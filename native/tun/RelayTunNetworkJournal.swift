import Foundation

/// A bounded recovery codec and injected compare-and-swap persistence contract.
/// There is deliberately no live filesystem, root, Mach or networking adapter.
/// A confirmed commit means only that this journal record was durably retained;
/// it is never evidence that a route, resolver or interface has been restored.
enum RelayTunNetworkJournal {
    private typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case invalid, blocked }
    enum Phase: String {
        case createIntent = "create_intent", acquired, installIntent = "install_intent", installed, active
        case removeIntent = "remove_intent", removed, closeIntent = "close_intent", restored, closedExternalChange = "closed_external_change"
        case retireDeviceIntent = "retire_device_intent"
        case acquisitionAborted = "acquisition_aborted"
    }
    struct Binding: Equatable {
        let installationRevision: String
        let clientUID: UInt32
        let planID: String
        let configurationSHA256: String
        let runtimeConfigurationSHA256: String
        // This is the approved projection digest. Realized device/effect bytes
        // have their separate digest after automatic interface assignment.
        let effectsSHA256: String
        let networkSHA256: String
        let protectionSHA256: String
        let createdAt: UInt64
        let expiresAt: UInt64
        let routeRemovalPolicy: RelayTunNetworkTransaction.RouteRemovalPolicy
        init(installationRevision: String, clientUID: UInt32, plan: RelayTunNetworkTransaction.Plan) throws {
            guard Effects.digest(installationRevision), clientUID > 0, Effects.uuid(plan.id),
                  [plan.configurationSHA256, plan.runtimeConfigurationSHA256, plan.effectsSHA256, plan.baseline.networkSHA256, plan.baseline.protectionSHA256].allSatisfy(Effects.digest),
                  plan.createdAt <= UInt64.max - 60_000, plan.expiresAt == plan.createdAt + 60_000 else { throw Failure.invalid }
            self.installationRevision = installationRevision; self.clientUID = clientUID; planID = plan.id
            configurationSHA256 = plan.configurationSHA256; runtimeConfigurationSHA256 = plan.runtimeConfigurationSHA256; effectsSHA256 = plan.effectsSHA256
            networkSHA256 = plan.baseline.networkSHA256; protectionSHA256 = plan.baseline.protectionSHA256; createdAt = plan.createdAt; expiresAt = plan.expiresAt
            routeRemovalPolicy = plan.routeRemovalPolicy
        }
        var json: [String: Any] { ["installationRevision": installationRevision, "clientUID": clientUID, "planID": planID,
                                  "configurationSHA256": configurationSHA256, "runtimeConfigurationSHA256": runtimeConfigurationSHA256,
                                  "effectsSHA256": effectsSHA256, "networkSHA256": networkSHA256, "protectionSHA256": protectionSHA256,
                                  "createdAt": String(createdAt), "expiresAt": String(expiresAt), "routeRemovalPolicy": routeRemovalPolicy.rawValue] }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try Effects.object(raw, keys: ["installationRevision", "clientUID", "planID", "configurationSHA256", "runtimeConfigurationSHA256", "effectsSHA256", "networkSHA256", "protectionSHA256", "createdAt", "expiresAt", "routeRemovalPolicy"])
            guard let policy = RelayTunNetworkTransaction.RouteRemovalPolicy(rawValue: try Effects.text(item["routeRemovalPolicy"])) else { throw Failure.invalid }
            let plan = try RelayTunNetworkTransaction.Plan(id: Effects.text(item["planID"]), configurationSHA256: Effects.text(item["configurationSHA256"]),
                runtimeConfigurationSHA256: Effects.text(item["runtimeConfigurationSHA256"]), effectsSHA256: Effects.text(item["effectsSHA256"]),
                baseline: .init(networkSHA256: Effects.text(item["networkSHA256"]), protectionSHA256: Effects.text(item["protectionSHA256"])),
                createdAt: Effects.decimal(item["createdAt"]), expiresAt: Effects.decimal(item["expiresAt"]), routeRemovalPolicy: policy)
            return try .init(installationRevision: Effects.text(item["installationRevision"]), clientUID: Effects.uint(item["clientUID"], positive: true), plan: plan)
        }
    }
    struct Observation: Equatable {
        let networkSHA256: String
        let protectionSHA256: String
        // Must come from an independent positive observation in a future live
        // adapter, not merely from successfully closing the helper's own FD.
        let deviceAbsent: Bool
        init(networkSHA256: String, protectionSHA256: String, deviceAbsent: Bool) throws {
            guard Effects.digest(networkSHA256), Effects.digest(protectionSHA256) else { throw Failure.invalid }
            self.networkSHA256 = networkSHA256; self.protectionSHA256 = protectionSHA256; self.deviceAbsent = deviceAbsent
        }
        var json: [String: Any] { ["networkSHA256": networkSHA256, "protectionSHA256": protectionSHA256, "deviceAbsent": deviceAbsent] }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try Effects.object(raw, keys: ["networkSHA256", "protectionSHA256", "deviceAbsent"])
            guard let number = item["deviceAbsent"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw Failure.invalid }
            return try .init(networkSHA256: Effects.text(item["networkSHA256"]), protectionSHA256: Effects.text(item["protectionSHA256"]), deviceAbsent: number.boolValue)
        }
    }
    struct Snapshot: Equatable {
        let binding: Binding
        let sequence: UInt32
        let phase: Phase
        let realizedEffects: RelayTunNetworkEffects.EffectSet?
        let pendingIDs: [String]
        let observation: Observation?
        init(binding: Binding, sequence: UInt32, phase: Phase, realizedEffects: RelayTunNetworkEffects.EffectSet?, pendingIDs: [String], observation: Observation? = nil) throws {
            guard pendingIDs.count <= Effects.maximumEffects else { throw Failure.invalid }
            if phase == .createIntent {
                guard sequence == 0, realizedEffects == nil, pendingIDs.isEmpty, observation == nil else { throw Failure.invalid }
            } else if phase == .acquisitionAborted {
                guard sequence == 1, realizedEffects == nil, pendingIDs.isEmpty,
                      let observation, observation.deviceAbsent,
                      observation.networkSHA256 == binding.networkSHA256,
                      observation.protectionSHA256 == binding.protectionSHA256 else { throw Failure.invalid }
            } else {
                guard sequence > 0, let effects = realizedEffects, effects.planID == binding.planID else { throw Failure.invalid }
                let changes = try effects.changes(), ids = changes.map(\.id)
                guard pendingIDs == Array(ids.prefix(pendingIDs.count)), pendingIDs.count <= ids.count else { throw Failure.invalid }
                if binding.routeRemovalPolicy == .ownedDeviceRetirement {
                    let routeCount = changes.prefix { $0.kind == .route }.count
                    guard changes.dropFirst(routeCount).allSatisfy({ $0.kind == .resolver }), effects.effects.allSatisfy({
                        if case .route(let route) = $0 { return route.interface == effects.device.interface }; return true
                    }) else { throw Failure.invalid }
                }
                if phase == .retireDeviceIntent {
                    guard binding.routeRemovalPolicy == .ownedDeviceRetirement, !pendingIDs.isEmpty,
                          changes.prefix(pendingIDs.count).allSatisfy({ $0.kind == .route }) else { throw Failure.invalid }
                }
                if [.acquired, .closeIntent, .restored, .closedExternalChange].contains(phase) { guard pendingIDs.isEmpty else { throw Failure.invalid } }
                if [.installIntent, .installed, .removeIntent].contains(phase) { guard !pendingIDs.isEmpty else { throw Failure.invalid } }
                if phase == .active { guard pendingIDs == ids else { throw Failure.invalid } }
                if [.restored, .closedExternalChange].contains(phase) {
                    guard let observation, observation.deviceAbsent else { throw Failure.invalid }
                    let matches = observation.networkSHA256 == binding.networkSHA256 && observation.protectionSHA256 == binding.protectionSHA256
                    guard matches == (phase == .restored) else { throw Failure.invalid }
                } else { guard observation == nil else { throw Failure.invalid } }
            }
            self.binding = binding; self.sequence = sequence; self.phase = phase; self.realizedEffects = realizedEffects; self.pendingIDs = pendingIDs; self.observation = observation
        }
        var json: [String: Any] { get throws {
            ["version": 1, "role": "network-recovery-journal", "binding": binding.json, "sequence": sequence, "phase": phase.rawValue,
             "realizedEffects": realizedEffects.map { $0.json as Any } ?? NSNull(),
             "realizedEffectsSHA256": try realizedEffects.map { try $0.sha256 as Any } ?? NSNull(),
             "pendingIDs": pendingIDs, "observation": observation.map { $0.json as Any } ?? NSNull()]
        } }
        func encoded() throws -> Data { let data = try Effects.bytes(json); _ = try Self.decode(data); return data }
        static func decode(_ data: Data) throws -> Self {
            let item = try Effects.object(RelayTunStrictJSON.object(data, limit: Effects.maximumBytes), keys: ["version", "role", "binding", "sequence", "phase", "realizedEffects", "realizedEffectsSHA256", "pendingIDs", "observation"])
            guard RelayTunStrictJSON.integer(item["version"]) == 1, item["role"] as? String == "network-recovery-journal",
                  let phase = Phase(rawValue: try Effects.text(item["phase"])), let pending = item["pendingIDs"] as? [String], pending.count <= Effects.maximumEffects else { throw Failure.invalid }
            let effects = try item["realizedEffects"] is NSNull ? nil : Effects.EffectSet.parse(item["realizedEffects"])
            if let effects { guard try Effects.text(item["realizedEffectsSHA256"]) == effects.sha256 else { throw Failure.invalid } }
            else { guard item["realizedEffectsSHA256"] is NSNull else { throw Failure.invalid } }
            return try .init(binding: Binding.parse(item["binding"]), sequence: Effects.uint(item["sequence"]), phase: phase, realizedEffects: effects, pendingIDs: pending,
                             observation: item["observation"] is NSNull ? nil : Observation.parse(item["observation"]))
        }
        func follows(_ previous: Self?) -> Bool {
            guard let previous else { return phase == .createIntent && sequence == 0 }
            guard previous.binding == binding, previous.sequence < UInt32.max, sequence == previous.sequence + 1 else { return false }
            if previous.phase == .createIntent { return [.acquired, .acquisitionAborted].contains(phase) && pendingIDs.isEmpty }
            guard previous.realizedEffects == realizedEffects else { return false }
            switch phase {
            case .createIntent, .acquired, .acquisitionAborted: return false
            case .installIntent:
                return [.acquired, .installed].contains(previous.phase) && pendingIDs.count == previous.pendingIDs.count + 1 && Array(pendingIDs.dropLast()) == previous.pendingIDs
            case .installed: return previous.phase == .installIntent && pendingIDs == previous.pendingIDs
            case .active: return [.acquired, .installed].contains(previous.phase) && pendingIDs == previous.pendingIDs
            case .removeIntent:
                if binding.routeRemovalPolicy == .ownedDeviceRetirement,
                   let changes = try? realizedEffects?.changes(), changes[pendingIDs.count - 1].kind != .resolver { return false }
                return [.installIntent, .installed, .active, .removed, .removeIntent].contains(previous.phase) && !pendingIDs.isEmpty && pendingIDs == previous.pendingIDs
            case .removed:
                // An explicit caller re-observes the same key's absence before
                // retrying an uncertain acknowledgement. Identical scope may
                // be reaffirmed; no new effect can be removed by this edge.
                if previous.phase == .removed && pendingIDs == previous.pendingIDs { return true }
                if binding.routeRemovalPolicy == .ownedDeviceRetirement {
                    guard let changes = try? realizedEffects?.changes(), !previous.pendingIDs.isEmpty,
                          pendingIDs == Array(previous.pendingIDs.dropLast()) else { return false }
                    if changes[previous.pendingIDs.count - 1].kind == .route {
                        let routeCount = changes.prefix { $0.kind == .route }.count
                        return previous.phase == .retireDeviceIntent || (previous.phase == .removed && previous.pendingIDs.count < routeCount)
                    }
                }
                // If the pre-write observation was already absent, Transaction
                // legitimately records removed without a remove_intent write.
                return [.installIntent, .installed, .active, .removed, .removeIntent].contains(previous.phase) && !previous.pendingIDs.isEmpty && pendingIDs == Array(previous.pendingIDs.dropLast())
            case .closeIntent: return [.acquired, .removed, .active, .closeIntent].contains(previous.phase) && pendingIDs.isEmpty && previous.pendingIDs.isEmpty
            case .restored, .closedExternalChange: return previous.phase == .closeIntent && pendingIDs.isEmpty
            case .retireDeviceIntent:
                return [.installIntent, .installed, .active, .removed, .retireDeviceIntent].contains(previous.phase) && pendingIDs == previous.pendingIDs
            }
        }
    }
    struct Storage {
        /// The implementation must bound reads before allocation as well.
        let read: () throws -> Data?
        /// A future root adapter must atomically compare the exact revision AND
        /// protected inode/owner/link identity at its mutation boundary. It must
        /// never overwrite an unknown object or accept a caller-selected path.
        let compareExchange: (_ expectedRevision: String?, _ replacement: Data) throws -> Bool
        /// Success must cover the complete record and required parent metadata.
        let sync: () throws -> Void
    }
    final class Writer {
        enum State { case unopened, ready, conflict, uncertain }
        enum Commit: Equatable { case confirmed(String), conflict, uncertain }
        private let binding: Binding
        private let storage: Storage
        private let mutationLock = NSRecursiveLock()
        private var mutating = false
        private var currentState: State = .unopened
        private var confirmed: Snapshot?
        var state: State { mutationLock.lock(); defer { mutationLock.unlock() }; return currentState }
        var lastConfirmed: Snapshot? { mutationLock.lock(); defer { mutationLock.unlock() }; return confirmed }
        private var revision: String?
        // Persisting recovery data does not establish actual network restoration.
        let restorationVerified = false
        let actualTunAccepted = false
        init(binding: Binding, storage: Storage) { self.binding = binding; self.storage = storage }
        private func begin() throws {
            guard mutationLock.try() else { throw Failure.blocked }
            guard !mutating else { mutationLock.unlock(); throw Failure.blocked }; mutating = true
        }
        private func end() { mutating = false; mutationLock.unlock() }
        private func read() throws -> Data? {
            let value = try storage.read()
            guard value == nil || value!.count <= Effects.maximumBytes else { throw Failure.invalid }; return value
        }
        @discardableResult func open() throws -> Snapshot? {
            try begin(); defer { end() }
            guard currentState == .unopened else { throw Failure.blocked }
            do {
                let data = try read()
                let snapshot = try data.map(Snapshot.decode)
                guard snapshot == nil || snapshot!.binding == binding else { currentState = .conflict; throw Failure.invalid }
                revision = data.map(RelayTunHelperTrust.digest); confirmed = snapshot; currentState = .ready
                return snapshot
            } catch { if currentState != .conflict { currentState = .uncertain }; throw error }
        }
        func record(_ snapshot: Snapshot) throws -> Commit {
            try begin(); defer { end() }
            guard currentState == .ready else { throw Failure.blocked }
            guard snapshot.binding == binding, snapshot.follows(confirmed) else { throw Failure.invalid }
            let bytes = try snapshot.encoded(), desired = RelayTunHelperTrust.digest(bytes)
            do {
                let observed = try read().map(RelayTunHelperTrust.digest)
                guard observed == revision else { currentState = .conflict; return .conflict }
                guard try storage.compareExchange(revision, bytes) else { currentState = .conflict; return .conflict }
                try storage.sync()
                guard let retained = try read(), RelayTunHelperTrust.digest(retained) == desired,
                      try Snapshot.decode(retained) == snapshot else { currentState = .uncertain; return .uncertain }
                revision = desired; confirmed = snapshot; return .confirmed(desired)
            } catch { currentState = .uncertain; return .uncertain }
        }
    }
}
