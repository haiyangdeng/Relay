import Foundation
import Darwin

func runRelayRecoveryPreflightSelfTests() -> Int32 {
    let fm = FileManager.default
    let sandbox = fm.temporaryDirectory.appendingPathComponent("relay-preflight-fixture-" + UUID().uuidString)
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    func rejects(_ name: String, _ operation: () throws -> Void) { do { try operation(); check(false, name) } catch { check(true, name) } }
    defer { try? fm.removeItem(at: sandbox) }
    do {
        try fm.createDirectory(at: sandbox, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = NetworkConfiguration(home: sandbox).home
        let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path)
        let store = try RelayPreferenceStore(context), backend = store.transactionBackend()
        let client = home.appendingPathComponent(".claude/settings.json")
        let before = Data("PRIVATE_CLIENT_BEFORE".utf8), after = Data("PRIVATE_CLIENT_AFTER".utf8)
        try NetworkConfiguration.safeWrite(before, to: client, mode: 0o640)
        let backup = try backend.install([(client, after, 0o600)])
        let selection = RelayRecoverySelection(source: "relay", id: backup.lastPathComponent)
        let input = RelayRecoveryPreflightInput(context: context, selection: selection)
        let manifestURL = backup.appendingPathComponent("manifest.json"), originalURL = backup.appendingPathComponent("original-0.bin")
        let manifestBytes = try Data(contentsOf: manifestURL)
        func edit(_ mutate: (inout [String: Any]) -> Void) throws {
            var json = try NetworkConfiguration.json(manifestBytes); mutate(&json)
            try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(json), to: manifestURL)
        }
        let clean = try RelayRecoveryInspector.inspect(input)
        check(clean.fileChecksPassed && clean.issues.isEmpty && clean.targets.first?.original == "verified" && clean.targets.first?.current == "installed", "valid file preflight")
        check(clean.snapshotOnly && !clean.restoreEnabled && clean.browser == "notApplicable", "snapshot never enables restore")
        let text = try RelayReadOnly.encode(clean)
        check(!text.contains(home.path) && !text.contains("PRIVATE_CLIENT"), "no paths or file bytes returned")
        check(try Data(contentsOf: manifestURL) == manifestBytes && Data(contentsOf: client) == after && Data(contentsOf: originalURL) == before, "inspection leaves all bytes unchanged")
        try NetworkConfiguration.safeWrite(Data("USER_LATER_CHANGE".utf8), to: client)
        let changed = try RelayRecoveryInspector.inspect(input)
        check(changed.issues.contains("targetChanged") && !changed.fileChecksPassed && changed.revision != clean.revision, "later content edit rejected and snapshot changes")
        try NetworkConfiguration.safeWrite(after, to: client, mode: 0o640)
        check(try RelayRecoveryInspector.inspect(input).issues.contains("targetChanged"), "later mode edit rejected")
        try NetworkConfiguration.safeWrite(before, to: client, mode: 0o640)
        check(try RelayRecoveryInspector.inspect(input).targets.first?.current == "original", "partially restored original recognized")
        try fm.removeItem(at: client)
        check(try RelayRecoveryInspector.inspect(input).issues.contains("targetChanged"), "missing originally existing target rejected")
        try NetworkConfiguration.safeWrite(after, to: client)
        try NetworkConfiguration.safeWrite(Data("CORRUPT".utf8), to: originalURL)
        check(try RelayRecoveryInspector.inspect(input).issues.contains("originalInvalid"), "corrupt original rejected")
        try fm.removeItem(at: originalURL)
        check(try RelayRecoveryInspector.inspect(input).issues.contains("originalInvalid"), "missing original rejected")
        try NetworkConfiguration.safeWrite(before, to: originalURL)
        try edit { json in
            var entries = json["entries"] as! [[String: Any]]; entries[0]["backupName"] = "../preferences.json"; json["entries"] = entries
        }
        check(try RelayRecoveryInspector.inspect(input).issues.contains("originalInvalid"), "backup traversal refused")
        try edit { json in
            var entries = json["entries"] as! [[String: Any]]; entries[0]["path"] = home.appendingPathComponent(".ssh/id_rsa").path; json["entries"] = entries
        }
        let scope = try RelayRecoveryInspector.inspect(input)
        check(scope.issues.contains("targetOutsideScope") && scope.targets.first?.target == "unknown" && !scope.fileChecksPassed, "home prefix alone does not authorize a target")
        try edit { json in var entries = json["entries"] as! [[String: Any]]; entries.append(entries[0]); json["entries"] = entries }
        check(try RelayRecoveryInspector.inspect(input).issues.contains("manifestInvalid"), "duplicate targets refused")
        try edit { json in var entries = json["entries"] as! [[String: Any]]; entries[0].removeValue(forKey: "originalDigest"); json["entries"] = entries }
        check(try RelayRecoveryInspector.inspect(input).issues.contains("originalInvalid"), "v2 requires original digest")
        try edit { $0["version"] = 99 }
        check(try RelayRecoveryInspector.inspect(input).version == 0, "unknown version stays unreadable")
        try edit { json in var entries = json["entries"] as! [[String: Any]]; entries[0].removeValue(forKey: "installedMode"); json["entries"] = entries }
        let unknownMode = try RelayRecoveryInspector.inspect(input)
        check(unknownMode.version == 2 && unknownMode.targets.first?.current == "unverifiedMode" && unknownMode.issues.contains("targetModeUnknown") && !unknownMode.fileChecksPassed, "upgraded legacy journal with missing installed mode remains unverified")
        try edit { $0["phase"] = "restored" }
        check(try RelayRecoveryInspector.inspect(input).issues.contains("transactionFinished"), "finished transaction not offered again")
        try NetworkConfiguration.safeWrite(manifestBytes, to: manifestURL)
        try fm.removeItem(at: client); try fm.createSymbolicLink(at: client, withDestinationURL: originalURL)
        check(try RelayRecoveryInspector.inspect(input).issues.contains("targetOutsideScope"), "target symlink refused before content read")
        try fm.removeItem(at: client); try NetworkConfiguration.safeWrite(after, to: client)
        try fm.removeItem(at: originalURL); try fm.createSymbolicLink(at: originalURL, withDestinationURL: client)
        check(try RelayRecoveryInspector.inspect(input).issues.contains("originalInvalid"), "original symlink refused")
        try fm.removeItem(at: originalURL); try NetworkConfiguration.safeWrite(before, to: originalURL)
        try NetworkConfiguration.safeWrite(Data(repeating: 65, count: 1048577), to: manifestURL)
        check(try RelayRecoveryInspector.inspect(input).issues.contains("manifestInvalid"), "oversized manifest bounded")
        try NetworkConfiguration.safeWrite(manifestBytes, to: manifestURL)
        for id in ["..", ".hidden", "a/b", "a\\b", "a\n", String(repeating: "a", count: 201)] {
            rejects("invalid record basename") { _ = try RelayRecoveryInspector.inspect(RelayRecoveryPreflightInput(context: context, selection: RelayRecoverySelection(source: "relay", id: id))) }
        }
        rejects("unknown source") { _ = try RelayRecoverySelection(source: "other", id: "record").validate() }
        let missing = RelayRecoveryPreflightInput(context: context, selection: RelayRecoverySelection(source: "relay", id: "missing"))
        check(try RelayRecoveryInspector.inspect(missing).issues == ["manifestInvalid"], "missing record explicitly unreadable")

        let absent = store.root.appendingPathComponent("preferences.json")
        let absentBackup = try backend.install([(absent, Data("{}".utf8), 0o600)])
        let absentInput = RelayRecoveryPreflightInput(context: context, selection: RelayRecoverySelection(source: "relay", id: absentBackup.lastPathComponent))
        check(try RelayRecoveryInspector.inspect(absentInput).targets.first?.original == "absent", "original absence recorded")
        try fm.removeItem(at: absent)
        check(try RelayRecoveryInspector.inspect(absentInput).targets.first?.current == "original", "already removed new target recognized")

        let legacy = NetworkConfiguration(home: home)
        let legacyBackup = try legacy.install([(client, Data("legacy".utf8), 0o600)])
        let legacyManifest = legacyBackup.appendingPathComponent("manifest.json")
        var old = try NetworkConfiguration.json(Data(contentsOf: legacyManifest))
        old["version"] = 1; old.removeValue(forKey: "phase")
        var oldEntries = old["entries"] as! [[String: Any]]; oldEntries[0].removeValue(forKey: "originalDigest"); oldEntries[0].removeValue(forKey: "installedMode"); old["entries"] = oldEntries
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(old), to: legacyManifest)
        let oldBytes = try Data(contentsOf: legacyManifest)
        let oldInput = RelayRecoveryPreflightInput(context: context, selection: RelayRecoverySelection(source: "legacy", id: legacyBackup.lastPathComponent))
        let oldReport = try RelayRecoveryInspector.inspect(oldInput)
        check(oldReport.requiresLegacyConfirmation && oldReport.targets.first?.original == "unverifiedLegacy" && oldReport.issues.contains("legacyConfirmationRequired"), "legacy originals never called digest-verified")
        check(try Data(contentsOf: legacyManifest) == oldBytes && !oldReport.restoreEnabled, "legacy preflight does not upgrade or authorize")

        let browser = store.root.appendingPathComponent("Private Browser/Default/Preferences")
        let browserBackup = try backend.install([(browser, Data("{}".utf8), 0o600)])
        let browserInput = RelayRecoveryPreflightInput(context: context, selection: RelayRecoverySelection(source: "relay", id: browserBackup.lastPathComponent))
        check(try RelayRecoveryInspector.inspect(browserInput, browserObservation: { _ in "running" }).issues.contains("browserRunning"), "running browser blocks future restore")
        check(try RelayRecoveryInspector.inspect(browserInput, browserObservation: { _ in "unknown" }).browser == "unconfirmed", "no process proof cannot claim browser is closed")

        let baseline = try store.load()
        try RelayStateLock(root: store.root).withLock {
            rejects("shared lock blocks preferences") { _ = try store.save(baseline.preferences, expectedRevision: baseline.revision) }
            rejects("shared lock blocks install") { _ = try backend.install([(client, after, 0o600)]) }
            rejects("shared lock blocks restore") { try backend.restore(absentBackup) }
            check(try RelayRecoveryInspector.inspect(oldInput).requiresLegacyConfirmation, "readonly preflight needs no write lock")
        }
        let journalLock = store.root.appendingPathComponent("Backups/.transaction.lock")
        let fd = Darwin.open(journalLock.path, O_RDWR | O_NOFOLLOW)
        guard fd >= 0 else { throw AssistantError("fixture journal lock unavailable") }
        defer { Darwin.close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw AssistantError("fixture journal lock busy") }
        rejects("new writer still respects older journal lock") { _ = try backend.install([(client, after, 0o600)]) }
        let saved = try store.save(baseline.preferences, expectedRevision: baseline.revision)
        check(saved.source == "relay", "failed journal lock releases shared state lock")
    } catch { failures.append("unexpected fixture failure: " + error.localizedDescription) }
    print(failures.isEmpty ? "PASS: \(count) Relay recovery preflight and shared-lock checks; temporary HOME only." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
