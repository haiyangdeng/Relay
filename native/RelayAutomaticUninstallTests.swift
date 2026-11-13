import Foundation
import Darwin

@MainActor func runRelayAutomaticUninstallSelfTests() async -> Int32 {
    let fm = FileManager.default
    let base = URL(fileURLWithPath: NetworkConfiguration.canonicalPath(fm.temporaryDirectory), isDirectory: true).appendingPathComponent("relay-automatic-uninstall-" + UUID().uuidString)
    var count = 0, failures: [String] = []
    func check(_ result: Bool, _ name: String) { count += 1; if !result { failures.append(name) } }
    func rejects(_ name: String, _ action: () throws -> Void) {
        do { try action(); check(false, name) } catch { check(true, name) }
    }
    defer { try? fm.removeItem(at: base) }
    func directory(_ path: URL) throws { try fm.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
    do {
        try directory(base)
        let home = NetworkConfiguration(home: base.appendingPathComponent("home")).home
        try directory(home)
        let authorityParent = NetworkConfiguration(home: base.appendingPathComponent("authority")).home
        let authorityRoot = authorityParent.appendingPathComponent("Uninstall")
        try directory(authorityRoot)
        let native = Data("fixture native executable".utf8), generation = UUID().uuidString.lowercased()
        try NetworkConfiguration.safeWrite(native, to: authorityRoot.appendingPathComponent("RelayNative"), mode: 0o700)
        var manifest: [String: Any] = ["version": 1, "generation": generation, "clientUID": getuid(), "home": home.path,
            "appPath": "/Applications/Relay.app", "appDevice": 1, "appInode": 2,
            "nativeSHA256": NetworkConfiguration.digest(native), "supervisorSHA256": String(repeating: "a", count: 64),
            "additionalInstallerMetadata": "allowed"]
        func writeManifest() throws { try NetworkConfiguration.safeWrite(JSONSerialization.data(withJSONObject: manifest), to: authorityRoot.appendingPathComponent("installation.json")) }
        try writeManifest()
        var intent: [String: Any] = ["version": 1, "generation": generation, "clientUID": getuid(), "phase": "requested"]
        func writeIntent() throws { try NetworkConfiguration.safeWrite(JSONSerialization.data(withJSONObject: intent), to: authorityRoot.appendingPathComponent("intent.json")) }
        let authority = RelayAutomaticUninstall.AuthorityEnvironment(root: authorityRoot, ancestor: authorityParent, owner: getuid(), uid: getuid(), home: home, applicationAbsent: { true })
        check(!RelayAutomaticUninstall.status(authority).requested, "missing intent never requests uninstall")
        try writeIntent()
        let accepted = try RelayAutomaticUninstall.authorize(authority)
        check(RelayAutomaticUninstall.status(authority).requested, "bound immutable intent accepted with extra installer fields")
        intent["generation"] = UUID().uuidString.lowercased(); try writeIntent()
        rejects("generation change invalidates held authorization") { try accepted.revalidate() }
        check(!RelayAutomaticUninstall.status(authority).requested, "wrong generation does not trigger Main quit")
        intent["generation"] = generation; intent["clientUID"] = getuid() + 1; try writeIntent()
        check(!RelayAutomaticUninstall.status(authority).requested, "other user intent refused")
        intent["clientUID"] = getuid(); intent["phase"] = "user-cleaned"; try writeIntent()
        check(!RelayAutomaticUninstall.status(authority).requested, "completed worker phase does not request another quit")
        intent["phase"] = "requested"; try writeIntent()
        manifest["home"] = base.path; try writeManifest()
        check(!RelayAutomaticUninstall.status(authority).requested, "foreign home refused")
        manifest["home"] = home.path; try writeManifest()
        try fm.setAttributes([.posixPermissions: 0o666], ofItemAtPath: authorityRoot.appendingPathComponent("intent.json").path)
        check(!RelayAutomaticUninstall.status(authority).requested, "writable root intent refused")
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: authorityRoot.appendingPathComponent("intent.json").path)
        try NetworkConfiguration.safeWrite(Data("changed executable".utf8), to: authorityRoot.appendingPathComponent("RelayNative"), mode: 0o700)
        check(!RelayAutomaticUninstall.status(authority).requested, "changed worker hash refused")
        try NetworkConfiguration.safeWrite(native, to: authorityRoot.appendingPathComponent("RelayNative"), mode: 0o700)
        let savedIntent = authorityRoot.appendingPathComponent("intent-saved.json")
        try fm.moveItem(at: authorityRoot.appendingPathComponent("intent.json"), to: savedIntent)
        try fm.createSymbolicLink(at: authorityRoot.appendingPathComponent("intent.json"), withDestinationURL: savedIntent)
        check(!RelayAutomaticUninstall.status(authority).requested, "intent symlink refused")

        var events: [String] = [], failStage: String?
        func step(_ name: String) throws { events.append(name); if failStage == name { throw AssistantError("fixture failure") } }
        let environment = RelayAutomaticUninstall.CleanupEnvironment(assertAuthorized: { try step("authorize") },
            restoreProxy: { try step("proxy") }, restoreDesktop: { try step("desktop") }, retireCore: { try step("core") },
            restoreClients: { try step("clients") }, assertIdle: { try step("idle") }, removeCredentials: { try step("credentials") }, removeTemporaryLease: { try step("temporary") }, remove: { try step("remove:" + $0) })
        failStage = "desktop"
        do { _ = try await RelayAutomaticUninstall.cleanup(environment); check(false, "recovery failure propagated") }
        catch { check(!events.contains(where: { $0.hasPrefix("remove:") }), "no files deleted after recovery failure") }
        events = []; failStage = nil
        check(try await RelayAutomaticUninstall.cleanup(environment).status == "cleaned", "complete recovery reaches cleaned")
        check(events.last == "remove:Library/Application Support/Relay-Preview", "recovery evidence removed last")
        check(events.firstIndex(of: "proxy")! < events.firstIndex(of: "clients")!, "proxy detached before client recovery")
        check(events.filter { $0 == "authorize" }.count == RelayAutomaticUninstall.cleanupPaths.count + 3, "intent checked before each deletion")

        let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path)
        let store = try RelayPreferenceStore(context), client = home.appendingPathComponent(".claude/settings.json")
        let original = Data("original client".utf8)
        try NetworkConfiguration.safeWrite(original, to: client)
        let first = try store.transactionBackend().install([(client, Data("first relay".utf8), 0o600)])
        _ = try store.transactionBackend().install([(client, Data("second relay".utf8), 0o600)])
        try RelayAutomaticUninstall.restoreClients(context, browserObservation: { _ in "closed" })
        check(try Data(contentsOf: client) == original, "stacked configuration writes restored newest-first")
        check(try RelayRecoveryInspector.inspect(.init(context: context, selection: .init(source: "relay", id: first.lastPathComponent))).phase == "restored", "client recovery journals completed")
        _ = try store.transactionBackend().install([(client, Data("third relay".utf8), 0o600)])
        try NetworkConfiguration.safeWrite(Data("later user edit".utf8), to: client)
        try RelayAutomaticUninstall.restoreClients(context, browserObservation: { _ in "closed" })
        check(try Data(contentsOf: client) == Data("later user edit".utf8), "external replacement client file preserved")

        func clientFields(_ name: String, legacy: Bool, changeProxy: Bool, entirelyExternal: Bool = false) throws {
            let folder = base.appendingPathComponent(name); try directory(folder)
            let c = RelayStateContext(home: folder.path, stateRoot: folder.appendingPathComponent("Library/Application Support/Relay-Preview").path)
            let s = try RelayPreferenceStore(c), target = folder.appendingPathComponent(".claude/settings.json")
            let before: [String: Any] = ["model": "original-model", "env": ["TOKEN": "private-token", "HTTP_PROXY": "http://old.proxy:1234"]]
            try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(before), to: target)
            var installed = before, environment = before["env"] as! [String: Any]
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] { environment[key] = "http://127.0.0.1:17890" }
            environment["NO_PROXY"] = "localhost,127.0.0.1"; environment["no_proxy"] = "localhost,127.0.0.1"
            environment["BROWSER"] = "/Applications/Relay.app/Contents/Resources/relay/RelayBrowser.app/Contents/MacOS/RelayBrowser"
            installed["env"] = environment
            let backup = try s.transactionBackend().install([(target, NetworkConfiguration.encode(installed), 0o600),
                (s.preferenceURL, Data("private preferences".utf8), 0o600)])
            if legacy {
                let path = backup.appendingPathComponent("manifest.json")
                var json = try NetworkConfiguration.json(Data(contentsOf: path)), entries = json["entries"] as! [[String: Any]]
                entries[0].removeValue(forKey: "installedEnvironment"); json["entries"] = entries
                try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(json), to: path)
            }
            var later = installed
            later["model"] = "user-new-model"; environment["NEW_KEY"] = "keep-added"
            if changeProxy { environment["HTTPS_PROXY"] = "http://user.proxy:9999" }
            if entirelyExternal {
                for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] { environment[key] = "http://127.0.0.1:18999" }
                environment["NO_PROXY"] = "user.example"; environment["no_proxy"] = "user.example"
                environment["BROWSER"] = "/Applications/UserBrowser.app/Contents/MacOS/Browser"
            }
            later["env"] = environment
            try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(later), to: target)
            try NetworkConfiguration.safeWrite(Data("later private preference edit".utf8), to: s.preferenceURL)
            try RelayAutomaticUninstall.restoreClients(c, browserObservation: { _ in "closed" })
            let result = try NetworkConfiguration.json(Data(contentsOf: target)), values = result["env"] as! [String: Any]
            if entirelyExternal {
                check(NSDictionary(dictionary: result).isEqual(to: later), "unproven other local proxy is preserved and does not block")
                return
            }
            check(result["model"] as? String == "user-new-model" && values["TOKEN"] as? String == "private-token" && values["NEW_KEY"] as? String == "keep-added", name + " preserves unrelated client changes")
            check(values["HTTP_PROXY"] as? String == "http://old.proxy:1234" && values["BROWSER"] == nil && values["http_proxy"] == nil && values["NO_PROXY"] == nil, name + " restores only owned fields")
            check(changeProxy ? values["HTTPS_PROXY"] as? String == "http://user.proxy:9999" : values["HTTPS_PROXY"] == nil, name + " preserves changed proxy key")
            let once = try Data(contentsOf: target)
            try RelayAutomaticUninstall.restoreClients(c, browserObservation: { _ in "closed" })
            check(try Data(contentsOf: target) == once, name + " repeats without replaying completed recovery")
        }
        try clientFields("new-fields", legacy: false, changeProxy: true)
        try clientFields("old-fields", legacy: true, changeProxy: true)
        try clientFields("other-proxy", legacy: true, changeProxy: true, entirelyExternal: true)

        let ownerWorkspace = URL(fileURLWithPath: context.stateRoot).appendingPathComponent("CoreOwner/.session")
        try directory(ownerWorkspace)
        var ownerInfo = stat(); _ = lstat(ownerWorkspace.path, &ownerInfo)
        let ownerExecutable = "/Applications/Relay.app/Contents/Resources/relay/RelayCoreOwner", hash = String(repeating: "a", count: 64)
        func actor(_ pid: Int, _ path: String) -> [String: Any] {
            ["pid": pid, "uid": getuid(), "bornSeconds": "123", "bornMicroseconds": "0", "executable": path, "resourceSHA256": hash, "fileIdentity": "1:2:3"]
        }
        let ownerSession = UUID().uuidString.lowercased(), rawLease = "{}"
        var journal: [String: Any] = ["version": 1, "contract": "relay-ordinary-core-owner-v1", "sessionId": ownerSession,
            "phase": "closed", "owner": actor(123, ownerExecutable), "core": actor(124, "/Applications/Relay.app/Contents/Resources/relay/core/darwin-arm64/mihomo"),
            "coreLease": ["token": ownerSession, "directoryIdentity": "1:2", "ownerSHA256": NetworkConfiguration.digest(Data(rawLease.utf8))],
            "runtime": ["directory": ownerWorkspace.path, "socket": ownerWorkspace.appendingPathComponent("api.sock").path, "httpPort": 17890,
                        "profileId": UUID().uuidString.lowercased(), "sourceSHA256": hash, "configurationSHA256": hash, "mode": "rule", "coreResourceSHA256": hash],
            "controlLost": false, "detached": false, "createdAt": "fixture", "workspaceIdentity": "\(ownerInfo.st_dev):\(ownerInfo.st_ino)", "leaseRaw": rawLease]
        func writeOwner() throws { try NetworkConfiguration.safeWrite(JSONSerialization.data(withJSONObject: journal), to: ownerWorkspace.appendingPathComponent("owner.json")) }
        try writeOwner()
        var observed: [pid_t] = []
        try RelayAutomaticUninstall.assertStaleCoreOwner(context, absent: { observed.append($0); return true })
        check(observed == [123, 124], "both historical owner and core must be absent")
        rejects("live historical core blocks cleanup") { try RelayAutomaticUninstall.assertStaleCoreOwner(context, absent: { $0 == 123 }) }
        journal["core"] = actor(0, "/Applications/Relay.app/Contents/Resources/relay/core/darwin-arm64/mihomo"); try writeOwner()
        rejects("malformed historical process identity refused") { try RelayAutomaticUninstall.assertStaleCoreOwner(context, absent: { _ in true }) }

        let external = base.appendingPathComponent("keep-external")
        try NetworkConfiguration.safeWrite(Data("keep".utf8), to: external)
        let cache = home.appendingPathComponent("Library/Caches/local.relay.network.preview")
        try directory(cache.appendingPathComponent("nested"))
        try NetworkConfiguration.safeWrite(Data("cache".utf8), to: cache.appendingPathComponent("nested/value"))
        try fm.createSymbolicLink(at: cache.appendingPathComponent("link"), withDestinationURL: external)
        try RelayAutomaticUninstall.removeOwnedPath("Library/Caches/local.relay.network.preview", home: home, uid: getuid())
        check(!fm.fileExists(atPath: cache.path) && fm.fileExists(atPath: external.path), "cache symlink removed without following target")
        rejects("arbitrary cleanup path refused") { try RelayAutomaticUninstall.removeOwnedPath(".claude", home: home, uid: getuid()) }
        try fm.createSymbolicLink(at: cache, withDestinationURL: external)
        rejects("namespace root symlink refused") { try RelayAutomaticUninstall.removeOwnedPath("Library/Caches/local.relay.network.preview", home: home, uid: getuid()) }
        check(fm.fileExists(atPath: external.path), "refused root preserves external content")
        try RelayAutomaticUninstall.removeOwnedPath("Library/Logs/Relay", home: home, uid: getuid())
        check(true, "absent optional namespace is idempotent")
    } catch { failures.append("fixture: " + error.localizedDescription) }
    if failures.isEmpty { print("Relay automatic uninstall: \(count) isolated checks passed"); return 0 }
    failures.forEach { print("FAIL: " + $0) }; return 1
}
