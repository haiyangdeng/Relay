#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Core readiness tests refuse root and all arguments; no live core or network test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-core-readiness"
mkdir -p "$build_dir"
sources=(
  "$project_dir/native/RelayTunAcquiredReceipt.swift"
  "$project_dir/native/RelayTunDescriptor.swift"
  "$project_dir/native/tun/RelayTunHelperTrust.swift"
  "$project_dir/native/tun/RelayTunSmartTools.swift"
  "$project_dir/native/tun/RelayTunSmartStateCodec.swift" "$project_dir/native/tun/RelayTunExecutionReceiptV2.swift"
  "$project_dir/native/tun/RelayTunExecutionInstallationV2.swift"
  "$project_dir/native/tun/RelayTunCoreProbePlan.swift"
  "$project_dir/native/tun/RelayTunOwnedChild.swift"
  "$project_dir/native/tun/RelayTunCoreHost.swift"
  "$project_dir/native/tun/RelayTunCoreReadiness.swift"
  "$project_dir/native/tun/RelayTunLiveCore.swift"
  "$project_dir/native/tun/RelayTunRuntimeRules.swift"
  "$project_dir/native/tun/RelayTunRuntimeResources.swift"
)
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${sources[@]}" \
    "$project_dir/native/tun/RelayTunCoreReadinessTests.swift" \
    -framework Foundation -framework Security -framework CryptoKit \
    -o "$build_dir/RelayTunCoreReadinessTests-$build_arch"
done
lipo -create "$build_dir/RelayTunCoreReadinessTests-arm64" "$build_dir/RelayTunCoreReadinessTests-x86_64" -output "$build_dir/RelayTunCoreReadinessTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunCoreReadinessTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunCoreReadinessTests"
# Injected responses and an owned inert HTTP child on a private Unix socket
# cover readiness, including EOF. No core, TCP/UDP listener, TUN or host network
# configuration is started or changed.
"$build_dir/RelayTunCoreReadinessTests"
