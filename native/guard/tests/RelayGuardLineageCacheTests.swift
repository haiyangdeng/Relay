import Darwin
import Foundation

private final class LineageCacheFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var lease: RelayGuardExecutionLease?
    private var notifications = 0

    func setLease(_ value: RelayGuardExecutionLease?) { lock.withLock { lease = value } }
    func currentLease() -> RelayGuardExecutionLease? { lock.withLock { lease } }
    func revoked() { lock.withLock { notifications += 1 } }
    var revocations: Int { lock.withLock { notifications } }
}

func runRelayGuardLineageCacheSelfTests() -> Int32 {
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    func token(_ version: UInt32, effectiveUID: UInt32 = 501, pid: UInt32 = 123) -> Data {
        // Synthetic audit-token words only. The production reader uses libbsm.
        var value = audit_token_t(val: (0, effectiveUID, 0, 501, 0, pid, 0, version))
        return withUnsafeBytes(of: &value) { Data($0) }
    }
    func healthy(_ revision: UInt64) -> RelayGuardLineageHealth {
        .init(epoch: "11111111-1111-4111-8111-111111111111", revision: revision,
              monitoring: true, knownRootsAvailable: true, globalCoverageReady: false, losses: ["lateAttach"])
    }
    let claims = RelayGuardFilterDataProvider.claimsNewFlow
    let direct = RelayGuardDirectAttribution(capacity: 1)
    let desktopToken = token(20), helperToken = token(21), nodeToken = token(22)
    let systemToken = token(20, pid: 234), nativeToken = token(23), spoofedToken = token(24), newCodexHelperToken = token(25)
    var observations: [Data: RelayGuardSigningObservation] = [
        desktopToken: .init(identifier: RelayGuardIdentityClassifier.desktopSigningID,
                           team: RelayGuardIdentityClassifier.teamID, valid: true),
        helperToken: .init(identifier: RelayGuardIdentityClassifier.desktopHelperSigningID,
                          team: RelayGuardIdentityClassifier.teamID, valid: true),
        nodeToken: .init(identifier: "node", team: "NODETEAM", valid: true),
        systemToken: .init(identifier: "com.apple.networkserviceproxy", team: "SYSTEMTEAM", valid: true),
        nativeToken: .init(identifier: RelayGuardIdentityClassifier.nativeCLISigningID,
                          team: RelayGuardIdentityClassifier.teamID, valid: true),
        spoofedToken: .init(identifier: RelayGuardIdentityClassifier.desktopSigningID,
                           team: "WRONGTEAM", valid: true),
        newCodexHelperToken: .init(identifier: RelayGuardIdentityClassifier.codexDesktopSigningID + ".helper.future",
                                  team: RelayGuardIdentityClassifier.codexTeamID, valid: true)
    ]
    let environment = RelayGuardAuditIdentityEnvironment(read: { observations[$0] })
    func directSubject(_ tokens: Data...) -> RelayGuardSubject { direct.subject(for: tokens, environment: environment) }
    check(!claims(directSubject(), false), "anonymous flow remains outside Claude policy")
    check(directSubject(nodeToken) == .other && !claims(directSubject(nodeToken), false),
          "normal Node is outside the direct policy")
    check(directSubject(nativeToken) == .other && claims(directSubject(nativeToken), true),
          "native CLI needs positive ES scope instead of blanket direct claims")
    let newCodexHelper = directSubject(newCodexHelperToken)
    check(newCodexHelper == .unverifiedProtected && claims(newCodexHelper, false),
          "an unlisted Codex helper with verified publisher cannot bypass first-flow admission")
    check(directSubject(spoofedToken) == .unverifiedProtected,
          "an exact Desktop identifier from the wrong Team is rejected")
    observations.removeValue(forKey: spoofedToken)
    check(!claims(directSubject(spoofedToken), false), "a rejected identity did not create positive membership")
    check(directSubject(desktopToken, systemToken) == .desktop && claims(directSubject(desktopToken, systemToken), false),
          "verified source application can occupy the only slot and claim a delegated flow")
    check(directSubject(desktopToken) == .desktop, "a still-live verified Desktop keeps its exact slot")
    observations.removeValue(forKey: desktopToken)
    check(directSubject(desktopToken, systemToken) == .unverifiedProtected,
          "loss of direct signature on the exact known generation cannot become ordinary allow")
    check(directSubject(token(20, effectiveUID: 502)) == .unverifiedProtected,
          "same direct generation remains restrictive across credential changes")
    check(directSubject(nodeToken) == .other && directSubject(systemToken) == .other,
          "PID reuse and the unclaimed system creator retain independent ordinary treatment")
    check(directSubject(helperToken) == .unverifiedProtected && !claims(directSubject(token(99)), false),
          "a full direct ledger denies a new authenticated candidate without claiming unknown actors")
    do {
        let cache = RelayGuardLineageCache(), state = LineageCacheFixture()
        let run = UUID(), id = run.uuidString.lowercased()
        let core = "22222222-2222-4222-8222-222222222222", config = String(repeating: "a", count: 64)
        let lease = RelayGuardExecutionLease(providerRunID: id, coreGeneration: 1, coreInstanceID: core, configurationSHA256: config)
        let replacement = RelayGuardExecutionLease(providerRunID: id, coreGeneration: 2, coreInstanceID: core, configurationSHA256: config)
        let health = healthy(1)
        var timebase = mach_timebase_info_data_t()
        guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.numer > 0, timebase.denom > 0 else {
            print("FAIL: unavailable fixture clock domain"); return 1
        }
        func ticket(_ version: UInt32) -> RelayGuardExecutionTicket {
            .init(claimID: UUID().uuidString.lowercased(), actorToken: token(1), targetToken: token(version),
                  subject: .officialScriptCLI, health: health, tagVersion: UInt64(version), authSequence: 1,
                  authGlobalSequence: UInt64(version),
                  expiresMach: mach_absolute_time() + 1_000_000_000 * UInt64(timebase.denom) / UInt64(timebase.numer))
        }
        state.setLease(lease)
        cache.beginRun(run, executionReadiness: { state.currentLease() }, onRevoked: { state.revoked() })
        try cache.apply(health)
        check(cache.attribution(token(2)) == nil, "unknown process generation has no positive attribution")

        let stable = ticket(2)
        try cache.prepareExecution(stable, lease: lease)
        let first = cache.attribution(stable.targetToken)?.permit
        check(first.map(cache.current) == true, "first positively claimed flow has a local pre-exec permit")
        check(cache.attribution(token(2, effectiveUID: 502))?.permit == nil && cache.attribution(token(2, effectiveUID: 502))?.subject == .officialScriptCLI,
              "changed credentials for the same staged generation preserve membership without a permit")
        check(cache.attribution(token(99)) == nil, "another generation of the same PID does not inherit attribution")
        let beforeStable = state.revocations
        cache.settleExecution(stable, outcome: .committed)
        check(first.map(cache.current) == true && state.revocations == beforeStable,
              "commit on the same live lease carries the permit without revocation")

        let changed = ticket(3)
        try cache.prepareExecution(changed, lease: lease)
        let old = cache.attribution(changed.targetToken)?.permit
        check(old.map(cache.current) == true, "staged flow is held before Core replacement")
        let beforeChanged = state.revocations
        state.setLease(replacement)
        cache.settleExecution(changed, outcome: .committed)
        check(state.revocations == beforeChanged + 1, "committed settlement that loses its permit immediately notifies the flow observer")
        check(old.map(cache.current) == false && cache.attribution(changed.targetToken)?.permit == nil
                && cache.attribution(changed.targetToken)?.subject == .officialScriptCLI,
              "different Core lease leaves the old flow invalid and its protected attribution sticky")

        try cache.apply(.init(epoch: health.epoch, revision: 2, monitoring: false,
                              knownRootsAvailable: false, globalCoverageReady: false, losses: ["eventGap"]))
        check(first.map(cache.current) == false && cache.attribution(stable.targetToken)?.permit == nil,
              "source loss invalidates a previously committed permit")
        check(cache.attribution(stable.targetToken)?.subject == .officialScriptCLI && cache.attribution(token(99)) == nil,
              "source loss neither erases the known protected generation nor claims a different one")
    } catch {
        failures.append("fixture setup failed: \(error)")
    }
    print(failures.isEmpty ? "PASS: \(count) guard lineage-cache checks; synthetic tokens and leases only." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
