import Foundation
import Darwin

/// A persistent lease, unlike a short-lived per-request configuration lock.
/// No directory, lock or journal is touched by init. The future session host must
/// keep this instance alive until recovery has completed; it is not a CLI action.
final class RelayDesktopStore {
    struct Current {
        let source: String
        let record: RelayDesktopRecord
        let digest: String
    }
    private struct Lease { let fd: Int32; let path: URL; let device: dev_t; let inode: ino_t }
    let home: URL
    let root: URL
    let directory: URL
    let legacyDirectory: URL
    private var leases: [Lease] = []
    private(set) var current: Current?
    private(set) var removalPending = false
    private let checkpoint: (String) throws -> Void
    var locked: Bool { !leases.isEmpty }

    init(_ context: RelayStateContext, checkpoint: @escaping (String) throws -> Void = { _ in }) throws {
        let paths = try RelayPreferenceStore(context)
        home = paths.home; root = paths.root
        directory = root.appendingPathComponent("Desktop Login", isDirectory: true)
        legacyDirectory = home.appendingPathComponent("Library/Application Support/Claude Desktop Login", isDirectory: true)
        self.checkpoint = checkpoint
    }
    deinit { release() }

    func stateURL(_ source: String) throws -> URL {
        guard ["relay", "legacy"].contains(source) else { throw AssistantError("登录记录来源无效。") }
        return (source == "relay" ? directory : legacyDirectory).appendingPathComponent("state.json")
    }
    private func ensureDirectory(_ url: URL) throws {
        try NetworkConfiguration.checkPlainPath(url)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Existing directories are not chmod'ed. Check each component owned by
        // this user, so a writable shared parent cannot redirect the record.
        let relative = String(url.path.dropFirst(home.path.count + 1))
        var checked = home
        var ancestors: [URL] = []
        for component in [""] + relative.components(separatedBy: "/") {
            if !component.isEmpty { checked.appendPathComponent(component) }
            var info = stat()
            guard lstat(checked.path, &info) == 0, info.st_uid == getuid(),
                  info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o022 == 0 else {
                throw AssistantError("登录状态目录不安全，没有修改其权限。")
            }
            ancestors.append(checked)
        }
        // Persist newly created intermediate directory entries too, not just
        // the final state file. A first-run crash must not lose its whole path.
        for ancestor in ancestors.reversed() { try syncDirectory(ancestor) }
    }
    func acquire() throws {
        guard leases.isEmpty else { try assertLease(); return }
        do {
            // Match the legacy coordinator's actual lock, even when it has not
            // written state yet. Both products now contend on the same inode.
            for (folder, name) in [(legacyDirectory, ".lock"), (root, ".state.lock"), (directory, ".lock")] {
                try ensureDirectory(folder)
                let path = folder.appendingPathComponent(name)
                let fd = Darwin.open(path.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
                guard fd >= 0 else { throw AssistantError("登录会话锁不可用。") }
                var info = stat()
                guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1,
                      info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o777 == 0o600,
                      flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                    Darwin.close(fd)
                    throw AssistantError("已有会话或配置事务，或登录锁不安全。")
                }
                leases.append(Lease(fd: fd, path: path, device: info.st_dev, inode: info.st_ino))
            }
            try assertLease()
            try checkpoint("directoryDurable")
        } catch { release(); throw error }
    }
    func release() {
        leases.reversed().forEach { Darwin.close($0.fd) }
        leases.removeAll()
    }
    func assertLease() throws {
        guard leases.count == 3 else { throw AssistantError("没有完整登录会话锁。") }
        for lease in leases {
            try NetworkConfiguration.checkPlainPath(lease.path)
            var info = stat()
            guard lstat(lease.path.path, &info) == 0, info.st_dev == lease.device, info.st_ino == lease.inode,
                  info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  info.st_mode & 0o777 == 0o600 else { throw AssistantError("登录锁被外部改变，停止操作。") }
        }
    }
    private func read(_ source: String) throws -> (RelayDesktopRecord, Data)? {
        guard let file = try RelayRecoveryInspector.read(stateURL(source), limit: 65536) else { return nil }
        return (try RelayDesktopRecord.decode(file), file.data)
    }
    func resume() throws {
        try assertLease()
        if removalPending { return }
        guard current == nil && !removalPending else { try assertCurrent(); return }
        let own = try read("relay"), legacy = try read("legacy")
        guard own == nil || legacy == nil else { throw AssistantError("新旧目录同时存在登录记录，请先人工核对，禁止自动覆盖。") }
        if let (record, data) = own ?? legacy {
            current = Current(source: own == nil ? "legacy" : "relay", record: record, digest: NetworkConfiguration.digest(data))
        }
    }
    func assertNoState() throws {
        try assertLease()
        guard current == nil && !removalPending, try read("relay") == nil && read("legacy") == nil else {
            throw AssistantError("存在登录记录，不能开始新会话。")
        }
    }
    func assertCurrent() throws {
        try assertLease()
        guard !removalPending, let current, let (record, data) = try read(current.source),
              record == current.record, NetworkConfiguration.digest(data) == current.digest else {
            throw AssistantError("登录记录被外部改变，停止覆盖并保留记录。")
        }
        let other = current.source == "relay" ? "legacy" : "relay"
        guard try read(other) == nil else { throw AssistantError("另一来源出现登录记录，停止恢复。") }
    }
    private func syncDirectory(_ url: URL) throws {
        try NetworkConfiguration.checkPlainPath(url)
        let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw AssistantError("登录记录目录无法同步。") }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw AssistantError("登录记录目录同步未确认。") }
    }
    func save(_ record: RelayDesktopRecord, initial: Bool = false) throws {
        if initial { try assertNoState() } else { try assertCurrent() }
        if initial {
            guard record.phase == "starting", record.attemptedSchemes.isEmpty else { throw AssistantError("新登录记录必须从未尝试阶段开始。") }
        } else if let previous = current?.record {
            let phases = previous.phase == "starting" ? ["starting", "active", "restoring"] : ["restoring"]
            guard record.sessionID == previous.sessionID, record.version == previous.version,
                  record.createdAt == previous.createdAt, record.originals == previous.originals,
                  record.temporaryApplication == previous.temporaryApplication,
                  Set(previous.attemptedSchemes).isSubset(of: Set(record.attemptedSchemes)), phases.contains(record.phase) else {
                throw AssistantError("登录记录身份或阶段不能覆盖。")
            }
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(record)
        _ = try RelayDesktopRecord.decode(.init(data: data, mode: 0o600))
        guard data.count <= 65536 else { throw AssistantError("登录记录过长。") }
        let source = initial ? "relay" : current!.source
        let target = try stateURL(source), folder = target.deletingLastPathComponent()
        let temporary = folder.appendingPathComponent(".state-" + UUID().uuidString + ".tmp")
        let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw AssistantError("登录记录暂存失败。") }
        defer { Darwin.close(fd); unlink(temporary.path) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw AssistantError("登录记录写入失败。") }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw AssistantError("登录记录未持久保存。") }
        try checkpoint("beforePublish")
        if initial { try assertNoState() } else { try assertCurrent() }
        let result = initial ? link(temporary.path, target.path) : rename(temporary.path, target.path)
        guard result == 0 else { throw AssistantError("登录记录发布失败，原记录未覆盖。") }
        // A failure after publication must retain the exact cursor we published,
        // rather than re-adopting arbitrary same-session external content.
        current = Current(source: source, record: record, digest: NetworkConfiguration.digest(data))
        if initial { guard unlink(temporary.path) == 0 else { throw AssistantError("登录记录暂存链接清理失败。") } }
        try checkpoint("afterPublish")
        try syncDirectory(folder)
    }
    func remove() throws {
        try assertCurrent()
        let target = try stateURL(current!.source)
        try checkpoint("beforeRemove")
        try assertCurrent()
        guard unlink(target.path) == 0 else { throw AssistantError("原默认浏览器已恢复，但记录删除未确认。") }
        removalPending = true
        try checkpoint("afterRemove")
        try completeRemoval()
    }
    func completeRemoval() throws {
        try assertLease()
        guard removalPending, let current, try read("relay") == nil && read("legacy") == nil else {
            throw AssistantError("登录记录删除状态发生变化，需人工核对。")
        }
        try syncDirectory(try stateURL(current.source).deletingLastPathComponent())
        self.current = nil; removalPending = false
    }
}
