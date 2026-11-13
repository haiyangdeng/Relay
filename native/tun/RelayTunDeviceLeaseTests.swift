import Foundation
import Darwin

private typealias Factory = RelayTunDeviceLease
private typealias Adapter = RelayTunDeviceAdapter
private typealias Effects = RelayTunNetworkEffects
private typealias Transaction = RelayTunNetworkTransaction
private enum Injected: Error { case failed }

private final class Fixture {
    var held = false, present = false, authorized = true, proof = true, allowed = true
    var snapshot = Adapter.Snapshot(name: "utun42", index: 91, controlID: 17, controlUnit: 43, mtu: 1500,
        addressKeys: ["6:fe800000000000000000000000000001:ffffffffffffffff0000000000000000"])
    var creates = 0, mtuWrites = 0, addressWrites = 0, closes = 0, observations = 0
    var failSnapshot = false, failMTUAfterWrite = false, uncertainClose = false, retainPresent = false, failSocket = false
    var socket = Factory.SocketIdentity(device: UInt64.max, inode: 0)
    var duplicates: [Int32] = [], records: [Factory.Record] = [], payloads: [Data] = [], order: [String] = []
    var hook: ((Factory.Record) throws -> Void)?
    let digest = String(repeating: "a", count: 64)
    func plan() -> Transaction.Plan {
        .init(id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", configurationSHA256: String(repeating: "b", count: 64),
            runtimeConfigurationSHA256: String(repeating: "c", count: 64), effectsSHA256: digest,
            baseline: .init(networkSHA256: String(repeating: "d", count: 64), protectionSHA256: String(repeating: "e", count: 64)),
            createdAt: 1000, expiresAt: 61000, routeRemovalPolicy: .ownedDeviceRetirement)
    }
    func configuration(mtu: UInt32 = 9000) throws -> Factory.Configuration {
        try .init(device: "utun", mtu: mtu, addresses: [.init(address: .init(family: .ipv4, value: "198.18.0.1"), length: 30)], projectionSHA256: digest)
    }
    func operation(_ event: Adapter.Event) -> String {
        switch event.operation { case .create: return "create"; case .mtu: return "mtu"; case .address: return "address"; case .duplicate: return "duplicate"; case .close: return "close"; case .verifyAbsent: return "verifyAbsent" }
    }
    func factory() -> Factory {
        Factory(driver: .init(authorized: { self.allowed }, create: { _ in
            self.creates += 1; self.order.append("create"); self.held = true; self.present = true
            return .init(hasHandle: { self.held }, snapshot: {
                if self.failSnapshot { throw Injected.failed }; return self.snapshot
            }, setMTU: { mtu in
                self.mtuWrites += 1; self.order.append("mtu"); self.snapshot = self.snapshot.replacing(mtu: mtu)
                if self.failMTUAfterWrite { throw Injected.failed }
            }, addAddress: { address in
                self.addressWrites += 1; self.order.append("address"); self.snapshot = self.snapshot.replacing(address: address)
            }, duplicate: {
                var descriptors: [Int32] = [-1, -1]
                guard pipe(&descriptors) == 0 else { throw Injected.failed }
                Darwin.close(descriptors[1]); _ = fcntl(descriptors[0], F_SETFD, FD_CLOEXEC)
                self.duplicates.append(descriptors[0]); self.order.append("duplicate")
                return FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true)
            }, close: {
                self.closes += 1; self.held = false; self.order.append("close")
                if !self.retainPresent { self.present = false }
                return .init(released: true, uncertain: self.uncertainClose)
            })
        }, absent: { _ in
            !self.present && !self.duplicates.contains { fcntl($0, F_GETFD) >= 0 }
        }), observeSocket: { file in
            self.observations += 1
            guard !self.failSocket, fcntl(file.fileDescriptor, F_GETFD) >= 0 else { throw Injected.failed }; return self.socket
        }, authorize: { _, _ in guard self.authorized else { throw Injected.failed } }, verifyConfiguration: { plan, value in
            guard self.proof, value.projectionSHA256 == plan.effectsSHA256 else { throw Injected.failed }
        }, record: { record in
            try self.hook?(record)
            self.records.append(record); self.payloads.append(try record.encoded())
            self.order.append("record:" + record.event.phase.rawValue + ":" + self.operation(record.event))
        })
    }
}

@main struct RelayTunDeviceLeaseTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ condition: @autoclosure () throws -> Bool, _ name: String) {
            do { rows.append(["name": name, "passed": try condition()]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": false]) }
            catch { rows.append(["name": name, "passed": true]) }
        }
        do {
            let good = Fixture(), factory = good.factory()
            check(good.creates == 0 && good.records.isEmpty, "factory construction opens no device and emits no fake recovery event")
            let lease = try factory.acquire(good.plan(), configuration: good.configuration())
            check(lease.held() && good.creates == 1 && good.mtuWrites == 1 && good.addressWrites == 1,
                  "one capability configures the approved MTU and requested address through the existing adapter")
            check(lease.identity.socketDevice == UInt64.max && lease.identity.socketInode == 0,
                  "private bound duplicate supplies complete non-lossy socket metadata")
            check(lease.identity.addresses.count == 2 && lease.identity.addresses.contains { $0.address.value == "fe80::1" && $0.length == 64 } &&
                  lease.identity.addresses.contains { $0.address.value == "198.18.0.1" && $0.length == 30 },
                  "full device identity preserves automatic kernel addresses alongside approved host prefixes")
            for operation in ["create", "mtu", "address", "duplicate"] {
                let index = good.order.firstIndex(of: operation)!
                check(index > 0 && good.order[index - 1] == "record:intent:" + operation,
                      "complete synchronized \(operation) intent precedes its device driver call")
            }
            check(good.records.map(\.sequence) == Array(0..<UInt32(good.records.count)), "bound device event records have a continuous zero-based sequence")
            let first = try JSONSerialization.jsonObject(with: good.payloads[0]) as! [String: Any]
            check(Set(first.keys) == Set(["version", "role", "planID", "configurationSHA256", "runtimeConfigurationSHA256", "effectsSHA256", "createdAt", "expiresAt", "sequence", "event"]) &&
                  first["role"] as? String == "tun-device-event" && first["planID"] as? String == good.plan().id,
                  "serialized event payload has the exact store binding schema")
            let mtuIntent = good.records.first { if case .mtu = $0.event.operation { return $0.event.phase == .intent }; return false }!
            let payload = try JSONSerialization.jsonObject(with: mtuIntent.encoded()) as! [String: Any]
            let event = payload["event"] as! [String: Any], before = event["before"] as! [String: Any], desired = event["desired"] as! [String: Any]
            check(before["addressKeys"] as? [String] == desired["addressKeys"] as? [String] && before["mtu"] as? Int == 1500 && desired["mtu"] as? Int == 9000,
                  "MTU intent stores complete before/desired inventory rather than a digest-only claim")
            try lease.verify(lease.identity)
            let copy = try lease.duplicate()
            check(good.duplicates.count == 2 && lease.held(), "client delivery adds a separate FD without surrendering private or primary recovery ownership")
            check(try lease.close() == .applied && !good.held && !lease.held(), "explicit close releases private duplicate before the original adapter handle")
            check(try !lease.absent(), "an outstanding client duplicate prevents positive device absence")
            try copy.close()
            check(try lease.absent() && Adapter.recover(factory.recoveryToken) == nil,
                  "independent absence after every FD copy closes releases the original device recovery owner")

            let denied = Fixture(); denied.allowed = false; let deniedFactory = denied.factory()
            rejects("ordinary/unapproved device driver refuses before device creation") { _ = try deniedFactory.acquire(denied.plan(), configuration: denied.configuration()) }
            check(denied.creates == 0 && denied.records.isEmpty, "driver permission refusal emits no create intent or syscall")
            let proof = Fixture(); proof.proof = false; let proofFactory = proof.factory()
            rejects("independent projected field/hash substitution is rejected before create") { _ = try proofFactory.acquire(proof.plan(), configuration: proof.configuration()) }
            check(proof.creates == 0 && proof.records.isEmpty, "mandatory projection proof failure is inert")
            let recordFailure = Fixture(); recordFailure.hook = { record in
                if record.event.phase == .intent, case .create = record.event.operation { throw Injected.failed }
            }; let recordFactory = recordFailure.factory()
            rejects("failed durable create intent prevents device creation") { _ = try recordFactory.acquire(recordFailure.plan(), configuration: recordFailure.configuration()) }
            check(recordFailure.creates == 0, "missing creation durability cannot be treated as acquisition")

            let configure = Fixture(); configure.hook = { record in
                if record.event.phase == .intent, case .address = record.event.operation { throw Injected.failed }
            }; let configureFactory = configure.factory()
            rejects("address persistence failure aborts the bridge while retaining the created owner") { _ = try configureFactory.acquire(configure.plan(), configuration: configure.configuration()) }
            check(configure.held && configure.mtuWrites == 1 && configure.addressWrites == 0 && Adapter.recover(configureFactory.recoveryToken) != nil,
                  "failed address intent preserves original capability and every earlier successful mutation")
            let recoveredConfigure = Adapter.recover(configureFactory.recoveryToken)!, configureID = recoveredConfigure.unresolved[0].id
            configure.hook = nil
            check(try recoveredConfigure.close(configureID).phase == .closed && recoveredConfigure.verifyAbsent(configureID).phase == .absent,
                  "explicit failure recovery uses the original owner object instead of an adopted name or PID")

            let afterWrite = Fixture(); afterWrite.failMTUAfterWrite = true; let afterFactory = afterWrite.factory()
            rejects("lost MTU acknowledgement does not return a ready lease") { _ = try afterFactory.acquire(afterWrite.plan(), configuration: afterWrite.configuration()) }
            check(afterWrite.held && afterWrite.snapshot.mtu == 9000 && afterFactory.unresolved.first?.phase == .uncertain,
                  "possibly applied MTU retains its concrete recovery owner")
            let original = Adapter.recover(afterFactory.recoveryToken)!, originalID = original.unresolved[0].id
            check(try original.close(originalID).phase == .closed && original.verifyAbsent(originalID).phase == .absent,
                  "known before/desired inventory permits explicit owned-handle retirement after uncertain write")

            let revoked = Fixture(); revoked.hook = { record in
                if record.event.phase == .intent, case .mtu = record.event.operation { revoked.authorized = false }
            }; let revokedFactory = revoked.factory()
            rejects("authorization revoked during persistence blocks the following MTU syscall") { _ = try revokedFactory.acquire(revoked.plan(), configuration: revoked.configuration()) }
            check(revoked.held && revoked.mtuWrites == 0, "post-journal authorization check preserves the created but unconfigured device")
            let revokeOwner = Adapter.recover(revokedFactory.recoveryToken)!, revokeID = revokeOwner.unresolved[0].id
            revoked.hook = nil
            check(try revokeOwner.close(revokeID).phase == .closed && revokeOwner.verifyAbsent(revokeID).phase == .absent,
                  "revoked activation still permits explicit original-owner close/absence records")

            let socket = Fixture(); socket.failSocket = true; let socketFactory = socket.factory()
            rejects("unverified socket metadata cannot produce a usable lease") { _ = try socketFactory.acquire(socket.plan(), configuration: socket.configuration()) }
            check(socket.held && socket.duplicates.allSatisfy { fcntl($0, F_GETFD) == -1 } && Adapter.recover(socketFactory.recoveryToken) != nil,
                  "failed socket observation closes only its new private copy and retains the original device")
            let socketOwner = Adapter.recover(socketFactory.recoveryToken)!, socketID = socketOwner.unresolved[0].id
            _ = try socketOwner.close(socketID); _ = try socketOwner.verifyAbsent(socketID)

            let changed = Fixture(), changedFactory = changed.factory(), changedLease = try changedFactory.acquire(changed.plan(), configuration: changed.configuration())
            changed.snapshot = changed.snapshot.replacing(mtu: 8000)
            rejects("fresh read-only inspection rejects a foreign inventory change") { try changedLease.verify(changedLease.identity) }
            rejects("foreign inventory cannot be hidden by dropping private copies and closing the primary") { _ = try changedLease.close() }
            check(changed.held && changed.closes == 0, "foreign device change retains every recovery reference")
            changed.snapshot = changed.snapshot.replacing(mtu: 9000)
            _ = try changedLease.close(); _ = try changedLease.absent()

            let noRewrite = Fixture(); let existing = try Adapter.Address("198.18.0.1/30", family: .ipv4)
            noRewrite.snapshot = noRewrite.snapshot.replacing(address: existing)
            let noRewriteFactory = noRewrite.factory(), noRewriteLease = try noRewriteFactory.acquire(noRewrite.plan(), configuration: noRewrite.configuration(mtu: 1500))
            check(noRewrite.mtuWrites == 0 && noRewrite.addressWrites == 0, "already present identical automatic/requested inventory is preserved without gratuitous setters")
            _ = try noRewriteLease.close(); _ = try noRewriteLease.absent()

            let closeUnknown = Fixture(), closeFactory = closeUnknown.factory(), closeLease = try closeFactory.acquire(closeUnknown.plan(), configuration: closeUnknown.configuration())
            closeUnknown.uncertainClose = true
            check(try closeLease.close() == .applied && closeLease.absent(), "uncertain released close is resolved only by fresh positive independent absence, never FD retry")

            for mode in ["mtuAcknowledgement", "addressIntent", "socketObservation", "beforeDevice"] {
                let fixture = Fixture(), failedFactory = fixture.factory()
                if mode == "mtuAcknowledgement" { fixture.failMTUAfterWrite = true }
                if mode == "addressIntent" { fixture.hook = { record in
                    if record.event.phase == .intent, case .address = record.event.operation { throw Injected.failed }
                } }
                if mode == "socketObservation" { fixture.failSocket = true }
                if mode == "beforeDevice" { fixture.proof = false }
                var journal: Data?, coreQueries = 0
                let session = try RelayTunNetworkSession(installationRevision: String(repeating: "f", count: 64), clientUID: 501,
                    driver: .init(authorized: { true }, inspect: { _ in fixture.plan().baseline },
                        acquire: { plan in try failedFactory.acquire(plan, configuration: fixture.configuration()) },
                        realize: { _, _ in throw Injected.failed }, verifyProjection: { _, _ in throw Injected.failed },
                        storage: { _ in .init(read: { journal }, compareExchange: { expected, replacement in
                            guard expected == journal.map(RelayTunHelperTrust.digest) else { return false }; journal = replacement; return true
                        }, sync: { }) }, route: { _ in throw Injected.failed }, resolver: { _ in throw Injected.failed },
                        coreRuntime: { _, _ in coreQueries += 1; return nil }, coreReleased: { _, _ in coreQueries += 1; return false },
                        now: { 1000 }))
                let original = fixture.plan()
                let plan = try session.prepare(configurationSHA256: original.configurationSHA256,
                    runtimeConfigurationSHA256: original.runtimeConfigurationSHA256, effectsSHA256: original.effectsSHA256)
                let acquired = try session.acquire(plan)
                check(acquired.phase == .uncertain && session.acquisitionAttempted && !acquired.restorationVerified,
                      "partial acquisition never returns ready or restored: " + mode)
                check(RelayTunNetworkSession.recover(session.recoveryToken) === session,
                      "session owns exact failed native capability instead of losing it: " + mode)
                session.invalidatePreparation(); fixture.hook = nil
                let restored = try session.restore(plan)
                let terminal = try RelayTunNetworkJournal.Snapshot.decode(journal!)
                check(restored.phase == .restored && restored.restorationVerified && !fixture.held && coreQueries == 0,
                      "explicit release restores never-delivered partial acquisition without a fake core report: " + mode)
                check(terminal.phase == .acquisitionAborted && terminal.realizedEffects == nil && terminal.pendingIDs.isEmpty &&
                      terminal.observation?.deviceAbsent == true && RelayTunNetworkSession.recover(session.recoveryToken) == nil,
                      "partial acquisition publishes complete synchronized abort after positive absence: " + mode)
            }
            let live = Factory.live(authorize: { _, _ in }, verifyConfiguration: { _, _ in }, record: { _ in throw Injected.failed })
            rejects("live bridge remains pre-syscall denied for ordinary UID") { _ = try live.acquire(good.plan(), configuration: good.configuration()) }
        } catch { rows.append(["name": "fixture setup", "passed": false, "error": String(describing: error)]) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "actualDeviceCreated": false, "actualMTUWritten": false, "actualAddressWritten": false,
            "actualRootFileWrites": false, "actualTunAccepted": false]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
        exit(passed == rows.count ? 0 : 1)
    }
}
