#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h:h}"
cache_dir="$project_dir/.relay-build/tun-effects-journal"
mkdir -p "$cache_dir"
sources=("$project_dir/native/tun/RelayTunHelperTrust.swift"
         "$project_dir/native/tun/RelayTunNetworkTransaction.swift"
         "$project_dir/native/tun/RelayTunNetworkEffects.swift"
         "$project_dir/native/tun/RelayTunNetworkJournal.swift"
         "$project_dir/native/tun/RelayTunNetworkEffectsTests.swift"
         "$project_dir/native/tun/RelayTunNetworkJournalTests.swift")
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$cache_dir/ModuleCache-$build_arch" "${sources[@]}" \
    -framework Foundation -framework Security -framework CryptoKit \
    -o "$cache_dir/RelayTunNetworkEffectsJournalTests-$build_arch"
done
lipo -create "$cache_dir/RelayTunNetworkEffectsJournalTests-arm64" "$cache_dir/RelayTunNetworkEffectsJournalTests-x86_64" -output "$cache_dir/RelayTunNetworkEffectsJournalTests"
codesign --force --sign - --options runtime --timestamp=none "$cache_dir/RelayTunNetworkEffectsJournalTests"
codesign --verify --strict --all-architectures "$cache_dir/RelayTunNetworkEffectsJournalTests"
# Only the in-memory fake storage and network callbacks are exercised. This
# runner never invokes root file, Mach, interface, route or DNS implementations.
"$cache_dir/RelayTunNetworkEffectsJournalTests"
