"""Real native preference/recovery IPC contract, confined to a temporary HOME."""
from pathlib import Path
import json
import subprocess
import tempfile

exe = Path('extra/relay/RelayNative').resolve()
checks = []
def check(name, condition):
    checks.append({'name': name, 'passed': bool(condition)})
def invoke(command, request):
    return subprocess.run([str(exe), command], input=json.dumps(request), capture_output=True, text=True, timeout=15)

with tempfile.TemporaryDirectory(prefix='relay-state-bridge-') as folder:
    home = Path(folder).resolve() / 'home'
    home.mkdir(mode=0o700)
    assert home != Path.home()
    root = home / 'Library/Application Support/Relay-Preview'
    context = {'home': str(home), 'stateRoot': str(root)}
    result = invoke('--preferences', {'action': 'read', 'context': context})
    check('initial read succeeds', result.returncode == 0)
    initial = json.loads(result.stdout)
    check('defaults without filesystem creation', initial['source'] == 'defaults' and not root.exists())
    result = invoke('--recovery-status', context)
    recovery = json.loads(result.stdout)
    check('recovery status is metadata only with explicit restore capability', result.returncode == 0 and recovery['metadataOnly'] is True and recovery['restoreEnabled'] is True)
    check('missing sources separated without directory creation', {r['source'] for r in recovery['inventories']} == {'relay', 'legacy'} and all(r['availability'] == 'missing' for r in recovery['inventories']) and not root.exists())
    legacy = home / 'Library/Application Support/AI Network Assistant/preferences.json'
    legacy.parent.mkdir(parents=True)
    legacy_data = json.dumps({'httpPort': 8888, 'node': 'fixture-node', 'internalExceptions': 'git.corp', 'private': 'NO_LEGACY_COPY'}).encode()
    legacy.write_bytes(legacy_data)
    read = invoke('--preferences', {'action': 'read', 'context': context})
    snapshot = json.loads(read.stdout)
    check('legacy allowlist read', snapshot['source'] == 'legacy' and snapshot['preferences']['httpPort'] == 8888 and 'NO_LEGACY_COPY' not in read.stdout)
    client = home / '.claude/settings.json'
    client.parent.mkdir()
    client.write_bytes(b'CLIENT_MUST_NOT_CHANGE')
    request = {'action': 'save', 'context': context, 'preferences': snapshot['preferences'], 'revision': snapshot['revision']}
    saved = invoke('--preferences', request)
    check('explicit Relay-only save', saved.returncode == 0 and json.loads(saved.stdout)['source'] == 'relay')
    own = root / 'preferences.json'
    check('private permissions, legacy not copied', own.stat().st_mode & 0o777 == 0o600 and 'NO_LEGACY_COPY' not in own.read_text())
    before = own.read_bytes()
    check('old source untouched', legacy.read_bytes() == legacy_data)
    stale = invoke('--preferences', request)
    check('stale source revision rejected', stale.returncode != 0 and own.read_bytes() == before)
    changed = json.loads(before)
    changed['future'] = {'private': 'OWN_FIELD_KEPT'}
    own.write_text(json.dumps(changed))
    fresh = json.loads(invoke('--preferences', {'action': 'read', 'context': context}).stdout)
    updated = invoke('--preferences', {**request, 'revision': fresh['revision']})
    check('unknown own fields preserved without returning them', updated.returncode == 0 and json.loads(own.read_text())['future']['private'] == 'OWN_FIELD_KEPT' and 'OWN_FIELD_KEPT' not in updated.stdout)
    bad_context = {'home': str(home), 'stateRoot': str(home / '.claude')}
    bad = invoke('--preferences', {**request, 'context': bad_context})
    check('client namespace rejected', bad.returncode != 0 and not (home / '.claude/preferences.json').exists())
    bad = invoke('--preferences', {**request, 'action': 'apply'})
    check('unknown action rejected', bad.returncode != 0)
    check('client remained unchanged', client.read_bytes() == b'CLIENT_MUST_NOT_CHANGE')

report = {'checks': len(checks), 'passed': sum(c['passed'] for c in checks), 'results': checks,
          'scope': 'Temporary HOME only; no real preferences, clients, browser, controller or network operations.'}
Path('../evidence/p2-state-bridge.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'checks': report['checks'], 'passed': report['passed']}))
assert report['checks'] == report['passed'], report
