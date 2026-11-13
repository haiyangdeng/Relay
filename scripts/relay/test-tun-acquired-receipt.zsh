#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Acquired receipt tests refuse root and all arguments; no live test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-acquired-receipt"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "$project_dir/native/RelayTunAcquiredReceipt.swift" \
    "$project_dir/native/tun/RelayTunAcquiredReceiptTests.swift" \
    -framework Foundation -o "$build_dir/RelayTunAcquiredReceiptTests-$build_arch"
done
lipo -create "$build_dir/RelayTunAcquiredReceiptTests-arm64" "$build_dir/RelayTunAcquiredReceiptTests-x86_64" -output "$build_dir/RelayTunAcquiredReceiptTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunAcquiredReceiptTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunAcquiredReceiptTests"
# Pure constructor/Codable fixtures only: no file, socket, Mach, core or helper.
"$build_dir/RelayTunAcquiredReceiptTests"
