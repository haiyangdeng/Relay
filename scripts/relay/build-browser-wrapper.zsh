#!/bin/zsh
set -euo pipefail
if (( $# != 2 )); then
  print -u2 'Usage: build-browser-wrapper.zsh <compiled-browser-binary> <resource-output-directory>'
  exit 64
fi
project_dir="${0:A:h:h:h}"
python3 - "$project_dir" "$1" "$2" <<'PY'
import json
import hashlib
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile

project = Path(sys.argv[1]).resolve()
binary = Path(sys.argv[2]).resolve(strict=True)
requested_output = Path(sys.argv[3])
if not requested_output.is_absolute():
    raise SystemExit('Resource output must be an absolute build directory.')
output = requested_output.resolve()
allowed = output == project / 'extra/relay' or output.is_relative_to(project / '.relay-build')
if not allowed or requested_output != output or not binary.is_file() or not os.access(binary, os.X_OK):
    raise SystemExit('Only this project generated resource/cache directories are accepted.')
version = json.loads((project / 'package.json').read_text())['version']
match = re.search(r"^buildVersion:\s*['\"]?(\d+)['\"]?\s*$", (project / 'electron-builder.relay.yml').read_text(), re.M)
if not match:
    raise SystemExit('Build version must be explicitly configured.')
output.mkdir(parents=True, exist_ok=True)
wrapper = output / 'RelayBrowser.app'
def inventory_existing():
    if not wrapper.exists() and not wrapper.is_symlink():
        return None
    if wrapper.is_symlink() or not wrapper.is_dir():
        raise SystemExit('Unexpected wrapper output; preserved for review.')
    paths = list(wrapper.rglob('*'))
    if any(p.is_symlink() for p in paths):
        raise SystemExit('Wrapper contains a symlink; preserved for review.')
    info_path = wrapper / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    if info.get('CFBundleIdentifier') != 'local.relay.browser' or info.get('CFBundleExecutable') != 'RelayBrowser':
        raise SystemExit('Unexpected existing wrapper identity; preserved for review.')
    return {str(p.relative_to(wrapper)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}
existing = inventory_existing()
with tempfile.TemporaryDirectory(prefix='.relay-browser-', dir=output) as temporary:
    app = Path(temporary) / 'RelayBrowser.app'
    macos = app / 'Contents/MacOS'
    macos.mkdir(parents=True)
    info = {
        'CFBundleIdentifier': 'local.relay.browser',
        'CFBundleExecutable': 'RelayBrowser',
        'CFBundleName': 'Relay Browser',
        'CFBundleDisplayName': 'Relay 专用浏览器',
        'CFBundlePackageType': 'APPL',
        'CFBundleVersion': match.group(1),
        'CFBundleShortVersionString': version,
        'CFBundleInfoDictionaryVersion': '6.0',
        'LSMinimumSystemVersion': '13.0',
        'LSUIElement': True,
        'NSHighResolutionCapable': True,
        'NSPrincipalClass': 'NSApplication',
        'CFBundleURLTypes': [{'CFBundleURLName': 'local.relay.browser',
            'CFBundleURLSchemes': ['http', 'https'], 'CFBundleTypeRole': 'Viewer'}]
    }
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    executable = macos / 'RelayBrowser'
    shutil.copyfile(binary, executable)
    executable.chmod(0o755)
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', str(app)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--all-architectures', str(app)], check=True)
    # Publishing a generated wrapper never registers it with Launch Services.
    if inventory_existing() != existing:
        raise SystemExit('Wrapper output changed while building; preserved for review.')
    previous = Path(temporary) / 'previous.app'
    if existing is not None:
        wrapper.rename(previous)
    try:
        app.rename(wrapper)
    except BaseException:
        if existing is not None:
            previous.rename(wrapper)
        raise
legacy = output / 'RelayBrowser'
if legacy.exists() or legacy.is_symlink():
    if not stat.S_ISREG(legacy.lstat().st_mode):
        raise SystemExit('Unexpected legacy browser resource; preserved for review.')
    legacy.unlink()
print('Built RelayBrowser.app; no application launched or URL handler registered.')
PY
