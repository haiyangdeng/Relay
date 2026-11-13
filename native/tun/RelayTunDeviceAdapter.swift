import Foundation
import Darwin

/// A held-device adapter, not an authorization or routing implementation. The
/// A process-lifetime registry retains unresolved owners even if their manager
/// releases its last reference. Recovery always uses the original object and
/// its gates, never an adopted name/PID/FD. No deinit network mutation exists.
/// The registry is not persistent crash recovery. Live construction is inert.
final class RelayTunDeviceAdapter {
    enum Failure: Error { case invalid, busy, unknownLease, permission, identity, uncertain, system(UInt32, UInt32, Int32, Bool) }
    enum Phase: String { case held, uncertain, closed, absent }
    enum Operation: Equatable { case create(String), mtu(UInt32), address(Address), duplicate, close, verifyAbsent }
    enum RecordPhase: String { case intent, confirmed, uncertain }
    struct Snapshot: Equatable {
        let name: String
        let index: UInt32
        let controlID: UInt32
        let controlUnit: UInt32
        let mtu: UInt32
        // Exact numeric address/mask bytes, including kernel-created addresses.
        // An unrecognized or changing inventory blocks a mutation.
        let addressKeys: [String]
        var valid: Bool {
            var unit: UInt32 = 0
            return !name.utf8.contains(0) && name.withCString { relay_tun_device_parse_name($0, &unit, nil) } == RELAY_TUN_DEVICE_OK &&
                unit > 0 && unit == controlUnit && index > 0 && controlID > 0 && mtu > 0 && mtu <= UInt32(Int32.max) &&
                addressKeys.count <= 256 && addressKeys == addressKeys.sorted() && Set(addressKeys).count == addressKeys.count &&
                addressKeys.allSatisfy(Self.validAddressKey)
        }
        func sameDevice(as other: Self) -> Bool {
            name == other.name && index == other.index && controlID == other.controlID && controlUnit == other.controlUnit
        }
        private static func validAddressKey(_ key: String) -> Bool {
            let pieces = key.split(separator: ":", omittingEmptySubsequences: false)
            guard pieces.count == 3, ["4", "6"].contains(String(pieces[0])) else { return false }
            let length = pieces[0] == "4" ? 8 : 32
            return pieces[1].count == length && pieces[2].count == length &&
                (pieces[1] + pieces[2]).allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
        }
        func replacing(mtu: UInt32? = nil, address: Address? = nil) -> Self {
            Self(name: name, index: index, controlID: controlID, controlUnit: controlUnit, mtu: mtu ?? self.mtu,
                 addressKeys: address.map { (addressKeys + [$0.key]).sorted() } ?? addressKeys)
        }
    }
    struct Address: Equatable {
        enum Family: Int32 { case ipv4 = 2, ipv6 = 30 }
        let family: Family
        let cidr: String
        let key: String
        fileprivate let prefix: RelayTunDevicePrefix
        init(_ cidr: String, family: Family) throws {
            guard !cidr.utf8.contains(0), cidr.utf8.count < 51 else { throw Failure.invalid }
            var prefix = RelayTunDevicePrefix()
            guard cidr.withCString({ relay_tun_device_parse_prefix($0, family.rawValue, &prefix, nil) }) == RELAY_TUN_DEVICE_OK else { throw Failure.invalid }
            self.family = family; self.cidr = cidr; self.prefix = prefix
            let count = family == .ipv4 ? 4 : 16
            key = "\(family == .ipv4 ? 4 : 6):" + withUnsafeBytes(of: prefix.address) { Self.hex($0.prefix(count)) } + ":" + withUnsafeBytes(of: prefix.mask) { Self.hex($0.prefix(count)) }
        }
        fileprivate static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 { bytes.map { String(format: "%02x", $0) }.joined() }
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.family == rhs.family && lhs.key == rhs.key }
    }
    struct Status {
        let id: String
        let phase: Phase
        let snapshot: Snapshot?
        let ownsHandle: Bool
        let deviceAbsentVerified: Bool
        let failure: Failure?
        let actualTunAccepted = false
        let networkRestorationVerified = false
    }
    struct View {
        // Leases are last confirmed observations while busy, not a verdict
        // about interface state partway through an external/kernel callback.
        let busy: Bool
        let unresolved: [Status]
    }
    /// Identity is an in-process capability, not a string accepted over IPC.
    /// Looking up a retained owner does not authorize any device operation.
    final class RecoveryToken {
        let id = UUID().uuidString.lowercased()
        fileprivate init() { }
    }
    struct RecoveryView {
        let token: RecoveryToken
        let view: View
    }
    private static let recoveryLock = NSLock()
    private static var recoveryOwners: [ObjectIdentifier: RelayTunDeviceAdapter] = [:]
    let recoveryToken = RecoveryToken()
    static var recoveryViews: [RecoveryView] {
        recoveryLock.lock(); let owners = Array(recoveryOwners.values); recoveryLock.unlock()
        return owners.map { RecoveryView(token: $0.recoveryToken, view: $0.view) }.sorted { $0.token.id < $1.token.id }
    }
    static func recover(_ token: RecoveryToken) -> RelayTunDeviceAdapter? {
        recoveryLock.lock(); defer { recoveryLock.unlock() }
        guard let owner = recoveryOwners[ObjectIdentifier(token)], owner.recoveryToken === token else { return nil }
        return owner
    }
    private func retainForRecovery() {
        Self.recoveryLock.lock(); Self.recoveryOwners[ObjectIdentifier(recoveryToken)] = self; Self.recoveryLock.unlock()
    }
    private func releaseRecoveryIfResolved() {
        // A released helper FD is insufficient: only a successful independent
        // absence acknowledgement may retire the owner and its recovery data.
        guard entries.values.allSatisfy({ $0.phase == .absent }) else { return }
        Self.recoveryLock.lock(); Self.recoveryOwners.removeValue(forKey: ObjectIdentifier(recoveryToken)); Self.recoveryLock.unlock()
    }
    struct Event {
        let id: String
        let operation: Operation
        let phase: RecordPhase
        let before: Snapshot?
        let desired: Snapshot?
        let observed: Snapshot?
        let ownsHandle: Bool
    }
    struct CloseResult { let released: Bool; let uncertain: Bool }
    /// A session carries closures over a driver's privately owned handle. The
    /// live driver never exposes its C pointer or accepts a caller's integer FD.
    struct Session {
        let hasHandle: () -> Bool
        let snapshot: () throws -> Snapshot
        let setMTU: (UInt32) throws -> Void
        let addAddress: (Address) throws -> Void
        let duplicate: () throws -> FileHandle
        let close: () throws -> CloseResult
    }
    struct Driver {
        let authorized: () -> Bool
        let create: (String) throws -> Session
        let absent: (Snapshot) throws -> Bool
    }
    private final class Entry {
        let id: String
        var session: Session?
        var phase: Phase = .uncertain
        var snapshot: Snapshot?
        var allowedAfterFailure: Snapshot?
        var failure: Failure?
        init(id: String) { self.id = id }
    }
    private let driver: Driver
    private let record: (Event) throws -> Void
    private var entries: [String: Entry] = [:]
    private let lock = NSRecursiveLock()
    private var mutating = false
    private let statusLock = NSLock()
    private var published = View(busy: false, unresolved: [])
    init(driver: Driver, record: @escaping (Event) throws -> Void) { self.driver = driver; self.record = record }
    static func live(record: @escaping (Event) throws -> Void) -> RelayTunDeviceAdapter { Self(driver: liveDriver, record: record) }
    private func begin() throws {
        guard lock.try() else { throw Failure.busy }
        guard !mutating else { lock.unlock(); throw Failure.busy }
        guard driver.authorized() else { lock.unlock(); throw Failure.permission }
        mutating = true; publish()
    }
    private func end() {
        withExtendedLifetime(self) {
            mutating = false; publish(); releaseRecoveryIfResolved(); lock.unlock()
        }
    }
    private func entry(_ id: String) throws -> Entry {
        guard let entry = entries[id] else { throw Failure.unknownLease }; return entry
    }
    private func status(_ entry: Entry) -> Status {
        Status(id: entry.id, phase: entry.phase, snapshot: entry.snapshot, ownsHandle: entry.session?.hasHandle() ?? false,
               deviceAbsentVerified: entry.phase == .absent, failure: entry.failure)
    }
    var view: View {
        statusLock.lock(); defer { statusLock.unlock() }; return published
    }
    var unresolved: [Status] { view.unresolved }
    private func publish() {
        let next = View(busy: mutating, unresolved: entries.values.filter { $0.phase != .absent }.map(status))
        statusLock.lock(); published = next; statusLock.unlock()
    }
    private func event(_ entry: Entry, _ operation: Operation, _ phase: RecordPhase, before: Snapshot? = nil, desired: Snapshot? = nil, observed: Snapshot? = nil) throws {
        publish()
        try record(Event(id: entry.id, operation: operation, phase: phase, before: before, desired: desired, observed: observed, ownsHandle: entry.session?.hasHandle() ?? false))
    }
    private func uncertain(_ entry: Entry, error: Error) -> Status {
        entry.phase = .uncertain; entry.failure = error as? Failure ?? .uncertain; return status(entry)
    }
    private func observed(_ entry: Entry, exact: Bool) throws -> Snapshot {
        guard let session = entry.session, session.hasHandle() else { throw Failure.uncertain }
        let value = try session.snapshot()
        guard value.valid else { throw Failure.identity }
        if let prior = entry.snapshot {
            guard value.sameDevice(as: prior), !exact || value == prior else { throw Failure.identity }
        }
        return value
    }
    /// Fresh read of this original held capability. This never adopts an
    /// interface by name, changes its configuration, or replaces the confirmed
    /// inventory with a changed value merely because the name still matches.
    func inspect(_ id: String) throws -> Snapshot {
        try begin(); defer { end() }
        let owned = try entry(id)
        guard owned.phase == .held else { throw Failure.uncertain }
        return try observed(owned, exact: true)
    }
    /// Once create is attempted this returns an owned/uncertain entry, including
    /// failed first observation or journal acknowledgement. It never throws away
    /// a returned C handle. Do not directly use an uncertain result as the
    /// Transaction.Environment.create success value.
    func create(requestedName: String) throws -> Status {
        try begin(); defer { end() }
        var unit: UInt32 = 0
        guard !requestedName.utf8.contains(0), requestedName.withCString({ relay_tun_device_parse_name($0, &unit, nil) }) == RELAY_TUN_DEVICE_OK,
              entries.values.allSatisfy({ $0.phase == .absent }) else { throw Failure.invalid }
        let owned = Entry(id: UUID().uuidString.lowercased())
        try event(owned, .create(requestedName), .intent)
        entries = [owned.id: owned]
        retainForRecovery()
        do {
            owned.session = try driver.create(requestedName)
            guard owned.session?.hasHandle() == true else { throw Failure.identity }
            publish()
            let value = try observed(owned, exact: false)
            guard requestedName == "utun" || value.name == requestedName else { throw Failure.identity }
            owned.snapshot = value
            try event(owned, .create(requestedName), .confirmed, observed: value)
            owned.phase = .held
            return status(owned)
        } catch { return uncertain(owned, error: error) }
    }
    private func configure(_ id: String, operation: Operation, desired: (Snapshot) throws -> Snapshot, apply: (Session) throws -> Void) throws -> Status {
        try begin(); defer { end() }
        let owned = try entry(id)
        guard owned.phase == .held, let session = owned.session else { throw Failure.uncertain }
        do {
            let before = try observed(owned, exact: true), target = try desired(before)
            guard target.valid else { throw Failure.invalid }
            try event(owned, operation, .intent, before: before, desired: target)
            owned.allowedAfterFailure = target
            guard try observed(owned, exact: true) == before else { throw Failure.identity }
            try apply(session)
            let after = try observed(owned, exact: false)
            guard after == target else { throw Failure.identity }
            try event(owned, operation, .confirmed, before: before, desired: target, observed: after)
            owned.snapshot = after; owned.allowedAfterFailure = nil
            return status(owned)
        } catch { return uncertain(owned, error: error) }
    }
    func setMTU(_ id: String, to mtu: UInt32) throws -> Status {
        guard relay_tun_device_validate_mtu(mtu, nil) == RELAY_TUN_DEVICE_OK else { throw Failure.invalid }
        return try configure(id, operation: .mtu(mtu), desired: { $0.replacing(mtu: mtu) }, apply: { try $0.setMTU(mtu) })
    }
    func addAddress(_ id: String, _ address: Address) throws -> Status {
        try configure(id, operation: .address(address), desired: {
            guard !$0.addressKeys.contains(address.key) else { throw Failure.invalid }; return $0.replacing(address: address)
        }, apply: { try $0.addAddress(address) })
    }
    func duplicateForDelivery(_ id: String) throws -> FileHandle {
        try begin(); defer { end() }
        let owned = try entry(id)
        guard owned.phase == .held, let session = owned.session else { throw Failure.uncertain }
        do {
            let before = try observed(owned, exact: true)
            try event(owned, .duplicate, .intent, before: before)
            guard try observed(owned, exact: true) == before else { throw Failure.identity }
            let file = try session.duplicate()
            do {
                guard try observed(owned, exact: true) == before else { throw Failure.identity }
                try event(owned, .duplicate, .confirmed, before: before, observed: before)
                return file
            } catch { try? file.close(); throw error }
        } catch { _ = uncertain(owned, error: error); throw error }
    }
    func close(_ id: String) throws -> Status {
        try begin(); defer { end() }
        let owned = try entry(id)
        guard let session = owned.session, session.hasHandle() else { return status(owned) }
        do {
            // If an earlier mutation lost acknowledgement, only its known before
            // or desired inventory may be retired. Foreign edits are retained.
            let before = try observed(owned, exact: false)
            guard owned.snapshot == nil || before == owned.snapshot || before == owned.allowedAfterFailure else { throw Failure.identity }
            try event(owned, .close, .intent, before: before)
            guard try observed(owned, exact: false) == before else { throw Failure.identity }
            let result = try session.close()
            guard result.released == !session.hasHandle(), result.released else { throw Failure.uncertain }
            owned.snapshot = before
            owned.phase = result.uncertain ? .uncertain : .closed
            try event(owned, .close, result.uncertain ? .uncertain : .confirmed, before: before)
            return status(owned)
        } catch { return uncertain(owned, error: error) }
    }
    func verifyAbsent(_ id: String) throws -> Status {
        try begin(); defer { end() }
        let owned = try entry(id)
        guard owned.session?.hasHandle() == false, let identity = owned.snapshot else { throw Failure.uncertain }
        do {
            guard try driver.absent(identity) else { throw Failure.uncertain }
            try event(owned, .verifyAbsent, .confirmed, before: identity)
            owned.phase = .absent; owned.failure = nil
            return status(owned)
        } catch { return uncertain(owned, error: error) }
    }

    private final class LiveOwner {
        var pointer: OpaquePointer?
        init(_ pointer: OpaquePointer) { self.pointer = pointer }
    }
    private static func root() throws { guard getuid() == 0, geteuid() == 0 else { throw Failure.permission } }
    private static func checked(_ code: RelayTunDeviceCode, _ error: RelayTunDeviceError) throws {
        guard code == RELAY_TUN_DEVICE_OK else { throw Failure.system(code.rawValue, error.stage.rawValue, error.system_error, error.network_may_have_changed) }
    }
    // Darwin may truncate netmask sockaddrs after the last significant byte.
    // Copy only the reported bytes and zero-fill the remaining address bytes.
    static func netmaskBytes(_ bytes: UnsafeRawBufferPointer, family: Int32) throws -> [UInt8] {
        let offset: Int, count: Int, maximum: Int
        switch family {
        case AF_INET: offset = 4; count = 4; maximum = MemoryLayout<sockaddr_in>.size
        case AF_INET6: offset = 8; count = 16; maximum = MemoryLayout<sockaddr_in6>.size
        default: throw Failure.identity
        }
        guard bytes.count >= 2, bytes.count <= maximum, Int(bytes[0]) == bytes.count,
              Int32(bytes[1]) == family else { throw Failure.identity }
        var result = [UInt8](repeating: 0, count: count)
        let available = max(0, min(count, bytes.count - offset))
        if available > 0 {
            for index in 0..<available { result[index] = bytes[offset + index] }
        }
        return result
    }
    private static func liveSnapshot(_ owner: LiveOwner) throws -> Snapshot {
        try root()
        guard let pointer = owner.pointer else { throw Failure.uncertain }
        func basic() throws -> RelayTunDeviceSnapshot {
            var value = RelayTunDeviceSnapshot(), error = RelayTunDeviceError()
            try checked(relay_tun_device_snapshot(pointer, &value, &error), error)
            return value
        }
        let value = try basic()
        let name = withUnsafeBytes(of: value.name) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        var addresses: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addresses) == 0 else { throw Failure.identity }
        defer { freeifaddrs(addresses) }
        var cursor = addresses, keys: [String] = []
        while let node = cursor {
            defer { cursor = node.pointee.ifa_next }
            guard let rawName = node.pointee.ifa_name, String(cString: rawName) == name,
                  let address = node.pointee.ifa_addr else { continue }
            let family = Int32(address.pointee.sa_family)
            guard [AF_INET, AF_INET6].contains(family) else { continue }
            guard let mask = node.pointee.ifa_netmask else { throw Failure.identity }
            let count = family == AF_INET ? 4 : 16
            let rawMask = UnsafeRawPointer(mask), maskLength = Int(rawMask.load(as: UInt8.self))
            let maskBytes = try netmaskBytes(UnsafeRawBufferPointer(start: rawMask, count: maskLength), family: family)
            let addressBytes: [UInt8]
            if family == AF_INET {
                guard Int(address.pointee.sa_len) >= MemoryLayout<sockaddr_in>.size else { throw Failure.identity }
                var numeric = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
                addressBytes = withUnsafeBytes(of: &numeric) { Array($0.prefix(count)) }
            } else {
                guard Int(address.pointee.sa_len) >= MemoryLayout<sockaddr_in6>.size else { throw Failure.identity }
                var numeric = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_addr
                addressBytes = withUnsafeBytes(of: &numeric) { Array($0.prefix(count)) }
            }
            keys.append("\(family == AF_INET ? 4 : 6):" + Address.hex(addressBytes) + ":" + Address.hex(maskBytes))
        }
        let after = try basic()
        guard value.interface_index == after.interface_index, value.control_id == after.control_id,
              value.control_unit == after.control_unit, value.mtu == after.mtu else { throw Failure.identity }
        let snapshot = Snapshot(name: name, index: value.interface_index, controlID: value.control_id, controlUnit: value.control_unit, mtu: value.mtu, addressKeys: keys.sorted())
        guard snapshot.valid else { throw Failure.identity }; return snapshot
    }
    private static var liveDriver: Driver {
        Driver(authorized: { getuid() == 0 && geteuid() == 0 }, create: { requested in
            try root()
            var pointer: OpaquePointer?, error = RelayTunDeviceError()
            let code = requested.withCString { relay_tun_device_create($0, &pointer, &error) }
            try checked(code, error)
            guard let pointer else { throw Failure.identity }
            let owner = LiveOwner(pointer)
            return Session(hasHandle: { owner.pointer != nil }, snapshot: { try liveSnapshot(owner) }, setMTU: { mtu in
                try root(); var error = RelayTunDeviceError(); try checked(relay_tun_device_set_mtu(owner.pointer, mtu, &error), error)
            }, addAddress: { address in
                try root(); var prefix = address.prefix, error = RelayTunDeviceError()
                let code = address.family == .ipv4 ? relay_tun_device_add_ipv4(owner.pointer, &prefix, &error) : relay_tun_device_add_ipv6(owner.pointer, &prefix, &error)
                try checked(code, error)
            }, duplicate: {
                try root(); var descriptor: Int32 = -1, error = RelayTunDeviceError()
                try checked(relay_tun_device_duplicate_fd(owner.pointer, &descriptor, &error), error)
                guard descriptor >= 0 else { throw Failure.identity }
                return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            }, close: {
                try root(); var error = RelayTunDeviceError()
                let code = relay_tun_device_close(&owner.pointer, &error)
                if owner.pointer != nil { try checked(code, error); throw Failure.uncertain }
                return CloseResult(released: true, uncertain: code != RELAY_TUN_DEVICE_OK)
            })
        }, absent: { identity in
            try root()
            var addresses: UnsafeMutablePointer<ifaddrs>?
            guard identity.valid, getifaddrs(&addresses) == 0 else { throw Failure.identity }
            defer { freeifaddrs(addresses) }
            var cursor = addresses
            while let node = cursor {
                defer { cursor = node.pointee.ifa_next }
                if let name = node.pointee.ifa_name, String(cString: name) == identity.name { return false }
                if let address = node.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_LINK), Int(address.pointee.sa_len) >= MemoryLayout<sockaddr_dl>.size,
                   UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_dl.self).pointee.sdl_index == identity.index { return false }
            }
            errno = 0
            let index = identity.name.withCString { if_nametoindex($0) }
            return index == 0 && [ENXIO, ENODEV].contains(errno)
        })
    }
}
