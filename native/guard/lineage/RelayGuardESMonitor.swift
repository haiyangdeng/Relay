import Darwin
import EndpointSecurity
import Foundation

/// A future entitled ES extension owns this client; neither Main nor the NE
/// Provider can subscribe, submit ancestry or start/stop it through XPC.
final class RelayGuardESMonitor: @unchecked Sendable {
    private final class RetainedMessage: @unchecked Sendable {
        let pointer: UnsafePointer<es_message_t>
        init(_ pointer: UnsafePointer<es_message_t>) {
            self.pointer = pointer
            es_retain_message(pointer)
        }
        deinit { es_release_message(pointer) }
    }

    typealias ExecutionPreparer = @Sendable (RelayGuardExecutionTicket, @escaping @Sendable (Bool) -> Void) -> Void

    let lineage = RelayGuardKnownLineage()
    private let queue = DispatchQueue(label: "local.relay.guard.lineage.events")
    private let lock = NSLock()
    private var client: OpaquePointer?
    private var pending = 0
    private var accepting = false
    private var subscribed = false
    private var disposing = false
    private var attempted = false
    private var stopAttempted = false
    private var observer: (@Sendable (RelayGuardLineageChange) -> Void)?
    private var executionPreparer: ExecutionPreparer?
    private var authorizations: [UUID: RelayGuardESAuthorization] = [:]
    // The event queue alone owns ticket associations and settlement order.
    private var executionTickets: [UUID: RelayGuardExecutionTicket] = [:]

    func setExecutionPreparer(_ callback: @escaping ExecutionPreparer) {
        lock.lock(); executionPreparer = callback; lock.unlock()
    }

    func observe(_ callback: @escaping @Sendable (RelayGuardLineageChange) -> Void) {
        lock.lock(); observer = callback; lock.unlock()
    }

    func health() -> RelayGuardLineageHealth {
        lock.lock(); let monitoring = subscribed && accepting; lock.unlock()
        let state = lineage.state()
        return .init(epoch: state.epoch, revision: state.revision, monitoring: monitoring,
            knownRootsAvailable: monitoring && state.knownAvailable,
            globalCoverageReady: false, losses: state.losses)
    }

    func membershipSnapshot() -> (health: RelayGuardLineageHealth, members: [RelayGuardLineageProcess]) {
        lock.lock(); let monitoring = subscribed && accepting; lock.unlock()
        let state = lineage.membershipSnapshot()
        let health = RelayGuardLineageHealth(epoch: state.epoch, revision: state.revision, monitoring: monitoring,
            knownRootsAvailable: monitoring && state.available, globalCoverageReady: false, losses: state.losses)
        let members = state.members.sorted { ($0.pid, $0.version) < ($1.pid, $1.version) }
            .map { RelayGuardLineageProcess(pid: $0.pid, pidversion: $0.version) }
        return (health, members)
    }

    func query(_ tokens: [Data]) -> (health: RelayGuardLineageHealth, results: [RelayGuardLineageResult]) {
        lock.lock(); let monitoring = subscribed && accepting; lock.unlock()
        let state = lineage.snapshot(tokens)
        let health = RelayGuardLineageHealth(epoch: state.epoch, revision: state.revision, monitoring: monitoring,
            knownRootsAvailable: monitoring && state.available, globalCoverageReady: false, losses: state.losses)
        let results = zip(tokens, state.tags).map { token, tag in
            RelayGuardLineageResult(auditToken: token, tag: tag.map {
                .init(pid: $0.process.pid, pidversion: $0.process.version, subject: $0.subject, tagVersion: $0.tagVersion)
            })
        }
        return (health, results)
    }

    func start() throws {
        guard Thread.isMainThread, RelayGuardLineageRelease.runtimeMonitoringReady,
              RelayGuardLineageRelease.systemInstallationSupported,
              RelayGuardLineageRelease.publisherTeamID != nil,
              Bundle.main.bundleIdentifier == RelayGuardLineageRelease.extensionID else {
            throw RelayGuardLineageWireFailure.unavailable
        }
        _ = try RelayGuardLineageIdentity.current()
        lock.lock()
        guard !attempted else { lock.unlock(); throw RelayGuardLineageWireFailure.stale }
        attempted = true
        lock.unlock()

        var created: OpaquePointer?
        let result = es_new_client(&created) { [weak self] _, message in self?.enqueue(message) }
        guard result == ES_NEW_CLIENT_RESULT_SUCCESS, let created else {
            notify(lineage.failed(.disconnected))
            throw RelayGuardLineageWireFailure.unavailable
        }
        lock.lock(); client = created; accepting = true; lock.unlock()
        let events = [ES_EVENT_TYPE_AUTH_EXEC, ES_EVENT_TYPE_NOTIFY_EXEC, ES_EVENT_TYPE_NOTIFY_FORK, ES_EVENT_TYPE_NOTIFY_EXIT]
        let subscription = events.withUnsafeBufferPointer {
            guard let base = $0.baseAddress else { return ES_RETURN_ERROR }
            return es_subscribe(created, base, UInt32($0.count))
        }
        guard subscription == ES_RETURN_SUCCESS else {
            stop()
            throw RelayGuardLineageWireFailure.unavailable
        }
        lock.lock(); subscribed = true; lock.unlock()
        notify(.init(changed: [], invalidateAll: true))
    }

    /// Only the owning extension's termination path uses this method. A query
    /// error or a NE client disconnect never stops/restarts the ES client.
    func stop() {
        guard Thread.isMainThread else { notify(lineage.failed(.disconnected)); return }
        lock.lock()
        guard !stopAttempted else { lock.unlock(); return }
        stopAttempted = true
        accepting = false; subscribed = false
        let existing = client
        let held = Array(authorizations.values)
        lock.unlock()
        // Finish retained requests before disposing their actual client handle.
        for authorization in held { authorization.finish(allow: false) }
        notify(lineage.failed(.disconnected))
        if let existing {
            // Stop new responder calls after every held request has had its
            // response opportunity. Disposal may wait for ES callbacks, so it
            // must not hold the lock those callbacks use.
            lock.lock(); disposing = true; lock.unlock()
            _ = es_unsubscribe_all(existing)
            let deleted = es_delete_client(existing)
            if deleted == ES_RETURN_SUCCESS {
                lock.lock(); client = nil; lock.unlock()
            }
            // Unknown disposal keeps the handle/attempt rather than restarting.
        }
    }

    private func enqueue(_ pointer: UnsafePointer<es_message_t>) {
        if pointer.pointee.event_type == ES_EVENT_TYPE_AUTH_EXEC {
            enqueueAuthorization(pointer); return
        }
        enqueueObservation(pointer, unclaimedAuthorization: false)
    }

    private func enqueueObservation(_ pointer: UnsafePointer<es_message_t>, unclaimedAuthorization: Bool) {
        lock.lock()
        guard accepting else { lock.unlock(); return }
        guard pending < 1024 else {
            lock.unlock()
            // The loss reaches subscribers without waiting behind the backlog.
            notify(lineage.failed(.queueOverflow)); return
        }
        pending += 1
        let message = RetainedMessage(pointer)
        lock.unlock()
        queue.async { [self, message] in
            defer { lock.lock(); pending -= 1; lock.unlock() }
            let change = unclaimedAuthorization
                ? lineage.observeAuthorization(message.pointer, unclaimed: true)
                : lineage.consumeMessage(message.pointer)
            if change.invalidateAll || !change.changed.isEmpty || !change.executionSettlements.isEmpty { notify(change) }
        }
    }

    private func enqueueAuthorization(_ pointer: UnsafePointer<es_message_t>) {
        lock.lock(); let owner = client.map { UInt(bitPattern: $0) }; let active = accepting; lock.unlock()
        guard let owner, active else { return }
        let admission = lineage.executionAdmission(pointer)
        guard admission.requiresHandoff else {
            // This ordinary execution never waits for the Provider or a Core.
            // Caching even an ordinary shell→env decision can skip a later
            // Claude execution, so every AUTH_EXEC response uses cache:false.
            enqueueObservation(pointer, unclaimedAuthorization: true)
            if !respondAuthorization(pointer, owner: owner, allow: true, requireAccepting: false).accepted {
                notify(lineage.failed(.disconnected))
            }
            return
        }
        let id = UUID()
        let authorization = RelayGuardESAuthorization(pointer, id: id,
            respond: { [weak self] message, allow, expiresMach in
                self?.respondAuthorization(message, owner: owner, allow: allow, expiresMach: expiresMach)
                    ?? .init(allowed: false, accepted: false)
            }, finished: { [weak self] receipt in self?.authorizationFinished(id, receipt: receipt) })
        lock.lock()
        guard accepting, client.map({ UInt(bitPattern: $0) }) == owner,
              authorizations.count < 128, pending < 1024 else {
            lock.unlock(); authorization.finish(allow: false)
            notify(lineage.failed(.queueOverflow)); return
        }
        authorizations[id] = authorization
        pending += 1
        lock.unlock()
        queue.async { [self, authorization] in
            defer { lock.lock(); pending -= 1; lock.unlock() }
            if authorization.result != nil {
                notify(lineage.observeAuthorization(authorization.message, unclaimed: false)); return
            }
            let prepared = lineage.prepareExecution(authorization.message, expiresMach: authorization.expiresMach,
                observedTerminalOrigin: admission.terminalOrigin,
                verifyNativeTarget: RelayGuardExecNativeIdentity.matches)
            notify(prepared.change)
            guard let ticket = prepared.ticket else {
                authorization.finish(allow: !prepared.requiresHandoff); return
            }
            executionTickets[id] = ticket
            if let receipt = authorization.result {
                settleFailedAuthorization(id, ticket: ticket, receipt: receipt); return
            }
            lock.lock(); let prepare = accepting ? executionPreparer : nil; lock.unlock()
            guard let prepare, lineage.currentExecution(ticket) else {
                authorization.finish(allow: false); return
            }
            prepare(ticket) { [weak self, authorization] installed in
                self?.queue.async { [weak self, authorization] in
                    guard let self, self.executionTickets[id]?.claimID == ticket.claimID,
                          authorization.result == nil else { return }
                    self.lock.lock(); let active = self.accepting; self.lock.unlock()
                    let allowed = installed && active && self.lineage.currentExecution(ticket)
                    guard let receipt = authorization.finish(allow: allowed) else { return }
                    if receipt.allowed && receipt.accepted && !self.lineage.markExecutionAllowed(ticket) {
                        self.notify(self.lineage.failed(.invalidTransition))
                    }
                }
            }
        }
        // Enqueue the AUTH observation before any reply can cause its matching
        // NOTIFY to arrive, including an immediate deadline fallback.
        authorization.arm()
    }

    private func respondAuthorization(_ message: UnsafePointer<es_message_t>, owner: UInt, allow: Bool,
                                      expiresMach: UInt64? = nil, requireAccepting: Bool = true) -> RelayGuardESAuthorization.Receipt {
        lock.lock(); defer { lock.unlock() }
        guard let client, !disposing, UInt(bitPattern: client) == owner else {
            return .init(allowed: false, accepted: false)
        }
        // Recheck lifecycle and time in the actual response critical section.
        // A queued ALLOW cannot survive stop or time spent waiting for this lock.
        let timely = expiresMach.map { mach_absolute_time() < $0 } ?? true
        let permitted = allow && (!requireAccepting || accepting) && timely
        let result = es_respond_auth_result(client, message,
            permitted ? ES_AUTH_RESULT_ALLOW : ES_AUTH_RESULT_DENY, false)
        return .init(allowed: permitted, accepted: result == ES_RESPOND_RESULT_SUCCESS)
    }
    private func authorizationFinished(_ id: UUID, receipt: RelayGuardESAuthorization.Receipt) {
        // No authorization/client lock is held here. Record response loss even
        // if identity inspection is still busy and no ticket exists yet.
        if !receipt.accepted { notify(lineage.failed(.disconnected)) }
        queue.async { [self] in
            lock.lock(); authorizations.removeValue(forKey: id); lock.unlock()
            guard let ticket = executionTickets.removeValue(forKey: id) else { return }
            if !receipt.allowed || !receipt.accepted {
                settleFailedAuthorization(id, ticket: ticket, receipt: receipt)
            }
        }
    }
    private func settleFailedAuthorization(_ id: UUID, ticket: RelayGuardExecutionTicket,
                                           receipt: RelayGuardESAuthorization.Receipt) {
        executionTickets.removeValue(forKey: id)
        notify(lineage.abortExecution(ticket, outcome: receipt.accepted && !receipt.allowed ? .aborted : .uncertain))
    }

    private func notify(_ change: RelayGuardLineageChange) {
        lock.lock(); let callback = observer; lock.unlock()
        callback?(change)
    }
}
