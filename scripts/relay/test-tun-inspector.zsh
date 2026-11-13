#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Environment inspector tests refuse root and all arguments; no live test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-inspector"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -c "$source_dir/RelayTunRouteCodec.c" -o "$build_dir/RelayTunRouteCodec-$build_arch.o"
  cat "$source_dir/RelayTunRouteCodec.h" > "$build_dir/Bridge.h"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_INSPECTOR_TESTS -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -import-objc-header "$build_dir/Bridge.h" \
    "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift" \
    "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunNetworkJournal.swift" \
    "$source_dir/RelayTunRouteProjection.swift" "$source_dir/RelayTunRouteSnapshot.swift" \
    "$source_dir/RelayTunRouteObservation.swift" \
    "$source_dir/RelayTunEnvironmentInspector.swift" "$source_dir/RelayTunEnvironmentInspectorTests.swift" \
    "$build_dir/RelayTunRouteCodec-$build_arch.o" \
    -framework Foundation -framework Security -framework SystemConfiguration -framework CryptoKit \
    -o "$build_dir/RelayTunEnvironmentInspectorTests-$build_arch"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-cli-$build_arch" -import-objc-header "$build_dir/Bridge.h" \
    "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift" \
    "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunNetworkJournal.swift" \
    "$source_dir/RelayTunRouteProjection.swift" "$source_dir/RelayTunRouteSnapshot.swift" \
    "$source_dir/RelayTunRouteObservation.swift" \
    "$source_dir/RelayTunEnvironmentInspector.swift" "$source_dir/RelayTunEnvironmentInspectorMain.swift" \
    "$build_dir/RelayTunRouteCodec-$build_arch.o" \
    -framework Foundation -framework Security -framework SystemConfiguration -framework CryptoKit \
    -o "$build_dir/RelayTunEnvironmentInspector-$build_arch"
done
lipo -create "$build_dir/RelayTunEnvironmentInspectorTests-arm64" "$build_dir/RelayTunEnvironmentInspectorTests-x86_64" -output "$build_dir/RelayTunEnvironmentInspectorTests"
lipo -create "$build_dir/RelayTunEnvironmentInspector-arm64" "$build_dir/RelayTunEnvironmentInspector-x86_64" -output "$build_dir/RelayTunEnvironmentInspector"
for resource in RelayTunEnvironmentInspectorTests RelayTunEnvironmentInspector; do
  codesign --force --sign - --options runtime --timestamp=none "$build_dir/$resource"
  codesign --verify --strict --all-architectures "$build_dir/$resource"
done
# All inspector sources are injected here. The live CLI is read-only at an
# ordinary UID: two consecutive captures must report identical digests.
"$build_dir/RelayTunEnvironmentInspectorTests"
"$build_dir/RelayTunEnvironmentInspector" --inspect
"$build_dir/RelayTunEnvironmentInspector" --inspect
