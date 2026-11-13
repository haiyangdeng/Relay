#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Adapter tests refuse root and all arguments; no privileged test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-device-adapter"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -DRELAY_TUN_DEVICE_TESTING -I "$source_dir" -c "$source_dir/RelayTunDevice.c" \
    -o "$build_dir/RelayTunDevice-$build_arch.o"
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" -Xcc -DRELAY_TUN_DEVICE_TESTING \
    -import-objc-header "$source_dir/RelayTunDevice.h" "$source_dir/RelayTunDeviceAdapter.swift" \
    "$source_dir/RelayTunDeviceAdapterTests.swift" "$build_dir/RelayTunDevice-$build_arch.o" \
    -framework Foundation -o "$build_dir/RelayTunDeviceAdapterTests-$build_arch"
done
lipo -create "$build_dir/RelayTunDeviceAdapterTests-arm64" "$build_dir/RelayTunDeviceAdapterTests-x86_64" -output "$build_dir/RelayTunDeviceAdapterTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunDeviceAdapterTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunDeviceAdapterTests"
# All successful operations use injected memory sessions. The live C driver is
# exercised only as an ordinary UID to prove its pre-syscall permission gate.
"$build_dir/RelayTunDeviceAdapterTests"
