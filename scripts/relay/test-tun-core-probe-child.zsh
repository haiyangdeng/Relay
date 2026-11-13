#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Core probe child tests refuse root and arguments; only ordinary-UID inert children are used.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-core-probe-child"
mkdir -p "$build_dir"
cat > "$build_dir/RelayTunDescriptorProbeBuild.h" <<'HEADER'
#define RELAY_PROBE_CLIENT_UID 501
#define RELAY_PROBE_CLIENT_GID 20
#define RELAY_PROBE_CLIENT_PATH "/dev/null"
#define RELAY_PROBE_CLIENT_SHA256 "0000000000000000000000000000000000000000000000000000000000000000"
#define RELAY_PROBE_CORE_TEST 1
#define RELAY_PROBE_TIMEOUT_NS UINT64_C(10000000)
HEADER
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -DRELAY_TUN_DEVICE_TESTING -I "$source_dir" -I "$build_dir" \
    "$source_dir/RelayTunDevice.c" "$source_dir/RelayTunCoreProbeChildTests.c" \
    -o "$build_dir/RelayTunCoreProbeChildTests-$build_arch"
done
lipo -create "$build_dir/RelayTunCoreProbeChildTests-arm64" "$build_dir/RelayTunCoreProbeChildTests-x86_64" -output "$build_dir/RelayTunCoreProbeChildTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunCoreProbeChildTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunCoreProbeChildTests"
"$build_dir/RelayTunCoreProbeChildTests"
