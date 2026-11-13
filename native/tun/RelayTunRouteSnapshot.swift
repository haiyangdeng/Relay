import Foundation
import Darwin

/// A bounded, read-only NET_RT_DUMP reader. Successful bytes are one completed
/// sysctl read, not an atomic/stable routing verdict or proof of route absence.
/// It never sends a route request, changes a sysctl, opens a socket or assumes
/// privilege, authorization, held-device identity or completed TUN acceptance.
enum RelayTunRouteSnapshot {
    enum Failure: Error, Equatable { case system(Int32), invalidLength, exhausted, changed }
    static let maximumBytes = 4 * 1024 * 1024
    static let maximumAttempts = 3
    private typealias Family = RelayTunNetworkEffects.Address.Family
    private struct Driver {
        let size: (Family) throws -> Int
        let fill: (Family, UnsafeMutableRawBufferPointer) throws -> Int
    }

    static func read(family: RelayTunNetworkEffects.Address.Family) throws -> Data {
        try load(family: family, driver: liveDriver)
    }
    private static func checkedSize(_ value: Int) throws {
        guard value >= 0 else { throw Failure.invalidLength }
        guard value <= maximumBytes else { throw Failure.exhausted }
    }
    private static func load(family: Family, driver: Driver) throws -> Data {
        for _ in 0..<maximumAttempts {
            do {
                let required = try driver.size(family)
                try checkedSize(required)
                var bytes = Data(count: required)
                // Even an initial zero requires a second phase. A routing table
                // which grew after sizing must not be published as empty.
                let returned = try bytes.withUnsafeMutableBytes { try driver.fill(family, $0) }
                try checkedSize(returned)
                guard returned <= required else { continue }
                bytes.removeSubrange(returned..<bytes.count)
                return bytes
            } catch Failure.system(ENOMEM) {
                // Discard the complete attempted buffer; the next attempt must
                // size again rather than reuse a potentially partial snapshot.
                continue
            }
        }
        throw Failure.changed
    }

    private static func query(family: Family, into buffer: UnsafeMutableRawBufferPointer?) throws -> Int {
        var mib: [Int32] = [CTL_NET, PF_ROUTE, 0, family == .ipv4 ? AF_INET : AF_INET6, NET_RT_DUMP, 0]
        var count = buffer?.count ?? 0
        apiCall()
        // This is the only production sysctl entry. Both newp and newlen are
        // permanently nil/zero; callers cannot supply another MIB or a value.
        let status = sysctl(&mib, UInt32(mib.count), buffer.flatMap { $0.count == 0 ? nil : $0.baseAddress }, &count, nil, 0)
        guard status == 0 else { throw Failure.system(errno) }
        return count
    }
    private static var liveDriver: Driver {
        .init(size: { try query(family: $0, into: nil) }, fill: { try query(family: $0, into: $1) })
    }
    private static func apiCall() {
        #if RELAY_TUN_ROUTE_SNAPSHOT_TESTS
        apiLock.lock(); apiCalls += 1; apiLock.unlock()
        #endif
    }
    #if RELAY_TUN_ROUTE_SNAPSHOT_TESTS
    struct TestDriver {
        let size: (RelayTunNetworkEffects.Address.Family) throws -> Int
        let fill: (RelayTunNetworkEffects.Address.Family, UnsafeMutableRawBufferPointer) throws -> Int
    }
    static func testRead(family: RelayTunNetworkEffects.Address.Family, driver: TestDriver) throws -> Data {
        try load(family: family, driver: .init(size: driver.size, fill: driver.fill))
    }
    private static let apiLock = NSLock()
    private static var apiCalls = 0
    static var liveAPICalls: Int { apiLock.lock(); defer { apiLock.unlock() }; return apiCalls }
    #endif
}
