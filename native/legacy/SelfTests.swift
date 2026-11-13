import Foundation
import Darwin

func runSelfTests() -> Int32 {
    var passed = 0
    func check(_ condition: @autoclosure () -> Bool, _ description: String) throws {
        guard condition() else { throw AssistantError("自测失败：" + description) }
        passed += 1
    }
    guard let canonical = realpath(FileManager.default.temporaryDirectory.path, nil) else { return 1 }
    let temporary = URL(fileURLWithPath: String(cString: canonical), isDirectory: true)
    free(canonical)
    let root = temporary.appendingPathComponent("AI-Network-Assistant-SelfTest-" + UUID().uuidString, isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = NetworkConfiguration(home: root)
        let noProxy = try NetworkConfiguration.mergedNoProxy(existing: ["*,.corp.local,api.anthropic.com,*.openai.com,10.10.0.5", "git.corp,localhost,.claude.ai"], additions: "192.168.10.8")
        try check(noProxy.contains(".corp.local") && noProxy.contains("10.10.0.5") && noProxy.contains("192.168.10.8"), "内网例外保留")
        try check(!noProxy.contains("anthropic.com") && !noProxy.contains("openai.com") && !noProxy.contains("claude.ai") && !noProxy.split(separator: ",").contains("*"), "移除AI域名和全匹配直连")
        do {
            _ = try NetworkConfiguration.mergedNoProxy(existing: [], additions: "host\nother")
            throw AssistantError("直连例外换行应被拒绝")
        } catch let error as AssistantError { try check(error.message.contains("换行"), "非法直连例外拒绝") }
        var invalid = AssistantSettings(); invalid.node = "DIRECT"
        do { try invalid.validate(); throw AssistantError("DIRECT应被拒绝") }
        catch let error as AssistantError { try check(error.message.contains("节点"), "DIRECT目标拒绝") }
        let yaml = root.appendingPathComponent("parser.yaml")
        try Data("mode: rule\nnode: :fixture\nupdated: 2026-10-21\n".utf8).write(to: yaml)
        let parsed = try NetworkConfiguration.readYAML(yaml)
        try check(parsed["mode"] as? String == "rule" && parsed["node"] as? String == "fixture", "安全YAML解析支持常见数据类型")
        var settings = AssistantSettings()
        do { try settings.validate(); throw AssistantError("空节点应被拒绝") }
        catch let error as AssistantError { try check(error.message.contains("节点"), "新安装须明确选择节点") }
        settings.node = "fixture-node"
        let plan = try backend.plan(settings)
        try check(plan.components(separatedBy: "DOMAIN-SUFFIX,").count - 1 == 8, "生成8条规则")
        try check(plan.contains("不得失败后自动重启") && plan.contains("App 本身不会调用 Clash 的写接口"), "保留当次确认边界")
        let guardPlan = try GuardDeploymentPlan.make(node: "fixture-node", proxyTypes: ["fixture-node": "Shadowsocks"])
        try check(guardPlan.contains("port: 17891") && guardPlan.contains("proxy: \"fixture-node\""), "禁止直连方案使用独立固定节点入口")
        try check(guardPlan.contains("本次不执行") && guardPlan.contains("明确许可"), "禁止直连方案保留网络操作边界")
        let profileURL = try backend.makeEdgeProfile()
        let profile = try PropertyListSerialization.propertyList(from: Data(contentsOf: profileURL), format: nil) as! [String: Any]
        try check(profile["PayloadScope"] as? String == "User" && profile["PayloadRemovalDisallowed"] as? Bool == false, "描述文件用户级可移除")
        let payload = (profile["PayloadContent"] as! [[String: Any]])[0]
        let keys = Set(payload.keys.filter { !$0.hasPrefix("Payload") })
        try check(keys == Set(["ProxySettings", "DnsOverHttpsMode", "WebRtcLocalhostIpHandling", "NetworkPredictionOptions"]), "描述文件仅四项网络策略")
        let firstUUID = profile["PayloadUUID"] as! String
        let secondURL = try backend.makeEdgeProfile()
        let second = try PropertyListSerialization.propertyList(from: Data(contentsOf: secondURL), format: nil) as! [String: Any]
        try check(firstUUID != second["PayloadUUID"] as? String, "每次生成独立UUID")
        let target = root.appendingPathComponent("test/settings.json")
        let original = Data("original".utf8)
        try NetworkConfiguration.safeWrite(original, to: target, mode: 0o640)
        let backup = try backend.install([(target, Data("installed".utf8), 0o600)])
        try backend.restore(backup)
        let restored = try Data(contentsOf: target)
        try check(restored == original, "恢复原字节")
        let mode = try FileManager.default.attributesOfItem(atPath: target.path)[.posixPermissions] as! NSNumber
        try check(mode.intValue == 0o640, "恢复原权限")
        let conflict = try backend.install([(target, Data("installed".utf8), 0o600)])
        try NetworkConfiguration.safeWrite(Data("later user change".utf8), to: target)
        do { try backend.restore(conflict); throw AssistantError("应拒绝覆盖后续更改") }
        catch let error as AssistantError { try check(error.message.contains("后续更改"), "恢复冲突保护") }
        let link = root.appendingPathComponent("symlink")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        do { try NetworkConfiguration.safeWrite(Data("bad".utf8), to: link); throw AssistantError("应拒绝符号链接") }
        catch let error as AssistantError { try check(error.message.contains("符号链接"), "符号链接保护") }
        let missing = root.appendingPathComponent("not-yet-created", isDirectory: true)
        try NetworkConfiguration.checkPlainPath(missing.appendingPathComponent("child"))
        try check(!FileManager.default.fileExists(atPath: missing.path), "路径检查允许不存在的目录且不创建它")
        let dangling = root.appendingPathComponent("dangling", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: dangling, withDestinationURL: missing)
        do {
            try NetworkConfiguration.checkPlainPath(dangling.appendingPathComponent("child"))
            throw AssistantError("未拒绝悬空祖先链接")
        } catch let error as AssistantError {
            try check(error.message.hasSuffix(dangling.lastPathComponent), "拒绝缺失文件的悬空祖先链接")
        }
        // Exercise the real configuration transaction exclusively in the fake HOME.
        let initial: [String: Any] = ["model": "keep-model", "permissions": ["allow": ["Read"]], "env": ["CUSTOM": "keep", "NO_PROXY": ".corp.local,*,.anthropic.com"]]
        try NetworkConfiguration.safeWrite(try NetworkConfiguration.encode(initial), to: backend.claudeSettings)
        let prefsURL = backend.browserProfile.appendingPathComponent("Default/Preferences")
        let stateURL = backend.browserProfile.appendingPathComponent("Local State")
        try NetworkConfiguration.safeWrite(try NetworkConfiguration.encode(["custom": "keep", "profile": ["other": "keep"]]), to: prefsURL)
        try NetworkConfiguration.safeWrite(try NetworkConfiguration.encode(["custom": "keep"]), to: stateURL)
        let appliedBackup = try backend.applyClaudeCode(settings)
        let updated = try NetworkConfiguration.json(Data(contentsOf: backend.claudeSettings))
        let env = updated["env"] as! [String: Any]
        try check(updated["model"] as? String == "keep-model" && (updated["permissions"] as? [String: Any]) != nil && env["CUSTOM"] as? String == "keep", "保留无关配置")
        try check(env["HTTP_PROXY"] as? String == "http://127.0.0.1:7890" && env["NO_PROXY"] as? String == env["no_proxy"] as? String, "代理变量正确合并")
        try check(env["BROWSER"] as? String == Bundle.main.executableURL?.path, "直接使用主App内置浏览器入口")
        try check(!FileManager.default.fileExists(atPath: root.appendingPathComponent("Applications/Claude 专用浏览器.app").path), "不创建辅助App")
        let callback = "https://claude.ai/oauth?code=opaque%2Bvalue&state=a%20b#fragment"
        let args = try NetworkConfiguration.privateBrowserArguments(rawURL: callback, profile: backend.browserProfile)
        try check(args.last == callback && args.contains("--proxy-server=socks5://127.0.0.1:17890"), "OAuth地址作为完整单独参数传递")
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "https://", "https://example.com/\nsecret", "https://user:pass@example.com"] {
            var refused = false
            do { _ = try NetworkConfiguration.privateBrowserArguments(rawURL: bad, profile: backend.browserProfile) } catch { refused = true }
            try check(refused, "拒绝非预期登录地址")
        }
        let browserPrefs = try NetworkConfiguration.json(Data(contentsOf: prefsURL))
        let browserState = try NetworkConfiguration.json(Data(contentsOf: stateURL))
        try check(browserPrefs["custom"] as? String == "keep" && (browserPrefs["profile"] as? [String: Any])?["other"] as? String == "keep" && browserState["custom"] as? String == "keep", "保留独立浏览器无关设置")
        try backend.restore(appliedBackup)
        let originalJSON = try NetworkConfiguration.json(Data(contentsOf: backend.claudeSettings))
        try check(NSDictionary(dictionary: originalJSON).isEqual(to: initial), "完整配置事务可恢复")
        let profileLock = backend.browserProfile.appendingPathComponent("SingletonLock")
        try FileManager.default.createSymbolicLink(atPath: profileLock.path, withDestinationPath: "test-\(getpid())")
        var blocked = false
        do { _ = try backend.applyClaudeCode(settings) } catch { blocked = true }
        try check(blocked, "专用浏览器进程存活时拒绝覆盖资料")
        let unchangedJSON = try NetworkConfiguration.json(Data(contentsOf: backend.claudeSettings))
        try check(NSDictionary(dictionary: unchangedJSON).isEqual(to: initial), "拒绝时原配置不变")
        print("PASS: \(passed) 项自测。仅写入临时假HOME；未修改真实设置、默认浏览器或Clash。")
        return 0
    } catch {
        print("FAIL after \(passed) checks: " + error.localizedDescription)
        return 1
    }
}
