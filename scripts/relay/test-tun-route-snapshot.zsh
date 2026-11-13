#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Route snapshot tests refuse root and all arguments; no live test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-route-snapshot"
mkdir -p "$build_dir"
sources=("$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift"
         "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunRouteSnapshot.swift")
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -typecheck \
    -target "$build_arch-apple-macosx13.0" -module-cache-path "$build_dir/ModuleCache-$build_arch" \
    "${sources[@]}" -framework Foundation -framework Security -framework CryptoKit
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -D RELAY_TUN_ROUTE_SNAPSHOT_TESTS \
    "${sources[@]}" "$source_dir/RelayTunRouteSnapshotTests.swift" \
    -framework Foundation -framework Security -framework CryptoKit -o "$build_dir/RelayTunRouteSnapshotTests-$build_arch"
done
lipo -create "$build_dir/RelayTunRouteSnapshotTests-arm64" "$build_dir/RelayTunRouteSnapshotTests-x86_64" -output "$build_dir/RelayTunRouteSnapshotTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunRouteSnapshotTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunRouteSnapshotTests"
# Fixtures invoke only injected memory drivers. The production sysctl reader is
# typechecked but never executed; no socket, helper or network mutation exists.
"$build_dir/RelayTunRouteSnapshotTests"
