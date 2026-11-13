import Foundation
import Darwin

/// Isolated proofs for the strict environment baseline inspector. Every
/// source is injected: no getifaddrs, route sysctl, SCDynamicStore, socket,
/// root path or network state is touched by these checks.
private typealias Effects = RelayTunNetworkEffects
private typealias Inspector = RelayTunEnvironmentInspector
private typealias Interface = Inspector.InterfaceObservation
private typealias Address = Inspector.AddressObservation
private enum Injected: Error { case failed }

private func route(destination: String, prefix: UInt32, family: Effects.Address.Family = .ipv4,
                   interface: Effects.Interface, gateway: String?, flags: UInt32, scope: UInt32 = 0) throws -> Effects.Route {
    let value = try Effects.Prefix(address: try .init(family: family, value: destination), length: prefix)
    let via = try gateway.map { try Effects.Address(family: family, value: $0) }
    return try .init(destination: value, gateway: via, interface: interface, scopeIndex: scope,
                     flags: flags, hopCount: 0)
}
private func frame(_ value: Effects.Route) throws -> Data {
    try RelayTunRouteProjection.request(value, operation: .get, pid: 0, sequence: 0, interfaceType: 249)
}
/// Valid frame bytes with an extra kernel flag patched in (e.g. RTF_LLINFO),
/// which the projection encoder deliberately refuses to emit.
private func frame(_ value: Effects.Route, adding rawFlag: Int32) throws -> Data {
    var bytes = try frame(value)
    var header = rt_msghdr()
    withUnsafeMutableBytes(of: &header) { $0.copyBytes(from: bytes.prefix($0.count)) }
    header.rtm_flags |= rawFlag
    withUnsafeBytes(of: header) { bytes.replaceSubrange(0..<$0.count, with: $0) }
    return bytes
}
private func sources(interfaces: [Interface], routes: [Effects.Address.Family: Data],
                     dns: [(String, Any)], proxies: [(String, Any)]) -> Inspector.Sources {
    .init(interfaces: { interfaces }, routes: { family in routes[family] ?? Data() },
          dns: { dns }, proxies: { proxies })
}
private let en0 = try! Effects.Interface(name: "en0", index: 4)
private let utun = try! Effects.Interface(name: "utun42", index: 91)
private let ownedIdentity = try! Effects.DeviceIdentity(id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    interface: utun, controlID: 17, controlUnit: 43, socketDevice: 7, socketInode: 0, mtu: 1500, addresses: [])

private var baseInterfaces: [Interface] {
    [Interface(name: "en0", index: 4, type: 6, flags: 34883, mtu: 1500,
               addresses: [Address(family: "inet", value: "192.168.1.2", prefix: 24)]),
     Interface(name: "utun42", index: 91, type: 249, flags: 34883, mtu: 1500,
               addresses: [Address(family: "inet", value: "198.18.0.1", prefix: 30)])]
}
private let ownedPrefix = Inspector.ownedServicePrefix + "8403621c-dafa-42e5-b5ba-bf10e07e7776"
private func baseRoutes() throws -> [Effects.Address.Family: Data] {
    let direct = try frame(route(destination: "192.168.1.0", prefix: 24, interface: en0, gateway: nil, flags: UInt32(RTF_UP | RTF_STATIC)))
    let tunneled = try frame(route(destination: "198.18.0.0", prefix: 30, interface: utun, gateway: nil, flags: UInt32(RTF_UP | RTF_STATIC)))
    let v6 = try frame(route(destination: "2001:db8::", prefix: 32, family: .ipv6, interface: en0, gateway: nil,
                             flags: UInt32(RTF_UP | RTF_STATIC)))
    return [.ipv4: direct + tunneled, .ipv6: v6]
}
private var baseDNS: [(String, Any)] {
    [("State:/Network/Global/DNS", ["SearchDomains": ["lan"], "ServerAddresses": ["192.168.1.1"]]),
     (ownedPrefix + "/DNS", ["ServerAddresses": ["198.18.0.2"], "SupplementalMatchDomains": [""]])]
}
private var baseProxies: [(String, Any)] {
    [("State:/Network/Global/Proxies", ["HTTPEnable": 0, "HTTPSEnable": 0, "ExceptionsList": ["*.local"]]),
     (ownedPrefix + "/Proxies", ["HTTPEnable": 1, "HTTPPort": 7890, "HTTPProxy": "127.0.0.1"])]
}

@main struct RelayTunEnvironmentInspectorTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ condition: @autoclosure () throws -> Bool, _ name: String) {
            do { rows.append(["name": name, "passed": try condition()]) }
            catch { rows.append(["name": name, "passed": false, "error": String(reflecting: error)]) }
        }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": false]) }
            catch { rows.append(["name": name, "passed": true]) }
        }
        func baseline(_ owned: Effects.DeviceIdentity?, interfaces: [Interface] = baseInterfaces,
                      routes: [Effects.Address.Family: Data]? = nil, dns: [(String, Any)] = baseDNS,
                      proxies: [(String, Any)] = baseProxies) throws -> EffectsBaseline {
            try Inspector.baseline(owned: owned, sources: sources(interfaces: interfaces,
                routes: routes ?? baseRoutes(), dns: dns, proxies: proxies))
        }
        typealias EffectsBaseline = RelayTunNetworkTransaction.Baseline
        do {
            let full = try baseline(nil), again = try baseline(nil)
            check(full.networkSHA256 == again.networkSHA256 && full.protectionSHA256 == again.protectionSHA256
                  && Effects.digest(full.networkSHA256) && Effects.digest(full.protectionSHA256),
                  "identical injected state yields identical digests")
            let cleanInterfaces = [baseInterfaces[0]]
            let cleanRoutes: [Effects.Address.Family: Data] = [.ipv4: try frame(route(destination: "192.168.1.0", prefix: 24, interface: en0, gateway: nil, flags: UInt32(RTF_UP | RTF_STATIC))), .ipv6: try frame(route(destination: "2001:db8::", prefix: 32, family: .ipv6, interface: en0, gateway: nil, flags: UInt32(RTF_UP | RTF_STATIC)))]
            let cleanDNS = baseDNS.filter { !$0.0.hasPrefix(Inspector.ownedServicePrefix) }
            let cleanProxies = baseProxies.filter { !$0.0.hasPrefix(Inspector.ownedServicePrefix) }
            let clean = try baseline(nil, interfaces: cleanInterfaces, routes: cleanRoutes, dns: cleanDNS, proxies: cleanProxies)
            let excluded = try baseline(ownedIdentity)
            check(excluded == clean,
                  "excluding the owned interface, its routes and service keys reproduces the untouched baseline")
            let emptyOwned = try baseline(nil, interfaces: cleanInterfaces, routes: cleanRoutes, dns: cleanDNS, proxies: cleanProxies)
            check(emptyOwned == clean, "baseline without owned state is order independent and repeatable")

            let changed = [Interface(name: baseInterfaces[0].name, index: baseInterfaces[0].index,
                type: baseInterfaces[0].type, flags: baseInterfaces[0].flags, mtu: 1400,
                addresses: baseInterfaces[0].addresses), baseInterfaces[1]]
            let mtu = try baseline(nil, interfaces: changed)
            check(mtu.networkSHA256 != full.networkSHA256 && mtu.protectionSHA256 == full.protectionSHA256,
                  "an unrelated MTU change stays visible in the network digest only")
            let extra = cleanRoutes.merging([.ipv4: (cleanRoutes[.ipv4] ?? Data()) + (try frame(route(destination: "10.0.0.0", prefix: 8, interface: en0, gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY))))]) { _, new in new }
            let added = try baseline(nil, interfaces: cleanInterfaces, routes: extra, dns: cleanDNS, proxies: cleanProxies)
            check(added.networkSHA256 != clean.networkSHA256, "an unrelated added route stays visible")
            var differentGateway = cleanRoutes
            differentGateway[.ipv6] = try frame(route(destination: "2001:db8::", prefix: 32, family: .ipv6,
                                              interface: en0, gateway: "2001:db8::1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)))
            let moved = try baseline(nil, interfaces: cleanInterfaces, routes: differentGateway, dns: cleanDNS, proxies: cleanProxies)
            check(moved.networkSHA256 != clean.networkSHA256, "an unrelated gateway change stays visible")
            var dnsChanged = cleanDNS; dnsChanged[0] = ("State:/Network/Global/DNS", ["SearchDomains": ["lan"], "ServerAddresses": ["192.168.1.254"]])
            let dns = try baseline(nil, interfaces: cleanInterfaces, routes: cleanRoutes, dns: dnsChanged, proxies: cleanProxies)
            check(dns.networkSHA256 != clean.networkSHA256 && dns.protectionSHA256 == clean.protectionSHA256,
                  "a DNS change stays visible without touching protection")
            var proxyChanged = cleanProxies; proxyChanged[0] = ("State:/Network/Global/Proxies", ["HTTPEnable": 1, "HTTPSEnable": 0, "ExceptionsList": ["*.local"]])
            let proxy = try baseline(nil, interfaces: cleanInterfaces, routes: cleanRoutes, dns: cleanDNS, proxies: proxyChanged)
            check(proxy.protectionSHA256 != clean.protectionSHA256 && proxy.networkSHA256 == clean.networkSHA256,
                  "a proxy change stays visible in the protection digest only")
            let llRoutes = cleanRoutes.merging([.ipv4: (cleanRoutes[.ipv4] ?? Data()) + (try frame(route(destination: "192.168.1.3", prefix: 32, interface: en0, gateway: nil, flags: UInt32(RTF_UP | RTF_STATIC)), adding: RTF_LLINFO))]) { _, new in new }
            let neighbor = try baseline(nil, interfaces: cleanInterfaces, routes: llRoutes, dns: cleanDNS, proxies: cleanProxies)
            check(neighbor == clean, "neighbor-cache link entries are not network configuration")

            // The two observed Darwin cache states from the private raw-frame
            // acceptance captures. Only public documentation addresses are used
            // here; the original bounded dumps are retained as private evidence.
            let parent = try frame(route(destination: "0.0.0.0", prefix: 0, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)),
                adding: RTF_PRCLONING | RTF_GLOBAL)
            let cacheBase = try route(destination: "203.0.113.9", prefix: 32, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_IFSCOPE), scope: en0.index)
            let cloneA = try frame(cacheBase, adding: RTF_WASCLONED | RTF_IFREF | RTF_GLOBAL)
            let cloneB = try frame(cacheBase, adding: RTF_WASCLONED | RTF_PROTO3 | RTF_GLOBAL)
            func routeBaseline(_ frames: Data) throws -> EffectsBaseline {
                try baseline(nil, interfaces: cleanInterfaces, routes: [.ipv4: frames], dns: cleanDNS, proxies: cleanProxies)
            }
            let parentOnly = try routeBaseline(parent)
            check(try routeBaseline(parent + cloneA) == parentOnly, "a positively covered scoped host cache is redundant")
            check(try routeBaseline(cloneB + parent) == parentOnly, "observed IFREF to PROTO3 cache churn leaves the baseline unchanged")
            check(try routeBaseline(parent + cloneA + cloneB) == parentOnly, "cache addition, duplication and expiry do not change the covered parent baseline")
            check(try routeBaseline(cloneA) != routeBaseline(Data()), "a clone without a positive parent stays visible")
            let movedParent = try frame(route(destination: "0.0.0.0", prefix: 0, interface: en0,
                gateway: "192.168.1.254", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)))
            check(try routeBaseline(movedParent + cloneA) != routeBaseline(movedParent), "a changed parent gateway cannot cover the old cache path")
            check(try routeBaseline(movedParent) != parentOnly, "a parent path change remains a baseline change")
            let specific = try frame(route(destination: "203.0.113.0", prefix: 24, interface: en0,
                gateway: "192.168.1.254", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)))
            check(try routeBaseline(parent + specific + cloneA) != routeBaseline(parent + specific), "a matching default cannot hide a conflicting more-specific path")
            let sameSpecific = try frame(route(destination: "203.0.113.0", prefix: 24, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)))
            check(try routeBaseline(parent + sameSpecific + cloneB) == routeBaseline(parent + sameSpecific), "the complete longest-prefix path can positively cover its cache")
            let abnormalSpecificClone = try frame(route(destination: "203.0.113.0", prefix: 24, interface: en0,
                gateway: "192.168.1.254", flags: UInt32(RTF_UP | RTF_GATEWAY)), adding: RTF_WASCLONED)
            check(try routeBaseline(parent + abnormalSpecificClone + cloneA) != routeBaseline(parent + abnormalSpecificClone),
                  "an abnormal more-specific clone blocks a default-parent coverage claim")
            let conflictingClone = try frame(route(destination: "203.0.113.9", prefix: 32, interface: en0,
                gateway: "192.168.1.254", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_IFSCOPE), scope: en0.index), adding: RTF_WASCLONED | RTF_IFREF | RTF_GLOBAL)
            check(try routeBaseline(parent + cloneA + conflictingClone) != routeBaseline(parent + conflictingClone),
                  "conflicting same-key cache paths are all retained")
            let staticClone = try frame(cacheBase, adding: RTF_WASCLONED | RTF_STATIC)
            check(try routeBaseline(parent + staticClone + cloneA) != routeBaseline(parent + staticClone),
                  "an anomalous same-key clone blocks another cache from being hidden")
            let scoped24B = try frame(route(destination: "203.0.113.0", prefix: 24, interface: en0,
                gateway: "192.168.1.254", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC | RTF_IFSCOPE), scope: en0.index))
            let unscoped25A = try frame(route(destination: "203.0.113.0", prefix: 25, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)))
            check(try routeBaseline(scoped24B + unscoped25A + cloneA) != routeBaseline(scoped24B + unscoped25A),
                  "a longer unscoped path cannot override a conflicting scoped parent in the coverage proof")
            let scoped25A = try frame(route(destination: "203.0.113.0", prefix: 25, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC | RTF_IFSCOPE), scope: en0.index))
            check(try routeBaseline(scoped25A + specific + cloneA) != routeBaseline(scoped25A + specific),
                  "a longer scoped path cannot hide a conflicting unscoped parent in the coverage proof")
            check(try routeBaseline(scoped25A + sameSpecific + cloneA) == routeBaseline(scoped25A + sameSpecific),
                  "different scope prefix lengths can cover a cache only when every selected path agrees")
            let hostParent = try frame(route(destination: "203.0.113.9", prefix: 32, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_STATIC)))
            check(try routeBaseline(parent + hostParent + cloneA) != routeBaseline(parent + hostParent), "a same-key host route is never treated as a cache parent")
            let otherInterface = try frame(route(destination: "0.0.0.0", prefix: 0, interface: utun,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)))
            check(try routeBaseline(otherInterface + cloneA) != routeBaseline(otherInterface), "a parent on another interface cannot cover a cache")
            check(try routeBaseline(parent + otherInterface + cloneA) != routeBaseline(parent + otherInterface), "ambiguous longest-prefix parents never hide a cache")
            let missingInterface = try Effects.Interface(name: "utun65000", index: 65000)
            let unresolvedParent = try frame(route(destination: "0.0.0.0", prefix: 0, interface: missingInterface,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)))
            let unresolvedClone = try frame(route(destination: "203.0.113.9", prefix: 32, interface: missingInterface,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_IFSCOPE), scope: missingInterface.index), adding: RTF_WASCLONED)
            check(try routeBaseline(unresolvedParent + unresolvedClone) != routeBaseline(unresolvedParent), "an unresolved interface identity cannot cover a cache")
            let scopedOther = try frame(route(destination: "0.0.0.0", prefix: 0, interface: utun,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC | RTF_IFSCOPE), scope: utun.index))
            check(try routeBaseline(scopedOther + cloneA) != routeBaseline(scopedOther), "an inapplicable scope cannot cover a cache")
            let untrustedParent = try frame(route(destination: "0.0.0.0", prefix: 0, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY)))
            check(try routeBaseline(untrustedParent + cloneA) != routeBaseline(untrustedParent), "a parent lacking stable STATIC semantics cannot cover a cache")
            let unrelatedParent = try frame(route(destination: "198.51.100.0", prefix: 24, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)))
            check(try routeBaseline(unrelatedParent + cloneA) != routeBaseline(unrelatedParent), "a parent outside the destination prefix cannot cover a cache")
            for (name, flag) in [("reject", RTF_REJECT), ("blackhole", RTF_BLACKHOLE),
                                  ("redirect", RTF_DYNAMIC), ("modified", RTF_MODIFIED), ("unknown", RTF_PROTO2)] {
                let abnormalParent = try frame(route(destination: "0.0.0.0", prefix: 0, interface: en0,
                    gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC)), adding: flag)
                check(try routeBaseline(abnormalParent + cloneA) != routeBaseline(abnormalParent), "a parent with \(name) semantics cannot cover a cache")
            }
            for (name, flag) in [("static", RTF_STATIC), ("reject", RTF_REJECT), ("blackhole", RTF_BLACKHOLE),
                                  ("redirect", RTF_DYNAMIC), ("modified", RTF_MODIFIED), ("unknown", RTF_PROTO2)] {
                let abnormal = try frame(cacheBase, adding: RTF_WASCLONED | flag)
                check(try routeBaseline(parent + abnormal) != parentOnly, "a cache with \(name) semantics stays visible")
            }
            let unscoped = try frame(route(destination: "203.0.113.9", prefix: 32, interface: en0,
                gateway: "192.168.1.1", flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST)), adding: RTF_WASCLONED)
            check(try routeBaseline(parent + unscoped) != parentOnly, "an unscoped clone is outside the positively observed cache subset")

            func observed(_ family: String = "ipv4", destination: String = "203.0.113.9", prefix: UInt32 = 32,
                          gateway: String = "192.0.2.1", kind: String = "ip", name: String = "en0",
                          index: UInt32 = 4, scope: UInt32 = 4, flags: UInt32 = 3) -> Inspector.RouteObservation {
                .init(family: family, destination: destination, prefix: prefix, gateway: gateway, gatewayKind: kind,
                      interfaceName: name, interfaceIndex: index, scopeIndex: scope, flags: flags)
            }
            let orderRows = [observed(), observed("ipv6", destination: "ff00::", prefix: 128,
                gateway: "fe80::1", name: "utun0", index: 90, scope: 90, flags: 99),
                observed(destination: "198.51.100.0", prefix: 24, gateway: "192.0.2.0", name: "bridge0", index: 2, scope: 0, flags: 1),
                observed(index: 5), observed(kind: "link"), observed(gateway: "192.0.2.2"), observed(flags: 4)]
            let less = Inspector.testRouteLess
            check(orderRows.allSatisfy { !less($0, $0) }, "route ordering is irreflexive")
            check(orderRows.allSatisfy { a in orderRows.allSatisfy { b in !less(a, b) || !less(b, a) } }, "route ordering is asymmetric")
            check(orderRows.allSatisfy { a in orderRows.allSatisfy { b in orderRows.allSatisfy { c in
                !(less(a, b) && less(b, c)) || less(a, c)
            } } }, "route ordering is transitive across families, scope, flags and gateway")
            check(orderRows.allSatisfy { a in orderRows.allSatisfy { b in a == b || less(a, b) || less(b, a) } }, "all distinct serialized route fields have a strict tie break")
            let ordered = orderRows.sorted(by: less)
            check(Array(orderRows.reversed()).sorted(by: less) == ordered &&
                  Array(orderRows[2...] + orderRows[..<2]).sorted(by: less) == ordered,
                  "route permutations yield the same complete order")

            let shuffled = try baseline(nil, interfaces: [baseInterfaces[1], baseInterfaces[0]],
                routes: [.ipv6: baseRoutes()[.ipv6]!, .ipv4: baseRoutes()[.ipv4]!],
                dns: [baseDNS[1], baseDNS[0]], proxies: [baseProxies[1], baseProxies[0]])
            check(shuffled == full, "collection order never changes the consent digest")
            let boolProxy: [(String, Any)] = [("State:/Network/Global/Proxies", ["HTTPEnable": true])]
            let numberProxy: [(String, Any)] = [("State:/Network/Global/Proxies", ["HTTPEnable": 1])]
            check(try baseline(nil, interfaces: [], routes: [:], dns: [], proxies: boolProxy).protectionSHA256
                  != baseline(nil, interfaces: [], routes: [:], dns: [], proxies: numberProxy).protectionSHA256,
                  "boolean and numeric proxy values are distinct observations")
            rejects("a malformed route frame fails the whole baseline") {
                _ = try baseline(nil, interfaces: cleanInterfaces, routes: [.ipv4: Data([0, 1, 2, 3]), .ipv6: Data()], dns: cleanDNS, proxies: cleanProxies)
            }
            rejects("a route dump from the wrong family fails the baseline") {
                _ = try baseline(nil, interfaces: cleanInterfaces, routes: [.ipv4: baseRoutes()[.ipv6]!, .ipv6: Data()], dns: cleanDNS, proxies: cleanProxies)
            }
            rejects("an unsupported plist value fails the baseline instead of dropping it") {
                _ = try baseline(nil, interfaces: cleanInterfaces, routes: cleanRoutes, dns: [("State:/Network/Global/DNS", ["bad": Date()])], proxies: cleanProxies)
            }
            rejects("an oversized route dump fails the baseline") {
                _ = try baseline(nil, interfaces: cleanInterfaces, routes: [.ipv4: Data(count: InspectorRouteDumpLimit + 1), .ipv6: Data()], dns: cleanDNS, proxies: cleanProxies)
            }
        } catch { rows.append(["name": "fixture setup", "passed": false, "error": String(reflecting: error)]) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "actualInterfaceRead": false, "actualRouteDumpRead": false, "actualDynamicStoreRead": false,
            "actualNetworkChanged": false, "actualTunAccepted": false]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
        exit(rows.count == passed ? 0 : 1)
    }
}
private let InspectorRouteDumpLimit = RelayTunRouteObservation.maximumBytes
