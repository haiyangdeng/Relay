import Foundation
import Darwin

/// The privileged wire executor over the held-device session stack. It binds
/// the authenticated peer, the exact typed projection bytes, the preparation
/// evidence and the session to one in-memory lifetime. It never reads a
/// caller-selected path, PID, descriptor number or renderer Boolean, and it
/// never treats a wire digest as proof of network state.
///
/// HelperMain constructs the live backend through its listener-owned service.
/// Runtime/release proofs come only from that connection's authenticated
/// reverse observer, bound to this executor's actual acquired-FD receipt.
final class RelayTunPrivilegedExecutor: RelayTunNetworkExecutor {
    typealias Session = RelayTunNetworkSession
    typealias Transaction = RelayTunNetworkTransaction
    typealias Effects = RelayTunNetworkEffects
    typealias Projection = RelayTunNetworkProjection
    enum Failure: Error { case invalid, busy, state, evidence, uncertain, permission }

    /// Typed capability seams. Production uses the strict baseline inspector
    /// and the connection-bound reverse observer; isolated tests replace both
    /// without creating devices or accepting caller readiness booleans.
    struct Backend {
        /// Real effective privilege. It is injectable only so policy proofs can
        /// run outside root; every injected replacement must also prove the
        /// production closure still refuses an ordinary UID.
        let rootGate: () -> Bool
        let inspect: (Effects.DeviceIdentity?) throws -> Transaction.Baseline
        let lease: (Transaction.Plan, RelayTunDeviceLease.Configuration) throws -> Session.Lease
        let storage: (Transaction.Plan) throws -> RelayTunNetworkJournal.Storage
        let route: (Session.RouteContext) throws -> RelayTunRouteAdapter
        let resolver: (Session.ResolverContext) throws -> RelayTunResolverAdapter
        /// Positive ordinary-UID host observation: the generated runtime digest
        /// only while the fixed core is actually ready on the delivered FD.
        let coreRuntime: (Transaction.Plan, Effects.DeviceIdentity) throws -> String?
        /// Positive proof the owned core exited and its client FD copies closed.
        let coreReleased: (Transaction.Plan, Effects.DeviceIdentity) throws -> Bool
        let now: () -> UInt64
        var retire: (Transaction.Plan, String, String, RelayTunAcquiredReceipt?) throws -> Void = { _, _, _, _ in }
    }

    private final class Current {
        let session: Session
        let plan: Transaction.Plan
        let projection: Projection
        let evidenceSHA256: String
        let sessionID: String
        var acquisitionAttempted = false
        var receipt: RelayTunAcquiredReceipt?
        init(session: Session, plan: Transaction.Plan, projection: Projection, evidenceSHA256: String, sessionID: String) {
            self.session = session; self.plan = plan; self.projection = projection
            self.evidenceSHA256 = evidenceSHA256; self.sessionID = sessionID
        }
    }

    private let backend: Backend
    private let delivered: ((Transaction.Plan, Effects.DeviceIdentity, RelayTunAcquiredReceipt) throws -> Void)?
    private let snapshotLock = NSLock()
    private var publishedSession: Session?
    private var publishedSessionID: String?
    private var suspensionGeneration: UInt64 = 0
    private func generation() -> UInt64 { snapshotLock.lock(); defer { snapshotLock.unlock() }; return suspensionGeneration }
    var hasSession: Bool { snapshotLock.lock(); defer { snapshotLock.unlock() }; return publishedSession != nil }
    private func publish(_ session: Session?, id: String?) {
        snapshotLock.lock(); publishedSession = session; publishedSessionID = id; snapshotLock.unlock()
    }
    private let lock = NSLock()
    private var current: Current?
    // Consent is the in-memory acceptance of one authenticated preparation.
    // It is not a durable authorization, a user gesture or a plan substitute.
    private let consentLock = NSLock()
    private var consent = false
    private func consentActive() -> Bool { consentLock.lock(); defer { consentLock.unlock() }; return consent }
    private func setConsent(_ value: Bool) { consentLock.lock(); consent = value; consentLock.unlock() }

    init(backend: Backend, delivered: ((Transaction.Plan, Effects.DeviceIdentity, RelayTunAcquiredReceipt) throws -> Void)? = nil) {
        self.backend = backend; self.delivered = delivered
    }

    private static func evidence(installationRevision: String, clientUID: uid_t, plan: Transaction.Plan,
                                 bundleSHA256: String) throws -> String {
        let value: [String: Any] = ["version": 1, "role": "tun-preparation-evidence",
            "installationRevision": installationRevision, "clientUID": clientUID, "planID": plan.id,
            "configurationSHA256": plan.configurationSHA256, "runtimeConfigurationSHA256": plan.runtimeConfigurationSHA256,
            "bundleSHA256": bundleSHA256, "effectsSHA256": plan.effectsSHA256,
            "networkSHA256": plan.baseline.networkSHA256, "protectionSHA256": plan.baseline.protectionSHA256,
            "createdAt": String(plan.createdAt), "expiresAt": String(plan.expiresAt),
            "routeRemovalPolicy": plan.routeRemovalPolicy.rawValue]
        return RelayTunHelperTrust.digest(try Effects.bytes(value))
    }

    private func makeSession(trust: RelayTunInstallationTrust) throws -> Session {
        try Session(installationRevision: trust.revision, clientUID: trust.clientUID,
            driver: .init(authorized: { [weak self] in self?.consentActive() ?? false },
                inspect: backend.inspect,
                acquire: { [weak self] plan in
                    guard let self, let current = self.current, current.plan == plan,
                          self.consentActive() else { throw Failure.state }
                    let configuration = try RelayTunDeviceLease.Configuration(device: current.projection.device,
                        mtu: current.projection.mtu, addresses: current.projection.addresses,
                        projectionSHA256: plan.effectsSHA256)
                    return try self.backend.lease(plan, configuration)
                },
                realize: { [weak self] plan, device in
                    guard let self, let current = self.current, current.plan == plan else { throw Failure.state }
                    return try current.projection.realize(planID: plan.id, device: device)
                },
                verifyProjection: { [weak self] plan, effects in
                    guard let self, let current = self.current, current.plan == plan else { throw Failure.state }
                    try current.projection.verify(plan: plan, effects: effects)
                },
                storage: backend.storage, route: backend.route, resolver: backend.resolver,
                coreRuntime: backend.coreRuntime, coreReleased: backend.coreReleased, now: backend.now))
    }

    func perform(request: RelayTunWireRequest, peer: RelayTunAuthenticatedPeer,
                 trust: RelayTunInstallationTrust) throws -> RelayTunExecutorResult {
        guard backend.rootGate(), peer.uid == trust.clientUID, peer.uid > 0,
              peer.installationRevision == trust.revision else { throw Failure.permission }
        if request.operation == .revoke {
            snapshotLock.lock(); let session = publishedSession
            let matches = request.sessionID == publishedSessionID && publishedSessionID != nil
            if matches { suspensionGeneration &+= 1 }; snapshotLock.unlock()
            guard matches, let session else { throw Failure.evidence }
            session.invalidatePreparation()
            return .init(state: .revoked, sessionID: request.sessionID, evidenceSHA256: nil, descriptor: nil)
        }
        let initialGeneration = generation()
        lock.lock(); defer { lock.unlock() }
        switch request.operation {
        case .status:
            guard let current else { return .init(state: .idle, sessionID: nil, evidenceSHA256: nil, descriptor: nil) }
            return .init(state: .uncertain, sessionID: current.sessionID,
                         evidenceSHA256: current.evidenceSHA256, descriptor: nil)
        case .prepare:
            guard current == nil else { throw Failure.state }
            guard let bytes = request.projection, let bundleSHA256 = request.bundleSHA256,
                  let configurationSHA256 = request.configurationSHA256,
                  let runtimeConfigurationSHA256 = request.runtimeConfigurationSHA256 else { throw Failure.invalid }
            let projection = try Projection.decode(bytes)
            guard projection.encoded() == bytes else { throw Failure.invalid }
            setConsent(true)
            do {
                let session = try makeSession(trust: trust)
                let plan = try session.prepare(configurationSHA256: configurationSHA256,
                    runtimeConfigurationSHA256: runtimeConfigurationSHA256, effectsSHA256: projection.sha256)
                guard plan.baseline.networkSHA256 == request.networkSHA256,
                      plan.baseline.protectionSHA256 == request.protectionSHA256,
                      initialGeneration == generation() else { session.invalidatePreparation(); throw Failure.evidence }
                let evidence = try Self.evidence(installationRevision: trust.revision,
                    clientUID: trust.clientUID, plan: plan, bundleSHA256: bundleSHA256)
                let sessionID = UUID().uuidString.lowercased()
                current = Current(session: session, plan: plan, projection: projection,
                                  evidenceSHA256: evidence, sessionID: sessionID)
                publish(session, id: sessionID)
                guard initialGeneration == generation() else { session.invalidatePreparation(); throw Failure.state }
                return .init(state: .prepared, sessionID: sessionID, evidenceSHA256: evidence, descriptor: nil)
            } catch { if current == nil { setConsent(false) }; throw error }
        case .acquire:
            guard let current, request.evidenceSHA256 == current.evidenceSHA256 else { throw Failure.evidence }
            defer { current.acquisitionAttempted = current.session.acquisitionAttempted }
            let status = try current.session.acquire(current.plan)
            guard status.phase == .acquired else { throw Failure.uncertain }
            let delivery = try current.session.duplicateForDelivery(current.plan)
            do {
                let identity = delivery.identity
                let receipt = try RelayTunAcquiredReceipt(installationRevision: trust.revision,
                    clientUID: trust.clientUID, evidenceSHA256: current.evidenceSHA256,
                    runtimeConfigurationSHA256: current.plan.runtimeConfigurationSHA256,
                    planID: current.plan.id, sessionID: current.sessionID, deviceID: identity.id,
                    interfaceName: identity.interface.name, interfaceIndex: identity.interface.index,
                    controlID: identity.controlID, controlUnit: identity.controlUnit,
                    socketDevice: String(identity.socketDevice), socketInode: String(identity.socketInode))
                current.receipt = receipt
                try delivered?(current.plan, identity, receipt)
                return .init(state: .acquired, sessionID: current.sessionID,
                             evidenceSHA256: current.evidenceSHA256, descriptor: delivery.descriptor,
                             acquisition: receipt)
            } catch { try? delivery.descriptor.close(); throw error }
        case .activate:
            guard let current, request.sessionID == current.sessionID,
                  request.evidenceSHA256 == current.evidenceSHA256,
                  request.runtimeConfigurationSHA256 == current.plan.runtimeConfigurationSHA256 else { throw Failure.evidence }
            let status = try current.session.activate(current.plan)
            if status.phase == .active {
                return .init(state: .active, sessionID: current.sessionID,
                             evidenceSHA256: current.evidenceSHA256, descriptor: nil)
            }
            // Activation failure keeps its obligations; release remains open.
            return .init(state: .uncertain, sessionID: current.sessionID,
                         evidenceSHA256: current.evidenceSHA256, descriptor: nil)
        case .revoke: throw Failure.state // handled before the I/O lock
        case .release:
            guard let current, request.sessionID == current.sessionID else { throw Failure.evidence }
            if !current.acquisitionAttempted {
                // prepare only read the baseline/journal. No create intent,
                // delivered descriptor or network effect has been attempted.
                guard try backend.inspect(nil) == current.plan.baseline else { throw Failure.evidence }
                current.session.invalidatePreparation()
                do { try backend.retire(current.plan, current.sessionID, current.evidenceSHA256, nil) }
                catch { return .init(state: .uncertain, sessionID: current.sessionID, evidenceSHA256: current.evidenceSHA256, descriptor: nil) }
                self.current = nil; publish(nil, id: nil); setConsent(false)
                return .init(state: .released, sessionID: current.sessionID,
                             evidenceSHA256: current.evidenceSHA256, descriptor: nil)
            }
            let previous = current.session.status
            let status = !previous.ownsDevice && (previous.phase == .restored || previous.phase == .conflict)
                ? previous : try current.session.restore(current.plan, allowUnactivatedDeviceRetirement: true)
            // Only a synchronized terminal record with no owned device and no
            // pending obligation may retire this executor session. A foreign
            // edit after exact retirement (closed_external_change) is complete
            // recovery work but is never reported as a verified restoration.
            let terminal = status.phase == .restored ||
                (status.phase == .conflict && !status.ownsDevice && status.potentiallyApplied == 0)
            if terminal {
                if status.phase == .restored, try backend.inspect(nil) != current.plan.baseline {
                    return .init(state: .uncertain, sessionID: current.sessionID,
                                 evidenceSHA256: current.evidenceSHA256, descriptor: nil)
                }
                do { try backend.retire(current.plan, current.sessionID, current.evidenceSHA256, current.receipt) }
                catch { return .init(state: .uncertain, sessionID: current.sessionID,
                    evidenceSHA256: current.evidenceSHA256, descriptor: nil) }
                self.current = nil; publish(nil, id: nil); setConsent(false)
                if status.phase == .restored, status.restorationVerified {
                    return .init(state: .released, sessionID: current.sessionID,
                                 evidenceSHA256: current.evidenceSHA256, descriptor: nil)
                }
            }
            return .init(state: .uncertain, sessionID: current.sessionID,
                         evidenceSHA256: current.evidenceSHA256, descriptor: nil)
        }
    }

    /// Only a never-attempted preparation may be canceled after transport
    /// loss. Read after the in-flight operation settles; an acquired or partial
    /// device is never inferred away from a missing delivery reply.
    func unusedPreparationCancellation() -> RelayTunWireRequest? {
        lock.lock(); defer { lock.unlock() }
        guard let current, !current.acquisitionAttempted, !current.session.acquisitionAttempted else { return nil }
        guard let nonce = try? RelayTunCoreObservation.randomNonce(), let bytes = try? JSONSerialization.data(withJSONObject: [
            "version": 1, "operation": "release", "nonce": nonce, "sessionID": current.sessionID]) else { return nil }
        return try? RelayTunWireRequest.parse(bytes)
    }
    /// Suspension/revocation (sleep, quit, consent withdrawal) invalidates
    /// activation without dropping recovery capability. Never blocks on I/O.
    func suspend() {
        snapshotLock.lock(); suspensionGeneration &+= 1; let session = publishedSession; snapshotLock.unlock()
        session?.invalidatePreparation()
    }
}

extension RelayTunPrivilegedExecutor {
    /// Live wiring for the parts whose verified implementations exist. The
    /// strict environment inspector is now the default inspect source; the
    /// ordinary-UID core-host observation is a mandatory parameter supplied by
    /// the connection service from the exact acquired receipt and callback.
    /// Construction is inert; every closure re-checks its own privilege and
    /// identity gates at call time.
    /// The only accepted privilege statement. Refuses setuid-root processes,
    /// dropped privileges and any non-root caller before plan work begins.
    static let productionRootGate: () -> Bool = { getuid() == 0 && geteuid() == 0 && getgid() == 0 && getegid() == 0 }
    static func liveBackend(inspect: @escaping (Effects.DeviceIdentity?) throws -> Transaction.Baseline =
                                { try RelayTunEnvironmentInspector.baseline(owned: $0,
                                    sources: RelayTunEnvironmentInspector.live) },
                            coreRuntime: @escaping (Transaction.Plan, Effects.DeviceIdentity) throws -> String?,
                            coreReleased: @escaping (Transaction.Plan, Effects.DeviceIdentity) throws -> Bool,
                            consent: @escaping () -> Bool) -> Backend {
        .init(rootGate: productionRootGate, inspect: inspect, lease: { plan, configuration in
            guard consent() else { throw Failure.permission }
            let journal = try RelayTunDeviceJournalStore.production(plan: plan)
            return try RelayTunDeviceLease.live(
                authorize: { candidate, bound in
                    guard consent(), candidate == plan, bound == configuration,
                          candidate.effectsSHA256 == configuration.projectionSHA256,
                          candidate.routeRemovalPolicy == .ownedDeviceRetirement else { throw Failure.evidence }
                },
                verifyConfiguration: { candidate, bound in
                    guard consent(), candidate == plan, bound == configuration else { throw Failure.evidence }
                },
                record: { try journal.record($0) }).acquire(plan, configuration: configuration)
        }, storage: { plan in
            guard consent() else { throw Failure.permission }
            return try RelayTunNetworkJournalStore.productionStorage(planID: plan.id)
        }, route: { context in
            guard consent() else { throw Failure.permission }
            return try RelayTunRouteAdapter.live(planID: context.plan.id, device: context.device,
                route: context.route, interfaceType: liveInterfaceType(context.device.interface),
                verifyDevice: context.verifyDevice, deviceAbsent: context.deviceAbsent, record: context.record)
        }, resolver: { context in
            guard consent() else { throw Failure.permission }
            return try RelayTunResolverAdapter.live(planID: context.plan.id, device: context.device,
                resolver: context.resolver, verifyDevice: context.verifyDevice, record: context.record)
        }, coreRuntime: coreRuntime, coreReleased: coreReleased,
           now: { DispatchTime.now().uptimeNanoseconds / 1_000_000 })
    }

    /// The AF_LINK sdl_type of the positively identified owned interface.
    /// An absent, duplicated or mismatched observation is an error, never a
    /// guessed constant.
    static func liveInterfaceType(_ interface: Effects.Interface) throws -> UInt8 {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { throw Failure.uncertain }
        defer { freeifaddrs(first) }
        var found: UInt8?
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr, Int32(address.pointee.sa_family) == AF_LINK,
                  String(cString: entry.pointee.ifa_name) == interface.name else { continue }
            let link = address.withMemoryRebound(to: sockaddr_dl.self, capacity: 1) { $0.pointee }
            guard UInt32(link.sdl_index) == interface.index else { continue }
            guard found == nil else { throw Failure.uncertain }
            found = link.sdl_type
        }
        guard let type = found, type > 0 else { throw Failure.uncertain }
        return type
    }
}
