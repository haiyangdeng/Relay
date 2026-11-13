import Foundation
import Darwin

/// Pure decisions shared by the app's offline tests and the system extension.
/// No sockets, DNS lookups, preference writes, timers or proxy switching.
struct ClaudeGuardPolicy {
    static let extensionID = "local.ai.network-assistant.guard"
    static let httpPort = 17891
    static let socksPort = 17890
    static let teamID = "Q6L2SF6YDW"
    static let signingID = "com.anthropic.claudefordesktop"
    enum Subject { case claude, unverifiedClaude, other, unresolved }
    enum Verdict: String { case allow, drop }
    struct Flow {
        let subject: Subject
        var outbound = true
        var tcp = true
        var host: String?
        var port: Int?
    }
    let proxyPorts: Set<Int>
    init(proxyPorts: Set<Int> = [17891, 17890]) {
        // Bad configuration must never introduce a public/direct exception.
        self.proxyPorts = Set(proxyPorts.filter { (1...65535).contains($0) })
    }
    static func isClaude(identifier: String, team: String) -> Bool {
        team == teamID && (identifier == signingID || identifier.hasPrefix(signingID + "."))
    }
    static func isProxyLoopback(_ raw: String) -> Bool {
        var v4 = in_addr()
        if inet_pton(AF_INET, raw, &v4) == 1 { return v4.s_addr == inet_addr("127.0.0.1") }
        var v6 = in6_addr()
        guard inet_pton(AF_INET6, raw, &v6) == 1 else { return false }
        let bytes = withUnsafeBytes(of: &v6) { Array($0) }
        return bytes == Array(repeating: 0, count: 15) + [1]
            || bytes == Array(repeating: 0, count: 10) + [255, 255, 127, 0, 0, 1]
    }
    func decide(_ flow: Flow) -> Verdict {
        // Do not alter other apps or inbound local OAuth callbacks.
        guard flow.outbound else { return .allow }
        switch flow.subject {
        case .other, .unresolved: return .allow
        case .unverifiedClaude: return .drop
        case .claude:
            guard flow.tcp, let host = flow.host, let port = flow.port,
                  Self.isProxyLoopback(host), proxyPorts.contains(port) else { return .drop }
            return .allow
        }
    }
}

struct GuardSimulation: Codable {
    let name: String
    let expected: String
    let actual: String
    var passed: Bool { expected == actual }
    static func run(httpPort: Int = ClaudeGuardPolicy.httpPort) -> [GuardSimulation] {
        let policy = ClaudeGuardPolicy(proxyPorts: [httpPort, 17890])
        var rows: [GuardSimulation] = []
        func test(_ name: String, _ flow: ClaudeGuardPolicy.Flow, _ expected: ClaudeGuardPolicy.Verdict) {
            rows.append(GuardSimulation(name: name, expected: expected.rawValue, actual: policy.decide(flow).rawValue))
        }
        test("Claude → 本机 HTTP 代理", .init(subject: .claude, host: "127.0.0.1", port: httpPort), .allow)
        test("Claude → 本机 SOCKS 代理", .init(subject: .claude, host: "::1", port: 17890), .allow)
        test("节点超时后尝试 IPv4 直连", .init(subject: .claude, host: "1.1.1.1", port: 443), .drop)
        test("Clash 退出后尝试 IPv6 直连", .init(subject: .claude, host: "2606:4700::1111", port: 443), .drop)
        test("Claude → 公网 QUIC / UDP", .init(subject: .claude, tcp: false, host: "1.1.1.1", port: 443), .drop)
        test("Claude → 内网直连", .init(subject: .claude, host: "192.168.1.2", port: 443), .drop)
        test("Claude → 未批准的本机端口", .init(subject: .claude, host: "127.0.0.1", port: 1080), .drop)
        test("本机 OAuth 入站回调", .init(subject: .claude, outbound: false, host: "127.0.0.1", port: 17991), .allow)
        test("Git / npm 等其他程序", .init(subject: .other, host: "192.168.1.2", port: 443), .allow)
        test("Claude 身份校验失败", .init(subject: .unverifiedClaude, host: "127.0.0.1", port: httpPort), .drop)
        return rows
    }
}

func runGuardSelfTests() -> Int32 {
    var failures: [String] = []
    var count = 0
    func check(_ value: Bool, _ name: String) { count += 1; if !value { failures.append(name) } }
    for row in GuardSimulation.run() { check(row.passed, row.name) }
    check(ClaudeGuardPolicy.isClaude(identifier: ClaudeGuardPolicy.signingID, team: ClaudeGuardPolicy.teamID), "main identity")
    check(ClaudeGuardPolicy.isClaude(identifier: ClaudeGuardPolicy.signingID + ".helper", team: ClaudeGuardPolicy.teamID), "helper identity")
    check(!ClaudeGuardPolicy.isClaude(identifier: ClaudeGuardPolicy.signingID + "-impostor", team: ClaudeGuardPolicy.teamID), "prefix boundary")
    check(!ClaudeGuardPolicy.isClaude(identifier: ClaudeGuardPolicy.signingID, team: "OTHERTEAM"), "team identity")
    let policy = ClaudeGuardPolicy()
    for host in ["127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"] {
        check(policy.decide(.init(subject: .claude, host: host, port: 17891)) == .allow, "loopback " + host)
    }
    for host in ["127.0.0.2", "127.1", "localhost", "127.0.0.1.example.com", "0.0.0.0", "::", "::ffff:8.8.8.8", "fe80::1", "10.0.0.1"] {
        check(policy.decide(.init(subject: .claude, host: host, port: 17891)) == .drop, "reject " + host)
    }
    check(policy.decide(.init(subject: .claude, host: nil, port: nil)) == .drop, "missing endpoint")
    check(policy.decide(.init(subject: .claude, tcp: false, host: "127.0.0.1", port: 17891)) == .drop, "local UDP")
    let custom = ClaudeGuardPolicy(proxyPorts: [8888])
    check(custom.decide(.init(subject: .claude, host: "127.0.0.1", port: 8888)) == .allow, "custom proxy port")
    check(custom.decide(.init(subject: .claude, host: "127.0.0.1", port: 7890)) == .drop, "old proxy not allowed")
    let invalid = ClaudeGuardPolicy(proxyPorts: [0, -1, 65536])
    check(invalid.proxyPorts.isEmpty && invalid.decide(.init(subject: .claude, host: "127.0.0.1", port: 17891)) == .drop, "invalid configuration stays restrictive")
    check(policy.decide(.init(subject: .other, tcp: false, host: nil, port: nil)) == .allow, "other apps unaffected")
    // Unattributed traffic cannot safely be blocked globally. This is a runtime
    // coverage limitation, never evidence that the flow was protected.
    check(policy.decide(.init(subject: .unresolved, host: "1.1.1.1", port: 443)) == .allow, "unresolved traffic does not block all apps")
    print(failures.isEmpty ? "PASS: \(count) offline guard checks; no network or system settings accessed." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
