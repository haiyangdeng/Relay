import Foundation

func runRelayCodeSelfTests() -> Int32 {
    let fm = FileManager.default
    let sandbox = fm.temporaryDirectory.appendingPathComponent("relay-code-fixture-" + UUID().uuidString)
    var count = 0, failures: [String] = []
    func check(_ condition: Bool, _ label: String) { count += 1; if !condition { failures.append(label) } }
    func rejects(_ label: String, _ action: () throws -> Void) { do { try action(); check(false, label) } catch { check(true, label) } }
    defer { try? fm.removeItem(at: sandbox) }
    let settings = RelayPreferences(httpPort: 7890, node: "fixture-node", internalExceptions: "git.corp,10.10.0.5")
    var environment = RelayCodeEnvironment(helperDigest: { _ in String(repeating: "a", count: 64) }, browserState: { _ in "closed" })
    do {
        try fm.createDirectory(at: sandbox, withIntermediateDirectories: true)
        let home = NetworkConfiguration(home: sandbox).home
        let store = try RelayPreferenceStore(RelayBrowserContract.context(home: home))
        let context = RelayCodeContext(home: home.path, stateRoot: store.root.path, browserExecutable: home.appendingPathComponent("App With Spaces/RelayBrowser").path)
        func input(_ revision: String? = nil) -> RelayCodeInput { RelayCodeInput(context: context, settings: settings, expectedRevision: revision) }
        let initial = try RelayCodeConfiguration.prepare(input(), environment: environment)
        check(initial.changedTargets.count == 4 && initial.canApply, "four targets staged")
        check(!fm.fileExists(atPath: store.root.path) && !fm.fileExists(atPath: home.appendingPathComponent(".claude").path), "prepare creates no directory")
        let target = home.appendingPathComponent(".claude/settings.json")
        let original = try NetworkConfiguration.encode(["custom": ["keep": true], "env": ["TOKEN": "PRIVATE_CODE_SECRET", "BROWSER": "/old/helper", "NO_PROXY": "*,.anthropic.com,git.old", "no_proxy": "10.0.0.8"]])
        try NetworkConfiguration.safeWrite(original, to: target, mode: 0o640)
        let own = try NetworkConfiguration.encode(["httpPort": 7890, "node": "fixture-node", "internalExceptions": "", "future": "PRIVATE_PREF_SECRET"])
        try NetworkConfiguration.safeWrite(own, to: store.preferenceURL)
        let profile = RelayBrowserContract.profile(store)
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(["unrelated": 123, "dns_over_https": ["future": true]]), to: profile.appendingPathComponent("Local State"))
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(["webrtc": ["future": true], "profile": ["avatar": 4]]), to: profile.appendingPathComponent("Default/Preferences"))
        rejects("stale preparation refused") { _ = try RelayCodeConfiguration.apply(input(initial.revision), environment: environment) }
        let prepared = try RelayCodeConfiguration.prepare(input(), environment: environment)
        check(!(try RelayReadOnly.encode(prepared)).contains("PRIVATE_"), "no raw settings or private fields in report")
        let applied = try RelayCodeConfiguration.apply(input(prepared.revision), environment: environment)
        let code = try NetworkConfiguration.json(Data(contentsOf: target)), env = code["env"] as! [String: Any]
        check(env["TOKEN"] as? String == "PRIVATE_CODE_SECRET" && (code["custom"] as? [String: Bool])?["keep"] == true, "unknown Code fields retained")
        check(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].allSatisfy { env[$0] as? String == "http://127.0.0.1:7890" }, "four fixed HTTP proxy variables")
        let bypass = env["NO_PROXY"] as! String
        check(bypass == env["no_proxy"] as? String && bypass.contains("git.old") && bypass.contains("git.corp") && bypass.contains("10.0.0.8") && !bypass.contains("anthropic") && !bypass.contains("*"), "internal exceptions merged and AI bypass removed")
        check(env["BROWSER"] as? String == context.browserExecutable, "absolute helper path with spaces retained verbatim")
        check(try RelayBrowserContract.policyReady(profile), "browser DNS and WebRTC policies installed")
        let state = try NetworkConfiguration.json(Data(contentsOf: profile.appendingPathComponent("Local State")))
        check(state["unrelated"] as? Int == 123 && (state["dns_over_https"] as? [String: Any])?["future"] as? Bool == true, "unrelated browser fields retained")
        check((try NetworkConfiguration.json(Data(contentsOf: store.preferenceURL)))["future"] as? String == "PRIVATE_PREF_SECRET", "unknown own preferences retained")
        check(try store.load().revision == applied.preferenceSnapshot.revision, "commit returns matching preference revision without reread")
        let second = try RelayCodeConfiguration.prepare(input(), environment: environment)
        check(second.changedTargets.isEmpty && !second.canApply, "already matching config needs no transaction")
        rejects("old proof cannot be replayed") { _ = try RelayCodeConfiguration.apply(input(prepared.revision), environment: environment) }
        let backup = store.root.appendingPathComponent("Backups").appendingPathComponent(applied.backupId)
        let manifestData = try Data(contentsOf: backup.appendingPathComponent("manifest.json"))
        let manifest = try JSONDecoder().decode(BackupManifest.self, from: manifestData)
        let installed = manifest.entries[0].installedEnvironment
        check(installed?.count == 7 && NetworkConfiguration.claudeEnvironmentKeys.allSatisfy { installed?[$0] == env[$0] as? String }, "backup pins exactly the seven installed Code environment fields")
        check(manifest.entries.dropFirst().allSatisfy { $0.installedEnvironment == nil } && installed?["TOKEN"] == nil, "backup does not duplicate private credentials or unrelated file fields")
        var legacyManifest = try NetworkConfiguration.json(manifestData)
        var legacyEntries = legacyManifest["entries"] as! [[String: Any]]
        legacyEntries[0].removeValue(forKey: "installedEnvironment"); legacyManifest["entries"] = legacyEntries
        let legacyDecoded = try JSONDecoder().decode(BackupManifest.self, from: NetworkConfiguration.encode(legacyManifest))
        check(legacyDecoded.entries[0].installedEnvironment == nil && legacyDecoded.entries[0].installedDigest == manifest.entries[0].installedDigest, "older backup schema remains readable without invented installed values")
        let recoveryInput = RelayRecoveryPreflightInput(context: context.state, selection: RelayRecoverySelection(source: "relay", id: applied.backupId))
        let report = try RelayRecoveryInspector.inspect(recoveryInput, browserObservation: { _ in "closed" })
        check(report.fileChecksPassed && report.targets.count == 4, "new config is fully covered by scoped recovery")
        _ = try RelayRestore.execute(RelayRestoreInput(context: context.state, selection: report.selection, expectedRevision: report.revision, allowLegacy: false), browserObservation: { _ in "closed" })
        check(try Data(contentsOf: target) == original && Data(contentsOf: store.preferenceURL) == own, "joint recovery restores original Code and preferences")
        check(fm.fileExists(atPath: backup.appendingPathComponent("manifest.json").path), "backup retained")
        environment.browserState = { _ in "running" }
        check(try !RelayCodeConfiguration.prepare(input(), environment: environment).canApply, "running browser blocks apply")
        environment.browserState = { _ in "unknown" }
        check(try RelayCodeConfiguration.prepare(input(), environment: environment).browserState == "unconfirmed", "unknown process state not closed")
        environment.browserState = { _ in "closed" }; environment.helperDigest = { _ in nil }
        check(try !RelayCodeConfiguration.prepare(input(), environment: environment).helperReady, "missing helper blocks apply")
        environment.helperDigest = { _ in String(repeating: "a", count: 64) }
        let fresh = try RelayCodeConfiguration.prepare(input(), environment: environment)
        rejects("failure during write triggers rollback") {
            _ = try RelayCodeConfiguration.apply(input(fresh.revision), environment: environment, beforeEntry: { if $0 == 2 { throw AssistantError("fixture failure") } })
        }
        check(try Data(contentsOf: target) == original && Data(contentsOf: store.preferenceURL) == own, "failed joint apply rolls back only written files")
        let latest = try RelayCodeConfiguration.prepare(input(), environment: environment)
        rejects("later target edit is preserved") {
            _ = try RelayCodeConfiguration.apply(input(latest.revision), environment: environment, beforeEntry: { if $0 == 0 { try NetworkConfiguration.safeWrite(Data("later edit".utf8), to: target) } })
        }
        check(try Data(contentsOf: target) == Data("later edit".utf8), "external file not replaced or rolled back")
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(["env": ["NO_PROXY": ["invalid"]]]), to: target)
        rejects("malformed bypass never silently dropped") { _ = try RelayCodeConfiguration.prepare(input(), environment: environment) }
        try NetworkConfiguration.safeWrite(original, to: target)
        let helperProof = try RelayCodeConfiguration.prepare(input(), environment: environment)
        environment.helperDigest = { _ in String(repeating: "b", count: 64) }
        rejects("helper changed after preparation") { _ = try RelayCodeConfiguration.apply(input(helperProof.revision), environment: environment) }
        environment.helperDigest = { _ in String(repeating: "a", count: 64) }
        let lockProof = try RelayCodeConfiguration.prepare(input(), environment: environment)
        try RelayStateLock(root: store.root).withLock {
            rejects("apply respects shared state lock") { _ = try RelayCodeConfiguration.apply(input(lockProof.revision), environment: environment) }
        }
        var closed = true
        environment.browserState = { _ in closed ? "closed" : "running" }
        let crashProof = try RelayCodeConfiguration.prepare(input(), environment: environment)
        rejects("browser starts after one browser file was written") {
            _ = try RelayCodeConfiguration.apply(input(crashProof.revision), environment: environment, beforeEntry: { if $0 == 3 { closed = false } })
        }
        check(store.transactionBackend().backupMetadata().entries.first?.phase == "recoveryNeeded", "unsafe browser rollback leaves recoverable journal")
        check(try Data(contentsOf: target) == original && Data(contentsOf: store.preferenceURL) == own, "non-browser rollback still restores Code and parameters")
        closed = true
        let pending = store.transactionBackend().backupMetadata().entries.first!
        let resume = try RelayRecoveryInspector.inspect(RelayRecoveryPreflightInput(context: context.state, selection: RelayRecoverySelection(source: "relay", id: pending.id)), browserObservation: { _ in "closed" })
        _ = try RelayRestore.execute(RelayRestoreInput(context: context.state, selection: resume.selection, expectedRevision: resume.revision, allowLegacy: false), browserObservation: { _ in "closed" })
        check(try Data(contentsOf: target) == original && store.transactionBackend().backupMetadata().entries.first?.phase == "restored", "fresh preflight recovers interrupted browser write")
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(["webrtc": false]), to: profile.appendingPathComponent("Default/Preferences"))
        rejects("malformed browser policy object not overwritten") { _ = try RelayCodeConfiguration.prepare(input(), environment: environment) }
    } catch { failures.append("unexpected fixture failure: " + error.localizedDescription) }
    print(failures.isEmpty ? "PASS: \(count) Code joint transaction checks; temporary HOME and injected helper/browser observations only." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
