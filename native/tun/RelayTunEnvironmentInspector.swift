import Foundation
import SystemConfiguration
import Darwin

/// Strict read-only host baseline inspector. It digests real interface,
/// route, DNS and system-proxy state into the two consent baselines used by
/// the transaction journal. With an owned identity it excludes exactly that
/// interface, its routes and this service's own resolver keys; every other
/// change remains visible. It never opens a socket, mutates state, reads a
/// caller-selected path or claims an observation it could not complete.
enum RelayTunEnvironmentInspector {
    enum Failure: Error { case partial, invalid, oversized }
    typealias Effects = RelayTunNetworkEffects
    typealias Transaction = RelayTunNetworkTransaction
    /// Only this service may hide its own resolver/proxy keys from a baseline.
    static let ownedServicePrefix = "State:/Network/Service/local.relay.network.tun."

    struct AddressObservation: Equatable {
        let family: String
        let value: String
        let prefix: UInt32
        var json: [String: Any] { ["family": family, "value": value, "prefix": prefix] }
    }
    struct InterfaceObservation: Equatable {
        let name: String
        let index: UInt32
        let type: UInt8
        let flags: UInt32
        let mtu: UInt32
        let addresses: [AddressObservation]
        var json: [String: Any] { ["name": name, "index": index, "type": type, "flags": flags,
                                   "mtu": mtu, "addresses": addresses.map(\.json)] }
    }
    struct RouteObservation: Equatable {
        let family: String
        let destination: String
        let prefix: UInt32
        let gateway: String
        let gatewayKind: String
        let interfaceName: String
        let interfaceIndex: UInt32
        let scopeIndex: UInt32
        let flags: UInt32
        var json: [String: Any] { ["family": family, "destination": destination, "prefix": prefix,
                                   "gateway": gateway, "gatewayKind": gatewayKind, "interface": interfaceName,
                                   "interfaceIndex": interfaceIndex, "scopeIndex": scopeIndex, "flags": flags] }
    }
    private struct CacheKey: Hashable {
        let family: String
        let destination: String
        let scopeIndex: UInt32
        init(_ route: RouteObservation) { family = route.family; destination = route.destination; scopeIndex = route.scopeIndex }
    }
    private struct CachePath: Hashable {
        let interfaceName: String
        let interfaceIndex: UInt32
        let gatewayKind: String
        let gateway: String
        init(_ route: RouteObservation) {
            interfaceName = route.interfaceName; interfaceIndex = route.interfaceIndex
            gatewayKind = route.gatewayKind; gateway = route.gateway
        }
    }
    /// Deterministic, replaceable sources. Live values are read-only and work
    /// at any UID; failures fail the whole baseline instead of guessing.
    struct Sources {
        let interfaces: () throws -> [InterfaceObservation]
        let routes: (Effects.Address.Family) throws -> Data
        let dns: () throws -> [(String, Any)]
        let proxies: () throws -> [(String, Any)]
    }

    static func baseline(owned: Effects.DeviceIdentity?, sources: Sources) throws -> Transaction.Baseline {
        try report(owned: owned, sources: sources).baseline
    }
    struct Report {
        let baseline: Transaction.Baseline
        let interfacesSHA256: String
        let routesSHA256: String
        let dnsSHA256: String
        let proxySHA256: String
        let existingTunnel: Bool
    }
    /// One normalized capture also supplies the App's individual evidence
    /// digests. Hashing raw dumps would include changing neighbor/timer state.
    static func report(owned: Effects.DeviceIdentity?, sources: Sources) throws -> Report {
        let interfaces = try sources.interfaces().filter { interface in
            guard let owned else { return true }
            return !(interface.name == owned.interface.name && interface.index == owned.interface.index)
        }.sorted { $0.name == $1.name ? $0.index < $1.index : $0.name < $1.name }
        let routes = try routeObservations(sources: sources, owned: owned)
        let dns = try canonicalEntries(try sources.dns(), owned: owned)
        let proxies = try canonicalEntries(try sources.proxies(), owned: owned)
        let network: [String: Any] = ["version": 1, "interfaces": interfaces.map(\.json),
                                      "routes": routes.map(\.json), "dns": dns]
        let protection: [String: Any] = ["version": 1, "proxies": proxies]
        return .init(baseline: .init(networkSHA256: RelayTunHelperTrust.digest(try Effects.bytes(network)),
                     protectionSHA256: RelayTunHelperTrust.digest(try Effects.bytes(protection))),
                     interfacesSHA256: try Effects.hash(interfaces.map(\.json)),
                     routesSHA256: try Effects.hash(routes.map(\.json)), dnsSHA256: try Effects.hash(dns),
                     proxySHA256: try Effects.hash(proxies),
                     existingTunnel: routes.contains { $0.interfaceName.hasPrefix("utun") &&
                         $0.scopeIndex == 0 && $0.prefix <= 1 })
    }

    private static func routeObservations(sources: Sources, owned: Effects.DeviceIdentity?) throws -> [RouteObservation] {
        var result: [RouteObservation] = []
        for family in [Effects.Address.Family.ipv4, .ipv6] {
            let bytes = try sources.routes(family)
            guard bytes.count <= RelayTunRouteObservation.maximumBytes else { throw Failure.oversized }
            var offset = 0, frames = 0
            while offset < bytes.count {
                let frame = try parseFrame(bytes, offset: &offset, count: &frames, family: family)
                var header = rt_msghdr()
                withUnsafeMutableBytes(of: &header) { $0.copyBytes(from: frame.prefix($0.count)) }
                guard header.rtm_errno == 0 else { throw Failure.partial }
                let flags = UInt32(bitPattern: header.rtm_flags)
                // Neighbor/link-layer cache entries are not network configuration.
                if flags & UInt32(RTF_LLINFO) != 0 { continue }
                let index = UInt32(header.rtm_index)
                if let owned, index == owned.interface.index { continue }
                var key = RelayTunRouteKey()
                let code = frame.withUnsafeBytes { relay_tun_route_key_decode($0.baseAddress, $0.count, &key) }
                guard code == RELAY_TUN_ROUTE_OK, key.family == (family == .ipv4 ? AF_INET : AF_INET6) else { throw Failure.partial }
                let destinationBytes = withUnsafeBytes(of: key.destination) { Array($0) }
                let destination = try text(family: family, bytes: destinationBytes, zone: 0)
                let gateway = try gateway(of: frame, header: header)
                let name = interfaceName(index: index)
                result.append(.init(family: family.rawValue, destination: destination, prefix: UInt32(key.prefix),
                    gateway: gateway.value, gatewayKind: gateway.kind, interfaceName: name ?? "index-\(index)",
                    interfaceIndex: index, scopeIndex: key.scope_index, flags: flags))
            }
        }
        // Darwin creates and expires scoped /32 forwarding-cache children as
        // connections are used. A child is redundant only when the complete
        // longest-prefix parent decision positively covers its exact path.
        // Unknown flags, redirects and conflicting/missing parents stay visible.
        var parents: [RouteObservation] = [], paths: [CacheKey: Set<CachePath>] = [:]
        for row in result {
            if observedIPv4HostCache(row) { paths[CacheKey(row), default: []].insert(CachePath(row)) }
            else { parents.append(row) }
        }
        let conflicts = Set(paths.filter { $0.value.count > 1 }.map(\.key))
        let ipv4Normalized = result.filter { !redundantIPv4Clone($0, parents: parents, conflicts: conflicts) }
        return normalizeIPv6Cache(ipv4Normalized).sorted(by: routeLess)
    }

    private static func routeLess(_ lhs: RouteObservation, _ rhs: RouteObservation) -> Bool {
        if lhs.family != rhs.family { return lhs.family < rhs.family }
        if lhs.destination != rhs.destination { return lhs.destination < rhs.destination }
        if lhs.prefix != rhs.prefix { return lhs.prefix < rhs.prefix }
        if lhs.scopeIndex != rhs.scopeIndex { return lhs.scopeIndex < rhs.scopeIndex }
        if lhs.interfaceName != rhs.interfaceName { return lhs.interfaceName < rhs.interfaceName }
        if lhs.interfaceIndex != rhs.interfaceIndex { return lhs.interfaceIndex < rhs.interfaceIndex }
        if lhs.gatewayKind != rhs.gatewayKind { return lhs.gatewayKind < rhs.gatewayKind }
        if lhs.gateway != rhs.gateway { return lhs.gateway < rhs.gateway }
        return lhs.flags < rhs.flags
    }

    private static func ipv4Number(_ text: String) -> UInt32? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var number: UInt32 = 0
        for part in parts {
            guard let byte = UInt8(part), String(byte) == part else { return nil }
            number = (number << 8) | UInt32(byte)
        }
        return number
    }

    private static func observedIPv4HostCache(_ child: RouteObservation) -> Bool {
        let required = UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_WASCLONED | RTF_IFSCOPE)
        let allowed = required | UInt32(RTF_IFREF | RTF_GLOBAL | RTF_PROTO3)
        guard child.family == Effects.Address.Family.ipv4.rawValue, child.prefix == 32,
              child.flags & required == required, child.flags & ~allowed == 0,
              child.interfaceIndex > 0, child.scopeIndex == child.interfaceIndex,
              !child.interfaceName.hasPrefix("index-"),
              child.gatewayKind == "ip", ipv4Number(child.gateway) != nil,
              ipv4Number(child.destination) != nil else { return false }
        return true
    }

    private static func redundantIPv4Clone(_ child: RouteObservation, parents: [RouteObservation], conflicts: Set<CacheKey>) -> Bool {
        guard observedIPv4HostCache(child), !conflicts.contains(CacheKey(child)),
              let destination = ipv4Number(child.destination) else { return false }
        let applicable = parents.filter { parent in
            guard parent.family == child.family, parent.prefix <= 32,
                  parent.scopeIndex == 0 || parent.scopeIndex == child.scopeIndex,
                  let network = ipv4Number(parent.destination) else { return false }
            let mask: UInt32 = parent.prefix == 0 ? 0 : UInt32.max << (32 - parent.prefix)
            return destination & mask == network & mask
        }
        let scopes = Dictionary(grouping: applicable, by: \.scopeIndex)
        guard !scopes.isEmpty else { return false }
        let parentRequired = UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)
        let parentAllowed = parentRequired | UInt32(RTF_CLONING | RTF_PRCLONING | RTF_IFSCOPE | RTF_GLOBAL)
        // Scoped and unscoped lookup priorities are not one combined longest
        // prefix search. Every available scope must independently agree on the
        // exact path, so kernel preference/fallback cannot change the verdict.
        return scopes.values.allSatisfy { candidates in
            guard let longest = candidates.map(\.prefix).max(), longest < 32 else { return false }
            return candidates.filter { $0.prefix == longest }.allSatisfy { parent in
                parent.flags & parentRequired == parentRequired && parent.flags & ~parentAllowed == 0 &&
                    parent.interfaceName == child.interfaceName && parent.interfaceIndex == child.interfaceIndex &&
                    parent.gatewayKind == child.gatewayKind && parent.gateway == child.gateway
            }
        }
    }
    private static func ipv6Bytes(_ text: String) -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard text.withCString({ pointer in bytes.withUnsafeMutableBytes {
            inet_pton(AF_INET6, pointer, $0.baseAddress)
        } }) == 1, ipv6Text(bytes, scope: 0) == text else { return nil }
        return bytes
    }
    private static func validIPv6Gateway(_ text: String, interfaceIndex: UInt32) -> Bool {
        let parts = text.split(separator: "%", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2, let bytes = ipv6Bytes(String(parts[0])) else { return false }
        if parts.count == 2 {
            guard let zone = UInt32(parts[1]), zone == interfaceIndex, String(zone) == parts[1] else { return false }
        }
        // Darwin may encode a link-local zone in bytes 2...3 instead of the
        // sockaddr scope field. Preserve the original gateway string in path
        // equality, and never cover a cache whose zone names another interface.
        if bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80 {
            let embedded = UInt32(bytes[2]) << 8 | UInt32(bytes[3])
            if embedded != 0 && embedded != interfaceIndex { return false }
        }
        return true
    }
    private static func observedIPv6HostCache(_ child: RouteObservation) -> Bool {
        let required = UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_WASCLONED | RTF_IFSCOPE)
        let allowed = required | UInt32(RTF_IFREF | RTF_GLOBAL | RTF_PROTO3)
        return child.family == Effects.Address.Family.ipv6.rawValue && child.prefix == 128 &&
            child.flags & required == required && child.flags & ~allowed == 0 &&
            child.interfaceIndex > 0 && child.scopeIndex == child.interfaceIndex &&
            !child.interfaceName.hasPrefix("index-") && child.gatewayKind == "ip" &&
            ipv6Bytes(child.destination) != nil && validIPv6Gateway(child.gateway, interfaceIndex: child.interfaceIndex)
    }
    private static func normalizeIPv6Cache(_ rows: [RouteObservation]) -> [RouteObservation] {
        var parents: [RouteObservation] = [], paths: [CacheKey: Set<CachePath>] = [:]
        for row in rows {
            if observedIPv6HostCache(row) { paths[CacheKey(row), default: []].insert(CachePath(row)) }
            else { parents.append(row) }
        }
        let conflicts = Set(paths.filter { $0.value.count > 1 }.map(\.key))
        return rows.filter { !redundantIPv6Clone($0, parents: parents, conflicts: conflicts) }
    }
    private static func redundantIPv6Clone(_ child: RouteObservation, parents: [RouteObservation], conflicts: Set<CacheKey>) -> Bool {
        guard observedIPv6HostCache(child), !conflicts.contains(CacheKey(child)),
              let destination = ipv6Bytes(child.destination) else { return false }
        let applicable = parents.filter { parent in
            guard parent.family == child.family, parent.prefix <= 128,
                  parent.scopeIndex == 0 || parent.scopeIndex == child.scopeIndex,
                  let network = ipv6Bytes(parent.destination) else { return false }
            let wholeBytes = Int(parent.prefix / 8), remainingBits = Int(parent.prefix % 8)
            guard destination.prefix(wholeBytes) == network.prefix(wholeBytes) else { return false }
            if remainingBits == 0 { return true }
            let mask = UInt8.max << (8 - remainingBits)
            return destination[wholeBytes] & mask == network[wholeBytes] & mask
        }
        let scopes = Dictionary(grouping: applicable, by: \.scopeIndex)
        guard !scopes.isEmpty else { return false }
        // Observed IPv6 RA defaults lack STATIC. PRCLONING positively identifies
        // their cache-parent role; no redirect, unknown flag or competing path
        // may be hidden. The IPv4 STATIC proof above remains unchanged.
        let required = UInt32(RTF_UP | RTF_GATEWAY | RTF_PRCLONING)
        let allowed = required | UInt32(RTF_STATIC | RTF_CLONING | RTF_IFSCOPE | RTF_GLOBAL)
        return scopes.values.allSatisfy { candidates in
            guard let longest = candidates.map(\.prefix).max(), longest < 128 else { return false }
            return candidates.filter { $0.prefix == longest }.allSatisfy { parent in
                parent.flags & required == required && parent.flags & ~allowed == 0 &&
                    parent.interfaceName == child.interfaceName && parent.interfaceIndex == child.interfaceIndex &&
                    parent.gatewayKind == child.gatewayKind && parent.gateway == child.gateway
            }
        }
    }
    #if RELAY_TUN_INSPECTOR_TESTS
    static func testRouteLess(_ lhs: RouteObservation, _ rhs: RouteObservation) -> Bool { routeLess(lhs, rhs) }
    static func testNormalizeIPv6Cache(_ rows: [RouteObservation]) -> [RouteObservation] { normalizeIPv6Cache(rows) }
    #endif
    /// Bounds-checked frame scan shared with the observer's contract: a
    /// malformed later record invalidates earlier ones.
    private static func parseFrame(_ bytes: Data, offset: inout Int, count: inout Int,
                                   family: Effects.Address.Family) throws -> Data {
        guard bytes.count - offset >= MemoryLayout<rt_msghdr>.size, count < RelayTunRouteObservation.maximumFrames else { throw Failure.partial }
        var length: UInt16 = 0
        withUnsafeMutableBytes(of: &length) { $0.copyBytes(from: bytes[offset..<(offset + 2)]) }
        let size = Int(length)
        guard size >= MemoryLayout<rt_msghdr>.size, size <= bytes.count - offset else { throw Failure.partial }
        let frame = bytes.subdata(in: offset..<(offset + size))
        offset += size; count += 1
        return frame
    }
    /// Walk RTA sockaddrs after rt_msghdr and canonicalize RTA_GATEWAY.
    /// AF_LINK gateways bind to the interface identity, never a MAC address.
    private static func gateway(of frame: Data, header: rt_msghdr) throws -> (kind: String, value: String) {
        var cursor = MemoryLayout<rt_msghdr>.size
        var bit = 1
        while bit <= RTA_BRD {
            defer { bit <<= 1 }
            guard header.rtm_addrs & Int32(bit) != 0 else { continue }
            // Slot bounds use 2 bytes (sa_len + sa_family): BSD netmask
            // sockaddrs are shorter than struct sockaddr and must not fail.
            guard cursor + 2 <= frame.count else { throw Failure.partial }
            let length = Int(frame.withUnsafeBytes { $0.load(fromByteOffset: cursor, as: sockaddr.self).sa_len })
            guard length >= 2, cursor + length <= frame.count else { throw Failure.partial }
            let family = Int32(frame.withUnsafeBytes { $0.load(fromByteOffset: cursor, as: sockaddr.self).sa_family })
            defer { cursor += length }
            guard bit == RTA_GATEWAY else { continue }
            switch family {
            case 0:
                // AF_UNSPEC gateway slot (e.g. an interface route request):
                // there is no gateway to bind into the baseline.
                return ("none", "")
            case AF_INET:
                guard length >= 8 else { throw Failure.partial }
                var bytes = [UInt8](repeating: 0, count: 4)
                bytes.withUnsafeMutableBytes { $0.copyBytes(from: frame[(cursor + 4)..<(cursor + 8)]) }
                return ("ip", ipv4Text(bytes))
            case AF_INET6:
                guard length >= 28 else { throw Failure.partial }
                var raw = [UInt8](repeating: 0, count: 16)
                raw.withUnsafeMutableBytes { $0.copyBytes(from: frame[(cursor + 8)..<(cursor + 24)]) }
                var scope: UInt32 = 0
                withUnsafeMutableBytes(of: &scope) { $0.copyBytes(from: frame[(cursor + 24)..<(cursor + 28)]) }
                return ("ip", ipv6Text(raw, scope: scope))
            case AF_LINK:
                guard length >= 4 else { throw Failure.partial }
                var index: UInt16 = 0
                withUnsafeMutableBytes(of: &index) { $0.copyBytes(from: frame[(cursor + 2)..<(cursor + 4)]) }
                return ("link", "link#\(index)")
            default:
                throw Failure.partial
            }
        }
        return ("none", "")
    }
    private static func text(family: Effects.Address.Family, bytes: [UInt8], zone: UInt32) throws -> String {
        switch family {
        case .ipv4: return ipv4Text(Array(bytes.prefix(4)))
        case .ipv6: return ipv6Text(bytes, scope: zone)
        }
    }
    static func ipv4Text(_ bytes: [UInt8]) -> String {
        bytes.prefix(4).map(String.init).joined(separator: ".")
    }
    static func ipv6Text(_ bytes: [UInt8], scope: UInt32) -> String {
        var output = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let value = bytes.withUnsafeBytes { inet_ntop(AF_INET6, $0.baseAddress, &output, socklen_t(output.count)) }
        let text = value.map { String(cString: $0) } ?? String(repeating: "0", count: 4)
        return scope == 0 ? text : text + "%" + String(scope)
    }
    static func interfaceName(index: UInt32) -> String? {
        var name = [CChar](repeating: 0, count: Int(IFNAMSIZ))
        guard if_indextoname(index, &name) != nil else { return nil }
        return String(cString: name)
    }
    /// Property-list values become deterministic JSON. Unknown types, oversized
    /// payloads and unreadable keys fail the baseline; nothing is silently dropped.
    private static func canonicalEntries(_ entries: [(String, Any)], owned: Effects.DeviceIdentity?) throws -> [[String: Any]] {
        var result: [[String: Any]] = []
        for (key, value) in entries where !(owned != nil && key.hasPrefix(Self.ownedServicePrefix)) {
            result.append(["key": key, "value": try canonical(value)])
        }
        return result.sorted { $0["key"] as? String ?? "" < $1["key"] as? String ?? "" }
    }
    static func canonical(_ value: Any) throws -> Any {
        switch value {
        case let object as [String: Any]:
            var result: [String: Any] = [:]
            for (key, child) in object { result[key] = try canonical(child) }
            return result
        case let array as [Any]: return try array.map(canonical)
        case let string as String: return string
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
            return number
        case let data as Data: return ["data": data.base64EncodedString()]
        case is NSNull: return NSNull()
        default: throw Failure.invalid
        }
    }

    /// Live read-only sources. Every read works at an ordinary UID; partial
    /// or unsupported state throws instead of fabricating a baseline.
    static var live: Sources {
        .init(interfaces: { try liveInterfaces() }, routes: { try RelayTunRouteSnapshot.read(family: $0) },
              dns: { try liveStoreEntries(suffix: "DNS", global: "State:/Network/Global/DNS") },
              proxies: { try liveStoreEntries(suffix: "Proxies", global: "State:/Network/Global/Proxies") })
    }
    static func linkIdentity(_ bytes: UnsafeRawBufferPointer) throws -> (index: UInt32, type: UInt8) {
        // sockaddr_dl has a variable payload. Copy only the complete SDK header,
        // then validate its declared bounds before using the typed fields.
        guard let headerSize = MemoryLayout<sockaddr_dl>.offset(of: \.sdl_data),
              bytes.count >= headerSize else { throw Failure.partial }
        var link = sockaddr_dl()
        withUnsafeMutableBytes(of: &link) { $0.copyBytes(from: bytes.prefix(headerSize)) }
        let length = Int(link.sdl_len)
        guard link.sdl_family == UInt8(AF_LINK), length >= headerSize, length <= bytes.count,
              Int(link.sdl_nlen) + Int(link.sdl_alen) + Int(link.sdl_slen) <= length - headerSize else {
            throw Failure.partial
        }
        return (UInt32(link.sdl_index), link.sdl_type)
    }
    static func liveInterfaces() throws -> [InterfaceObservation] {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { throw Failure.partial }
        defer { freeifaddrs(first) }
        struct Raw { var flags: UInt32 = 0, mtu: UInt32 = 0, type: UInt8 = 0, index: UInt32 = 0; var addresses: [AddressObservation] = [] }
        var rows: [String: Raw] = [:]
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            let name = String(cString: entry.pointee.ifa_name)
            guard let address = entry.pointee.ifa_addr else { continue }
            let family = Int32(address.pointee.sa_family)
            var row = rows[name] ?? Raw()
            if family == AF_LINK {
                let identity = try linkIdentity(UnsafeRawBufferPointer(start: address, count: Int(address.pointee.sa_len)))
                row.type = identity.type
                row.index = identity.index
                row.flags = UInt32(entry.pointee.ifa_flags)
                if let data = entry.pointee.ifa_data {
                    var value = if_data()
                    withUnsafeMutableBytes(of: &value) { $0.copyBytes(from: UnsafeRawBufferPointer(start: data, count: $0.count)) }
                    row.mtu = UInt32(value.ifi_mtu)
                }
            } else if family == AF_INET || family == AF_INET6 {
                let bits = family == AF_INET ? 4 : 16
                guard let mask = entry.pointee.ifa_netmask else { continue }
                // BSD netmask sockaddrs carry only significant bytes
                // (sa_len = header + mask bytes); absent bytes are zero.
                let base = family == AF_INET ? 4 : 8
                let maskLength = Int(UnsafeRawPointer(mask).load(as: UInt8.self))
                var raw = [UInt8](repeating: 0, count: bits)
                let available = max(0, min(bits, maskLength - base))
                if available > 0 {
                    raw.withUnsafeMutableBytes {
                        $0.copyBytes(from: UnsafeRawBufferPointer(start: UnsafeRawPointer(mask).advanced(by: base), count: available))
                    }
                }
                var value = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
                guard inet_ntop(family, UnsafeRawPointer(address).advanced(by: base), &value, socklen_t(value.count)) != nil else { continue }
                let prefix = raw.reduce(UInt32(0)) { $0 + UInt32($1.nonzeroBitCount) }
                row.addresses.append(.init(family: family == AF_INET ? "inet" : "inet6",
                                           value: String(cString: value), prefix: prefix))
            }
            rows[name] = row
        }
        guard !rows.isEmpty else { throw Failure.partial }
        return rows.map { name, raw in
            InterfaceObservation(name: name, index: raw.index, type: raw.type, flags: raw.flags,
                                 mtu: raw.mtu, addresses: raw.addresses.sorted {
                                     ($0.family, $0.value, $0.prefix) < ($1.family, $1.value, $1.prefix) })
        }
    }
    /// One bounded SCDynamicStore pass per list. Successive baselines use the
    /// same source code path, so prepare-time and restore-time digests stay
    /// comparable; a read failure fails the baseline instead of guessing.
    private static func liveStoreEntries(suffix: String, global: String) throws -> [(String, Any)] {
        guard let store = SCDynamicStoreCreate(nil, "Relay environment baseline" as CFString, nil, nil) else { throw Failure.partial }
        var keys = [global]
        let pattern = "State:/Network/Service/[^/]+/" + suffix
        if let list = SCDynamicStoreCopyKeyList(store, pattern as CFString) as? [String] { keys.append(contentsOf: list) }
        var result: [(String, Any)] = []
        for key in keys.sorted() {
            guard let value = SCDynamicStoreCopyValue(store, key as CFString) else { continue }
            result.append((key, value))
        }
        return result
    }
}
