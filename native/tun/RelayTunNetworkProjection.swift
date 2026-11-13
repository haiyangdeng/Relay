import Foundation
import CoreFoundation
import Darwin

/// The complete bounded root setup request. This is data, not a grant: the
/// authenticated executor must still bind consent, freshness and a held device.
/// No path, arbitrary resolver key, gateway, flags, FD or process is accepted.
struct RelayTunNetworkProjection: Equatable {
    private typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case invalid, deviceMismatch, planMismatch, effectMismatch }
    // Must equal RelayTunWireRequest.maximumProjectionBytes: the helper's wire
    // target does not link this module, so the executor tests assert equality.
    static let maximumBytes = 16384
    static let maximumAddresses = 16

    struct RouteRequest: Equatable {
        let destination: RelayTunNetworkEffects.Prefix
        let scoped: Bool
        init(destination: RelayTunNetworkEffects.Prefix, scoped: Bool) throws {
            guard destination.address.networkAligned(prefix: destination.length) else { throw Failure.invalid }
            self.destination = destination; self.scoped = scoped
        }
        var json: [String: Any] { ["destination": destination.json, "scoped": scoped] }
        fileprivate static func parse(_ raw: Any?) throws -> Self {
            let item = try Effects.object(raw, keys: ["destination", "scoped"])
            guard let scoped = item["scoped"] as? NSNumber, CFGetTypeID(scoped) == CFBooleanGetTypeID() else { throw Failure.invalid }
            return try .init(destination: Effects.Prefix.parse(item["destination"]), scoped: scoped.boolValue)
        }
    }
    struct ResolverRequest: Equatable {
        let servers: [RelayTunNetworkEffects.Address]
        let matchDomains: [String]
        let searchDomains: [String]
        let searchOrder: UInt32
        init(servers: [RelayTunNetworkEffects.Address], matchDomains: [String], searchDomains: [String], searchOrder: UInt32) throws {
            // Reuse the typed resolver's numeric-address/domain limits without
            // accepting its privileged key or any caller-supplied interface.
            _ = try Effects.Resolver(key: "validation-only", interface: .init(name: "utun0", index: 1),
                servers: servers, matchDomains: matchDomains, searchDomains: searchDomains, searchOrder: searchOrder)
            self.servers = servers; self.matchDomains = matchDomains; self.searchDomains = searchDomains; self.searchOrder = searchOrder
        }
        var json: [String: Any] { ["servers": servers.map(\.json), "matchDomains": matchDomains, "searchDomains": searchDomains, "searchOrder": searchOrder] }
        fileprivate static func parse(_ raw: Any?) throws -> Self {
            let item = try Effects.object(raw, keys: ["servers", "matchDomains", "searchDomains", "searchOrder"])
            guard let servers = item["servers"] as? [Any], servers.count <= 8,
                  let matches = item["matchDomains"] as? [String], let searches = item["searchDomains"] as? [String] else { throw Failure.invalid }
            return try .init(servers: servers.map(Effects.Address.parse), matchDomains: matches,
                             searchDomains: searches, searchOrder: Effects.uint(item["searchOrder"]))
        }
    }
    let device: String
    let mtu: UInt32
    let addresses: [RelayTunNetworkEffects.Prefix]
    let routes: [RouteRequest]
    let resolver: ResolverRequest?
    private let canonicalBytes: Data
    let sha256: String

    init(device: String, mtu: UInt32, addresses: [RelayTunNetworkEffects.Prefix], routes: [RouteRequest], resolver: ResolverRequest?) throws {
        guard device == "utun" || RelayTunNetworkTransaction.Device.validInterfaceName(device),
              (1280...65535).contains(mtu), addresses.count <= Self.maximumAddresses,
              routes.count + (resolver == nil ? 0 : 1) <= Effects.maximumEffects,
              !addresses.contains(where: Self.isAutomaticAddress),
              Set(try addresses.map { try Effects.hash($0.address.json) }).count == addresses.count,
              Set(try routes.map { try Effects.hash($0.json) }).count == routes.count else { throw Failure.invalid }
        self.device = device; self.mtu = mtu; self.addresses = addresses; self.routes = routes; self.resolver = resolver
        let value: [String: Any] = ["version": 1, "device": device, "mtu": mtu, "addresses": addresses.map(\.json),
            "routes": routes.map(\.json), "resolver": resolver.map { $0.json as Any } ?? NSNull()]
        let bytes = try Effects.bytes(value)
        guard bytes.count <= Self.maximumBytes else { throw Failure.invalid }
        canonicalBytes = bytes; sha256 = RelayTunHelperTrust.digest(bytes)
    }
    /// Object keys are sorted; array order remains part of the consent digest.
    /// Equivalent whitespace/key order never changes the approved request.
    func encoded() -> Data { canonicalBytes }
    static func decode(_ data: Data) throws -> Self {
        let item = try Effects.object(RelayTunStrictJSON.object(data, limit: maximumBytes),
                                      keys: ["version", "device", "mtu", "addresses", "routes", "resolver"])
        guard RelayTunStrictJSON.integer(item["version"]) == 1,
              let addresses = item["addresses"] as? [Any], addresses.count <= maximumAddresses,
              let routes = item["routes"] as? [Any], routes.count <= Effects.maximumEffects else { throw Failure.invalid }
        return try .init(device: Effects.text(item["device"], maximum: Int(IFNAMSIZ) - 1), mtu: Effects.uint(item["mtu"]),
                         addresses: addresses.map(Effects.Prefix.parse), routes: routes.map(RouteRequest.parse),
                         resolver: item["resolver"] is NSNull ? nil : ResolverRequest.parse(item["resolver"]))
    }
    /// Darwin may supply IPv6 link-local addresses while bringing up its owned
    /// utun. Preserve those observations in DeviceIdentity; they are never user
    /// setup requests and are never silently stripped from recovery evidence.
    static func isAutomaticAddress(_ prefix: RelayTunNetworkEffects.Prefix) -> Bool {
        guard prefix.address.family == .ipv6 else { return false }
        var bytes = [UInt8](repeating: 0, count: 16)
        guard prefix.address.value.withCString({ inet_pton(AF_INET6, $0, &bytes) }) == 1 else { return false }
        return bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80
    }
    private func validateDevice(_ observed: Effects.DeviceIdentity) throws {
        guard (device == "utun" || device == observed.interface.name), mtu == observed.mtu,
              addresses.allSatisfy({ observed.addresses.contains($0) }),
              observed.addresses.allSatisfy({ addresses.contains($0) || Self.isAutomaticAddress($0) }) else { throw Failure.deviceMismatch }
    }
    func realize(planID: String, device observed: RelayTunNetworkEffects.DeviceIdentity) throws -> RelayTunNetworkEffects.EffectSet {
        try validateDevice(observed)
        var effects = try routes.map { route -> Effects.Effect in
            let scope = route.scoped ? observed.interface.index : 0
            let flags = UInt32(RTF_UP | RTF_STATIC) | (route.scoped ? UInt32(RTF_IFSCOPE) : 0)
            return try .route(.init(destination: route.destination, gateway: nil, interface: observed.interface,
                                    scopeIndex: scope, flags: flags, hopCount: 0))
        }
        if let resolver {
            effects.append(try .resolver(.init(key: Effects.Resolver.ownedKey(planID: planID), interface: observed.interface,
                servers: resolver.servers, matchDomains: resolver.matchDomains, searchDomains: resolver.searchDomains, searchOrder: resolver.searchOrder)))
        }
        return try .init(planID: planID, device: observed, effects: effects)
    }
    /// This proves the approved request-to-effect mapping. The executor must
    /// additionally compare device identity against its privately held handle.
    func verify(plan: RelayTunNetworkTransaction.Plan, effects: RelayTunNetworkEffects.EffectSet) throws {
        guard plan.effectsSHA256 == sha256, plan.id == effects.planID,
              routes.isEmpty || plan.routeRemovalPolicy == .ownedDeviceRetirement else { throw Failure.planMismatch }
        let expected = try realize(planID: plan.id, device: effects.device)
        guard expected == effects else { throw Failure.effectMismatch }
    }
}
