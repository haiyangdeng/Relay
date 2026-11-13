import Foundation
import Darwin

private typealias Session = RelayTunNetworkSession
private typealias Effects = RelayTunNetworkEffects
private typealias Transaction = RelayTunNetworkTransaction
private typealias Journal = RelayTunNetworkJournal
private enum Injected: Error { case failed }

private final class Fixture {
    let config = String(repeating: "a", count: 64), runtime = String(repeating: "b", count: 64), projection = String(repeating: "c", count: 64)
    let identity: Effects.DeviceIdentity
    var baseline = Transaction.Baseline(networkSHA256: String(repeating: "d", count: 64), protectionSHA256: String(repeating: "e", count: 64))
    var allowed = true, held = false, coreReady = true, coreCopies = 0, clock: UInt64 = 1000
    var acquireCalls = 0, routeWrites = 0, resolverWrites = 0, closeCalls = 0, duplicateCalls = 0
    var routeDump = Data(), resolverValue: Data?, journalBytes: Data?, order: [String] = []
    var rejectProjection = false, foreignRoute = false, wrongAck = false, factoryFailure = false, deviceStillVisible = false, substituteRoute = false
    var rejectReleasedProofAfterRetirement = false, repeatedReleasedProofs = 0
    var releaseProofCalls = 0, releaseProof: (() throws -> Bool)?
    var runtimeOverride: String?, onSync: ((Journal.Snapshot) throws -> Void)?, onRouteBoundary: (() -> Void)?
    var realized: Effects.EffectSet?
    init() throws {
        identity = try .init(id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", interface: .init(name: "utun42", index: 91),
            controlID: 17, controlUnit: 43, socketDevice: 7, socketInode: 0, mtu: 1500, addresses: [])
    }
    func route(changed: Bool = false) throws -> Effects.Route {
        try .init(destination: .init(address: .init(family: .ipv4, value: "198.18.0.0"), length: 30),
            gateway: nil, interface: identity.interface, scopeIndex: 0, flags: 0x801, hopCount: changed ? 3 : 0)
    }
    func routeFrame(changed: Bool = false) throws -> Data {
        try RelayTunRouteProjection.request(route(changed: changed), operation: .get, pid: 0, sequence: 0, interfaceType: 249)
    }
    func effects(_ plan: Transaction.Plan, _ device: Effects.DeviceIdentity) throws -> Effects.EffectSet {
        let resolver = try Effects.Resolver(key: Effects.Resolver.ownedKey(planID: plan.id), interface: device.interface,
            servers: [.init(family: .ipv4, value: "198.18.0.1")], matchDomains: [""], searchDomains: [], searchOrder: 1000)
        let value = try Effects.EffectSet(planID: plan.id, device: device, effects: [.route(route()), .resolver(resolver)])
        realized = value; return value
    }
    func session() throws -> Session {
        try Session(installationRevision: String(repeating: "f", count: 64), clientUID: 501,
            driver: .init(authorized: { self.allowed }, inspect: { _ in self.baseline }, acquire: { _ in
                self.acquireCalls += 1; self.held = true; self.order.append("acquire")
                return .init(identity: self.identity, held: { self.held }, verify: { device in
                    guard self.held && device == self.identity else { throw Injected.failed }
                }, duplicate: {
                    self.duplicateCalls += 1
                    guard let file = FileHandle(forReadingAtPath: "/dev/null") else { throw Injected.failed }; return file
                }, close: {
                    self.closeCalls += 1
                    if !self.held { return .unchanged }
                    self.held = false; self.order.append("close")
                    if !self.foreignRoute { self.routeDump = Data() }
                    return .applied
                }, absent: { !self.held && self.coreCopies == 0 && !self.deviceStillVisible })
            }, realize: { try self.effects($0, $1) }, verifyProjection: { plan, effects in
                guard !self.rejectProjection, plan.effectsSHA256 == self.projection, effects == self.realized else { throw Injected.failed }
            }, storage: { _ in
                .init(read: { self.journalBytes }, compareExchange: { revision, replacement in
                    guard revision == self.journalBytes.map(RelayTunHelperTrust.digest) else { return false }
                    self.journalBytes = replacement; return true
                }, sync: {
                    guard let bytes = self.journalBytes else { throw Injected.failed }
                    let snapshot = try Journal.Snapshot.decode(bytes)
                    self.order.append("journal:" + snapshot.phase.rawValue)
                    try self.onSync?(snapshot)
                })
            }, route: { context in
                if self.factoryFailure { throw Injected.failed }
                let driver = RelayTunRouteAdapter.Driver(authorized: { self.allowed }, read: { _ in self.routeDump },
                    resolveInterface: { index in guard index == self.identity.interface.index else { throw Injected.failed }; return self.identity.interface },
                    add: { request, boundary in
                        self.onRouteBoundary?(); try boundary()
                        self.routeWrites += 1; self.order.append("route:add"); self.routeDump = try self.routeFrame()
                        var header = rt_msghdr(), result = request
                        withUnsafeMutableBytes(of: &header) { $0.copyBytes(from: request.prefix($0.count)) }
                        header.rtm_flags |= RTF_DONE
                        if self.wrongAck { header.rtm_seq += 1 }
                        withUnsafeBytes(of: header) { result.replaceSubrange(0..<$0.count, with: $0) }
                        return result
                    }, pid: 501, sequence: { 7 })
                return try RelayTunRouteAdapter(planID: context.plan.id, device: context.device, route: self.substituteRoute ? self.route(changed: true) : context.route,
                    interfaceType: 249, driver: driver, verifyDevice: context.verifyDevice,
                    deviceAbsent: context.deviceAbsent, record: context.record)
            }, resolver: { context in
                let driver = RelayTunResolverAdapter.Driver(authorized: { self.allowed }, inspect: { _ in self.resolverValue }, create: { _ in
                    var held = true
                    return .init(held: { held }, addTemporary: { value in
                        guard self.resolverValue == nil else { return false }
                        self.resolverWrites += 1; self.order.append("resolver:add"); self.resolverValue = value; return true
                    }, release: {
                        held = false; self.resolverValue = nil; self.order.append("resolver:release")
                        return .init(released: true, uncertain: false)
                    })
                })
                return try RelayTunResolverAdapter(planID: context.plan.id, device: context.device, resolver: context.resolver,
                    driver: driver, verifyDevice: context.verifyDevice, record: context.record)
            }, coreRuntime: { _, _ in self.coreReady ? self.runtimeOverride ?? self.runtime : nil },
               coreReleased: { _, _ in
                   self.releaseProofCalls += 1
                   if let proof = self.releaseProof { return try proof() }
                   if self.rejectReleasedProofAfterRetirement && !self.held { self.repeatedReleasedProofs += 1; return false }
                   return self.coreCopies == 0
               }, now: { self.clock }))
    }
    func prepare(_ session: Session) throws -> Transaction.Plan {
        try session.prepare(configurationSHA256: config, runtimeConfigurationSHA256: runtime, effectsSHA256: projection)
    }
}

@main struct RelayTunNetworkSessionTests {
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
            let good = try Fixture(), session = try good.session(), plan = try good.prepare(session)
            check(plan.effectsSHA256 == good.projection && plan.routeRemovalPolicy == .ownedDeviceRetirement, "preparation binds the approved projection and device-retirement policy")
            check(good.acquireCalls == 0 && good.routeWrites == 0 && good.journalBytes == nil, "prepare observes and binds without creating a device, journal or effect")
            check(try session.acquire(plan).phase == .acquired && good.held && good.routeWrites == 0 && good.resolverWrites == 0,
                  "acquire retains only its new lease and complete realized recovery data")
            check(try Journal.Snapshot.decode(good.journalBytes!).realizedEffects == good.realized, "acquired journal contains exact typed route/resolver and allocated-device bytes")
            check(Session.recover(session.recoveryToken) === session, "the unresolved session is retained independently of its caller")
            let delivery = try session.duplicateForDelivery(plan); try delivery.descriptor.close()
            check(delivery.identity == good.identity, "delivery returns the exact held-device identity for receipt binding")
            check(good.duplicateCalls == 1 && good.held, "delivery uses the held capability without dropping its recovery handle")
            good.coreReady = false
            rejects("core readiness is observed through the trusted host before any effect") { _ = try session.activate(plan) }
            good.coreReady = true; good.runtimeOverride = good.config
            rejects("a ready core with a different runtime digest cannot activate") { _ = try session.activate(plan) }
            good.runtimeOverride = nil
            check(try session.activate(plan).phase == .active && good.routeWrites == 1 && good.resolverWrites == 1, "real adapters and journal complete route-then-resolver activation")
            let routeIndex = good.order.firstIndex(of: "route:add")!, resolverIndex = good.order.firstIndex(of: "resolver:add")!
            check(routeIndex < resolverIndex && good.order[routeIndex - 1] == "journal:install_intent" && good.order[resolverIndex - 1] == "journal:install_intent",
                  "each real adapter mutation follows its synchronized exact outer intent")
            check(try Journal.Snapshot.decode(good.journalBytes!).phase == .active && session.status.potentiallyApplied == 2,
                  "published active status follows the durable active record")
            good.coreCopies = 1
            rejects("restore waits for positive core-exit and client-FD release evidence") { _ = try session.restore(plan) }
            rejects("unactivated retirement exception cannot bypass an active core release proof") {
                _ = try session.restore(plan, allowUnactivatedDeviceRetirement: true)
            }
            check(good.held && good.resolverValue != nil && good.closeCalls == 0, "unreleased client ownership leaves device and resolver intact")
            good.coreCopies = 0
            let restored = try session.restore(plan)
            check(restored.phase == .restored && restored.restorationVerified && !restored.ownsDevice && restored.potentiallyApplied == 0,
                  "one session performs complete resolver release, device retirement and baseline restoration")
            check(good.resolverValue == nil && good.routeDump.isEmpty && !good.held && good.routeWrites == 1,
                  "route recovery uses device retirement and issues no DELETE or second ADD")
            check(try Journal.Snapshot.decode(good.journalBytes!).phase == .restored && Session.recover(session.recoveryToken) == nil,
                  "only synchronized terminal evidence releases the recovery owner")
            check(!restored.actualTunAccepted, "isolated end-to-end wiring never claims live TUN acceptance")

            let retiredProof = try Fixture(), retiredSession = try retiredProof.session(), retiredPlan = try retiredProof.prepare(retiredSession)
            _ = try retiredSession.acquire(retiredPlan); _ = try retiredSession.activate(retiredPlan)
            retiredProof.rejectReleasedProofAfterRetirement = true
            let retiredResult = try retiredSession.restore(retiredPlan)
            check(!retiredProof.held && retiredProof.routeDump.isEmpty && retiredProof.resolverValue == nil,
                  "route and resolver removal independently retire the device before terminal confirmation")
            check(retiredResult.phase == .restored && retiredResult.restorationVerified && retiredProof.repeatedReleasedProofs == 0,
                  "positive device retirement needs no second core-release callback before durable restoration")
            check(try Journal.Snapshot.decode(retiredProof.journalBytes!).phase == .restored && Session.recover(retiredSession.recoveryToken) == nil,
                  "already-retired route and DNS effects reach a durable terminal record without redundant close")

            // The ordinary CoreHost cannot start again after its released phase.
            // A single restore must not require the same terminal proof again
            // after removing DNS, when the callback transport may be unavailable.
            let once = try Fixture(), onceSession = try once.session(), oncePlan = try once.prepare(onceSession)
            _ = try onceSession.acquire(oncePlan); _ = try onceSession.activate(oncePlan)
            once.releaseProof = { once.releaseProofCalls == 1 }
            let onceResult = try onceSession.restore(oncePlan)
            check(onceResult.phase == .restored && onceResult.restorationVerified && once.releaseProofCalls == 1,
                  "one bound terminal core proof completes the same serial restore without a second callback")
            check(!once.held && once.resolverValue == nil && once.routeDump.isEmpty && once.closeCalls == 1,
                  "single-proof restoration closes the lease once and removes both typed effects")
            check(try Journal.Snapshot.decode(once.journalBytes!).phase == .restored && Session.recover(onceSession.recoveryToken) == nil,
                  "single-proof restoration still requires durable terminal evidence")

            let fresh = try Fixture(), freshSession = try fresh.session(), freshPlan = try fresh.prepare(freshSession)
            _ = try freshSession.acquire(freshPlan); _ = try freshSession.activate(freshPlan)
            fresh.foreignRoute = true; fresh.routeDump = try fresh.routeFrame(changed: true)
            check(try freshSession.restore(freshPlan).phase == .conflict && fresh.held && fresh.closeCalls == 0,
                  "an observed route conflict retains the lease despite positive core release")
            fresh.foreignRoute = false; fresh.routeDump = try fresh.routeFrame(); fresh.releaseProof = { false }
            rejects("a later restore cannot reuse the previous invocation's release proof") { _ = try freshSession.restore(freshPlan) }
            check(fresh.releaseProofCalls == 2 && fresh.held && fresh.closeCalls == 0 && fresh.resolverValue != nil,
                  "a negative fresh proof blocks all recovery writes on a later invocation")
            fresh.releaseProof = { throw Injected.failed }
            rejects("an unavailable fresh proof cannot reuse prior positive release evidence") { _ = try freshSession.restore(freshPlan) }
            check(fresh.releaseProofCalls == 3 && fresh.held && fresh.closeCalls == 0,
                  "failed fresh observation retains ownership without a close")
            fresh.releaseProof = { true }
            check(try freshSession.restore(freshPlan).phase == .restored && fresh.releaseProofCalls == 4 && fresh.closeCalls == 1,
                  "only a new positive proof admits the next complete restore")

            let reappeared = try Fixture(), reappearedSession = try reappeared.session(), reappearedPlan = try reappeared.prepare(reappearedSession)
            _ = try reappearedSession.acquire(reappearedPlan); _ = try reappearedSession.activate(reappearedPlan)
            reappeared.onSync = { snapshot in if snapshot.phase == .closeIntent { reappeared.deviceStillVisible = true } }
            let reappearedResult = try reappearedSession.restore(reappearedPlan)
            check(reappearedResult.phase == .uncertain && !reappearedResult.restorationVerified && reappearedResult.ownsDevice,
                  "fresh post-retirement absence still rejects a device visible at final close intent")
            check(try Journal.Snapshot.decode(reappeared.journalBytes!).phase == .closeIntent && Session.recover(reappearedSession.recoveryToken) === reappearedSession,
                  "a changed device observation cannot publish a restored record or discard recovery ownership")

            let lostDelivery = try Fixture(), lostSession = try lostDelivery.session(), lostPlan = try lostDelivery.prepare(lostSession)
            _ = try lostSession.acquire(lostPlan); lostDelivery.coreCopies = 1
            rejects("ordinary unactivated restore still requires its host release proof by default") { _ = try lostSession.restore(lostPlan) }
            let pendingDelivery = try lostSession.restore(lostPlan, allowUnactivatedDeviceRetirement: true)
            check(pendingDelivery.phase == .uncertain && !pendingDelivery.restorationVerified && pendingDelivery.ownsDevice && !lostDelivery.held,
                  "explicit lost-delivery recovery drops only helper handles and waits for independent all-copy absence")
            check(lostDelivery.routeWrites == 0 && lostDelivery.resolverWrites == 0 && Session.recover(lostSession.recoveryToken) === lostSession,
                  "a remaining client FD never becomes a fabricated released core or restored network")
            lostDelivery.coreCopies = 0
            let deliveredLaterClosed = try lostSession.restore(lostPlan, allowUnactivatedDeviceRetirement: true)
            check(deliveredLaterClosed.phase == .restored && deliveredLaterClosed.restorationVerified && !deliveredLaterClosed.ownsDevice,
                  "explicit retry completes lost-delivery recovery only after fresh independent device absence")

            let unapproved = try Fixture(); unapproved.allowed = false; let denied = try unapproved.session()
            rejects("unapproved session refuses preparation before its driver") { _ = try unapproved.prepare(denied) }
            check(unapproved.acquireCalls == 0 && unapproved.journalBytes == nil, "permission refusal creates no resource or journal")

            let noIntent = try Fixture(); noIntent.onSync = { snapshot in if snapshot.phase == .createIntent { throw Injected.failed } }
            let noIntentSession = try noIntent.session(), noIntentPlan = try noIntent.prepare(noIntentSession)
            rejects("failed durable creation intent blocks device acquisition") { _ = try noIntentSession.acquire(noIntentPlan) }
            check(noIntent.acquireCalls == 0 && Session.recover(noIntentSession.recoveryToken) == nil, "no device capability exists before durable creation intent")

            let badProjection = try Fixture(); badProjection.rejectProjection = true
            var projectionSession: Session? = try badProjection.session(); let projectionPlan = try badProjection.prepare(projectionSession!)
            check(try projectionSession!.acquire(projectionPlan).phase == .uncertain && badProjection.held && badProjection.routeWrites == 0,
                  "rejected projection retains the acquired lease and never installs effects")
            let token = projectionSession!.recoveryToken; projectionSession = nil
            check(Session.recover(token) != nil && Session.recover(token)!.status.ownsDevice, "dropping a caller after realization failure cannot lose its lease")
            check(try Journal.Snapshot.decode(badProjection.journalBytes!).phase == .createIntent, "unverified realization cannot publish an acquired record")

            let factory = try Fixture(); factory.factoryFailure = true
            let factorySession = try factory.session(), factoryPlan = try factory.prepare(factorySession)
            _ = try factorySession.acquire(factoryPlan)
            rejects("adapter-factory failure precedes the first route/resolver mutation") { _ = try factorySession.activate(factoryPlan) }
            check(try factorySession.restore(factoryPlan).phase == .restored && factory.routeWrites == 0 && factory.resolverWrites == 0,
                  "an unactivated acquired lease can restore after factory failure")

            let substituted = try Fixture(); substituted.substituteRoute = true
            let substitutedSession = try substituted.session(), substitutedPlan = try substituted.prepare(substitutedSession)
            _ = try substitutedSession.acquire(substitutedPlan)
            rejects("an adapter factory cannot substitute different effect bytes after projection verification") { _ = try substitutedSession.activate(substitutedPlan) }
            check(try substitutedSession.restore(substitutedPlan).phase == .restored && substituted.routeWrites == 0,
                  "factory substitution is rejected before writing and retains a recoverable lease")

            let ack = try Fixture(); ack.wrongAck = true
            let ackSession = try ack.session(), ackPlan = try ack.prepare(ackSession); _ = try ackSession.acquire(ackPlan)
            check(try ackSession.activate(ackPlan).phase == .uncertain && ack.routeWrites == 1 && ack.resolverWrites == 0,
                  "uncertain route ACK retains its obligation and prevents later resolver install")
            check(try ackSession.restore(ackPlan).phase == .restored && ack.routeWrites == 1, "the same typed obligation recovers by owned-device retirement after an uncertain ADD")

            let expired = try Fixture(); let expiredSession = try expired.session(), expiredPlan = try expired.prepare(expiredSession)
            _ = try expiredSession.acquire(expiredPlan)
            expired.onSync = { snapshot in if snapshot.phase == .installIntent { expired.clock = expiredPlan.expiresAt + 1 } }
            check(try expiredSession.activate(expiredPlan).phase == .uncertain && expired.routeWrites == 0 && expired.resolverWrites == 0,
                  "expiry while persisting install intent blocks all subsequent network mutation")
            expired.onSync = nil
            check(try expiredSession.restore(expiredPlan).phase == .restored, "expiration revokes activation while preserving explicit recovery capability")

            let boundary = try Fixture(); let boundarySession = try boundary.session(), boundaryPlan = try boundary.prepare(boundarySession)
            _ = try boundarySession.acquire(boundaryPlan); boundary.onRouteBoundary = { boundary.clock = boundaryPlan.expiresAt + 1 }
            check(try boundarySession.activate(boundaryPlan).phase == .uncertain && boundary.routeWrites == 0,
                  "expiry during route transport setup is caught by the final session-bound device verifier")
            boundary.onRouteBoundary = nil
            check(try boundarySession.restore(boundaryPlan).phase == .restored, "a failed final write boundary leaves a recoverable exact lease")

            let revoked = try Fixture(); let revokedSession = try revoked.session(), revokedPlan = try revoked.prepare(revokedSession)
            _ = try revokedSession.acquire(revokedPlan); revokedSession.invalidatePreparation()
            rejects("suspension/revocation prevents activation of an acquired session") { _ = try revokedSession.activate(revokedPlan) }
            check(try revokedSession.restore(revokedPlan).phase == .restored, "revocation preserves explicit stop/recovery authority")

            let conflict = try Fixture(); let conflictSession = try conflict.session(), conflictPlan = try conflict.prepare(conflictSession)
            _ = try conflictSession.acquire(conflictPlan); _ = try conflictSession.activate(conflictPlan)
            conflict.foreignRoute = true; conflict.routeDump = try conflict.routeFrame(changed: true)
            check(try conflictSession.restore(conflictPlan).phase == .conflict && conflict.held && conflict.resolverValue != nil && conflict.closeCalls == 0,
                  "foreign route edits stop every undo write and preserve all original ownership")

            let external = try Fixture(); let externalSession = try external.session(), externalPlan = try external.prepare(externalSession)
            _ = try externalSession.acquire(externalPlan); _ = try externalSession.activate(externalPlan)
            external.baseline = .init(networkSHA256: String(repeating: "0", count: 64), protectionSHA256: external.baseline.protectionSHA256)
            let changed = try externalSession.restore(externalPlan)
            check(changed.phase == .conflict && !changed.restorationVerified && !changed.ownsDevice,
                  "unrelated external baseline changes remain visible after exact owned resources retire")
            check(try Journal.Snapshot.decode(external.journalBytes!).phase == .closedExternalChange && Session.recover(externalSession.recoveryToken) == nil,
                  "closed-external-change records the mismatch without retaining released device resources")

            let finalFailure = try Fixture(); let finalSession = try finalFailure.session(), finalPlan = try finalFailure.prepare(finalSession)
            _ = try finalSession.acquire(finalPlan); _ = try finalSession.activate(finalPlan)
            finalFailure.onSync = { snapshot in if snapshot.phase == .restored { throw Injected.failed } }
            check(try finalSession.restore(finalPlan).phase == .uncertain && !finalSession.status.restorationVerified,
                  "lost final journal acknowledgement cannot publish restoration")
            check(Session.recover(finalSession.recoveryToken) === finalSession && !finalFailure.held,
                  "released physical ownership keeps its logical recovery owner until terminal durability is known")

            let reentrant = try Fixture(); let reentrantSession = try reentrant.session(), reentrantPlan = try reentrant.prepare(reentrantSession)
            var busy = false, statusReadable = false
            reentrant.onSync = { snapshot in
                statusReadable = reentrantSession.status.busy
                if snapshot.phase == .createIntent {
                    do { _ = try reentrantSession.acquire(reentrantPlan) } catch Session.Failure.busy { busy = true }
                }
            }
            check(try reentrantSession.acquire(reentrantPlan).phase == .acquired && busy && statusReadable,
                  "journal callback reentry is rejected while status remains immediately readable")
            reentrant.onSync = nil
            _ = try reentrantSession.restore(reentrantPlan)
        } catch { rows.append(["name": "fixture setup", "passed": false, "error": String(describing: error)]) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "actualRouteWritten": false, "actualResolverWritten": false, "actualDeviceCreated": false,
            "actualRootFileWrites": false, "actualTunAccepted": false]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
        exit(rows.count == passed ? 0 : 1)
    }
}
