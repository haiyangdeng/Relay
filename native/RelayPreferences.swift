import Foundation
import Darwin

struct RelayStateContext: Codable {
    let home: String
    let stateRoot: String
}
struct RelayPreferenceSnapshot: Codable {
    let preferences: RelayPreferences
    let source: String
    let revision: String
    let warnings: [String]
}
struct RelayPreferenceInput: Decodable {
    enum Action: String, Decodable { case read, save }
    let action: Action
    let context: RelayStateContext
    let preferences: RelayPreferences?
    let revision: String?
}

/// Only the Relay preference file is writable. No client, browser or core writes.
final class RelayPreferenceStore {
    let home: URL
    let root: URL
    let legacyRoot: URL
    let preferenceURL: URL
    private let limit = 1048576
    private let writer: (Data, URL) throws -> Void
    private static let defaults = RelayPreferences(httpPort: 7890, node: "Your node", internalExceptions: "")

    init(_ context: RelayStateContext, writer: @escaping (Data, URL) throws -> Void = { try NetworkConfiguration.safeWrite($0, to: $1) }) throws {
        self.writer = writer
        guard context.home.hasPrefix("/"), context.stateRoot.hasPrefix("/"),
              !context.home.utf8.contains(0), !context.stateRoot.utf8.contains(0) else {
            throw AssistantError("Relay 数据目录无效。")
        }
        let home = NetworkConfiguration(home: URL(fileURLWithPath: context.home, isDirectory: true)).home
        self.home = home
        let attributes = try FileManager.default.attributesOfItem(atPath: home.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
            throw AssistantError("Relay 用户目录不可用。")
        }
        let candidate = URL(fileURLWithPath: context.stateRoot, isDirectory: true)
        try NetworkConfiguration.checkPlainPath(candidate)
        let path = NetworkConfiguration.canonicalPath(candidate)
        let allowed = ["Relay", "Relay-Preview"].map { home.appendingPathComponent("Library/Application Support/" + $0).path }
        guard allowed.contains(path) else { throw AssistantError("Relay 数据目录无效。") }
        root = URL(fileURLWithPath: path, isDirectory: true)
        legacyRoot = home.appendingPathComponent("Library/Application Support/AI Network Assistant", isDirectory: true)
        preferenceURL = root.appendingPathComponent("preferences.json")
    }

    private func readData(_ url: URL) throws -> Data? {
        try NetworkConfiguration.checkPlainPath(url)
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw AssistantError("偏好文件不可读取。") }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              info.st_size <= limit else { throw AssistantError("偏好文件类型、权限或长度无效。") }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16384)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw AssistantError("偏好文件读取失败。") }
            if count == 0 { break }
            guard data.count + count <= limit else { throw AssistantError("偏好文件过长。") }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    private func validated(_ preferences: RelayPreferences) throws -> RelayPreferences {
        let node = preferences.node.trimmingCharacters(in: .whitespacesAndNewlines)
        guard preferences.node.utf16.count <= 131072, preferences.internalExceptions.utf16.count <= 131072,
              !["DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL", "COMPATIBLE"].contains(node.uppercased()) else {
            throw AssistantError("偏好参数无效。")
        }
        let result = RelayPreferences(httpPort: preferences.httpPort, node: node, internalExceptions: preferences.internalExceptions)
        _ = try result.settings()
        return result
    }

    private func parsed(_ root: [String: Any]) throws -> RelayPreferences {
        // Only known fields may cross from the old assistant into Relay.
        let input: [String: Any] = ["httpPort": root["httpPort"] ?? Self.defaults.httpPort,
            "node": root["node"] ?? Self.defaults.node, "internalExceptions": root["internalExceptions"] ?? ""]
        return try validated(JSONDecoder().decode(RelayPreferences.self, from: NetworkConfiguration.encode(input)))
    }
    private func revision(_ label: String, _ data: Data?) -> String {
        NetworkConfiguration.digest(Data((label + ":" + (data.map(NetworkConfiguration.digest) ?? "missing")).utf8))
    }
    private func state() throws -> (RelayPreferenceSnapshot, [String: Any]) {
        let own: Data?
        do { own = try readData(preferenceURL) }
        catch { throw AssistantError("Relay 偏好无法读取；未覆盖原文件。") }
        if let own {
            do {
                let json = try NetworkConfiguration.json(own)
                return (RelayPreferenceSnapshot(preferences: try parsed(json), source: "relay", revision: revision("relay", own), warnings: []), json)
            } catch { throw AssistantError("Relay 偏好格式无效；未回退或覆盖，请先处理原文件。") }
        }
        let legacy: Data?
        do { legacy = try readData(legacyRoot.appendingPathComponent("preferences.json")) }
        catch {
            return (RelayPreferenceSnapshot(preferences: Self.defaults, source: "defaults", revision: revision("legacy-unavailable", nil),
                warnings: ["旧助手偏好不可读取，使用默认草稿；旧文件未修改。"]), [:])
        }
        if let legacy {
            do {
                return (RelayPreferenceSnapshot(preferences: try parsed(NetworkConfiguration.json(legacy)), source: "legacy", revision: revision("legacy", legacy),
                    warnings: ["已只读载入旧助手参数；显式保存后才会写入 Relay，旧文件保持原样。"]), [:])
            } catch {
                return (RelayPreferenceSnapshot(preferences: Self.defaults, source: "defaults", revision: revision("legacy-invalid", legacy),
                    warnings: ["旧助手偏好格式不兼容，使用默认草稿；未复制未知字段或覆盖旧文件。"]), [:])
            }
        }
        return (RelayPreferenceSnapshot(preferences: Self.defaults, source: "defaults", revision: revision("defaults", nil), warnings: []), [:])
    }

    func load() throws -> RelayPreferenceSnapshot { try state().0 }

    func stage(_ preferences: RelayPreferences) throws -> (current: RelayPreferenceSnapshot, next: RelayPreferenceSnapshot, data: Data) {
        let preferences = try validated(preferences)
        let (current, original) = try state()
        var json = original
        json["httpPort"] = preferences.httpPort; json["node"] = preferences.node
        json["internalExceptions"] = preferences.internalExceptions
        let data = try NetworkConfiguration.encode(json)
        guard data.count <= limit else { throw AssistantError("偏好文件过长，未保存。") }
        let next = RelayPreferenceSnapshot(preferences: preferences, source: "relay", revision: revision("relay", data), warnings: [])
        return (current, next, data)
    }

    /// Keep the journal lock as well, so older transaction readers stay compatible.
    func transactionBackend() -> NetworkConfiguration {
        NetworkConfiguration(home: home,
            diagnosticPaths: (home.appendingPathComponent("Library/Application Support/mihomo-party"), root.appendingPathComponent("Private Browser")),
            supportRoot: root, stateLock: RelayStateLock(root: root))
    }

    func save(_ preferences: RelayPreferences, expectedRevision: String) throws -> RelayPreferenceSnapshot {
        let preferences = try validated(preferences)
        guard expectedRevision.count == 64, expectedRevision.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            throw AssistantError("请先读取当前偏好版本，再保存。")
        }
        return try RelayStateLock(root: root).withLock {
            let staged = try stage(preferences)
            guard staged.current.revision == expectedRevision else {
                throw AssistantError("偏好已在其他窗口或进程中改变，请重新读取后再保存。")
            }
            do { try writer(staged.data, preferenceURL) }
            catch { throw AssistantError("偏好保存失败，原偏好未被本次操作替换。") }
            // No fallible file observation after the atomic commit.
            return staged.next
        }
    }
}
