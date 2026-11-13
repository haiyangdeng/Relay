import CryptoKit
import Darwin
import Foundation
import Security

struct RelayGuardHostResource: Encodable {
    let version = 1
    let trusted: Bool
    let path: String?
    let resourceSHA256: String?
    let reason: String?
}

/// Read-only prerequisite for require(.node). Does not load code or invoke a
/// manager. All paths are resolved from the fixed packaged RelayNative layout.
enum RelayGuardHostIntegrity {
    static func inspect(executable: URL) -> RelayGuardHostResource {
        do {
            guard let team = RelayGuardManagementRelease.publisherTeamID,
                  team.utf8.count == 10, team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }),
                  let root = RelayGuardReadiness.applicationRoot(executable) else { throw AssistantError("publisherNotConfigured") }
            let observation = RelayGuardReadiness.observe(root)
            guard observation.bundleIdentifier == RelayGuardContract.applicationID,
                  observation.signingIdentifier == RelayGuardContract.applicationID,
                  observation.signature == "staticValid", observation.team == team,
                  let build = observation.version else { throw AssistantError("packageIdentityUnconfirmed") }
            try validate(root, identifier: RelayGuardContract.applicationID, team: team)
            #if arch(arm64)
            let architecture = "arm64"
            #else
            let architecture = "x86_64"
            #endif
            let directory = root.appendingPathComponent("Contents/Resources/relay/guard-host/" + architecture)
            let manifestURL = directory.appendingPathComponent("manifest.json")
            try NetworkConfiguration.checkPlainPath(manifestURL)
            let bytes = try Data(contentsOf: manifestURL)
            guard bytes.count <= 8192, let manifest = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  Set(manifest.keys) == ["version", "architecture", "buildVersion", "files"],
                  let schema = manifest["version"] as? NSNumber, CFGetTypeID(schema) != CFBooleanGetTypeID(), schema == 1,
                  manifest["architecture"] as? String == architecture, manifest["buildVersion"] as? String == build,
                  let files = manifest["files"] as? [String: String],
                  Set(files.keys) == ["RelayGuard.node", "libRelayGuardHost.dylib"] else { throw AssistantError("resourcePairingUnconfirmed") }
            for (name, hash) in files {
                guard hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw AssistantError("resourcePairingUnconfirmed") }
                let file = directory.appendingPathComponent(name)
                try NetworkConfiguration.checkPlainPath(file)
                var info = stat()
                guard lstat(file.path, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                      info.st_mode & 0o022 == 0, info.st_nlink == 1, info.st_size > 0, info.st_size <= 128 * 1024 * 1024 else { throw AssistantError("resourcePairingUnconfirmed") }
                let data = try Data(contentsOf: file)
                let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard actual == hash else { throw AssistantError("resourcePairingUnconfirmed") }
                try validate(file, identifier: RelayGuardContract.applicationID + ".guard-host." + (name == "RelayGuard.node" ? "node" : "swift"), team: team)
            }
            // Repeat package validation after byte reads; replacement is not a
            // successful inspection. The signed resource envelope pins manifest.
            try validate(root, identifier: RelayGuardContract.applicationID, team: team)
            return RelayGuardHostResource(trusted: true, path: directory.appendingPathComponent("RelayGuard.node").path,
                resourceSHA256: files["RelayGuard.node"], reason: nil)
        } catch {
            return RelayGuardHostResource(trusted: false, path: nil, resourceSHA256: nil, reason: "packageIdentityUnconfirmed")
        }
    }
    private static func validate(_ url: URL, identifier: String, team: String) throws {
        var requirement: SecRequirement?, code: SecStaticCode?
        let expression = "anchor apple generic and identifier \"" + identifier + "\" and certificate leaf[subject.OU] = \"" + team + "\""
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode).union(.noNetworkAccess)
        guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else { throw AssistantError("packageIdentityUnconfirmed") }
    }
}
