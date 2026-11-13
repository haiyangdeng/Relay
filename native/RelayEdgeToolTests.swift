import Foundation
import Darwin

func runRelayEdgeToolSelfTests() async -> Int32 {
    let fm = FileManager.default
    let fixture = fm.temporaryDirectory.appendingPathComponent("relay-edge-fixture-" + UUID().uuidString)
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    defer { try? fm.removeItem(at: fixture) }
    do {
        try fm.createDirectory(at: fixture, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = NetworkConfiguration(home: fixture).home
        let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path)
        let paths = try RelayPreferenceStore(context)
        var values: [String: Any] = [:], forced = Set<String>(), installed = true
        var requests: [(URL, URL)] = []
        let environment = RelayEdgeEnvironment(values: { values }, forced: { forced }, application: { _, _ in installed }, open: {
            requests.append(($0, $1))
        })
        var report = try RelayEdgeTools.inspect(environment)
        check(report.status == "needsInstall" && report.canOpenProfile && report.manualReviewRequired, "missing policies require manual review")
        check(report.readOnly && !report.runtimeVerified && report.policySource == "unconfirmed", "no provenance or runtime claim")
        check(report.policies.count == 4 && !fm.fileExists(atPath: paths.root.path) && requests.isEmpty, "inspection inert")
        let missingRevision = report.revision
        values = NetworkConfiguration.expectedEdgePolicies
        report = try RelayEdgeTools.inspect(environment)
        check(report.status == "needsInstall" && report.policies.allSatisfy { $0.matches && !$0.valid }, "unforced matching values not managed")
        check(report.revision != missingRevision, "proof hashes full values")
        forced = Set(values.keys)
        report = try RelayEdgeTools.inspect(environment)
        check(report.status == "configured" && !report.canOpenProfile, "matching managed settings never reinstall")
        forced.remove("ProxySettings")
        check(try RelayEdgeTools.inspect(environment).status == "blocked", "partial managed policy blocks replacement")
        forced = Set(values.keys); values["ProxySettings"] = ["ProxyMode": "direct", "PRIVATE": "secret"]
        let wrong = try RelayEdgeTools.inspect(environment)
        check(wrong.status == "blocked" && !wrong.canOpenProfile, "conflicting forced value blocks")
        check(try !RelayReadOnly.encode(wrong).contains("secret"), "raw values never returned")
        values["ProxySettings"] = ["ProxyMode": "system"]
        check(try RelayEdgeTools.inspect(environment).revision != wrong.revision, "different wrong values invalidate proof")
        values = NetworkConfiguration.expectedEdgePolicies; forced = Set(values.keys)
        for key in RelayEdgeTools.additionalKeys {
            values[key] = ["PRIVATE": "secret"]
            let extra = try RelayEdgeTools.inspect(environment)
            check(extra.status == "blocked" && extra.reviewKeys == [key], "additional policy reviewed: " + key)
            values.removeValue(forKey: key)
            forced.insert(key)
            check(try RelayEdgeTools.inspect(environment).status == "blocked", "forced missing extra blocked: " + key)
            forced.remove(key)
        }
        installed = false
        check(try RelayEdgeTools.inspect(environment).status == "blocked", "missing application blocks installation")
        installed = true; values = [:]; forced = []
        func input(_ action: RelayEdgeToolInput.Action, _ revision: String? = nil) -> RelayEdgeToolInput {
            RelayEdgeToolInput(action: action, context: context, expectedRevision: revision)
        }
        let revision = try RelayEdgeTools.inspect(environment).revision
        values["ProxyMode"] = "direct"
        do { _ = try await RelayEdgeTools.perform(input(.openProfile, revision), environment: environment); check(false, "changed observation rejected") }
        catch { check(requests.isEmpty, "changed observation never opens") }
        values = [:]
        let result = try await RelayEdgeTools.perform(input(.openProfile, revision), environment: environment)
        check(result.status == "requested" && !result.installed && requests.count == 1, "opening never reports installed")
        let staged = paths.root.appendingPathComponent("Profiles/Claude-Edge-Network.mobileconfig")
        check(requests.last?.0 == staged && requests.last?.1 == RelayEdgeTools.settingsURL, "fixed file and System Settings opener")
        check(try RelayRecoveryInspector.read(staged)?.mode == 0o600, "staged file private")
        _ = try await RelayEdgeTools.perform(input(.openProfile, revision), environment: environment)
        check(requests.count == 2, "own generated profile replaceable")
        try NetworkConfiguration.safeWrite(Data("PRIVATE unknown file".utf8), to: staged)
        do { _ = try await RelayEdgeTools.perform(input(.openProfile, revision), environment: environment); check(false, "unknown staged file rejected") }
        catch { check(requests.count == 2 && (try? Data(contentsOf: staged)) == Data("PRIVATE unknown file".utf8), "unknown file preserved") }
        try fm.removeItem(at: staged)
        try fm.createSymbolicLink(at: staged, withDestinationURL: home.appendingPathComponent("outside"))
        do { _ = try await RelayEdgeTools.perform(input(.openProfile, revision), environment: environment); check(false, "symlink refused") }
        catch { check(requests.count == 2 && !fm.fileExists(atPath: home.appendingPathComponent("outside").path), "symlink target untouched") }
        try fm.removeItem(at: staged)
        let lease = try RelayDesktopStore(context); try lease.acquire()
        do { _ = try await RelayEdgeTools.perform(input(.openProfile, revision), environment: environment); check(false, "active login lease blocks stage") }
        catch { check(requests.count == 2 && !fm.fileExists(atPath: staged.path), "lease exclusion before file staging") }
        lease.release()
        _ = try await RelayEdgeTools.perform(input(.deviceManagement), environment: environment)
        check(requests.last?.0 == RelayEdgeTools.deviceURL && requests.last?.1 == RelayEdgeTools.settingsURL, "fixed device management entry")
        _ = try await RelayEdgeTools.perform(input(.edgePolicy), environment: environment)
        check(requests.last?.0 == RelayEdgeTools.policyURL && requests.last?.1 == RelayDesktopInspection.edgeURL, "fixed Edge entry, no default browser")
        for action in [RelayEdgeToolInput.Action.edgePolicy, .deviceManagement] {
            do { _ = try await RelayEdgeTools.perform(input(action, revision), environment: environment); check(false, "unexpected revision rejected") }
            catch { check(requests.count == 4, "parameter rejected before opening") }
        }
        var failing = environment
        failing.open = { _, _ in throw AssistantError("PRIVATE failure") }
        do { _ = try await RelayEdgeTools.perform(input(.openProfile, revision), environment: failing); check(false, "open failure surfaced") }
        catch { check(fm.fileExists(atPath: staged.path) && requests.count == 4, "open failure keeps staged file, no fallback") }
    } catch { failures.append("unexpected Edge fixture failure") }
    print(failures.isEmpty ? "PASS: \(count) Edge tool checks; fixture HOME and injected openers only." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
