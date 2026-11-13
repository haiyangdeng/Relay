import Foundation
import Darwin

func runRelayPreferenceSelfTests() -> Int32 {
    let fm = FileManager.default
    let sandbox = fm.temporaryDirectory.appendingPathComponent("relay-preferences-fixture-" + UUID().uuidString)
    var failures: [String] = []
    var count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    func rejects(_ name: String, _ operation: () throws -> Void) {
        do { try operation(); check(false, name) } catch { check(true, name) }
    }
    defer { try? fm.removeItem(at: sandbox) }
    do {
        try fm.createDirectory(at: sandbox, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = NetworkConfiguration(home: sandbox).home
        let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path)
        let store = try RelayPreferenceStore(context)
        let initial = try store.load()
        check(initial.source == "defaults" && initial.preferences.httpPort == 7890, "missing state uses defaults")
        check(!fm.fileExists(atPath: store.root.path), "reading creates no directory or lock")
        let legacyURL = store.legacyRoot.appendingPathComponent("preferences.json")
        let legacy = try NetworkConfiguration.encode(["httpPort": 8888, "node": "fixture-node", "internalExceptions": "git.corp", "TOKEN": "OLD_SECRET_NOT_IMPORTED"])
        try NetworkConfiguration.safeWrite(legacy, to: legacyURL, mode: 0o640)
        let inherited = try store.load()
        check(inherited.source == "legacy" && inherited.preferences.httpPort == 8888 && !inherited.warnings.isEmpty, "read-only legacy compatibility")
        rejects("legacy edit invalidates old revision") { _ = try store.save(initial.preferences, expectedRevision: initial.revision) }
        check(!fm.fileExists(atPath: store.preferenceURL.path), "stale save did not create preferences")
        let client = home.appendingPathComponent(".claude/settings.json")
        let clientData = Data("client fixture unchanged".utf8)
        try NetworkConfiguration.safeWrite(clientData, to: client)
        let saved = try store.save(inherited.preferences, expectedRevision: inherited.revision)
        let ownData = try Data(contentsOf: store.preferenceURL)
        check(saved.source == "relay" && saved.revision != inherited.revision, "explicit save owns Relay state")
        check(!String(decoding: ownData, as: UTF8.self).contains("OLD_SECRET_NOT_IMPORTED"), "legacy unknown fields are not copied")
        check(try Data(contentsOf: legacyURL) == legacy, "legacy bytes unchanged")
        let oldMode = try fm.attributesOfItem(atPath: legacyURL.path)[.posixPermissions] as? NSNumber
        let newMode = try fm.attributesOfItem(atPath: store.preferenceURL.path)[.posixPermissions] as? NSNumber
        check(oldMode?.intValue == 0o640 && newMode?.intValue == 0o600, "old permissions preserved, new file private")
        var json = try NetworkConfiguration.json(ownData)
        json["future"] = ["theme": "mint", "secret": "OWN_PRIVATE_FIELD"]
        try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(json), to: store.preferenceURL)
        rejects("external edit invalidates old own revision") { _ = try store.save(saved.preferences, expectedRevision: saved.revision) }
        let fresh = try store.load()
        let changed = RelayPreferences(httpPort: 9999, node: "fixture-node", internalExceptions: "10.10.0.5")
        let updated = try store.save(changed, expectedRevision: fresh.revision)
        let merged = try NetworkConfiguration.json(Data(contentsOf: store.preferenceURL))
        check((merged["future"] as? [String: Any])?["secret"] as? String == "OWN_PRIVATE_FIELD", "unknown Relay fields preserved")
        check(!String(decoding: try JSONEncoder().encode(updated), as: UTF8.self).contains("OWN_PRIVATE_FIELD"), "private fields not returned to renderer")
        check(try Data(contentsOf: client) == clientData, "client untouched")
        let before = try Data(contentsOf: store.preferenceURL)
        let fd = Darwin.open(store.root.appendingPathComponent(".state.lock").path, O_RDWR | O_NOFOLLOW)
        guard fd >= 0 else { throw AssistantError("fixture lock unavailable") }
        let locked = flock(fd, LOCK_EX | LOCK_NB) == 0
        check(locked, "fixture acquires OS lock")
        if locked { rejects("competing process cannot save") { _ = try store.save(changed, expectedRevision: updated.revision) } }
        Darwin.close(fd)
        check(try Data(contentsOf: store.preferenceURL) == before, "busy lock preserves bytes")
        let afterRelease = try store.save(changed, expectedRevision: updated.revision)
        check(afterRelease.source == "relay", "closed process lock needs no stale-file deletion")
        let failing = try RelayPreferenceStore(context, writer: { _, _ in throw AssistantError("fixture write failure") })
        rejects("failed atomic writer is surfaced") { _ = try failing.save(changed, expectedRevision: afterRelease.revision) }
        check(try Data(contentsOf: store.preferenceURL) == before, "failed writer preserves original")
        try NetworkConfiguration.safeWrite(Data("broken SECRET_INPUT".utf8), to: store.preferenceURL)
        rejects("corrupt own state cannot fall back to legacy") { _ = try store.load() }
        rejects("corrupt own state cannot be overwritten") { _ = try store.save(changed, expectedRevision: afterRelease.revision) }
        check(try Data(contentsOf: store.preferenceURL) == Data("broken SECRET_INPUT".utf8), "corrupt evidence retained")
        try fm.removeItem(at: store.preferenceURL)
        try NetworkConfiguration.safeWrite(Data("legacy malformed".utf8), to: legacyURL)
        let incompatible = try store.load()
        check(incompatible.source == "defaults" && !incompatible.warnings.isEmpty, "legacy corruption is explicit default fallback")
        let outside = home.appendingPathComponent("untouched.json")
        try NetworkConfiguration.safeWrite(Data("DO_NOT_TOUCH".utf8), to: outside)
        try fm.createSymbolicLink(at: store.preferenceURL, withDestinationURL: outside)
        rejects("symlink preference is never read") { _ = try store.load() }
        rejects("symlink preference is never replaced") { _ = try store.save(changed, expectedRevision: incompatible.revision) }
        check(try Data(contentsOf: outside) == Data("DO_NOT_TOUCH".utf8), "symlink target unchanged")
        try fm.removeItem(at: store.preferenceURL)
        try NetworkConfiguration.safeWrite(Data(repeating: 32, count: 1048577), to: store.preferenceURL)
        rejects("oversized preference is refused") { _ = try store.load() }
        try fm.removeItem(at: store.preferenceURL)
        rejects("legacy directory cannot be a write namespace") {
            _ = try RelayPreferenceStore(RelayStateContext(home: home.path, stateRoot: store.legacyRoot.path))
        }
        rejects("client directory cannot be a write namespace") {
            _ = try RelayPreferenceStore(RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent(".claude").path))
        }
        rejects("invalid proxy port not saved") { _ = try store.save(RelayPreferences(httpPort: 17890, node: "fixture-node", internalExceptions: ""), expectedRevision: incompatible.revision) }
        check(!fm.fileExists(atPath: store.preferenceURL.path), "invalid data leaves preference absent")
        check(try Data(contentsOf: client) == clientData, "all cases left client unchanged")
    } catch { failures.append("unexpected fixture failure") }
    print(failures.isEmpty ? "PASS: \(count) Relay preference checks; temporary fake HOME only, no real user state or network operations." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
