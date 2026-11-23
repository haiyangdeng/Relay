import Foundation
import Security
import Darwin

/// The actual persistent ordinary-UID client. Control requests contain the
/// main-owned binding; helper IDs/receipt and private configuration never cross
/// back into renderer status. All mutations run on one queue, while revoke has
/// an independent queue and an immediate shared authorization latch.
final class RelayTunAppSession: NSObject, RelayTunCoreObservationChannel {
    enum Failure: Error { case invalid, state, binding, unverified, revoked }
    private let bundle: RelayTunAppBundle
    private let stateLock = NSLock()
    private var authorization = true
    private var controlLost = false
    private var host: RelayTunCoreHost?
    private var core: RelayTunLiveCore?
    private var managedCore: RelayTunManagedCore?
    // Dispatch callbacks deliberately retain this owner weakly. The actual
    // session must retain its read capability beyond ClientMain's last use.
    private var proxyGroupsChannel: RelayTunRuntimeCapture.Channel?
    private var runtimeCaptureChannel: RelayTunRuntimeCapture.Channel?
    private let proxyGroupsIOQueue = DispatchQueue(label: "local.relay.tun.proxy-groups.io")
    private let runtimeTrafficIOQueue = DispatchQueue(label: "local.relay.tun.runtime-traffic.io")
    private let runtimeTrafficAuthority = RelayTunRuntimeCapture.TrafficAuthority()
    private var smartStateChannel: RelayTunSmartStateChannel?
    private var smartToolsChannel: RelayTunSmartToolsChannel?
    private let smartToolsAuthority = RelayTunSmartTools.Authority()
    private let smartToolsIOQueue = DispatchQueue(label: "local.relay.tun.smart-tools.io")
    private let smartStateIOQueue = DispatchQueue(label: "local.relay.tun.smart-state.files")
    var supportsSmartState: Bool { bundle.smartStateEnabled }
    private var runtimeRulesChannel: RelayTunRuntimeRules.Channel?
    private var runtimeResourcesChannel: RelayTunRuntimeResourcesChannel?
    private var resourceController: RelayTunRuntimeResources.Controller?
    private var resourceRevoked = false
    private var runtimeRuleProvidersChannel: RelayTunRuntimeRuleProvidersChannel?
    private var ruleProviderController: RelayTunRuntimeRuleProviders.Controller?
    private var ruleProvidersRevoked = false
    private var providerSelection: RelayTunRuntimeRuleProviders.Selection?
    private var providerRequestContext: RelayTunRuntimeRuleProvidersChannel.Context?
    private var providerProjection: RelayTunRuntimeRuleProviderProbe.Projection?
    private var providerProbes = [RelayTunRuntimeRuleProviderProbe.Session]()
    private var providerEvidenceRetained = false
    private var providerOperationDraining = false
    private var providerDrainWaiters = [() -> Void]()
    private let providerDrainGroup = DispatchGroup()
    private let releaseDrainGroup = DispatchGroup()
    private let providerProbeQueue = DispatchQueue(label: "local.relay.tun.provider-probe")
    private var receipt: RelayTunAcquiredReceipt?
    private var heldDelivery: FileHandle?
    private var deliveryCloseAttempted = false
    private var unstartedDeliveryClosed = false
    private var prepared: RelayTunWireResponse?
    private var client: RelayTunXPCClient?
    private var phase = "idle", network = "unchanged", device = "none", coreState = "none"
    private var initialized = false, restored = false, disposed = false
    private var acquireAttempted = false
    private(set) var coreStartFailure: String?
    private(set) var recoveryFailureCode: String?
    private var recoveryStage = "session.recovery"
    private let mutationQueue = DispatchQueue(label: "local.relay.tun.app-session.operations")
    private let revokeQueue = DispatchQueue(label: "local.relay.tun.app-session.revoke")
    private let outputLock = NSLock()
    private let seenLock = NSLock()
    private var identifiers = Set<Int>()
    private var closing = false
    init(bootstrap: Data, coreManaged: Bool = false, resourcesEnabled: Bool = false, ruleProvidersEnabled: Bool = false,
         executionContext: RelayTunAppBundle.ExecutionContext? = nil) throws {
        bundle = try RelayTunAppBundle(bootstrap, resourcesEnabled: resourcesEnabled, ruleProvidersEnabled: ruleProvidersEnabled,
                                       executionContext: executionContext)
        guard bundle.coreManaged == coreManaged else { throw Failure.binding }
        super.init()
    }
    func startRuntimeCapture(_ channel: RelayTunRuntimeCapture.Channel) throws {
        guard (channel.proxyGroupsEnabled ? proxyGroupsChannel : runtimeCaptureChannel) == nil, bundle.coreManaged, let revision = bundle.installationRevision else { throw Failure.state }
        let clientSHA256 = try runtimeCapabilityIdentity(revision: revision)
        if channel.proxyGroupsEnabled { proxyGroupsChannel = channel } else { runtimeCaptureChannel = channel }
        channel.start(binding: bundle.binding.json, clientSHA256: clientSHA256, installationRevision: revision,
                      traffic: { [weak self] context, reply in
            guard let self else { reply(.unavailable); return }
            self.readRuntimeTraffic(context: context, reply: reply)
        }, connections: { [weak self] context, reply in
            guard let self else { reply(.unavailable); return }
            self.readRuntimeTraffic(context: context, connections: true, reply: reply)
        }, proxies: { [weak self] action, context, reply in
            guard let self else { reply(.unavailable); return }
            self.readRuntimeTraffic(context: context, proxies: action, reply: reply)
        }) { [weak self] deadline, reply in
            guard let self else { reply(.unavailable); return }
            self.captureRuntime(deadline: deadline, reply: reply)
        }
    }
    func startSmartState(input: Int32 = 7, output: Int32 = 8) throws {
        var transferred = false
        defer { if !transferred { Darwin.close(input); Darwin.close(output) } }
        try bundle.requireSmartStateSeed()
        guard let revision = bundle.installationRevision, let handoff = bundle.smartStateHandoff else { throw Failure.state }
        let identity = try runtimeCapabilityIdentity(revision: revision)
        let driver = RelayTunSmartStateChannel.Driver(export: { [weak self] context, done in
            guard let self else { done(.failure(Failure.revoked)); return }
            self.exportSmartState(context: context, done: done)
        }, acknowledge: { acknowledgement, context in
            try context.check(); return try handoff.acknowledge(acknowledgement)
        }, invalidate: { handoff.invalidatePublication() })
        guard let channel = RelayTunSmartStateChannel(binding: try .init(bundle.binding.json), clientSHA256: identity,
            installationRevision: revision, driver: driver, input: input, output: output) else { throw Failure.state }
        transferred = true
        stateLock.lock()
        guard smartStateChannel == nil, !disposed else { stateLock.unlock(); channel.invalidate(); throw Failure.state }
        smartStateChannel = channel; stateLock.unlock()
    }
    func startSmartTools(input: Int32 = 9, output: Int32 = 10) throws {
        typealias Channel = RelayTunSmartToolsChannel
        var transferred = false
        defer { if !transferred { Darwin.close(input); Darwin.close(output) } }
        guard bundle.executionReceipt?.core.profile == .smart, bundle.smartStateEnabled,
              let revision = bundle.installationRevision else { throw Failure.binding }
        let identity = try runtimeCapabilityIdentity(revision: revision)
        let driver = Channel.Driver(read: { [weak self] context, done in
            guard let self else { done(.failure(Channel.Engine.Failure.unavailable)); return }
            self.performSmartTools(id: 0, clear: false, context: context) { reply in
                if let observation = reply.observation, reply.status == "weights" { done(.success(observation)) }
                else {
                    switch reply.status {
                    case "unsupported": done(.failure(Channel.Engine.Failure.unsupported))
                    case "cancelled": done(.failure(Channel.Engine.Failure.cancelled))
                    case "expired": done(.failure(Channel.Engine.Failure.expired))
                    default: done(.failure(Channel.Engine.Failure.unavailable))
                    }
                }
            }
        }, clear: { [weak self] id, context, done in
            guard let self else { done(.init(status: "unavailable")); return }
            self.performSmartTools(id: id, clear: true, context: context, done: done)
        }, cancel: { [smartToolsAuthority] id in smartToolsAuthority.cancel(id) },
           invalidate: { [smartToolsAuthority] in smartToolsAuthority.revoke() })
        guard let channel = Channel(binding: try .init(bundle.binding.json), clientSHA256: identity,
            installationRevision: revision, driver: driver, input: input, output: output) else { throw Failure.state }
        transferred = true
        stateLock.lock()
        guard smartToolsChannel == nil, !disposed else { stateLock.unlock(); channel.invalidate(); throw Failure.state }
        smartToolsChannel = channel; stateLock.unlock()
    }
    private func revokeSmartTools() {
        smartToolsAuthority.revoke()
        stateLock.lock(); let channel = smartToolsChannel; stateLock.unlock()
        channel?.invalidate()
    }
    private func performSmartTools(id: Int, clear: Bool, context: RelayTunSmartToolsChannel.Context,
                                  done: @escaping (RelayTunSmartToolsChannel.Engine.Reply) -> Void) {
        mutationQueue.async { [self] in
            var pending: RelayTunSmartTools.Operation?
            do {
                try context.check()
                guard initialized, !disposed, phase == "active", authorized(), let core = managedCore else { throw Failure.revoked }
                let operation = try smartToolsAuthority.begin(id); pending = operation
                let lease = try core.smartToolsLease()
                guard lease.definition.configurationRevision == bundle.binding.runtimeConfigurationSHA256 else { throw Failure.binding }
                try operation.check(); try context.check()
                smartToolsIOQueue.async { [smartToolsAuthority] in
                    defer { smartToolsAuthority.finish(id) }
                    func check() throws { try context.check(); try operation.check() }
                    do {
                        let snapshot: RelayTunSmartTools.Snapshot
                        if clear {
                            snapshot = try lease.clear(context.deadline, check, {
                                try check(); try operation.enterWrite(); try check()
                            })
                        } else { snapshot = try lease.weights(context.deadline, check) }
                        try check()
                        done(.init(status: clear ? "accepted" : "weights", observation: snapshot))
                    } catch {
                        let status: String
                        if clear && operation.mayHaveWritten { status = "uncertain" }
                        else {
                            switch error {
                            case RelayTunRuntimeAssetScope.Failure.cancelled: status = "cancelled"
                            case RelayTunRuntimeAssetScope.Failure.expired: status = "expired"
                            default: status = "unavailable"
                            }
                        }
                        done(.init(status: status))
                    }
                }
            } catch {
                if pending != nil { smartToolsAuthority.finish(id) }
                let status: String
                switch error { case RelayTunSmartTools.Failure.unsupported: status = "unsupported"; default: status = "unavailable" }
                done(.init(status: status))
            }
        }
    }
    private func exportSmartState(context: RelayTunSmartStateChannel.Context,
                                  done: @escaping (Result<RelayTunSmartStateHandoff.Snapshot, Error>) -> Void) {
        mutationQueue.async { [self] in
            do {
                try context.check()
                guard initialized, !disposed, restored,
                      managedCore == nil || managedCore?.released == true,
                      currentHost() == nil || currentHost()?.status.released == true,
                      let handoff = bundle.smartStateHandoff else { throw Failure.state }
                // The only fresh network observation occurs on the owner queue.
                // A state IO callback later checks only this minted pure stamp.
                try managedCore?.verifyRestored(); try verifyBaseline(owned: false)
                switch try handoff.beginExport() {
                case .existing(let snapshot): try context.check(); done(.success(snapshot))
                case .start(let stamp):
                    smartStateIOQueue.async { [bundle] in
                        do {
                            let snapshot = try bundle.exportSmartState(stamp: stamp,
                                afterRestoration: { try handoff.checkExport(stamp) },
                                contextCheck: { try context.check(); try handoff.checkExport(stamp) })
                            done(.success(snapshot))
                        } catch {
                            try? handoff.finishExport(stamp, snapshot: nil); done(.failure(error))
                        }
                    }
                }
            } catch { done(.failure(error)) }
        }
    }
    private func runtimeCapabilityIdentity(revision: String) throws -> String {
        #if RELAY_TUN_APP_SESSION_TESTS
        if let readIdentity = testDriver?.runtimeCaptureIdentity {
            let identity = try readIdentity()
            guard identity.revision == revision, RelayTunHelperTrust.hex(identity.clientSHA256, count: 64) != nil else { throw Failure.binding }
            return identity.clientSHA256
        }
        #endif
        if let receipt = bundle.executionReceipt {
            let trust = try RelayTunExecutionInstallationV2.load()
            guard trust.revision == revision, trust.core == receipt.core else { throw Failure.binding }
            return trust.clientPin.sha256
        }
        let trust = try RelayTunManagedInstallation.load()
        guard trust.revision == revision, trust.clientUID == getuid() else { throw Failure.binding }
        try trust.validateLaunch(resources: bundle.resourcesEnabled)
        return trust.clientPin.sha256
    }
    /// Only ClientMain's positively versioned launch supplies these two owned
    /// descriptors. Errors stay on this optional capability, never control.
    func startRuntimeRules(input: Int32 = 5, output: Int32 = 6) throws {
        guard input >= 3, output >= 3, input != output else { throw Failure.state }
        stateLock.lock(); let existing = runtimeRulesChannel != nil; stateLock.unlock()
        guard !existing else { throw Failure.state }
        var transferred = false
        defer { if !transferred { Darwin.close(input); Darwin.close(output) } }
        guard bundle.coreManaged, let revision = bundle.installationRevision else { throw Failure.state }
        let clientSHA256 = try runtimeCapabilityIdentity(revision: revision)
        let driver = RelayTunRuntimeRules.Driver(currentOwner: { [weak self] in
            guard let self else { throw RelayTunRuntimeRules.Failure.revoked }
            return try self.runtimeRulesOwner()
        }, read: { [weak self] access, reply in
            guard let self else { reply(.failure(RelayTunRuntimeRules.Failure.revoked)); return }
            // Always enqueue, including calls already on mutationQueue. No
            // HTTP IO may run inline under Controller's request processing.
            self.mutationQueue.async { [weak self] in
                guard let self else { reply(.failure(RelayTunRuntimeRules.Failure.revoked)); return }
                do {
                    guard !self.providerOperationDraining else { throw RelayTunRuntimeRules.Failure.unavailable }
                    _ = try self.runtimeRulesOwner()
                    guard let core = self.managedCore else { throw RelayTunRuntimeRules.Failure.revoked }
                    reply(.success(try core.readRuntimeRules(access)))
                } catch { reply(.failure(error)) }
            }
        }, apply: { [weak self] mutation, access, reply in
            guard let self else { reply(.failure(RelayTunRuntimeRules.Failure.revoked)); return }
            let authority = self.runtimeTrafficAuthority, mutationTicket = self.runtimeTrafficAuthority.beginMutation()
            self.mutationQueue.async { [weak self] in
                defer { authority.finishMutation(mutationTicket) }
                guard let self else { reply(.failure(RelayTunRuntimeRules.Failure.revoked)); return }
                do {
                    guard !self.providerOperationDraining else { throw RelayTunRuntimeRules.Failure.unavailable }
                    _ = try self.runtimeRulesOwner()
                    guard let core = self.managedCore else { throw RelayTunRuntimeRules.Failure.revoked }
                    reply(.success(try core.applyRuntimeRule(mutation, access: access)))
                } catch { reply(.failure(error)) }
            }
        })
        guard let channel = RelayTunRuntimeRules.Channel(binding: try .init(bundle.binding.json), clientSHA256: clientSHA256,
            installationRevision: revision, driver: driver, input: input, output: output, execute: { [weak self] work in
                self?.mutationQueue.async { work() }
            }) else { throw Failure.state }
        transferred = true
        stateLock.lock()
        guard runtimeRulesChannel == nil else { stateLock.unlock(); throw Failure.state }
        runtimeRulesChannel = channel; stateLock.unlock()
        channel.start()
    }
    /// Only Controller/Driver's normal execution queue calls this fast stamp.
    /// Cancel/EOF instead revoke Access directly without reading session state.
    private func runtimeRulesOwner() throws -> RelayTunRuntimeRules.Owner {
        guard authorized(), initialized, !disposed, phase == "active", let core = managedCore else { throw RelayTunRuntimeRules.Failure.revoked }
        let owner = try core.runtimeRulesOwner()
        guard owner.configurationRevision == bundle.binding.runtimeConfigurationSHA256 else { throw Failure.binding }
        return owner
    }
    /// Constructed by the positive resources launch, strongly held, but its
    /// hello starts only after initialize's control ACK has actually returned.
    func startRuntimeResources(input: Int32 = 7, output: Int32 = 8) throws {
        var transferred = false
        defer { if !transferred { Darwin.close(input); Darwin.close(output) } }
        guard bundle.resourcesEnabled, let revision = bundle.installationRevision, bundle.resourceInbox != nil else { throw Failure.state }
        let clientSHA = try runtimeCapabilityIdentity(revision: revision)
        let driver = RelayTunRuntimeResourcesChannel.Driver(read: { [weak self] context, done in
            guard let self else { done(.failure(Failure.revoked)); return }
            do { done(.success(try readRuntimeResources(context))) } catch { done(.failure(error)) }
        }, replace: { [weak self] id, selection, context, done in
            guard let self else { done(.init(status: .unavailable)); return }
            let authority = runtimeTrafficAuthority, mutationTicket = runtimeTrafficAuthority.beginMutation()
            replaceRuntimeResource(id: id, selection: selection, context: context, done: { reply in
                authority.finishMutation(mutationTicket); done(reply)
            })
        }, cancelReplace: { [weak self] id in
            guard let self else { return .init(status: .unavailable) }
            stateLock.lock(); let controller = resourceController; stateLock.unlock()
            return controller?.cancel(operationId: id) ?? .init(status: .stale)
        }, discard: { [weak self] ticket, context, done in
            guard let self, let inbox = bundle.resourceInbox else { done(.failure(Failure.revoked)); return }
            do { done(.success(try inbox.discardBlob(ticket, check: context.check))) } catch { done(.failure(error)) }
        }, invalidate: { [weak self] in self?.invalidateRuntimeResources() })
        guard let channel = RelayTunRuntimeResourcesChannel(binding: try .init(bundle.binding.json), clientSHA256: clientSHA,
            installationRevision: revision, driver: driver, input: input, output: output,
            execute: { [weak self] work in self?.mutationQueue.async { work() } }) else { throw Failure.state }
        transferred = true
        stateLock.lock()
        guard runtimeResourcesChannel == nil, !resourceRevoked else { stateLock.unlock(); channel.invalidate(); throw Failure.state }
        runtimeResourcesChannel = channel; stateLock.unlock()
    }
    private func invalidateRuntimeResources() {
        stateLock.lock(); resourceRevoked = true; let controller = resourceController; stateLock.unlock()
        controller?.close()
    }
    private func resourcesLive(_ context: RelayTunRuntimeResourcesChannel.Context) throws -> RelayTunManagedCore {
        try context.check()
        stateLock.lock(); let revoked = resourceRevoked; stateLock.unlock()
        guard !revoked, authorized(), initialized, !disposed, phase == "active", let core = managedCore else { throw Failure.revoked }
        _ = try core.runtimeRulesOwner(); try context.check(); return core
    }
    private func readRuntimeResources(_ context: RelayTunRuntimeResourcesChannel.Context) throws -> RelayTunRuntimeResourcesChannel.Observation {
        guard !bundle.resourceIsolated else { throw RelayTunRuntimeResourcesChannel.Failure.uncertain }
        let core = try resourcesLive(context)
        let check = { _ = try self.resourcesLive(context) }
        let state = try core.readRuntimeResources(before: context.deadline, check: check)
        let ledger = try bundle.observeResourceState(state, check: check)
        try check(); return .init(configurationRevision: bundle.binding.runtimeConfigurationSHA256, ledger: ledger)
    }
    private func replaceRuntimeResource(id: Int, selection: RelayTunRuntimeResources.Selection,
                                        context: RelayTunRuntimeResourcesChannel.Context,
                                        done: @escaping (RelayTunRuntimeResources.Reply) -> Void) {
        typealias Model = RelayTunRuntimeResources
        guard !bundle.resourceIsolated else { done(.init(status: .uncertain)); return }
        do {
            let core = try resourcesLive(context)
            guard selection.configurationRevision == bundle.binding.runtimeConfigurationSHA256,
                  let inbox = bundle.resourceInbox else { throw Failure.binding }
            let observation = try readRuntimeResources(context), previous = observation.ledger
            try bundle.beginResourceTransition(selection, previous: previous)
            let driver = Model.Driver(currentOwner: { [weak self] in
                guard let self else { throw Failure.revoked }
                return try resourcesLive(context).runtimeResourcesOwner(coreBootId: previous.bootId)
            }, readBlob: { selection, access, reply in
                do { reply(.success(try inbox.consume(selection, check: access.check))) } catch { reply(.failure(error)) }
            }, prepareCore: { selection, blob, access, reply in
                do {
                    try inbox.stage(selection, blob: blob, check: access.check)
                    reply(.success(try core.prepareRuntimeResource(selection, access: access)))
                } catch { reply(.failure(error)) }
            }, commitCore: { [weak self] prepared, access, reply in
                guard let self else { reply(.failure(Failure.revoked)); return }
                do {
                    let receipt = try core.commitRuntimeResource(prepared, access: access)
                    let state = try core.readRuntimeResources(before: access.deadline, check: access.check)
                    let readback = try bundle.readResourcePostimage(state, check: access.check)
                    guard readback.bootId == receipt.bootId, readback.sequence == receipt.sequence,
                          readback.generationSHA256 == receipt.generationSHA256,
                          let old = previous.resources[selection.kind] else { throw Failure.binding }
                    try inbox.registerRetained(nonce: prepared.nonce, previous: old, applied: receipt, check: access.check)
                    reply(.success(.init(receipt: receipt, readback: readback)))
                } catch { reply(.failure(error)) }
            }, cancelPrepared: { prepared, _, deadline, reply in
                do { reply(.success(try core.cancelRuntimeResource(prepared, before: deadline))) } catch { reply(.failure(error)) }
            })
            let controller = try Model.Controller(ledger: previous, staticAssetBytes: bundle.staticResourceBytes, driver: driver)
            stateLock.lock(); resourceController = controller; let revoked = resourceRevoked; stateLock.unlock()
            if revoked { controller.close() }
            controller.replace(id: id, selection: selection) { [self, controller] response in
                var answer = response
                do { try bundle.finishResourceTransition(response, isolated: controller.isIsolated) }
                catch {
                    try? bundle.finishResourceTransition(response, isolated: true)
                    answer = .init(status: .uncertain)
                }
                // An unknown sibling/changed stage is evidence, never a
                // reason to recursively delete or invent a Core rollback.
                try? inbox.cleanupStage(selection.blobId)
                do { _ = try resourcesLive(context) }
                catch {
                    if answer.status == .updated {
                        // Scope may be lost during terminal spool cleanup.
                        // Reinstall the exact selection as isolated below;
                        // never publish a stale success snapshot.
                        bundle.isolateCompletedResource(selection)
                        answer = .init(status: .uncertain)
                    }
                }
                stateLock.lock(); if resourceController === controller { resourceController = nil }; stateLock.unlock()
                done(answer)
            }
        } catch {
            // No admitted model transaction was started. Keep the original
            // fixed target inventory; do not create an inferred generation.
            try? bundle.finishResourceTransition(.init(status: .unavailable), isolated: false)
            done(.init(status: .unavailable))
        }
    }
    func startRuntimeRuleProviders(input: Int32 = 9, output: Int32 = 10) throws {
        typealias Channel = RelayTunRuntimeRuleProvidersChannel
        var transferred = false
        defer { if !transferred { Darwin.close(input); Darwin.close(output) } }
        guard bundle.ruleProvidersEnabled, let revision = bundle.installationRevision,
              bundle.resourceInbox != nil else { throw Failure.state }
        let clientSHA = try runtimeCapabilityIdentity(revision: revision)
        let driver = Channel.Driver(read: { [weak self] context, done in
            guard let self else { done(.failure(Failure.revoked)); return }
            do { done(.success(try self.readRuntimeRuleProviders(context))) } catch { done(.failure(error)) }
        }, replace: { [weak self] id, selection, context, done in
            guard let self else { done(.init(status: .unavailable)); return }
            let authority = self.runtimeTrafficAuthority, mutationTicket = self.runtimeTrafficAuthority.beginMutation()
            self.replaceRuntimeRuleProvider(id: id, selection: selection, context: context, done: { reply in
                authority.finishMutation(mutationTicket); done(reply)
            })
        }, cancelReplace: { [weak self] id in
            guard let self else { return .init(status: .unavailable) }
            self.stateLock.lock(); let controller = self.ruleProviderController; self.stateLock.unlock()
            return controller?.cancel(operationId: id) ?? .init(status: .stale)
        }, discard: { [weak self] ticket, context, done in
            guard let self, let inbox = self.bundle.resourceInbox else { done(.failure(Failure.revoked)); return }
            do {
                let result = try inbox.discardProviderBlob(Self.providerTicket(ticket), check: context.check)
                done(.success(result == .discarded ? .discarded : .absent))
            } catch { done(.failure(error)) }
        }, invalidate: { [weak self] in self?.invalidateRuntimeRuleProviders() })
        guard let channel = Channel(binding: try .init(bundle.binding.json), clientSHA256: clientSHA,
            installationRevision: revision, driver: driver, input: input, output: output,
            execute: { [weak self] work in self?.mutationQueue.async { work() } }) else { throw Failure.state }
        transferred = true
        stateLock.lock()
        guard runtimeRuleProvidersChannel == nil, !ruleProvidersRevoked else { stateLock.unlock(); channel.invalidate(); throw Failure.state }
        runtimeRuleProvidersChannel = channel; stateLock.unlock()
    }
    private static func providerTicket(_ ticket: RelayTunRuntimeRuleProvidersChannel.Ticket) throws -> RelayTunRuntimeResourceInbox.ProviderTicket {
        guard let kind = RelayTunRuntimeResourceInbox.ProviderKind(rawValue: ticket.kind.rawValue) else { throw Failure.binding }
        return try .init(blobId: ticket.blobId, kind: kind, sha256: ticket.sha256, bytes: ticket.bytes, filename: ticket.filename)
    }
    private func invalidateRuntimeRuleProviders() {
        stateLock.lock(); ruleProvidersRevoked = true; let controller = ruleProviderController; stateLock.unlock()
        controller?.close()
    }
    /// This observer may run under the provider file lock. It reads only the
    /// queue-owned cached budget and fast held-child authority, never Bundle.verify.
    private func currentRuleProviderContext() throws -> RelayTunRuntimeRuleProviders.Context {
        typealias Model = RelayTunRuntimeRuleProviders
        stateLock.lock(); let revoked = ruleProvidersRevoked; stateLock.unlock()
        guard !revoked, authorized(), initialized, !disposed, phase == "active",
              let core = managedCore, let geo = bundle.resourceLedger,
              !bundle.resourceIsolated, !bundle.ruleProviderIsolated else { throw Model.Failure.revoked }
        let (stamp, coreSHA) = try core.runtimeRuleProvidersOwner()
        return .init(owner: try .init(heldGeneration: stamp.generation,
            configurationRevision: stamp.configurationRevision, coreSHA256: coreSHA, ordinaryUID: getuid()),
            geo: try .init(generationSHA256: geo.generationSHA256, bytes: geo.resources.values.reduce(0) { $0 + $1.bytes }))
    }
    private func readRuntimeRuleProviders(_ context: RelayTunRuntimeRuleProvidersChannel.Context) throws -> RelayTunRuntimeRuleProvidersChannel.Observation {
        guard !providerOperationDraining, !bundle.ruleProviderIsolated else { throw RelayTunRuntimeRuleProvidersChannel.Failure.uncertain }
        try context.check()
        guard authorized(), initialized, !disposed, phase == "active", let core = managedCore else { throw Failure.revoked }
        func check() throws {
            try context.check()
            stateLock.lock(); let revoked = ruleProvidersRevoked; stateLock.unlock()
            guard !revoked, authorized() else { throw Failure.revoked }
            _ = try core.runtimeRuleProvidersOwner()
        }
        // A resource-free configuration still has a same-boot empty Geo
        // ledger. All later contexts use this checked cached head and budget.
        let geo = try core.readRuntimeResources(before: context.deadline, check: check)
        _ = try bundle.observeResourceState(geo, check: check)
        let authority = try currentRuleProviderContext()
        let metadata = try core.readRuntimeRuleProviders(before: context.deadline, check: check)
        let ledger = try bundle.observeRuleProviders(metadata, context: authority, check: check)
        if let controller = ruleProviderController {
            guard !controller.isBusy, controller.isolation == nil, controller.knownLedger == ledger else { throw Failure.binding }
        } else {
            let controller = try makeRuleProviderController(ledger: ledger, authority: authority)
            stateLock.lock(); ruleProviderController = controller; let revoked = ruleProvidersRevoked; stateLock.unlock()
            if revoked { controller.close(); throw Failure.revoked }
        }
        try check()
        return .init(configurationRevision: bundle.binding.runtimeConfigurationSHA256, ledger: ledger)
    }
    private func makeRuleProviderController(ledger: RelayTunRuntimeRuleProviders.Ledger,
                                           authority: RelayTunRuntimeRuleProviders.Context) throws -> RelayTunRuntimeRuleProviders.Controller {
        typealias Model = RelayTunRuntimeRuleProviders
        let driver = Model.Driver(supportsSynchronousFileRead: true, currentContext: { [weak self] in
            guard let self else { throw Model.Failure.revoked }; return try self.currentRuleProviderContext()
        }, readBlob: { [weak self] selection, access, done in
            guard let self, let inbox = self.bundle.resourceInbox,
                  let row = self.ruleProviderController?.knownLedger.resources[selection.provider],
                  let kind = RelayTunRuntimeResourceInbox.ProviderKind(rawValue: "rule-" + row.binding.format.rawValue) else { done(.failure(Failure.binding)); return }
            do {
                let ticket = try RelayTunRuntimeResourceInbox.ProviderTicket(blobId: selection.blobId, kind: kind,
                    sha256: selection.newSHA256, bytes: selection.bytes, filename: selection.blobId + "." + kind.suffix)
                let blob = try inbox.consumeProvider(ticket, check: access.check)
                done(.success(try .init(id: blob.id, format: row.binding.format, data: blob.data, identity: blob.identity)))
            } catch { done(.failure(error)) }
        }, stage: { [weak self] group, blob, access, done in
            guard let self else { done(.failure(Failure.revoked)); return }
            self.stageRuntimeRuleProvider(group: group, blob: blob, access: access, done: done)
        }, prune: { [weak self] records, access, done in
            guard let self, let files = self.bundle.ruleProviderFiles else { done(.failure(Failure.binding)); return }
            do { try self.bundle.verify(); try access.check(); done(.success(files.prune(records, check: access.check))) }
            catch { done(.failure(error)) }
        }, publish: { [weak self] stage, access, done in
            guard let self else { done(.failure(Failure.revoked)); return }
            do { done(.success(try self.publishRuntimeRuleProvider(stage, access: access))) } catch { done(.failure(error)) }
        }, cleanup: { [weak self] stage, disposition, done in
            guard let self, let files = self.bundle.ruleProviderFiles else { done(.failure(Failure.binding)); return }
            do {
                switch disposition {
                case .discardUnpublished: try files.discardUnpublished(stage, check: {})
                case .keepPublishedAndRetained: try files.verifyKnownLayouts(check: {})
                }
                done(.success(()))
            } catch { done(.failure(error)) }
        })
        return try .init(ledger: ledger, staticAssetBytes: bundle.nonGeoNonProviderResourceBytes,
            initialGeo: authority.geo, driver: driver)
    }
    private func stageRuntimeRuleProvider(group: [RelayTunRuntimeRuleProviders.Resource], blob: RelayTunRuntimeRuleProviders.Blob,
                                         access: RelayTunRuntimeRuleProviders.Access,
                                         done: @escaping (Result<RelayTunRuntimeRuleProviders.Stage, Error>) -> Void) {
        typealias Probe = RelayTunRuntimeRuleProviderProbe
        do {
            guard let selection = providerSelection, let context = providerRequestContext else { throw Failure.binding }
            let authority = try currentRuleProviderContext()
            let snapshot = try bundle.captureProviderSnapshot(context: authority, group: group, check: access.check)
            let projection = try Probe.project(snapshot, blob: blob, declaredRuleCount: selection.declaredRuleCount)
            let fence = try access.preparePublishFence()
            providerProjection = projection
            #if RELAY_TUN_APP_SESSION_TESTS
            let testProbe = testDriver?.probeRuleProvider
            let testWorkspace = testDriver?.providerProbeWorkspace
            #endif
            // The worker uses immutable data and pure latches. It never calls
            // a queue-owned Bundle/Core observer or waits back on this queue.
            providerProbeQueue.async { [self] in
                let result: Result<Probe.Acceptance, Error>
                do {
                    func runOwnedProbe() throws -> Probe.Acceptance {
                        func workspace(_ value: Probe.Projection) throws -> Probe.Workspace {
                            #if RELAY_TUN_APP_SESSION_TESTS
                            if let testWorkspace { return try testWorkspace(value) }
                            #endif
                            return try RelayTunAppBundle.makeProviderProbeWorkspace(projection: value, corePin: Probe.corePin)
                        }
                        let probe = Probe.Session(projection: projection, deadline: access.deadline, check: {
                            try access.validateFence(fence); try context.check()
                        }, buildWorkspace: workspace, register: { probe in
                            stateLock.lock(); providerProbes.append(probe); stateLock.unlock()
                        })
                        return try probe.perform()
                    }
                    #if RELAY_TUN_APP_SESSION_TESTS
                    if let testProbe {
                        result = .success(try testProbe(projection, access.deadline, {
                            try access.validateFence(fence); try context.check()
                        }))
                    } else { result = .success(try runOwnedProbe()) }
                    #else
                    result = .success(try runOwnedProbe())
                    #endif
                } catch { result = .failure(error) }
                mutationQueue.async { [self] in
                    stateLock.lock(); providerProbes.removeAll { $0.isSettled }; stateLock.unlock()
                    do {
                        let receipt = try result.get(); try context.check(); try access.check(); try bundle.verify()
                        guard receipt.coreSHA256 == authority.owner.coreSHA256,
                              receipt.sourceConfigurationSHA256 == authority.owner.configurationRevision,
                              receipt.geoGenerationSHA256 == authority.geo.generationSHA256,
                              receipt.bodySHA256 == selection.newSHA256,
                              receipt.projectedConfigurationSHA256 == projection.configurationSHA256,
                              let files = bundle.ruleProviderFiles else { throw Failure.binding }
                        let names = Set(group.map { $0.binding.name })
                        let counts = receipt.counts.filter { names.contains($0.key) }
                        done(.success(try files.stage(group: group, blob: blob, checkedRuleCounts: counts, check: access.check)))
                    } catch { done(.failure(error)) }
                }
            }
        } catch { done(.failure(error)) }
    }
    private func publishRuntimeRuleProvider(_ stage: RelayTunRuntimeRuleProviders.Stage,
                                            access: RelayTunRuntimeRuleProviders.Access) throws -> RelayTunRuntimeRuleProviders.Publication {
        typealias Model = RelayTunRuntimeRuleProviders
        guard let core = managedCore, let files = bundle.ruleProviderFiles, let projection = providerProjection,
              let previous = ruleProviderController?.knownLedger else { throw Failure.binding }
        try access.check(); try bundle.verify()
        _ = try files.swap(stage, access: access)
        let fence = try access.preparePublishFence()
        var accepted = Set<String>()
        for binding in stage.bindings {
            try core.updateRuntimeRuleProvider(name: binding.name, before: access.deadline, check: access.check,
                beforeDispatch: { try access.validateFence(fence) })
            accepted.insert(binding.name)
        }
        let metadata = try core.readRuntimeRuleProviders(before: access.deadline, check: access.check)
        let receipt = try RelayTunRuntimeRuleProviderProbe.accepted(projection, putAccepted: accepted, metadata: metadata)
        let swapped = try files.verifySwapped(stage, check: access.check)
        try bundle.verify(); try access.check()
        let names = Set(stage.bindings.map { $0.name })
        let rows = try previous.resources.values.map { old -> Model.Resource in
            guard names.contains(old.binding.name) else { return old }
            guard let count = receipt.counts[old.binding.name] else { throw Failure.binding }
            return try .init(binding: old.binding, fileSHA256: stage.sha256, identity: swapped.currentIdentity,
                ruleCount: count, registeredFile: true)
        }
        return .init(retained: swapped.retained, resources: rows, acceptance: .synchronousFileRead)
    }
    private func replaceRuntimeRuleProvider(id: Int, selection: RelayTunRuntimeRuleProvidersChannel.Selection,
                                           context: RelayTunRuntimeRuleProvidersChannel.Context,
                                           done: @escaping (RelayTunRuntimeRuleProviders.Reply) -> Void) {
        typealias Model = RelayTunRuntimeRuleProviders
        guard !bundle.ruleProviderIsolated else { done(.init(status: .uncertain)); return }
        guard !providerOperationDraining else { done(.init(status: .busy)); return }
        do {
            let observation = try readRuntimeRuleProviders(context), authority = try currentRuleProviderContext()
            guard let row = observation.ledger.resources[selection.provider], row.binding.format == selection.kind.format,
                  let controller = ruleProviderController else { throw Failure.binding }
            let input = try Model.Selection(provider: selection.provider, configurationRevision: selection.configurationRevision,
                expectedGenerationSHA256: selection.expectedGenerationSHA256, expectedGeoGenerationSHA256: authority.geo.generationSHA256,
                oldSHA256: selection.oldSHA256, newSHA256: selection.newSHA256, blobId: selection.blobId,
                bytes: selection.bytes, declaredRuleCount: selection.declaredRuleCount)
            try bundle.beginRuleProviderOperation(selection: input, previous: observation.ledger)
            providerSelection = input; providerRequestContext = context; providerOperationDraining = true
            providerDrainGroup.enter()
            controller.replace(id: id, selection: input, maximumDeadline: context.deadline) { [self, controller] response in
                var answer = response
                do {
                    if response.status == .published { try context.check() }
                    try bundle.endRuleProviderOperation(response, isolated: controller.isolation != nil)
                } catch {
                    try? bundle.endRuleProviderOperation(.init(status: .uncertain), isolated: true)
                    answer = .init(status: .uncertain)
                }
                providerSelection = nil; providerRequestContext = nil; providerProjection = nil
                providerOperationDraining = false
                done(answer)
                let pending = providerDrainWaiters; providerDrainWaiters.removeAll()
                for work in pending { mutationQueue.async { work() } }
                providerDrainGroup.leave()
            }
        } catch { done(.init(status: .unavailable)) }
    }
    /// Control recovery cannot delete a Bundle while its inert checker still
    /// owns a child/workspace. Keep it asynchronous so cancel can always drain.
    private func afterProviderDrain(_ work: @escaping () -> Void) {
        if providerOperationDraining { providerDrainWaiters.append(work) } else { work() }
    }
    private func cleanupProviderProbes() throws -> Bool {
        stateLock.lock(); let probes = providerProbes; stateLock.unlock()
        for probe in probes {
            do { try probe.cleanup() }
            catch {
                // A still-owned child must really drain. An already reaped
                // child's unknown private files are preserved, never adopted
                // or used to keep a restored system capability alive.
                guard probe.isDrained else { throw error }
                providerEvidenceRetained = true
            }
        }
        stateLock.lock(); providerProbes.removeAll { $0.isSettled || $0.isDrained }; let empty = providerProbes.isEmpty; stateLock.unlock()
        guard empty else { throw Failure.unverified }
        return providerEvidenceRetained
    }
    @discardableResult private func finalizeBundleAfterRestoration() throws -> RelayTunAppBundle.FinalDisposition {
        // Filesystem evidence is independent of the capability lifetime. A
        // narrowly recognized lost Geo receipt may preserve its private home,
        // but never substitutes for a fresh verified network/device baseline.
        recoveryStage = "dispose.core"; try managedCore?.verifyRestored()
        let probeEvidence = try cleanupProviderProbes()
        recoveryStage = "dispose.bundle"
        let disposition = try bundle.finalizeAfterRestoration()
        if probeEvidence || disposition == .retainedEvidence {
            let message = Array("RELAY_TUN_PRIVATE_RESOURCE_EVIDENCE_RETAINED\n".utf8)
            _ = message.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
        }
        return disposition
    }
    /// Revoke admission, drain inherited pipes and bounded worker IO, then
    /// enqueue behind their owner callbacks. This path never writes networking.
    private func afterReleasedWorkersDrain(_ work: @escaping (Result<Void, Error>) -> Void) {
        releaseDrainGroup.enter()
        suspend()
        bundle.smartStateHandoff?.beginDisposal(cleanupNonce: nil)
        stateLock.lock()
        let groups = proxyGroupsChannel, capture = runtimeCaptureChannel, rules = runtimeRulesChannel, resources = runtimeResourcesChannel
        let providers = runtimeRuleProvidersChannel, state = smartStateChannel, tools = smartToolsChannel
        stateLock.unlock()
        recoveryStage = "release-owned.channels"
        let drained = [groups?.invalidateAndDrain(), capture?.invalidateAndDrain(), rules?.invalidateAndDrain(), resources?.invalidateAndDrain(),
                       providers?.invalidateAndDrain(), state?.invalidateAndDrain(), tools?.invalidateAndDrain()]
            .allSatisfy { $0 != false }
        proxyGroupsIOQueue.sync {}; runtimeTrafficIOQueue.sync {}; smartToolsIOQueue.sync {}; smartStateIOQueue.sync {}
        providerProbeQueue.sync {}; revokeQueue.sync {}
        mutationQueue.async { [self] in
            defer { releaseDrainGroup.leave() }
            guard drained, !providerOperationDraining, resourceController?.isBusy != true,
                  ruleProviderController?.isBusy != true, bundle.smartStateHandoff?.workerPending != true else {
                work(.failure(Failure.unverified)); return
            }
            work(.success(()))
        }
    }
    private func finalizeReleasedResources() throws {
        recoveryStage = "release-owned.session"
        guard bundle.coreManaged, !disposed, let managedCore,
              currentHost() == nil, helperSession() == nil, heldDelivery == nil, core == nil else { throw Failure.state }
        _ = try cleanupProviderProbes()
        recoveryStage = "release-owned.core"
        try managedCore.disposeReleased { try bundle.recordReleasedResources() }
        // The core is reaped and its routes/DNS/device match the original
        // network digest. The external proxy change is deliberately unverified.
        restored = false; coreState = "stopped"; device = "absent"; network = "unknown"
        currentClient()?.invalidate(); markDisposed()
    }
    private func failControlRecovery() {
        reportRecoveryFailure()
        try? bundle.recordControlRecovery(restored: false, failureStage: recoveryFailureCode)
        let message = Array("Relay owned-session control-loss recovery remains unverified; ownership is retained.\n".utf8)
        _ = message.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
    }
    private func exitAfterControlRecovery() {
        #if RELAY_TUN_APP_SESSION_TESTS
        if testDriver != nil { return }
        #endif
        Darwin.exit(0)
    }
    private func revokeRuntimeTraffic() { runtimeTrafficAuthority.revoke() }
    private func readRuntimeTraffic(context: RelayTunRuntimeCapture.TrafficContext, connections: Bool = false,
                                   proxies: RelayTunRuntimeCapture.ProxyAction? = nil,
                                   reply: @escaping (RelayTunRuntimeCapture.TrafficResult) -> Void) {
        // Bind at FD admission, before owner-queue wait. An old queued read
        // cannot acquire the epoch created by a resource/rule change.
        let authority = runtimeTrafficAuthority, stamp: UUID
        do { try context.check(); stamp = try authority.begin() }
        catch { reply(.unavailable); return }
        mutationQueue.async { [self] in
            do {
                try context.check(); try authority.check(stamp)
                guard !providerOperationDraining else { reply(.busy); return }
                guard authorized(), initialized, !disposed, phase == "active", let core = managedCore else {
                    reply(.unavailable); return
                }
                let lease = try core.trafficLease(connections: connections, proxies: proxies)
                guard lease.configurationRevision == bundle.binding.runtimeConfigurationSHA256 else { throw Failure.binding }
                try context.bindOwner {
                    try authority.check(stamp); try lease.assertOwner(); try authority.check(stamp)
                }
                try context.bindPublication { check in try lease.verifyPublication(check) }
                try context.check()
                let io = proxies == nil ? runtimeTrafficIOQueue : proxyGroupsIOQueue
                io.async {
                    do {
                        let raw = try lease.read(context.deadline, context.check)
                        try context.check(); reply(.sampled(raw))
                    } catch { reply(.unavailable) }
                }
            } catch { reply(.unavailable) }
        }
    }
    func captureRuntime(deadline: UInt64, reply: @escaping (RelayTunRuntimeCapture.Result) -> Void) {
        mutationQueue.async { [self] in
            guard RelayTunRuntimeCapture.now < deadline else { reply(.busy); return }
            guard !providerOperationDraining else { reply(.busy); return }
            guard authorized(), initialized, !disposed, phase == "active", let managedCore else { reply(.unavailable); return }
            do {
                let snapshot = try managedCore.captureRuntime(deadline: deadline)
                guard snapshot.originalLoadedSHA256 == bundle.binding.runtimeConfigurationSHA256,
                      snapshot.originalLoadedBytes == bundle.configuration.count else { reply(.unavailable); return }
                reply(.captured(snapshot))
            }
            catch RelayTunRuntimeCapture.Failure.unsupported { reply(.unsupported) }
            catch is RelayTunTCPListener.Failure { reply(.unsupported) }
            catch { reply(.unavailable) }
        }
    }
    #if RELAY_TUN_APP_SESSION_TESTS
    struct TestDriver {
        let revision: String
        let exchange: (String, [String: Any]) throws -> (RelayTunWireResponse, FileHandle?)
        let reconnect: () throws -> Void
        let baseline: (RelayTunAcquiredReceipt?) throws -> RelayTunNetworkTransaction.Baseline
        let makeHost: (RelayTunAcquiredReceipt, FileHandle, RelayTunAppBundle) throws -> RelayTunCoreHost
        let emit: ([String: Any]) -> Void
        var makeManagedCore: ((RelayTunAppBundle, @escaping () -> Bool) throws -> RelayTunManagedCore)? = nil
        var runtimeCaptureIdentity: (() throws -> (revision: String, clientSHA256: String))? = nil
        var probeRuleProvider: ((RelayTunRuntimeRuleProviderProbe.Projection, UInt64, () throws -> Void) throws -> RelayTunRuntimeRuleProviderProbe.Acceptance)? = nil
        var providerProbeWorkspace: ((RelayTunRuntimeRuleProviderProbe.Projection) throws -> RelayTunRuntimeRuleProviderProbe.Workspace)? = nil
    }
    func waitSmartToolsForTest() { smartToolsIOQueue.sync {} }
    private var testDriver: TestDriver?
    convenience init(bootstrap: Data, testDriver: TestDriver, coreManaged: Bool = false, resourcesEnabled: Bool = false, ruleProvidersEnabled: Bool = false,
                     executionContext: RelayTunAppBundle.ExecutionContext? = nil) throws {
        try self.init(bootstrap: bootstrap, coreManaged: coreManaged, resourcesEnabled: resourcesEnabled, ruleProvidersEnabled: ruleProvidersEnabled,
                      executionContext: executionContext); self.testDriver = testDriver
    }
    #endif
    private func authorized() -> Bool { stateLock.lock(); defer { stateLock.unlock() }; return authorization }
    private func currentHost() -> RelayTunCoreHost? { stateLock.lock(); defer { stateLock.unlock() }; return host }
    private func setHost(_ value: RelayTunCoreHost) { stateLock.lock(); host = value; stateLock.unlock() }
    private func currentClient() -> RelayTunXPCClient? { stateLock.lock(); defer { stateLock.unlock() }; return client }
    private func storeClient(_ value: RelayTunXPCClient) { stateLock.lock(); client = value; stateLock.unlock() }
    private func markDisposed() {
        revokeRuntimeTraffic()
        revokeSmartTools()
        stateLock.lock(); disposed = true; let state = smartStateChannel; stateLock.unlock()
        state?.invalidate()
    }
    private func helperSession() -> String? { stateLock.lock(); defer { stateLock.unlock() }; return prepared?.sessionID }
    private func storePrepared(_ value: RelayTunWireResponse) { stateLock.lock(); prepared = value; stateLock.unlock() }
    private func suspend() {
        revokeRuntimeTraffic()
        revokeSmartTools()
        stateLock.lock(); authorization = false; let host = self.host, rules = runtimeRulesChannel, resources = runtimeResourcesChannel, providers = runtimeRuleProvidersChannel; stateLock.unlock()
        providers?.invalidate()
        resources?.invalidate()
        rules?.invalidate()
        host?.suspend()
    }
    func query(_ request: NSData, withReply reply: @escaping (NSData) -> Void) {
        if let host = currentHost() { RelayTunCoreObservationEndpoint(host: host).query(request, withReply: reply); return }
        // An authenticated delivery can fail before CoreHost construction. No
        // launch is possible without that host; explicit closure of its only
        // client delivery still supplies honest release proof for this receipt.
        stateLock.lock(); let receipt = self.receipt, closed = unstartedDeliveryClosed; stateLock.unlock()
        do {
            let (expected, operation, nonce) = try RelayTunCoreObservation.decodeRequest(request as Data)
            guard receipt == expected else { throw Failure.binding }
            let result: RelayTunCoreObservation.Result? = operation == .released ? .released(closed) : nil
            let response = try RelayTunCoreObservation.response(receipt: expected, operation: operation, nonce: nonce,
                result: result, available: operation == .released)
            reply(response as NSData)
        } catch { reply(NSData()) }
    }
    private final class Exchange {
        let finished = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var result: Result<(RelayTunWireResponse, FileHandle?), Error>?
        func complete(_ value: Result<(RelayTunWireResponse, FileHandle?), Error>) {
            lock.lock(); defer { lock.unlock() }
            guard result == nil else { if case .success(let (_, file)) = value { try? file?.close() }; return }
            result = value; finished.signal()
        }
        func take() throws -> (RelayTunWireResponse, FileHandle?) {
            lock.lock(); defer { lock.unlock() }
            guard let result else { throw Failure.unverified }; return try result.get()
        }
    }
    private func transact(_ operation: String, _ fields: [String: Any] = [:]) throws -> (RelayTunWireResponse, FileHandle?) {
        #if RELAY_TUN_APP_SESSION_TESTS
        if let testDriver { return try testDriver.exchange(operation, fields) }
        #endif
        guard let client = currentClient() else { throw Failure.state }
        var object = fields
        object["version"] = 1; object["operation"] = operation; object["nonce"] = try RelayTunCoreObservation.randomNonce()
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        let attempt = Exchange()
        try client.transact(bytes, completion: attempt.complete)
        guard attempt.finished.wait(timeout: .now() + 32) == .success else { throw Failure.unverified }
        return try attempt.take()
    }
    private func noFD(_ operation: String, _ fields: [String: Any] = [:]) throws -> RelayTunWireResponse {
        let (response, file) = try transact(operation, fields)
        guard file == nil else { try? file?.close(); throw Failure.unverified }; return response
    }
    private func releaseHelper(_ session: String) throws -> RelayTunWireResponse {
        do { return try noFD("release", ["sessionID": session]) }
        catch {
            // A stopped-session release may rebind one failed transport per
            // request. It keeps the original plan/session and installation;
            // it never repeats prepare/acquire/activation.
            guard phase == "coreStopped",
                  currentHost() == nil || currentHost()?.status.released == true else { throw Failure.unverified }
            #if RELAY_TUN_APP_SESSION_TESTS
            if let testDriver {
                try testDriver.reconnect()
                return try noFD("release", ["sessionID": session])
            }
            #endif
            let trust = try RelayTunInstallationTrust.load()
            guard trust.revision == prepared?.helperRevision, trust.clientUID == getuid() else { throw Failure.binding }
            currentClient()?.invalidate(); storeClient(try RelayTunXPCClient(observation: self))
            return try noFD("release", ["sessionID": session])
        }
    }
    private func baseline(owned: Bool) throws -> RelayTunNetworkTransaction.Baseline {
        #if RELAY_TUN_APP_SESSION_TESTS
        if let testDriver { return try testDriver.baseline(owned ? receipt : nil) }
        #endif
        var identity: RelayTunNetworkEffects.DeviceIdentity?
        if owned, let receipt {
            identity = try .init(id: receipt.deviceID,
                interface: .init(name: receipt.interfaceName, index: receipt.interfaceIndex),
                controlID: receipt.controlID, controlUnit: receipt.controlUnit,
                socketDevice: receipt.socketDeviceValue, socketInode: receipt.socketInodeValue,
                mtu: UInt32(bundle.managedMTU), addresses: bundle.projection?.addresses ?? [])
        }
        return try RelayTunEnvironmentInspector.baseline(owned: identity, sources: RelayTunEnvironmentInspector.live)
    }
    private func verifyBaseline(owned: Bool) throws {
        let current = try baseline(owned: owned)
        guard current == bundle.baseline else { throw Failure.unverified }
    }
    private func observation() -> [String: Any] {
        var result = bundle.binding.json
        result["version"] = 1; result["phase"] = phase; result["core"] = coreState
        result["device"] = device; result["network"] = network
        return result
    }
    private func inspectWorkDirectory() throws -> [String: String] {
        guard phase == "active", !disposed, authorized(), let managedCore else { throw Failure.state }
        let owner = try managedCore.runtimeRulesOwner()
        let proof = try bundle.workDirectoryProof()
        guard try managedCore.runtimeRulesOwner() == owner, authorized() else { throw Failure.revoked }
        return proof
    }
    private func prepare() throws {
        guard !initialized, authorized() else { throw Failure.state }
        try bundle.verify(); try verifyBaseline(owned: false)
        guard let projection = bundle.projection else { throw Failure.state }
        let installation = try connect()
        let response = try noFD("prepare", ["configurationSHA256": bundle.configurationSHA256,
            "runtimeConfigurationSHA256": bundle.binding.runtimeConfigurationSHA256, "bundleSHA256": bundle.bundleSHA256,
            "projection": projection.encoded().map { String(format: "%02x", $0) }.joined(),
            "networkSHA256": bundle.baseline.networkSHA256, "protectionSHA256": bundle.baseline.protectionSHA256])
        guard response.status == .prepared, response.sessionID != nil, response.evidenceSHA256 != nil,
              response.helperRevision == installation, response.clientUID == getuid() else { throw Failure.unverified }
        storePrepared(response); initialized = true
        guard authorized() else { throw Failure.revoked }
    }
    private func connect() throws -> String {
        #if RELAY_TUN_APP_SESSION_TESTS
        if let testDriver { return testDriver.revision }
        #endif
        let trust = try RelayTunInstallationTrust.load()
        guard trust.clientUID == getuid() else { throw Failure.binding }
        storeClient(try RelayTunXPCClient(observation: self))
        return trust.revision
    }
    private func acquire() throws {
        guard initialized, receipt == nil, let evidence = prepared?.evidenceSHA256, authorized() else { throw Failure.state }
        try bundle.verify(); try verifyBaseline(owned: false)
        acquireAttempted = true
        let (response, delivered) = try transact("acquire", ["evidenceSHA256": evidence])
        if response.status == .acquired, let actual = response.acquisition, let delivered {
            stateLock.lock(); receipt = actual; stateLock.unlock()
            heldDelivery = delivered
        }
        guard response.status == .acquired, let delivered, let receipt = response.acquisition,
              receipt.sessionID == prepared?.sessionID, receipt.evidenceSHA256 == evidence,
              receipt.runtimeConfigurationSHA256 == bundle.binding.runtimeConfigurationSHA256 else {
            throw Failure.unverified
        }
        // Retain the exact delivered capability before throwing admission or
        // resource checks; release can close it even if no core was spawned.
        let host: RelayTunCoreHost
        #if RELAY_TUN_APP_SESSION_TESTS
        if let testDriver {
            host = try testDriver.makeHost(receipt, delivered, bundle)
        } else { host = try makeLiveHost(receipt: receipt, delivered: delivered) }
        #else
        host = try makeLiveHost(receipt: receipt, delivered: delivered)
        #endif
        setHost(host)
        #if RELAY_TUN_APP_SESSION_TESTS
        if testDriver == nil { try verifyDelivery(delivered, receipt: receipt) }
        #else
        try verifyDelivery(delivered, receipt: receipt)
        #endif
        device = "held"; phase = "acquired"
        guard authorized() else { host.suspend(); throw Failure.revoked }
    }
    private func verifyDelivery(_ delivered: FileHandle, receipt: RelayTunAcquiredReceipt) throws {
        let admitted = try RelayTunDescriptor.validateLive(delivered.fileDescriptor, receipt: receipt)
        try admitted.close()
    }
    private func makeLiveHost(receipt: RelayTunAcquiredReceipt, delivered: FileHandle) throws -> RelayTunCoreHost {
        let core = try RelayTunLiveCore(receipt: receipt, delivered: delivered, configuration: bundle.configuration,
            directory: bundle.directory, managedMTU: bundle.managedMTU,
            authorization: { [weak self] in self?.authorized() ?? false }, verifyBundle: { try self.bundle.verify() })
        self.core = core; return try core.makeHost()
    }
    private func operation(_ action: String) throws {
        guard !disposed else { throw Failure.state }
        if bundle.coreManaged { try managedOperation(action); return }
        switch action {
        case "initialize": try prepare()
        case "acquire": try acquire()
        case "startCore":
            var stage = "session.state"
            do {
                guard phase == "acquired", let host = currentHost(), authorized() else { throw Failure.state }
                stage = "session.bundle"; try bundle.verify()
                stage = "session.baseline"; try verifyBaseline(owned: true)
                stage = "host"
                guard try host.start().ready, authorized() else { throw Failure.unverified }
                phase = "coreReady"; coreState = "running"
            } catch {
                let code = stage == "host" ? (core?.startReadinessFailure ?? currentHost()?.startFailureStage.map { "host." + $0 } ?? "host.authorization") : stage
                coreStartFailure = code
                FileHandle.standardError.write(Data(("RELAY_TUN_START_FAILURE " + code + "\n").utf8))
                throw error
            }
        case "activate":
            guard phase == "coreReady", let host = currentHost(), let receipt, authorized(),
                  try host.runtime() == bundle.binding.runtimeConfigurationSHA256 else { throw Failure.state }
            try bundle.verify(); try verifyBaseline(owned: true)
            let response = try noFD("activate", ["sessionID": receipt.sessionID, "evidenceSHA256": receipt.evidenceSHA256,
                "runtimeConfigurationSHA256": receipt.runtimeConfigurationSHA256])
            guard response.status == .active, response.sessionID == receipt.sessionID,
                  response.evidenceSHA256 == receipt.evidenceSHA256, authorized() else { throw Failure.unverified }
            phase = "active"; network = "active"
        case "inspect":
            guard initialized else { throw Failure.state }
            try bundle.verify()
            if phase == "active" || phase == "coreReady" {
                guard authorized(), try currentHost()?.runtime() == bundle.binding.runtimeConfigurationSHA256 else { throw Failure.unverified }
                try verifyBaseline(owned: true)
            } else if phase == "acquired", let receipt, let heldDelivery {
                guard authorized() else { throw Failure.revoked }
                let validated = try RelayTunDescriptor.validateLive(heldDelivery.fileDescriptor, receipt: receipt)
                try validated.close(); try verifyBaseline(owned: true)
            } else if phase == "idle", !acquireAttempted { try verifyBaseline(owned: false) }
            else if restored { try verifyBaseline(owned: false) }
            else { throw Failure.unverified }
        case "stopCore":
            suspend()
            if let host = currentHost() {
                guard try host.release().released else { throw Failure.unverified }
                coreState = "stopped"
            } else if let heldDelivery {
                guard !deliveryCloseAttempted else { throw Failure.unverified }
                deliveryCloseAttempted = true
                try heldDelivery.close(); self.heldDelivery = nil
                stateLock.lock(); unstartedDeliveryClosed = true; stateLock.unlock()
                coreState = "none"
            } else {
                // All launches occur through the retained CoreHost. With no
                // host and no transferred delivery there was no local spawn.
                coreState = "none"
            }
            phase = "coreStopped"
        case "release":
            guard phase == "coreStopped",
                  currentHost() == nil || currentHost()?.status.released == true else { throw Failure.state }
            if let session = prepared?.sessionID {
                let response = try releaseHelper(session)
                guard response.status == .released, response.sessionID == session,
                      response.evidenceSHA256 == prepared?.evidenceSHA256 else { throw Failure.unverified }
            } else {
                // prepare cannot acquire a device. Only this positive local
                // no-acquire history permits cleanup after initialize failed.
                guard !acquireAttempted, receipt == nil, currentHost() == nil, heldDelivery == nil else { throw Failure.unverified }
                try verifyBaseline(owned: false)
            }
            phase = "released"; device = receipt == nil ? "none" : "released"; network = "restored"
        case "verifyRestored":
            guard phase == "released", let receipt else {
                guard phase == "released", self.receipt == nil else { throw Failure.state }
                try verifyBaseline(owned: false); restored = true; phase = "restored"; return
            }
            guard if_nametoindex(receipt.interfaceName) == 0 else { throw Failure.unverified }
            try verifyBaseline(owned: false); restored = true; phase = "restored"; device = "absent"
        default: throw Failure.invalid
        }
    }
    private func managedOperation(_ action: String) throws {
        switch action {
        case "initialize":
            guard !initialized, authorized() else { throw Failure.state }
            try bundle.verify(); try verifyBaseline(owned: false)
            let authorization = { [weak self] in self?.authorized() ?? false }
            #if RELAY_TUN_APP_SESSION_TESTS
            if let make = testDriver?.makeManagedCore { managedCore = try make(bundle, authorization) }
            else { managedCore = try RelayTunManagedCore.live(bundle: bundle, authorized: authorization) }
            #else
            managedCore = try RelayTunManagedCore.live(bundle: bundle, authorized: authorization)
            #endif
            initialized = true
        case "startCore":
            do {
                guard initialized, phase == "idle", authorized(), let managedCore else { throw Failure.state }
                try managedCore.start()
                phase = "active"; coreState = "running"; device = "held"; network = "active"
            } catch {
                let code = managedCore?.startFailureCode ?? "managed.state"
                coreStartFailure = code
                FileHandle.standardError.write(Data(("RELAY_TUN_START_FAILURE " + code + "\n").utf8))
                throw error
            }
        case "inspect":
            guard initialized else { throw Failure.state }
            if phase == "active" { try managedCore?.inspect() }
            else if restored { try managedCore?.verifyRestored(); try verifyBaseline(owned: false) }
            else if phase == "idle" { try bundle.verify(); try verifyBaseline(owned: false) }
            else { throw Failure.state }
        case "stopCore":
            recoveryStage = "session.stopCore"
            suspend(); try managedCore?.stop()
            phase = "coreStopped"; coreState = managedCore == nil ? "none" : "stopped"
            device = "unknown"; network = "unknown"
        case "release", "verifyRestored":
            recoveryStage = "session." + action
            guard phase == (action == "release" ? "coreStopped" : "released"),
                  managedCore == nil || managedCore?.released == true else { throw Failure.state }
            recoveryStage = "session." + action + ".core"
            try managedCore?.verifyRestored()
            recoveryStage = "session.baseline"; try verifyBaseline(owned: false)
            phase = action == "release" ? "released" : "restored"
            device = "absent"; network = "restored"; restored = action == "verifyRestored"
        default: throw Failure.invalid
        }
    }
    @discardableResult private func output(_ value: [String: Any]) -> Bool {
        outputLock.lock(); defer { outputLock.unlock() }
        #if RELAY_TUN_APP_SESSION_TESTS
        if let testDriver { testDriver.emit(value); return true }
        #endif
        do {
            let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
            guard bytes.count <= 8192 else { return false }
            stateLock.lock(); let lost = controlLost; stateLock.unlock()
            if lost { return false }
            let frame = bytes + Data([10])
            try frame.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    let count = Darwin.write(STDOUT_FILENO, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if count < 0, errno == EINTR { continue }
                    guard count > 0 else { throw Failure.unverified }; offset += count
                }
            }
            return true
        } catch { inputEnded(); return false }
    }
    func accept(_ bytes: Data) throws {
        stateLock.lock(); let lost = controlLost; stateLock.unlock()
        guard !lost else { throw Failure.revoked }
        let raw = try RelayTunStrictJSON.object(bytes, limit: 8192)
        let noncePresent = raw.keys.contains("stateCleanupNonce")
        let smartDisposal = bundle.smartStateEnabled && raw["action"] as? String == "dispose"
        let stateCleanupNonce = raw["stateCleanupNonce"] as? String
        guard !noncePresent || (smartDisposal && RelayTunHelperTrust.hex(stateCleanupNonce, count: 64) != nil),
              Set(raw.keys) == Set(["version", "id", "action", "sessionId", "evidenceSHA256", "runtimeConfigurationSHA256"])
                .union(noncePresent ? ["stateCleanupNonce"] : []),
              RelayTunStrictJSON.integer(raw["version"]) == 1,
              let id = RelayTunStrictJSON.integer(raw["id"]), id > 0,
              let action = raw["action"] as? String,
              ["initialize", "acquire", "startCore", "activate", "inspect", "inspectWorkDirectory", "revokeActivation", "stopCore", "release", "verifyRestored", "dispose", "disposeReleased"].contains(action),
              action != "disposeReleased" || bundle.coreManaged,
              raw["sessionId"] as? String == bundle.binding.sessionId,
              raw["evidenceSHA256"] as? String == bundle.binding.evidenceSHA256,
              raw["runtimeConfigurationSHA256"] as? String == bundle.binding.runtimeConfigurationSHA256 else { throw Failure.invalid }
        seenLock.lock()
        guard identifiers.count < 4096, identifiers.insert(id).inserted, !closing else { seenLock.unlock(); throw Failure.invalid }
        if action == "dispose" || action == "disposeReleased" { closing = true }
        seenLock.unlock()
        if ["stopCore", "release", "dispose", "disposeReleased"].contains(action) {
            revokeRuntimeTraffic(); revokeSmartTools()
        }
        if action == "revokeActivation" {
            suspend()
            revokeQueue.async { [self] in
                do {
                    if let session = helperSession() {
                        let response = try noFD("revoke", ["sessionID": session])
                        guard response.status == .revoked, response.sessionID == session else { throw Failure.unverified }
                    }
                    var response = bundle.binding.json
                    response["version"] = 1; response["id"] = id; response["action"] = action; response["revoked"] = true
                    output(response)
                } catch {
                    var response = bundle.binding.json
                    response["version"] = 1; response["id"] = id; response["action"] = action; response["revoked"] = false
                    output(response)
                }
            }
            return
        }
        if action == "inspectWorkDirectory" {
            mutationQueue.async { [self] in
                var response = bundle.binding.json
                response["version"] = 1; response["id"] = id; response["action"] = action
                response["workDirectory"] = (try? inspectWorkDirectory()) as Any? ?? NSNull()
                output(response)
            }
            return
        }
        mutationQueue.async { [self] in
            afterProviderDrain { [self] in
            if action == "disposeReleased" {
                afterReleasedWorkersDrain { [self] result in
                    var response = bundle.binding.json
                    response["version"] = 1; response["id"] = id; response["action"] = action
                    do {
                        try result.get(); try finalizeReleasedResources()
                        response["closed"] = true; response["restorationVerified"] = false
                        response["reason"] = "external-protection-changed"
                        response["stateDisposition"] = "retained-evidence"
                    } catch {
                        reportRecoveryFailure()
                        seenLock.lock(); closing = false; seenLock.unlock()
                        response["closed"] = false
                    }
                    output(response)
                }
                return
            }
            do {
                if action == "dispose" {
                    recoveryStage = "session.dispose"
                    guard restored, currentHost() == nil || currentHost()?.status.released == true,
                          managedCore == nil || managedCore?.released == true else { throw Failure.state }
                    bundle.smartStateHandoff?.beginDisposal(cleanupNonce: stateCleanupNonce)
                    let stateDisposition = try finalizeBundleAfterRestoration()
                    recoveryStage = "dispose.core"; try managedCore?.dispose()
                    currentClient()?.invalidate(); markDisposed()
                    var response = bundle.binding.json
                    response["version"] = 1; response["id"] = id; response["action"] = action; response["closed"] = true
                    if bundle.smartStateEnabled { response["stateDisposition"] = stateDisposition == .removed ? "removed" : "retained-evidence" }
                    output(response)
                } else {
                    try operation(action)
                    let delivered = output(["version": 1, "id": id, "action": action, "observation": observation()])
                    if action == "initialize", delivered, authorized() {
                        stateLock.lock(); let channel = resourceRevoked ? nil : runtimeResourcesChannel
                        let providers = ruleProvidersRevoked ? nil : runtimeRuleProvidersChannel
                        let state = smartStateChannel, tools = smartToolsChannel; stateLock.unlock()
                        channel?.start()
                        providers?.start()
                        state?.start()
                        tools?.start()
                    }
                }
            } catch {
                if ["stopCore", "release", "verifyRestored", "dispose", "disposeReleased"].contains(action) { reportRecoveryFailure() }
                if action == "dispose" {
                    seenLock.lock(); closing = false; seenLock.unlock()
                    var response = bundle.binding.json
                    response["version"] = 1; response["id"] = id; response["action"] = action; response["closed"] = false
                    output(response)
                } else { outputFailure(id: id, action: action) }
            }
            }
        }
    }
    private func outputFailure(id: Int, action: String) {
        suspend(); phase = "unknown"; coreState = "unknown"; device = "unknown"; network = "unknown"
        output(["version": 1, "id": id, "action": action, "observation": observation()])
    }
    private func reportRecoveryFailure() {
        let coreStage = ["session.stopCore", "session.release.core", "session.verifyRestored.core", "dispose.core", "release-owned.core"].contains(recoveryStage)
        let code = (coreStage ? managedCore?.recoveryFailureCode : nil) ?? recoveryStage
        recoveryFailureCode = code
        let message = Array(("RELAY_TUN_RECOVERY_FAILURE " + code + "\n").utf8)
        _ = message.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
    }
    private func unknownObservation() -> [String: Any] {
        var result = bundle.binding.json
        result["version"] = 1; result["phase"] = "unknown"; result["core"] = "unknown"
        result["device"] = "unknown"; result["network"] = "unknown"
        return result
    }
    /// Bootstrap admission requires the enabling App confirmation's explicit
    /// restore-owned-session control-loss policy. Its authority is limited to
    /// this session's held child/FD/device; no other Clash process is selected.
    func inputEnded() {
        stateLock.lock()
        guard !controlLost, !disposed else { stateLock.unlock(); return }
        controlLost = true; stateLock.unlock()
        bundle.smartStateHandoff?.beginDisposal(cleanupNonce: nil)
        suspend()
        // Do not wait behind an activation that may be awaiting a callback.
        revokeQueue.async { [self] in
            if let session = helperSession() { _ = try? noFD("revoke", ["sessionID": session]) }
        }
        mutationQueue.async { [self] in
            afterProviderDrain { [self] in
            do {
                if !restored {
                    try operation("stopCore")
                    try operation("release")
                    try operation("verifyRestored")
                }
                guard restored, currentHost() == nil || currentHost()?.status.released == true,
                      managedCore == nil || managedCore?.released == true else { throw Failure.unverified }
                try finalizeBundleAfterRestoration()
                recoveryStage = "dispose.core"
                try managedCore?.dispose()
                currentClient()?.invalidate()
                recoveryStage = "dispose.record"
                try bundle.recordControlRecovery(restored: true)
                markDisposed()
                exitAfterControlRecovery()
            } catch {
                if bundle.coreManaged, managedCore?.recoveryFailureCode == "restore.protection" {
                    afterReleasedWorkersDrain { [self] result in
                        do {
                            try result.get(); try finalizeReleasedResources(); exitAfterControlRecovery()
                        } catch { failControlRecovery() }
                    }
                } else { failControlRecovery() }
            }
            }
        }
    }
    func waitForDisposal() {
        mutationQueue.sync { }
        providerDrainGroup.wait()
        mutationQueue.sync { }
        releaseDrainGroup.wait()
        mutationQueue.sync { }
        revokeQueue.sync { }
    }
    var canExit: Bool { stateLock.lock(); defer { stateLock.unlock() }; return disposed }

    static func status() throws -> RelayTunWireResponse {
        let client = try RelayTunXPCClient(), attempt = Exchange()
        defer { client.invalidate() }
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "operation": "status", "nonce": RelayTunCoreObservation.randomNonce()])
        try client.transact(bytes, completion: attempt.complete)
        guard attempt.finished.wait(timeout: .now() + 32) == .success else { throw Failure.unverified }
        let (response, file) = try attempt.take()
        guard file == nil else { try? file?.close(); throw Failure.unverified }
        return response
    }

    static func inspect() throws -> [String: Any] {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { throw Failure.invalid }
        let time = Int64(Date().timeIntervalSince1970 * 1000), report = try RelayTunEnvironmentInspector.report(owned: nil, sources: RelayTunEnvironmentInspector.live)
        let missingRevision = RelayTunAppBundle.digest(Data("relay-tun-installation-missing".utf8))
        var helper: [String: Any] = ["version": 1, "source": "native", "observedAt": time, "revision": missingRevision,
            "state": "missing", "identity": "unconfirmed", "authorization": "notApproved", "rootOwned": false,
            "runningAsRoot": false, "clientUID": getuid()]
        if FileManager.default.fileExists(atPath: RelayTunInstallationPaths.manifest) {
            helper["state"] = "unconfirmed"; helper["authorization"] = "unconfirmed"
            if let trust = try? RelayTunInstallationTrust.load() {
                helper["revision"] = trust.revision; helper["helperSHA256"] = trust.helper.sha256
                #if arch(arm64)
                helper["coreSHA256"] = trust.coreSHA256["arm64"]
                #else
                helper["coreSHA256"] = trust.coreSHA256["x86_64"]
                #endif
                if let response = try? status() {
                    if response.authenticated && response.rootOwned && response.runningAsRoot && response.clientUID == getuid() {
                        helper["identity"] = "authenticated"; helper["authorization"] = "approved"; helper["rootOwned"] = true; helper["runningAsRoot"] = true
                        helper["state"] = response.executorAvailable ? "ready" : "requiresApproval"
                    }
                }
            }
        }
        let network: [String: Any] = ["version": 1, "source": "native", "observedAt": time, "state": "observed",
            "revision": report.baseline.networkSHA256, "routesSHA256": report.routesSHA256, "dnsSHA256": report.dnsSHA256,
            "interfacesSHA256": report.interfacesSHA256, "proxySHA256": report.proxySHA256,
            "protectionSHA256": report.baseline.protectionSHA256, "existingTunnel": report.existingTunnel ? "present" : "none",
            "recovery": "available"]
        return ["helper": helper, "network": network, "baseline": ["networkSHA256": report.baseline.networkSHA256,
            "protectionSHA256": report.baseline.protectionSHA256]]
    }
    static func managedInspect(executionV2: Bool = false) throws -> [String: Any] {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { throw Failure.invalid }
        let revision: String, clientSHA256: String, coreSHA256: String
        if executionV2 {
            let trust = try RelayTunExecutionInstallationV2.load()
            revision = trust.revision; clientSHA256 = trust.clientPin.sha256; coreSHA256 = trust.core.sha256
        } else {
            let trust = try RelayTunManagedInstallation.load()
            guard trust.clientUID == getuid() else { throw Failure.binding }
            revision = trust.revision; clientSHA256 = trust.clientPin.sha256; coreSHA256 = trust.coreSHA256
        }
        let time = Int64(Date().timeIntervalSince1970 * 1000)
        let report = try RelayTunEnvironmentInspector.report(owned: nil, sources: RelayTunEnvironmentInspector.live)
        let helper: [String: Any] = ["version": 1, "source": "native", "observedAt": time, "revision": revision,
            "state": "ready", "identity": "authenticated", "authorization": "approved", "rootOwned": true,
            "runningAsRoot": false, "clientUID": getuid(), "helperSHA256": clientSHA256,
            "coreSHA256": coreSHA256, "execution": "core-managed", "privilegedCoreVerified": true]
        let network: [String: Any] = ["version": 1, "source": "native", "observedAt": time, "state": "observed",
            "revision": report.baseline.networkSHA256, "routesSHA256": report.routesSHA256, "dnsSHA256": report.dnsSHA256,
            "interfacesSHA256": report.interfacesSHA256, "proxySHA256": report.proxySHA256,
            "protectionSHA256": report.baseline.protectionSHA256, "existingTunnel": report.existingTunnel ? "present" : "none",
            "recovery": "available"]
        return ["helper": helper, "network": network, "baseline": ["networkSHA256": report.baseline.networkSHA256,
            "protectionSHA256": report.baseline.protectionSHA256]]
    }
}
