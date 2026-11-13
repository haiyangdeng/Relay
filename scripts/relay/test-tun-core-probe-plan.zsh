#!/bin/zsh
set -euo pipefail
if (( $# != 0 || EUID == 0 || UID == 0 )); then
  print -u2 'Core-FD plan tests refuse root and all arguments; no live test mode exists.'
  exit 77
fi
project_dir="${0:A:h:h:h}"
build_dir="$project_dir/.relay-build/tun-core-probe-plan"
mkdir -p "$build_dir"
for build_arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -swift-version 5 -warnings-as-errors -O -target "$build_arch-apple-macosx13.0" \
    -module-cache-path "$build_dir/ModuleCache-$build_arch" "$project_dir/native/RelayTunAcquiredReceipt.swift" \
    "$project_dir/native/tun/RelayTunCoreProbePlan.swift" "$project_dir/native/tun/RelayTunCoreProbePlanTests.swift" \
    -framework Foundation -o "$build_dir/RelayTunCoreProbePlanTests-$build_arch"
done
lipo -create "$build_dir/RelayTunCoreProbePlanTests-arm64" "$build_dir/RelayTunCoreProbePlanTests-x86_64" -output "$build_dir/RelayTunCoreProbePlanTests"
codesign --force --sign - --options runtime --timestamp=none "$build_dir/RelayTunCoreProbePlanTests"
codesign --verify --strict --all-architectures "$build_dir/RelayTunCoreProbePlanTests"
# Only pure configuration/HTTP/receipt/lifecycle drivers; no core, FD or network.
"$build_dir/RelayTunCoreProbePlanTests"
