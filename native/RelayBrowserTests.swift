import Foundation

func runRelayBrowserSelfTests() -> Int32 {
    let fm = FileManager.default
    let sandbox = fm.temporaryDirectory.appendingPathComponent("relay-browser-fixture-" + UUID().uuidString)
    var count = 0, failures: [String] = []
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    func rejects(_ name: String, _ action: () throws -> Void) { do { try action(); check(false, name) } catch { check(true, name) } }
    defer { try? fm.removeItem(at: sandbox) }
    do {
        try fm.createDirectory(at: sandbox, withIntermediateDirectories: true)
        let home = NetworkConfiguration(home: sandbox).home
        let store = try RelayPreferenceStore(RelayBrowserContract.context(home: home))
        var launched: [[String]] = [], observations = 0
        let binding = RelayBrowserBinding(instanceId: "00000000-0000-0000-0000-000000000001", configurationRevision: String(repeating: "a", count: 64), pid: 1234, httpPort: 18193, socksPort: nil, route: "fixture-node")
        var environment = RelayBrowserEnvironment(installed: { observations += 1; return true }, binding: { binding }, policyAllowed: { true }, process: { _ in "closed" }, spawn: { launched.append($0) })
        for url in ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@claude.ai/", "https://claude.ai/\n", " --flag", "https://localhost:0", String(repeating: "a", count: 32769)] {
            rejects("invalid browser URL") { try RelayBrowserLauncher.launch(url, home: home, environment: environment) }
        }
        check(observations == 0 && launched.isEmpty && !fm.fileExists(atPath: store.root.path), "invalid URLs cause no state reads, launch or directory creation")
        check(try RelayBrowserLauncher.inspectReadiness(home: home, environment: environment), "new private profile can be prepared on explicit launch")
        check(!fm.fileExists(atPath: store.root.path), "failed readiness does not create state")
        let profile = RelayBrowserContract.profile(store)
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(["dns_over_https": ["mode": "off"]]), to: profile.appendingPathComponent("Local State"))
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(["webrtc": ["ip_handling_policy": "disable_non_proxied_udp"]]), to: profile.appendingPathComponent("Default/Preferences"))
        var lockHeld = false
        environment.spawn = { args in
            launched.append(args)
            do { try RelayBrowserLauncher.launchLock(store.root).withLock { } } catch { lockHeld = true }
        }
        let url = "https://claude.ai/oauth?state=a%26b%20c"
        try RelayBrowserLauncher.launch(url, home: home, environment: environment)
        check(launched.count == 1 && launched[0].last == url, "URL passed as one verbatim argument")
        check(lockHeld && launched[0].contains("--user-data-dir=" + profile.path), "launch shares transaction lock and own profile")
        check(launched[0].contains("--proxy-server=http://127.0.0.1:18193") && launched[0].contains("--webrtc-ip-handling-policy=disable_non_proxied_udp"), "fixed proxy and UDP policy")
        check(launched[0].contains { $0.contains("MAP * ^NOTFOUND") && $0.contains("EXCLUDE localhost") }, "remote DNS routing with callback exceptions")
        environment.binding = { throw AssistantError("offline") }
        rejects("missing proxy has no direct/default fallback") { try RelayBrowserLauncher.launch(url, home: home, environment: environment) }
        environment.binding = { binding }; environment.process = { _ in "running" }
        rejects("unverified running profile is not reused") { try RelayBrowserLauncher.launch(url, home: home, environment: environment) }
        environment.process = { _ in "unconfirmed" }
        rejects("unknown browser process blocks launch") { try RelayBrowserLauncher.launch(url, home: home, environment: environment) }
        check(launched.count == 1, "rejected attempts never launch anything")
        environment.process = { _ in "closed" }; environment.installed = { false }
        rejects("missing Chrome blocks launch") { try RelayBrowserLauncher.launch(url, home: home, environment: environment) }
        environment.installed = { true }; environment.policyAllowed = { false }
        rejects("Chrome proxy policy cannot override own endpoint") { try RelayBrowserLauncher.launch(url, home: home, environment: environment) }
        environment.policyAllowed = { true }
        var reads = 0
        environment.binding = {
            reads += 1
            return RelayBrowserBinding(instanceId: binding.instanceId, configurationRevision: String(repeating: reads == 1 ? "a" : "b", count: 64), pid: binding.pid, httpPort: binding.httpPort, socksPort: nil, route: binding.route)
        }
        rejects("changed live owner before spawn is rejected") { try RelayBrowserLauncher.launch(url, home: home, environment: environment) }
        check(launched.count == 1, "owner and policy rejection never launch")
        environment.binding = { binding }
        try RelayStateLock(root: store.root).withLock {
            try RelayBrowserLauncher.launch(url, home: home, environment: environment)
        }
        check(launched.count == 2, "desktop root transaction lock does not prevent browser handler")
        let nonce = String(repeating: "c", count: 64)
        let reply: [String: Any] = ["version": 1, "nonce": nonce, "binding": ["instanceId": binding.instanceId, "configurationRevision": binding.configurationRevision, "pid": binding.pid, "httpPort": binding.httpPort, "route": binding.route]]
        let bytes = try JSONSerialization.data(withJSONObject: reply)
        check(try RelayBrowserBindingClient.decode(bytes, nonce: nonce) == binding, "nonce-bound owner response decoded")
        rejects("replayed owner reply rejected") { _ = try RelayBrowserBindingClient.decode(bytes, nonce: String(repeating: "d", count: 64)) }
        let dynamic = try RelayBrowserContract.arguments(url, profile: profile, httpPort: 18293)
        check(dynamic.contains("--proxy-server=http://127.0.0.1:18293"), "current owned custom HTTP port is used")
        environment.process = { _ in "running" }; environment.reusable = { _, port in port == binding.httpPort }
        try RelayBrowserLauncher.launch(url, home: home, environment: environment)
        check(launched.count == 3, "verified own Chrome arguments may accept another URL")
        environment.process = { _ in "unconfirmed" }
        rejects("unknown process state cannot reuse even matching observed args") { try RelayBrowserLauncher.launch(url, home: home, environment: environment) }
        let process = RelayBrowserProcess(pid: 77, parent: 1, name: "Google Chrome", arguments: try RelayBrowserContract.arguments(url, profile: profile))
        let chrome = RelayBrowserContract.chrome.appendingPathComponent("Contents/MacOS/Google Chrome").path
        check(RelayBrowserProcesses.reusable(profile, httpPort: 18193, snapshot: { [process] }, executable: { _ in chrome }), "existing exact dedicated Chrome arguments verified")
        check(!RelayBrowserProcesses.reusable(profile, httpPort: 18293, snapshot: { [process] }, executable: { _ in chrome }), "other proxy process never reused")
        check(!RelayBrowserProcesses.reusable(profile, httpPort: 18193, snapshot: { [process] }, executable: { _ in "/other/Google Chrome" }), "untrusted browser executable never reused")
        for bypass in ["--proxy-bypass-list=*", "--proxy-auto-detect", "--no-proxy-server", "--no-proxy-server=true", "--proxy-pac-url=https://example.invalid/pac"] {
            let altered = RelayBrowserProcess(pid: process.pid, parent: process.parent, name: process.name, arguments: process.arguments + [bypass])
            check(!RelayBrowserProcesses.reusable(profile, httpPort: 18193, snapshot: { [altered] }, executable: { _ in chrome }), "proxy bypass arguments are never reused")
        }
        check(RelayBrowserContract.policyAllowed(read: { _ in nil }), "no management overrides accepted")
        for policy in ["ProxySettings", "DnsOverHttpsMode", "DnsOverHttpsTemplates", "WebRtcIPHandling", "WebRtcIPHandlingUrl", "WebRtcLocalIpsAllowedUrls"] {
            check(!RelayBrowserContract.policyAllowed(read: { $0 == policy ? "override" : nil }), "global management override cannot be mistaken for profile isolation")
        }
        let callback = try RelayBrowserContract.arguments("http://127.0.0.1:17991/callback?code=fixture", profile: profile)
        check(callback.last?.contains("127.0.0.1:17991") == true, "loopback callback URL accepted")
    } catch { failures.append("unexpected browser fixture failure") }
    print(failures.isEmpty ? "PASS: \(count) browser entry checks; only fixture profile files, no actual browser, port probe or network." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
