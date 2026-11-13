import Foundation
import Darwin

/// Ordinary-user, in-memory protocol checks. Never contacts Mach, reads an
/// installed trust manifest, or invokes a live preferences mutation adapter.
@main struct RelaySystemProxyHelperTests {
    static func main() {
        typealias Trust = RelaySystemProxyHelperTrust
        typealias Pin = RelaySystemProxyCodePin
        typealias Request = RelaySystemProxyHelperRequest
        typealias Reply = RelaySystemProxyHelperReply
        typealias Backend = RelaySystemProxyBackend
        var rows: [[String: Any]] = []
        func check(_ passed: Bool, _ name: String) { rows.append(["name": name, "passed": passed]) }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); check(false, name) } catch { check(true, name) }
        }
        func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
        do {
            guard getuid() != 0, geteuid() == getuid() else { throw Backend.Failure("Offline helper tests require an ordinary user.") }
            var clock: TimeInterval = 0
            let lifetime = RelaySystemProxyHelperLifetime(now: { clock })
            check(!lifetime.beginIdleShutdown(), "launchd helper does not exit immediately after launch")
            check(lifetime.acquire() && lifetime.acquire(), "connection and transaction hold separate leases")
            clock = 30; lifetime.release()
            check(!lifetime.beginIdleShutdown(), "client disconnect cannot interrupt in-flight rollback or commit")
            lifetime.release(); clock = 44
            check(!lifetime.beginIdleShutdown(), "idle grace starts after the final operation finishes")
            clock = 45
            check(lifetime.beginIdleShutdown() && !lifetime.acquire() && !lifetime.beginIdleShutdown(), "idle shutdown is atomic and refuses newly racing connections")
            let sha = String(repeating: "a", count: 64), arm = String(repeating: "b", count: 40), intel = String(repeating: "c", count: 40)
            let pin = Pin(sha256: sha, size: 1024, cdhashes: ["arm64": arm, "x86_64": intel])
            let pinObject: [String: Any] = ["sha256": sha, "size": 1024, "cdhashes": ["arm64": arm, "x86_64": intel]]
            let base: [String: Any] = ["version": 1, "role": "system-proxy-v1", "clientUID": 501, "helper": pinObject, "client": pinObject, "daemonSHA256": sha, "uninstallerSHA256": sha]
            let manifestBytes = try bytes(base), manifest = try Trust.parse(manifestBytes)
            let trust = Trust(revision: Trust.digest(manifestBytes), manifest: manifest)
            try pin.validate()
            check(manifest.clientUID == 501 && manifest.role == "system-proxy-v1", "fixed manifest accepts the intended ordinary-user installation")
            check(pin.requirement == "(cdhash H\"\(arm)\" or cdhash H\"\(intel)\")", "ad-hoc peer requirement is pinned to both exact architecture hashes")
            for (name, value) in [("root UID", 0), ("reserved maximum UID", Int(UInt32.max)), ("negative UID", -1)] {
                var object = base; object["clientUID"] = value
                rejects("manifest rejects \(name)") { _ = try Trust.parse(bytes(object)) }
            }
            for (key, value) in [("version", 2 as Any), ("role", "tun-v1" as Any), ("clientUID", true as Any), ("clientUID", 1.5 as Any), ("daemonSHA256", "bad" as Any), ("uninstallerSHA256", String(repeating: "A", count: 64) as Any)] {
                var object = base; object[key] = value
                rejects("manifest rejects invalid \(key)=\(value)") { _ = try Trust.parse(bytes(object)) }
            }
            for key in base.keys.sorted() {
                var object = base; object.removeValue(forKey: key)
                rejects("manifest rejects missing \(key)") { _ = try Trust.parse(bytes(object)) }
            }
            var extra = base; extra["executable"] = "/bin/sh"
            rejects("manifest rejects arbitrary top-level executable fields") { _ = try Trust.parse(bytes(extra)) }
            rejects("manifest rejects empty input") { _ = try Trust.parse(Data()) }
            rejects("manifest rejects over-limit input") { _ = try Trust.parse(Data(repeating: 32, count: 16385)) }
            rejects("manifest rejects a non-object root") { _ = try Trust.parse(bytes([base])) }
            for (name, badPin) in [
                ("empty digest", Pin(sha256: "", size: 1024, cdhashes: pin.cdhashes)),
                ("zero size", Pin(sha256: sha, size: 0, cdhashes: pin.cdhashes)),
                ("negative size", Pin(sha256: sha, size: -1, cdhashes: pin.cdhashes)),
                ("oversize resource", Pin(sha256: sha, size: 33554433, cdhashes: pin.cdhashes)),
                ("missing architecture", Pin(sha256: sha, size: 1024, cdhashes: ["arm64": arm])),
                ("extra architecture", Pin(sha256: sha, size: 1024, cdhashes: ["arm64": arm, "x86_64": intel, "i386": intel])),
                ("malformed cdhash", Pin(sha256: sha, size: 1024, cdhashes: ["arm64": "invalid", "x86_64": intel]))
            ] { rejects("pin rejects \(name)") { try badPin.validate() } }
            rejects("protected-file reader rejects caller-selected paths before filesystem access") { _ = try Trust.protectedFile("/private/tmp/relay-untrusted-installation.json", limit: 16384, mode: 0o644) }

            let originalBytes = try PropertyListSerialization.data(fromPropertyList: ["HTTPEnable": 0], format: .binary, options: 0)
            let targetBytes = try PropertyListSerialization.data(fromPropertyList: ["HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": 18191], format: .binary, options: 0)
            let before = Backend.Snapshot(location: "L1", services: [Backend.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: originalBytes)])
            let target = Backend.Snapshot(location: "L1", services: [Backend.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: targetBytes)])
            let nonce = "00000000-0000-0000-0000-000000000001"
            func request(_ expected: Backend.Snapshot? = before, _ desired: Backend.Snapshot? = target, version: Int = 1, operation: Request.Operation = .change, nonce: String = nonce, deadline: TimeInterval = 108) -> Request {
                Request(version: version, operation: operation, nonce: nonce, deadline: deadline, expected: expected, target: desired)
            }
            let change = request(), status = request(nil, nil, operation: .status)
            let decoded = try Request.parse(JSONEncoder().encode(change), now: 100)
            check(decoded.expected == before && decoded.target == target, "change request preserves exact snapshot bytes through the wire")
            try status.validate(now: 100)
            check(true, "status request has no mutation snapshots")
            for (name, badRequest) in [
                ("unsupported version", request(version: 2)), ("expired deadline", request(deadline: 99)),
                ("excessive deadline", request(deadline: 111)), ("infinite deadline", request(deadline: .infinity)),
                ("NaN deadline", request(deadline: .nan)), ("invalid nonce", request(nonce: "bad")),
                ("missing before", request(nil, target)), ("missing target", request(before, nil)),
                ("status with snapshots", request(operation: .status))
            ] { rejects("request rejects \(name)") { try badRequest.validate(now: 100) } }
            rejects("request rejects a nonfinite current time") { try change.validate(now: .nan) }
            rejects("request rejects an oversized frame") { _ = try Request.parse(Data(repeating: 0, count: Request.maximumBytes + 1), now: 100) }
            rejects("request rejects an empty frame") { _ = try Request.parse(Data(), now: 100) }
            rejects("request rejects malformed JSON") { _ = try Request.parse(Data("{invalid}".utf8), now: 100) }
            var requestObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(change)) as! [String: Any]
            requestObject["operation"] = "exec"
            rejects("request rejects non-proxy operation names") { _ = try Request.parse(bytes(requestObject), now: 100) }
            let changedLocation = Backend.Snapshot(location: "L2", services: before.services)
            rejects("request rejects location replacement") { try request(before, changedLocation).validate(now: 100) }
            for badService in [
                Backend.Service(id: "B", name: "Wi-Fi", enabled: true, configuration: targetBytes),
                Backend.Service(id: "A", name: "Ethernet", enabled: true, configuration: targetBytes),
                Backend.Service(id: "A", name: "Wi-Fi", enabled: false, configuration: targetBytes),
                Backend.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: Data("invalid plist".utf8))
            ] { rejects("request rejects changed service identity or malformed configuration: \(badService.id)/\(badService.name)/\(badService.enabled)") { try request(before, Backend.Snapshot(location: "L1", services: [badService])).validate(now: 100) } }
            rejects("request rejects duplicate service identities") { try request(before, Backend.Snapshot(location: "L1", services: before.services + before.services)).validate(now: 100) }
            rejects("request rejects removing services") { try request(before, Backend.Snapshot(location: "L1", services: [])).validate(now: 100) }

            func reply(version: Int = 1, nonce: String = nonce, revision: String = trust.revision, uid: UInt32 = 501, result: Backend.ChangeResult? = nil, error: String? = nil) -> Reply {
                Reply(version: version, nonce: nonce, revision: revision, clientUID: uid, result: result, error: error)
            }
            for state in ["applied", "rolledBack", "unchanged", "uncertain"] {
                try reply(result: Backend.ChangeResult(status: state, snapshot: state == "applied" ? target : before)).validate(request: change, trust: trust)
                check(true, "reply accepts bounded \(state) state")
            }
            try reply().validate(request: status, trust: trust)
            try reply(error: "bounded failure").validate(request: change, trust: trust)
            check(true, "status acknowledgement and explicit bounded error do not masquerade as an applied change")
            for (name, badReply) in [
                ("version", reply(version: 2)), ("nonce", reply(nonce: UUID().uuidString.lowercased())),
                ("installation revision", reply(revision: String(repeating: "d", count: 64))), ("peer UID", reply(uid: 0)),
                ("missing result", reply()), ("unknown result status", reply(result: Backend.ChangeResult(status: "success", snapshot: target))),
                ("too many warnings", reply(result: Backend.ChangeResult(status: "uncertain", snapshot: before, warnings: Array(repeating: "warning", count: 17)))),
                ("oversized warning", reply(result: Backend.ChangeResult(status: "uncertain", snapshot: before, warnings: [String(repeating: "x", count: 1025)]))),
                ("oversized error", reply(error: String(repeating: "x", count: 1025))),
                ("result with error", reply(result: Backend.ChangeResult(status: "applied", snapshot: target), error: "error")),
                ("invalid returned snapshot", reply(result: Backend.ChangeResult(status: "uncertain", snapshot: Backend.Snapshot(location: "", services: []))))
            ] { rejects("reply rejects \(name)") { try badReply.validate(request: change, trust: trust) } }
            rejects("status reply rejects a mutation result") { try reply(result: Backend.ChangeResult(status: "applied", snapshot: target)).validate(request: status, trust: trust) }

            var disk = before, cache = before, commits = 0, applies = 0
            let session = Backend.LockedSession(synchronize: { cache = disk }, read: { cache }, stage: { cache = $0 }, commit: { commits += 1; disk = cache; return true }, apply: { applies += 1; return true })
            let first = try Backend.changeLocked(before, target, session: session)
            check(first.status == "applied" && commits == 1 && applies == 1, "first in-memory transaction commits and applies once")
            rejects("repeated original snapshot cannot reapply a completed change") { _ = try Backend.changeLocked(before, target, session: session) }
            check(commits == 1 && applies == 1 && disk == target, "replayed stale transaction adds no writes")
            rows += try relaySystemProxyBackendSelfTestRows()
        } catch {
            rows.append(["name": "unexpected fixture setup failure", "passed": false, "error": String(describing: error)])
        }
        let passed = rows.allSatisfy { $0["passed"] as? Bool == true }
        let report: [String: Any] = ["version": 1, "passed": passed, "rows": rows, "count": rows.count,
            "execution": "ordinary-user in-memory fixtures only", "systemMachContacted": false,
            "livePreferencesAdapterInvoked": false, "administratorInstallationExecuted": false]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) { print(String(decoding: data, as: UTF8.self)) }
        exit(passed ? 0 : 1)
    }
}
