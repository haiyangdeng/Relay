import Foundation
import Darwin

private final class BridgeStorage {
    var bytes: Data?
    var syncFailure = false
    var compareCount = 0
    var syncCount = 0
    var hook: (() throws -> Void)?
    var storage: RelayTunNetworkJournal.Storage {
        .init(read: { self.bytes }, compareExchange: { expected, replacement in
            guard self.bytes.map(RelayTunHelperTrust.digest) == expected else { return false }
            self.compareCount += 1; self.bytes = replacement; try self.hook?(); return true
        }, sync: { self.syncCount += 1; if self.syncFailure { throw RelayTunTransactionJournal.Failure.uncertain } })
    }
}

@main struct RelayTunTransactionJournalTests {
    static func main() throws {
        var rows: [[String: Any]] = []
        func check(_ value: Bool, _ name: String) { rows.append(["name": name, "passed": value]) }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); check(false, name) } catch { check(true, name) }
        }
        let effects = try EffectsFixture.set(), plan = EffectsFixture.plan(), owned = RelayTunNetworkTransaction.Device(id: effects.device.id, interface: effects.device.interface.name)
        let store = BridgeStorage()
        var realizedCount = 0, verifiedCount = 0, observations = 0
        let bridge = try RelayTunTransactionJournal(plan: plan, installationRevision: String(repeating: "f", count: 64), clientUID: 501,
            storage: store.storage, realize: { _ in realizedCount += 1; return effects }, verifyRealization: { observedPlan, observedEffects in
                guard observedPlan == plan, observedEffects == effects else { throw RelayTunTransactionJournal.Failure.invalid }; verifiedCount += 1
            }, observeRestoration: { _ in
                observations += 1
                return try .init(networkSHA256: plan.baseline.networkSHA256, protectionSHA256: plan.baseline.protectionSHA256, deviceAbsent: true)
            })
        func event(_ phase: String, _ device: RelayTunNetworkTransaction.Device? = owned, _ changes: [RelayTunNetworkTransaction.Change] = []) -> RelayTunNetworkTransaction.Event {
            .init(phase: phase, plan: plan, device: device, changes: changes)
        }
        check(store.bytes == nil && store.compareCount == 0, "opening an empty bridge does not create a recovery record")
        rejects("acquired cannot skip the durable creation intent") { try bridge.record(event("acquired")) }
        check(realizedCount == 0 && verifiedCount == 0, "out-of-order acquisition cannot invoke the trusted live realization provider")
        // Use a fresh bridge after a rejected transition: no mutable network
        // resource exists in this runner and no live operation was attempted.
        let clean = BridgeStorage()
        let fresh = try RelayTunTransactionJournal(plan: plan, installationRevision: String(repeating: "f", count: 64), clientUID: 501,
            storage: clean.storage, realize: { _ in realizedCount += 1; return effects }, verifyRealization: { _, _ in verifiedCount += 1 },
            observeRestoration: { _ in observations += 1; return try .init(networkSHA256: plan.baseline.networkSHA256, protectionSHA256: plan.baseline.protectionSHA256, deviceAbsent: true) })
        try fresh.record(event("create_intent", nil)); try fresh.record(event("acquired"))
        let recorded = try RelayTunNetworkJournal.Snapshot.decode(clean.bytes!)
        check(recorded.realizedEffects == effects && recorded.phase == .acquired, "acquired record contains the entire realized recovery effect set")
        check(try recorded.realizedEffects!.sha256 != plan.effectsSHA256, "approved projection and realized device digests are not conflated")
        check(realizedCount == 1 && verifiedCount == 1, "realization is checked once then retained intact for recovery after FD closure")
        let changes = try effects.changes()
        let wrongChange = RelayTunNetworkTransaction.Change(id: changes[0].id, kind: changes[0].kind, beforeSHA256: changes[0].beforeSHA256, desiredSHA256: String(repeating: "0", count: 64))
        rejects("pending changes cannot use a target ID to replace its exact recovery value") { try fresh.record(event("install_intent", owned, [wrongChange])) }
        check(clean.compareCount == 2, "invalid pending changes leave the acquired journal unchanged")
        try fresh.record(event("install_intent", owned, [changes[0]])); try fresh.record(event("installed", owned, [changes[0]]))
        try fresh.record(event("remove_intent", owned, [changes[0]])); try fresh.record(event("removed"))
        try fresh.record(event("close_intent")); try fresh.record(event("restored"))
        check(try RelayTunNetworkJournal.Snapshot.decode(clean.bytes!).phase == .restored && observations == 1, "terminal record requires an independent full-baseline and device absence observation")
        check(clean.compareCount == clean.syncCount && clean.compareCount == 8, "every accepted lifecycle event is synchronized before acknowledgement")
        var changedPlan = plan; changedPlan.routeRemovalPolicy = .ownedDeviceRetirement
        rejects("same hashes cannot substitute a different route retirement policy") { try fresh.record(.init(phase: "close_intent", plan: changedPlan, device: owned, changes: [])) }
        rejects("unknown event names cannot become stored lifecycle authority") { try fresh.record(event("ready_and_protected")) }

        let failed = BridgeStorage()
        let uncertain = try RelayTunTransactionJournal(plan: plan, installationRevision: String(repeating: "f", count: 64), clientUID: 501,
            storage: failed.storage, realize: { _ in effects }, verifyRealization: { _, _ in }, observeRestoration: { _ in throw RelayTunTransactionJournal.Failure.invalid })
        failed.syncFailure = true
        rejects("failed durability is not accepted as a successful transaction event") { try uncertain.record(event("create_intent", nil)) }
        check(failed.bytes != nil, "unconfirmed publication remains available for explicit recovery inspection")
        rejects("an uncertain writer cannot silently continue a network lifecycle") { try uncertain.record(event("acquired")) }

        let rejected = BridgeStorage()
        let untrusted = try RelayTunTransactionJournal(plan: plan, installationRevision: String(repeating: "f", count: 64), clientUID: 501,
            storage: rejected.storage, realize: { _ in effects }, verifyRealization: { _, _ in throw RelayTunTransactionJournal.Failure.invalid },
            observeRestoration: { _ in throw RelayTunTransactionJournal.Failure.invalid })
        try untrusted.record(event("create_intent", nil))
        rejects("realized effects need the mandatory trusted projection mapping proof") { try untrusted.record(event("acquired")) }
        check(try RelayTunNetworkJournal.Snapshot.decode(rejected.bytes!).phase == .createIntent, "rejected realization cannot publish acquired ownership")

        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let result: [String: Any] = ["checks": rows.count, "passed": passed, "actualRootFileWrites": false, "actualKernelOperations": false, "actualHelperConnection": false, "actualTunAccepted": false, "rows": rows]
        print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
        if passed != rows.count { exit(1) }
    }
}
