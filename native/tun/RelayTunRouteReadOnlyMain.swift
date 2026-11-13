import Foundation
import Darwin

/// Ordinary-UID diagnostic only. There is no mutation or privileged mode.
@main struct RelayTunRouteReadOnlyMain {
    static func main() {
        guard CommandLine.arguments.dropFirst().elementsEqual(["--inspect"]), getuid() > 0, geteuid() == getuid() else {
            FileHandle.standardError.write(Data("Use --inspect as the ordinary user for read-only route diagnostics.\n".utf8)); exit(77)
        }
        var rows: [[String: Any]] = []
        for family in [RelayTunNetworkEffects.Address.Family.ipv4, .ipv6] {
            var row: [String: Any] = ["family": family.rawValue, "readCompleted": false]
            do {
                let snapshot = try RelayTunRouteSnapshot.read(family: family)
                row["readCompleted"] = true; row["bytes"] = snapshot.count
                row["snapshotSHA256"] = RelayTunHelperTrust.digest(snapshot)
                let observer = RelayTunRouteObservation(read: { requested in
                    guard requested == family else { throw RelayTunRouteObservation.Failure.invalidSnapshot }
                    return snapshot
                }, resolveInterface: { index in
                    var name = [CChar](repeating: 0, count: Int(IFNAMSIZ))
                    guard if_indextoname(index, &name) != nil else { throw RelayTunRouteProjection.Failure.interfaceIdentity }
                    return try .init(name: String(cString: name), index: index)
                })
                // Documentation-only networks are queried; no packet is sent.
                let destination = try RelayTunNetworkEffects.Prefix(address: .init(family: family,
                    value: family == .ipv4 ? "203.0.113.0" : "2001:db8::"), length: family == .ipv4 ? 24 : 32)
                let state: String, evidence: RelayTunRouteObservation.Evidence
                switch try observer.observe(destination: destination, scopeIndex: 0) {
                case .absent(let value): state = "absent_in_completed_snapshot"; evidence = value
                case .present(_, let value): state = "present_in_completed_snapshot"; evidence = value
                }
                row["queryState"] = state; row["frames"] = evidence.frames
            } catch {
                row["queryState"] = "unknown"; row["error"] = String(describing: error)
            }
            rows.append(row)
        }
        let report: [String: Any] = ["mode": "ordinary-uid-read-only", "uid": getuid(), "observations": rows,
            "systemConfigurationChanged": false, "actualTunCreated": false, "actualTunAccepted": false,
            "networkRestorationVerified": false]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if rows.contains(where: { ($0["queryState"] as? String) == "unknown" }) { exit(1) }
    }
}
