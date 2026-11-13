import Foundation
import Darwin

/// Bridges the held C-device adapter to NetworkSession capabilities. The
/// mandatory recorder must durably retain every complete bound device event;
/// a failed/unknown creation remains in DeviceAdapter's original recovery owner.
/// Construction is inert. No helper, core, route or resolver is started here.
final class RelayTunDeviceLease {
    typealias Adapter = RelayTunDeviceAdapter
    private typealias Effects = RelayTunNetworkEffects
    typealias Transaction = RelayTunNetworkTransaction
    enum Failure: Error { case invalid, busy, state, uncertain, identity, system(Int32), exhausted }
    struct Configuration: Equatable {
        let device: String
        let mtu: UInt32
        let addresses: [RelayTunNetworkEffects.Prefix]
        let projectionSHA256: String
        init(device: String, mtu: UInt32, addresses: [RelayTunNetworkEffects.Prefix], projectionSHA256: String) throws {
            var unit: UInt32 = 0
            guard !device.utf8.contains(0), device.withCString({ relay_tun_device_parse_name($0, &unit, nil) }) == RELAY_TUN_DEVICE_OK,
                  relay_tun_device_validate_mtu(mtu, nil) == RELAY_TUN_DEVICE_OK,
                  addresses.count <= 16, Effects.digest(projectionSHA256),
                  Set(try addresses.map { try Effects.hash($0.json) }).count == addresses.count else { throw Failure.invalid }
            self.device = device; self.mtu = mtu; self.addresses = addresses; self.projectionSHA256 = projectionSHA256
        }
    }
    struct SocketIdentity: Equatable { let device: UInt64; let inode: UInt64 }
    struct Record {
        let plan: RelayTunNetworkTransaction.Plan
        let sequence: UInt32
        let event: RelayTunDeviceAdapter.Event
        private static func snapshot(_ value: Adapter.Snapshot?) -> Any {
            guard let value else { return NSNull() }
            return ["name": value.name, "index": value.index, "controlID": value.controlID,
                    "controlUnit": value.controlUnit, "mtu": value.mtu, "addressKeys": value.addressKeys]
        }
        func encoded() throws -> Data {
            guard Effects.uuid(plan.id), Effects.uuid(event.id),
                  [plan.configurationSHA256, plan.runtimeConfigurationSHA256, plan.effectsSHA256].allSatisfy(Effects.digest),
                  plan.expiresAt >= plan.createdAt,
                  [event.before, event.desired, event.observed].compactMap({ $0 }).allSatisfy(\.valid) else { throw Failure.invalid }
            let operation: [String: Any]
            switch event.operation {
            case .create(let name): operation = ["kind": "create", "requestedName": name]
            case .mtu(let mtu): operation = ["kind": "mtu", "value": mtu]
            case .address(let address): operation = ["kind": "address", "family": address.family == .ipv4 ? "ipv4" : "ipv6", "cidr": address.cidr, "key": address.key]
            case .duplicate: operation = ["kind": "duplicate"]
            case .close: operation = ["kind": "close"]
            case .verifyAbsent: operation = ["kind": "verifyAbsent"]
            }
            return try Effects.bytes(["version": 1, "role": "tun-device-event", "planID": plan.id,
                "configurationSHA256": plan.configurationSHA256, "runtimeConfigurationSHA256": plan.runtimeConfigurationSHA256,
                "effectsSHA256": plan.effectsSHA256, "createdAt": String(plan.createdAt), "expiresAt": String(plan.expiresAt),
                "sequence": sequence, "event": ["id": event.id, "operation": operation, "phase": event.phase.rawValue,
                    "before": Self.snapshot(event.before), "desired": Self.snapshot(event.desired), "observed": Self.snapshot(event.observed),
                    "ownsHandle": event.ownsHandle]])
        }
    }
    private final class Binding {
        let plan: Transaction.Plan
        let configuration: Configuration
        var sequence: UInt32 = 0
        var id: String?
        init(plan: Transaction.Plan, configuration: Configuration) { self.plan = plan; self.configuration = configuration }
    }
    private final class Recorder {
        let persist: (Record) throws -> Void
        let authorize: (Transaction.Plan, Configuration) throws -> Void
        var binding: Binding?
        init(persist: @escaping (Record) throws -> Void, authorize: @escaping (Transaction.Plan, Configuration) throws -> Void) {
            self.persist = persist; self.authorize = authorize
        }
        func record(_ event: Adapter.Event) throws {
            guard let binding, binding.sequence < UInt32.max else { throw Failure.exhausted }
            if let id = binding.id { guard event.id == id else { throw Failure.identity } }
            else {
                guard event.phase == .intent, case .create = event.operation else { throw Failure.state }
                binding.id = event.id
            }
            let activation: Bool
            switch event.operation { case .close, .verifyAbsent: activation = false; default: activation = true }
            if activation { try authorize(binding.plan, binding.configuration) }
            let record = Record(plan: binding.plan, sequence: binding.sequence, event: event)
            _ = try record.encoded() // invalid/incomplete recovery payload blocks the operation
            try persist(record)
            binding.sequence += 1
            // Persistence may block while the activation lease expires/revokes.
            if activation { try authorize(binding.plan, binding.configuration) }
        }
    }
    private final class Owner {
        let adapter: Adapter
        let id: String
        let snapshot: Adapter.Snapshot
        let identity: Effects.DeviceIdentity
        let observeSocket: (FileHandle) throws -> SocketIdentity
        private var file: FileHandle?
        private var closeUncertain = false
        private let lock = NSRecursiveLock()
        private var operating = false
        init(adapter: Adapter, id: String, snapshot: Adapter.Snapshot, identity: Effects.DeviceIdentity,
             file: FileHandle, observeSocket: @escaping (FileHandle) throws -> SocketIdentity) {
            self.adapter = adapter; self.id = id; self.snapshot = snapshot; self.identity = identity; self.file = file; self.observeSocket = observeSocket
        }
        private func begin() throws {
            guard lock.try() else { throw Failure.busy }
            guard !operating else { lock.unlock(); throw Failure.busy }; operating = true
        }
        private func end() { operating = false; lock.unlock() }
        var held: Bool {
            lock.lock(); defer { lock.unlock() }
            return file != nil && !closeUncertain && adapter.unresolved.contains { $0.id == id && $0.ownsHandle }
        }
        private func verifyHeld(_ supplied: Effects.DeviceIdentity) throws {
            guard supplied == identity, let file, !closeUncertain, try adapter.inspect(id) == snapshot,
                  try observeSocket(file) == SocketIdentity(device: identity.socketDevice, inode: identity.socketInode) else { throw Failure.identity }
        }
        func verify(_ supplied: Effects.DeviceIdentity) throws { try begin(); defer { end() }; try verifyHeld(supplied) }
        func duplicate() throws -> FileHandle {
            try begin(); defer { end() }
            try verifyHeld(identity)
            let duplicate = try adapter.duplicateForDelivery(id)
            do {
                guard try observeSocket(duplicate) == SocketIdentity(device: identity.socketDevice, inode: identity.socketInode) else { throw Failure.identity }
                try verifyHeld(identity); return duplicate
            } catch { try? duplicate.close(); throw error }
        }
        func close() throws -> Transaction.Outcome {
            try begin(); defer { end() }
            guard !closeUncertain else { return .uncertain }
            if let file {
                try verifyHeld(identity)
                // The original primary handle is still retained. Closing only
                // this private duplicate cannot retire the interface by itself.
                self.file = nil
                do { try file.close() } catch { closeUncertain = true; return .uncertain }
            }
            let result = try adapter.close(id)
            switch result.phase {
            case .closed: return .applied
            case .absent: return .unchanged
            case .uncertain:
                // A released integer with a failed close acknowledgement is
                // resolved only by fresh positive device absence, never retry.
                if !result.ownsHandle, try adapter.verifyAbsent(id).phase == .absent { return .applied }
                return .uncertain
            case .held: return .uncertain
            }
        }
        func absent() throws -> Bool {
            try begin(); defer { end() }
            guard file == nil, !closeUncertain, !adapter.unresolved.contains(where: { $0.id == id && $0.ownsHandle }) else { return false }
            return try adapter.verifyAbsent(id).phase == .absent
        }
    }

    private let recorder: Recorder
    private let adapter: Adapter
    private let observeSocket: (FileHandle) throws -> SocketIdentity
    /// Exact failed acquisition capability. It can only retire this lease's
    /// original adapter, and never adopts an interface, FD or caller identifier.
    /// A missing/unknown first device observation remains unverified.
    final class PartialAcquisition: RelayTunFailedAcquisition {
        let plan: Transaction.Plan
        private let adapter: Adapter
        private let id: String?
        init(plan: Transaction.Plan, adapter: Adapter) {
            self.plan = plan; self.adapter = adapter
            let entries = adapter.unresolved
            id = entries.count == 1 ? entries[0].id : nil
        }
        func restore() throws -> Bool {
            guard let id else { return adapter.unresolved.isEmpty }
            let closed = try adapter.close(id)
            guard !closed.ownsHandle else { return false }
            return try adapter.verifyAbsent(id).deviceAbsentVerified
        }
        func absent() throws -> Bool {
            guard let id else { return adapter.unresolved.isEmpty }
            return try adapter.verifyAbsent(id).deviceAbsentVerified
        }
    }
    private let verifyConfiguration: (Transaction.Plan, Configuration) throws -> Void
    private let operationLock = NSRecursiveLock()
    private var operating = false
    init(driver: RelayTunDeviceAdapter.Driver,
         observeSocket: @escaping (FileHandle) throws -> SocketIdentity,
         authorize: @escaping (RelayTunNetworkTransaction.Plan, Configuration) throws -> Void,
         verifyConfiguration: @escaping (RelayTunNetworkTransaction.Plan, Configuration) throws -> Void,
         record: @escaping (Record) throws -> Void) {
        let recorder = Recorder(persist: record, authorize: authorize)
        self.recorder = recorder; self.observeSocket = observeSocket; self.verifyConfiguration = verifyConfiguration
        adapter = Adapter(driver: driver, record: { try recorder.record($0) })
    }
    private init(authorize: @escaping (Transaction.Plan, Configuration) throws -> Void,
                 verifyConfiguration: @escaping (Transaction.Plan, Configuration) throws -> Void,
                 record: @escaping (Record) throws -> Void) {
        let recorder = Recorder(persist: record, authorize: authorize)
        self.recorder = recorder; self.observeSocket = Self.socketIdentity; self.verifyConfiguration = verifyConfiguration
        adapter = Adapter.live(record: { try recorder.record($0) })
    }
    static func live(authorize: @escaping (RelayTunNetworkTransaction.Plan, Configuration) throws -> Void,
                     verifyConfiguration: @escaping (RelayTunNetworkTransaction.Plan, Configuration) throws -> Void,
                     record: @escaping (Record) throws -> Void) -> RelayTunDeviceLease {
        Self(authorize: authorize, verifyConfiguration: verifyConfiguration, record: record)
    }
    var recoveryToken: RelayTunDeviceAdapter.RecoveryToken { adapter.recoveryToken }
    var unresolved: [RelayTunDeviceAdapter.Status] { adapter.unresolved }
    private static func socketIdentity(_ file: FileHandle) throws -> SocketIdentity {
        var value = stat()
        guard fstat(file.fileDescriptor, &value) == 0 else { throw Failure.system(errno) }
        guard value.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) else { throw Failure.identity }
        return .init(device: UInt64(truncatingIfNeeded: value.st_dev), inode: UInt64(value.st_ino))
    }
    private static func address(_ key: String) throws -> Effects.Prefix {
        let parts = key.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, ["4", "6"].contains(String(parts[0])) else { throw Failure.identity }
        let size = parts[0] == "4" ? 4 : 16
        func binary(_ value: Substring) throws -> [UInt8] {
            guard value.utf8.count == size * 2 else { throw Failure.identity }
            let digits = Array(value), pairs = stride(from: 0, to: digits.count, by: 2)
            return try pairs.map { offset in
                guard let byte = UInt8(String(digits[offset...offset + 1]), radix: 16) else { throw Failure.identity }; return byte
            }
        }
        let bytes = try binary(parts[1]), mask = try binary(parts[2])
        var count: UInt32 = 0, zero = false
        for byte in mask { for bit in (0..<8).reversed() {
            if byte & (1 << bit) == 0 { zero = true }
            else { guard !zero else { throw Failure.identity }; count += 1 }
        } }
        var output = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let family: Effects.Address.Family = size == 4 ? .ipv4 : .ipv6
        guard bytes.withUnsafeBytes({ inet_ntop(size == 4 ? AF_INET : AF_INET6, $0.baseAddress, &output, socklen_t(output.count)) }) != nil else { throw Failure.identity }
        return try .init(address: .init(family: family, value: String(cString: output)), length: count)
    }
    func acquire(_ plan: RelayTunNetworkTransaction.Plan, configuration: Configuration) throws -> RelayTunNetworkSession.Lease {
        guard operationLock.try() else { throw Failure.busy }
        guard !operating else { operationLock.unlock(); throw Failure.busy }
        operating = true; defer { operating = false; operationLock.unlock() }
        guard adapter.unresolved.isEmpty, plan.effectsSHA256 == configuration.projectionSHA256,
              plan.routeRemovalPolicy == .ownedDeviceRetirement else { throw Failure.state }
        do {
        // All requested values and their approved projection proof are checked
        // before the first create/configuration syscall or durable device event.
        try verifyConfiguration(plan, configuration)
        try recorder.authorize(plan, configuration)
        let addresses = try configuration.addresses.map { prefix in
            try Adapter.Address(prefix.address.value + "/" + String(prefix.length), family: prefix.address.family == .ipv4 ? .ipv4 : .ipv6)
        }
        recorder.binding = .init(plan: plan, configuration: configuration)
        var result = try adapter.create(requestedName: configuration.device)
        guard result.phase == .held, var snapshot = result.snapshot else { throw Failure.uncertain }
        if snapshot.mtu != configuration.mtu {
            result = try adapter.setMTU(result.id, to: configuration.mtu)
            guard result.phase == .held, let value = result.snapshot else { throw Failure.uncertain }; snapshot = value
        }
        for address in addresses where !snapshot.addressKeys.contains(address.key) {
            result = try adapter.addAddress(result.id, address)
            guard result.phase == .held, let value = result.snapshot else { throw Failure.uncertain }; snapshot = value
        }
        snapshot = try adapter.inspect(result.id)
        let observedAddresses = try snapshot.addressKeys.map(Self.address)
        guard observedAddresses.count <= 16 else { throw Failure.identity }
        let file = try adapter.duplicateForDelivery(result.id)
        do {
            let socket = try observeSocket(file)
            guard try adapter.inspect(result.id) == snapshot else { throw Failure.identity }
            let identity = try Effects.DeviceIdentity(id: result.id, interface: .init(name: snapshot.name, index: snapshot.index),
                controlID: snapshot.controlID, controlUnit: snapshot.controlUnit, socketDevice: socket.device, socketInode: socket.inode,
                mtu: snapshot.mtu, addresses: observedAddresses)
            let owner = Owner(adapter: adapter, id: result.id, snapshot: snapshot, identity: identity, file: file, observeSocket: observeSocket)
            return .init(identity: identity, held: { owner.held }, verify: { try owner.verify($0) }, duplicate: { try owner.duplicate() },
                         close: { try owner.close() }, absent: { try owner.absent() })
        } catch { try? file.close(); throw error }
        } catch { throw PartialAcquisition(plan: plan, adapter: adapter) }
    }
}
