import Foundation
import Darwin

private typealias Plan = RelayTunCoreProbePlan
private enum Injected: Error { case failure }

@main struct RelayTunCoreProbePlanTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ value: @autoclosure () throws -> Bool, _ name: String) {
            do { rows.append(["name": name, "passed": try value()]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": false]) }
            catch { rows.append(["name": name, "passed": true]) }
        }
        func bytes(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
        do {
            let receipt = try RelayTunAcquiredReceipt(installationRevision: String(repeating: "a", count: 64), clientUID: 501,
                evidenceSHA256: String(repeating: "b", count: 64), runtimeConfigurationSHA256: String(repeating: "c", count: 64),
                planID: "a819f72d-7b78-45e5-933f-561bfa2e0f70", sessionID: "bd3e739f-2820-4be2-85ef-01286a8618c4",
                deviceID: "b166222a-c6c9-473b-a09b-df5c3e631b44", interfaceName: "utun4", interfaceIndex: 20, controlID: 5, controlUnit: 5,
                socketDevice: "0", socketInode: "0")
            let generated = try Plan.configuration(receipt: receipt)
            let configuration = try JSONSerialization.jsonObject(with: generated) as! [String: Any]
            let tun = configuration["tun"] as! [String: Any]
            check(try Plan.configuration(receipt: receipt) == generated, "fixed fixture configuration is deterministic and leaves receipt immutable")
            check(["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"].allSatisfy { configuration[$0] as? Int == 0 }, "all five configured proxy ports are disabled")
            check(tun["device"] as? String == "utun4" && tun["file-descriptor"] as? Int == 3 && tun["stack"] as? String == "gvisor", "only the receipt device and FD3 enter the gvisor fixture")
            check(["auto-route", "auto-detect-interface", "auto-redirect", "gso", "recvmsgx", "sendmsgx"].allSatisfy { tun[$0] as? Bool == false }, "automatic route, monitor, redirect and experimental socket options explicitly override core defaults")
            check(tun["dns-mode"] as? String == "disabled" && (tun["dns-hijack"] as? [String])?.isEmpty == true && (tun["inet6-address"] as? [String])?.isEmpty == true,
                  "DNS handling and default IPv6 prefixes are explicitly disabled")
            check((configuration["dns"] as? [String: Bool])?["enable"] == false && configuration["rules"] as? [String] == ["MATCH,REJECT"] && (configuration["listeners"] as? [Any])?.isEmpty == true,
                  "fixture disables DNS, external listeners and permits only reject policy")
            check(configuration["external-controller"] as? String == "" && configuration["external-controller-tls"] as? String == "", "private Unix CLI controller cannot inherit a TCP controller")
            check(!generated.contains(Data("post-up".utf8)) && !generated.contains(Data("post-down".utf8)), "fixture has no process hooks or arbitrary command fields")

            let version = try bytes(["version": "v1.19.33"])
            var response = configuration
            response["tun"] = tun.merging(["stack": "gVisor"]) { _, new in new }
            try Plan.validateReady(version: version, configs: bytes(response), receipt: receipt)
            check(true, "exact core version, actual tun enable/device/FD and controlled settings validate without a readiness claim for forwarding")
            var omitted = tun
            for key in ["auto-redirect", "gso", "recvmsgx", "sendmsgx"] { omitted.removeValue(forKey: key) }
            response["tun"] = omitted
            try Plan.validateReady(version: version, configs: bytes(response), receipt: receipt)
            check(true, "known omitempty false fields from the fixed core are accepted")
            func badConfig(_ key: String, _ value: Any) throws {
                var candidate = configuration; candidate[key] = value
                try Plan.validateReady(version: version, configs: bytes(candidate), receipt: receipt)
            }
            func badTun(_ key: String, _ value: Any?) throws {
                var candidate = configuration, changed = tun
                changed[key] = value; candidate["tun"] = changed
                try Plan.validateReady(version: version, configs: bytes(candidate), receipt: receipt)
            }
            for key in ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"] {
                rejects("enabled \(key) rejects core adoption") { try badConfig(key, 7890) }
                rejects("boolean cannot masquerade as disabled numeric \(key)") { try badConfig(key, false) }
                rejects("missing \(key) is not disabled evidence") { var c = configuration; c.removeValue(forKey: key); try Plan.validateReady(version: version, configs: bytes(c), receipt: receipt) }
            }
            for key in ["allow-lan", "ipv6"] {
                rejects("enabled \(key) is outside fixture scope") { try badConfig(key, true) }
                rejects("numeric zero is not Boolean \(key) evidence") { try badConfig(key, 0) }
            }
            rejects("another mode cannot replace the rule/reject fixture") { try badConfig("mode", "direct") }
            for field in ["enable", "device", "file-descriptor", "stack", "dns-mode", "mtu", "auto-route", "auto-detect-interface"] {
                rejects("missing critical TUN \(field) refuses") { try badTun(field, nil) }
            }
            for (key, value): (String, Any) in [("enable", false), ("enable", 1), ("device", "utun5"), ("file-descriptor", 4),
                ("file-descriptor", true), ("stack", "system"), ("dns-mode", "native"), ("mtu", 9000), ("dns-hijack", ["0.0.0.0:53"])] {
                rejects("changed TUN \(key) cannot pass actual adopted-state verification") { try badTun(key, value) }
            }
            for field in ["auto-route", "auto-detect-interface", "auto-redirect", "gso", "recvmsgx", "sendmsgx"] {
                rejects("enabled TUN \(field) cannot widen fixture scope") { try badTun(field, true) }
                rejects("numeric zero does not prove Boolean false for \(field)") { try badTun(field, 0) }
            }
            for invalid in ["v1.19.32", "1.19.33", "", "v1.19.33-dev"] {
                rejects("different or unrecognized core version refuses") { try Plan.validateReady(version: bytes(["version": invalid]), configs: generated, receipt: receipt) }
            }
            rejects("oversized API JSON is bounded") { try Plan.validateReady(version: version, configs: Data(repeating: 32, count: Plan.responseLimit + 1), receipt: receipt) }

            let payload = Data("{\"ok\":true}".utf8)
            let closedResponse = Data("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n".utf8) + payload
            check(try Plan.httpBody(closedResponse) == payload, "EOF-delimited HTTP/1.0 body is decoded without packet traffic")
            let sizedResponse = Data("HTTP/1.1 200 OK\r\nContent-Length: \(payload.count)\r\n\r\n".utf8) + payload
            check(try Plan.httpBody(sizedResponse) == payload, "exact Content-Length also validates")
            let headers = ["HTTP/1.0 500 Error\r\n\r\n", "HTTP/2 200 OK\r\n\r\n", "HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
                "HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n", "HTTP/1.0 200 OK\r\nContent-Length: 00\r\n\r\n",
                "HTTP/1.0 200 OK\r\nContent-Length: -1\r\n\r\n", "HTTP/1.0 200 OK\r\nContent-Length: 11\r\nContent-Length: 11\r\n\r\n",
                "HTTP/1.0 200 OK\r\n Broken: yes\r\n\r\n", "HTTP/1.0 200 OK\r\nX: a\nb\r\n\r\n"]
            for header in headers { rejects("malformed, ambiguous or unsupported HTTP framing refuses") { _ = try Plan.httpBody(Data(header.utf8) + payload) } }
            rejects("missing header terminator is not a complete API response") { _ = try Plan.httpBody(payload) }
            rejects("empty API body cannot claim readiness") { _ = try Plan.httpBody(Data("HTTP/1.0 200 OK\r\n\r\n".utf8)) }
            rejects("oversized headers cannot consume the body budget") { _ = try Plan.httpBody(Data(("HTTP/1.0 200 OK\r\nX: " + String(repeating: "a", count: Plan.headerLimit) + "\r\n\r\n").utf8) + payload) }
            rejects("oversized body cannot become a JSON observation") { _ = try Plan.httpBody(Data("HTTP/1.0 200 OK\r\n\r\n".utf8) + Data(repeating: 65, count: Plan.responseLimit + 1)) }

            var signals: [Int32] = [], now: UInt64 = 100, state = Plan.ChildState.exited(0)
            let normal = Plan.StopDriver(wait: { state }, signal: { signal in signals.append(signal); state = .exited(0) }, now: { now }, pause: { now += 10 })
            let already = try Plan.stopOwnedChild(normal)
            check(already.waitStatus == 0 && !already.forced && signals.isEmpty, "an already reaped child is never signalled")
            state = .running
            let polite = try Plan.stopOwnedChild(normal)
            check(polite.waitStatus == 0 && !polite.forced && signals == [SIGTERM], "owned running child receives only graceful TERM when it exits")
            check(try { try Plan.requireGracefulExit(polite); return true }(), "normal status zero is accepted as a completed graceful core shutdown")
            for status: Int32 in [1, 9, 15, 256, 512] {
                rejects("signalled or nonzero child status cannot claim successful core shutdown") {
                    try Plan.requireGracefulExit(.init(waitStatus: status, forced: false))
                }
            }
            rejects("forced exit never becomes successful shutdown even with an inconsistent zero wait fixture") {
                try Plan.requireGracefulExit(.init(waitStatus: 0, forced: true))
            }
            signals = []; now = 100; state = .running
            let hard = Plan.StopDriver(wait: { state }, signal: { signal in signals.append(signal); if signal == SIGKILL { state = .exited(9) } }, now: { now }, pause: { now += 100 })
            let killed = try Plan.stopOwnedChild(hard)
            check(killed.forced && killed.waitStatus == 9 && signals == [SIGTERM, SIGKILL] && now == 3100,
                  "only the same unreaped fixture child escalates after three seconds")
            signals = []; now = 100; state = .running
            let stuck = Plan.StopDriver(wait: { state }, signal: { signals.append($0) }, now: { now }, pause: { now += 100 })
            rejects("unreaped child after TERM and KILL remains unknown") { _ = try Plan.stopOwnedChild(stuck) }
            check(signals == [SIGTERM, SIGKILL] && now == 5100, "failed exit proof remains bounded to five seconds")
            signals = []; state = .unknown
            rejects("unknown ownership prevents every signal") { _ = try Plan.stopOwnedChild(normal) }
            check(signals.isEmpty, "unknown wait result is never treated as owned running process")
            signals = []; state = .running; now = 100
            let backwards = Plan.StopDriver(wait: { state }, signal: { signals.append($0) }, now: { now }, pause: { now -= 1 })
            rejects("regressed clock cannot silently extend a stop deadline") { _ = try Plan.stopOwnedChild(backwards) }
            check(signals == [SIGTERM], "clock uncertainty does not escalate another signal")
            signals = []; state = .running; now = 100; var pauses = 0
            let frozen = Plan.StopDriver(wait: { state }, signal: { signals.append($0) }, now: { now }, pause: { pauses += 1 })
            rejects("frozen injected clock has a separate finite iteration bound") { _ = try Plan.stopOwnedChild(frozen) }
            check(pauses == 600 && signals == [SIGTERM], "clock failure cannot make the cleanup loop infinite")
            rejects("failed wait does not become an exited child") { _ = try Plan.stopOwnedChild(.init(wait: { throw Injected.failure }, signal: { _ in }, now: { 0 }, pause: {})) }
            check(Plan.readyMilliseconds == 5000 && Plan.gracefulMilliseconds == 3000 && Plan.killMilliseconds == 2000,
                  "readiness and owned-stop budgets remain explicit")
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failures = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failures == 0, "checksPassed": rows.count - failures, "checksTotal": rows.count,
            "actualCoreLaunched": false, "actualTunCreated": false, "actualSignalsSent": false, "actualDNSCacheFlushAttempted": false,
            "actualTunAccepted": false, "systemConfigurationChanged": false, "checks": rows]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failures > 0 { exit(1) }
    }
}
