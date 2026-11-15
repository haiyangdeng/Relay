import Foundation
import Darwin

func runTransactionRegressionTests() -> Int32 {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("AI-Transaction-Regression-" + UUID().uuidString, isDirectory: true)
    var checks = 0
    var failures: [String] = []
    func check(_ condition: Bool, _ message: String) throws {
        checks += 1
        if !condition { throw AssistantError(message) }
    }
    func rejected(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
    func write(_ url: URL, _ value: String) throws { try NetworkConfiguration.safeWrite(Data(value.utf8), to: url) }
    func value(_ url: URL) throws -> String { String(decoding: try Data(contentsOf: url), as: UTF8.self) }
    func manifest(_ directory: URL) throws -> BackupManifest {
        try JSONDecoder().decode(BackupManifest.self, from: Data(contentsOf: directory.appendingPathComponent("manifest.json")))
    }
    func scenario(_ name: String, _ body: (NetworkConfiguration) throws -> Void) {
        do {
            let home = root.appendingPathComponent(name, isDirectory: true)
            try fm.createDirectory(at: home, withIntermediateDirectories: true)
            try body(NetworkConfiguration(home: home))
        } catch { failures.append(name + ": " + error.localizedDescription) }
    }
    do { try fm.createDirectory(at: root, withIntermediateDirectories: true) }
    catch { print("FAIL: cannot create transaction fixtures"); return 1 }
    defer { try? fm.removeItem(at: root) }

    scenario("safe-write-atomic") { b in
        let target = b.home.appendingPathComponent("settings.json")
        try write(target, "old")
        let before = Set(try fm.contentsOfDirectory(atPath: b.home.path))
        try check(rejected { try NetworkConfiguration.safeWrite(Data("new".utf8), to: target, mode: -1) }, "invalid mode rejected before commit")
        try check(try value(target) == "old", "failed safe write preserves original bytes")
        try check(Set(try fm.contentsOfDirectory(atPath: b.home.path)) == before, "failed safe write leaves no temporary file")
        try NetworkConfiguration.safeWrite(Data("new".utf8), to: target, mode: 0o640)
        let mode = try fm.attributesOfItem(atPath: target.path)[.posixPermissions] as? NSNumber
        try check(try value(target) == "new" && mode?.intValue == 0o640, "data and requested permissions committed together")
        try check(Set(try fm.contentsOfDirectory(atPath: b.home.path)) == before, "successful safe write leaves no temporary file")
        try NetworkConfiguration.safeWrite(Data(), to: target)
        try check(try Data(contentsOf: target).isEmpty, "empty data commits correctly")
        try check(Set(try fm.contentsOfDirectory(atPath: b.home.path)) == before, "empty safe write leaves no temporary file")
    }
    scenario("safe-write-directory-target") { b in
        let target = b.home.appendingPathComponent("settings.json")
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        let before = Set(try fm.contentsOfDirectory(atPath: b.home.path))
        try check(rejected { try NetworkConfiguration.safeWrite(Data("new".utf8), to: target) }, "directory target rejected")
        let type = try fm.attributesOfItem(atPath: target.path)[.type] as? FileAttributeType
        try check(type == .typeDirectory, "directory target is never replaced")
        try check(Set(try fm.contentsOfDirectory(atPath: b.home.path)) == before, "directory rejection leaves no temporary file")
    }
    scenario("safe-write-read-only-directory") { b in
        let target = b.home.appendingPathComponent("settings.json")
        try write(target, "old")
        let before = Set(try fm.contentsOfDirectory(atPath: b.home.path))
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: b.home.path)
        defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: b.home.path) }
        try check(rejected { try NetworkConfiguration.safeWrite(Data("new".utf8), to: target) }, "read-only parent fails without commit")
        try check(try value(target) == "old", "read-only parent preserves original bytes")
        try check(Set(try fm.contentsOfDirectory(atPath: b.home.path)) == before, "read-only failure leaves no temporary file")
    }
    scenario("failed-install") { b in
        let a = b.home.appendingPathComponent("a.json")
        let locked = b.home.appendingPathComponent("locked")
        let middle = locked.appendingPathComponent("b.json")
        try write(a, "old-a"); try write(middle, "old-b")
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked.path)
        defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }
        try check(rejected { _ = try b.install([(a, Data("new-a".utf8), 0o600), (middle, Data("new-b".utf8), 0o600)]) }, "failure injected")
        let unchanged = try value(a) == "old-a" && value(middle) == "old-b"
        try check(unchanged, "rollback original bytes")
        try check(b.latestBackup() == nil, "fully rolled back is not recoverable candidate")
    }
    scenario("partial-restore") { b in
        let a = b.home.appendingPathComponent("a.json"), locked = b.home.appendingPathComponent("locked")
        let middle = locked.appendingPathComponent("b.json"), c = b.home.appendingPathComponent("c.json")
        try write(a, "old-a"); try write(middle, "old-b"); try write(c, "old-c")
        let backup = try b.install([(a, Data("new-a".utf8), 0o600), (middle, Data("new-b".utf8), 0o600), (c, Data("new-c".utf8), 0o600)])
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked.path)
        defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }
        try check(rejected { try b.restore(backup) }, "restore failure injected")
        let intermediate = try value(a) == "new-a" && value(middle) == "new-b" && value(c) == "old-c"
        try check(intermediate, "fixture actually reached partial restore")
        try check(b.backupRecoveryPending(backup), "pending recovery visible")
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path)
        try b.restore(backup)
        let restored = try value(a) == "old-a" && value(middle) == "old-b" && value(c) == "old-c"
        try check(restored, "restore retry succeeds")
        try check(b.latestBackup() == nil, "restored transaction excluded")
        try b.restore(backup)
        try check(try value(c) == "old-c", "repeat restore is harmless")
    }
    scenario("partial-user-edit") { b in
        let a = b.home.appendingPathComponent("a.json"), locked = b.home.appendingPathComponent("locked")
        let middle = locked.appendingPathComponent("b.json"), c = b.home.appendingPathComponent("c.json")
        try write(a, "old-a"); try write(middle, "old-b"); try write(c, "old-c")
        let backup = try b.install([(a, Data("new-a".utf8), 0o600), (middle, Data("new-b".utf8), 0o600), (c, Data("new-c".utf8), 0o600)])
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked.path)
        defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }
        _ = rejected { try b.restore(backup) }
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path)
        try write(c, "later-user-edit")
        try check(rejected { try b.restore(backup) }, "later user edit stops retry")
        let intact = try value(a) == "new-a" && value(middle) == "new-b" && value(c) == "later-user-edit"
        try check(intact, "preflight stops before any further write")
    }
    scenario("partial-delete-new-file") { b in
        let locked = b.home.appendingPathComponent("locked"), c = b.home.appendingPathComponent("new.json")
        let middle = locked.appendingPathComponent("b.json")
        try write(middle, "old-b")
        let backup = try b.install([(middle, Data("new-b".utf8), 0o600), (c, Data("new-c".utf8), 0o600)])
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked.path)
        defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }
        try check(rejected { try b.restore(backup) }, "delete then fail")
        try check(!fm.fileExists(atPath: c.path), "new file already removed")
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path)
        try b.restore(backup)
        try check(try value(middle) == "old-b", "retry accepts already absent new file")
    }
    scenario("corrupt-original") { b in
        let a = b.home.appendingPathComponent("a.json"), c = b.home.appendingPathComponent("c.json")
        try write(a, "old-a"); try write(c, "old-c")
        let backup = try b.install([(a, Data("new-a".utf8), 0o600), (c, Data("new-c".utf8), 0o600)])
        try write(backup.appendingPathComponent("original-0.bin"), "CORRUPTED")
        try check(rejected { try b.restore(backup) }, "corrupted original rejected")
        let intact = try value(a) == "new-a" && value(c) == "new-c"
        try check(intact, "all originals checked before any target write")
    }
    scenario("corrupt-mode-preflight") { b in
        let a = b.home.appendingPathComponent("a.json"), c = b.home.appendingPathComponent("c.json")
        try write(a, "old-a"); try write(c, "old-c")
        let backup = try b.install([(a, Data("new-a".utf8), 0o600), (c, Data("new-c".utf8), 0o600)])
        let url = backup.appendingPathComponent("manifest.json")
        var journal = try NetworkConfiguration.json(Data(contentsOf: url))
        var entries = journal["entries"] as! [[String: Any]]
        entries[0]["originalMode"] = 0o4000; journal["entries"] = entries
        try NetworkConfiguration.safeWrite(try NetworkConfiguration.encode(journal), to: url)
        try check(rejected { try b.restore(backup) }, "invalid permission journal rejected")
        let intact = try value(a) == "new-a" && value(c) == "new-c"
        try check(intact, "all permission records checked before any target write")
    }
    scenario("atomic-preferences") { b in
        let settingsFile = b.claudeSettings
        try write(settingsFile, "{\"env\":{\"CUSTOM\":\"keep\"}}")
        let before = try Data(contentsOf: settingsFile)
        let prefs = b.support.appendingPathComponent("preferences.json")
        try fm.createDirectory(at: prefs, withIntermediateDirectories: true)
        var settings = AssistantSettings(); settings.httpPort = 8888; settings.node = "fixture-node"
        try check(rejected { _ = try b.applyClaudeCode(settings) }, "invalid preferences target rejected")
        try check(try Data(contentsOf: settingsFile) == before, "Claude settings unchanged when preferences cannot be committed")
        try check(!fm.fileExists(atPath: b.browserProfile.appendingPathComponent("Local State").path), "browser settings unchanged on preflight failure")
    }
    scenario("preferences-rollback") { b in
        var settings = AssistantSettings(); settings.httpPort = 8888; settings.node = "fixture-node"
        let backup = try b.applyClaudeCode(settings)
        try check(b.readSavedSettings().httpPort == 8888, "preferences committed in same transaction")
        try b.restore(backup)
        try check(b.readSavedSettings().httpPort == 7890 && !fm.fileExists(atPath: b.claudeSettings.path), "preferences and Claude settings restored together")
    }
    scenario("backup-order") { b in
        let target = b.home.appendingPathComponent("settings.json"); try write(target, "original")
        var lastOrder: UInt64 = 0
        for n in 0..<12 {
            let backup = try b.install([(target, Data("version-\(n)".utf8), 0o600)])
            try check(b.latestBackup() == backup, "latest means most recently completed transaction")
            let order = try manifest(backup).order ?? 0
            try check(order > lastOrder, "strictly increasing order independent of UUID")
            lastOrder = order
        }
    }
    scenario("prepared-recovery") { b in
        let target = b.home.appendingPathComponent("settings.json"); try write(target, "old")
        let backup = try b.install([(target, Data("new".utf8), 0o600)])
        var journal = try manifest(backup); journal.phase = "prepared"
        try NetworkConfiguration.safeWrite(try JSONEncoder().encode(journal), to: backup.appendingPathComponent("manifest.json"))
        try check(b.latestBackup() == backup && b.backupRecoveryPending(backup), "prepared crash record remains visible")
        try b.restore(backup)
        try check(try value(target) == "old", "prepared journal can recover")
    }
    scenario("legacy") { b in
        let target = b.home.appendingPathComponent("settings.json"); try write(target, "new")
        let backup = b.support.appendingPathComponent("Backups/legacy")
        try write(backup.appendingPathComponent("original-0.bin"), "old")
        let entry = BackupEntry(path: target.path, originalExists: true, originalMode: 0o600, backupName: "original-0.bin", installedDigest: NetworkConfiguration.digest(Data("new".utf8)), originalDigest: nil, installedMode: nil)
        let journal = BackupManifest(version: 1, createdAt: "legacy", entries: [entry], phase: nil, order: nil)
        try NetworkConfiguration.safeWrite(try JSONEncoder().encode(journal), to: backup.appendingPathComponent("manifest.json"))
        try check(b.latestBackup()?.standardizedFileURL.path == backup.standardizedFileURL.path, "legacy backup remains listed")
        try check(try b.backupRequiresLegacyConfirmation(backup), "legacy trust confirmation required")
        try check(rejected { try b.restore(backup) }, "legacy not silently trusted")
        try check(try value(target) == "new", "legacy rejection leaves target unchanged")
        try b.restore(backup, allowLegacy: true)
        try check(try value(target) == "old", "explicitly trusted legacy can restore")
    }
    scenario("symlink-backup") { b in
        let target = b.home.appendingPathComponent("settings.json"); try write(target, "old")
        let backup = try b.install([(target, Data("new".utf8), 0o600)])
        let original = backup.appendingPathComponent("original-0.bin"), alternate = b.home.appendingPathComponent("alternate")
        try write(alternate, "old"); try fm.removeItem(at: original); try fm.createSymbolicLink(at: original, withDestinationURL: alternate)
        try check(rejected { try b.restore(backup) }, "symlink original refused")
        try check(try value(target) == "new", "symlink rejection before writes")
    }
    scenario("duplicate-target") { b in
        let target = b.home.appendingPathComponent("settings.json"); try write(target, "old")
        try check(rejected { _ = try b.install([(target, Data("one".utf8), 0o600), (target, Data("two".utf8), 0o600)]) }, "duplicate target rejected")
        try check(try value(target) == "old", "duplicate rejection preserves original")
    }
    scenario("later-permissions") { b in
        let target = b.home.appendingPathComponent("settings.json"); try write(target, "old")
        let backup = try b.install([(target, Data("new".utf8), 0o600)])
        try fm.setAttributes([.posixPermissions: 0o400], ofItemAtPath: target.path)
        try check(rejected { try b.restore(backup) }, "later permission edit preserved")
        try check(try value(target) == "new", "permission conflict has no byte writes")
    }
    print(failures.isEmpty ? "PASS: \(checks) transaction regression checks; fixture HOME only." : "FAIL: " + failures.joined(separator: " | "))
    return failures.isEmpty ? 0 : 1
}
