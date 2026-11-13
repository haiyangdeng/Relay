#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Resolver tests refuse root and all arguments; no privileged test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-resolver-adapter"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -D RELAY_TUN_RESOLVER_TESTS \
    "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunNetworkTransaction.swift" \
    "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunResolverAdapter.swift" \
    "$source_dir/RelayTunResolverAdapterTests.swift" \
    -framework Foundation -framework Security -framework CryptoKit -framework SystemConfiguration \
    -o "$build_dir/RelayTunResolverAdapterTests-$build_arch"
done
lipo -create "$build_dir/RelayTunResolverAdapterTests-arm64" "$build_dir/RelayTunResolverAdapterTests-x86_64" -output "$build_dir/RelayTunResolverAdapterTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunResolverAdapterTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunResolverAdapterTests"
# Only injected sessions are exercised; production permission failures precede
# every configd API. No real store session, root path or DNS query is created.
"$build_dir/RelayTunResolverAdapterTests"
