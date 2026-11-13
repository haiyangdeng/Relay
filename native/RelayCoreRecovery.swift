import Foundation
import Darwin

/// Only archives a private stale record whose recorded PID is absent. No
/// process handle is adopted, and no terminating signal or network call exists.
enum RelayCoreRecovery {
    struct Input: Decodable {
        enum Action: String, Decodable { case inspect, archive }
        let action: Action
        let context: RelayStateContext
        let expectedRevision: String?
    }
    struct Report: Encodable {
        let status: String
        let canArchive: Bool
        let revision: String?
        let archiveID: String?
        let warnings: [String]
    }
    private struct Snapshot {
        let directory: URL
        let identity: stat
        let bytes: Data
        let pid: pid_t?
        let revision: String
    }
    static func directory(_ path: URL, home: URL) throws -> stat? {
        guard path.path == home.path || path.path.hasPrefix(home.path + "/") else { throw AssistantError("核心记录路径无效。") }
        var cursor = home
        let suffix = String(path.path.dropFirst(home.path.count)).split(separator: "/").map(String.init)
        var result = stat()
        for part in [""] + suffix {
            if !part.isEmpty { cursor.appendPathComponent(part) }
            var value = stat()
            if lstat(cursor.path, &value) != 0 {
                if errno == ENOENT { return nil }
                throw AssistantError("核心记录目录不可读取。")
            }
            guard value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), value.st_uid == getuid(), value.st_mode & 0o022 == 0,
                  NetworkConfiguration.canonicalPath(cursor) == cursor.path else { throw AssistantError("核心记录目录权限或身份异常。") }
            result = value
        }
        return result
    }
    static func read(_ path: URL) throws -> Data {
        let fd = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw AssistantError("核心记录不可读取。") }
        defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), before.st_uid == getuid(),
              before.st_nlink == 1, before.st_mode & 0o7777 == 0o600, before.st_size > 0, before.st_size <= 4096 else { throw AssistantError("核心记录格式或权限异常。") }
        let bytes = FileHandle(fileDescriptor: fd, closeOnDealloc: false).readData(ofLength: 4097)
        guard bytes.count == before.st_size, fstat(fd, &after) == 0, lstat(path.path, &linked) == 0,
              [after, linked].allSatisfy({ $0.st_dev == before.st_dev && $0.st_ino == before.st_ino && $0.st_size == before.st_size && $0.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec && $0.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec && $0.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec && $0.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec && $0.st_uid == before.st_uid && $0.st_nlink == 1 && $0.st_mode == before.st_mode }) else { throw AssistantError("核心记录读取期间发生变化。") }
        return bytes
    }
    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double.rounded() == double, double >= 0, double < Double(Int.max) else { return nil }
        return number.intValue
    }
    private static func snapshot(_ core: URL, home: URL) throws -> Snapshot? {
        guard try directory(core, home: home) != nil else { return nil }
        let path = core.appendingPathComponent(".session", isDirectory: true)
        guard let identity = try directory(path, home: home) else { return nil }
        guard identity.st_mode & 0o7777 == 0o700, try FileManager.default.contentsOfDirectory(atPath: path.path) == ["owner.json"] else { throw AssistantError("核心会话含未知内容，保留原状。") }
        let bytes = try read(path.appendingPathComponent("owner.json"))
        guard let owner = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(owner.keys).isSubset(of: ["version", "token", "mode", "createdAt", "phase", "pid", "runtime"]),
              integer(owner["version"]) == 1, let token = owner["token"] as? String, UUID(uuidString: token) != nil,
              let mode = owner["mode"] as? String, ["rule", "global", "direct"].contains(mode),
              let phase = owner["phase"] as? String, ["starting", "running", "stopping"].contains(phase),
              let created = owner["createdAt"] as? String else { throw AssistantError("核心会话版本或内容无效。") }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard formatter.date(from: created) != nil else { throw AssistantError("核心会话时间无效。") }
        let pid = integer(owner["pid"])
        guard owner["pid"] == nil || (pid != nil && pid! > 0 && pid! <= Int(Int32.max)), phase != "running" || pid != nil else { throw AssistantError("核心会话PID无效。") }
        if let runtime = owner["runtime"] {
            guard let value = runtime as? [String: Any], Set(value.keys).isSubset(of: ["kind", "httpPort", "ports", "profileId", "sourceSHA256", "resolverMode"]),
                  value["kind"] as? String == "localProxy", let port = integer(value["httpPort"]), (1024...65535).contains(port),
                  let id = value["profileId"] as? String, UUID(uuidString: id) != nil,
                  let sha = value["sourceSHA256"] as? String, sha.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  value["resolverMode"] == nil || ["off", "profile"].contains(value["resolverMode"] as? String ?? "") else { throw AssistantError("核心运行来源记录无效。") }
            if let rawPorts = value["ports"] {
                guard let ports = rawPorts as? [String: Any], Set(ports.keys) == Set(["http", "socks", "mixed", "redir"]) else { throw AssistantError("核心监听端口记录无效。") }
                let values = ["http", "socks", "mixed", "redir"].compactMap { integer(ports[$0]) }
                guard values.count == 4, values.allSatisfy({ $0 == 0 || (1024...65535).contains($0) }),
                      values[0] != 0 || values[2] != 0,
                      (values[0] != 0 ? values[0] : values[2]) == port,
                      Set(values.filter { $0 != 0 }).count == values.filter({ $0 != 0 }).count else { throw AssistantError("核心监听端口记录无效。") }
            }
        }
        guard let after = try directory(path, home: home), after.st_dev == identity.st_dev, after.st_ino == identity.st_ino else { throw AssistantError("核心会话目录发生变化。") }
        let fingerprint = Data("\(identity.st_dev):\(identity.st_ino):".utf8) + bytes
        return Snapshot(directory: path, identity: identity, bytes: bytes, pid: pid.map(pid_t.init), revision: NetworkConfiguration.digest(fingerprint))
    }
    private static func absent(_ pid: pid_t?) -> Bool {
        guard let pid else { return false }
        // Signal zero only asks the kernel whether this PID exists. A reused
        // or inaccessible PID is conservatively treated as live/unknown.
        return Darwin.kill(pid, 0) != 0 && errno == ESRCH
    }
    static func sync(_ path: URL) throws {
        let fd = Darwin.open(path.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw AssistantError("恢复目录不可同步。") }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw AssistantError("恢复目录同步未确认。") }
    }
    static func perform(_ input: Input) throws -> Report {
        guard input.action != .inspect || input.expectedRevision == nil else { throw AssistantError("检查不接受修订参数。") }
        let preference = try RelayPreferenceStore(input.context), core = preference.root.appendingPathComponent("Core", isDirectory: true)
        guard let original = try snapshot(core, home: preference.home) else {
            guard input.action == .inspect else { throw AssistantError("会话记录已不存在，请重新检查。") }
            return Report(status: "clear", canArchive: false, revision: nil, archiveID: nil, warnings: [])
        }
        let canArchive = absent(original.pid)
        if input.action == .inspect {
            return Report(status: canArchive ? "stale" : "liveOrUnknown", canArchive: canArchive, revision: original.revision, archiveID: nil,
                          warnings: [canArchive ? "记录中的PID已不存在；仍需确认后归档旧会话，才能重新选择启动。" : "记录PID仍存在、无法确认或尚未登记；不接管、不发停止信号、不自动清理。"])
        }
        guard canArchive, input.expectedRevision == original.revision else { throw AssistantError("旧记录或PID状态未确认，未归档。") }
        let lockPath = core.appendingPathComponent(".recovery.lock")
        let fd = Darwin.open(lockPath.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw AssistantError("恢复锁不可用。") }
        defer { Darwin.close(fd) }
        var lockInfo = stat(), linked = stat()
        guard fstat(fd, &lockInfo) == 0, lockInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), lockInfo.st_uid == getuid(), lockInfo.st_nlink == 1,
              lockInfo.st_mode & 0o7777 == 0o600, flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw AssistantError("恢复锁异常或另一恢复正在执行。") }
        guard let current = try snapshot(core, home: preference.home), current.revision == original.revision, absent(current.pid),
              lstat(lockPath.path, &linked) == 0, linked.st_dev == lockInfo.st_dev, linked.st_ino == lockInfo.st_ino else { throw AssistantError("确认期间会话或锁发生变化。") }
        let archives = core.appendingPathComponent("AbandonedSessions", isDirectory: true)
        if try directory(archives, home: preference.home) == nil {
            guard mkdir(archives.path, 0o700) == 0 else { throw AssistantError("旧会话归档目录不可创建。") }
        }
        guard let folder = try directory(archives, home: preference.home), folder.st_mode & 0o7777 == 0o700 else { throw AssistantError("旧会话归档目录权限异常。") }
        let archiveID = UUID().uuidString.lowercased(), target = archives.appendingPathComponent(archiveID, isDirectory: true)
        var targetInfo = stat()
        guard lstat(target.path, &targetInfo) != 0, errno == ENOENT,
              let final = try snapshot(core, home: preference.home), final.revision == original.revision, absent(final.pid) else { throw AssistantError("归档前记录或目标发生变化。") }
        guard Darwin.rename(final.directory.path, target.path) == 0 else { throw AssistantError("旧记录归档未完成，未重试。") }
        do {
            guard let moved = try directory(target, home: preference.home), moved.st_dev == original.identity.st_dev, moved.st_ino == original.identity.st_ino,
                  try read(target.appendingPathComponent("owner.json")) == original.bytes else { throw AssistantError("归档身份未确认。") }
            try sync(archives); try sync(core)
            return Report(status: "archived", canArchive: false, revision: original.revision, archiveID: archiveID, warnings: ["旧会话已归档；没有按PID接管或停止任何进程，也没有启动核心或修改网络。"])
        } catch {
            return Report(status: "uncertain", canArchive: false, revision: original.revision, archiveID: archiveID, warnings: ["归档移动后的身份或同步未确认，保留现场；不回滚、不重试、不启动或停止进程。"])
        }
    }
}
