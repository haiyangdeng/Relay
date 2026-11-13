"""Restore fixed official resources from the checked-in manifest, never latest.

Optional proxy applies to these curl requests only, not OS or shell settings.
Unknown existing executable bytes are preserved rather than overwritten.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import argparse
import gzip
import hashlib
import json
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--proxy', choices=['http://127.0.0.1:7890'])
parser.add_argument('--architecture', choices=['arm64', 'x64'])
args = parser.parse_args()
app = Path(__file__).resolve().parents[2]
manifest = json.loads((app / 'src/main/relay/core/manifest.json').read_text())
assert manifest['schemaVersion'] == 1 and re.fullmatch(r'v\d+\.\d+\.\d+', manifest['version'])
cache = app / '.relay-build/core-downloads'
cache.mkdir(parents=True, exist_ok=True)


def fetch(arch):
    pin = manifest['assets'][arch]
    destination = app / 'extra/relay/core' / pin['path']
    assert pin['path'] == f'darwin-{arch}/mihomo'
    assert pin['url'] == f"https://github.com/MetaCubeX/mihomo/releases/download/{manifest['version']}/{pin['asset']}"
    assert '/' not in pin['asset'] and re.fullmatch(r'[a-f0-9]{64}', pin['archiveSHA256'])
    assert re.fullmatch(r'[a-f0-9]{64}', pin['sha256'])
    if destination.exists() or destination.is_symlink():
        assert not destination.is_symlink() and hashlib.sha256(destination.read_bytes()).hexdigest() == pin['sha256'], 'Existing resource changed; preserved'
        return {'architecture': arch, 'status': 'alreadyVerified'}
    archive = cache / pin['asset']
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != pin['archiveSHA256']:
        command = ['/usr/bin/curl', '--http1.1', '--fail', '--silent', '--show-error', '--location', '--max-time', '120']
        if args.proxy: command += ['--proxy', args.proxy]
        subprocess.run(command + [pin['url'], '--output', str(archive)], check=True)
    data = archive.read_bytes()
    assert hashlib.sha256(data).hexdigest() == pin['archiveSHA256']
    raw = gzip.decompress(data)
    assert len(raw) == pin['size'] and hashlib.sha256(raw).hexdigest() == pin['sha256']
    assert int.from_bytes(raw[:4], 'little') == 0xfeedfacf and int.from_bytes(raw[4:8], 'little') == pin['cpuType']
    destination.parent.mkdir(parents=True, exist_ok=True)
    assert destination.parent.resolve() == destination.parent
    with destination.open('xb') as output: output.write(raw)
    destination.chmod(0o755)
    return {'architecture': arch, 'status': 'downloadedAndVerified'}


with ThreadPoolExecutor(max_workers=2) as pool:
    result = list(pool.map(fetch, [args.architecture] if args.architecture else ['arm64', 'x64']))
print(json.dumps({'version': manifest['version'], 'resources': result, 'processStarted': False, 'systemSettingsChanged': False}))
