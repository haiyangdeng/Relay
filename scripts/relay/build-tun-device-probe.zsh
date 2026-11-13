#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Probe preparation refuses root and all arguments; it never runs a privileged probe.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-device-probe"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -pedantic -Wl,-dead_strip -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" "$source_dir/RelayTunDevice.c" "$source_dir/RelayTunDeviceProbe.c" \
    -o "$build_dir/RelayTunDeviceProbe-$build_arch"
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -pedantic -Wl,-dead_strip -target "$build_arch-apple-macosx13.0" \
    -DRELAY_TUN_DEVICE_TESTING -DRELAY_TUN_DEVICE_PROBE_PERMISSION_TESTS -I "$source_dir" \
    "$source_dir/RelayTunDevice.c" "$source_dir/RelayTunDeviceProbe.c" \
    -o "$build_dir/RelayTunDeviceProbePermissionTests-$build_arch"
done
for binary_name in RelayTunDeviceProbe RelayTunDeviceProbePermissionTests; do
  lipo -create "$build_dir/$binary_name-arm64" "$build_dir/$binary_name-x86_64" -output "$build_dir/$binary_name"
  codesign --force --sign - --options runtime --timestamp=none "$build_dir/$binary_name"
  codesign --verify --strict --all-architectures "$build_dir/$binary_name"
  if "$build_dir/$binary_name" > "$build_dir/$binary_name.default.json"; then
    print -u2 'A default invocation unexpectedly succeeded.'; exit 1
  else
    result_code=$?
    if (( result_code != 64 )); then print -u2 'Default refusal returned an unexpected status.'; exit 1; fi
  fi
  if "$build_dir/$binary_name" --create-unconfigured-device-and-release > "$build_dir/$binary_name.permission.json"; then
    print -u2 'An ordinary-UID invocation unexpectedly succeeded.'; exit 1
  else
    result_code=$?
    if (( result_code != 77 )); then print -u2 'Permission refusal returned an unexpected status.'; exit 1; fi
  fi
done
python3 - "$build_dir" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
for name in ('RelayTunDeviceProbe', 'RelayTunDeviceProbePermissionTests'):
    for mode, status in (('default', 'refused_argument'), ('permission', 'refused_permission')):
        value = json.loads((root / f'{name}.{mode}.json').read_text())
        assert value['status'] == status
        for key in ('privilegedBranchExecuted', 'createAttempted', 'created', 'identityObserved', 'closeAttempted',
                    'closeSucceeded', 'primaryHandleReleased', 'absenceChecked', 'deviceAbsentObserved',
                    'possibleNetworkChange', 'explicitConfigurationWrites', 'descriptorExported',
                    'baselineRestorationVerified', 'actualTunAccepted'):
            assert value[key] is False, (name, mode, key)
        assert value['identity'] is None and value['absenceChecks'] == 0 and value['absenceError'] == 0
        assert all(value[key] is None for key in ('createError', 'snapshotError', 'closeError'))
        if name.endswith('PermissionTests'):
            assert set(value['deviceCallCounters']) == {'socket', 'ioctl', 'connect', 'observe', 'fd', 'close'}
            assert all(count == 0 for count in value['deviceCallCounters'].values())
        else:
            assert value['deviceCallCounters'] is None
print('Four ordinary-UID refusals passed; all instrumented backend call counters stayed zero.')
PY
print "Prepared candidate: $build_dir/RelayTunDeviceProbe"
/usr/bin/shasum -a 256 "$build_dir/RelayTunDeviceProbe"
print 'The privileged branch has not been executed; actual device creation requires separate explicit user consent.'
