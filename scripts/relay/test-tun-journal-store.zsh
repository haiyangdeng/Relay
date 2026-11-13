#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h:h}"
cache_dir="$project_dir/.relay-build/tun-journal-store"
mkdir -p "$cache_dir"
sources=("$project_dir/native/tun/RelayTunHelperTrust.swift"
         "$project_dir/native/tun/RelayTunNetworkTransaction.swift"
         "$project_dir/native/tun/RelayTunNetworkEffects.swift"
         "$project_dir/native/tun/RelayTunNetworkJournal.swift"
         "$project_dir/native/tun/RelayTunNetworkEffectsTests.swift"
         "$project_dir/native/tun/RelayTunNetworkJournalStore.swift"
         "$project_dir/native/tun/RelayTunNetworkJournalStoreTests.swift")
production_sources=("$project_dir/native/tun/RelayTunHelperTrust.swift"
                    "$project_dir/native/tun/RelayTunNetworkTransaction.swift"
                    "$project_dir/native/tun/RelayTunNetworkEffects.swift"
                    "$project_dir/native/tun/RelayTunNetworkJournal.swift"
                    "$project_dir/native/tun/RelayTunNetworkJournalStore.swift")
for build_arch in arm64 x86_64; do
  # Check the shipping code with the test-only path factory absent.
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -typecheck \
    -target "$build_arch-apple-macosx13.0" -module-cache-path "$cache_dir/ModuleCache-$build_arch" \
    "${production_sources[@]}" -framework Foundation -framework Security -framework CryptoKit
  xcrun swiftc -parse-as-library -swift-version 5 -O -D RELAY_TUN_JOURNAL_STORE_TESTS \
    -target "$build_arch-apple-macosx13.0" -module-cache-path "$cache_dir/ModuleCache-$build_arch" \
    "${sources[@]}" -framework Foundation -framework Security -framework CryptoKit \
    -o "$cache_dir/RelayTunNetworkJournalStoreTests-$build_arch"
done
lipo -create "$cache_dir/RelayTunNetworkJournalStoreTests-arm64" "$cache_dir/RelayTunNetworkJournalStoreTests-x86_64" -output "$cache_dir/RelayTunNetworkJournalStoreTests"
codesign --force --sign - --options runtime --timestamp=none "$cache_dir/RelayTunNetworkJournalStoreTests"
codesign --verify --strict --all-architectures "$cache_dir/RelayTunNetworkJournalStoreTests"
# Only the compile-time ordinary-UID factory is used for private workspace files.
# The production root constructor is tested solely for rejection before file I/O.
"$cache_dir/RelayTunNetworkJournalStoreTests"
