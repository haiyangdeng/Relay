#if RELAY_GUARD_MANAGEMENT_FIXTURE
import Darwin
import Foundation

// This executable uses the real controller and permit entry. The default
// release gate must refuse before reaching filesystem/signature inspection.
enum NetworkConfiguration {
    static func checkPlainPath(_ url: URL) throws {
        preconditionFailure("The default-off fixture must not inspect a real package.")
    }
}

private final class FixtureIntent: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true

    func isCurrent() -> Bool { lock.withLock { valid } }
    func invalidate() { lock.withLock { valid = false } }
}

@MainActor
private final class FixtureAdapter: RelayGuardManagementAdapter {
    var configuration: RelayGuardFilterObservation
    var activationResults: [RelayGuardActivationResult] = []
    var onActivation: (() -> Void)?
    var appliedSave = true
    var saveError = false
    var failReadback = false
    var installedLineage: RelayGuardExtensionStatus = .unknown
    var installedFilter: RelayGuardExtensionStatus = .unknown
    var onExtensionRead: ((RelayGuardInstallationComponent) -> Void)?
    private(set) var loaded = 0
    private(set) var activations: [RelayGuardInstallationComponent] = []
    private(set) var saves: [Bool] = []
    private(set) var extensionReads: [RelayGuardInstallationComponent] = []

    init(_ configuration: RelayGuardFilterObservation) { self.configuration = configuration }

    func activate(_ component: RelayGuardInstallationComponent,
                  needsApproval: @escaping @MainActor @Sendable () -> Void) async -> RelayGuardActivationResult {
        activations.append(component)
        needsApproval()
        await Task.yield()
        onActivation?()
        precondition(!activationResults.isEmpty)
        return activationResults.removeFirst()
    }

    func loadConfiguration() async throws -> RelayGuardFilterObservation {
        loaded += 1
        if failReadback, !saves.isEmpty { throw RelayGuardManagementFailure.systemRequestFailed }
        return configuration
    }

    func extensionStatus(_ component: RelayGuardInstallationComponent) async -> RelayGuardExtensionStatus {
        extensionReads.append(component)
        onExtensionRead?(component)
        return component == .lineage ? installedLineage : installedFilter
    }

    func saveEnabled(_ enabled: Bool, expected: RelayGuardFilterObservation) async throws {
        precondition(configuration == expected)
        saves.append(enabled)
        if appliedSave {
            configuration = .init(exists: true, owned: true, enabled: enabled, revision: "saved")
        }
        if saveError { throw RelayGuardManagementFailure.systemRequestFailed }
    }
}

@main
@MainActor
enum RelayGuardManagementControllerTests {
    private static let ownedEnabled = RelayGuardFilterObservation(exists: true, owned: true, enabled: true, revision: "before")

    static func main() async throws {
        try actionContextGate()
        await defaultGate()
        try filterEntryContract()
        await cancellationAndStaleIntent()
        await changedConfigurationAndPackage()
        await partialInstall()
        await staleBetweenComponents()
        await disableReadbacks()
        await extensionReadbacks()
        print("PASS: filter management state machine, with injected preferences, action context and OS activation.")
    }

    private static func controller(_ adapter: FixtureAdapter,
                                   inspect: @escaping (RelayGuardManagementOperation) throws -> String = { _ in "3" },
                                   beforeRevalidation: @escaping () async throws -> Void = {}) -> RelayGuardManagementController {
        RelayGuardManagementController(fixtureAdapter: adapter, inspectVersion: inspect) { try await beforeRevalidation() }
    }

    private static func actionContextGate() throws {
        try RelayGuardActionContext.validate(current: true, visibleWindow: true, sheetOpen: false, modalOpen: false)
        try RelayGuardActionContext.validate(current: true, visibleWindow: false, sheetOpen: false, modalOpen: false, requiresWindow: false)
        for current in [false, true] {
            do {
                try RelayGuardActionContext.validate(current: current, visibleWindow: false, sheetOpen: false, modalOpen: false)
                preconditionFailure("A missing action or required window cannot execute.")
            } catch RelayGuardManagementFailure.userCancelled {}
        }
        for sheet in [false, true] {
            do {
                try RelayGuardActionContext.validate(current: true, visibleWindow: true, sheetOpen: sheet, modalOpen: !sheet)
                preconditionFailure("Existing modal UI keeps the operation blocked.")
            } catch RelayGuardManagementFailure.operationPending {}
        }
        print("PASS: direct actions retain current-intent, window and modal gates without a confirmation sheet")
    }

    private static func extensionReadbacks() async {
        let adapter = FixtureAdapter(.init(exists: true, owned: true, enabled: false, revision: "initial"))
        adapter.installedLineage = .awaitingUserApproval
        adapter.installedFilter = .enabled
        adapter.onExtensionRead = { [weak adapter] component in
            if component == .filter { adapter?.configuration = ownedEnabled }
        }
        let value = controller(adapter)
        await value.refresh(includeExtensionStatus: true)
        precondition(value.state.installation == nil)
        precondition(value.state.extensions?.lineage == .awaitingUserApproval && value.state.extensions?.filter == .enabled)
        precondition(value.state.configuration == ownedEnabled && !value.state.protectionVerified)
        precondition(adapter.extensionReads == [.lineage, .filter] && adapter.activations.isEmpty && adapter.saves.isEmpty)
        await value.refresh()
        precondition(value.state.extensions == nil && adapter.extensionReads == [.lineage, .filter])
        print("PASS: current OS extension observations are separate from request receipts and runtime protection")
    }

    private static func defaultGate() async {
        let value = RelayGuardManagementController { _ in
            preconditionFailure("Release refusal must precede construction of the OS adapter.")
        }
        await value.perform(.install)
        guard case .blocked(.publisherNotConfigured) = value.state.phase else {
            preconditionFailure("The real release gate must stay closed.")
        }
        precondition(!value.state.systemOperationAttempted && !value.state.pending)
        print("PASS: compiled release refusal precedes the OS adapter")
    }

    private static func filterEntryContract() throws {
        // Replace only the publisher placeholder in the existing release
        // Info.plist. No signed bundle, preference manager or OS calls.
        let plist = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("package/Info.plist")
        let team = "FIXTURE123", expected = team + ".local.relay.network.preview.guard.ipc"
        let data = try String(contentsOf: plist, encoding: .utf8)
            .replacingOccurrences(of: "__RELAY_PUBLISHER_TEAM_ID__", with: team).data(using: .utf8)!
        let info = try PropertyListSerialization.propertyList(from: data, format: nil) as! [String: Any]
        precondition(RelayGuardXPCIdentity.validatedFilterService(info: info, team: team) == expected)
        let changedInfo = [
            info.merging(["CFBundleExecutable": "OtherProvider"]) { _, new in new },
            info.merging(["CFBundlePackageType": "APPL"]) { _, new in new },
            info.merging(["NSEndpointSecurityMachServiceName": expected]) { _, new in new },
            info.merging(["NetworkExtension": ["NEMachServiceName": "unsigned.local.relay.network.preview.guard.ipc",
                "NEProviderClasses": ["com.apple.networkextension.filter-data": "RelayGuardExtension.RelayGuardFilterDataProvider"]]]) { _, new in new },
            info.merging(["NetworkExtension": ["NEMachServiceName": expected,
                "NEProviderClasses": ["com.apple.networkextension.filter-data": "OtherProvider"]]]) { _, new in new },
            info.merging(["NetworkExtension": ["NEMachServiceName": expected,
                "NEProviderClasses": ["com.apple.networkextension.filter-data": "RelayGuardExtension.RelayGuardFilterDataProvider",
                    "com.apple.networkextension.filter-control": "ExtraProvider"]]]) { _, new in new }
        ]
        for operation: RelayGuardManagementOperation in [.install, .enable] {
            try RelayGuardManagementPermit.requireFilterEntry(for: operation, team: team, info: info)
            for invalid in [nil] + changedInfo.map(Optional.some) {
                do {
                    try RelayGuardManagementPermit.requireFilterEntry(for: operation, team: team, info: invalid)
                    preconditionFailure("An invalid NE Info must not admit \(operation).")
                } catch RelayGuardManagementFailure.packageIdentityUnconfirmed {}
            }
        }
        var read = false
        func unusableEntry() -> [String: Any]? { read = true; return nil }
        try RelayGuardManagementPermit.requireFilterEntry(for: .disable, team: team, info: unusableEntry())
        precondition(!read, "NE disable recovery must not inspect the Provider's entry point.")
        print("PASS: fixed NE entry gates install/enable and never blocks signed disable recovery")
    }

    private static func cancellationAndStaleIntent() async {
        let cancelledAdapter = FixtureAdapter(ownedEnabled)
        let cancelled = controller(cancelledAdapter, beforeRevalidation: { throw RelayGuardManagementFailure.userCancelled })
        await cancelled.perform(.disable)
        guard case .blocked(.userCancelled) = cancelled.state.phase else { preconditionFailure("Cancel must be reported.") }
        precondition(cancelledAdapter.saves.isEmpty && cancelled.state.confirmedDisabledAfterMutation == nil)

        let intent = FixtureIntent(), staleAdapter = FixtureAdapter(ownedEnabled)
        let stale = controller(staleAdapter, beforeRevalidation: {
            await Task.yield()
            intent.invalidate()
        })
        await stale.perform(.install, isCurrent: { intent.isCurrent() })
        guard case .blocked(.userCancelled) = stale.state.phase else { preconditionFailure("The Main-issued intent became stale.") }
        precondition(staleAdapter.loaded == 1 && staleAdapter.activations.isEmpty)
        precondition(!stale.state.systemOperationAttempted && stale.state.installation == nil)
        print("PASS: revoked action context and stale intent perform no writes")
    }

    private static func changedConfigurationAndPackage() async {
        let adapter = FixtureAdapter(ownedEnabled)
        let changed = controller(adapter, beforeRevalidation: {
            adapter.configuration = .init(exists: true, owned: true, enabled: true, revision: "external")
        })
        await changed.perform(.disable)
        guard case .blocked(.configurationChanged) = changed.state.phase else {
            preconditionFailure("An external edit must invalidate the original requested action.")
        }
        precondition(adapter.saves.isEmpty && changed.state.confirmedDisabledAfterMutation == nil)

        let replacement = FixtureAdapter(ownedEnabled)
        let replaced = controller(replacement, inspect: { _ in replacement.loaded == 0 ? "3" : "4" })
        await replaced.perform(.install)
        guard case .blocked(.configurationChanged) = replaced.state.phase else {
            preconditionFailure("The replacement version cannot reuse the original requested action.")
        }
        precondition(replacement.activations.isEmpty && replacement.loaded == 2)
        print("PASS: stale preferences and a changed release version reject before mutations")
    }

    private static func partialInstall() async {
        let adapter = FixtureAdapter(ownedEnabled)
        adapter.activationResults = [.completed, .failed]
        var gateAvailable = true
        var intentAccepted = true
        let value = controller(adapter, inspect: { _ in
            guard gateAvailable else { throw RelayGuardManagementFailure.packageIdentityUnconfirmed }
            return "3"
        }, beforeRevalidation: {
            guard intentAccepted else { throw RelayGuardManagementFailure.userCancelled }
        })
        await value.perform(.install)
        precondition(adapter.activations == [.lineage, .filter] && adapter.saves.isEmpty)
        precondition(value.state.installation?.lineage == .completed && value.state.installation?.filter == .failed)
        guard case .uncertain = value.state.phase else { preconditionFailure("Partial install must stay uncertain.") }
        gateAvailable = false
        await value.refresh()
        guard case .uncertain = value.state.phase else { preconditionFailure("A failed status probe cannot resolve a partial install.") }
        precondition(value.state.installation?.lineage == .completed && value.state.installation?.filter == .failed)
        gateAvailable = true
        intentAccepted = false
        await value.perform(.disable)
        guard case .uncertain = value.state.phase else { preconditionFailure("Cancel cannot discard earlier uncertainty.") }
        precondition(adapter.saves.isEmpty && value.state.confirmedDisabledAfterMutation == nil)
        print("PASS: partial installation survives failed status and later cancellation")
    }

    private static func staleBetweenComponents() async {
        let adapter = FixtureAdapter(ownedEnabled), intent = FixtureIntent()
        adapter.activationResults = [.completed]
        adapter.onActivation = { intent.invalidate() }
        let value = controller(adapter)
        await value.perform(.install, isCurrent: { intent.isCurrent() })
        precondition(adapter.activations == [.lineage] && adapter.saves.isEmpty)
        precondition(value.state.installation?.lineage == .completed && value.state.installation?.filter == .notRequested)
        guard case .uncertain = value.state.phase else { preconditionFailure("The first submission may have completed.") }
        precondition(value.state.systemOperationAttempted && !value.state.pending)
        print("PASS: old intent keeps the real first receipt and never submits the second extension")
    }

    private static func disableReadbacks() async {
        let rejected = FixtureAdapter(ownedEnabled)
        rejected.appliedSave = false
        rejected.saveError = true
        let unchanged = controller(rejected)
        await unchanged.perform(.disable)
        guard case .failedUnchanged = unchanged.state.phase else { preconditionFailure("Readback confirms it stayed enabled.") }
        precondition(rejected.saves == [false] && unchanged.state.confirmedDisabledAfterMutation == nil)

        let lost = FixtureAdapter(ownedEnabled)
        lost.failReadback = true
        let unknown = controller(lost)
        await unknown.perform(.disable)
        guard case .uncertain = unknown.state.phase else { preconditionFailure("Missing readback is unknown.") }
        precondition(lost.saves == [false] && unknown.state.confirmedDisabledAfterMutation == nil)

        let applied = FixtureAdapter(ownedEnabled)
        applied.saveError = true
        let disabled = controller(applied)
        await disabled.perform(.disable)
        guard case .configurationDisabled = disabled.state.phase else { preconditionFailure("The final readback settles a delivered write.") }
        precondition(applied.saves == [false] && disabled.state.confirmedDisabledAfterMutation == applied.configuration)
        precondition(!disabled.state.protectionVerified)
        print("PASS: only a confirmed owned disable permits lease cleanup, even after a lost save reply")
    }
}
#endif
