import Foundation
import Security

enum RelayGuardManagementOperation: String, Sendable {
    case install, enable, disable
}

enum RelayGuardManagementFailure: Error, Sendable {
    case publisherNotConfigured
    case releaseNotInstallable
    case trustedPolicyBindingUnavailable
    case packageIdentityUnconfirmed
    case operationPending
    case userCancelled
    case configurationChanged
    case configurationOwnershipUnconfirmed
    case systemRequestFailed
}

/// Current native/guard/package/manifest.json has a null publisher and both
/// deployment capabilities false. These are release inputs, never IPC arguments.
/// No placeholder Team ID is substituted to make a development build usable.

/// An in-process proof of the running publisher package. Its initializer is
/// private; callers cannot supply a readiness Boolean, Team ID, bundle or path.
struct RelayGuardManagementPermit {
    let version: String
    let operation: RelayGuardManagementOperation
    private init(version: String, operation: RelayGuardManagementOperation) {
        self.version = version
        self.operation = operation
    }

    static func inspect(for operation: RelayGuardManagementOperation, policyReady: (() throws -> Void)? = nil) throws -> Self {
        guard let team = RelayGuardManagementRelease.publisherTeamID,
              team.utf8.count == 10,
              team.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }) else {
            throw RelayGuardManagementFailure.publisherNotConfigured
        }
        // Recovery does not depend on a working Provider or activation support.
        if operation != .disable {
            guard RelayGuardManagementRelease.systemInstallationSupported,
                  RelayGuardLineageRelease.systemInstallationSupported else {
                throw RelayGuardManagementFailure.releaseNotInstallable
            }
            guard RelayGuardManagementRelease.runtimeProtectionReady, RelayGuardManagementRelease.completeClientScopeReady,
                  RelayGuardLineageRelease.runtimeMonitoringReady else {
                throw RelayGuardManagementFailure.trustedPolicyBindingUnavailable
            }
        }
        // A release metadata bit alone is never policy authority. Only the
        // native main-process session supplies the signed-XPC prepared lease.
        if operation == .enable {
            guard let policyReady else { throw RelayGuardManagementFailure.trustedPolicyBindingUnavailable }
            do { try policyReady() }
            catch { throw RelayGuardManagementFailure.trustedPolicyBindingUnavailable }
        }
        let root = Bundle.main.bundleURL
        guard root.pathExtension == "app", Bundle.main.bundleIdentifier == RelayGuardContract.applicationID,
              let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              !version.isEmpty, version.utf8.count <= 64 else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        let ext = root.appendingPathComponent("Contents/Library/SystemExtensions/" + RelayGuardContract.extensionID + ".systemextension")
        let application = RelayGuardReadiness.observe(root), component = RelayGuardReadiness.observe(ext)
        guard application.presence == "present", component.presence == "present",
              application.bundleIdentifier == RelayGuardContract.applicationID,
              application.signingIdentifier == RelayGuardContract.applicationID,
              component.bundleIdentifier == RelayGuardContract.extensionID,
              component.signingIdentifier == RelayGuardContract.extensionID,
              application.signature == "staticValid", component.signature == "staticValid",
              application.team == team, component.team == team,
              application.version == version, component.version == version,
              application.installEntitlement, application.networkEntitlement,
              component.networkEntitlement, component.sandboxEntitlement else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        let hostRequirement = try requirement(identifier: RelayGuardContract.applicationID, team: team)
        let extensionRequirement = try requirement(identifier: RelayGuardContract.extensionID, team: team)
        try verify(root, requirement: hostRequirement)
        let extensionCode = try verify(ext, requirement: extensionRequirement)
        try requireFilterEntry(for: operation, team: team, info: signedInfo(extensionCode))
        if operation != .disable {
            guard version == RelayGuardManagementRelease.buildVersion,
                  version == RelayGuardLineageRelease.buildVersion,
                  RelayGuardLineageRelease.publisherTeamID == team else {
                throw RelayGuardManagementFailure.packageIdentityUnconfirmed
            }
            let group = team + "." + RelayGuardContract.extensionID
            try verifyGroup(root, expected: group)
            try verifyGroup(ext, expected: group)
            try verifyLineage(root: root, team: team, version: version, group: group)
        }
        var ownCode: SecCode?
        guard SecCodeCopySelf([], &ownCode) == errSecSuccess, let ownCode,
              SecCodeCheckValidity(ownCode, .noNetworkAccess, hostRequirement) == errSecSuccess else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        return Self(version: version, operation: operation)
    }

    // Existing signed, owned preferences must remain recoverable even if the
    // bundled Provider has an unusable entry point and cannot start or reply.
    static func requireFilterEntry(for operation: RelayGuardManagementOperation, team: String,
                                   info: @autoclosure () -> [String: Any]?) throws {
        guard operation != .disable else { return }
        guard RelayGuardXPCIdentity.validatedFilterService(info: info(), team: team) != nil else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
    }

    private static func signedInfo(_ code: SecStaticCode) -> [String: Any]? {
        var copied: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess,
              let info = copied as? [String: Any] else { return nil }
        return info[kSecCodeInfoPList as String] as? [String: Any]
    }

    // Optional for the ordinary App and for NE disable/revoke recovery. Only
    // install/enable require the two exact publisher components as one pair.
    private static func verifyLineage(root: URL, team: String, version: String, group: String) throws {
        let identifier = RelayGuardLineageRelease.extensionID
        guard identifier == RelayGuardContract.extensionID + ".lineage" else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        let url = root.appendingPathComponent("Contents/Library/SystemExtensions/" + identifier + ".systemextension")
        do {
            try NetworkConfiguration.checkPlainPath(url.appendingPathComponent("Contents/MacOS/" + RelayGuardLineageRelease.executable))
        } catch { throw RelayGuardManagementFailure.packageIdentityUnconfirmed }
        let observed = RelayGuardReadiness.observe(url)
        guard observed.presence == "present", observed.bundleIdentifier == identifier,
              observed.signingIdentifier == identifier, observed.signature == "staticValid",
              observed.team == team, observed.version == version,
              let bundle = Bundle(url: url),
              bundle.object(forInfoDictionaryKey: "CFBundleExecutable") as? String == RelayGuardLineageRelease.executable,
              bundle.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "SYSX",
              bundle.object(forInfoDictionaryKey: "NSEndpointSecurityMachServiceName") as? String == team + "." + identifier + ".ipc" else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        try verify(url, requirement: requirement(identifier: identifier, team: team))
        try verifyGroup(url, expected: group)
        var code: SecStaticCode?, copied: CFDictionary?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess,
              let info = copied as? [String: Any],
              let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
              let permission = entitlements["com.apple.developer.endpoint-security.client"] as? NSNumber,
              CFGetTypeID(permission) == CFBooleanGetTypeID(), permission.boolValue,
              entitlements["com.apple.developer.networking.networkextension"] == nil else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        // Revalidate the signed containing App after all component reads. No
        // readiness or FDA result is inferred from package metadata.
        try verify(root, requirement: requirement(identifier: RelayGuardContract.applicationID, team: team))
    }

    private static func verifyGroup(_ url: URL, expected: String) throws {
        var code: SecStaticCode?, copied: CFDictionary?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess,
              let info = copied as? [String: Any],
              let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
              entitlements["com.apple.security.application-groups"] as? [String] == [expected] else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
    }

    private static func requirement(identifier: String, team: String) throws -> SecRequirement {
        var value: SecRequirement?
        let expression = "anchor apple generic and identifier \"" + identifier
            + "\" and certificate leaf[subject.OU] = \"" + team + "\""
        guard SecRequirementCreateWithString(expression as CFString, [], &value) == errSecSuccess,
              let value else { throw RelayGuardManagementFailure.packageIdentityUnconfirmed }
        return value
    }

    @discardableResult
    private static func verify(_ url: URL, requirement: SecRequirement) throws -> SecStaticCode {
        var code: SecStaticCode?
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess)
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        return code
    }
}
