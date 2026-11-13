import Foundation

// Compiled release authority, shared by read-only General inspection and the
// persistent main-process host. Never supplied by a renderer or mutable state.
enum RelayGuardManagementRelease {
    // Every signed release must pair this compiled value with both Info.plists.
    static let buildVersion = "3"
    static let sessionContractRevision = "relay-guard-session-v2"
    static let policyRevision = "relay-guard-policy-20261109-v3"
    static let publisherTeamID: String? = nil
    static let systemInstallationSupported = false
    static let runtimeProtectionReady = false
    static let completeClientScopeReady = false
    static let scopedCLILaunchSupported = false
    static let terminalCLILaunchSupported = false
}
