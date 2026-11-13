import Foundation

typealias Effects = RelayTunNetworkEffects
typealias Journal = RelayTunNetworkJournal

enum EffectsFixture {
    static let planID = "b10537c0-1c47-4e45-a636-82a89d58e598"
    static let deviceID = "20428e7a-4e2a-498a-84a5-102ab04b3256"
    static func address(_ value: String, _ family: Effects.Address.Family = .ipv4) throws -> Effects.Address { try .init(family: family, value: value) }
    static func device() throws -> Effects.DeviceIdentity {
        try .init(id: deviceID, interface: .init(name: "utun42", index: 91), controlID: 17, controlUnit: 43,
                  socketDevice: 0, socketInode: UInt64.max, mtu: 9000, addresses: [.init(address: address("198.18.0.1"), length: 30)])
    }
    static func route(_ destination: String = "0.0.0.0", prefix: UInt32 = 0, gateway: String = "198.18.0.1") throws -> Effects.Route {
        try .init(destination: .init(address: address(destination), length: prefix), gateway: address(gateway), interface: device().interface, scopeIndex: 0, flags: 3, hopCount: 1)
    }
    static func resolver(planID: String = planID) throws -> Effects.Resolver {
        try .init(key: Effects.Resolver.ownedKey(planID: planID), interface: device().interface,
                  servers: [address("198.18.0.2"), address("fd00::2", .ipv6)], matchDomains: [""], searchDomains: ["example.test"], searchOrder: 900)
    }
    static func set() throws -> Effects.EffectSet { try .init(planID: planID, device: device(), effects: [.route(route()), .resolver(resolver())]) }
    static func plan() -> RelayTunNetworkTransaction.Plan {
        .init(id: planID, configurationSHA256: String(repeating: "a", count: 64), runtimeConfigurationSHA256: String(repeating: "b", count: 64),
              effectsSHA256: String(repeating: "c", count: 64), baseline: .init(networkSHA256: String(repeating: "d", count: 64), protectionSHA256: String(repeating: "e", count: 64)), createdAt: 1000, expiresAt: 61000)
    }
    static func binding(revision: String = String(repeating: "f", count: 64), uid: UInt32 = 501) throws -> Journal.Binding {
        try .init(installationRevision: revision, clientUID: uid, plan: plan())
    }
}

enum RelayTunNetworkEffectsTests {
    static func run(check: (Bool, String) -> Void, rejects: (String, () throws -> Void) -> Void) throws {
        let set = try EffectsFixture.set(), changes = try set.changes(), bytes = try set.encoded()
        check(try Effects.EffectSet.decode(bytes) == set, "typed effects round-trip all recovery fields without filesystem or kernel access")
        check(set.device.socketInode == UInt64.max && String(data: bytes, encoding: .utf8)!.contains("18446744073709551615"), "full-width socket inode is retained as an exact decimal string")
        let zeroInode = try Effects.DeviceIdentity(id: set.device.id, interface: set.device.interface, controlID: set.device.controlID, controlUnit: set.device.controlUnit,
                                                  socketDevice: 0, socketInode: 0, mtu: set.device.mtu, addresses: set.device.addresses)
        check(try Effects.DeviceIdentity.parse(zeroInode.json) == zeroInode, "Darwin socket inode zero round-trips as an observation rather than a unique ownership claim")
        let zeroSet = try Effects.EffectSet(planID: set.planID, device: zeroInode, effects: set.effects)
        check(try Effects.EffectSet.decode(zeroSet.encoded()) == zeroSet, "complete recovery effects preserve zero socket identity observations")
        check(changes.count == 2 && Set(changes.map(\.id)).count == 2 && changes.allSatisfy { $0.beforeSHA256 == RelayTunNetworkTransaction.absentSHA256 }, "typed target keys generate distinct originally-absent transaction changes")
        for (index, change) in changes.enumerated() { check(try set.effect(for: change) == set.effects[index], "exact Change hashes recover the complete effect at index \(index)") }
        let tamperedChange = RelayTunNetworkTransaction.Change(id: changes[0].id, kind: .route, beforeSHA256: changes[0].beforeSHA256, desiredSHA256: String(repeating: "1", count: 64))
        rejects("a matching target ID cannot substitute a different desired digest") { _ = try set.effect(for: tamperedChange) }
        rejects("a matching desired digest cannot substitute the change kind") {
            _ = try set.effect(for: .init(id: changes[0].id, kind: .resolver, beforeSHA256: changes[0].beforeSHA256, desiredSHA256: changes[0].desiredSHA256))
        }
        rejects("two gateway values occupying one route key are rejected before any write") { _ = try Effects.EffectSet(planID: set.planID, device: set.device, effects: [.route(EffectsFixture.route()), .route(EffectsFixture.route(gateway: "198.18.0.2"))]) }
        let differentRoute = try EffectsFixture.route("192.0.2.0", prefix: 24), different = try Effects.EffectSet(planID: set.planID, device: set.device, effects: [.route(differentRoute)])
        check(try different.changes()[0].id != changes[0].id, "route destinations remain part of the exact lookup key")
        let ipv6 = try Effects.Route(destination: .init(address: EffectsFixture.address("::", .ipv6), length: 0), gateway: nil, interface: set.device.interface, scopeIndex: 91, flags: 0x01000001, hopCount: 0)
        check(try Effects.EffectSet(planID: set.planID, device: set.device, effects: [.route(EffectsFixture.route()), .route(ipv6)]).changes().count == 2, "IPv4 and IPv6 default route identities cannot collapse")
        rejects("a route network prefix with nonzero host bits is rejected") { _ = try EffectsFixture.route("192.0.2.7", prefix: 24) }
        rejects("a route gateway of the other family is rejected") { _ = try Effects.Route(destination: ipv6.destination, gateway: EffectsFixture.address("192.0.2.1"), interface: set.device.interface, scopeIndex: 0, flags: 1, hopCount: 0) }
        rejects("a scoped route must bind the exact interface index") { _ = try Effects.Route(destination: ipv6.destination, gateway: nil, interface: set.device.interface, scopeIndex: 99, flags: 0x01000001, hopCount: 0) }
        rejects("route scope and SDK RTF_IFSCOPE bit cannot disagree") { _ = try Effects.Route(destination: ipv6.destination, gateway: nil, interface: set.device.interface, scopeIndex: 91, flags: 1, hopCount: 0) }
        for value in ["127.1", "192.000.2.1", "1.2.3.4\0other", "256.0.0.1", "::1"] {
            rejects("noncanonical or wrong-family IPv4 input is rejected: \(value.debugDescription)") { _ = try EffectsFixture.address(value) }
        }
        for value in ["FE80::1", "fe80::1%en0", "2001:db8:0:0::1", "192.0.2.1"] {
            rejects("noncanonical or scoped textual IPv6 input is rejected: \(value)") { _ = try EffectsFixture.address(value, .ipv6) }
        }
        check(try EffectsFixture.address("2001:db8::1", .ipv6).value == "2001:db8::1", "canonical IPv6 is retained without DNS resolution")
        rejects("an IPv4 prefix cannot exceed its family width") { _ = try Effects.Prefix(address: EffectsFixture.address("192.0.2.1"), length: 33) }
        rejects("a zero interface index is refused") { _ = try Effects.Interface(name: "utun42", index: 0) }
        rejects("an interface cannot contain a path or shell fragment") { _ = try Effects.Interface(name: "en0/other", index: 1) }
        rejects("device control unit cannot identify a different utun") { _ = try Effects.DeviceIdentity(id: set.device.id, interface: set.device.interface, controlID: 17, controlUnit: 44, socketDevice: 0, socketInode: 1, mtu: 9000, addresses: []) }
        rejects("a bare automatic device name is not an observed identity") { _ = try Effects.DeviceIdentity(id: set.device.id, interface: .init(name: "utun", index: 1), controlID: 17, controlUnit: 1, socketDevice: 0, socketInode: 1, mtu: 9000, addresses: []) }
        rejects("duplicate interface addresses are not silently dropped") { _ = try Effects.DeviceIdentity(id: set.device.id, interface: set.device.interface, controlID: 17, controlUnit: 43, socketDevice: 0, socketInode: 1, mtu: 9000, addresses: set.device.addresses + set.device.addresses) }
        let foreignResolver = try Effects.Resolver(key: "State:/Network/Global/DNS", interface: set.device.interface, servers: [.init(family: .ipv4, value: "192.0.2.1")], matchDomains: [], searchDomains: [], searchOrder: 0)
        rejects("a resolver cannot target an existing global DNS key") { _ = try Effects.EffectSet(planID: set.planID, device: set.device, effects: [.resolver(foreignResolver)]) }
        rejects("a resolver cannot borrow another plan's state key") { _ = try Effects.EffectSet(planID: set.planID, device: set.device, effects: [.resolver(EffectsFixture.resolver(planID: EffectsFixture.deviceID))]) }
        let wrongInterface = try Effects.Resolver(key: Effects.Resolver.ownedKey(planID: set.planID), interface: .init(name: "en0", index: 5), servers: [.init(family: .ipv4, value: "192.0.2.1")], matchDomains: [], searchDomains: [], searchOrder: 0)
        rejects("a resolver must bind the exact observed device interface") { _ = try Effects.EffectSet(planID: set.planID, device: set.device, effects: [.resolver(wrongInterface)]) }
        rejects("duplicate DNS servers are rejected rather than normalized away") { _ = try Effects.Resolver(key: "unused", interface: set.device.interface, servers: [EffectsFixture.address("192.0.2.1"), EffectsFixture.address("192.0.2.1")], matchDomains: [], searchDomains: [], searchOrder: 0) }
        rejects("uppercase or empty-label DNS domain input is rejected") { _ = try Effects.Resolver(key: "unused", interface: set.device.interface, servers: [EffectsFixture.address("192.0.2.1")], matchDomains: ["Example..test"], searchDomains: [], searchOrder: 0) }
        rejects("effect counts are bounded before encoding") { _ = try Effects.EffectSet(planID: set.planID, device: set.device, effects: Array(repeating: set.effects[0], count: Effects.maximumEffects + 1)) }
        var raw = set.json; raw["unknown"] = true
        rejects("unknown effect-set fields are rejected") { _ = try Effects.EffectSet.decode(Effects.bytes(raw)) }
        let duplicate = String(data: bytes, encoding: .utf8)!.replacingOccurrences(of: "\"scopeIndex\":0", with: "\"scopeIndex\":0,\"scopeInd\\u0065x\":0")
        rejects("escaped duplicate keys are rejected before Foundation decoding") { _ = try Effects.EffectSet.decode(Data(duplicate.utf8)) }
        for value: Any in [true, -1, 1.25, UInt64(UInt32.max) + 1, "1"] {
            var route = try EffectsFixture.route().json; route["hopCount"] = value
            var changed = set.json; changed["effects"] = [["kind": "route", "value": route]]
            rejects("non-UInt32 route hop count is rejected: \(value)") { _ = try Effects.EffectSet.decode(Effects.bytes(changed)) }
        }
        for value: Any in ["01", "18446744073709551616", UInt64.max, true] {
            var device = set.device.json; device["socketInode"] = value
            var changed = set.json; changed["device"] = device
            rejects("ambiguous or out-of-range full-width identity is rejected: \(value)") { _ = try Effects.EffectSet.decode(Effects.bytes(changed)) }
        }
        rejects("oversized effect JSON is refused before structural decoding") { _ = try Effects.EffectSet.decode(Data(repeating: 32, count: Effects.maximumBytes + 1)) }
        rejects("truncated effect JSON cannot be interpreted as an empty plan") { _ = try Effects.EffectSet.decode(bytes.prefix(bytes.count / 2)) }
    }
}
