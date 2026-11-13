import Foundation
import CoreFoundation
import CryptoKit
import SystemConfiguration
import Darwin

struct AssistantError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

struct AssistantSettings: Codable, Equatable {
    var httpPort = 7890
    var socksPort: Int { 17890 }
    var node = ""
    var internalExceptions = ""

    func validate() throws {
        guard (1...65535).contains(httpPort), httpPort != socksPort else {
            throw AssistantError("HTTP 端口需要在 1–65535 之间，并与专用 SOCKS 端口 17890 不同。")
        }
        guard !node.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !node.contains(where: { $0.isNewline || $0 == "," }),
              !["DIRECT", "REJECT", "GLOBAL"].contains(node.uppercased()) else {
            throw AssistantError("请填写已有代理节点的准确名称，不可填 DIRECT、REJECT 或 GLOBAL。")
        }
    }
}

struct HealthSnapshot: Sendable, Codable {
    var checkedAt = ""
    var directOption: Bool?
    var routingVerified: Bool?
    var dnsVerified: Bool?
    var chromeDoHOff: Bool?
    var chromeWebRTCRestricted: Bool?
    var httpReady = false
    var socksReady = false
    var systemProxy = false
    var cliConfigured = false
    var browserIntegrated = false
    var edgePolicyCount = 0
    var clashRules = 0
    var dnsPolicies = 0
    var clashLocated = false
    var controllerConnected = false
    var selectedNode = ""
    var nodeNames: [String] = []
    var proxyTypes: [String: String] = [:]
    var summary = "尚未检测"
    var details: [String] = []

    static let preview = HealthSnapshot(checkedAt: "演示数据", directOption: true, routingVerified: false, dnsVerified: true, chromeDoHOff: true, chromeWebRTCRestricted: true, httpReady: true, socksReady: true, systemProxy: true,
        cliConfigured: true, browserIntegrated: true, edgePolicyCount: 4, clashRules: 8, dnsPolicies: 8,
        clashLocated: true, controllerConnected: true, selectedNode: "示例节点",
        nodeNames: ["示例节点"], summary: "演示：有可选直连路径待检查", details: ["预览数据，不代表本机检测结果。"])
}

struct BackupEntry: Codable {
    let path: String
    let originalExists: Bool
    let originalMode: Int
    let backupName: String
    let installedDigest: String
    let originalDigest: String?
    let installedMode: Int?
    var installedEnvironment: [String: String]? = nil
}
struct BackupManifest: Codable {
    let version: Int
    let createdAt: String
    let entries: [BackupEntry]
    var phase: String?
    let order: UInt64?
}
struct BackupMetadata: Codable {
    let id: String
    let createdAt: String
    let version: Int
    let phase: String
    let targetCount: Int
}
struct BackupMetadataInventory: Codable {
    let source: String
    let availability: String
    let complete: Bool
    let entries: [BackupMetadata]
}

/// Read-only dependencies. Tests replace all OS, file and controller observations.
struct DiagnosticEnvironment {
    var now: () -> String
    var readJSON: (URL) throws -> [String: Any]
    var readYAML: (URL) throws -> [String: Any]
    var portReady: (Int) -> Bool
    var systemProxies: () -> [String: Any]
    var edgePolicies: () -> [NetworkConfiguration.PolicyStatus]
    var controller: () -> URL?
    var controllerGET: (URL, String) throws -> [String: Any]
    var browserExecutable: String?
}

/// All system command invocations are fixed executables with separate arguments.
/// This backend contains no Clash mutation, stop, restart, reload or connection-close call.
final class NetworkConfiguration {
    let home: URL
    let support: URL
    let bundle: Bundle
    static let claudeEnvironmentKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "BROWSER"]
    static let claudeDomains = ["anthropic.com", "claude.ai", "claude.com", "claudeusercontent.com"]
    static let codexDomains = ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"]
    static let edgeDomain = "com.microsoft.Edge"

    private let diagnosticPaths: (clash: URL, browser: URL)?
    private let stateLock: RelayStateLock?
    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, bundle: Bundle = .main,
         diagnosticPaths: (clash: URL, browser: URL)? = nil, supportRoot: URL? = nil, stateLock: RelayStateLock? = nil) {
        let canonicalHome: URL
        if let resolved = realpath(home.path, nil) {
            canonicalHome = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
            free(resolved)
        } else { canonicalHome = home }
        self.home = canonicalHome
        self.support = supportRoot ?? canonicalHome.appendingPathComponent("Library/Application Support/AI Network Assistant", isDirectory: true)
        self.bundle = bundle
        self.diagnosticPaths = diagnosticPaths
        self.stateLock = stateLock
    }
    var clashRoot: URL { diagnosticPaths?.clash ?? home.appendingPathComponent("Library/Application Support/mihomo-party", isDirectory: true) }
    var claudeSettings: URL { home.appendingPathComponent(".claude/settings.json") }
    var browserProfile: URL { diagnosticPaths?.browser ?? home.appendingPathComponent("Library/Application Support/Claude Private Browser", isDirectory: true) }

    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    // Resolve existing ancestors with POSIX realpath. Foundation can standardize
    // /private/var differently for existing and not-yet-created files.
    static func canonicalPath(_ url: URL) -> String {
        var cursor = url
        var suffix: [String] = []
        while cursor.path != "/" {
            if let pointer = realpath(cursor.path, nil) {
                let base = String(cString: pointer)
                free(pointer)
                var components = base.split(separator: "/").map(String.init)
                for component in suffix.reversed() {
                    if component == ".." { if !components.isEmpty { components.removeLast() } }
                    else if component != "." && !component.isEmpty { components.append(component) }
                }
                return "/" + components.joined(separator: "/")
            }
            suffix.append(cursor.lastPathComponent)
            cursor.deleteLastPathComponent()
        }
        return url.path
    }
    private func isInsideHome(_ url: URL) -> Bool {
        Self.canonicalPath(url).hasPrefix(Self.canonicalPath(home) + "/")
    }

    @discardableResult
    static func run(_ executable: String, _ arguments: [String], input: Data? = nil) throws -> Data {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = arguments
        let output = Pipe()
        task.standardOutput = output
        // Never forward raw config/parser errors: they may contain a node credential.
        task.standardError = FileHandle.nullDevice
        if let input {
            let pipe = Pipe()
            task.standardInput = pipe
            try task.run()
            pipe.fileHandleForWriting.write(input)
            try? pipe.fileHandleForWriting.close()
        } else {
            task.standardInput = FileHandle.nullDevice
            try task.run()
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw AssistantError("操作未完成（\(URL(fileURLWithPath: executable).lastPathComponent)，状态 \(task.terminationStatus)）。原始输出未展示，以免泄露凭据。")
        }
        return data
    }

    static func json(_ data: Data) throws -> [String: Any] {
        guard let dictionary = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AssistantError("配置的根节点需要是对象，已停止操作。")
        }
        return dictionary
    }
    static func encode(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) + Data([10])
    }
    static func readYAML(_ path: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: path)
        // Built-in macOS Ruby/Psych is used only as a YAML parser. No user code is evaluated.
        let code = "print JSON.generate(YAML.safe_load(STDIN.read, permitted_classes: [Symbol, Date, Time], permitted_symbols: [], aliases: true) || {})"
        let output = try run("/usr/bin/ruby", ["-ryaml", "-rjson", "-rdate", "-e", code], input: data)
        return try json(output)
    }
    private static func portReady(_ port: Int) -> Bool {
        (try? run("/usr/bin/nc", ["-z", "-G", "1", "-w", "1", "127.0.0.1", String(port)])) != nil
    }

    static func mergedNoProxy(existing: [String], additions: String) throws -> String {
        try ConfigurationAssessment.mergedNoProxy(existing: existing, additions: additions, domains: claudeDomains + codexDomains)
    }

    func readSavedSettings() -> AssistantSettings {
        guard let data = try? Data(contentsOf: support.appendingPathComponent("preferences.json")),
              let settings = try? JSONDecoder().decode(AssistantSettings.self, from: data) else { return AssistantSettings() }
        return settings
    }
    func savePreferences(_ settings: AssistantSettings) throws {
        try settings.validate()
        try Self.safeWrite(try JSONEncoder().encode(settings), to: support.appendingPathComponent("preferences.json"))
    }

    static func safeWrite(_ data: Data, to url: URL, mode: Int = 0o600) throws {
        let fm = FileManager.default
        guard url.isFileURL, !url.path.utf8.contains(0), (0...0o777).contains(mode) else {
            throw AssistantError("配置文件路径或权限无效，未写入。")
        }
        func requireRegularTarget() throws {
            do {
                let attributes = try fm.attributesOfItem(atPath: url.path)
                guard attributes[.type] as? FileAttributeType == .typeRegular else {
                    throw AssistantError("目标不是普通文件：\(url.lastPathComponent)")
                }
            } catch let error as NSError where error.domain == NSCocoaErrorDomain &&
                [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) {
                return
            }
        }
        try checkPlainPath(url)
        try requireRegularTarget()
        let parent = url.deletingLastPathComponent()
        try fm.createDirectory(at: parent, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        try checkPlainPath(parent)
        let temporary = parent.appendingPathComponent(".ai-network-write-" + UUID().uuidString + ".tmp")
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw AssistantError("无法创建临时配置文件：\(String(cString: strerror(errno)))") }
        var committed = false
        defer {
            Darwin.close(descriptor)
            if !committed { _ = Darwin.unlink(temporary.path) }
        }
        try data.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var written = 0
            while written < buffer.count {
                let count = Darwin.write(descriptor, base.advanced(by: written), buffer.count - written)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw AssistantError("临时配置文件写入未完成。") }
                written += count
            }
        }
        // Configure and flush the temporary inode before the atomic commit.
        // A chmod/fsync error must leave the original target untouched.
        guard Darwin.fchmod(descriptor, mode_t(mode)) == 0 else {
            throw AssistantError("无法设置临时配置文件权限：\(String(cString: strerror(errno)))")
        }
        while Darwin.fsync(descriptor) != 0 {
            if errno == EINTR { continue }
            throw AssistantError("无法保存临时配置文件：\(String(cString: strerror(errno)))")
        }
        try checkPlainPath(url)
        try requireRegularTarget()
        guard Darwin.rename(temporary.path, url.path) == 0 else {
            throw AssistantError("无法提交配置文件：\(String(cString: strerror(errno)))")
        }
        // No fallible operation after rename: callers may now track this as a
        // committed write, including when they later need to roll it back.
        committed = true
    }

    private func controller() -> URL? {
        let prefix = "mihomo-party-\(getuid())-"
        guard let candidates = try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: "/tmp"), includingPropertiesForKeys: [.contentModificationDateKey]) else { return nil }
        let sockets = candidates.filter { $0.lastPathComponent.hasPrefix(prefix) && $0.pathExtension == "sock" }
        for socket in sockets.sorted(by: { $0.lastPathComponent > $1.lastPathComponent }) {
            if (try? controllerGET(socket: socket, path: "/version")) != nil { return socket }
        }
        return nil
    }
    private func controllerGET(socket: URL, path: String) throws -> [String: Any] {
        guard ["/version", "/configs", "/proxies", "/rules"].contains(path) else {
            throw AssistantError("只允许读取网络状态。")
        }
        var arguments = ["--silent", "--show-error", "--fail", "--noproxy", "*", "--max-time", "2", "--unix-socket", socket.path]
        // A controller secret, when present, stays in stdin (not process argv or logs).
        var input: Data?
        if let current = try? Self.readYAML(clashRoot.appendingPathComponent("work/config.yaml")),
           let secret = current["secret"] as? String, !secret.isEmpty {
            guard !secret.contains(where: { $0.isNewline }) else { throw AssistantError("控制器凭据格式异常。") }
            let escaped = secret.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            input = Data("header = \"Authorization: Bearer \(escaped)\"\n".utf8)
            arguments += ["--config", "-"]
        }
        arguments += ["http://localhost" + path]
        return try Self.json(Self.run("/usr/bin/curl", arguments, input: input))
    }

    func liveDiagnosticEnvironment(browserExecutable: String? = nil) -> DiagnosticEnvironment {
        DiagnosticEnvironment(now: { ISO8601DateFormatter().string(from: Date()) },
            readJSON: { try Self.json(Data(contentsOf: $0)) }, readYAML: { try Self.readYAML($0) },
            portReady: Self.portReady, systemProxies: { SCDynamicStoreCopyProxies(nil) as? [String: Any] ?? [:] },
            edgePolicies: Self.edgePolicies, controller: { self.controller() },
            controllerGET: { try self.controllerGET(socket: $0, path: $1) },
            browserExecutable: browserExecutable ?? bundle.executableURL?.path)
    }

    func diagnose(_ settings: AssistantSettings, environment: DiagnosticEnvironment? = nil) -> HealthSnapshot {
        let environment = environment ?? liveDiagnosticEnvironment()
        var result = HealthSnapshot()
        result.checkedAt = environment.now()
        if let state = try? environment.readJSON(browserProfile.appendingPathComponent("Local State")) {
            result.chromeDoHOff = (state["dns_over_https"] as? [String: Any])?["mode"] as? String == "off"
        }
        if let preferences = try? environment.readJSON(browserProfile.appendingPathComponent("Default/Preferences")) {
            result.chromeWebRTCRestricted = (preferences["webrtc"] as? [String: Any])?["ip_handling_policy"] as? String == "disable_non_proxied_udp"
        }
        var liveProxies: [String: [String: Any]] = [:]
        var liveRules: [[String: Any]]?
        var mode: String?
        var yamlRules: [String] = []
        var policy: [String: Any] = [:]
        result.httpReady = environment.portReady(settings.httpPort)
        result.socksReady = environment.portReady(settings.socksPort)
        let proxy = environment.systemProxies()
        result.systemProxy = (proxy["HTTPEnable"] as? NSNumber)?.boolValue == true &&
            (proxy["HTTPSEnable"] as? NSNumber)?.boolValue == true &&
            proxy["HTTPProxy"] as? String == "127.0.0.1" && proxy["HTTPSProxy"] as? String == "127.0.0.1" &&
            (proxy["HTTPPort"] as? NSNumber)?.intValue == settings.httpPort && (proxy["HTTPSPort"] as? NSNumber)?.intValue == settings.httpPort
        if let json = try? environment.readJSON(claudeSettings), let env = json["env"] as? [String: Any] {
            let expected = "http://127.0.0.1:\(settings.httpPort)"
            result.browserIntegrated = environment.browserExecutable != nil && env["BROWSER"] as? String == environment.browserExecutable
            let bypassKeys = ["NO_PROXY", "no_proxy"]
            let bypasses = bypassKeys.map { env[$0] as? String ?? "" }
            let clean = try? Self.mergedNoProxy(existing: bypasses, additions: "")
            let cleanTokens = Set((clean ?? "").split(separator: ",").map { $0.lowercased() })
            let originalTokens = bypasses.joined(separator: ",").split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty }
            let safeBypasses = clean != nil && bypassKeys.allSatisfy { env[$0] == nil || env[$0] is String } && originalTokens.allSatisfy { cleanTokens.contains($0) }
            result.cliConfigured = safeBypasses && ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].allSatisfy { env[$0] as? String == expected }
        }
        result.edgePolicyCount = environment.edgePolicies().filter { $0.valid }.count
        if let current = try? environment.readYAML(clashRoot.appendingPathComponent("work/config.yaml")) {
            result.clashLocated = true
            mode = current["mode"] as? String
            policy = (current["dns"] as? [String: Any])?["nameserver-policy"] as? [String: Any] ?? [:]
            yamlRules = current["rules"] as? [String] ?? []
        } else { result.details.append("未读取到 Clash 运行配置；本机检查需可用的 /usr/bin/ruby 和标准 mihomo-party 数据目录。") }
        if let socket = environment.controller() {
            result.controllerConnected = true
            // Once the core is present its actual mode is authoritative; a
            // failed read cannot fall back to a potentially stale green YAML.
            mode = (try? environment.controllerGET(socket, "/configs"))?["mode"] as? String
            if let response = try? environment.controllerGET(socket, "/proxies"), let proxies = response["proxies"] as? [String: [String: Any]] {
                liveProxies = proxies
                result.proxyTypes = proxies.compactMapValues { $0["type"] as? String }
                result.nodeNames = result.proxyTypes.filter { GuardDeploymentPlan.isSupportedLeafType($0.value) }.keys.sorted()
                if let selected = proxies["PROXY"]?["now"] as? String { result.selectedNode = selected }
            }
            liveRules = (try? environment.controllerGET(socket, "/rules"))?["rules"] as? [[String: Any]]
        }
        let domains = Self.claudeDomains + Self.codexDomains
        let routing: ConfigurationAssessment.Result
        if result.controllerConnected {
            routing = ConfigurationAssessment.route(mode: mode, rules: liveRules ?? [], domains: domains, proxies: liveProxies)
        } else {
            routing = ConfigurationAssessment.routeFromYAML(mode: mode, rules: yamlRules, domains: domains, proxies: liveProxies)
        }
        let dns = ConfigurationAssessment.dns(policy: policy, domains: domains, proxies: liveProxies)
        result.routingVerified = routing.safe
        result.dnsVerified = result.clashLocated ? dns.safe : nil
        result.clashRules = routing.count
        result.dnsPolicies = dns.count
        result.directOption = CriticalDiagnostics.directReachability(targets: routing.targets, proxies: liveProxies)
        result.details += [routing.reason, dns.reason]
        result.summary = result.httpReady && result.systemProxy && result.cliConfigured && result.routingVerified == true && result.dnsVerified == true ? "配置证据已核对（实际请求未验证）" : "有项目需要配置或验证"
        result.details += ["检测只读，不重载 Clash，也不发送账号请求。", "端口可连仅说明本地服务存在；实际出口和模型请求仍需在使用时核对。", "Clash 规则：\(result.clashRules)/8；DNS 策略：\(result.dnsPolicies)/8；Edge 强制策略：\(result.edgePolicyCount)/4。"]
        return result
    }

    struct PolicyStatus {
        let key: String
        let forced: Bool
        let matches: Bool
        var valid: Bool { forced && matches }
    }
    static var expectedEdgePolicies: [String: Any] {
        ["ProxySettings": ["ProxyMode": "fixed_servers", "ProxyServer": "socks5://127.0.0.1:17890", "ProxyBypassList": "localhost;*.localhost;127.0.0.1;[::1]"], "DnsOverHttpsMode": "off", "WebRtcLocalhostIpHandling": "disable_non_proxied_udp", "NetworkPredictionOptions": 2]
    }
    static func assessEdgePolicies(values: [String: Any], forced: Set<String>) -> [PolicyStatus] {
        let expected = expectedEdgePolicies
        return expected.keys.sorted().map { key in
            PolicyStatus(key: key, forced: forced.contains(key),
                matches: values[key].map { NSDictionary(dictionary: ["v": $0]).isEqual(to: ["v": expected[key]!]) } ?? false)
        }
    }
    static func edgePolicies() -> [PolicyStatus] {
        var values: [String: Any] = [:]
        var forced: Set<String> = []
        for key in expectedEdgePolicies.keys {
            values[key] = CFPreferencesCopyAppValue(key as CFString, edgeDomain as CFString)
            if CFPreferencesAppValueIsForced(key as CFString, edgeDomain as CFString) { forced.insert(key) }
        }
        return assessEdgePolicies(values: values, forced: forced)
    }

    /// Pure plist generation; installation/opening is a separate UI action.
    static func edgeProfileData() throws -> Data {
        var policy: [String: Any] = ["PayloadType": edgeDomain, "PayloadVersion": 1,
            "PayloadIdentifier": "local.claude.edge-network.edge", "PayloadUUID": UUID().uuidString,
            "PayloadDisplayName": "Edge 专用代理及隐私设置"]
        policy.merge(expectedEdgePolicies) { _, new in new }
        let profile: [String: Any] = ["PayloadType": "Configuration", "PayloadVersion": 1,
            "PayloadIdentifier": "local.claude.edge-network", "PayloadUUID": UUID().uuidString,
            "PayloadDisplayName": "Claude 专用 Edge 网络设置", "PayloadScope": "User", "PayloadRemovalDisallowed": false,
            "PayloadDescription": "只管理当前用户的 Edge：通过 127.0.0.1:17890，保留回环直连。适用于专用 Edge 的所有资料，可在设备管理中移除。", "PayloadContent": [policy]]
        return try PropertyListSerialization.data(fromPropertyList: profile, format: .xml, options: 0)
    }
    func makeEdgeProfile() throws -> URL {
        let url = support.appendingPathComponent("Profiles/Claude 专用 Edge 网络设置.mobileconfig")
        try Self.safeWrite(Self.edgeProfileData(), to: url)
        return url
    }

    func plan(_ settings: AssistantSettings) throws -> String {
        try settings.validate()
        func quoted(_ text: String) -> String { String(data: try! JSONSerialization.data(withJSONObject: [text]), encoding: .utf8)!.dropFirst().dropLast().description }
        let domains = Self.claudeDomains + Self.codexDomains
        let rules = domains.map { "  - " + quoted("DOMAIN-SUFFIX,\($0),\(settings.node)") }.joined(separator: "\n")
        let dns = domains.map { "    \(quoted("+." + $0)): \(quoted("https://cloudflare-dns.com/dns-query#" + settings.node))" }.joined(separator: "\n")
        return """
        # Claude＋Codex 网络配置方案

        本方案仅生成文本，尚未写入或应用 Clash 配置。
        HTTP／混合端口：\(settings.httpPort)。专用 SOCKS：17890。节点：\(settings.node)。

        ## 执行约束
        保留自定义 DNS、原规则、内网例外和现有开发环境。不要复制其他电脑的节点口令。
        未获得用户针对本次具体操作的明确许可，不得退出、停止、重启 Clash Party 或在用 Mihomo。
        热加载也可能短暂停流；执行前说明影响并取得本次许可。不得失败后自动重启或清空连接。
        App 本身不会调用 Clash 的写接口，也不会应用本方案。

        ## 1. 在当前持久配置 rules 列表最前合并
        ```yaml
        rules:
        \(rules)
        ```
        保留其余规则；已有同域条目应检查并更新，避免重复。这里直接绑定节点，改变 PROXY 组选择不改变这些规则。

        ## 2. 在实际生效的自定义 DNS 中合并
        ```yaml
        dns:
          nameserver-policy:
        \(dns)
        ```
        保留全部原 nameserver、proxy-server-nameserver 与其他域名策略。
        Clash Party 应用级 DNS 覆写可能覆盖 profile；优先通过 DNS 设置界面合并并保存。
        不要只改生成的 work/config.yaml，不要在应用运行时外部改它缓存的 DNS 源来代替正常保存。

        ## 3. 合并专用浏览器 listener
        ```yaml
        listeners:
          - name: claude-browser-private
            type: socks
            listen: 127.0.0.1
            port: 17890
            proxy: \(quoted(settings.node))
            udp: false
        ```
        已有同名入口应核对，不能重复追加。端口被别的程序占用时先处理冲突，不停止未知进程。
        本版浏览器、Edge 描述文件及桌面登录辅助程序使用固定17890；更换需同步修改源码并重新构建。

        ## 4. Claude Code 与登录
        在助手“Claude Code”页面备份并合并用户 settings.json；四代理变量采用实际混合端口。
        NO_PROXY 保留必要内网精确主机/IP，移除全匹配 * 和 Claude/OpenAI 域名。CIDR 支持因运行库而异。
        Codex 使用系统代理；不把 shell_environment_policy.set 误当成 Codex 本体代理，不向所有开发子进程注入全局代理。
        Edge 描述文件由用户在系统设置确认安装。它影响当前用户的 Edge 全部资料，不能覆盖冲突的组织策略。
        Claude 桌面重新登录时先开专用登录入口，结束后恢复原默认浏览器。账号授权由用户本人完成。

        ## 5. 验收与回滚
        先备份具体修改点，用 Mihomo -t 在隔离目录校验；确认后只走已查清不会自动重启的热载路径。
        核对持久源→生成配置→运行核心一致，真实新连接经目标节点而非DIRECT；不为刷新显示关闭旧连接。
        在专用浏览器完成 DNS、WebRTC 和本地回调测试；检查内网、Git、npm 等原业务。
        规则模式、系统代理开启是本方案的使用前提。HTTP 401/404、端口可连不等于真实模型请求成功。
        回滚只恢复本次字段；不要整文件覆盖后续修改。回滚如需热载或停止核心，重新取得当次许可。
        """
    }

    private func requirePrivateBrowserClosed() throws {
        let fm = FileManager.default
        let lock = browserProfile.appendingPathComponent("SingletonLock")
        if let target = try? fm.destinationOfSymbolicLink(atPath: lock.path),
           let value = target.split(separator: "-").last, let pid = Int32(value), kill(pid, 0) == 0 || errno == EPERM {
            throw AssistantError("Claude 专用 Chrome 仍在运行。请退出该专用资料的实例后重试；助手不会关闭浏览器。")
        }
    }

    func applyClaudeCode(_ settings: AssistantSettings) throws -> URL {
        try settings.validate()
        try requirePrivateBrowserClosed()
        let fm = FileManager.default
        guard let executable = bundle.executableURL else { throw AssistantError("无法确定助手程序路径。") }
        var root: [String: Any] = [:]
        if fm.fileExists(atPath: claudeSettings.path) { root = try Self.json(Data(contentsOf: claudeSettings)) }
        if let existing = root["env"], !(existing is [String: Any]) { throw AssistantError("Claude env 字段不是对象，已停止修改。") }
        var env = root["env"] as? [String: Any] ?? [:]
        let bypass = try Self.mergedNoProxy(existing: [env["NO_PROXY"] as? String ?? "", env["no_proxy"] as? String ?? ""], additions: settings.internalExceptions)
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] { env[key] = "http://127.0.0.1:\(settings.httpPort)" }
        env["NO_PROXY"] = bypass; env["no_proxy"] = bypass; env["BROWSER"] = executable.path
        root["env"] = env
        return try install([(claudeSettings, try Self.encode(root), 0o600),
                            (support.appendingPathComponent("preferences.json"), try JSONEncoder().encode(settings), 0o600)] + privateBrowserWrites())
    }

    func preparePrivateBrowser() throws -> URL {
        try requirePrivateBrowserClosed()
        return try install(privateBrowserWrites())
    }

    private func privateBrowserWrites() throws -> [(URL, Data, Int)] {
        let fm = FileManager.default
        let localState = browserProfile.appendingPathComponent("Local State")
        let preferences = browserProfile.appendingPathComponent("Default/Preferences")
        var state = fm.fileExists(atPath: localState.path) ? try Self.json(Data(contentsOf: localState)) : [:]
        var doh = state["dns_over_https"] as? [String: Any] ?? [:]; doh["mode"] = "off"; state["dns_over_https"] = doh
        var prefs = fm.fileExists(atPath: preferences.path) ? try Self.json(Data(contentsOf: preferences)) : [:]
        var rtc = prefs["webrtc"] as? [String: Any] ?? [:]; rtc["ip_handling_policy"] = "disable_non_proxied_udp"; prefs["webrtc"] = rtc
        var profile = prefs["profile"] as? [String: Any] ?? [:]; profile["name"] = "Claude 专用"; prefs["profile"] = profile
        return [(localState, try Self.encode(state), 0o600),
                (preferences, try Self.encode(prefs), 0o600)]
    }

    static func privateBrowserArguments(rawURL: String, profile: URL) throws -> [String] {
        guard !rawURL.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let url = URL(string: rawURL), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else {
            throw AssistantError("仅接受有效的 HTTP/HTTPS 登录地址。")
        }
        return ["-na", "/Applications/Google Chrome.app", "--args",
                "--user-data-dir=" + profile.path,
                "--proxy-server=socks5://127.0.0.1:17890",
                "--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE *.localhost",
                "--webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--no-first-run", "--no-default-browser-check", rawURL]
    }

    func launchPrivateBrowser(rawURL: String) throws {
        let arguments = try Self.privateBrowserArguments(rawURL: rawURL, profile: browserProfile)
        guard FileManager.default.fileExists(atPath: "/Applications/Google Chrome.app") else {
            throw AssistantError("请先安装 Google Chrome。")
        }
        guard FileManager.default.fileExists(atPath: browserProfile.appendingPathComponent("Default/Preferences").path) else {
            throw AssistantError("请先在助手的 Claude Code 页面配置专用浏览器资料。")
        }
        guard Self.portReady(17890) else { throw AssistantError("专用代理 127.0.0.1:17890 不可用，已停止打开；不会回退直连。") }
        _ = try Self.run("/usr/bin/open", arguments)
    }

    /// A durable journal is published before changing any target. Every recovery
    /// verifies all originals and all current targets before its first write.
    private var backupRoot: URL { support.appendingPathComponent("Backups", isDirectory: true) }

    static func checkPlainPath(_ url: URL) throws {
        var cursor = url
        while cursor.path != "/" {
            // Inspect only the entry type. Foundation's full attributes also
            // query extended attributes, which can request Documents access.
            var entry = stat()
            if Darwin.lstat(cursor.path, &entry) == 0,
               entry.st_mode & mode_t(S_IFMT) == mode_t(S_IFLNK) {
                throw AssistantError("目标路径包含符号链接，已停止：\(cursor.lastPathComponent)")
            }
            cursor.deleteLastPathComponent()
        }
    }
    private func regularAttributes(_ url: URL) throws -> [FileAttributeKey: Any]? {
        try Self.checkPlainPath(url)
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else {
                throw AssistantError("目标不是普通文件：\(url.lastPathComponent)")
            }
            return attributes
        } catch let error as NSError where error.domain == NSCocoaErrorDomain &&
            [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) {
            return nil
        }
    }
    private func withBackupLock<T>(_ operation: () throws -> T) throws -> T {
        if let stateLock { return try stateLock.withLock { try withJournalLock(operation) } }
        return try withJournalLock(operation)
    }
    private func withJournalLock<T>(_ operation: () throws -> T) throws -> T {
        guard isInsideHome(backupRoot) else { throw AssistantError("备份路径不在当前用户目录内。") }
        try Self.checkPlainPath(backupRoot)
        try FileManager.default.createDirectory(at: backupRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = backupRoot.appendingPathComponent(".transaction.lock")
        let descriptor = Darwin.open(lock.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw AssistantError("无法获取配置事务锁。") }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              fchmod(descriptor, 0o600) == 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            throw AssistantError("另一个配置或恢复操作正在进行，或事务锁不可用。")
        }
        return try operation()
    }
    private func saveManifest(_ manifest: BackupManifest, in directory: URL) throws {
        try Self.safeWrite(try JSONEncoder().encode(manifest), to: directory.appendingPathComponent("manifest.json"))
    }
    private func readManifest(_ directory: URL, strictBounds: Bool = false) throws -> BackupManifest {
        guard Self.canonicalPath(directory.deletingLastPathComponent()) == Self.canonicalPath(backupRoot) else {
            throw AssistantError("备份目录不属于本助手。")
        }
        try Self.checkPlainPath(directory)
        let url = directory.appendingPathComponent("manifest.json")
        guard try regularAttributes(url) != nil else { throw AssistantError("没有找到备份清单。") }
        let data: Data
        if strictBounds {
            guard let file = try RelayRecoveryInspector.read(url, limit: 1048576) else { throw AssistantError("清单不可读取。") }
            data = file.data
        } else { data = try Data(contentsOf: url) }
        let manifest = try JSONDecoder().decode(BackupManifest.self, from: data)
        guard [1, 2].contains(manifest.version), !manifest.entries.isEmpty,
              Set(manifest.entries.map { Self.canonicalPath(URL(fileURLWithPath: $0.path)) }).count == manifest.entries.count,
              manifest.entries.allSatisfy({ (0...0o777).contains($0.originalMode) && ($0.installedMode.map { (0...0o777).contains($0) } ?? true) }) else {
            throw AssistantError("备份版本不受支持、清单重复/为空或权限记录无效。")
        }
        if manifest.version == 2 {
            guard let phase = manifest.phase,
                  ["prepared", "committed", "recoveryNeeded", "restoring", "rolledBack", "restored"].contains(phase) else {
                throw AssistantError("备份事务状态无效。")
            }
        }
        return manifest
    }
    private func backupOrder(_ directory: URL, _ manifest: BackupManifest) -> UInt64 {
        if let order = manifest.order { return order }
        let date = (try? FileManager.default.attributesOfItem(atPath: directory.path)[.creationDate]) as? Date
        return UInt64(max(0, (date?.timeIntervalSince1970 ?? 0) * 1_000_000_000))
    }
    private func allocateOrder() throws -> UInt64 {
        let counter = backupRoot.appendingPathComponent(".order.json")
        let stored: UInt64
        if try regularAttributes(counter) != nil {
            stored = try JSONDecoder().decode(UInt64.self, from: Data(contentsOf: counter))
        } else { stored = 0 }
        let directories = (try? FileManager.default.contentsOfDirectory(at: backupRoot, includingPropertiesForKeys: nil)) ?? []
        let last = directories.compactMap { url -> UInt64? in
            guard let manifest = try? readManifest(url) else { return nil }
            return backupOrder(url, manifest)
        }.max() ?? 0
        let clock = UInt64(max(0, Date().timeIntervalSince1970 * 1_000_000_000))
        guard max(stored, last) < UInt64.max else { throw AssistantError("备份顺序计数已超出范围。") }
        let order = max(clock, max(stored, last) + 1)
        try Self.safeWrite(try JSONEncoder().encode(order), to: counter)
        return order
    }
    private enum TargetState { case original, installed, changed }
    private func targetState(_ entry: BackupEntry, strictBounds: Bool = false) throws -> TargetState {
        let url = URL(fileURLWithPath: entry.path)
        guard isInsideHome(url) else { throw AssistantError("备份目标不在当前用户目录内。") }
        guard let attributes = try regularAttributes(url) else {
            return entry.originalExists ? .changed : .original
        }
        let data: Data
        let mode: Int
        if strictBounds {
            guard let file = try RelayRecoveryInspector.read(url) else { throw AssistantError("目标在核对期间改变。") }
            data = file.data; mode = file.mode
        } else {
            data = try Data(contentsOf: url)
            mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
        }
        let digest = Self.digest(data)
        if entry.originalExists && digest == entry.originalDigest && mode == entry.originalMode { return .original }
        if digest == entry.installedDigest && (entry.installedMode == nil || mode == entry.installedMode) { return .installed }
        return .changed
    }
    private func originalData(_ entry: BackupEntry, index: Int, directory: URL, allowLegacy: Bool = false, strictBounds: Bool = false) throws -> Data? {
        guard entry.backupName == "original-\(index).bin", isInsideHome(URL(fileURLWithPath: entry.path)) else {
            throw AssistantError("备份文件名或目标路径异常。")
        }
        guard entry.originalExists else {
            guard entry.originalDigest == nil else { throw AssistantError("备份原文件状态无效。") }
            return nil
        }
        let original = directory.appendingPathComponent(entry.backupName)
        guard try regularAttributes(original) != nil else { throw AssistantError("原始备份缺失，未执行恢复。") }
        let data: Data
        if strictBounds {
            guard let file = try RelayRecoveryInspector.read(original) else { throw AssistantError("原始备份在核对期间改变。") }
            data = file.data
        } else { data = try Data(contentsOf: original) }
        if let digest = entry.originalDigest {
            guard Self.digest(data) == digest else { throw AssistantError("原始备份摘要不匹配，可能已损坏；未执行恢复。") }
        } else if !allowLegacy { throw AssistantError("旧版备份没有原文件摘要，需先人工核对并单独确认。") }
        return data
    }
    private func restoreEntry(_ entry: BackupEntry, data: Data?, strictBounds: Bool = false) throws {
        let url = URL(fileURLWithPath: entry.path)
        let state = try targetState(entry, strictBounds: strictBounds)
        guard state != .changed else { throw AssistantError("配置已有后续更改：\(url.lastPathComponent)。未覆盖该文件。") }
        guard state != .original else { return }
        if let data { try Self.safeWrite(data, to: url, mode: entry.originalMode) }
        else { try FileManager.default.removeItem(at: url) }
    }

    func install(_ writes: [(URL, Data, Int)], strictBounds: Bool = false,
                 lockedPreflight: (([(URL, Data?, Int)]) throws -> Void)? = nil,
                 beforeInstallEntry: ((Int) throws -> Void)? = nil,
                 beforeRollbackEntry: ((Int) throws -> Void)? = nil) throws -> URL {
        try withBackupLock {
            let fm = FileManager.default
            guard !writes.isEmpty, Set(writes.map { Self.canonicalPath($0.0) }).count == writes.count else {
                throw AssistantError("配置目标为空或重复。")
            }
            // Preflight every target, including assistant preferences, before any
            // target is written. Backups and their journal are separate data.
            var captured: [(URL, Data?, Int)] = []
            for (url, _, mode) in writes {
                guard isInsideHome(url), (0...0o777).contains(mode) else { throw AssistantError("配置目标路径或权限无效。") }
                let attributes = try regularAttributes(url)
                if strictBounds {
                    let file = try RelayRecoveryInspector.read(url)
                    captured.append((url, file?.data, file?.mode ?? 0o600))
                } else {
                    let original = try attributes.map { _ in try Data(contentsOf: url) }
                    captured.append((url, original, (attributes?[.posixPermissions] as? NSNumber)?.intValue ?? 0o600))
                }
            }
            try lockedPreflight?(captured)
            let order = try allocateOrder()
            let directory = backupRoot.appendingPathComponent(String(order) + "-" + UUID().uuidString, isDirectory: true)
            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var entries: [BackupEntry] = []
            for (index, write) in writes.enumerated() {
                let original = captured[index].1
                let name = "original-\(index).bin"
                if let original { try Self.safeWrite(original, to: directory.appendingPathComponent(name)) }
                var entry = BackupEntry(path: write.0.path, originalExists: original != nil, originalMode: captured[index].2,
                    backupName: name, installedDigest: Self.digest(write.1), originalDigest: original.map(Self.digest), installedMode: write.2)
                // Keep the exact values we installed, not the entire user JSON.
                // Automatic uninstall can then restore only still-owned keys
                // while preserving unrelated settings added after this write.
                if write.0.path == claudeSettings.path,
                   let object = try? Self.json(write.1), let environment = object["env"] as? [String: Any],
                   Self.claudeEnvironmentKeys.allSatisfy({ environment[$0] is String }) {
                    entry.installedEnvironment = Dictionary(uniqueKeysWithValues: Self.claudeEnvironmentKeys.map { ($0, environment[$0] as! String) })
                }
                entries.append(entry)
            }
            var manifest = BackupManifest(version: 2, createdAt: ISO8601DateFormatter().string(from: Date()), entries: entries, phase: "prepared", order: order)
            try saveManifest(manifest, in: directory)
            var committedIndices: [Int] = []
            do {
                for (index, write) in writes.enumerated() {
                    try beforeInstallEntry?(index)
                    guard try targetState(entries[index], strictBounds: strictBounds) == .original else {
                        throw AssistantError("配置在备份后被修改，已停止覆盖。")
                    }
                    try Self.safeWrite(write.1, to: write.0, mode: write.2)
                    committedIndices.append(index)
                }
                manifest.phase = "committed"
                try saveManifest(manifest, in: directory)
            } catch {
                // safeWrite cannot throw after its atomic commit. Do not roll
                // back targets this transaction never wrote: they might have
                // been created or changed by another process after preflight.
                var rollbackComplete = true
                for index in committedIndices.reversed() {
                    do {
                        try beforeRollbackEntry?(index)
                        try restoreEntry(entries[index], data: captured[index].1, strictBounds: strictBounds)
                    }
                    catch { rollbackComplete = false }
                }
                manifest.phase = rollbackComplete ? "rolledBack" : "recoveryNeeded"
                try? saveManifest(manifest, in: directory)
                let message = rollbackComplete ? "本次写入已撤销。" : "部分写入尚需恢复，备份已保留；请处理后重试恢复。"
                throw AssistantError("配置未完成，" + message + "备份：\(directory.path)")
            }
            return directory
        }
    }

    func latestBackup() -> URL? {
        let directories = (try? FileManager.default.contentsOfDirectory(at: backupRoot, includingPropertiesForKeys: nil)) ?? []
        let candidates = directories.compactMap { url -> (URL, UInt64)? in
            guard !FileManager.default.fileExists(atPath: url.appendingPathComponent("restored.txt").path),
                  let manifest = try? readManifest(url),
                  manifest.version == 1 || ["committed", "prepared", "recoveryNeeded", "restoring"].contains(manifest.phase ?? "") else { return nil }
            return (url, backupOrder(url, manifest))
        }
        return candidates.max { $0.1 < $1.1 }?.0
    }
    /// Metadata only. Never creates a lock/directory, upgrades a journal or reads
    /// original/current target contents. Restore must run its full preflight.
    func backupMetadata() -> BackupMetadataInventory {
        let source = support.lastPathComponent == "AI Network Assistant" ? "legacy" : "relay"
        do {
            try Self.checkPlainPath(backupRoot)
            let items: [URL]
            do {
                guard try FileManager.default.attributesOfItem(atPath: backupRoot.path)[.type] as? FileAttributeType == .typeDirectory else { throw AssistantError("备份根目录不可读取。") }
                items = try FileManager.default.contentsOfDirectory(at: backupRoot, includingPropertiesForKeys: nil).filter { !$0.lastPathComponent.hasPrefix(".") }.sorted { $0.lastPathComponent > $1.lastPathComponent }
            }
            catch let error as NSError where error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) {
                return BackupMetadataInventory(source: source, availability: "missing", complete: true, entries: [])
            }
            var complete = items.count <= 64
            var records: [(BackupMetadata, UInt64)] = []
            for directory in items.prefix(64) {
                do {
                    let manifestURL = directory.appendingPathComponent("manifest.json")
                    guard let attributes = try regularAttributes(manifestURL),
                          let size = attributes[.size] as? NSNumber, size.intValue <= 1048576 else { throw AssistantError("清单不可读取。") }
                    let manifest = try readManifest(directory)
                    records.append((BackupMetadata(id: directory.lastPathComponent, createdAt: manifest.createdAt,
                        version: manifest.version, phase: manifest.version == 1 ? "legacy" : manifest.phase ?? "unreadable", targetCount: manifest.entries.count), backupOrder(directory, manifest)))
                } catch {
                    complete = false
                    records.append((BackupMetadata(id: directory.lastPathComponent, createdAt: "", version: 0, phase: "unreadable", targetCount: 0), UInt64.max))
                }
            }
            return BackupMetadataInventory(source: source, availability: "readable", complete: complete,
                entries: records.sorted { $0.1 > $1.1 }.map { $0.0 })
        } catch { return BackupMetadataInventory(source: source, availability: "unreadable", complete: false, entries: []) }
    }
    func backupRequiresLegacyConfirmation(_ directory: URL) throws -> Bool { try readManifest(directory).version == 1 }
    func backupRecoveryPending(_ directory: URL) -> Bool {
        guard let manifest = try? readManifest(directory) else { return false }
        return manifest.version == 2 && manifest.phase != "committed"
    }
    func restore(_ directory: URL, allowLegacy: Bool = false,
                 lockedPreflight: ((BackupManifest, [Data?]) throws -> Void)? = nil,
                 beforeRestoreEntry: ((Int) throws -> Void)? = nil) throws {
        if lockedPreflight == nil { try requirePrivateBrowserClosed() }
        try withBackupLock {
            let strictBounds = lockedPreflight != nil
            var manifest = try readManifest(directory, strictBounds: strictBounds)
            guard manifest.phase != "rolledBack" else { throw AssistantError("此事务已回滚，无需恢复。") }
            if manifest.version == 1 && !allowLegacy { throw AssistantError("旧版备份没有原文件摘要，需人工核对后单独确认。") }
            // Validate every original before changing even the first target.
            let originals = try manifest.entries.enumerated().map {
                try originalData($0.element, index: $0.offset, directory: directory, allowLegacy: manifest.version == 1 && allowLegacy, strictBounds: strictBounds)
            }
            try lockedPreflight?(manifest, originals)
            if manifest.version == 1 {
                let entries = manifest.entries.enumerated().map { index, entry in
                    BackupEntry(path: entry.path, originalExists: entry.originalExists, originalMode: entry.originalMode,
                        backupName: entry.backupName, installedDigest: entry.installedDigest,
                        originalDigest: originals[index].map(Self.digest), installedMode: nil)
                }
                manifest = BackupManifest(version: 2, createdAt: manifest.createdAt, entries: entries, phase: "restoring", order: backupOrder(directory, manifest))
            }
            for entry in manifest.entries {
                guard try targetState(entry, strictBounds: strictBounds) != .changed else {
                    throw AssistantError("配置已有后续更改：\(URL(fileURLWithPath: entry.path).lastPathComponent)。为保留新配置，未执行恢复。")
                }
            }
            manifest.phase = "restoring"
            try saveManifest(manifest, in: directory)
            do {
                for index in manifest.entries.indices.reversed() {
                    try beforeRestoreEntry?(index)
                    try restoreEntry(manifest.entries[index], data: originals[index], strictBounds: strictBounds)
                }
                manifest.phase = "restored"
                try saveManifest(manifest, in: directory)
            } catch {
                // Existing restored originals are recognized on retry; any real
                // later user edit still fails the complete preflight.
                manifest.phase = "recoveryNeeded"
                try? saveManifest(manifest, in: directory)
                throw AssistantError("恢复未完成，已保留进度和备份；处理原因后可重试。\(error.localizedDescription)")
            }
        }
    }
}
