import Foundation
import Darwin

/// Installs one absent route through a positively held utun. The only mutation
/// is RTM_ADD; route recovery retires the owned device and then independently
/// observes this key absent. No route DELETE/CHANGE or value-CAS is provided.
/// Caller authentication, approved projection and durable storage are supplied
/// by the owning executor; constructing this adapter performs no OS operation.
final class RelayTunRouteAdapter {
    private typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case invalid, permission, busy, state, conflict, uncertain, system(Int32), exhausted }
    enum Phase: String { case idle, installed, conflict, uncertain, retired }
    enum RecordPhase: String { case intent, confirmed }
    struct Event {
        let phase: RecordPhase
        let retiring: Bool
        let planID: String
        let device: RelayTunNetworkEffects.DeviceIdentity
        let route: RelayTunNetworkEffects.Route
        let observedSHA256: String
    }
    struct Status {
        let phase: Phase
        let potentiallyApplied: Bool
        let routeAbsentVerified: Bool
        let failure: Failure?
        let actualTunAccepted = false
        let networkRestorationVerified = false
    }
    struct Driver {
        let authorized: () -> Bool
        let read: (RelayTunNetworkEffects.Address.Family) throws -> Data
        let resolveInterface: (UInt32) throws -> RelayTunNetworkEffects.Interface
        /// Exactly one request. The transport must call beforeWrite directly
        /// before its write; it must never retry a short/failed mutation write.
        let add: (_ request: Data, _ beforeWrite: () throws -> Void) throws -> Data
        let pid: Int32
        let sequence: () throws -> Int32
    }
    let planID: String
    let device: RelayTunNetworkEffects.DeviceIdentity
    let route: RelayTunNetworkEffects.Route
    private let interfaceType: UInt8
    private let driver: Driver
    private let verifyDevice: (RelayTunNetworkEffects.DeviceIdentity) throws -> Void
    private let deviceAbsent: (RelayTunNetworkEffects.DeviceIdentity) throws -> Bool
    private let record: (Event) throws -> Void
    private let desiredSHA256: String
    private let lock = NSRecursiveLock()
    private let statusLock = NSLock()
    private var mutating = false, potentiallyApplied = false
    private var phase: Phase = .idle
    private var failure: Failure?
    private var published = Status(phase: .idle, potentiallyApplied: false, routeAbsentVerified: false, failure: nil)

    init(planID: String, device: RelayTunNetworkEffects.DeviceIdentity, route: RelayTunNetworkEffects.Route,
         interfaceType: UInt8, driver: Driver,
         verifyDevice: @escaping (RelayTunNetworkEffects.DeviceIdentity) throws -> Void,
         deviceAbsent: @escaping (RelayTunNetworkEffects.DeviceIdentity) throws -> Bool,
         record: @escaping (Event) throws -> Void) throws {
        guard route.interface == device.interface, device.interface.index <= UInt16.max,
              interfaceType > 0, driver.pid > 0 else { throw Failure.invalid }
        let effects = try Effects.EffectSet(planID: planID, device: device, effects: [.route(route)])
        // Apply the codec's full supported-subset validation before any driver
        // callback. A malformed route never reaches observation or transport.
        _ = try RelayTunRouteProjection.request(route, operation: .add, pid: driver.pid, sequence: 1, interfaceType: interfaceType)
        self.planID = planID; self.device = device; self.route = route; self.interfaceType = interfaceType
        self.driver = driver; self.verifyDevice = verifyDevice; self.deviceAbsent = deviceAbsent; self.record = record
        desiredSHA256 = try effects.changes()[0].desiredSHA256
    }
    static func live(planID: String, device: RelayTunNetworkEffects.DeviceIdentity, route: RelayTunNetworkEffects.Route,
                     interfaceType: UInt8,
                     verifyDevice: @escaping (RelayTunNetworkEffects.DeviceIdentity) throws -> Void,
                     deviceAbsent: @escaping (RelayTunNetworkEffects.DeviceIdentity) throws -> Bool,
                     record: @escaping (Event) throws -> Void) throws -> RelayTunRouteAdapter {
        try Self(planID: planID, device: device, route: route, interfaceType: interfaceType, driver: liveDriver,
                 verifyDevice: verifyDevice, deviceAbsent: deviceAbsent, record: record)
    }
    var status: Status { statusLock.lock(); defer { statusLock.unlock() }; return published }
    private func publish() {
        let value = Status(phase: phase, potentiallyApplied: potentiallyApplied, routeAbsentVerified: phase == .retired, failure: failure)
        statusLock.lock(); published = value; statusLock.unlock()
    }
    private func begin() throws {
        guard lock.try() else { throw Failure.busy }
        guard !mutating else { lock.unlock(); throw Failure.busy }
        guard driver.authorized() else { lock.unlock(); throw Failure.permission }
        mutating = true
    }
    private func end() { mutating = false; publish(); lock.unlock() }
    private func inspect() throws -> RelayTunRouteObservation.Result {
        try RelayTunRouteObservation(read: driver.read, resolveInterface: driver.resolveInterface)
            .observe(destination: route.destination, scopeIndex: route.scopeIndex)
    }
    private func matching(_ message: RelayTunRouteProjection.Message) -> Bool {
        // XNU enriches an interface route with its MTU, selected address and
        // IPv4 protocol-cloning flag. Accept those observations only against
        // this already-held device, never as proof of device ownership.
        message.route == route && message.interfaceType == interfaceType &&
            (message.kernelMTU == 0 || message.kernelMTU == device.mtu) &&
            (message.interfaceAddress == nil || device.addresses.contains { $0.address == message.interfaceAddress }) &&
            (!message.kernelProtocolCloning || (route.gateway == nil &&
                route.destination.address.family == .ipv4 && route.destination.length < 32))
    }
    private func requireAbsent() throws {
        guard case .absent = try inspect() else { throw Failure.conflict }
    }
    private func requireDesired() throws {
        guard case .present(let value, _) = try inspect(), matching(value) else { throw Failure.uncertain }
    }
    private func failed(_ error: Error) -> Status {
        failure = error as? Failure ?? .uncertain
        if case .conflict? = failure { phase = .conflict } else { phase = .uncertain }
        publish(); return status
    }
    /// A value observation maps only this exact typed effect. It supplies no
    /// ownership, authorization or completed-restoration verdict.
    func observation() throws -> String {
        try begin(); defer { end() }
        switch try inspect() {
        case .absent: return RelayTunNetworkTransaction.absentSHA256
        case .present(let value, _):
            if matching(value) { return desiredSHA256 }
            return try Effects.hash(["version": 1, "kind": "unexpected-route-value", "deviceID": device.id,
                                     "route": value.route.json, "interfaceType": value.interfaceType])
        }
    }
    @discardableResult func install(expected: String) throws -> Status {
        try begin(); defer { end() }
        guard phase == .idle, expected == RelayTunNetworkTransaction.absentSHA256 else { throw Failure.state }
        do {
            try verifyDevice(device); try requireAbsent()
            try record(.init(phase: .intent, retiring: false, planID: planID, device: device, route: route, observedSHA256: expected))
            let sequence = try driver.sequence(); guard sequence > 0 else { throw Failure.invalid }
            let request = try RelayTunRouteProjection.request(route, operation: .add, pid: driver.pid,
                                                              sequence: sequence, interfaceType: interfaceType)
            try verifyDevice(device); try requireAbsent()
            potentiallyApplied = true; phase = .uncertain; publish()
            var boundaryCalled = false
            let bytes = try driver.add(request) {
                guard !boundaryCalled, driver.authorized() else { throw Failure.permission }
                boundaryCalled = true
                try verifyDevice(device); try requireAbsent()
            }
            guard boundaryCalled else { throw Failure.uncertain }
            let acknowledgement = try RelayTunRouteProjection.decode(bytes, resolveInterface: driver.resolveInterface)
            guard acknowledgement.operation == .add, acknowledgement.pid == driver.pid,
                  acknowledgement.sequence == sequence, acknowledgement.confirmed,
                  matching(acknowledgement) else { throw Failure.uncertain }
            try verifyDevice(device); try requireDesired()
            try record(.init(phase: .confirmed, retiring: false, planID: planID, device: device, route: route,
                             observedSHA256: desiredSHA256))
            try verifyDevice(device); try requireDesired()
            phase = .installed; failure = nil; publish(); return status
        } catch { return failed(error) }
    }
    /// Called only after the owning transaction has retired its actual device
    /// and all client FD copies. This method never performs a route mutation.
    @discardableResult func verifyRetired() throws -> Status {
        try begin(); defer { end() }
        guard phase != .idle, phase != .retired else { throw Failure.state }
        do {
            guard try deviceAbsent(device) else { throw Failure.uncertain }
            try requireAbsent()
            try record(.init(phase: .confirmed, retiring: true, planID: planID, device: device, route: route,
                             observedSHA256: RelayTunNetworkTransaction.absentSHA256))
            guard try deviceAbsent(device) else { throw Failure.uncertain }
            try requireAbsent()
            phase = .retired; failure = nil; potentiallyApplied = false; publish(); return status
        } catch { return failed(error) }
    }

    private static let sequenceLock = NSLock()
    private static var nextSequence: Int32 = 1
    private static var liveDriver: Driver {
        .init(authorized: { getuid() == 0 && geteuid() == 0 }, read: { try RelayTunRouteSnapshot.read(family: $0) },
              resolveInterface: { index in
            var name = [CChar](repeating: 0, count: Int(IFNAMSIZ))
            guard if_indextoname(index, &name) != nil else { throw Failure.system(errno) }
            return try .init(name: String(cString: name), index: index)
        }, add: exchange, pid: getpid(), sequence: {
            sequenceLock.lock(); defer { sequenceLock.unlock() }
            guard nextSequence < Int32.max else { throw Failure.exhausted }
            let value = nextSequence; nextSequence += 1; return value
        })
    }
    /// One private nonblocking AF_ROUTE socket, bounded ACK wait and no write
    /// retry. A short write, timeout, malformed/colliding reply or close failure
    /// remains uncertain; the caller must recover through its owned device.
    private static func exchange(_ request: Data, beforeWrite: () throws -> Void) throws -> Data {
        guard getuid() == 0 && geteuid() == 0 else { throw Failure.permission }
        guard request.count >= MemoryLayout<rt_msghdr>.size,
              request.count <= Int(RELAY_TUN_ROUTE_MAX_MESSAGE), request.startIndex == 0 else { throw Failure.invalid }
        var wanted = rt_msghdr()
        withUnsafeMutableBytes(of: &wanted) { $0.copyBytes(from: request.prefix($0.count)) }
        guard wanted.rtm_type == RTM_ADD, wanted.rtm_version == RTM_VERSION,
              wanted.rtm_msglen == request.count, wanted.rtm_pid == getpid(), wanted.rtm_seq > 0 else { throw Failure.invalid }
        let fd = socket(PF_ROUTE, SOCK_RAW, AF_UNSPEC)
        guard fd >= 0 else { throw Failure.system(errno) }
        var released = false
        defer { if !released { _ = Darwin.close(fd) } }
        guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 && fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else { throw Failure.system(errno) }
        try beforeWrite()
        let written = request.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        guard written == request.count else { throw Failure.uncertain }
        let start = DispatchTime.now().uptimeNanoseconds
        var buffer = [UInt8](repeating: 0, count: 65536)
        for _ in 0..<128 {
            let elapsed = (DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            guard elapsed < 1000 else { throw Failure.uncertain }
            var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&poller, 1, Int32(1000 - elapsed))
            if ready < 0 && errno == EINTR { continue }
            guard ready > 0, poller.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0 else { throw Failure.uncertain }
            let count = recv(fd, &buffer, buffer.count, MSG_TRUNC)
            if count < 0 && (errno == EAGAIN || errno == EINTR) { continue }
            guard count >= MemoryLayout<rt_msghdr>.size, count <= Int(RELAY_TUN_ROUTE_MAX_MESSAGE) else { throw Failure.uncertain }
            let response = Data(buffer.prefix(count)); var header = rt_msghdr()
            withUnsafeMutableBytes(of: &header) { $0.copyBytes(from: response.prefix($0.count)) }
            guard header.rtm_msglen == count else { throw Failure.uncertain }
            if header.rtm_pid != wanted.rtm_pid || header.rtm_seq != wanted.rtm_seq { continue }
            let closed = Darwin.close(fd); released = true
            guard closed == 0 else { throw Failure.uncertain }
            return response
        }
        throw Failure.uncertain
    }
}
