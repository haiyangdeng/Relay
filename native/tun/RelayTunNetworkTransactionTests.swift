import Foundation
import Darwin

private typealias Transaction = RelayTunNetworkTransaction
private enum FixtureFailure: Error { case injected }

/// All state is in memory. No actual interface, route, resolver, helper, file,
/// process handle or Mach connection exists in this runner.
private final class NetworkFixture {
    static let original = Transaction.Baseline(networkSHA256: String(repeating: "1", count: 64), protectionSHA256: String(repeating: "2", count: 64))
    let first = Transaction.Change(id: String(repeating: "a", count: 64), kind: .route, beforeSHA256: Transaction.absentSHA256, desiredSHA256: String(repeating: "3", count: 64))
    let second = Transaction.Change(id: String(repeating: "b", count: 64), kind: .resolver, beforeSHA256: Transaction.absentSHA256, desiredSHA256: String(repeating: "4", count: 64))
    var clock: UInt64 = 1000
    var events: [String] = []
    var journal: [Transaction.Event] = []
    var values: [String: String] = [:]
    var unrelatedChange = false
    var protectionChange = false
    var devicePresent = false
    var changeOverride: [Transaction.Change]?
    var failRecord: String?
    var failCreate = false
    var invalidDevice = false
    var interfaceName = "utun49"
    var loseInstallAcknowledgement = false
    var installOutcome = Transaction.Outcome.applied
    var installWrites = true
    var externalDuringInstall = false
    var failRemove = false
    var lostRemoveAcknowledgement = false
    var closeOutcome = Transaction.Outcome.applied
    var duplicateHandleRemains = false
    var externalDuringUndo = false
    var routeRemovalPolicy: Transaction.RouteRemovalPolicy = .perKey
    var foreignAfterRetirement = false
    var failAbsence = false
    var recordHook: ((Transaction.Event) throws -> Void)?
    var acknowledgementHook: ((Transaction.Event) throws -> Void)?
    private var restoringObservations = 0
    lazy var transaction = Transaction(environment: Transaction.Environment(
        inspect: { [unowned self] owned in
            events.append(owned == nil ? "inspect:all" : "inspect:exclude-owned")
            let unexcluded = owned == nil && (devicePresent || values.values.contains(where: { $0 != Transaction.absentSHA256 }))
            return Transaction.Baseline(networkSHA256: unrelatedChange || unexcluded ? String(repeating: "5", count: 64) : Self.original.networkSHA256, protectionSHA256: protectionChange ? String(repeating: "6", count: 64) : Self.original.protectionSHA256)
        },
        create: { [unowned self] _ in
            events.append("create")
            if failCreate { throw FixtureFailure.injected }
            devicePresent = true
            return Transaction.Device(id: invalidDevice ? "old-pid-123" : UUID().uuidString.lowercased(), interface: invalidDevice ? "en0" : interfaceName)
        },
        changes: { [unowned self] _, _ in changeOverride ?? [first, second] },
        observe: { [unowned self] change, _ in
            events.append("observe:" + change.kind.rawValue)
            if externalDuringUndo {
                restoringObservations += 1
                if restoringObservations == 3 { values[change.id] = String(repeating: "f", count: 64) }
            }
            return values[change.id] ?? Transaction.absentSHA256
        },
        install: { [unowned self] change, _, expected in
            events.append("install:" + change.kind.rawValue)
            if externalDuringInstall { values[change.id] = String(repeating: "f", count: 64) }
            guard values[change.id] ?? Transaction.absentSHA256 == expected else { return .unchanged }
            if installWrites { values[change.id] = change.desiredSHA256 }
            if loseInstallAcknowledgement { throw FixtureFailure.injected }
            return installOutcome
        },
        remove: { [unowned self] change, _, expected in
            events.append("remove:" + change.kind.rawValue)
            guard values[change.id] ?? Transaction.absentSHA256 == expected else { return .unchanged }
            if failRemove { return .unchanged }
            values[change.id] = Transaction.absentSHA256
            return lostRemoveAcknowledgement ? .uncertain : .applied
        },
        close: { [unowned self] _ in
            events.append("close")
            if closeOutcome == .applied && !duplicateHandleRemains {
                devicePresent = false
                if routeRemovalPolicy == .ownedDeviceRetirement {
                    for route in (changeOverride ?? [first, second]) where route.kind == .route {
                        if values[route.id] == route.desiredSHA256 { values[route.id] = Transaction.absentSHA256 }
                    }
                    if foreignAfterRetirement { values[first.id] = String(repeating: "f", count: 64) }
                }
            }
            return closeOutcome
        },
        deviceAbsent: { [unowned self] _ in events.append("deviceAbsent"); if failAbsence { throw FixtureFailure.injected }; return !devicePresent },
        record: { [unowned self] event in
            events.append("record:" + event.phase)
            try recordHook?(event)
            if event.phase == failRecord { throw FixtureFailure.injected }
            journal.append(event)
            try acknowledgementHook?(event)
        },
        now: { [unowned self] in clock }, routeRemovalPolicy: routeRemovalPolicy
    ))
    func prepare() throws -> Transaction.Plan { try transaction.prepare(configurationSHA256: String(repeating: "c", count: 64), runtimeConfigurationSHA256: String(repeating: "e", count: 64), effectsSHA256: String(repeating: "d", count: 64)) }
    func acquire() throws -> Transaction.Plan { let plan = try prepare(); _ = try transaction.acquire(plan); return plan }
    func activate(_ plan: Transaction.Plan) throws -> Transaction.Status { try transaction.activate(plan, coreConfigurationSHA256: plan.runtimeConfigurationSHA256, coreReady: true) }
    var installs: [String] { events.filter { $0.hasPrefix("install:") } }
    var removes: [String] { events.filter { $0.hasPrefix("remove:") } }
}

private final class ThreadResult {
    private let lock = NSLock()
    private var result: Result<Transaction.Status, Error>?
    func store(_ value: Result<Transaction.Status, Error>) { lock.lock(); result = value; lock.unlock() }
    func read() -> Result<Transaction.Status, Error>? { lock.lock(); defer { lock.unlock() }; return result }
}

@main struct RelayTunNetworkTransactionTests {
    static func main() {
        var rows: [[String: Any]] = []
        func check(_ passed: Bool, _ name: String) { rows.append(["name": name, "passed": passed]) }
        func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
        func rejectsBusy(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch Transaction.Failure.busy { check(true, name) } catch { check(false, name) } }
        do {
            for name in ["utun0", "utun42", "utun100000", "utun4294967294"] {
                let fixture = NetworkFixture(); fixture.interfaceName = name
                let prepared = try fixture.prepare(), acquired = try fixture.transaction.acquire(prepared)
                check(acquired.phase == .acquired && acquired.ownsDevice && fixture.installs.isEmpty,
                      "returned actual device name fits SDK unit width: " + name)
                _ = try fixture.transaction.restore(prepared)
            }
            for name in ["utun", "utun4294967295", "utun01", "utun000000000001", "utun123456789012", "utun0\n", "utun+1", "utun一"] {
                let fixture = NetworkFixture(); fixture.interfaceName = name
                let prepared = try fixture.prepare(), acquired = try fixture.transaction.acquire(prepared)
                check(acquired.phase == .uncertain && acquired.ownsDevice && fixture.installs.isEmpty,
                      "ambiguous or out-of-width returned device identity stays unresolved: " + name)
            }
            let split = NetworkFixture(), plan = try split.prepare()
            check(split.events == ["inspect:all"] && !split.devicePresent && split.installs.isEmpty, "preparation only observes baseline and never creates a device or changes routing")
            let acquired = try split.transaction.acquire(plan)
            check(acquired.phase == .acquired && acquired.ownsDevice && acquired.potentiallyApplied == 0 && split.installs.isEmpty && split.values.isEmpty, "acquire owns only its unique device before any route or resolver installation")
            check(split.events.firstIndex(of: "record:create_intent")! < split.events.firstIndex(of: "create")!, "creation intent is durable before acquiring a device")
            rejects("unready ordinary-UID core cannot activate traffic") { _ = try split.transaction.activate(plan, coreConfigurationSHA256: plan.configurationSHA256, coreReady: false) }
            check(split.installs.isEmpty && split.transaction.status.ownsDevice, "readiness failure retains acquired device without route/DNS writes")
            rejects("valid but different runtime digest cannot authorize activation") { _ = try split.transaction.activate(plan, coreConfigurationSHA256: String(repeating: "9", count: 64), coreReady: true) }
            check(split.installs.isEmpty, "digest mismatch leaves both route and DNS unchanged")

            let expired = NetworkFixture(), expiredPlan = try expired.acquire(); expired.clock = expiredPlan.expiresAt + 1
            rejects("expired activation proof is refused while retaining owned device") { _ = try expired.activate(expiredPlan) }
            check(expired.transaction.status.ownsDevice && expired.installs.isEmpty, "expired proof does not silently discard the live resource")
            let backwards = NetworkFixture(), backwardsPlan = try backwards.acquire(); backwards.clock = backwardsPlan.createdAt - 1
            rejects("clock reversal cannot revive a preparation") { _ = try backwards.activate(backwardsPlan) }
            let stale = NetworkFixture(), oldPlan = try stale.prepare(), freshPlan = try stale.prepare()
            rejects("replaced preparation cannot be replayed to acquire") { _ = try stale.transaction.acquire(oldPlan) }
            _ = try stale.transaction.acquire(freshPlan)
            rejects("already-acquired preparation is single-use") { _ = try stale.transaction.acquire(freshPlan) }

            let changed = NetworkFixture(), changedPlan = try changed.acquire(); changed.unrelatedChange = true
            rejects("changed external network baseline blocks activation") { _ = try changed.activate(changedPlan) }
            check(changed.installs.isEmpty && changed.transaction.status.ownsDevice, "baseline mismatch performs no corrective write or forced cleanup")
            let protected = NetworkFixture(), protectedPlan = try protected.acquire(); protected.protectionChange = true
            rejects("changed Claude protection baseline blocks activation") { _ = try protected.activate(protectedPlan) }

            let existing = NetworkFixture(), existingPlan = try existing.acquire()
            existing.changeOverride = [Transaction.Change(id: existing.first.id, kind: .route, beforeSHA256: String(repeating: "7", count: 64), desiredSHA256: existing.first.desiredSHA256)]
            rejects("planned replacement of an existing route is refused") { _ = try existing.activate(existingPlan) }
            check(existing.installs.isEmpty, "existing route replacement never reaches adapter mutation")
            let occupied = NetworkFixture(), occupiedPlan = try occupied.acquire(); occupied.values[occupied.second.id] = String(repeating: "8", count: 64)
            rejects("late occupation of any target prevents all first writes") { _ = try occupied.activate(occupiedPlan) }
            check(occupied.installs.isEmpty, "all original target observations pass before the first install")
            let duplicate = NetworkFixture(), duplicatePlan = try duplicate.acquire(); duplicate.changeOverride = [duplicate.first, duplicate.first]
            rejects("duplicate target identities are rejected") { _ = try duplicate.activate(duplicatePlan) }

            let success = NetworkFixture(), successPlan = try success.acquire(), active = try success.activate(successPlan)
            check(active.phase == .active && !active.busy && active.potentiallyApplied == 2 && !active.restorationVerified && !active.actualTunAccepted, "completed activation records both owned effects without a stale busy or actual TUN acceptance claim")
            let events = success.events
            check(events.firstIndex(of: "record:install_intent")! < events.firstIndex(of: "install:route")!, "route mutation follows a recorded install intent")
            rejects("activated plan cannot be replayed for a second installation") { _ = try success.activate(successPlan) }
            let restored = try success.transaction.restore(successPlan)
            check(success.removes == ["remove:resolver", "remove:route"], "explicit restore unwinds resolver and route effects in reverse order")
            check(restored.phase == .restored && restored.restorationVerified && !restored.ownsDevice && !success.devicePresent && !restored.actualTunAccepted, "close followed by matching baseline verifies restoration only")
            check(success.events.last == "record:restored", "confirmed final baseline is recorded after effect removal and device close")

            let lost = NetworkFixture(), lostPlan = try lost.acquire(); lost.loseInstallAcknowledgement = true
            let lostState = try lost.activate(lostPlan)
            check(lostState.phase == .uncertain && lostState.ownsDevice && lostState.potentiallyApplied == 1 && lost.removes.isEmpty, "lost install acknowledgement retains device and possible effect without automatic rollback")
            lost.loseInstallAcknowledgement = false
            check(try lost.transaction.restore(lostPlan).restorationVerified, "explicit recovery observes and undoes a write whose acknowledgement was lost")

            let createJournal = NetworkFixture(), createJournalPlan = try createJournal.prepare(); createJournal.failRecord = "create_intent"
            rejects("failed creation-intent persistence prevents creating an interface") { _ = try createJournal.transaction.acquire(createJournalPlan) }
            check(!createJournal.devicePresent && !createJournal.events.contains("create"), "no device is created without its durable intent")
            let acquiredJournal = NetworkFixture(); acquiredJournal.failRecord = "acquired"; let acquiredJournalPlan = try acquiredJournal.prepare()
            let journalState = try acquiredJournal.transaction.acquire(acquiredJournalPlan)
            check(journalState.phase == .uncertain && journalState.ownsDevice, "failed acquired journal acknowledgement does not lose the returned device")
            acquiredJournal.failRecord = nil
            check(try acquiredJournal.transaction.restore(acquiredJournalPlan).restorationVerified, "explicit release can recover acquired resource after journal failure")

            for failure in ["install_intent", "installed", "active"] {
                let journal = NetworkFixture(), journalPlan = try journal.acquire(); journal.failRecord = failure
                let unknown = try journal.activate(journalPlan)
                check(unknown.phase == .uncertain && unknown.ownsDevice && !unknown.restorationVerified, "\(failure) journal failure preserves ownership and unknown state")
                if failure == "install_intent" { check(journal.installs.isEmpty, "failed install intent prevents the first route mutation") }
                journal.failRecord = nil
                check(try journal.transaction.restore(journalPlan).restorationVerified, "\(failure) journal failure has an explicit observable recovery path")
            }

            let boundary = NetworkFixture(), boundaryPlan = try boundary.acquire(); boundary.externalDuringInstall = true
            let raced = try boundary.activate(boundaryPlan)
            check(raced.phase == .uncertain && boundary.values[boundary.first.id] == String(repeating: "f", count: 64), "adapter mutation-boundary CAS preserves a foreign value after prevalidation")
            check(try boundary.transaction.restore(boundaryPlan).phase == .conflict && boundary.removes.isEmpty, "foreign raced value blocks all removal writes")

            let foreign = NetworkFixture(), foreignPlan = try foreign.acquire(); _ = try foreign.activate(foreignPlan); foreign.values[foreign.first.id] = String(repeating: "f", count: 64)
            let conflict = try foreign.transaction.restore(foreignPlan)
            check(conflict.phase == .conflict && conflict.ownsDevice && foreign.removes.isEmpty && !foreign.events.contains("close"), "foreign modification to any owned key blocks every undo and device close")

            let undoRace = NetworkFixture(), undoPlan = try undoRace.acquire(); _ = try undoRace.activate(undoPlan); undoRace.externalDuringUndo = true
            let undoUnknown = try undoRace.transaction.restore(undoPlan)
            check(undoUnknown.phase == .uncertain && undoUnknown.ownsDevice && undoRace.removes.isEmpty, "external change between undo preflight and mutation is re-observed and not overwritten")
            let removeFailure = NetworkFixture(), removePlan = try removeFailure.acquire(); _ = try removeFailure.activate(removePlan); removeFailure.failRemove = true
            let removalUnknown = try removeFailure.transaction.restore(removePlan)
            check(removalUnknown.phase == .uncertain && removalUnknown.potentiallyApplied == 2 && removalUnknown.ownsDevice, "unconfirmed removal preserves pending identity and does not close device")
            let removeAck = NetworkFixture(), removeAckPlan = try removeAck.acquire(); _ = try removeAck.activate(removeAckPlan); removeAck.lostRemoveAcknowledgement = true
            check(try removeAck.transaction.restore(removeAckPlan).restorationVerified, "observed exact absence can verify a removal despite lost acknowledgement")

            let closeUnknown = NetworkFixture(), closeUnknownPlan = try closeUnknown.acquire(); closeUnknown.closeOutcome = .uncertain
            let closeState = try closeUnknown.transaction.restore(closeUnknownPlan)
            check(closeState.phase == .uncertain && closeState.ownsDevice && !closeState.restorationVerified, "unknown device close retains recovery identity and never claims restoration")
            closeUnknown.closeOutcome = .applied
            check(try closeUnknown.transaction.restore(closeUnknownPlan).restorationVerified, "a later explicit close recovery can verify the unchanged baseline")
            let closeUnchanged = NetworkFixture(), closeUnchangedPlan = try closeUnchanged.acquire(); closeUnchanged.closeOutcome = .unchanged
            let unchangedClose = try closeUnchanged.transaction.restore(closeUnchangedPlan)
            check(unchangedClose.ownsDevice && !unchangedClose.restorationVerified && unchangedClose.phase != .restored, "unchanged close with a still-present interface preserves owned identity")
            let retainedFD = NetworkFixture(), retainedPlan = try retainedFD.acquire(); retainedFD.duplicateHandleRemains = true
            let retainedState = try retainedFD.transaction.restore(retainedPlan)
            check(retainedState.ownsDevice && !retainedState.restorationVerified && retainedState.phase != .restored, "remaining duplicate FD prevents releasing the owned interface identity")

            let external = NetworkFixture(), externalPlan = try external.acquire(); _ = try external.activate(externalPlan); external.unrelatedChange = true
            let externalState = try external.transaction.restore(externalPlan)
            check(externalState.phase == .conflict && !externalState.restorationVerified && external.unrelatedChange && !external.devicePresent, "unrelated network changes survive owned cleanup and block original-baseline acceptance")
            let closeJournal = NetworkFixture(), closeJournalPlan = try closeJournal.acquire(); closeJournal.failRecord = "close_intent"
            let closeJournalState = try closeJournal.transaction.restore(closeJournalPlan)
            check(closeJournalState.phase == .uncertain && closeJournalState.ownsDevice && !closeJournal.events.contains("close"), "failed close-intent record prevents losing the recovery descriptor")
            let finalJournal = NetworkFixture(), finalJournalPlan = try finalJournal.acquire(); finalJournal.failRecord = "restored"
            var verifiedBeforeFinalAcknowledgement = false
            finalJournal.recordHook = { event in
                if event.phase == "restored" { verifiedBeforeFinalAcknowledgement = finalJournal.transaction.status.restorationVerified }
            }
            let finalState = try finalJournal.transaction.restore(finalJournalPlan)
            check(finalState.phase == .uncertain && finalState.ownsDevice && !finalState.restorationVerified && !finalState.actualTunAccepted, "failed final journal never publishes restored phase, verified restoration or actual TUN success")
            check(!verifiedBeforeFinalAcknowledgement && !finalJournal.transaction.status.restorationVerified, "neither in-flight nor settled status confirms restoration before durable final acknowledgement")
            finalJournal.failRecord = nil; finalJournal.recordHook = nil
            check(try finalJournal.transaction.restore(finalJournalPlan).restorationVerified, "an explicit retry can acknowledge the final restored baseline after journal failure")

            let invalid = NetworkFixture(); invalid.invalidDevice = true; let invalidPlan = try invalid.prepare(), invalidState = try invalid.transaction.acquire(invalidPlan)
            check(invalidState.phase == .uncertain && invalidState.ownsDevice && invalid.installs.isEmpty, "invalid returned device identity remains explicit recovery work rather than adopted old PID")
            let invalidate = NetworkFixture(), invalidatePlan = try invalidate.acquire(); invalidate.transaction.invalidatePreparation()
            check(invalidate.transaction.status.ownsDevice && invalidate.transaction.status.phase == .acquired, "sleep invalidation never relabels an acquired resource as an unexecuted plan")
            _ = try invalidate.transaction.restore(invalidatePlan)
            let newPlan = try invalidate.prepare()
            check(newPlan.id != invalidatePlan.id, "new preparation has a fresh session nonce after verified release")

            let revoked = NetworkFixture(), revokedPlan = try revoked.acquire()
            revoked.transaction.invalidatePreparation()
            rejects("sleep revokes activation proof even while the acquired device remains owned") { _ = try revoked.activate(revokedPlan) }
            check(revoked.transaction.status.phase == .acquired && revoked.transaction.status.ownsDevice && revoked.installs.isEmpty, "revocation preserves acquired identity and observed phase without any route mutation")
            revoked.clock = revokedPlan.expiresAt + 1
            check(try revoked.transaction.restore(revokedPlan).restorationVerified && revoked.transaction.status.phase == .restored, "revoked and expired activation proof never prevents explicit restoration")

            let alreadyActive = NetworkFixture(), activePlan = try alreadyActive.acquire(); _ = try alreadyActive.activate(activePlan)
            alreadyActive.transaction.invalidatePreparation()
            check(alreadyActive.transaction.status.phase == .active && alreadyActive.transaction.status.ownsDevice && alreadyActive.removes.isEmpty, "revocation of an active session preserves active facts and never silently restores")
            alreadyActive.clock = activePlan.expiresAt + 1
            check(try alreadyActive.transaction.restore(activePlan).restorationVerified, "active-session recovery remains available after revocation and TTL expiry")

            for mode in ["sleep", "expiry"] {
                let duringCreateRecord = NetworkFixture(), createPlan = try duringCreateRecord.prepare()
                duringCreateRecord.recordHook = { event in
                    if event.phase == "create_intent" {
                        if mode == "sleep" { duringCreateRecord.transaction.invalidatePreparation() }
                        else { duringCreateRecord.clock = event.plan.expiresAt + 1 }
                    }
                }
                rejects("\(mode) during creation journal prevents the subsequent device mutation") { _ = try duringCreateRecord.transaction.acquire(createPlan) }
                check(!duringCreateRecord.devicePresent && !duringCreateRecord.events.contains("create"), "\(mode) creation-journal delay cannot create an interface on stale approval")
            }

            let acquiredRevocation = NetworkFixture(), acquiredRevocationPlan = try acquiredRevocation.prepare()
            acquiredRevocation.recordHook = { event in if event.phase == "acquired" { acquiredRevocation.transaction.invalidatePreparation() } }
            let acquiredRevoked = try acquiredRevocation.transaction.acquire(acquiredRevocationPlan)
            check(acquiredRevoked.phase == .uncertain && acquiredRevoked.ownsDevice && acquiredRevocation.installs.isEmpty, "revocation after device creation retains owned resource but does not publish fresh acquisition approval")
            acquiredRevocation.recordHook = nil
            check(try acquiredRevocation.transaction.restore(acquiredRevocationPlan).restorationVerified, "device created before revocation is recoverable without re-authorizing activation")

            for mode in ["sleep", "expiry"] {
                let duringInstallRecord = NetworkFixture(), installPlan = try duringInstallRecord.acquire()
                duringInstallRecord.recordHook = { event in
                    if event.phase == "install_intent" {
                        if mode == "sleep" { duringInstallRecord.transaction.invalidatePreparation() }
                        else { duringInstallRecord.clock = event.plan.expiresAt + 1 }
                    }
                }
                let stopped = try duringInstallRecord.activate(installPlan)
                check(stopped.phase == .uncertain && stopped.ownsDevice && duringInstallRecord.installs.isEmpty, "\(mode) during install-intent journal blocks the imminent kernel write")
                duringInstallRecord.recordHook = nil
                check(try duringInstallRecord.transaction.restore(installPlan).restorationVerified, "\(mode) before first install retains explicit cleanup capability")
            }

            let afterFirst = NetworkFixture(), afterFirstPlan = try afterFirst.acquire()
            afterFirst.recordHook = { event in if event.phase == "installed" { afterFirst.clock = event.plan.expiresAt + 1 } }
            let partlyInstalled = try afterFirst.activate(afterFirstPlan)
            check(partlyInstalled.phase == .uncertain && afterFirst.installs == ["install:route"] && partlyInstalled.potentiallyApplied == 1, "TTL expiring after first route prevents the second resolver mutation")
            afterFirst.recordHook = nil
            check(try afterFirst.transaction.restore(afterFirstPlan).restorationVerified, "expired partially installed effects can be explicitly undone")

            for mode in ["sleep", "expiry"] {
                let finalApproval = NetworkFixture(), finalPlan = try finalApproval.acquire()
                finalApproval.recordHook = { event in
                    if event.phase == "active" {
                        if mode == "sleep" { finalApproval.transaction.invalidatePreparation() }
                        else { finalApproval.clock = event.plan.expiresAt + 1 }
                    }
                }
                let finalUnknown = try finalApproval.activate(finalPlan)
                check(finalUnknown.phase == .uncertain && finalUnknown.ownsDevice && finalUnknown.potentiallyApplied == 2, "\(mode) in final journal cannot publish the session as newly active")
                finalApproval.recordHook = nil
                check(try finalApproval.transaction.restore(finalPlan).restorationVerified, "\(mode) after installations preserves cleanup of both effects")
            }

            let reentrant = NetworkFixture(), reentrantPlan = try reentrant.prepare()
            var reentryRejected = false, callbackStatusRead = false
            reentrant.recordHook = { event in
                if event.phase == "create_intent" {
                    let observed = reentrant.transaction.status
                    callbackStatusRead = observed.phase == .prepared && observed.busy
                    do { _ = try reentrant.prepare() }
                    catch Transaction.Failure.busy { reentryRejected = true }
                }
            }
            _ = try reentrant.transaction.acquire(reentrantPlan)
            check(reentryRejected && callbackStatusRead && reentrant.transaction.status.phase == .acquired, "same-thread adapter reentry gets busy while status remains readable and original plan survives")
            reentrant.recordHook = nil
            check(try reentrant.transaction.restore(reentrantPlan).restorationVerified, "reentrant preparation cannot replace the acquired resource's recovery plan")

            let concurrent = NetworkFixture(), concurrentPlan = try concurrent.prepare()
            let entered = DispatchSemaphore(value: 0), resume = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0), outcome = ThreadResult()
            concurrent.recordHook = { event in
                if event.phase == "create_intent" { entered.signal(); guard resume.wait(timeout: .now() + 5) == .success else { throw FixtureFailure.injected } }
            }
            DispatchQueue.global().async {
                do { outcome.store(.success(try concurrent.transaction.acquire(concurrentPlan))) }
                catch { outcome.store(.failure(error)) }
                finished.signal()
            }
            let reached = entered.wait(timeout: .now() + 5) == .success
            check(reached, "concurrent fixture reaches an in-flight journal without a real kernel operation")
            if reached {
                rejectsBusy("another connection gets busy preparing during acquisition") { _ = try concurrent.prepare() }
                rejectsBusy("another connection gets busy acquiring the same session concurrently") { _ = try concurrent.transaction.acquire(concurrentPlan) }
                rejectsBusy("another connection gets busy restoring during acquisition") { _ = try concurrent.transaction.restore(concurrentPlan) }
                let observed = concurrent.transaction.status
                check(observed.phase == .prepared && !observed.ownsDevice && observed.busy, "status is readable and explicitly busy during another connection's blocked journal")
                concurrent.transaction.invalidatePreparation()
            }
            resume.signal()
            check(finished.wait(timeout: .now() + 5) == .success, "concurrent revocation and mutation settle without a lock deadlock")
            if case .failure(Transaction.Failure.stale)? = outcome.read() {
                check(!concurrent.devicePresent && !concurrent.events.contains("create"), "revocation from another thread takes effect before blocked acquisition can create")
            } else { check(false, "concurrent acquisition must reject the revoked authorization") }
            check(!concurrent.transaction.status.ownsDevice && !concurrent.transaction.status.busy && concurrent.installs.isEmpty, "settled busy and revocation leave no adopted device or route/DNS effect")

            let activationRace = NetworkFixture(), activationPlan = try activationRace.acquire()
            let installEntered = DispatchSemaphore(value: 0), installResume = DispatchSemaphore(value: 0), installFinished = DispatchSemaphore(value: 0), activationOutcome = ThreadResult()
            activationRace.recordHook = { event in
                if event.phase == "install_intent" { installEntered.signal(); guard installResume.wait(timeout: .now() + 5) == .success else { throw FixtureFailure.injected } }
            }
            DispatchQueue.global().async {
                do { activationOutcome.store(.success(try activationRace.activate(activationPlan))) }
                catch { activationOutcome.store(.failure(error)) }
                installFinished.signal()
            }
            let installationBlocked = installEntered.wait(timeout: .now() + 5) == .success
            check(installationBlocked, "activation pauses after owned-effect intent and before actual adapter install")
            if installationBlocked {
                rejectsBusy("parallel recovery cannot consume a device while activation intends to install") { _ = try activationRace.transaction.restore(activationPlan) }
                rejectsBusy("parallel activation cannot duplicate its pending route effect") { _ = try activationRace.activate(activationPlan) }
                let observed = activationRace.transaction.status
                check(observed.ownsDevice && observed.potentiallyApplied == 1 && observed.phase == .acquired && observed.busy, "status publishes an explicitly busy acquired-resource and pending-effect snapshot during journal I/O")
                activationRace.transaction.invalidatePreparation()
            }
            installResume.signal()
            check(installFinished.wait(timeout: .now() + 5) == .success, "activation revocation from another connection settles without blocking cleanup forever")
            if case let .success(state)? = activationOutcome.read() {
                check(state.phase == .uncertain && state.ownsDevice && activationRace.installs.isEmpty, "inter-thread revocation stops the first route write and retains explicit recovery ownership")
            } else { check(false, "revoked in-flight activation must retain an uncertain owned state") }
            activationRace.recordHook = nil
            check(try activationRace.transaction.restore(activationPlan).restorationVerified, "serialized explicit recovery works after the competing activation has settled")

            let partialRestore = NetworkFixture(), partialPlan = try partialRestore.acquire(); _ = try partialRestore.activate(partialPlan)
            let removeEntered = DispatchSemaphore(value: 0), removeResume = DispatchSemaphore(value: 0), removeFinished = DispatchSemaphore(value: 0), restoreOutcome = ThreadResult()
            partialRestore.recordHook = { event in
                if event.phase == "remove_intent" && event.changes.count == 1 {
                    removeEntered.signal(); guard removeResume.wait(timeout: .now() + 5) == .success else { throw FixtureFailure.injected }
                }
            }
            DispatchQueue.global().async {
                do { restoreOutcome.store(.success(try partialRestore.transaction.restore(partialPlan))) }
                catch { restoreOutcome.store(.failure(error)) }
                removeFinished.signal()
            }
            let partialUndoBlocked = removeEntered.wait(timeout: .now() + 5) == .success
            check(partialUndoBlocked, "recovery pauses after resolver removal but before its final route mutation")
            if partialUndoBlocked {
                let observed = partialRestore.transaction.status
                check(observed.busy && observed.phase == .active && observed.potentiallyApplied == 1 && !observed.restorationVerified, "old active phase during partial restoration is explicitly busy, never a current full-routing claim")
                rejectsBusy("another connection cannot activate against a partially restored session") { _ = try partialRestore.activate(partialPlan) }
            }
            removeResume.signal()
            check(removeFinished.wait(timeout: .now() + 5) == .success, "partial restoration status reads do not deadlock its journal callback")
            if case let .success(state)? = restoreOutcome.read() {
                check(!state.busy && state.phase == .restored && state.restorationVerified && !partialRestore.transaction.status.busy, "completed restoration clears busy in both reply and published status")
            } else { check(false, "partial recovery must settle with a verified restoration reply") }
            try retirement(check: check, rejects: rejects)
        } catch { check(false, "unexpected isolated policy fixture failure") }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let output: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows, "actualTunAccepted": false, "actualKernelOperations": false, "actualRootFileWrites": false, "actualHelperConnection": false, "actualSystemConfigurationChanged": false]
        if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text) }
        exit(passed == rows.count ? 0 : 1)
    }
    private static func retirement(check: (Bool, String) -> Void, rejects: (String, () throws -> Void) -> Void) throws {
        func fixture() -> NetworkFixture { let value = NetworkFixture(); value.routeRemovalPolicy = .ownedDeviceRetirement; return value }
        for timing in ["before", "after"] {
            let value = NetworkFixture(), approved = try value.acquire(); _ = try value.activate(approved)
            var beforeAckCount = 0
            value.recordHook = { event in
                if event.phase == "removed" {
                    beforeAckCount = value.transaction.status.potentiallyApplied
                    if timing == "before" { throw FixtureFailure.injected }
                }
            }
            value.acknowledgementHook = { event in if event.phase == "removed" && timing == "after" { throw FixtureFailure.injected } }
            let pending = try value.transaction.restore(approved)
            check(pending.phase == .uncertain && pending.potentiallyApplied == 2 && pending.ownsDevice && !pending.restorationVerified && beforeAckCount == 2,
                  "per-key \(timing)-ack failure preserves the complete logical pending suffix even during the journal callback")
            check(value.removes == ["remove:resolver"] && !value.events.contains("close"), "per-key \(timing)-ack failure performs no subsequent kernel operation")
            value.recordHook = nil; value.acknowledgementHook = nil
            check(try value.transaction.restore(approved).restorationVerified && value.removes == ["remove:resolver", "remove:route"], "per-key \(timing)-ack retry re-observes absence and does not repeat the completed removal")
        }
        let replaced = NetworkFixture(), replacedPlan = try replaced.acquire(); _ = try replaced.activate(replacedPlan)
        replaced.failRecord = "removed"; _ = try replaced.transaction.restore(replacedPlan); replaced.failRecord = nil
        replaced.values[replaced.second.id] = replaced.second.desiredSHA256
        let replacement = try replaced.transaction.restore(replacedPlan)
        check(replacement.phase == .conflict && replacement.ownsDevice && replacement.potentiallyApplied == 2 && replaced.removes == ["remove:resolver"] && !replaced.events.contains("close"),
              "a reappearing key after uncertain removal acknowledgement is preserved even when its bytes equal the previous desired value")
        let owned = fixture(), plan = try owned.acquire()
        check(plan.routeRemovalPolicy == .ownedDeviceRetirement, "device retirement policy is part of the exact approved plan")
        _ = try owned.activate(plan)
        let state = try owned.transaction.restore(plan)
        check(state.phase == .restored && state.restorationVerified && !state.ownsDevice && !state.actualTunAccepted, "owned device retirement restores only after absence, complete baseline and durable final acknowledgement")
        check(owned.removes == ["remove:resolver"] && !owned.events.contains("remove:route"), "owned retirement never invokes a key-based route delete callback")
        let resolverIndex = owned.events.firstIndex(of: "remove:resolver")!, retireIndex = owned.events.firstIndex(of: "record:retire_device_intent")!, closeIndex = owned.events.firstIndex(of: "close")!
        check(resolverIndex < retireIndex && retireIndex < closeIndex && owned.events[closeIndex...].contains("deviceAbsent"), "resolver undo precedes durable device retirement intent, close and independent disappearance proof")
        check(owned.journal.first(where: { $0.phase == "retire_device_intent" })?.changes == [owned.first], "retirement intent retains the complete pending route prefix")
        var changedPlan = plan; changedPlan.routeRemovalPolicy = .perKey
        rejects("changing only the route cleanup policy cannot reuse an existing recovery plan") { _ = try owned.transaction.restore(changedPlan) }

        let misordered = fixture(), misorderedPlan = try misordered.acquire()
        misordered.changeOverride = [misordered.second, misordered.first]
        rejects("owned retirement rejects routes after a resolver before the first installation") { _ = try misordered.activate(misorderedPlan) }
        check(misordered.installs.isEmpty && misordered.transaction.status.potentiallyApplied == 0, "invalid route/resolver ordering has no network mutation callbacks")
        let perKey = NetworkFixture(), perKeyPlan = try perKey.acquire(); perKey.changeOverride = [perKey.second, perKey.first]
        _ = try perKey.activate(perKeyPlan); _ = try perKey.transaction.restore(perKeyPlan)
        check(perKey.removes == ["remove:route", "remove:resolver"] && perKeyPlan.routeRemovalPolicy == .perKey, "default per-key policy keeps its existing order and removal behavior")

        let duplicate = fixture(), duplicatePlan = try duplicate.acquire(); _ = try duplicate.activate(duplicatePlan)
        duplicate.duplicateHandleRemains = true
        let held = try duplicate.transaction.restore(duplicatePlan)
        check(held.phase == .uncertain && held.ownsDevice && held.potentiallyApplied == 1 && !held.restorationVerified && !duplicate.events.contains("remove:route"), "a surviving ordinary-UID core FD preserves logical route ownership after helper close")
        duplicate.duplicateHandleRemains = false
        check(try duplicate.transaction.restore(duplicatePlan).restorationVerified, "explicit retry after the last duplicate disappears can finish retirement without route deletion")

        let before = fixture(), beforePlan = try before.acquire(); _ = try before.activate(beforePlan)
        before.values[before.first.id] = String(repeating: "f", count: 64)
        let conflict = try before.transaction.restore(beforePlan)
        check(conflict.phase == .conflict && conflict.ownsDevice && before.removes.isEmpty && !before.events.contains("close"), "a foreign route found in the all-key preflight prevents resolver writes and device close")
        let raced = fixture(), racedPlan = try raced.acquire(); _ = try raced.activate(racedPlan)
        raced.recordHook = { if $0.phase == "retire_device_intent" { raced.values[raced.first.id] = String(repeating: "f", count: 64) } }
        let racedState = try raced.transaction.restore(racedPlan)
        check(racedState.phase == .conflict && racedState.ownsDevice && !raced.events.contains("close") && raced.values[raced.first.id] == String(repeating: "f", count: 64), "observed replacement after the retirement journal boundary is preserved without closing or deleting")
        let after = fixture(), afterPlan = try after.acquire(); _ = try after.activate(afterPlan); after.foreignAfterRetirement = true
        let afterState = try after.transaction.restore(afterPlan)
        check(afterState.phase == .conflict && afterState.ownsDevice && afterState.potentiallyApplied == 1 && !afterState.restorationVerified && after.values[after.first.id] == String(repeating: "f", count: 64), "a replacement moved to another interface survives kernel retirement and remains an explicit conflict")
        check(after.removes == ["remove:resolver"] && !after.devicePresent, "route conflict after interface disappearance never triggers a key-based repair")

        for failure in ["retire_intent", "close", "absence", "route_removed_before_ack", "route_removed_after_ack", "close_intent", "final_record"] {
            let value = fixture(), approved = try value.acquire(); _ = try value.activate(approved)
            switch failure {
            case "retire_intent": value.failRecord = "retire_device_intent"
            case "close": value.closeOutcome = .uncertain
            case "absence": value.failAbsence = true
            case "route_removed_before_ack": value.recordHook = { if $0.phase == "removed" && $0.changes.isEmpty { throw FixtureFailure.injected } }
            case "route_removed_after_ack": value.acknowledgementHook = { if $0.phase == "removed" && $0.changes.isEmpty { throw FixtureFailure.injected } }
            case "close_intent": value.failRecord = "close_intent"
            default: value.failRecord = "restored"
            }
            let unknown = try value.transaction.restore(approved)
            check(unknown.phase == .uncertain && unknown.ownsDevice && !unknown.restorationVerified && !unknown.actualTunAccepted, "\(failure) retains logical ownership and never publishes completed restoration")
            if failure == "retire_intent" { check(!value.events.contains("close") && unknown.potentiallyApplied == 1, "failed retirement intent prevents dropping the recovery descriptor") }
            if failure.hasPrefix("route_removed") { check(unknown.potentiallyApplied == 1 && !value.devicePresent, "failed route absence acknowledgement retains its full pending identity after device close") }
            value.failRecord = nil; value.recordHook = nil; value.acknowledgementHook = nil; value.closeOutcome = .applied; value.failAbsence = false
            check(try value.transaction.restore(approved).restorationVerified && !value.events.contains("remove:route"), "\(failure) has an explicit re-observed retry without route deletion")
        }
        let resolverAck = fixture(), resolverAckPlan = try resolverAck.acquire(); _ = try resolverAck.activate(resolverAckPlan)
        resolverAck.recordHook = { if $0.phase == "removed" && $0.changes.count == 1 { throw FixtureFailure.injected } }
        let pendingResolver = try resolverAck.transaction.restore(resolverAckPlan)
        check(pendingResolver.potentiallyApplied == 2 && pendingResolver.ownsDevice && !resolverAck.events.contains("close"), "resolver acknowledgement failure preserves the original pending suffix before retiring the device")
        resolverAck.recordHook = nil
        check(try resolverAck.transaction.restore(resolverAckPlan).restorationVerified, "reaffirming observed resolver absence permits a later explicit device retirement")
        let external = fixture(), externalPlan = try external.acquire(); _ = try external.activate(externalPlan); external.unrelatedChange = true
        let externallyChanged = try external.transaction.restore(externalPlan)
        check(externallyChanged.phase == .conflict && !externallyChanged.restorationVerified && !externallyChanged.ownsDevice && external.unrelatedChange && !external.events.contains("remove:route"), "external global changes remain intact and keep final verified false after owned interface retirement")
    }
}
