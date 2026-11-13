import Foundation

/// Shared by extension main, its XPC listener and DataProvider. A session is
/// invalidated on signed-host connection loss; protected flows recheck their
/// generation and the kernel-owned listener before every admitted data chunk.
final class RelayGuardProviderSession: @unchecked Sendable {
    struct Revocation: Sendable {
        let run: UUID
        // Nil only when the Provider run itself retires, not on a rebind.
        let generation: UInt64?

        func retires(run candidate: UUID, generation candidateGeneration: UInt64) -> Bool {
            run == candidate && (generation == nil || generation == candidateGeneration)
        }
    }

    static let shared = RelayGuardProviderSession()
    private let lock = NSRecursiveLock()
    private var owner: UUID?
    private var nonce: String?
    private var proof: RelayGuardProxyProof?
    private var providerReady = false
    private var providerRun: UUID?
    private var generation: UInt64 = 0
    private var onRevoked: ((Revocation) -> Void)?

    // Called under the session lock. Deliver outside it, using the exact lease
    // that lost authority even if a replacement admits flows before delivery.
    private func advanceBindingLocked() -> (() -> Void)? {
        let retired = generation
        generation &+= 1
        guard let run = providerRun, let callback = onRevoked else { return nil }
        return { callback(.init(run: run, generation: retired)) }
    }

    @discardableResult
    func beginProviderRun(_ run: UUID, isLocallyCurrent: () -> Bool, onRevoked callback: @escaping (Revocation) -> Void) -> Bool {
        lock.lock()
        guard isLocallyCurrent() else { lock.unlock(); return false }
        if providerRun == run { onRevoked = callback; lock.unlock(); return true }
        let previous = onRevoked, previousRun = providerRun
        // Main prepares its authenticated Core lease before enabling the
        // first Provider. Preserve that preparation for this first owner.
        // Replacing a still-present run retires that run's binding instead.
        if previousRun != nil { proof = nil; generation &+= 1 }
        providerRun = run; providerReady = false
        onRevoked = callback
        lock.unlock()
        if let previousRun { previous?(.init(run: previousRun, generation: nil)) }
        return true
    }
    func isProviderRun(_ expected: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }; return providerRun == expected
    }
    @discardableResult
    func setProviderReady(_ value: Bool, run expected: UUID) -> Bool {
        var callback: (() -> Void)?
        lock.lock(); defer { lock.unlock(); callback?() }
        guard providerRun == expected else { return false }
        providerReady = value
        if !value { proof = nil; callback = advanceBindingLocked() }
        return true
    }
    func endProviderRun(_ expected: UUID?) {
        lock.lock()
        guard let expected, providerRun == expected else { lock.unlock(); return }
        providerRun = nil; providerReady = false; proof = nil; generation &+= 1
        let callback = onRevoked; onRevoked = nil
        lock.unlock(); callback?(.init(run: expected, generation: nil))
    }
    func revoke(owner connection: UUID? = nil) {
        var callback: (() -> Void)?
        lock.lock(); defer { lock.unlock(); callback?() }
        guard connection == nil || owner == connection else { return }
        owner = nil; nonce = nil; proof = nil; callback = advanceBindingLocked()
    }
    func transact(_ message: RelayGuardSessionMessage, connection: UUID, uid: UInt32) throws -> RelayGuardSessionReply {
        let running = try RelayGuardRuntimeAttestation.current()
        try RelayGuardRuntimeAttestation.validate(buildVersion: message.buildVersion, contractRevision: message.contractRevision, policyRevision: message.policyRevision)
        var callback: (() -> Void)?
        lock.lock(); defer { lock.unlock(); callback?() }
        guard owner == nil || owner == connection, nonce == nil || nonce == message.nonce else {
            throw RelayGuardBindingFailure.stale
        }
        if message.action == "revoke" {
            owner = nil; nonce = nil; proof = nil; callback = advanceBindingLocked()
        }
        else if message.action == "bind" {
            guard let candidate = message.proof, candidate.uid == uid, uid > 0,
                  UUID(uuidString: candidate.instanceID)?.uuidString.lowercased() == candidate.instanceID,
                  candidate.configurationSHA256.utf8.count == 64,
                  RelayGuardCorePins.accepts(executable: candidate.executable, sha256: candidate.resourceSHA256) else {
                throw RelayGuardBindingFailure.invalid
            }
            try candidate.verify()
            proof = candidate; nonce = message.nonce; owner = connection; callback = advanceBindingLocked()
        }
        if let proof { try proof.verify() }
        return RelayGuardSessionReply(version: 2, buildVersion: running.buildVersion, contractRevision: running.contractRevision, policyRevision: running.policyRevision, id: message.id, nonce: message.nonce,
            state: proof == nil ? "unbound" : providerReady && RelayGuardLineageClient.shared.available ? "ready" : "prepared",
            instanceID: proof?.instanceID, configurationSHA256: proof?.configurationSHA256, protectionVerified: false)
    }
    /// Only the actual owned Core process may carry proxy infrastructure
    /// traffic. A mismatched ordinary actor never revokes somebody else's
    /// valid binding and never inherits an infrastructure allowance.
    func infrastructureSnapshot(_ token: Data?, generation expected: UInt64? = nil) -> (proof: RelayGuardProxyProof, generation: UInt64)? {
        lock.lock(); defer { lock.unlock() }
        guard providerReady, let proof, expected == nil || expected == generation,
              (try? proof.verifyInfrastructureActor(token)) != nil else { return nil }
        return (proof, generation)
    }
    func bindingGeneration() -> UInt64 { lock.lock(); defer { lock.unlock() }; return generation }
    func snapshot(providerRun expected: UUID? = nil) -> (proof: RelayGuardProxyProof, generation: UInt64)? {
        var callback: (() -> Void)?
        lock.lock(); defer { lock.unlock(); callback?() }
        guard providerReady, providerRun != nil, expected == nil || providerRun == expected,
              let proof else { return nil }
        do { try proof.verify(); return (proof, generation) }
        catch { self.proof = nil; callback = advanceBindingLocked(); return nil }
    }
    func hasPreparedProof() -> Bool {
        lock.lock(); let candidate = proof; lock.unlock()
        guard let candidate else { return false }
        return (try? candidate.verify()) != nil
    }
    func current(_ expected: UInt64) -> Bool {
        guard let actual = snapshot() else { return false }
        return actual.generation == expected
    }
}
