import CryptoKit
import Darwin
import Foundation
import Security

/// Long-lived, signed main-App peer. XPC death revokes the Provider lease. No
/// liveness Boolean from a renderer is ever promoted to policy readiness.
@MainActor
final class RelayGuardHostConnection {
    private var connection: NSXPCConnection?
    private var localProof: RelayGuardProxyProof?
    private var proof: RelayGuardProxyProof?
    private var nonce = ""
    private var observed: RelayGuardSessionReply?
    private var observedAt: UInt64 = 0
    private var remoteBindMayExist = false

    func bind(_ value: RelayGuardProxyProof) async throws -> RelayGuardSessionReply {
        _ = try RelayGuardManagementPermit.inspect(for: .disable)
        try value.verify()
        localProof = value
        if connection == nil {
            guard let team = RelayGuardManagementRelease.publisherTeamID else { throw RelayGuardBindingFailure.publisher }
            let service = team + "." + RelayGuardContract.extensionID + ".ipc"
            let peer = NSXPCConnection(machServiceName: service)
            peer.setCodeSigningRequirement(try RelayGuardXPCIdentity.requirement(identifier: RelayGuardContract.extensionID))
            peer.remoteObjectInterface = NSXPCInterface(with: RelayGuardProviderCommunication.self)
            peer.interruptionHandler = { [weak self] in Task { @MainActor in self?.lost() } }
            peer.invalidationHandler = { [weak self] in Task { @MainActor in self?.lost() } }
            var random = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw RelayGuardBindingFailure.invalid }
            nonce = random.map { String(format: "%02x", $0) }.joined()
            connection = peer; peer.resume()
        }
        remoteBindMayExist = true
        do {
            let response = try await request("bind", proof: value)
            guard ["prepared", "ready"].contains(response.state), response.instanceID == value.instanceID,
                  response.configurationSHA256 == value.configurationSHA256 else { throw RelayGuardBindingFailure.stale }
            proof = value
            observed = response; observedAt = DispatchTime.now().uptimeNanoseconds
            return response
        } catch {
            // A mismatched/old reply never leaves a previously cached ready
            // result live. The possibly delivered remote bind remains sticky.
            lost(); throw error
        }
    }
    func status() async throws -> RelayGuardSessionReply {
        do {
        guard let proof else { throw RelayGuardBindingFailure.stale }
        try proof.verify()
        let reply = try await request("status")
        guard reply.instanceID == proof.instanceID, reply.configurationSHA256 == proof.configurationSHA256 else {
            lost(); throw RelayGuardBindingFailure.stale
        }
        observed = reply; observedAt = DispatchTime.now().uptimeNanoseconds
        return reply
        } catch { lost(); throw error }
    }
    func prepare(_ value: RelayGuardProxyProof, connect: Bool) async throws {
        _ = try RelayGuardManagementPermit.inspect(for: .disable)
        try value.verify()
        if remoteBindMayExist { try await revoke() }
        localProof = value
        // Never infer disabled-service launchability. Local preparation sends no
        // bind; after explicit enable the one post-save bind establishes proof.
        if connect { _ = try await bind(value) }
    }
    func confirmDisabled(_ observation: RelayGuardFilterObservation?) {
        guard let observation, !observation.enabled, observation.owned || !observation.exists else { return }
        // A fresh owned disabled/absent NE observation is an independent closure
        // proof, including a bind whose reply or connection was lost.
        if remoteBindMayExist { remoteBindMayExist = false; localProof = nil; lost() }
    }
    func refreshForEnable() throws {
        guard let localProof, !remoteBindMayExist || (proof != nil && observed != nil && connection != nil) else { throw RelayGuardBindingFailure.stale }
        try localProof.verify()
    }
    func connectPrepared() async throws {
        guard let localProof else { throw RelayGuardBindingFailure.stale }
        _ = try await bind(localProof)
    }
    func authorizePrepared(requireRunning: Bool = false) throws {
        if !requireRunning { try refreshForEnable(); return }
        guard let proof, let observed, observed.state == "ready",
              observed.instanceID == proof.instanceID, observed.configurationSHA256 == proof.configurationSHA256,
              DispatchTime.now().uptimeNanoseconds >= observedAt,
              DispatchTime.now().uptimeNanoseconds - observedAt < 3_000_000_000 else { throw RelayGuardBindingFailure.stale }
        try proof.verify()
    }
    var isBound: Bool { proof != nil }
    var isPrepared: Bool { localProof != nil }
    var publicState: [String: Any] {
        if remoteBindMayExist && (connection == nil || proof == nil || observed == nil) { return ["phase": "unconfirmed"] }
        guard let proof, let observed else {
            guard let localProof else { return ["phase": "unbound"] }
            return ["phase": "preparedLocally", "instanceID": localProof.instanceID, "configurationSHA256": localProof.configurationSHA256]
        }
        return ["phase": observed.state, "instanceID": proof.instanceID, "configurationSHA256": proof.configurationSHA256]
    }
    func revoke() async throws {
        guard connection != nil else {
            guard !remoteBindMayExist else { throw RelayGuardBindingFailure.stale }
            localProof = nil; proof = nil; observed = nil; observedAt = 0
            return
        }
        defer { lost() }
        let reply = try await request("revoke")
        guard reply.state == "unbound", reply.instanceID == nil, reply.configurationSHA256 == nil else { throw RelayGuardBindingFailure.stale }
        remoteBindMayExist = false; localProof = nil
    }
    private func lost() { proof = nil; observed = nil; observedAt = 0; let previous = connection; connection = nil; previous?.invalidate() }
    private func request(_ action: String, proof: RelayGuardProxyProof? = nil) async throws -> RelayGuardSessionReply {
        guard let connection else { throw RelayGuardBindingFailure.stale }
        let running = try RelayGuardRuntimeAttestation.current()
        let message = RelayGuardSessionMessage(version: 2, buildVersion: running.buildVersion, contractRevision: running.contractRevision, policyRevision: running.policyRevision, id: UUID().uuidString.lowercased(), nonce: nonce, action: action, proof: proof)
        let bytes = try JSONEncoder().encode(message)
        return try await withCheckedThrowingContinuation { continuation in
            let gate = RelayGuardReplyOnce(continuation)
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { gate.finish(.failure(RelayGuardBindingFailure.stale)) }
            guard let remote = connection.remoteObjectProxyWithErrorHandler({ _ in gate.finish(.failure(RelayGuardBindingFailure.publisher)) })
                as? RelayGuardProviderCommunication else { gate.finish(.failure(RelayGuardBindingFailure.publisher)); return }
            remote.transact(bytes as NSData) { data in
                do {
                    guard data.length <= 8192 else { throw RelayGuardBindingFailure.invalid }
                    let object = try RelayTunStrictJSON.object(data as Data, limit: 8192)
                    let reply = try JSONDecoder().decode(RelayGuardSessionReply.self, from: data as Data)
                    guard Set(object.keys) == Set(["version", "buildVersion", "contractRevision", "policyRevision", "id", "nonce", "state", "protectionVerified"] + (reply.instanceID == nil ? [] : ["instanceID"]) + (reply.configurationSHA256 == nil ? [] : ["configurationSHA256"])),
                          reply.version == 2, reply.buildVersion == message.buildVersion, reply.contractRevision == message.contractRevision, reply.policyRevision == message.policyRevision, reply.id == message.id, reply.nonce == message.nonce,
                          !reply.protectionVerified, ["prepared", "ready", "unbound"].contains(reply.state) else { throw RelayGuardBindingFailure.invalid }
                    gate.finish(.success(reply))
                } catch { gate.finish(.failure(error)) }
            }
        }
    }
}

private final class RelayGuardReplyOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<RelayGuardSessionReply, Error>?
    init(_ continuation: CheckedContinuation<RelayGuardSessionReply, Error>) { self.continuation = continuation }
    func finish(_ result: Result<RelayGuardSessionReply, Error>) {
        lock.lock(); let value = continuation; continuation = nil; lock.unlock()
        value?.resume(with: result)
    }
}
