"""Offline contract fixtures for the isolated ES/NE publisher verifier."""

import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import struct
import sys
import tempfile
import unittest
from unittest.mock import Mock


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SPEC = importlib.util.spec_from_file_location('guard_extension_pair', HERE / 'verify-guard-extension-package.py')
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
STAGE_SPEC = importlib.util.spec_from_file_location('guard_extension_stage', HERE / 'stage-guard-extension-package.py')
stager = importlib.util.module_from_spec(STAGE_SPEC)
STAGE_SPEC.loader.exec_module(stager)

TEAM = 'FIXTURE123'
BUILD = '3'
APP_SHORT_VERSION = '2.0.0-dev.3'


def digest(value):
    return hashlib.sha256(value).hexdigest()


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)
    return path


def document(path, value):
    return put(path, (json.dumps(value, indent=2) + '\n').encode())


def thin(architecture, kind):
    return struct.pack('<IIIIIIII', 0xfeedfacf, gate.CPU[architecture], 0, kind, 0, 0, 0, 0)


class Fixture:
    def __init__(self, root, architecture='arm64', enabled=False):
        self.arch = architecture
        self.source = root / 'source'
        self.app = root / 'Relay.app'
        self.staged = root / 'approved-components'
        self.extensions = self.app / gate.EXTENSION_DIR
        self.resources = self.app / gate.RELAY_RESOURCES
        self.stage = self.source / 'extra/relay'
        self.signatures = Mock()
        self.entitlements = Mock(side_effect=self.permissions)
        self.create_sources(enabled)
        put(self.app / 'Contents/MacOS/Relay', thin(architecture, 2)).chmod(0o700)
        put(self.app / 'Contents/Info.plist', plistlib.dumps({
            'CFBundleIdentifier': gate.APP_ID, 'CFBundleExecutable': 'Relay',
            'CFBundleShortVersionString': APP_SHORT_VERSION,
            'CFBundleVersion': BUILD, 'LSMinimumSystemVersion': '13.0',
            'NSSystemExtensionUsageDescription': stager.PURPOSE,
        }))
        self.create_component(gate.NE_ID, gate.NE_EXEC, gate.NE_PACKAGE)
        self.create_component(gate.ES_ID, gate.ES_EXEC, gate.ES_PACKAGE)
        for arch in gate.CPU:
            location = Path('guard-host') / arch
            pinned = {}
            for name, (kind, _) in gate.HOST_ROLES.items():
                code = thin(arch, kind)
                pinned[name] = digest(code)
                for root_dir in [self.resources, self.stage]:
                    put(root_dir / location / name, code)
            for root_dir in [self.resources, self.stage]:
                document(root_dir / location / 'manifest.json', {
                    'version': 1, 'architecture': arch, 'buildVersion': BUILD, 'files': pinned
                })
        for root_dir in [self.resources, self.stage]:
            put(root_dir / 'RelayNative', b'approved test-only RelayNative stand-in').chmod(0o700)

    def create_sources(self, enabled):
        document(self.source / 'package.json', {'version': APP_SHORT_VERSION})
        for relative in [gate.NE_PACKAGE, gate.ES_PACKAGE]:
            template = json.loads((ROOT / relative / 'manifest.json').read_bytes())
            template['publisherTeamID'] = TEAM
            template['systemInstallationSupported'] = enabled
            if relative == gate.ES_PACKAGE:
                template['resourceSHA256'] = {arch: digest(thin(arch, 2)) for arch in gate.CPU}
                template['runtimeMonitoringReady'] = enabled
            else:
                template['runtimeProtectionReady'] = enabled
            document(self.source / relative / 'manifest.json', template)
        for relative in [
            Path('native/RelayGuardRelease.swift'),
            Path('native/guard/lineage/RelayGuardLineageRelease.swift')
        ]:
            text = (ROOT / relative).read_text().replace('publisherTeamID: String? = nil',
                                                         f'publisherTeamID: String? = "{TEAM}"')
            if enabled:
                for field in ('systemInstallationSupported', 'runtimeMonitoringReady',
                              'runtimeProtectionReady', 'completeClientScopeReady'):
                    text = text.replace(f'static let {field} = false', f'static let {field} = true')
            put(self.source / relative, text.encode())

    def create_component(self, identifier, executable, package):
        target = self.extensions / (identifier + '.systemextension')
        info = (ROOT / package / 'Info.plist').read_bytes().replace(b'__RELAY_PUBLISHER_TEAM_ID__', TEAM.encode())
        put(target / 'Contents/Info.plist', info)
        put(target / 'Contents/MacOS' / executable, thin(self.arch, 2)).chmod(0o700)
        put(target / 'Contents/_CodeSignature/CodeResources', b'fixture signed-resource marker')
        self.staged.mkdir(exist_ok=True)
        shutil.copytree(target, self.staged / target.name)

    def permissions(self, path, architecture):
        if architecture != self.arch:
            raise AssertionError('Capability inspection is for the candidate slice.')
        common = {gate.GROUP_ENTITLEMENT: [TEAM + '.' + gate.NE_ID]}
        ne = {gate.NE_ENTITLEMENT: ['content-filter-provider-systemextension']}
        if path == self.app:
            return {**common, **ne, gate.INSTALL_ENTITLEMENT: True}
        if path.name == gate.NE_ID + '.systemextension':
            return {**common, **ne, 'com.apple.security.app-sandbox': True}
        if path.name == gate.ES_ID + '.systemextension':
            return {**common, gate.ES_ENTITLEMENT: True}
        raise AssertionError('Unexpected entitlement target.')

    def verify(self):
        return gate.verify_bundle(self.app, self.source, self.staged, self.arch,
                                  inspect=self.signatures, inspect_entitlements=self.entitlements)


class GuardExtensionPackageTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='relay-guard-package-fixture-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()

    def publisher_base(self, architecture='arm64'):
        value = Fixture(self.root / architecture, architecture)
        shutil.rmtree(value.extensions)
        shutil.rmtree(value.resources / 'guard-host')
        put(value.resources / 'RelayNative', b'base App native binary').chmod(0o700)
        info = value.app / 'Contents/Info.plist'
        original = plistlib.loads(info.read_bytes())
        del original['NSSystemExtensionUsageDescription']
        put(info, plistlib.dumps(original))
        return value

    @staticmethod
    def copy_fixture(source, destination):
        if source.is_dir():
            shutil.copytree(source, destination, symlinks=True)
        else:
            shutil.copy2(source, destination, follow_symlinks=False)

    def test_publisher_staging_keeps_base_and_signed_inputs_and_seals_nested_roles(self):
        for architecture in gate.CPU:
            with self.subTest(architecture=architecture):
                value = self.publisher_base(architecture)
                signatures = Mock()
                base_entitlements = {'com.apple.security.cs.allow-jit': True}
                def entitlements(path, arch):
                    if path == value.app:
                        return base_entitlements
                    return value.permissions(path, arch)
                copy = stager.copy_signed if sys.platform == 'darwin' else self.copy_fixture
                result = stager.stage(value.app, value.source, value.staged, value.arch, self.root,
                                      copy=copy, inspect=signatures, inspect_entitlements=entitlements)
                app = Path(result['app'])
                self.assertTrue(result['outerAppSigningPending'])
                self.assertFalse(result['installationAttempted'])
                self.assertEqual(plistlib.loads(Path(result['hostEntitlements']).read_bytes()),
                                 {**base_entitlements, **gate.expected_entitlements(TEAM, 'app')})
                self.assertFalse(value.extensions.exists())
                self.assertFalse((value.resources / 'guard-host').exists())
                self.assertEqual((value.resources / 'RelayNative').read_bytes(), b'base App native binary')
                self.assertNotIn('NSSystemExtensionUsageDescription',
                                 plistlib.loads((value.app / 'Contents/Info.plist').read_bytes()))
                self.assertEqual(plistlib.loads((app / 'Contents/Info.plist').read_bytes())['NSSystemExtensionUsageDescription'],
                                 stager.PURPOSE)
                self.assertEqual([row['identifier'] for row in signatures.call_args.args[0]['targets']],
                                 [gate.NE_ID, gate.ES_ID, *[gate.APP_ID + '.guard-host.' + suffix
                                  for suffix in ('node', 'swift', 'node', 'swift')], 'RelayNative'])
                final = gate.verify_bundle(app, value.source, value.staged, architecture,
                                           inspect=Mock(), inspect_entitlements=lambda path, arch:
                                           gate.expected_entitlements(TEAM, 'app') if path == app else value.permissions(path, arch))
                self.assertTrue(final['offlineDeveloperIDPairingVerified'])

    def test_publisher_staging_rejects_untrusted_nested_input_without_exposing_partial_app(self):
        value = self.publisher_base()
        signatures = Mock(side_effect=[None, None, ValueError('nested signature refused')])
        with self.assertRaisesRegex(ValueError, 'nested signature refused'):
            stager.stage(value.app, value.source, value.staged, value.arch, self.root,
                         copy=self.copy_fixture, inspect=signatures,
                         inspect_entitlements=lambda _path, _arch: {})
        self.assertEqual(list(self.root.glob('relay-guard-release-*')), [])
        self.assertFalse(value.extensions.exists())

    def test_publisher_staging_refuses_default_development_authority_before_io(self):
        copy = Mock()
        sign = Mock()
        with self.assertRaisesRegex(ValueError, 'missing approved publisher'):
            stager.stage(self.root / 'missing.app', ROOT, self.root / 'missing', 'arm64', self.root,
                         copy=copy, inspect=sign)
        copy.assert_not_called()
        sign.assert_not_called()

    def test_disabled_source_refuses_before_signature_or_system_inspection(self):
        sign = Mock(side_effect=AssertionError('The disabled contract must not inspect signatures.'))
        with self.assertRaisesRegex(ValueError, 'missing approved publisher'):
            gate.verify_bundle(self.root / 'missing.app', ROOT, self.root / 'missing', 'arm64', inspect=sign)
        sign.assert_not_called()

    def test_signed_pair_input_contract_for_both_architectures(self):
        for architecture in gate.CPU:
            with self.subTest(architecture=architecture):
                value = Fixture(self.root / architecture, architecture, enabled=True)
                result = value.verify()
                request = value.signatures.call_args.args[0]
                self.assertEqual(request['team'], TEAM)
                self.assertEqual(result['architecture'], architecture)
                self.assertEqual([target['identifier'] for target in request['targets']], [
                    gate.APP_ID, gate.NE_ID, gate.ES_ID,
                    gate.APP_ID + '.guard-host.node', gate.APP_ID + '.guard-host.swift',
                    gate.APP_ID + '.guard-host.node', gate.APP_ID + '.guard-host.swift', 'RelayNative'
                ])
                self.assertEqual(request['targets'][0]['architectures'], [architecture])
                self.assertEqual(request['targets'][0]['appVersion'], {
                    'build': BUILD, 'short': APP_SHORT_VERSION
                })
                self.assertEqual(request['targets'][-1]['architectures'], list(gate.CPU))
                self.assertEqual(value.entitlements.call_count, 3)
                self.assertFalse(result['runtimeProtectionVerified'])
                self.assertFalse(result['provisioningOrNotarizationVerified'])
                self.assertFalse(result['activationAttempted'])
                self.assertFalse(result['appLaunched'])

    def test_outer_app_short_version_must_match_release_source(self):
        for short_version in [None, '2.0.0']:
            with self.subTest(short_version=short_version):
                value = Fixture(self.root / str(short_version))
                path = value.app / 'Contents/Info.plist'
                info = plistlib.loads(path.read_bytes())
                if short_version is None:
                    del info['CFBundleShortVersionString']
                else:
                    info['CFBundleShortVersionString'] = short_version
                put(path, plistlib.dumps(info))
                with self.assertRaisesRegex(ValueError, 'App Info mismatch'):
                    value.verify()
                value.signatures.assert_not_called()

    def test_unsigned_synthetic_inputs_are_rejected_by_signature_inspection(self):
        value = Fixture(self.root)
        value.signatures.side_effect = ValueError('Developer ID verification failed')
        with self.assertRaisesRegex(ValueError, 'Developer ID verification failed'):
            value.verify()
        value.entitlements.assert_not_called()

    def test_wrong_signed_entitlement_is_rejected(self):
        value = Fixture(self.root)

        def permissions(path, architecture):
            result = value.permissions(path, architecture)
            if path.name == gate.ES_ID + '.systemextension':
                result[gate.ES_ENTITLEMENT] = 1
                result[gate.NE_ENTITLEMENT] = ['content-filter-provider-systemextension']
            return result

        value.entitlements.side_effect = permissions
        with self.assertRaisesRegex(ValueError, 'wrong signed capabilities for lineage'):
            value.verify()

    def test_provider_metadata_mismatch_even_if_staging_matches(self):
        value = Fixture(self.root)
        name = gate.NE_ID + '.systemextension'
        for root in [value.extensions, value.staged]:
            path = root / name / 'Contents/Info.plist'
            info = plistlib.loads(path.read_bytes())
            info['NetworkExtension']['NEMachServiceName'] = 'unsigned.' + gate.NE_ID + '.ipc'
            put(path, plistlib.dumps(info))
        with self.assertRaisesRegex(ValueError, 'NE Mach or provider class mismatch'):
            value.verify()
        value.signatures.assert_not_called()

    def test_packaging_cannot_change_signed_extension_resources(self):
        value = Fixture(self.root)
        put(value.extensions / (gate.ES_ID + '.systemextension') / 'Contents/_CodeSignature/CodeResources', b'changed')
        with self.assertRaisesRegex(ValueError, 'component signed tree changed'):
            value.verify()
        value.signatures.assert_not_called()

    def test_staged_signatures_do_not_replace_lineage_binary_pin(self):
        value = Fixture(self.root)
        for root in [value.extensions, value.staged]:
            put(root / (gate.ES_ID + '.systemextension') / 'Contents/MacOS' / gate.ES_EXEC,
                thin(value.arch, 2) + b'different signed bytes')
        with self.assertRaisesRegex(ValueError, 'ES binary pin mismatch'):
            value.verify()
        value.signatures.assert_not_called()

    def test_guard_host_architecture_must_match_its_manifest_slot(self):
        value = Fixture(self.root)
        put(value.resources / 'guard-host/x86_64/RelayGuard.node', thin('arm64', 8))
        with self.assertRaisesRegex(ValueError, 'wrong Mach-O architecture or role'):
            value.verify()
        value.signatures.assert_not_called()

    def test_source_release_disagreement_refuses_before_inspection(self):
        value = Fixture(self.root)
        path = value.source / 'native/RelayGuardRelease.swift'
        text = path.read_text().replace('buildVersion = "3"', 'buildVersion = "4"')
        put(path, text.encode())
        with self.assertRaisesRegex(ValueError, 'compiled buildVersion differs'):
            value.verify()
        value.signatures.assert_not_called()

    def test_lineage_authority_must_inherit_guard_publisher_and_build(self):
        for field, wrong in [('publisherTeamID', '"WRONGTEAM1"'), ('buildVersion', '"4"')]:
            with self.subTest(field=field):
                value = Fixture(self.root / field, enabled=True)
                path = value.source / 'native/guard/lineage/RelayGuardLineageRelease.swift'
                text = path.read_text().replace(f'RelayGuardManagementRelease.{field}', wrong)
                put(path, text.encode())
                with self.assertRaisesRegex(ValueError, f'compiled lineage {field} must inherit'):
                    value.verify()
                value.signatures.assert_not_called()

    def test_mutation_during_signature_inspection_refuses(self):
        value = Fixture(self.root)

        def modify(_):
            put(value.resources / 'guard-host/x86_64/RelayGuard.node', b'test-only mutation')

        value.signatures.side_effect = modify
        with self.assertRaisesRegex(ValueError, 'path changed'):
            value.verify()


if __name__ == '__main__':
    unittest.main()
