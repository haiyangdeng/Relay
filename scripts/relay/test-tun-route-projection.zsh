#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Route projection tests refuse root and all arguments; no live test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-route-projection"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -c "$source_dir/RelayTunRouteCodec.c" -o "$build_dir/RelayTunRouteCodec-$build_arch.o"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -import-objc-header "$source_dir/RelayTunRouteCodec.h" \
    "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift" \
    "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunRouteProjection.swift" \
    "$source_dir/RelayTunRouteProjectionTests.swift" "$build_dir/RelayTunRouteCodec-$build_arch.o" \
    -framework Foundation -framework Security -framework CryptoKit -o "$build_dir/RelayTunRouteProjectionTests-$build_arch"
done
lipo -create "$build_dir/RelayTunRouteProjectionTests-arm64" "$build_dir/RelayTunRouteProjectionTests-x86_64" -output "$build_dir/RelayTunRouteProjectionTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunRouteProjectionTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunRouteProjectionTests"
# The codec transforms memory only; interface names come from injected closures.
# No routing socket, interface lookup, helper, root storage or DNS API is invoked.
"$build_dir/RelayTunRouteProjectionTests"
