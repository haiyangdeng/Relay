"""Negative contracts only: reject before any live OS/default/policy observation.

Positive readiness behavior is tested with injected observations in --self-test.
Never invokes the live readiness operation with a valid writable context.
"""
from pathlib import Path
import json
import subprocess
import tempfile

native = Path('extra/relay/RelayNative').resolve()
results = []


def rejected(name, args, raw):
    result = subprocess.run([str(native), *args], input=raw, capture_output=True,
                            text=True, timeout=5)
    results.append({'name': name, 'passed': result.returncode != 0
                    and not result.stdout and 'PRIVATE' not in result.stderr})


rejected('only exact fixed operation accepted', ['--desktop-readiness', '/PRIVATE/path'], '')
rejected('malformed input rejected without echo', ['--desktop-readiness'], 'PRIVATE malformed json')
rejected('oversize input rejected before context parsing', ['--desktop-readiness'], 'PRIVATE' * 80000)
with tempfile.TemporaryDirectory(prefix='relay-desktop-contract-') as temporary:
    home = Path(temporary).resolve() / 'home'
    home.mkdir(mode=0o700)
    rejected('redirected context rejected before live callbacks', ['--desktop-readiness'],
             json.dumps({'home': str(home), 'stateRoot': str(home / 'PRIVATE unsupported')}))
    results.append({'name': 'no fixture state created by rejected calls',
                    'passed': list(home.iterdir()) == []})

report = {'checks': len(results), 'passed': sum(row['passed'] for row in results),
          'results': results, 'liveReadinessObserved': False,
          'scope': 'Only invalid inputs and fake HOME rejected before OS callbacks. No Finder, browser, default changes, real client settings or network.'}
Path('../evidence/desktop-contract.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'checks': report['checks'], 'passed': report['passed']}))
assert report['checks'] == report['passed'], report
