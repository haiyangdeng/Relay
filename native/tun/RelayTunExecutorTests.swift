import Foundation
import Darwin

/// Isolated policy proofs for the privileged wire executor. Every device,
/// route, resolver, journal and core capability is injected; delivery uses an
/// inert /dev/null descriptor. This runner never creates a utun, writes a
/// route/DNS key, opens a root path or runs as root. The live factory's own
/// privilege gates are exercised only to prove refusal at an ordinary UID.
private typealias Session = RelayTunNetworkSession
private typealias Effects = RelayTunNetworkEffects
private typealias Transaction = RelayTunNetworkTransaction
private typealias Projection = RelayTunNetworkProjection
private typealias Executor = RelayTunPrivilegedExecutor
private enum Injected: Error { case failed }

private final class FailedAcquire: RelayTunFailedAcquisition {
    let plan: Transaction.Plan
    private let close: () -> Void
    private let observeAbsent: () -> Bool
    init(plan: Transaction.Plan, close: @escaping () -> Void, absent: @escaping () -> Bool) {
        self.plan = plan; self.close = close; observeAbsent = absent
    }
    func restore() throws -> Bool { close(); return observeAbsent() }
    func absent() throws -> Bool { observeAbsent() }
}

private final class Fixture {
    let trust: RelayTunInstallationTrust
    let config = String(repeating: "a", count: 64)
    let runtime = String(repeating: "b", count: 64)
    let bundle = String(repeating: "d", count: 64)
    let projection: Projection
    let identity: Effects.DeviceIdentity
    var baseline = Transaction.Baseline(networkSHA256: String(repeating: "e", count: 64),
                                        protectionSHA256: String(repeating: "f", count: 64))
    var rootAllowed = true, coreReady = true, coreCopies = 0, clock: UInt64 = 1000
    var held = false, foreignRoute = false, deviceStillVisible = false
    var leaseCalls = 0, duplicateCalls = 0, closeCalls = 0, routeWrites = 0, resolverWrites = 0
    var routeDump = Data(), resolverValue: Data?, journalBytes: Data?
    var leaseConfigurations: [RelayTunDeviceLease.Configuration] = []
    var runtimeOverride: String?

    init() throws {
        let pin = RelayTunCodePin(sha256: String(repeating: "0", count: 64), size: 1,
                                  cdhashes: ["arm64": String(repeating: "a", count: 40),
                                             "x86_64": String(repeating: "b", count: 40)])
        trust = RelayTunInstallationTrust(revision: String(repeating: "c", count: 64), clientUID: 501,
            helper: pin, client: pin, uninstaller: pin, launchDaemonSHA256: String(repeating: "1", count: 64),
            coreSHA256: ["arm64": String(repeating: "2", count: 64)])
        let address = try Effects.Prefix(address: .init(family: .ipv4, value: "198.18.0.1"), length: 30)
        identity = try .init(id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", interface: .init(name: "utun42", index: 91),
            controlID: 17, controlUnit: 43, socketDevice: 7, socketInode: 0, mtu: 1500, addresses: [address])
        projection = try .init(device: "utun", mtu: 1500, addresses: [address],
            routes: [.init(destination: .init(address: .init(family: .ipv4, value: "198.18.0.0"), length: 30), scoped: false)],
            resolver: .init(servers: [.init(family: .ipv4, value: "198.18.0.2")], matchDomains: [""], searchDomains: [], searchOrder: 1000))
    }
    var peer: RelayTunAuthenticatedPeer { .init(uid: trust.clientUID, installationRevision: trust.revision) }

    func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    func wire(_ object: [String: Any]) throws -> RelayTunWireRequest {
        try RelayTunWireRequest.parse(try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }
    func statusRequest() throws -> RelayTunWireRequest {
        try wire(["version": 1, "operation": "status", "nonce": String(repeating: "1", count: 64)])
    }
    func prepareRequest(projection override: Data? = nil) throws -> RelayTunWireRequest {
        try wire(["version": 1, "operation": "prepare", "nonce": String(repeating: "2", count: 64),
                  "configurationSHA256": config, "runtimeConfigurationSHA256": runtime,
                  "bundleSHA256": bundle, "networkSHA256": baseline.networkSHA256,
                  "protectionSHA256": baseline.protectionSHA256, "projection": hex(override ?? projection.encoded())])
    }
    func acquireRequest(evidence: String) throws -> RelayTunWireRequest {
        try wire(["version": 1, "operation": "acquire", "nonce": String(repeating: "3", count: 64), "evidenceSHA256": evidence])
    }
    func activateRequest(session: String, evidence: String, runtime override: String? = nil) throws -> RelayTunWireRequest {
        try wire(["version": 1, "operation": "activate", "nonce": String(repeating: "4", count: 64),
                  "sessionID": session, "evidenceSHA256": evidence, "runtimeConfigurationSHA256": override ?? runtime])
    }
    func releaseRequest(session: String) throws -> RelayTunWireRequest {
        try wire(["version": 1, "operation": "release", "nonce": String(repeating: "5", count: 64), "sessionID": session])
    }

    func route(changed: Bool = false) throws -> Effects.Route {
        try .init(destination: .init(address: .init(family: .ipv4, value: "198.18.0.0"), length: 30),
                  gateway: nil, interface: identity.interface, scopeIndex: 0, flags: 0x801, hopCount: changed ? 3 : 0)
    }
    func routeFrame(changed: Bool = false) throws -> Data {
        try RelayTunRouteProjection.request(route(changed: changed), operation: .get, pid: 0, sequence: 0, interfaceType: 249)
    }
    func makeLease(_ plan: Transaction.Plan, configuration: RelayTunDeviceLease.Configuration) throws -> Session.Lease {
        leaseCalls += 1; leaseConfigurations.append(configuration)
        guard configuration.projectionSHA256 == plan.effectsSHA256,
              configuration.mtu == projection.mtu, configuration.addresses == projection.addresses,
              configuration.device == projection.device else { throw Injected.failed }
        held = true
        return .init(identity: identity, held: { self.held }, verify: { device in
            guard self.held && device == self.identity else { throw Injected.failed }
        }, duplicate: {
            self.duplicateCalls += 1
            guard let file = FileHandle(forReadingAtPath: "/dev/null") else { throw Injected.failed }; return file
        }, close: {
            self.closeCalls += 1
            if !self.held { return .unchanged }
            self.held = false
            if !self.foreignRoute { self.routeDump = Data() }
            return .applied
        }, absent: { !self.held && self.coreCopies == 0 && !self.deviceStillVisible })
    }
    func storage() -> RelayTunNetworkJournal.Storage {
        .init(read: { self.journalBytes }, compareExchange: { revision, replacement in
            guard revision == self.journalBytes.map(RelayTunHelperTrust.digest) else { return false }
            self.journalBytes = replacement; return true
        }, sync: { _ = try RelayTunNetworkJournal.Snapshot.decode(self.journalBytes ?? Data()) })
    }
    func routeAdapter(_ context: Session.RouteContext) throws -> RelayTunRouteAdapter {
        let driver = RelayTunRouteAdapter.Driver(authorized: { true }, read: { _ in self.routeDump },
            resolveInterface: { index in
                guard index == self.identity.interface.index else { throw Injected.failed }; return self.identity.interface
            }, add: { request, boundary in
                try boundary(); self.routeWrites += 1; self.routeDump = try self.routeFrame()
                var header = rt_msghdr(), result = request
                withUnsafeMutableBytes(of: &header) { $0.copyBytes(from: request.prefix($0.count)) }
                header.rtm_flags |= RTF_DONE
                withUnsafeBytes(of: header) { result.replaceSubrange(0..<$0.count, with: $0) }
                return result
            }, pid: 501, sequence: { 7 })
        return try RelayTunRouteAdapter(planID: context.plan.id, device: context.device, route: context.route,
            interfaceType: 249, driver: driver, verifyDevice: context.verifyDevice,
            deviceAbsent: context.deviceAbsent, record: context.record)
    }
    func resolverAdapter(_ context: Session.ResolverContext) throws -> RelayTunResolverAdapter {
        let driver = RelayTunResolverAdapter.Driver(authorized: { true }, inspect: { _ in self.resolverValue }, create: { _ in
            var held = true
            return .init(held: { held }, addTemporary: { value in
                guard self.resolverValue == nil else { return false }
                self.resolverWrites += 1; self.resolverValue = value; return true
            }, release: {
                held = false; self.resolverValue = nil
                return .init(released: true, uncertain: false)
            })
        })
        return try RelayTunResolverAdapter(planID: context.plan.id, device: context.device, resolver: context.resolver,
            driver: driver, verifyDevice: context.verifyDevice, record: context.record)
    }
    func backend() -> Executor.Backend {
        .init(rootGate: { self.rootAllowed }, inspect: { _ in self.baseline },
              lease: { try self.makeLease($0, configuration: $1) }, storage: { _ in self.storage() },
              route: { try self.routeAdapter($0) }, resolver: { try self.resolverAdapter($0) },
              coreRuntime: { _, _ in self.coreReady ? self.runtimeOverride ?? self.runtime : nil },
              coreReleased: { _, _ in self.coreCopies == 0 }, now: { self.clock })
    }
    func executor() -> Executor { Executor(backend: backend()) }
}

@main struct RelayTunExecutorTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ condition: @autoclosure () throws -> Bool, _ name: String) {
            do { rows.append(["name": name, "passed": try condition()]) }
            catch { rows.append(["name": name, "passed": false, "error": String(reflecting: error)]) }
        }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": false]) }
            catch { rows.append(["name": name, "passed": true]) }
        }
        do {
            let good = try Fixture(), executor = good.executor()
            let unavailable = try executor.perform(request: good.statusRequest(), peer: good.peer, trust: good.trust)
            check(unavailable.state == .idle && unavailable.sessionID == nil && unavailable.descriptor == nil,
                  "idle live executor reports no network session")
            let prepared = try executor.perform(request: good.prepareRequest(), peer: good.peer, trust: good.trust)
            let sessionID = prepared.sessionID!, evidence = prepared.evidenceSHA256!
            check(prepared.state == .prepared && UUID(uuidString: sessionID)?.uuidString.lowercased() == sessionID
                  && evidence.utf8.count == 64 && prepared.descriptor == nil,
                  "prepare returns one bound session identifier and preparation evidence")
            check(good.leaseCalls == 0 && good.journalBytes == nil && !good.held,
                  "prepare binds typed bytes without creating a device or durable record")
            rejects("a second prepare cannot replace the live executor session") {
                _ = try executor.perform(request: good.prepareRequest(), peer: good.peer, trust: good.trust)
            }
            rejects("acquire with foreign preparation evidence is refused") {
                _ = try executor.perform(request: good.acquireRequest(evidence: String(repeating: "0", count: 64)),
                                         peer: good.peer, trust: good.trust)
            }
            let acquired = try executor.perform(request: good.acquireRequest(evidence: evidence), peer: good.peer, trust: good.trust)
            let receipt = acquired.acquisition
            check(acquired.state == .acquired && acquired.descriptor != nil && receipt != nil,
                  "acquire delivers one descriptor duplicate with its typed receipt")
            check(receipt?.installationRevision == good.trust.revision && receipt?.clientUID == good.trust.clientUID
                  && receipt?.sessionID == sessionID && receipt?.evidenceSHA256 == evidence
                  && receipt?.runtimeConfigurationSHA256 == good.runtime
                  && receipt?.interfaceName == good.identity.interface.name
                  && receipt?.interfaceIndex == good.identity.interface.index
                  && receipt?.deviceID == good.identity.id && receipt?.controlUnit == good.identity.controlUnit,
                  "receipt binds installation, authorized UID, session, evidence and exact held-device identity")
            check(good.leaseConfigurations.count == 1 && good.leaseConfigurations[0].projectionSHA256 == good.projection.sha256
                  && good.duplicateCalls == 1 && good.held,
                  "the device lease receives only the approved projection digest and keeps its recovery handle")
            try acquired.descriptor?.close()

            rejects("activation with a foreign session identifier is refused") {
                _ = try executor.perform(request: good.activateRequest(session: UUID().uuidString.lowercased(), evidence: evidence),
                                         peer: good.peer, trust: good.trust)
            }
            rejects("activation with foreign evidence is refused") {
                _ = try executor.perform(request: good.activateRequest(session: sessionID, evidence: String(repeating: "0", count: 64)),
                                         peer: good.peer, trust: good.trust)
            }
            rejects("activation with a different generated runtime digest is refused") {
                _ = try executor.perform(request: good.activateRequest(session: sessionID, evidence: evidence, runtime: good.config),
                                         peer: good.peer, trust: good.trust)
            }
            good.coreReady = false
            rejects("activation needs positive ordinary-UID core readiness on the delivered descriptor") {
                _ = try executor.perform(request: good.activateRequest(session: sessionID, evidence: evidence), peer: good.peer, trust: good.trust)
            }
            good.coreReady = true
            let active = try executor.perform(request: good.activateRequest(session: sessionID, evidence: evidence),
                                              peer: good.peer, trust: good.trust)
            check(active.state == .active && active.descriptor == nil && good.routeWrites == 1 && good.resolverWrites == 1,
                  "activation realizes exactly the approved route and resolver through injected adapters")
            check(active.sessionID == sessionID && active.evidenceSHA256 == evidence && active.acquisition == nil,
                  "activation never issues a second descriptor or acquisition receipt")
            rejects("release with a foreign session identifier is refused") {
                _ = try executor.perform(request: good.releaseRequest(session: UUID().uuidString.lowercased()), peer: good.peer, trust: good.trust)
            }
            good.coreCopies = 1
            rejects("release waits for positive core exit and client descriptor closure") {
                _ = try executor.perform(request: good.releaseRequest(session: sessionID), peer: good.peer, trust: good.trust)
            }
            good.coreCopies = 0
            let released = try executor.perform(request: good.releaseRequest(session: sessionID), peer: good.peer, trust: good.trust)
            check(released.state == .released && !good.held && good.routeDump.isEmpty && good.resolverValue == nil,
                  "verified restoration retires the device, resolver and executor session")
            check(try executor.perform(request: good.statusRequest(), peer: good.peer, trust: good.trust).state == .idle,
                  "a released executor session cannot be queried or reused as live state")
            // The durable journal is bound to exactly one plan for its whole
            // lifetime. A new plan therefore needs a fresh helper generation;
            // reusing the retired plan's record must fail closed, and that
            // refusal must not resurrect the session or leave consent enabled.
            let leaseCallsBefore = good.leaseCalls
            rejects("a retired plan's durable journal cannot be rebound to a new plan") {
                _ = try executor.perform(request: good.prepareRequest(), peer: good.peer, trust: good.trust)
            }
            check(good.leaseCalls == leaseCallsBefore && !good.held
                  && (try? executor.perform(request: good.statusRequest(), peer: good.peer,
                                            trust: good.trust).state) == .idle,
                  "a refused re-preparation creates no device and revives no session or consent")

            let tampered = try Fixture(), tamperedExecutor = tampered.executor()
            var spaced = String(decoding: tampered.projection.encoded(), as: UTF8.self)
            spaced = spaced.replacingOccurrences(of: "\":", with: "\" :")
            check(spaced != String(decoding: tampered.projection.encoded(), as: UTF8.self), "fixture produces non-canonical projection bytes")
            rejects("a semantically equal but non-canonical projection is refused before consent") {
                _ = try tamperedExecutor.perform(request: tampered.prepareRequest(projection: Data(spaced.utf8)),
                                                 peer: tampered.peer, trust: tampered.trust)
            }
            check(tampered.leaseCalls == 0 && tampered.journalBytes == nil, "rejected projection bytes create no capability or journal")

            let hostile = try Fixture(), hostileExecutor = hostile.executor()
            rejects("a peer with another UID cannot use the executor") {
                _ = try hostileExecutor.perform(request: hostile.statusRequest(),
                                                peer: .init(uid: 502, installationRevision: hostile.trust.revision), trust: hostile.trust)
            }
            rejects("a peer from another installation revision cannot use the executor") {
                _ = try hostileExecutor.perform(request: hostile.statusRequest(),
                                                peer: .init(uid: 501, installationRevision: String(repeating: "0", count: 64)),
                                                trust: hostile.trust)
            }
            hostile.rootAllowed = false
            rejects("without real root privilege every operation is refused") {
                _ = try hostileExecutor.perform(request: hostile.prepareRequest(), peer: hostile.peer, trust: hostile.trust)
            }

            let conflict = try Fixture(), conflictExecutor = conflict.executor()
            let conflictPrepared = try conflictExecutor.perform(request: conflict.prepareRequest(), peer: conflict.peer, trust: conflict.trust)
            let conflictSession = conflictPrepared.sessionID!, conflictEvidence = conflictPrepared.evidenceSHA256!
            _ = try conflictExecutor.perform(request: conflict.acquireRequest(evidence: conflictEvidence), peer: conflict.peer, trust: conflict.trust)
            _ = try conflictExecutor.perform(request: conflict.activateRequest(session: conflictSession, evidence: conflictEvidence),
                                             peer: conflict.peer, trust: conflict.trust)
            conflict.foreignRoute = true; conflict.routeDump = try conflict.routeFrame(changed: true)
            let uncertain = try conflictExecutor.perform(request: conflict.releaseRequest(session: conflictSession),
                                                         peer: conflict.peer, trust: conflict.trust)
            check(uncertain.state == .uncertain && conflict.held && conflict.resolverValue != nil,
                  "foreign edits produce an uncertain release and preserve every owned obligation")
            check(try conflictExecutor.perform(request: conflict.statusRequest(), peer: conflict.peer,
                                               trust: conflict.trust).sessionID == conflictSession,
                  "an uncertain release retains its recovery session instead of retiring it")

            let expired = try Fixture(), expiredExecutor = expired.executor()
            let expiredPrepared = try expiredExecutor.perform(request: expired.prepareRequest(), peer: expired.peer, trust: expired.trust)
            _ = try expiredExecutor.perform(request: expired.acquireRequest(evidence: expiredPrepared.evidenceSHA256!),
                                            peer: expired.peer, trust: expired.trust)
            expired.clock = 100_000_000
            var expiredActivated = true
            do {
                let result = try expiredExecutor.perform(request: expired.activateRequest(session: expiredPrepared.sessionID!,
                    evidence: expiredPrepared.evidenceSHA256!), peer: expired.peer, trust: expired.trust)
                expiredActivated = result.state == .active
            } catch { expiredActivated = false }
            check(!expiredActivated && expired.routeWrites == 0 && expired.resolverWrites == 0,
                  "an expired preparation cannot activate or mutate any network object")
            check(try expiredExecutor.perform(request: expired.releaseRequest(session: expiredPrepared.sessionID!),
                                              peer: expired.peer, trust: expired.trust).state == .released,
                  "expiry revokes activation while preserving explicit recovery")

            let suspended = try Fixture(), suspendedExecutor = suspended.executor()
            let suspendedPrepared = try suspendedExecutor.perform(request: suspended.prepareRequest(), peer: suspended.peer, trust: suspended.trust)
            _ = try suspendedExecutor.perform(request: suspended.acquireRequest(evidence: suspendedPrepared.evidenceSHA256!),
                                              peer: suspended.peer, trust: suspended.trust)
            suspendedExecutor.suspend()
            rejects("suspension or consent withdrawal blocks activation") {
                _ = try suspendedExecutor.perform(request: suspended.activateRequest(session: suspendedPrepared.sessionID!,
                    evidence: suspendedPrepared.evidenceSHA256!), peer: suspended.peer, trust: suspended.trust)
            }
            check(try suspendedExecutor.perform(request: suspended.releaseRequest(session: suspendedPrepared.sessionID!),
                                                peer: suspended.peer, trust: suspended.trust).state == .released,
                  "suspension never removes stop and recovery authority")

            check(RelayTunWireRequest.maximumProjectionBytes == Projection.maximumBytes
                  && RelayTunWireRequest.maximumBytes > 2 * Projection.maximumBytes,
                  "wire and typed projection bounds stay consistent across their separate build targets")
            check(!Executor.productionRootGate(), "the real privilege gate refuses this ordinary-UID test process")
            let live = Executor.liveBackend(inspect: { _ in try Fixture().baseline },
                coreRuntime: { _, _ in nil }, coreReleased: { _, _ in false }, consent: { true })
            do {
                let fixture = try Fixture(), candidate = fixture.executor()
                var changed = try RelayTunStrictJSON.object(try JSONSerialization.data(withJSONObject: [
                    "version": 1, "operation": "prepare", "nonce": String(repeating: "2", count: 64),
                    "configurationSHA256": fixture.config, "runtimeConfigurationSHA256": fixture.runtime,
                    "bundleSHA256": fixture.bundle, "projection": fixture.hex(fixture.projection.encoded()),
                    "networkSHA256": fixture.baseline.networkSHA256, "protectionSHA256": fixture.baseline.protectionSHA256]))
                changed["networkSHA256"] = String(repeating: "0", count: 64)
                rejects("prepare cannot replace a user's confirmed baseline with fresh network state") {
                    _ = try candidate.perform(request: fixture.wire(changed), peer: fixture.peer, trust: fixture.trust)
                }
                check(!candidate.hasSession && fixture.leaseCalls == 0 && fixture.journalBytes == nil,
                      "baseline mismatch precedes device mutation and retains no fabricated session")
                let prepared = try candidate.perform(request: fixture.prepareRequest(), peer: fixture.peer, trust: fixture.trust)
                let canceled = try candidate.perform(request: fixture.releaseRequest(session: prepared.sessionID!), peer: fixture.peer, trust: fixture.trust)
                check(canceled.state == .released && !candidate.hasSession && fixture.leaseCalls == 0 && fixture.journalBytes == nil,
                      "prepared-only cancellation verifies untouched baseline and retires without acquire")
            }
            do {
                let fixture = try Fixture(); var attempts = 0
                var backend = fixture.backend()
                backend.retire = { _, _, _, _ in attempts += 1; if attempts == 1 { throw Injected.failed } }
                let candidate = Executor(backend: backend)
                let prepared = try candidate.perform(request: fixture.prepareRequest(), peer: fixture.peer, trust: fixture.trust)
                let acquired = try candidate.perform(request: fixture.acquireRequest(evidence: prepared.evidenceSHA256!), peer: fixture.peer, trust: fixture.trust)
                try acquired.descriptor?.close()
                let request = try fixture.releaseRequest(session: prepared.sessionID!)
                let first = try candidate.perform(request: request, peer: fixture.peer, trust: fixture.trust)
                let closes = fixture.closeCalls
                check(first.state == .uncertain && candidate.hasSession && !fixture.held,
                      "failed terminal archival preserves executor recovery after actual network retirement")
                let originalBaseline = fixture.baseline
                fixture.baseline = .init(networkSHA256: String(repeating: "0", count: 64), protectionSHA256: fixture.baseline.protectionSHA256)
                check(try candidate.perform(request: request, peer: fixture.peer, trust: fixture.trust).state == .uncertain && attempts == 1,
                      "archive retry cannot reuse an old restored observation after a fresh baseline change")
                fixture.baseline = originalBaseline
                let second = try candidate.perform(request: request, peer: fixture.peer, trust: fixture.trust)
                check(second.state == .released && !candidate.hasSession && attempts == 2 && fixture.closeCalls == closes,
                      "retry after terminal archival failure only retries archive, never network writes")
            }
            do {
                let fixture = try Fixture()
                var retirementReceipts: [RelayTunAcquiredReceipt] = []
                let service = RelayTunExecutorService(backend: { runtime, released, _ in
                    let base = fixture.backend()
                    var backend = Executor.Backend(rootGate: base.rootGate, inspect: base.inspect, lease: base.lease,
                        storage: base.storage, route: base.route, resolver: base.resolver,
                        coreRuntime: runtime, coreReleased: released, now: base.now)
                    backend.retire = { plan, session, evidence, receipt in
                        guard let receipt, receipt.planID == plan.id, receipt.sessionID == session,
                              receipt.evidenceSHA256 == evidence, receipt.deviceID == fixture.identity.id,
                              !fixture.held, fixture.resolverValue == nil, fixture.routeDump.isEmpty,
                              try RelayTunNetworkJournal.Snapshot.decode(fixture.journalBytes ?? Data()).phase == .restored
                        else { throw Injected.failed }
                        retirementReceipts.append(receipt)
                    }
                    return backend
                })
                var callbackReleased = false, observedReceipts: [RelayTunAcquiredReceipt] = []
                var positiveReleaseResponses = 0
                func observer() throws -> RelayTunCoreObserver {
                    try RelayTunCoreObserver(query: { data, reply in
                        do {
                            let (receipt, operation, nonce) = try RelayTunCoreObservation.decodeRequest(data as Data)
                            observedReceipts.append(receipt)
                            // Only the first positive terminal response is available.
                            // A redundant callback after DNS rollback must not strand
                            // this exact device or prevent durable retirement.
                            if operation == .released, callbackReleased {
                                positiveReleaseResponses += 1
                                guard positiveReleaseResponses == 1 else { reply(NSData()); return }
                            }
                            let result: RelayTunCoreObservation.Result = operation == .runtime ? .runtime(receipt.runtimeConfigurationSHA256) : .released(callbackReleased)
                            reply(try RelayTunCoreObservation.response(receipt: receipt, operation: operation, nonce: nonce, result: result, available: true) as NSData)
                        } catch { reply(NSData()) }
                    })
                }
                let channel = try observer(), connection = UUID().uuidString.lowercased(), foreign = UUID().uuidString.lowercased()
                func perform(_ request: RelayTunWireRequest, id: String = connection,
                             callback: RelayTunCoreObserver? = nil) throws -> RelayTunExecutorResult {
                    try service.perform(request: request, peer: fixture.peer, trust: fixture.trust,
                                        connectionID: id, observer: callback ?? channel)
                }
                let prepared = try perform(fixture.prepareRequest()), session = prepared.sessionID!, evidence = prepared.evidenceSHA256!
                rejects("second authenticated connection cannot replace an existing global owner") {
                    _ = try perform(fixture.prepareRequest(), id: foreign)
                }
                rejects("another connection cannot acquire its peer's prepared FD") {
                    _ = try perform(fixture.acquireRequest(evidence: evidence), id: foreign)
                }
                let acquired = try perform(fixture.acquireRequest(evidence: evidence)); try acquired.descriptor?.close()
                _ = try perform(fixture.activateRequest(session: session, evidence: evidence))
                check(observedReceipts == [acquired.acquisition!], "activation callback uses exact executor-issued acquired receipt")
                rejects("callback false never proves core and client descriptor released") {
                    _ = try perform(fixture.releaseRequest(session: session))
                }
                service.disconnect(connectionID: connection)
                rejects("disconnected owner cannot reactivate after authorization revocation") {
                    _ = try perform(fixture.activateRequest(session: session, evidence: evidence))
                }
                rejects("new connection cannot take over activation after disconnect") {
                    _ = try perform(fixture.activateRequest(session: session, evidence: evidence), id: foreign)
                }
                callbackReleased = true
                let replacement = try observer()
                let released = try perform(fixture.releaseRequest(session: session), id: foreign, callback: replacement)
                check(released.state == .released && !fixture.held && observedReceipts.allSatisfy { $0 == acquired.acquisition },
                      "same fixed UID can restore matching session using new authenticated fresh callback")
                check(positiveReleaseResponses == 1 && fixture.closeCalls == 1 && retirementReceipts == [acquired.acquisition!],
                      "one receipt-bound terminal callback completes device, DNS, route, durable journal and retirement hook")
                check(try perform(fixture.statusRequest(), id: foreign, callback: replacement).state == .idle,
                      "global owner retires only after verified restoration and terminal work")
                let closes = fixture.closeCalls, routes = fixture.routeWrites, dns = fixture.resolverWrites
                check(try perform(fixture.releaseRequest(session: session), id: UUID().uuidString.lowercased(), callback: replacement).state == .released,
                      "lost terminal response can be confirmed idempotently on a new authenticated connection")
                check(fixture.closeCalls == closes && fixture.routeWrites == routes && fixture.resolverWrites == dns,
                      "idempotent terminal confirmation never repeats network or FD operations")
                check(positiveReleaseResponses == 1 && retirementReceipts.count == 1,
                      "terminal confirmation repeats neither the release callback nor the completed archive hook")
                fixture.baseline = .init(networkSHA256: String(repeating: "0", count: 64), protectionSHA256: fixture.baseline.protectionSHA256)
                check(try perform(fixture.releaseRequest(session: session), id: foreign, callback: replacement).state == .uncertain,
                      "cached terminal proof cannot hide a fresh external baseline change")
            }
            do {
                let fixture = try Fixture(), candidate = fixture.executor()
                let prepared = try candidate.perform(request: fixture.prepareRequest(), peer: fixture.peer, trust: fixture.trust)
                let revoke = try fixture.wire(["version": 1, "operation": "revoke", "nonce": String(repeating: "7", count: 64), "sessionID": prepared.sessionID!])
                let revoked = try candidate.perform(request: revoke, peer: fixture.peer, trust: fixture.trust)
                check(revoked.state == .revoked && candidate.hasSession && fixture.leaseCalls == 0,
                      "wire revoke preserves exact recovery session without acquiring or closing anything")
                rejects("revoked preparation cannot create a new device") {
                    _ = try candidate.perform(request: fixture.acquireRequest(evidence: prepared.evidenceSHA256!), peer: fixture.peer, trust: fixture.trust)
                }
                check(try candidate.perform(request: fixture.releaseRequest(session: prepared.sessionID!), peer: fixture.peer, trust: fixture.trust).state == .released,
                      "rejected acquire before create boundary remains safely cancellable")
            }
            do {
                let fixture = try Fixture()
                let service = RelayTunExecutorService(backend: { runtime, released, _ in
                    let base = fixture.backend()
                    return .init(rootGate: base.rootGate, inspect: base.inspect, lease: base.lease,
                        storage: base.storage, route: base.route, resolver: base.resolver,
                        coreRuntime: runtime, coreReleased: released, now: base.now)
                })
                let entered = DispatchSemaphore(value: 0), unblock = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
                let callback = try RelayTunCoreObserver(timeoutMilliseconds: 3000, query: { data, reply in
                    do {
                        let (receipt, operation, nonce) = try RelayTunCoreObservation.decodeRequest(data as Data)
                        if operation == .runtime { entered.signal(); _ = unblock.wait(timeout: .now() + 2) }
                        reply(try RelayTunCoreObservation.response(receipt: receipt, operation: operation, nonce: nonce,
                            result: operation == .runtime ? .runtime(receipt.runtimeConfigurationSHA256) : .released(true), available: true) as NSData)
                    } catch { reply(NSData()) }
                })
                let id = UUID().uuidString.lowercased()
                func call(_ request: RelayTunWireRequest) throws -> RelayTunExecutorResult {
                    try service.perform(request: request, peer: fixture.peer, trust: fixture.trust,
                        connectionID: id, observer: callback)
                }
                let prepared = try call(fixture.prepareRequest())
                let acquired = try call(fixture.acquireRequest(evidence: prepared.evidenceSHA256!)); try acquired.descriptor?.close()
                DispatchQueue.global().async {
                    do { _ = try service.perform(request: fixture.activateRequest(session: prepared.sessionID!, evidence: prepared.evidenceSHA256!),
                        peer: fixture.peer, trust: fixture.trust, connectionID: id, observer: callback) } catch { }
                    finished.signal()
                }
                check(entered.wait(timeout: .now() + 2) == .success, "activation entered bounded reverse observation")
                let request = try fixture.wire(["version": 1, "operation": "revoke", "nonce": String(repeating: "7", count: 64), "sessionID": prepared.sessionID!])
                service.revokeAuthorization(connectionID: id)
                unblock.signal()
                check(finished.wait(timeout: .now() + 2) == .success && fixture.routeWrites == 0 && fixture.resolverWrites == 0,
                      "authenticated connection latch revokes in-flight activation before formal trust/resource I/O")
                check(try call(request).state == .revoked, "formal independent revoke verifies and acknowledges the already withdrawn session")
                check(try call(fixture.releaseRequest(session: prepared.sessionID!)).state == .released,
                      "revocation preserves positive recovery on the same authenticated connection")
            }
            do {
                let fixture = try Fixture(); var callbacks = 0
                let service = RelayTunExecutorService(backend: { runtime, released, _ in
                    let base = fixture.backend()
                    return .init(rootGate: base.rootGate, inspect: base.inspect, lease: { plan, _ in
                        fixture.held = true
                        throw FailedAcquire(plan: plan, close: { fixture.held = false }, absent: { !fixture.held })
                    }, storage: base.storage, route: base.route, resolver: base.resolver,
                        coreRuntime: runtime, coreReleased: released, now: base.now)
                })
                let callback = try RelayTunCoreObserver(query: { _, reply in callbacks += 1; reply(NSData()) })
                let connection = UUID().uuidString.lowercased()
                let prepared = try service.perform(request: fixture.prepareRequest(), peer: fixture.peer, trust: fixture.trust,
                    connectionID: connection, observer: callback)
                rejects("production coordinator retains a partial failed acquire instead of delivering an invalid FD") {
                    _ = try service.perform(request: fixture.acquireRequest(evidence: prepared.evidenceSHA256!), peer: fixture.peer,
                        trust: fixture.trust, connectionID: connection, observer: callback)
                }
                service.disconnect(connectionID: connection)
                let restored = try service.perform(request: fixture.releaseRequest(session: prepared.sessionID!), peer: fixture.peer,
                    trust: fixture.trust, connectionID: UUID().uuidString.lowercased(), observer: callback)
                check(restored.state == .released && callbacks == 0 && !fixture.held && fixture.routeWrites == 0 && fixture.resolverWrites == 0,
                      "reconnected explicit release recovers the exact unreturned acquisition without any fake ordinary-host proof")
                check(try RelayTunNetworkJournal.Snapshot.decode(fixture.journalBytes!).phase == .acquisitionAborted,
                      "coordinator recovery reaches the real strict aborted-acquisition terminal journal")
            }
            let liveFixture = try Fixture()
            let livePlan = Transaction.Plan(id: UUID().uuidString.lowercased(), configurationSHA256: liveFixture.config,
                runtimeConfigurationSHA256: liveFixture.runtime, effectsSHA256: liveFixture.projection.sha256,
                baseline: liveFixture.baseline, createdAt: 1, expiresAt: 2, routeRemovalPolicy: .ownedDeviceRetirement)
            let configuration = try RelayTunDeviceLease.Configuration(device: "utun", mtu: 1500, addresses: [],
                                                                     projectionSHA256: liveFixture.projection.sha256)
            rejects("live device wiring refuses an ordinary UID before any filesystem or socket step") {
                _ = try live.lease(livePlan, configuration)
            }
            rejects("live durable storage refuses an ordinary UID before any path inspection") {
                _ = try live.storage(livePlan)
            }
            rejects("the live interface observer refuses a missing interface instead of guessing a type") {
                _ = try Executor.liveInterfaceType(liveFixture.identity.interface)
            }
            let noConsent = Executor.liveBackend(inspect: { _ in throw Injected.failed },
                coreRuntime: { _, _ in nil }, coreReleased: { _, _ in false }, consent: { false })
            rejects("withdrawn consent refuses live acquisition before any privileged resource") {
                _ = try noConsent.lease(livePlan, configuration)
            }
        } catch { rows.append(["name": "fixture setup", "passed": false, "error": String(describing: error)]) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "actualDeviceCreated": false, "actualRouteWritten": false, "actualResolverWritten": false,
            "actualRootFileWrites": false, "actualMachConnection": false, "actualTunAccepted": false]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
        exit(rows.count == passed ? 0 : 1)
    }
}
