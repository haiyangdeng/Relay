#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Network projection tests refuse root and arguments; no live operation exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-network-projection"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" \
    "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift" \
    "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunNetworkProjection.swift" \
    "$source_dir/RelayTunNetworkProjectionTests.swift" \
    -framework Foundation -framework Security -framework CryptoKit -o "$build_dir/RelayTunNetworkProjectionTests-$build_arch"
done
lipo -create "$build_dir/RelayTunNetworkProjectionTests-arm64" "$build_dir/RelayTunNetworkProjectionTests-x86_64" -output "$build_dir/RelayTunNetworkProjectionTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunNetworkProjectionTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunNetworkProjectionTests"
"$build_dir/RelayTunNetworkProjectionTests"
