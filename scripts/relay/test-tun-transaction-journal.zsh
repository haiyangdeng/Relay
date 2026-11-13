#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h:h}"
cache_dir="$project_dir/.relay-build/tun-transaction-journal"
mkdir -p "$cache_dir"
sources=("$project_dir/native/tun/RelayTunHelperTrust.swift"
         "$project_dir/native/tun/RelayTunNetworkTransaction.swift"
         "$project_dir/native/tun/RelayTunNetworkEffects.swift"
         "$project_dir/native/tun/RelayTunNetworkJournal.swift"
         "$project_dir/native/tun/RelayTunNetworkEffectsTests.swift"
         "$project_dir/native/tun/RelayTunTransactionJournal.swift"
         "$project_dir/native/tun/RelayTunTransactionJournalTests.swift")
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -O -warnings-as-errors -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$cache_dir/ModuleCache-$build_arch" "${sources[@]}" \
    -framework Foundation -framework Security -framework CryptoKit \
    -o "$cache_dir/RelayTunTransactionJournalTests-$build_arch"
done
lipo -create "$cache_dir/RelayTunTransactionJournalTests-arm64" "$cache_dir/RelayTunTransactionJournalTests-x86_64" -output "$cache_dir/RelayTunTransactionJournalTests"
codesign --force --sign - --options runtime --timestamp=none "$cache_dir/RelayTunTransactionJournalTests"
codesign --verify --strict --all-architectures "$cache_dir/RelayTunTransactionJournalTests"
"$cache_dir/RelayTunTransactionJournalTests"
