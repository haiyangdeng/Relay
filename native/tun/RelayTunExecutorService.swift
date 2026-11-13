import Foundation

/// Listener-owned single-session coordinator. It retains the privileged
/// executor across connection failures and supplies core proofs exclusively
/// through the same authenticated connection's reverse callback. A reconnect
/// may only restore its matching session, never reactivate it.
final class RelayTunExecutorService: RelayTunConnectionService {
    typealias Transaction = RelayTunNetworkTransaction
    typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case busy, binding, unavailable }
    private final class Owner {
        var connectionID: String
        var observer: RelayTunCoreObserver
        let uid: UInt32
        let revision: String
        let baseline: Transaction.Baseline
        let trust: RelayTunInstallationTrust
        var sessionID: String?
        var receipt: RelayTunAcquiredReceipt?
        var disconnected = false, revoked = false
        init(connectionID: String, observer: RelayTunCoreObserver, peer: RelayTunAuthenticatedPeer, baseline: Transaction.Baseline, trust: RelayTunInstallationTrust) {
            self.connectionID = connectionID; self.observer = observer; uid = peer.uid; revision = peer.installationRevision; self.baseline = baseline; self.trust = trust
        }
    }
    private struct Terminal {
        let uid: UInt32
        let revision: String
        let baseline: Transaction.Baseline
        let result: RelayTunExecutorResult
    }
    private let lock = NSLock()
    private var terminals: [String: Terminal] = [:]
    private var terminalOrder: [String] = []
    private let production: Bool
    private var inspector: ((Effects.DeviceIdentity?) throws -> Transaction.Baseline)!
    private var owner: Owner?
    private var executor: RelayTunPrivilegedExecutor!

    /// Construction is inert: no files, descriptors, Mach connections or kernel
    /// state are touched until an authenticated request reaches the live gates.
    init(backend: ((@escaping (Transaction.Plan, Effects.DeviceIdentity) throws -> String?,
                    @escaping (Transaction.Plan, Effects.DeviceIdentity) throws -> Bool,
                    @escaping () -> Bool) -> RelayTunPrivilegedExecutor.Backend)? = nil) {
        production = backend == nil
        let runtime: (Transaction.Plan, Effects.DeviceIdentity) throws -> String? = { [weak self] plan, device in
            guard let self else { return nil }; return self.runtime(plan, device: device)
        }
        let released: (Transaction.Plan, Effects.DeviceIdentity) throws -> Bool = { [weak self] plan, device in
            guard let self else { return false }; return self.released(plan, device: device)
        }
        let consent: () -> Bool = { [weak self] in
            guard let self else { return false }; self.lock.lock(); defer { self.lock.unlock() }; return (self.owner.map { !$0.disconnected && !$0.revoked } ?? false) &&
                (!self.production || RelayTunUninstallFence.permitsActivation())
        }
        var live = backend?(runtime, released, consent) ?? RelayTunPrivilegedExecutor.liveBackend(
            coreRuntime: runtime, coreReleased: released, consent: consent)
        inspector = live.inspect
        if production {
            live.retire = { [weak self] plan, sessionID, evidence, receipt in
                guard let self else { throw Failure.unavailable }
                self.lock.lock(); let owner = self.owner; self.lock.unlock()
                guard let owner, owner.sessionID == sessionID else { throw Failure.binding }
                try RelayTunJournalArchive.retire(plan: plan, sessionID: sessionID, evidenceSHA256: evidence,
                    receipt: receipt, clientUID: owner.uid, revision: owner.revision)
            }
        }
        executor = RelayTunPrivilegedExecutor(backend: live, delivered: { [weak self] plan, device, receipt in
            guard let self else { throw Failure.unavailable }
            self.lock.lock(); defer { self.lock.unlock() }
            guard let owner = self.owner, !owner.disconnected, owner.receipt == nil,
                  receipt.clientUID == owner.uid, receipt.installationRevision == owner.revision,
                  Self.matches(receipt, plan: plan, device: device) else { throw Failure.binding }
            owner.receipt = receipt; owner.sessionID = receipt.sessionID
        })
    }
    private static func matches(_ receipt: RelayTunAcquiredReceipt, plan: Transaction.Plan,
                                device: Effects.DeviceIdentity) -> Bool {
        receipt.planID == plan.id && receipt.runtimeConfigurationSHA256 == plan.runtimeConfigurationSHA256 &&
        receipt.deviceID == device.id && receipt.interfaceName == device.interface.name &&
        receipt.interfaceIndex == device.interface.index && receipt.controlID == device.controlID &&
        receipt.controlUnit == device.controlUnit && receipt.socketDeviceValue == device.socketDevice &&
        receipt.socketInodeValue == device.socketInode
    }
    private func source(_ plan: Transaction.Plan, device: Effects.DeviceIdentity,
                        allowDisconnected: Bool) -> (RelayTunCoreObserver, RelayTunAcquiredReceipt)? {
        lock.lock(); defer { lock.unlock() }
        guard let owner, allowDisconnected || (!owner.disconnected && !owner.revoked), let receipt = owner.receipt,
              Self.matches(receipt, plan: plan, device: device) else { return nil }
        return (owner.observer, receipt)
    }
    private func runtime(_ plan: Transaction.Plan, device: Effects.DeviceIdentity) -> String? {
        guard let (observer, receipt) = source(plan, device: device, allowDisconnected: false) else { return nil }
        return observer.runtime(receipt)
    }
    private func released(_ plan: Transaction.Plan, device: Effects.DeviceIdentity) -> Bool {
        lock.lock()
        guard let owner else { lock.unlock(); return false }
        // The only path that can send a duplicate first synchronously records
        // its exact receipt. No receipt is positive evidence of no delivery;
        // a possibly delivered duplicate always needs the ordinary host proof.
        let neverDelivered = owner.receipt == nil
        let disconnected = owner.disconnected
        lock.unlock()
        if disconnected && !neverDelivered { return false }
        if neverDelivered { return true }
        guard let (observer, receipt) = source(plan, device: device, allowDisconnected: true) else { return false }
        return observer.released(receipt)
    }
    func perform(request: RelayTunWireRequest, peer: RelayTunAuthenticatedPeer, trust: RelayTunInstallationTrust,
                 connectionID: String, observer: RelayTunCoreObserver) throws -> RelayTunExecutorResult {
        if production, ![.status, .revoke].contains(request.operation) {
            return try RelayTunUninstallFence.withMutation(allowRecovery: request.operation == .release) {
                try self.route(request: request, peer: peer, trust: trust, connectionID: connectionID, observer: observer)
            }
        }
        return try route(request: request, peer: peer, trust: trust, connectionID: connectionID, observer: observer)
    }
    private func terminal(_ sessionID: String, peer: RelayTunAuthenticatedPeer) throws -> RelayTunExecutorResult? {
        lock.lock(); var value = terminals[sessionID]; lock.unlock()
        if value == nil, production,
           let archived = try RelayTunJournalArchive.loadTerminal(sessionID: sessionID, clientUID: peer.uid, revision: peer.installationRevision) {
            value = Terminal(uid: archived.clientUID, revision: archived.revision, baseline: archived.plan.baseline,
                result: .init(state: archived.phase == "closed_external_change" ? .uncertain : .released,
                    sessionID: archived.sessionID, evidenceSHA256: archived.evidenceSHA256, descriptor: nil))
        }
        guard let value else { return nil }
        guard value.uid == peer.uid, value.revision == peer.installationRevision else { throw Failure.binding }
        // A terminal cache/archive is evidence of this old session, never proof
        // of today's host configuration. Every idempotent confirmation samples
        // the full current baseline, without touching an old PID or interface.
        guard try inspector(nil) == value.baseline else {
            return .init(state: .uncertain, sessionID: sessionID, evidenceSHA256: value.result.evidenceSHA256, descriptor: nil)
        }
        return value.result
    }
    private func route(request: RelayTunWireRequest, peer: RelayTunAuthenticatedPeer, trust: RelayTunInstallationTrust,
                 connectionID: String, observer: RelayTunCoreObserver) throws -> RelayTunExecutorResult {
        guard peer.uid == trust.clientUID, peer.uid > 0, peer.installationRevision == trust.revision,
              UUID(uuidString: connectionID)?.uuidString.lowercased() == connectionID else { throw Failure.binding }
        lock.lock(); let currentSessionID = owner?.sessionID; lock.unlock()
        if request.operation == .release, let sessionID = request.sessionID, sessionID != currentSessionID,
           let known = try terminal(sessionID, peer: peer) { return known }
        if production, request.operation == .prepare {
            lock.lock(); let occupied = owner != nil; lock.unlock()
            guard !occupied else { throw Failure.busy }
            try RelayTunJournalArchive.verifyLiveEmpty()
        }
        lock.lock()
        if request.operation == .prepare {
            guard owner == nil else { lock.unlock(); throw Failure.busy }
            guard let network = request.networkSHA256, let protection = request.protectionSHA256 else { lock.unlock(); throw Failure.binding }
            owner = Owner(connectionID: connectionID, observer: observer, peer: peer,
                baseline: .init(networkSHA256: network, protectionSHA256: protection), trust: trust)
        } else if let owner {
            guard owner.uid == peer.uid, owner.revision == peer.installationRevision else { lock.unlock(); throw Failure.binding }
            if owner.connectionID != connectionID {
                guard owner.disconnected, request.operation == .release, request.sessionID == owner.sessionID,
                      owner.sessionID != nil else { lock.unlock(); throw Failure.binding }
                owner.connectionID = connectionID; owner.observer = observer; owner.disconnected = false; owner.revoked = true
            }
        } else if request.operation != .status { lock.unlock(); throw Failure.binding }
        if request.operation == .revoke { owner?.revoked = true }
        lock.unlock()
        do {
            let result = try executor.perform(request: request, peer: peer, trust: trust)
            lock.lock()
            if let owner, owner.connectionID == connectionID {
                if result.state == .prepared { owner.sessionID = result.sessionID }
                if result.state == .released, let sessionID = result.sessionID {
                    terminals[sessionID] = Terminal(uid: owner.uid, revision: owner.revision, baseline: owner.baseline, result: result)
                    terminalOrder.append(sessionID)
                    if terminalOrder.count > 64 { terminals.removeValue(forKey: terminalOrder.removeFirst()) }
                }
                if !executor.hasSession { self.owner = nil }
            }
            lock.unlock()
            return result
        } catch {
            lock.lock(); if !executor.hasSession { owner = nil }; lock.unlock(); throw error
        }
    }
    func revokeAuthorization(connectionID: String) {
        lock.lock(); let matches = owner?.connectionID == connectionID
        if matches { owner?.revoked = true }; lock.unlock()
        if matches { executor.suspend() }
    }
    func disconnect(connectionID: String) {
        lock.lock()
        let captured = owner?.connectionID == connectionID ? owner : nil
        if let captured { captured.disconnected = true; captured.revoked = true }
        lock.unlock()
        guard let captured else { return }
        executor.suspend()
        // A lost prepare reply has no client-known helper session ID. Once any
        // in-flight operation settles, dispose only a positively unattempted
        // preparation. Actual/partial acquisition always remains explicit
        // recovery work, with all held capabilities retained.
        DispatchQueue.global().async { [self, captured] in
            guard let request = self.executor.unusedPreparationCancellation() else { return }
            self.lock.lock(); let sameOwner = self.owner === captured && captured.disconnected; self.lock.unlock()
            guard sameOwner else { return }
            _ = try? self.perform(request: request,
                peer: .init(uid: captured.uid, installationRevision: captured.revision), trust: captured.trust,
                connectionID: captured.connectionID, observer: captured.observer)
        }
    }
}
