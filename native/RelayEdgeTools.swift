import AppKit
import Foundation
import Darwin

struct RelayEdgeToolInput: Decodable {
    enum Action: String, Decodable { case inspect, openProfile, deviceManagement, edgePolicy }
    let action: Action
    let context: RelayStateContext
    let expectedRevision: String?
}
struct RelayEdgeInspection: Encodable {
    let version = 1
    let readOnly = true
    let runtimeVerified = false
    let policySource = "unconfirmed"
    let manualReviewRequired = true
    let edgeInstalled: Bool
    let policies: [RelayEdgePolicy]
    let reviewKeys: [String]
    let status: String
    let canOpenProfile: Bool
    let revision: String
    let warnings = ["只检查当前用户可读到的已知 Edge 策略，不能排除云端、组织或其他来源的策略。",
        "打开前必须在设备管理和 edge://policy 人工核对；不会删除、覆盖或绕过组织管理。",
        "描述文件作用于当前用户全部 Edge 资料。安装后需自行完全退出并重开 Edge，再重新检测；助手不会关闭浏览器。",
        "基础策略匹配不代表运行中的 Edge 已加载、DNS/WebRTC 零泄漏或账号风险已验收。"]
}
struct RelayEdgeToolResult: Encodable {
    let status = "requested"
    let action: String
    let installed = false
    let warnings: [String]
}
struct RelayEdgeEnvironment {
    var values: () -> [String: Any]
    var forced: () -> Set<String>
    var application: (URL, String) -> Bool
    var open: @MainActor (URL, URL) async throws -> Void

    static var live: RelayEdgeEnvironment {
        RelayEdgeEnvironment(values: {
            var result: [String: Any] = [:]
            for key in RelayEdgeTools.allKeys {
                result[key] = CFPreferencesCopyAppValue(key as CFString, "com.microsoft.Edge" as CFString)
            }
            return result
        }, forced: {
            Set(RelayEdgeTools.allKeys.filter { CFPreferencesAppValueIsForced($0 as CFString, "com.microsoft.Edge" as CFString) })
        }, application: RelayDesktopEnvironment.live.application, open: { url, application in
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let configuration = NSWorkspace.OpenConfiguration()
                NSWorkspace.shared.open([url], withApplicationAt: application, configuration: configuration) { app, error in
                    if app != nil && error == nil { continuation.resume() }
                    else { continuation.resume(throwing: AssistantError("打开请求未确认；可能已出现窗口，请核对后再操作。")) }
                }
            }
        })
    }
}

enum RelayEdgeTools {
    // URL-specific WebRTC policy takes precedence over the global policy.
    // Individual proxy policies may also represent existing organisational intent.
    // Presence is a reason to review, not proof that every listed value is harmful.
    static let additionalKeys = ["ProxyMode", "ProxyServer", "ProxyPacUrl", "ProxyBypassList",
        "WebRtcIPHandlingUrl", "WebRtcLocalIpsAllowedUrls", "DnsOverHttpsTemplates"]
    static var allKeys: [String] { (Array(NetworkConfiguration.expectedEdgePolicies.keys) + additionalKeys).sorted() }
    static let settingsURL = URL(fileURLWithPath: "/System/Applications/System Settings.app", isDirectory: true)
    static let deviceURL = URL(string: "x-apple.systempreferences:com.apple.Profiles-Settings.extension")!
    static let policyURL = URL(string: "edge://policy")!

    static func additionalPolicyKeys() -> [String] {
        let environment = RelayEdgeEnvironment.live
        let values = environment.values(), forced = environment.forced()
        return additionalKeys.filter { values[$0] != nil || forced.contains($0) }.sorted()
    }
    static func inspect(_ environment: RelayEdgeEnvironment) throws -> RelayEdgeInspection {
        let values = environment.values(), forced = environment.forced()
        let expected = NetworkConfiguration.expectedEdgePolicies
        let policies = NetworkConfiguration.assessEdgePolicies(values: values, forced: forced).map {
            RelayEdgePolicy(key: $0.key, forced: $0.forced, matches: $0.matches, valid: $0.valid)
        }
        let reviewKeys = additionalKeys.filter { values[$0] != nil || forced.contains($0) }.sorted()
        let installed = environment.application(RelayDesktopInspection.edgeURL, "com.microsoft.edgemac")
        let status = !reviewKeys.isEmpty || !installed ? "blocked" : policies.allSatisfy(\.valid) ? "configured"
            : policies.contains(where: \.forced) ? "blocked" : "needsInstall"
        // Hash the complete known observation, not merely booleans: changing one
        // wrong value to another during confirmation must invalidate the proof.
        let observations = Dictionary(uniqueKeysWithValues: allKeys.map { key in
            (key, ["forced": forced.contains(key), "value": values[key] ?? NSNull()] as [String: Any])
        })
        let revision = NetworkConfiguration.digest(try NetworkConfiguration.encode([
            "version": 1, "edgeInstalled": installed, "observations": observations,
            "expected": expected]))
        return RelayEdgeInspection(edgeInstalled: installed, policies: policies, reviewKeys: reviewKeys,
            status: status, canOpenProfile: status == "needsInstall", revision: revision)
    }
    private static func requireOwnedDirectory(_ directory: URL, home: URL) throws {
        try NetworkConfiguration.checkPlainPath(directory)
        guard directory.path.hasPrefix(home.path + "/") else { throw AssistantError("描述文件目录无效。") }
        var path = home
        for part in [""] + String(directory.path.dropFirst(home.path.count + 1)).components(separatedBy: "/") {
            if !part.isEmpty { path.appendPathComponent(part) }
            var info = stat()
            if lstat(path.path, &info) != 0 && errno == ENOENT {
                guard mkdir(path.path, 0o700) == 0 else { throw AssistantError("无法创建描述文件目录。") }
                guard lstat(path.path, &info) == 0 else { throw AssistantError("描述文件目录不可核对。") }
            }
            guard info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o022 == 0 else {
                throw AssistantError("描述文件目录不安全，未修改其权限。")
            }
        }
    }
    static func stage(_ paths: RelayPreferenceStore, data: Data) throws -> URL {
        let directory = paths.root.appendingPathComponent("Profiles", isDirectory: true)
        try requireOwnedDirectory(directory, home: paths.home)
        let target = directory.appendingPathComponent("Claude-Edge-Network.mobileconfig")
        if let previous = try RelayRecoveryInspector.read(target, limit: 65536) {
            guard previous.mode == 0o600,
                  let profile = try PropertyListSerialization.propertyList(from: previous.data, format: nil) as? [String: Any],
                  profile["PayloadIdentifier"] as? String == "local.claude.edge-network",
                  profile["PayloadType"] as? String == "Configuration",
                  profile["PayloadScope"] as? String == "User",
                  profile["PayloadRemovalDisallowed"] as? Bool == false,
                  let content = profile["PayloadContent"] as? [[String: Any]], content.count == 1,
                  content[0]["PayloadType"] as? String == "com.microsoft.Edge",
                  NetworkConfiguration.expectedEdgePolicies.allSatisfy({ key, value in
                      NSDictionary(dictionary: ["v": value]).isEqual(to: ["v": content[0][key] ?? NSNull()])
                  }), Set(content[0].keys).subtracting(NetworkConfiguration.expectedEdgePolicies.keys)
                    == Set(["PayloadType", "PayloadVersion", "PayloadIdentifier", "PayloadUUID", "PayloadDisplayName"]) else {
                throw AssistantError("暂存路径已有未知或改动文件，请人工核对；未替换。")
            }
        }
        try NetworkConfiguration.safeWrite(data, to: target)
        guard let saved = try RelayRecoveryInspector.read(target, limit: 65536), saved.mode == 0o600,
              saved.data == data else { throw AssistantError("描述文件暂存结果未确认，未打开。") }
        return target
    }
    static func perform(_ input: RelayEdgeToolInput, environment: RelayEdgeEnvironment) async throws -> RelayEdgeToolResult {
        let paths = try RelayPreferenceStore(input.context)
        let url: URL, application: URL
        switch input.action {
        case .inspect: throw AssistantError("只读检查不能请求打开。")
        case .openProfile:
            guard environment.application(settingsURL, "com.apple.systempreferences") else { throw AssistantError("系统设置应用身份无法确认，未暂存。") }
            guard let revision = input.expectedRevision, revision.count == 64,
                  revision.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw AssistantError("请重新检查 Edge 策略。") }
            // The existing state lease excludes active desktop login and Code
            // transactions. The operation never removes a managed profile.
            try requireOwnedDirectory(paths.root, home: paths.home)
            url = try RelayStateLock(root: paths.root).withLock {
                let report = try inspect(environment)
                guard report.revision == revision, report.canOpenProfile else { throw AssistantError("策略已改变或存在待处理策略，未打开描述文件。") }
                let target = try stage(paths, data: NetworkConfiguration.edgeProfileData())
                guard try inspect(environment).revision == revision else { throw AssistantError("暂存期间策略已改变，文件已保留但未打开。") }
                return target
            }
            application = settingsURL
        case .deviceManagement:
            guard input.expectedRevision == nil else { throw AssistantError("系统入口不接受版本参数。") }
            url = deviceURL; application = settingsURL
        case .edgePolicy:
            guard input.expectedRevision == nil else { throw AssistantError("策略入口不接受版本参数。") }
            url = policyURL; application = RelayDesktopInspection.edgeURL
        }
        guard environment.application(application, input.action == .edgePolicy ? "com.microsoft.edgemac" : "com.apple.systempreferences") else {
            throw AssistantError("没有找到身份匹配的目标应用，未使用默认浏览器或其他入口。")
        }
        try await environment.open(url, application)
        return RelayEdgeToolResult(action: input.action.rawValue, warnings: [
            "仅提交打开请求，没有确认安装、切换默认浏览器或重启任何应用。",
            input.action == .openProfile ? "请在系统设置核对并手动安装；同标识旧描述文件可能被替换。完成后重新检测四项策略。" : "未自动点击安装、刷新策略或更改页面设置。"])
    }
}
