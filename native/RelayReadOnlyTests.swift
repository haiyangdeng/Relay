import Foundation

func runRelayReadOnlySelfTests() -> Int32 {
    var failures: [String] = []
    var count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    do {
        let data = try NetworkConfiguration.edgeProfileData()
        let profile = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] ?? [:]
        let policy = (profile["PayloadContent"] as? [[String: Any]])?.first ?? [:]
        let proxy = policy["ProxySettings"] as? [String: Any] ?? [:]
        check(profile["PayloadScope"] as? String == "User", "user scope")
        check(profile["PayloadRemovalDisallowed"] as? Bool == false, "removable")
        check((profile["PayloadContent"] as? [Any])?.count == 1 && policy["PayloadType"] as? String == "com.microsoft.Edge", "only Edge payload")
        check(profile["PayloadIdentifier"] as? String == "local.claude.edge-network", "existing profile identity preserved")
        check(proxy["ProxyMode"] as? String == "fixed_servers" && proxy["ProxyServer"] as? String == "socks5://127.0.0.1:17890", "fixed local SOCKS")
        check(proxy["ProxyBypassList"] as? String == "localhost;*.localhost;127.0.0.1;[::1]", "loopback callback exceptions")
        check(policy["DnsOverHttpsMode"] as? String == "off", "DoH off")
        check(policy["WebRtcLocalhostIpHandling"] as? String == "disable_non_proxied_udp", "UDP restriction")
        check(policy["NetworkPredictionOptions"] as? Int == 2, "prediction disabled")
        let another = try PropertyListSerialization.propertyList(from: NetworkConfiguration.edgeProfileData(), options: [], format: nil) as? [String: Any] ?? [:]
        check(profile["PayloadUUID"] as? String != another["PayloadUUID"] as? String, "fresh payload UUID")
        let expected = NetworkConfiguration.expectedEdgePolicies
        check(NetworkConfiguration.assessEdgePolicies(values: expected, forced: Set(expected.keys)).allSatisfy { $0.valid }, "all forced values checked")
        check(NetworkConfiguration.assessEdgePolicies(values: expected, forced: []).allSatisfy { !$0.valid && $0.matches }, "unforced values never green")
        var wrong = expected
        wrong["ProxySettings"] = ["ProxyMode": "direct"]
        check(NetworkConfiguration.assessEdgePolicies(values: wrong, forced: Set(expected.keys)).filter { $0.valid }.count == 3, "conflicting proxy policy")
        check(NetworkConfiguration.assessEdgePolicies(values: [:], forced: Set(expected.keys)).allSatisfy { !$0.valid }, "missing managed values")

        let backend = NetworkConfiguration(home: URL(fileURLWithPath: "/relay-read-only-fixture", isDirectory: true),
            diagnosticPaths: (URL(fileURLWithPath: "/fixture/clash"), URL(fileURLWithPath: "/fixture/browser")))
        let domains = NetworkConfiguration.claudeDomains + NetworkConfiguration.codexDomains
        let rules: [[String: Any]] = domains.map { ["type": "DomainSuffix", "payload": $0, "proxy": "fixture-node"] }
        let yaml: [String: Any] = ["mode": "rule", "rules": domains.map { "DOMAIN-SUFFIX,\($0),fixture-node" },
            "dns": ["nameserver-policy": Dictionary(uniqueKeysWithValues: domains.map { ("+." + $0, "https://cloudflare-dns.com/dns-query#fixture-node") })]]
        var env: [String: Any] = ["NO_PROXY": "localhost", "BROWSER": "/fixture/RelayBrowser", "TOKEN": "SECRET_NEVER_IN_REPORT"]
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] { env[key] = "http://127.0.0.1:7890" }
        var ports: [Int] = []
        var controllerPaths: [String] = []
        var policyReads = 0
        let environment = DiagnosticEnvironment(now: { "2026-10-23T08:00:00Z" }, readJSON: { url in
            switch url.lastPathComponent {
            case "settings.json": return ["env": env]
            case "Local State": return ["dns_over_https": ["mode": "off"]]
            case "Preferences": return ["webrtc": ["ip_handling_policy": "disable_non_proxied_udp"]]
            default: throw AssistantError("fixture missing")
            }
        }, readYAML: { _ in yaml }, portReady: { ports.append($0); return true },
            systemProxies: { ["HTTPEnable": 1, "HTTPSEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPSProxy": "127.0.0.1", "HTTPPort": 7890, "HTTPSPort": 7890] },
            edgePolicies: { policyReads += 1; return NetworkConfiguration.assessEdgePolicies(values: expected, forced: Set(expected.keys)) },
            controller: { URL(fileURLWithPath: "/fixture/controller.sock") }, controllerGET: { _, path in
                controllerPaths.append(path)
                switch path {
                case "/configs": return ["mode": "rule"]
                case "/proxies": return ["proxies": ["fixture-node": ["type": "Shadowsocks"], "group": ["type": "Selector", "all": ["fixture-node", "DIRECT"]]]]
                case "/rules": return ["rules": rules]
                default: throw AssistantError("unexpected endpoint")
                }
            }, browserExecutable: "/fixture/RelayBrowser")
        var settings = AssistantSettings()
        settings.node = "fixture-node"
        let report = RelayReadOnly.report(backend: backend, settings: settings, environment: environment, timezone: "Asia/Taipei", preferredLanguages: ["en-US", "zh-Hans"])
        check(ports == [7890, 17890], "only local configured port observations")
        check(controllerPaths == ["/configs", "/proxies", "/rules"], "only read endpoints")
        check(policyReads == 1, "single forced-policy observation")
        check(report.snapshot.cliConfigured && report.snapshot.systemProxy && report.snapshot.browserIntegrated, "client evidence")
        check(report.snapshot.routingVerified == true && report.snapshot.clashRules == 8 && report.snapshot.directOption == false, "ordered routes")
        check(report.snapshot.dnsVerified == true && report.snapshot.dnsPolicies == 8, "all DNS families")
        check(report.snapshot.nodeNames == ["fixture-node"], "groups cannot become leaf candidates")
        check(report.checks.count == 11 && report.checks.prefix(5).allSatisfy { $0.state == .verifiedConfiguration }, "configuration rows")
        check(report.checks.suffix(6).allSatisfy { $0.state == .pending } && !report.guardEnabled && report.readOnly, "runtime evidence remains pending")
        check(report.timezone == "Asia/Taipei" && report.preferredLanguages.first == "en-US", "environment reference")
        let encoded = try RelayReadOnly.encode(report)
        check(!encoded.contains("SECRET_NEVER_IN_REPORT") && !encoded.contains("HTTP_PROXY"), "raw credentials not returned")
        let override = RelayReadOnly.report(backend: backend, settings: settings, environment: environment,
            timezone: "Asia/Taipei", preferredLanguages: ["en-US"], policyReviewKeys: ["WebRtcIPHandlingUrl"])
        check(override.edgePolicyReviewKeys == ["WebRtcIPHandlingUrl"] && override.checks.first { $0.id == "browser-config" }?.state == .attention,
            "extra policy cannot leave browser configuration green")
        var failedMode = environment
        failedMode.controllerGET = { socket, path in
            if path == "/configs" { throw AssistantError("fixture read failure") }
            return try environment.controllerGET(socket, path)
        }
        let unknown = backend.diagnose(settings, environment: failedMode)
        check(unknown.routingVerified == nil, "failed core mode cannot use stale YAML green")
        var missing = environment
        missing.readJSON = { _ in throw AssistantError("fixture missing") }
        missing.readYAML = { _ in throw AssistantError("fixture missing") }
        missing.controller = { nil }
        let unavailable = backend.diagnose(settings, environment: missing)
        check(!unavailable.cliConfigured && unavailable.chromeDoHOff == nil && unavailable.dnsVerified == nil, "missing files not successful evidence")
        check(CriticalDiagnostics.rows(unavailable).first { $0.id == "dns-policy" }?.state == .pending, "missing DNS stays pending")
        var noBrowser = environment; noBrowser.browserExecutable = nil
        check(!backend.diagnose(settings, environment: noBrowser).browserIntegrated, "missing browser entry not integrated")
        var unforced = environment
        unforced.edgePolicies = { NetworkConfiguration.assessEdgePolicies(values: expected, forced: []) }
        let needsPolicy = RelayReadOnly.report(backend: backend, settings: settings, environment: unforced, timezone: "UTC", preferredLanguages: ["en"])
        check(needsPolicy.checks.first { $0.id == "browser-config" }?.state == .attention && needsPolicy.snapshot.summary.contains("有待检查"), "summary cannot hide unforced browser policy")
    } catch {
        failures.append("unexpected fixture failure")
    }
    print(failures.isEmpty ? "PASS: \(count) Relay read-only/profile checks; all OS/files/controller observations replaced with fixtures." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
