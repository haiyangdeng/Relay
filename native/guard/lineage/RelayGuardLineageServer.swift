import Darwin
import Foundation

/// Authenticated ES → NE channel. Source ancestry never passes through Main or a
/// renderer; every connection must be the publisher's actual NE extension.
final class RelayGuardLineageServer: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private struct Bootstrap {
        let health: RelayGuardLineageHealth
        let members: [RelayGuardLineageProcess]
        var offset = 0
    }
    private final class Client: @unchecked Sendable {
        let connection: NSXPCConnection
        var clientNonce: String?
        var serverNonce: String?
        var sequence: UInt64 = 0
        var updateSequence: UInt64 = 0
        var executionSequence: UInt64 = 0
        var providerRunID: String?
        var bootstrap: Bootstrap?
        init(_ connection: NSXPCConnection) { self.connection = connection }
    }
    private final class Reply: @unchecked Sendable {
        let send: (NSData) -> Void
        init(_ send: @escaping (NSData) -> Void) { self.send = send }
    }
    private struct ExecutionClaim: Sendable {
        let clientID: UUID
        let frame: RelayGuardExecutionFrame
        let finish: @Sendable (Bool) -> Void
    }

    private let monitor: RelayGuardESMonitor
    private let queue = DispatchQueue(label: "local.relay.guard.lineage.xpc")
    private var listener: NSXPCListener?
    private var clients: [UUID: Client] = [:]
    private var activeClient: UUID?
    private var executionClaims: [String: ExecutionClaim] = [:]
    private let requestLock = NSLock()
    private var pendingRequests = 0
    private let updateLock = NSLock()
    private var pendingKeys = Set<RelayGuardProcessGeneration>()
    private var pendingInvalidate = false
    private var updateScheduled = false
    private var pendingSettlements: [RelayGuardExecutionSettlement] = []
    private let maximumSequence: UInt64 = 9_007_199_254_740_991

    init(monitor: RelayGuardESMonitor) {
        self.monitor = monitor
        super.init()
        monitor.observe { [weak self] change in self?.publish(change) }
        monitor.setExecutionPreparer { [weak self] ticket, completion in
            guard let self else { completion(false); return }
            self.prepareExecution(ticket, completion: completion)
        }
    }

    func start() throws {
        guard RelayGuardLineageRelease.runtimeMonitoringReady,
              RelayGuardLineageRelease.systemInstallationSupported,
              Bundle.main.bundleIdentifier == RelayGuardLineageRelease.extensionID else {
            throw RelayGuardLineageWireFailure.unavailable
        }
        let value = NSXPCListener(machServiceName: try RelayGuardLineageIdentity.machService())
        value.setConnectionCodeSigningRequirement(try RelayGuardLineageIdentity.requirement(for: .provider))
        value.delegate = self
        listener = value
        value.resume()
    }

    func stop() {
        listener?.invalidate(); listener = nil
        queue.async { [self] in
            let existing = Array(clients.values); clients.removeAll(); activeClient = nil
            let claims = Array(executionClaims.values); executionClaims.removeAll()
            for claim in claims { claim.finish(false) }
            for client in existing { client.connection.invalidate() }
        }
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier == 0,
              let requirement = try? RelayGuardLineageIdentity.requirement(for: .provider) else { return false }
        let id = UUID()
        connection.setCodeSigningRequirement(requirement)
        connection.exportedInterface = NSXPCInterface(with: RelayGuardLineageCommunication.self)
        connection.remoteObjectInterface = NSXPCInterface(with: RelayGuardLineageUpdates.self)
        connection.exportedObject = Handler(server: self, id: id)
        connection.interruptionHandler = { [weak self] in self?.retire(id) }
        connection.invalidationHandler = { [weak self] in self?.retire(id) }
        let admitted = queue.sync { () -> Bool in
            guard clients.count < 4 else { return false }
            clients[id] = Client(connection)
            return true
        }
        guard admitted else { return false }
        connection.resume()
        return true
    }

    fileprivate func transact(_ data: Data, id: UUID, reply: @escaping (NSData) -> Void) {
        requestLock.lock()
        guard pendingRequests < 128 else {
            requestLock.unlock(); reply(Data() as NSData); retire(id); return
        }
        pendingRequests += 1
        requestLock.unlock()
        let response = Reply(reply)
        queue.async { [self, response] in
            defer { requestLock.lock(); pendingRequests -= 1; requestLock.unlock() }
            guard let client = clients[id] else { response.send(Data() as NSData); return }
            do {
                let request = try RelayGuardLineageRequest.decode(data)
                guard client.sequence < maximumSequence, request.sequence == client.sequence + 1 else {
                    throw RelayGuardLineageWireFailure.stale
                }
                let value: RelayGuardLineageReply
                if client.sequence == 0 {
                    guard request.action == "hello", activeClient == nil else { throw RelayGuardLineageWireFailure.stale }
                    let snapshot = monitor.membershipSnapshot()
                    guard snapshot.health.available, snapshot.members.count <= RelayGuardLineageBootstrapPage.maximumMembers else {
                        throw RelayGuardLineageWireFailure.unavailable
                    }
                    let nonce = try RelayGuardLineageIdentity.nonce()
                    client.clientNonce = request.clientNonce
                    client.serverNonce = nonce
                    client.bootstrap = .init(health: snapshot.health, members: snapshot.members)
                    activeClient = id
                    queue.asyncAfter(deadline: .now() + 10) { [weak self] in
                        guard let self, self.clients[id]?.bootstrap != nil else { return }
                        self.retireLocked(id)
                    }
                    value = .init(request: request, serverNonce: nonce, health: snapshot.health, results: [])
                } else {
                    guard activeClient == id, request.action != "hello", request.clientNonce == client.clientNonce,
                          let nonce = client.serverNonce, request.serverNonce == nonce else {
                        throw RelayGuardLineageWireFailure.stale
                    }
                    if request.action == "bootstrap" {
                        value = try bootstrapReply(request, id: id, client: client, nonce: nonce)
                    } else {
                        guard client.bootstrap == nil else { throw RelayGuardLineageWireFailure.stale }
                        let snapshot = monitor.query(request.tokens ?? [])
                        value = .init(request: request, serverNonce: nonce, health: snapshot.health, results: snapshot.results)
                    }
                }
                client.sequence = request.sequence
                response.send(try value.encoded() as NSData)
            } catch {
                response.send(Data() as NSData)
                retireLocked(id)
            }
        }
    }

    private func bootstrapReply(_ request: RelayGuardLineageRequest, id: UUID, client: Client,
                                nonce: String) throws -> RelayGuardLineageReply {
        guard var bootstrap = client.bootstrap else { throw RelayGuardLineageWireFailure.stale }
        let offset = bootstrap.offset, total = bootstrap.members.count
        let end = min(offset + RelayGuardLineageBootstrapPage.pageSize, total)
        let final = end == total
        if final {
            // A bootstrap request proves that the peer received the hello.
            // Include callbacks emitted here in the final page's watermark.
            deliverUpdates(helloAcknowledged: true)
        }
        // Graph changes can precede the ES callback's publish. Include
        // positives already in the graph at this second snapshot cut.
        let snapshot = final ? monitor.membershipSnapshot() : nil
        let health = snapshot?.health ?? monitor.health()
        guard activeClient == id, health.available, health.epoch == bootstrap.health.epoch,
              health.revision == bootstrap.health.revision else { throw RelayGuardLineageWireFailure.stale }
        if let snapshot {
            let initial = Set(bootstrap.members)
            let missing = snapshot.members.filter { !initial.contains($0) }
            try sendUpdates(missing, invalidate: false, health: health, id: id, client: client)
        }
        let page = RelayGuardLineageBootstrapPage(offset: offset, total: total,
            members: Array(bootstrap.members[offset..<end]), updateThrough: final ? client.updateSequence : nil)
        bootstrap.offset = end
        client.bootstrap = final ? nil : bootstrap
        return .init(request: request, serverNonce: nonce, health: health, results: [], bootstrap: page)
    }

    private func retire(_ id: UUID) {
        queue.async { [self] in retireLocked(id) }
        // A NE bridge loss neither stops nor recreates the standalone ES client.
    }

    private func retireLocked(_ id: UUID) {
        if activeClient == id { activeClient = nil }
        clients.removeValue(forKey: id)?.connection.invalidate()
        for (key, claim) in executionClaims where claim.clientID == id {
            executionClaims.removeValue(forKey: key)?.finish(false)
        }
        // No abort is inferred from connection loss: a target already staged
        // in NE remains positive-unavailable until a proven settlement/query.
    }

    func prepareExecution(_ ticket: RelayGuardExecutionTicket, completion: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            var consumedClient: UUID?
            do {
                guard monitor.lineage.currentExecution(ticket),
                      let remaining = RelayGuardExecutionClock.remainingNanoseconds(until: ticket.expiresMach),
                      let id = activeClient, let client = clients[id], client.bootstrap == nil,
                      let clientNonce = client.clientNonce, let serverNonce = client.serverNonce,
                      executionClaims.count < 64, executionClaims[ticket.claimID] == nil,
                      client.executionSequence < maximumSequence else { throw RelayGuardLineageWireFailure.unavailable }
                consumedClient = id
                client.executionSequence += 1
                let frame = try RelayGuardExecutionFrame(clientNonce: clientNonce, serverNonce: serverNonce,
                    executionSequence: client.executionSequence, ticket: ticket)
                let data = try frame.encoded()
                executionClaims[ticket.claimID] = .init(clientID: id, frame: frame, finish: completion)
                queue.asyncAfter(deadline: .now() + .nanoseconds(Int(remaining))) { [weak self] in
                    self?.finishClaim(ticket.claimID, clientID: id, result: nil)
                }
                guard let remote = client.connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in
                    self?.retire(id)
                }) as? RelayGuardLineageUpdates else { throw RelayGuardLineageWireFailure.unavailable }
                remote.claimExecution(data as NSData) { [weak self] response in
                    let data = response.length <= 32768 ? response as Data : nil
                    self?.queue.async { [weak self] in self?.finishClaim(ticket.claimID, clientID: id, result: data) }
                }
            } catch {
                // A consumed sequence without a frame is not reusable.
                if let claim = executionClaims.removeValue(forKey: ticket.claimID) {
                    claim.finish(false); retireLocked(claim.clientID)
                } else {
                    completion(false)
                    if let consumedClient { retireLocked(consumedClient) }
                }
            }
        }
    }

    private func finishClaim(_ claimID: String, clientID: UUID, result: Data?) {
        guard let claim = executionClaims.removeValue(forKey: claimID), claim.clientID == clientID else { return }
        do {
            guard let result, activeClient == clientID, let client = clients[clientID],
                  monitor.lineage.currentExecution(claim.frame.ticket),
                  RelayGuardExecutionClock.remainingNanoseconds(until: claim.frame.ticket.expiresMach) != nil else {
                throw RelayGuardLineageWireFailure.stale
            }
            let acknowledgement = try RelayGuardExecutionAcknowledgement.decode(result, for: claim.frame)
            guard let lease = acknowledgement.lease else { claim.finish(false); return }
            guard client.providerRunID == nil || client.providerRunID == lease.providerRunID else {
                throw RelayGuardLineageWireFailure.stale
            }
            client.providerRunID = lease.providerRunID
            claim.finish(true)
        } catch {
            claim.finish(false)
            retireLocked(clientID)
        }
    }

    private func publish(_ change: RelayGuardLineageChange) {
        updateLock.lock()
        var overflow = false
        let committed = Set(change.executionSettlements.filter { $0.outcome == .committed }
            .compactMap { RelayGuardProcessGeneration(token: $0.ticket.targetToken) })
        if pendingSettlements.count + change.executionSettlements.count <= 128 {
            pendingSettlements.append(contentsOf: change.executionSettlements)
        } else {
            // Recover the source's retained positives if any settlement would
            // be lost. Mark the epoch unavailable before resuming delivery.
            pendingSettlements.removeAll(); pendingInvalidate = true; overflow = true
        }
        pendingInvalidate = pendingInvalidate || change.invalidateAll
        // A live commit retains the same tagVersion as the acknowledged stage.
        // Other positive changes must survive a coalesced invalidation.
        pendingKeys.formUnion(change.changed.subtracting(committed))
        if pendingKeys.count > RelayGuardLineageBootstrapPage.maximumMembers {
            pendingInvalidate = true; overflow = true
        }
        if overflow {
            pendingKeys.removeAll()
            _ = monitor.lineage.failed(.queueOverflow)
        }
        guard !updateScheduled else {
            updateLock.unlock(); return
        }
        updateScheduled = true
        updateLock.unlock()
        queue.async { [self] in deliverUpdates() }
    }

    private func deliverUpdates(helloAcknowledged: Bool = false) {
        let client = activeClient.flatMap { clients[$0] }
        updateLock.lock()
        updateScheduled = false
        if let bootstrap = client?.bootstrap, bootstrap.offset == 0, !helloAcknowledged {
            // A newly authenticated client may not have processed hello yet.
            updateLock.unlock(); return
        }
        let invalidate = pendingInvalidate
        let settlements = pendingSettlements; pendingSettlements.removeAll()
        let keys = pendingKeys
        pendingKeys.removeAll(); pendingInvalidate = false
        updateLock.unlock()
        guard invalidate || !keys.isEmpty || !settlements.isEmpty else { return }
        var changed = Set(keys.map { RelayGuardLineageProcess(pid: $0.pid, pidversion: $0.version) })
        for settlement in settlements {
            if let claim = executionClaims.removeValue(forKey: settlement.ticket.claimID) { claim.finish(false) }
            if client?.bootstrap == nil {
                deliverSettlement(settlement)
            } else if settlement.outcome != .aborted, let target = RelayGuardLineageProcess(auditToken: settlement.ticket.targetToken) {
                // The new owner cannot consume an old owner's ACK. Carry only
                // the exact positive generation in the update sequence.
                changed.insert(target)
            }
        }
        guard let id = activeClient, let client = clients[id] else { return }
        var health = monitor.health()
        if invalidate && health.losses.contains("queueOverflow") {
            let snapshot = monitor.membershipSnapshot()
            health = snapshot.health
            changed.formUnion(snapshot.members)
        }
        let members = changed.sorted { ($0.pid, $0.pidversion) < ($1.pid, $1.pidversion) }
        do {
            try sendUpdates(members, invalidate: invalidate, health: health, id: id, client: client)
        } catch { retireLocked(id) }
    }

    private func sendUpdates(_ members: [RelayGuardLineageProcess], invalidate: Bool,
                             health: RelayGuardLineageHealth, id: UUID, client: Client) throws {
        guard !members.isEmpty || invalidate else { return }
        guard let clientNonce = client.clientNonce, let serverNonce = client.serverNonce,
              let proxy = client.connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in self?.retire(id) })
                as? RelayGuardLineageUpdates else { throw RelayGuardLineageWireFailure.unavailable }
        for offset in stride(from: 0, to: members.count, by: RelayGuardLineageBootstrapPage.pageSize) {
            let end = min(offset + RelayGuardLineageBootstrapPage.pageSize, members.count)
            try sendUpdate(client, clientNonce: clientNonce, serverNonce: serverNonce, health: health,
                changed: Array(members[offset..<end]), invalidate: false, proxy: proxy)
        }
        if invalidate {
            try sendUpdate(client, clientNonce: clientNonce, serverNonce: serverNonce, health: health,
                changed: [], invalidate: true, proxy: proxy)
        }
    }

    private func sendUpdate(_ client: Client, clientNonce: String, serverNonce: String, health: RelayGuardLineageHealth,
                            changed: [RelayGuardLineageProcess], invalidate: Bool, proxy: RelayGuardLineageUpdates) throws {
        guard client.updateSequence < maximumSequence else { throw RelayGuardLineageWireFailure.capacity }
        client.updateSequence += 1
        let update = try RelayGuardLineageUpdate(clientNonce: clientNonce, serverNonce: serverNonce,
            updateSequence: client.updateSequence, health: health, changed: changed, invalidateAll: invalidate)
        proxy.updated(try update.encoded() as NSData)
    }

    private func deliverSettlement(_ settlement: RelayGuardExecutionSettlement) {
        let ticket = settlement.ticket
        guard let id = activeClient, let client = clients[id],
              let clientNonce = client.clientNonce, let serverNonce = client.serverNonce else { return }
        do {
            guard client.executionSequence < maximumSequence else { throw RelayGuardLineageWireFailure.capacity }
            client.executionSequence += 1
            let frame = try RelayGuardExecutionFrame(clientNonce: clientNonce, serverNonce: serverNonce,
                executionSequence: client.executionSequence, ticket: ticket, outcome: settlement.outcome)
            let data = try frame.encoded()
            guard let remote = client.connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in self?.retire(id) })
                as? RelayGuardLineageUpdates else { throw RelayGuardLineageWireFailure.unavailable }
            remote.settleExecution(data as NSData)
        } catch { retireLocked(id) }
    }

    private final class Handler: NSObject, RelayGuardLineageCommunication {
        weak var server: RelayGuardLineageServer?
        let id: UUID
        init(server: RelayGuardLineageServer, id: UUID) { self.server = server; self.id = id }
        func transact(_ request: NSData, withReply reply: @escaping (NSData) -> Void) {
            guard let server else { reply(Data() as NSData); return }
            guard request.length <= 32768 else { reply(Data() as NSData); server.retire(id); return }
            server.transact(request as Data, id: id, reply: reply)
        }
    }
}
