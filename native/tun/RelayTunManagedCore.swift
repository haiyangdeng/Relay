import Foundation
import Darwin

/// The fixed Mihomo owns TUN creation, routing, DNS and teardown. This owner
/// only supervises its exact child and checks recovery; it has no device FD,
/// route writer, resolver writer or process-name/PID adoption path.
final class RelayTunManagedCore {
    enum Failure: Error { case state, revoked, binding, uncertain }
    struct Child {
        let observe: () throws -> RelayTunCoreProbePlan.ChildState
        let stop: () throws -> RelayTunCoreProbePlan.Stopped
        let read: (String) throws -> Data
        var verifyListeners: (([Int], UInt64) throws -> Void)? = nil
        var readCapture: ((String, UInt64) throws -> Data)? = nil
        var readRules: ((RelayTunRuntimeRules.Access) throws -> RelayTunRuntimeRules.Snapshot)? = nil
        var applyRule: ((RelayTunRuntimeRules.Mutation, RelayTunRuntimeRules.Access, () throws -> Void) throws -> RelayTunRuntimeRules.Snapshot)? = nil
        var readResources: ((UInt64, () throws -> Void) throws -> RelayTunCoreReadiness.ResourceState)? = nil
        var prepareResource: ((RelayTunRuntimeResources.Selection, RelayTunRuntimeResources.Access) throws -> RelayTunRuntimeResources.Prepared)? = nil
        var commitResource: ((RelayTunRuntimeResources.Prepared, RelayTunRuntimeResources.Access) throws -> RelayTunRuntimeResources.Receipt)? = nil
        var cancelResource: ((RelayTunRuntimeResources.Prepared, UInt64, () throws -> Void) throws -> RelayTunRuntimeResources.Cancellation)? = nil
        var readRuleProviders: ((UInt64, () throws -> Void) throws -> Data)? = nil
        var updateRuleProvider: ((String, UInt64, () throws -> Void, () throws -> Void) throws -> Void)? = nil
        var trafficReader: (() throws -> TrafficIO)? = nil
        var smartToolsReader: (() throws -> SmartToolsIO)? = nil
        var startupDiagnostic: (() -> String?)? = nil
    }
    typealias TrafficFullVerification = (() throws -> Void) throws -> Void
    struct TrafficIO {
        let assertMetadata: () throws -> Void
        let verifySource: () throws -> Void
        let read: (RelayTunCoreReadiness.Endpoint, UInt64, () throws -> Void) throws -> Data
        let traffic: (UInt64, () throws -> Void) throws -> Data
        var proxies: ((RelayTunRuntimeCapture.ProxyAction, UInt64, () throws -> Void) throws -> Data)? = nil
        var connections: ((UInt64, () throws -> Void) throws -> Data)? = nil
    }
    struct TrafficLease {
        let configurationRevision: String
        let assertOwner: () throws -> Void
        let verifyPublication: TrafficFullVerification
        let read: (UInt64, () throws -> Void) throws -> Data
    }
    struct SmartToolsIO {
        let read: (String, UInt64, () throws -> Void) throws -> Data
        let weights: (UInt64, () throws -> Void) throws -> Data
        let clear: (UInt64, () throws -> Void, () throws -> Void) throws -> Void
    }
    struct SmartToolsLease {
        let definition: RelayTunSmartTools.Definition
        let weights: (UInt64, () throws -> Void) throws -> RelayTunSmartTools.Snapshot
        let clear: (UInt64, () throws -> Void, () throws -> Void) throws -> RelayTunSmartTools.Snapshot
    }
    struct Driver {
        let verify: () throws -> Void
        let hold: () throws -> Void
        let launch: (@escaping (Child) -> Void) throws -> Void
        let interfacePresent: () throws -> Bool
        let baseline: () throws -> RelayTunNetworkTransaction.Baseline
        let dispose: () throws -> Void
        var trafficVerificationSnapshot: (() throws -> TrafficFullVerification)? = nil
    }
    struct RecoveryClock {
        let now: () -> UInt64
        let pause: () -> Void
        static let live = RecoveryClock(now: { DispatchTime.now().uptimeNanoseconds / 1_000_000 },
                                        pause: { usleep(50_000) })
    }
    private let configuration: Data
    private let rulesConfigurationRevision: String
    private let baseline: RelayTunNetworkTransaction.Baseline
    private let authorized: () -> Bool
    private let driver: Driver
    private let recoveryClock: RecoveryClock
    private let resourcesEnabled: Bool
    private let executionCore: RelayTunExecutionReceiptV2.CoreIdentity?
    private let ruleProvidersEnabled: Bool
    private let ruleProvidersCoreSHA256: String?
    private let rulesGeneration = UInt64.random(in: 1...UInt64.max)
    private var child: Child?
    private var launchAttempted = false
    private var stopped = false
    private var restored = false
    private var disposed = false
    var released: Bool { stopped }
    private(set) var startFailureCode: String?
    private(set) var recoveryFailureCode: String?

    init(configuration: Data, baseline: RelayTunNetworkTransaction.Baseline,
         authorized: @escaping () -> Bool, driver: Driver, recoveryClock: RecoveryClock = .live, resourcesEnabled: Bool = false,
         ruleProvidersEnabled: Bool = false, ruleProvidersCoreSHA256: String? = nil,
         executionCore: RelayTunExecutionReceiptV2.CoreIdentity? = nil) throws {
        let raw = try RelayTunStrictJSON.object(configuration, limit: 2 * 1024 * 1024)
        guard let tun = raw["tun"] as? [String: Any], tun["enable"] as? Bool == true,
              tun["file-descriptor"] == nil, let device = tun["device"] as? String,
              device.hasPrefix("utun"), let index = UInt32(device.dropFirst(4)), index <= UInt32(Int16.max),
              device == "utun\(index)" else { throw Failure.binding }
        guard raw["secret"] == nil || raw["secret"] is String else { throw Failure.binding }
        if let executionCore {
            guard RelayTunExecutionReceiptV2.corePins.contains(executionCore),
                  !resourcesEnabled || executionCore.profile == .localGeodata else { throw Failure.binding }
        }
        guard !ruleProvidersEnabled || (resourcesEnabled && ruleProvidersCoreSHA256 ==
            RelayTunManagedInstallation.localGeodataPins[RelayTunManagedInstallation.architecture]?.0) else { throw Failure.binding }
        self.configuration = configuration; self.rulesConfigurationRevision = RelayTunHelperTrust.digest(configuration); self.baseline = baseline
        self.authorized = authorized; self.driver = driver
        self.recoveryClock = recoveryClock
        self.resourcesEnabled = resourcesEnabled
        self.executionCore = executionCore
        self.ruleProvidersEnabled = ruleProvidersEnabled
        self.ruleProvidersCoreSHA256 = ruleProvidersCoreSHA256
    }
    func start() throws {
        var stage = "managed.state"
        do {
            guard !launchAttempted, !stopped, !disposed, authorized() else { throw Failure.state }
            stage = "managed.resource"; try driver.verify()
            stage = "managed.lock"; try driver.hold()
            stage = "managed.baseline"
            guard authorized(), try !driver.interfacePresent(), try driver.baseline() == baseline else { throw Failure.binding }
            launchAttempted = true
            stage = "managed.spawn"
            try driver.launch { owned in self.child = owned }
            guard child != nil else { throw Failure.uncertain }
            stage = "managed.readiness"
            let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
            while true {
                do { try inspect(); return }
                catch let error as RelayTunCoreReadiness.Failure {
                    guard error.allowsStartupRetry else { throw error }
                    guard authorized(), let child, case .running = try child.observe(),
                          DispatchTime.now().uptimeNanoseconds < deadline else { throw error }
                    usleep(10000)
                }
            }
        } catch {
            if stage == "managed.readiness", let failure = error as? RelayTunCoreReadiness.Failure,
               case .field(.enable) = failure, let diagnostic = child?.startupDiagnostic?() {
                startFailureCode = diagnostic
            } else if stage == "managed.readiness", let failure = error as? RelayTunCoreReadiness.Failure {
                startFailureCode = failure.diagnosticCode
            } else { startFailureCode = stage }
            throw error
        }
    }
    func inspect() throws {
        guard !stopped, !disposed, authorized(), let child else { throw Failure.state }
        // Full local trust work is outside each bounded HTTP response timer.
        try driver.verify()
        guard case .running = try child.observe() else { throw Failure.uncertain }
        let version = try child.read("version"), configs = try child.read("configs")
        try RelayTunCoreReadiness.validateManaged(configuration: configuration, version: version, configs: configs, resources: resourcesEnabled, execution: executionCore)
        guard authorized(), case .running = try child.observe(), try driver.interfacePresent(),
              try driver.baseline().protectionSHA256 == baseline.protectionSHA256 else { throw Failure.uncertain }
    }
    /// Invoked only on AppSession's existing mutation queue. Failures are
    /// returned on the optional read channel, never through inspect/recovery.
    func captureRuntime(deadline: UInt64) throws -> RelayTunRuntimeCapture.Snapshot {
        try RelayTunRuntimeCapture.check(deadline)
        guard !stopped, !disposed, authorized(), let child else { throw RelayTunRuntimeCapture.Failure.unavailable }
        guard !configuration.isEmpty, configuration.count <= RelayTunRuntimeCapture.bodyLimit,
              let verifyListeners = child.verifyListeners else { throw RelayTunRuntimeCapture.Failure.unsupported }
        try driver.verify(); try RelayTunRuntimeCapture.check(deadline)
        guard case .running = try child.observe() else { throw RelayTunRuntimeCapture.Failure.unavailable }
        let version = try child.readCapture?("version", deadline) ?? child.read("version"); try RelayTunRuntimeCapture.check(deadline)
        let configs = try child.readCapture?("configs", deadline) ?? child.read("configs"); try RelayTunRuntimeCapture.check(deadline)
        let mode = try RelayTunCoreReadiness.validateManagedCapture(configuration: configuration, version: version, configs: configs, resources: resourcesEnabled, execution: executionCore)
        let expected = try RelayTunStrictJSON.object(configuration, limit: RelayTunRuntimeCapture.bodyLimit)
        var ports = [RelayTunRuntimeCapture.Snapshot.Port]()
        for (key, kind) in [("port", "http"), ("mixed-port", "mixed")] {
            guard let port = RelayTunStrictJSON.integer(expected[key] ?? 0), port <= 65535 else { throw RelayTunRuntimeCapture.Failure.unsupported }
            if port < 1024 { continue }
            guard !ports.contains(where: { $0.port == port }) else { throw RelayTunRuntimeCapture.Failure.unsupported }
            ports.append(.init(kind: kind, port: port))
        }
        guard !ports.isEmpty else { throw RelayTunRuntimeCapture.Failure.unsupported }
        try verifyListeners(ports.map { $0.port }, deadline); try RelayTunRuntimeCapture.check(deadline)
        guard authorized(), case .running = try child.observe(), try driver.interfacePresent(),
              try driver.baseline().protectionSHA256 == baseline.protectionSHA256 else { throw RelayTunRuntimeCapture.Failure.unavailable }
        try driver.verify(); try RelayTunRuntimeCapture.check(deadline)
        return .init(originalLoadedSHA256: RelayTunHelperTrust.digest(configuration), originalLoadedBytes: configuration.count,
                     mode: mode, ports: ports)
    }
    /// Private stamp only, invoked from the same session queue as other owner
    /// operations. It never opens a socket or waits for another operation.
    func runtimeRulesOwner() throws -> RelayTunRuntimeRules.Owner {
        guard !stopped, !disposed, authorized(), let child,
              case .running = try child.observe() else { throw RelayTunRuntimeRules.Failure.revoked }
        return try .init(generation: rulesGeneration, configurationRevision: rulesConfigurationRevision)
    }
    private func verifyRulesContext(_ access: RelayTunRuntimeRules.Access) throws {
        try access.check()
        guard !stopped, !disposed, authorized(), let child,
              case .running = try child.observe() else { throw RelayTunRuntimeRules.Failure.revoked }
        try driver.verify(); try access.check()
        guard try driver.interfacePresent(),
              try driver.baseline().protectionSHA256 == baseline.protectionSHA256 else { throw RelayTunRuntimeRules.Failure.revoked }
        try access.check()
    }
    private func rulesReadiness(_ access: RelayTunRuntimeRules.Access) throws -> Child {
        try verifyRulesContext(access)
        guard let child, let read = child.readCapture else { throw RelayTunRuntimeRules.Failure.unavailable }
        let version = try read("version", access.deadline); try verifyRulesContext(access)
        let configs = try read("configs", access.deadline); try verifyRulesContext(access)
        _ = try RelayTunCoreReadiness.validateManagedCapture(configuration: configuration, version: version, configs: configs, resources: resourcesEnabled, execution: executionCore)
        try verifyRulesContext(access); return child
    }
    /// Rules use the authenticated Unix socket and work when configured HTTP
    /// ports are zero. No listener/PCB observation or runtime capture fallback.
    func readRuntimeRules(_ access: RelayTunRuntimeRules.Access) throws -> RelayTunRuntimeRules.Snapshot {
        let child = try rulesReadiness(access)
        guard let read = child.readRules else { throw RelayTunRuntimeRules.Failure.unavailable }
        let result = try read(access); try verifyRulesContext(access); return result
    }
    func applyRuntimeRule(_ mutation: RelayTunRuntimeRules.Mutation,
                          access: RelayTunRuntimeRules.Access) throws -> RelayTunRuntimeRules.Snapshot {
        let child = try rulesReadiness(access)
        guard let apply = child.applyRule else { throw RelayTunRuntimeRules.Failure.unavailable }
        let result = try apply(mutation, access, { try self.verifyRulesContext(access) })
        try verifyRulesContext(access); return result
    }
    func runtimeResourcesOwner(coreBootId: String) throws -> RelayTunRuntimeResources.Owner {
        guard resourcesEnabled else { throw Failure.binding }
        let stamp = try runtimeRulesOwner()
        return try .init(heldGeneration: stamp.generation, configurationRevision: stamp.configurationRevision,
                         coreBootId: coreBootId, ordinaryUID: getuid())
    }
    /// Fast authority stamp only, for Model.currentContext even while the
    /// provider filesystem owner holds its lock. Full bundle/file checks stay
    /// outside that observer, immediately before publication and on readback.
    func runtimeRuleProvidersOwner() throws -> (RelayTunRuntimeRules.Owner, String) {
        guard ruleProvidersEnabled, let sha256 = ruleProvidersCoreSHA256 else { throw Failure.binding }
        return (try runtimeRulesOwner(), sha256)
    }
    private func resourceReadiness(before deadline: UInt64, check: () throws -> Void) throws -> Child {
        guard resourcesEnabled, !stopped, !disposed, authorized(), let child,
              let read = child.readCapture else { throw Failure.revoked }
        func verify() throws {
            try check(); try driver.verify(); try check()
            guard authorized(), case .running = try child.observe(), try driver.interfacePresent(),
                  try driver.baseline().protectionSHA256 == baseline.protectionSHA256 else { throw Failure.revoked }
            try check()
        }
        try verify()
        let version = try read("version", deadline); try verify()
        let configs = try read("configs", deadline); try verify()
        _ = try RelayTunCoreReadiness.validateManagedCapture(configuration: configuration, version: version, configs: configs, resources: true)
        try verify(); return child
    }
    func readRuntimeResources(before deadline: UInt64, check: () throws -> Void) throws -> RelayTunCoreReadiness.ResourceState {
        let child = try resourceReadiness(before: deadline, check: check)
        guard let read = child.readResources else { throw Failure.binding }
        let state = try read(deadline, check); try check(); return state
    }
    func readRuntimeRuleProviders(before deadline: UInt64, check: () throws -> Void) throws -> Data {
        _ = try runtimeRuleProvidersOwner()
        let child = try resourceReadiness(before: deadline, check: check)
        guard let read = child.readRuleProviders else { throw Failure.binding }
        let bytes = try read(deadline, check)
        try check(); _ = try runtimeRuleProvidersOwner(); return bytes
    }
    func updateRuntimeRuleProvider(name: String, before deadline: UInt64, check: () throws -> Void,
                                   beforeDispatch: () throws -> Void) throws {
        _ = try runtimeRuleProvidersOwner()
        let child = try resourceReadiness(before: deadline, check: check)
        guard let update = child.updateRuleProvider else { throw Failure.binding }
        try update(name, deadline, check, beforeDispatch)
        try check(); _ = try runtimeRuleProvidersOwner()
    }
    func prepareRuntimeResource(_ selection: RelayTunRuntimeResources.Selection,
                                access: RelayTunRuntimeResources.Access) throws -> RelayTunRuntimeResources.Prepared {
        let child = try resourceReadiness(before: access.deadline, check: access.check)
        guard let prepare = child.prepareResource else { throw Failure.binding }
        return try prepare(selection, access)
    }
    func commitRuntimeResource(_ prepared: RelayTunRuntimeResources.Prepared,
                               access: RelayTunRuntimeResources.Access) throws -> RelayTunRuntimeResources.Receipt {
        let child = try resourceReadiness(before: access.deadline, check: access.check)
        guard let commit = child.commitResource else { throw Failure.binding }
        return try commit(prepared, access)
    }
    /// Neutralize one known private prepare nonce even after user scope loss.
    /// It cannot publish and remains bound to this exact unreaped child/peer.
    func cancelRuntimeResource(_ prepared: RelayTunRuntimeResources.Prepared, before deadline: UInt64) throws -> RelayTunRuntimeResources.Cancellation {
        guard resourcesEnabled, !stopped, !disposed, let child, let cancel = child.cancelResource else { throw Failure.revoked }
        return try cancel(prepared, deadline, {
            guard case .running = try child.observe() else { throw Failure.revoked }
        })
    }
    func stop() throws {
        var stage = "stop.state"
        recoveryFailureCode = nil
        do {
            guard !disposed else { throw Failure.state }
            if stopped { return }
            if let child {
                stage = "stop.child"; _ = try child.stop()
                stage = "stop.child-exit"
                guard case .exited = try child.observe() else { throw Failure.uncertain }
            }
            // Nil is a positive no-child history, not a PID lookup.
            stopped = true
        } catch {
            recoveryFailureCode = stage; throw error
        }
    }
    func verifyRestored() throws {
        var stage = "restore.state"
        recoveryFailureCode = nil
        do {
            guard stopped, !disposed else { throw Failure.uncertain }
            // Child exit does not acknowledge configd's removal of the upstream
            // temporary resolver. Observe the unchanged strict baseline for at
            // most 5s; never replay stop, write DNS or replace the original baseline.
            let began = recoveryClock.now()
            for attempt in 0...100 {
                stage = "restore.interface-read"
                let present = try (child != nil && driver.interfacePresent())
                stage = "restore.baseline-read"
                let current = try driver.baseline()
                stage = "restore.protection"
                guard current.protectionSHA256 == baseline.protectionSHA256 else { throw Failure.uncertain }
                stage = present ? "restore.interface-deadline" : "restore.network-deadline"
                let now = recoveryClock.now()
                guard now >= began, now - began < 5_000 else { throw Failure.uncertain }
                if !present && current == baseline { restored = true; return }
                // Once restoration has been proved, a later change must not be
                // hidden by waiting for it to disappear during disposal.
                if restored {
                    stage = present ? "restore.interface-changed" : "restore.network-changed"
                    throw Failure.uncertain
                }
                guard attempt < 100 else { throw Failure.uncertain }
                recoveryClock.pause()
            }
        } catch {
            recoveryFailureCode = stage; throw error
        }
    }
    /// Minted only on the Session owner queue after activation. A worker gets
    /// immutable facts and the separately locked authenticated reader, never
    /// permission to consult mutable ManagedCore state or hold a system lease.
    func trafficLease(connections: Bool = false, proxies: RelayTunRuntimeCapture.ProxyAction? = nil) throws -> TrafficLease {
        guard !stopped, !disposed, authorized(), let child,
              let makeReader = child.trafficReader, let makeVerification = driver.trafficVerificationSnapshot,
              case .running = try child.observe() else { throw Failure.revoked }
        // Mint on the owner queue. The worker gets this independent reader and
        // immutable identity facts, never lazy access to resources.readiness.
        let io = try makeReader(), configuration = self.configuration
        let revision = rulesConfigurationRevision, execution = executionCore, resources = resourcesEnabled
        let verifyFull = try makeVerification(), authorized = self.authorized
        func assertOwner() throws {
            guard authorized(), case .running = try child.observe() else { throw Failure.revoked }
            try io.assertMetadata()
            guard authorized(), case .running = try child.observe() else { throw Failure.revoked }
        }
        func verifyPublication(_ check: () throws -> Void) throws {
            try check(); try assertOwner()
            try verifyFull(check); try io.verifySource()
            try assertOwner(); try check()
        }
        return .init(configurationRevision: revision, assertOwner: assertOwner, verifyPublication: verifyPublication, read: { deadline, check in
            try verifyPublication(check)
            let version = try io.read(.version, deadline, check)
            let configs = try io.read(.configs, deadline, check)
            try RelayTunCoreReadiness.validateManaged(configuration: configuration, version: version, configs: configs,
                                                      resources: resources, execution: execution)
            try check(); try assertOwner()
            let raw: Data
            if let proxies {
                guard let read = io.proxies else { throw Failure.revoked }
                raw = try read(proxies, deadline, check)
            } else if connections {
                guard let read = io.connections else { throw Failure.revoked }
                raw = try read(deadline, check)
            } else { raw = try io.traffic(deadline, check) }
            try verifyPublication(check)
            return raw
        })
    }
    func smartToolsLease() throws -> SmartToolsLease {
        guard !stopped, !disposed, authorized(), let child,
              let executionCore, executionCore.profile == .smart,
              let makeReader = child.smartToolsReader,
              case .running = try child.observe() else { throw RelayTunSmartTools.Failure.unsupported }
        let definition = try RelayTunSmartTools.Definition(configuration: configuration)
        let io = try makeReader(), configuration = self.configuration
        let verifySource = driver.verify, authorized = self.authorized
        func verify(_ check: () throws -> Void) throws {
            try check(); guard authorized(), case .running = try child.observe() else { throw RelayTunSmartTools.Failure.revoked }
            try verifySource(); try check()
        }
        func prepare(_ deadline: UInt64, _ check: () throws -> Void) throws {
            try verify(check)
            let version = try io.read("version", deadline, check)
            let configs = try io.read("configs", deadline, check)
            try RelayTunCoreReadiness.validateManaged(configuration: configuration, version: version, configs: configs, execution: executionCore)
            try verify(check)
        }
        return .init(definition: definition, weights: { deadline, check in
            try prepare(deadline, check)
            let bytes = try io.weights(deadline, check)
            try verify(check)
            return try RelayTunSmartTools.decodeAggregate(bytes, definition: definition)
        }, clear: { deadline, check, enterWrite in
            try prepare(deadline, check)
            try io.clear(deadline, check, enterWrite)
            try verify(check)
            return .init(configurationRevision: definition.configurationRevision, groups: nil)
        })
    }
    func dispose() throws {
        if disposed { return }
        guard restored else { throw Failure.state }
        // A prior observation cannot hide a later external network change.
        try verifyRestored()
        do { try driver.dispose(); disposed = true }
        catch { recoveryFailureCode = "dispose.lock"; throw error }
    }

    /// Retirement is distinct from restoration. Only a foreign proxy-only
    /// change may end this owned lifetime without certifying the old baseline.
    /// The unchanged network digest includes all interfaces, routes and DNS.
    func disposeReleased(record: () throws -> Void) throws {
        var stage = "release-owned.state"
        recoveryFailureCode = nil
        do {
            guard stopped, !disposed else { throw Failure.uncertain }
            stage = "release-owned.child"
            if let child {
                guard case .exited = try child.observe() else { throw Failure.uncertain }
            }
            // As in stop(), nil is positive never-published-child history.
            stage = "release-owned.interface"
            guard try !driver.interfacePresent() else { throw Failure.uncertain }
            stage = "release-owned.baseline"
            let current = try driver.baseline()
            guard current.networkSHA256 == baseline.networkSHA256,
                  current.protectionSHA256 != baseline.protectionSHA256 else { throw Failure.uncertain }
            stage = "release-owned.lock"; try driver.dispose()
            // A failed evidence write is never a successful disposal or exit.
            stage = "release-owned.record"; try record()
            disposed = true
        } catch { recoveryFailureCode = stage; throw error }
    }

    static func live(bundle: RelayTunAppBundle, authorized: @escaping () -> Bool) throws -> RelayTunManagedCore {
        guard bundle.coreManaged, let revision = bundle.installationRevision,
              let raw = try JSONSerialization.jsonObject(with: bundle.configuration) as? [String: Any],
              let tun = raw["tun"] as? [String: Any], let device = tun["device"] as? String else { throw Failure.binding }
        let executable: String, coreSHA256: String, environmentResources: Bool
        let executionCore: RelayTunExecutionReceiptV2.CoreIdentity?
        let executionLaunch: RelayTunOwnedChild.ExecutionLaunch?
        let holdInstallation: () throws -> FileHandle, verifyInstallation: () throws -> Void
        if let receipt = bundle.executionReceipt {
            if receipt.core.profile == .smart { try bundle.requireSmartStateSeed() }
            let trust = try RelayTunExecutionInstallationV2.load()
            guard trust.revision == revision, trust.core == receipt.core,
                  !bundle.resourcesEnabled, !bundle.ruleProvidersEnabled else { throw Failure.binding }
            executable = trust.executable; coreSHA256 = trust.core.sha256
            environmentResources = trust.profile == .localGeodata; executionCore = trust.core
            holdInstallation = trust.holdInstallation
            verifyInstallation = {
                let fresh = try RelayTunExecutionInstallationV2.load()
                guard fresh.revision == revision, fresh.core == trust.core else { throw Failure.revoked }
            }
            executionLaunch = .init(installation: trust, beforeSpawn: {
                try bundle.checkExecutionDeadline(nowMS: Int64(Date().timeIntervalSince1970 * 1000))
            })
        } else {
            let trust = try RelayTunManagedInstallation.load()
            guard trust.revision == revision, trust.clientUID == getuid() else { throw Failure.binding }
            try trust.validateLaunch(resources: bundle.resourcesEnabled)
            executable = trust.executable; coreSHA256 = trust.coreSHA256
            environmentResources = bundle.resourcesEnabled; executionCore = nil; executionLaunch = nil
            holdInstallation = trust.holdInstallation
            verifyInstallation = {
                guard try RelayTunManagedInstallation.load().revision == revision else { throw Failure.revoked }
            }
        }
        final class Resources { var installationLock: FileHandle?; var readiness: RelayTunCoreReadiness.Live? }
        let resources = Resources()
        let verify: () throws -> Void = {
            guard authorized() else { throw Failure.revoked }
            try verifyInstallation(); try bundle.verify()
        }
        // The launch fence runs before any child/socket exists. General active
        // verify stays base-only until the real reader authenticates its peer.
        let launchVerify: () throws -> Void = {
            try verify(); try bundle.verifySmartStateBeforeFork()
        }
        return try .init(configuration: bundle.configuration, baseline: bundle.baseline, authorized: authorized,
            driver: .init(verify: verify, hold: {
                guard resources.installationLock == nil else { throw Failure.state }
                resources.installationLock = try holdInstallation()
            }, launch: { register in
                guard let held = resources.installationLock else { throw Failure.state }
                _ = try RelayTunOwnedChild.spawnManaged(launch: .init(executable: executable, directory: bundle.directory, resources: environmentResources),
                    installationLock: held.fileDescriptor, execution: executionLaunch, verify: launchVerify, register: { owned in
                        let read: (String, UInt64?) throws -> Data = { endpoint, deadline in
                            try owned.whileRunning {
                                if resources.readiness == nil {
                                    let secret = raw["secret"] as? String
                                    resources.readiness = try .init(directory: bundle.directory, configuration: bundle.configuration,
                                        authorization: secret.flatMap { $0.isEmpty ? nil : $0 },
                                        verifyPeer: { try owned.verifyPeer(socket: $0) }, socketUID: 0)
                                }
                                guard let reader = resources.readiness else { throw Failure.state }
                                let bytes = try reader.read(endpoint, before: deadline)
                                if bundle.smartStateEnabled {
                                    try bundle.registerSmartStateSocket(reader.registeredSocketSnapshot())
                                    try bundle.verifySmartStateActiveLayout()
                                }
                                return bytes
                            }
                        }
                        func rulesReader() throws -> RelayTunCoreReadiness.Live {
                            guard let reader = resources.readiness else { throw Failure.state }; return reader
                        }
                        register(.init(observe: { try owned.observe() }, stop: { try owned.stop() }, read: { try read($0, nil) },
                            verifyListeners: { ports, deadline in try owned.verifyHTTPListeners(ports, deadline: deadline) },
                            readCapture: { try read($0, $1) },
                            readRules: { access in
                                try owned.whileRunning { try rulesReader().readRules(access) }
                            }, applyRule: { mutation, access, verifyContext in
                                try owned.whileRunning { try rulesReader().patchRule(mutation, access: access, verifyContext: verifyContext) }
                            }, readResources: { deadline, check in
                                try owned.whileRunning { try rulesReader().readResources(before: deadline, check: check) }
                            }, prepareResource: { selection, access in
                                try owned.whileRunning { try rulesReader().prepareResource(selection, access: access) }
                            }, commitResource: { prepared, access in
                                try owned.whileRunning { try rulesReader().commitResource(prepared, access: access) }
                            }, cancelResource: { prepared, deadline, check in
                                try owned.whileRunning { try rulesReader().cancelResource(prepared, before: deadline, check: check) }
                            }, readRuleProviders: { deadline, check in
                                try owned.whileRunning { try rulesReader().readRuleProviders(before: deadline, check: check) }
                            }, updateRuleProvider: { name, deadline, check, beforeDispatch in
                                try owned.whileRunning { try rulesReader().updateRuleProvider(name: name, before: deadline, check: check, beforeDispatch: beforeDispatch) }
                            }, trafficReader: {
                                let delegated = try rulesReader().delegatedTrafficReader()
                                let sourceSnapshot = try delegated.trafficSourceSnapshot()
                                return .init(assertMetadata: { try delegated.assertTrafficMetadata(sourceSnapshot) },
                                    verifySource: { try delegated.verifyTrafficSource(sourceSnapshot) }, read: { endpoint, deadline, check in
                                    try check()
                                    return try owned.whileRunning { try delegated.trafficReadiness(endpoint, before: deadline, check: check) }
                                }, traffic: { deadline, check in
                                    try owned.whileRunning { try delegated.readTraffic(before: deadline, check: check) }
                                }, proxies: { action, deadline, check in
                                    try owned.whileRunning { try delegated.proxyGroups(action, before: deadline, check: check) }
                                }, connections: { deadline, check in
                                    try owned.whileRunning { try delegated.readConnections(before: deadline, check: check) }
                                })
                            }, smartToolsReader: {
                                guard executionCore?.profile == .smart else { throw RelayTunSmartTools.Failure.unsupported }
                                let delegated = try rulesReader().delegatedSmartToolsReader()
                                return .init(read: { endpoint, deadline, check in
                                    try check()
                                    return try owned.whileRunning { try delegated.read(endpoint, before: deadline) }
                                }, weights: { deadline, check in
                                    try owned.whileRunning { try delegated.smartWeights(before: deadline, check: check) }
                                }, clear: { deadline, check, enter in
                                    try owned.whileRunning { try delegated.clearSmartCache(before: deadline, check: check, enterWrite: enter) }
                                })
                            }, startupDiagnostic: { owned.startupDiagnostic }))
                    })
            }, interfacePresent: { if_nametoindex(device) != 0 }, baseline: {
                try RelayTunEnvironmentInspector.baseline(owned: nil, sources: RelayTunEnvironmentInspector.live)
            }, dispose: {
                try resources.installationLock?.close(); resources.installationLock = nil
            }, trafficVerificationSnapshot: {
                guard authorized() else { throw Failure.revoked }
                let snapshot = try bundle.trafficVerificationSnapshot()
                return { check in
                    try check(); guard authorized() else { throw Failure.revoked }
                    try verifyInstallation(); try check()
                    try snapshot.verify(check)
                    try check(); guard authorized() else { throw Failure.revoked }
                }
            }), resourcesEnabled: bundle.resourcesEnabled, ruleProvidersEnabled: bundle.ruleProvidersEnabled,
            ruleProvidersCoreSHA256: bundle.ruleProvidersEnabled ? coreSHA256 : nil, executionCore: executionCore)
    }
}
