import Foundation
import CryptoKit
import Darwin

/// One ordinary-UID core lifetime. This is a capability/state-machine slice,
/// not a production process adapter or a JSON/IPC entry point. Driver closures
/// must capture the authenticated, admitted FD and this invocation's spawned,
/// unreaped child. They may not adopt a PID, path, FD number or ready Boolean
/// supplied by a caller. HelperMain deliberately does not construct this type.
final class RelayTunCoreHost {
    enum Failure: Error { case invalid, permission, busy, state, revoked, uncertain }
    enum Phase: String { case idle, starting, ready, revoked, stopping, released, uncertain }

    struct Binding: Equatable {
        let receipt: RelayTunAcquiredReceipt
        let coreSHA256: String
        init(receipt: RelayTunAcquiredReceipt, coreSHA256: String) throws {
            try receipt.validate()
            guard RelayTunInstallationPaths.fixedCorePins.values.contains(where: { $0.0 == coreSHA256 }) else { throw Failure.invalid }
            self.receipt = receipt; self.coreSHA256 = coreSHA256
        }
    }
    /// A live adapter must derive this observation from the exact held child,
    /// pinned executable, private configuration bytes and observed inherited FD.
    /// Decoding a caller's report is not an implementation of this contract.
    struct RuntimeObservation {
        let binding: Binding
        let runtimeConfigurationSHA256: String
        let coreVersion: String
        let inheritedDescriptor: Int32
    }
    struct Child {
        let poll: () throws -> RelayTunCoreProbePlan.ChildState
        let stop: () throws -> RelayTunCoreProbePlan.Stopped
        let readiness: () throws -> RuntimeObservation?
    }
    struct Descriptor {
        /// Re-observe the retained descriptor's complete receipt identity.
        let verify: () throws -> RelayTunAcquiredReceipt
        /// Launch only the fixed core, with FD3 and these exact private bytes.
        /// Register exactly once immediately after successful spawn, before any
        /// throwing post-spawn check. A later throw retains that capability.
        let launch: (Binding, Data, (Child) -> Void) throws -> Void
        /// Positive spawn-failure observation when launch was attempted but no
        /// child capability was registered. Missing registration alone is not
        /// proof that no child or inherited descriptor exists.
        let spawnAbsent: () throws -> Bool
        /// Close all ordinary-UID parent/client copies exactly once. The child
        /// must already have been positively reaped. An ambiguous close is not
        /// retried against a possibly reused descriptor number.
        let close: () throws -> Void
        let closed: () throws -> Bool
    }
    struct Driver {
        let ordinaryUID: () -> UInt32?
        let verifyResource: (Binding) throws -> Void
        let admit: (Binding) throws -> Descriptor
        // A session may transfer an authenticated XPC delivery before resource
        // verification/admission. That original copy also needs explicit close
        // evidence if start fails before admission; nil means no such copy.
        var releaseUnadmitted: (() throws -> Bool)? = nil
        // Immediate, nonblocking latch shared with the actual launch adapter.
        // It revokes unexecuted work and never stops a child or closes an FD.
        var revoke: () -> Void = {}
    }
    struct Status {
        let phase: Phase
        let retainsDescriptor: Bool
        let ownsChild: Bool
        let childExited: Bool
        let clientFDClosed: Bool
        let forcedExit: Bool
        let cleanExit: Bool
        var ready: Bool { phase == .ready }
        var released: Bool { phase == .released && childExited && clientFDClosed }
    }
    final class RecoveryToken { let id = UUID().uuidString.lowercased(); fileprivate init() {} }
    private static let recoveryLock = NSLock()
    private static var owners: [ObjectIdentifier: RelayTunCoreHost] = [:]
    let recoveryToken = RecoveryToken()
    static func recover(_ token: RecoveryToken) -> RelayTunCoreHost? {
        recoveryLock.lock(); defer { recoveryLock.unlock() }
        guard let owner = owners[ObjectIdentifier(token)], owner.recoveryToken === token else { return nil }
        return owner
    }
    static var recoveryCount: Int { recoveryLock.lock(); defer { recoveryLock.unlock() }; return owners.count }
    static let productionOrdinaryUID: () -> UInt32? = {
        guard getuid() > 0, geteuid() == getuid(), getgid() == getegid() else { return nil }
        return getuid()
    }

    private let binding: Binding
    var observationBinding: Binding { binding }
    private let configuration: Data
    private let driver: Driver
    private let operationLock = NSRecursiveLock()
    private var operating = false
    private let revocationLock = NSLock()
    private var revoked = false
    private let statusLock = NSLock()
    private var published = Status(phase: .idle, retainsDescriptor: false, ownsChild: false,
        childExited: false, clientFDClosed: false, forcedExit: false, cleanExit: false)
    private var phase: Phase = .idle
    private(set) var startFailureStage: String?
    private var descriptor: Descriptor?
    private var child: Child?
    private var launchAttempted = false
    private var spawnAbsenceVerified = false
    private var waitStatus: Int32?
    private var forced = false
    private var closeAttempted = false
    private var fdClosed = false

    init(binding: Binding, configuration: Data, driver: Driver) throws {
        guard !configuration.isEmpty, configuration.count <= 16 * 1024 * 1024,
              Self.digest(configuration) == binding.receipt.runtimeConfigurationSHA256 else { throw Failure.invalid }
        self.binding = binding; self.configuration = configuration; self.driver = driver
    }
    private static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func isRevoked() -> Bool { revocationLock.lock(); defer { revocationLock.unlock() }; return revoked }
    private func retainRecovery() {
        Self.recoveryLock.lock(); Self.owners[ObjectIdentifier(recoveryToken)] = self; Self.recoveryLock.unlock()
    }
    private func retireRecovery() {
        Self.recoveryLock.lock(); Self.owners.removeValue(forKey: ObjectIdentifier(recoveryToken)); Self.recoveryLock.unlock()
    }
    private func publish() {
        let snapshot = Status(phase: phase, retainsDescriptor: descriptor != nil || (driver.releaseUnadmitted != nil && !fdClosed), ownsChild: child != nil && waitStatus == nil,
            childExited: waitStatus != nil || (child == nil && (!launchAttempted || spawnAbsenceVerified)), clientFDClosed: fdClosed,
            forcedExit: forced, cleanExit: waitStatus == 0 && !forced)
        statusLock.lock(); published = snapshot; statusLock.unlock()
    }
    var status: Status {
        statusLock.lock(); let value = published; statusLock.unlock()
        if isRevoked(), value.phase == .starting || value.phase == .ready {
            return Status(phase: .revoked, retainsDescriptor: value.retainsDescriptor, ownsChild: value.ownsChild,
                childExited: value.childExited, clientFDClosed: value.clientFDClosed,
                forcedExit: value.forcedExit, cleanExit: value.cleanExit)
        }
        return value
    }
    private func begin() throws {
        guard operationLock.try() else { throw Failure.busy }
        guard !operating else { operationLock.unlock(); throw Failure.busy }
        guard driver.ordinaryUID() == binding.receipt.clientUID else { suspend(); operationLock.unlock(); throw Failure.permission }
        operating = true
    }
    private func end() { publish(); operating = false; operationLock.unlock() }
    private func authorize() throws {
        guard driver.ordinaryUID() == binding.receipt.clientUID else { throw Failure.permission }
        guard !isRevoked() else { throw Failure.revoked }
    }
    private func verifyDescriptor() throws {
        guard let descriptor, try descriptor.verify() == binding.receipt else { throw Failure.uncertain }
    }
    private func observeChild() throws -> RelayTunCoreProbePlan.ChildState {
        if let waitStatus { return .exited(waitStatus) }
        guard let child else { throw Failure.state }
        let value = try child.poll()
        if case .exited(let status) = value { waitStatus = status }
        return value
    }
    private func observeRuntime() throws -> String? {
        try authorize(); try verifyDescriptor()
        guard let child, case .running = try observeChild(), let observation = try child.readiness() else { return nil }
        guard observation.binding == binding,
              observation.runtimeConfigurationSHA256 == binding.receipt.runtimeConfigurationSHA256,
              observation.coreVersion == RelayTunCoreProbePlan.version,
              observation.inheritedDescriptor == 3 else { throw Failure.uncertain }
        try verifyDescriptor()
        guard case .running = try observeChild() else { return nil }
        try authorize()
        return observation.runtimeConfigurationSHA256
    }

    /// Starts at most once. Every successfully acquired capability is retained
    /// before the next throwing observation. Failure never claims release.
    func start() throws -> Status {
        try begin(); defer { end() }
        guard phase == .idle else { throw Failure.state }
        var stage = "authorization"
        do {
            if driver.releaseUnadmitted != nil { retainRecovery() }
            try authorize(); phase = .starting; publish()
            stage = "resource"
            try driver.verifyResource(binding); try authorize()
            stage = "admission"
            descriptor = try driver.admit(binding); retainRecovery(); publish()
            stage = "descriptor"
            try verifyDescriptor(); try authorize()
            guard let descriptor else { throw Failure.state }
            var registrations = 0; launchAttempted = true
            stage = "spawn"
            try descriptor.launch(binding, configuration) { owned in
                registrations += 1
                if registrations == 1 { self.child = owned; self.publish() }
            }
            stage = "observation"
            guard registrations == 1, child != nil, try observeRuntime() != nil else { throw Failure.uncertain }
            phase = .ready; publish(); return status
        } catch {
            startFailureStage = stage
            phase = isRevoked() ? .revoked : .uncertain
            throw error
        }
    }
    /// A fresh observation, never a cached ready bit. Failure revokes readiness
    /// while retaining the child and descriptor for explicit recovery.
    func runtime() throws -> String? {
        try begin(); defer { end() }
        guard phase == .ready, !isRevoked() else { return nil }
        do {
            guard let runtime = try observeRuntime() else { phase = .uncertain; return nil }
            return runtime
        } catch { phase = isRevoked() ? .revoked : .uncertain; throw error }
    }
    /// Sleep/quit/consent withdrawal immediately revokes activation, without
    /// blocking on launch/readiness I/O or discarding recovery capabilities.
    func suspend() {
        revocationLock.lock(); revoked = true; revocationLock.unlock()
        driver.revoke()
    }

    /// This is only the ordinary-UID child/FD release proof. It says nothing
    /// about privileged device, route, resolver or host-baseline restoration.
    func release() throws -> Status {
        try begin(); defer { end() }
        if phase == .released { return status }
        guard phase != .idle || driver.releaseUnadmitted != nil else { throw Failure.state }
        phase = .stopping; publish()
        do {
            if let child, waitStatus == nil {
                let stopped = try child.stop()
                guard case .exited(let observed) = try child.poll(), observed == stopped.waitStatus else { throw Failure.uncertain }
                waitStatus = observed; forced = stopped.forced
            }
            guard child == nil || waitStatus != nil else { throw Failure.uncertain }
            if launchAttempted, child == nil {
                guard let descriptor, try descriptor.spawnAbsent() else { throw Failure.uncertain }
                spawnAbsenceVerified = true
            }
            if let descriptor {
                if !closeAttempted { closeAttempted = true; try descriptor.close() }
                guard try descriptor.closed() else { throw Failure.uncertain }
            } else if let releaseUnadmitted = driver.releaseUnadmitted {
                guard try releaseUnadmitted() else { throw Failure.uncertain }
            }
            fdClosed = true; phase = .released; descriptor = nil; retireRecovery(); publish()
            return status
        } catch { phase = .uncertain; throw error }
    }
    /// Returns true only for this exact retained binding, after positive child
    /// reaping (or no spawn) and all ordinary-UID FD-copy closure observations.
    func released(for expected: Binding) -> Bool { expected == binding && status.released }
}

/// Composition of the real spawn-owned process capability with this host's
/// state machine. The readiness closure is still a mandatory trusted source:
/// this adapter does not invent an API/configuration or inherited-FD proof.
extension RelayTunCoreHost.Child {
    static func owned(_ child: RelayTunOwnedChild,
                      readiness: @escaping () throws -> RelayTunCoreHost.RuntimeObservation?) -> Self {
        .init(poll: { try child.observe() }, stop: { try child.stop() },
              readiness: { try child.whileRunning(readiness) })
    }
}
