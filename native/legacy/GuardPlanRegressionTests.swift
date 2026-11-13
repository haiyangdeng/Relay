import Foundation

/// Pure string/metadata checks. No core queries, application launches or writes.
func runGuardPlanRegressionTests() -> Int32 {
    var count = 0
    var failures: [String] = []
    func check(_ condition: Bool, _ name: String) {
        count += 1
        if !condition { failures.append(name) }
    }
    func rejected(_ node: String, _ types: [String: String]) -> Bool {
        do { _ = try GuardDeploymentPlan.make(node: node, proxyTypes: types); return false }
        catch { return true }
    }
    do {
        let plan = try GuardDeploymentPlan.make(node: "fixture-node", proxyTypes: ["fixture-node": "Shadowsocks"])
        check(plan.components(separatedBy: "proxy: \"fixture-node\"").count - 1 == 2, "known leaf binds both listeners")
        check(plan.contains("本次不执行") && plan.contains("明确许可"), "deployment consent remains explicit")
        check(plan.contains("节点自身的 dialer-proxy 等链路也需核对"), "type metadata not a complete upstream proof")
    } catch { check(false, "known leaf accepted") }
    check(rejected("fixture-node", [:]), "missing metadata refused")
    check(rejected("unknown-node", ["fixture-node": "Shadowsocks"]), "unknown node refused")
    check(rejected("PROXY", ["PROXY": "Selector"]), "shared selector refused")
    check(rejected("FallbackWithDIRECT", ["FallbackWithDIRECT": "Fallback"]), "fallback group refused")
    check(rejected("ProxyOnlyGroup", ["ProxyOnlyGroup": "URLTest"]), "proxy-only group still not a fixed leaf")
    check(rejected("relay-group", ["relay-group": "Relay"]), "relay group refused")
    check(rejected("unknown-type", ["unknown-type": "FutureTransport"]), "unknown type refused")
    check(rejected("missing-type", ["missing-type": ""]), "empty type refused")
    for reserved in ["DIRECT", "REJECT", "REJECT-DROP", "GLOBAL", "PROXY", "PASS", "COMPATIBLE", " direct "] {
        check(rejected(reserved, [reserved: "Shadowsocks"]), "reserved target refused: " + reserved)
    }
    check(GuardDeploymentPlan.isSupportedLeafType("SOCKS5"), "known transport case accepted")
    check(!GuardDeploymentPlan.isSupportedLeafType("Selector"), "selector not classified as node")
    check(!GuardDeploymentPlan.isSupportedLeafType("Direct"), "direct not classified as node")
    check(!GuardDeploymentPlan.isSupportedLeafType("RejectDrop"), "drop not classified as node")
    check(!GuardDeploymentPlan.isSupportedLeafType("Shadowsocks "), "malformed type not trusted")
    print(failures.isEmpty ? "PASS: \(count) guard plan regression checks; metadata only, no network or settings accessed."
          : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
