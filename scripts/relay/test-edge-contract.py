"""Compiled negative Edge contracts. No valid live opener or policy mutation."""
from pathlib import Path
import json
import subprocess
import tempfile

native = Path('extra/relay/RelayNative').resolve()
rows = []


def rejected(name, args, data):
    result = subprocess.run([str(native), *args], input=data, text=True,
                            capture_output=True, timeout=5)
    rows.append({'name': name, 'passed': result.returncode != 0
                 and not result.stdout and 'PRIVATE' not in result.stderr})


rejected('exact operation only', ['--edge-tools', '/PRIVATE/path'], '')
rejected('invalid JSON', ['--edge-tools'], 'PRIVATE broken JSON')
rejected('bounded input', ['--edge-tools'], 'PRIVATE' * 10000)
rejected('fixed action enum', ['--edge-tools'], json.dumps({'action': 'PRIVATE injected'}))
with tempfile.TemporaryDirectory(prefix='relay-edge-contract-') as temporary:
    home = Path(temporary).resolve() / 'home'
    home.mkdir(mode=0o700)
    context = {'home': str(home), 'stateRoot': str(home / 'Library/Application Support/Relay-Preview')}
    for action in ['openProfile', 'deviceManagement', 'edgePolicy']:
        rejected('opener rejects redirected home: ' + action, ['--edge-tools'], json.dumps({
            'context': context, 'action': action, 'expectedRevision': 'a' * 64}))
    rejected('inspection validates state namespace before live callbacks', ['--edge-tools'], json.dumps({
        'context': {**context, 'stateRoot': str(home / 'PRIVATE unsupported')}, 'action': 'inspect'}))
    rejected('inspection does not accept an opening proof', ['--edge-tools'], json.dumps({
        'context': context, 'action': 'inspect', 'expectedRevision': 'a' * 64}))
    rows.append({'name': 'rejected calls create no fixture state', 'passed': list(home.iterdir()) == []})

report = {'checks': len(rows), 'passed': sum(row['passed'] for row in rows), 'results': rows,
          'actualOpenInvoked': False, 'actualProfileInstalled': False,
          'scope': 'Malformed and redirected requests only. No real browser, System Settings, policy inventory or network operations.'}
Path('../evidence/edge-native-contract.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'checks': report['checks'], 'passed': report['passed']}))
assert report['checks'] == report['passed'], report
