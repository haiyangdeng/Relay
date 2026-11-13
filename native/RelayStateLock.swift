import Foundation
import Darwin

/// Relay writers share this lock. Reading state never creates or acquires it.
struct RelayStateLock {
    let root: URL

    func withLock<T>(_ operation: () throws -> T) throws -> T {
        try NetworkConfiguration.checkPlainPath(root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = Darwin.open(root.appendingPathComponent(".state.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw AssistantError("Relay 状态锁不可用，未执行写入。") }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              fchmod(fd, 0o600) == 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            throw AssistantError("另一个偏好或配置事务正在进行，或状态锁不可用。")
        }
        return try operation()
    }
}
