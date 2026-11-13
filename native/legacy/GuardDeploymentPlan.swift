import Foundation

/// Export only. No application launch, Clash write, or controller mutation.
enum GuardDeploymentPlan {
    static func isSupportedLeafType(_ type: String) -> Bool {
        ["shadowsocks", "shadowsocksr", "snell", "socks5", "http", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "wireguard", "ssh", "anytls", "mieru"].contains(type.lowercased())
    }

    /// The caller supplies the last observed core type map, never a list made
    /// from user-entered names. Missing/unknown types do not establish a leaf.
    static func make(node: String, proxyTypes: [String: String]) throws -> String {
        var settings = AssistantSettings(); settings.node = node; try settings.validate()
        let reserved = ["PROXY", "GLOBAL", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]
        guard !reserved.contains(node.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()),
              let type = proxyTypes[node], isSupportedLeafType(type) else {
            throw AssistantError("无法确认“\(node)”是核心已知的具体代理节点。请先读取核心状态并选择已确认的节点；代理组、内置策略和未知类型不能用于固定节点方案。")
        }
        let quotedNode = String(decoding: try JSONSerialization.data(withJSONObject: node, options: [.fragmentsAllowed]), as: UTF8.self)
        return """
        # Claude 禁止直连 · 待验收部署方案

        当前仅实现，尚未在本机部署/启用。不要将模拟通过当成网络保护生效。

        ## 独立代理路径
        将以下条目合并进现有 listeners。17890 已存在时仅核对并保留一份。
        保留原有 listener、DNS、系统代理与所有其他业务规则，不整体覆盖。
        目标必须为具体节点，不能是含 DIRECT 的共享代理组；节点自身的 dialer-proxy 等链路也需核对。

        ```yaml
        listeners:
          - name: claude-guard-http
            type: http
            listen: 127.0.0.1
            port: 17891
            proxy: \(quotedNode)
          - name: claude-browser-private
            type: socks
            listen: 127.0.0.1
            port: 17890
            proxy: \(quotedNode)
        ```

        ## Claude 桌面启动参数（仅供后续单独测试）
        在保存工作并自行完全退出 Claude 后，使用启动参数：
        --proxy-server=http://127.0.0.1:17891
        --proxy-bypass-list=localhost;127.0.0.1;[::1]
        助手不在本次自动退出/启动 Claude。应用是否接受这些 Chromium 参数必须实机验证。
        当前默认 HTTP 7890 不在过滤器允许范围；若客户端没有加载专用代理，将无法联网，这是预期的封闭行为。

        ## 过滤器约束
        核对 Claude 官方签名 Team ID、应用与网络 Helper 的 audit token。
        已识别 Claude 的出站 TCP 仅可访问 127.0.0.1 / ::1 的 17891 与 17890。
        公网/内网直连、UDP、其他本机端口均拒绝；其他应用和入站回调不受该应用规则限制。
        特权过滤器不轮询节点，也不会为超时启用 DIRECT。

        ## 后续测试与部署顺序（本次不执行）
        1. 使用具备权限的同一 Team 正式签名主 App 与扩展，配置两个 provisioning profiles。
        2. 审阅本方案与测试说明；若准备更改/热载 Clash，先取得用户针对该次操作的明确许可。
        3. 在隔离环境验证/应用专用 listener，不占用未知现有端口，不停止当前核心。
        4. 在 /Applications 安装签名助手，开启显式测试构建；先安装扩展，再单独确认启用。
        5. 验证正常请求走固定节点，再使用隔离代理模拟超时，观察直接 IPv4/IPv6/UDP 被拒绝。
        6. 验证实际 Claude Helper 归属、系统代理关闭、助手退出、过滤器异常、既有连接及本机回调。
        7. 验证 Git/npm/IDE/内网站点未受影响；Claude 内置 MCP 或本机开发服务可能被严格端口规则阻断。
        不得通过停止用户当前 Clash/VPN 来模拟断线。未知身份流与系统代发 DNS 等覆盖边界见测试说明。
        """
    }
}
