# Relay modified Mihomo — corresponding source

The packaged modified core identifies itself as `relay-geodata-v1p1-3f27`.

- Upstream: https://github.com/MetaCubeX/mihomo
- Fixed commit: `3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8`
- License: GPL-3.0; full upstream text in `mihomo-geodata-v1/LICENSE.upstream`.
- Base source archive SHA-256: `ecda5f8c8a8a1d60bc088c2640c85d92c8f002c0686234a26bdf671735afe216`.
- First change: `mihomo-geodata-v1/patches/0001-local-geodata-v1.patch`, local geodata replacement endpoint. SHA-256 `e36ec9ab8e45d2d3cb0ce3ece6f422abd053ece7c0937e406649be17472043e6`.
- Second change: `mihomo-provider-file-v1/patches/0001-serialize-local-file-updates.patch`, serialization of local File provider updates. SHA-256 `fa6fec94f3a3d40bff3a4545acaa01dd10c86c88147b3a20634b856472d80a8d`.

- Third change: `mihomo-tun-handoff/patches/0003-darwin-tun-handoff.patch` enables the macOS cross-UID handoff on accepted loopback TCP connections of the managed TUN core. Listening sockets keep their original options.

All changes are included together using the checked-in Go overlay source and verified against their manifests. Do not apply the patch and then overlay a second time.

Build using `python3 scripts/relay/build-public.py resources --execute` from the repository root. The recipe checks every upstream source file, the overlay manifests and patch digests before compiling. See `docs/BUILD.md` for prerequisites and later packaging. It does not rely on a prior Relay binary. The ordinary official core uses a separate pinned release in `src/main/relay/core/manifest.json`.

Both macOS architectures compile with `relay_local_geodata,with_gvisor`. The pinned upstream dependency `github.com/metacubex/sing-tun v0.4.28` requires `with_gvisor` for both Mixed and gVisor TUN stacks; without it, both constructors return an unsupported-stack error even though configuration parsing with `-t` succeeds. The public build checks the resulting Go build metadata for the tag and gVisor module before admitting the binary. This reuses the upstream stacks without modifying their network implementation.

The actual signed binary SHA-256/size and architecture are generated after compiling in `src/main/relay/core/geodata-manifest.json` and the packaged resource's `manifest.json`. Publish the corresponding source snapshot (including generated source pins) with the exact binaries; do not claim local rebuilt bytes are identical to an earlier private build.
