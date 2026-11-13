import Foundation

func runDiagnosticsRegressionTests() -> Int32 {
    var count = 0
    var failures: [String] = []
    func check(_ value: Bool, _ name: String) { count += 1; if !value { failures.append(name) } }
    let domains = NetworkConfiguration.claudeDomains + NetworkConfiguration.codexDomains
    let leaf: [String: [String: Any]] = ["node": ["type": "Shadowsocks"]]
    let rules: [[String: Any]] = domains.map { ["type": "DomainSuffix", "payload": $0, "proxy": "node"] }
    func route(_ mode: String?, _ input: [[String: Any]], _ proxies: [String: [String: Any]] = leaf) -> ConfigurationAssessment.Result {
        ConfigurationAssessment.route(mode: mode, rules: input, domains: domains, proxies: proxies)
    }
    check(route("rule", rules).safe == true && route("rule", rules).count == 8, "baseline ordered routes")
    check(route("direct", rules).safe == false, "direct mode cannot be green")
    check(route("global", rules).safe == false, "global mode cannot be green")
    check(route(nil, rules).safe == nil, "missing mode remains unknown")
    check(route("rule", [["type": "Match", "payload": "", "proxy": "DIRECT"]] + rules).safe == false, "earlier MATCH DIRECT")
    check(route("rule", [["type": "DomainSuffix", "payload": "com", "proxy": "DIRECT"]] + rules).safe == false, "earlier parent suffix DIRECT")
    check(route("rule", [["type": "Domain", "payload": "api.anthropic.com", "proxy": "DIRECT"]] + rules).safe == false, "earlier subdomain DIRECT")
    check(route("rule", [["type": "Domain", "payload": "git.corp", "proxy": "DIRECT"]] + rules).safe == true, "disjoint exact domain can be skipped")
    check(route("rule", [["type": "IPCIDR", "payload": "10.0.0.0/8", "proxy": "DIRECT"]] + rules).safe == nil, "unknown prior IP condition")
    check(route("rule", [["type": "DomainKeyword", "payload": "ads", "proxy": "DIRECT"]] + rules).safe == nil, "unknown subdomain keyword")
    check(route("rule", rules.map { ["type": "DomainSuffix", "payload": $0["payload"]!, "proxy": "REJECT-DROP"] }).safe == false, "reject-drop is not proxy")
    check(route("rule", rules.map { ["type": "DomainSuffix", "payload": $0["payload"]!, "proxy": "PASS"] }).safe == false, "pass is not proxy")
    check(route("rule", rules, [:]).safe == nil, "unread target metadata")
    check(ConfigurationAssessment.proxyTarget("socks", proxies: ["socks": ["type": "Socks5"]]) == true, "SOCKS5 node type retains number")
    check(ConfigurationAssessment.proxyTarget("hy2", proxies: ["hy2": ["type": "Hysteria2"]]) == true, "Hysteria2 node type retains number")
    var graph = leaf
    graph["group"] = ["type": "Selector", "all": ["node", "DIRECT"]]
    check(ConfigurationAssessment.proxyTarget("group", proxies: graph) == false, "group direct branch")
    graph["blocked"] = ["type": "RejectDrop"]
    check(ConfigurationAssessment.proxyTarget("blocked", proxies: graph) == false, "custom named reject node")
    graph["cycle"] = ["type": "Selector", "all": ["cycle"]]
    check(ConfigurationAssessment.proxyTarget("cycle", proxies: graph) == nil, "proxy cycle remains unknown")
    let yamlRules = domains.map { "DOMAIN-SUFFIX,\($0),node" }
    check(ConfigurationAssessment.routeFromYAML(mode: "rule", rules: yamlRules, domains: domains, proxies: leaf).safe == true, "YAML route normalization")
    check(ConfigurationAssessment.routeFromYAML(mode: "rule", rules: ["MATCH,DIRECT"] + yamlRules, domains: domains, proxies: leaf).safe == false, "YAML prior MATCH")

    let valid = Dictionary(uniqueKeysWithValues: domains.map { ("+." + $0, "https://cloudflare-dns.com/dns-query#node" as Any) })
    func dns(_ policy: [String: Any], _ proxies: [String: [String: Any]] = leaf) -> ConfigurationAssessment.Result {
        ConfigurationAssessment.dns(policy: policy, domains: domains, proxies: proxies)
    }
    check(dns(valid).safe == true && dns(valid).count == 8, "all DNS candidates verified")
    var policy = valid
    policy["+.anthropic.com"] = "https://cloudflare-dns.com/dns-query#"
    check(dns(policy).safe == false, "empty DNS target")
    policy["+.anthropic.com"] = ["https://cloudflare-dns.com/dns-query#node", "https://dns.example/dns-query"]
    check(dns(policy).safe == false, "mixed proxied and unqualified DNS")
    policy["+.anthropic.com"] = ["https://cloudflare-dns.com/dns-query#node", "https://dns.example/dns-query#DIRECT"]
    check(dns(policy).safe == false, "mixed direct DNS")
    policy["+.anthropic.com"] = "https://cloudflare-dns.com/dns-query#REJECT-DROP"
    check(dns(policy).safe == false, "DNS reject-drop target")
    policy["+.anthropic.com"] = "https://cloudflare-dns.com/dns-query#DIRECT&h3=true"
    check(dns(policy).safe == false, "direct DNS plus options")
    policy["+.anthropic.com"] = "https://cloudflare-dns.com/dns-query#missing"
    check(dns(policy).safe == nil, "unknown DNS target")
    policy["+.anthropic.com"] = "https://cloudflare-dns.com/dns-query#group"
    check(dns(policy, graph).safe == false, "DNS target group has direct branch")
    policy["+.anthropic.com"] = "https://bad host/dns-query#node"
    check(dns(policy).safe == false, "invalid DNS host")
    policy["+.anthropic.com"] = "https://dns.example:99999/dns-query#node"
    check(dns(policy).safe == false, "invalid DNS port")
    check(dns(valid, [:]).safe == nil, "unread DNS proxy graph")
    policy["+.anthropic.com"] = [] as [String]
    check(dns(policy).safe == false, "empty DNS list")
    policy["+.anthropic.com"] = "https://cloudflare-dns.com/dns-query#node&unknown=value"
    check(dns(policy).safe == nil, "unverified DNS options stay pending")

    do {
        let merged = try ConfigurationAssessment.mergedNoProxy(existing: [".com,.ai,*.com,*:443,*:*,api.anthropic.com:443,.openai.com,*.claude.ai,0.0.0.0/0,::/0,0:0:0:0:0:0:0:0/00"], additions: ".corp.local,10.0.0.0/8,10.1.2.3,git.company.local:8443,[::1]:1234", domains: domains)
        let values = Set(merged.split(separator: ",").map(String.init))
        check(!values.contains(".com") && !values.contains(".ai") && !values.contains("*.com"), "public parent suffixes removed")
        check(!values.contains("*:443") && !values.contains("*:*") && !values.contains("0.0.0.0/0") && !values.contains("::/0") && !values.contains("0:0:0:0:0:0:0:0/00"), "all-match forms removed")
        check(!values.contains("api.anthropic.com:443") && !values.contains(".openai.com") && !values.contains("*.claude.ai"), "AI host and subdomain bypass removed")
        check(values.contains(".corp.local") && values.contains("10.0.0.0/8") && values.contains("10.1.2.3") && values.contains("git.company.local:8443") && values.contains("[::1]:1234"), "internal hosts IP CIDR and loopback preserved")
        let dedup = try ConfigurationAssessment.mergedNoProxy(existing: ["GIT.CORP,git.corp"], additions: "", domains: domains)
        check(dedup.split(separator: ",").filter { $0.lowercased() == "git.corp" }.count == 1, "case-insensitive dedup")
    } catch { failures.append("NO_PROXY regression fixture: " + error.localizedDescription) }
    do {
        _ = try ConfigurationAssessment.mergedNoProxy(existing: ["\nhost.corp"], additions: "", domains: domains)
        check(false, "leading newline rejected")
    } catch { check(true, "leading newline rejected") }
    print(failures.isEmpty ? "PASS: \(count) diagnostic regression checks; no network or settings accessed." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
