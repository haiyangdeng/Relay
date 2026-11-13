import Foundation

/// Only injected closures are called. No install lookup, authorization session,
/// process, XPC connection or real preferences adapter is used in these cases.
func relaySystemProxyHelperBridgeSelfTestRows() -> [[String: Any]] {
    typealias Backend = RelaySystemProxyBackend
    var rows: [[String: Any]] = []
    func check(_ passed: Bool, _ name: String) { rows.append(["name": name, "passed": passed]) }
    let snapshot = Backend.Snapshot(location: "Fixture-location", services: [])
    let applied = Backend.ChangeResult(status: "applied", snapshot: snapshot)
    var authorizationCalls = 0, helperCalls = 0
    let absent = RelaySystemProxyHelperBridge.selectBackend(helperPresent: false, authorized: { authorizationCalls += 1; return applied }, installed: { helperCalls += 1; return applied })
    check(absent.status == "applied" && authorizationCalls == 1 && helperCalls == 0, "absent helper uses exactly the existing authorization backend")
    authorizationCalls = 0; helperCalls = 0
    let installed = RelaySystemProxyHelperBridge.selectBackend(helperPresent: true, authorized: { authorizationCalls += 1; return applied }, installed: { helperCalls += 1; return applied })
    check(installed.status == "applied" && authorizationCalls == 0 && helperCalls == 1, "installed helper never starts an authorization write")
    for (name, failure) in [("partial installation", RelaySystemProxyHelperFailure.installation), ("disconnected helper", .unavailable), ("invalid reply", .reply)] {
        authorizationCalls = 0; helperCalls = 0
        do {
            _ = try RelaySystemProxyHelperBridge.selectBackend(helperPresent: true, authorized: { authorizationCalls += 1; return applied }, installed: { helperCalls += 1; throw failure })
            check(false, name + " does not fall back or retry")
        } catch {
            check(authorizationCalls == 0 && helperCalls == 1, name + " does not fall back or retry")
        }
    }
    authorizationCalls = 0; helperCalls = 0
    let uncertain = RelaySystemProxyHelperBridge.selectBackend(helperPresent: true, authorized: { authorizationCalls += 1; return applied }, installed: { helperCalls += 1; return Backend.ChangeResult(status: "uncertain", snapshot: snapshot, warnings: ["fixture lost acknowledgment"]) })
    check(uncertain.status == "uncertain" && uncertain.warnings == ["fixture lost acknowledgment"] && authorizationCalls == 0 && helperCalls == 1, "uncertain helper result reaches the recovery journal without a second write")
    authorizationCalls = 0; helperCalls = 0
    do {
        _ = try RelaySystemProxyHelperBridge.selectBackend(helperPresent: false, authorized: { authorizationCalls += 1; throw Backend.SystemFailure(stage: "authorization_create", code: -60005) }, installed: { helperCalls += 1; return applied })
        check(false, "denied original authorization is never retried through the helper")
    } catch {
        check(authorizationCalls == 1 && helperCalls == 0, "denied original authorization is never retried through the helper")
    }
    return rows
}
