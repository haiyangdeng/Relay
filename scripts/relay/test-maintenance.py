"""Compiled maintenance contracts and temporary signed bundle metadata.

Executes only RelayNative CLI operations, never an App main executable. Signing
uses ad-hoc fixture copies only. No user/client files or system filter APIs.
"""
from pathlib import Path
import argparse
import json
import plistlib
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--native', type=Path, default=Path('extra/relay/RelayNative'))
native = parser.parse_args().native.resolve()
rows = []
observations = []


def check(name, passed):
    rows.append({'name': name, 'passed': bool(passed)})


def invoke(args, data='', executable=native):
    return subprocess.run([str(executable), *args], input=data, text=True,
                          capture_output=True, timeout=25)


def output(args, executable=native):
    result = invoke(args, executable=executable)
    assert result.returncode == 0, 'Controlled CLI failed; private stderr not emitted'
    return json.loads(result.stdout)


standalone = output(['--guard-status'])
check('standalone helper does not guess an application', standalone['application']['presence'] == 'notBundled')
check('offline status has no protection or live permission', not standalone['protectionVerified'] and not standalone['liveOperationsAvailable'])
check('system status remains unqueried', standalone['systemExtension'] == standalone['filterConfiguration'] == 'notQueried')
check('no network static validation contract', standalone['signatureValidationScope'] == 'allArchitecturesNoNetwork')
sample = output(['--critical-preview'])
check('critical preview explicitly marked as a sample', sample['sample'] and not sample['observed'] and sample['readOnly'])
check('sample has eleven rows, six runtime checks pending', len(sample['checks']) == 11 and all(row['state'] == 'pending' for row in sample['checks'][5:]))
check('guard simulate alias uses the same decisions', output(['--simulate']) == output(['--guard-simulate']))
guard_tests = invoke(['--guard-self-test'])
check('dedicated guard self-test retained', guard_tests.returncode == 0 and 'PASS: 34' in guard_tests.stdout)
for args in [['--guard-status', '/PRIVATE/injected.app'], ['--critical-preview', '--apply'], ['--guard-self-test', '--enable'], ['--render-preview', '/PRIVATE/out.png']]:
    result = invoke(args)
    check('unsupported argument combination rejected: ' + args[0], result.returncode != 0 and not result.stdout and 'PRIVATE' not in result.stderr)
for command in ['--status', '--diagnose']:
    result = invoke([command], 'PRIVATE malformed')
    check(command + ' rejects malformed structured input without implicit user reads', result.returncode != 0 and not result.stdout and 'PRIVATE' not in result.stderr)

with tempfile.TemporaryDirectory(prefix='relay-guard-bundle-') as temporary:
    root = Path(temporary).resolve()
    app = root / 'Fixture.app'
    helper = app / 'Contents/Resources/relay/RelayNative'
    helper.parent.mkdir(parents=True)
    shutil.copy2(native, helper)
    binary = app / 'Contents/MacOS/Fixture'
    binary.parent.mkdir()
    shutil.copyfile('/usr/bin/true', binary)
    binary.chmod(0o755)
    info = {'CFBundleIdentifier': 'local.relay.network.preview', 'CFBundleExecutable': 'Fixture',
            'CFBundlePackageType': 'APPL', 'CFBundleVersion': '3'}
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))

    def sign(path, identifier):
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none',
                        '--identifier', identifier, str(path)], check=True, capture_output=True)

    sign(app, info['CFBundleIdentifier'])
    report = output(['--guard-status'], helper)
    observations.append({'phase': 'adHocApp', 'report': report})
    check('temporary signed App metadata observed', report['application']['presence'] == 'present' and report['application']['identity'] == 'matches')
    check('ad-hoc signature is distinct from production readiness', report['application']['signature'] == 'adHoc' and not report['bundleMetadataMatches'])
    check('missing extension distinguished from unknown system installation', report['extensionComponent']['presence'] == 'missing' and report['systemExtension'] == 'notQueried')
    check('missing entitlements never fabricated', not report['application']['installEntitlement'] and not report['application']['networkEntitlement'])
    ext = app / 'Contents/Library/SystemExtensions/local.relay.network.guard.systemextension'
    ext_binary = ext / 'Contents/MacOS/FilterFixture'
    ext_binary.parent.mkdir(parents=True)
    shutil.copyfile('/usr/bin/true', ext_binary)
    ext_binary.chmod(0o755)
    ext_info = {'CFBundleIdentifier': 'local.relay.network.guard', 'CFBundleExecutable': 'FilterFixture',
                'CFBundlePackageType': 'SYSX', 'CFBundleVersion': '3'}
    (ext / 'Contents/Info.plist').write_bytes(plistlib.dumps(ext_info))
    sign(ext, ext_info['CFBundleIdentifier']); sign(app, info['CFBundleIdentifier'])
    report = output(['--guard-status'], helper)
    observations.append({'phase': 'adHocExtension', 'report': report})
    check('extension metadata is scoped to the fixed Relay identity', report['extensionComponent']['identity'] == 'matches')
    check('signed fixture extension still not a deployed filter', report['extensionComponent']['signature'] == 'adHoc' and not report['liveOperationsAvailable'] and not report['protectionVerified'])
    check('ad-hoc teams remain unconfirmed', report['sameSigningTeam'] == 'unconfirmed')
    check('matching component versions may be shown without a protection claim', report['sameVersion'] == 'matches' and not report['bundleMetadataMatches'])
    (app / 'Contents/Resources/changed.txt').write_text('fixture change')
    report = output(['--guard-status'], helper)
    observations.append({'phase': 'changedSeal', 'report': report})
    check('resource seal change detected', report['application']['signature'] == 'invalid' and not report['bundleMetadataMatches'])
    alias = root / 'Alias.app'
    alias.symlink_to(app, target_is_directory=True)
    report = output(['--guard-status'], alias / 'Contents/Resources/relay/RelayNative')
    check('symlink container cannot become a verified App', report['application']['presence'] == 'unconfirmed' and not report['bundleMetadataMatches'])

report = {'checks': len(rows), 'passed': sum(row['passed'] for row in rows), 'results': rows,
          'fixtureObservations': observations,
          'fixtureSigningOnly': True, 'systemExtensionAPIsCalled': False, 'filterConfigurationReadOrWritten': False,
          'actualAppOrBrowserLaunched': False, 'actualClientConfigurationReadOrChanged': False,
          'networkChanged': False, 'previewPackaged': False}
Path('../evidence/maintenance-native-contract.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'checks': report['checks'], 'passed': report['passed']}))
for row in rows:
    if not row['passed']: print(row['name'])
assert report['checks'] == report['passed']
