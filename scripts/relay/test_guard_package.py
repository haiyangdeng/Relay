#!/usr/bin/env python3
"""Offline package-definition contracts. No extension is executed or installed."""
import copy
import importlib.util
import re
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guard_package', Path(__file__).with_name('build-guard-package.py'))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class GuardPackageContracts(unittest.TestCase):
    def setUp(self):
        self.manifest, self.info, self.extension, self.host = package.definition()

    def validate(self):
        package.validate_definition(self.manifest, self.info, self.extension, self.host)

    def test_valid_development_definition_matches_host_and_provider(self):
        self.validate()
        self.assertEqual(self.info['CFBundlePackageType'], 'SYSX')
        self.assertIs(self.manifest['runtimeProtectionReady'], False)

    def test_readiness_contract_matches_the_actual_packaged_identity(self):
        source = (package.APP / 'native/RelayGuardReadiness.swift').read_text()
        identifiers = dict(re.findall(r'static let (applicationID|extensionID) = "([^"]+)"', source))
        self.assertEqual(identifiers, {
            'applicationID': self.manifest['hostBundleID'],
            'extensionID': self.manifest['extensionBundleID'],
        })
        self.assertEqual(identifiers['extensionID'], self.info['CFBundleIdentifier'])
        self.assertEqual(identifiers['extensionID'] + '.systemextension', self.manifest['bundleName'])

    def test_host_bundle_and_output_paths_are_fixed(self):
        for key, value in [('hostBundleID', 'foreign.app'), ('extensionBundleID', 'foreign.extension'),
                           ('bundleName', '../foreign.systemextension'), ('executable', '/tmp/foreign')]:
            with self.subTest(key=key):
                manifest = copy.deepcopy(self.manifest)
                manifest[key] = value
                with self.assertRaises(ValueError):
                    package.validate_definition(manifest, self.info, self.extension, self.host)

    def test_provider_class_and_extension_point_must_match(self):
        for classes in [{package.POINT: 'Foreign.Provider'}, {'foreign.point': self.manifest['providerClass']}]:
            with self.subTest(classes=classes):
                info = copy.deepcopy(self.info)
                info['NetworkExtension']['NEProviderClasses'] = classes
                with self.assertRaises(ValueError):
                    package.validate_definition(self.manifest, info, self.extension, self.host)

    def test_mach_service_requires_the_publisher_placeholder(self):
        self.info['NetworkExtension']['NEMachServiceName'] = 'unreviewed.service'
        with self.assertRaises(ValueError):
            self.validate()

    def test_extension_rejects_extra_privileges_and_wrong_capability(self):
        for changed in [{'com.apple.security.get-task-allow': True}, {package.NE_KEY: ['packet-tunnel-provider-systemextension']},
                        {'com.apple.security.app-sandbox': 1}]:
            with self.subTest(changed=changed):
                extension = {**self.extension, **changed}
                with self.assertRaises(ValueError):
                    package.validate_definition(self.manifest, self.info, extension, self.host)

    def test_host_install_capability_is_explicit_and_cannot_be_replaced_by_another_provider(self):
        self.host[package.NE_KEY] = ['dns-proxy-systemextension']
        with self.assertRaises(ValueError):
            self.validate()

    def test_development_package_cannot_claim_production_or_installation_readiness(self):
        for changed in [{'publisherTeamID': 'FAKEIDENT0'}, {'runtimeProtectionReady': True},
                        {'systemInstallationSupported': True}, {'schemaVersion': True}]:
            with self.subTest(changed=changed):
                with self.assertRaises(ValueError):
                    package.validate_definition({**self.manifest, **changed}, self.info, self.extension, self.host)

    def test_versions_minimum_os_and_unknown_metadata_cannot_drift(self):
        for key, value in [('CFBundleVersion', '999'), ('LSMinimumSystemVersion', '12.0'), ('UnknownKey', True)]:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    package.validate_definition(self.manifest, {**self.info, key: value}, self.extension, self.host)


if __name__ == '__main__':
    unittest.main()
