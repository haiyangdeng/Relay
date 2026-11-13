import Darwin
import Foundation
import Network
import NetworkExtension

func runRelayGuardFilterSettingsSelfTests() -> Int32 {
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    let settings = RelayGuardFilterDataProvider.makeSettings()
    check(settings.defaultAction == .filterData, "non-loopback flows require provider decisions")
    check(settings.rules.count == 2, "two explicit loopback families without duplicate or invalid mapped rules")

    let expected: [(String, Int)] = [("127.0.0.0", 8), ("::1", 128)]
    func sameAddress(_ actual: String?, _ expected: String) -> Bool {
        guard let actual else { return false }
        if let lhs = IPv4Address(actual), let rhs = IPv4Address(expected) { return lhs.rawValue == rhs.rawValue }
        if let lhs = IPv6Address(actual), let rhs = IPv6Address(expected) { return lhs.rawValue == rhs.rawValue }
        return false
    }
    for (index, rule) in settings.rules.enumerated() {
        guard index < expected.count else { continue }
        let network = rule.networkRule
        let host: String?, port: Int?, localMissing: Bool
        if #available(macOS 15.0, *) {
            if case let .hostPort(address, number)? = network.matchRemoteHostOrNetworkEndpoint {
                host = String(describing: address); port = Int(number.rawValue)
            } else { host = nil; port = nil }
            localMissing = network.matchLocalNetworkEndpoint == nil
        } else {
            host = network.matchRemoteEndpoint?.hostname
            port = network.matchRemoteEndpoint.flatMap { Int($0.port) }
            localMissing = network.matchLocalNetwork == nil
        }
        check(sameAddress(host, expected[index].0), "explicit loopback address family \(index)")
        check(network.matchRemotePrefix == expected[index].1, "full loopback network prefix \(index)")
        check(port == 0 && localMissing, "all loopback ports without a local network restriction \(index)")
        check(rule.action == .filterData, "loopback never bypasses provider decisions \(index)")
        check(network.matchProtocol == .any, "TCP and UDP loopback are both observed \(index)")
        check(network.matchDirection == .any, "loopback rules include inbound and outbound \(index)")
    }

    // This confirms object normalization only, not how real mapped socket flows
    // match in the kernel. A separate signed deployment must test that boundary.
    if case let .ipv4(mapped) = Network.NWEndpoint.Host("::ffff:127.0.0.0") {
        check(mapped.rawValue == IPv4Address("127.0.0.0")?.rawValue,
            "mapped loopback endpoint normalizes into the explicit IPv4 network")
    } else { check(false, "mapped loopback endpoint normalization is understood") }
    check(settings.rules.allSatisfy { $0.networkRule.matchRemotePrefix <= 32 || $0.networkRule.matchRemotePrefix == 128 },
        "no normalized IPv4 endpoint receives an invalid mapped /104 prefix")

    for family in [AF_INET, AF_INET6] {
        check(RelayGuardFilterDataProvider.isTCP(socketFamily: family, socketType: SOCK_STREAM,
            socketProtocol: IPPROTO_TCP), "exact Internet TCP socket \(family)")
    }
    for (family, type, proto) in [(AF_UNIX, SOCK_STREAM, IPPROTO_TCP),
        (AF_INET, SOCK_DGRAM, IPPROTO_UDP), (AF_INET6, SOCK_STREAM, IPPROTO_UDP),
        (AF_INET, SOCK_DGRAM, IPPROTO_TCP), (AF_INET, SOCK_STREAM, 0)] {
        check(!RelayGuardFilterDataProvider.isTCP(socketFamily: family, socketType: type,
            socketProtocol: proto), "non-TCP or ambiguous socket rejected \(family)/\(type)/\(proto)")
    }

    // An NEProvider object requires the system extension host. Evaluate the
    // actual production admission predicate without constructing a provider.
    check(!RelayGuardFilterDataProvider.permitsProviderStart, "offline release rejects Provider start")
    print(failures.isEmpty ? "PASS: \(count) guard filter-object checks; no settings applied, extension activated, or network changed." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
