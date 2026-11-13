import Foundation
import Darwin

/// Shared locks cover every helper operation, including release. Removal takes
/// the exclusive lock before publishing a durable fence and checking journals.
/// Nonblocking locks fail closed; no helper waits past bootout on an old inode.
enum RelayTunUninstallFence {
    enum Failure: Error { case permission, invalid, unsafe, busy, fenced, uncertain }
    static let lockPath = "/Library/PrivilegedHelperTools/local.relay.network.tun.operation-lock"
    static let fencePath = "/Library/PrivilegedHelperTools/local.relay.network.tun.uninstall-active"
    private static func production() throws -> Store {
        guard getuid() == 0, geteuid() == 0, getgid() == 0, getegid() == 0 else { throw Failure.permission }
        return Store(parent: "/Library/PrivilegedHelperTools", owner: 0, group: 0)
    }
    static func withMutation<T>(allowRecovery: Bool = false, _ body: () throws -> T) throws -> T {
        try production().withMutation(allowRecovery: allowRecovery, body)
    }
    static func withRemoval<T>(manifestSHA256: String, _ body: () throws -> T) throws -> T {
        try production().withRemoval(manifestSHA256: manifestSHA256, body)
    }
    static func withRemoval<T>(manifestSHA256: String, _ body: (_ retireFence: @escaping () throws -> Void) throws -> T) throws -> T {
        try production().withRemoval(manifestSHA256: manifestSHA256, body)
    }
    static func permitsActivation() -> Bool { (try? production().fenceAbsent()) == true }
    #if RELAY_TUN_JOURNAL_ARCHIVE_TESTS
    static func isolated(parent: String) throws -> Store {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        let prefix = app + "/.relay-build/tun-journal-archive-fixtures/"
        guard getuid() > 0, geteuid() == getuid(), parent.hasPrefix(prefix),
              RelayTunNetworkEffects.uuid(String(parent.dropFirst(prefix.count))) else { throw Failure.permission }
        return Store(parent: parent, owner: getuid(), group: getgid())
    }
    #endif
    final class Store {
        private let parent: String, owner: uid_t, group: gid_t
        private let lockName = "local.relay.network.tun.operation-lock", fenceName = "local.relay.network.tun.uninstall-active"
        fileprivate init(parent: String, owner: uid_t, group: gid_t) { self.parent = parent; self.owner = owner; self.group = group }
        private func directory() throws -> Int32 {
            guard getuid() == owner, geteuid() == owner, getgid() == group, getegid() == group else { throw Failure.permission }
            var current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard current >= 0 else { throw Failure.unsafe }
            do {
                for part in parent.split(separator: "/").map(String.init) {
                    guard part != ".", part != "..", !part.contains("\0") else { throw Failure.invalid }
                    let child = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    guard child >= 0 else { throw Failure.unsafe }
                    var info = stat(), linked = stat()
                    let valid = fstat(child, &info) == 0 && fstatat(current, part, &linked, AT_SYMLINK_NOFOLLOW) == 0 &&
                        info.st_dev == linked.st_dev && info.st_ino == linked.st_ino && info.st_mode == linked.st_mode
                    guard valid, [uid_t(0), owner].contains(info.st_uid), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                          info.st_mode & 0o6022 == 0 else { Darwin.close(child); throw Failure.unsafe }
                    Darwin.close(current); current = child
                }
                return current
            } catch { Darwin.close(current); throw error }
        }
        private func checked(_ fd: Int32, name: String, parent: Int32) throws -> stat {
            var held = stat(), linked = stat()
            guard fstat(fd, &held) == 0, fstatat(parent, name, &linked, AT_SYMLINK_NOFOLLOW) == 0,
                  held.st_dev == linked.st_dev, held.st_ino == linked.st_ino, held.st_uid == owner, held.st_gid == group,
                  held.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), held.st_mode & 0o7777 == 0o600, held.st_nlink == 1,
                  held.st_mode == linked.st_mode, held.st_nlink == linked.st_nlink else { throw Failure.unsafe }
            return held
        }
        private func acquire(_ parent: Int32, exclusive: Bool) throws -> Int32 {
            let fd = openat(parent, lockName, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw Failure.unsafe }
            do {
                let before = try checked(fd, name: lockName, parent: parent)
                guard before.st_size == 0, flock(fd, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB) == 0 else { throw Failure.busy }
                let after = try checked(fd, name: lockName, parent: parent)
                guard before.st_dev == after.st_dev, before.st_ino == after.st_ino else { throw Failure.unsafe }
                return fd
            } catch { Darwin.close(fd); throw error }
        }
        func fenceAbsent() throws -> Bool {
            let dir = try directory(); defer { Darwin.close(dir) }
            var info = stat(); if fstatat(dir, fenceName, &info, AT_SYMLINK_NOFOLLOW) == 0 { return false }
            guard errno == ENOENT else { throw Failure.unsafe }; return true
        }
        func withMutation<T>(allowRecovery: Bool = false, _ body: () throws -> T) throws -> T {
            let dir = try directory(); defer { Darwin.close(dir) }
            let held = try acquire(dir, exclusive: false); defer { _ = flock(held, LOCK_UN); Darwin.close(held) }
            if !allowRecovery { guard try fenceAbsent() else { throw Failure.fenced } }
            return try body()
        }
        func withRemoval<T>(manifestSHA256: String, _ body: () throws -> T) throws -> T {
            try withRemoval(manifestSHA256: manifestSHA256) { retire in
                let result = try body(); try retire(); return result
            }
        }
        func withRemoval<T>(manifestSHA256: String, _ body: (_ retireFence: @escaping () throws -> Void) throws -> T) throws -> T {
            guard RelayTunHelperTrust.hex(manifestSHA256, count: 64) != nil else { throw Failure.invalid }
            let dir = try directory(); defer { Darwin.close(dir) }
            let held = try acquire(dir, exclusive: true); defer { _ = flock(held, LOCK_UN); Darwin.close(held) }
            let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "role": "tun-uninstall-fence", "manifestSHA256": manifestSHA256], options: [.sortedKeys])
            var fence = openat(dir, fenceName, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            if fence >= 0 {
                do {
                    _ = try checked(fence, name: fenceName, parent: dir)
                    try bytes.withUnsafeBytes { raw in
                        var offset = 0
                        while offset < raw.count { let count = Darwin.write(fence, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                            if count < 0 && errno == EINTR { continue }; guard count > 0 else { throw Failure.uncertain }; offset += count }
                    }
                    guard fsync(fence) == 0, fsync(dir) == 0 else { throw Failure.uncertain }
                } catch { Darwin.close(fence); throw error }
            } else {
                guard errno == EEXIST else { throw Failure.unsafe }
                fence = openat(dir, fenceName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                guard fence >= 0 else { throw Failure.unsafe }
            }
            defer { Darwin.close(fence) }
            let info = try checked(fence, name: fenceName, parent: dir)
            guard info.st_size == bytes.count, lseek(fence, 0, SEEK_SET) == 0 else { throw Failure.unsafe }
            var buffer = [UInt8](repeating: 0, count: bytes.count + 1)
            guard Darwin.read(fence, &buffer, buffer.count) == bytes.count, Data(buffer.prefix(bytes.count)) == bytes else { throw Failure.unsafe }
            var retired = false, active = true
            let scopeLock = NSLock()
            defer { scopeLock.lock(); active = false; scopeLock.unlock() }
            let result = try body {
                scopeLock.lock(); defer { scopeLock.unlock() }
                guard active else { throw Failure.unsafe }
                if retired { return }
                // Caller must first prove job/helper/core/manifest absence.
                // The pinned uninstaller and recovery intent still exist if
                // this final namespace synchronization needs explicit retry.
                _ = try self.checked(fence, name: self.fenceName, parent: dir)
                _ = try self.checked(held, name: self.lockName, parent: dir)
                guard unlinkat(dir, self.fenceName, 0) == 0, unlinkat(dir, self.lockName, 0) == 0, fsync(dir) == 0 else { throw Failure.uncertain }
                retired = true
            }
            scopeLock.lock(); let completed = retired; scopeLock.unlock()
            guard completed else { throw Failure.uncertain }
            return result
        }
    }
}
