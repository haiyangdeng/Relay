#!/bin/zsh
set -euo pipefail
if (( $# != 1 || EUID == 0 || UID == 0 )) || [[ "$1" != --inspect ]]; then
  print -u2 'Pass --inspect as the ordinary user; only read-only route diagnostics are available.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-route-read-only"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -c "$source_dir/RelayTunRouteCodec.c" -o "$build_dir/RelayTunRouteCodec-$build_arch.o"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -import-objc-header "$source_dir/RelayTunRouteCodec.h" \
    "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift" \
    "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunRouteProjection.swift" \
    "$source_dir/RelayTunRouteObservation.swift" "$source_dir/RelayTunRouteSnapshot.swift" \
    "$source_dir/RelayTunRouteReadOnlyMain.swift" "$build_dir/RelayTunRouteCodec-$build_arch.o" \
    -framework Foundation -framework Security -framework CryptoKit -o "$build_dir/RelayTunRouteReadOnly-$build_arch"
done
lipo -create "$build_dir/RelayTunRouteReadOnly-arm64" "$build_dir/RelayTunRouteReadOnly-x86_64" -output "$build_dir/RelayTunRouteReadOnly"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunRouteReadOnly"
codesign --verify --strict --all-architectures "$build_dir/RelayTunRouteReadOnly"
# Only read-only sysctl, interface-name lookup and local hash/parse operations.
# No helper connection, route socket, utun, network packet or system write exists.
"$build_dir/RelayTunRouteReadOnly" --inspect
