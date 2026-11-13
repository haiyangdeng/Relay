import Foundation

/// Connects a single held-device capability, typed effects, durable transaction
/// journal and route/resolver adapters. It grants no caller authority and is
/// installed only by the authenticated executor service with typed projection,
/// receipt-bound core observations and current operation authorization.
final class RelayTunNetworkSession {
    private typealias Transaction = RelayTunNetworkTransaction
    private typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case invalid, permission, busy, state, uncertain }
    /// The trusted acquisition driver must retain failed/uncertain creations in
    /// its own device recovery owner. A successfully returned lease is retained
    /// here before verification, realization, persistence or factories can fail.
    struct Lease {
        let identity: RelayTunNetworkEffects.DeviceIdentity
        let held: () -> Bool
        let verify: (RelayTunNetworkEffects.DeviceIdentity) throws -> Void
        let duplicate: () throws -> FileHandle
        let close: () throws -> RelayTunNetworkTransaction.Outcome
        let absent: () throws -> Bool
    }
    struct RouteContext {
        let plan: RelayTunNetworkTransaction.Plan
        let device: RelayTunNetworkEffects.DeviceIdentity
        let route: RelayTunNetworkEffects.Route
        let verifyDevice: (RelayTunNetworkEffects.DeviceIdentity) throws -> Void
        let deviceAbsent: (RelayTunNetworkEffects.DeviceIdentity) throws -> Bool
        let record: (RelayTunRouteAdapter.Event) throws -> Void
    }
    struct ResolverContext {
        let plan: RelayTunNetworkTransaction.Plan
        let device: RelayTunNetworkEffects.DeviceIdentity
        let resolver: RelayTunNetworkEffects.Resolver
        let verifyDevice: (RelayTunNetworkEffects.DeviceIdentity) throws -> Void
        let record: (RelayTunResolverAdapter.Event) throws -> Void
    }
    struct Driver {
        let authorized: () -> Bool
        /// The baseline excludes only the exact positively owned identity and
        /// realized effects. An unrelated change must remain visible.
        let inspect: (RelayTunNetworkEffects.DeviceIdentity?) throws -> RelayTunNetworkTransaction.Baseline
        let acquire: (RelayTunNetworkTransaction.Plan) throws -> Lease
        let realize: (RelayTunNetworkTransaction.Plan, RelayTunNetworkEffects.DeviceIdentity) throws -> RelayTunNetworkEffects.EffectSet
        /// Mandatory proof mapping the approved projection digest to allocated
        /// interface/effect bytes; matching UUIDs or a digest alone is insufficient.
        let verifyProjection: (RelayTunNetworkTransaction.Plan, RelayTunNetworkEffects.EffectSet) throws -> Void
        let storage: (RelayTunNetworkTransaction.Plan) throws -> RelayTunNetworkJournal.Storage
        let route: (RouteContext) throws -> RelayTunRouteAdapter
        let resolver: (ResolverContext) throws -> RelayTunResolverAdapter
        /// Observed by the trusted ordinary-UID FD host, never renderer booleans.
        let coreRuntime: (RelayTunNetworkTransaction.Plan, RelayTunNetworkEffects.DeviceIdentity) throws -> String?
        /// Positive proof that the owned core exited and its client FD copies
        /// closed; no PID/name adoption or process signal is performed here.
        let coreReleased: (RelayTunNetworkTransaction.Plan, RelayTunNetworkEffects.DeviceIdentity) throws -> Bool
        let now: () -> UInt64
    }
    final class RecoveryToken { let id = UUID().uuidString.lowercased(); fileprivate init() {} }
    struct RecoveryView { let token: RecoveryToken; let status: RelayTunNetworkTransaction.Status; let retainsLease: Bool }
    private static let recoveryLock = NSLock()
    private static var owners: [ObjectIdentifier: RelayTunNetworkSession] = [:]
    let recoveryToken = RecoveryToken()
    static var recoveryViews: [RecoveryView] {
        recoveryLock.lock(); let retained = Array(owners.values); recoveryLock.unlock()
        return retained.map { .init(token: $0.recoveryToken, status: $0.status, retainsLease: $0.state.lease != nil || $0.state.failedAcquisition != nil) }
            .sorted { $0.token.id < $1.token.id }
    }
    static func recover(_ token: RecoveryToken) -> RelayTunNetworkSession? {
        recoveryLock.lock(); defer { recoveryLock.unlock() }
        guard let owner = owners[ObjectIdentifier(token)], owner.recoveryToken === token else { return nil }; return owner
    }
    private func retainForRecovery() {
        Self.recoveryLock.lock(); Self.owners[ObjectIdentifier(recoveryToken)] = self; Self.recoveryLock.unlock()
    }
    private func releaseRecovery() {
        Self.recoveryLock.lock(); Self.owners.removeValue(forKey: ObjectIdentifier(recoveryToken)); Self.recoveryLock.unlock()
    }

    private enum BoundAdapter { case route(RelayTunRouteAdapter), resolver(RelayTunResolverAdapter) }
    private final class State {
        let driver: Driver
        let installationRevision: String
        let clientUID: UInt32
        private let ownershipLock = NSLock()
        private var retainedLease: Lease?
        private var attemptedAcquisition = false
        var acquisitionAttempted: Bool {
            get { ownershipLock.lock(); defer { ownershipLock.unlock() }; return attemptedAcquisition }
            set { ownershipLock.lock(); attemptedAcquisition = newValue; ownershipLock.unlock() }
        }
        var lease: Lease? {
            get { ownershipLock.lock(); defer { ownershipLock.unlock() }; return retainedLease }
            set { ownershipLock.lock(); retainedLease = newValue; ownershipLock.unlock() }
        }
        private let authorizationLock = NSLock()
        private var revoked = false
        var plan: Transaction.Plan?
        var failedAcquisition: RelayTunFailedAcquisition?
        var retiringUnactivated = false
        // Scoped to one serialized restore, never retained between requests.
        // CoreHost's released phase is terminal for its immutable receipt.
        var restoringReleasedDevice: Effects.DeviceIdentity?
        var journal: RelayTunTransactionJournal?
        var effects: Effects.EffectSet?
        var adapters: [String: BoundAdapter] = [:]
        var lastRecord: Transaction.Event?
        var acquired: (() -> Void)?
        init(driver: Driver, installationRevision: String, clientUID: UInt32) {
            self.driver = driver; self.installationRevision = installationRevision; self.clientUID = clientUID
        }
        func revoke() { authorizationLock.lock(); revoked = true; authorizationLock.unlock() }
        func resetAuthorization() { authorizationLock.lock(); revoked = false; authorizationLock.unlock() }
        func authorizeActivation() throws {
            authorizationLock.lock(); let revoked = self.revoked; authorizationLock.unlock()
            guard driver.authorized(), !revoked, let plan else { throw Failure.permission }
            let now = driver.now(); guard now >= plan.createdAt && now <= plan.expiresAt else { throw Failure.state }
        }
        func owned(_ value: Transaction.Device) throws -> Lease {
            guard let lease, lease.identity.id == value.id, lease.identity.interface.name == value.interface else { throw Failure.invalid }
            return lease
        }
        func verify(_ identity: Effects.DeviceIdentity) throws {
            try authorizeActivation()
            guard let lease, lease.identity == identity, lease.held() else { throw Failure.uncertain }
            try lease.verify(identity)
        }
        func realize(_ owned: Transaction.Device) throws -> Effects.EffectSet {
            let lease = try self.owned(owned)
            try verify(lease.identity)
            guard let plan else { throw Failure.state }
            let value = try driver.realize(plan, lease.identity)
            guard value.planID == plan.id, value.device == lease.identity else { throw Failure.invalid }
            let routeCount = value.effects.prefix { if case .route = $0 { return true }; return false }.count
            guard value.effects.dropFirst(routeCount).allSatisfy({ if case .resolver = $0 { return true }; return false }),
                  value.effects.allSatisfy({ if case .route(let route) = $0 { return route.interface == lease.identity.interface }; return true }) else { throw Failure.invalid }
            try driver.verifyProjection(plan, value)
            try verify(lease.identity)
            effects = value; return value
        }
        func checkAdapterEvent(_ change: Transaction.Change, installing: Bool) throws {
            guard driver.authorized(), let event = lastRecord,
                  event.phase == (installing ? "install_intent" : "remove_intent"), event.changes.last == change else { throw Failure.state }
            // The outer complete typed intent is already synchronized. Inner
            // adapter callbacks validate that exact scope rather than emitting
            // a duplicate/illegal journal transition for the same mutation.
            if installing { try authorizeActivation() }
        }
        func makeAdapters() throws -> [Transaction.Change] {
            guard let effects, let plan else { throw Failure.state }
            let changes = try effects.changes()
            for (effect, change) in zip(effects.effects, changes) where adapters[change.id] == nil {
                switch effect {
                case .route(let route):
                    let context = RouteContext(plan: plan, device: effects.device, route: route,
                        verifyDevice: { [weak self] identity in guard let self else { throw Failure.state }; try self.verify(identity) },
                        deviceAbsent: { [weak self] identity in
                            guard let lease = self?.lease, lease.identity == identity else { throw Failure.invalid }; return try lease.absent()
                        }, record: { [weak self] event in
                            guard let self, event.planID == plan.id, event.device == effects.device, event.route == route else { throw Failure.invalid }
                            if event.retiring {
                                guard self.driver.authorized(), let phase = self.lastRecord?.phase,
                                      ["retire_device_intent", "removed", "close_intent"].contains(phase),
                                      event.observedSHA256 == Transaction.absentSHA256 else { throw Failure.state }
                            } else { try self.checkAdapterEvent(change, installing: true) }
                        })
                    let adapter = try driver.route(context)
                    guard adapter.planID == plan.id, adapter.device == effects.device, adapter.route == route else { throw Failure.invalid }
                    adapters[change.id] = .route(adapter)
                case .resolver(let resolver):
                    let context = ResolverContext(plan: plan, device: effects.device, resolver: resolver,
                        verifyDevice: { [weak self] identity in guard let self else { throw Failure.state }; try self.verify(identity) },
                        record: { [weak self] event in
                            guard let self, event.planID == plan.id, event.device == effects.device, event.resolver == resolver else { throw Failure.invalid }
                            try self.checkAdapterEvent(change, installing: event.operation == .install)
                        })
                    let adapter = try driver.resolver(context)
                    guard adapter.planID == plan.id, adapter.device == effects.device, adapter.resolver == resolver else { throw Failure.invalid }
                    adapters[change.id] = .resolver(adapter)
                }
            }
            return changes
        }
        func adapter(_ change: Transaction.Change, _ owned: Transaction.Device) throws -> BoundAdapter {
            _ = try self.owned(owned)
            guard let effects, try effects.effect(for: change).kind == change.kind, let adapter = adapters[change.id] else { throw Failure.invalid }
            return adapter
        }
        func observe(_ change: Transaction.Change, _ owned: Transaction.Device) throws -> String {
            switch try adapter(change, owned) {
            case .route(let adapter): return try adapter.observation()
            case .resolver(let adapter): return try adapter.observation()
            }
        }
        func install(_ change: Transaction.Change, _ owned: Transaction.Device, _ expected: String) throws -> Transaction.Outcome {
            guard expected == change.beforeSHA256, expected == Transaction.absentSHA256 else { throw Failure.invalid }
            try authorizeActivation()
            switch try adapter(change, owned) {
            case .route(let adapter): return try adapter.install(expected: expected).phase == .installed ? .applied : .uncertain
            case .resolver(let adapter): return try adapter.install().phase == .held ? .applied : .uncertain
            }
        }
        func remove(_ change: Transaction.Change, _ owned: Transaction.Device, _ expected: String) throws -> Transaction.Outcome {
            guard expected == change.desiredSHA256 else { throw Failure.invalid }
            switch try adapter(change, owned) {
            case .route: throw Failure.invalid // only original owned-device retirement may remove routes
            case .resolver(let adapter): return try adapter.release().phase == .absent ? .applied : .uncertain
            }
        }
        func close(_ owned: Transaction.Device) throws -> Transaction.Outcome {
            let lease = try self.owned(owned)
            guard driver.authorized(), plan != nil,
                  retiringUnactivated || restoringReleasedDevice == lease.identity else { throw Failure.state }
            return try lease.close()
        }
        func absent(_ owned: Transaction.Device) throws -> Bool {
            let lease = try self.owned(owned)
            guard try lease.absent() else { return false }
            for adapter in adapters.values {
                if case .route(let route) = adapter, route.status.potentiallyApplied, route.status.phase != .retired {
                    guard try route.verifyRetired().phase == .retired else { return false }
                }
            }
            return true
        }
        func record(_ event: Transaction.Event) throws {
            guard let journal else { throw Failure.state }
            try journal.record(event); lastRecord = event
        }
    }
    private let state: State
    private let transaction: Transaction
    private let operationLock = NSRecursiveLock()
    private var operating = false
    init(installationRevision: String, clientUID: UInt32, driver: Driver) throws {
        guard Effects.digest(installationRevision), clientUID > 0 else { throw Failure.invalid }
        let state = State(driver: driver, installationRevision: installationRevision, clientUID: clientUID)
        self.state = state
        transaction = Transaction(environment: .init(inspect: { owned in
            try driver.inspect(try owned.map { try state.owned($0).identity })
        }, create: { plan in
            state.acquisitionAttempted = true
            let lease: Lease
            do { lease = try driver.acquire(plan) }
            catch let partial as RelayTunFailedAcquisition {
                guard partial.plan == plan else { throw Failure.invalid }
                state.failedAcquisition = partial; state.acquired?(); throw partial
            }
            state.lease = lease; state.acquired?()
            // Do not add a throwing step here. Transaction must first retain
            // the returned identity before acquired realization can fail.
            return .init(id: lease.identity.id, interface: lease.identity.interface.name)
        }, changes: { plan, owned in
            guard plan == state.plan, try state.owned(owned).identity == state.effects?.device else { throw Failure.invalid }
            return try state.makeAdapters()
        }, observe: { try state.observe($0, $1) }, install: { try state.install($0, $1, $2) },
           remove: { try state.remove($0, $1, $2) }, close: { try state.close($0) }, deviceAbsent: { try state.absent($0) },
           record: { try state.record($0) }, now: driver.now, routeRemovalPolicy: .ownedDeviceRetirement))
        state.acquired = { [weak self] in self?.retainForRecovery() }
    }
    var status: RelayTunNetworkTransaction.Status { transaction.status }
    /// Positive record of crossing the trusted create boundary, not inferred
    /// from the absence of a returned lease or a rejected acquire request.
    var acquisitionAttempted: Bool { state.acquisitionAttempted }
    private func begin() throws {
        guard operationLock.try() else { throw Failure.busy }
        guard !operating else { operationLock.unlock(); throw Failure.busy }
        guard state.driver.authorized() else { operationLock.unlock(); throw Failure.permission }
        operating = true
    }
    private func end() { operating = false; operationLock.unlock() }
    func prepare(configurationSHA256: String, runtimeConfigurationSHA256: String, effectsSHA256: String) throws -> RelayTunNetworkTransaction.Plan {
        try begin(); defer { end() }
        guard state.lease == nil, state.failedAcquisition == nil else { throw Failure.state }
        state.resetAuthorization(); state.acquisitionAttempted = false
        let plan = try transaction.prepare(configurationSHA256: configurationSHA256,
            runtimeConfigurationSHA256: runtimeConfigurationSHA256, effectsSHA256: effectsSHA256)
        state.plan = plan; state.effects = nil; state.adapters = [:]; state.lastRecord = nil; state.retiringUnactivated = false
        let state = self.state
        do {
            state.journal = try RelayTunTransactionJournal(plan: plan, installationRevision: state.installationRevision,
                clientUID: state.clientUID, storage: state.driver.storage(plan), realize: { [weak state] owned in
                    guard let state else { throw Failure.state }; return try state.realize(owned)
                }, verifyRealization: { [weak state] plan, effects in
                    guard let state, plan == state.plan, effects == state.effects else { throw Failure.invalid }
                    try state.verify(effects.device)
                }, observeRestoration: { [weak state] owned in
                    guard let state, try state.absent(owned) else { throw Failure.uncertain }
                    let baseline = try state.driver.inspect(nil)
                    return try .init(networkSHA256: baseline.networkSHA256, protectionSHA256: baseline.protectionSHA256, deviceAbsent: true)
                }, observeUnacquiredRestoration: { [weak state] in
                    guard let state, let partial = state.failedAcquisition, try partial.absent() else { throw Failure.uncertain }
                    let baseline = try state.driver.inspect(nil)
                    return try .init(networkSHA256: baseline.networkSHA256, protectionSHA256: baseline.protectionSHA256, deviceAbsent: true)
                })
            return plan
        } catch { state.journal = nil; state.plan = nil; transaction.invalidatePreparation(); throw error }
    }
    func acquire(_ plan: RelayTunNetworkTransaction.Plan) throws -> RelayTunNetworkTransaction.Status {
        try begin(); defer { end() }
        guard plan == state.plan else { throw Failure.state }
        return try transaction.acquire(plan)
    }
    /// The returned identity is the exact held device this duplicate belongs
    /// to; the caller binds it into its delivery receipt before replying.
    func duplicateForDelivery(_ plan: RelayTunNetworkTransaction.Plan) throws -> (descriptor: FileHandle, identity: RelayTunNetworkEffects.DeviceIdentity) {
        try begin(); defer { end() }
        guard plan == state.plan, transaction.status.phase == .acquired, let lease = state.lease else { throw Failure.state }
        try state.verify(lease.identity)
        let descriptor = try lease.duplicate()
        do { try state.verify(lease.identity); return (descriptor, lease.identity) } catch { try? descriptor.close(); throw error }
    }
    func activate(_ plan: RelayTunNetworkTransaction.Plan) throws -> RelayTunNetworkTransaction.Status {
        try begin(); defer { end() }
        guard plan == state.plan, let lease = state.lease else { throw Failure.state }
        try state.verify(lease.identity)
        let runtime = try state.driver.coreRuntime(plan, lease.identity)
        return try transaction.activate(plan, coreConfigurationSHA256: runtime ?? "", coreReady: runtime != nil)
    }
    func restore(_ plan: RelayTunNetworkTransaction.Plan, allowUnactivatedDeviceRetirement: Bool = false) throws -> RelayTunNetworkTransaction.Status {
        try begin(); defer { end() }
        guard plan == state.plan else { throw Failure.state }
        if let partial = state.failedAcquisition {
            guard try partial.restore() else { throw Failure.uncertain }
            let result = try transaction.restoreUnacquired(plan, deviceAbsent: partial.absent())
            if result.phase == .restored, result.restorationVerified { state.failedAcquisition = nil; releaseRecovery() }
            return result
        }
        guard let lease = state.lease else { throw Failure.state }
        if allowUnactivatedDeviceRetirement, transaction.status.phase == .acquired,
           transaction.status.potentiallyApplied == 0 { state.retiringUnactivated = true }
        // A lost acquire reply may leave no ordinary endpoint for its receipt.
        // Before activation only, root may drop its own handles and require the
        // stronger independent all-copy/device-absence observation. Any live
        // ordinary child or delivery copy prevents the terminal proof. Once
        // begun this same no-effect retirement can be explicitly retried.
        if !state.retiringUnactivated {
            guard try state.driver.coreReleased(plan, lease.identity) else { throw Failure.state }
            // Positive reaping and closure of all client FD copies cannot be
            // undone by this single-use CoreHost. Consume that exact proof for
            // this restore only, instead of querying it again after DNS undo.
            state.restoringReleasedDevice = lease.identity
        }
        defer { state.restoringReleasedDevice = nil }
        let result = try transaction.restore(plan)
        if !result.ownsDevice, result.potentiallyApplied == 0, try lease.absent() { state.lease = nil; releaseRecovery() }
        return result
    }
    /// Revokes activation without dropping any recovery capability. This does
    /// not wait for blocked filesystem/kernel callbacks or close a live device.
    func invalidatePreparation() { state.revoke(); transaction.invalidatePreparation() }
}
