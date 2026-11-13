import Foundation
import Darwin

func runRelayRestoreSelfTests() -> Int32 {
    let fm = FileManager.default
    let sandbox = fm.temporaryDirectory.appendingPathComponent("relay-restore-fixture-" + UUID().uuidString)
    var count = 0, failures: [String] = []
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    func rejects(_ name: String, _ action: () throws -> Void) { do { try action(); check(false, name) } catch { check(true, name) } }
    defer { try? fm.removeItem(at: sandbox) }
    func scenario(_ name: String, _ action: (RelayPreferenceStore, RelayStateContext) throws -> Void) {
        do {
            let folder = sandbox.appendingPathComponent(name)
            try fm.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let home = NetworkConfiguration(home: folder).home
            let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path)
            try action(RelayPreferenceStore(context), context)
        } catch { failures.append(name + ": " + error.localizedDescription) }
    }
    func proof(_ context: RelayStateContext, _ backup: URL, _ source: String = "relay") throws -> RelayRecoveryPreflight {
        try RelayRecoveryInspector.inspect(RelayRecoveryPreflightInput(context: context,
            selection: RelayRecoverySelection(source: source, id: backup.lastPathComponent)), browserObservation: { _ in "closed" })
    }
    func request(_ context: RelayStateContext, _ report: RelayRecoveryPreflight, legacy: Bool = false) -> RelayRestoreInput {
        RelayRestoreInput(context: context, selection: report.selection, expectedRevision: report.revision, allowLegacy: legacy)
    }
    scenario("normal") { store, context in
        let backend = store.transactionBackend(), target = store.home.appendingPathComponent(".claude/settings.json")
        try NetworkConfiguration.safeWrite(Data("before".utf8), to: target, mode: 0o640)
        let backup = try backend.install([(target, Data("after".utf8), 0o600)])
        let p = try proof(context, backup), input = request(context, p)
        check(try RelayRestore.execute(input).status == "restored", "scoped restore completes")
        check(try Data(contentsOf: target) == Data("before".utf8), "original bytes restored")
        check((try fm.attributesOfItem(atPath: target.path)[.posixPermissions] as? NSNumber)?.intValue == 0o640, "original mode restored")
        check(try proof(context, backup).phase == "restored", "journal records completion")
        rejects("single snapshot cannot be replayed") { _ = try RelayRestore.execute(input) }
    }
    scenario("post-confirm-change") { store, context in
        let target = store.home.appendingPathComponent(".claude/settings.json")
        let backup = try store.transactionBackend().install([(target, Data("installed".utf8), 0o600)])
        let p = try proof(context, backup), manifest = backup.appendingPathComponent("manifest.json")
        let bytes = try Data(contentsOf: manifest)
        try NetworkConfiguration.safeWrite(Data("later user edit".utf8), to: target)
        rejects("later edit blocks before journal mutation") { _ = try RelayRestore.execute(request(context, p)) }
        check(try Data(contentsOf: manifest) == bytes && Data(contentsOf: target) == Data("later user edit".utf8), "rejected restore preserves edit and journal")
    }
    scenario("partial-retry") { store, context in
        let a = store.home.appendingPathComponent(".claude/settings.json"), b = store.preferenceURL
        try NetworkConfiguration.safeWrite(Data("old-a".utf8), to: a)
        let backup = try store.transactionBackend().install([(a, Data("new-a".utf8), 0o600), (b, Data("new-b".utf8), 0o600)])
        let p = try proof(context, backup)
        rejects("mid-restore failure retained") {
            _ = try RelayRestore.execute(request(context, p), beforeEntry: { if $0 == 0 { throw AssistantError("fixture interruption") } })
        }
        check(try !fm.fileExists(atPath: b.path) && Data(contentsOf: a) == Data("new-a".utf8), "completed target preserved across interruption")
        let next = try proof(context, backup)
        check(next.phase == "recoveryNeeded" && next.targets[1].current == "original", "partial state recognized")
        _ = try RelayRestore.execute(request(context, next))
        check(try Data(contentsOf: a) == Data("old-a".utf8) && !fm.fileExists(atPath: b.path), "fresh proof resumes remaining targets")
    }
    scenario("concurrent-edit") { store, context in
        let target = store.home.appendingPathComponent(".claude/settings.json")
        let backup = try store.transactionBackend().install([(target, Data("installed".utf8), 0o600)])
        let p = try proof(context, backup)
        rejects("per-entry check catches edit after locked preflight") {
            _ = try RelayRestore.execute(request(context, p), beforeEntry: { _ in try NetworkConfiguration.safeWrite(Data("external edit".utf8), to: target) })
        }
        check(try Data(contentsOf: target) == Data("external edit".utf8) && proof(context, backup).phase == "recoveryNeeded", "later edit is never rolled back by recovery")
    }
    scenario("browser-start") { store, context in
        let target = store.root.appendingPathComponent("Private Browser/Default/Preferences")
        let backup = try store.transactionBackend().install([(target, Data("{}".utf8), 0o600)])
        let p = try proof(context, backup)
        var scans = 0
        rejects("browser starting during restore blocks its write") {
            _ = try RelayRestore.execute(request(context, p), browserObservation: { _ in scans += 1; return scans <= 2 ? "closed" : "running" })
        }
        check(try fm.fileExists(atPath: target.path) && proof(context, backup).phase == "recoveryNeeded", "browser conflict leaves resumable journal")
    }
    scenario("legacy") { store, context in
        let backend = NetworkConfiguration(home: store.home), target = store.home.appendingPathComponent(".claude/settings.json")
        try NetworkConfiguration.safeWrite(Data("legacy-before".utf8), to: target)
        let backup = try backend.install([(target, Data("legacy-after".utf8), 0o600)])
        let manifest = backup.appendingPathComponent("manifest.json")
        var json = try NetworkConfiguration.json(Data(contentsOf: manifest)); json["version"] = 1; json.removeValue(forKey: "phase")
        var entries = json["entries"] as! [[String: Any]]; entries[0].removeValue(forKey: "originalDigest"); entries[0].removeValue(forKey: "installedMode"); json["entries"] = entries
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(json), to: manifest)
        let p = try proof(context, backup, "legacy")
        rejects("legacy requires explicit reviewed flag") { _ = try RelayRestore.execute(request(context, p)) }
        _ = try RelayRestore.execute(request(context, p, legacy: true))
        check(try Data(contentsOf: target) == Data("legacy-before".utf8), "explicitly reviewed legacy restored")
        check(try proof(context, backup, "legacy").phase == "restored", "legacy upgrade happens only on explicit restore")
    }
    scenario("locks-and-scope") { store, context in
        let target = store.home.appendingPathComponent(".claude/settings.json")
        let backup = try store.transactionBackend().install([(target, Data("installed".utf8), 0o600)])
        let p = try proof(context, backup)
        try RelayStateLock(root: store.root).withLock {
            rejects("restore respects shared lock") { _ = try RelayRestore.execute(request(context, p)) }
        }
        check(fm.fileExists(atPath: target.path), "busy lock preserves target")
        let outside = store.home.appendingPathComponent(".ssh/id_rsa")
        let bad = try store.transactionBackend().install([(outside, Data("fixture-key".utf8), 0o600)])
        let scoped = try proof(context, bad)
        rejects("explicit request cannot bypass exact target scope") { _ = try RelayRestore.execute(request(context, scoped, legacy: true)) }
        check(try Data(contentsOf: outside) == Data("fixture-key".utf8), "outside target untouched")
    }
    print(failures.isEmpty ? "PASS: \(count) scoped restore checks; temporary HOME and injected browser observations only." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
