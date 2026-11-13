#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Journal archive tests refuse root and arguments; no system/uninstall test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-journal-archive"
mkdir -p "$build_dir"
sources=(
  "$project_dir/native/RelayTunAcquiredReceipt.swift"
  "$project_dir/native/tun/RelayTunHelperTrust.swift"
  "$project_dir/native/tun/RelayTunNetworkTransaction.swift"
  "$project_dir/native/tun/RelayTunNetworkEffects.swift"
  "$project_dir/native/tun/RelayTunNetworkJournal.swift"
  "$project_dir/native/tun/RelayTunNetworkJournalStore.swift"
  "$project_dir/native/tun/RelayTunJournalArchive.swift"
  "$project_dir/native/tun/RelayTunUninstallFence.swift"
  "$project_dir/native/tun/RelayTunUninstall.swift"
)
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -typecheck -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${sources[@]}" -framework Foundation -framework Security -framework CryptoKit
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_JOURNAL_ARCHIVE_TESTS -D RELAY_TUN_JOURNAL_STORE_TESTS \
    -target "$build_arch-apple-macosx13.0" -module-cache-path "$build_dir/ModuleCache-$build_arch" "${sources[@]}" \
    "$project_dir/native/tun/RelayTunNetworkEffectsTests.swift" "$project_dir/native/tun/RelayTunUninstallArchiveTests.swift" "$project_dir/native/tun/RelayTunJournalArchiveTests.swift" \
    -framework Foundation -framework Security -framework CryptoKit -o "$build_dir/RelayTunJournalArchiveTests-$build_arch"
done
lipo -create "$build_dir/RelayTunJournalArchiveTests-arm64" "$build_dir/RelayTunJournalArchiveTests-x86_64" -output "$build_dir/RelayTunJournalArchiveTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunJournalArchiveTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunJournalArchiveTests"
"$build_dir/RelayTunJournalArchiveTests"
