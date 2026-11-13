#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Descriptor probe preparation refuses root and all arguments; no privileged test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-descriptor-probe"
mkdir -p "$build_dir"
stage_artifact() {
  case "${1:t}" in
    RelayTunDescriptorProbeClient) python3 "$project_dir/scripts/relay/stage-tun-probe.py" descriptor-client ;;
    RelayTunDescriptorProbe) python3 "$project_dir/scripts/relay/stage-tun-probe.py" descriptor-probe ;;
    *) print -u2 'Unexpected probe resource'; return 1 ;;
  esac
}
client_sources=("$source_dir/RelayTunHelperTrust.swift")
for source_file in "$project_dir"/native/*.swift "$project_dir"/native/legacy/*.swift; do
  if [[ "${source_file:t}" != RelayNative.swift ]]; then client_sources+=("$source_file"); fi
done
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "${client_sources[@]}" "$source_dir/RelayTunDescriptorProbeClient.swift" \
    -framework AppKit -framework SystemConfiguration -framework CryptoKit -framework NetworkExtension \
    -framework SystemExtensions -framework Security -framework JavaScriptCore -o "$build_dir/RelayTunDescriptorProbeClient-$build_arch"
done
lipo -create "$build_dir/RelayTunDescriptorProbeClient-arm64" "$build_dir/RelayTunDescriptorProbeClient-x86_64" -output "$build_dir/RelayTunDescriptorProbeClient"
chmod 0755 "$build_dir/RelayTunDescriptorProbeClient"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunDescriptorProbeClient"
codesign --verify --strict --all-architectures "$build_dir/RelayTunDescriptorProbeClient"
stage_artifact "$build_dir/RelayTunDescriptorProbeClient" > "$build_dir/client-deployment.json"
python3 - "$build_dir" <<'PY'
import json
import os
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1]).resolve()
deployment = json.loads((root / 'client-deployment.json').read_text())
client = Path(deployment['path'])
info = client.lstat()
assert os.getuid() > 0 and os.geteuid() == os.getuid()
assert stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o755 and info.st_uid == os.getuid() and info.st_nlink == 1
digest = deployment['sha256']
header = '\n'.join([
    '#ifndef RELAY_TUN_DESCRIPTOR_PROBE_BUILD_H', '#define RELAY_TUN_DESCRIPTOR_PROBE_BUILD_H',
    '#define RELAY_PROBE_CLIENT_UID ' + str(os.getuid()), '#define RELAY_PROBE_CLIENT_GID ' + str(os.getgid()),
    '#define RELAY_PROBE_CLIENT_PATH ' + json.dumps(str(client)),
    '#define RELAY_PROBE_CLIENT_SHA256 "' + digest + '"', '#endif', ''
])
(root / 'RelayTunDescriptorProbeBuild.h').write_text(header)
print('Pinned ordinary-UID client SHA256: ' + digest)
PY
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -pedantic -Wl,-dead_strip -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -I "$build_dir" "$source_dir/RelayTunDevice.c" "$source_dir/RelayTunDescriptorProbe.c" \
    -o "$build_dir/RelayTunDescriptorProbe-$build_arch"
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -pedantic -Wl,-dead_strip -target "$build_arch-apple-macosx13.0" \
    -DRELAY_TUN_DEVICE_TESTING -DRELAY_TUN_DESCRIPTOR_PROBE_PERMISSION_TESTS -I "$source_dir" -I "$build_dir" \
    "$source_dir/RelayTunDevice.c" "$source_dir/RelayTunDescriptorProbe.c" -o "$build_dir/RelayTunDescriptorProbePermissionTests-$build_arch"
done
for binary_name in RelayTunDescriptorProbe RelayTunDescriptorProbePermissionTests; do
  lipo -create "$build_dir/$binary_name-arm64" "$build_dir/$binary_name-x86_64" -output "$build_dir/$binary_name"
  codesign --force --sign - --options runtime --timestamp=none "$build_dir/$binary_name"
  codesign --verify --strict --all-architectures "$build_dir/$binary_name"
  "$build_dir/$binary_name" --verify-client-only > "$build_dir/$binary_name.read-only-client.json"
  if "$build_dir/$binary_name" > "$build_dir/$binary_name.default.json"; then
    print -u2 'Default invocation unexpectedly succeeded.'; exit 1
  else
    result_code=$?
    if (( result_code != 64 )); then print -u2 'Unexpected default refusal status.'; exit 1; fi
  fi
  if "$build_dir/$binary_name" --create-deliver-and-release > "$build_dir/$binary_name.permission.json"; then
    print -u2 'Ordinary-UID invocation unexpectedly succeeded.'; exit 1
  else
    result_code=$?
    if (( result_code != 77 )); then print -u2 'Unexpected permission refusal status.'; exit 1; fi
  fi
done
python3 - "$build_dir" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
for name in ('RelayTunDescriptorProbe', 'RelayTunDescriptorProbePermissionTests'):
    check = json.loads((root / f'{name}.read-only-client.json').read_text())
    assert check['status'] == 'read_only_client_verified' and check['readOnlyClientCheck'] is True
    assert check['clientCheckBefore'] == {'stage': 'passed', 'errno': 0, 'closeErrno': 0}
    assert check['clientPinnedBeforeCreate'] is True
    for key in ('createAttempted', 'created', 'deliveryDuplicated', 'childForked', 'privilegedBranchExecuted'):
        assert check[key] is False
    if name.endswith('PermissionTests'):
        assert all(number == 0 for number in check['deviceCallCounters'].values())
    for mode, status in (('default', 'refused_argument'), ('permission', 'refused_permission')):
        value = json.loads((root / f'{name}.{mode}.json').read_text())
        assert value['status'] == status
        for key in ('privilegedBranchExecuted', 'clientPinnedBeforeCreate', 'clientPinRechecked', 'createAttempted', 'created',
                    'identityObserved', 'deliveryDuplicated', 'parentDeliveryClosed', 'childForked', 'childExited',
                    'childTimedOut', 'childReportValidated', 'childReportedOrdinaryUID', 'childReportedReceiptBinding',
                    'childReportedFDClosed', 'primaryCloseAttempted', 'primaryCloseSucceeded', 'primaryHandleReleased',
                    'absenceChecked', 'deviceAbsentObserved', 'authenticatedMachTransfer', 'actualTunAccepted',
                    'baselineRestorationVerified', 'explicitConfigurationWrites', 'coreStarted'):
            assert value[key] is False, (name, mode, key)
        assert value['identity'] is None and value['systemError'] == value['absenceError'] == value['absenceChecks'] == 0
        assert all(number == 0 for number in value['deviceError'].values())
        if name.endswith('PermissionTests'):
            assert set(value['deviceCallCounters']) == {'socket', 'ioctl', 'connect', 'observe', 'fd', 'close'}
            assert all(number == 0 for number in value['deviceCallCounters'].values())
        else:
            assert value['deviceCallCounters'] is None
print('Four ordinary-UID refusals passed; instrumented backend call counters stayed zero.')
PY
stage_artifact "$build_dir/RelayTunDescriptorProbe" > "$build_dir/probe-deployment.json"
python3 - "$build_dir" <<'PY'
import json
import os
from pathlib import Path
import pwd
import sys

root = Path(sys.argv[1]).resolve()
manifest = {
    'version': 1,
    'role': 'physical-cross-uid-fd-probe-deployment',
    'clientUID': os.getuid(),
    'clientGID': os.getgid(),
    'cacheRoot': str(Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Caches/local.relay.network/TunDescriptorProbe'),
    'client': json.loads((root / 'client-deployment.json').read_text()),
    'probe': json.loads((root / 'probe-deployment.json').read_text()),
    'privilegedBranchExecuted': False,
    'actualDescriptorTransferred': False
}
(root / 'deployment.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
print('Deployment manifest: ' + str(root / 'deployment.json'))
print('Prepared staged candidate: ' + manifest['probe']['path'])
PY
print "Prepared candidate: $build_dir/RelayTunDescriptorProbe"
/usr/bin/shasum -a 256 "$build_dir/RelayTunDescriptorProbe" "$build_dir/RelayTunDescriptorProbeClient"
print 'No privileged branch or real FD transfer was executed. Separate explicit user consent is required.'
