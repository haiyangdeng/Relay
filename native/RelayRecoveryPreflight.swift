import Foundation
import Darwin

struct RelayRecoverySelection: Codable {
    let source: String
    let id: String

    func validate() throws {
        guard ["relay", "legacy"].contains(source), !id.isEmpty, id.utf8.count <= 200,
              id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw AssistantError("恢复记录来源或编号无效。")
        }
    }
}
struct RelayRecoveryPreflightInput: Decodable {
    let context: RelayStateContext
    let selection: RelayRecoverySelection
}
struct RelayRecoveryTarget: Encodable {
    let index: Int
    let target: String
    let original: String
    let current: String
}
struct RelayRecoveryPreflight: Encodable {
    let selection: RelayRecoverySelection
    let version: Int
    let phase: String
    let revision: String
    let targets: [RelayRecoveryTarget]
    let issues: [String]
    let requiresLegacyConfirmation: Bool
    let browser: String
    let fileChecksPassed: Bool
    let snapshotOnly = true
    let restoreEnabled = false
    let warnings = ["只读预检会读取备份原文件与当前目标的内容和权限；不返回内容、路径或账号信息。",
        "检查是当前时点的快照，不能作为执行授权；实际恢复前仍须持锁重新校验。",
        "浏览器退出状态来自进程参数、父进程和活动锁核对；写入前仍须重新检查。"]
}

/// No mkdir, chmod, lock acquisition, manifest repair or restore calls here.
enum RelayRecoveryInspector {
    struct FileObservation {
        let data: Data
        let mode: Int
    }
    static func read(_ url: URL, limit: Int = 4194304, allowRootOwner: Bool = false) throws -> FileObservation? {
        try NetworkConfiguration.checkPlainPath(url)
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw AssistantError("预检文件不可读取。") }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_uid == getuid() || (allowRootOwner && info.st_uid == 0)), info.st_nlink == 1,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_size <= limit else {
            throw AssistantError("预检文件类型、权限或长度无效。")
        }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 16384)
        while true {
            let size = Darwin.read(fd, &buffer, buffer.count)
            if size < 0 && errno == EINTR { continue }
            guard size >= 0, data.count + max(0, size) <= limit else { throw AssistantError("预检文件读取失败或过长。") }
            if size == 0 { break }
            data.append(contentsOf: buffer.prefix(size))
        }
        return FileObservation(data: data, mode: Int(info.st_mode & 0o777))
    }
    private static func validDigest(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func inspect(_ input: RelayRecoveryPreflightInput, browserObservation: ((URL) -> String)? = nil) throws -> RelayRecoveryPreflight {
        try input.selection.validate()
        let paths = try RelayPreferenceStore(input.context)
        let root = input.selection.source == "relay" ? paths.root : paths.legacyRoot
        let record = root.appendingPathComponent("Backups", isDirectory: true).appendingPathComponent(input.selection.id, isDirectory: true)
        let profile = input.selection.source == "relay" ? paths.root.appendingPathComponent("Private Browser", isDirectory: true) :
            paths.home.appendingPathComponent("Library/Application Support/Claude Private Browser", isDirectory: true)
        let allowed = [paths.home.appendingPathComponent(".claude/settings.json").path: "claudeSettings",
            root.appendingPathComponent("preferences.json").path: "assistantPreferences",
            profile.appendingPathComponent("Local State").path: "browserLocalState",
            profile.appendingPathComponent("Default/Preferences").path: "browserPreferences"]
        var issues: [String] = [], targets: [RelayRecoveryTarget] = [], evidence = [String]()
        var version = 0, phase = "unreadable", browser = "notApplicable"
        func issue(_ code: String) { if !issues.contains(code) { issues.append(code) } }
        do {
            guard let file = try read(record.appendingPathComponent("manifest.json"), limit: 1048576) else { throw AssistantError("清单缺失。") }
            evidence.append(NetworkConfiguration.digest(file.data))
            let manifest = try JSONDecoder().decode(BackupManifest.self, from: file.data)
            guard [1, 2].contains(manifest.version), (1...4).contains(manifest.entries.count),
                  Set(manifest.entries.map(\.path)).count == manifest.entries.count,
                  manifest.entries.allSatisfy({ (0...0o777).contains($0.originalMode) &&
                    ($0.installedMode.map { (0...0o777).contains($0) } ?? true) &&
                    validDigest($0.installedDigest) && ($0.originalDigest == nil || validDigest($0.originalDigest)) }),
                  manifest.version == 1 || ["prepared", "committed", "recoveryNeeded", "restoring", "rolledBack", "restored"].contains(manifest.phase ?? "") else {
                throw AssistantError("清单无效。")
            }
            version = manifest.version; phase = version == 1 ? "legacy" : manifest.phase!
            if ["rolledBack", "restored"].contains(phase) { issue("transactionFinished") }
            if version == 1 { issue("legacyConfirmationRequired") }
            for (index, entry) in manifest.entries.enumerated() {
                guard let label = allowed[entry.path], entry.path == NetworkConfiguration.canonicalPath(URL(fileURLWithPath: entry.path)) else {
                    issue("targetOutsideScope")
                    targets.append(RelayRecoveryTarget(index: index, target: "unknown", original: "unassessed", current: "unassessed"))
                    continue
                }
                var original = "unreadable", current = "unreadable", originalFile: FileObservation?
                do {
                    guard entry.backupName == "original-\(index).bin", entry.originalExists || entry.originalDigest == nil,
                          !entry.originalExists || version == 1 || validDigest(entry.originalDigest) else { throw AssistantError("原始记录无效。") }
                    if entry.originalExists {
                        guard let file = try read(record.appendingPathComponent(entry.backupName)) else { throw AssistantError("原始备份缺失。") }
                        originalFile = file
                        let digest = NetworkConfiguration.digest(file.data)
                        evidence.append("original:\(index):\(digest)")
                        if let expected = entry.originalDigest, digest != expected { original = "invalid"; issue("originalInvalid") }
                        else { original = version == 1 ? "unverifiedLegacy" : "verified" }
                    } else { original = "absent" }
                } catch { issue("originalInvalid") }
                do {
                    if let file = try read(URL(fileURLWithPath: entry.path)) {
                        let digest = NetworkConfiguration.digest(file.data)
                        evidence.append("target:\(index):\(digest):\(file.mode)")
                        if entry.originalExists, let originalFile, original != "invalid",
                           digest == NetworkConfiguration.digest(originalFile.data), file.mode == entry.originalMode { current = "original" }
                        else if digest == entry.installedDigest, entry.installedMode == nil {
                            current = "unverifiedMode"; issue("targetModeUnknown")
                        }
                        else if digest == entry.installedDigest, file.mode == entry.installedMode { current = "installed" }
                        else { current = "changed"; issue("targetChanged") }
                    } else {
                        evidence.append("target:\(index):missing")
                        current = entry.originalExists ? "changed" : "original"
                        if current == "changed" { issue("targetChanged") }
                    }
                } catch { issue("targetUnreadable") }
                targets.append(RelayRecoveryTarget(index: index, target: label, original: original, current: current))
            }
            if targets.contains(where: { $0.target.hasPrefix("browser") }) {
                browser = (browserObservation ?? { RelayBrowserProcesses.status($0) })(profile)
                if !["running", "closed"].contains(browser) { browser = "unconfirmed" }
                if browser != "closed" { issue(browser == "running" ? "browserRunning" : "browserProcessUnconfirmed") }
            }
        } catch { issue("manifestInvalid") }
        evidence.append(contentsOf: [input.selection.source, input.selection.id, phase, browser] + issues)
        return RelayRecoveryPreflight(selection: input.selection, version: version, phase: phase,
            revision: NetworkConfiguration.digest(Data(evidence.joined(separator: "\n").utf8)), targets: targets,
            issues: issues, requiresLegacyConfirmation: version == 1, browser: browser,
            fileChecksPassed: !issues.contains(where: { !["legacyConfirmationRequired", "browserRunning", "browserProcessUnconfirmed", "transactionFinished"].contains($0) }))
    }
}
