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
            var loopbackLink = Data([11, UInt8(AF_LINK), 1, 0, 24, 3, 0, 0, 108, 111, 48, 17])
            let loopbackIdentity = try loopbackLink.withUnsafeBytes { try Inspector.linkIdentity($0) }
            check(loopbackIdentity.index == 1 && loopbackIdentity.type == 24,
                  "link identity uses the SDK type field instead of trailing padding")
            loopbackLink[11] = 34
            check(try loopbackLink.withUnsafeBytes { try Inspector.linkIdentity($0).type } == loopbackIdentity.type,
                  "bytes beyond the declared link address do not change its type")
            var ethernetLink = Data([17, UInt8(AF_LINK), 4, 0, 6, 3, 6, 0, 101, 110, 48, 98, 0, 0, 0, 0, 1])
            check(try ethernetLink.withUnsafeBytes { try Inspector.linkIdentity($0).type } == 6,
                  "Ethernet identity reads its type rather than the first MAC byte")
            ethernetLink[11] = 170
            check(try ethernetLink.withUnsafeBytes { try Inspector.linkIdentity($0).type } == 6,
                  "a link address payload change does not become an interface type change")
            check(try loopbackLink.prefix(11).withUnsafeBytes { try Inspector.linkIdentity($0).type } == 24,
                  "an exact short sockaddr_dl is decoded without reading a full struct or padding")
            let shortLink = UnsafeMutableRawPointer.allocate(byteCount: 11, alignment: 1)
            defer { shortLink.deallocate() }
            loopbackLink.withUnsafeBytes { shortLink.copyMemory(from: $0.baseAddress!, byteCount: 11) }
            check(try Inspector.linkIdentity(UnsafeRawBufferPointer(start: shortLink, count: 11)).type == 24,
                  "an exact 11-byte allocation is decoded without an out-of-bounds read")
            for (name, bytes) in [
                ("empty", Data()), ("short header", Data(loopbackLink.prefix(7))),
                ("wrong family", Data([11, UInt8(AF_INET), 1, 0, 24, 3, 0, 0, 108, 111, 48])),
                ("short declared length", Data([7, UInt8(AF_LINK), 1, 0, 24, 0, 0, 0])),
                ("truncated payload", Data([12, UInt8(AF_LINK), 1, 0, 24, 3, 0, 0, 108, 111, 48])),
                ("oversized name", Data([8, UInt8(AF_LINK), 1, 0, 24, 255, 0, 0])),
                ("oversized address", Data([8, UInt8(AF_LINK), 1, 0, 24, 0, 255, 0])),
                ("oversized selector", Data([8, UInt8(AF_LINK), 1, 0, 24, 0, 0, 255]))
            ] {
                rejects("invalid link metadata is rejected: \(name)") {
                    _ = try bytes.withUnsafeBytes { try Inspector.linkIdentity($0) }
                }
            }
            let full = try baseline(nil), again = try baseline(nil)
            check(full.networkSHA256 == again.networkSHA256 && full.protectionSHA256 == again.protectionSHA256
                  && Effects.digest(full.networkSHA256) && Effects.digest(full.protectionSHA256),
                  "identical injected state yields identical digests")
            let changedType = Interface(name: baseInterfaces[0].name, index: baseInterfaces[0].index,
                type: 24, flags: baseInterfaces[0].flags, mtu: baseInterfaces[0].mtu,
                addresses: baseInterfaces[0].addresses)
            check(try baseline(nil, interfaces: [changedType, baseInterfaces[1]]).networkSHA256 != full.networkSHA256,
                  "a real interface type change stays visible")
            let changedFlags = Interface(name: baseInterfaces[0].name, index: baseInterfaces[0].index,
                type: baseInterfaces[0].type, flags: baseInterfaces[0].flags ^ UInt32(IFF_OACTIVE),
                mtu: baseInterfaces[0].mtu, addresses: baseInterfaces[0].addresses)
            check(try baseline(nil, interfaces: [changedFlags, baseInterfaces[1]]).networkSHA256 != full.networkSHA256,
                  "interface flags remain fully visible after correcting link type decoding")
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

            // Darwin IPv6 router-advertisement parents are PRCLONING without
            // STATIC; their scoped /128 cache children have the same observed
            // IFREF/PROTO3 churn as IPv4. Keep a separate parent proof.
            let ipv6ParentFlags = UInt32(RTF_UP | RTF_GATEWAY | RTF_PRCLONING | RTF_GLOBAL)
            func ipv6Frame(_ destination: String, prefix: UInt32, gateway: String = "2001:db8::1",
                           flags: UInt32, scope: UInt32 = 0, interface: Effects.Interface = en0) throws -> Data {
                try frame(route(destination: destination, prefix: prefix, family: .ipv6, interface: interface,
                    gateway: gateway, flags: flags & ~UInt32(RTF_PRCLONING | RTF_GLOBAL | RTF_WASCLONED | RTF_IFREF | RTF_PROTO3), scope: scope),
                    adding: Int32(bitPattern: flags & UInt32(RTF_PRCLONING | RTF_GLOBAL | RTF_WASCLONED | RTF_IFREF | RTF_PROTO3)))
            }
            // Preserve the route's real scope through the encoder.
            func ipv6ScopedFrame(_ gateway: String = "2001:db8::1", extra: Int32 = RTF_IFREF,
                                 flags: UInt32 = UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_IFSCOPE)) throws -> Data {
                try frame(route(destination: "2001:db8:1234::9", prefix: 128, family: .ipv6,
                    interface: en0, gateway: gateway, flags: flags, scope: en0.index),
                    adding: RTF_WASCLONED | RTF_GLOBAL | extra)
            }
            func ipv6Baseline(_ frames: Data) throws -> EffectsBaseline {
                try baseline(nil, interfaces: cleanInterfaces, routes: [.ipv6: frames], dns: cleanDNS, proxies: cleanProxies)
            }
            let v6Parent = try ipv6Frame("::", prefix: 0, flags: ipv6ParentFlags)
            let v6CloneA = try ipv6ScopedFrame(), v6CloneB = try ipv6ScopedFrame(extra: RTF_PROTO3)
            let v6ParentOnly = try ipv6Baseline(v6Parent)
            check(try ipv6Baseline(v6Parent + v6CloneA) == v6ParentOnly,
                  "IPv6 PRCLONING parent positively covers its scoped host cache")
            check(try ipv6Baseline(v6CloneB + v6Parent) == v6ParentOnly,
                  "IPv6 observed IFREF to PROTO3 cache churn leaves the baseline unchanged")
            check(try ipv6Baseline(v6Parent + v6CloneA + v6CloneB) == v6ParentOnly,
                  "IPv6 covered cache addition duplication and expiry leave the baseline unchanged")

            func observed(_ family: String = "ipv4", destination: String = "203.0.113.9", prefix: UInt32 = 32,
                          gateway: String = "192.0.2.1", kind: String = "ip", name: String = "en0",
                          index: UInt32 = 4, scope: UInt32 = 4, flags: UInt32 = 3) -> Inspector.RouteObservation {
                .init(family: family, destination: destination, prefix: prefix, gateway: gateway, gatewayKind: kind,
                      interfaceName: name, interfaceIndex: index, scopeIndex: scope, flags: flags)
            }
            let v6CacheFlags = UInt32(RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_IFSCOPE | RTF_WASCLONED | RTF_IFREF | RTF_GLOBAL)
            func v6Observed(_ destination: String = "2001:db8:1234::9", prefix: UInt32 = 128,
                            gateway: String = "fe80::1%4", name: String = "en0", index: UInt32 = 4,
                            scope: UInt32 = 4, flags: UInt32? = nil) -> Inspector.RouteObservation {
                observed("ipv6", destination: destination, prefix: prefix, gateway: gateway, name: name,
                    index: index, scope: scope, flags: flags ?? v6CacheFlags)
            }
            let v6Default = v6Observed("::", prefix: 0, scope: 0, flags: ipv6ParentFlags)
            let v6Child = v6Observed(), normalizeV6 = Inspector.testNormalizeIPv6Cache
            check(normalizeV6([v6Default, v6Child]) == [v6Default], "IPv6 matching numeric gateway zones remain bound to the interface")
            check(normalizeV6([v6Child]) == [v6Child], "IPv6 cache without a positive parent stays visible")
            for (name, flag) in [("static", RTF_STATIC), ("reject", RTF_REJECT), ("blackhole", RTF_BLACKHOLE),
                                 ("redirect", RTF_DYNAMIC), ("modified", RTF_MODIFIED), ("unknown", RTF_PROTO2)] {
                let child = v6Observed(flags: v6CacheFlags | UInt32(flag))
                check(normalizeV6([v6Default, child]) == [v6Default, child], "IPv6 cache with \(name) semantics stays visible")
                check(normalizeV6([v6Default, child, v6Child]) == [v6Default, child, v6Child],
                      "IPv6 anomalous same-key \(name) host blocks another cache from being hidden")
            }
            for (name, flag) in [("reject", RTF_REJECT), ("blackhole", RTF_BLACKHOLE), ("redirect", RTF_DYNAMIC),
                                 ("modified", RTF_MODIFIED), ("unknown", RTF_PROTO2)] {
                let parent = v6Observed("::", prefix: 0, scope: 0, flags: ipv6ParentFlags | UInt32(flag))
                check(normalizeV6([parent, v6Child]) == [parent, v6Child], "IPv6 parent with \(name) semantics cannot cover a cache")
            }
            let noCloning = v6Observed("::", prefix: 0, scope: 0, flags: UInt32(RTF_UP | RTF_GATEWAY | RTF_STATIC))
            check(normalizeV6([noCloning, v6Child]) == [noCloning, v6Child], "IPv6 STATIC without positive PRCLONING evidence cannot cover a cache")
            let otherGateway = v6Observed(gateway: "fe80::2%4")
            check(normalizeV6([v6Default, v6Child, otherGateway]) == [v6Default, v6Child, otherGateway],
                  "IPv6 conflicting same-key cache paths are all retained")
            let wrongZoneParent = v6Observed("::", prefix: 0, gateway: "fe80::1%5", scope: 0, flags: ipv6ParentFlags)
            let wrongZoneChild = v6Observed(gateway: "fe80::1%5")
            check(normalizeV6([wrongZoneParent, wrongZoneChild]) == [wrongZoneParent, wrongZoneChild],
                  "IPv6 equal gateway strings naming another interface do not cover a cache")
            let embeddedParent = v6Observed("::", prefix: 0, gateway: "fe80:4::1", scope: 0, flags: ipv6ParentFlags)
            let embeddedChild = v6Observed(gateway: "fe80:4::1")
            check(normalizeV6([embeddedParent, embeddedChild]) == [embeddedParent], "IPv6 matching embedded zones stay bound to their interface")
            let conflictZoneParent = v6Observed("::", prefix: 0, gateway: "fe80:5::1%4", scope: 0, flags: ipv6ParentFlags)
            let conflictZoneChild = v6Observed(gateway: "fe80:5::1%4")
            check(normalizeV6([conflictZoneParent, conflictZoneChild]) == [conflictZoneParent, conflictZoneChild],
                  "IPv6 conflicting embedded and explicit zones stay visible")
            check(normalizeV6([v6Default, embeddedChild]) == [v6Default, embeddedChild],
                  "IPv6 gateway zone encodings are not erased to claim path equality")
            let moreSpecific = v6Observed("2001:db8:1234::", prefix: 65, gateway: "fe80::2%4", scope: 0, flags: ipv6ParentFlags)
            check(normalizeV6([v6Default, moreSpecific, v6Child]) == [v6Default, moreSpecific, v6Child],
                  "IPv6 non-byte longest prefix blocks a conflicting default-parent claim")
            let outsidePrefix = v6Observed("2001:db8:1234:0:8000::", prefix: 65, gateway: "fe80::2%4", scope: 0, flags: ipv6ParentFlags)
            check(normalizeV6([v6Default, outsidePrefix, v6Child]) == [v6Default, outsidePrefix],
                  "IPv6 nonmatching partial-byte prefix cannot override the applicable parent")
            let scopedConflict = v6Observed("2001:db8::", prefix: 32, gateway: "fe80::2%4", flags: ipv6ParentFlags | UInt32(RTF_IFSCOPE))
            let unscopedLonger = v6Observed("2001:db8:1234::", prefix: 64, scope: 0, flags: ipv6ParentFlags)
            check(normalizeV6([scopedConflict, unscopedLonger, v6Child]) == [scopedConflict, unscopedLonger, v6Child],
                  "IPv6 longer unscoped prefix cannot hide a conflicting scoped parent")
            let scopedLonger = v6Observed("2001:db8:1234::", prefix: 64, flags: ipv6ParentFlags | UInt32(RTF_IFSCOPE))
            let unscopedConflict = v6Observed("2001:db8::", prefix: 32, gateway: "fe80::2%4", scope: 0, flags: ipv6ParentFlags)
            check(normalizeV6([scopedLonger, unscopedConflict, v6Child]) == [scopedLonger, unscopedConflict, v6Child],
                  "IPv6 longer scoped prefix cannot hide a conflicting unscoped parent")
            check(normalizeV6([v6Default, scopedLonger, v6Child]) == [v6Default, scopedLonger],
                  "IPv6 independent scopes cover a cache only when all selected paths agree")
            let hostParent6 = v6Observed(scope: 0, flags: ipv6ParentFlags | UInt32(RTF_HOST))
            check(normalizeV6([v6Default, hostParent6, v6Child]) == [v6Default, hostParent6, v6Child],
                  "IPv6 same-key host route blocks a parent-cache claim")
            let secondDefault = v6Observed("::", prefix: 0, gateway: "fe80::2%4", scope: 0, flags: ipv6ParentFlags)
            check(normalizeV6([v6Default, secondDefault, v6Child]) == [v6Default, secondDefault, v6Child],
                  "IPv6 ambiguous longest-prefix parents stay visible")
            let otherInterfaceParent = v6Observed("::", prefix: 0, name: "en1", index: 5, scope: 0, flags: ipv6ParentFlags)
            check(normalizeV6([otherInterfaceParent, v6Child]) == [otherInterfaceParent, v6Child],
                  "IPv6 another interface cannot cover a cache with an equal gateway string")
            let unscopedChild6 = v6Observed(scope: 0, flags: v6CacheFlags & ~UInt32(RTF_IFSCOPE))
            check(normalizeV6([v6Default, unscopedChild6]) == [v6Default, unscopedChild6],
                  "IPv6 unscoped cache is outside the observed subset")
            let unresolved6 = v6Observed(name: "index-4")
            check(normalizeV6([v6Default, unresolved6]) == [v6Default, unresolved6],
                  "IPv6 unresolved interface cannot claim cache coverage")
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
