import Foundation
import Darwin

/// Typed recovery data only. These values neither authorize nor perform a
/// route/resolver mutation. A live adapter must independently observe the key,
/// bind consent and device ownership, and compare again at its write boundary.
enum RelayTunNetworkEffects {
    enum Failure: Error { case invalid }
    static let maximumEffects = 128
    static let maximumBytes = 262144

    static func object(_ raw: Any?, keys: Set<String>) throws -> [String: Any] {
        guard let value = raw as? [String: Any], Set(value.keys) == keys else { throw Failure.invalid }; return value
    }
    static func text(_ raw: Any?, maximum: Int = 256) throws -> String {
        guard let value = raw as? String, !value.contains("\0"), value.utf8.count <= maximum else { throw Failure.invalid }; return value
    }
    static func uint(_ raw: Any?, positive: Bool = false) throws -> UInt32 {
        guard let value = RelayTunStrictJSON.integer(raw), !positive || value > 0 else { throw Failure.invalid }; return UInt32(value)
    }
    static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func digest(_ value: String) -> Bool { RelayTunHelperTrust.hex(value, count: 64) != nil }
    static func bytes(_ value: Any) throws -> Data {
        let result = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        guard result.count <= maximumBytes else { throw Failure.invalid }; return result
    }
    static func hash(_ value: Any) throws -> String { RelayTunHelperTrust.digest(try bytes(value)) }
    static func decimal(_ raw: Any?, positive: Bool = false) throws -> UInt64 {
        let value = try text(raw, maximum: 20)
        guard let number = UInt64(value), String(number) == value, !positive || number > 0 else { throw Failure.invalid }; return number
    }
    static func interfaceName(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count < Int(IFNAMSIZ) && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 95].contains($0)
        }
    }

    struct Address: Equatable {
        enum Family: String { case ipv4, ipv6 }
        let family: Family
        let value: String
        private let octets: [UInt8]
        init(family: Family, value: String) throws {
            let size = family == .ipv4 ? 4 : 16, af = family == .ipv4 ? AF_INET : AF_INET6
            var binary = [UInt8](repeating: 0, count: size), output = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            guard !value.contains("\0"), value.utf8.count < Int(INET6_ADDRSTRLEN),
                  value.withCString({ inet_pton(af, $0, &binary) }) == 1,
                  binary.withUnsafeBytes({ inet_ntop(af, $0.baseAddress, &output, socklen_t(output.count)) }) != nil,
                  String(cString: output) == value else { throw Failure.invalid }
            self.family = family; self.value = value; octets = binary
        }
        var json: [String: Any] { ["family": family.rawValue, "value": value] }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try object(raw, keys: ["family", "value"])
            guard let family = Family(rawValue: try text(item["family"])) else { throw Failure.invalid }
            return try .init(family: family, value: text(item["value"]))
        }
        func networkAligned(prefix: UInt32) -> Bool {
            guard prefix <= (family == .ipv4 ? 32 : 128) else { return false }
            for (index, byte) in octets.enumerated() {
                let bits = max(0, min(8, Int(prefix) - index * 8))
                if bits < 8 && byte & UInt8(255 >> bits) != 0 { return false }
            }
            return true
        }
    }
    struct Prefix: Equatable {
        let address: Address
        let length: UInt32
        init(address: Address, length: UInt32) throws {
            guard length <= (address.family == .ipv4 ? 32 : 128) else { throw Failure.invalid }
            self.address = address; self.length = length
        }
        var json: [String: Any] { ["address": address.json, "length": length] }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try object(raw, keys: ["address", "length"])
            return try .init(address: Address.parse(item["address"]), length: uint(item["length"]))
        }
    }
    struct Interface: Equatable {
        let name: String
        let index: UInt32
        init(name: String, index: UInt32) throws {
            guard interfaceName(name), index > 0 else { throw Failure.invalid }; self.name = name; self.index = index
        }
        var json: [String: Any] { ["name": name, "index": index] }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try object(raw, keys: ["name", "index"])
            return try .init(name: text(item["name"]), index: uint(item["index"], positive: true))
        }
    }
    struct DeviceIdentity: Equatable {
        let id: String
        let interface: Interface
        let controlID: UInt32
        let controlUnit: UInt32
        let socketDevice: UInt64
        let socketInode: UInt64
        let mtu: UInt32
        let addresses: [Prefix]
        init(id: String, interface: Interface, controlID: UInt32, controlUnit: UInt32,
             socketDevice: UInt64, socketInode: UInt64, mtu: UInt32, addresses: [Prefix]) throws {
            guard uuid(id), RelayTunNetworkTransaction.Device.validInterfaceName(interface.name),
                  let number = UInt32(interface.name.dropFirst(4)), controlUnit == number + 1,
                  controlID > 0, mtu > 0, addresses.count <= 16,
                  Set(try addresses.map { try hash($0.json) }).count == addresses.count else { throw Failure.invalid }
            self.id = id; self.interface = interface; self.controlID = controlID; self.controlUnit = controlUnit
            self.socketDevice = socketDevice; self.socketInode = socketInode; self.mtu = mtu; self.addresses = addresses
        }
        // Darwin sockets may report inode zero. These observations supplement
        // the held FD/control/interface identity; they never identify an owner
        // on their own. Decimal strings retain the complete UInt64 range.
        var json: [String: Any] { ["id": id, "interface": interface.json, "controlID": controlID, "controlUnit": controlUnit,
                                  "socketDevice": String(socketDevice), "socketInode": String(socketInode), "mtu": mtu, "addresses": addresses.map(\.json)] }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try object(raw, keys: ["id", "interface", "controlID", "controlUnit", "socketDevice", "socketInode", "mtu", "addresses"])
            guard let addresses = item["addresses"] as? [Any], addresses.count <= 16 else { throw Failure.invalid }
            return try .init(id: text(item["id"]), interface: Interface.parse(item["interface"]), controlID: uint(item["controlID"], positive: true),
                             controlUnit: uint(item["controlUnit"], positive: true), socketDevice: decimal(item["socketDevice"]),
                             socketInode: decimal(item["socketInode"]), mtu: uint(item["mtu"], positive: true), addresses: addresses.map(Prefix.parse))
        }
    }
    struct Route: Equatable {
        let destination: Prefix
        let gateway: Address?
        let interface: Interface
        let scopeIndex: UInt32
        let flags: UInt32
        // SDK net/route.h rt_metrics.rmx_hopcount, not a cross-platform metric.
        let hopCount: UInt32
        init(destination: Prefix, gateway: Address?, interface: Interface, scopeIndex: UInt32, flags: UInt32, hopCount: UInt32) throws {
            guard destination.address.networkAligned(prefix: destination.length), gateway == nil || gateway!.family == destination.address.family,
                  scopeIndex == 0 || scopeIndex == interface.index,
                  (flags & 0x01000000 != 0) == (scopeIndex != 0) else { throw Failure.invalid }
            self.destination = destination; self.gateway = gateway; self.interface = interface; self.scopeIndex = scopeIndex; self.flags = flags; self.hopCount = hopCount
        }
        // A changed gateway/value occupies the same lookup key; it must not be
        // mistaken for a second originally-absent route which can be overwritten.
        var key: [String: Any] { ["destination": destination.json, "scopeIndex": scopeIndex] }
        var json: [String: Any] { ["destination": destination.json, "gateway": gateway.map { $0.json as Any } ?? NSNull(),
                                  "interface": interface.json, "scopeIndex": scopeIndex, "flags": flags, "hopCount": hopCount] }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try object(raw, keys: ["destination", "gateway", "interface", "scopeIndex", "flags", "hopCount"])
            return try .init(destination: Prefix.parse(item["destination"]), gateway: item["gateway"] is NSNull ? nil : Address.parse(item["gateway"]),
                             interface: Interface.parse(item["interface"]), scopeIndex: uint(item["scopeIndex"]), flags: uint(item["flags"]), hopCount: uint(item["hopCount"]))
        }
    }
    struct Resolver: Equatable {
        let key: String
        let interface: Interface
        let servers: [Address]
        let matchDomains: [String]
        let searchDomains: [String]
        let searchOrder: UInt32
        static func ownedKey(planID: String) -> String { "State:/Network/Service/local.relay.network.tun." + planID + "/DNS" }
        private static func domains(_ value: [String], allowRoot: Bool) -> Bool {
            value.count <= 32 && Set(value).count == value.count && value.allSatisfy { domain in
                if domain.isEmpty { return allowRoot }
                return domain.utf8.count <= 253 && domain.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
                    !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-" && label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
                }
            }
        }
        init(key: String, interface: Interface, servers: [Address], matchDomains: [String], searchDomains: [String], searchOrder: UInt32) throws {
            guard key.utf8.count <= 160, !key.contains("\0"), (1...8).contains(servers.count), Set(servers.map(\.value)).count == servers.count,
                  Self.domains(matchDomains, allowRoot: true), Self.domains(searchDomains, allowRoot: false) else { throw Failure.invalid }
            self.key = key; self.interface = interface; self.servers = servers; self.matchDomains = matchDomains; self.searchDomains = searchDomains; self.searchOrder = searchOrder
        }
        var json: [String: Any] { ["key": key, "interface": interface.json, "servers": servers.map(\.json), "matchDomains": matchDomains, "searchDomains": searchDomains, "searchOrder": searchOrder] }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try object(raw, keys: ["key", "interface", "servers", "matchDomains", "searchDomains", "searchOrder"])
            guard let servers = item["servers"] as? [Any], servers.count <= 8, let matches = item["matchDomains"] as? [String], let searches = item["searchDomains"] as? [String] else { throw Failure.invalid }
            return try .init(key: text(item["key"]), interface: Interface.parse(item["interface"]), servers: servers.map(Address.parse), matchDomains: matches, searchDomains: searches, searchOrder: uint(item["searchOrder"]))
        }
    }
    enum Effect: Equatable {
        case route(Route), resolver(Resolver)
        var kind: RelayTunNetworkTransaction.Change.Kind { switch self { case .route: return .route; case .resolver: return .resolver } }
        var key: [String: Any] { switch self { case .route(let route): return ["kind": "route", "key": route.key]; case .resolver(let resolver): return ["kind": "resolver", "key": resolver.key] } }
        var json: [String: Any] { switch self { case .route(let route): return ["kind": "route", "value": route.json]; case .resolver(let resolver): return ["kind": "resolver", "value": resolver.json] } }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try object(raw, keys: ["kind", "value"])
            switch try text(item["kind"]) { case "route": return try .route(Route.parse(item["value"])); case "resolver": return try .resolver(Resolver.parse(item["value"])); default: throw Failure.invalid }
        }
    }
    struct EffectSet: Equatable {
        let planID: String
        let device: DeviceIdentity
        let effects: [Effect]
        // This is a realized recovery description. A future live adapter must
        // separately prove that it realizes the approved projection; having a
        // self-consistent digest here never supplies that missing authority.
        init(planID: String, device: DeviceIdentity, effects: [Effect]) throws {
            guard uuid(planID), effects.count <= maximumEffects, Set(try effects.map { try hash($0.key) }).count == effects.count else { throw Failure.invalid }
            for effect in effects {
                if case .resolver(let resolver) = effect {
                    guard resolver.key == Resolver.ownedKey(planID: planID), resolver.interface == device.interface else { throw Failure.invalid }
                }
            }
            self.planID = planID; self.device = device; self.effects = effects
        }
        var json: [String: Any] { ["version": 1, "planID": planID, "device": device.json, "effects": effects.map(\.json)] }
        var sha256: String { get throws { try hash(json) } }
        func changes() throws -> [RelayTunNetworkTransaction.Change] {
            try effects.map { effect in
                .init(id: try hash(["version": 1, "planID": planID, "deviceID": device.id, "target": effect.key]), kind: effect.kind,
                      beforeSHA256: RelayTunNetworkTransaction.absentSHA256,
                      desiredSHA256: try hash(["version": 1, "device": device.json, "effect": effect.json]))
            }
        }
        func effect(for change: RelayTunNetworkTransaction.Change) throws -> Effect {
            let values = try changes()
            guard let index = values.firstIndex(of: change) else { throw Failure.invalid }; return effects[index]
        }
        static func parse(_ raw: Any?) throws -> Self {
            let item = try object(raw, keys: ["version", "planID", "device", "effects"])
            guard RelayTunStrictJSON.integer(item["version"]) == 1, let effects = item["effects"] as? [Any], effects.count <= maximumEffects else { throw Failure.invalid }
            return try .init(planID: text(item["planID"]), device: DeviceIdentity.parse(item["device"]), effects: effects.map(Effect.parse))
        }
        func encoded() throws -> Data { let data = try bytes(json); _ = try Self.decode(data); return data }
        static func decode(_ data: Data) throws -> Self { try parse(RelayTunStrictJSON.object(data, limit: maximumBytes)) }
    }
}
