#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'App session tests refuse root and arguments; no live test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-app-session"
mkdir -p "$build_dir"
sources=("$project_dir/native/RelayTunAcquiredReceipt.swift" "$project_dir/native/RelayTunDescriptor.swift")
for name in RelayTunHelperTrust RelayTunSmartTools RelayTunSmartStateCodec RelayTunExecutionReceiptV2 RelayTunExecutionInstallationV2 RelayTunCoreObservation RelayTunCoreObservationEndpoint RelayTunXPC RelayTunNetworkTransaction RelayTunNetworkEffects RelayTunNetworkJournal RelayTunRouteProjection RelayTunRouteObservation RelayTunRouteSnapshot RelayTunNetworkProjection RelayTunEnvironmentInspector RelayTunCoreProbePlan RelayTunOwnedChild RelayTunCoreHost RelayTunCoreReadiness RelayTunLiveCore RelayTunAppBundle RelayTunRuntimeCapture RelayTunRuntimeRules RelayTunRuntimeResources RelayTunRuntimeResourceInbox RelayTunRuntimeAssetChannel RelayTunSmartState RelayTunSmartStateChannel RelayTunSmartToolsChannel RelayTunRuntimeResourcesChannel RelayTunRuntimeRuleProviders RelayTunRuntimeRuleProviderFiles RelayTunRuntimeRuleProviderProbe RelayTunRuleProviderProbeWorkspace RelayTunRuntimeRuleProvidersChannel RelayTunManagedCore RelayTunAppSession RelayTunAppSessionTests; do
  sources+=("$source_dir/$name.swift")
done
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" -I "$source_dir" \
    -c "$source_dir/RelayTunRouteCodec.c" -o "$build_dir/RelayTunRouteCodec-$build_arch.o"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_APP_SESSION_TESTS -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -import-objc-header "$source_dir/RelayTunRouteCodec.h" "${sources[@]}" \
    "$build_dir/RelayTunRouteCodec-$build_arch.o" -framework Foundation -framework Security -framework CryptoKit -framework SystemConfiguration \
    -o "$build_dir/RelayTunAppSessionTests-$build_arch"
done
lipo -create "$build_dir/RelayTunAppSessionTests-arm64" "$build_dir/RelayTunAppSessionTests-x86_64" -output "$build_dir/RelayTunAppSessionTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunAppSessionTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunAppSessionTests"
"$build_dir/RelayTunAppSessionTests"
