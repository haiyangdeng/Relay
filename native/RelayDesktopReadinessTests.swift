import Foundation

func runRelayDesktopReadinessSelfTests() -> Int32 {
    let fm = FileManager.default
    let fixture = fm.temporaryDirectory.appendingPathComponent("relay-desktop-fixture-" + UUID().uuidString)
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    defer { try? fm.removeItem(at: fixture) }
    do {
        try fm.createDirectory(at: fixture, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = NetworkConfiguration(home: fixture).home
        let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path)
        let paths = try RelayPreferenceStore(context)
        let original = RelayDesktopIdentity(bundleIdentifier: "com.apple.Safari", appURL: URL(fileURLWithPath: "/Applications/Safari.app", isDirectory: true).absoluteString)
        let other = RelayDesktopIdentity(bundleIdentifier: "org.fixture.Other", appURL: URL(fileURLWithPath: "/Applications/Other.app", isDirectory: true).absoluteString)
        var current = ["http": original, "https": original]
        let wrapper = RelayDesktopIdentity(bundleIdentifier: "local.relay.browser",
            appURL: URL(fileURLWithPath: "/fixture/Relay.app/Contents/Resources/relay/RelayBrowser.app", isDirectory: true).absoluteString)
        var env = RelayDesktopEnvironment(application: { _, _ in true }, loginBrowser: { RelayDesktopInspection.edge },
            edgePoliciesReady: { true }, edgeClosed: { true }, currentDefault: { current[$0] })
        var report = try RelayDesktopInspection.inspect(context, environment: env)
        check(report.configurationReady && report.sharedDefaults, "matching fixture configuration passes snapshot gates")
        check(report.readOnly && !report.startEnabled && report.proxy == "notTested" && report.locks == "notAcquired", "snapshot never grants start or lock permission")
        check(report.records.allSatisfy { $0.state == "missing" }, "two absent records separately reported")
        check(!fm.fileExists(atPath: paths.root.path), "inspection creates no state directories")
        check(report.edgeInstalled && report.edgePoliciesReady && report.edgeClosed && report.browserReady, "installed Edge, forced policies and closed state reported")
        env.edgePoliciesReady = { false }
        check(try !RelayDesktopInspection.inspect(context, environment: env).configurationReady, "Edge policy mismatch blocks readiness without opening it")
        env.edgePoliciesReady = { true }
        env.loginBrowser = { nil }
        check(try !RelayDesktopInspection.inspect(context, environment: env).edgeInstalled, "missing Edge identity is not ready")
        env.loginBrowser = { wrapper }
        check(try !RelayDesktopInspection.inspect(context, environment: env).edgeInstalled, "wrapper cannot substitute for direct Edge login")
        env.loginBrowser = { RelayDesktopInspection.edge }
        env.application = { _, id in id != "com.google.Chrome" && id != "local.relay.browser" }
        check(try RelayDesktopInspection.inspect(context, environment: env).configurationReady, "Edge login does not require Chrome or wrapper")
        env.edgeClosed = { false }
        check(try !RelayDesktopInspection.inspect(context, environment: env).configurationReady, "running Edge blocks new login")
        env.edgeClosed = { true }
        env.application = { _, id in id != "com.microsoft.edgemac" }
        check(try !RelayDesktopInspection.inspect(context, environment: env).edgeInstalled, "Edge application identity missing")
        env.application = { _, id in id != "com.anthropic.claudefordesktop" }
        check(try !RelayDesktopInspection.inspect(context, environment: env).claudeInstalled, "Claude identity missing")
        env.application = { _, _ in true }
        current["https"] = other
        check(try !RelayDesktopInspection.inspect(context, environment: env).sharedDefaults, "different defaults block paired setters")
        current.removeValue(forKey: "https")
        report = try RelayDesktopInspection.inspect(context, environment: env)
        check(!report.sharedDefaults && report.defaults["https"] == nil, "unknown default stays unknown")
        current = ["http": original, "https": original]
        let recordURL = paths.root.appendingPathComponent("Desktop Login/state.json")
        let legacyURL = home.appendingPathComponent("Library/Application Support/Claude Desktop Login/state.json")
        func make(_ originals: [String: RelayDesktopIdentity] = ["http": original, "https": original], attempted: [String] = ["http", "https"], phase: String = "active") -> RelayDesktopRecord {
            RelayDesktopRecord(version: 1, sessionID: UUID().uuidString, createdAt: "2026-10-24T00:00:00Z",
                originals: originals, temporaryApplication: RelayDesktopInspection.edge, attemptedSchemes: attempted, phase: phase)
        }
        func save(_ value: RelayDesktopRecord, _ url: URL) throws { try NetworkConfiguration.safeWrite(JSONEncoder().encode(value), to: url) }
        try save(make(), recordURL)
        let saved = try Data(contentsOf: recordURL)
        report = try RelayDesktopInspection.inspect(context, environment: env)
        check(!report.configurationReady && report.records[0].state == "pending", "any existing record blocks new session even if already original")
        check(report.records[0].decisions.values.allSatisfy { $0 == "alreadyOriginal" }, "already original must still be finalized by owner")
        check(try Data(contentsOf: recordURL) == saved, "inspection never deletes or updates recovery record")
        current = ["http": RelayDesktopInspection.edge, "https": RelayDesktopInspection.edge]
        report = try RelayDesktopInspection.inspect(context, environment: env)
        check(report.records[0].decisions.values.allSatisfy { $0 == "restoreEligible" }, "temporary pair eligible only as a snapshot")
        current["https"] = other
        report = try RelayDesktopInspection.inspect(context, environment: env)
        check(report.records[0].decisions.values.allSatisfy { $0 == "blocked" }, "one external change blocks collateral restore of other scheme")
        current.removeValue(forKey: "https")
        report = try RelayDesktopInspection.inspect(context, environment: env)
        check(report.records[0].decisions["http"] == "blocked" && report.records[0].decisions["https"] == "unconfirmed", "missing current identity never authorizes a paired setter")
        current = ["http": RelayDesktopInspection.edge, "https": RelayDesktopInspection.edge]
        try save(make(attempted: []), recordURL)
        check(try RelayDesktopInspection.inspect(context, environment: env).records[0].decisions.values.allSatisfy { $0 == "blocked" }, "unattempted defaults cannot be restored")
        try save(make(["http": original, "https": other]), recordURL)
        check(try RelayDesktopInspection.inspect(context, environment: env).records[0].decisions.values.allSatisfy { $0 == "blocked" }, "split original defaults cannot cause paired overwrite")
        try save(make(attempted: ["http", "http"]), recordURL)
        check(try RelayDesktopInspection.inspect(context, environment: env).records[0].state == "invalid", "duplicate attempts rejected")
        try save(make(phase: "finished"), recordURL)
        check(try RelayDesktopInspection.inspect(context, environment: env).records[0].state == "invalid", "unknown phase rejected")
        let wrapperRecord = RelayDesktopRecord(version: 2, sessionID: UUID().uuidString, createdAt: "2026-10-24T00:00:00Z",
            originals: ["http": original, "https": original], temporaryApplication: wrapper,
            attemptedSchemes: ["http", "https"], phase: "active")
        try save(wrapperRecord, recordURL)
        current = ["http": wrapper, "https": wrapper]
        report = try RelayDesktopInspection.inspect(context, environment: env)
        check(report.records[0].state == "pending" && report.records[0].decisions.values.allSatisfy { $0 == "restoreEligible" },
            "version2 wrapper record is recoverable using its captured temporary identity")
        let fakeWrapper = RelayDesktopIdentity(bundleIdentifier: "local.relay.browser", appURL: URL(fileURLWithPath: "/fixture/Other.app", isDirectory: true).absoluteString)
        let forged = RelayDesktopRecord(version: 2, sessionID: UUID().uuidString, createdAt: wrapperRecord.createdAt,
            originals: wrapperRecord.originals, temporaryApplication: fakeWrapper, attemptedSchemes: ["http", "https"], phase: "active")
        try save(forged, recordURL)
        check(try RelayDesktopInspection.inspect(context, environment: env).records[0].state == "invalid", "version2 rejects wrong wrapper resource location")
        current = ["http": RelayDesktopInspection.edge, "https": RelayDesktopInspection.edge]
        try NetworkConfiguration.safeWrite(Data("PRIVATE-BROKEN-RECORD".utf8), to: recordURL)
        report = try RelayDesktopInspection.inspect(context, environment: env)
        let publicJSON = try RelayReadOnly.encode(report)
        check(report.records[0].state == "invalid" && !publicJSON.contains("PRIVATE-BROKEN") && !publicJSON.contains(home.path), "malformed record does not leak bytes or paths")
        try save(make(), recordURL)
        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: recordURL.path)
        check(try RelayDesktopInspection.inspect(context, environment: env).records[0].state == "invalid", "nonprivate state rejected without chmod")
        check(try fm.attributesOfItem(atPath: recordURL.path)[.posixPermissions] as? Int == 0o644, "read does not repair permissions")
        try fm.removeItem(at: recordURL)
        try save(make(phase: "restoring"), legacyURL)
        report = try RelayDesktopInspection.inspect(context, environment: env)
        check(report.records[1].state == "pending" && report.records[1].phase == "restoring", "legacy state read in place with same contract")
        check(!fm.fileExists(atPath: recordURL.path), "legacy record not migrated or cloned")
        try fm.createSymbolicLink(at: recordURL, withDestinationURL: legacyURL)
        check(try RelayDesktopInspection.inspect(context, environment: env).records[0].state == "unreadable", "symlink state rejected")
        check(!RelayDesktopIdentity(bundleIdentifier: "secret\nidentity", appURL: original.appURL).valid, "control characters in identities rejected")
        check(!RelayDesktopIdentity(bundleIdentifier: "org.test", appURL: "https://secret.example/a.app").valid, "nonfile app identities rejected")
        check(!RelayDesktopIdentity(bundleIdentifier: "org.test", appURL: "file://remote/Applications/Test.app/").valid, "remote file identity rejected")
        check(!RelayDesktopIdentity(bundleIdentifier: "org.test", appURL: "file:///Applications/../Test.app/").valid, "noncanonical app identity rejected")
    } catch { failures.append("unexpected fixture failure") }
    print(failures.isEmpty ? "PASS: \(count) Relay desktop readiness checks; fixture HOME and injected OS only, no browser/default/network changes." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
