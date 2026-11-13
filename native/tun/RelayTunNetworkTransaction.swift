import Foundation
import Darwin

/// Capability retained when native acquisition failed after its create boundary.
/// Only an in-process adapter implements this contract; it has no JSON form.
protocol RelayTunFailedAcquisition: Error {
    var plan: RelayTunNetworkTransaction.Plan { get }
    func restore() throws -> Bool
    func absent() throws -> Bool
}

/// Transaction policy for a future authenticated, privileged network adapter.
/// No socket, route, DNS, filesystem, process or helper API is called here.
/// Opaque changes are produced by that adapter, never decoded from renderer JSON.
final class RelayTunNetworkTransaction {
    enum Failure: Error { case invalid, stale, busy, evidenceChanged }
    enum Outcome: Equatable { case applied, unchanged, uncertain }
    enum Phase: String { case idle, prepared, acquired, active, conflict, uncertain, restored }
    enum RouteRemovalPolicy: String {
        case perKey = "per_key"
        // Darwin routing sockets have no route-value compare-and-delete. This
        // policy retires routes through their positively owned device instead;
        // it must never be presented as preserving edits on that same device.
        case ownedDeviceRetirement = "owned_device_retirement"
    }
    struct Baseline: Equatable {
        let networkSHA256: String
        let protectionSHA256: String
    }
    struct Plan: Equatable {
        let id: String
        let configurationSHA256: String
        let runtimeConfigurationSHA256: String
        let effectsSHA256: String
        let baseline: Baseline
        let createdAt: UInt64
        let expiresAt: UInt64
        var routeRemovalPolicy: RouteRemovalPolicy = .perKey
    }
    struct Device {
        let id: String
        let interface: String
        static func validInterfaceName(_ value: String) -> Bool {
            guard value.utf8.count < Int(IFNAMSIZ), value.hasPrefix("utun") else { return false }
            let suffix = String(value.dropFirst(4))
            guard let index = UInt32(suffix), index < UInt32.max else { return false }
            return String(index) == suffix
        }
    }
    struct Change: Equatable {
        enum Kind: String { case route, resolver }
        let id: String
        let kind: Kind
        let beforeSHA256: String
        let desiredSHA256: String
    }
    struct Event {
        let phase: String
        let plan: Plan
        let device: Device?
        let changes: [Change]
    }
    struct Status {
        // While busy, phase is the last confirmed stage and the effect count
        // may still be in progress. It is not a current routing-state verdict.
        let busy: Bool
        let phase: Phase
        let ownsDevice: Bool
        let potentiallyApplied: Int
        let restorationVerified: Bool
        // Policy tests and an adapter interface do not prove a working TUN.
        let actualTunAccepted = false
    }
    struct Environment {
        /// Excludes only this transaction's positively owned interface/effects.
        /// Unrelated route, resolver and protection changes remain in the digest.
        let inspect: (_ owned: Device?) throws -> Baseline
        let create: (_ plan: Plan) throws -> Device
        let changes: (_ plan: Plan, _ owned: Device) throws -> [Change]
        let observe: (_ change: Change, _ owned: Device) throws -> String
        /// Must compare `expected` again at its mutation boundary. No overwrite.
        let install: (_ change: Change, _ owned: Device, _ expected: String) throws -> Outcome
        let remove: (_ change: Change, _ owned: Device, _ expected: String) throws -> Outcome
        /// Closes only its held descriptor. It must not operate by stored PID/name.
        let close: (_ owned: Device) throws -> Outcome
        /// Independent positive proof, including descriptors held by the client.
        /// A closed helper FD alone does not prove that its utun disappeared.
        let deviceAbsent: (_ owned: Device) throws -> Bool
        /// Production must persist private recovery intent before each mutation.
        let record: (_ event: Event) throws -> Void
        let now: () -> UInt64
        // Stored by value in the transaction and bound into its recovery plan.
        var routeRemovalPolicy: RouteRemovalPolicy = .perKey
    }
    private let environment: Environment
    private var currentPhase: Phase = .idle
    private var plan: Plan?
    private var planEpoch: UUID?
    private var device: Device?
    private var creationAttempted = false
    private var pending: [Change] = []
    private var unacknowledgedRemoval: Change?
    private var verified = false
    // One writer across all authenticated connections, with immediate busy
    // rejection for both concurrent calls and adapter callback re-entry.
    private let mutationLock = NSRecursiveLock()
    private var mutating = false
    // Sleep/revocation must invalidate a blocked writer without waiting for its
    // external journal/kernel callback. Status similarly uses a separate lock.
    private let epochLock = NSLock()
    private var epoch = UUID()
    private let statusLock = NSLock()
    private var publishedStatus = Status(busy: false, phase: .idle, ownsDevice: false, potentiallyApplied: 0, restorationVerified: false)
    /// SHA256(empty bytes) is the adapter's canonical absence observation.
    static let absentSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    init(environment: Environment) { self.environment = environment }
    private static func digest(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
    private static func valid(_ baseline: Baseline) -> Bool {
        digest(baseline.networkSHA256) && digest(baseline.protectionSHA256)
    }
    var phase: Phase { status.phase }
    var status: Status { statusLock.lock(); defer { statusLock.unlock() }; return publishedStatus }
    private func snapshot(busy: Bool? = nil) -> Status { Status(busy: busy ?? mutating, phase: currentPhase, ownsDevice: device != nil, potentiallyApplied: pending.count, restorationVerified: verified) }
    private func publish() { statusLock.lock(); publishedStatus = snapshot(); statusLock.unlock() }
    private func currentEpoch() -> UUID { epochLock.lock(); defer { epochLock.unlock() }; return epoch }
    private func beginMutation() throws {
        guard mutationLock.try() else { throw Failure.busy }
        guard !mutating else { mutationLock.unlock(); throw Failure.busy }
        mutating = true; publish()
    }
    private func endMutation() {
        if device == nil, !creationAttempted, currentPhase == .prepared, let planEpoch, planEpoch != currentEpoch() {
            plan = nil; self.planEpoch = nil; currentPhase = .idle; verified = false
        }
        mutating = false; publish(); mutationLock.unlock()
    }
    private func checkAuthorization(_ approved: Plan) throws {
        let now = environment.now()
        guard plan == approved, planEpoch == currentEpoch(), now >= approved.createdAt, now <= approved.expiresAt else { throw Failure.stale }
    }
    private func record(_ value: String, proposedChanges: [Change]? = nil) throws {
        guard let plan else { throw Failure.invalid }
        publish()
        try environment.record(Event(phase: value, plan: plan, device: device, changes: proposedChanges ?? pending))
    }
    func invalidatePreparation() {
        epochLock.lock(); epoch = UUID(); epochLock.unlock()
        guard mutationLock.try() else { return }
        defer { mutationLock.unlock() }
        guard !mutating else { return }
        if device == nil, !creationAttempted { plan = nil; planEpoch = nil; currentPhase = .idle; verified = false; publish() }
        // An acquired/live resource keeps its identity and observed phase, but
        // its activation authorization is revoked. Explicit restore remains usable.
    }
    func prepare(configurationSHA256: String, runtimeConfigurationSHA256: String, effectsSHA256: String) throws -> Plan {
        try beginMutation(); defer { endMutation() }
        let preparationEpoch = currentEpoch()
        guard device == nil, !creationAttempted, pending.isEmpty else { throw Failure.busy }
        guard Self.digest(configurationSHA256), Self.digest(runtimeConfigurationSHA256), Self.digest(effectsSHA256) else { throw Failure.invalid }
        let baseline = try environment.inspect(nil), now = environment.now()
        guard Self.valid(baseline), now <= UInt64.max - 60_000 else { throw Failure.invalid }
        guard preparationEpoch == currentEpoch() else { throw Failure.stale }
        let value = Plan(id: UUID().uuidString.lowercased(), configurationSHA256: configurationSHA256,
                         runtimeConfigurationSHA256: runtimeConfigurationSHA256, effectsSHA256: effectsSHA256,
                         baseline: baseline, createdAt: now, expiresAt: now + 60_000, routeRemovalPolicy: environment.routeRemovalPolicy)
        plan = value; planEpoch = preparationEpoch; verified = false; currentPhase = .prepared
        return value
    }
    /// Acquire only the unique device. Default routes/DNS remain untouched until
    /// a separate authenticated activation after the ordinary-UID core is ready.
    func acquire(_ approved: Plan) throws -> Status {
        try beginMutation(); defer { endMutation() }
        guard device == nil, currentPhase == .prepared else { throw Failure.stale }
        try checkAuthorization(approved)
        guard try environment.inspect(nil) == approved.baseline else { throw Failure.evidenceChanged }
        try record("create_intent")
        try checkAuthorization(approved)
        do {
            // Contract: create returns a held handle or disposes its failed
            // creation. It never returns an arbitrary pre-existing interface.
            creationAttempted = true
            let owned = try environment.create(approved)
            device = owned
            guard UUID(uuidString: owned.id)?.uuidString.lowercased() == owned.id,
                  Device.validInterfaceName(owned.interface) else {
                throw Failure.invalid
            }
            try record("acquired")
            try checkAuthorization(approved)
            currentPhase = .acquired
        } catch {
            currentPhase = .uncertain
            // Retain a returned device for explicit recovery; never lose its
            // identity because a journal acknowledgement failed.
        }
        return snapshot(busy: false)
    }
    func activate(_ approved: Plan, coreConfigurationSHA256: String, coreReady: Bool) throws -> Status {
        try beginMutation(); defer { endMutation() }
        guard let device, currentPhase == .acquired, coreReady,
              coreConfigurationSHA256 == approved.runtimeConfigurationSHA256 else { throw Failure.stale }
        try checkAuthorization(approved)
        // The trusted native FD host must supply actual readiness and the
        // generated runtime digest, never a renderer-provided Boolean.
        guard try environment.inspect(device) == approved.baseline else { throw Failure.evidenceChanged }
        let changes = try environment.changes(approved, device)
        guard changes.count <= 512, Set(changes.map(\.id)).count == changes.count,
              changes.allSatisfy({ Self.digest($0.id) && $0.beforeSHA256 == Self.absentSHA256 && Self.digest($0.desiredSHA256) && $0.beforeSHA256 != $0.desiredSHA256 }) else {
            throw Failure.invalid
        }
        if approved.routeRemovalPolicy == .ownedDeviceRetirement {
            let routes = changes.prefix { $0.kind == .route }.count
            guard changes.dropFirst(routes).allSatisfy({ $0.kind == .resolver }) else { throw Failure.invalid }
        }
        // Validate every original before the first route/resolver mutation.
        for change in changes {
            guard try environment.observe(change, device) == change.beforeSHA256 else { throw Failure.evidenceChanged }
        }
        do {
            for change in changes {
                try checkAuthorization(approved)
                pending.append(change)
                try record("install_intent")
                try checkAuthorization(approved)
                let outcome = try environment.install(change, device, change.beforeSHA256)
                guard outcome == .applied, try environment.observe(change, device) == change.desiredSHA256 else {
                    currentPhase = .uncertain; return snapshot(busy: false)
                }
                try record("installed")
            }
            try checkAuthorization(approved)
            try record("active")
            try checkAuthorization(approved)
            currentPhase = .active
        } catch { currentPhase = .uncertain }
        return snapshot(busy: false)
    }
    /// Explicit release/recovery, after the host has stopped its own core and
    /// dropped its duplicate FD. Never signals or adopts a process by old PID.
    func restore(_ approved: Plan) throws -> Status {
        try beginMutation(); defer { endMutation() }
        guard plan == approved, let device else { throw Failure.stale }
        do {
            // An external alteration of any owned key blocks all undo writes.
            // Changes elsewhere never get overwritten to recreate a baseline.
            for change in pending {
                let observed = try environment.observe(change, device)
                guard observed == change.beforeSHA256 || observed == change.desiredSHA256 else {
                    currentPhase = .conflict; return snapshot(busy: false)
                }
            }
            if let change = unacknowledgedRemoval {
                guard pending.last == change, try environment.observe(change, device) == change.beforeSHA256 else {
                    currentPhase = .conflict; return snapshot(busy: false)
                }
                try acknowledgeRemoval(change)
            }
            var deviceRetired = false
            if approved.routeRemovalPolicy == .ownedDeviceRetirement {
                let retiringRoutes = pending.contains { $0.kind == .route }
                guard try restoreByDeviceRetirement(device) else { return snapshot(busy: false) }
                deviceRetired = retiringRoutes
            } else {
                while let change = pending.last {
                    let observed = try environment.observe(change, device)
                    if observed == change.desiredSHA256 {
                        try record("remove_intent")
                        _ = try environment.remove(change, device, observed)
                    }
                    guard try environment.observe(change, device) == change.beforeSHA256 else {
                        currentPhase = .uncertain; return snapshot(busy: false)
                    }
                    try acknowledgeRemoval(change)
                }
            }
            try record("close_intent")
            // This call already closed the owned device and independently
            // proved absence while retiring routes. Do not ask its former
            // core for another release proof just to close it a second time.
            if !deviceRetired {
                guard try environment.close(device) != .uncertain else { currentPhase = .uncertain; return snapshot(busy: false) }
            }
            guard try environment.deviceAbsent(device) else { currentPhase = .uncertain; return snapshot(busy: false) }
            // inspect(nil) must also prove the owned interface and all duplicate
            // handles no longer leave a configured interface behind.
            let final = try environment.inspect(nil)
            guard Self.valid(final) else { throw Failure.invalid }
            let baselineRestored = final == approved.baseline
            try record(baselineRestored ? "restored" : "closed_external_change")
            // Publishing verification must follow the durable final record;
            // a failed acknowledgement leaves explicit recovery work.
            verified = baselineRestored
            self.device = nil; creationAttempted = false
            currentPhase = verified ? .restored : .conflict
        } catch { verified = false; currentPhase = .uncertain }
        return snapshot(busy: false)
    }
    /// A failed acquire never published a device to the transaction or client.
    /// Only its retained native recovery owner can supply the positive absence
    /// proof; the durable aborted record is synchronized before publication.
    func restoreUnacquired(_ approved: Plan, deviceAbsent: Bool) throws -> Status {
        try beginMutation(); defer { endMutation() }
        guard plan == approved, device == nil, creationAttempted, pending.isEmpty,
              currentPhase == .uncertain, deviceAbsent else { throw Failure.stale }
        guard try environment.inspect(nil) == approved.baseline else { throw Failure.evidenceChanged }
        try record("acquisition_aborted")
        creationAttempted = false; verified = true; currentPhase = .restored
        return snapshot(busy: false)
    }
    private func acknowledgeRemoval(_ change: Change) throws {
        guard pending.last == change else { throw Failure.invalid }
        do {
            // The proposed journal records the smaller prefix, but the live
            // logical obligation stays intact until persistence acknowledges it.
            try record("removed", proposedChanges: Array(pending.dropLast()))
            pending.removeLast(); unacknowledgedRemoval = nil
        }
        catch {
            // A lost journal acknowledgement cannot shrink logical recovery
            // scope. Reaffirm this same observed fact before another mutation.
            unacknowledgedRemoval = change; throw error
        }
    }
    private func restoreByDeviceRetirement(_ device: Device) throws -> Bool {
        // Routes were installed first, so resolvers form the removable suffix.
        while let change = pending.last, change.kind == .resolver {
            let observed = try environment.observe(change, device)
            guard observed == change.beforeSHA256 || observed == change.desiredSHA256 else { currentPhase = .conflict; return false }
            if observed == change.desiredSHA256 {
                try record("remove_intent")
                _ = try environment.remove(change, device, observed)
            }
            guard try environment.observe(change, device) == change.beforeSHA256 else { currentPhase = .uncertain; return false }
            try acknowledgeRemoval(change)
        }
        guard pending.allSatisfy({ $0.kind == .route }) else { throw Failure.invalid }
        if !pending.isEmpty {
            try record("retire_device_intent")
            // Recheck after the durable intent boundary. This catches observed
            // conflicts; it is deliberately not a claim of kernel value-CAS.
            for change in pending {
                let observed = try environment.observe(change, device)
                guard observed == change.beforeSHA256 || observed == change.desiredSHA256 else { currentPhase = .conflict; return false }
            }
            guard try environment.close(device) != .uncertain, try environment.deviceAbsent(device) else { currentPhase = .uncertain; return false }
            // The kernel, not a key-based RTM_DELETE, retires routes still bound
            // to the detached owned interface. A replacement on another iface
            // is preserved and prevents a claim of baseline restoration.
            while let change = pending.last {
                let observed = try environment.observe(change, device)
                guard observed == change.beforeSHA256 else {
                    currentPhase = observed == change.desiredSHA256 ? .uncertain : .conflict; return false
                }
                try acknowledgeRemoval(change)
            }
        }
        return true
    }
}
