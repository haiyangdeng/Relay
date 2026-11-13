import AppKit
import Darwin
import Foundation

@MainActor
final class RelayMaintenanceCoordinator {
    enum Mode: String { case normal, maintenance, unacquired }
    private struct Marker: Codable, Sendable {
        let version: Int
        let operationId: String
        let kind: String
        let restoreFrom: String?
        let createdAt: Int64
    }
    private struct Prepared: Codable, Sendable {
        let version: Int
        let operationId: String
        let kind: String
        let markerSHA256: String
        let original: RelayMaintenanceIdentity
        let current: RelayMaintenanceIdentity?
        let restoreFrom: String?
        let createdAt: Int64
    }
    private struct Phase: Codable, Sendable {
        let version: Int
        let operationId: String
        let step: String
        let previousSHA256: String
    }
    private struct Evidence {
        let id: String
        let fingerprint: String
        let current: RelayMaintenanceIdentity?
        let restoreId: String?
        let restoreIdentity: RelayMaintenanceIdentity?
        let isCurrent: @Sendable () -> Bool
    }
    private var mode: Mode = .unacquired
    private var lock: Int32 = -1
    private var lockIdentity: RelayMaintenanceIdentity?
    private var home = ""
    private var support: RelayMaintenanceDirectory?
    private var control: RelayMaintenanceDirectory?
    private var evidence: Evidence?
    private var working = false
    private var lastPhase = "idle"
    private let controlParts = ["Library", "Application Support", "Relay-Maintenance"]
    private let markerName = "owned-reset.json"
    private var rootURL: URL { URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/Relay-Preview") }
    private var context: RelayStateContext { .init(home: home, stateRoot: rootURL.path) }
    deinit { if lock >= 0 { Darwin.close(lock) } }

    private func directory(_ suffix: [String], create: Bool = false) throws -> RelayMaintenanceDirectory {
        try RelayMaintenanceDirectory(home: home, components: controlParts + suffix, create: create)
    }
    private func lockValid() throws {
        try RelayMaintenanceGate.ownIdentity()
        guard lock >= 0, let control, let lockIdentity else { throw RelayMaintenanceFailure.unavailable }
        try control.verify()
        var held = stat(), linked = stat()
        guard fstat(lock, &held) == 0, fstatat(control.fd, "main.lock", &linked, AT_SYMLINK_NOFOLLOW) == 0,
              try RelayMaintenanceIdentity(held) == lockIdentity, RelayMaintenanceDirectory.same(held, linked),
              held.st_mode & 0o7777 == 0o600, held.st_nlink == 1 else { throw RelayMaintenanceFailure.changed }
    }
    private func marker() throws -> (Marker, Data)? {
        guard let control, let bytes = try control.read(markerName) else { return nil }
        let object = try RelayTunStrictJSON.object(bytes, limit: 65536)
        let value = try JSONDecoder().decode(Marker.self, from: bytes)
        let expected = Set(["version", "operationId", "kind", "createdAt"] + (value.kind == "restore" ? ["restoreFrom"] : []))
        guard Set(object.keys) == expected, value.version == 1, RelayMaintenanceGate.uuid(value.operationId),
              ["reset", "restore"].contains(value.kind), value.createdAt > 0, value.createdAt <= 9_007_199_254_740_991,
              value.kind == "restore" ? (value.restoreFrom.map(RelayMaintenanceGate.uuid) == true) : value.restoreFrom == nil else { throw RelayMaintenanceFailure.invalid }
        return (value, bytes)
    }
    private func validIdentity(_ value: Any?, decoded: RelayMaintenanceIdentity) -> Bool {
        guard let object = value as? [String: Any], Set(object.keys) == ["dev", "ino", "uid", "mode"],
              let dev = RelayTunStrictJSON.integer(object["dev"]), dev >= 0,
              let ino = RelayTunStrictJSON.integer(object["ino"]), ino > 0,
              let uid = RelayTunStrictJSON.integer(object["uid"]), uid == Int(getuid()),
              let mode = RelayTunStrictJSON.integer(object["mode"]), mode >= 0, mode <= Int(UInt32.max),
              UInt32(mode) & UInt32(S_IFMT) == UInt32(S_IFDIR), mode & 0o7022 == 0 else { return false }
        return decoded.dev == UInt64(dev) && decoded.ino == UInt64(ino) && decoded.uid == UInt32(uid) && decoded.mode == UInt32(mode)
    }
    private func prepared(_ folder: RelayMaintenanceDirectory, operation: String) throws -> (Prepared, Data)? {
        guard let bytes = try folder.read("prepared.json") else { return nil }
        let object = try RelayTunStrictJSON.object(bytes)
        let item = try JSONDecoder().decode(Prepared.self, from: bytes)
        let fields = Set(["version", "operationId", "kind", "markerSHA256", "original", "createdAt"] + (item.current == nil ? [] : ["current"]) + (item.restoreFrom == nil ? [] : ["restoreFrom"]))
        guard Set(object.keys) == fields, item.version == 1, item.operationId == operation, RelayMaintenanceGate.uuid(operation),
              ["reset", "restore"].contains(item.kind), RelayMaintenanceGate.hash(item.markerSHA256), item.createdAt > 0,
              item.createdAt <= 9_007_199_254_740_991, validIdentity(object["original"], decoded: item.original),
              item.current.map({ validIdentity(object["current"], decoded: $0) }) ?? true,
              item.kind == "reset" ? item.restoreFrom == nil && item.current == item.original : item.restoreFrom.map(RelayMaintenanceGate.uuid) == true else { throw RelayMaintenanceFailure.invalid }
        return (item, bytes)
    }
    private func phase(_ folder: RelayMaintenanceDirectory, name: String, id: String, step: String, previous: Data) throws -> Data? {
        guard let bytes = try folder.read(name) else { return nil }
        let object = try RelayTunStrictJSON.object(bytes)
        let item = try JSONDecoder().decode(Phase.self, from: bytes)
        guard Set(object.keys) == ["version", "operationId", "step", "previousSHA256"], item.version == 1,
              item.operationId == id, item.step == step, item.previousSHA256 == RelayMaintenanceDirectory.hash(previous) else { throw RelayMaintenanceFailure.invalid }
        return bytes
    }
    private func publish(_ folder: RelayMaintenanceDirectory, name: String, id: String, step: String, previous: Data) throws -> Data {
        let bytes = try JSONEncoder().encode(Phase(version: 1, operationId: id, step: step, previousSHA256: RelayMaintenanceDirectory.hash(previous)))
        try folder.append(name, bytes); return bytes
    }
    private func newestOriginal() throws -> (String, RelayMaintenanceIdentity)? {
        let quarantine = try directory(["Quarantine"], create: true)
        let names = try quarantine.list()
        guard names.count <= 128 else { throw RelayMaintenanceFailure.unsafe }
        var candidates: [(String, RelayMaintenanceIdentity, Int64)] = []
        for id in names {
            guard RelayMaintenanceGate.uuid(id) else { throw RelayMaintenanceFailure.invalid }
            let folder = try directory(["Quarantine", id])
            guard let (record, bytes) = try prepared(folder, operation: id), record.kind == "reset",
                  let identity = try folder.identity("original") else { continue }
            guard identity == record.original else { throw RelayMaintenanceFailure.changed }
            // Completed resets and an interrupted reset whose original has
            // already moved can be restored explicitly. Neither is auto-resumed.
            let moved = try phase(folder, name: "original-moved.json", id: id, step: "original-moved", previous: bytes)
            if let moved { _ = try phase(folder, name: "complete.json", id: id, step: "complete", previous: moved) }
            candidates.append((id, identity, record.createdAt))
        }
        return candidates.sorted { $0.2 == $1.2 ? $0.0 > $1.0 : $0.2 > $1.2 }.first.map { ($0.0, $0.1) }
    }
    private func snapshot(isCurrent: @escaping @Sendable () -> Bool, authorize: Bool) async throws -> Evidence {
        try lockValid(); try RelayMaintenanceGate.noOtherOwnMain()
        guard isCurrent(), let support else { throw RelayMaintenanceFailure.cancelled }
        let current = try support.identity("Relay-Preview")
        let active = try marker()
        var original = try newestOriginal()
        if let active {
            let folder = try directory(["Quarantine", active.0.operationId])
            if let (record, _) = try prepared(folder, operation: active.0.operationId) {
                guard record.markerSHA256 == RelayMaintenanceDirectory.hash(active.1), record.kind == active.0.kind,
                      record.restoreFrom == active.0.restoreFrom, record.createdAt == active.0.createdAt else { throw RelayMaintenanceFailure.invalid }
                if active.0.kind == "reset", try folder.identity("original") == record.original { original = (active.0.operationId, record.original) }
            }
        }
        if authorize { try await freshIdle() }
        var parts = [current.map { String(describing: $0) } ?? "missing", active.map { RelayMaintenanceDirectory.hash($0.1) } ?? "none",
                     original?.0 ?? "none", original.map { String(describing: $0.1) } ?? "none"]
        if let active {
            let folder = try directory(["Quarantine", active.0.operationId])
            let names = try folder.list()
            guard names.count <= 16 else { throw RelayMaintenanceFailure.unsafe }
            for name in names where name.hasSuffix(".json") {
                guard let bytes = try folder.read(name) else { throw RelayMaintenanceFailure.changed }
                _ = try RelayTunStrictJSON.object(bytes); parts.append(name + ":" + RelayMaintenanceDirectory.hash(bytes))
            }
        }
        try lockValid(); try RelayMaintenanceGate.noOtherOwnMain()
        guard isCurrent() else { throw RelayMaintenanceFailure.cancelled }
        return Evidence(id: UUID().uuidString.lowercased(), fingerprint: RelayMaintenanceDirectory.hash(Data(parts.joined(separator: "\n").utf8)),
            current: current, restoreId: original?.0, restoreIdentity: original?.1, isCurrent: isCurrent)
    }
    private func rootWritersAbsent() throws {
        try RelayMaintenanceGate.noOtherOwnMain()
        try RelayMaintenanceGate.ownedWorkspacesIdle(root: rootURL)
        try RelayMaintenanceGate.shortHelpersIdle(roots: [rootURL] + (try newestOriginal().map { [rootURL.deletingLastPathComponent().appendingPathComponent("Relay-Maintenance/Quarantine/" + $0.0 + "/original")] } ?? []))
        let profile = RelayBrowserContract.profile(try RelayPreferenceStore(context))
        guard RelayBrowserProcesses.status(profile) == "closed" else { throw RelayMaintenanceFailure.pending }
        if let original = try newestOriginal() {
            let originalRoot = rootURL.deletingLastPathComponent().appendingPathComponent("Relay-Maintenance/Quarantine/" + original.0 + "/original")
            try RelayMaintenanceGate.ownedWorkspacesIdle(root: originalRoot)
            let preserved = originalRoot.appendingPathComponent("Private Browser")
            guard RelayBrowserProcesses.status(preserved) == "closed" else { throw RelayMaintenanceFailure.pending }
        }
    }
    private func freshIdle() async throws {
        try rootWritersAbsent()
        let core = try RelayCoreRecovery.perform(.init(action: .inspect, context: context, expectedRevision: nil))
        guard core.status == "clear" else { throw RelayMaintenanceFailure.pending }
        let desktop = try RelayDesktopInspection.inspect(context)
        guard desktop.records.allSatisfy({ $0.state == "missing" && $0.phase == "none" }) else { throw RelayMaintenanceFailure.pending }
        let proxy = try RelaySystemProxy.perform(.init(context: context, action: "inspect", settings: nil, expectedRevision: nil))
        guard ["inactive", "restored"].contains(proxy.status), !proxy.canRestore else { throw RelayMaintenanceFailure.pending }
        try RelayMaintenanceGate.installationIdle(root: rootURL)
        try RelayMaintenanceGate.uiResetIdle(root: rootURL)
        try RelayMaintenanceGate.backupsIdle(root: rootURL)
        try await RelayMaintenanceGate.tunIdle()
        guard let filter = await RelayGuardHostBridge.observeFilterForMaintenance(), !filter.enabled, filter.owned || !filter.exists else { throw RelayMaintenanceFailure.pending }
        try rootWritersAbsent()
    }
    private func acquire(_ requested: Mode) throws {
        guard mode == .unacquired, requested != .unacquired else { throw RelayMaintenanceFailure.invalid }
        try RelayMaintenanceGate.ownIdentity()
        home = try RelayBrowserContract.realHome().path
        support = try RelayMaintenanceDirectory(home: home, components: ["Library", "Application Support"], create: true)
        control = try directory([], create: true)
        guard let control else { throw RelayMaintenanceFailure.unsafe }
        var permissions = stat()
        guard fstat(control.fd, &permissions) == 0, permissions.st_mode & 0o7777 == 0o700 else { throw RelayMaintenanceFailure.unsafe }
        let descriptor = openat(control.fd, "main.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard descriptor >= 0 else { throw RelayMaintenanceFailure.unsafe }
        do {
            var value = stat(), linked = stat()
            guard fstat(descriptor, &value) == 0, fstatat(control.fd, "main.lock", &linked, AT_SYMLINK_NOFOLLOW) == 0,
                  value.st_uid == getuid(), value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), value.st_mode & 0o7777 == 0o600,
                  value.st_nlink == 1, RelayMaintenanceDirectory.same(value, linked), flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw RelayMaintenanceFailure.busy }
            try RelayMaintenanceGate.noOtherOwnMain()
            lock = descriptor; lockIdentity = try .init(value); mode = requested
        } catch { Darwin.close(descriptor); throw error }
        // No NE, TUN, defaults or system-proxy query during startup acquisition.
        _ = try directory(["Quarantine"], create: true); _ = try directory(["Histories"], create: true)
    }
    private func archiveMarker(_ item: Marker, bytes: Data) throws {
        guard let control, try control.read(markerName) == bytes else { throw RelayMaintenanceFailure.changed }
        let histories = try directory(["Histories"])
        let name = UUID().uuidString.lowercased() + ".json"
        do {
            try control.move(markerName, to: histories, as: name)
            guard try histories.read(name) == bytes else { throw RelayMaintenanceFailure.uncertain }
        } catch {
            // If a post-rename sync fails, best-effort re-establish the bootstrap
            // marker; no moved data is rolled back or overwritten.
            if (try? control.read(markerName)) == nil { try? control.append(markerName, bytes) }
            throw RelayMaintenanceFailure.uncertain
        }
    }
    private func mutate(_ action: String, id: String, isCurrent: @escaping @Sendable () -> Bool) async throws {
        guard let expected = evidence, expected.id == id, expected.isCurrent(), isCurrent() else { throw RelayMaintenanceFailure.changed }
        let before = try await snapshot(isCurrent: isCurrent, authorize: true)
        guard before.fingerprint == expected.fingerprint else { throw RelayMaintenanceFailure.changed }
        await RelayMaintenanceGate.releaseProbeLocks()
        // Maintenance can be admitted before a normal browser window exists.
        // The current intent and any existing modal UI still gate this action.
        try RelayGuardActionContext.check(isCurrent: isCurrent, requiresWindow: false)
        let current = try await snapshot(isCurrent: isCurrent, authorize: true)
        guard current.fingerprint == expected.fingerprint, expected.isCurrent(), isCurrent(), let control, let support else { throw RelayMaintenanceFailure.changed }
        let old = try marker()
        if let old {
            let oldFolder = try directory(["Quarantine", old.0.operationId])
            if let (record, bytes) = try prepared(oldFolder, operation: old.0.operationId) {
                let originalSlot = try oldFolder.identity("original")
                let resetAlreadyMoved = action == "reset" && old.0.kind == "reset" && current.current == nil && originalSlot == record.original
                let restoreAlreadyMoved = action == "restore" && old.0.kind == "restore" && current.current == record.original && current.restoreId != record.restoreFrom
                if resetAlreadyMoved || restoreAlreadyMoved {
                    try rootWritersAbsent(); try lockValid()
                    guard isCurrent(), expected.isCurrent() else { throw RelayMaintenanceFailure.cancelled }
                    _ = try publish(oldFolder, name: "finalized-" + UUID().uuidString.lowercased() + ".json", id: old.0.operationId, step: "explicit-finalization", previous: bytes)
                    guard fsync(support.fd) == 0, fsync(oldFolder.fd) == 0 else { throw RelayMaintenanceFailure.uncertain }
                    try archiveMarker(old.0, bytes: old.1)
                    lastPhase = action == "reset" ? "resetCompleted" : "restoreCompleted"; evidence = nil
                    return
                }
                // An explicit restore may recover the positively identified
                // quarantined original. A new immutable restore transaction is
                // atomically made active; the previous intent remains preserved.
                guard action == "restore", current.restoreId != nil, current.restoreIdentity != nil else { throw RelayMaintenanceFailure.pending }
            } else if old.0.kind != action { throw RelayMaintenanceFailure.pending }
        }
        let transaction: Marker
        let markerBytes: Data
        let needsRecoveryTransaction: Bool
        if let old { needsRecoveryTransaction = try prepared(directory(["Quarantine", old.0.operationId]), operation: old.0.operationId) != nil }
        else { needsRecoveryTransaction = false }
        if let old, !needsRecoveryTransaction { transaction = old.0; markerBytes = old.1 }
        else {
            if action == "reset" { guard current.current != nil else { throw RelayMaintenanceFailure.changed } }
            else { guard current.restoreId != nil, current.restoreIdentity != nil else { throw RelayMaintenanceFailure.changed } }
            transaction = Marker(version: 1, operationId: UUID().uuidString.lowercased(), kind: action,
                restoreFrom: action == "restore" ? current.restoreId : nil, createdAt: Int64(Date().timeIntervalSince1970 * 1000))
            _ = try directory(["Quarantine", transaction.operationId], create: true)
            markerBytes = try JSONEncoder().encode(transaction)
            guard isCurrent() else { throw RelayMaintenanceFailure.cancelled }
            if let old { try control.replaceMarker(markerName, expected: old.1, with: markerBytes) }
            else { try control.append(markerName, markerBytes) }
        }
        if mode == .normal { lastPhase = action == "reset" ? "resetScheduled" : "restoreScheduled"; evidence = nil; return }
        guard mode == .maintenance else { throw RelayMaintenanceFailure.unavailable }
        let folder = try directory(["Quarantine", transaction.operationId])
        guard try folder.read("prepared.json") == nil else { throw RelayMaintenanceFailure.pending }
        let original: RelayMaintenanceIdentity
        if action == "reset" { guard let identity = current.current else { throw RelayMaintenanceFailure.changed }; original = identity }
        else { guard transaction.restoreFrom == current.restoreId, let identity = current.restoreIdentity else { throw RelayMaintenanceFailure.changed }; original = identity }
        let prepared = Prepared(version: 1, operationId: transaction.operationId, kind: action, markerSHA256: RelayMaintenanceDirectory.hash(markerBytes),
            original: original, current: current.current, restoreFrom: transaction.restoreFrom, createdAt: transaction.createdAt)
        let preparedBytes = try JSONEncoder().encode(prepared)
        guard isCurrent() else { throw RelayMaintenanceFailure.cancelled }
        try folder.append("prepared.json", preparedBytes)
        do {
            try rootWritersAbsent(); try lockValid()
            guard isCurrent(), expected.isCurrent() else { throw RelayMaintenanceFailure.cancelled }
            var prior = preparedBytes
            if action == "reset" {
                try support.move("Relay-Preview", to: folder, as: "original", identity: original)
                prior = try publish(folder, name: "original-moved.json", id: transaction.operationId, step: "original-moved", previous: prior)
                guard try support.identity("Relay-Preview") == nil else { throw RelayMaintenanceFailure.uncertain }
            } else {
                if let current = prepared.current {
                    try support.move("Relay-Preview", to: folder, as: "displaced", identity: current)
                    prior = try publish(folder, name: "current-moved.json", id: transaction.operationId, step: "current-moved", previous: prior)
                }
                try rootWritersAbsent(); try lockValid()
                guard isCurrent(), expected.isCurrent(), let from = transaction.restoreFrom else { throw RelayMaintenanceFailure.cancelled }
                let oldFolder = try directory(["Quarantine", from])
                try oldFolder.move("original", to: support, as: "Relay-Preview", identity: original)
                prior = try publish(folder, name: "restored.json", id: transaction.operationId, step: "restored", previous: prior)
            }
            try rootWritersAbsent(); try lockValid()
            guard isCurrent(), expected.isCurrent() else { throw RelayMaintenanceFailure.cancelled }
            _ = try publish(folder, name: "complete.json", id: transaction.operationId, step: "complete", previous: prior)
            try archiveMarker(transaction, bytes: markerBytes)
            lastPhase = action == "reset" ? "resetCompleted" : "restoreCompleted"
            evidence = nil
        } catch {
            let failure = try? JSONSerialization.data(withJSONObject: ["version": 1, "operationId": transaction.operationId, "phase": "uncertain"], options: [.sortedKeys])
            if let failure { try? folder.append("uncertain-" + UUID().uuidString.lowercased() + ".json", failure) }
            lastPhase = "uncertain"; evidence = nil
            throw RelayMaintenanceFailure.uncertain
        }
    }
    private func cancel(id: String?, isCurrent: @escaping @Sendable () -> Bool) async throws {
        try lockValid()
        guard let (marker, bytes) = try marker() else { lastPhase = "idle"; return }
        guard let id, let evidence, evidence.id == id, evidence.isCurrent(), isCurrent() else { throw RelayMaintenanceFailure.changed }
        let folder = try directory(["Quarantine", marker.operationId])
        guard try folder.read("prepared.json") == nil, try folder.identity("original") == nil, try folder.identity("displaced") == nil else { throw RelayMaintenanceFailure.pending }
        try RelayGuardActionContext.check(isCurrent: isCurrent, requiresWindow: false)
        guard isCurrent(), evidence.isCurrent(), try control?.read(markerName) == bytes else { throw RelayMaintenanceFailure.changed }
        _ = try publish(folder, name: "cancelled.json", id: marker.operationId, step: "cancelled", previous: bytes)
        try archiveMarker(marker, bytes: bytes)
        self.evidence = nil; lastPhase = "cancelled"
    }
    func handle(id: String, action: String, requestedMode: String?, evidenceID: String?, isCurrent: @escaping @Sendable () -> Bool) async -> String {
        if working { return response(id: id, action: action, phase: "held", reason: "busy") }
        working = true
        defer { working = false; RelayMaintenanceGate.releaseProbeLocksSync() }
        do {
            guard isCurrent() else { throw RelayMaintenanceFailure.cancelled }
            if action == "acquire" {
                guard let text = requestedMode, let requested = Mode(rawValue: text) else { throw RelayMaintenanceFailure.invalid }
                try acquire(requested)
                // Acquisition is filesystem/signature/ownership only. Manual
                // inspect is the sole fresh system-read admission path.
                if let active = try marker() { return response(id: id, action: action, phase: active.0.kind == "reset" ? "resetScheduled" : "restoreScheduled") }
                return response(id: id, action: action, phase: "idle")
            }
            try lockValid()
            if action == "inspect" {
                let item = try await snapshot(isCurrent: isCurrent, authorize: false)
                evidence = item
                let active = try marker()
                var wasPrepared = false, mayFinalizeReset = false, mayFinalizeRestore = false
                if let active, let (record, _) = try prepared(directory(["Quarantine", active.0.operationId]), operation: active.0.operationId) {
                    wasPrepared = true
                    mayFinalizeReset = active.0.kind == "reset" && item.current == nil && item.restoreId == active.0.operationId && item.restoreIdentity == record.original
                    mayFinalizeRestore = active.0.kind == "restore" && item.current == record.original && item.restoreId != record.restoreFrom
                }
                let phase = wasPrepared ? "uncertain" : active.map { $0.0.kind == "reset" ? "resetScheduled" : "restoreScheduled" } ?? "idle"
                do { try await freshIdle() }
                catch {
                    // Eligibility failure is not a root transaction failure. A
                    // scheduled, unmutated intent remains explicitly cancellable
                    // without requiring the currently active systems to stop.
                    guard isCurrent() else { throw RelayMaintenanceFailure.cancelled }
                    let checked = try await snapshot(isCurrent: isCurrent, authorize: false)
                    guard checked.fingerprint == item.fingerprint else { throw RelayMaintenanceFailure.changed }
                    return response(id: id, action: action, phase: active == nil ? "held" : phase, reason: (error as? RelayMaintenanceFailure)?.explanation ?? "pending", proof: item)
                }
                let checked = try await snapshot(isCurrent: isCurrent, authorize: false)
                guard checked.fingerprint == item.fingerprint else { throw RelayMaintenanceFailure.changed }
                return response(id: id, action: action, phase: phase, proof: item,
                    canReset: mode == .maintenance && mayFinalizeReset || !wasPrepared && item.current != nil && (active == nil || (mode == .maintenance && active?.0.kind == "reset")),
                    canRestore: mode == .maintenance && (mayFinalizeRestore || (wasPrepared && item.restoreId != nil)) || !wasPrepared && item.restoreId != nil && (active == nil || (mode == .maintenance && active?.0.kind == "restore")))
            }
            if action == "cancel" { try await cancel(id: evidenceID, isCurrent: isCurrent) }
            else {
                guard ["reset", "restore"].contains(action), let evidenceID else { throw RelayMaintenanceFailure.invalid }
                try await mutate(action, id: evidenceID, isCurrent: isCurrent)
            }
            return response(id: id, action: action, phase: lastPhase)
        } catch let error as RelayMaintenanceFailure {
            let malformedMarker = error == .invalid || error == .unsafe || error == .changed
            let phase = error == .publisher || error == .unavailable ? "unavailable" : lastPhase == "uncertain" || (malformedMarker && markerPresent()) ? "uncertain" : "held"
            return response(id: id, action: action, phase: phase, reason: error.explanation)
        } catch { return response(id: id, action: action, phase: markerPresent() ? "uncertain" : "held", reason: "unsafe") }
    }
    private func markerPresent() -> Bool {
        guard let control else { return false }
        var metadata = stat()
        return fstatat(control.fd, markerName, &metadata, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT
    }
    private func response(id: String, action: String, phase: String, reason: String? = nil, proof: Evidence? = nil,
                          canReset: Bool = false, canRestore: Bool = false) -> String {
        var value: [String: Any] = ["version": 1, "id": id, "action": action, "phase": phase, "mode": mode.rawValue,
            "lockHeld": lock >= 0, "canReset": canReset, "canRestore": canRestore,
            "restartRequired": mode == .normal ? markerPresent() || ["resetScheduled", "restoreScheduled", "uncertain"].contains(phase) : ["resetCompleted", "restoreCompleted", "cancelled"].contains(phase)]
        if !home.isEmpty { value["rootPathSHA256"] = RelayMaintenanceDirectory.hash(Data(rootURL.path.utf8)) }
        if let reason { value["reason"] = reason }; if let proof { value["evidenceID"] = proof.id }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }
}

@objc(RelayMaintenanceHostBridge)
public final class RelayMaintenanceHostBridge: NSObject {
    @MainActor private static let coordinator = RelayMaintenanceCoordinator()
    @objc(request:validity:completion:)
    public static func request(_ text: String, validity: @escaping @Sendable () -> Bool, completion: @escaping @Sendable (String) -> Void) {
        guard let data = text.data(using: .utf8), let object = try? RelayTunStrictJSON.object(data, limit: 65536),
              RelayTunStrictJSON.integer(object["version"]) == 1,
              let id = object["id"] as? String, RelayMaintenanceGate.uuid(id),
              let action = object["action"] as? String, ["acquire", "inspect", "reset", "restore", "cancel"].contains(action) else { completion("{}"); return }
        let mode = object["mode"] as? String, evidence = object["evidenceID"] as? String
        let expected = Set(["version", "id", "action"] + (action == "acquire" ? ["mode"] : evidence == nil ? [] : ["evidenceID"]))
        guard Set(object.keys) == expected, action != "acquire" || ["normal", "maintenance"].contains(mode ?? ""),
              !["reset", "restore"].contains(action) || evidence != nil, evidence == nil || RelayMaintenanceGate.uuid(evidence!) else { completion("{}"); return }
        Task { @MainActor in completion(await coordinator.handle(id: id, action: action, requestedMode: mode, evidenceID: evidence, isCurrent: validity)) }
    }
}
