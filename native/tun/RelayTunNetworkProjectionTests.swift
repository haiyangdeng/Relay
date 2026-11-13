import Foundation
import Darwin

private typealias Projection = RelayTunNetworkProjection
private typealias Effects = RelayTunNetworkEffects
private typealias Transaction = RelayTunNetworkTransaction

@main struct RelayTunNetworkProjectionTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var checks: [[String: Any]] = []
        func check(_ name: String, _ value: @autoclosure () throws -> Bool) {
            do { checks.append(["name": name, "passed": try value()]) }
            catch { checks.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); checks.append(["name": name, "passed": false]) }
            catch { checks.append(["name": name, "passed": true]) }
        }
        func prefix(_ value: String, _ length: UInt32, _ family: Effects.Address.Family = .ipv4) throws -> Effects.Prefix {
            try .init(address: .init(family: family, value: value), length: length)
        }
        let planID = "a819f72d-7b78-45e5-933f-561bfa2e0f70", deviceID = "b166222a-c6c9-473b-a09b-df5c3e631b44"
        do {
            let address = try prefix("198.18.0.1", 30), automatic = try prefix("fe80::1234", 64, .ipv6)
            let route = try Projection.RouteRequest(destination: prefix("192.0.2.0", 24), scoped: false)
            let scoped = try Projection.RouteRequest(destination: prefix("2001:db8::", 32, .ipv6), scoped: true)
            let resolver = try Projection.ResolverRequest(servers: [.init(family: .ipv4, value: "198.18.0.1")],
                matchDomains: [""], searchDomains: ["relay.test"], searchOrder: 42)
            let projection = try Projection(device: "utun", mtu: 1500, addresses: [address], routes: [route, scoped], resolver: resolver)
            func observed(_ name: String = "utun4", mtu: UInt32 = 1500, addresses: [Effects.Prefix]? = nil) throws -> Effects.DeviceIdentity {
                let unit = UInt32(name.dropFirst(4))! + 1
                return try .init(id: deviceID, interface: .init(name: name, index: 20), controlID: 5, controlUnit: unit,
                    socketDevice: 0, socketInode: UInt64.max, mtu: mtu, addresses: addresses ?? [address, automatic])
            }
            let device = try observed(), effects = try projection.realize(planID: planID, device: device)
            func plan(_ digest: String? = nil, policy: Transaction.RouteRemovalPolicy = .ownedDeviceRetirement) -> Transaction.Plan {
                var plan = Transaction.Plan(id: planID, configurationSHA256: String(repeating: "a", count: 64),
                    runtimeConfigurationSHA256: String(repeating: "b", count: 64), effectsSHA256: digest ?? projection.sha256,
                    baseline: .init(networkSHA256: String(repeating: "c", count: 64), protectionSHA256: String(repeating: "d", count: 64)), createdAt: 1, expiresAt: 10)
                plan.routeRemovalPolicy = policy; return plan
            }
            try projection.verify(plan: plan(), effects: effects)
            check("canonical typed request round-trips with its digest", try Projection.decode(projection.encoded()) == projection)
            check("allocated device and full socket values survive realization", effects.device == device && effects.device.socketInode == UInt64.max)
            check("kernel-generated IPv6 link-local remains in recovery identity", effects.device.addresses == [address, automatic])
            check("two routes and one temporary resolver form exactly three effects", effects.effects.count == 3)
            if case .route(let route) = effects.effects[0] {
                check("unscoped interface route has fixed UP STATIC flags and no gateway", route.scopeIndex == 0 && route.flags == UInt32(RTF_UP | RTF_STATIC) && route.gateway == nil && route.hopCount == 0 && route.interface == device.interface)
            } else { check("first route exists", false) }
            if case .route(let route) = effects.effects[1] {
                check("scoped route uses only the actual allocated index", route.scopeIndex == 20 && route.flags == UInt32(RTF_UP | RTF_STATIC | RTF_IFSCOPE) && route.gateway == nil)
            } else { check("second route exists", false) }
            if case .resolver(let actual) = effects.effects[2] {
                check("resolver key and interface come only from current plan and acquired device", actual.key == Effects.Resolver.ownedKey(planID: planID) && actual.interface == device.interface && actual.searchOrder == 42)
            } else { check("resolver exists", false) }
            let reordered = try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: projection.encoded()), options: [.prettyPrinted])
            check("whitespace and object key order cannot change consent digest", try Projection.decode(reordered).sha256 == projection.sha256)
            let reversed = try Projection(device: "utun", mtu: 1500, addresses: [address], routes: [scoped, route], resolver: resolver)
            check("array order remains part of the explicit request", reversed.sha256 != projection.sha256)
            let exact = try Projection(device: "utun4", mtu: 1500, addresses: [address], routes: [], resolver: nil)
            check("explicit requested device is accepted only when observed exactly", try exact.realize(planID: planID, device: device).effects.isEmpty)
            rejects("explicit name cannot switch to another allocated device") { _ = try exact.realize(planID: planID, device: observed("utun5")) }
            rejects("observed MTU must equal the approved setup") { _ = try projection.realize(planID: planID, device: observed(mtu: 9000)) }
            rejects("missing required address cannot pass as configured") { _ = try projection.realize(planID: planID, device: observed(addresses: [automatic])) }
            rejects("unapproved non-kernel address blocks realization") { _ = try projection.realize(planID: planID, device: observed(addresses: [address, prefix("203.0.113.1", 24)])) }
            rejects("kernel link-local observation cannot become a user setup request") { _ = try Projection(device: "utun", mtu: 1500, addresses: [automatic], routes: [], resolver: nil) }
            rejects("same address with two masks cannot become two alias writes") { _ = try Projection(device: "utun", mtu: 1500, addresses: [address, prefix("198.18.0.1", 24)], routes: [], resolver: nil) }
            rejects("wrong plan projection digest refuses even self-consistent effects") { try projection.verify(plan: plan(String(repeating: "e", count: 64)), effects: effects) }
            rejects("route plan cannot claim per-key Darwin deletion recovery") { try projection.verify(plan: plan(policy: .perKey), effects: effects) }
            let injected = try Effects.Route(destination: route.destination, gateway: .init(family: .ipv4, value: "198.18.0.2"),
                interface: device.interface, scopeIndex: 0, flags: UInt32(RTF_UP | RTF_STATIC | RTF_GATEWAY), hopCount: 0)
            let modified = try Effects.EffectSet(planID: planID, device: device, effects: [.route(injected)] + effects.effects.dropFirst())
            rejects("same lookup key cannot replace approved interface route with a gateway") { try projection.verify(plan: plan(), effects: modified) }
            rejects("omitted effect cannot pass mapping verification") { try projection.verify(plan: plan(), effects: .init(planID: planID, device: device, effects: Array(effects.effects.dropLast()))) }
            rejects("reordering realized effects cannot bypass exact mapping") { try projection.verify(plan: plan(), effects: .init(planID: planID, device: device, effects: effects.effects.reversed())) }
            let foreign = try Effects.Route(destination: route.destination, gateway: nil, interface: .init(name: "en0", index: 2), scopeIndex: 0, flags: UInt32(RTF_UP | RTF_STATIC), hopCount: 0)
            rejects("foreign interface route cannot be substituted") { try projection.verify(plan: plan(), effects: .init(planID: planID, device: device, effects: [.route(foreign)] + effects.effects.dropFirst())) }
            var raw = try JSONSerialization.jsonObject(with: projection.encoded()) as! [String: Any]
            func decode(_ item: [String: Any]) throws { _ = try Projection.decode(JSONSerialization.data(withJSONObject: item, options: [.sortedKeys])) }
            for key in ["version", "device", "mtu", "addresses", "routes", "resolver"] {
                var missing = raw; missing.removeValue(forKey: key)
                rejects("missing required projection field refuses: \(key)") { try decode(missing) }
            }
            for key in ["path", "gateway", "flags", "FD", "authorized", "interfaceIndex"] {
                var extra = raw; extra[key] = 1
                rejects("untrusted extra setup authority refuses: \(key)") { try decode(extra) }
            }
            for value: Any in [true, -1, 1.5, "1500", 1279, 65536, UInt64(UInt32.max) + 1] {
                var changed = raw; changed["mtu"] = value
                rejects("MTU type/range is enforced: \(value)") { try decode(changed) }
            }
            for value in ["en0", "utun01", "utun4294967295", "utun4/other", "utun4\0"] {
                var changed = raw; changed["device"] = value
                rejects("noncanonical or foreign requested device refuses: \(value.debugDescription)") { try decode(changed) }
            }
            for value: Any in [0, 1, "true", NSNull()] {
                var changed = raw; changed["routes"] = [["destination": route.destination.json, "scoped": value]]
                rejects("scoped requires JSON Boolean: \(value)") { try decode(changed) }
            }
            var changed = raw; changed["routes"] = [route.json, route.json]
            rejects("duplicate lookup key refuses before realization") { try decode(changed) }
            changed = raw; changed["routes"] = [["destination": try prefix("192.0.2.1", 24).json, "scoped": false]]
            rejects("route with host bits refuses") { try decode(changed) }
            var badResolver = resolver.json; badResolver["key"] = "State:/Network/Global/DNS"
            changed = raw; changed["resolver"] = badResolver
            rejects("caller cannot choose a resolver key") { try decode(changed) }
            badResolver = resolver.json; badResolver["servers"] = [resolver.servers[0].json, resolver.servers[0].json]
            changed = raw; changed["resolver"] = badResolver
            rejects("duplicate DNS servers refuse") { try decode(changed) }
            badResolver = resolver.json; badResolver["searchDomains"] = [""]
            changed = raw; changed["resolver"] = badResolver
            rejects("empty search domain refuses") { try decode(changed) }
            let maximumRoutes = try (0..<128).map { index in try Projection.RouteRequest(destination: prefix("192.0.2.\(index)", 32), scoped: false) }
            let maximum = try Projection(device: "utun", mtu: 1500, addresses: [], routes: maximumRoutes, resolver: nil)
            check("maximum 128 exact interface route effects are accepted within byte budget", try maximum.realize(planID: planID, device: observed(addresses: [automatic])).effects.count == 128)
            rejects("resolver plus 128 routes cannot exceed total effect limit") { _ = try Projection(device: "utun", mtu: 1500, addresses: [], routes: maximumRoutes, resolver: resolver) }
            let manyAddresses = try (1...17).map { try prefix("198.18.0.\($0)", 32) }
            rejects("address count is bounded independently") { _ = try Projection(device: "utun", mtu: 1500, addresses: manyAddresses, routes: [], resolver: nil) }
            let text = String(data: projection.encoded(), encoding: .utf8)!
            rejects("escaped duplicate field names refuse before Foundation decoding") { _ = try Projection.decode(Data(text.replacingOccurrences(of: "\"mtu\":1500", with: "\"mtu\":1500,\"mt\\u0075\":1500").utf8)) }
            rejects("oversized JSON refuses before decoding") { _ = try Projection.decode(Data(repeating: 32, count: Projection.maximumBytes + 1)) }
            rejects("truncated JSON cannot become empty setup") { _ = try Projection.decode(projection.encoded().prefix(40)) }
            raw["resolver"] = NSNull()
            check("explicit null resolver represents no DNS effect", try Projection.decode(JSONSerialization.data(withJSONObject: raw)).resolver == nil)
        } catch { checks.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failures = checks.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failures == 0, "checksPassed": checks.count - failures, "checksTotal": checks.count,
            "actualNetworkConfigurationChanged": false, "actualTunCreated": false, "rootExecuted": false, "checks": checks]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failures != 0 { exit(1) }
    }
}
