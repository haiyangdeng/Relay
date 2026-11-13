#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Build as the ordinary user without arguments; no live observation is run.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
observer_dir="$project_dir/native/network-observer"
build_dir="$project_dir/.relay-build/network-observer"
mkdir -p "$build_dir" "$project_dir/extra/relay"
cat "$source_dir/RelayTunRouteCodec.h" > "$build_dir/Bridge.h"
sources=(
  "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift"
  "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunNetworkJournal.swift"
  "$source_dir/RelayTunRouteProjection.swift" "$source_dir/RelayTunRouteSnapshot.swift"
  "$source_dir/RelayTunRouteObservation.swift" "$source_dir/RelayTunEnvironmentInspector.swift"
)
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -c "$source_dir/RelayTunRouteCodec.c" -o "$build_dir/RelayTunRouteCodec-$build_arch.o"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -import-objc-header "$build_dir/Bridge.h" \
    "${sources[@]}" "$observer_dir/RelayNetworkObserver.swift" "$observer_dir/RelayNetworkObserverMain.swift" \
    "$build_dir/RelayTunRouteCodec-$build_arch.o" \
    -framework Foundation -framework Security -framework SystemConfiguration -framework CryptoKit \
    -o "$build_dir/RelayNetworkObserver-$build_arch"
done
lipo -create "$build_dir/RelayNetworkObserver-arm64" "$build_dir/RelayNetworkObserver-x86_64" \
  -output "$project_dir/extra/relay/RelayNetworkObserver"
codesign --force --sign - --options runtime --timestamp=none "$project_dir/extra/relay/RelayNetworkObserver"
codesign --verify --strict --all-architectures "$project_dir/extra/relay/RelayNetworkObserver"
# Reuse the inspector's existing injected-source regressions; never run its live CLI.
test_arch="$(uname -m)"
for test_name in RelayTunEnvironmentInspectorTests RelayNetworkObserverTests; do
  test_source="$source_dir/$test_name.swift"
  extras=()
  if [[ "$test_name" == RelayNetworkObserverTests ]]; then
    test_source="$observer_dir/$test_name.swift"
    extras=("$observer_dir/RelayNetworkObserver.swift")
  fi
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_INSPECTOR_TESTS \
    -target "$test_arch-apple-macosx13.0" -module-cache-path "$build_dir/ModuleCache-tests-$test_arch" \
    -import-objc-header "$build_dir/Bridge.h" "${sources[@]}" "${extras[@]}" "$test_source" \
    "$build_dir/RelayTunRouteCodec-$test_arch.o" \
    -framework Foundation -framework Security -framework SystemConfiguration -framework CryptoKit \
    -o "$build_dir/$test_name"
  "$build_dir/$test_name"
done
print 'Bundled read-only observer built and injected-source checks passed. No live observation, core, network or system settings used.'
