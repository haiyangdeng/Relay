import Foundation
import CryptoKit
import Darwin

private typealias Host = RelayTunCoreHost
private enum Injected: Error { case failure }

/// No real descriptor, process, socket, signal, root path or network operation.
private final class Fixture {
    let configuration = Data("{\"private-fixture\":true,\"tun\":{\"file-descriptor\":3}}".utf8)
    let receipt: RelayTunAcquiredReceipt
    let binding: Host.Binding
    var uid: UInt32? = 501
    var verifyCount = 0, admitCount = 0, launchCount = 0, closeCount = 0
    var resourceFails = false, admissionFails = false, descriptorFails = false, launchFails = false
    var ready = true, readyFails = false, waitFails = false, closeFails = false, closureFails = false
    var autoClose = true, closed = false, clock: UInt64 = 100
    var postSpawnFails = false, skipRegistration = false, spawnAbsent = true, stopReportsWithoutExit = false
    var childState: RelayTunCoreProbePlan.ChildState = .running
    var signals: [Int32] = []
    var stopOnTerm = true, stopOnKill = true
    var receiptOverride: RelayTunAcquiredReceipt?
    var observationOverride: Host.RuntimeObservation?
    var onResource: (() -> Void)?, onReady: (() -> Void)?, onVerify: (() -> Void)?
    init() throws {
        receipt = try .init(installationRevision: String(repeating: "a", count: 64), clientUID: 501,
            evidenceSHA256: String(repeating: "b", count: 64),
            runtimeConfigurationSHA256: SHA256.hash(data: configuration).map { String(format: "%02x", $0) }.joined(),
            planID: "11111111-1111-4111-8111-111111111111", sessionID: "22222222-2222-4222-8222-222222222222",
            deviceID: "33333333-3333-4333-8333-333333333333", interfaceName: "utun42", interfaceIndex: 91,
            controlID: 17, controlUnit: 43, socketDevice: "7", socketInode: "18446744073709551615")
        binding = try .init(receipt: receipt, coreSHA256: RelayTunInstallationPaths.fixedCorePins["arm64"]!.0)
    }
    func changedReceipt(_ field: String) throws -> RelayTunAcquiredReceipt {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt)) as! [String: Any]
        switch field {
        case "clientUID": object[field] = 502
        case "interfaceIndex", "controlID": object[field] = 92
        case "interfaceName": object[field] = "utun43"; object["controlUnit"] = 44
        case "socketDevice": object[field] = "8"
        case "socketInode": object[field] = "0"
        case "installationRevision", "evidenceSHA256", "runtimeConfigurationSHA256": object[field] = String(repeating: "c", count: 64)
        default: object[field] = "44444444-4444-4444-8444-444444444444"
        }
        return try JSONDecoder().decode(RelayTunAcquiredReceipt.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func host(configuration override: Data? = nil) throws -> Host {
        try Host(binding: binding, configuration: override ?? configuration, driver: .init(ordinaryUID: { self.uid },
            verifyResource: { _ in self.verifyCount += 1; self.onResource?(); if self.resourceFails { throw Injected.failure } },
            admit: { _ in
                self.admitCount += 1
                if self.admissionFails { throw Injected.failure }
                return .init(verify: {
                    self.onVerify?()
                    if self.descriptorFails { throw Injected.failure }
                    return self.receiptOverride ?? self.receipt
                }, launch: { binding, bytes, register in
                    guard binding == self.binding, bytes == self.configuration else { throw Injected.failure }
                    self.launchCount += 1
                    if self.launchFails { throw Injected.failure }
                    let child = Host.Child(poll: {
                        if self.waitFails { throw Injected.failure }
                        return self.childState
                    }, stop: {
                        if self.stopReportsWithoutExit { return .init(waitStatus: 0, forced: false) }
                        return try RelayTunCoreProbePlan.stopOwnedChild(.init(wait: {
                            if self.waitFails { throw Injected.failure }
                            return self.childState
                        }, signal: { signal in
                            self.signals.append(signal)
                            if signal == SIGTERM && self.stopOnTerm { self.childState = .exited(0) }
                            if signal == SIGKILL && self.stopOnKill { self.childState = .exited(9) }
                        }, now: { self.clock }, pause: { self.clock += 100 }))
                    }, readiness: {
                        self.onReady?()
                        if self.readyFails { throw Injected.failure }
                        guard self.ready else { return nil }
                        return self.observationOverride ?? .init(binding: self.binding,
                            runtimeConfigurationSHA256: self.receipt.runtimeConfigurationSHA256,
                            coreVersion: RelayTunCoreProbePlan.version, inheritedDescriptor: 3)
                    })
                    if !self.skipRegistration { register(child) }
                    if self.postSpawnFails { throw Injected.failure }
                }, spawnAbsent: { self.spawnAbsent }, close: {
                    self.closeCount += 1
                    if self.autoClose { self.closed = true }
                    if self.closeFails { throw Injected.failure }
                }, closed: {
                    if self.closureFails { throw Injected.failure }
                    return self.closed
                })
            }))
    }
}

@main struct RelayTunCoreHostTests {
    static func main() {
        #if RELAY_TUN_OWNED_CHILD_TESTS
        if Array(CommandLine.arguments.dropFirst()) == ["--inert-owned-child", "wait"] {
            while true { pause() }
        }
        #endif
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ value: Bool, _ name: String) { rows.append(["name": name, "passed": value]) }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); check(false, name) } catch { check(true, name) }
        }
        do {
            let initialRecovery = Host.recoveryCount
            let f = try Fixture(), host = try f.host()
            check(host.status.phase == .idle && !host.status.ready && !host.status.released, "new host makes no readiness or release claim")
            check(Host.productionOrdinaryUID() == getuid(), "production identity source uses real ordinary UID and matching effective credentials")
            rejects("changed configuration bytes cannot reuse receipt digest") { _ = try f.host(configuration: Data("changed".utf8)) }
            rejects("empty configuration cannot start") { _ = try f.host(configuration: Data()) }
            rejects("unfixed core digest is refused before resource admission") { _ = try Host.Binding(receipt: f.receipt, coreSHA256: String(repeating: "0", count: 64)) }
            check(try host.start().ready, "successful capability observations establish readiness")
            check(f.verifyCount == 1 && f.admitCount == 1 && f.launchCount == 1, "resource and FD admission precede exactly one launch")
            check(try host.runtime() == f.receipt.runtimeConfigurationSHA256, "runtime proof is freshly observed from retained child and FD")
            check(!host.released(for: f.binding) && Host.recover(host.recoveryToken) === host, "live host retains exact recovery capability")
            rejects("second start cannot spawn another child") { _ = try host.start() }
            check(f.launchCount == 1, "duplicate start did not launch")
            check(try host.release().released, "release positively observes reaped child and closed client copies")
            check(host.status.cleanExit && !host.status.forcedExit && f.signals == [SIGTERM] && f.closeCount == 1,
                "graceful owned shutdown is distinct from forced exit")
            check(host.released(for: f.binding) && Host.recover(host.recoveryToken) == nil, "terminal host retires recovery only after both proofs")
            _ = try host.release()
            check(f.closeCount == 1 && f.signals == [SIGTERM], "duplicate release never signals or closes again")
            rejects("released lifetime cannot restart") { _ = try host.start() }
            let wrong = try Host.Binding(receipt: f.changedReceipt("sessionID"), coreSHA256: f.binding.coreSHA256)
            check(!host.released(for: wrong), "release proof cannot transfer to another session")

            for field in ["installationRevision", "clientUID", "planID", "sessionID", "deviceID", "evidenceSHA256", "runtimeConfigurationSHA256",
                          "interfaceName", "interfaceIndex", "controlID", "socketDevice", "socketInode"] {
                let fixture = try Fixture(), candidate = try fixture.host()
                fixture.receiptOverride = try fixture.changedReceipt(field)
                rejects("FD observation binds complete receipt field: " + field) { _ = try candidate.start() }
                check(fixture.launchCount == 0 && candidate.status.retainsDescriptor, "mismatch retains admitted FD without launching: " + field)
                _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); fixture.uid = 0
                rejects("root cannot enter ordinary UID host") { _ = try candidate.start() }
                check(fixture.verifyCount == 0 && fixture.admitCount == 0, "privilege rejection precedes all capabilities")
                fixture.uid = 502
                rejects("another ordinary UID cannot use receipt") { _ = try candidate.start() }
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); fixture.resourceFails = true
                rejects("resource verification failure fails closed") { _ = try candidate.start() }
                check(candidate.startFailureStage == "resource", "resource failure retains a fixed diagnostic stage")
                check(fixture.admitCount == 0 && fixture.launchCount == 0, "unverified core receives no FD or launch")
                _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); fixture.admissionFails = true
                rejects("admission failure does not launch") { _ = try candidate.start() }
                check(candidate.startFailureStage == "admission", "admission failure is distinguished from spawn and readiness")
                check(!candidate.status.retainsDescriptor && fixture.launchCount == 0, "failed admission has no acquired capability")
                _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); fixture.launchFails = true
                rejects("failed spawn retains acquired parent FD") { _ = try candidate.start() }
                check(candidate.startFailureStage == "spawn", "spawn failure retains its stage without disclosing raw errors")
                check(candidate.status.retainsDescriptor && !candidate.status.ownsChild && !candidate.status.released, "spawn failure is not release proof")
                _ = try candidate.release()
                check(fixture.signals.isEmpty && fixture.closeCount == 1, "failed spawn closes only its held parent capability")
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); fixture.postSpawnFails = true
                rejects("post-spawn identity failure retains registered child") { _ = try candidate.start() }
                check(candidate.status.ownsChild && candidate.status.retainsDescriptor && Host.recover(candidate.recoveryToken) === candidate,
                    "spawn registration precedes throwing post-spawn verification")
                _ = try candidate.release()
                check(fixture.signals == [SIGTERM] && fixture.closeCount == 1, "failed post-spawn check can recover exact held child")
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); fixture.skipRegistration = true; fixture.spawnAbsent = false
                rejects("launch without positive child capability cannot publish ready") { _ = try candidate.start() }
                check(!candidate.status.ready && candidate.status.retainsDescriptor, "missing launch registration remains uncertain")
                rejects("missing registration is not positive no-child evidence") { _ = try candidate.release() }
                check(fixture.closeCount == 0 && !candidate.status.released && !candidate.status.childExited, "unknown child existence retains parent FD without an exited-child claim")
                fixture.spawnAbsent = true; _ = try candidate.release()
                check(candidate.status.released, "positive spawn-absence observation permits no-child recovery")
            }
            for mode in ["notReady", "wrongRuntime", "wrongBinding", "wrongVersion", "wrongFD"] {
                let fixture = try Fixture(), candidate = try fixture.host()
                if mode == "notReady" { fixture.ready = false }
                else {
                    let bound = mode == "wrongBinding" ? try Host.Binding(receipt: fixture.changedReceipt("deviceID"), coreSHA256: fixture.binding.coreSHA256) : fixture.binding
                    fixture.observationOverride = .init(binding: bound,
                        runtimeConfigurationSHA256: mode == "wrongRuntime" ? String(repeating: "0", count: 64) : fixture.receipt.runtimeConfigurationSHA256,
                        coreVersion: mode == "wrongVersion" ? "v1.19.32" : RelayTunCoreProbePlan.version,
                        inheritedDescriptor: mode == "wrongFD" ? 4 : 3)
                }
                rejects("readiness source is bound: " + mode) { _ = try candidate.start() }
                check(!candidate.status.ready && candidate.status.ownsChild && candidate.status.retainsDescriptor, "failed readiness preserves recovery: " + mode)
                _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start()
                fixture.childState = .exited(7)
                check(try candidate.runtime() == nil && !candidate.status.ready, "child exit invalidates cached readiness")
                _ = try candidate.release()
                check(fixture.signals.isEmpty && !candidate.status.cleanExit, "already reaped abnormal child is never signaled")
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start()
                fixture.descriptorFails = true
                rejects("lost FD observation cannot remain ready") { _ = try candidate.runtime() }
                check(!candidate.status.ready && candidate.status.ownsChild, "lost FD proof retains owned child")
                _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start()
                fixture.waitFails = true
                rejects("unknown child state cannot authorize signal or FD closure") { _ = try candidate.release() }
                check(fixture.signals.isEmpty && fixture.closeCount == 0 && Host.recover(candidate.recoveryToken) === candidate,
                    "failed wait retains both capabilities")
                fixture.waitFails = false; _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start(); fixture.stopReportsWithoutExit = true
                rejects("stop result without positive exited-child observation cannot release") { _ = try candidate.release() }
                check(candidate.status.ownsChild && fixture.closeCount == 0, "unverified stop result preserves child and parent FD")
                fixture.stopReportsWithoutExit = false; _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start(); fixture.uid = 502
                rejects("runtime fails closed when ordinary identity changes") { _ = try candidate.runtime() }
                check(!candidate.status.ready && candidate.status.phase == .revoked, "identity mismatch immediately revokes published readiness")
                fixture.uid = 501; _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start()
                fixture.autoClose = false
                rejects("close return alone is insufficient release evidence") { _ = try candidate.release() }
                check(!candidate.status.released && candidate.status.retainsDescriptor && fixture.closeCount == 1, "missing closure proof retains recovery")
                rejects("ambiguous close does not retry a possibly reused FD number") { _ = try candidate.release() }
                check(fixture.closeCount == 1, "ambiguous descriptor close was attempted once")
                fixture.closed = true; check(try candidate.release().released, "later positive closure observation can finish recovery")
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start(); fixture.closeFails = true
                rejects("throwing close cannot claim release") { _ = try candidate.release() }
                check(fixture.closed && !candidate.status.released, "close uncertainty remains explicit even when driver later reports closure")
                _ = try candidate.release()
                check(fixture.closeCount == 1 && candidate.status.released, "recovery observes closure without retrying close")
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start(); fixture.stopOnTerm = false
                let released = try candidate.release()
                check(released.released && released.forcedExit && !released.cleanExit && fixture.signals == [SIGTERM, SIGKILL],
                    "forced owned-child cleanup is reported and never called graceful")
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); _ = try candidate.start()
                candidate.suspend()
                check(!candidate.status.ready && candidate.status.phase == .revoked && fixture.signals.isEmpty && fixture.closeCount == 0,
                    "sleep revokes readiness without stopping or closing capabilities")
                check(try candidate.runtime() == nil, "sleep cannot revive runtime proof")
                _ = try candidate.release()
                check(candidate.status.released, "revoked activation retains release capability")
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host()
                fixture.onReady = { candidate.suspend() }
                rejects("suspension during readiness cannot publish ready") { _ = try candidate.start() }
                check(candidate.status.phase == .revoked && candidate.status.retainsDescriptor, "in-flight suspension preserves acquired ownership")
                fixture.onReady = nil; _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host(); var refused = false
                fixture.onReady = { do { _ = try candidate.release() } catch { refused = true } }
                _ = try candidate.start()
                check(refused && fixture.signals.isEmpty && fixture.closeCount == 0, "same-thread reentrancy is busy without mutating ownership")
                fixture.onReady = nil; _ = try candidate.release()
            }
            do {
                let fixture = try Fixture(), candidate = try fixture.host()
                let entered = DispatchSemaphore(value: 0), unblock = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
                fixture.onResource = { entered.signal(); _ = unblock.wait(timeout: .now() + 3) }
                DispatchQueue.global().async { do { _ = try candidate.start() } catch { }; finished.signal() }
                check(entered.wait(timeout: .now() + 3) == .success, "blocked capability callback was entered")
                rejects("another thread cannot overlap a held operation") { _ = try candidate.release() }
                candidate.suspend()
                check(candidate.status.phase == .revoked, "sleep revocation and status do not block behind resource I/O")
                unblock.signal(); check(finished.wait(timeout: .now() + 3) == .success, "blocked start observes revoked authorization on return")
                check(fixture.admitCount == 0, "revocation prevents the next FD capability acquisition")
                _ = try candidate.release()
            }
            #if RELAY_TUN_OWNED_CHILD_TESTS
            do {
                let fixture = try Fixture()
                var template = Array("/private/tmp/relay-host-inert-XXXXXX".utf8CString)
                guard mkdtemp(&template) != nil else { throw Injected.failure }
                let directory = String(cString: template)
                defer { _ = rmdir(directory) }
                var closed = false
                let candidate = try Host(binding: fixture.binding, configuration: fixture.configuration,
                    driver: .init(ordinaryUID: Host.productionOrdinaryUID, verifyResource: { _ in }, admit: { _ in
                        .init(verify: { fixture.receipt }, launch: { _, _, register in
                            _ = try RelayTunOwnedChild.inert(directory: directory, mode: "wait", register: { child in
                                register(.owned(child, readiness: {
                                    .init(binding: fixture.binding, runtimeConfigurationSHA256: fixture.receipt.runtimeConfigurationSHA256,
                                          coreVersion: RelayTunCoreProbePlan.version, inheritedDescriptor: 3)
                                }))
                            })
                        }, spawnAbsent: { false }, close: { closed = true }, closed: { closed })
                    }))
                _ = try candidate.start()
                check(try candidate.runtime() == fixture.receipt.runtimeConfigurationSHA256,
                    "real inert owned-child capability composes with host polling and readiness")
                candidate.suspend()
                check(!candidate.status.ready && !closed, "composed child's FD capability survives revocation")
                let released = try candidate.release()
                check(released.released && closed && !released.forcedExit,
                    "real owned-child stop and reap precede composed host's client-FD closure")
                _ = try candidate.release()
                check(Host.recover(candidate.recoveryToken) == nil,
                    "composed real child retires exact recovery capability after release")
            }
            #endif
            check(Host.recoveryCount == initialRecovery, "all isolated recovery owners retire only after explicit completed release")
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failures = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failures == 0, "checksPassed": rows.count - failures, "checksTotal": rows.count,
            "productionProcessAdapterAvailable": false, "helperMainConnected": false,
            "actualCoreLaunched": false, "actualTunCreated": false,
            "actualInertOwnedChildLaunched": true, "actualSignalsLimitedToOwnedInertChild": true,
            "systemConfigurationChanged": false, "checks": rows]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failures > 0 { exit(1) }
    }
}
