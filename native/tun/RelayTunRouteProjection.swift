import Foundation
import Darwin

/// Pure bridge between the bounded Darwin message codec and typed effects.
/// Interface resolution is injected: this type never opens a routing socket,
/// looks up an interface, authorizes a write or interprets a refusal as absence.
enum RelayTunRouteProjection {
    private typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case invalid, interfaceIdentity, codec(UInt32) }
    enum Operation: UInt8 { case add = 1, get = 4 }
    struct Message {
        let route: RelayTunNetworkEffects.Route
        let operation: Operation
        let pid: Int32
        let sequence: Int32
        let confirmed: Bool
        // Preserve AF_LINK metadata outside the effect's narrower value model.
        // Neither a matching name/index nor DONE proves held-device ownership.
        let interfaceType: UInt8
        let suppliedInterfaceName: String?
        let kernelMTU: UInt32
        let kernelProtocolCloning: Bool
        let interfaceAddress: RelayTunNetworkEffects.Address?
    }

    private static func checked(_ result: RelayTunRouteCode) throws {
        guard result == RELAY_TUN_ROUTE_OK else { throw Failure.codec(result.rawValue) }
    }
    private static func copy<T>(_ bytes: [UInt8], into value: inout T) throws {
        guard bytes.count <= MemoryLayout<T>.size else { throw Failure.invalid }
        withUnsafeMutableBytes(of: &value) { buffer in
            buffer.initializeMemory(as: UInt8.self, repeating: 0)
            buffer.copyBytes(from: bytes)
        }
    }
    private static func binary(_ address: Effects.Address) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 16)
        let family = address.family == .ipv4 ? AF_INET : AF_INET6
        guard address.value.withCString({ inet_pton(family, $0, &bytes) }) == 1 else { throw Failure.invalid }
        return bytes
    }
    private static func address<T>(_ value: T, family: Effects.Address.Family) throws -> Effects.Address {
        var bytes = value, output = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let af = family == .ipv4 ? AF_INET : AF_INET6
        let result = withUnsafeBytes(of: &bytes) { inet_ntop(af, $0.baseAddress, &output, socklen_t(output.count)) }
        guard result != nil else { throw Failure.invalid }
        return try .init(family: family, value: String(cString: output))
    }
    private static func record(_ route: Effects.Route, interfaceType: UInt8) throws -> RelayTunRouteRecord {
        var value = RelayTunRouteRecord()
        value.family = route.destination.address.family == .ipv4 ? AF_INET : AF_INET6
        guard let prefix = UInt8(exactly: route.destination.length) else { throw Failure.invalid }
        value.prefix = prefix
        try copy(binary(route.destination.address), into: &value.destination)
        value.gateway_kind = UInt8(route.gateway == nil ? RELAY_TUN_ROUTE_INTERFACE : RELAY_TUN_ROUTE_IP)
        if let gateway = route.gateway { try copy(binary(gateway), into: &value.gateway) }
        value.interface_index = route.interface.index
        try copy(Array(route.interface.name.utf8) + [0], into: &value.interface_name)
        value.interface_type = interfaceType; value.scope_index = route.scopeIndex
        value.flags = route.flags; value.hop_count = route.hopCount
        try checked(relay_tun_route_validate(&value))
        return value
    }
    /// Produces request bytes only. Sending, correlating a reply, recording its
    /// intent and independently observing the result belong to a future adapter.
    static func request(_ route: RelayTunNetworkEffects.Route, operation: Operation,
                        pid: Int32, sequence: Int32, interfaceType: UInt8) throws -> Data {
        var value = try record(route, interfaceType: interfaceType)
        var bytes = Data(count: Int(RELAY_TUN_ROUTE_MAX_MESSAGE)), written = 0
        let result = bytes.withUnsafeMutableBytes {
            relay_tun_route_encode(&value, operation.rawValue, pid, sequence, $0.baseAddress, $0.count, &written)
        }
        try checked(result)
        guard written > 0 && written <= bytes.count else { throw Failure.invalid }
        bytes.removeSubrange(written..<bytes.count)
        return bytes
    }
    /// The resolver must provide a separately observed, bound interface. A
    /// message name cannot replace that observation or adopt a device by name.
    /// Kernel errors, unsupported fields and lookup failures all throw.
    static func decode(_ bytes: Data, resolveInterface: (UInt32) throws -> RelayTunNetworkEffects.Interface) throws -> Message {
        guard !bytes.isEmpty && bytes.count <= Int(RELAY_TUN_ROUTE_MAX_MESSAGE) else { throw Failure.invalid }
        var message = RelayTunRouteMessage()
        try checked(bytes.withUnsafeBytes { relay_tun_route_decode($0.baseAddress, $0.count, &message) })
        guard let operation = Operation(rawValue: message.operation) else { throw Failure.invalid }
        let value = message.route
        let interface = try resolveInterface(value.interface_index)
        let suppliedName = withUnsafeBytes(of: value.interface_name) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        guard interface.index == value.interface_index, suppliedName.isEmpty || suppliedName == interface.name else { throw Failure.interfaceIdentity }
        let family: Effects.Address.Family
        switch value.family { case AF_INET: family = .ipv4; case AF_INET6: family = .ipv6; default: throw Failure.invalid }
        let destination = try Effects.Prefix(address: address(value.destination, family: family), length: UInt32(value.prefix))
        let gateway: Effects.Address?
        switch Int(value.gateway_kind) {
        case RELAY_TUN_ROUTE_INTERFACE: gateway = nil
        case RELAY_TUN_ROUTE_IP: gateway = try address(value.gateway, family: family)
        default: throw Failure.invalid
        }
        let route = try Effects.Route(destination: destination, gateway: gateway, interface: interface,
                                      scopeIndex: value.scope_index, flags: value.flags, hopCount: value.hop_count)
        let interfaceAddress: Effects.Address?
        switch message.interface_address_family {
        case 0: interfaceAddress = nil
        case AF_INET: interfaceAddress = try address(message.interface_address, family: .ipv4)
        case AF_INET6: interfaceAddress = try address(message.interface_address, family: .ipv6)
        default: throw Failure.invalid
        }
        return .init(route: route, operation: operation, pid: message.pid, sequence: message.sequence, confirmed: message.confirmed,
                     interfaceType: value.interface_type, suppliedInterfaceName: suppliedName.isEmpty ? nil : suppliedName,
                     kernelMTU: message.kernel_mtu, kernelProtocolCloning: message.kernel_protocol_cloning,
                     interfaceAddress: interfaceAddress)
    }
}
