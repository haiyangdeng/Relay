import Foundation

/// Publisher-owned compiled authority. No preference, IPC or manifest can
/// enable the monitor. The ordinary App remains usable without this resource.
enum RelayGuardLineageRelease {
    static let extensionID = RelayGuardContract.extensionID + ".lineage"
    static let executable = "RelayGuardLineageExtension"
    static let contractRevision = "relay-guard-lineage-v3"
    static let catalogRevision = "claude-codex-terminal-cli-roots-v4"
    static let runtimeMonitoringReady = false
    static let systemInstallationSupported = false
    static let globalCoverageReady = false
    static var buildVersion: String { RelayGuardManagementRelease.buildVersion }
    static var publisherTeamID: String? { RelayGuardManagementRelease.publisherTeamID }
}
