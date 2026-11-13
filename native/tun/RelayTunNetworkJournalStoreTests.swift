import Foundation
import Darwin

private typealias Store = RelayTunNetworkJournalStore
private enum StoreFixtureFailure: Error { case injected, invalid, seed(String) }
private final class StoreFixture {
    let parent: String
    var path: String { parent + "/NetworkJournal" }
    init() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        let root = app + "/.relay-build/tun-journal-store-fixtures"
        if mkdir(root, 0o700) != 0 && errno != EEXIST { throw StoreFixtureFailure.invalid }
        var info = stat()
        guard lstat(root, &info) == 0, info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o7777 == 0o700 else { throw StoreFixtureFailure.invalid }
        parent = root + "/" + UUID().uuidString.lowercased()
        guard mkdir(parent, 0o700) == 0 else { throw StoreFixtureFailure.invalid }
    }
    deinit {
        // Only this test's freshly generated, private UUID fixture is retired.
        // No production path or caller-provided directory reaches this helper.
        func retire(_ path: String) {
            var info = stat(); guard lstat(path, &info) == 0, info.st_uid == getuid() else { return }
            if info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) {
                for name in (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? [] { retire(path + "/" + name) }
                _ = rmdir(path)
            } else { _ = unlink(path) }
        }
        var info = stat()
        if lstat(parent, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 { retire(parent) }
    }
    func storage(fault: ((Store.TestPoint) throws -> Void)? = nil) throws -> Journal.Storage { try Store.testStorage(path: path, fault: fault) }
    func record(_ index: Int) -> String { path + "/" + String(format: "%010d.record", index) }
    var names: [String] { ((try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []).sorted() }
    func seed() throws -> (Journal.Storage, Journal.Snapshot, Journal.Snapshot) {
        let binding = try EffectsFixture.binding(), initial = try Journal.Snapshot(binding: binding, sequence: 0, phase: .createIntent, realizedEffects: nil, pendingIDs: [])
        let acquired = try Journal.Snapshot(binding: binding, sequence: 1, phase: .acquired, realizedEffects: EffectsFixture.set(), pendingIDs: [])
        var points: [Store.TestPoint] = []
        let storage = try self.storage { points.append($0) }, writer = Journal.Writer(binding: binding, storage: storage)
        try writer.open()
        guard case .confirmed = try writer.record(initial) else { throw StoreFixtureFailure.seed(String(describing: points)) }
        return (storage, initial, acquired)
    }
}

private final class StoreThreadResult {
    private let lock = NSLock()
    private var values: [Bool] = []
    func append(_ value: Bool) { lock.lock(); values.append(value); lock.unlock() }
    func result() -> [Bool] { lock.lock(); defer { lock.unlock() }; return values }
}

@main struct RelayTunNetworkJournalStoreTests {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--benchmark-small"] { benchmark(counts: [8, 32]); return }
        if arguments == ["--benchmark-max"] { benchmark(counts: [128]); return }
        var rows: [[String: Any]] = []
        func check(_ value: Bool, _ name: String) { rows.append(["name": name, "passed": value]) }
        func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
        do {
            guard getuid() > 0, getuid() == geteuid() else { throw StoreFixtureFailure.invalid }
            rejects("ordinary UID cannot construct production storage") { _ = try Store.productionStorage() }
            check(Store.productionFilesystemEntries == 0, "production privilege rejection precedes every filesystem entry")
            rejects("test-only factory cannot select a system path") { _ = try Store.testStorage(path: "/Library/Application Support/Relay/Tun/NetworkJournal") }
            let query = try StoreFixture(), queryStorage = try query.storage()
            check(try queryStorage.read() == nil && query.names.isEmpty && !FileManager.default.fileExists(atPath: query.path), "read-only query does not create the journal namespace or a lease")

            let first = try StoreFixture(), (storage, initial, acquired) = try first.seed()
            check(first.names == ["0000000000.record"], "first durable intent leaves exactly one immutable record and no lease/temp")
            var metadata = stat(); _ = lstat(first.path, &metadata)
            check(metadata.st_mode & 0o7777 == 0o700 && metadata.st_uid == getuid(), "test namespace has the same private directory policy with the test owner")
            _ = lstat(first.record(0), &metadata)
            check(metadata.st_mode & 0o7777 == 0o600 && metadata.st_nlink == 1 && metadata.st_gid == getgid(), "published record is private, singly linked, and has exact group ownership")
            let prior = try storage.read()
            check(try storage.compareExchange(prior.map(RelayTunHelperTrust.digest), acquired.encoded()), "CAS appends the next bound snapshot without replacing the previous record")
            try storage.sync()
            check(try storage.read() == acquired.encoded() && first.names == ["0000000000.record", "0000000001.record"], "sync and readback retain both immutable chain records and release only the owned lease")
            check(try first.storage().read() == acquired.encoded(), "a fresh store validates the whole chain after a simulated restart")
            check(try storage.read() == acquired.encoded() && !storage.compareExchange(RelayTunHelperTrust.digest(initial.encoded()), acquired.encoded()), "a stale expected snapshot cannot append or overwrite a newer chain")

            let binding = try EffectsFixture.binding()
            let emptyEffects = try Effects.EffectSet(planID: binding.planID, device: EffectsFixture.device(), effects: [])
            // A separate empty-effects scope exercises the acquired -> close
            // path without inventing evidence that planned routes disappeared.
            let completed = try StoreFixture(), completedStorage = try completed.storage()
            let completedWriter = Journal.Writer(binding: binding, storage: completedStorage); try completedWriter.open()
            _ = try completedWriter.record(initial)
            _ = try completedWriter.record(.init(binding: binding, sequence: 1, phase: .acquired, realizedEffects: emptyEffects, pendingIDs: []))
            _ = try completedWriter.record(.init(binding: binding, sequence: 2, phase: .closeIntent, realizedEffects: emptyEffects, pendingIDs: []))
            let final = try Journal.Snapshot(binding: binding, sequence: 3, phase: .restored, realizedEffects: emptyEffects, pendingIDs: [], observation: .init(networkSHA256: binding.networkSHA256, protectionSHA256: binding.protectionSHA256, deviceAbsent: true))
            guard case .confirmed = try completedWriter.record(final) else { throw StoreFixtureFailure.invalid }
            let savedNames = completed.names, savedFinal = try completedStorage.read()
            rejects("a terminal record is not automatically cleared or reused for a new session") { _ = try completedStorage.compareExchange(savedFinal.map(RelayTunHelperTrust.digest), initial.encoded()) }
            check(try completed.names == savedNames && savedFinal == completed.storage().read(), "rejected terminal reuse leaves the complete historical chain and no extra lease")
            check(!completedWriter.restorationVerified, "real private-file durability still does not prove real network restoration")

            let broken = try StoreFixture(), (brokenStorage, _, brokenAcquired) = try broken.seed()
            let brokenPrevious = try brokenStorage.read()
            guard try brokenStorage.compareExchange(brokenPrevious.map(RelayTunHelperTrust.digest), brokenAcquired.encoded()) else { throw StoreFixtureFailure.invalid }
            try brokenStorage.sync(); _ = try brokenStorage.read()
            var envelope = try RelayTunStrictJSON.object(Data(contentsOf: URL(fileURLWithPath: broken.record(1))), limit: Effects.maximumBytes)
            envelope["previousRecordSHA256"] = String(repeating: "0", count: 64)
            try Effects.bytes(envelope).write(to: URL(fileURLWithPath: broken.record(1)))
            rejects("a complete valid snapshot cannot hide a corrupted previous-record hash") { _ = try broken.storage().read() }
            check(broken.names == ["0000000000.record", "0000000001.record"], "corrupted hash-chain evidence is preserved rather than truncated")

            let replaced = try StoreFixture(), (replacementStorage, _, next) = try replaced.seed()
            let seen = try replacementStorage.read(), identical = try Data(contentsOf: URL(fileURLWithPath: replaced.record(0)))
            let saved = replaced.parent + "/original-record"
            guard rename(replaced.record(0), saved) == 0 else { throw StoreFixtureFailure.invalid }
            try identical.write(to: URL(fileURLWithPath: replaced.record(0)), options: .withoutOverwriting); guard chmod(replaced.record(0), 0o600) == 0 else { throw StoreFixtureFailure.invalid }
            check(try !replacementStorage.compareExchange(seen.map(RelayTunHelperTrust.digest), next.encoded()), "identical bytes in a replaced original inode do not satisfy CAS")
            check(try replaced.names == ["0000000000.record"] && Data(contentsOf: URL(fileURLWithPath: saved)) == identical, "CAS inode conflict preserves both the replacement and the original bytes")

            let moved = try StoreFixture(), (movedStorage, _, movedNext) = try moved.seed()
            let movedSeen = try movedStorage.read(), originalDirectory = moved.parent + "/original-directory"
            guard rename(moved.path, originalDirectory) == 0, mkdir(moved.path, 0o700) == 0 else { throw StoreFixtureFailure.invalid }
            check(try !movedStorage.compareExchange(movedSeen.map(RelayTunHelperTrust.digest), movedNext.encoded()), "replacement of the journal directory itself cannot satisfy an old observation")
            check(moved.names.isEmpty && FileManager.default.fileExists(atPath: originalDirectory + "/0000000000.record"), "directory identity conflict does not mutate the replacement namespace")

            for kind in ["mode", "hardlink", "symlink", "missing", "corrupt", "unknown", "namespaceMode", "namespaceSymlink"] {
                let fixture = try StoreFixture(), (_, _, acquired) = try fixture.seed()
                if kind == "missing" {
                    let nextStorage = try fixture.storage(), previous = try nextStorage.read()
                    guard try nextStorage.compareExchange(previous.map(RelayTunHelperTrust.digest), acquired.encoded()) else { throw StoreFixtureFailure.invalid }
                    try nextStorage.sync(); _ = try nextStorage.read(); guard unlink(fixture.record(0)) == 0 else { throw StoreFixtureFailure.invalid }
                } else if kind == "mode" { guard chmod(fixture.record(0), 0o644) == 0 else { throw StoreFixtureFailure.invalid } }
                else if kind == "hardlink" { guard link(fixture.record(0), fixture.parent + "/extra-link") == 0 else { throw StoreFixtureFailure.invalid } }
                else if kind == "symlink" {
                    let destination = fixture.parent + "/source"; guard rename(fixture.record(0), destination) == 0, symlink(destination, fixture.record(0)) == 0 else { throw StoreFixtureFailure.invalid }
                } else if kind == "corrupt" { try Data("{\"version\":1".utf8).write(to: URL(fileURLWithPath: fixture.record(0))) }
                else if kind == "unknown" { try Data("preserve".utf8).write(to: URL(fileURLWithPath: fixture.path + "/unknown-file")) }
                else if kind == "namespaceMode" { guard chmod(fixture.path, 0o755) == 0 else { throw StoreFixtureFailure.invalid } }
                else if kind == "namespaceSymlink" {
                    let destination = fixture.parent + "/real-directory"; guard rename(fixture.path, destination) == 0, symlink(destination, fixture.path) == 0 else { throw StoreFixtureFailure.invalid }
                }
                let originalNames = fixture.names
                rejects("\(kind) mutation cannot be accepted as trusted recovery storage") { _ = try fixture.storage().read() }
                check(fixture.names == originalNames, "\(kind) mutation remains untouched for explicit resolution")
            }

            for kind in ["rename", "inPlaceMtimeRestored", "hardlink", "symlink", "permissions", "tailMissing"] {
                let fixture = try StoreFixture(), (warm, _, _) = try fixture.seed()
                _ = try warm.read()
                let file = fixture.record(0)
                if kind == "rename" {
                    let data = try Data(contentsOf: URL(fileURLWithPath: file))
                    guard rename(file, fixture.parent + "/cached-original") == 0 else { throw StoreFixtureFailure.invalid }
                    try data.write(to: URL(fileURLWithPath: file), options: .withoutOverwriting); _ = chmod(file, 0o600)
                } else if kind == "inPlaceMtimeRestored" {
                    var before = stat(); guard lstat(file, &before) == 0 else { throw StoreFixtureFailure.invalid }
                    var data = try Data(contentsOf: URL(fileURLWithPath: file)); data[data.startIndex] ^= 1
                    try data.write(to: URL(fileURLWithPath: file))
                    var times = [before.st_atimespec, before.st_mtimespec]
                    guard utimensat(AT_FDCWD, file, &times, 0) == 0 else { throw StoreFixtureFailure.invalid }
                } else if kind == "hardlink" { guard link(file, fixture.parent + "/cached-link") == 0 else { throw StoreFixtureFailure.invalid } }
                else if kind == "symlink" {
                    let target = fixture.parent + "/cached-target"; guard rename(file, target) == 0, symlink(target, file) == 0 else { throw StoreFixtureFailure.invalid }
                } else if kind == "permissions" { guard chmod(file, 0o640) == 0 else { throw StoreFixtureFailure.invalid } }
                else { guard unlink(file) == 0 else { throw StoreFixtureFailure.invalid } }
                let names = fixture.names
                rejects("a warm decode cache cannot hide \(kind) tampering") { _ = try warm.read() }
                check(fixture.names == names, "warm \(kind) detection preserves the altered namespace")
            }

            for point: Store.TestPoint in [.namespaceSync, .leaseSync, .beforeWrite, .fileSync, .beforePublish, .afterPublish, .directorySync] {
                let fixture = try StoreFixture(), binding = try EffectsFixture.binding()
                let storage = try fixture.storage { if $0 == point { throw StoreFixtureFailure.injected } }
                let writer = Journal.Writer(binding: binding, storage: storage); try writer.open()
                check(try writer.record(initial) == .uncertain && !writer.restorationVerified, "injected \(point) failure never acknowledges a durable network mutation intent")
                let before = fixture.names
                rejects("\(point) failure latches the original store against automatic retry") { _ = try storage.read() }
                check(fixture.names == before, "\(point) failure does not reset or delete unknown residual evidence")
                if point != .namespaceSync {
                    check(before.contains("writer.lease"), "\(point) failure retains the lease instead of treating it as stale by PID")
                    rejects("a fresh store refuses the orphaned \(point) lease") { _ = try fixture.storage().read() }
                }
            }
            let collision = try StoreFixture(), collisionStorage = try collision.storage { point in
                if point == .beforePublish { try Data("foreign destination".utf8).write(to: URL(fileURLWithPath: collision.record(0)), options: .withoutOverwriting); _ = chmod(collision.record(0), 0o600) }
            }
            _ = try collisionStorage.read()
            rejects("exclusive publication cannot replace a destination created at the link boundary") { _ = try collisionStorage.compareExchange(nil, initial.encoded()) }
            check((try Data(contentsOf: URL(fileURLWithPath: collision.record(0)))) == Data("foreign destination".utf8), "link collision preserves the exact foreign destination bytes")

            let concurrent = try StoreFixture(), a = try concurrent.storage(), b = try concurrent.storage()
            _ = try a.read(); _ = try b.read()
            let start = DispatchSemaphore(value: 0), finished = DispatchGroup(), outcomes = StoreThreadResult(), initialBytes = try initial.encoded()
            for writer in [a, b] {
                finished.enter(); DispatchQueue.global().async {
                    defer { finished.leave() }; start.wait()
                    do {
                        let accepted = try writer.compareExchange(nil, initialBytes)
                        if accepted { try writer.sync(); _ = try writer.read() }; outcomes.append(accepted)
                    } catch { outcomes.append(false) }
                }
            }
            start.signal(); start.signal()
            check(finished.wait(timeout: .now() + 15) == .success, "two real private-file writers finish bounded lease contention")
            check(outcomes.result().filter { $0 }.count == 1 && concurrent.names == ["0000000000.record"], "exclusive lease and fixed index admit exactly one competing first writer")
            check(try concurrent.storage().read() == initialBytes, "winning concurrent record remains readable as one complete chain")

            let excessive = try StoreFixture(); guard mkdir(excessive.path, 0o700) == 0 else { throw StoreFixtureFailure.invalid }
            for index in 0...Store.testCapacity.records {
                let fd = Darwin.open(excessive.record(index), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
                guard fd >= 0 else { throw StoreFixtureFailure.invalid }; Darwin.close(fd)
            }
            rejects("record-count limits reject an oversized namespace before decoding entries") { _ = try excessive.storage().read() }
            check(excessive.names.count == Store.testCapacity.records + 1, "an excessive namespace is not recursively pruned")
            let overBytes = try StoreFixture(); _ = try overBytes.seed()
            let oversizedFD = Darwin.open(overBytes.record(0), O_WRONLY | O_CLOEXEC)
            guard oversizedFD >= 0, ftruncate(oversizedFD, 300000) == 0 else { throw StoreFixtureFailure.invalid }; Darwin.close(oversizedFD)
            rejects("per-record size limits reject an oversized regular file before allocation") { _ = try overBytes.storage().read() }
            try maximumLifecycle(check: check)
        } catch { check(false, "unexpected private-file fixture error: \(error)") }
        let failures = rows.filter { $0["passed"] as? Bool != true }.count
        let report: [String: Any] = ["passed": failures == 0, "checksPassed": rows.count - failures, "checksTotal": rows.count,
            "actualRootFileAccess": false, "actualMachConnection": false, "actualNetworkChanged": false, "actualTunAccepted": false,
            "ordinaryUIDPrivateFileTests": true, "checks": rows]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
        exit(failures == 0 ? 0 : 1)
    }

    private static func shapes(count: Int, restore: Bool, undoReaffirmations: Int = 0) throws -> [Journal.Snapshot] {
        guard (0...Effects.maximumEffects).contains(count) else { throw StoreFixtureFailure.invalid }
        let binding = try EffectsFixture.binding(), device = try EffectsFixture.device()
        let routes = try (0..<count).map { index -> Effects.Effect in
            .route(try .init(destination: .init(address: EffectsFixture.address("10.0.\(index).0"), length: 24),
                            gateway: EffectsFixture.address("198.18.0.1"), interface: device.interface, scopeIndex: 0, flags: 3, hopCount: 1))
        }
        let effects = try Effects.EffectSet(planID: binding.planID, device: device, effects: routes), ids = try effects.changes().map(\.id)
        var result = [try Journal.Snapshot(binding: binding, sequence: 0, phase: .createIntent, realizedEffects: nil, pendingIDs: [])]
        func append(_ phase: Journal.Phase, _ pending: [String], observation: Journal.Observation? = nil) throws {
            result.append(try .init(binding: binding, sequence: UInt32(result.count), phase: phase, realizedEffects: effects, pendingIDs: pending, observation: observation))
        }
        try append(.acquired, [])
        for installed in 0..<count {
            let pending = Array(ids.prefix(installed + 1)); try append(.installIntent, pending); try append(.installed, pending)
        }
        try append(.active, ids)
        if restore {
            var remaining = count
            while remaining > 0 {
                let pending = Array(ids.prefix(remaining)); try append(.removeIntent, pending)
                if remaining == count { for _ in 0..<undoReaffirmations { try append(.removeIntent, pending) } }
                remaining -= 1; try append(.removed, Array(ids.prefix(remaining)))
            }
            try append(.closeIntent, [])
            try append(.restored, [], observation: .init(networkSHA256: binding.networkSHA256, protectionSHA256: binding.protectionSHA256, deviceAbsent: true))
        }
        return result
    }
    private static func maximumLifecycle(check: (Bool, String) -> Void) throws {
        let snapshots = try shapes(count: Effects.maximumEffects, restore: true, undoReaffirmations: 2 * Effects.maximumEffects)
        let expectedCount = 4 * Effects.maximumEffects + 5 + 2 * Effects.maximumEffects
        let binding = try EffectsFixture.binding()
        var lastBytes: Data?, previousRecord: String?, totalBytes = 0, recordCount = 0
        let storage = Journal.Storage(read: { lastBytes }, compareExchange: { expected, replacement in
            guard lastBytes.map(RelayTunHelperTrust.digest) == expected else { return false }
            let snapshot = try Journal.Snapshot.decode(replacement)
            let record = try Store.testRecord(snapshot, previousRecord: previousRecord, previousSnapshot: expected)
            totalBytes += record.count; recordCount += 1; previousRecord = RelayTunHelperTrust.digest(record); lastBytes = replacement; return true
        }, sync: {})
        let writer = Journal.Writer(binding: binding, storage: storage); try writer.open()
        for snapshot in snapshots { guard case .confirmed = try writer.record(snapshot) else { throw StoreFixtureFailure.invalid } }
        check(snapshots.count == expectedCount && recordCount == expectedCount && writer.lastConfirmed?.phase == .restored,
              "maximum 128-effect complete durable codec lifecycle plus 256 explicit undo intents reaches terminal")
        check(recordCount <= Store.testCapacity.records && totalBytes <= Store.testCapacity.total,
              "actual maximum-lifecycle record count and encoded bytes fit the production storage budget")
        check(Store.testCapacity.records == 6 * Effects.maximumEffects + 16 &&
              Store.testCapacity.total == Store.testCapacity.records * Store.testCapacity.perRecord,
              "the universal byte budget covers every admitted record at the record-count bound")
        check(!writer.restorationVerified, "capacity proof does not replace live restoration or deadline performance evidence")
    }
    private static func benchmark(counts: [Int]) {
        var rows: [[String: Any]] = []
        do {
            for count in counts {
                let fixture = try StoreFixture(), storage = try fixture.storage(), binding = try EffectsFixture.binding()
                let writer = Journal.Writer(binding: binding, storage: storage)
                let started = DispatchTime.now().uptimeNanoseconds
                let snapshots = try shapes(count: count, restore: false)
                try writer.open()
                for snapshot in snapshots { guard case .confirmed = try writer.record(snapshot) else { throw StoreFixtureFailure.invalid } }
                let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
                rows.append(["effects": count, "activationRecords": snapshots.count, "elapsedMilliseconds": elapsed,
                             "completed": writer.lastConfirmed?.phase == .active, "networkOperations": 0])
            }
            let report: [String: Any] = ["passed": true, "ordinaryUIDPrivateFileBenchmark": true, "actualRootFileAccess": false,
                "actualNetworkChanged": false, "actualTunAccepted": false, "results": rows]
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])); FileHandle.standardOutput.write(Data([10]))
        } catch {
            let report: [String: Any] = ["passed": false, "error": String(describing: error), "results": rows]
            if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) { FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10])) }
            exit(1)
        }
    }
}
