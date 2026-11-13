import AppKit
import CryptoKit
import Foundation
@preconcurrency import NetworkExtension
@preconcurrency import SystemExtensions

enum RelayGuardActivationResult: Sendable {
    case completed, rebootRequired, failed, cancelled
}

enum RelayGuardInstallationComponent: Sendable {
    case lineage, filter
    var identifier: String {
        self == .lineage ? RelayGuardLineageRelease.extensionID : RelayGuardContract.extensionID
    }
}

enum RelayGuardInstallationStep: String, Sendable {
    case notRequested, requesting, awaitingUserApproval, completed, rebootRequired, failed, cancelled
}

/// Historical OS request receipts for this Main lifetime, not installed/running
/// facts. In particular, approval never attests ES subscription or FDA access.
struct RelayGuardInstallationReceipt: Sendable {
    var lineage: RelayGuardInstallationStep = .notRequested
    var filter: RelayGuardInstallationStep = .notRequested
    let monitoringVerified = false
    let fullDiskAccess = "notQueried"
    var unconfirmed: Bool {
        (lineage != .notRequested || filter != .notRequested)
            && !(lineage == .completed && filter == .completed)
    }
    var rebootRequired: Bool { lineage == .rebootRequired || filter == .rebootRequired }
    mutating func set(_ step: RelayGuardInstallationStep, for component: RelayGuardInstallationComponent) {
        if component == .lineage { lineage = step } else { filter = step }
    }
    mutating func set(_ result: RelayGuardActivationResult, for component: RelayGuardInstallationComponent) {
        let step: RelayGuardInstallationStep
        switch result {
        case .completed: step = .completed
        case .rebootRequired: step = .rebootRequired
        case .failed: step = .failed
        case .cancelled: step = .cancelled
        }
        set(step, for: component)
    }
}

struct RelayGuardFilterObservation: Equatable, Sendable {
    let exists: Bool
    let owned: Bool
    let enabled: Bool
    let revision: String
}

enum RelayGuardExtensionStatus: String, Sendable {
    case absent, enabled, disabled, awaitingUserApproval, uninstalling, differentVersion, unknown
}

struct RelayGuardExtensionObservation: Sendable {
    let lineage: RelayGuardExtensionStatus
    let filter: RelayGuardExtensionStatus
}

enum RelayGuardManagementPhase: Sendable {
    case idle, checking, awaitingUserApproval, activationCompleted, rebootRequired
    case configurationEnabled, configurationDisabled, failedUnchanged, uncertain
    case blocked(RelayGuardManagementFailure)
}

/// Configuration/activation facts only; none of these states establish runtime
/// blocking. The persistent host must retain this controller through callbacks.
struct RelayGuardManagementState: Sendable {
    var phase: RelayGuardManagementPhase = .idle
    var configuration: RelayGuardFilterObservation?
    var installation: RelayGuardInstallationReceipt?
    var extensions: RelayGuardExtensionObservation?
    var pending = false
    var systemOperationAttempted = false
    let protectionVerified = false

    var confirmedDisabledAfterMutation: RelayGuardFilterObservation? {
        guard systemOperationAttempted, let configuration,
              configuration.exists, configuration.owned, !configuration.enabled else { return nil }
        return configuration
    }
}

@MainActor
protocol RelayGuardManagementAdapter: AnyObject {
    func activate(_ component: RelayGuardInstallationComponent, needsApproval: @escaping @MainActor @Sendable () -> Void) async -> RelayGuardActivationResult
    func loadConfiguration() async throws -> RelayGuardFilterObservation
    func extensionStatus(_ component: RelayGuardInstallationComponent) async -> RelayGuardExtensionStatus
    func saveEnabled(_ enabled: Bool, expected: RelayGuardFilterObservation) async throws
}

/// The signed Main host retains this controller across OS callbacks. Current
/// null/false publisher gates reject before adapter/system-manager creation.
@MainActor
final class RelayGuardManagementController {
    private typealias Access = (version: String, makeAdapter: @MainActor () -> any RelayGuardManagementAdapter)
    private struct Authorization {
        let operation: RelayGuardManagementOperation
        let version: String
        let revision: String
        let requestID: UUID
    }
    private static var activeTransaction: UUID?
    private let inspect: (RelayGuardManagementOperation, (() throws -> Void)?) throws -> Access
    #if RELAY_GUARD_MANAGEMENT_FIXTURE
    private var beforeRevalidation: () async throws -> Void = {}
    #endif
    private(set) var state = RelayGuardManagementState()

    init(makeAdapter: @escaping @MainActor (RelayGuardManagementPermit) -> any RelayGuardManagementAdapter = {
        RelayGuardAppleManagementAdapter(permit: $0)
    }) {
        inspect = { operation, policyReady in
            let permit = try RelayGuardManagementPermit.inspect(for: operation, policyReady: policyReady)
            return (permit.version, { makeAdapter(permit) })
        }
    }

    #if RELAY_GUARD_MANAGEMENT_FIXTURE
    init(fixtureAdapter: any RelayGuardManagementAdapter,
         inspectVersion: @escaping (RelayGuardManagementOperation) throws -> String,
         beforeRevalidation: @escaping () async throws -> Void = {}) {
        inspect = { operation, _ in (try inspectVersion(operation), { fixtureAdapter }) }
        self.beforeRevalidation = beforeRevalidation
    }
    #endif

    func perform(_ operation: RelayGuardManagementOperation, policyReady: (() throws -> Void)? = nil, refreshPolicy: (() async throws -> Void)? = nil, isCurrent: @escaping @Sendable () -> Bool = { true }) async {
        guard !state.pending else { return }
        guard Self.activeTransaction == nil else {
            state = RelayGuardManagementState(phase: .blocked(.operationPending), installation: state.installation)
            return
        }
        let transaction = UUID()
        Self.activeTransaction = transaction
        state = RelayGuardManagementState(phase: .checking,
            installation: state.installation, pending: true)
        defer {
            state.pending = false
            if Self.activeTransaction == transaction { Self.activeTransaction = nil }
        }
        do {
            guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
            if operation == .enable { try await refreshPolicy?() }
            guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
            let permit = try inspect(operation, policyReady)
            let adapter = permit.makeAdapter()
            // Activating an extension can start its Provider when an old filter
            // configuration is already enabled. Installation also needs a fresh
            // configuration observation and an exact requested-action binding.
            let before = try await adapter.loadConfiguration()
            guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
            if operation == .disable && (!before.exists || !before.owned) {
                throw RelayGuardManagementFailure.configurationOwnershipUnconfirmed
            }
            if (before.exists || before.enabled) && !before.owned {
                throw RelayGuardManagementFailure.configurationOwnershipUnconfirmed
            }
            state.configuration = before
            let requestID = UUID()
            #if RELAY_GUARD_MANAGEMENT_FIXTURE
            try await beforeRevalidation()
            #else
            try RelayGuardActionContext.check(isCurrent: isCurrent)
            #endif
            let authorization = Authorization(operation: operation, version: permit.version,
                revision: before.revision, requestID: requestID)
            // An explicit action still rechecks the signed package and exact
            // loaded configuration before any mutation.
            guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
            if operation == .enable { try await refreshPolicy?() }
            guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
            let current = try await adapter.loadConfiguration()
            guard current == before, current.revision == authorization.revision else {
                throw RelayGuardManagementFailure.configurationChanged
            }
            guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
            let currentPermit = try inspect(operation, policyReady)
            guard authorization.operation == operation, authorization.version == currentPermit.version,
                  authorization.requestID == requestID else { throw RelayGuardManagementFailure.configurationChanged }
            guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
            if operation == .install {
                // Fixed identifiers and order only. One explicit action
                // authorizes this sequence, never replacement or auto-enable.
                for component in [RelayGuardInstallationComponent.lineage, .filter] {
                    if component == .filter {
                        let observed = try await adapter.loadConfiguration()
                        state.configuration = observed
                        guard observed == before, observed.revision == authorization.revision else {
                            throw RelayGuardManagementFailure.configurationChanged
                        }
                        guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
                        guard try inspect(.install, nil).version == authorization.version else {
                            throw RelayGuardManagementFailure.configurationChanged
                        }
                    }
                    guard isCurrent() else { throw RelayGuardManagementFailure.userCancelled }
                    // A refused/cancelled preparation must not erase a prior
                    // partial request. Start a new receipt only at submission.
                    if component == .lineage { state.installation = RelayGuardInstallationReceipt() }
                    state.installation?.set(.requesting, for: component)
                    state.systemOperationAttempted = true
                    let result = await adapter.activate(component) { [weak self] in
                        self?.state.installation?.set(.awaitingUserApproval, for: component)
                        self?.state.phase = isCurrent() ? .awaitingUserApproval : .uncertain
                    }
                    state.installation?.set(result, for: component)
                    // Activation can start an already-enabled NE configuration.
                    // On any failure only observe facts; never deactivate the
                    // first component or rewrite preferences as a rollback.
                    state.configuration = try? await adapter.loadConfiguration()
                    guard isCurrent() else { state.phase = .uncertain; return }
                    switch result {
                    case .completed:
                        guard state.configuration == before else { state.phase = .uncertain; return }
                        state.phase = .checking
                    case .rebootRequired:
                        state.phase = state.configuration == nil ? .uncertain : .rebootRequired
                        return
                    case .failed, .cancelled:
                        state.phase = .uncertain
                        return
                    }
                }
                state.phase = .activationCompleted
                return
            }
            let enabled = operation == .enable
            if enabled { try policyReady?() }
            state.systemOperationAttempted = true
            do {
                try await adapter.saveEnabled(enabled, expected: before)
                let observed = try await adapter.loadConfiguration()
                state.configuration = observed
                guard isCurrent() else { state.phase = .uncertain; return }
                state.phase = observed.owned && observed.enabled == enabled
                    ? (enabled ? .configurationEnabled : .configurationDisabled) : .uncertain
            } catch {
                // Do not restore by blindly overwriting a possible external edit.
                // A fresh read separates unchanged, saved-target and unknown facts.
                guard let observed = try? await adapter.loadConfiguration() else {
                    state.configuration = nil
                    state.phase = .uncertain
                    return
                }
                state.configuration = observed
                guard isCurrent() else { state.phase = .uncertain; return }
                if observed == before { state.phase = .failedUnchanged }
                else if observed.owned && observed.enabled == enabled {
                    state.phase = enabled ? .configurationEnabled : .configurationDisabled
                } else { state.phase = .uncertain }
            }
        } catch let failure as RelayGuardManagementFailure {
            state.configuration = nil
            state.phase = state.systemOperationAttempted || state.installation?.unconfirmed == true
                ? .uncertain : .blocked(failure)
        } catch {
            state.configuration = nil
            state.phase = .uncertain
        }
    }

    func refresh(includeExtensionStatus: Bool = false) async {
        guard !state.pending, Self.activeTransaction == nil else { return }
        let transaction = UUID(); Self.activeTransaction = transaction
        state = RelayGuardManagementState(phase: .checking, installation: state.installation, pending: true)
        defer { state.pending = false; if Self.activeTransaction == transaction { Self.activeTransaction = nil } }
        do {
            let permit = try inspect(.disable, nil)
            let adapter = permit.makeAdapter()
            if includeExtensionStatus {
                let lineage = await adapter.extensionStatus(.lineage)
                let filter = await adapter.extensionStatus(.filter)
                state.extensions = .init(lineage: lineage, filter: filter)
            }
            // The registration queries can wait for system replies. Keep the
            // configuration observation used by lease recovery at the end.
            let observed = try await adapter.loadConfiguration()
            state.configuration = observed
            if state.installation?.rebootRequired == true { state.phase = .rebootRequired }
            else if state.installation?.unconfirmed == true {
                // A NE preference read cannot resolve a partial ES/NE request.
                // Keep that uncertainty until a new explicit install sequence;
                // disable/revoke remain independent recovery actions.
                state.phase = .uncertain
            } else {
                state.phase = observed.owned ? (observed.enabled ? .configurationEnabled : .configurationDisabled) : .idle
            }
        } catch let failure as RelayGuardManagementFailure {
            state.configuration = nil
            state.phase = state.installation?.unconfirmed == true ? .uncertain : .blocked(failure)
        } catch { state.configuration = nil; state.phase = .uncertain }
    }


}

/// Apple FilteringNetworkTraffic sample, pinned archive 73bdbda7edfc6ecc… .
/// Uses its activation delegate and load/save APIs, with explicit ownership,
/// readback, persistent delegate lifetime and replacement cancellation added.
@MainActor
private final class RelayGuardAppleManagementAdapter: RelayGuardManagementAdapter {
    private let permit: RelayGuardManagementPermit
    private lazy var manager = NEFilterManager.shared()
    private var requestID: UUID?
    private var delegate: RelayGuardActivationDelegate?

    init(permit: RelayGuardManagementPermit) { self.permit = permit }

    func activate(_ component: RelayGuardInstallationComponent, needsApproval: @escaping @MainActor @Sendable () -> Void) async -> RelayGuardActivationResult {
        guard permit.operation == .install, requestID == nil else { return .failed }
        let id = UUID(), request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: component.identifier, queue: .main)
        requestID = id
        return await withCheckedContinuation { continuation in
            let bridge = RelayGuardActivationDelegate(request: request) { [self] event in
                guard self.requestID == id else { return }
                if case .needsApproval = event { needsApproval(); return }
                if case .properties = event { return }
                self.requestID = nil; self.delegate = nil
                switch event {
                case .completed: continuation.resume(returning: .completed)
                case .rebootRequired: continuation.resume(returning: .rebootRequired)
                case .failed: continuation.resume(returning: .failed)
                case .cancelled: continuation.resume(returning: .cancelled)
                case .needsApproval, .properties: break
                }
            }
            delegate = bridge
            request.delegate = bridge
            OSSystemExtensionManager.shared.submitRequest(request)
        }
    }

    func extensionStatus(_ component: RelayGuardInstallationComponent) async -> RelayGuardExtensionStatus {
        guard requestID == nil else { return .unknown }
        let id = UUID(), request = OSSystemExtensionRequest.propertiesRequest(
            forExtensionWithIdentifier: component.identifier, queue: .main)
        requestID = id
        return await withCheckedContinuation { continuation in
            let finish: @MainActor @Sendable (RelayGuardExtensionStatus) -> Void = { [self] status in
                guard self.requestID == id else { return }
                self.requestID = nil; self.delegate = nil
                continuation.resume(returning: status)
            }
            let bridge = RelayGuardActivationDelegate(request: request, expectedVersion: permit.version) { event in
                switch event {
                case .properties(let status): finish(status)
                case .failed, .cancelled, .needsApproval, .rebootRequired: finish(.unknown)
                case .completed: break // Only foundProperties supplies an observation.
                }
            }
            delegate = bridge
            request.delegate = bridge
            OSSystemExtensionManager.shared.submitRequest(request)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                finish(.unknown)
            }
        }
    }

    func loadConfiguration() async throws -> RelayGuardFilterObservation {
        try await withCheckedThrowingContinuation { continuation in
            manager.loadFromPreferences { [weak self] error in
                let failed = error != nil
                Task { @MainActor in
                    guard let self, !failed else {
                        continuation.resume(throwing: RelayGuardManagementFailure.systemRequestFailed)
                        return
                    }
                    do { continuation.resume(returning: try self.observe()) }
                    catch { continuation.resume(throwing: error) }
                }
            }
        }
    }

    func saveEnabled(_ enabled: Bool, expected: RelayGuardFilterObservation) async throws {
        guard permit.operation == (enabled ? .enable : .disable),
              try observe() == expected,
              expected.owned || (!expected.exists && !expected.enabled && enabled
                && manager.localizedDescription == nil && manager.grade == .firewall) else {
            throw RelayGuardManagementFailure.configurationChanged
        }
        if !expected.exists {
            let configuration = NEFilterProviderConfiguration()
            configuration.filterDataProviderBundleIdentifier = RelayGuardContract.extensionID
            configuration.filterSockets = true
            configuration.filterPackets = false
            configuration.vendorConfiguration = ["relayGuardConfigurationVersion": 1]
            manager.providerConfiguration = configuration
            manager.localizedDescription = "Relay system filter"
        }
        manager.isEnabled = enabled
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            manager.saveToPreferences { error in
                if error == nil { continuation.resume() }
                else { continuation.resume(throwing: RelayGuardManagementFailure.systemRequestFailed) }
            }
        }
    }

    private func observe() throws -> RelayGuardFilterObservation {
        // This slice only manages the socket filter. A hidden DNS-disabling
        // setting must not be inherited, including when no Provider is loaded.
        if #available(macOS 15.0, *), manager.disableEncryptedDNSSettings {
            throw RelayGuardManagementFailure.configurationOwnershipUnconfirmed
        }
        let config = manager.providerConfiguration
        let marker = config?.vendorConfiguration ?? [:]
        let numeric = marker["relayGuardConfigurationVersion"] as? NSNumber
        let ownMarker = marker.count == 1 && numeric?.doubleValue == 1 && numeric.map {
            CFGetTypeID($0) != CFBooleanGetTypeID()
        } == true
        let owned = config?.filterDataProviderBundleIdentifier == RelayGuardContract.extensionID
            && config?.filterPacketProviderBundleIdentifier == nil && config?.filterSockets == true
            && config?.filterPackets == false && ownMarker && config?.serverAddress == nil
            && config?.username == nil && config?.organization == nil
            && config?.passwordReference == nil && config?.identityReference == nil
            && manager.grade == .firewall
        let data = try JSONSerialization.data(withJSONObject: [
            "exists": config != nil, "owned": owned, "enabled": manager.isEnabled,
            "description": manager.localizedDescription ?? "", "version": permit.version
        ], options: [.sortedKeys])
        return RelayGuardFilterObservation(exists: config != nil, owned: owned, enabled: manager.isEnabled,
            revision: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }
}

private final class RelayGuardActivationDelegate: NSObject, OSSystemExtensionRequestDelegate {
    enum Event: Sendable {
        case needsApproval, completed, rebootRequired, failed, cancelled
        case properties(RelayGuardExtensionStatus)
    }
    private let request: OSSystemExtensionRequest
    private let expectedVersion: String?
    private let notify: @MainActor @Sendable (Event) -> Void
    init(request: OSSystemExtensionRequest, expectedVersion: String? = nil,
         notify: @escaping @MainActor @Sendable (Event) -> Void) {
        self.request = request
        self.expectedVersion = expectedVersion
        self.notify = notify
    }
    private func send(_ event: Event, for value: OSSystemExtensionRequest) {
        guard value === request else { return }
        let notify = notify
        Task { @MainActor in notify(event) }
    }
    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) { send(.needsApproval, for: request) }
    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        let value = error as NSError
        let cancelled = value.domain == OSSystemExtensionErrorDomain
            && value.code == OSSystemExtensionError.Code.requestCanceled.rawValue
        send(cancelled ? .cancelled : .failed, for: request)
    }
    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        switch result {
        case .completed: send(.completed, for: request)
        case .willCompleteAfterReboot: send(.rebootRequired, for: request)
        @unknown default: send(.failed, for: request)
        }
    }
    func request(_ request: OSSystemExtensionRequest, foundProperties properties: [OSSystemExtensionProperties]) {
        guard request === self.request, let expectedVersion else { return }
        let status: RelayGuardExtensionStatus
        if properties.isEmpty { status = .absent }
        else if properties.count != 1 || properties[0].bundleIdentifier != request.identifier { status = .unknown }
        else {
            let value = properties[0]
            if value.bundleVersion != expectedVersion { status = .differentVersion }
            else if value.isUninstalling { status = .uninstalling }
            else if value.isAwaitingUserApproval { status = .awaitingUserApproval }
            else { status = value.isEnabled ? .enabled : .disabled }
        }
        send(.properties(status), for: request)
    }
    func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        .cancel
    }
}

// An explicit UI action carries the Main-issued intent. Removing an extra
// Yes/No sheet does not remove cancellation or the existing window/modal gate.
@MainActor enum RelayGuardActionContext {
    static func validate(current: Bool, visibleWindow: Bool, sheetOpen: Bool,
                         modalOpen: Bool, requiresWindow: Bool = true) throws {
        guard current, !requiresWindow || visibleWindow else { throw RelayGuardManagementFailure.userCancelled }
        guard !sheetOpen, !modalOpen else { throw RelayGuardManagementFailure.operationPending }
    }
    static func check(isCurrent: @Sendable () -> Bool, requiresWindow: Bool = true) throws {
        let parent = NSApp.keyWindow
        try validate(current: isCurrent(), visibleWindow: parent?.isVisible == true,
            sheetOpen: parent?.sheetParent != nil || parent?.attachedSheet != nil,
            modalOpen: NSApp.modalWindow != nil, requiresWindow: requiresWindow)
    }
}
