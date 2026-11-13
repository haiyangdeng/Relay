#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Read capability tests refuse root and arguments; no helper/Core/TUN or live mode.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-runtime-capture"
mkdir -p "$build_dir"
sources=("$project_dir/native/RelayTunAcquiredReceipt.swift" "$project_dir/native/RelayTunDescriptor.swift")
for name in RelayTunHelperTrust RelayTunSmartStateCodec RelayTunExecutionReceiptV2 RelayTunExecutionInstallationV2 RelayTunCoreProbePlan RelayTunOwnedChild RelayTunRuntimeCapture RelayTunRuntimeCaptureTests; do
  sources+=("$project_dir/native/tun/$name.swift")
done
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${sources[@]}" \
    -framework Foundation -framework Security -framework CryptoKit -o "$build_dir/RelayTunRuntimeCaptureTests-$build_arch"
done
"$build_dir/RelayTunRuntimeCaptureTests-arm64"
