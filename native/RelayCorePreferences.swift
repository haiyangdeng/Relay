import Foundation
import Darwin

/// Remember only a source identity. Reading preferences never starts a core,
/// restores network settings, arms a scheduler or reuses another process PID.
enum RelayCorePreferences {
    struct Selection: Codable, Equatable { let id: String; let sha256: String }
    struct Input: Decodable {
        enum Action: String, Decodable { case read, save }
        let context: RelayStateContext
        let action: Action
        let selection: Selection?
        let expectedRevision: String?
    }
    struct Report: Encodable { let selection: Selection?; let revision: String }
    private struct Record: Encodable { let version = 1; let selection: Selection? }
    private static func valid(_ value: Selection?) throws {
        guard let value else { return }
        guard value.id.range(of: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$", options: .regularExpression) != nil,
              value.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw AssistantError("启动来源选择无效。") }
    }
    private static func current(_ core: URL, home: URL) throws -> Report {
        let missing = Report(selection: nil, revision: NetworkConfiguration.digest(Data("missing core selection".utf8)))
        guard try RelayCoreRecovery.directory(core, home: home) != nil else { return missing }
        let path = core.appendingPathComponent("selection.json")
        var info = stat()
        if lstat(path.path, &info) != 0 {
            if errno == ENOENT { return missing }
            throw AssistantError("启动来源偏好不可读取。")
        }
        let bytes = try RelayCoreRecovery.read(path)
        guard let record = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(record.keys).isSubset(of: ["version", "selection"]), RelayCoreRecovery.integer(record["version"]) == 1 else { throw AssistantError("启动来源偏好版本或内容异常。") }
        var selected: Selection?
        if let raw = record["selection"], !(raw is NSNull) {
            guard let value = raw as? [String: Any], Set(value.keys) == ["id", "sha256"],
                  let id = value["id"] as? String, let sha = value["sha256"] as? String else { throw AssistantError("启动来源记录无效。") }
            selected = Selection(id: id, sha256: sha)
        }
        try valid(selected)
        return Report(selection: selected, revision: NetworkConfiguration.digest(bytes))
    }
    static func perform(_ input: Input) throws -> Report {
        let context = try RelayPreferenceStore(input.context), core = context.root.appendingPathComponent("Core", isDirectory: true)
        if input.action == .read {
            guard input.selection == nil, input.expectedRevision == nil else { throw AssistantError("读取启动偏好不接受更新参数。") }
            return try current(core, home: context.home)
        }
        try valid(input.selection)
        guard let revision = input.expectedRevision, revision.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw AssistantError("需要启动偏好的当前修订。") }
        if try RelayCoreRecovery.directory(core, home: context.home) == nil {
            try FileManager.default.createDirectory(at: core, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        guard try RelayCoreRecovery.directory(core, home: context.home) != nil else { throw AssistantError("启动偏好目录不可用。") }
        let lock = core.appendingPathComponent(".selection.lock"), fd = Darwin.open(lock.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw AssistantError("启动偏好锁不可用。") }
        defer { Darwin.close(fd) }
        var info = stat(), linked = stat()
        guard fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & 0o7777 == 0o600, flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw AssistantError("启动偏好锁异常或已有写入。") }
        let previous = try current(core, home: context.home)
        guard previous.revision == revision, lstat(lock.path, &linked) == 0, info.st_dev == linked.st_dev, info.st_ino == linked.st_ino else { throw AssistantError("启动偏好或锁已变化，未覆盖。") }
        let bytes = try JSONEncoder().encode(Record(selection: input.selection))
        try NetworkConfiguration.safeWrite(bytes, to: core.appendingPathComponent("selection.json"))
        try RelayCoreRecovery.sync(core)
        let result = try current(core, home: context.home)
        guard result.selection == input.selection, result.revision == NetworkConfiguration.digest(bytes) else { throw AssistantError("启动偏好保存未确认。") }
        return result
    }
}
