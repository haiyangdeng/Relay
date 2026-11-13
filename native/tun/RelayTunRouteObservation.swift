import Foundation
import Darwin

/// Read-only snapshot selection over an injected complete route-dump reader.
/// Every frame must have a trustworthy key before absence can be returned.
/// An unsupported candidate, partial dump or duplicate is an error, never nil.
/// This type has no live reader, routing socket, mutation or recovery operation.
final class RelayTunRouteObservation {
    enum Failure: Error { case invalidQuery, invalidSnapshot, key(UInt32), ambiguous }
    struct Evidence {
        // Includes runtime counters and message metadata. This identifies the
        // evidence bytes, never the stable network baseline used for consent.
        let snapshotSHA256: String
        let frames: Int
        let bytes: Int
        // Completeness is relative to the trusted reader's returned snapshot,
        // not an assertion that the kernel cannot change after that observation.
        let actualTunAccepted = false
    }
    enum Result {
        case absent(Evidence)
        case present(RelayTunRouteProjection.Message, Evidence)
    }
    static let maximumBytes = 4 * 1024 * 1024
    static let maximumFrames = 32768
    private let read: (RelayTunNetworkEffects.Address.Family) throws -> Data
    private let resolveInterface: (UInt32) throws -> RelayTunNetworkEffects.Interface

    init(read: @escaping (RelayTunNetworkEffects.Address.Family) throws -> Data,
         resolveInterface: @escaping (UInt32) throws -> RelayTunNetworkEffects.Interface) {
        self.read = read; self.resolveInterface = resolveInterface
    }

    func observe(destination: RelayTunNetworkEffects.Prefix, scopeIndex: UInt32) throws -> Result {
        guard destination.address.networkAligned(prefix: destination.length), scopeIndex <= UInt16.max else { throw Failure.invalidQuery }
        let family = destination.address.family, af = family == .ipv4 ? AF_INET : AF_INET6
        var target = [UInt8](repeating: 0, count: 16)
        guard destination.address.value.withCString({ inet_pton(af, $0, &target) }) == 1 else { throw Failure.invalidQuery }
        // Apply the codec's destination restrictions to the query too. Without
        // this check an empty dump could declare an unrepresentable zone absent.
        // The placeholder index validates bytes only; it never identifies a device.
        var query = RelayTunRouteRecord()
        query.family = af; query.prefix = UInt8(destination.length)
        withUnsafeMutableBytes(of: &query.destination) { $0.copyBytes(from: target) }
        query.interface_index = scopeIndex == 0 ? 1 : scopeIndex
        query.scope_index = scopeIndex; query.flags = scopeIndex == 0 ? 0 : 0x01000000
        guard relay_tun_route_validate(&query) == RELAY_TUN_ROUTE_OK else { throw Failure.invalidQuery }
        let bytes = try read(family)
        guard bytes.count <= Self.maximumBytes, bytes.startIndex == 0 else { throw Failure.invalidSnapshot }
        var offset = 0, count = 0, candidate: Data?
        // Inspect the entire returned dump before projecting any matching value.
        // A malformed later record must invalidate an earlier matching record.
        while offset < bytes.count {
            guard bytes.count - offset >= MemoryLayout<rt_msghdr>.size, count < Self.maximumFrames else { throw Failure.invalidSnapshot }
            var length: UInt16 = 0
            withUnsafeMutableBytes(of: &length) { $0.copyBytes(from: bytes[offset..<(offset + 2)]) }
            let size = Int(length)
            guard size >= MemoryLayout<rt_msghdr>.size, size <= bytes.count - offset else { throw Failure.invalidSnapshot }
            let frame = bytes.subdata(in: offset..<(offset + size))
            var key = RelayTunRouteKey()
            let result = frame.withUnsafeBytes { relay_tun_route_key_decode($0.baseAddress, $0.count, &key) }
            guard result == RELAY_TUN_ROUTE_OK else { throw Failure.key(result.rawValue) }
            // A family-filtered reader returning another family cannot prove a
            // complete snapshot of the requested family; reject that contract.
            guard key.family == af else { throw Failure.invalidSnapshot }
            let addressMatches = withUnsafeBytes(of: key.destination) { Array($0) == target }
            // zone_index is retained by the key codec. Bucket every canonical
            // zone variant conservatively: a colliding zoned frame must reach
            // strict projection and refuse, rather than become false absence.
            if addressMatches && UInt32(key.prefix) == destination.length && key.scope_index == scopeIndex {
                guard candidate == nil else { throw Failure.ambiguous }
                candidate = frame
            }
            offset += size; count += 1
        }
        let evidence = Evidence(snapshotSHA256: RelayTunHelperTrust.digest(bytes), frames: count, bytes: bytes.count)
        guard let candidate else { return .absent(evidence) }
        return try .present(RelayTunRouteProjection.decode(candidate, resolveInterface: resolveInterface), evidence)
    }
}
