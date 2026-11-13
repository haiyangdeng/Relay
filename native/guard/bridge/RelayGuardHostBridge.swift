import AppKit
import Foundation
import Security

/// The native object lives in the signed Electron main process. It is never
/// hosted by the short-lived RelayNative command runner or a renderer process.
/// Adapted from Electron v43.8.0's Swift native-addon bridge and the existing
/// RelayGuardManagementController; loading the class performs no system work.
@objc(RelayGuardHostBridge)
public final class RelayGuardHostBridge: NSObject {
    @MainActor private static let controller = RelayGuardManagementController()

    @MainActor private static let policy = RelayGuardHostConnection()
    @MainActor private static var working = false
    @MainActor private static var scopedProof: RelayGuardProxyProof?

    @MainActor static func observeFilterForMaintenance() async -> RelayGuardFilterObservation? {
        guard !working else { return nil }
        working = true; defer { working = false }
        await controller.refresh()
        return controller.state.configuration
    }

    @objc(request:validity:completion:)
    public static func request(_ text: String, validity: @escaping @Sendable () -> Bool, completion: @escaping @Sendable (String) -> Void) {
        guard let bytes = text.data(using: .utf8), bytes.count <= 3 * 1024 * 1024,
              let value = try? RelayTunStrictJSON.object(bytes, limit: 3 * 1024 * 1024, maxNodes: 200000),
              let version = value["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let id = value["id"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
              let action = value["action"] as? String,
              ["status", "install", "enable", "disable", "bind", "revoke", "launchDesktop", "verifyScopedCore", "scopedCoreStatus", "revokeScopedCore"].contains(action),
              Set(value.keys) == Set(["version", "id", "action"] + (["bind", "verifyScopedCore"].contains(action) ? ["instanceID", "configuration", "pid"] : [])) else {
            completion("{\"version\":1,\"error\":\"invalidRequest\"}")
            return
        }
        // Extract Sendable values before crossing into the main actor. bind is
        // a Main-only method; no renderer channel accepts these three fields.
        let instance = value["instanceID"] as? String, configuration = value["configuration"] as? String
        let pid = RelayTunStrictJSON.integer(value["pid"])
        Task { @MainActor in
            let independentScopedRead = ["scopedCoreStatus", "revokeScopedCore"].contains(action)
            if working && !independentScopedRead { completion(encode(id: id, action: action, state: RelayGuardManagementState(phase: .blocked(.operationPending), pending: true))); return }
            if !independentScopedRead { working = true }
            defer { if !independentScopedRead { working = false } }
            var failure: RelayGuardManagementFailure?
            guard validity() else { completion(encode(id: id, action: action, state: RelayGuardManagementState(phase: .blocked(.userCancelled)))); return }
            do {
                switch action {
                case "verifyScopedCore":
                    scopedProof = nil
                    guard RelayGuardManagementRelease.scopedCLILaunchSupported else { throw RelayGuardManagementFailure.trustedPolicyBindingUnavailable }
                    try verifyScopedHost()
                    guard let instance, let configuration, let pid, pid > 0, pid <= Int(Int32.max) else { throw RelayGuardBindingFailure.invalid }
                    scopedProof = try RelayGuardProxyProof.issue(instanceID: instance, configuration: configuration, pid: Int32(pid))
                case "scopedCoreStatus":
                    guard let scopedProof else { throw RelayGuardBindingFailure.stale }
                    do { try scopedProof.verify() } catch { self.scopedProof = nil; throw error }
                case "revokeScopedCore": scopedProof = nil
                case "bind":
                    _ = try RelayGuardManagementPermit.inspect(for: .disable)
                    guard let instance, let configuration, let pid, pid > 0, pid <= Int(Int32.max) else { throw RelayGuardBindingFailure.invalid }
                    let proof = try RelayGuardProxyProof.issue(instanceID: instance, configuration: configuration, pid: Int32(pid))
                    await controller.refresh()
                    policy.confirmDisabled(controller.state.configuration)
                    try await policy.prepare(proof, connect: controller.state.configuration?.owned == true && controller.state.configuration?.enabled == true)
                case "revoke": try await policy.revoke()
                case "status":
                    await controller.refresh(includeExtensionStatus: true)
                    policy.confirmDisabled(controller.state.configuration)
                    if policy.isBound { _ = try await policy.status() }
                case "launchDesktop": try await launchDesktop(isCurrent: validity)
                default:
                    if let operation = RelayGuardManagementOperation(rawValue: action) {
                        await controller.perform(operation, policyReady: { try policy.authorizePrepared() },
                            refreshPolicy: { try policy.refreshForEnable() }, isCurrent: validity)
                        if operation == .disable, let observation = controller.state.confirmedDisabledAfterMutation {
                            try? await policy.revoke()
                            policy.confirmDisabled(observation)
                        }
                        if operation == .enable, validity(), case .configurationEnabled = controller.state.phase, controller.state.configuration?.owned == true, controller.state.configuration?.enabled == true {
                            // One bind attempt after confirmed save/readback. Failure keeps
                            // configuration facts; no client launch or automatic rollback.
                            try? await policy.connectPrepared()
                        }
                    }
                }
            } catch let reason as RelayGuardManagementFailure { failure = reason }
            catch { failure = .trustedPolicyBindingUnavailable }
            let scopedAction = ["verifyScopedCore", "scopedCoreStatus", "revokeScopedCore"].contains(action)
            let state = failure.map { RelayGuardManagementState(phase: .blocked($0)) } ?? (scopedAction ? RelayGuardManagementState() : controller.state)
            completion(encode(id: id, action: action, state: state))
        }
    }

    @MainActor private static func verifyScopedHost() throws {
        // This separate signed release capability does not assert that a system
        // filter is installed, enabled or that all external CLI are covered.
        guard Bundle.main.bundleIdentifier == RelayGuardContract.applicationID,
              let team = RelayGuardManagementRelease.publisherTeamID,
              team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil,
              RelayGuardHostIntegrity.inspect(executable: Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/relay/RelayNative")).trusted else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        var requirement: SecRequirement?, code: SecCode?
        let expression = "anchor apple generic and identifier \"" + RelayGuardContract.applicationID + "\" and certificate leaf[subject.OU] = \"" + team + "\""
        guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, .noNetworkAccess, requirement) == errSecSuccess else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
    }

    @MainActor private static func launchDesktop(isCurrent: @escaping @Sendable () -> Bool) async throws {
        // This deliberate release gate cannot be flipped by a renderer. Node
        // interpreters and their tool descendants still lack an admitted origin
        // protocol; native-only success cannot claim the user's complete scope.
        guard RelayGuardManagementRelease.completeClientScopeReady else { throw RelayGuardManagementFailure.trustedPolicyBindingUnavailable }
        _ = try await policy.status()
        _ = try RelayGuardManagementPermit.inspect(for: .enable, policyReady: { try policy.authorizePrepared(requireRunning: true) })
        await controller.refresh()
        guard controller.state.configuration?.owned == true, controller.state.configuration?.enabled == true else {
            throw RelayGuardManagementFailure.configurationOwnershipUnconfirmed
        }
        try RelayGuardActionContext.check(isCurrent: isCurrent)
        _ = try await policy.status()
        try policy.authorizePrepared(requireRunning: true)
        await controller.refresh()
        guard controller.state.configuration?.owned == true, controller.state.configuration?.enabled == true else {
            throw RelayGuardManagementFailure.configurationOwnershipUnconfirmed
        }
        try policy.authorizePrepared(requireRunning: true)
        guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
        let url = RelayDesktopInspection.claudeURL
        var requirement: SecRequirement?, code: SecStaticCode?
        let expression = "anchor apple generic and identifier \"com.anthropic.claudefordesktop\" and certificate leaf[subject.OU] = \"" + RelayGuardIdentityClassifier.teamID + "\""
        guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess), requirement) == errSecSuccess,
              !NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == "com.anthropic.claudefordesktop" }) else {
            throw RelayGuardManagementFailure.packageIdentityUnconfirmed
        }
        let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    @MainActor private static func encode(id: String, action: String, state: RelayGuardManagementState) -> String {
        let phase: String, reason: String?
        switch state.phase {
        case .idle: phase = "idle"; reason = nil
        case .checking: phase = "checking"; reason = nil
        case .awaitingUserApproval: phase = "awaitingUserApproval"; reason = nil
        case .activationCompleted: phase = "activationCompleted"; reason = nil
        case .rebootRequired: phase = "rebootRequired"; reason = nil
        case .configurationEnabled: phase = "configurationEnabled"; reason = nil
        case .configurationDisabled: phase = "configurationDisabled"; reason = nil
        case .failedUnchanged: phase = "failedUnchanged"; reason = nil
        case .uncertain: phase = "uncertain"; reason = nil
        case .blocked(let failure):
            phase = "blocked"
            switch failure {
            case .publisherNotConfigured: reason = "publisherNotConfigured"
            case .releaseNotInstallable: reason = "releaseNotInstallable"
            case .trustedPolicyBindingUnavailable: reason = "trustedPolicyBindingUnavailable"
            case .packageIdentityUnconfirmed: reason = "packageIdentityUnconfirmed"
            case .operationPending: reason = "operationPending"
            case .userCancelled: reason = "userCancelled"
            case .configurationChanged: reason = "configurationChanged"
            case .configurationOwnershipUnconfirmed: reason = "configurationOwnershipUnconfirmed"
            case .systemRequestFailed: reason = "systemRequestFailed"
            }
        }
        var value: [String: Any] = [
            "version": 1, "id": id, "action": action, "phase": phase,
            "pending": state.pending, "systemOperationAttempted": state.systemOperationAttempted,
            "protectionVerified": false, "runtimeEnforcement": "notVerified", "policy": policy.publicState
        ]
        if let scopedProof {
            value["scopedPolicy"] = ["phase": "prepared", "instanceID": scopedProof.instanceID, "configurationSHA256": scopedProof.configurationSHA256]
        } else { value["scopedPolicy"] = ["phase": "unbound"] }
        if let reason { value["reason"] = reason }
        if let configuration = state.configuration {
            value["configuration"] = ["exists": configuration.exists, "owned": configuration.owned,
                "enabled": configuration.enabled, "revision": configuration.revision]
        }
        if let installation = state.installation ?? controller.state.installation {
            value["installation"] = ["lineage": installation.lineage.rawValue, "filter": installation.filter.rawValue,
                "monitoringVerified": false, "fullDiskAccess": "notQueried"]
        }
        if let extensions = state.extensions {
            value["extensions"] = ["lineage": extensions.lineage.rawValue, "filter": extensions.filter.rawValue]
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let text = String(data: bytes, encoding: .utf8) else {
            return "{\"version\":1,\"error\":\"encodingFailed\"}"
        }
        return text
    }
}
