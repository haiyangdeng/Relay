import AppKit
import CoreServices
import Foundation

struct RelayDesktopIdentity: Codable, Equatable {
    let bundleIdentifier: String
    let appURL: String

    var valid: Bool {
        guard !bundleIdentifier.isEmpty, bundleIdentifier.utf8.count <= 255,
              bundleIdentifier.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 95].contains($0) }),
              let url = URL(string: appURL), url.isFileURL, url.host == nil || url.host == "",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.hasPrefix("/"), url.path.hasSuffix(".app"), !url.path.utf8.contains(0),
              url.standardizedFileURL.path == url.path else { return false }
        return appURL == URL(fileURLWithPath: url.path, isDirectory: true).absoluteString
    }
}

// Compatible with the legacy record format. Never copy it into Relay or repair
// it during a read: a live legacy coordinator may still own its recovery lock.
struct RelayDesktopRecord: Codable, Equatable {
    let version: Int
    let sessionID: String
    let createdAt: String
    let originals: [String: RelayDesktopIdentity]
    let temporaryApplication: RelayDesktopIdentity
    let attemptedSchemes: [String]
    let phase: String

    static func decode(_ file: RelayRecoveryInspector.FileObservation) throws -> RelayDesktopRecord {
        guard file.mode == 0o600, let saved = try? JSONDecoder().decode(Self.self, from: file.data),
              [1, 2].contains(saved.version), UUID(uuidString: saved.sessionID) != nil,
              ISO8601DateFormatter().date(from: saved.createdAt) != nil,
              Set(saved.originals.keys) == Set(RelayDesktopInspection.schemes), saved.originals.values.allSatisfy(\.valid),
              (saved.version == 1 ? saved.temporaryApplication == RelayDesktopInspection.edge
                : RelayDesktopInspection.isRelayBrowser(saved.temporaryApplication)),
              saved.attemptedSchemes.count == Set(saved.attemptedSchemes).count,
              Set(saved.attemptedSchemes).isSubset(of: Set(RelayDesktopInspection.schemes)),
              ["starting", "active", "restoring"].contains(saved.phase) else {
            throw AssistantError("桌面登录记录格式或权限异常，已保留。")
        }
        return saved
    }

    func updating(phase: String, attempted: [String]? = nil) -> RelayDesktopRecord {
        RelayDesktopRecord(version: version, sessionID: sessionID, createdAt: createdAt, originals: originals,
            temporaryApplication: temporaryApplication, attemptedSchemes: attempted ?? attemptedSchemes, phase: phase)
    }
}
struct RelayDesktopRecoverySummary: Encodable {
    let source: String
    let state: String
    let phase: String
    let decisions: [String: String]
}
struct RelayDesktopReadiness: Encodable {
    let edgeInstalled: Bool
    let edgePoliciesReady: Bool
    let edgeClosed: Bool
    let claudeInstalled: Bool
    let browserReady: Bool
    let defaults: [String: String]
    let sharedDefaults: Bool
    let records: [RelayDesktopRecoverySummary]
    let configurationReady: Bool
    let readOnly = true
    let startEnabled = false
    let proxy = "notTested"
    let locks = "notAcquired"
    let warnings = ["仅核对 Edge 应用、已知强制策略、退出状态、默认浏览器和恢复记录；不探测代理端口、不发送请求。",
        "未取得会话锁，不授予登录或恢复权限；实际操作前仍须持锁复核。",
        "本次只读检查不安装描述文件、不切换默认浏览器或启动应用；实际会话须另行系统确认。",
        "登录直接使用 Microsoft Edge；开始时必须核对 17890 属于 Relay 的固定节点专用 SOCKS。",
        "Edge 策略作用于当前用户全部 Edge 资料；此快照不证明真实网络路径已验收。"]
}
struct RelayDesktopEnvironment {
    var application: (URL, String) -> Bool
    var loginBrowser: () -> RelayDesktopIdentity?
    var edgePoliciesReady: () -> Bool
    var edgeClosed: () -> Bool
    var currentDefault: (String) -> RelayDesktopIdentity?

    static var live: RelayDesktopEnvironment {
        RelayDesktopEnvironment(application: { url, expected in
            guard let bundle = Bundle(url: url), bundle.bundleIdentifier == expected,
                  let executable = bundle.executableURL else { return false }
            return FileManager.default.isExecutableFile(atPath: executable.path)
        }, loginBrowser: { RelayDesktopInspection.edge }, edgePoliciesReady: {
            (try? RelayEdgeTools.inspect(.live).status) == "configured"
        }, edgeClosed: {
            NSRunningApplication.runningApplications(withBundleIdentifier: "com.microsoft.edgemac").isEmpty
        }, currentDefault: { scheme in
            guard let copied = LSCopyDefaultHandlerForURLScheme(scheme as CFString),
                  let query = URL(string: scheme + "://localhost/"),
                  let app = NSWorkspace.shared.urlForApplication(toOpen: query), let bundle = Bundle(url: app) else { return nil }
            let identifier = copied.takeRetainedValue() as String
            guard bundle.bundleIdentifier == identifier else { return nil }
            return RelayDesktopIdentity(bundleIdentifier: identifier,
                appURL: URL(fileURLWithPath: app.resolvingSymlinksInPath().standardizedFileURL.path, isDirectory: true).absoluteString)
        })
    }
}

enum RelayDesktopInspection {
    static let schemes = ["http", "https"]
    // Shared with the existing Edge mobileconfig. A local listening port alone
    // is insufficient: the session also requires Relay's authenticated binding.
    static let edgeProxyPort = 17890
    static let edgeURL = URL(fileURLWithPath: "/Applications/Microsoft Edge.app", isDirectory: true)
    static let claudeURL = URL(fileURLWithPath: "/Applications/Claude.app", isDirectory: true)
    static let edge = RelayDesktopIdentity(bundleIdentifier: "com.microsoft.edgemac", appURL: edgeURL.absoluteString)

    static func isRelayBrowser(_ identity: RelayDesktopIdentity) -> Bool {
        guard identity.valid, identity.bundleIdentifier == RelayBrowserContract.wrapperIdentifier,
              let url = URL(string: identity.appURL) else { return false }
        return url.path.hasSuffix(".app/Contents/Resources/relay/RelayBrowser.app")
    }

    static func record(_ url: URL, source: String, current: [String: RelayDesktopIdentity]) -> RelayDesktopRecoverySummary {
        func result(_ state: String, _ phase: String, _ decisions: [String: String] = [:]) -> RelayDesktopRecoverySummary {
            RelayDesktopRecoverySummary(source: source, state: state, phase: phase,
                decisions: Dictionary(uniqueKeysWithValues: schemes.map { ($0, decisions[$0] ?? (state == "missing" ? "notApplicable" : "unconfirmed")) }))
        }
        let file: RelayRecoveryInspector.FileObservation
        do {
            guard let read = try RelayRecoveryInspector.read(url, limit: 65536) else { return result("missing", "none") }
            file = read
        } catch { return result("unreadable", "unreadable") }
        guard let saved = try? RelayDesktopRecord.decode(file) else { return result("invalid", "invalid") }
        // macOS can associate both schemes. One external change blocks any
        // setter that could also overwrite the other scheme. No setter runs here.
        let paired = saved.originals["http"] == saved.originals["https"]
            && schemes.allSatisfy { current[$0] == saved.originals[$0] || current[$0] == saved.temporaryApplication }
        let decisions = Dictionary(uniqueKeysWithValues: schemes.map { scheme -> (String, String) in
            guard let now = current[scheme] else { return (scheme, "unconfirmed") }
            if now == saved.originals[scheme] { return (scheme, "alreadyOriginal") }
            if now == saved.temporaryApplication && saved.attemptedSchemes.contains(scheme) && paired { return (scheme, "restoreEligible") }
            return (scheme, "blocked")
        })
        return result("pending", saved.phase, decisions)
    }

    static func inspect(_ context: RelayStateContext, environment: RelayDesktopEnvironment = .live) throws -> RelayDesktopReadiness {
        let paths = try RelayPreferenceStore(context)
        var defaults: [String: RelayDesktopIdentity] = [:]
        for scheme in schemes {
            if let identity = environment.currentDefault(scheme), identity.valid { defaults[scheme] = identity }
        }
        let shared = defaults.count == 2 && defaults["http"] == defaults["https"]
        let browser = environment.loginBrowser()
        let edgeInstalled = browser.map { identity in
            identity == edge && environment.application(edgeURL, edge.bundleIdentifier)
        } ?? false
        let edgePoliciesReady = environment.edgePoliciesReady(), edgeClosed = environment.edgeClosed()
        let claudeInstalled = environment.application(claudeURL, "com.anthropic.claudefordesktop")
        let browserReady = edgeInstalled && edgePoliciesReady && edgeClosed
        let records = [
            record(paths.root.appendingPathComponent("Desktop Login/state.json"), source: "relay", current: defaults),
            record(paths.home.appendingPathComponent("Library/Application Support/Claude Desktop Login/state.json"), source: "legacy", current: defaults)
        ]
        return RelayDesktopReadiness(edgeInstalled: edgeInstalled, edgePoliciesReady: edgePoliciesReady, edgeClosed: edgeClosed,
            claudeInstalled: claudeInstalled, browserReady: browserReady,
            defaults: defaults.mapValues(\.bundleIdentifier), sharedDefaults: shared, records: records,
            configurationReady: edgeInstalled && claudeInstalled && browserReady && shared
                && records.allSatisfy { $0.state == "missing" })
    }
}
