import Foundation
import CoreFoundation
import Darwin

/// Pure policy for one fixed-core supplied-FD fixture. No process, socket,
/// directory, root, TUN packet or DNS-cache API is invoked by this type.
enum RelayTunCoreProbePlan {
    enum Failure: Error { case invalid, response, childUnknown, deadline, interrupted }
    static let version = "v1.19.33"
    static let responseLimit = 65536
    static let headerLimit = 8192
    static let readyMilliseconds: UInt64 = 5000
    static let gracefulMilliseconds: UInt64 = 3000
    static let killMilliseconds: UInt64 = 2000

    static func configuration(receipt: RelayTunAcquiredReceipt) throws -> Data {
        try receipt.validate()
        let value: [String: Any] = [
            "port": 0, "socks-port": 0, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0,
            "allow-lan": false, "bind-address": "127.0.0.1", "mode": "rule", "log-level": "silent", "ipv6": false,
            "external-controller": "", "external-controller-tls": "", "external-ui": "",
            "dns": ["enable": false], "hosts": [String: String](),
            "tun": ["enable": true, "device": receipt.interfaceName, "file-descriptor": 3, "stack": "gvisor",
                    "mtu": 1500, "gso": false, "recvmsgx": false, "sendmsgx": false,
                    "auto-route": false, "auto-detect-interface": false, "auto-redirect": false,
                    "dns-mode": "disabled", "dns-hijack": [String](), "inet6-address": [String](),
                    "route-address": [String](), "route-exclude-address": [String](), "disable-icmp-forwarding": true] as [String: Any],
            "ntp": ["enable": false], "sniffer": ["enable": false],
            "profile": ["store-selected": false, "store-fake-ip": false],
            "geo-auto-update": false, "geodata-mode": false, "find-process-mode": "off",
            "proxies": [Any](), "proxy-groups": [Any](), "proxy-providers": [String: Any](),
            "rule-providers": [String: Any](), "listeners": [Any](), "rules": ["MATCH,REJECT"]
        ]
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    private static func object(_ bytes: Data) throws -> [String: Any] {
        guard !bytes.isEmpty, bytes.count <= responseLimit,
              let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw Failure.response }
        return object
    }
    private static func integer(_ value: Any?, equal: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue == Double(equal)
    }
    private static func boolean(_ value: Any?, equal: Bool) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue == equal
    }
    static func validateReady(version: Data, configs: Data, receipt: RelayTunAcquiredReceipt) throws {
        try receipt.validate()
        let reported = try object(version), config = try object(configs)
        guard reported["version"] as? String == Self.version,
              ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"].allSatisfy({ integer(config[$0], equal: 0) }),
              boolean(config["allow-lan"], equal: false), boolean(config["ipv6"], equal: false), config["mode"] as? String == "rule",
              let tun = config["tun"] as? [String: Any], boolean(tun["enable"], equal: true),
              tun["device"] as? String == receipt.interfaceName, integer(tun["file-descriptor"], equal: 3),
              (tun["stack"] as? String)?.lowercased() == "gvisor", tun["dns-mode"] as? String == "disabled",
              integer(tun["mtu"], equal: 1500), boolean(tun["auto-route"], equal: false),
              boolean(tun["auto-detect-interface"], equal: false) else { throw Failure.response }
        for field in ["auto-redirect", "gso", "recvmsgx", "sendmsgx"] {
            // The fixed core omits several false fields in its API JSON.
            guard tun[field] == nil || boolean(tun[field], equal: false) else { throw Failure.response }
        }
        guard tun["dns-hijack"] is NSNull || (tun["dns-hijack"] as? [Any])?.isEmpty == true else { throw Failure.response }
    }

    /// The live reader requests HTTP/1.0 and waits for EOF. Chunked transfer is
    /// deliberately refused; a partial/read-timeout stream never reaches here.
    static func httpBody(_ bytes: Data) throws -> Data {
        guard bytes.count <= headerLimit + 4 + responseLimit,
              let boundary = bytes.range(of: Data([13, 10, 13, 10])), boundary.lowerBound <= headerLimit,
              let header = String(data: bytes[..<boundary.lowerBound], encoding: .ascii) else { throw Failure.response }
        let lines = header.components(separatedBy: "\r\n")
        guard let status = lines.first else { throw Failure.response }
        let pieces = status.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
        guard pieces.count == 3, ["HTTP/1.0", "HTTP/1.1"].contains(String(pieces[0])), pieces[1] == "200" else { throw Failure.response }
        var length: Int?
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex,
                  line[..<colon].utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || $0 == 45 }) else { throw Failure.response }
            let key = line[..<colon].lowercased(), value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard value.utf8.allSatisfy({ (32...126).contains($0) || $0 == 9 }) else { throw Failure.response }
            guard key != "transfer-encoding" else { throw Failure.response }
            if key == "content-length" {
                guard length == nil, let count = Int(value), String(count) == value, count >= 0, count <= responseLimit else { throw Failure.response }
                length = count
            }
        }
        let body = Data(bytes[boundary.upperBound...])
        guard !body.isEmpty, body.count <= responseLimit, length == nil || body.count == length else { throw Failure.response }
        return body
    }

    enum ChildState: Equatable { case running, exited(Int32), unknown }
    struct StopDriver {
        // The live closures capture only a successfully spawned unreaped child.
        // No PID/name/path, stored record or permission is accepted by policy.
        let wait: () throws -> ChildState
        let signal: (Int32) throws -> Void
        let now: () -> UInt64
        let pause: () -> Void
    }
    struct Stopped { let waitStatus: Int32; let forced: Bool }
    static func requireGracefulExit(_ stopped: Stopped) throws {
        // Reaping proves ownership has ended. Only normal status zero proves
        // this fixture completed the core's shutdown rather than truncating it.
        guard stopped.waitStatus == 0, !stopped.forced else { throw Failure.childUnknown }
    }
    static func stopOwnedChild(_ driver: StopDriver) throws -> Stopped {
        func observe() throws -> Int32? {
            switch try driver.wait() { case .running: return nil; case .exited(let value): return value; case .unknown: throw Failure.childUnknown }
        }
        if let status = try observe() { return .init(waitStatus: status, forced: false) }
        try driver.signal(SIGTERM)
        func until(_ milliseconds: UInt64) throws -> Int32? {
            let start = driver.now()
            guard start <= UInt64.max - milliseconds else { throw Failure.deadline }
            var previous = start
            for _ in 0..<600 {
                if let status = try observe() { return status }
                let now = driver.now()
                guard now >= previous else { throw Failure.deadline }; previous = now
                if now - start >= milliseconds { return nil }
                driver.pause()
            }
            throw Failure.deadline
        }
        if let status = try until(gracefulMilliseconds) { return .init(waitStatus: status, forced: false) }
        // Recheck the exact unreaped child immediately before escalation.
        if let status = try observe() { return .init(waitStatus: status, forced: false) }
        try driver.signal(SIGKILL)
        guard let status = try until(killMilliseconds) else { throw Failure.childUnknown }
        return .init(waitStatus: status, forced: true)
    }
}
