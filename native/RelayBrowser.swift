import Foundation
import Darwin
import Security

enum RelayBrowserContract {
    static let namespace = "Relay-Preview"
    static let socksPort = 18190
    static let wrapperIdentifier = "local.relay.browser"
    static let chrome = URL(fileURLWithPath: "/Applications/Google Chrome.app", isDirectory: true)
    static func context(home: URL) -> RelayStateContext {
        RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/" + namespace).path)
    }
    static func profile(_ store: RelayPreferenceStore) -> URL { store.root.appendingPathComponent("Private Browser", isDirectory: true) }
    static func arguments(_ rawURL: String, profile: URL, httpPort: Int = 18193) throws -> [String] {
        guard rawURL.utf8.count <= 32768, rawURL == rawURL.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: rawURL), url.port.map({ (1...65535).contains($0) }) ?? true else {
            throw AssistantError("登录地址无效。")
        }
        guard (1024...65535).contains(httpPort) else { throw AssistantError("专用 HTTP 端口无效。") }
        return Array(try NetworkConfiguration.privateBrowserArguments(rawURL: rawURL, profile: profile).dropFirst(3)).map {
            $0.hasPrefix("--proxy-server=") ? "--proxy-server=http://127.0.0.1:\(httpPort)" : $0
        }
    }
    static func policyReady(_ profile: URL) throws -> Bool {
        guard let local = try RelayRecoveryInspector.read(profile.appendingPathComponent("Local State")),
              let preferences = try RelayRecoveryInspector.read(profile.appendingPathComponent("Default/Preferences")) else { return false }
        let state = try NetworkConfiguration.json(local.data), prefs = try NetworkConfiguration.json(preferences.data)
        return (state["dns_over_https"] as? [String: Any])?["mode"] as? String == "off" &&
            (prefs["webrtc"] as? [String: Any])?["ip_handling_policy"] as? String == "disable_non_proxied_udp"
    }
    static func wrapperURL() throws -> URL {
        let resources = try RelayBrowserBindingClient.resources()
        let wrapper = resources.appendingPathComponent("RelayBrowser.app", isDirectory: true)
        guard let bundle = Bundle(url: wrapper), bundle.bundleIdentifier == wrapperIdentifier,
              bundle.object(forInfoDictionaryKey: "CFBundleExecutable") as? String == "RelayBrowser",
              let entries = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]],
              Set(entries.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }) == ["http", "https"],
              let executable = bundle.executableURL,
              FileManager.default.isExecutableFile(atPath: executable.path),
              let target = try RelayRecoveryInspector.read(executable, limit: 33554432, allowRootOwner: true),
              target.mode & 0o022 == 0 else {
            throw AssistantError("Relay 专用浏览器 URL 入口未安装或资源不匹配。")
        }
        var code: SecStaticCode?, requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(wrapper as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(("identifier \"" + wrapperIdentifier + "\"") as CFString, [], &requirement) == errSecSuccess,
              let requirement, SecStaticCodeCheckValidity(code, .noNetworkAccess, requirement) == errSecSuccess else {
            throw AssistantError("Relay 专用浏览器签名未确认。")
        }
        return wrapper
    }
    static func policyAllowed(read: (String) -> Any? = { CFPreferencesCopyAppValue($0 as CFString, "com.google.Chrome" as CFString) }) -> Bool {
        // Profile preferences and command-line routing do not isolate browser
        // management policies. Refuse policy overrides rather than guessing.
        ["ProxySettings", "ProxyMode", "ProxyServer", "ProxyPacUrl", "ProxyBypassList",
         "DnsOverHttpsMode", "DnsOverHttpsTemplates", "WebRtcIPHandling", "WebRtcIPHandlingUrl",
         "WebRtcLocalIpsAllowedUrls"].allSatisfy { read($0) == nil }
    }
    static func realHome() throws -> URL {
        guard let record = getpwuid(getuid()), let value = record.pointee.pw_dir else { throw AssistantError("用户目录不可确认。") }
        return URL(fileURLWithPath: String(cString: value), isDirectory: true)
    }
}
struct RelayBrowserEnvironment {
    var installed: () -> Bool
    var binding: () throws -> RelayBrowserBinding
    var policyAllowed: () -> Bool
    var process: (URL) -> String
    var reusable: (URL, Int) -> Bool = { _, _ in false }
    var spawn: ([String]) throws -> Void
    static var live: Self {
        Self(installed: { Bundle(url: RelayBrowserContract.chrome)?.bundleIdentifier == "com.google.Chrome" &&
            FileManager.default.isExecutableFile(atPath: RelayBrowserContract.chrome.appendingPathComponent("Contents/MacOS/Google Chrome").path) },
            binding: { try RelayBrowserLauncher.requireOwnedBinding(home: RelayBrowserContract.realHome()) },
            policyAllowed: { RelayBrowserContract.policyAllowed() },
            process: { RelayBrowserProcesses.status($0) },
            reusable: { RelayBrowserProcesses.reusable($0, httpPort: $1) },
            spawn: { arguments in
                let child = Process()
                child.executableURL = RelayBrowserContract.chrome.appendingPathComponent("Contents/MacOS/Google Chrome")
                child.arguments = arguments
                child.standardInput = FileHandle.nullDevice; child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
                try child.run()
            })
    }
}
enum RelayBrowserLauncher {
    static func requireOwnedBinding(home: URL) throws -> RelayBrowserBinding { try RelayBrowserBindingClient.read(home: home) }
    static func launchLock(_ root: URL) -> RelayStateLock { RelayStateLock(root: root.appendingPathComponent("Browser Launch", isDirectory: true)) }
    static func inspectReadiness(home: URL, environment: RelayBrowserEnvironment = .live) throws -> Bool {
        let store = try RelayPreferenceStore(RelayBrowserContract.context(home: home))
        let profile = RelayBrowserContract.profile(store)
        try NetworkConfiguration.checkPlainPath(profile)
        // Inspect existing JSON if present; a new profile is prepared only by
        // an explicit launch under the shared browser-write lock.
        for name in ["Local State", "Default/Preferences"] {
            if let file = try RelayRecoveryInspector.read(profile.appendingPathComponent(name)) { _ = try NetworkConfiguration.json(file.data) }
        }
        guard environment.installed(), environment.policyAllowed() else { return false }
        let state = environment.process(profile)
        if state == "closed" { return true }
        guard state == "running", let binding = try? environment.binding(),
              (try? binding.validate()) != nil, try RelayBrowserContract.policyReady(profile) else { return false }
        return environment.reusable(profile, binding.httpPort)
    }
    private static func prepareProfile(_ profile: URL) throws {
        func object(_ root: [String: Any], _ key: String) throws -> [String: Any] {
            guard root[key] == nil || root[key] is [String: Any] else { throw AssistantError("专用浏览器偏好格式异常。") }
            return root[key] as? [String: Any] ?? [:]
        }
        let local = profile.appendingPathComponent("Local State"), preferences = profile.appendingPathComponent("Default/Preferences")
        var state = try RelayRecoveryInspector.read(local).map { try NetworkConfiguration.json($0.data) } ?? [:]
        var prefs = try RelayRecoveryInspector.read(preferences).map { try NetworkConfiguration.json($0.data) } ?? [:]
        var doh = try object(state, "dns_over_https"), rtc = try object(prefs, "webrtc")
        doh["mode"] = "off"; state["dns_over_https"] = doh
        rtc["ip_handling_policy"] = "disable_non_proxied_udp"; prefs["webrtc"] = rtc
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(state), to: local)
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(prefs), to: preferences)
    }
    static func launch(_ rawURL: String, home: URL, environment: RelayBrowserEnvironment = .live) throws {
        _ = try RelayBrowserContract.arguments(rawURL, profile: URL(fileURLWithPath: "/unused"))
        let binding = try environment.binding(); try binding.validate()
        let store = try RelayPreferenceStore(RelayBrowserContract.context(home: home))
        let profile = RelayBrowserContract.profile(store)
        guard environment.installed(), environment.policyAllowed() else { throw AssistantError("专用 Chrome 或策略未就绪。") }
        try launchLock(store.root).withLock {
            let state = environment.process(profile), closed = state == "closed"
            guard (closed || (state == "running" && environment.reusable(profile, binding.httpPort))), environment.policyAllowed(), try environment.binding() == binding else {
                throw AssistantError("专用浏览器或 Relay 代理归属已改变。")
            }
            if closed { try prepareProfile(profile) }
            guard try environment.binding() == binding,
                  (closed ? environment.process(profile) == "closed" : (environment.process(profile) == "running" && environment.reusable(profile, binding.httpPort))),
                  environment.policyAllowed(), try RelayBrowserContract.policyReady(profile) else {
                throw AssistantError("专用浏览器启动前检查未通过。")
            }
            try environment.spawn(RelayBrowserContract.arguments(rawURL, profile: profile, httpPort: binding.httpPort))
        }
    }
}
