import Foundation

func runRelayRecoverySelfTests() -> Int32 {
    let fm = FileManager.default
    let directory = fm.temporaryDirectory.appendingPathComponent("relay-recovery-fixture-" + UUID().uuidString)
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    defer { try? fm.removeItem(at: directory) }
    do {
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = NetworkConfiguration(home: directory).home
        let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path)
        let paths = try RelayPreferenceStore(context)
        let empty = try RelayRecovery.status(context)
        check(empty.inventories.allSatisfy { $0.availability == "missing" && $0.entries.isEmpty }, "missing roots reported separately")
        check(!fm.fileExists(atPath: paths.root.path) && !fm.fileExists(atPath: paths.legacyRoot.path), "metadata read creates no state")
        let backend = NetworkConfiguration(home: home, supportRoot: paths.root)
        let target = home.appendingPathComponent("fixture-client.json")
        try NetworkConfiguration.safeWrite(Data("before".utf8), to: target)
        let backup = try backend.install([(target, Data("after".utf8), 0o600)])
        var inventory = backend.backupMetadata()
        check(inventory.source == "relay" && inventory.complete && inventory.entries.first?.phase == "committed", "Relay journal metadata")
        check(inventory.entries.first?.targetCount == 1 && inventory.entries.first?.id == backup.lastPathComponent, "only journal IDs and counts")
        try NetworkConfiguration.safeWrite(Data("corrupt-original-fixture".utf8), to: backup.appendingPathComponent("original-0.bin"))
        inventory = backend.backupMetadata()
        check(inventory.entries.first?.phase == "committed", "metadata does not pretend to check original contents")
        let manifestURL = backup.appendingPathComponent("manifest.json")
        var manifest = try NetworkConfiguration.json(Data(contentsOf: manifestURL))
        manifest["phase"] = "prepared"
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(manifest), to: manifestURL)
        let pendingBytes = try Data(contentsOf: manifestURL)
        check(backend.backupMetadata().entries.first?.phase == "prepared", "pending phase visible")
        check(try Data(contentsOf: manifestURL) == pendingBytes && Data(contentsOf: target) == Data("after".utf8), "inspection does not recover or repair")
        try NetworkConfiguration.safeWrite(Data("SECRET_BROKEN_JOURNAL".utf8), to: manifestURL)
        inventory = backend.backupMetadata()
        check(!inventory.complete && inventory.entries.first?.phase == "unreadable", "invalid record is not ignored")
        let legacy = NetworkConfiguration(home: home)
        let oldBackup = try legacy.install([(home.appendingPathComponent("legacy-target.json"), Data("legacy installed".utf8), 0o600)])
        let oldManifestURL = oldBackup.appendingPathComponent("manifest.json")
        var old = try NetworkConfiguration.json(Data(contentsOf: oldManifestURL))
        old["version"] = 1; old.removeValue(forKey: "phase")
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(old), to: oldManifestURL)
        let oldBytes = try Data(contentsOf: oldManifestURL)
        let report = try RelayRecovery.status(context)
        check(report.inventories.last?.entries.first?.phase == "legacy", "legacy requires separate review")
        check(try Data(contentsOf: oldManifestURL) == oldBytes, "legacy journal never upgraded by inspection")
        let encoded = try RelayReadOnly.encode(report)
        check(report.metadataOnly && report.restoreEnabled && !encoded.contains(target.path) && !encoded.contains("SECRET_BROKEN_JOURNAL"), "metadata exposes capability, not target paths or raw content")
        try fm.removeItem(at: paths.legacyRoot.appendingPathComponent("Backups"))
        try NetworkConfiguration.safeWrite(Data("not a directory".utf8), to: paths.legacyRoot.appendingPathComponent("Backups"))
        let unavailable = legacy.backupMetadata()
        check(unavailable.availability == "unreadable" && !unavailable.complete, "unreadable root is not an empty healthy list")
    } catch { failures.append("unexpected fixture failure") }
    print(failures.isEmpty ? "PASS: \(count) Relay recovery metadata checks; fixture HOME only, no actual restore or user configuration accessed." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
