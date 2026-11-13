import Foundation
import Darwin

private enum InjectedFailure: Error { case storage }
private final class MemoryJournal {
    var data: Data?
    var events: [String] = []
    var writes = 0
    var failRead = false, failSync = false, throwBeforeWrite = false, throwAfterWrite = false, partialWrite = false
    var beforeCAS: (() -> Void)?
    var duringSync: (() -> Void)?
    var afterRead: (() -> Void)?
    var storage: Journal.Storage { .init(read: { [unowned self] in
        events.append("read"); if failRead { throw InjectedFailure.storage }; let result = data; afterRead?(); return result
    }, compareExchange: { [unowned self] expected, replacement in
        events.append("cas"); beforeCAS?()
        guard data.map(RelayTunHelperTrust.digest) == expected else { return false }
        if throwBeforeWrite { throw InjectedFailure.storage }
        writes += 1; data = partialWrite ? Data(replacement.prefix(replacement.count / 2)) : replacement
        if throwAfterWrite { throw InjectedFailure.storage }; return true
    }, sync: { [unowned self] in
        events.append("sync"); duringSync?(); if failSync { throw InjectedFailure.storage }
    }) }
}

@main struct RelayTunNetworkJournalTests {
    static func main() {
        var rows: [[String: Any]] = []
        func check(_ passed: Bool, _ name: String) { rows.append(["name": name, "passed": passed]) }
        func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
        do {
            try RelayTunNetworkEffectsTests.run(check: check, rejects: rejects)
            let binding = try EffectsFixture.binding(), effects = try EffectsFixture.set(), ids = try effects.changes().map(\.id)
            let initial = try Journal.Snapshot(binding: binding, sequence: 0, phase: .createIntent, realizedEffects: nil, pendingIDs: [])
            func value(_ sequence: UInt32, _ phase: Journal.Phase, _ pending: [String], observation: Journal.Observation? = nil) throws -> Journal.Snapshot {
                try .init(binding: binding, sequence: sequence, phase: phase, realizedEffects: effects, pendingIDs: pending, observation: observation)
            }
            let observation = try Journal.Observation(networkSHA256: binding.networkSHA256, protectionSHA256: binding.protectionSHA256, deviceAbsent: true)
            let acquired = try value(1, .acquired, [])
            let memory = MemoryJournal(), writer = Journal.Writer(binding: binding, storage: memory.storage)
            check(try writer.open() == nil, "a successful empty storage read opens an unused journal without writing")
            check(try writer.record(initial) == .confirmed(RelayTunHelperTrust.digest(initial.encoded())), "creation intent is acknowledged only after compare-exchange, sync and exact readback")
            check(memory.events == ["read", "read", "cas", "sync", "read"], "durability and readback happen after CAS and before an intent acknowledgement")
            let phases: [(Journal.Phase, [String])] = [(.acquired, []), (.installIntent, [ids[0]]), (.installed, [ids[0]]),
                (.installIntent, ids), (.installed, ids), (.active, ids), (.removeIntent, ids), (.removed, [ids[0]]),
                (.removeIntent, [ids[0]]), (.removed, []), (.closeIntent, []), (.restored, [])]
            for (index, phase) in phases.enumerated() {
                let snapshot = try value(UInt32(index + 1), phase.0, phase.1, observation: phase.0 == .restored ? observation : nil)
                let expected = try RelayTunHelperTrust.digest(snapshot.encoded())
                check(try writer.record(snapshot) == .confirmed(expected), "durable ordered stage accepted: \(phase.0.rawValue)")
            }
            check(!writer.restorationVerified && !writer.actualTunAccepted, "even a durable restored record does not itself claim real network or TUN acceptance")
            check(try Journal.Snapshot.decode(memory.data!).realizedEffects == effects, "terminal record retains every route/resolver/device field for audit")
            let reopened = Journal.Writer(binding: binding, storage: memory.storage)
            check(try reopened.open()?.phase == .restored && !reopened.restorationVerified, "reopening a saved final phase does not promote it into live restoration evidence")
            rejects("a terminal journal cannot be silently reused for a new create intent") { _ = try reopened.record(initial) }

            let skip = MemoryJournal(), skipWriter = Journal.Writer(binding: binding, storage: skip.storage)
            try skipWriter.open(); _ = try skipWriter.record(initial); _ = try skipWriter.record(acquired)
            let writesBeforeSkip = skip.writes
            rejects("active cannot skip durable install intent and installed stages") { _ = try skipWriter.record(value(2, .active, ids)) }
            check(skip.writes == writesBeforeSkip, "an invalid phase edge makes no storage write")
            rejects("pending effects must be the exact ordered prefix") { _ = try value(2, .installIntent, [ids[1]]) }
            rejects("a close intent cannot retain effects still requiring recovery") { _ = try value(7, .closeIntent, ids) }
            rejects("restored requires an independent device-absence and baseline observation") { _ = try value(12, .restored, []) }
            rejects("a surviving duplicate descriptor cannot be recorded as restored") { _ = try value(12, .restored, [], observation: .init(networkSHA256: binding.networkSHA256, protectionSHA256: binding.protectionSHA256, deviceAbsent: false)) }
            rejects("external network changes cannot be labeled restored") { _ = try value(12, .restored, [], observation: .init(networkSHA256: String(repeating: "1", count: 64), protectionSHA256: binding.protectionSHA256, deviceAbsent: true)) }
            let changed = try value(12, .closedExternalChange, [], observation: .init(networkSHA256: String(repeating: "1", count: 64), protectionSHA256: binding.protectionSHA256, deviceAbsent: true))
            check(changed.phase == .closedExternalChange, "positive device absence with another network change remains an explicit conflict record")

            for variant in ["revision", "uid", "configuration", "runtime", "effects", "plan"] {
                var raw = try initial.json, changedBinding = binding.json
                switch variant {
                case "revision": changedBinding["installationRevision"] = String(repeating: "2", count: 64)
                case "uid": changedBinding["clientUID"] = 502
                case "configuration": changedBinding["configurationSHA256"] = String(repeating: "2", count: 64)
                case "runtime": changedBinding["runtimeConfigurationSHA256"] = String(repeating: "2", count: 64)
                case "effects": changedBinding["effectsSHA256"] = String(repeating: "2", count: 64)
                default: changedBinding["planID"] = EffectsFixture.deviceID
                }
                raw["binding"] = changedBinding
                let occupied = MemoryJournal(); occupied.data = try Effects.bytes(raw)
                let other = Journal.Writer(binding: binding, storage: occupied.storage)
                rejects("opening a journal bound to another \(variant) is refused") { _ = try other.open() }
                check(occupied.writes == 0 && other.state == .conflict, "wrong \(variant) remains untouched and blocks the writer")
            }
            var acquiredRaw = try acquired.json
            acquiredRaw["realizedEffectsSHA256"] = String(repeating: "3", count: 64)
            rejects("a stale realized-effects digest cannot authenticate modified recovery payloads") { _ = try Journal.Snapshot.decode(Effects.bytes(acquiredRaw)) }
            var initialRaw = try initial.json; initialRaw["unknown"] = "value"
            rejects("unknown top-level journal fields are refused") { _ = try Journal.Snapshot.decode(Effects.bytes(initialRaw)) }
            for invalid: Any in [true, -1, 0.25, "0", UInt64(UInt32.max) + 1] {
                var raw = try initial.json; raw["sequence"] = invalid
                rejects("invalid journal sequence is refused: \(invalid)") { _ = try Journal.Snapshot.decode(Effects.bytes(raw)) }
            }
            for invalid: Any in ["01000", 1000, "18446744073709551616"] {
                var raw = try initial.json, b = binding.json; b["createdAt"] = invalid; raw["binding"] = b
                rejects("ambiguous full-width preparation clock is refused: \(invalid)") { _ = try Journal.Snapshot.decode(Effects.bytes(raw)) }
            }
            let duplicate = String(data: try initial.encoded(), encoding: .utf8)!.replacingOccurrences(of: "\"clientUID\":501", with: "\"clientUID\":501,\"clientUID\":501")
            rejects("duplicate nested journal binding keys are refused before decoding") { _ = try Journal.Snapshot.decode(Data(duplicate.utf8)) }
            rejects("oversized recovery journals are refused") { _ = try Journal.Snapshot.decode(Data(repeating: 32, count: Effects.maximumBytes + 1)) }

            for failure in ["read", "beforeWrite", "afterWrite", "partial", "sync", "readback"] {
                let disk = MemoryJournal(), uncertain = Journal.Writer(binding: binding, storage: disk.storage)
                try uncertain.open()
                switch failure {
                case "read": disk.failRead = true
                case "beforeWrite": disk.throwBeforeWrite = true
                case "afterWrite": disk.throwAfterWrite = true
                case "partial": disk.partialWrite = true
                case "sync": disk.failSync = true
                default: disk.duringSync = { disk.failRead = true }
                }
                check(try uncertain.record(initial) == .uncertain && uncertain.state == .uncertain, "\(failure) cannot acknowledge a durable mutation intent")
                check(uncertain.lastConfirmed == nil && !uncertain.restorationVerified, "\(failure) retains unknown persistence without claiming restored state")
                let writes = disk.writes
                rejects("\(failure) writer cannot retry through an unknown stored state") { _ = try uncertain.record(initial) }
                check(disk.writes == writes, "\(failure) retry rejection does not overwrite residual storage")
            }
            let partial = MemoryJournal(); partial.data = Data("{\"version\":1".utf8)
            let partialWriter = Journal.Writer(binding: binding, storage: partial.storage)
            rejects("an existing partial journal is not treated as original absence") { _ = try partialWriter.open() }
            check(partial.writes == 0 && partialWriter.state == .uncertain, "malformed recovery evidence is retained for explicit resolution")
            let oversized = MemoryJournal(); oversized.data = Data(repeating: 32, count: Effects.maximumBytes + 1)
            let oversizedWriter = Journal.Writer(binding: binding, storage: oversized.storage)
            rejects("an oversized stored object is refused before hashing or decoding") { _ = try oversizedWriter.open() }
            check(oversized.writes == 0 && oversized.data?.count == Effects.maximumBytes + 1, "oversized unknown storage is preserved without cleanup")

            let recover = MemoryJournal(), pendingIntent = try value(7, .removeIntent, ids)
            recover.data = try pendingIntent.encoded()
            let recovering = Journal.Writer(binding: binding, storage: recover.storage)
            check(try recovering.open()?.pendingIDs == ids, "reopening a removal intent retains all still-possibly-owned effect descriptions")
            check(try recovering.record(value(8, .removeIntent, ids)) == .confirmed(RelayTunHelperTrust.digest(value(8, .removeIntent, ids).encoded())), "explicit recovery may durably reaffirm the same undo intent without changing its scope")
            let sameClose = try value(11, .closeIntent, []), closeRecovery = MemoryJournal(); closeRecovery.data = try sameClose.encoded()
            let closing = Journal.Writer(binding: binding, storage: closeRecovery.storage); try closing.open()
            check(try closing.record(value(12, .closeIntent, [])) == .confirmed(RelayTunHelperTrust.digest(value(12, .closeIntent, []).encoded())), "explicit recovery may durably reaffirm close intent without claiming device absence")
            check(!closing.restorationVerified, "a repeated close intent provides no independent interface-disappearance evidence")

            for timing in ["beforeRead", "atCAS", "duringSync"] {
                let external = MemoryJournal(), guarded = Journal.Writer(binding: binding, storage: external.storage), foreign = Data("unknown external contents".utf8)
                try guarded.open()
                if timing == "beforeRead" { external.data = foreign }
                else if timing == "atCAS" { external.beforeCAS = { external.data = foreign } }
                else { external.duringSync = { external.data = foreign } }
                let result = try guarded.record(initial)
                check(result == (timing == "duringSync" ? .uncertain : .conflict), "external change \(timing) blocks durable acknowledgement")
                check(external.data == foreign && !guarded.restorationVerified, "external contents \(timing) are not overwritten or cleared as recovery")
            }
            let recursive = MemoryJournal(), recursiveWriter = Journal.Writer(binding: binding, storage: recursive.storage)
            try recursiveWriter.open(); var reentryRefused = false
            recursive.beforeCAS = { do { _ = try recursiveWriter.record(initial) } catch { reentryRefused = true } }
            check(try recursiveWriter.record(initial) == .confirmed(RelayTunHelperTrust.digest(initial.encoded())) && reentryRefused && recursive.writes == 1, "storage callback re-entry is refused without losing the outer intent")

            try integration(binding: binding, effects: effects, check: check)
            try retirement(check: check, rejects: rejects)
        } catch { check(false, "unexpected fixture error: \(error)") }
        let failed = rows.filter { $0["passed"] as? Bool != true }.count
        let report: [String: Any] = ["passed": failed == 0, "checksPassed": rows.count - failed, "checksTotal": rows.count,
            "actualRootFileAccess": false, "actualMachConnection": false, "actualNetworkChanged": false, "actualTunAccepted": false, "checks": rows]
        if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) { FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10])) }
        exit(failed == 0 ? 0 : 1)
    }

    private static func integration(binding: Journal.Binding, effects: Effects.EffectSet, check: (Bool, String) -> Void) throws {
        typealias Transaction = RelayTunNetworkTransaction
        for failAt in ["none", "create_intent", "acquired", "install_intent", "restored"] {
            let memory = MemoryJournal()
            var writer: Journal.Writer!
            var realized: Effects.EffectSet!
            var approvedBinding: Journal.Binding!
            var devicePresent = false, creates = 0, installs = 0, intentSeenBeforeInstall = true, values: [String: String] = [:]
            let original = EffectsFixture.plan().baseline
            let transaction = Transaction(environment: .init(inspect: { owned in
                if owned == nil && (devicePresent || !values.isEmpty) { return .init(networkSHA256: String(repeating: "1", count: 64), protectionSHA256: original.protectionSHA256) }
                return original
            }, create: { _ in creates += 1; devicePresent = true; return .init(id: effects.device.id, interface: effects.device.interface.name) },
               changes: { _, _ in try realized.changes() }, observe: { change, _ in values[change.id] ?? Transaction.absentSHA256 },
               install: { change, _, expected in
                   let retained = try memory.data.map(Journal.Snapshot.decode)
                   intentSeenBeforeInstall = intentSeenBeforeInstall && retained?.phase == .installIntent && retained?.pendingIDs.last == change.id
                   guard values[change.id] ?? Transaction.absentSHA256 == expected else { return .unchanged }
                   installs += 1; values[change.id] = change.desiredSHA256; return .applied
               }, remove: { change, _, expected in
                   guard values[change.id] == expected else { return .unchanged }; values.removeValue(forKey: change.id); return .applied
               }, close: { _ in devicePresent = false; return .applied }, deviceAbsent: { _ in !devicePresent },
               record: { event in
                   guard let phase = Journal.Phase(rawValue: event.phase) else { throw InjectedFailure.storage }
                   guard try Journal.Binding(installationRevision: binding.installationRevision, clientUID: binding.clientUID, plan: event.plan) == approvedBinding else { throw InjectedFailure.storage }
                   memory.failSync = event.phase == failAt
                   let sequence = writer.lastConfirmed.map { $0.sequence + 1 } ?? 0
                   let observation = phase == .restored ? try Journal.Observation(networkSHA256: original.networkSHA256, protectionSHA256: original.protectionSHA256, deviceAbsent: !devicePresent) : nil
                   let snapshot = try Journal.Snapshot(binding: approvedBinding, sequence: sequence, phase: phase, realizedEffects: event.device == nil ? nil : realized, pendingIDs: event.changes.map(\.id), observation: observation)
                   guard case .confirmed = try writer.record(snapshot) else { throw InjectedFailure.storage }
               }, now: { 1000 }))
            let plan = try transaction.prepare(configurationSHA256: binding.configurationSHA256, runtimeConfigurationSHA256: binding.runtimeConfigurationSHA256, effectsSHA256: binding.effectsSHA256)
            approvedBinding = try .init(installationRevision: binding.installationRevision, clientUID: binding.clientUID, plan: plan)
            realized = try .init(planID: plan.id, device: effects.device, effects: [.route(EffectsFixture.route()), .resolver(EffectsFixture.resolver(planID: plan.id))])
            writer = Journal.Writer(binding: approvedBinding, storage: memory.storage)
            try writer.open()
            if failAt == "create_intent" {
                do { _ = try transaction.acquire(plan) } catch { }
                check(creates == 0 && !devicePresent && installs == 0 && writer.state == .uncertain, "failed durable create intent prevents the injected device mutation")
                continue
            }
            _ = try transaction.acquire(plan)
            if failAt == "acquired" {
                check(transaction.status.phase == .uncertain && transaction.status.ownsDevice && devicePresent && installs == 0, "failed acquired journal sync preserves the returned device identity")
                continue
            }
            _ = try transaction.activate(plan, coreConfigurationSHA256: binding.runtimeConfigurationSHA256, coreReady: true)
            if failAt == "install_intent" {
                check(installs == 0 && transaction.status.phase == .uncertain && transaction.status.ownsDevice, "failed effect intent persistence blocks all injected route/resolver writes")
                continue
            }
            let restored = try transaction.restore(plan)
            if failAt == "restored" {
                check(restored.phase == .uncertain && writer.state == .uncertain && !writer.restorationVerified, "final sync failure retains uncertain journal status despite successful injected undo")
            } else {
                check(installs == 2 && intentSeenBeforeInstall && restored.phase == .restored && !devicePresent && values.isEmpty, "transaction writes each typed intent before its injected effect and reverses both effects")
                check(try writer.lastConfirmed?.encoded() == memory.data && writer.lastConfirmed?.phase == .restored, "completed injected restoration retains the exact durable recovery record")
            }
        }
    }
    private static func retirement(check: (Bool, String) -> Void, rejects: (String, () throws -> Void) -> Void) throws {
        typealias Transaction = RelayTunNetworkTransaction
        var plan = EffectsFixture.plan(); plan.routeRemovalPolicy = .ownedDeviceRetirement
        let binding = try Journal.Binding(installationRevision: String(repeating: "f", count: 64), clientUID: 501, plan: plan)
        let effects = try EffectsFixture.set(), ids = try effects.changes().map(\.id)
        func value(_ sequence: UInt32, _ phase: Journal.Phase, _ pending: [String]) throws -> Journal.Snapshot {
            try .init(binding: binding, sequence: sequence, phase: phase, realizedEffects: effects, pendingIDs: pending,
                      observation: phase == .restored ? .init(networkSHA256: binding.networkSHA256, protectionSHA256: binding.protectionSHA256, deviceAbsent: true) : nil)
        }
        let memory = MemoryJournal(), writer = Journal.Writer(binding: binding, storage: memory.storage)
        try writer.open()
        _ = try writer.record(.init(binding: binding, sequence: 0, phase: .createIntent, realizedEffects: nil, pendingIDs: []))
        let phases: [(Journal.Phase, [String])] = [(.acquired, []), (.installIntent, [ids[0]]), (.installed, [ids[0]]),
            (.installIntent, ids), (.installed, ids), (.active, ids), (.removeIntent, ids), (.removed, [ids[0]]),
            (.retireDeviceIntent, [ids[0]]), (.retireDeviceIntent, [ids[0]]), (.removed, []), (.removed, []), (.closeIntent, []), (.restored, [])]
        for (index, phase) in phases.enumerated() {
            let next = try value(UInt32(index + 1), phase.0, phase.1)
            check(try writer.record(next) == .confirmed(RelayTunHelperTrust.digest(next.encoded())), "owned-device journal accepts ordered or explicitly reaffirmed phase: \(phase.0.rawValue)")
        }
        check(try Journal.Snapshot.decode(memory.data!).binding.routeRemovalPolicy == .ownedDeviceRetirement, "device-lifetime ownership strategy round-trips in the complete strict recovery binding")
        var missingPolicy = binding.json; missingPolicy.removeValue(forKey: "routeRemovalPolicy")
        rejects("missing route-removal policy cannot silently decode into another cleanup strategy") { _ = try Journal.Binding.parse(missingPolicy) }
        var unknownPolicy = binding.json; unknownPolicy["routeRemovalPolicy"] = "delete_by_guessed_gateway"
        rejects("unknown route-removal strategy cannot expand the helper's authority") { _ = try Journal.Binding.parse(unknownPolicy) }
        let resolverRemoved = try value(8, .removed, [ids[0]])
        check(try !value(9, .removed, []).follows(resolverRemoved), "owned route absence acknowledgement cannot skip its durable retirement intent")
        check(try !value(9, .removeIntent, [ids[0]]).follows(resolverRemoved), "owned policy cannot substitute per-key route remove intent for interface retirement")
        rejects("retirement intent cannot contain resolver effects") { _ = try value(9, .retireDeviceIntent, ids) }
        rejects("retirement intent requires a nonempty exact route prefix") { _ = try value(9, .retireDeviceIntent, []) }
        check(try !value(11, .retireDeviceIntent, [ids[0]]).follows(value(10, .removed, [])), "retirement retry cannot re-expand a previously acknowledged pending prefix")
        let defaultBinding = try EffectsFixture.binding()
        rejects("per-key journal cannot encode an owned-device retirement command") { _ = try Journal.Snapshot(binding: defaultBinding, sequence: 9, phase: .retireDeviceIntent, realizedEffects: effects, pendingIDs: [ids[0]]) }
        let perKeyRouteRemoved = try Journal.Snapshot(binding: defaultBinding, sequence: 8, phase: .removed, realizedEffects: effects, pendingIDs: [ids[0]])
        let perKeyReaffirmed = try Journal.Snapshot(binding: defaultBinding, sequence: 9, phase: .removed, realizedEffects: effects, pendingIDs: [ids[0]])
        check(perKeyReaffirmed.follows(perKeyRouteRemoved), "per-key recovery may reaffirm the same removed fact without shrinking another logical obligation")
        let perKeyExpanded = try Journal.Snapshot(binding: defaultBinding, sequence: 9, phase: .removed, realizedEffects: effects, pendingIDs: ids)
        check(!perKeyExpanded.follows(perKeyRouteRemoved), "removed reaffirmation cannot expand or reorder the complete bound pending prefix")
        check(try !value(9, .retireDeviceIntent, [ids[0]]).follows(perKeyRouteRemoved), "recovery cannot silently switch an existing plan from per-key to device-lifetime ownership")
        let reversed = try Effects.EffectSet(planID: effects.planID, device: effects.device, effects: effects.effects.reversed())
        rejects("owned journal rejects resolver-first realized effects before an acquired record") { _ = try Journal.Snapshot(binding: binding, sequence: 1, phase: .acquired, realizedEffects: reversed, pendingIDs: []) }
        let route = try EffectsFixture.route(), foreignRoute = try Effects.Route(destination: route.destination, gateway: route.gateway,
            interface: .init(name: "en0", index: 8), scopeIndex: route.scopeIndex, flags: route.flags, hopCount: route.hopCount)
        let foreign = try Effects.EffectSet(planID: effects.planID, device: effects.device, effects: [.route(foreignRoute)])
        rejects("device retirement cannot claim a route bound to another interface as its own lifecycle resource") { _ = try Journal.Snapshot(binding: binding, sequence: 1, phase: .acquired, realizedEffects: foreign, pendingIDs: []) }

        for policy in [Transaction.RouteRemovalPolicy.perKey, .ownedDeviceRetirement] {
        for failure in ["none", "retire_before_sync", "resolver_removed_before_sync", "resolver_removed_after_sync", "route_removed_before_sync", "route_removed_after_sync"] where policy == .ownedDeviceRetirement || failure != "retire_before_sync" {
            let disk = MemoryJournal()
            var recoveryWriter: Journal.Writer!, realized: Effects.EffectSet!, approved: Journal.Binding!
            var present = false, values: [String: String] = [:], routeDeletes = 0, resolverDeletes = 0, failureInjected = false
            let baseline = plan.baseline
            let transaction = Transaction(environment: .init(inspect: { owned in
                if owned == nil && (present || !values.isEmpty) { return .init(networkSHA256: String(repeating: "1", count: 64), protectionSHA256: baseline.protectionSHA256) }
                return baseline
            }, create: { _ in present = true; return .init(id: effects.device.id, interface: effects.device.interface.name) },
               changes: { _, _ in try realized.changes() }, observe: { change, _ in values[change.id] ?? Transaction.absentSHA256 },
               install: { change, _, expected in
                   guard values[change.id] ?? Transaction.absentSHA256 == expected else { return .unchanged }; values[change.id] = change.desiredSHA256; return .applied
               }, remove: { change, _, expected in
                   if change.kind == .route { routeDeletes += 1 } else { resolverDeletes += 1 }
                   guard values[change.id] == expected else { return .unchanged }; values.removeValue(forKey: change.id); return .applied
               }, close: { _ in
                   present = false
                   if policy == .ownedDeviceRetirement { for change in try realized.changes() where change.kind == .route { values.removeValue(forKey: change.id) } }
                   return .applied
               }, deviceAbsent: { _ in !present }, record: { event in
                   guard let phase = Journal.Phase(rawValue: event.phase) else { throw InjectedFailure.storage }
                   let target = !failureInjected && ((failure == "retire_before_sync" && phase == .retireDeviceIntent) ||
                       ((failure == "resolver_removed_before_sync" || failure == "resolver_removed_after_sync") && phase == .removed && event.changes.count == 1) ||
                       ((failure == "route_removed_before_sync" || failure == "route_removed_after_sync") && phase == .removed && event.changes.isEmpty))
                   if target { failureInjected = true }
                   disk.failSync = target && !failure.hasSuffix("after_sync")
                   let sequence = recoveryWriter.lastConfirmed.map { $0.sequence + 1 } ?? 0
                   let next = try Journal.Snapshot(binding: approved, sequence: sequence, phase: phase, realizedEffects: event.device == nil ? nil : realized,
                       pendingIDs: event.changes.map(\.id), observation: phase == .restored ? .init(networkSHA256: baseline.networkSHA256, protectionSHA256: baseline.protectionSHA256, deviceAbsent: !present) : nil)
                   guard case .confirmed = try recoveryWriter.record(next) else { throw InjectedFailure.storage }
                   if target && failure.hasSuffix("after_sync") { throw InjectedFailure.storage }
               }, now: { 1000 }, routeRemovalPolicy: policy))
            let livePlan = try transaction.prepare(configurationSHA256: binding.configurationSHA256, runtimeConfigurationSHA256: binding.runtimeConfigurationSHA256, effectsSHA256: binding.effectsSHA256)
            approved = try .init(installationRevision: binding.installationRevision, clientUID: binding.clientUID, plan: livePlan)
            realized = try .init(planID: livePlan.id, device: effects.device, effects: [.route(EffectsFixture.route()), .resolver(EffectsFixture.resolver(planID: livePlan.id))])
            recoveryWriter = Journal.Writer(binding: approved, storage: disk.storage); try recoveryWriter.open()
            _ = try transaction.acquire(livePlan); _ = try transaction.activate(livePlan, coreConfigurationSHA256: binding.runtimeConfigurationSHA256, coreReady: true)
            let first = try transaction.restore(livePlan)
            if failure != "none" {
                check(first.phase == .uncertain && first.ownsDevice && !first.restorationVerified, "real injected \(policy.rawValue) journal \(failure) retains logical recovery ownership")
                disk.failSync = false
                recoveryWriter = Journal.Writer(binding: approved, storage: disk.storage); try recoveryWriter.open()
                let retry = try transaction.restore(livePlan)
                check(retry.phase == .restored && retry.restorationVerified && !retry.ownsDevice, "reopened exact \(policy.rawValue) journal \(failure) can reaffirm its same observed record and finish recovery")
            } else { check(first.restorationVerified && first.phase == .restored, "\(policy.rawValue) transaction and strict journal complete their ordered durable integration") }
            check(routeDeletes == (policy == .perKey ? 1 : 0) && resolverDeletes == 1 && !present && values.isEmpty && recoveryWriter.lastConfirmed?.phase == .restored,
                  "\(policy.rawValue) \(failure) uses only its intended removal policy, does not repeat removal, and retains the acknowledged terminal journal")
        }
        }
    }
}
