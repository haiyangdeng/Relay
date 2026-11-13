# Explicit scoped CLI storage

This is the bounded Relay-launched normal-TLS process-tree mode. It does not
complete the original arbitrary external old/copied/updated JS CLI scope. The
publisher and all existing launch/protection release flags stay null/false.

Main creates only an exclusive fixed `Relay-ScopedCLI/Sessions/<UUID>` sibling
of its normal data root. An actual signed-Main Node-API call creates a fixed
512 MiB APFS sparseimage there, and mounts it at that session's `volume`.
Only `volume/home` and `volume/work` are sandbox-writable. Public proxy CA and
curl configuration stay in the host-side read-only support directory. No
existing Claude HOME/configuration, arbitrary path/device, tool discovery or
system network configuration is accepted. At most 64 records are listed;
reaching that retention bound stops new launches without deleting originals.

The host mountpoint is exclusively created with mode 0500, empty ACL and a
CLOEXEC descriptor. Before launch, its held identity and the parent filesystem
directory entry must still match, while `hdiutil info -plist` and `statfs`
must identify the same private APFS image, root inode, fsid, device, path,
owner/mode, no-suid flag and capacity. No assumption that hdiutil preserves an
existing mountpoint is sufficient: replacement/removal or an incompatible
filesystem fails closed. Unified runtime validation remains deferred.

The SBPL profile denies writes to the host anchor and ancestor literals,
including chmod/ACL/rename, in addition to allowing writes only under the two
mounted roots. A successful normal unmount must reveal the original 0500,
empty-ACL, empty host directory. Ordinary sandboxed descendants then cannot
recreate writable roots after unmount. Elevated tools, malicious local
cooperation and external/manual device manipulation are outside this bounded
claim. Standard sudo/su execution is denied; there are no Mach/Unix/AppleEvent
delegation grants or inherited host descriptors.

Explicit “end writes and retain” first closes the TLS broker. It may run after
the same held leader has positively exited even when descendants still own
stdout; it never signals that dead PID/group. Native default-cancel confirmation
binds the exact record revision and Main intent epoch. Only `hdiutil detach
<fixed-private-mountpoint>` is used, with no force, numeric-device fallback or
automatic retry. Image/device/filesystem/anchor facts are read again before and
after it. A drained failed command whose same mount is freshly proven can be
recorded as mounted for a later new confirmation. A deadline, lost response or
unknown prior submission cannot authorize another detach.

Only a positively absent image mapping plus the original host DAC/ACL/empty
anchor authorizes exclusive same-volume rename of the whole session to
`Relay-ScopedCLI/Retained/<UUID>`. Append-only hash-linked records and original
files remain; no deletion, copying of active files, remount, rollback, PID
adoption or process-tree-exited assertion exists. A later list refresh verifies
closed records again. Legacy directory sessions and incomplete create/attach
or lost-command records remain unconfirmed. Child handles, ordinary quit and
Core barriers are retained independently of storage closure.

Journal publication uses a fixed private `storage/head.json`, bound by SHA256
to an exclusively appended Native-UUID record. The existing C05 atomic
RENAME_SWAP/CAS primitive retains every old head; records, old heads and
committed publication intents stay inside `storage/`. Reading current state
does not scan historical entries or consume a retry-count budget. A durable
head-update intent precedes publication and is exclusively archived only after
the new head is verified. Missing first head, interrupted/unknown publication,
or an old unpublished r1 `storage-NN.json` layout is refused as unknown; no
orphan-file ordering or automatic format migration is used. Actual space or
safe-integer exhaustion still retains unknown state rather than promising
unlimited retries.

The existing maintenance glob builds these Swift bodies into the same signed
Main addon. New `scopedStorage` and `invalidateScopedStorageIntents` exports use
a separate atomic intent epoch; no operation runs at module load. Guard,
maintenance and storage confirmations reject nested/current modal sheets.

Reuse: installed dmg-builder 26.15.7 (electron-builder, MIT) provides the actual
attach/task/detach chain. This adapter keeps that OS mechanism while removing
its automatic EULA input, noverify, force fallback and retry. Apple hdiutil(1)
defines private mountpoint, APFS root ownership/mode and normal detach/open-file
semantics; no vendor implementation or new dependency is imported. Native
descriptor/exclusive-rename/bounded-process code reuses Relay's C05 primitives.
