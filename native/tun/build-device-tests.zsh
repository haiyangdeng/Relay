#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Device tests refuse root and all arguments; no privileged test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-device"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -c "$source_dir/RelayTunDevice.c" -o "$build_dir/RelayTunDevice-$build_arch.o"
done
test_arch="$(uname -m)"
if [[ "$test_arch" != arm64 && "$test_arch" != x86_64 ]]; then
  print -u2 'Only native macOS ARM or Intel inert tests are supported.'
  exit 1
fi
xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$test_arch-apple-macosx13.0" \
  -DRELAY_TUN_DEVICE_TESTING -I "$source_dir" "$source_dir/RelayTunDevice.c" \
  "$source_dir/RelayTunDeviceTests.c" -o "$build_dir/RelayTunDeviceTests-$test_arch"
"$build_dir/RelayTunDeviceTests-$test_arch"
