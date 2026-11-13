import Foundation

/// Conservative, offline assessment of configuration evidence. Unknown rules or
/// proxy metadata never become a positive routing/DNS result.
enum ConfigurationAssessment {
    struct Result {
        let safe: Bool?
        let count: Int
        let targets: [String]
        let reason: String
    }
    private static let unusableTargets: Set<String> = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"]
    private static let nodeTypes: Set<String> = ["shadowsocks", "shadowsocksr", "snell", "socks5", "http", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "wireguard", "ssh", "anytls", "mieru"]
    private static func normalized(_ value: String) -> String { value.lowercased().filter { $0.isLetter || $0.isNumber } }
    static func isProxyTarget(_ target: String) -> Bool {
        !target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !unusableTargets.contains(target.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())
    }

    /// A selection graph is safe only if every reachable branch is a known
    /// proxy node. Reject/Pass are not successful proxy paths either.
    static func proxyTarget(_ target: String, proxies: [String: [String: Any]]) -> Bool? {
        var memo: [String: Bool] = [:]
        func visit(_ name: String, path: Set<String>) -> Bool? {
            guard isProxyTarget(name) else { return false }
            if let value = memo[name] { return value }
            guard path.count < 64, !path.contains(name), let entry = proxies[name],
                  let kind = entry["type"] as? String else { return nil }
            let type = normalized(kind)
            if ["direct", "reject", "rejectdrop", "pass", "compatible"].contains(type) { return false }
            if let members = entry["all"] as? [String] {
                guard !members.isEmpty else { return nil }
                var unknown = false
                for member in members {
                    let result = visit(member, path: path.union([name]))
                    if result == false { memo[name] = false; return false }
                    if result == nil { unknown = true }
                }
                if unknown { return nil }
                memo[name] = true
                return true
            }
            guard nodeTypes.contains(type) else { return nil }
            memo[name] = true
            return true
        }
        return visit(target, path: [])
    }

    static func routeFromYAML(mode: String?, rules: [String], domains: [String], proxies: [String: [String: Any]]) -> Result {
        let parsed: [[String: Any]] = rules.map { rule in
            let parts = rule.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            guard let kind = parts.first else { return [:] }
            if normalized(kind) == "match", parts.count == 2 { return ["type": kind, "payload": "", "proxy": parts[1]] }
            // Complex rule syntax is deliberately not reconstructed by splitting
            // commas: the evaluator will keep it unverified.
            guard parts.count == 3 else { return ["type": "unparsed"] }
            return ["type": kind, "payload": parts[1], "proxy": parts[2]]
        }
        return route(mode: mode, rules: parsed, domains: domains, proxies: proxies)
    }

    static func route(mode: String?, rules: [[String: Any]], domains: [String], proxies: [String: [String: Any]]) -> Result {
        guard let mode else { return Result(safe: nil, count: 0, targets: [], reason: "未读取生效模式") }
        guard mode.lowercased() == "rule" else {
            return Result(safe: false, count: 0, targets: [], reason: "当前不是规则模式：" + mode)
        }
        guard !domains.isEmpty, !rules.isEmpty else { return Result(safe: nil, count: 0, targets: [], reason: "缺少域名或规则证据") }
        var covered = 0
        var allTargets: [String] = []
        var uncertain = false
        var unsafe = false
        for rawDomain in domains {
            let domain = rawDomain.lowercased()
            var complete = false
            var domainUnknown = false
            var domainUnsafe = false
            for rule in rules {
                guard let kind = rule["type"] as? String,
                      let target = rule["proxy"] as? String else { domainUnknown = true; break }
                let payload = (rule["payload"] as? String ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
                let type = normalized(kind)
                var overlap = false
                var coversFamily = false
                switch type {
                case "match": overlap = true; coversFamily = true
                case "domainsuffix":
                    guard !payload.isEmpty else { domainUnknown = true; break }
                    coversFamily = domain == payload || domain.hasSuffix("." + payload)
                    overlap = coversFamily || payload.hasSuffix("." + domain)
                case "domain":
                    // An exact subdomain rule can affect part of the family;
                    // keep checking the remaining family after a safe branch.
                    overlap = domain == payload || payload.hasSuffix("." + domain)
                case "domainkeyword":
                    // Keywords may match unknown subdomains. Without a concrete
                    // requested hostname they cannot safely be ruled out.
                    domainUnknown = true
                default:
                    // IP, process, provider, logical and other conditional rules
                    // require runtime evidence. Never skip them to find a later
                    // reassuring DOMAIN-SUFFIX entry.
                    domainUnknown = true
                }
                if domainUnknown { break }
                if !overlap { continue }
                if !allTargets.contains(target) { allTargets.append(target) }
                let valid = proxyTarget(target, proxies: proxies)
                if valid == false { domainUnsafe = true; break }
                if valid == nil { domainUnknown = true; break }
                if coversFamily { complete = true; break }
            }
            if domainUnsafe { unsafe = true }
            if complete && !domainUnsafe && !domainUnknown { covered += 1 }
            else if !domainUnsafe { uncertain = true }
        }
        let safe: Bool? = unsafe ? false : uncertain ? nil : true
        return Result(safe: safe, count: covered, targets: allTargets,
                      reason: unsafe ? "域名路径包含直连、阻断或非代理分支" : uncertain ? "前置规则或目标类型无法离线确认" : "规则模式与已覆盖域名路径已核对")
    }

    static func dns(policy: [String: Any], domains: [String], proxies: [String: [String: Any]]) -> Result {
        guard !domains.isEmpty else { return Result(safe: nil, count: 0, targets: [], reason: "缺少域名证据") }
        var count = 0
        var targets: [String] = []
        var unknown = false
        var invalid = false
        for domain in domains {
            let raw = policy["+." + domain]
            let values: [String]
            if let string = raw as? String { values = [string] }
            else if let strings = raw as? [String], !strings.isEmpty { values = strings }
            else { invalid = true; continue }
            var domainValid = true
            var domainUnknown = false
            for value in values {
                guard !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                      let url = URLComponents(string: value), url.scheme?.lowercased() == "https",
                      let host = url.host, !host.isEmpty, !host.contains(where: \.isWhitespace), url.url != nil,
                      url.port.map({ (1...65535).contains($0) }) ?? true, url.user == nil, url.password == nil,
                      let fragment = url.fragment, !fragment.isEmpty else { domainValid = false; break }
                // Combined fragment options have semantics not checked here.
                // Keep them pending rather than treating one valid-looking part
                // as proof of a dedicated proxy path.
                if fragment.contains("&") {
                    let first = fragment.components(separatedBy: "&")[0]
                    if !isProxyTarget(first) { domainValid = false; break }
                    domainUnknown = true
                    continue
                }
                guard isProxyTarget(fragment) else { domainValid = false; break }
                if !targets.contains(fragment) { targets.append(fragment) }
                let valid = proxyTarget(fragment, proxies: proxies)
                if valid == false { domainValid = false; break }
                if valid == nil { domainUnknown = true }
            }
            if !domainValid { invalid = true }
            else if domainUnknown { unknown = true }
            else { count += 1 }
        }
        return Result(safe: invalid ? false : unknown ? nil : true, count: count, targets: targets,
                      reason: invalid ? "DNS候选存在缺失代理目标、未代理或非代理分支" : unknown ? "DNS目标或参数无法离线确认" : "全部DNS候选的专用代理路径已核对")
    }

    static func mergedNoProxy(existing: [String], additions: String, domains: [String]) throws -> String {
        var items = ["localhost", ".localhost", "127.0.0.1", "::1", "[::1]", ".local"]
        for raw in (existing + [additions]).joined(separator: ",").split(separator: ",") {
            guard !raw.contains(where: \.isNewline) else { throw AssistantError("直连例外不可包含换行。") }
            let value = raw.trimmingCharacters(in: .whitespaces)
            if value.isEmpty { continue }
            guard !value.contains(where: \.isWhitespace) else { throw AssistantError("直连例外只能填写逗号分隔的主机名或 IP，不可包含空格或换行。") }
            let lower = value.lowercased()
            let cidr = lower.split(separator: "/", omittingEmptySubsequences: false)
            if cidr.count == 2, Int(cidr[1]) == 0 { continue }
            var host = lower
            if !host.contains("/") && !host.contains("[") && host.filter({ $0 == ":" }).count == 1 {
                host = host.components(separatedBy: ":")[0]
            }
            host = host.trimmingCharacters(in: CharacterSet(charactersIn: ".*"))
            // Covers bare *, *:443, *:*, dots and unsupported wildcard forms.
            if host.isEmpty || host.contains("*") { continue }
            let bypassesAI = domains.contains { ai in
                host == ai || host.hasSuffix("." + ai) || ai.hasSuffix("." + host)
            }
            if bypassesAI { continue }
            if !items.contains(where: { $0.lowercased() == lower }) { items.append(value) }
        }
        return items.joined(separator: ",")
    }
}
