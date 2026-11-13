# File-provider update serialization supplement

GPL-3.0, based on MetaCubeX/mihomo commit
`3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8`. This is an explicit,
separately pinned supplement to the existing `mihomo-geodata-v1` overlays.
It does not replace that frozen extension, original cores, manifests or pins.

The fixed Fetcher reads vehicle bytes before taking its `loadBufMutex`. An old
watcher may retain A, a newer PUT can synchronously accept B, then the old
watcher publishes A. Same counts, stable current-file SHA and a PUT 204 cannot
rule this out. The private before test actually witnesses that ordering.

This one-file patch serializes **File** Initial/Update/SideUpdate across
read/parse/write/onUpdate, using a separate outer updateMutex. Initial's remote
fallback calls an unlocked private helper to avoid recursive locking. The
existing inner parser mutex remains. fswatch v0.1.1 Start launches its event
loop asynchronously; callbacks later reenter the same serialized Update.
Non-File branches retain the existing behavior and public API.

File dedup also uses a private SHA256 stored under loadBufMutex, advanced only
after parser and optional vehicle Write succeed. The global MD5 HashType and
HTTP behavior do not change. This aligns local byte dedup with Native's SHA256
contract while retaining exact-repeat dedup. The equal-MD5 test **injects** equal
legacy hash values; it is not a claim that two valid rule-file MD5 collision
samples were constructed.

The eight tests exercise old-read replay, SideUpdate ordering, initial fallback,
error release, different bytes/equal legacy hash, retained strong dedup on
parse/write failure, exact-repeat fast path and unchanged non-File behavior.
They run only the Go library in an own source copy with deny-network, fixed
Go1.26.10, original readonly modules and existing verified private caches.
One missing-path Initial fallback exercises only a private source-directory
watcher and closes it; no Core/application/helper/TUN process is started.

`manifest.json` pins the original/overlay/patch/test and required Geo-extension
manifest. Applying the patch reconstructs the overlay exactly. Builder opt-in,
new version/SHA pair, Native positive capability, real new-pair integration and
shipping admission are separate gates owned by the integration workflow. No
production Core bytes were built or replaced by this supplement task.

The integration-selected next version is `relay-geodata-v1p1-3f27`; Geo API,
environment and profile remain v1. No new Core API is introduced. The builder
will require explicit provider-serialization opt-in and separately pinned bytes.
