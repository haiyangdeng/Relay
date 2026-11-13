import Darwin
import Foundation

/// Authenticated NE peer of the independent ES source. It never creates an ES
/// client, submits labels, changes a system preference or invents JS identity.
final class RelayGuardLineageClient: @unchecked Sendable {
    static let shared = RelayGuardLineageClient()
    private struct Job: Sendable {
        let tokens: [Data]
        let revalidations: Int
        let finish: @Sendable ([RelayGuardLineageAttribution?]) -> Void
    }
    private final class Bootstrap {
        let deadline: DispatchTime
        var total: Int?
        var members = Set<RelayGuardLineageProcess>()
        var updateThrough: UInt64?
        init(deadline: DispatchTime) { self.deadline = deadline }
    }
    private let queue = DispatchQueue(label: "local.relay.guard.lineage.client")
    private let cache = RelayGuardLineageCache()
    private var connection: NSXPCConnection?
    private var connectionID: UUID?
    private var clientNonce = ""
    private var serverNonce: String?
    private var sourceEpoch: String?
    private var requestSequence: UInt64 = 0
    private var updateSequence: UInt64 = 0
    private var executionSequence: UInt64 = 0
    private var guardRun: UUID?
    private var isCurrentRun: (@Sendable () -> Bool)?
    private var executionReadiness: (@Sendable () -> RelayGuardExecutionLease?)?
    private var pending: UUID?
    private var pendingFailure: (@Sendable (Error) -> Void)?
    private var jobs: [Job] = []
    private var startObservers: [@Sendable (Bool) -> Void] = []
    private var earlyUpdates: [Data] = []
    private var bootstrap: Bootstrap?
    private var timer: DispatchSourceTimer?
    private let callbackLock = NSLock()
    private var callbackConnection: UUID?
    private var pendingExecutionCallbacks = 0
    private var callbackUnavailable = false
    private var callbackBootstrapped = false
    private let maximumCounter: UInt64 = 9_007_199_254_740_991
    private init() {}

    func attribution(_ token: Data) -> RelayGuardLineageAttribution? {
        let observedConnection = usableCallbackConnection
        guard let label = cache.attribution(token) else { return nil }
        guard let observedConnection, observedConnection == usableCallbackConnection else {
            return .init(process: label.process, subject: label.subject, permit: nil)
        }
        return label
    }
    func current(_ permit: RelayGuardLineagePermit) -> Bool {
        guard let observedConnection = usableCallbackConnection, cache.current(permit) else { return false }
        return observedConnection == usableCallbackConnection
    }
    var health: RelayGuardLineageHealth? {
        guard let observedConnection = usableCallbackConnection, let health = cache.health,
              observedConnection == usableCallbackConnection else { return nil }
        return health
    }
    var available: Bool {
        guard let observedConnection = usableCallbackConnection, cache.available else { return false }
        return observedConnection == usableCallbackConnection
    }
    var globalCoverageReady: Bool { false }

    /// Completion belongs to an actual reply observed after this call. Merely
    /// scheduling an XPC connection or reading an old cache never returns true.
    func startAndObserve(run: UUID, isCurrentRun: @escaping @Sendable () -> Bool,
                         executionReadiness: @escaping @Sendable () -> RelayGuardExecutionLease?,
                         onRevoked: @escaping @Sendable () -> Void) async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async { [weak self] in
                guard let self, isCurrentRun(), !self.cache.exhausted else {
                    continuation.resume(returning: false); return
                }
                if let previous = self.guardRun, previous != run { self.lost() }
                guard isCurrentRun(), self.startObservers.count < 32 else {
                    continuation.resume(returning: false); return
                }
                self.guardRun = run; self.isCurrentRun = isCurrentRun
                self.executionReadiness = executionReadiness
                self.cache.beginRun(run, executionReadiness: executionReadiness, onRevoked: onRevoked)
                self.startObservers.append { continuation.resume(returning: $0) }
                if self.connection == nil { self.open() }
                else if self.serverNonce != nil, self.pending == nil {
                    if self.bootstrap != nil { self.advanceBootstrap() }
                    else { self.tick() }
                }
            }
        }
    }
    func stop(run: UUID? = nil) {
        queue.async { [weak self] in
            guard let self, let run, self.guardRun == run else { return }
            self.lost()
        }
    }

    /// Only kernel flow audit-token bytes may reach this private native API.
    /// An unavailable/error reply returns sticky positives with nil permits;
    /// it never supplies an allow/drop verdict for a previously unknown Node.
    func lookup(_ tokens: [Data]) async -> [RelayGuardLineageAttribution?] {
        await withCheckedContinuation { continuation in
            queue.async { [weak self] in
                guard let self else { continuation.resume(returning: tokens.map { _ in nil }); return }
                if (1...2).contains(tokens.count), self.callbackChannelUsable,
                   let staged = self.cache.stagedAttributions(tokens), self.callbackChannelUsable {
                    continuation.resume(returning: staged); return
                }
                guard (1...2).contains(tokens.count), tokens.allSatisfy({ $0.count == 32 && RelayGuardLineageProcess(auditToken: $0) != nil }),
                      self.jobs.count < 64, self.connection != nil, self.callbackChannelUsable else {
                    continuation.resume(returning: tokens.map(self.attribution)); return
                }
                self.jobs.append(Job(tokens: tokens, revalidations: 0, finish: { continuation.resume(returning: $0) }))
                self.pump()
            }
        }
    }

    private func open() {
        guard connection == nil else { return }
        guard !cache.exhausted, guardRun != nil, isCurrentRun?() == true, executionReadiness != nil else {
            lost(); return
        }
        do {
            let deadline = DispatchTime.now() + 10
            guard RelayGuardLineageRelease.runtimeMonitoringReady, RelayGuardLineageRelease.systemInstallationSupported,
                  !RelayGuardLineageRelease.globalCoverageReady,
                  Bundle.main.bundleIdentifier == RelayGuardContract.extensionID, getuid() == 0, geteuid() == 0 else {
                throw RelayGuardLineageWireFailure.unavailable
            }
            _ = try RelayGuardLineageIdentity.current()
            let id = UUID(), nonce = try RelayGuardLineageIdentity.nonce()
            let peer = NSXPCConnection(machServiceName: try RelayGuardLineageIdentity.machService(), options: .privileged)
            peer.setCodeSigningRequirement(try RelayGuardLineageIdentity.requirement(for: .source))
            peer.remoteObjectInterface = NSXPCInterface(with: RelayGuardLineageCommunication.self)
            peer.exportedInterface = NSXPCInterface(with: RelayGuardLineageUpdates.self)
            peer.exportedObject = RelayGuardLineageCallback(client: self, connection: id)
            peer.interruptionHandler = { [weak self] in self?.connectionLost(id) }
            peer.invalidationHandler = { [weak self] in self?.connectionLost(id) }
            guard isCurrentRun?() == true, DispatchTime.now() < deadline else { peer.invalidate(); lost(); return }
            connection = peer; connectionID = id; clientNonce = nonce
            resetCallbackChannel(id)
            serverNonce = nil; sourceEpoch = nil; requestSequence = 0; updateSequence = 0; executionSequence = 0; earlyUpdates = []
            bootstrap = Bootstrap(deadline: deadline)
            queue.asyncAfter(deadline: deadline) { [weak self] in
                guard let self, self.connectionID == id, self.bootstrap != nil else { return }
                self.lost()
            }
            peer.resume()
            send("hello") { [weak self] result in
                guard let self else { return }
                do {
                    let reply = try result.get()
                    guard self.isCurrentRun?() == true, self.callbackChannelConnected else {
                        throw RelayGuardLineageWireFailure.stale
                    }
                    self.serverNonce = reply.serverNonce; self.sourceEpoch = reply.health.epoch
                    try self.cache.apply(reply.health)
                    let waiting = self.earlyUpdates; self.earlyUpdates = []
                    for data in waiting { try self.applyUpdate(data) }
                    self.advanceBootstrap()
                } catch { self.lost() }
            }
        } catch { lost() }
    }

    private func advanceBootstrap() {
        guard let bootstrap, serverNonce != nil, pending == nil else { return }
        guard isCurrentRun?() == true, callbackChannelConnected, DispatchTime.now() < bootstrap.deadline else {
            lost(); return
        }
        if bootstrap.updateThrough != nil {
            finishBootstrapIfReady(); return
        }
        send("bootstrap") { [weak self] result in
            guard let self else { return }
            do {
                try self.applyBootstrapPage(result.get())
                self.advanceBootstrap()
            } catch { self.lost() }
        }
    }

    private func applyBootstrapPage(_ reply: RelayGuardLineageReply) throws {
        guard let bootstrap, bootstrap.updateThrough == nil, isCurrentRun?() == true,
              callbackChannelConnected, DispatchTime.now() < bootstrap.deadline,
              reply.health.epoch == sourceEpoch, let page = reply.bootstrap,
              (0...65536).contains(page.total), page.offset == bootstrap.members.count,
              bootstrap.total == nil || bootstrap.total == page.total,
              page.members.count <= 256, page.offset + page.members.count <= page.total else {
            throw RelayGuardLineageWireFailure.stale
        }
        let members = Set(page.members)
        let final = page.offset + page.members.count == page.total
        guard members.count == page.members.count, bootstrap.members.isDisjoint(with: members),
              final == (page.updateThrough != nil), final || !members.isEmpty else {
            throw RelayGuardLineageWireFailure.invalid
        }
        // Pages seed positive membership only. A later normal query supplies
        // its subject and permit after this connection completes catch-up.
        try cache.apply(reply.health, changed: page.members)
        bootstrap.total = page.total
        bootstrap.members.formUnion(members)
        bootstrap.updateThrough = page.updateThrough
    }

    private func finishBootstrapIfReady() {
        guard let bootstrap, let through = bootstrap.updateThrough, updateSequence >= through else { return }
        guard let id = connectionID, isCurrentRun?() == true, cache.available,
              completeCallbackBootstrap(id, before: bootstrap.deadline) else { lost(); return }
        self.bootstrap = nil
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.tick() }
        self.timer = timer; timer.resume()
        finishStartObservers(available); pump()
    }

    private func pump() {
        guard callbackChannelUsable, pending == nil, serverNonce != nil, !jobs.isEmpty else { return }
        let job = jobs.removeFirst()
        guard cache.canQuery(job.tokens) else {
            lost(); job.finish(job.tokens.map(attribution)); return
        }
        let baseline = updateSequence
        send("query", tokens: job.tokens) { [weak self] result in
            guard let self else { job.finish(job.tokens.map { _ in nil }); return }
            do {
                let reply = try result.get()
                guard reply.health.epoch == self.sourceEpoch else { throw RelayGuardLineageWireFailure.stale }
                try self.cache.apply(reply.health)
                try self.cache.record(reply.results, health: reply.health, grantsCurrent: baseline == self.updateSequence)
                let staleMiss = baseline != self.updateSequence && zip(job.tokens, reply.results).contains { token, result in
                    result.tag == nil && self.cache.attribution(token) == nil
                }
                if staleMiss && job.revalidations == 0 {
                    // This successfully answered snapshot was overtaken by a
                    // callback (including coalesced invalidateAll). One new,
                    // bounded read prevents exposing that old miss as a fresh
                    // classification. Never replay a failed request/mutation.
                    self.jobs.insert(Job(tokens: job.tokens, revalidations: 1, finish: job.finish), at: 0)
                    self.pump(); return
                }
                self.finishStartObservers(self.available)
                job.finish(job.tokens.map(self.attribution)); self.pump()
            } catch {
                self.lost(); job.finish(job.tokens.map(self.attribution))
            }
        }
    }

    private func tick() {
        cache.expireExecutionClaims()
        guard callbackChannelUsable, pending == nil, serverNonce != nil else { return }
        if !jobs.isEmpty { pump(); return }
        send("status") { [weak self] result in
            guard let self else { return }
            do {
                let reply = try result.get()
                guard reply.health.epoch == self.sourceEpoch else { throw RelayGuardLineageWireFailure.stale }
                try self.cache.apply(reply.health)
                self.finishStartObservers(self.available)
                self.pump()
            } catch { self.lost() }
        }
    }

    private func send(_ action: String, tokens: [Data]? = nil,
                      completion: @escaping @Sendable (Result<RelayGuardLineageReply, Error>) -> Void) {
        guard let connection, let connectionID, pending == nil, requestSequence < maximumCounter else {
            completion(.failure(RelayGuardLineageWireFailure.unavailable)); return
        }
        do {
            requestSequence += 1
            let message = try RelayGuardLineageRequest(action: action, clientNonce: clientNonce,
                serverNonce: action == "hello" ? nil : serverNonce, sequence: requestSequence, tokens: tokens)
            let data = try message.encoded(), ticket = UUID()
            pending = ticket
            pendingFailure = { completion(.failure($0)) }
            queue.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, self.pending == ticket, self.connectionID == connectionID else { return }
                self.pending = nil; self.pendingFailure = nil
                completion(.failure(RelayGuardLineageWireFailure.stale))
            }
            let finish: @Sendable (Data) -> Void = { [weak self] data in
                self?.queue.async { [weak self] in
                    guard let self, self.pending == ticket, self.connectionID == connectionID else { return }
                    self.pending = nil; self.pendingFailure = nil
                    do { completion(.success(try RelayGuardLineageReply.decode(data, for: message))) }
                    catch { completion(.failure(error)) }
                }
            }
            guard let remote = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in
                self?.connectionLost(connectionID)
            }) as? RelayGuardLineageCommunication else {
                connectionLost(connectionID); return
            }
            remote.transact(data as NSData) { [weak self] reply in
                guard reply.length <= 32768 else { self?.connectionLost(connectionID); return }
                finish(reply as Data)
            }
        } catch { completion(.failure(error)) }
    }

    fileprivate func receive(_ data: Data, connection id: UUID) {
        queue.async { [weak self] in
            guard let self, self.connectionID == id else { return }
            do {
                guard data.count <= 32768 else { throw RelayGuardLineageWireFailure.invalid }
                if self.serverNonce == nil {
                    guard self.earlyUpdates.count < 8 else { throw RelayGuardLineageWireFailure.capacity }
                    self.earlyUpdates.append(data); return
                }
                try self.applyUpdate(data)
                self.finishBootstrapIfReady()
            } catch { self.lost() }
        }
    }
    private func applyUpdate(_ data: Data) throws {
        let update = try RelayGuardLineageUpdate.decode(data)
        guard update.clientNonce == clientNonce, update.serverNonce == serverNonce, update.health.epoch == sourceEpoch,
              updateSequence < maximumCounter, update.updateSequence == updateSequence + 1 else { throw RelayGuardLineageWireFailure.stale }
        updateSequence = update.updateSequence
        try cache.apply(update.health, changed: update.changed, invalidateAll: update.invalidateAll)
    }

    private final class ExecutionReply: @unchecked Sendable {
        let send: (NSData) -> Void
        init(_ send: @escaping (NSData) -> Void) { self.send = send }
    }

    fileprivate func claimExecution(_ data: Data, connection id: UUID, reply: @escaping (NSData) -> Void) {
        guard admitExecutionCallback(id) else { reply(Data() as NSData); return }
        let response = ExecutionReply(reply)
        queue.async { [weak self, response] in
            defer { self?.releaseExecutionCallback(id) }
            guard let self, self.connectionID == id else { response.send(Data() as NSData); return }
            do {
                let frame = try self.executionFrame(data)
                guard frame.outcome == nil else { throw RelayGuardLineageWireFailure.invalid }
                var accepted: RelayGuardExecutionLease?
                if self.callbackChannelUsable, self.isCurrentRun?() == true,
                   let run = self.guardRun, let before = self.executionReadiness?(),
                   before.providerRunID == run.uuidString.lowercased(),
                   RelayGuardExecutionClock.remainingNanoseconds(until: frame.ticket.expiresMach) != nil {
                    try self.cache.apply(frame.ticket.health)
                    try self.cache.prepareExecution(frame.ticket, lease: before)
                    if self.isCurrentRun?() == true, self.executionReadiness?() == before,
                       self.callbackChannelUsable,
                       RelayGuardExecutionClock.remainingNanoseconds(until: frame.ticket.expiresMach) != nil {
                        accepted = before
                    } else { self.cache.settleExecution(frame.ticket, outcome: .uncertain) }
                }
                let acknowledgement = RelayGuardExecutionAcknowledgement(request: frame, lease: accepted)
                response.send(try acknowledgement.encoded() as NSData)
            } catch {
                response.send(Data() as NSData); self.lost()
            }
        }
    }

    fileprivate func settleExecution(_ data: Data, connection id: UUID) {
        guard admitExecutionCallback(id) else { return }
        queue.async { [weak self] in
            defer { self?.releaseExecutionCallback(id) }
            guard let self, self.connectionID == id else { return }
            do {
                let frame = try self.executionFrame(data)
                guard let outcome = frame.outcome else { throw RelayGuardLineageWireFailure.invalid }
                self.cache.settleExecution(frame.ticket, outcome: outcome)
                if self.cache.exhausted { self.lost() }
            } catch { self.lost() }
        }
    }

    private func admitExecutionCallback(_ id: UUID) -> Bool {
        callbackLock.lock()
        guard callbackConnection == id, !callbackUnavailable else { callbackLock.unlock(); return false }
        if pendingExecutionCallbacks < 128 {
            pendingExecutionCallbacks += 1; callbackLock.unlock(); return true
        }
        callbackUnavailable = true
        callbackLock.unlock()
        enqueueConnectionLoss(id)
        return false
    }
    private func releaseExecutionCallback(_ id: UUID) {
        callbackLock.lock(); defer { callbackLock.unlock() }
        if callbackConnection == id { pendingExecutionCallbacks -= 1 }
    }
    private func resetCallbackChannel(_ id: UUID?) {
        callbackLock.lock(); defer { callbackLock.unlock() }
        callbackConnection = id; pendingExecutionCallbacks = 0; callbackUnavailable = false
        callbackBootstrapped = false
    }
    private func completeCallbackBootstrap(_ id: UUID, before deadline: DispatchTime) -> Bool {
        callbackLock.lock(); defer { callbackLock.unlock() }
        guard callbackConnection == id, !callbackUnavailable, DispatchTime.now() < deadline else { return false }
        callbackBootstrapped = true
        return true
    }
    private var callbackChannelConnected: Bool {
        callbackLock.lock(); defer { callbackLock.unlock() }
        return callbackConnection != nil && !callbackUnavailable
    }
    private var callbackChannelUsable: Bool { usableCallbackConnection != nil }
    private var usableCallbackConnection: UUID? {
        callbackLock.lock(); defer { callbackLock.unlock() }
        return !callbackUnavailable && callbackBootstrapped ? callbackConnection : nil
    }

    private func executionFrame(_ data: Data) throws -> RelayGuardExecutionFrame {
        let frame = try RelayGuardExecutionFrame.decode(data)
        guard frame.clientNonce == clientNonce, frame.serverNonce == serverNonce,
              frame.ticket.health.epoch == sourceEpoch, executionSequence < maximumCounter,
              frame.executionSequence == executionSequence + 1 else { throw RelayGuardLineageWireFailure.stale }
        executionSequence = frame.executionSequence
        return frame
    }
    private func connectionLost(_ id: UUID) {
        callbackLock.lock()
        guard callbackConnection == id, !callbackUnavailable else { callbackLock.unlock(); return }
        // Existing flow callbacks may be running while the serial client queue
        // is busy. Stop grants as soon as XPC reports this exact connection lost.
        callbackUnavailable = true
        callbackLock.unlock()
        enqueueConnectionLoss(id)
    }
    private func enqueueConnectionLoss(_ id: UUID) {
        queue.async { [weak self] in guard let self, self.connectionID == id else { return }; self.lost() }
    }
    private func lost() {
        let old = connection
        let retiringRun = guardRun
        let failPending = pendingFailure
        connection = nil; connectionID = nil; pending = nil; serverNonce = nil; sourceEpoch = nil
        resetCallbackChannel(nil)
        guardRun = nil; isCurrentRun = nil; executionReadiness = nil
        pendingFailure = nil
        timer?.cancel(); timer = nil; earlyUpdates = []; bootstrap = nil
        if let retiringRun { cache.retireRun(retiringRun) }
        finishStartObservers(false)
        let waiting = jobs; jobs = []
        for job in waiting { job.finish(job.tokens.map(attribution)) }
        old?.invalidate()
        failPending?(RelayGuardLineageWireFailure.unavailable)
    }
    private func finishStartObservers(_ available: Bool) {
        let observers = startObservers; startObservers = []
        let current = available && isCurrentRun?() == true && callbackChannelUsable
        for observer in observers { observer(current) }
    }
}

private final class RelayGuardLineageCallback: NSObject, RelayGuardLineageUpdates {
    private weak var client: RelayGuardLineageClient?
    private let connection: UUID
    init(client: RelayGuardLineageClient, connection: UUID) { self.client = client; self.connection = connection }
    func updated(_ update: NSData) {
        guard update.length <= 32768 else { client?.connectionLostForMalformedCallback(connection); return }
        client?.receive(update as Data, connection: connection)
    }
    func claimExecution(_ request: NSData, withReply reply: @escaping (NSData) -> Void) {
        guard let client else { reply(Data() as NSData); return }
        guard request.length <= 32768 else {
            reply(Data() as NSData); client.connectionLostForMalformedCallback(connection); return
        }
        client.claimExecution(request as Data, connection: connection, reply: reply)
    }
    func settleExecution(_ settlement: NSData) {
        guard settlement.length <= 32768 else { client?.connectionLostForMalformedCallback(connection); return }
        client?.settleExecution(settlement as Data, connection: connection)
    }
}

private extension RelayGuardLineageClient {
    func connectionLostForMalformedCallback(_ id: UUID) { connectionLost(id) }
}
