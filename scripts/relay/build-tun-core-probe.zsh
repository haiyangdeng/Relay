#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Core FD probe preparation refuses root and arguments; no privileged execution exists here.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-core-probe"
mkdir -p "$build_dir"
for core_arch in arm64 x64; do
  python3 "$project_dir/scripts/relay/stage-tun-probe.py" "core-$core_arch" > "$build_dir/core-$core_arch-deployment.json"
done
python3 - "$project_dir" "$build_dir" <<'PY'
import json
from pathlib import Path
import sys

app, root = map(Path, sys.argv[1:])
manifest = json.loads((app / 'src/main/relay/core/manifest.json').read_text())
lines = ['import Foundation', 'enum RelayTunCoreProbeBuild {']
for index, arch in enumerate(('arm64', 'x64')):
    deployed = json.loads((root / f'core-{arch}-deployment.json').read_text())
    asset = manifest['assets'][arch]
    assert deployed['sha256'] == asset['sha256']
    lines += ['    #if arch(arm64)' if index == 0 else '    #else',
              '    static let executable = ' + json.dumps(deployed['path']),
              '    static let sha256 = ' + json.dumps(asset['sha256']),
              '    static let size: Int = ' + str(asset['size']),
              '    static let cpuType: UInt32 = ' + str(asset['cpuType'])]
lines += ['    #endif', '}', '']
(root / 'RelayTunCoreProbeBuild.swift').write_text('\n'.join(lines))
PY
client_sources=("$source_dir/RelayTunHelperTrust.swift" "$source_dir/RelayTunCoreProbePlan.swift")
for source_file in "$project_dir"/native/*.swift "$project_dir"/native/legacy/*.swift; do
  if [[ "${source_file:t}" != RelayNative.swift ]]; then client_sources+=("$source_file"); fi
done
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${client_sources[@]}" \
    "$build_dir/RelayTunCoreProbeBuild.swift" "$source_dir/RelayTunCoreProbeClient.swift" \
    -framework AppKit -framework SystemConfiguration -framework CryptoKit -framework NetworkExtension \
    -framework SystemExtensions -framework Security -framework JavaScriptCore -o "$build_dir/RelayTunCoreProbeClient-$build_arch"
done
lipo -create "$build_dir/RelayTunCoreProbeClient-arm64" "$build_dir/RelayTunCoreProbeClient-x86_64" -output "$build_dir/RelayTunCoreProbeClient"
chmod 0755 "$build_dir/RelayTunCoreProbeClient"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunCoreProbeClient"
codesign --verify --strict --all-architectures "$build_dir/RelayTunCoreProbeClient"
python3 "$project_dir/scripts/relay/stage-tun-probe.py" core-client > "$build_dir/client-deployment.json"
"$build_dir/RelayTunCoreProbeClient" --verify-core-only > "$build_dir/core-resource-read-only.json"
python3 - "$build_dir" <<'PY'
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1]); client = json.loads((root / 'client-deployment.json').read_text())
reply = '{"version":1,"receiptBindingValidated":true,"ordinaryUID":true,"coreResourceVerified":true,"coreVersionVerified":true,"coreTunFDVerified":true,"coreExited":true,"FDClosed":true,"privateDirectoryRemoved":true,"actualTunAccepted":false}\n'
lines = ['#ifndef RELAY_TUN_DESCRIPTOR_PROBE_BUILD_H', '#define RELAY_TUN_DESCRIPTOR_PROBE_BUILD_H',
         '#define RELAY_PROBE_CLIENT_UID ' + str(os.getuid()), '#define RELAY_PROBE_CLIENT_GID ' + str(os.getgid()),
         '#define RELAY_PROBE_CLIENT_PATH ' + json.dumps(client['path']),
         '#define RELAY_PROBE_CLIENT_SHA256 ' + json.dumps(client['sha256']),
         '#define RELAY_PROBE_ACTION "--adopt-fixed-core-and-release"',
         '#define RELAY_PROBE_CLIENT_ARGUMENT "--adopt-received-device-in-fixed-core"',
         '#define RELAY_PROBE_EXPECTED_REPLY ' + json.dumps(reply),
         '#define RELAY_PROBE_TIMEOUT_NS UINT64_C(30000000000)', '#define RELAY_PROBE_CORE_TEST 1', '#endif', '']
(root / 'RelayTunDescriptorProbeBuild.h').write_text('\n'.join(lines))
PY
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -pedantic -Wl,-dead_strip -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -I "$build_dir" "$source_dir/RelayTunDevice.c" "$source_dir/RelayTunDescriptorProbe.c" \
    -o "$build_dir/RelayTunCoreProbe-$build_arch"
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -pedantic -Wl,-dead_strip -target "$build_arch-apple-macosx13.0" \
    -DRELAY_TUN_DEVICE_TESTING -DRELAY_TUN_DESCRIPTOR_PROBE_PERMISSION_TESTS \
    -I "$source_dir" -I "$build_dir" "$source_dir/RelayTunDevice.c" "$source_dir/RelayTunDescriptorProbe.c" \
    -o "$build_dir/RelayTunCoreProbePermissionTests-$build_arch"
done
for binary_name in RelayTunCoreProbe RelayTunCoreProbePermissionTests; do
  lipo -create "$build_dir/$binary_name-arm64" "$build_dir/$binary_name-x86_64" -output "$build_dir/$binary_name"
  codesign --force --sign - --options runtime --timestamp=none "$build_dir/$binary_name"
  codesign --verify --strict --all-architectures "$build_dir/$binary_name"
  "$build_dir/$binary_name" --verify-client-only > "$build_dir/$binary_name.read-only.json"
  for probe_mode in default permission; do
    probe_args=()
    expected_status=64
    if [[ "$probe_mode" == permission ]]; then probe_args=(--adopt-fixed-core-and-release); expected_status=77; fi
    if "$build_dir/$binary_name" "${probe_args[@]}" > "$build_dir/$binary_name.$probe_mode.json"; then
      print -u2 'An unapproved core FD probe unexpectedly succeeded.'; exit 1
    else
      result_code=$?
      if (( result_code != expected_status )); then print -u2 'Unexpected probe refusal status'; exit 1; fi
    fi
  done
done
python3 "$project_dir/scripts/relay/stage-tun-probe.py" core-probe > "$build_dir/probe-deployment.json"
python3 - "$build_dir" <<'PY'
import json
import os
from pathlib import Path
import pwd
import sys

root = Path(sys.argv[1])
resource = json.loads((root / 'core-resource-read-only.json').read_text())
assert resource == {'version': 1, 'ordinaryUID': True, 'coreResourceVerified': True, 'coreStarted': False, 'actualTunAccepted': False}
for name in ('RelayTunCoreProbe', 'RelayTunCoreProbePermissionTests'):
    for mode in ('default', 'permission', 'read-only'):
        value = json.loads((root / f'{name}.{mode}.json').read_text())
        assert value['coreAdoptionProbe'] is True
        assert value['privilegedBranchExecuted'] is False and value['createAttempted'] is False
        assert value['created'] is False and value['deliveryDuplicated'] is False and value['childForked'] is False
        assert value['coreStarted'] is False and value['childOutputHex'] == ''
        if mode == 'read-only':
            assert value['clientPinnedBeforeCreate'] is True and value['clientCheckBefore']['stage'] == 'passed'
        if name.endswith('PermissionTests'):
            assert all(count == 0 for count in value['deviceCallCounters'].values())
manifest = {'version': 1, 'role': 'fixed-core-fd-probe-deployment', 'clientUID': os.getuid(), 'clientGID': os.getgid(),
            'cacheRoot': str(Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Caches/local.relay.network/TunCoreProbe'),
            'client': json.loads((root / 'client-deployment.json').read_text()),
            'probe': json.loads((root / 'probe-deployment.json').read_text()),
            'cores': {arch: json.loads((root / f'core-{arch}-deployment.json').read_text()) for arch in ('arm64', 'x64')},
            'privilegedBranchExecuted': False, 'coreStarted': False}
(root / 'deployment.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
print(json.dumps({'prepared': True, 'probeSHA256': manifest['probe']['sha256'], 'clientSHA256': manifest['client']['sha256'], 'coreStarted': False}))
PY
print 'Core FD probe prepared only. Fixed-core startup, TUN packet loops and attempted DNS cache flush require a new explicit scope approval.'
