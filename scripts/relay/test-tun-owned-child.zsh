#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Owned-child tests refuse root and all arguments; no live core or network test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-owned-child"
mkdir -p "$build_dir"
native_sources=("$project_dir/native/RelayTunAcquiredReceipt.swift" "$project_dir/native/RelayTunDescriptor.swift" "$project_dir/native/tun/RelayTunHelperTrust.swift" "$project_dir/native/tun/RelayTunSmartStateCodec.swift" "$project_dir/native/tun/RelayTunExecutionReceiptV2.swift" "$project_dir/native/tun/RelayTunExecutionInstallationV2.swift")
frameworks=(-framework Foundation -framework Security -framework CryptoKit)
for build_arch in arm64 x86_64; do
  # Shipping slice is checked without the fixture macro or legacy bridge.
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -typecheck -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${native_sources[@]}" \
    "$project_dir/native/tun/RelayTunCoreProbePlan.swift" "$project_dir/native/tun/RelayTunOwnedChild.swift" "${frameworks[@]}"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_OWNED_CHILD_TESTS -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${native_sources[@]}" \
    "$project_dir/native/tun/RelayTunCoreProbePlan.swift" "$project_dir/native/tun/RelayTunOwnedChild.swift" \
    "$project_dir/native/tun/RelayTunOwnedChildTests.swift" "${frameworks[@]}" -o "$build_dir/RelayTunOwnedChildTests-$build_arch"
done
lipo -create "$build_dir/RelayTunOwnedChildTests-arm64" "$build_dir/RelayTunOwnedChildTests-x86_64" -output "$build_dir/RelayTunOwnedChildTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunOwnedChildTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunOwnedChildTests"
# Tests only spawn this fixed inert self re-exec branch. No real utun, helper,
# Mihomo, network socket, system configuration or user process is touched.
"$build_dir/RelayTunOwnedChildTests"
