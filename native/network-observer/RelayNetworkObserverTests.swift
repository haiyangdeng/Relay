import Foundation
import Darwin

@main struct RelayNetworkObserverTests {
    static func main() throws {
        guard CommandLine.arguments.count == 1, getuid() > 0, geteuid() == getuid() else { exit(77) }
        // All sources are injected. No live system/network reads or mutations.
        func sources(proxy: Int = 0, mtu: UInt32 = 1500) -> RelayTunEnvironmentInspector.Sources {
            .init(interfaces: { [.init(name: "fixture0", index: 1, type: 6, flags: 1, mtu: mtu, addresses: [])] },
                  routes: { _ in Data() }, dns: { [] },
                  proxies: { [("State:/Network/Global/Proxies", ["HTTPEnable": proxy])] })
        }
        let first = try RelayNetworkObserver.inspect(uid: 501, sources: sources())
        let repeated = try RelayNetworkObserver.inspect(uid: 501, sources: sources())
        precondition(first.networkSHA256 == repeated.networkSHA256 && first.protectionSHA256 == repeated.protectionSHA256)
        precondition(!first.existingTunnel)
        let changed = try RelayNetworkObserver.inspect(uid: 501, sources: sources(proxy: 1))
        precondition(first.networkSHA256 == changed.networkSHA256 && first.protectionSHA256 != changed.protectionSHA256)
        let moved = try RelayNetworkObserver.inspect(uid: 501, sources: sources(mtu: 1400))
        precondition(first.networkSHA256 != moved.networkSHA256)
        let encoded = try JSONEncoder().encode(first)
        let raw = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        precondition(Set(raw.keys) == ["version", "role", "uid", "networkSHA256", "protectionSHA256", "existingTunnel"])
        precondition(raw["version"] as? Int == 1 && raw["role"] as? String == "probe-network-observer" && raw["uid"] as? Int == 501)
        enum Incomplete: Error { case fixture }
        let failing = RelayTunEnvironmentInspector.Sources(interfaces: { throw Incomplete.fixture },
            routes: { _ in Data() }, dns: { [] }, proxies: { [] })
        do { _ = try RelayNetworkObserver.inspect(uid: 501, sources: failing); preconditionFailure("Partial read accepted") }
        catch Incomplete.fixture {}
        print("RelayNetworkObserver: injected read-only report, changes and partial failure passed")
    }
}
