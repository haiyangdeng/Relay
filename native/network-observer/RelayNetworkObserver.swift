import Foundation

/// The shipped probe observer reuses the TUN inspector's normalized read-only
/// capture. It has no installation, execution, authorization or mutation API.
enum RelayNetworkObserver {
    struct Report: Encodable {
        let version = 1
        let role = "probe-network-observer"
        let uid: UInt32
        let networkSHA256: String
        let protectionSHA256: String
        let existingTunnel: Bool
    }

    static func inspect(uid: UInt32, sources: RelayTunEnvironmentInspector.Sources) throws -> Report {
        let observed = try RelayTunEnvironmentInspector.report(owned: nil, sources: sources)
        return .init(uid: uid, networkSHA256: observed.baseline.networkSHA256,
                     protectionSHA256: observed.baseline.protectionSHA256,
                     existingTunnel: observed.existingTunnel)
    }
}
