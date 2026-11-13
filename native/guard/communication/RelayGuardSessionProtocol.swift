import Foundation
import Security

@objc protocol RelayGuardProviderCommunication {
    func transact(_ request: NSData, withReply reply: @escaping (NSData) -> Void)
}

struct RelayGuardSessionMessage: Codable, Sendable {
    let version: Int
    let buildVersion: String
    let contractRevision: String
    let policyRevision: String
    let id: String
    let nonce: String
    let action: String
    let proof: RelayGuardProxyProof?
    static func decode(_ data: Data) throws -> Self {
        let object = try RelayTunStrictJSON.object(data, limit: 8192)
        guard let message = try? JSONDecoder().decode(Self.self, from: data), message.version == 2,
              UUID(uuidString: message.id)?.uuidString.lowercased() == message.id,
              message.nonce.utf8.count == 64, message.nonce.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              ["bind", "status", "revoke"].contains(message.action),
              Set(object.keys) == Set(["version", "buildVersion", "contractRevision", "policyRevision", "id", "nonce", "action"] + (message.action == "bind" ? ["proof"] : [])),
              (message.action == "bind") == (message.proof != nil) else { throw RelayGuardBindingFailure.invalid }
        try RelayGuardRuntimeAttestation.validate(buildVersion: message.buildVersion, contractRevision: message.contractRevision, policyRevision: message.policyRevision)
        if message.action == "bind" {
            guard let proof = object["proof"] as? [String: Any], Set(proof.keys) == ["instanceID", "configurationSHA256", "pid", "uid", "bornSeconds", "bornMicroseconds", "executable", "resourceSHA256", "fileIdentity", "ports"] else { throw RelayGuardBindingFailure.invalid }
        }
        return message
    }
}

struct RelayGuardSessionReply: Codable, Sendable {
    let version: Int
    let buildVersion: String
    let contractRevision: String
    let policyRevision: String
    let id: String
    let nonce: String
    let state: String
    let instanceID: String?
    let configurationSHA256: String?
    let protectionVerified: Bool
}


// Actual running bundle metadata must agree with this code's compiled release
// build, not merely with the other peer's echo or a static bundled extension.
// An old activated Provider cannot silently inherit a newly installed App build.
enum RelayGuardRuntimeAttestation {
    static func current() throws -> (buildVersion: String, contractRevision: String, policyRevision: String) {
        guard [RelayGuardContract.applicationID, RelayGuardContract.extensionID].contains(Bundle.main.bundleIdentifier ?? ""),
              let actual = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              actual == RelayGuardManagementRelease.buildVersion,
              !actual.isEmpty, actual.utf8.count <= 64 else { throw RelayGuardBindingFailure.publisher }
        return (actual, RelayGuardManagementRelease.sessionContractRevision, RelayGuardManagementRelease.policyRevision)
    }
    static func validate(buildVersion: String, contractRevision: String, policyRevision: String) throws {
        let actual = try current()
        guard buildVersion == actual.buildVersion, contractRevision == actual.contractRevision, policyRevision == actual.policyRevision else {
            throw RelayGuardBindingFailure.stale
        }
    }
}

enum RelayGuardXPCIdentity {
    static func validatedFilterService(info: [String: Any]?, team: String) -> String? {
        let executable = "RelayGuardExtension"
        let expected = team + "." + RelayGuardContract.extensionID + ".ipc"
        guard let info,
              info["CFBundleIdentifier"] as? String == RelayGuardContract.extensionID,
              info["CFBundleExecutable"] as? String == executable,
              info["CFBundlePackageType"] as? String == "SYSX",
              info["NSEndpointSecurityMachServiceName"] == nil,
              let extensionInfo = info["NetworkExtension"] as? [String: Any],
              Set(extensionInfo.keys) == ["NEMachServiceName", "NEProviderClasses"],
              extensionInfo["NEMachServiceName"] as? String == expected,
              extensionInfo["NEProviderClasses"] as? [String: String] == [
                  "com.apple.networkextension.filter-data": executable + ".RelayGuardFilterDataProvider"
              ] else { return nil }
        return expected
    }

    static func requirement(identifier: String) throws -> String {
        guard let team = RelayGuardManagementRelease.publisherTeamID,
              team.utf8.count == 10, team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }) else {
            throw RelayGuardBindingFailure.publisher
        }
        return "anchor apple generic and identifier \"" + identifier + "\" and certificate leaf[subject.OU] = \"" + team + "\""
    }
    static func machService() throws -> String {
        _ = try requirement(identifier: RelayGuardContract.extensionID)
        guard let team = RelayGuardManagementRelease.publisherTeamID else { throw RelayGuardBindingFailure.publisher }
        let bundle: Bundle?
        if Bundle.main.bundleIdentifier == RelayGuardContract.extensionID { bundle = Bundle.main }
        else if Bundle.main.bundleIdentifier == RelayGuardContract.applicationID {
            bundle = Bundle(url: Bundle.main.bundleURL.appendingPathComponent("Contents/Library/SystemExtensions/" + RelayGuardContract.extensionID + ".systemextension"))
        } else { bundle = nil }
        guard let service = validatedFilterService(info: bundle?.infoDictionary, team: team) else {
            throw RelayGuardBindingFailure.publisher
        }
        return service
    }
}
