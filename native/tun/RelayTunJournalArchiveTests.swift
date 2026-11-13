import Foundation
import Darwin

private typealias Archive = RelayTunJournalArchive
private enum FixtureFailure: Error { case invalid, injected }
private final class Fixture {
    let root: String, archive: Archive.Store
    let revision = String(repeating: "f", count: 64), evidence = String(repeating: "9", count: 64)
    init(rootMode: mode_t = 0o700, recoveryParentGroup: gid_t? = nil) throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        let base = app + "/.relay-build/tun-journal-archive-fixtures"
        if Darwin.mkdir(base, 0o700) != 0 && errno != EEXIST { throw FixtureFailure.invalid }
        root = base + "/" + UUID().uuidString.lowercased()
        guard Darwin.mkdir(root, rootMode) == 0, chmod(root, rootMode) == 0 else { throw FixtureFailure.invalid }
        if let recoveryParentGroup {
            let parent = root + "/GroupParent"
            guard Darwin.mkdir(parent, 0o700) == 0, chown(parent, getuid(), recoveryParentGroup) == 0,
                  chmod(parent, 0o700) == 0 else { throw FixtureFailure.invalid }
            archive = try Archive.isolated(root: root, rootMode: rootMode, recoveryParent: parent)
        } else {
            archive = try Archive.isolated(root: root, rootMode: rootMode)
        }
    }
    deinit { try? FileManager.default.removeItem(atPath: root) }
    func plan() -> Archive.Plan {
        var value = EffectsFixture.plan(); value = .init(id: UUID().uuidString.lowercased(), configurationSHA256: value.configurationSHA256,
            runtimeConfigurationSHA256: value.runtimeConfigurationSHA256, effectsSHA256: value.effectsSHA256,
            baseline: value.baseline, createdAt: value.createdAt, expiresAt: value.expiresAt)
        return value
    }
    func mkdir(_ path: String) throws { if Darwin.mkdir(path, 0o700) != 0 && errno != EEXIST { throw FixtureFailure.invalid } }
    func write(_ path: String, _ bytes: Data) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw FixtureFailure.invalid }; defer { Darwin.close(fd) }
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count { let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                guard count > 0 else { throw FixtureFailure.invalid }; offset += count }
        }
    }
    func seed(_ plan: Archive.Plan, session: String, terminal: Bool = true, aborted: Bool = false, deviceJournal: Bool = true, verifyAbsent: Bool = true) throws -> RelayTunAcquiredReceipt {
        try mkdir(root + "/NetworkJournal"); try mkdir(root + "/DeviceJournal")
        let storage = try RelayTunNetworkJournalStore.archiveTestStorage(path: root + "/NetworkJournal/" + plan.id)
        let binding = try Journal.Binding(installationRevision: revision, clientUID: getuid(), plan: plan), writer = Journal.Writer(binding: binding, storage: storage)
        _ = try writer.open()
        func append(_ snapshot: Journal.Snapshot) throws { guard case .confirmed = try writer.record(snapshot) else { throw FixtureFailure.invalid } }
        try append(.init(binding: binding, sequence: 0, phase: .createIntent, realizedEffects: nil, pendingIDs: []))
        let observation = try Journal.Observation(networkSHA256: plan.baseline.networkSHA256, protectionSHA256: plan.baseline.protectionSHA256, deviceAbsent: true)
        if aborted {
            try append(.init(binding: binding, sequence: 1, phase: .acquisitionAborted, realizedEffects: nil, pendingIDs: [], observation: observation))
        } else {
            let effects = try Effects.EffectSet(planID: plan.id, device: EffectsFixture.device(), effects: [])
            try append(.init(binding: binding, sequence: 1, phase: .acquired, realizedEffects: effects, pendingIDs: []))
            if terminal {
                try append(.init(binding: binding, sequence: 2, phase: .closeIntent, realizedEffects: effects, pendingIDs: []))
                try append(.init(binding: binding, sequence: 3, phase: .restored, realizedEffects: effects, pendingIDs: [], observation: observation))
            }
        }
        if deviceJournal {
            try mkdir(root + "/DeviceJournal/" + plan.id)
            var previous: String?
            let events = [("create", "intent", false), ("create", "confirmed", true), ("close", "intent", true), ("close", "confirmed", false)] + (verifyAbsent ? [("verifyAbsent", "confirmed", false)] : [])
            for (sequence, item) in events.enumerated() {
                let operation: [String: Any] = item.0 == "create" ? ["kind": item.0, "requestedName": "utun"] : ["kind": item.0]
                let record: [String: Any] = ["version": 1, "role": "tun-device-event", "planID": plan.id,
                    "configurationSHA256": plan.configurationSHA256, "runtimeConfigurationSHA256": plan.runtimeConfigurationSHA256,
                    "effectsSHA256": plan.effectsSHA256, "createdAt": String(plan.createdAt), "expiresAt": String(plan.expiresAt), "sequence": sequence,
                    "event": ["id": EffectsFixture.deviceID, "operation": operation, "phase": item.1, "before": NSNull(), "desired": NSNull(), "observed": NSNull(), "ownsHandle": item.2]]
                let body = try Effects.bytes(["version": 1, "role": "tun-device-journal-record", "previousRecordSHA256": previous.map { $0 as Any } ?? NSNull(), "record": record])
                let hash = RelayTunHelperTrust.digest(body)
                try write(root + "/DeviceJournal/" + plan.id + "/" + String(format: "%08d", sequence) + "-" + hash + ".json", body)
                previous = hash
            }
        }
        return try .init(installationRevision: revision, clientUID: getuid(), evidenceSHA256: evidence,
            runtimeConfigurationSHA256: plan.runtimeConfigurationSHA256, planID: plan.id, sessionID: session, deviceID: EffectsFixture.deviceID,
            interfaceName: "utun42", interfaceIndex: 91, controlID: 17, controlUnit: 43, socketDevice: "0", socketInode: String(UInt64.max))
    }
    func retire(_ plan: Archive.Plan, session: String, receipt: RelayTunAcquiredReceipt?) throws {
        try archive.retire(plan, sessionID: session, evidenceSHA256: evidence, receipt: receipt, clientUID: getuid(), revision: revision)
    }
}

@main struct RelayTunJournalArchiveTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), getgid() == getegid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ value: Bool, _ name: String) { rows.append(["name": name, "passed": value]) }
        func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
        do {
            let f = try Fixture()
            rejects("ordinary UID cannot enter production archive") { try Archive.verifyLiveEmpty() }
            rejects("ordinary UID cannot enter production removal fence") { try RelayTunUninstallFence.withMutation { } }
            check(try !f.archive.verifyPreserved(), "empty isolated recovery namespace is not invented")
            for round in 1...2 {
                let plan = f.plan(), session = UUID().uuidString.lowercased(), receipt = try f.seed(plan, session: session)
                try f.retire(plan, session: session, receipt: receipt)
                check(!FileManager.default.fileExists(atPath: f.root + "/NetworkJournal/" + plan.id) && !FileManager.default.fileExists(atPath: f.root + "/DeviceJournal/" + plan.id),
                      "normal stop frees both live journal namespaces for round \(round)")
                check(try f.archive.verifyPreserved(), "all original immutable records remain verifiable after round \(round)")
                let proof = try f.archive.loadTerminal(sessionID: session, clientUID: getuid(), revision: f.revision)
                check(proof?.plan == plan && proof?.receipt == receipt && proof?.evidenceSHA256 == f.evidence, "durable exact receipt/evidence survives helper connection loss round \(round)")
                try f.retire(plan, session: session, receipt: receipt)
                check(try f.archive.loadTerminal(sessionID: session, clientUID: getuid() + 1, revision: f.revision) == nil, "archived proof cannot transfer to another UID")
                try f.archive.verifyLiveEmpty()
            }
            try f.archive.verifyLiveEmpty(remove: true)
            check(try f.archive.verifyPreserved() && !FileManager.default.fileExists(atPath: f.root + "/NetworkJournal"), "uninstall removes only empty live bases and retains validated audit history")
            do {
                let installed = try Fixture(rootMode: 0o755), plan = installed.plan(), session = UUID().uuidString.lowercased()
                let receipt = try installed.seed(plan, session: session)
                try installed.retire(plan, session: session, receipt: receipt)
                try installed.archive.verifyLiveEmpty(remove: true)
                check(try installed.archive.verifyPreserved() && !FileManager.default.fileExists(atPath: installed.root + "/NetworkJournal") && !FileManager.default.fileExists(atPath: installed.root + "/DeviceJournal"), "installed 0755 root supports one-pass empty journal cleanup and retained 0700 audit archive")
            }
            do {
                let count = getgroups(0, nil)
                guard count > 0 else { throw FixtureFailure.invalid }
                var groups = [gid_t](repeating: 0, count: Int(count))
                guard getgroups(count, &groups) == count, let other = groups.first(where: { $0 != getgid() }) else { throw FixtureFailure.invalid }
                let inherited = try Fixture(recoveryParentGroup: other), parent = inherited.root + "/GroupParent"
                let probe = parent + "/Probe"
                guard mkdir(probe, 0o700) == 0 else { throw FixtureFailure.invalid }
                var before = stat()
                guard lstat(probe, &before) == 0, rmdir(probe) == 0 else { throw FixtureFailure.invalid }
                check(before.st_gid == other, "fixture actually inherits the parent group on directory creation")
                let plan = inherited.plan(), session = UUID().uuidString.lowercased()
                try inherited.retire(plan, session: session, receipt: nil)
                var recovery = stat(), parentInfo = stat()
                guard lstat(parent + "/Recovery", &recovery) == 0, lstat(parent, &parentInfo) == 0 else { throw FixtureFailure.invalid }
                check(recovery.st_uid == getuid() && recovery.st_gid == getgid() && recovery.st_mode & 0o7777 == 0o700 && parentInfo.st_gid == other,
                      "a newly created archive corrects inherited group without changing its parent")
                check(try inherited.archive.loadTerminal(sessionID: session, clientUID: getuid(), revision: inherited.revision)?.phase == "unacquired",
                      "archive completes with a recovery parent in a different group")
                let existing = try Fixture(recoveryParentGroup: other), existingParent = existing.root + "/GroupParent"
                try existing.mkdir(existingParent + "/Recovery")
                let sentinel = existingParent + "/Recovery/sentinel"
                try existing.write(sentinel, Data("keep".utf8))
                let otherPlan = existing.plan(), otherSession = UUID().uuidString.lowercased()
                rejects("an existing archive with an inherited foreign group is never normalized") { try existing.retire(otherPlan, session: otherSession, receipt: nil) }
                var unchanged = stat()
                guard lstat(existingParent + "/Recovery", &unchanged) == 0 else { throw FixtureFailure.invalid }
                let preserved = try Data(contentsOf: URL(fileURLWithPath: sentinel))
                check(unchanged.st_gid == other && preserved == Data("keep".utf8),
                      "refusing an existing foreign-group archive preserves its group and contents")
            }
            do {
                let plan = f.plan(), session = UUID().uuidString.lowercased()
                try f.retire(plan, session: session, receipt: nil)
                check(try f.archive.loadTerminal(sessionID: session, clientUID: getuid(), revision: f.revision)?.phase == "unacquired", "prepared cancellation records zero acquisition with exact baseline and evidence")
            }
            for device in [false, true] {
                let isolated = try Fixture(), plan = isolated.plan(), session = UUID().uuidString.lowercased()
                _ = try isolated.seed(plan, session: session, aborted: true, deviceJournal: device)
                try isolated.retire(plan, session: session, receipt: nil)
                check(try isolated.archive.verifyPreserved(), "positive acquisition abort archives with device journal presence \(device)")
                check(try isolated.archive.loadTerminal(sessionID: session, clientUID: getuid(), revision: isolated.revision)?.phase == "acquisition_aborted", "aborted proof never invents an acquired receipt")
            }
            do {
                let partial = try Fixture(), plan = partial.plan(), session = UUID().uuidString.lowercased(), receipt = try partial.seed(plan, session: session)
                partial.archive.afterMove = { kind in if kind == "NetworkJournal" { throw FixtureFailure.injected } }
                rejects("failure after first move preserves explicit partial archive for retry") { try partial.retire(plan, session: session, receipt: receipt) }
                check(FileManager.default.fileExists(atPath: partial.root + "/Recovery/" + plan.id + "/retirement.json") && FileManager.default.fileExists(atPath: partial.root + "/DeviceJournal/" + plan.id), "partial rename keeps manifest and unmoved device evidence")
                partial.archive.afterMove = nil; try partial.retire(plan, session: session, receipt: receipt)
                check(try partial.archive.verifyPreserved(), "retry completes same archive without rewriting any immutable record")
            }
            do {
                let unknown = try Fixture(), plan = unknown.plan(), session = UUID().uuidString.lowercased(), receipt = try unknown.seed(plan, session: session, terminal: false)
                rejects("nonterminal network record prevents archival") { try unknown.retire(plan, session: session, receipt: receipt) }
                rejects("nonterminal live journals prevent uninstall before bootout") { try unknown.archive.verifyLiveEmpty() }
                check(FileManager.default.fileExists(atPath: unknown.root + "/NetworkJournal/" + plan.id), "nonterminal evidence remains untouched")
            }
            do {
                let unknown = try Fixture(), plan = unknown.plan(), session = UUID().uuidString.lowercased(), receipt = try unknown.seed(plan, session: session)
                try unknown.write(unknown.root + "/NetworkJournal/" + plan.id + "/unknown", Data("PRIVATE".utf8))
                rejects("unknown journal entries cannot be archived or deleted") { try unknown.retire(plan, session: session, receipt: receipt) }
                check(FileManager.default.fileExists(atPath: unknown.root + "/NetworkJournal/" + plan.id + "/unknown"), "unknown journal file is retained")
            }
            do {
                let collision = try Fixture(), plan = collision.plan(), session = UUID().uuidString.lowercased(), receipt = try collision.seed(plan, session: session)
                try collision.mkdir(collision.root + "/Recovery"); try collision.mkdir(collision.root + "/Recovery/" + plan.id)
                rejects("unknown existing archive directory cannot be adopted") { try collision.retire(plan, session: session, receipt: receipt) }
                check(FileManager.default.fileExists(atPath: collision.root + "/NetworkJournal/" + plan.id), "destination conflict never moves source journals")
            }
            do {
                let unknown = try Fixture(), plan = unknown.plan(), session = UUID().uuidString.lowercased(), receipt = try unknown.seed(plan, session: session, verifyAbsent: false)
                rejects("closed helper handle alone is not terminal device absence") { try unknown.retire(plan, session: session, receipt: receipt) }
                check(FileManager.default.fileExists(atPath: unknown.root + "/DeviceJournal/" + plan.id), "device evidence stays live when independent absence acknowledgment is missing")
            }
            do {
                let unknown = try Fixture(), plan = unknown.plan(), session = UUID().uuidString.lowercased(), receipt = try unknown.seed(plan, session: session)
                try unknown.write(unknown.root + "/NetworkJournal/" + plan.id + "/writer.lease", Data("held".utf8))
                rejects("an outstanding writer lease blocks archival") { try unknown.retire(plan, session: session, receipt: receipt) }
            }
            do {
                let tampered = try Fixture(), plan = tampered.plan(), session = UUID().uuidString.lowercased(), receipt = try tampered.seed(plan, session: session)
                try tampered.retire(plan, session: session, receipt: receipt)
                let path = tampered.root + "/Recovery/" + plan.id + "/retirement.json"
                var object = try RelayTunStrictJSON.object(Data(contentsOf: URL(fileURLWithPath: path)))
                object["evidenceSHA256"] = String(repeating: "0", count: 64)
                try Effects.bytes(object).write(to: URL(fileURLWithPath: path))
                rejects("tampered durable evidence cannot replay an acquired terminal reply") { _ = try tampered.archive.loadTerminal(sessionID: session, clientUID: getuid(), revision: tampered.revision) }
                check(FileManager.default.fileExists(atPath: path), "invalid retained audit is never deleted or rewritten")
            }
            do {
                let fixture = try Fixture(), fence = try RelayTunUninstallFence.isolated(parent: fixture.root), revision = fixture.revision
                try fence.withMutation {
                    rejects("removal cannot race a helper operation holding the shared lock") { try fence.withRemoval(manifestSHA256: revision) { } }
                }
                rejects("failed removal retains durable fence for explicit recovery") { try fence.withRemoval(manifestSHA256: revision) { throw FixtureFailure.injected } }
                var touched = false
                rejects("fence blocks new acquisitions") { try fence.withMutation { touched = true } }
                check(!touched, "blocked mutation never enters its body")
                try fence.withMutation(allowRecovery: true) { touched = true }
                check(touched, "explicit recovery remains possible behind a failed-removal fence")
                rejects("another candidate cannot adopt the fixed fence") { try fence.withRemoval(manifestSHA256: String(repeating: "0", count: 64)) { } }
                try fence.withRemoval(manifestSHA256: revision) {
                    rejects("even recovery cannot execute during the exclusive removal interval") { try fence.withMutation(allowRecovery: true) { } }
                }
                check(try fence.fenceAbsent(), "successful final synchronization removes only known fence and lock")
                try fence.withMutation { }
                check(true, "fresh later lifecycle can create its own lock after completed removal")
                var escaped: (() throws -> Void)?
                try fence.withRemoval(manifestSHA256: revision) { retire in escaped = retire; try retire() }
                try fence.withMutation { }
                rejects("retired cleanup capability cannot act on reused descriptors or a later lock") { try escaped?() }
                check(FileManager.default.fileExists(atPath: fixture.root + "/local.relay.network.tun.operation-lock"), "late cleanup leaves new lifecycle lock untouched")
            }
            try RelayTunUninstallArchiveTests.run(root: f.root, check: check)
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failed = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failed == 0, "checksPassed": rows.count - failed, "checksTotal": rows.count,
            "ordinaryUIDPrivateFixturesOnly": true, "productionRootPathsAccessed": false, "actualNetworkChanged": false,
            "actualHelperInstalledOrStopped": false, "checks": rows]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)); if failed > 0 { exit(1) }
    }
}
