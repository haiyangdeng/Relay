#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h:h}"
output_dir="${RELAY_UNINSTALL_BUILD_DIR:-$project_dir/.relay-build/uninstall-supervisor}"
if (( $# > 0 )); then
  [[ $# == 2 && "$1" == --output-dir ]] || exit 64
  output_dir="$2"
fi
[[ "$output_dir" == "$project_dir/.relay-build/"* ]] || { print -u2 'Use a private .relay-build output directory'; exit 64; }
mkdir -p "$output_dir"
sources=("$project_dir"/native/uninstall/*.swift)
python3 - "$project_dir" "$output_dir" <<'PYSNAPSHOT'
import hashlib, json, pathlib, sys
root, out = map(pathlib.Path, sys.argv[1:])
sources = sorted((root / 'native/uninstall').glob('*.swift')) + [root / 'native/uninstall/local.relay.network.uninstall.plist', root / 'scripts/relay/build-uninstall-supervisor.zsh']
(out / 'source-snapshot.json').write_text(json.dumps({str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}, sort_keys=True))
PYSNAPSHOT
for arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$arch-apple-macosx13.0" -module-cache-path "$project_dir/.relay-build/ModuleCache-$arch" \
    "${sources[@]}" -framework Foundation -framework CryptoKit -framework AppKit -framework Security -o "$output_dir/RelayUninstallSupervisor-$arch"
done
lipo -create "$output_dir/RelayUninstallSupervisor-arm64" "$output_dir/RelayUninstallSupervisor-x86_64" -output "$output_dir/RelayUninstallSupervisor"
codesign --force --sign - --timestamp=none "$output_dir/RelayUninstallSupervisor"
codesign --verify --strict --all-architectures "$output_dir/RelayUninstallSupervisor"
"$output_dir/RelayUninstallSupervisor" --self-test > "$output_dir/self-test.json"
cp "$project_dir/native/uninstall/local.relay.network.uninstall.plist" "$output_dir/local.relay.network.uninstall.plist"
python3 - "$project_dir" "$output_dir" <<'PY'
import hashlib, json, pathlib, sys
root, out = map(pathlib.Path, sys.argv[1:])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
sources = sorted((root / 'native/uninstall').glob('*.swift')) + [root / 'native/uninstall/local.relay.network.uninstall.plist', root / 'scripts/relay/build-uninstall-supervisor.zsh']
assert {str(p.relative_to(root)):sha(p) for p in sources} == json.loads((out / 'source-snapshot.json').read_text()), 'Sources changed during build'
report = json.loads((out / 'self-test.json').read_text())
assert report['passed'] is True
receipt = dict(passed=True, architectures=['arm64', 'x86_64'], supervisorSHA256=sha(out / 'RelayUninstallSupervisor'), daemonSHA256=sha(out / 'local.relay.network.uninstall.plist'), sourceSHA256={str(p.relative_to(root)):sha(p) for p in sources}, systemChangesExecuted=False)
(out / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
PY
print 'Universal automatic-uninstall monitor built; no service installed or system changes executed.'
