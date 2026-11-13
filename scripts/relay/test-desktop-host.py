"""Production pipe/idle lifecycle only. NEVER sends start/restore/cancel.

Initialization reads current-user directory metadata but acquires no locks,
reads no client settings/default values and performs no proxy/browser operation.
Signal tests target only these newly spawned, inert fixture worker processes.
"""
from pathlib import Path
import json
import os
import pwd
import select
import signal
import subprocess

native = Path('extra/relay/RelayNative').resolve()
home = Path(pwd.getpwuid(os.getuid()).pw_dir)
root = home / 'Library/Application Support/Relay-Preview'
legacy = home / 'Library/Application Support/Claude Desktop Login'
context = {'home': str(home), 'stateRoot': str(root)}
tracked = [root / '.state.lock', root / 'Desktop Login', root / 'Desktop Login/.lock',
           root / 'Desktop Login/state.json', legacy / '.lock', legacy / 'state.json']


def metadata():
    values = []
    for path in tracked:
        try:
            info = path.lstat()
            values.append((info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns))
        except FileNotFoundError:
            values.append(None)
    return values


before = metadata()
results = []


def check(name, value):
    results.append({'name': name, 'passed': bool(value)})


def spawn():
    return subprocess.Popen([str(native), '--desktop-session'], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)


def send(process, id, action, supplied=None):
    message = {'id': id, 'action': action}
    if supplied is not None:
        message['context'] = supplied
    process.stdin.write(json.dumps(message) + '\n')
    process.stdin.flush()


def read(process):
    assert select.select([process.stdout], [], [], 10)[0], 'idle protocol response timed out'
    return json.loads(process.stdout.readline())


def initialize(process):
    send(process, 1, 'initialize', context)
    response = read(process)
    check('production initialization is idle and does not own a record',
          response['id'] == 1 and response['snapshot']['phase'] == 'idle'
          and not response['snapshot']['hasRecord'] and response['snapshot']['canClose'])
    check('wire output contains no real home path', str(home) not in json.dumps(response))


def done(process, expected):
    code = process.wait(timeout=10)
    check('inert worker exit code', code == expected)
    if not process.stdin.closed:
        process.stdin.close()
    if not process.stdout.closed:
        process.stdout.close()
    error = process.stderr.read()
    process.stderr.close()
    check('controlled protocol errors do not echo private payloads', 'PRIVATE' not in error)


process = spawn()
initialize(process)
send(process, 2, 'status')
check('status reuses persistent inert process', read(process)['id'] == 2)
send(process, 3, 'close')
response = read(process)
check('close is acknowledged before process exit', response['id'] == 3 and response['closing'])
done(process, 0)

process = spawn()
initialize(process)
process.stdin.close()
done(process, 0)

process = spawn()
initialize(process)
process.send_signal(signal.SIGTERM)
done(process, 0)

process = spawn()
initialize(process)
process.stdout.close()
send(process, 2, 'status')  # Triggers SIGPIPE path, still no mutating command.
done(process, 0)

process = spawn()
initialize(process)
send(process, 1, 'status')
done(process, 2)

for raw in ['PRIVATE malformed\n', 'A' * 65537 + '\n', '{',
            json.dumps({'id': 1, 'action': 'initialize', 'context': {**context, 'stateRoot': '/PRIVATE/redirect'}}) + '\n']:
    process = spawn()
    process.stdin.write(raw)
    process.stdin.close()
    done(process, 2)

check('idle lifecycle did not create, chmod, update or remove tracked state', before == metadata())
report = {'checks': len(results), 'passed': sum(row['passed'] for row in results), 'results': results,
          'currentUserDirectoryMetadataRead': True, 'clientSettingsRead': False,
          'defaultBrowserReadOrChanged': False, 'mutatingSessionCommandSent': False,
          'browserLaunched': False, 'proxyProbed': False,
          'scope': 'Real compiled persistent worker protocol/idle lifecycle. Start, restore and cancel are NEVER sent. Active-session effects covered by injected native tests.'}
Path('../evidence/host-process-contract.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'checks': report['checks'], 'passed': report['passed']}))
assert report['checks'] == report['passed'], report
