import AppKit
import NetworkExtension
import SystemExtensions
import Security

/// No work in init. Only explicit UI actions can reach the live code; the
/// distributed offline build excludes every system-changing request below.
@MainActor
final class NetworkGuardCoordinator: NSObject, OSSystemExtensionRequestDelegate {
    var onUpdate: ((String) -> Void)?
    private var extensionReady = false
    private var busy = false
    static var liveBuild: Bool {
        #if AI_NETWORK_GUARD_LIVE
        return true
        #else
        return false
        #endif
    }
    var readiness: String {
        let extensionURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Library/SystemExtensions/" + ClaudeGuardPolicy.extensionID + ".systemextension")
        let present = FileManager.default.fileExists(atPath: extensionURL.path)
        return "模式：\(Self.liveBuild ? "正式签名测试入口" : "离线测试，真实启用已锁定")\n扩展组件：\(present ? "已随 App 打包" : "缺失")\n当前未经过运行时验证，不能显示为已保护。"
    }
    func simulate() -> String {
        let rows = GuardSimulation.run()
        return rows.map { ($0.passed ? "✓ " : "✗ ") + $0.name + "：" + ($0.actual == "drop" ? "阻断" : "允许") }.joined(separator: "\n")
            + "\n\n以上为离线策略模拟；没有创建连接、安装扩展或修改系统。"
    }
    func readSystemStatus() {
        #if AI_NETWORK_GUARD_LIVE
        guard !busy else { return }
        busy = true
        let request = OSSystemExtensionRequest.propertiesRequest(forExtensionWithIdentifier: ClaudeGuardPolicy.extensionID, queue: .main)
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
        #else
        onUpdate?(readiness)
        #endif
    }
    nonisolated func request(_ request: OSSystemExtensionRequest, foundProperties properties: [OSSystemExtensionProperties]) {
        Task { @MainActor in
            let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Library/SystemExtensions/" + ClaudeGuardPolicy.extensionID + ".systemextension")
            let version = Bundle(url: bundled)?.infoDictionary?["CFBundleVersion"] as? String
            self.extensionReady = properties.contains { $0.bundleIdentifier == ClaudeGuardPolicy.extensionID && $0.isEnabled && !$0.isUninstalling && $0.bundleVersion == version }
            NEFilterManager.shared().loadFromPreferences { error in
                Task { @MainActor in
                    self.busy = false
                    if let error { self.onUpdate?("过滤配置状态读取失败：\(error.localizedDescription)"); return }
                    let manager = NEFilterManager.shared()
                    let own = manager.providerConfiguration?.filterDataProviderBundleIdentifier == ClaudeGuardPolicy.extensionID
                    self.onUpdate?("扩展：\(self.extensionReady ? "当前版本已安装启用" : "未就绪/版本不符")\n过滤配置：\(own && manager.isEnabled ? "已启用" : "未启用")\n这不是运行时拦截验收结果。")
                }
            }
        }
    }
    func installExtension() {
        #if AI_NETWORK_GUARD_LIVE
        guard !busy else { return }
        guard Self.hasEntitlement("com.apple.developer.system-extension.install"),
              Self.hasEntitlement("com.apple.developer.networking.networkextension") else {
            onUpdate?("缺少系统扩展/网络扩展签名权限，未提交安装请求。"); return
        }
        guard Bundle.main.bundleURL.path.hasPrefix("/Applications/") else {
            onUpdate?("请先将正式签名的助手放到 /Applications，再安装扩展。"); return
        }
        busy = true
        // An enabled stale configuration can start filtering as soon as its
        // missing extension is installed. Refuse this implicit activation.
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { error in
            Task { @MainActor in
                guard error == nil, !manager.isEnabled else {
                    self.busy = false
                    self.onUpdate?("无法确认过滤配置处于停用状态。未提交安装请求；先读取并处理现有配置，避免安装时恢复旧过滤。")
                    return
                }
                let request = OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: ClaudeGuardPolicy.extensionID, queue: .main)
                request.delegate = self
                OSSystemExtensionManager.shared.submitRequest(request)
            }
        }
        #else
        onUpdate?("当前是离线构建，不会提交系统扩展安装请求。")
        #endif
    }
    func enable() {
        #if AI_NETWORK_GUARD_LIVE
        guard extensionReady, !busy else {
            onUpdate?("先完成扩展安装，并确认 HTTP 代理端口有效。"); return
        }
        busy = true
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { error in
            Task { @MainActor in
                guard error == nil else { self.busy = false; self.onUpdate?("读取过滤配置失败，未修改。"); return }
                if let identifier = manager.providerConfiguration?.filterDataProviderBundleIdentifier,
                   identifier != ClaudeGuardPolicy.extensionID {
                    self.busy = false; self.onUpdate?("存在非本助手的过滤配置，拒绝覆盖。"); return
                }
                guard !manager.isEnabled else {
                    self.busy = false; self.onUpdate?("过滤配置已经启用；不会在线改写端口。先按测试流程停用再修改。"); return
                }
                let config = NEFilterProviderConfiguration()
                config.filterSockets = true
                config.filterPackets = false
                config.filterDataProviderBundleIdentifier = ClaudeGuardPolicy.extensionID
                config.vendorConfiguration = ["proxyPorts": [ClaudeGuardPolicy.httpPort, ClaudeGuardPolicy.socksPort]]
                manager.providerConfiguration = config
                manager.localizedDescription = "AI 网络助手 · Claude 禁止直连"
                manager.grade = .firewall
                manager.isEnabled = true
                manager.saveToPreferences { error in
                    Task { @MainActor in
                        self.busy = false
                        self.onUpdate?(error.map { "启用失败：\($0.localizedDescription)" }
                            ?? "系统已保存启用请求；尚未验证过滤器运行或既有连接是否受控。请按清单验收。")
                    }
                }
            }
        }
        #else
        onUpdate?("当前是离线构建，不会保存或启用网络过滤配置。")
        #endif
    }
    func disable() {
        #if AI_NETWORK_GUARD_LIVE
        guard !busy else { return }
        busy = true
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { error in
            Task { @MainActor in
                guard error == nil,
                      manager.providerConfiguration?.filterDataProviderBundleIdentifier == ClaudeGuardPolicy.extensionID else {
                    self.busy = false; self.onUpdate?("未找到本助手的可停用配置，未修改。"); return
                }
                manager.isEnabled = false
                manager.saveToPreferences { error in
                    Task { @MainActor in
                        self.busy = false
                        self.onUpdate?(error.map { "停用失败：\($0.localizedDescription)" } ?? "本助手过滤配置已请求停用，Claude 的直连保护将不再提供。")
                    }
                }
            }
        }
        #else
        onUpdate?("当前是离线构建，不会修改任何过滤配置。")
        #endif
    }
    func launchClaude() {
        #if AI_NETWORK_GUARD_LIVE
        guard extensionReady, !busy else { onUpdate?("先完成扩展安装和启用。"); return }
        let running = NSWorkspace.shared.runningApplications.contains {
            let identifier = $0.bundleIdentifier ?? ""
            return identifier == ClaudeGuardPolicy.signingID || identifier.hasPrefix(ClaudeGuardPolicy.signingID + ".")
        }
        guard !running else { onUpdate?("Claude 或 Helper 仍运行。请保存工作并自行完全退出，助手不会关闭它。"); return }
        busy = true
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { error in
            Task { @MainActor in
                guard error == nil, manager.isEnabled,
                      manager.providerConfiguration?.filterDataProviderBundleIdentifier == ClaudeGuardPolicy.extensionID else {
                    self.busy = false; self.onUpdate?("过滤配置未启用，未启动 Claude。"); return
                }
                let url = URL(fileURLWithPath: "/Applications/Claude.app")
                guard Bundle(url: url)?.bundleIdentifier == ClaudeGuardPolicy.signingID else {
                    self.busy = false; self.onUpdate?("未找到预期的 Claude 客户端。"); return
                }
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.arguments = ["--proxy-server=http://127.0.0.1:17891", "--proxy-bypass-list=localhost;127.0.0.1;[::1]"]
                NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
                    Task { @MainActor in
                        self.busy = false
                        self.onUpdate?(error.map { "启动失败：\($0.localizedDescription)" }
                            ?? "已按专用代理参数请求启动。参数是否被客户端加载及真实出网路径仍须验收。")
                    }
                }
            }
        }
        #else
        onUpdate?("离线构建不会启动 Claude 或创建网络连接。")
        #endif
    }
    private static func hasEntitlement(_ key: String) -> Bool {
        guard let task = SecTaskCreateFromSelf(nil), let value = SecTaskCopyValueForEntitlement(task, key as CFString, nil) else { return false }
        if let bool = value as? Bool { return bool }
        return (value as? [String])?.contains("content-filter-provider-systemextension") == true
    }
    nonisolated func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        Task { @MainActor in self.onUpdate?("等待你在系统设置批准扩展；不会自动启用过滤配置。") }
    }
    nonisolated func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties,
                            withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        // Replacing an active filter could change live traffic. Do not do so implicitly.
        .cancel
    }
    nonisolated func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        Task { @MainActor in
            self.busy = false
            self.extensionReady = result == .completed
            self.onUpdate?(self.extensionReady ? "扩展安装请求完成。过滤尚未启用，请另行确认启用。" : "扩展需要重启电脑后完成；助手不会重启电脑。")
        }
    }
    nonisolated func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        Task { @MainActor in self.busy = false; self.extensionReady = false; self.onUpdate?("扩展安装未完成：\(error.localizedDescription)") }
    }
}
