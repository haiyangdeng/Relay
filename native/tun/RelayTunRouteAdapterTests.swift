import Foundation
import Darwin

private typealias Adapter = RelayTunRouteAdapter
private typealias Effects = RelayTunNetworkEffects
private enum Injected: Error { case failed }

private final class Fixture {
    let planID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    let device: Effects.DeviceIdentity
    let route: Effects.Route
    var allowed = true, alive = true, reads = 0, verifies = 0, writes = 0, boundaryChecks = 0
    var dump = Data(), records: [String] = [], request: Data?
    var onRead: (() throws -> Void)?, onRecord: ((Adapter.Event) throws -> Void)?
    var onBoundary: (() throws -> Void)?, onReply: ((Data) throws -> Data)?
    var omitBoundary = false, duplicateBoundary = false, installDump = true
    init(withAddress: Bool = false) throws {
        let interface = try Effects.Interface(name: "utun42", index: 91)
        let addresses: [Effects.Prefix] = withAddress
            ? [try .init(address: .init(family: .ipv4, value: "198.18.0.1"), length: 30)] : []
        device = try .init(id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", interface: interface,
                           controlID: 17, controlUnit: 43, socketDevice: 7, socketInode: 0, mtu: 1500, addresses: addresses)
        route = try .init(destination: .init(address: .init(family: .ipv4, value: "198.18.0.0"), length: 30),
                          gateway: nil, interface: interface, scopeIndex: 0, flags: 0x801, hopCount: 0)
    }
    func frame(_ route: Effects.Route? = nil) throws -> Data {
        try RelayTunRouteProjection.request(route ?? self.route, operation: .get, pid: 0, sequence: 0, interfaceType: 249)
    }
    func changed() throws -> Effects.Route {
        try .init(destination: route.destination, gateway: route.gateway, interface: route.interface,
                  scopeIndex: route.scopeIndex, flags: route.flags, hopCount: 3)
    }
    static func header(_ bytes: Data, change: (inout rt_msghdr) -> Void) -> Data {
        var header = rt_msghdr(), output = bytes
        withUnsafeMutableBytes(of: &header) { $0.copyBytes(from: bytes.prefix($0.count)) }
        change(&header)
        withUnsafeBytes(of: header) { output.replaceSubrange(0..<$0.count, with: $0) }
        return output
    }
    static func enriched(_ bytes: Data, mtu: UInt32 = 1500, address: UInt8 = 1) -> Data {
        var output = bytes
        output.append(contentsOf: [16, UInt8(AF_INET), 0, 0, 198, 18, 0, address, 0, 0, 0, 0, 0, 0, 0, 0])
        return header(output) {
            $0.rtm_flags |= RTF_PRCLONING
            $0.rtm_rmx.rmx_mtu = mtu
            $0.rtm_addrs |= RTA_IFA
            $0.rtm_msglen = UInt16(output.count)
        }
    }
    func adapter() throws -> Adapter {
        let driver = Adapter.Driver(authorized: { self.allowed }, read: { _ in
            self.reads += 1; try self.onRead?(); return self.dump
        }, resolveInterface: { index in
            guard index == self.device.interface.index else { throw Injected.failed }; return self.device.interface
        }, add: { bytes, boundary in
            self.request = bytes
            try self.onBoundary?()
            if !self.omitBoundary { self.boundaryChecks += 1; try boundary() }
            if self.duplicateBoundary { try boundary() }
            self.writes += 1
            if self.installDump { self.dump = try self.frame() }
            let acknowledgement = Self.header(bytes) { $0.rtm_flags |= RTF_DONE }
            return try self.onReply?(acknowledgement) ?? acknowledgement
        }, pid: 501, sequence: { 7 })
        return try Adapter(planID: planID, device: device, route: route, interfaceType: 249, driver: driver,
            verifyDevice: { supplied in
                self.verifies += 1
                guard supplied == self.device, self.alive else { throw Injected.failed }
            }, deviceAbsent: { supplied in supplied == self.device && !self.alive }, record: { event in
                self.records.append(event.retiring ? "retired" : event.phase.rawValue)
                try self.onRecord?(event)
            })
    }
}

@main struct RelayTunRouteAdapterTests {
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
            let good = try Fixture(), adapter = try good.adapter()
            check(good.reads == 0 && good.writes == 0 && good.verifies == 0, "construction is inert")
            check(try adapter.observation() == RelayTunNetworkTransaction.absentSHA256 && good.records.isEmpty, "absence observation makes no journal or mutation call")
            let installed = try adapter.install(expected: RelayTunNetworkTransaction.absentSHA256)
            check(installed.phase == .installed && installed.potentiallyApplied && !installed.routeAbsentVerified, "exact ACK plus independent desired observation confirms installation")
            check(good.writes == 1 && good.boundaryChecks == 1 && good.records == ["intent", "confirmed"], "one absent ADD has intent and confirmation, never a retry")
            check(!installed.actualTunAccepted && !installed.networkRestorationVerified, "one route cannot claim working TUN or full restoration")
            let changes = try Effects.EffectSet(planID: good.planID, device: good.device, effects: [.route(good.route)]).changes()
            check(try adapter.observation() == changes[0].desiredSHA256, "exact desired value maps to its transaction effect digest")
            rejects("a second install cannot add the same route twice") { _ = try adapter.install(expected: RelayTunNetworkTransaction.absentSHA256) }
            check(try adapter.verifyRetired().phase == .uncertain && good.writes == 1, "an absent-looking key cannot retire while the original device remains alive")
            good.alive = false; good.dump = Data()
            check(try adapter.verifyRetired().phase == .retired && adapter.status.routeAbsentVerified && !adapter.status.potentiallyApplied,
                  "device absence plus independent key absence retires the effect without route deletion")
            check(good.writes == 1 && good.records.last == "retired", "retirement records observation and sends no route request")

            let kernel = try Fixture(withAddress: true), kernelOwner = try kernel.adapter()
            kernel.onReply = { ack in
                kernel.dump = Fixture.enriched(try kernel.frame())
                return Fixture.enriched(ack)
            }
            check(try kernelOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .installed,
                  "kernel route enrichment matches the held device MTU and assigned address")
            let kernelChanges = try Effects.EffectSet(planID: kernel.planID, device: kernel.device, effects: [.route(kernel.route)]).changes()
            check(try kernelOwner.observation() == kernelChanges[0].desiredSHA256,
                  "validated kernel metadata preserves the desired route effect digest for recovery")
            kernel.dump = Fixture.enriched(try kernel.frame(), mtu: 1400)
            check(try kernelOwner.observation() != kernelChanges[0].desiredSHA256,
                  "a changed kernel MTU cannot reuse the owned route digest")
            kernel.dump = Fixture.enriched(try kernel.frame(), address: 2)
            check(try kernelOwner.observation() != kernelChanges[0].desiredSHA256,
                  "an interface address outside the held device cannot reuse the owned route digest")
            for ackMismatch in [true, false] {
                for wrongMTU in [true, false] {
                    let mismatch = try Fixture(withAddress: true), mismatchOwner = try mismatch.adapter()
                    mismatch.onReply = { ack in
                        let wrong = { (data: Data) in Fixture.enriched(data, mtu: wrongMTU ? 1400 : 1500, address: wrongMTU ? 1 : 2) }
                        mismatch.dump = ackMismatch ? Fixture.enriched(try mismatch.frame()) : wrong(try mismatch.frame())
                        return ackMismatch ? wrong(ack) : Fixture.enriched(ack)
                    }
                    check(try mismatchOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain && mismatch.records == ["intent"],
                          "mismatched \(wrongMTU ? "MTU" : "interface address") in \(ackMismatch ? "ACK" : "snapshot") cannot confirm installation")
                }
            }

            let denied = try Fixture(); denied.allowed = false; let deniedAdapter = try denied.adapter()
            rejects("unapproved driver cannot inspect or install") { _ = try deniedAdapter.install(expected: RelayTunNetworkTransaction.absentSHA256) }
            check(denied.reads == 0 && denied.verifies == 0 && denied.writes == 0, "permission failure precedes every device or network callback")

            let invalidExpected = try Fixture(), invalidExpectedAdapter = try invalidExpected.adapter()
            rejects("a non-absent expected digest cannot authorize an overwrite") { _ = try invalidExpectedAdapter.install(expected: String(repeating: "a", count: 64)) }
            check(invalidExpected.reads == 0 && invalidExpected.writes == 0, "invalid expected value refuses before observation")

            for same in [true, false] {
                let occupied = try Fixture(); occupied.dump = try occupied.frame(same ? occupied.route : occupied.changed())
                let owner = try occupied.adapter()
                check(try owner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .conflict && occupied.writes == 0 && occupied.records.isEmpty,
                      "an existing \(same ? "same" : "different") value occupies the key and is never adopted or overwritten")
                if !same { check(try owner.observation() != changes[0].desiredSHA256, "changed route value cannot reuse the desired effect digest") }
            }
            let malformed = try Fixture(); malformed.dump = Data([1, 2, 3]); let malformedAdapter = try malformed.adapter()
            check(try malformedAdapter.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain && malformed.writes == 0,
                  "an incomplete route dump remains unknown instead of becoming absence")

            let journalFailed = try Fixture(); journalFailed.onRecord = { _ in throw Injected.failed }; let journalOwner = try journalFailed.adapter()
            check(try journalOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain && journalFailed.writes == 0,
                  "failed intent persistence blocks the ADD")
            let changedAfterJournal = try Fixture()
            changedAfterJournal.onRecord = { event in if event.phase == .intent { changedAfterJournal.dump = try changedAfterJournal.frame() } }
            let changedOwner = try changedAfterJournal.adapter()
            check(try changedOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .conflict && changedAfterJournal.writes == 0,
                  "a route inserted during journal I/O is detected before transport")
            let changedAtBoundary = try Fixture(); changedAtBoundary.onBoundary = { changedAtBoundary.dump = try changedAtBoundary.frame() }
            let boundaryOwner = try changedAtBoundary.adapter()
            check(try boundaryOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .conflict && changedAtBoundary.writes == 0,
                  "transport opening delay cannot bypass the final absence check at the write boundary")
            let revoked = try Fixture(); revoked.onBoundary = { revoked.allowed = false }; let revokedOwner = try revoked.adapter()
            check(try revokedOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain && revoked.writes == 0,
                  "revocation at the final write boundary blocks mutation")
            let lostDevice = try Fixture(); lostDevice.onBoundary = { lostDevice.alive = false }; let lostDeviceOwner = try lostDevice.adapter()
            check(try lostDeviceOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain && lostDevice.writes == 0,
                  "lost held-device identity at the write boundary blocks mutation")

            let badAcks: [(String, (inout rt_msghdr) -> Void)] = [
                ("PID", { $0.rtm_pid += 1 }), ("sequence", { $0.rtm_seq += 1 }),
                ("operation", { $0.rtm_type = UInt8(RTM_GET) }), ("DONE", { $0.rtm_flags &= ~RTF_DONE }),
                ("kernel error", { $0.rtm_errno = EEXIST }), ("route value", { $0.rtm_rmx.rmx_hopcount = 3 })
            ]
            for (label, change) in badAcks {
                let bad = try Fixture(); bad.onReply = { Fixture.header($0, change: change) }; let badOwner = try bad.adapter()
                check(try badOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain && bad.writes == 1 && bad.records == ["intent"],
                      "wrong \(label) ACK never confirms an applied route")
            }
            let noBoundary = try Fixture(); noBoundary.omitBoundary = true; let noBoundaryOwner = try noBoundary.adapter()
            check(try noBoundaryOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain, "a driver omitting the mandatory write-boundary callback cannot confirm success")
            let duplicate = try Fixture(); duplicate.duplicateBoundary = true; let duplicateOwner = try duplicate.adapter()
            check(try duplicateOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain && duplicate.writes == 0,
                  "a driver cannot use the boundary capability twice")
            let missingAfter = try Fixture(); missingAfter.installDump = false; let missingOwner = try missingAfter.adapter()
            check(try missingOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain && missingAfter.records == ["intent"],
                  "a successful ACK cannot replace independent post-write route observation")
            let changedAtConfirm = try Fixture(); changedAtConfirm.onRecord = { event in
                if event.phase == .confirmed { changedAtConfirm.dump = try changedAtConfirm.frame(changedAtConfirm.changed()) }
            }; let confirmOwner = try changedAtConfirm.adapter()
            check(try confirmOwner.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .uncertain,
                  "journal confirmation cannot conceal a later value change")

            let retirementConflict = try Fixture(), retirementOwner = try retirementConflict.adapter()
            _ = try retirementOwner.install(expected: RelayTunNetworkTransaction.absentSHA256)
            retirementConflict.alive = false; retirementConflict.dump = try retirementConflict.frame(retirementConflict.changed())
            check(try retirementOwner.verifyRetired().phase == .conflict && retirementConflict.writes == 1,
                  "a different route left after device retirement is preserved as conflict")
            retirementConflict.dump = Data(); retirementConflict.onRecord = { event in
                if event.retiring { retirementConflict.dump = try retirementConflict.frame() }
            }
            check(try retirementOwner.verifyRetired().phase == .conflict,
                  "a key reappearing during retirement journal I/O prevents an absence claim")

            let reentrant = try Fixture(); var reentrantOwner: Adapter?; var busy = false
            reentrant.onRecord = { _ in
                do { _ = try reentrantOwner!.observation() } catch Adapter.Failure.busy { busy = true }
            }; reentrantOwner = try reentrant.adapter()
            check(try reentrantOwner!.install(expected: RelayTunNetworkTransaction.absentSHA256).phase == .installed && busy,
                  "same-thread journal reentry reports busy instead of starting a second operation")

            let live = try Adapter.live(planID: good.planID, device: good.device, route: good.route, interfaceType: 249,
                verifyDevice: { _ in throw Injected.failed }, deviceAbsent: { _ in throw Injected.failed }, record: { _ in throw Injected.failed })
            rejects("ordinary UID refuses the live adapter before any OS or injected callback") { _ = try live.install(expected: RelayTunNetworkTransaction.absentSHA256) }
        } catch { rows.append(["name": "fixture setup", "passed": false, "error": String(describing: error)]) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "liveRouteSocketOpened": false, "actualRouteWritten": false, "actualTunAccepted": false]
        let bytes = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(decoding: bytes, as: UTF8.self)); exit(passed == rows.count ? 0 : 1)
    }
}
