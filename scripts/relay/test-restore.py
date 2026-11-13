"""Exercise the compiled restore transaction only inside a temporary HOME."""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile

exe = Path('extra/relay/RelayNative').resolve()
checks = []
def check(name, condition):
    checks.append({'name': name, 'passed': bool(condition)})
def invoke(operation, request):
    return subprocess.run([str(exe), operation], input=json.dumps(request), capture_output=True, text=True, timeout=15)
def digest(data):
    return hashlib.sha256(data).hexdigest()

with tempfile.TemporaryDirectory(prefix='relay-restore-bridge-') as folder:
    home = Path(folder).resolve() / 'home'
    home.mkdir(mode=0o700)
    assert home != Path.home()
    root = home / 'Library/Application Support/Relay-Preview'
    context = {'home': str(home), 'stateRoot': str(root)}
    client = home / '.claude/settings.json'
    client.parent.mkdir()
    before, after = b'ORIGINAL_PRIVATE_FIXTURE', b'INSTALLED_PRIVATE_FIXTURE'
    record = root / 'Backups/fixture-record'
    record.mkdir(parents=True)
    manifest_path = record / 'manifest.json'
    backup = record / 'original-0.bin'
    def prepare(version=2, source='relay'):
        client.write_bytes(after); client.chmod(0o600); backup.write_bytes(before)
        entry = {'path': str(client), 'originalExists': True, 'originalMode': 0o640,
                 'backupName': backup.name, 'installedDigest': digest(after), 'originalDigest': digest(before), 'installedMode': 0o600}
        manifest = {'version': version, 'createdAt': '2026-10-23T00:00:00Z', 'entries': [entry]}
        if version == 2:
            manifest['phase'] = 'committed'
        else:
            entry.pop('originalDigest'); entry.pop('installedMode')
        manifest_path.write_text(json.dumps(manifest))
        selection = {'source': source, 'id': record.name}
        result = invoke('--recovery-preflight', {'context': context, 'selection': selection})
        assert result.returncode == 0, result.stderr
        return {'context': context, 'selection': selection, 'expectedRevision': json.loads(result.stdout)['revision'], 'allowLegacy': False}
    request = prepare()
    client.write_bytes(b'LATER_EDIT')
    result = invoke('--recovery-restore', request)
    check('stale confirmation cannot overwrite later edits', result.returncode != 0 and client.read_bytes() == b'LATER_EDIT')
    request = prepare()
    result = invoke('--recovery-restore', request)
    check('compiled restore succeeds', result.returncode == 0 and json.loads(result.stdout)['status'] == 'restored')
    check('original bytes and mode restored', client.read_bytes() == before and client.stat().st_mode & 0o777 == 0o640)
    check('journal and backup retained', json.loads(manifest_path.read_text())['phase'] == 'restored' and backup.read_bytes() == before)
    check('no paths or private content in response', str(home) not in result.stdout and 'PRIVATE_FIXTURE' not in result.stdout)
    check('replayed snapshot refused', invoke('--recovery-restore', request).returncode != 0 and client.read_bytes() == before)
    request = prepare()
    backup.write_bytes(b'CORRUPT')
    check('manual-review flag cannot bypass corruption', invoke('--recovery-restore', {**request, 'allowLegacy': True}).returncode != 0 and client.read_bytes() == after)
    request = prepare(version=1)
    initial_manifest = manifest_path.read_bytes()
    check('legacy restore requires separate review', invoke('--recovery-restore', request).returncode != 0 and manifest_path.read_bytes() == initial_manifest)
    result = invoke('--recovery-restore', {**request, 'allowLegacy': True})
    check('reviewed legacy restored only on explicit operation', result.returncode == 0 and client.read_bytes() == before)
    check('legacy journal upgraded durably', json.loads(manifest_path.read_text())['version'] == 2 and json.loads(manifest_path.read_text())['phase'] == 'restored')
    check('bad revision refused', invoke('--recovery-restore', {**request, 'expectedRevision': 'bad'}).returncode != 0)
    check('outside record path refused', invoke('--recovery-restore', {**request, 'selection': {'source': 'relay', 'id': '../fixture-record'}}).returncode != 0)

report = {'checks': len(checks), 'passed': sum(c['passed'] for c in checks), 'results': checks,
          'scope': 'Real compiled restore operation with fake HOME only. No actual user configuration, browser observation, controller or network operation.'}
Path('../evidence/restore-bridge.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'checks': report['checks'], 'passed': report['passed']}))
assert report['checks'] == report['passed'], report
