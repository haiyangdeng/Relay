import Foundation

struct RelayCodeContext: Decodable {
    let home: String
    let stateRoot: String
    let browserExecutable: String
    var state: RelayStateContext { RelayStateContext(home: home, stateRoot: stateRoot) }
}
struct RelayCodeInput: Decodable {
    let context: RelayCodeContext
    let settings: RelayPreferences
    let expectedRevision: String?
}
struct RelayCodePrepared: Encodable {
    let revision: String
    let httpPort: Int
    let changedTargets: [String]
    let browserState: String
    let helperReady: Bool
    let canApply: Bool
    let warnings = ["将联合备份并配置用户 Code 设置、Relay 参数及专用浏览器的两份偏好；不保存 JSON 草稿或复制旧浏览器资料。",
        "只更新四个代理变量、两个直连例外和 BROWSER；保留已有其他字段，不改 shell、Git、npm 或 IDE 全局环境。",
        "浏览器只使用当前 Relay 验证的专用 HTTP 入口；不会借用其他软件的代理或修改系统默认浏览器。",
        "已有专用窗口需先退出；启动入口会拒绝复用未核实启动参数的在用资料。实际网络与禁止直连仍待独立验收。"]
}
struct RelayCodeApplied: Encodable {
    let status = "applied"
    let backupId: String
    let preferenceSnapshot: RelayPreferenceSnapshot
    let warnings = ["四个文件已通过同一备份事务配置；没有重启客户端、网络或应用 Clash 配置。",
        "下一次 Code 会话使用新的 BROWSER；专用浏览器需代理端口和资料就绪后才启动。代理链路与禁止直连不由本次写入证明。"]
}
struct RelayCodeEnvironment {
    var helperDigest: (URL) throws -> String?
    var browserState: (URL) -> String
    static var live: Self {
        Self(helperDigest: { executable in
            _ = try RelayBrowserContract.wrapperURL()
            let native = URL(fileURLWithPath: CommandLine.arguments[0])
            let expected = native.deletingLastPathComponent().appendingPathComponent("RelayBrowser.app/Contents/MacOS/RelayBrowser")
            guard executable.path == NetworkConfiguration.canonicalPath(expected) else { throw AssistantError("浏览器入口必须随 Relay 原生模块打包。") }
            guard FileManager.default.isExecutableFile(atPath: executable.path) else { return nil }
            // The CLI and Launch Services use the same signed browser executable.
            guard let file = try RelayRecoveryInspector.read(executable, limit: 33554432, allowRootOwner: true), file.mode & 0o022 == 0 else {
                throw AssistantError("浏览器入口权限无效。")
            }
            return NetworkConfiguration.digest(file.data)
        }, browserState: { RelayBrowserProcesses.status($0) })
    }
}
enum RelayCodeConfiguration {
    private struct Staged {
        let report: RelayCodePrepared
        let store: RelayPreferenceStore
        let writes: [(URL, Data, Int)]
        let originals: [RelayRecoveryInspector.FileObservation?]
        let nextPreferences: RelayPreferenceSnapshot
    }
    private static func object(_ root: [String: Any], _ key: String) throws -> [String: Any] {
        guard root[key] == nil || root[key] is [String: Any] else { throw AssistantError("配置字段类型异常，未准备写入。") }
        return root[key] as? [String: Any] ?? [:]
    }
    private static func stage(_ input: RelayCodeInput, environment: RelayCodeEnvironment) throws -> Staged {
        let store = try RelayPreferenceStore(input.context.state)
        guard store.root.lastPathComponent == RelayBrowserContract.namespace,
              input.context.browserExecutable.hasPrefix("/"), !input.context.browserExecutable.utf8.contains(0) else {
            throw AssistantError("Code 与浏览器运行目录不匹配。")
        }
        let preferences = try store.stage(input.settings)
        let settings = preferences.next.preferences
        let helper = URL(fileURLWithPath: input.context.browserExecutable)
        try NetworkConfiguration.checkPlainPath(helper)
        let helperDigest = try environment.helperDigest(helper)
        let profile = RelayBrowserContract.profile(store)
        let urls = [store.home.appendingPathComponent(".claude/settings.json"), store.preferenceURL,
            profile.appendingPathComponent("Local State"), profile.appendingPathComponent("Default/Preferences")]
        let names = ["claudeSettings", "assistantPreferences", "browserLocalState", "browserPreferences"]
        let originals = try urls.map { try RelayRecoveryInspector.read($0) }
        func json(_ index: Int) throws -> [String: Any] {
            try originals[index].map { try NetworkConfiguration.json($0.data) } ?? [:]
        }
        var code = try json(0), env = try object(code, "env")
        var bypasses: [String] = []
        for key in ["NO_PROXY", "no_proxy"] {
            if let existing = env[key] {
                guard let value = existing as? String else { throw AssistantError("已有直连例外类型异常，未准备写入。") }
                bypasses.append(value)
            }
        }
        let bypass = try NetworkConfiguration.mergedNoProxy(existing: bypasses, additions: settings.internalExceptions)
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] { env[key] = "http://127.0.0.1:\(settings.httpPort)" }
        env["NO_PROXY"] = bypass; env["no_proxy"] = bypass; env["BROWSER"] = helper.path
        code["env"] = env
        var state = try json(2), doh = try object(state, "dns_over_https")
        doh["mode"] = "off"; state["dns_over_https"] = doh
        var browser = try json(3), rtc = try object(browser, "webrtc"), label = try object(browser, "profile")
        rtc["ip_handling_policy"] = "disable_non_proxied_udp"; browser["webrtc"] = rtc
        label["name"] = "Relay Private"; browser["profile"] = label
        let data = [try NetworkConfiguration.encode(code), preferences.data, try NetworkConfiguration.encode(state), try NetworkConfiguration.encode(browser)]
        guard data.allSatisfy({ $0.count <= 4194304 }) else { throw AssistantError("生成配置过长，未准备写入。") }
        let browserState = environment.browserState(profile)
        let stateValue = ["closed", "running"].contains(browserState) ? browserState : "unconfirmed"
        let changed = names.indices.filter { originals[$0]?.data != data[$0] || originals[$0]?.mode != 0o600 }.map { names[$0] }
        let encoded = try RelayReadOnly.encode(settings)
        let evidence = [encoded, preferences.current.revision, helper.path, helperDigest ?? "missing", stateValue] + names.indices.map {
            "\(names[$0]):\(originals[$0].map { NetworkConfiguration.digest($0.data) } ?? "missing"):\(originals[$0]?.mode ?? -1):\(NetworkConfiguration.digest(data[$0]))"
        }
        let report = RelayCodePrepared(revision: NetworkConfiguration.digest(Data(evidence.joined(separator: "\n").utf8)),
            httpPort: settings.httpPort, changedTargets: changed, browserState: stateValue, helperReady: helperDigest != nil,
            canApply: helperDigest != nil && stateValue == "closed" && !changed.isEmpty)
        return Staged(report: report, store: store, writes: urls.indices.map { (urls[$0], data[$0], 0o600) }, originals: originals, nextPreferences: preferences.next)
    }
    static func prepare(_ input: RelayCodeInput, environment: RelayCodeEnvironment = .live) throws -> RelayCodePrepared {
        try stage(input, environment: environment).report
    }
    static func apply(_ input: RelayCodeInput, environment: RelayCodeEnvironment = .live,
                      beforeEntry: ((Int) throws -> Void)? = nil) throws -> RelayCodeApplied {
        guard let revision = input.expectedRevision, revision.utf8.count == 64,
              revision.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw AssistantError("请先准备并核对实际配置。") }
        let staged = try stage(input, environment: environment)
        guard staged.report.revision == revision, staged.report.canApply else { throw AssistantError("配置已变化或仍未就绪，未执行写入。") }
        let profile = RelayBrowserContract.profile(staged.store)
        let backup = try RelayBrowserLauncher.launchLock(staged.store.root).withLock {
            try staged.store.transactionBackend().install(staged.writes, strictBounds: true, lockedPreflight: { originals in
            let current = try stage(input, environment: environment)
            guard current.report.canApply, current.report.revision == revision, originals.count == staged.originals.count,
                  originals.indices.allSatisfy({ originals[$0].1 == staged.originals[$0]?.data &&
                    originals[$0].2 == (staged.originals[$0]?.mode ?? 0o600) }) else {
                throw AssistantError("配置在确认后改变，未执行写入。")
            }
        }, beforeInstallEntry: { index in
            try beforeEntry?(index)
            guard environment.browserState(profile) == "closed" else { throw AssistantError("专用浏览器在配置期间启动，已停止写入。") }
        }, beforeRollbackEntry: { index in
            if index >= 2 && environment.browserState(profile) != "closed" { throw AssistantError("浏览器仍在使用资料，保留事务供后续恢复。") }
        })
        }
        return RelayCodeApplied(backupId: backup.lastPathComponent, preferenceSnapshot: staged.nextPreferences)
    }
}
