#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Core host tests refuse root and all arguments; no live test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-core-host"
mkdir -p "$build_dir"
sources=(
  "$project_dir/native/RelayTunAcquiredReceipt.swift"
  "$project_dir/native/RelayTunDescriptor.swift"
  "$project_dir/native/tun/RelayTunHelperTrust.swift" "$project_dir/native/tun/RelayTunSmartStateCodec.swift" "$project_dir/native/tun/RelayTunExecutionReceiptV2.swift" "$project_dir/native/tun/RelayTunExecutionInstallationV2.swift"
  "$project_dir/native/tun/RelayTunCoreProbePlan.swift"
  "$project_dir/native/tun/RelayTunOwnedChild.swift"
  "$project_dir/native/tun/RelayTunCoreHost.swift"
)
for build_arch in arm64 x86_64; do
  # The real process composition also typechecks without any inert test branch.
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -typecheck -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${sources[@]}" \
    -framework Foundation -framework Security -framework CryptoKit
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_OWNED_CHILD_TESTS -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" \
    "${sources[@]}" \
    "$project_dir/native/tun/RelayTunCoreHostTests.swift" \
    -framework Foundation -framework Security -framework CryptoKit \
    -o "$build_dir/RelayTunCoreHostTests-$build_arch"
done
lipo -create "$build_dir/RelayTunCoreHostTests-arm64" "$build_dir/RelayTunCoreHostTests-x86_64" -output "$build_dir/RelayTunCoreHostTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunCoreHostTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunCoreHostTests"
# FD/resource/readiness observations remain injected. The only real process is
# this binary's inert self re-exec; production code has no inert branch or entry.
# No live core, TUN, helper or network/system-configuration test mode exists.
"$build_dir/RelayTunCoreHostTests"
