import Darwin
import Foundation
import Security

enum RelayGuardLineageIdentity {
    enum Peer { case source, provider }
    static var extensionID: String { RelayGuardLineageRelease.extensionID }
    static var contractRevision: String { RelayGuardLineageRelease.contractRevision }
    static var catalogRevision: String { RelayGuardLineageRelease.catalogRevision }

    static func current() throws -> RelayGuardLineageAttestation {
        guard [RelayGuardContract.extensionID, extensionID].contains(Bundle.main.bundleIdentifier ?? ""),
              let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              version == RelayGuardLineageRelease.buildVersion else { throw RelayGuardLineageWireFailure.unavailable }
        let peer: Peer = Bundle.main.bundleIdentifier == extensionID ? .source : .provider
        var own: SecCode?, required: SecRequirement?
        guard getuid() == 0, geteuid() == 0,
              SecCodeCopySelf([], &own) == errSecSuccess, let own,
              SecRequirementCreateWithString(try requirement(for: peer) as CFString, [], &required) == errSecSuccess,
              let required, SecCodeCheckValidity(own, .noNetworkAccess, required) == errSecSuccess else {
            throw RelayGuardLineageWireFailure.unavailable
        }
        return .init(buildVersion: version, policyRevision: RelayGuardManagementRelease.policyRevision,
                     contractRevision: contractRevision, catalogRevision: catalogRevision)
    }
    static func requirement(for peer: Peer) throws -> String {
        // Same requirement primitive as RelayGuardXPCIdentity, without linking
        // the unrelated proxy/session wire into the independent ES target.
        guard let team = RelayGuardLineageRelease.publisherTeamID, team.utf8.count == 10,
              team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }) else {
            throw RelayGuardLineageWireFailure.unavailable
        }
        let identifier = peer == .source ? extensionID : RelayGuardContract.extensionID
        return "anchor apple generic and identifier \"" + identifier + "\" and certificate leaf[subject.OU] = \"" + team + "\""
    }
    static func machService() throws -> String {
        _ = try current()
        _ = try requirement(for: .source)
        guard let team = RelayGuardLineageRelease.publisherTeamID else { throw RelayGuardLineageWireFailure.unavailable }
        let name = team + "." + extensionID + ".ipc"
        if Bundle.main.bundleIdentifier == extensionID {
            guard Bundle.main.object(forInfoDictionaryKey: "NSEndpointSecurityMachServiceName") as? String == name else {
                throw RelayGuardLineageWireFailure.unavailable
            }
        }
        return name
    }
    static func nonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw RelayGuardLineageWireFailure.unavailable
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
