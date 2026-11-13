#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Fixed-core control tests require an ordinary user and accept no arguments.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-fixed-core"
mkdir -p "$build_dir"
sources=("$project_dir/native/RelayTunAcquiredReceipt.swift" "$project_dir/native/RelayTunDescriptor.swift")
for name in RelayTunHelperTrust RelayTunSmartTools RelayTunSmartStateCodec RelayTunExecutionReceiptV2 RelayTunExecutionInstallationV2 RelayTunCoreProbePlan RelayTunOwnedChild RelayTunCoreHost RelayTunCoreReadiness RelayTunLiveCore RelayTunRuntimeRules RelayTunRuntimeResources RelayTunFixedCoreTests; do
  sources+=("$project_dir/native/tun/$name.swift")
done
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_FIXED_CORE_TESTS \
    -target "$build_arch-apple-macosx13.0" -module-cache-path "$build_dir/ModuleCache-$build_arch" \
    "${sources[@]}" -framework Foundation -framework Security -framework CryptoKit \
    -o "$build_dir/RelayTunFixedCoreTests-$build_arch"
done
case "$(uname -m)" in
  arm64) fixed_arch=arm64 ;;
  x86_64) fixed_arch=x64 ;;
  *) exit 77 ;;
esac
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunFixedCoreTests-$(uname -m)"
codesign --verify --strict "$build_dir/RelayTunFixedCoreTests-$(uname -m)"
# The test-only launch pins the original executable and an exact configuration:
# all TCP/UDP listeners, providers, TUN, DNS, NTP and auto-downloads are disabled.
# Only the private Unix control socket is created. No installed component is used.
"$build_dir/RelayTunFixedCoreTests-$(uname -m)" "$project_dir/extra/relay/core/darwin-$fixed_arch/mihomo"
