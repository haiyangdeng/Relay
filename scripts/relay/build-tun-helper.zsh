#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Offline helper build refuses root and arguments; no installation or live test mode.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
cache_dir="${RELAY_TUN_HELPER_BUILD_DIR:-$project_dir/.relay-build/tun-helper}"
capture_pin="${RELAY_TUN_CAPTURE_PIN_OUTPUT:-$project_dir/src/main/relay/tun/runtime-capture-client.json}"
rules_pin="${RELAY_TUN_RULES_PIN_OUTPUT:-$project_dir/src/main/relay/tun/runtime-rules-client.json}"
resources_pin="${RELAY_TUN_RESOURCES_PIN_OUTPUT:-$project_dir/src/main/relay/tun/runtime-resources-client.json}"
providers_pin="${RELAY_TUN_PROVIDERS_PIN_OUTPUT:-$project_dir/src/main/relay/tun/runtime-rule-providers-client.json}"
# Execution admission stays disabled unless this build selects an output.
execution_pin="${RELAY_TUN_EXECUTION_PIN_OUTPUT:-}"
# Smart tools admission is separate and stays disabled without an output.
smart_tools_pin="${RELAY_TUN_SMART_TOOLS_PIN_OUTPUT:-}"
# Telemetry admission stays disabled without an explicitly selected output.
telemetry_pin="${RELAY_TUN_TELEMETRY_PIN_OUTPUT:-}"
# History v3 remains unavailable unless its real verified build writes this pin.
history_pin="${RELAY_TUN_HISTORY_PIN_OUTPUT:-}"
if [[ "$cache_dir" != /* || "$capture_pin" != /* || "$rules_pin" != /* || "$resources_pin" != /* || "$providers_pin" != /* || ( -n "$execution_pin" && "$execution_pin" != /* ) || ( -n "$smart_tools_pin" && "$smart_tools_pin" != /* ) || ( -n "$telemetry_pin" && "$telemetry_pin" != /* ) || ( -n "$history_pin" && "$history_pin" != /* ) ]]; then
  print -u2 'Helper build and pin outputs must be explicit absolute paths.'
  exit 77
fi
mkdir -p "$cache_dir"
common=("$project_dir/native/RelayTunAcquiredReceipt.swift" "$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunCoreObservation.swift" "$source_dir/RelayTunXPC.swift")
network=(RelayTunNetworkTransaction RelayTunNetworkEffects RelayTunNetworkJournal RelayTunTransactionJournal RelayTunRouteProjection RelayTunRouteObservation RelayTunRouteSnapshot RelayTunRouteAdapter RelayTunResolverAdapter RelayTunNetworkProjection RelayTunNetworkSession RelayTunDeviceAdapter RelayTunDeviceLease RelayTunDeviceJournalStore RelayTunNetworkJournalStore RelayTunEnvironmentInspector RelayTunJournalArchive RelayTunUninstallFence)
network_sources=()
for name in "${network[@]}"; do network_sources+=("$source_dir/$name.swift"); done
client=(RelayTunCoreProbePlan RelayTunOwnedChild RelayTunCoreHost RelayTunCoreReadiness RelayTunLiveCore RelayTunCoreObservationEndpoint RelayTunAppBundle RelayTunRuntimeCapture RelayTunRuntimeRules RelayTunRuntimeResources RelayTunRuntimeResourceInbox RelayTunRuntimeAssetChannel RelayTunSmartState RelayTunSmartStateChannel RelayTunSmartTools RelayTunSmartToolsChannel RelayTunRuntimeResourcesChannel RelayTunRuntimeRuleProviders RelayTunRuntimeRuleProviderFiles RelayTunRuntimeRuleProviderProbe RelayTunRuleProviderProbeWorkspace RelayTunRuntimeRuleProvidersChannel RelayTunManagedCore RelayTunAppSession)
client_sources=("$project_dir/native/RelayTunDescriptor.swift" "$source_dir/RelayTunSmartStateCodec.swift" "$source_dir/RelayTunExecutionReceiptV2.swift" "$source_dir/RelayTunExecutionInstallationV2.swift")
for name in "${client[@]}"; do client_sources+=("$source_dir/$name.swift"); done
shipping_sources=("${common[@]}" "${network_sources[@]}" "${client_sources[@]}"
  "$source_dir/RelayTunPrivilegedExecutor.swift" "$source_dir/RelayTunExecutorService.swift" "$source_dir/RelayTunHelperMain.swift"
  "$source_dir/RelayTunClientMain.swift" "$source_dir/RelayTunUninstall.swift" "$source_dir/RelayTunUninstallMain.swift"
  "$source_dir/RelayTunDevice.c" "$source_dir/RelayTunDevice.h" "$source_dir/RelayTunRouteCodec.c" "$source_dir/RelayTunRouteCodec.h"
  "$project_dir/scripts/relay/build-tun-helper.zsh")
python3 - "$project_dir" "$cache_dir/source-before.json" "${shipping_sources[@]}" <<'PYCODE'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); files={str(pathlib.Path(p).relative_to(root)):hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in sys.argv[3:]}
pathlib.Path(sys.argv[2]).write_text(json.dumps({"version":1,"files":files},sort_keys=True))
PYCODE
retirement_sources=("$source_dir/RelayTunNetworkTransaction.swift" "$source_dir/RelayTunNetworkEffects.swift" "$source_dir/RelayTunNetworkJournal.swift" "$source_dir/RelayTunJournalArchive.swift" "$source_dir/RelayTunUninstallFence.swift")
frameworks=(-framework Foundation -framework Security -framework CryptoKit -framework SystemConfiguration)
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" -I "$source_dir" \
    -c "$source_dir/RelayTunDevice.c" -o "$cache_dir/RelayTunDevice-$build_arch.o"
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" -I "$source_dir" \
    -c "$source_dir/RelayTunRouteCodec.c" -o "$cache_dir/RelayTunRouteCodec-$build_arch.o"
  cat "$source_dir/RelayTunDevice.h" "$source_dir/RelayTunRouteCodec.h" > "$cache_dir/Bridge.h"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$cache_dir/ModuleCache-$build_arch" -import-objc-header "$cache_dir/Bridge.h" \
    "${common[@]}" "${network_sources[@]}" "$source_dir/RelayTunPrivilegedExecutor.swift" \
    "$source_dir/RelayTunExecutorService.swift" "$source_dir/RelayTunHelperMain.swift" \
    "$cache_dir/RelayTunDevice-$build_arch.o" "$cache_dir/RelayTunRouteCodec-$build_arch.o" "${frameworks[@]}" \
    -o "$cache_dir/RelayTunHelper-$build_arch"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$cache_dir/ModuleCache-$build_arch" -import-objc-header "$cache_dir/Bridge.h" \
    "${common[@]}" "${network_sources[@]}" "${client_sources[@]}" "$source_dir/RelayTunClientMain.swift" \
    "$cache_dir/RelayTunDevice-$build_arch.o" "$cache_dir/RelayTunRouteCodec-$build_arch.o" "${frameworks[@]}" \
    -o "$cache_dir/RelayTunClient-$build_arch"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$cache_dir/ModuleCache-$build_arch" \
    "$project_dir/native/RelayTunAcquiredReceipt.swift" "$source_dir/RelayTunHelperTrust.swift" "${retirement_sources[@]}" "$source_dir/RelayTunUninstall.swift" "$source_dir/RelayTunUninstallMain.swift" \
    "${frameworks[@]}" -o "$cache_dir/RelayTunUninstall-$build_arch"
done
for resource in RelayTunHelper RelayTunClient RelayTunUninstall; do
  lipo -create "$cache_dir/$resource-arm64" "$cache_dir/$resource-x86_64" -output "$cache_dir/$resource"
  codesign --force --sign - --identifier "local.relay.network.tun.$resource" --options runtime --timestamp=none "$cache_dir/$resource"
  codesign --verify --strict --all-architectures "$cache_dir/$resource"
done
# A production capability pin comes only from this freshly signed/verified
# universal client, never from an arbitrary installed manifest declaration.
python3 - "$cache_dir/RelayTunClient" "$capture_pin" "$rules_pin" "$resources_pin" "$project_dir" "$providers_pin" "$execution_pin" "$smart_tools_pin" "$telemetry_pin" "$history_pin" <<'PYCODE'
import hashlib,json,pathlib,sys
digest=hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
for output,capability in [(sys.argv[2],"runtime-capture-v1"),(sys.argv[3],"runtime-rules-v1")]:
    value={"version":1,"capability":capability,"clientSHA256":digest}
    pathlib.Path(output).write_text(json.dumps(value,indent=2)+"\n")
root=pathlib.Path(sys.argv[5])
profile=json.loads((root/"src/main/relay/core/geodata-manifest.json").read_text())
if profile["version"]!="relay-geodata-v1p1-3f27" or profile["capability"]!="local-geodata-v1":
    raise SystemExit("Unknown Geo Core profile")
cores={}
for architecture in ["arm64","x64"]:
    pin=profile["assets"][architecture]
    core=root/"extra/relay/core-geodata-v1"/pin["path"]
    if core.stat().st_size!=pin["size"] or hashlib.sha256(core.read_bytes()).hexdigest()!=pin["sha256"]:
        raise SystemExit("Paired Geo Core bytes changed")
    cores[architecture]=pin["sha256"]
value={"version":1,"capability":"runtime-resources-v1","clientSHA256":digest,"cores":cores}
pathlib.Path(sys.argv[4]).write_text(json.dumps(value,indent=2)+"\n")
value={"version":1,"capability":"runtime-rule-providers-v1","clientSHA256":digest,"cores":cores}
pathlib.Path(sys.argv[6]).write_text(json.dumps(value,indent=2)+"\n")
if sys.argv[7]:
    value={"version":1,"capability":"execution-v2","clientSHA256":digest}
    pathlib.Path(sys.argv[7]).write_text(json.dumps(value,indent=2)+"\n")
if sys.argv[8]:
    value={"version":1,"capability":"runtime-smart-tools-v1","clientSHA256":digest}
    pathlib.Path(sys.argv[8]).write_text(json.dumps(value,indent=2)+"\n")
if sys.argv[9]:
    value={"version":2,"capability":"runtime-telemetry-v2","clientSHA256":digest}
    pathlib.Path(sys.argv[9]).write_text(json.dumps(value,indent=2)+"\n")
if sys.argv[10]:
    value={"version":3,"capability":"runtime-history-v3","clientSHA256":digest}
    pathlib.Path(sys.argv[10]).write_text(json.dumps(value,indent=2)+"\n")
PYCODE
# Explicit injection runner, absent from every shipping main target.
xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -D RELAY_TUN_HELPER_TESTS \
  "${common[@]}" "${retirement_sources[@]}" "$source_dir/RelayTunUninstall.swift" "$source_dir/RelayTunHelperTests.swift" \
  "${frameworks[@]}" -o "$cache_dir/RelayTunHelperTests"
python3 - "$project_dir" "$cache_dir/source-before.json" "$cache_dir/shipping-sources.json" <<'PYCODE'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); before=json.loads(pathlib.Path(sys.argv[2]).read_text())
for name,digest in before["files"].items():
    if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest: raise RuntimeError("Shipping source changed during build: "+name)
pathlib.Path(sys.argv[3]).write_text(json.dumps(before,sort_keys=True))
PYCODE
print 'Network executor helper, continuous ordinary-UID client, fixed uninstaller and isolated runner built. Nothing installed, launched or changed on the host.'
