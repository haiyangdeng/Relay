import Foundation

struct CriticalCheck: Codable {
    enum State: String, Codable { case verifiedConfiguration, attention, pending }
    let id: String
    let title: String
    let state: State
    let value: String
    let evidence: String
    let nextStep: String
}

/// Keeps observed local configuration separate from evidence requiring real
/// browser/client traffic. No external requests or system mutations.
enum CriticalDiagnostics {
    static func rows(_ h: HealthSnapshot) -> [CriticalCheck] {
        let hasSnapshot = !h.checkedAt.isEmpty
        func config(_ good: Bool) -> CriticalCheck.State { !hasSnapshot ? .pending : good ? .verifiedConfiguration : .attention }
        let routingState: CriticalCheck.State = !hasSnapshot ? .pending : h.routingVerified == false || h.directOption == true ? .attention : h.routingVerified == true && h.directOption == false ? .verifiedConfiguration : .pending
        let dnsState: CriticalCheck.State = !hasSnapshot || !h.clashLocated ? .pending : h.dnsVerified == false ? .attention : h.dnsVerified == true ? .verifiedConfiguration : .pending
        var rows: [CriticalCheck] = [
            .init(id: "ports", title: "本地代理入口", state: config(h.httpReady && h.socksReady),
                  value: hasSnapshot ? "HTTP：\(h.httpReady ? "可连接" : "未连接")；专用 SOCKS：\(h.socksReady ? "可连接" : "未连接")" : "尚未检测",
                  evidence: "本机端口连通性。不能证明远端节点或模型可用。", nextStep: "实际节点超时需后续隔离测试，不关闭当前 VPN。"),
            .init(id: "clients", title: "Claude 桌面 / Code 代理配置", state: config(h.systemProxy && h.cliConfigured),
                  value: hasSnapshot ? "桌面系统代理：\(h.systemProxy ? "匹配" : "未匹配")；Code 四变量：\(h.cliConfigured ? "匹配" : "未匹配")" : "尚未检测",
                  evidence: "读取系统代理与用户级 Code 设置，不代表客户端当前进程已经加载。", nextStep: "桌面、Code 与浏览器应分别核对真实请求路径。"),
            .init(id: "routing", title: "Claude 路由与直连分支", state: routingState,
                  value: routingValue(h), evidence: "已核对规则模式、可确定的前置顺序和代理成员图；未知条件保持待验证，未检查实际请求命中。select 中包含 DIRECT 不等于超时会自动切换。",
                  nextStep: "专用路径使用固定节点；不要把含 DIRECT 的共享组当成禁止直连保护。"),
            .init(id: "dns-policy", title: "Claude / Codex 专用 DNS 策略", state: dnsState,
                  value: !hasSnapshot || !h.clashLocated ? "未读取运行 DNS 配置" : "全部候选已核对的域名 \(h.dnsPolicies)/8", evidence: "逐一核对运行配置的全部DNS候选和非空代理目标；未知目标保持待验证，不代表 DNS 泄漏测试通过。",
                  nextStep: "保留原业务 DNS；真实解析出口另行检测。"),
            .init(id: "browser-config", title: "专用浏览器 DNS / WebRTC 限制", state: !hasSnapshot ? .pending : h.edgePolicyCount == 4 && h.chromeDoHOff == true && h.chromeWebRTCRestricted == true ? .verifiedConfiguration : .attention,
                  value: hasSnapshot ? "Edge 强制策略 \(h.edgePolicyCount)/4；Chrome DoH：\(flag(h.chromeDoHOff))；WebRTC：\(flag(h.chromeWebRTCRestricted))" : "尚未检测",
                  evidence: "Edge 强制策略与专用 Chrome 资料设置。只适用于对应浏览器，不证明桌面客户端已受保护。",
                  nextStep: "在真正用于登录的专用窗口中测 DNS / WebRTC，不能用普通浏览器结果代替。")
        ]
        let runtime: [(String, String, String, String)] = [
            ("egress", "实际出口 IP / 地区 / ASN", "未实测", "核对 Claude、登录浏览器出口是否符合预期；ASN / 机房属性仅作来源信息，不计算封号概率。"),
            ("dns-exit", "DNS 实际解析出口", "未实测", "需要浏览器解析探针及解析服务器数据；仅有策略字段不能判定无泄漏。"),
            ("webrtc", "WebRTC 公网 IP 暴露", "未实测", "需要目标专用浏览器采集 ICE 候选；宿主 App 或其他浏览器结果不能替代。"),
            ("callback", "登录本机回调", "未实测", "需要临时本机服务与实际登录窗口验证；不会自动重新登录或读取凭据。"),
            ("request", "Claude 实际请求 / 延迟", "未实测", "网页连通、401/404或端口可连不等于模型请求成功；由真实客户端请求及连接记录核对。"),
            ("guard", "节点失效时禁止直连", "未确认启用 / 未验收", "扩展源码与离线模拟已提供。需要正式签名、系统授权和隔离断线测试，不能把组件存在当成保护生效。")
        ]
        rows += runtime.map { .init(id: $0.0, title: $0.1, state: .pending, value: $0.2,
                                    evidence: "需要运行时证据；未发送任何外部检测请求。", nextStep: $0.3) }
        return rows
    }
    private static func flag(_ value: Bool?) -> String { value.map { $0 ? "已配置" : "未匹配" } ?? "未读取" }
    private static func routingValue(_ h: HealthSnapshot) -> String {
        guard !h.checkedAt.isEmpty else { return "尚未检测" }
        let branch = h.directOption.map { $0 ? "存在 DIRECT 分支" : "成员图中未发现 DIRECT" } ?? "直连分支未确认"
        return "已核对域名路径 \(h.clashRules)/8；" + branch
    }

    /// nil means incomplete/ambiguous graph, never an all-clear result.
    static func directReachability(targets: [String], proxies: [String: [String: Any]]) -> Bool? {
        guard !targets.isEmpty else { return nil }
        var memo: [String: Bool] = [:]
        func visit(_ name: String, _ path: Set<String>) -> Bool? {
            if let cached = memo[name] { return cached }
            if name == "DIRECT" { return true }
            if name == "REJECT" || name == "REJECT-DROP" { return false }
            guard path.count < 64, !path.contains(name), let entry = proxies[name], let kind = entry["type"] as? String else { return nil }
            if kind.lowercased() == "direct" { return true }
            if let members = entry["all"] as? [String] {
                guard !members.isEmpty else { return nil }
                var unknown = false
                for member in members {
                    let result = visit(member, path.union([name]))
                    if result == true { memo[name] = true; return true }
                    if result == nil { unknown = true }
                }
                if !unknown { memo[name] = false }
                return unknown ? nil : false
            }
            if ["selector", "urltest", "fallback", "loadbalance", "relay", "compatible", "pass"].contains(kind.lowercased()) { return nil }
            let knownNodes = ["shadowsocks", "shadowsocksr", "snell", "socks5", "http", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "wireguard", "ssh", "anytls", "mieru", "reject", "rejectdrop"]
            guard knownNodes.contains(kind.lowercased()) else { return nil }
            memo[name] = false
            return false
        }
        var unknown = false
        for target in targets {
            let result = visit(target, [])
            if result == true { return true }
            if result == nil { unknown = true }
        }
        return unknown ? nil : false
    }
}

func runCriticalCheckSelfTests() -> Int32 {
    var checks = 0
    var failures: [String] = []
    func check(_ value: Bool, _ name: String) { checks += 1; if !value { failures.append(name) } }
    let leaf: [String: [String: Any]] = ["node": ["type": "Shadowsocks"]]
    check(CriticalDiagnostics.directReachability(targets: ["node"], proxies: leaf) == false, "fixed node")
    check(CriticalDiagnostics.directReachability(targets: ["DIRECT"], proxies: [:]) == true, "direct target")
    var graph = leaf
    graph["group"] = ["type": "Selector", "all": ["node", "DIRECT"]]
    graph["nested"] = ["type": "Fallback", "all": ["group"]]
    check(CriticalDiagnostics.directReachability(targets: ["nested"], proxies: graph) == true, "nested direct")
    graph["group"] = ["type": "Selector", "all": ["node"]]
    check(CriticalDiagnostics.directReachability(targets: ["nested"], proxies: graph) == false, "nested proxy only")
    check(CriticalDiagnostics.directReachability(targets: ["missing"], proxies: graph) == nil, "missing graph")
    graph["unknown-type"] = ["type": "UnrecognizedProvider"]
    check(CriticalDiagnostics.directReachability(targets: ["unknown-type"], proxies: graph) == nil, "unknown provider cannot be green")
    graph["cycle"] = ["type": "Selector", "all": ["cycle"]]
    check(CriticalDiagnostics.directReachability(targets: ["cycle"], proxies: graph) == nil, "cycle")
    graph["cycle"] = ["type": "Selector", "all": ["cycle", "DIRECT"]]
    check(CriticalDiagnostics.directReachability(targets: ["cycle"], proxies: graph) == true, "cycle cannot hide direct")
    check(CriticalDiagnostics.rows(HealthSnapshot()).allSatisfy { $0.state == .pending }, "unobserved cannot be green")
    var snapshot = HealthSnapshot.preview
    snapshot.directOption = true
    let rows = CriticalDiagnostics.rows(snapshot)
    check(rows.count == 11 && Set(rows.map(\.id)).count == 11, "curated stable rows")
    check(rows.first { $0.id == "routing" }?.state == .attention, "direct option warning")
    check(rows.filter { ["egress", "dns-exit", "webrtc", "callback", "request", "guard"].contains($0.id) }.allSatisfy { $0.state == .pending }, "configuration cannot certify runtime")
    snapshot.directOption = nil
    snapshot.routingVerified = nil
    check(CriticalDiagnostics.rows(snapshot).first { $0.id == "routing" }?.state == .pending, "missing live graph pending")
    snapshot.directOption = false
    snapshot.routingVerified = true
    check(CriticalDiagnostics.rows(snapshot).first { $0.id == "routing" }?.state == .verifiedConfiguration, "verified ordered route can be green")
    snapshot.dnsVerified = nil
    check(CriticalDiagnostics.rows(snapshot).first { $0.id == "dns-policy" }?.state == .pending, "DNS count alone cannot be green")
    snapshot.dnsVerified = false
    check(CriticalDiagnostics.rows(snapshot).first { $0.id == "dns-policy" }?.state == .attention, "bad DNS candidates show attention")
    print(failures.isEmpty ? "PASS: \(checks) critical diagnostics checks; no network or settings accessed." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
