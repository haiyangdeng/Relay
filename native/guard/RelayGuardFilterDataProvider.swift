import Darwin
import Foundation
import Network
@preconcurrency import NetworkExtension

/// Direct signed observations can arrive before the ES graph knows the actor.
/// Remember only that exact execution is protected, without granting a lease.
final class RelayGuardDirectAttribution: @unchecked Sendable {
    private let lock = NSLock()
    private let capacity: Int
    private var protected = Set<RelayGuardProcessGeneration>()

    init(capacity: Int = 65536) { self.capacity = capacity }

    func subject(for tokens: [Data], environment: RelayGuardAuditIdentityEnvironment = .live) -> RelayGuardSubject {
        let observations = tokens.map { token in
            (generation: RelayGuardProcessGeneration(token: token),
             subject: RelayGuardAuditIdentity.resolve(token, environment: environment, includeUnscopedCLI: false))
        }
        return lock.withLock {
            var deny = false
            for observation in observations {
                switch observation.subject {
                case .desktop, .desktopHelper:
                    guard let generation = observation.generation,
                          protected.contains(generation) || protected.count < capacity else {
                        deny = true; continue
                    }
                    protected.insert(generation)
                default:
                    if let generation = observation.generation, protected.contains(generation) { deny = true }
                }
            }
            return deny ? .unverifiedProtected : RelayGuardIdentityClassifier.combine(observations.map(\.subject))
        }
    }
}

/// Runtime source remains gated offline by the current release contract.
/// A future signed deployment must additionally pass full scope/OS admission.
final class RelayGuardFilterDataProvider: NEFilterDataProvider, @unchecked Sendable {
    static let offlineErrorDomain = "local.relay.network.guard.offline"
    private static let directAttribution = RelayGuardDirectAttribution()
    private let flowsLock = NSLock()
    private let lineage = RelayGuardLineageClient.shared
    private final class FlowRecord {
        let flow: NEFilterSocketFlow
        let generation: UInt64
        let owningRun: UUID
        let permits: [RelayGuardLineagePermit]
        let sourceEpoch: String?
        let sourceRevision: UInt64?
        let infrastructureToken: Data?
        var inboundDone = false, outboundDone = false
        init(flow: NEFilterSocketFlow, generation: UInt64, run: UUID, permits: [RelayGuardLineagePermit], health: RelayGuardLineageHealth) {
            self.flow = flow; self.generation = generation; self.owningRun = run; self.permits = permits
            sourceEpoch = health.epoch; sourceRevision = health.revision; infrastructureToken = nil
        }
        init(flow: NEFilterSocketFlow, generation: UInt64, run: UUID, infrastructureToken: Data) {
            self.flow = flow; self.generation = generation; self.owningRun = run; self.infrastructureToken = infrastructureToken
            permits = []; sourceEpoch = nil; sourceRevision = nil
        }
    }
    private final class PendingLookup: @unchecked Sendable {
        let flow: NEFilterSocketFlow
        let subject: RelayGuardSubject
        let tokens: [Data]
        let coreGeneration: UInt64
        let run: UUID
        init(flow: NEFilterSocketFlow, subject: RelayGuardSubject, tokens: [Data], coreGeneration: UInt64, run: UUID) {
            self.flow = flow; self.subject = subject; self.tokens = tokens
            self.coreGeneration = coreGeneration; self.run = run
        }
    }
    private final class StartReply: @unchecked Sendable {
        private let lock = NSLock()
        private var completion: ((Error?) -> Void)?
        init(_ completion: @escaping (Error?) -> Void) { self.completion = completion }
        func finish(_ error: Error?) { lock.lock(); let call = completion; completion = nil; lock.unlock(); call?(error) }
    }
    private var flows: [UUID: FlowRecord] = [:]
    private var pending: [UUID: PendingLookup] = [:]
    private var run: UUID?

    static var permitsProviderStart: Bool {
        RelayGuardManagementRelease.runtimeProtectionReady && RelayGuardManagementRelease.completeClientScopeReady
            && RelayGuardManagementRelease.publisherTeamID != nil
            && RelayGuardLineageRelease.runtimeMonitoringReady && RelayGuardLineageRelease.systemInstallationSupported
    }

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        guard Self.permitsProviderStart else {
            completionHandler(NSError(domain: Self.offlineErrorDomain, code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Relay 过滤器仍为离线构建；发布身份及完整保护范围未验收，拒绝启动。"
            ])); return
        }
        let currentRun = UUID(), completion = StartReply(completionHandler)
        let unavailable = NSError(domain: Self.offlineErrorDomain, code: 2)
        flowsLock.lock(); run = currentRun; flowsLock.unlock()
        // Independent observers: an ES update must never replace the existing
        // owned-Core revocation callback or clear its remote bind uncertainty.
        guard RelayGuardProviderSession.shared.beginProviderRun(currentRun,
            isLocallyCurrent: { [weak self] in self?.isLocallyCurrent(currentRun) == true },
            onRevoked: { [weak self] revocation in self?.dropProtectedFlows(revocation) }) else {
            retireRun(currentRun); completion.finish(unavailable); return
        }
        Task { [weak self] in
            guard let self else { completion.finish(unavailable); return }
            guard self.isCurrent(currentRun) else {
                self.retireRun(currentRun); completion.finish(unavailable); return
            }
            let observed = await self.lineage.startAndObserve(run: currentRun, isCurrentRun: { [weak self] in self?.isCurrent(currentRun) == true }, executionReadiness: { [weak self] in
                guard let self, self.isCurrent(currentRun),
                      let bound = RelayGuardProviderSession.shared.snapshot(providerRun: currentRun) else { return nil }
                return RelayGuardExecutionLease(providerRunID: currentRun.uuidString.lowercased(),
                    coreGeneration: bound.generation, coreInstanceID: bound.proof.instanceID,
                    configurationSHA256: bound.proof.configurationSHA256)
            }, onRevoked: { [weak self] in self?.dropStaleLineageFlows(run: currentRun) })
            guard self.isCurrent(currentRun), observed else {
                self.retireRun(currentRun); completion.finish(unavailable); return
            }
            self.apply(Self.makeSettings()) { [weak self] error in
                guard let self else { completion.finish(unavailable); return }
                guard error == nil, self.isCurrent(currentRun), self.lineage.available,
                      RelayGuardProviderSession.shared.setProviderReady(true, run: currentRun) else {
                    self.retireRun(currentRun); completion.finish(error ?? unavailable); return
                }
                completion.finish(nil)
            }
        }
    }
    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        retireRun()
        completionHandler()
    }

    private func retireRun(_ expected: UUID? = nil) {
        flowsLock.lock()
        guard let stoppingRun = run, expected == nil || expected == stoppingRun else {
            flowsLock.unlock(); return
        }
        run = nil
        let waiting = Array(pending.values); pending.removeAll()
        let stoppingFlows = flows.values.map { $0.flow }; flows.removeAll()
        flowsLock.unlock()
        lineage.stop(run: stoppingRun)
        RelayGuardProviderSession.shared.endProviderRun(stoppingRun)
        // Only retire the records captured by this stop. A subsequent start
        // may have already admitted its own records by the time we get here.
        for flow in stoppingFlows { update(flow, using: .drop(), for: .any) }
        // Only already claimed protected subjects enter the paused set. A
        // previously positive attribution remains restrictive after source loss.
        for item in waiting { resumeFlow(item.flow, with: NEFilterNewFlowVerdict.drop()) }
    }

    /// The current release never submits these settings to the system.
    /// Apple's wildcard rules and default action exclude loopback traffic, so
    /// both address families need explicit rules. Apple's endpoint objects
    /// normalize mapped IPv6 loopback to IPv4; kernel coverage is not validated.
    static func makeSettings() -> NEFilterSettings {
        let networks: [(String, Int)] = [
            ("127.0.0.0", 8),
            ("::1", 128)
        ]
        let rules = networks.map { host, prefix -> NEFilterRule in
            let network: NENetworkRule
            if #available(macOS 15.0, *) {
                network = NENetworkRule(remoteNetworkEndpoint: .hostPort(host: .init(host), port: .any),
                    remotePrefix: prefix, localNetworkEndpoint: nil, localPrefix: 0,
                    protocol: .any, direction: .any)
            } else {
                network = NENetworkRule(remoteNetwork: NWHostEndpoint(hostname: host, port: "0"),
                    remotePrefix: prefix, localNetwork: nil, localPrefix: 0,
                    protocol: .any, direction: .any)
            }
            return NEFilterRule(networkRule: network, action: .filterData)
        }
        return NEFilterSettings(rules: rules, defaultAction: .filterData)
    }

    static func isTCP(socketFamily: Int32, socketType: Int32, socketProtocol: Int32) -> Bool {
        (socketFamily == AF_INET || socketFamily == AF_INET6)
            && socketType == SOCK_STREAM && socketProtocol == IPPROTO_TCP
    }

    static func claimsNewFlow(_ subject: RelayGuardSubject, positiveLineage: Bool) -> Bool {
        positiveLineage || (subject != .other && subject != .unresolved)
    }

    private static func endpoint(_ flow: NEFilterSocketFlow) -> (host: String?, port: Int?) {
        if #available(macOS 15.0, *) {
            guard case let .hostPort(host, port)? = flow.remoteFlowEndpoint else { return (nil, nil) }
            return (String(describing: host), Int(port.rawValue))
        }
        guard let endpoint = flow.remoteEndpoint as? NWHostEndpoint else { return (nil, nil) }
        return (endpoint.hostname, Int(endpoint.port))
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        guard let socket = flow as? NEFilterSocketFlow else { return .drop() }
        // The fixed raw Core has no publisher Team. Its own upstream sockets
        // require a separate exact-process lease, not a Claude-child identity
        // or an exception for generic unsigned/Node processes.
        if let token = flow.sourceProcessAuditToken,
           let bound = RelayGuardProviderSession.shared.infrastructureSnapshot(token) {
            return authorizeInfrastructure(socket, token: token, bound: bound)
        }
        let appToken = flow.sourceAppAuditToken, processToken = flow.sourceProcessAuditToken
        let tokens = [appToken, appToken == processToken ? nil : processToken].compactMap { $0 }.filter { $0.count == 32 }
        let subject = Self.directAttribution.subject(for: tokens)
        // Missing identity alone cannot put an ordinary process under Claude
        // policy. Only a direct protected identity or a sticky positive ES
        // attribution may claim this flow. A missed Claude attribution is a
        // coverage gap, so this boundary does not authorize deployment.
        let positive = tokens.contains { lineage.attribution($0) != nil }
        if !Self.claimsNewFlow(subject, positiveLineage: positive) { return .allow() }
        if subject == .unverifiedProtected { return .drop() }
        flowsLock.lock(); let currentRun = run; flowsLock.unlock()
        guard let currentRun else { return .drop() }
        let item = PendingLookup(flow: socket, subject: subject, tokens: tokens,
            coreGeneration: RelayGuardProviderSession.shared.bindingGeneration(), run: currentRun)
        guard lineage.available, !tokens.isEmpty else { return .drop() }
        flowsLock.lock()
        guard run == item.run, pending.count < 4096, pending[flow.identifier] == nil else { flowsLock.unlock(); return .drop() }
        pending[flow.identifier] = item; flowsLock.unlock()
        Task { [weak self, item] in
            guard let self else { return }
            let found = await self.lineage.lookup(item.tokens)
            self.finishLookup(item, observations: found)
        }
        return .pause()
    }
    private func authorizeInfrastructure(_ flow: NEFilterSocketFlow, token: Data,
        bound: (proof: RelayGuardProxyProof, generation: UInt64)) -> NEFilterNewFlowVerdict {
        let tcp = Self.isTCP(socketFamily: flow.socketFamily, socketType: flow.socketType, socketProtocol: flow.socketProtocol)
        let udp = (flow.socketFamily == AF_INET || flow.socketFamily == AF_INET6)
            && flow.socketType == SOCK_DGRAM && flow.socketProtocol == IPPROTO_UDP
        // This same owned Core also serves its ordinary HTTP listener. The
        // client's separate protected policy still permits only 17890/17891;
        // restricting the Core server half to those ports would break other
        // clients of the ordinary listener. The exemption belongs only to the
        // exact current infrastructure process, never its responsible app or
        // children. It remains a filtered, continuously leased flow.
        guard flow.direction == .inbound || flow.direction == .outbound, tcp || udp else { return .drop() }
        flowsLock.lock(); let expectedRun = run; flowsLock.unlock()
        guard let expectedRun, isCurrent(expectedRun) else { return .drop() }
        let record = FlowRecord(flow: flow, generation: bound.generation, run: expectedRun, infrastructureToken: token)
        flowsLock.lock()
        guard run == expectedRun, flows.count < 4096, flows[flow.identifier] == nil else { flowsLock.unlock(); return .drop() }
        flows[flow.identifier] = record; flowsLock.unlock()
        guard current(record) else {
            flowsLock.lock(); if flows[flow.identifier] === record { flows.removeValue(forKey: flow.identifier) }; flowsLock.unlock()
            return .drop()
        }
        return Self.filteredVerdict()
    }
    private static func filteredVerdict() -> NEFilterNewFlowVerdict {
        let verdict = NEFilterNewFlowVerdict.filterDataVerdict(withFilterInbound: true, peekInboundBytes: 1,
            filterOutbound: true, peekOutboundBytes: 1)
        verdict.shouldReport = true
        return verdict
    }
    private func current(_ record: FlowRecord) -> Bool {
        guard isCurrent(record.owningRun) else { return false }
        if let token = record.infrastructureToken {
            return RelayGuardProviderSession.shared.infrastructureSnapshot(token, generation: record.generation) != nil
        }
        return RelayGuardProviderSession.shared.current(record.generation) && sourceCurrent(record) && isCurrent(record.owningRun)
    }
    private func isLocallyCurrent(_ expected: UUID) -> Bool {
        flowsLock.lock(); defer { flowsLock.unlock() }; return run == expected
    }
    private func isCurrent(_ expected: UUID) -> Bool {
        isLocallyCurrent(expected) && RelayGuardProviderSession.shared.isProviderRun(expected)
    }
    private func finishLookup(_ item: PendingLookup, observations: [RelayGuardLineageAttribution?]) {
        flowsLock.lock()
        let owned = pending[item.flow.identifier] === item
        if owned { pending.removeValue(forKey: item.flow.identifier) }
        let active = run == item.run
        flowsLock.unlock()
        guard owned else { return } // stop already resumed this exact lookup
        let verdict = active ? authorize(item, observations: observations) : .drop()
        resumeFlow(item.flow, with: verdict)
        // Revocation between insertion and resume cannot authorize bytes: both
        // chunk and completion callbacks independently recheck both leases.
    }
    private func authorize(_ item: PendingLookup, observations: [RelayGuardLineageAttribution?]) -> NEFilterNewFlowVerdict {
        let attributed = item.tokens.enumerated().compactMap { index, token in
            lineage.attribution(token) ?? (index < observations.count ? observations[index] : nil)
        }
        // A positive-but-invalidated entry is never converted into `other`.
        guard !attributed.contains(where: { $0.permit == nil }) else { return .drop() }
        let subject = RelayGuardIdentityClassifier.combine([item.subject] + attributed.map { $0.subject })
        // Admission to the paused set claimed the flow. A missing reply or
        // attribution must never return that flow to ordinary traffic.
        guard subject != .other else { return .drop() }
        let permits = attributed.compactMap { $0.permit }
        guard let health = lineage.health, lineage.available, permits.allSatisfy(lineage.current),
              let bound = RelayGuardProviderSession.shared.snapshot(), bound.generation == item.coreGeneration else { return .drop() }
        let remote = Self.endpoint(item.flow)
        let candidate = RelayGuardFlow(subject: subject, outbound: item.flow.direction == .outbound,
            tcp: Self.isTCP(socketFamily: item.flow.socketFamily, socketType: item.flow.socketType,
                socketProtocol: item.flow.socketProtocol), host: remote.host, port: remote.port)
        let endpoints = Set(bound.proof.ports.map { RelayGuardEndpoint(host: "127.0.0.1", port: $0) })
        guard RelayGuardPolicy(approvedProxyEndpoints: endpoints).decide(candidate) == .allow else { return .drop() }
        let record = FlowRecord(flow: item.flow, generation: bound.generation, run: item.run, permits: permits, health: health)
        flowsLock.lock()
        guard run == item.run, flows.count < 4096, flows[item.flow.identifier] == nil else { flowsLock.unlock(); return .drop() }
        flows[item.flow.identifier] = record; flowsLock.unlock()
        guard current(record) else {
            flowsLock.lock(); if flows[item.flow.identifier] === record { flows.removeValue(forKey: item.flow.identifier) }; flowsLock.unlock()
            return .drop()
        }
        // Reports also retire abnormal/RST closures, without payload logging.
        return Self.filteredVerdict()
    }
    private func sourceCurrent(_ record: FlowRecord) -> Bool {
        if record.infrastructureToken != nil { return true }
        guard lineage.available, let health = lineage.health,
              health.epoch == record.sourceEpoch, health.revision == record.sourceRevision else { return false }
        return record.permits.allSatisfy(lineage.current)
    }
    override func handleInboundData(from flow: NEFilterFlow, readBytesStartOffset offset: Int, readBytes: Data) -> NEFilterDataVerdict {
        dataVerdict(flow, count: readBytes.count)
    }
    override func handleOutboundData(from flow: NEFilterFlow, readBytesStartOffset offset: Int, readBytes: Data) -> NEFilterDataVerdict {
        dataVerdict(flow, count: readBytes.count)
    }
    private func dataVerdict(_ flow: NEFilterFlow, count: Int) -> NEFilterDataVerdict {
        flowsLock.lock(); let record = flows[flow.identifier]; flowsLock.unlock()
        guard let record, current(record) else { return .drop() }
        return NEFilterDataVerdict(passBytes: count, peekBytes: 1)
    }
    override func handleInboundDataComplete(for flow: NEFilterFlow) -> NEFilterDataVerdict { complete(flow, inbound: true) }
    override func handleOutboundDataComplete(for flow: NEFilterFlow) -> NEFilterDataVerdict { complete(flow, inbound: false) }
    private func complete(_ flow: NEFilterFlow, inbound: Bool) -> NEFilterDataVerdict {
        flowsLock.lock()
        guard let record = flows[flow.identifier] else { flowsLock.unlock(); return .drop() }
        if inbound { record.inboundDone = true } else { record.outboundDone = true }
        let done = record.inboundDone && record.outboundDone
        if done { flows.removeValue(forKey: flow.identifier) }
        flowsLock.unlock()
        guard current(record) else { return .drop() }
        return done ? .allow() : NEFilterDataVerdict(passBytes: 0, peekBytes: 1)
    }
    override func handle(_ report: NEFilterReport) {
        guard report.event == .flowClosed, let flow = report.flow else { return }
        // Read only the kernel flow ID/event, never report payload/statistics.
        flowsLock.lock(); flows.removeValue(forKey: flow.identifier); flowsLock.unlock()
    }
    private func dropStaleLineageFlows(run expected: UUID) {
        flowsLock.lock(); let observed = flows.values.filter { $0.owningRun == expected }; flowsLock.unlock()
        let stale = observed.filter { !isCurrent(expected) || !sourceCurrent($0) }
        var removed: [NEFilterSocketFlow] = []
        flowsLock.lock()
        for record in stale where flows[record.flow.identifier] === record {
            flows.removeValue(forKey: record.flow.identifier); removed.append(record.flow)
        }
        flowsLock.unlock()
        for flow in removed { update(flow, using: .drop(), for: .any) }
    }
    private func dropProtectedFlows(_ revocation: RelayGuardProviderSession.Revocation) {
        flowsLock.lock()
        let retiring = flows.values.filter {
            revocation.retires(run: $0.owningRun, generation: $0.generation)
        }.map { $0.flow }
        for flow in retiring { flows.removeValue(forKey: flow.identifier) }
        flowsLock.unlock()
        for flow in retiring { update(flow, using: .drop(), for: .any) }
    }
}
