#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Device lease tests refuse root and all arguments; no live device test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-device-lease"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -c "$source_dir/RelayTunDevice.c" -o "$build_dir/RelayTunDevice-$build_arch.o"
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -c "$source_dir/RelayTunRouteCodec.c" -o "$build_dir/RelayTunRouteCodec-$build_arch.o"
  cat "$source_dir/RelayTunDevice.h" "$source_dir/RelayTunRouteCodec.h" > "$build_dir/Bridge.h"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -import-objc-header "$build_dir/Bridge.h" \
    "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift" \
    "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunNetworkJournal.swift" \
    "$source_dir/RelayTunTransactionJournal.swift" "$source_dir/RelayTunRouteProjection.swift" \
    "$source_dir/RelayTunRouteObservation.swift" "$source_dir/RelayTunRouteSnapshot.swift" \
    "$source_dir/RelayTunRouteAdapter.swift" "$source_dir/RelayTunResolverAdapter.swift" \
    "$source_dir/RelayTunNetworkSession.swift" "$source_dir/RelayTunDeviceAdapter.swift" \
    "$source_dir/RelayTunDeviceLease.swift" "$source_dir/RelayTunDeviceLeaseTests.swift" \
    "$build_dir/RelayTunRouteCodec-$build_arch.o" "$build_dir/RelayTunDevice-$build_arch.o" \
    -framework Foundation -framework Security -framework SystemConfiguration -framework CryptoKit \
    -o "$build_dir/RelayTunDeviceLeaseTests-$build_arch"
done
lipo -create "$build_dir/RelayTunDeviceLeaseTests-arm64" "$build_dir/RelayTunDeviceLeaseTests-x86_64" -output "$build_dir/RelayTunDeviceLeaseTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunDeviceLeaseTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunDeviceLeaseTests"
# Device sessions and socket identity observations are injected. Inert pipe FDs
# exercise held-copy cleanup; the live driver is refused before any syscall.
"$build_dir/RelayTunDeviceLeaseTests"
