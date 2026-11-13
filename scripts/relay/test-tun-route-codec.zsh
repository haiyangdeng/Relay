#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Route codec fixtures refuse root and arguments; no network mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
source_dir="$project_dir/native/tun"
build_dir="$project_dir/.relay-build/tun-route-codec"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" -c "$source_dir/RelayTunRouteCodec.c" -o "$build_dir/RelayTunRouteCodec-$build_arch.o"
  xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$build_arch-apple-macosx13.0" \
    -I "$source_dir" "$source_dir/RelayTunRouteCodec.c" "$source_dir/RelayTunRouteCodecTests.c" \
    -o "$build_dir/RelayTunRouteCodecTests-$build_arch"
done
test_arch="$(uname -m)"
if [[ "$test_arch" != arm64 && "$test_arch" != x86_64 ]]; then
  print -u2 'Only native macOS ARM or Intel inert fixtures are supported.'
  exit 1
fi
# In-memory bytes only; no socket, interface lookup, route or DNS API is linked.
"$build_dir/RelayTunRouteCodecTests-$test_arch"
xcrun clang -std=c11 -Wall -Wextra -Werror -pedantic -target "$test_arch-apple-macosx13.0" \
  -fsanitize=address,undefined -fno-omit-frame-pointer -g -I "$source_dir" \
  "$source_dir/RelayTunRouteCodec.c" "$source_dir/RelayTunRouteCodecTests.c" \
  -o "$build_dir/RelayTunRouteCodecTests-sanitized-$test_arch"
"$build_dir/RelayTunRouteCodecTests-sanitized-$test_arch"
