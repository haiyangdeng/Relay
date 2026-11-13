#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Core observation tests refuse root and arguments; no XPC or live core test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-core-observation"
mkdir -p "$build_dir"
sources=(
  "$project_dir/native/RelayTunAcquiredReceipt.swift"
  "$project_dir/native/RelayTunDescriptor.swift"
  "$project_dir/native/tun/RelayTunHelperTrust.swift" "$project_dir/native/tun/RelayTunSmartStateCodec.swift" "$project_dir/native/tun/RelayTunExecutionReceiptV2.swift" "$project_dir/native/tun/RelayTunExecutionInstallationV2.swift"
  "$project_dir/native/tun/RelayTunCoreProbePlan.swift"
  "$project_dir/native/tun/RelayTunOwnedChild.swift"
  "$project_dir/native/tun/RelayTunCoreHost.swift"
  "$project_dir/native/tun/RelayTunCoreObservation.swift" "$project_dir/native/tun/RelayTunCoreObservationEndpoint.swift"
)
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${sources[@]}" \
    "$project_dir/native/tun/RelayTunCoreObservationTests.swift" \
    -framework Foundation -framework Security -framework CryptoKit \
    -o "$build_dir/RelayTunCoreObservationTests-$build_arch"
done
lipo -create "$build_dir/RelayTunCoreObservationTests-arm64" "$build_dir/RelayTunCoreObservationTests-x86_64" -output "$build_dir/RelayTunCoreObservationTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunCoreObservationTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunCoreObservationTests"
# Host/runtime/FD evidence and transport are injected; this never connects XPC,
# launches any child/core, creates a TUN interface or changes host configuration.
"$build_dir/RelayTunCoreObservationTests"
