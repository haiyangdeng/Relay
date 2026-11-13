"""Offline build-recipe regression tests: no compiler, network, installer or app."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('build-public.py')
spec = importlib.util.spec_from_file_location('relay_public_build', SCRIPT)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class PublicBuildTests(unittest.TestCase):
    def test_all_dry_runs_are_read_only_and_fixed_version(self):
        before = [p.exists() for p in [build.WORK, build.RESOURCE, build.ROOT / 'release']]
        for stage in ['resources', 'package', 'installer', 'tun-installer']:
            result = subprocess.run([sys.executable, str(SCRIPT), stage, '--dry-run'],
                                    capture_output=True, text=True, check=True)
            receipt = json.loads(result.stdout)
            self.assertFalse(receipt['executed'])
            self.assertTrue(receipt['sourcePinsVerified'])
            self.assertEqual(receipt['version'], '1.0.0')
        self.assertEqual(before, [p.exists() for p in [build.WORK, build.RESOURCE, build.ROOT / 'release']])

    def test_no_execute_is_safe_default(self):
        with patch.object(sys, 'argv', [str(SCRIPT)]), patch.object(build, 'resources') as run:
            with contextlib.redirect_stdout(io.StringIO()):
                build.main()
            run.assert_not_called()

    def test_both_architecture_pins_follow_new_signed_bytes(self):
        # Fake the external tool boundary; exercise real pin writing and bundled source notices.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            work, resource, source = root / 'work', root / 'extra/relay', root / 'source'
            work.mkdir(); source.mkdir()
            old = {'assets': {arch: {'cpuType': cpu, 'sha256': char * 64, 'size': size}
                              for arch, cpu, char, size in [('arm64', 16777228, 'a', 501), ('x64', 16777223, 'b', 502)]}}
            manifest_path = root / 'src/main/relay/core/geodata-manifest.json'
            manifest_path.parent.mkdir(parents=True)
            manifest_path.write_text(json.dumps(old))
            fixture = root / 'pins.swift'
            fixture.write_text('arm=' + 'a' * 64 + ':501 x64=' + 'b' * 64 + ':502')
            for name in ['mihomo-geodata-v1/LICENSE.upstream', 'mihomo-geodata-v1/patches/0001-local-geodata-v1.patch',
                         'mihomo-provider-file-v1/patches/0001-serialize-local-file-updates.patch', 'SOURCE.md']:
                path = root / 'core-extensions' / name
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text(name)
            def fake_run(*args, **kwargs):
                if args[:2] == ('go', 'build'):
                    path = Path(args[args.index('-o') + 1])
                    cpu = 16777228 if kwargs['env']['GOARCH'] == 'arm64' else 16777223
                    path.write_bytes((0xfeedfacf).to_bytes(4, 'little') + cpu.to_bytes(4, 'little') + b'signed-fixture')
            with patch.multiple(build, ROOT=root, WORK=work, RESOURCE=resource, NATIVE_PINS=['pins.swift']), patch.object(build, 'run', side_effect=fake_run):
                build.compile_core(source, {'overlays': {}}, {'overlays': {}})
            new = json.loads(manifest_path.read_text())
            for arch in ['arm64', 'x64']:
                binary = resource / 'core-geodata-v1' / ('darwin-' + arch) / 'mihomo'
                self.assertEqual(new['assets'][arch]['sha256'], build.digest(binary))
                self.assertEqual(new['assets'][arch]['size'], binary.stat().st_size)
                self.assertIn(new['assets'][arch]['sha256'], fixture.read_text())
                self.assertNotIn(old['assets'][arch]['sha256'], fixture.read_text())
            self.assertTrue((resource / 'core-geodata-v1/0002-serialize-local-file-updates.patch').is_file())

    def test_fresh_tun_client_rebases_all_admitted_capabilities(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); work = root / 'work'
            directory = root / 'src/main/relay/tun'; directory.mkdir(parents=True)
            core = root / 'src/main/relay/core/geodata-manifest.json'; core.parent.mkdir()
            cores = {'arm64': {'sha256': 'c' * 64}, 'x64': {'sha256': 'd' * 64}}
            core.write_text(json.dumps({'assets': cores}))
            filenames = ['execution-client.json', 'runtime-smart-tools-client.json', 'runtime-telemetry-client.json',
                         'runtime-capture-client.json', 'runtime-rules-client.json', 'runtime-resources-client.json',
                         'runtime-rule-providers-client.json', 'runtime-work-directory-client.json', 'runtime-history-client.json']
            for name in filenames:
                (directory / name).write_text(json.dumps({'version': 1, 'clientSHA256': None if name == 'runtime-history-client.json' else 'a' * 64}))
            def compile_fixture(*args, **kwargs):
                compiled = work / 'tun-helper'; compiled.mkdir(parents=True)
                for name in ['RelayTunHelper', 'RelayTunClient', 'RelayTunUninstall']:
                    (compiled / name).write_bytes(('fresh-' + name).encode())
                (compiled / 'shipping-sources.json').write_text(json.dumps({'files': {}}))
                for variable, destination in kwargs['env'].items():
                    if variable.startswith('RELAY_TUN_') and variable.endswith('_PIN_OUTPUT'):
                        path = Path(destination); value = json.loads(path.read_text())
                        value['clientSHA256'] = build.digest(compiled / 'RelayTunClient')
                        if variable in ['RELAY_TUN_RESOURCES_PIN_OUTPUT', 'RELAY_TUN_PROVIDERS_PIN_OUTPUT']:
                            value['cores'] = {arch: item['sha256'] for arch, item in cores.items()}
                        path.write_text(json.dumps(value))
            with patch.multiple(build, ROOT=root, WORK=work), patch.object(build, 'run', side_effect=compile_fixture):
                build.build_tun_resources()
                self.assertIsNone(json.loads((directory / 'runtime-history-client.json').read_text())['clientSHA256'])
                client_hash = build.digest(work / 'tun-helper/RelayTunClient')
                self.assertEqual(json.loads((directory / 'runtime-work-directory-client.json').read_text())['clientSHA256'], client_hash)
                bad = directory / 'runtime-resources-client.json'
                value = json.loads(bad.read_text()); value['cores']['arm64'] = 'e' * 64; bad.write_text(json.dumps(value))
                with self.assertRaisesRegex(RuntimeError, 'different Core'):
                    build.verify_tun_pairing()

    def test_installer_rejects_changed_same_version_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); work = root / 'work'; work.mkdir()
            app = root / 'release/mac-arm64/Relay.app'; app.mkdir(parents=True)
            (app / 'binary').write_bytes(b'packaged fixture')
            (work / 'resources.json').write_text('{}')
            receipt = {'architecture': 'arm64', 'version': '1.0.0',
                       'resourceReceiptSHA256': build.digest(work / 'resources.json'), 'app': build.app_inventory(app)}
            (work / 'package-arm64.json').write_text(json.dumps(receipt))
            with patch.multiple(build, ROOT=root, WORK=work), patch.object(build, 'verify_staged_resources', return_value={'version': '1.0.0'}):
                build.verify_packaged_app('arm64')
                (app / 'binary').write_bytes(b'changed same-version app')
                with self.assertRaisesRegex(RuntimeError, 'does not match'):
                    build.verify_packaged_app('arm64')

    def test_source_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'escape').symlink_to('/tmp')
            with self.assertRaisesRegex(RuntimeError, 'Non-regular'):
                build.plain_tree(root)


if __name__ == '__main__':
    unittest.main()
