import Foundation
import Darwin

private typealias Adapter = RelayTunDeviceAdapter
private enum FixtureFailure: Error { case injected }
private final class DeviceFixture {
    var held = false
    var present = false
    var snapshot = Adapter.Snapshot(name: "utun49", index: 77, controlID: 4, controlUnit: 50, mtu: 1500, addressKeys: [])
    var events: [String] = []
    var records: [Adapter.Event] = []
    var failCreate = false
    var failSnapshot = false
    var failSetAfterWrite = false
    var failClose = false
    var uncertainClose = false
    var retainInterfaceAfterClose = false
    var creates = 0, mtuWrites = 0, addressWrites = 0, duplicates = 0, closes = 0, absenceReads = 0
    var lastDuplicate: Int32 = -1
    var hook: ((Adapter.Event) throws -> Void)?
    var adapter: Adapter { retainedAdapter! }
    func relinquishAdapter() -> Adapter { let value = adapter; retainedAdapter = nil; return value }
    private lazy var retainedAdapter: Adapter? = Adapter(driver: Adapter.Driver(authorized: { true }, create: { [unowned self] _ in
        events.append("create"); creates += 1
        if failCreate { throw FixtureFailure.injected }
        held = true; present = true
        return Adapter.Session(hasHandle: { [unowned self] in held }, snapshot: { [unowned self] in
            events.append("snapshot"); if failSnapshot { throw FixtureFailure.injected }; return snapshot
        }, setMTU: { [unowned self] mtu in
            events.append("mtu"); mtuWrites += 1; snapshot = snapshot.replacing(mtu: mtu)
            if failSetAfterWrite { throw FixtureFailure.injected }
        }, addAddress: { [unowned self] address in
            events.append("address"); addressWrites += 1; snapshot = snapshot.replacing(address: address)
        }, duplicate: { [unowned self] in
            events.append("duplicate"); duplicates += 1
            var descriptors: [Int32] = [-1, -1]
            guard pipe(&descriptors) == 0 else { throw FixtureFailure.injected }
            Darwin.close(descriptors[1]); _ = fcntl(descriptors[0], F_SETFD, FD_CLOEXEC)
            lastDuplicate = descriptors[0]
            return FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true)
        }, close: { [unowned self] in
            events.append("close"); closes += 1
            if failClose { return Adapter.CloseResult(released: false, uncertain: true) }
            held = false
            if !retainInterfaceAfterClose { present = false }
            return Adapter.CloseResult(released: true, uncertain: uncertainClose)
        })
    }, absent: { [unowned self] _ in
        events.append("absent"); absenceReads += 1; return !present
    }), record: { [unowned self] event in
        events.append("record:" + event.phase.rawValue)
        let operation: String
        switch event.operation { case .create: operation = "create"; case .mtu: operation = "mtu"; case .address: operation = "address"; case .duplicate: operation = "duplicate"; case .close: operation = "close"; case .verifyAbsent: operation = "absent" }
        events.append("record:" + event.phase.rawValue + ":" + operation); records.append(event); try hook?(event)
    })
}

@main private struct RelayTunDeviceAdapterTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var total = 0, failures: [String] = []
        func check(_ condition: @autoclosure () throws -> Bool, _ message: String) {
            total += 1
            do { if try !condition() { failures.append(message) } } catch { failures.append(message + ": \(error)") }
        }
        func rejects(_ message: String, _ body: () throws -> Void) {
            total += 1
            do { try body(); failures.append(message) } catch { }
        }
        do {
            let shortIPv4: [UInt8] = [8, UInt8(AF_INET), 0, 0, 255, 255, 255, 252]
            let shortIPv4Prefix: [UInt8] = [7, UInt8(AF_INET), 0, 0, 255, 255, 255]
            let shortIPv6: [UInt8] = [12, UInt8(AF_INET6), 0, 0, 0, 0, 0, 0, 255, 255, 255, 255]
            check(try shortIPv4.withUnsafeBytes { try Adapter.netmaskBytes($0, family: AF_INET) } == [255, 255, 255, 252], "the observed eight-byte IPv4 /30 mask is accepted without reading beyond sa_len")
            check(try shortIPv4Prefix.withUnsafeBytes { try Adapter.netmaskBytes($0, family: AF_INET) } == [255, 255, 255, 0], "a truncated IPv4 mask zero-fills its omitted trailing bytes")
            check(try shortIPv6.withUnsafeBytes { try Adapter.netmaskBytes($0, family: AF_INET6) } == [255, 255, 255, 255] + Array(repeating: 0, count: 12), "a truncated IPv6 mask zero-fills its omitted trailing bytes")
            rejects("mask family mismatch is rejected") { _ = try shortIPv4.withUnsafeBytes { try Adapter.netmaskBytes($0, family: AF_INET6) } }
            let malformed: [UInt8] = [7, UInt8(AF_INET), 0, 0, 255, 255, 255, 252]
            rejects("mask length must match the actual buffer") { _ = try malformed.withUnsafeBytes { try Adapter.netmaskBytes($0, family: AF_INET) } }
            let address4 = try Adapter.Address("198.18.0.1/30", family: .ipv4)
            let address6 = try Adapter.Address("fd00::1/126", family: .ipv6)
            check(address4.key == "4:c6120001:fffffffc", "IPv4 typed prefix retains host and exact mask bytes")
            check(address6.key == "6:fd000000000000000000000000000001:fffffffffffffffffffffffffffffffc", "IPv6 typed prefix retains host and exact mask bytes")
            rejects("NUL prefix cannot be silently truncated by C") { _ = try Adapter.Address("198.18.0.1/30\0extra", family: .ipv4) }
            rejects("IPv4 with leading zeros is rejected before mutation") { _ = try Adapter.Address("198.018.0.1/30", family: .ipv4) }
            rejects("IPv6 scope is never resolved from caller text") { _ = try Adapter.Address("fe80::1%en0/64", family: .ipv6) }
            let fixture = DeviceFixture(), created = try fixture.adapter.create(requestedName: "utun")
            check(created.phase == .held && created.ownsHandle && !created.deviceAbsentVerified && !created.actualTunAccepted, "new device is held and does not claim forwarding or restoration")
            check(UUID(uuidString: created.id)?.uuidString.lowercased() == created.id && created.snapshot?.name == "utun49", "only internally generated UUID maps the observed automatic device")
            check(fixture.events.first == "record:intent" && fixture.creates == 1 && fixture.records.last?.phase == .confirmed, "creation intent precedes driver creation and observed identity is recorded")
            rejects("a second live device cannot hide the first held lease") { _ = try fixture.adapter.create(requestedName: "utun") }
            rejects("caller supplied unknown UUID never adopts a device") { _ = try fixture.adapter.setMTU(UUID().uuidString.lowercased(), to: 1400) }
            check(fixture.creates == 1 && fixture.mtuWrites == 0, "invalid second acquisition and unknown lease perform no writes")
            let changed = try fixture.adapter.setMTU(created.id, to: 1400)
            check(changed.phase == .held && changed.snapshot?.mtu == 1400 && fixture.mtuWrites == 1, "MTU applies only to the held identity and confirms actual value")
            let mtuIndex = fixture.events.firstIndex(of: "mtu")!
            check(fixture.events.firstIndex(of: "record:intent:mtu")! < mtuIndex && fixture.records.contains(where: { $0.operation == .mtu(1400) && $0.before?.mtu == 1500 && $0.desired?.mtu == 1400 }), "MTU intent stores exact before and desired inventory before the driver mutation")
            let added4 = try fixture.adapter.addAddress(created.id, address4), added6 = try fixture.adapter.addAddress(created.id, address6)
            check(added4.snapshot?.addressKeys == [address4.key] && added6.snapshot?.addressKeys == [address4.key, address6.key].sorted(), "IPv4 and IPv6 additions confirm exact resulting inventory")
            check(fixture.addressWrites == 2 && fixture.records.contains(where: { $0.operation == .address(address6) && $0.phase == .intent }) && fixture.events.firstIndex(of: "record:intent:address")! < fixture.events.firstIndex(of: "address")!, "address writes require typed recorded intent before the driver mutation")
            let delivery = try fixture.adapter.duplicateForDelivery(created.id)
            let flags = fcntl(delivery.fileDescriptor, F_GETFD)
            check(fixture.duplicates == 1 && flags >= 0 && flags & FD_CLOEXEC != 0 && fixture.events.firstIndex(of: "record:intent:duplicate")! < fixture.events.firstIndex(of: "duplicate")!, "delivery is an owned CLOEXEC FileHandle created only after its intent")
            try delivery.close()
            let closed = try fixture.adapter.close(created.id)
            check(!closed.ownsHandle && closed.phase == .closed && !closed.deviceAbsentVerified && !closed.networkRestorationVerified, "closing helper FD alone never claims device or network restoration")
            let absent = try fixture.adapter.verifyAbsent(created.id)
            check(absent.phase == .absent && absent.deviceAbsentVerified && !absent.networkRestorationVerified && fixture.absenceReads == 1, "independent absence is recorded separately from global network restoration")
            _ = try fixture.adapter.close(created.id)
            check(fixture.closes == 1 && fixture.adapter.unresolved.isEmpty, "a released handle is never closed twice or by reused FD")
            let next = try fixture.adapter.create(requestedName: "utun")
            check(next.id != created.id && fixture.creates == 2, "only a fully retired lease permits a new generated identity")

            let deniedIntent = DeviceFixture()
            deniedIntent.hook = { if $0.phase == .intent { throw FixtureFailure.injected } }
            rejects("failed creation intent prevents driver mutation") { _ = try deniedIntent.adapter.create(requestedName: "utun") }
            check(deniedIntent.creates == 0 && deniedIntent.adapter.unresolved.isEmpty && Adapter.recover(deniedIntent.adapter.recoveryToken) == nil, "no unrecorded acquisition or recovery owner is created")
            let failedCreate = DeviceFixture(); failedCreate.failCreate = true
            let failedCreation = try failedCreate.adapter.create(requestedName: "utun")
            check(failedCreation.phase == .uncertain && !failedCreation.ownsHandle && failedCreate.adapter.unresolved.count == 1, "an unknown create outcome remains visible even without a returned handle")
            rejects("unknown create outcome cannot be relabelled as device absence") { _ = try failedCreate.adapter.verifyAbsent(failedCreation.id) }
            let failedObservation = DeviceFixture(); failedObservation.failSnapshot = true
            let retained = try failedObservation.adapter.create(requestedName: "utun")
            check(retained.phase == .uncertain && retained.ownsHandle && retained.snapshot == nil, "initial observation failure retains the returned handle under its UUID")
            failedObservation.failSnapshot = false
            let recoveredClose = try failedObservation.adapter.close(retained.id)
            check(recoveredClose.phase == .closed && !recoveredClose.ownsHandle && failedObservation.closes == 1, "explicit recovery can close its internally owned first-observation failure")
            check(try failedObservation.adapter.verifyAbsent(retained.id).deviceAbsentVerified, "recovered identity still requires independent absence proof")

            let failedAcknowledgement = DeviceFixture()
            failedAcknowledgement.hook = { if $0.phase == .confirmed { throw FixtureFailure.injected } }
            let unacknowledged = try failedAcknowledgement.adapter.create(requestedName: "utun")
            check(unacknowledged.phase == .uncertain && unacknowledged.ownsHandle && unacknowledged.snapshot != nil, "creation acknowledgement failure never drops known ownership")
            let mutateFailure = DeviceFixture(), mutateLease = try mutateFailure.adapter.create(requestedName: "utun")
            mutateFailure.failSetAfterWrite = true
            let partial = try mutateFailure.adapter.setMTU(mutateLease.id, to: 1450)
            check(partial.phase == .uncertain && partial.ownsHandle && mutateFailure.snapshot.mtu == 1450, "a failed post-write MTU acknowledgement retains ownership and uncertainty")
            check(try mutateFailure.adapter.close(mutateLease.id).phase == .closed, "recovery accepts only the recorded before or desired inventory after a partial write")
            let recordFailure = DeviceFixture(), recordLease = try recordFailure.adapter.create(requestedName: "utun")
            recordFailure.hook = { if $0.operation == .address(address4) && $0.phase == .intent { throw FixtureFailure.injected } }
            let noWrite = try recordFailure.adapter.addAddress(recordLease.id, address4)
            check(noWrite.phase == .uncertain && recordFailure.addressWrites == 0 && noWrite.ownsHandle, "failed address intent causes no ioctl and preserves the held device")

            let identity = DeviceFixture(), identityLease = try identity.adapter.create(requestedName: "utun")
            identity.snapshot = Adapter.Snapshot(name: "utun49", index: 78, controlID: 4, controlUnit: 50, mtu: 1500, addressKeys: [])
            let foreign = try identity.adapter.setMTU(identityLease.id, to: 1400)
            check(foreign.phase == .uncertain && identity.mtuWrites == 0 && foreign.ownsHandle, "changed ifindex rejects mutation without adopting a replacement")
            check(try identity.adapter.close(identityLease.id).ownsHandle && identity.closes == 0, "changed identity also refuses destructive close")
            let foreignSettings = DeviceFixture(), settingsLease = try foreignSettings.adapter.create(requestedName: "utun")
            foreignSettings.snapshot = foreignSettings.snapshot.replacing(mtu: 1490)
            _ = try foreignSettings.adapter.addAddress(settingsLease.id, address4)
            check(try foreignSettings.addressWrites == 0 && foreignSettings.adapter.close(settingsLease.id).ownsHandle && foreignSettings.closes == 0, "unrecorded external settings are neither overwritten nor retired")
            let race = DeviceFixture(), raceLease = try race.adapter.create(requestedName: "utun")
            race.hook = { if $0.operation == .mtu(1420) && $0.phase == .intent { race.snapshot = race.snapshot.replacing(mtu: 1390) } }
            _ = try race.adapter.setMTU(raceLease.id, to: 1420)
            check(race.mtuWrites == 0 && race.adapter.unresolved.first?.ownsHandle == true, "identity and inventory are checked again after the journal boundary")

            let duplicateFailure = DeviceFixture(), duplicateLease = try duplicateFailure.adapter.create(requestedName: "utun")
            duplicateFailure.hook = { if $0.operation == .duplicate && $0.phase == .confirmed { throw FixtureFailure.injected } }
            rejects("unrecorded delivery cannot escape to a client") { _ = try duplicateFailure.adapter.duplicateForDelivery(duplicateLease.id) }
            errno = 0
            check(fcntl(duplicateFailure.lastDuplicate, F_GETFD) == -1 && errno == EBADF && duplicateFailure.adapter.unresolved.first?.ownsHandle == true, "failed duplicate acknowledgement closes only the new delivery copy")
            let remaining = DeviceFixture(), remainingLease = try remaining.adapter.create(requestedName: "utun")
            remaining.retainInterfaceAfterClose = true
            _ = try remaining.adapter.close(remainingLease.id)
            check(!(try remaining.adapter.verifyAbsent(remainingLease.id)).deviceAbsentVerified && !remaining.held && remaining.present, "a client duplicate retaining the interface blocks absence acknowledgement")
            remaining.present = false
            check(try remaining.adapter.verifyAbsent(remainingLease.id).deviceAbsentVerified, "absence can be confirmed after the independently observed last copy disappears")
            let closeFailure = DeviceFixture(), closeLease = try closeFailure.adapter.create(requestedName: "utun")
            closeFailure.failClose = true
            check(try closeFailure.adapter.close(closeLease.id).ownsHandle && closeFailure.closes == 1, "close rejection retains its handle for a later explicit retry")
            closeFailure.failClose = false; closeFailure.uncertainClose = true
            let unknownClose = try closeFailure.adapter.close(closeLease.id)
            check(unknownClose.phase == .uncertain && !unknownClose.ownsHandle, "a released but uncertain close never retries a freed C pointer")
            _ = try closeFailure.adapter.close(closeLease.id)
            check(closeFailure.closes == 2, "the same released integer cannot be closed on a retry")
            check(try closeFailure.adapter.verifyAbsent(closeLease.id).deviceAbsentVerified, "independent absence can resolve a released-close uncertainty")

            let reentrant = DeviceFixture()
            var busyRejected = false
            reentrant.hook = { event in
                if event.phase == .intent, case .create = event.operation {
                    do { _ = try reentrant.adapter.create(requestedName: "utun") } catch Adapter.Failure.busy { busyRejected = true }
                }
            }
            _ = try reentrant.adapter.create(requestedName: "utun")
            check(busyRejected && reentrant.creates == 1, "callback reentry cannot interleave a second mutation")
            let concurrent = DeviceFixture(), concurrentLease = try concurrent.adapter.create(requestedName: "utun")
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), completed = DispatchSemaphore(value: 0)
            concurrent.hook = { event in
                if event.phase == .intent && event.operation == .mtu(1300) { entered.signal(); _ = release.wait(timeout: .now() + 3) }
            }
            DispatchQueue.global().async {
                defer { completed.signal() }
                _ = try? concurrent.adapter.setMTU(concurrentLease.id, to: 1300)
            }
            let didEnter = entered.wait(timeout: .now() + 2) == .success
            check(didEnter, "concurrent writer reaches the injected journal boundary")
            if didEnter {
                let view = concurrent.adapter.view
                check(view.busy && view.unresolved.first?.snapshot?.mtu == 1500 && view.unresolved.first?.ownsHandle == true, "status remains readable and explicitly busy while another thread is blocked in journalling")
                check(Adapter.recoveryViews.first(where: { $0.token === concurrent.adapter.recoveryToken })?.view.busy == true, "recovery registry observation does not wait for a blocked mutation")
                rejects("a concurrent mutation does not wait or interleave behind the journal callback") { _ = try concurrent.adapter.addAddress(concurrentLease.id, address4) }
            }
            release.signal()
            check(completed.wait(timeout: .now() + 2) == .success && !concurrent.adapter.view.busy && concurrent.adapter.unresolved.first?.snapshot?.mtu == 1300, "writer publishes confirmed nonbusy state after the durable boundary resumes")

            let registryBefore = Set(Adapter.recoveryViews.map { $0.token.id })
            let lifecycle = DeviceFixture()
            var externalOwner: Adapter? = lifecycle.relinquishAdapter()
            weak var retainedOwner = externalOwner
            let lifecycleToken = externalOwner!.recoveryToken
            let lifecycleLease = try externalOwner!.create(requestedName: "utun")
            externalOwner = nil
            check(retainedOwner != nil && Adapter.recover(lifecycleToken) === retainedOwner, "dropping every manager reference does not lose a held owner or its exact recovery object")
            check(Set(Adapter.recoveryViews.map { $0.token.id }) == registryBefore.union([lifecycleToken.id]) && Adapter.recoveryViews.first(where: { $0.token === lifecycleToken })?.view.unresolved.first?.id == lifecycleLease.id, "process recovery inventory exposes the generated token and original lease without adopting strings")
            var recoveryOwner = Adapter.recover(lifecycleToken)
            lifecycle.retainInterfaceAfterClose = true
            _ = try recoveryOwner!.close(lifecycleLease.id)
            recoveryOwner = nil
            check(retainedOwner != nil && !lifecycle.held && Adapter.recover(lifecycleToken) != nil, "a closed helper FD with a remaining client copy retains a recoverable owner")
            lifecycle.present = false
            lifecycle.hook = { event in if event.operation == .verifyAbsent { throw FixtureFailure.injected } }
            recoveryOwner = Adapter.recover(lifecycleToken)
            _ = try recoveryOwner!.verifyAbsent(lifecycleLease.id)
            recoveryOwner = nil
            check(retainedOwner != nil && Adapter.recover(lifecycleToken)?.unresolved.first?.phase == .uncertain, "absence journal failure prevents owner deregistration even when the interface is gone")
            lifecycle.hook = nil
            recoveryOwner = Adapter.recover(lifecycleToken)
            check(try recoveryOwner!.verifyAbsent(lifecycleLease.id).deviceAbsentVerified, "explicit recovery after the manager disappears still uses durable absence acknowledgement")
            recoveryOwner = nil
            check(retainedOwner == nil && Adapter.recover(lifecycleToken) == nil && Set(Adapter.recoveryViews.map { $0.token.id }) == registryBefore, "only recorded independent absence releases the final retained owner and restores the registry key set")

            let lostObservation = DeviceFixture()
            var lostOwner: Adapter? = lostObservation.relinquishAdapter()
            weak var heldUnknownOwner = lostOwner
            let lostToken = lostOwner!.recoveryToken
            lostObservation.failSnapshot = true
            let lostLease = try lostOwner!.create(requestedName: "utun")
            lostOwner = nil
            check(heldUnknownOwner != nil && Adapter.recover(lostToken)?.unresolved.first?.ownsHandle == true && Adapter.recover(lostToken)?.unresolved.first?.snapshot == nil, "initial observation failure remains recoverable after its last external owner reference disappears")
            lostObservation.failSnapshot = false
            var recoverLost = Adapter.recover(lostToken)
            _ = try recoverLost!.close(lostLease.id)
            _ = try recoverLost!.verifyAbsent(lostLease.id)
            recoverLost = nil
            check(heldUnknownOwner == nil && Adapter.recover(lostToken) == nil, "recovering an initially unknown identity can release its retained owner only after exact close and absence")
            let changedOwner = DeviceFixture()
            var managerReference: Adapter? = changedOwner.relinquishAdapter()
            weak var preservedForeignOwner = managerReference
            let changedToken = managerReference!.recoveryToken
            let changedLease = try managerReference!.create(requestedName: "utun")
            let originalIdentity = changedOwner.snapshot
            changedOwner.snapshot = Adapter.Snapshot(name: "utun49", index: 78, controlID: 4, controlUnit: 50, mtu: 1500, addressKeys: [])
            _ = try managerReference!.setMTU(changedLease.id, to: 1400)
            managerReference = nil
            var retryForeign = Adapter.recover(changedToken)
            check(try preservedForeignOwner != nil && retryForeign!.close(changedLease.id).ownsHandle && changedOwner.closes == 0, "an identity conflict remains discoverable after manager deallocation and cannot silently close a replacement")
            changedOwner.snapshot = originalIdentity
            _ = try retryForeign!.close(changedLease.id)
            _ = try retryForeign!.verifyAbsent(changedLease.id)
            retryForeign = nil
            check(preservedForeignOwner == nil && Adapter.recover(changedToken) == nil, "explicitly revalidated identity and recorded absence can retire a conflict owner")
            check(Adapter.recover(failedCreate.adapter.recoveryToken)?.unresolved.first?.snapshot == nil && Adapter.recover(failedCreate.adapter.recoveryToken)?.unresolved.first?.phase == .uncertain, "create failure without a session stays visible in recovery inventory instead of disappearing")
            var liveRecords = 0
            let live = Adapter.live(record: { _ in liveRecords += 1 })
            rejects("ordinary UID live create is rejected before journalling or C operations") { _ = try live.create(requestedName: "utun") }
            rejects("ordinary UID live MTU cannot inspect a supplied lease") { _ = try live.setMTU(UUID().uuidString.lowercased(), to: 1400) }
            rejects("ordinary UID live address cannot inspect a supplied lease") { _ = try live.addAddress(UUID().uuidString.lowercased(), address4) }
            rejects("ordinary UID live duplication cannot create an FD") { _ = try live.duplicateForDelivery(UUID().uuidString.lowercased()) }
            rejects("ordinary UID live close cannot touch a handle") { _ = try live.close(UUID().uuidString.lowercased()) }
            rejects("ordinary UID live absence never queries interfaces") { _ = try live.verifyAbsent(UUID().uuidString.lowercased()) }
            let counters = relay_tun_device_test_counters()
            check(liveRecords == 0 && live.unresolved.isEmpty && Adapter.recover(live.recoveryToken) == nil, "production permission refusal is inert and does not create recovery obligations")
            check(counters.socket_calls == 0 && counters.ioctl_calls == 0 && counters.connect_calls == 0 && counters.observe_calls == 0 && counters.fd_calls == 0 && counters.close_calls == 0, "all C live operation counters remain zero")
        } catch { failures.append("runner error: \(error)") }
        let result: [String: Any] = ["tests": total, "passed": total - failures.count, "failures": failures, "actualRootBranchExecuted": false, "actualTunCreated": false, "systemConfigurationChanged": false]
        let bytes = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(decoding: bytes, as: UTF8.self)); exit(failures.isEmpty ? 0 : 1)
    }
}
