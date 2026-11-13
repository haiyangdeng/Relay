#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h:h}"
cache_dir="$project_dir/.relay-build/tun-network-transaction"
mkdir -p "$cache_dir"
sources=("$project_dir/native/tun/RelayTunNetworkTransaction.swift" "$project_dir/native/tun/RelayTunNetworkTransactionTests.swift")
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$cache_dir/ModuleCache-$build_arch" "${sources[@]}" \
    -framework Foundation -o "$cache_dir/RelayTunNetworkTransactionTests-$build_arch"
done
lipo -create "$cache_dir/RelayTunNetworkTransactionTests-arm64" "$cache_dir/RelayTunNetworkTransactionTests-x86_64" -output "$cache_dir/RelayTunNetworkTransactionTests"
codesign --force --sign - --options runtime --timestamp=none "$cache_dir/RelayTunNetworkTransactionTests"
codesign --verify --strict --all-architectures "$cache_dir/RelayTunNetworkTransactionTests"
# The runner uses only in-memory Environment closures. Neither platform slice
# contains a live kernel, helper or persistence adapter.
"$cache_dir/RelayTunNetworkTransactionTests"
