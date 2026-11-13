"""Run the compiled read-only recovery bridge against a temporary HOME only."""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile

exe = Path('extra/relay/RelayNative').resolve()
checks = []

def check(name, condition):
    checks.append({'name': name, 'passed': bool(condition)})

def invoke(request):
    return subprocess.run([str(exe), '--recovery-preflight'], input=json.dumps(request),
                          capture_output=True, text=True, timeout=15)

def digest(data):
    return hashlib.sha256(data).hexdigest()

with tempfile.TemporaryDirectory(prefix='relay-recovery-bridge-') as directory:
    home = Path(directory).resolve() / 'home'
    home.mkdir(mode=0o700)
    assert home != Path.home()
    root = home / 'Library/Application Support/Relay-Preview'
    context = {'home': str(home), 'stateRoot': str(root)}
    selection = {'source': 'relay', 'id': 'fixture-record'}
    request = {'context': context, 'selection': selection}
    missing = invoke(request)
    check('missing journal is unreadable without creating state', missing.returncode == 0 and
          json.loads(missing.stdout)['issues'] == ['manifestInvalid'] and not root.exists())
    client = home / '.claude/settings.json'
    client.parent.mkdir()
    original, installed = b'PRIVATE_ORIGINAL_FIXTURE', b'PRIVATE_INSTALLED_FIXTURE'
    client.write_bytes(installed)
    client.chmod(0o600)
    record = root / 'Backups/fixture-record'
    record.mkdir(parents=True)
    backup = record / 'original-0.bin'
    backup.write_bytes(original)
    manifest = {'version': 2, 'createdAt': '2026-10-23T00:00:00Z', 'phase': 'recoveryNeeded',
                'entries': [{'path': str(client), 'originalExists': True, 'originalMode': 0o640,
                             'backupName': backup.name, 'installedDigest': digest(installed),
                             'originalDigest': digest(original), 'installedMode': 0o600}]}
    manifest_path = record / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest))
    manifest_bytes = manifest_path.read_bytes()
    result = invoke(request)
    report = json.loads(result.stdout)
    check('valid compiled preflight reports file evidence', result.returncode == 0 and report['fileChecksPassed'] and
          report['targets'][0]['original'] == 'verified' and report['targets'][0]['current'] == 'installed')
    check('no restore enabled and no private content returned', report['snapshotOnly'] is True and report['restoreEnabled'] is False and
          str(home) not in result.stdout and 'PRIVATE_' not in result.stdout)
    check('read does not create state or journal locks', not (root / '.state.lock').exists() and not (root / 'Backups/.transaction.lock').exists())
    client.write_bytes(b'LATER_USER_EDIT')
    changed = json.loads(invoke(request).stdout)
    check('later edit rejected with a different snapshot', 'targetChanged' in changed['issues'] and not changed['fileChecksPassed'] and
          changed['revision'] != report['revision'] and client.read_bytes() == b'LATER_USER_EDIT')
    client.write_bytes(installed)
    backup.write_bytes(b'CORRUPT')
    check('corrupt original never verified', 'originalInvalid' in json.loads(invoke(request).stdout)['issues'])
    backup.write_bytes(original)
    manifest['entries'][0]['path'] = str(home / '.ssh/id_rsa')
    manifest_path.write_text(json.dumps(manifest))
    scope = json.loads(invoke(request).stdout)
    check('inside HOME but outside fixed scope is refused', scope['targets'][0]['target'] == 'unknown' and
          scope['targets'][0]['current'] == 'unassessed' and 'targetOutsideScope' in scope['issues'])
    manifest['entries'][0]['path'] = str(client)
    manifest['version'] = 1
    manifest.pop('phase')
    manifest['entries'][0].pop('originalDigest')
    manifest['entries'][0].pop('installedMode')
    manifest_path.write_text(json.dumps(manifest))
    old_bytes = manifest_path.read_bytes()
    old = json.loads(invoke(request).stdout)
    check('legacy confirmation remains separate and journal unchanged', old['requiresLegacyConfirmation'] and
          old['targets'][0]['original'] == 'unverifiedLegacy' and old['restoreEnabled'] is False and manifest_path.read_bytes() == old_bytes)
    for selection in [{'source': 'relay', 'id': '../fixture-record'}, {'source': 'other', 'id': 'fixture-record'}]:
        check('invalid selection refused before access', invoke({**request, 'selection': selection}).returncode != 0)
    bad_context = {'home': str(home), 'stateRoot': str(home / '.claude')}
    check('caller cannot select client state namespace', invoke({**request, 'context': bad_context}).returncode != 0)
    manifest_path.write_bytes(manifest_bytes)
    check('final client and backup bytes unchanged by inspection', client.read_bytes() == installed and backup.read_bytes() == original)

report = {'checks': len(checks), 'passed': sum(c['passed'] for c in checks), 'results': checks,
          'scope': 'Compiled helper with temporary HOME only. No host settings, browser process probes, recovery writes or network operations.'}
Path('../evidence/recovery-bridge.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'checks': report['checks'], 'passed': report['passed']}))
assert report['checks'] == report['passed'], report
