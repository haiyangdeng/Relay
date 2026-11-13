#if RELAY_GUARD_SESSION_FIXTURE
import Dispatch
import Foundation

private final class FixtureFlows: @unchecked Sendable {
    private struct Flow {
        let run: UUID
        let generation: UInt64
    }

    private let lock = NSLock()
    private var flows: [String: Flow] = [:]

    func add(_ name: String, run: UUID, generation: UInt64) {
        lock.withLock { flows[name] = Flow(run: run, generation: generation) }
    }

    func retire(_ notice: RelayGuardProviderSession.Revocation) {
        lock.withLock {
            flows = flows.filter { !notice.retires(run: $0.value.run, generation: $0.value.generation) }
        }
    }

    var names: Set<String> { lock.withLock { Set(flows.keys) } }
}

@main
enum RelayGuardProviderSessionTests {
    static func main() {
        lateBindingRetirement()
        fullRunRetirement()
        staleOwnerRevocation()
        #if RELAY_GUARD_PROVIDER_CONNECTION_FIXTURE
        lateRequestForRetiredConnection()
        retirementDuringBind()
        #endif
    }

    private static func lateBindingRetirement() {
        let session = RelayGuardProviderSession()
        let run = UUID(), otherRun = UUID(), flows = FixtureFlows()
        let callbackReached = DispatchSemaphore(value: 0)
        let deliverCallback = DispatchSemaphore(value: 0)
        let callbackFinished = DispatchSemaphore(value: 0)
        precondition(session.beginProviderRun(run, isLocallyCurrent: { true }) { notice in
            precondition(notice.run == run && notice.generation != nil)
            callbackReached.signal()
            precondition(deliverCallback.wait(timeout: .now() + 5) == .success)
            flows.retire(notice)
        })
        precondition(session.setProviderReady(true, run: run))
        let retiredGeneration = session.bindingGeneration()
        flows.add("old protected", run: run, generation: retiredGeneration)
        flows.add("old infrastructure", run: run, generation: retiredGeneration)
        flows.add("other run", run: otherRun, generation: retiredGeneration)

        DispatchQueue.global().async {
            precondition(session.setProviderReady(false, run: run))
            callbackFinished.signal()
        }
        precondition(callbackReached.wait(timeout: .now() + 5) == .success)
        // The real session changes generation before releasing its lock and
        // delivering the notice. Admit the model replacement at that boundary.
        let currentGeneration = session.bindingGeneration()
        precondition(currentGeneration != retiredGeneration)
        precondition(session.setProviderReady(true, run: run))
        flows.add("new protected", run: run, generation: currentGeneration)
        flows.add("new infrastructure", run: run, generation: currentGeneration)
        deliverCallback.signal()
        precondition(callbackFinished.wait(timeout: .now() + 5) == .success)
        precondition(flows.names == ["new protected", "new infrastructure", "other run"])
        print("PASS: delayed old binding retirement drops only its exact protected and infrastructure flows")
    }

    private static func fullRunRetirement() {
        let session = RelayGuardProviderSession()
        let first = UUID(), replacement = UUID(), flows = FixtureFlows()
        precondition(session.beginProviderRun(first, isLocallyCurrent: { true }, onRevoked: flows.retire))
        let initial = session.bindingGeneration()
        flows.add("first old generation", run: first, generation: initial)
        flows.add("first newer generation", run: first, generation: initial + 1)
        flows.add("replacement", run: replacement, generation: initial)
        precondition(session.beginProviderRun(replacement, isLocallyCurrent: { true }, onRevoked: flows.retire))
        precondition(flows.names == ["replacement"])
        let current = session.bindingGeneration()
        session.endProviderRun(first)
        precondition(!session.setProviderReady(false, run: first))
        precondition(session.bindingGeneration() == current && flows.names == ["replacement"])
        flows.add("replacement newer generation", run: replacement, generation: current)
        session.endProviderRun(replacement)
        precondition(flows.names.isEmpty)
        print("PASS: Provider replacement and stop retire the entire owning run; stale stop does not affect its successor")
    }

    private static func staleOwnerRevocation() {
        let session = RelayGuardProviderSession()
        let run = UUID(), flows = FixtureFlows()
        precondition(session.beginProviderRun(run, isLocallyCurrent: { true }, onRevoked: flows.retire))
        let retired = session.bindingGeneration()
        flows.add("revocable", run: run, generation: retired)
        flows.add("later binding", run: run, generation: retired + 1)
        session.revoke(owner: UUID())
        precondition(session.bindingGeneration() == retired && flows.names.count == 2)
        session.revoke()
        precondition(session.bindingGeneration() == retired + 1 && flows.names == ["later binding"])
        print("PASS: stale owner is ignored and explicit revocation only retires the current binding generation")
    }

    #if RELAY_GUARD_PROVIDER_CONNECTION_FIXTURE
    private static func bindRequest(uid: UInt32) -> Data {
        let proof = RelayGuardProxyProof(instanceID: UUID().uuidString.lowercased(),
            configurationSHA256: String(repeating: "1", count: 64), pid: 42, uid: uid,
            bornSeconds: 1, bornMicroseconds: 0, executable: "/fixture/owned-core",
            resourceSHA256: String(repeating: "2", count: 64), fileIdentity: "fixture", ports: [17890, 17891])
        return try! JSONEncoder().encode(RelayGuardSessionMessage(version: 2,
            buildVersion: RelayGuardManagementRelease.buildVersion,
            contractRevision: RelayGuardManagementRelease.sessionContractRevision,
            policyRevision: RelayGuardManagementRelease.policyRevision,
            id: UUID().uuidString.lowercased(), nonce: String(repeating: "3", count: 64),
            action: "bind", proof: proof))
    }

    private static func state(_ request: Data, from handler: RelayGuardProviderRequestHandler) -> String? {
        var value: String?
        handler.transact(request as NSData) { data in
            let response = try! JSONSerialization.jsonObject(with: data as Data) as! [String: Any]
            value = (response["state"] ?? response["error"]) as? String
        }
        return value
    }

    private static func lateRequestForRetiredConnection() {
        let uid: UInt32 = 501
        let session = RelayGuardProviderSession.shared
        let old = RelayGuardProviderRequestHandler(connection: UUID(), uid: uid)
        let next = RelayGuardProviderRequestHandler(connection: UUID(), uid: uid)
        precondition(state(bindRequest(uid: uid), from: old) == "prepared")
        let queuedRequest = bindRequest(uid: uid)
        old.retire()
        let retiredGeneration = session.bindingGeneration()
        precondition(!session.hasPreparedProof())
        let late = state(queuedRequest, from: old)
        guard late == "unconfirmed" else {
            FileHandle.standardError.write(Data("FAIL: retired exported handler accepted queued bind: \(late ?? "nil")\n".utf8))
            exit(1)
        }
        precondition(session.bindingGeneration() == retiredGeneration && !session.hasPreparedProof())
        precondition(state(bindRequest(uid: uid), from: next) == "prepared")
        let nextGeneration = session.bindingGeneration()
        old.retire()
        precondition(state(bindRequest(uid: uid), from: old) == "unconfirmed")
        precondition(session.bindingGeneration() == nextGeneration && session.hasPreparedProof())
        next.retire()
        print("PASS: a queued bind cannot regain a retired connection's lease or change its replacement")
    }

    private static func retirementDuringBind() {
        let uid: UInt32 = 501
        let old = RelayGuardProviderRequestHandler(connection: UUID(), uid: uid)
        let next = RelayGuardProviderRequestHandler(connection: UUID(), uid: uid)
        let request = bindRequest(uid: uid)
        let verificationEntered = DispatchSemaphore(value: 0), allowVerification = DispatchSemaphore(value: 0)
        let startedRetirement = DispatchSemaphore(value: 0), retired = DispatchSemaphore(value: 0)
        let bound = DispatchSemaphore(value: 0)
        RelayGuardProviderConnectionFixtureProof.blockOnce {
            verificationEntered.signal()
            precondition(allowVerification.wait(timeout: .now() + 5) == .success)
        }
        DispatchQueue.global().async {
            precondition(state(request, from: old) == "prepared")
            bound.signal()
        }
        precondition(verificationEntered.wait(timeout: .now() + 5) == .success)
        DispatchQueue.global().async {
            startedRetirement.signal()
            old.retire()
            retired.signal()
        }
        precondition(startedRetirement.wait(timeout: .now() + 5) == .success)
        allowVerification.signal()
        precondition(bound.wait(timeout: .now() + 5) == .success)
        precondition(retired.wait(timeout: .now() + 5) == .success)
        precondition(!RelayGuardProviderSession.shared.hasPreparedProof())
        precondition(state(bindRequest(uid: uid), from: next) == "prepared")
        next.retire()
        print("PASS: retirement during proof verification clears the in-flight binding before replacement")
    }
    #endif
}
#endif
