#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'App bundle tests refuse root and arguments; no live test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-app-bundle"
mkdir -p "$build_dir"
sources=("$project_dir/native/RelayTunAcquiredReceipt.swift" "$project_dir/native/RelayTunDescriptor.swift")
for name in RelayTunHelperTrust RelayTunSmartTools RelayTunSmartStateCodec RelayTunExecutionReceiptV2 RelayTunExecutionInstallationV2 RelayTunNetworkEffects RelayTunNetworkTransaction RelayTunNetworkJournal RelayTunNetworkProjection RelayTunCoreProbePlan RelayTunOwnedChild RelayTunCoreHost RelayTunCoreReadiness RelayTunRuntimeRules RelayTunRuntimeResources RelayTunRuntimeResourceInbox RelayTunRuntimeRuleProviders RelayTunRuntimeRuleProviderFiles RelayTunRuntimeRuleProviderProbe RelayTunRuleProviderProbeWorkspace RelayTunRuntimeAssetChannel RelayTunSmartState RelayTunSmartStateChannel RelayTunAppBundle RelayTunAppBundleTests; do
  sources+=("$project_dir/native/tun/$name.swift")
done
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_APP_BUNDLE_TESTS -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${sources[@]}" \
    -framework Foundation -framework Security -framework CryptoKit -o "$build_dir/RelayTunAppBundleTests-$build_arch"
done
lipo -create "$build_dir/RelayTunAppBundleTests-arm64" "$build_dir/RelayTunAppBundleTests-x86_64" -output "$build_dir/RelayTunAppBundleTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunAppBundleTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunAppBundleTests"
"$build_dir/RelayTunAppBundleTests"
