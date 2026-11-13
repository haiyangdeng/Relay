import Foundation
import Darwin

final class CoreOwnerHost: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    let store: CoreOwnerStore
    private var child: CoreOwnerChild?, parser: CoreOwnerChild?
    private var primary: String
    private var original: String
    private var detachGrant: (id: String, revision: String, wall: TimeInterval, uptime: UInt64)?
    private var listener: Int32 = -1, clients = 0
    private var releaseAcknowledged = false, unconfirmed = false, stopAttempted = false, detachMayHaveCommitted = false
    private var attachedMain: CoreOwnerProcessIdentity, controlLost = false
    private var releasedSnapshot: CoreOwnerSnapshot?
    private var retiredUnknown = false
    private var childrenClosed: Bool { (child == nil || child?.exited == true) && (parser == nil || parser?.exited == true) }
    private let sessionId: String
    init(store: CoreOwnerStore, connection: CoreOwnerConnection) { self.store = store; primary = connection.id; original = connection.id; sessionId = store.journal.sessionId; attachedMain = connection.main }
    private func assertPrimary(_ connection: CoreOwnerConnection) throws {
        guard primary == connection.id, attachedMain == connection.main,
              !controlLost else { throw CoreOwnerFailure.control }
        try CoreOwnerIdentity.verify(connection.main, identifier: RelayCoreOwnerRelease.applicationID)
    }
    private func snapshot(fresh: Bool = false) -> CoreOwnerSnapshot {
        if let releasedSnapshot { return releasedSnapshot }
        if fresh && ["ready", "detachPrepared", "detached"].contains(store.journal.phase) {
            do { try store.assertCurrent(); try CoreOwnerCore.verify(store.journal, child: child) }
            catch { unconfirmed = true; try? store.persist { $0.phase = "uncertain" }; detachGrant = nil }
        }
        var observed = store.journal
        if unconfirmed { observed.phase = "uncertain" }
        if store.releasePending && childrenClosed { observed.phase = "closed"; observed.detached = false }
        observed.attachedMain = attachedMain; observed.controlLost = controlLost
        return observed.snapshot(revision: store.revision,
                                 warnings: store.releasePending ? ["releaseFinalizationRequired"] : observed.phase == "uncertain" ? ["ownerStateUnconfirmed"] : [])
    }
    func initial(requestId: String, connection: CoreOwnerConnection) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return try response(requestId: requestId, connection: connection, status: "ok", snapshot: snapshot(fresh: true))
    }
    private func response(requestId: String, connection: CoreOwnerConnection, status: String, snapshot: CoreOwnerSnapshot,
                          error: String? = nil, detach: [String: Any]? = nil) throws -> [String: Any] {
        var output: [String: Any] = ["version": 1, "contract": RelayCoreOwnerRelease.contract, "requestId": requestId,
                                   "status": status, "connectionId": connection.id, "clientNonce": connection.clientNonce,
                                   "serverNonce": connection.serverNonce, "sequence": connection.sequence,
                                   "snapshot": try coreOwnerObject(coreOwnerEncode(snapshot), limit: 65536)]
        if let error { output["error"] = error }; if let detach { output["detach"] = detach }; return output
    }
    func handle(_ bytes: Data, connection: inout CoreOwnerConnection) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let request = try coreOwnerObject(bytes), requestID = try coreOwnerUUID(request["requestId"])
        let base: Set<String> = ["version", "contract", "requestId", "sessionId", "connectionId", "clientNonce", "serverNonce", "sequence", "action"]
        guard RelayTunStrictJSON.integer(request["version"]) == 1, request["contract"] as? String == RelayCoreOwnerRelease.contract,
              request["sessionId"] as? String == store.journal.sessionId, request["connectionId"] as? String == connection.id,
              request["clientNonce"] as? String == connection.clientNonce, request["serverNonce"] as? String == connection.serverNonce,
              let sequence = coreOwnerSafeInteger(request["sequence"]), sequence == connection.sequence + 1,
              sequence <= 9_007_199_254_740_991, let action = request["action"] as? String else { throw CoreOwnerFailure.invalid }
        let extras: [String: Set<String>] = ["launch": ["configuration"], "inspect": [], "reattach": ["expectedRevision"],
            "detachPrepare": ["expectedRevision"], "detachCommit": ["expectedRevision", "evidenceId"], "cancelDetach": [],
            "stop": ["expectedRevision"], "release": ["expectedRevision"]]
        guard let extra = extras[action], Set(request.keys) == base.union(extra) else { throw CoreOwnerFailure.invalid }
        connection.sequence = sequence
        do {
            if let releasedSnapshot {
                return try response(requestId: requestID, connection: connection, status: "refused", snapshot: releasedSnapshot, error: "released")
            }
            if !["stop", "reattach"].contains(action) && !(store.releasePending && ["release", "inspect"].contains(action)) { try store.assertCurrent() }
            try CoreOwnerIdentity.verify(connection.main, identifier: RelayCoreOwnerRelease.applicationID)
            if extra.contains("expectedRevision") { guard try coreOwnerSHA(request["expectedRevision"]) == store.revision else { throw CoreOwnerFailure.stale } }
            switch action {
            case "inspect": return try response(requestId: requestID, connection: connection, status: "ok", snapshot: snapshot(fresh: true))
            case "launch":
                try assertPrimary(connection)
                guard original == connection.id, store.journal.phase == "reserved", child == nil, parser == nil,
                      let raw = request["configuration"] as? String else { throw CoreOwnerFailure.refused }
                try launch(raw, main: connection.main)
            case "reattach":
                let sameMain = attachedMain == connection.main
                guard sameMain || ((store.journal.detached || controlLost || detachMayHaveCommitted) &&
                      CoreOwnerIdentity.positivelyAbsent(attachedMain)) else { throw CoreOwnerFailure.refused }
                if store.releasePending {
                    guard childrenClosed, store.journal.phase == "closed" else { throw CoreOwnerFailure.uncertain }
                    // Keep the original closed journal bytes for finalization;
                    // only the authenticated in-memory connection changes.
                    primary = connection.id; attachedMain = connection.main; controlLost = false
                    detachGrant = nil; unconfirmed = true
                } else {
                    var confirmed = false
                    do { try store.reconcileAttempt(); try CoreOwnerCore.verify(store.journal, child: child); confirmed = true } catch { }
                    primary = connection.id; attachedMain = connection.main; controlLost = false
                    do { try store.persist { $0.attachedMain = connection.main; $0.controlLost = false; $0.detached = false; $0.phase = confirmed ? "ready" : "uncertain" } }
                    catch { confirmed = false }
                    detachGrant = nil; unconfirmed = !confirmed
                    if confirmed { detachMayHaveCommitted = false }
                }
            case "detachPrepare":
                try assertPrimary(connection)
                guard store.journal.phase == "ready", !store.journal.detached else { throw CoreOwnerFailure.refused }
                try CoreOwnerCore.verify(store.journal, child: child)
                let id = UUID().uuidString.lowercased(), wall = Date().timeIntervalSince1970, uptime = DispatchTime.now().uptimeNanoseconds
                try store.persist { $0.phase = "detachPrepared" }
                detachGrant = (id, store.revision, wall, uptime)
                return try response(requestId: requestID, connection: connection, status: "ok", snapshot: snapshot(),
                                    detach: ["evidenceId": id, "revision": store.revision, "expiresAt": Int64((wall + 30) * 1000)])
            case "detachCommit":
                try assertPrimary(connection)
                guard store.journal.phase == "detachPrepared", let grant = detachGrant,
                      request["evidenceId"] as? String == grant.id, grant.revision == store.revision,
                      Date().timeIntervalSince1970 >= grant.wall, Date().timeIntervalSince1970 - grant.wall <= 30,
                      DispatchTime.now().uptimeNanoseconds >= grant.uptime,
                      DispatchTime.now().uptimeNanoseconds - grant.uptime <= 30_000_000_000 else { throw CoreOwnerFailure.stale }
                try CoreOwnerCore.verify(store.journal, child: child)
                try assertPrimary(connection)
                // Durable commit before reply; an ambiguous reply never rolls
                // back or stops the now-detached traffic child.
                detachMayHaveCommitted = true
                try store.persist { $0.detached = true; $0.phase = "detached" }
                detachGrant = nil
            case "cancelDetach":
                try assertPrimary(connection); detachGrant = nil
                if store.journal.phase == "detachPrepared", !store.journal.detached { try store.persist { $0.phase = "ready" } }
            case "stop":
                try assertPrimary(connection); try stop()
            case "release":
                try assertPrimary(connection)
                guard (child == nil || child?.exited == true), parser == nil || parser?.exited == true else { throw CoreOwnerFailure.refused }
                let final = try store.release()
                releasedSnapshot = final
                return try response(requestId: requestID, connection: connection, status: "ok", snapshot: final)
            default: throw CoreOwnerFailure.invalid
            }
            return try response(requestId: requestID, connection: connection, status: "ok", snapshot: snapshot())
        } catch {
            let code = (error as? CoreOwnerFailure) ?? .uncertain
            if [.record, .identity, .resource, .uncertain].contains(code) {
                detachGrant = nil; unconfirmed = true
                if !store.releasePending { try? store.persist { $0.phase = "uncertain" } }
            }
            return try response(requestId: requestID, connection: connection,
                                status: unconfirmed || store.releasePending || store.journal.phase == "uncertain" ? "uncertain" : "refused", snapshot: snapshot(), error: code.rawValue)
        }
    }
    private func launch(_ raw: String, main: CoreOwnerProcessIdentity) throws {
        let bytes = try CoreOwnerCore.configuration(raw, runtime: store.journal.runtime)
        let (executable, hash) = try CoreOwnerCore.resource(selfIdentity: store.ownerIdentity)
        guard hash == store.journal.runtime.coreResourceSHA256 else { throw CoreOwnerFailure.resource }
        try CoreOwnerFiles.publish(bytes, path: store.workspace + "/config.yaml", maximum: 2 * 1024 * 1024)
        try store.persist { $0.runtime.configurationSHA256 = coreOwnerHash(bytes); $0.phase = "starting" }
        try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
        let check = try CoreOwnerChild(executable: executable, directory: store.workspace, parser: true); parser = check
        try check.launch(); try check.parserResult(); check.closeStreams(); parser = nil
        try store.assertCurrent(); try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
        let process = try CoreOwnerChild(executable: executable, directory: store.workspace, parser: false); child = process
        try process.launch()
        // Parent identity is checked from the OS after spawn, not accepted from
        // a caller PID. A crash before this persistence is explicitly unknown.
        let identity = try CoreOwnerIdentity.capture(process.pid)
        guard try CoreOwnerIdentity.process(identity.pid).pbi_ppid == UInt32(getpid()), identity.executable == executable,
              identity.resourceSHA256 == hash else { throw CoreOwnerFailure.identity }
        try store.persist { $0.core = identity }
        let deadline = DispatchTime.now().uptimeNanoseconds + 8_000_000_000
        var ready = false
        while !process.exited, DispatchTime.now().uptimeNanoseconds < deadline {
            try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
            do { try CoreOwnerCore.verify(store.journal, child: process); ready = true; break }
            catch { usleep(50000) }
        }
        guard ready else { throw CoreOwnerFailure.uncertain }
        try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
        try store.updateLease(phase: "running", pid: identity.pid)
        try store.persist { $0.phase = "ready" }
    }
    private func stop(fromEOF: Bool = false) throws {
        if store.releasePending {
            guard childrenClosed else { throw CoreOwnerFailure.uncertain }
            return // Actual held children already exited; never re-signal them.
        }
        if fromEOF, stopAttempted, child?.exited != true || parser?.exited == false { throw CoreOwnerFailure.uncertain }
        stopAttempted = true
        detachGrant = nil
        var recorded = true
        do { try store.reconcileAttempt(); try store.persist { $0.phase = "stopping" }; try store.updateLease(phase: "stopping", pid: child?.pid) }
        catch { recorded = false; unconfirmed = true }
        if let parser { try parser.stop(); parser.closeStreams(); self.parser = nil }
        if let child { try child.stop(); child.closeStreams() }
        guard child == nil || child?.exited == true else { throw CoreOwnerFailure.uncertain }
        detachMayHaveCommitted = false
        guard recorded else { throw CoreOwnerFailure.uncertain }
        try store.persist { $0.phase = "closed"; $0.detached = false }
        unconfirmed = false
    }
    func lost(_ connection: CoreOwnerConnection) {
        lock.lock(); defer { lock.unlock() }
        guard primary == connection.id, !releaseAcknowledged else { return }
        if releasedSnapshot != nil { releaseAcknowledged = true; return }
        detachGrant = nil
        controlLost = true
        if store.releasePending {
            if childrenClosed && store.knownArchivedAfterFailure() { retiredUnknown = true; releaseAcknowledged = true }
            return
        }
        do { try store.persist { $0.controlLost = true } } catch { unconfirmed = true }
        if store.journal.detached || detachMayHaveCommitted { return }
        guard CoreOwnerIdentity.positivelyAbsent(attachedMain) else {
            unconfirmed = true; try? store.persist { $0.phase = "uncertain" }; return
        }
        do {
            try stop(fromEOF: true)
            _ = try store.release(); releaseAcknowledged = true
        } catch {
            unconfirmed = true
            if !store.releasePending { try? store.persist { $0.phase = "uncertain"; $0.controlLost = true } }
        }
    }
    func didFlush(_ response: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        if releasedSnapshot != nil, (response["snapshot"] as? [String: Any])?["released"] as? Bool == true { releaseAcknowledged = true }
    }
    var exitWasUncertain: Bool { lock.lock(); defer { lock.unlock() }; return retiredUnknown }
    var canExit: Bool { lock.lock(); defer { lock.unlock() }; return releaseAcknowledged }
    func startListener() throws {
        listener = try CoreOwnerIO.listener(store.controlSocket)
        DispatchQueue(label: "Relay.core-owner.accept").async { [self] in
            while !canExit {
                var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
                if poll(&descriptor, 1, 1000) <= 0 { continue }
                let fd = Darwin.accept(listener, nil, nil)
                guard fd >= 0 else { continue }
                lock.lock(); let accepted = clients < 4; if accepted { clients += 1 }; lock.unlock()
                if !accepted { Darwin.close(fd); continue }
                DispatchQueue.global(qos: .userInitiated).async { [self] in
                    defer { Darwin.close(fd); lock.lock(); clients -= 1; lock.unlock() }
                    do { try serveClient(fd) } catch { }
                }
            }
            Darwin.close(listener)
        }
    }
    private func serveClient(_ fd: Int32) throws {
        try CoreOwnerIO.configure(fd)
        let helper = try CoreOwnerIdentity.peer(fd, selfIdentity: store.ownerIdentity), main = try CoreOwnerIdentity.mainParent(helper.pid)
        guard let data = try CoreOwnerIO.frame(fd, maximum: 8192) else { throw CoreOwnerFailure.control }
        let hello = try coreOwnerObject(data, limit: 8192)
        guard Set(hello.keys) == ["version", "contract", "requestId", "action", "sessionId", "clientNonce"],
              RelayTunStrictJSON.integer(hello["version"]) == 1, hello["contract"] as? String == RelayCoreOwnerRelease.contract,
              hello["action"] as? String == "hello", hello["sessionId"] as? String == sessionId else { throw CoreOwnerFailure.invalid }
        let requestID = try coreOwnerUUID(hello["requestId"]), nonce = try coreOwnerSHA(hello["clientNonce"])
        var connection = CoreOwnerConnection(id: UUID().uuidString.lowercased(), clientNonce: nonce, serverNonce: try coreOwnerNonce(), main: main)
        try CoreOwnerIdentity.verify(helper, identifier: RelayCoreOwnerRelease.helperID)
        try CoreOwnerIO.reply(initial(requestId: requestID, connection: connection), to: fd)
        defer { lost(connection) }
        while !canExit, let request = try CoreOwnerIO.frame(fd, maximum: 3 * 1024 * 1024, idle: true) {
            try CoreOwnerIdentity.verify(helper, identifier: RelayCoreOwnerRelease.helperID)
            let response = try handle(request, connection: &connection)
            try CoreOwnerIO.reply(response, to: fd); didFlush(response)
        }
    }
}
