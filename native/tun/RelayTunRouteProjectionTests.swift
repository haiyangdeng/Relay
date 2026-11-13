import Foundation
import Darwin

private typealias Projection = RelayTunRouteProjection
private typealias Effects = RelayTunNetworkEffects
private enum Injected: Error { case lookup }

@main struct RelayTunRouteProjectionTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ condition: @autoclosure () throws -> Bool, _ name: String) {
            do { rows.append(["name": name, "passed": try condition()]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": false]) }
            catch { rows.append(["name": name, "passed": true]) }
        }
        func header(_ bytes: Data, change: (inout rt_msghdr) -> Void) -> Data {
            var value = rt_msghdr()
            withUnsafeMutableBytes(of: &value) { $0.copyBytes(from: bytes.prefix($0.count)) }
            change(&value)
            var output = bytes
            withUnsafeBytes(of: value) { output.replaceSubrange(0..<$0.count, with: $0) }
            return output
        }
        do {
            let interface = try Effects.Interface(name: "utun42", index: 91)
            func route(_ family: Effects.Address.Family, _ destination: String, _ prefix: UInt32,
                       _ gateway: String? = nil, scoped: Bool = false) throws -> Effects.Route {
                try .init(destination: .init(address: .init(family: family, value: destination), length: prefix),
                          gateway: gateway.map { try .init(family: family, value: $0) }, interface: interface,
                          scopeIndex: scoped ? interface.index : 0,
                          flags: 0x801 | (gateway == nil ? 0 : 2) | (prefix == (family == .ipv4 ? 32 : 128) ? 4 : 0) | (scoped ? 0x01000000 : 0), hopCount: 7)
            }
            let fixtures = try [route(.ipv4, "198.18.0.0", 30), route(.ipv4, "0.0.0.0", 0, "192.0.2.1"),
                                route(.ipv4, "203.0.113.8", 32, scoped: true), route(.ipv6, "fd00::", 126),
                                route(.ipv6, "::", 0, "2001:db8::1", scoped: true), route(.ipv6, "2001:db8::8", 128)]
            for (index, route) in fixtures.enumerated() {
                for operation in [Projection.Operation.add, .get] {
                    let bytes = try Projection.request(route, operation: operation, pid: 123, sequence: Int32(index + 1), interfaceType: 1)
                    var lookups: [UInt32] = []
                    let decoded = try Projection.decode(bytes, resolveInterface: { value in lookups.append(value); return interface })
                    let name = "fixture \(index) \(operation)"
                    check(decoded.route == route, "\(name) preserves network, gateway, interface, scope, flags and hop count")
                    check(decoded.operation == operation && decoded.pid == 123 && decoded.sequence == Int32(index + 1), "\(name) preserves reply correlation metadata")
                    check(!decoded.confirmed && decoded.interfaceType == 1 && decoded.suppliedInterfaceName == interface.name, "\(name) retains link metadata without inferring confirmation")
                    check(lookups == [interface.index], "\(name) resolves the exact index through the injected binding")
                }
            }
            let ordinary = fixtures[0]
            let bytes = try Projection.request(ordinary, operation: .get, pid: 123, sequence: 19, interfaceType: 249)
            let confirmed = header(bytes) { $0.rtm_flags = Int32(bitPattern: UInt32(bitPattern: $0.rtm_flags) | 0x40) }
            let acknowledgement = try Projection.decode(confirmed, resolveInterface: { _ in interface })
            check(acknowledgement.confirmed && acknowledgement.route == ordinary && acknowledgement.interfaceType == 249,
                  "DONE is retained as acknowledgement metadata while link type remains intact")
            // sockaddr_dl's fixed header is eight bytes; remove its optional
            // name and the old four-byte-aligned span from this direct gateway.
            let gatewayOffset = MemoryLayout<rt_msghdr>.size + MemoryLayout<sockaddr_in>.size
            let oldSpan = (Int(bytes[gatewayOffset]) + 3) & ~3
            var indexOnly = bytes, link = Data(bytes[gatewayOffset..<(gatewayOffset + 8)])
            link[0] = 8; link[5] = 0
            indexOnly.replaceSubrange(gatewayOffset..<(gatewayOffset + oldSpan), with: link)
            indexOnly = header(indexOnly) { $0.rtm_msglen = UInt16(indexOnly.count) }
            let resolved = try Projection.decode(indexOnly, resolveInterface: { _ in interface })
            check(resolved.route == ordinary && resolved.suppliedInterfaceName == nil && resolved.interfaceType == 249,
                  "an index-only gateway uses the independent interface binding without inventing supplied metadata")
            let device = try Effects.DeviceIdentity(id: "e861b728-c035-4fb8-9bee-17b3020360c5", interface: interface,
                controlID: 17, controlUnit: 43, socketDevice: 0, socketInode: 0, mtu: 1500, addresses: [])
            let planID = "b08a6eb3-f468-421c-865e-d736bc67b8ac"
            let before = try Effects.EffectSet(planID: planID, device: device, effects: [.route(ordinary)])
            let after = try Effects.EffectSet(planID: planID, device: device, effects: [.route(acknowledgement.route)])
            check(try before.sha256 == after.sha256 && before.changes() == after.changes(), "codec transport metadata cannot alter the bound typed recovery effect")

            rejects("a lookup failure remains an error") { _ = try Projection.decode(bytes, resolveInterface: { _ in throw Injected.lookup }) }
            rejects("a changed interface name cannot be adopted from the message") {
                _ = try Projection.decode(bytes, resolveInterface: { _ in try .init(name: "utun43", index: 91) })
            }
            rejects("a resolver cannot substitute another index with the same name") {
                _ = try Projection.decode(bytes, resolveInterface: { _ in try .init(name: "utun42", index: 92) })
            }
            var lookupCalls = 0
            for bad in [Data(), Data(repeating: 0, count: Int(RELAY_TUN_ROUTE_MAX_MESSAGE) + 1), Data(bytes.dropLast()),
                        header(bytes, change: { $0.rtm_errno = ESRCH }), header(bytes, change: { $0.rtm_type = 2 })] {
                rejects("malformed, kernel-error or delete frame refuses before interface resolution (\(bad.count) bytes)") {
                    _ = try Projection.decode(bad, resolveInterface: { _ in lookupCalls += 1; return interface })
                }
            }
            check(lookupCalls == 0, "decode refusal never becomes an absence lookup or other callback")
            rejects("negative PID cannot form a request") { _ = try Projection.request(ordinary, operation: .add, pid: -1, sequence: 1, interfaceType: 1) }
            rejects("negative sequence cannot form a request") { _ = try Projection.request(ordinary, operation: .get, pid: 1, sequence: -1, interfaceType: 1) }
            let wide = try Effects.Route(destination: ordinary.destination, gateway: nil, interface: .init(name: "utun42", index: 65536), scopeIndex: 0, flags: ordinary.flags, hopCount: 0)
            rejects("wide typed interface indices refuse instead of narrowing into the Darwin header") { _ = try Projection.request(wide, operation: .add, pid: 1, sequence: 1, interfaceType: 1) }
            let unknownFlags = try Effects.Route(destination: ordinary.destination, gateway: nil, interface: interface, scopeIndex: 0, flags: ordinary.flags | 0x80000000, hopCount: 0)
            rejects("unsupported typed flags cannot silently disappear during encoding") { _ = try Projection.request(unknownFlags, operation: .add, pid: 1, sequence: 1, interfaceType: 1) }
            let zoned = try route(.ipv6, "fe80::", 64, "fe80:1::1")
            rejects("IPv6 gateway carrying unrepresented embedded zone bytes cannot form a request") { _ = try Projection.request(zoned, operation: .add, pid: 1, sequence: 1, interfaceType: 1) }
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failed = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failed == 0, "checksPassed": rows.count - failed, "checksTotal": rows.count,
            "actualTunCreated": false, "routingSocketOpened": false, "systemConfigurationChanged": false,
            "actualTunAccepted": false, "checks": rows]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failed > 0 { exit(1) }
    }
}
