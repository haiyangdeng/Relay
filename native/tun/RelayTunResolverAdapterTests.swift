import Foundation
import Darwin

private typealias Adapter = RelayTunResolverAdapter
private typealias Effects = RelayTunNetworkEffects
private enum Injected: Error { case fault }
private final class ResolverFixture {
    static let plan = "27fc432f-de89-487c-b697-7769b2259109"
    let device: Effects.DeviceIdentity
    let resolver: Effects.Resolver
    var adapter: Adapter!
    var bytes: Data?
    var desired: Data?
    var owner: UUID?
    var held = false
    var events: [String] = []
    var allow = true, deviceValid = true, failCreate = false, failAdd = false, addAfterThrow = false, addFalseAfterWrite = false
    var failRelease = false, releaseAfterThrow = false, uncertainRelease = false, holdOnRelease = false, retireLater = false
    var failInspect = false, inspectOversized = false, failRecord: String?
    var recordHook: ((Adapter.Event) throws -> Void)?
    var releaseHook: (() -> Void)?
    var inspectHook: (() -> Void)?
    init() throws {
        device = try .init(id: "a1536bb3-94f2-4594-b45b-bf967d88d28c", interface: .init(name: "utun42", index: 91),
                           controlID: 17, controlUnit: 43, socketDevice: 0, socketInode: 0, mtu: 1500, addresses: [])
        resolver = try .init(key: Effects.Resolver.ownedKey(planID: Self.plan), interface: device.interface,
                             servers: [.init(family: .ipv4, value: "192.0.2.1"), .init(family: .ipv6, value: "2001:db8::1")],
                             matchDomains: ["test.invalid"], searchDomains: ["test.invalid"], searchOrder: 1)
        adapter = try Adapter(planID: Self.plan, device: device, resolver: resolver, driver: .init(authorized: { [unowned self] in allow }, inspect: { [unowned self] key in
            events.append("inspect"); guard key == resolver.key else { throw Injected.fault }
            if failInspect { throw Injected.fault }
            if inspectOversized { return Data(repeating: 32, count: 65537) }
            let retained = bytes; inspectHook?(); return retained
        }, create: { [unowned self] key in
            events.append("create"); guard key == resolver.key, !failCreate else { throw Injected.fault }
            held = true; let identity = UUID()
            return .init(held: { [unowned self] in held }, addTemporary: { [unowned self] data in
                events.append("add"); desired = data
                guard bytes == nil else { return false }
                if failAdd { throw Injected.fault }
                bytes = data; owner = identity
                if addAfterThrow { throw Injected.fault }
                return !addFalseAfterWrite
            }, release: { [unowned self] in
                events.append("release"); if failRelease { throw Injected.fault }
                releaseHook?()
                if !holdOnRelease {
                    held = false
                    // Match configd's documented session ownership: a value
                    // updated by another session no longer belongs to us.
                    if owner == identity && !retireLater { bytes = nil; owner = nil }
                }
                if releaseAfterThrow { throw Injected.fault }
                return .init(released: !held, uncertain: uncertainRelease)
            })
        }), verifyDevice: { [unowned self] value in
            events.append("device"); guard deviceValid && value == device else { throw Injected.fault }
        }, record: { [unowned self] value in
            let key = value.operation.rawValue + "_" + value.phase.rawValue; events.append(key)
            try recordHook?(value)
            if failRecord == key { throw Injected.fault }
        })
    }
    func external(_ data: Data?) { bytes = data; owner = nil }
    func cleanup() {
        allow = true; failInspect = false; inspectOversized = false; failRecord = nil; recordHook = nil; releaseHook = nil; inspectHook = nil
        failRelease = false; releaseAfterThrow = false; uncertainRelease = false; holdOnRelease = false; retireLater = false
        guard let adapter else { return }
        if adapter.view.status.ownsSession { if owner == nil { external(nil) }; _ = try? adapter.release() }
        else if adapter.view.status.phase != .idle && adapter.view.status.phase != .absent { external(nil); _ = try? adapter.verifyAbsent() }
    }
}

@main struct RelayTunResolverAdapterTests {
    static func main() {
        guard getuid() > 0 && geteuid() == getuid() else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ passed: Bool, _ name: String) { rows.append(["name": name, "passed": passed]) }
        func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
        do {
            let ordinary = try ResolverFixture(); defer { ordinary.cleanup() }
            check(ordinary.events.isEmpty && !ordinary.held && ordinary.bytes == nil, "construction is inert and does not open a configd session")
            let installed = try ordinary.adapter.install()
            check(installed.phase == .held && installed.ownsSession && !installed.absentVerified && !installed.actualTunAccepted && !installed.networkRestorationVerified, "temporary resolver is held without claiming routing or network restoration")
            check(ordinary.events == ["device", "inspect", "install_intent", "device", "inspect", "create", "add", "inspect", "device", "install_confirmed", "device", "inspect"], "durable intent and exact device/key validation surround session creation and its final acknowledgement")
            let value = try JSONSerialization.jsonObject(with: ordinary.bytes!) as! [String: Any]
            check(Set(value.keys) == ["ServerAddresses", "SupplementalMatchDomains", "SupplementalMatchOrders", "SearchDomains"], "temporary dictionary contains only documented DNS value fields")
            check(value["ServerAddresses"] as? [String] == ["192.0.2.1", "2001:db8::1"] && value["SupplementalMatchOrders"] as? [Int] == [1], "server family/order values remain intact")
            rejects("an installed resolver cannot be silently installed again") { _ = try ordinary.adapter.install() }
            rejects("held session cannot be declared absent") { _ = try ordinary.adapter.verifyAbsent() }
            let retired = try ordinary.adapter.release()
            check(retired.phase == .absent && !retired.ownsSession && retired.absentVerified && ordinary.bytes == nil, "release closes only the owned session and independently confirms key absence")
            check(Adapter.recover(ordinary.adapter.recoveryToken) == nil, "confirmed absence retires the process recovery owner")
            rejects("a terminal resolver cannot silently reuse a prior session") { _ = try ordinary.adapter.release() }
            let observed = try ResolverFixture(); defer { observed.cleanup() }
            check(try observed.adapter.observation() == RelayTunNetworkTransaction.absentSHA256 && observed.events == ["inspect"], "fresh absent observation performs no journal or session mutation")
            _ = try observed.adapter.install()
            let desiredObservation = try Effects.EffectSet(planID: ResolverFixture.plan, device: observed.device, effects: [.resolver(observed.resolver)]).changes()[0].desiredSHA256
            check(try observed.adapter.observation() == desiredObservation, "fresh exact DNS value maps to the bound typed effect digest")
            observed.external(Data("{\"foreign\":true}".utf8))
            let unexpected = try observed.adapter.observation()
            check(unexpected != desiredObservation && unexpected != RelayTunNetworkTransaction.absentSHA256, "unknown DNS value cannot masquerade as either the desired effect or absence")

            let wrong = try ResolverFixture(); defer { wrong.cleanup() }
            let foreign = try Effects.Resolver(key: "State:/Network/Global/DNS", interface: wrong.device.interface, servers: wrong.resolver.servers, matchDomains: [""], searchDomains: [], searchOrder: 1)
            rejects("global DNS key cannot enter the adapter") { _ = try Adapter(planID: ResolverFixture.plan, device: wrong.device, resolver: foreign, driver: .init(authorized: { true }, inspect: { _ in nil }, create: { _ in throw Injected.fault }), verifyDevice: { _ in }, record: { _ in }) }
            let other = try Effects.Resolver(key: Effects.Resolver.ownedKey(planID: ResolverFixture.plan), interface: .init(name: "en0", index: 5), servers: wrong.resolver.servers, matchDomains: [], searchDomains: [], searchOrder: 1)
            rejects("resolver must bind the exact held device interface") { _ = try Adapter(planID: ResolverFixture.plan, device: wrong.device, resolver: other, driver: .init(authorized: { true }, inspect: { _ in nil }, create: { _ in throw Injected.fault }), verifyDevice: { _ in }, record: { _ in }) }

            let occupied = try ResolverFixture(); defer { occupied.cleanup() }; occupied.external(Data("{\"foreign\":true}".utf8))
            check(try occupied.adapter.install().phase == .conflict && !occupied.events.contains("create") && !occupied.events.contains("install_intent"), "an existing key is preserved before any session or intent mutation")
            let intentFailure = try ResolverFixture(); defer { intentFailure.cleanup() }; intentFailure.failRecord = "install_intent"
            rejects("failed install intent prevents all session operations") { _ = try intentFailure.adapter.install() }
            check(!intentFailure.held && !intentFailure.events.contains("create") && Adapter.recover(intentFailure.adapter.recoveryToken) == nil, "pre-mutation journal failure creates no owner obligation")
            let intentRace = try ResolverFixture(); defer { intentRace.cleanup() }
            intentRace.recordHook = { value in if value.operation == .install && value.phase == .intent { intentRace.external(Data("{\"foreign\":true}".utf8)) } }
            check(try intentRace.adapter.install().phase == .conflict && !intentRace.events.contains("create"), "a target created during intent persistence is never overwritten")
            let deviceRace = try ResolverFixture(); defer { deviceRace.cleanup() }
            deviceRace.recordHook = { value in if value.phase == .intent { deviceRace.deviceValid = false } }
            rejects("device identity changed during journal I/O prevents session creation") { _ = try deviceRace.adapter.install() }
            check(!deviceRace.events.contains("create"), "device revalidation precedes every installation")
            let finalDeviceRace = try ResolverFixture(); defer { finalDeviceRace.cleanup() }
            finalDeviceRace.recordHook = { event in if event.operation == .install && event.phase == .confirmed { finalDeviceRace.deviceValid = false } }
            check(try finalDeviceRace.adapter.install().phase == .uncertain && finalDeviceRace.held, "device change during the final install record cannot publish held state or drop the recovery session")
            let finalValueRace = try ResolverFixture(); defer { finalValueRace.cleanup() }
            finalValueRace.recordHook = { event in if event.operation == .install && event.phase == .confirmed { finalValueRace.external(Data("{\"foreign\":true}".utf8)) } }
            check(try finalValueRace.adapter.install().phase == .uncertain && finalValueRace.bytes != finalValueRace.desired, "value change during the final install record is independently detected and preserved")

            for mode in ["create", "add", "afterAdd", "falseAfterAdd", "installAck"] {
                let fixture = try ResolverFixture(); defer { fixture.cleanup() }
                fixture.failCreate = mode == "create"; fixture.failAdd = mode == "add"; fixture.addAfterThrow = mode == "afterAdd"; fixture.addFalseAfterWrite = mode == "falseAfterAdd"
                if mode == "installAck" { fixture.failRecord = "install_confirmed" }
                let status = try fixture.adapter.install()
                check(status.phase == .uncertain && !status.absentVerified && Adapter.recover(fixture.adapter.recoveryToken) === fixture.adapter, "\(mode) failure preserves exact owner and uncertain recovery state")
                fixture.failRecord = nil
                check(try fixture.adapter.release().absentVerified, "\(mode) explicit recovery retires only its own temporary session")
            }
            for mode in ["releaseIntent", "release", "afterRelease", "uncertainRelease", "heldRelease", "releaseAck", "absenceAck"] {
                let fixture = try ResolverFixture(); defer { fixture.cleanup() }; _ = try fixture.adapter.install()
                if mode == "releaseIntent" { fixture.failRecord = "release_intent" }
                fixture.failRelease = mode == "release"; fixture.releaseAfterThrow = mode == "afterRelease"; fixture.uncertainRelease = mode == "uncertainRelease"; fixture.holdOnRelease = mode == "heldRelease"
                if mode == "releaseAck" { fixture.failRecord = "release_confirmed" }
                if mode == "absenceAck" { fixture.failRecord = "verifyAbsent_confirmed" }
                let status = try fixture.adapter.release()
                check(status.phase == .uncertain && !status.absentVerified && Adapter.recover(fixture.adapter.recoveryToken) === fixture.adapter, "\(mode) failure never loses recovery ownership or confirms absence")
                if mode == "releaseIntent" { check(fixture.held && !fixture.events.contains("release"), "release intent failure cannot close the held session") }
                fixture.cleanup()
                check(fixture.adapter.view.status.absentVerified, "\(mode) revalidated explicit retry can confirm absence")
            }
            let foreignChange = try ResolverFixture(); defer { foreignChange.cleanup() }; _ = try foreignChange.adapter.install()
            let foreignBytes = Data("{\"foreign\":true}".utf8); foreignChange.external(foreignBytes)
            check(try foreignChange.adapter.release().phase == .conflict && foreignChange.held && !foreignChange.events.contains("release"), "unknown external value is preserved without releasing the original session")
            check(foreignChange.bytes == foreignBytes, "conflict handling leaves external DNS value untouched")
            let sameValue = try ResolverFixture(); defer { sameValue.cleanup() }; _ = try sameValue.adapter.install(); sameValue.external(sameValue.bytes)
            check(try sameValue.adapter.release().phase == .uncertain && !sameValue.held && sameValue.bytes == sameValue.desired, "same-byte external session update is not deleted or falsely confirmed absent by closing the original temporary owner")
            let delayed = try ResolverFixture(); defer { delayed.cleanup() }; _ = try delayed.adapter.install(); delayed.retireLater = true
            check(try delayed.adapter.release().phase == .uncertain && !delayed.held && Adapter.recover(delayed.adapter.recoveryToken) === delayed.adapter, "asynchronous configd retirement retains ownership evidence until absence is observed")
            delayed.bytes = nil; delayed.owner = nil
            check(try delayed.adapter.verifyAbsent().absentVerified, "later independent absence can acknowledge an already released session without another mutation")
            let duringClose = try ResolverFixture(); defer { duringClose.cleanup() }; _ = try duringClose.adapter.install()
            duringClose.releaseHook = { duringClose.external(foreignBytes) }
            check(try duringClose.adapter.release().phase == .conflict && duringClose.bytes == foreignBytes, "an external session update racing retirement survives and blocks restored status")
            let afterAbsence = try ResolverFixture(); defer { afterAbsence.cleanup() }; _ = try afterAbsence.adapter.install()
            afterAbsence.recordHook = { event in if event.operation == .verifyAbsent { afterAbsence.external(foreignBytes) } }
            check(try afterAbsence.adapter.release().phase == .conflict && !afterAbsence.adapter.view.status.absentVerified, "value appearing during final journal acknowledgement blocks absence confirmation")

            let malformed = try ResolverFixture(); defer { malformed.cleanup() }; malformed.bytes = Data("{\"a\":1,\"a\":1}".utf8)
            rejects("duplicate-key observation never supplies absence proof") { _ = try malformed.adapter.install() }
            let oversized = try ResolverFixture(); defer { oversized.cleanup() }; oversized.inspectOversized = true
            rejects("oversized observation is refused before a session exists") { _ = try oversized.adapter.install() }
            let permission = try ResolverFixture(); defer { permission.cleanup() }; permission.allow = false
            rejects("unauthorized install never invokes a driver") { _ = try permission.adapter.install() }
            rejects("unauthorized release never invokes a driver") { _ = try permission.adapter.release() }
            rejects("unauthorized absence never invokes a driver") { _ = try permission.adapter.verifyAbsent() }
            rejects("unauthorized observation never invokes a driver") { _ = try permission.adapter.observation() }
            check(permission.events.isEmpty, "permission refusal is before journal, device or configd callbacks")

            let lifecycle = try ResolverFixture(); defer { lifecycle.cleanup() }; _ = try lifecycle.adapter.install()
            weak var retained: Adapter? = lifecycle.adapter; let token = lifecycle.adapter.recoveryToken
            lifecycle.adapter = nil
            check(retained != nil && Adapter.recover(token) === retained, "dropping the last manager reference cannot release an unresolved temporary session")
            var recovered = Adapter.recover(token); lifecycle.adapter = recovered
            check(try recovered!.release().absentVerified, "the original in-process owner supports explicit recovery")
            lifecycle.adapter = nil; recovered = nil
            check(retained == nil && Adapter.recover(token) == nil, "only recorded independent absence retires the process owner")

            let reentry = try ResolverFixture(); defer { reentry.cleanup() }; var wasBusy = false
            reentry.recordHook = { event in
                if event.operation == .install && event.phase == .intent {
                    do { _ = try reentry.adapter.install() } catch Adapter.Failure.busy { wasBusy = true }
                }
            }
            _ = try reentry.adapter.install(); check(wasBusy, "storage callback reentry is rejected rather than creating a second session")
            let concurrent = try ResolverFixture(); defer { concurrent.cleanup() }
            let reached = DispatchSemaphore(value: 0), resume = DispatchSemaphore(value: 0), ended = DispatchSemaphore(value: 0)
            concurrent.recordHook = { event in if event.operation == .install && event.phase == .intent { reached.signal(); _ = resume.wait(timeout: .now() + 5) } }
            DispatchQueue.global().async { _ = try? concurrent.adapter.install(); ended.signal() }
            let atIntent = reached.wait(timeout: .now() + 5) == .success
            check(atIntent, "concurrent fixture pauses before session creation without real configd")
            if atIntent {
                check(concurrent.adapter.view.busy && !concurrent.adapter.view.status.ownsSession, "published status remains readable during blocked persistence")
                rejects("another connection cannot release an in-flight creation") { _ = try concurrent.adapter.release() }
                check(Adapter.recoveryViews.allSatisfy { !$0.token.id.isEmpty }, "recovery inventory remains readable while another writer is busy")
            }
            resume.signal(); check(ended.wait(timeout: .now() + 5) == .success, "concurrent writer settles without deadlock")
            concurrent.recordHook = nil

            let live = try Adapter.live(planID: ResolverFixture.plan, device: ordinary.device, resolver: ordinary.resolver, verifyDevice: { _ in throw Injected.fault }, record: { _ in throw Injected.fault })
            rejects("ordinary UID production install refuses before configd") { _ = try live.install() }
            rejects("ordinary UID production release refuses before configd") { _ = try live.release() }
            rejects("ordinary UID production absence refuses before configd") { _ = try live.verifyAbsent() }
            rejects("ordinary UID production observation refuses before configd") { _ = try live.observation() }
            check(Adapter.liveAPICalls == 0 && !live.view.status.ownsSession && Adapter.recover(live.recoveryToken) == nil, "all production configd API counters remain zero")
        } catch { rows.append(["name": "runner: \(error)", "passed": false]) }
        let failures = rows.filter { $0["passed"] as? Bool != true }
        let result: [String: Any] = ["tests": rows.count, "passed": rows.count - failures.count, "failures": failures, "actualConfigdAPICalls": Adapter.liveAPICalls, "actualDNSChanged": false, "actualRootBranchExecuted": false, "actualTunAccepted": false]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self)); exit(failures.isEmpty ? 0 : 1)
    }
}
