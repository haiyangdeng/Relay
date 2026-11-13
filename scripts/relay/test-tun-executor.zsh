#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Executor tests refuse root and all arguments; no live network test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-executor"
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
    "$source_dir/RelayTunNetworkProjection.swift" "$source_dir/RelayTunNetworkSession.swift" \
    "$source_dir/RelayTunDeviceAdapter.swift" "$source_dir/RelayTunDeviceLease.swift" \
    "$source_dir/RelayTunDeviceJournalStore.swift" "$source_dir/RelayTunNetworkJournalStore.swift" \
    "$source_dir/RelayTunEnvironmentInspector.swift" "$source_dir/RelayTunJournalArchive.swift" "$source_dir/RelayTunUninstallFence.swift" \
    "$project_dir/native/RelayTunAcquiredReceipt.swift" "$source_dir/RelayTunCoreObservation.swift" "$source_dir/RelayTunXPC.swift" \
    "$source_dir/RelayTunPrivilegedExecutor.swift" "$source_dir/RelayTunExecutorService.swift" "$source_dir/RelayTunExecutorTests.swift" \
    "$build_dir/RelayTunRouteCodec-$build_arch.o" "$build_dir/RelayTunDevice-$build_arch.o" \
    -framework Foundation -framework Security -framework SystemConfiguration -framework CryptoKit \
    -o "$build_dir/RelayTunExecutorTests-$build_arch"
done
lipo -create "$build_dir/RelayTunExecutorTests-arm64" "$build_dir/RelayTunExecutorTests-x86_64" -output "$build_dir/RelayTunExecutorTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunExecutorTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunExecutorTests"
# All capabilities are injected. Live factories are invoked only to prove they
# refuse an ordinary UID; no utun, route, DNS key, root file or Mach service.
"$build_dir/RelayTunExecutorTests"
