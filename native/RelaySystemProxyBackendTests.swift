import Foundation

/// Runs with only the shared backend linked. No preferences, helper or network
/// adapter is invoked; these cases cover transport fidelity and locked CAS.
func relaySystemProxyBackendSelfTestRows() throws -> [[String: Any]] {
    typealias Backend = RelaySystemProxyBackend
    var rows: [[String: Any]] = []
    func check(_ passed: Bool, _ name: String) { rows.append(["name": name, "passed": passed]) }
    func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
    let values: [String: Any] = ["HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": 18191, "ExceptionsList": ["localhost", "*.internal"], "PrivateUnknown": ["bytes": Data([1, 2, 3]), "flag": true]]
    let binary = try PropertyListSerialization.data(fromPropertyList: values, format: .binary, options: 0)
    let xml = try PropertyListSerialization.data(fromPropertyList: values, format: .xml, options: 0)
    let snapshot = Backend.Snapshot(location: "Location-A", services: [
        Backend.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: binary),
        Backend.Service(id: "B", name: "Ethernet", enabled: false, configuration: nil)
    ])
    let decoded = try JSONDecoder().decode(Backend.Snapshot.self, from: JSONEncoder().encode(snapshot))
    check(decoded == snapshot, "shared snapshot wire round-trip preserves exact plist bytes and nil protocols")
    let result = Backend.ChangeResult(status: "uncertain", snapshot: snapshot, warnings: ["fixture apply status 1003"])
    let decodedResult = try JSONDecoder().decode(Backend.ChangeResult.self, from: JSONEncoder().encode(result))
    check(decodedResult.status == result.status && decodedResult.snapshot == snapshot && decodedResult.warnings == result.warnings, "shared change result wire round-trip preserves bounded status and warnings")
    let xmlSnapshot = Backend.Snapshot(location: snapshot.location, services: [Backend.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: xml), snapshot.services[1]])
    check(try Backend.same(snapshot, xmlSnapshot), "shared comparison uses plist values rather than binary encoding order")
    let empty = try PropertyListSerialization.data(fromPropertyList: [:], format: .binary, options: 0)
    let emptySnapshot = Backend.Snapshot(location: snapshot.location, services: [snapshot.services[0], Backend.Service(id: "B", name: "Ethernet", enabled: false, configuration: empty)])
    check(try !Backend.same(snapshot, emptySnapshot), "shared comparison keeps absent and empty protocol configurations distinct")
    check(try Backend.canonical(Backend.Snapshot(location: snapshot.location, services: snapshot.services.reversed())) == snapshot, "shared canonicalization preserves values while sorting service identity")
    check(try Backend.digest(snapshot) == decoded.revision && snapshot.revision.count == 64, "shared CryptoKit digest matches the snapshot revision after transport")
    rejects("shared validation rejects duplicate service identifiers") { _ = try Backend.canonical(Backend.Snapshot(location: snapshot.location, services: [snapshot.services[0], snapshot.services[0]])) }
    rejects("shared validation rejects an empty network location") { _ = try Backend.canonical(Backend.Snapshot(location: "", services: snapshot.services)) }
    rejects("shared validation rejects malformed protocol plist bytes") { _ = try Backend.dictionary(Data("invalid plist".utf8)) }
    rejects("shared validation rejects over-limit protocol plist bytes") { _ = try Backend.dictionary(Data(repeating: 0, count: 65537)) }
    let other = Backend.Snapshot(location: "Other-location", services: snapshot.services)
    var staged = 0, committed = 0, applied = 0
    rejects("shared locked transaction refuses a stale snapshot before staging") {
        _ = try Backend.changeLocked(snapshot, snapshot, session: Backend.LockedSession(synchronize: {}, read: { other }, stage: { _ in staged += 1 }, commit: { committed += 1; return true }, apply: { applied += 1; return true }))
    }
    check(staged == 0 && committed == 0 && applied == 0, "stale shared transaction performs no stage commit or apply")
    var observed = snapshot
    let lostReadback = try Backend.changeLocked(snapshot, snapshot, session: Backend.LockedSession(synchronize: {}, read: { observed }, stage: { _ in staged += 1 }, commit: { committed += 1; return true }, apply: { applied += 1; observed = other; return true }))
    check(lostReadback.status == "uncertain" && lostReadback.snapshot == other && staged == 1 && committed == 1 && applied == 1, "successful apply with changed readback remains uncertain without overwriting external state")
    for invalidAt in 1...3 {
        var disk = snapshot, cached = snapshot, validations = 0, stages = 0, commits = 0, applies = 0
        let cancelled = try Backend.changeLocked(snapshot, emptySnapshot, session: Backend.LockedSession(synchronize: { cached = disk }, read: { cached }, stage: { cached = $0; stages += 1 }, commit: { disk = cached; commits += 1; return true }, apply: { applies += 1; return true }, requestIsValid: { validations += 1; return validations < invalidAt }))
        check(cancelled.status == "unchanged" && cancelled.snapshot == snapshot && disk == snapshot && stages == (invalidAt == 3 ? 1 : 0) && commits == 0 && applies == 0 && validations == invalidAt, "expired request at check \(invalidAt) never commits or applies staged preferences")
    }
    var disk = snapshot, cached = snapshot, connected = true, validations = 0, commits = 0, applies = 0
    let finishedRecovery = try Backend.changeLocked(snapshot, emptySnapshot, session: Backend.LockedSession(synchronize: { cached = disk }, read: { cached }, stage: { cached = $0 }, commit: { disk = cached; commits += 1; connected = false; return true }, apply: { applies += 1; return applies > 1 }, requestIsValid: { validations += 1; return connected }))
    check(finishedRecovery.status == "rolledBack" && finishedRecovery.snapshot == snapshot && disk == snapshot && validations == 3 && commits == 2 && applies == 2, "disconnect after commit still completes exact-candidate rollback and readback")
    return rows
}
