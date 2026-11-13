"""Real Code/helper contracts. All configuration targets stay in a temporary HOME.

The production prepare operation may read current-user Chrome process metadata;
it never reads actual client settings or sends network traffic. A denied process
observation must block apply rather than be bypassed for this test.
"""
from pathlib import Path
import json
import subprocess
import tempfile

native = Path('extra/relay/RelayNative').resolve()
browser = native.with_name('RelayBrowser')
checks = []
def check(name, condition):
    checks.append({'name': name, 'passed': bool(condition)})
def invoke(operation, request):
    return subprocess.run([str(native), operation], input=json.dumps(request), capture_output=True, text=True, timeout=20)

description = subprocess.run([str(browser), '--describe'], capture_output=True, text=True, timeout=5)
check('bundled helper advertises matching namespace and port', description.returncode == 0 and
      json.loads(description.stdout) == {'version': 1, 'namespace': 'Relay-Preview', 'socksPort': 17890})
for raw in ['file:///etc/passwd', 'javascript:alert(1)', '--unexpected', 'https://user:pass@claude.ai/']:
    result = subprocess.run([str(browser), raw], capture_output=True, text=True, timeout=5)
    check('helper rejects URL before home/profile/launch', result.returncode != 0 and raw not in result.stderr)

applied = False
with tempfile.TemporaryDirectory(prefix='relay-code-bridge-') as directory:
    home = Path(directory).resolve() / 'home'
    home.mkdir(mode=0o700)
    assert home != Path.home()
    root = home / 'Library/Application Support/Relay-Preview'
    context = {'home': str(home), 'stateRoot': str(root), 'browserExecutable': str(browser)}
    settings = {'httpPort': 7890, 'node': 'fixture-node', 'internalExceptions': 'git.corp'}
    request = {'context': context, 'settings': settings}
    result = invoke('--code-prepare', request)
    check('prepare returns strict public metadata only', result.returncode == 0)
    report = json.loads(result.stdout)
    check('prepare creates no state or client directories', not root.exists() and not (home / '.claude').exists())
    check('prepared helper and four-target scope', report['helperReady'] is True and len(report['changedTargets']) == 4 and str(home) not in result.stdout)
    bad = invoke('--code-apply', {**request, 'expectedRevision': 'bad'})
    check('invalid proof rejected before writing', bad.returncode != 0 and not root.exists())
    missing = invoke('--code-prepare', {**request, 'context': {**context, 'browserExecutable': str(browser.parent / 'other')}})
    check('caller cannot redirect the bundled helper', missing.returncode != 0)
    if report['canApply']:
        result = invoke('--code-apply', {**request, 'expectedRevision': report['revision']})
        if result.returncode == 0:
            applied = True
            response = json.loads(result.stdout)
            client = json.loads((home / '.claude/settings.json').read_text())
            check('compiled joint transaction commits with durable backup', response['status'] == 'applied' and (root / 'Backups' / response['backupId'] / 'manifest.json').is_file())
            check('raw helper path and HTTP proxy written only in fixture', client['env']['BROWSER'] == str(browser) and client['env']['HTTPS_PROXY'] == 'http://127.0.0.1:7890')
            check('fixture preferences private and browser files present', (root / 'preferences.json').stat().st_mode & 0o777 == 0o600 and (root / 'Private Browser/Default/Preferences').is_file())
        else:
            # Process metadata can change between preparation and write. Verify
            # safe refusal, never force a second attempt or change observations.
            check('changed process observation safely refuses live-bridge write', not (home / '.claude/settings.json').exists())
    else:
        result = invoke('--code-apply', {**request, 'expectedRevision': report['revision']})
        check('unconfirmed process state blocks write', result.returncode != 0 and not (home / '.claude/settings.json').exists())

report = {'checks': len(checks), 'passed': sum(c['passed'] for c in checks), 'results': checks,
          'jointApplyExecutedInFixture': applied,
          'scope': 'Only fake HOME configuration targets. Helper describe/invalid URLs only; no browser launched or network request. Prepare may read actual current-user process metadata and can refuse it.'}
Path('../evidence/code-bridge.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'checks': report['checks'], 'passed': report['passed'], 'jointApplyExecutedInFixture': applied}))
assert report['checks'] == report['passed'], report
