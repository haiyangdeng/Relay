#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h:h}"
cache_dir="$project_dir/.relay-build"
output_dir="$project_dir/extra/relay"
while (( $# > 0 )); do
  case "$1" in
    --output-dir) (( $# >= 2 )) || exit 64; output_dir="$2"; shift 2 ;;
    --cache-dir) (( $# >= 2 )) || exit 64; cache_dir="$2"; shift 2 ;;
    *) print -u2 'Usage: build-native.zsh [--output-dir <absolute-build-directory>] [--cache-dir <absolute-cache-directory>]'; exit 64 ;;
  esac
done
[[ "$output_dir" == /* && "$cache_dir" == /* ]] || exit 64
python3 - "$project_dir" "$output_dir" "$cache_dir" <<'PYBUILD'
from pathlib import Path
import sys
project = Path(sys.argv[1]).resolve()
for value, is_output in [(sys.argv[2], True), (sys.argv[3], False)]:
    path = Path(value)
    if path.resolve() != path or not (path == project / '.relay-build' or path.is_relative_to(project / '.relay-build') or (is_output and path == project / 'extra/relay')):
        raise SystemExit('Only this project generated resource/cache directories are accepted.')
PYBUILD
mkdir -p "$output_dir" "$cache_dir"
native_sources=("$project_dir"/native/*.swift "$project_dir"/native/legacy/*.swift)
native_sources+=("$project_dir/native/system-proxy/RelaySystemProxyHelperTrust.swift" "$project_dir/native/system-proxy/RelaySystemProxyHelperWire.swift")
browser_sources=()
for source_file in "${native_sources[@]}"; do
  if [[ "${source_file:t}" != RelayNative.swift ]]; then browser_sources+=("$source_file"); fi
done
for build_arch in arm64 x86_64; do
  mkdir -p "$cache_dir/ModuleCache-$build_arch"
  xcrun swiftc -parse-as-library -swift-version 5 -O -target "$build_arch-apple-macosx13.0" -module-cache-path "$cache_dir/ModuleCache-$build_arch" \
    "${native_sources[@]}" \
    -framework AppKit -framework SystemConfiguration -framework CryptoKit -framework NetworkExtension -framework SystemExtensions -framework Security -framework JavaScriptCore \
    -o "$cache_dir/RelayNative-$build_arch"
  xcrun swiftc -parse-as-library -swift-version 5 -O -target "$build_arch-apple-macosx13.0" -module-cache-path "$cache_dir/ModuleCache-$build_arch" \
    "${browser_sources[@]}" "$project_dir/native/browser/RelayBrowserMain.swift" \
    -framework AppKit -framework SystemConfiguration -framework CryptoKit -framework NetworkExtension -framework SystemExtensions -framework Security -framework JavaScriptCore \
    -o "$cache_dir/RelayBrowser-$build_arch"
done
lipo -create "$cache_dir/RelayNative-arm64" "$cache_dir/RelayNative-x86_64" -output "$output_dir/RelayNative"
codesign --force --sign - --timestamp=none "$output_dir/RelayNative"
lipo -create "$cache_dir/RelayBrowser-arm64" "$cache_dir/RelayBrowser-x86_64" -output "$cache_dir/RelayBrowser-universal"
zsh "$project_dir/scripts/relay/build-browser-wrapper.zsh" "$cache_dir/RelayBrowser-universal" "$output_dir"
print 'RelayNative and RelayBrowser.app built. No GUI, network, settings, or core started.'
