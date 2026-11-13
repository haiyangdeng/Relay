import Foundation
import Darwin
import SystemConfiguration

/// Owns a new temporary configd session/key, never an existing DNS service.
/// Session retirement is not value-CAS: another session's update detaches the
/// temporary ownership (SCDynamicStore.h), and independent absence is required.
/// This module supplies no caller authentication or network activation consent.
final class RelayTunResolverAdapter {
    private typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case invalid, permission, busy, state, conflict, uncertain, system(Int32) }
    enum Phase: String { case idle, held, conflict, uncertain, released, absent }
    enum Operation: String { case install, release, verifyAbsent }
    enum RecordPhase: String { case intent, confirmed }
    struct Event {
        let operation: Operation
        let phase: RecordPhase
        let planID: String
        let device: RelayTunNetworkEffects.DeviceIdentity
        let resolver: RelayTunNetworkEffects.Resolver
        let observedSHA256: String
        let ownsSession: Bool
    }
    struct Status {
        let phase: Phase
        let ownsSession: Bool
        let absentVerified: Bool
        let failure: Failure?
        let actualTunAccepted = false
        let networkRestorationVerified = false
    }
    struct View { let busy: Bool; let status: Status }
    struct ReleaseResult { let released: Bool; let uncertain: Bool }
    /// A session closes only its privately held configd reference. There is no
    /// remove(key), set(key), caller-selected key, or persistent preference API.
    struct Session {
        let held: () -> Bool
        let addTemporary: (Data) throws -> Bool
        let release: () throws -> ReleaseResult
    }
    struct Driver {
        let authorized: () -> Bool
        let inspect: (String) throws -> Data?
        /// Throwing creation must not leak a session outside the returned owner.
        let create: (String) throws -> Session
    }
    final class RecoveryToken {
        let id = UUID().uuidString.lowercased()
        fileprivate init() { }
    }
    struct RecoveryView { let token: RecoveryToken; let view: View }
    private static let recoveryLock = NSLock()
    private static var owners: [ObjectIdentifier: RelayTunResolverAdapter] = [:]
    let recoveryToken = RecoveryToken()
    static var recoveryViews: [RecoveryView] {
        recoveryLock.lock(); let retained = Array(owners.values); recoveryLock.unlock()
        return retained.map { .init(token: $0.recoveryToken, view: $0.view) }.sorted { $0.token.id < $1.token.id }
    }
    static func recover(_ token: RecoveryToken) -> RelayTunResolverAdapter? {
        recoveryLock.lock(); defer { recoveryLock.unlock() }
        guard let owner = owners[ObjectIdentifier(token)], owner.recoveryToken === token else { return nil }; return owner
    }
    private func retainForRecovery() {
        Self.recoveryLock.lock(); Self.owners[ObjectIdentifier(recoveryToken)] = self; Self.recoveryLock.unlock()
    }
    private func releaseRecovery() {
        Self.recoveryLock.lock(); Self.owners.removeValue(forKey: ObjectIdentifier(recoveryToken)); Self.recoveryLock.unlock()
    }

    let planID: String
    let device: RelayTunNetworkEffects.DeviceIdentity
    let resolver: RelayTunNetworkEffects.Resolver
    private let desired: Data
    private let desiredEffectSHA256: String
    private let driver: Driver
    private let verifyDevice: (RelayTunNetworkEffects.DeviceIdentity) throws -> Void
    private let record: (Event) throws -> Void
    private var session: Session?
    private var currentPhase: Phase = .idle
    private var failure: Failure?
    private let lock = NSRecursiveLock()
    private var mutating = false
    private let statusLock = NSLock()
    private var published = View(busy: false, status: .init(phase: .idle, ownsSession: false, absentVerified: false, failure: nil))

    init(planID: String, device: RelayTunNetworkEffects.DeviceIdentity, resolver: RelayTunNetworkEffects.Resolver,
         driver: Driver, verifyDevice: @escaping (RelayTunNetworkEffects.DeviceIdentity) throws -> Void,
         record: @escaping (Event) throws -> Void) throws {
        let effects = try Effects.EffectSet(planID: planID, device: device, effects: [.resolver(resolver)])
        self.planID = planID; self.device = device; self.resolver = resolver; self.driver = driver
        self.verifyDevice = verifyDevice; self.record = record; desired = try Self.value(resolver)
        desiredEffectSHA256 = try effects.changes()[0].desiredSHA256
    }
    static func live(planID: String, device: RelayTunNetworkEffects.DeviceIdentity, resolver: RelayTunNetworkEffects.Resolver,
                     verifyDevice: @escaping (RelayTunNetworkEffects.DeviceIdentity) throws -> Void,
                     record: @escaping (Event) throws -> Void) throws -> RelayTunResolverAdapter {
        try Self(planID: planID, device: device, resolver: resolver, driver: liveDriver, verifyDevice: verifyDevice, record: record)
    }
    private static func value(_ resolver: Effects.Resolver) throws -> Data {
        try canonical(["ServerAddresses": resolver.servers.map(\.value), "SupplementalMatchDomains": resolver.matchDomains,
                       "SupplementalMatchOrders": Array(repeating: resolver.searchOrder, count: resolver.matchDomains.count),
                       "SearchDomains": resolver.searchDomains])
    }
    private static func canonical(_ value: Any) throws -> Data {
        guard let object = value as? [String: Any], JSONSerialization.isValidJSONObject(object) else { throw Failure.invalid }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        guard data.count <= 65536 else { throw Failure.invalid }; return data
    }
    private static func checked(_ value: Data?) throws -> Data? {
        guard let value else { return nil }
        guard value.count <= 65536 else { throw Failure.invalid }
        // A driver observation must already be canonical; unknown additional
        // fields are retained in its bytes and cannot match the desired value.
        let object = try RelayTunStrictJSON.object(value, limit: 65536)
        guard try canonical(object) == value else { throw Failure.invalid }; return value
    }
    private func inspect() throws -> Data? { try Self.checked(driver.inspect(resolver.key)) }
    private func status() -> Status {
        .init(phase: currentPhase, ownsSession: session?.held() ?? false, absentVerified: currentPhase == .absent, failure: failure)
    }
    private func publish() {
        let value = View(busy: mutating, status: status()); statusLock.lock(); published = value; statusLock.unlock()
    }
    var view: View { statusLock.lock(); defer { statusLock.unlock() }; return published }
    private func begin() throws {
        guard lock.try() else { throw Failure.busy }
        guard !mutating else { lock.unlock(); throw Failure.busy }
        guard driver.authorized() else { lock.unlock(); throw Failure.permission }
        mutating = true; publish()
    }
    private func end() {
        withExtendedLifetime(self) {
            mutating = false; publish()
            if currentPhase == .absent { releaseRecovery() }
            lock.unlock()
        }
    }
    private func event(_ operation: Operation, _ phase: RecordPhase, observed: Data?) throws {
        publish()
        try record(.init(operation: operation, phase: phase, planID: planID, device: device, resolver: resolver,
                         observedSHA256: observed.map(RelayTunHelperTrust.digest) ?? RelayTunNetworkTransaction.absentSHA256,
                         ownsSession: session?.held() ?? false))
    }
    private func failed(_ error: Error) -> Status {
        failure = error as? Failure ?? .uncertain
        currentPhase = failure.map { if case .conflict = $0 { return .conflict }; return .uncertain } ?? .uncertain
        return status()
    }
    /// Fresh value observation for Transaction.Environment.observe. This maps
    /// only this exact typed effect; matching bytes do not prove session/key
    /// ownership, device existence, authorization or completed restoration.
    func observation() throws -> String {
        try begin(); defer { end() }
        guard let observed = try inspect() else { return RelayTunNetworkTransaction.absentSHA256 }
        if observed == desired { return desiredEffectSHA256 }
        return try Effects.hash(["version": 1, "kind": "unexpected-resolver-value", "key": resolver.key,
                                 "deviceID": device.id, "valueSHA256": RelayTunHelperTrust.digest(observed)])
    }
    @discardableResult func install() throws -> Status {
        try begin(); defer { end() }
        guard currentPhase == .idle else { throw Failure.state }
        try verifyDevice(device)
        let before = try inspect()
        guard before == nil else { currentPhase = .conflict; failure = .conflict; return status() }
        try event(.install, .intent, observed: nil)
        // Recheck both device identity and target absence after journal I/O.
        try verifyDevice(device)
        guard try inspect() == nil else { currentPhase = .conflict; failure = .conflict; return status() }
        retainForRecovery()
        currentPhase = .uncertain
        do {
            session = try driver.create(resolver.key)
            guard session?.held() == true else { throw Failure.uncertain }
            guard try session!.addTemporary(desired) else { throw Failure.uncertain }
            guard try inspect() == desired else { throw Failure.uncertain }
            try verifyDevice(device)
            try event(.install, .confirmed, observed: desired)
            try verifyDevice(device)
            guard try inspect() == desired else { throw Failure.uncertain }
            currentPhase = .held; failure = nil; return status()
        } catch { return failed(error) }
    }
    @discardableResult func release() throws -> Status {
        try begin(); defer { end() }
        guard currentPhase != .idle && currentPhase != .absent else { throw Failure.state }
        do {
            let before = try inspect()
            guard before == nil || before == desired else { throw Failure.conflict }
            try event(.release, .intent, observed: before)
            guard try inspect() == before else { throw Failure.conflict }
            if let session, session.held() {
                let result = try session.release()
                guard result.released, !result.uncertain, !session.held() else { throw Failure.uncertain }
            }
            currentPhase = .released
            try event(.release, .confirmed, observed: before)
            return try confirmAbsence()
        } catch { return failed(error) }
    }
    @discardableResult func verifyAbsent() throws -> Status {
        try begin(); defer { end() }
        guard currentPhase != .idle && currentPhase != .absent, session?.held() != true else { throw Failure.state }
        do { return try confirmAbsence() } catch { return failed(error) }
    }
    private func confirmAbsence() throws -> Status {
        if let observed = try inspect() {
            // configd may not have processed session teardown yet. Identical
            // bytes also cannot distinguish a new owner's same-value update.
            throw observed == desired ? Failure.uncertain : Failure.conflict
        }
        try event(.verifyAbsent, .confirmed, observed: nil)
        // A journal callback cannot substitute a new key after the observation.
        if let observed = try inspect() { throw observed == desired ? Failure.uncertain : Failure.conflict }
        currentPhase = .absent; failure = nil; return status()
    }

    private final class LiveSession {
        private var store: SCDynamicStore?
        let key: String
        var held: Bool { store != nil }
        init(key: String) throws {
            guard getuid() == 0 && geteuid() == 0 else { throw Failure.permission }
            Self.apiCall()
            guard let store = SCDynamicStoreCreate(nil, "Relay temporary DNS" as CFString, nil, nil) else { throw Failure.system(SCError()) }
            self.store = store; self.key = key
        }
        func add(_ data: Data) throws -> Bool {
            guard getuid() == 0 && geteuid() == 0, let store else { throw Failure.permission }
            let object = try RelayTunStrictJSON.object(data, limit: 65536)
            Self.apiCall(); return SCDynamicStoreAddTemporaryValue(store, key as CFString, object as CFDictionary)
        }
        func release() throws -> ReleaseResult {
            guard getuid() == 0 && geteuid() == 0 else { throw Failure.permission }
            store = nil
            return .init(released: true, uncertain: false)
        }
        private static func apiCall() { RelayTunResolverAdapter.apiCall() }
    }
    private static var liveDriver: Driver {
        .init(authorized: { getuid() == 0 && geteuid() == 0 }, inspect: { key in
            guard getuid() == 0 && geteuid() == 0 else { throw Failure.permission }
            apiCall()
            guard let observer = SCDynamicStoreCreate(nil, "Relay DNS observation" as CFString, nil, nil) else { throw Failure.system(SCError()) }
            apiCall()
            guard let object = SCDynamicStoreCopyValue(observer, key as CFString) else {
                let error = SCError(); guard error == kSCStatusNoKey else { throw Failure.system(error) }; return nil
            }
            return try canonical(object)
        }, create: { key in
            let owner = try LiveSession(key: key)
            return .init(held: { owner.held }, addTemporary: { try owner.add($0) }, release: { try owner.release() })
        })
    }
    private static func apiCall() {
        #if RELAY_TUN_RESOLVER_TESTS
        apiLock.lock(); apiCalls += 1; apiLock.unlock()
        #endif
    }
    #if RELAY_TUN_RESOLVER_TESTS
    private static let apiLock = NSLock()
    private static var apiCalls = 0
    static var liveAPICalls: Int { apiLock.lock(); defer { apiLock.unlock() }; return apiCalls }
    #endif
}
