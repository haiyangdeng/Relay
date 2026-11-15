import Foundation

struct RelayPreferences: Codable {
    let httpPort: Int
    let node: String
    let internalExceptions: String

    func settings() throws -> AssistantSettings {
        var settings = AssistantSettings()
        settings.httpPort = httpPort; settings.node = node; settings.internalExceptions = internalExceptions
        try settings.validate()
        return settings
    }
}

/// Supplied by the Electron main process, never accepted from renderer messages.
struct RelayDiagnosticContext: Decodable {
    let home: String
    let clashRoot: String
    let browserProfile: String
    let browserExecutable: String
    var owned: RelayOwnedDiagnosticPorts? = nil
}
struct RelayDiagnosticBrowser: Codable {
    let bundleId: String
    let version: String
    let profile: String
}
struct RelayOwnedDiagnosticMetadata: Codable {
    let appVersion: String
    let appBuild: String
    let browsers: [RelayDiagnosticBrowser]
}
struct RelayDiagnosticInput: Decodable {
    let settings: RelayPreferences
    let context: RelayDiagnosticContext
}
struct RelayGuardPlanInput: Decodable {
    let node: String
    let proxyTypes: [String: String]
}
struct RelayEdgePolicy: Codable {
    let key: String
    let forced: Bool
    let matches: Bool
    let valid: Bool
}
struct RelayReadOnlyReport: Codable {
    let snapshot: HealthSnapshot
    let checks: [CriticalCheck]
    let edgePolicies: [RelayEdgePolicy]
    let edgePolicyReviewKeys: [String]
    let timezone: String
    let preferredLanguages: [String]
    let readOnly: Bool
    let guardEnabled: Bool
    let warnings: [String]
    var owned: RelayOwnedDiagnosticMetadata? = nil
}

enum RelayReadOnly {
    static func report(backend: NetworkConfiguration, settings: AssistantSettings,
                       environment: DiagnosticEnvironment, timezone: String,
                       preferredLanguages: [String], policyReviewKeys: [String] = [],
                       owned: RelayOwnedDiagnosticPorts? = nil) -> RelayReadOnlyReport {
        // One policy observation per report; count and individual rows must agree.
        let policies = environment.edgePolicies()
        var captured = environment
        captured.edgePolicies = { policies }
        var snapshot = backend.diagnose(settings, environment: captured, owned: owned)
        let checks = CriticalDiagnostics.rows(snapshot).map { item -> CriticalCheck in
            guard item.id == "browser-config", !policyReviewKeys.isEmpty else { return item }
            return CriticalCheck(id: item.id, title: item.title, state: .attention,
                value: "发现需核对的 Edge 附加策略：" + policyReviewKeys.joined(separator: "、"),
                evidence: "基础四策略匹配不能排除额外策略覆盖；未修改或移除任何策略。",
                nextStep: "在设备管理及 edge://policy 核对来源和覆盖关系，再进行浏览器实测。")
        }
        snapshot.summary = checks.prefix(5).allSatisfy { $0.state == .verifiedConfiguration }
            ? "五项配置证据已核对（六项运行时检查仍待验证）"
            : "配置证据有待检查或补充；实际网络路径尚未验收"
        return RelayReadOnlyReport(snapshot: snapshot, checks: checks,
            edgePolicies: policies.map { RelayEdgePolicy(key: $0.key, forced: $0.forced, matches: $0.matches, valid: $0.valid) },
            edgePolicyReviewKeys: policyReviewKeys,
            timezone: timezone, preferredLanguages: preferredLanguages, readOnly: true, guardEnabled: false,
            warnings: [owned == nil ? "只读核对现有 Clash 来源；没有接管、写入、重载或停止核心。" :
                "仅核对 Relay 客户端配置；自有核心归属由 Main 另行核对，没有读取 Clash 配置或控制接口。",
                "端口和配置匹配不代表实际出口、DNS、WebRTC、模型请求或禁止直连已验收。",
                "时区和语言仅作环境参考，不自动修改，也不计算账号风险分。"])
    }

    static func live(_ input: RelayDiagnosticInput) throws -> RelayReadOnlyReport {
        let context = input.context
        try context.owned?.validate()
        let backend = NetworkConfiguration(home: URL(fileURLWithPath: context.home, isDirectory: true),
            diagnosticPaths: (URL(fileURLWithPath: context.clashRoot, isDirectory: true),
                              URL(fileURLWithPath: context.browserProfile, isDirectory: true)))
        let executable = FileManager.default.isExecutableFile(atPath: context.browserExecutable) ? context.browserExecutable : nil
        var environment = backend.liveDiagnosticEnvironment(browserExecutable: executable)
        // A missing bundled helper is never reported as a working browser entry.
        environment.browserExecutable = executable
        var result = report(backend: backend, settings: try input.settings.settings(), environment: environment,
            timezone: TimeZone.current.identifier, preferredLanguages: Locale.preferredLanguages,
            policyReviewKeys: RelayEdgeTools.additionalPolicyKeys(), owned: context.owned)
        if context.owned != nil {
            let root = RelayGuardReadiness.applicationRoot(URL(fileURLWithPath: CommandLine.arguments[0]))
            let app = root.flatMap { Bundle(url: $0) }
            let browsers = [("/Applications/Microsoft Edge.app", "com.microsoft.edgemac", "edge-default"),
                            ("/Applications/Google Chrome.app", "com.google.Chrome", "relay-private")].compactMap { path, id, profile -> RelayDiagnosticBrowser? in
                guard let bundle = Bundle(path: path), bundle.bundleIdentifier == id,
                      let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String else { return nil }
                return RelayDiagnosticBrowser(bundleId: id, version: version, profile: profile)
            }
            result.owned = RelayOwnedDiagnosticMetadata(
                appVersion: app?.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unpackaged",
                appBuild: app?.infoDictionary?["CFBundleVersion"] as? String ?? "unpackaged", browsers: browsers)
        }
        return result
    }

    static func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
}
