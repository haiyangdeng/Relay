// Pure complete-candidate projection plus actual own Unix HTTP responder.
// No Core/helper/TUN/App or user path/traffic is used by this test target.
import Foundation
import Darwin
private typealias P = RelayTunRuntimeRuleProviders
private typealias Q = RelayTunRuntimeRuleProviderProbe
private typealias R = RelayTunCoreReadiness
private typealias G = RelayTunRuntimeResources
private enum Bad: Error { case failed(String), revoked }
private func expect(_ x: @autoclosure () throws -> Bool, _ label: String = "assertion") throws { guard try x() else { throw Bad.failed(label) } }
private func rejects(_ body: () throws -> Void) throws { do { try body() } catch { return }; throw Bad.failed("expected rejection") }
private func json(_ raw: Any) throws -> Data { try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys, .withoutEscapingSlashes]) }
private let old = Data("payload:\n - old.synthetic.invalid\n".utf8), body = Data("payload:\n - new.synthetic.invalid\n".utf8)
private func identity(_ inode: UInt64, _ count: Int) throws -> P.FileIdentity { try .init(device: 1, inode: inode, ownerUID: getuid(), mode: 0o100600, links: 1, bytes: count, modifiedNS: 1, changedNS: 1) }
private struct Fixture {
    let snapshot: Q.Snapshot, blob: P.Blob, configuration: Data, bindings: [P.Binding]
    init(alias: Bool = true, altered: ((inout [String: Any]) -> Void)? = nil) throws {
        let path = "relay-files/" + G.digest(old) + ".yaml"
        var definitions: [String: Any] = ["Only": ["type": "file", "behavior": "domain", "format": "yaml", "path": path, "interval": 0]]
        if alias { definitions["别名/a?%#"] = ["type": "file", "behavior": "classical", "format": "yaml", "path": path, "interval": 0] }
        var value: [String: Any] = ["port": 7890, "mixed-port": 7891, "ipv6": true, "mode": "global", "tun": ["enable": true, "device": "utun99"], "dns": ["enable": true, "nameserver": ["https://synthetic.invalid/dns"]], "rule-providers": definitions, "proxy-providers": [String: Any](), "listeners": [["port": 9999]], "rules": ["RULE-SET,Only,REJECT", "MATCH,REJECT"], "proxies": [Any](), "proxy-groups": [Any](), "geox-url": ["geosite": "https://synthetic.invalid/private"], "geo-auto-update": true, "secret": "private-original"]
        altered?(&value); configuration = try json(value)
        let owner = try P.Owner(heldGeneration: 1, configurationRevision: G.digest(configuration), coreSHA256: Q.corePin.sha256, ordinaryUID: getuid())
        let context = P.Context(owner: owner, geo: try .init(generationSHA256: String(repeating: "b", count: 64), bytes: 0))
        let names = alias ? ["Only", "别名/a?%#"] : ["Only"]
        bindings = try names.map { try .init(name: $0, originalPath: path, behavior: $0 == "Only" ? .domain : .classical, format: .yaml) }
        let rows = try bindings.map { try P.Resource(binding: $0, fileSHA256: G.digest(old), identity: identity(1, old.count), ruleCount: 1, registeredFile: true) }.sorted { $0.binding.name < $1.binding.name }
        snapshot = try .init(configuration: configuration, assets: [.init(path: path, data: old, identity: identity(1, old.count))], context: context, group: rows, expectedRuleCounts: Dictionary(uniqueKeysWithValues: names.map { ($0, 1) }))
        blob = try .init(id: UUID().uuidString.lowercased(), format: .yaml, data: body, identity: identity(2, body.count))
    }
    func projection(_ count: Int = 1) throws -> Q.Projection { try Q.project(snapshot, blob: blob, declaredRuleCount: count) }
    func metadata(count: Any = 1) throws -> Data {
        try json(["providers": Dictionary(uniqueKeysWithValues: bindings.map { ($0.name, ["name": $0.name, "behavior": $0.behavior == .domain ? "Domain" : "Classical", "format": "YamlRule", "ruleCount": count, "type": "Rule", "vehicleType": "File", "updatedAt": "2026-11-02T12:34:56.123456789+08:00"] as [String: Any]) })])
    }
}
/// Adapted from the existing IO responder: accepted sockets explicitly clear
/// Darwin-inherited O_NONBLOCK, suppress SIGPIPE, and bound reads/writes.
private final class Peer {
    let root: String, original: stat, source = Data("{\"synthetic\":true}".utf8)
    var live: R.Live!, responseBody = Data("{\"providers\":{}}".utf8), status = 200, rawResponse: Data?, afterRequest: (() -> Void)?
    private var listener: Int32 = -1, reader: DispatchSourceRead?, ended = DispatchSemaphore(value: 0), workers = DispatchGroup()
    private let lock = NSLock(); private var requests = [String](), stopped = false
    init() throws {
        var pattern = Array("/private/tmp/relay-provider-io-XXXXXX".utf8CString)
        guard mkdtemp(&pattern) != nil else { throw Bad.failed("mkdtemp") }; root = String(cString: pattern)
        var value = stat(); guard lstat(root, &value) == 0 else { throw Bad.failed("lstat") }; original = value
    }
    func start() throws {
        try source.write(to: URL(fileURLWithPath: root + "/config.yaml"), options: .withoutOverwriting)
        guard chmod(root + "/config.yaml", 0o600) == 0 else { throw Bad.failed("chmod") }
        listener = socket(AF_UNIX, SOCK_STREAM, 0); guard listener >= 0 else { throw Bad.failed("socket") }
        let path = root + "/api.sock"; var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8CString.map { UInt8(bitPattern: $0) }) }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, listen(listener, 8) == 0, fcntl(listener, F_SETFD, FD_CLOEXEC) == 0, fcntl(listener, F_SETFL, O_NONBLOCK) == 0 else { throw Bad.failed("listen") }
        let fd = listener; reader = DispatchSource.makeReadSource(fileDescriptor: listener, queue: DispatchQueue(label: "provider-peer.accept"))
        reader!.setCancelHandler { [ended] in Darwin.close(fd); ended.signal() }
        reader!.setEventHandler { [weak self] in
            guard let self else { return }
            while true {
                let fd = accept(self.listener, nil, nil)
                if fd < 0, errno == EINTR { continue }; if fd < 0 { return }
                self.workers.enter(); DispatchQueue.global().async { self.handle(fd); self.workers.leave() }
            }
        }
        reader!.resume()
        live = try R.Live(directory: root, configuration: source, authorization: "private-fixture", verifyPeer: { _ in })
    }
    private func handle(_ fd: Int32) {
        defer { Darwin.close(fd) }
        var noSignal: Int32 = 1, timeout = timeval(tv_sec: 1, tv_usec: 0)
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) == 0, fcntl(fd, F_SETFD, FD_CLOEXEC) == 0,
              setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0 else { return }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while bytes.range(of: Data([13, 10, 13, 10])) == nil {
            let count = Darwin.read(fd, &buffer, buffer.count); if count < 0, errno == EINTR { continue }
            guard count > 0, bytes.count + count <= 8192 else { return }; bytes.append(contentsOf: buffer.prefix(count))
        }
        guard let line = String(data: bytes, encoding: .utf8)?.components(separatedBy: "\r\n").first else { return }
        lock.lock(); requests.append(line); lock.unlock(); afterRequest?()
        let response = rawResponse ?? (Data("HTTP/1.0 \(status) Fixture\r\nContent-Length: \(responseBody.count)\r\n\r\n".utf8) + responseBody)
        response.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if n < 0, errno == EINTR { continue }; if n <= 0 { return }; offset += n
            }
        }
    }
    var log: [String] { lock.lock(); defer { lock.unlock() }; return requests }
    func close() throws {
        guard !stopped else { return }; stopped = true; live = nil
        if let reader { reader.cancel(); guard ended.wait(timeout: .now() + 3) == .success else { throw Bad.failed("accept close") } }
        else if listener >= 0 { Darwin.close(listener) }
        guard workers.wait(timeout: .now() + 3) == .success else { throw Bad.failed("worker drain") }
        var value = stat(); guard lstat(root, &value) == 0, value.st_dev == original.st_dev, value.st_ino == original.st_ino, value.st_uid == getuid() else { throw Bad.failed("root replaced") }
        try FileManager.default.removeItem(atPath: root)
    }
}
@main private enum ProbeTests {
    static func main() {
        var rows = [[String: Any]]()
        func test(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": true]) } catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        func peerTest(_ name: String, _ body: (Peer) throws -> Void) {
            test(name) { let p = try Peer(); var error: Error?, cleanup: Error?; do { try p.start(); try body(p) } catch let e { error = e }; do { try p.close() } catch let e { cleanup = e }; if let cleanup { throw cleanup }; if let error { throw error } }
        }
        test("complete projection preserves rules and Geo assets but removes all listeners and network updaters") {
            let f = try Fixture(), q = try f.projection(), raw = try RelayTunStrictJSON.object(q.configuration)
            try expect(raw["rules"] as? [String] == ["RULE-SET,Only,REJECT", "MATCH,REJECT"])
            try expect((raw["tun"] as? [String: Any])?["enable"] as? Bool == false && (raw["dns"] as? [String: Any])?["enable"] as? Bool == false)
            try expect((raw["listeners"] as? [Any])?.isEmpty == true && raw["geo-auto-update"] as? Bool == false)
            try expect(q.assets[f.bindings[0].originalPath] == body && q.sourceConfigurationSHA256 == G.digest(f.configuration) && q.secret != "private-original")
            try expect(try RelayTunStrictJSON.object(f.configuration)["port"] as? Int == 7890)
        }
        test("all physical aliases must be included even with different behaviors") {
            let f = try Fixture(), s = f.snapshot
            let missing = try Q.Snapshot(configuration: s.configuration, assets: s.assets, context: s.context, group: [s.group[0]], expectedRuleCounts: s.expectedRuleCounts)
            try rejects { _ = try Q.project(missing, blob: f.blob, declaredRuleCount: 1) }
        }
        test("path URL or interval drift from loaded binding is rejected") {
            for key in ["url", "interval", "path"] {
                let f = try Fixture { raw in var d = raw["rule-providers"] as! [String: Any]; var item = d["Only"] as! [String: Any]; item[key] = key == "interval" ? 1 : "https://synthetic.invalid/path"; d["Only"] = item; raw["rule-providers"] = d }
                try rejects { _ = try f.projection() }
            }
        }
        test("unbound proxy provider or declared zero/overflow never starts a candidate") {
            let f = try Fixture { $0["proxy-providers"] = ["Other": ["type": "http", "url": "https://synthetic.invalid"]] }
            try rejects { _ = try f.projection() }; let normal = try Fixture(); for n in [0, Q.maximumDeclaredRules + 1] { try rejects { _ = try normal.projection(n) } }
        }
        test("PUT all aliases plus actual counts produces private receipt bound to body/cfg/Geo") {
            let f = try Fixture(), p = try f.projection(), accepted = try Q.accepted(p, putAccepted: Set(p.bindings.map { $0.name }), metadata: f.metadata())
            try expect(accepted.counts.count == 2 && accepted.bodySHA256 == G.digest(body) && accepted.sourceConfigurationSHA256 == G.digest(f.configuration))
        }
        test("204 or timestamp without every alias acceptance cannot certify candidate") {
            let f = try Fixture(), p = try f.projection(); try rejects { _ = try Q.accepted(p, putAccepted: ["Only"], metadata: f.metadata()) }
        }
        test("partial parser counts and bool counts cannot pass declared completeness") {
            let f = try Fixture(), p = try f.projection(2), names = Set(p.bindings.map { $0.name })
            for bad in [1 as Any, true as Any, 0 as Any] { try rejects { _ = try Q.accepted(p, putAccepted: names, metadata: f.metadata(count: bad)) } }
        }
        test("strict metadata decoded duplicate does not become accepted strategy evidence") {
            let f = try Fixture(alias: false), p = try f.projection(), raw = try String(data: f.metadata(), encoding: .utf8)!
            let duplicate = raw.replacingOccurrences(of: "\"ruleCount\":1", with: "\"ruleCount\":1,\"rule\\u0043ount\":1")
            try rejects { _ = try Q.accepted(p, putAccepted: ["Only"], metadata: Data(duplicate.utf8)) }
        }
        test("candidate ready requires exact version and no active TUN or proxy port") {
            let f = try Fixture(), p = try f.projection(), base: [String: Any] = ["port": 0, "socks-port": 0, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0, "allow-lan": false, "ipv6": false, "mode": "rule", "tun": ["enable": false]]
            try Q.validateReady(p, version: json(["version": Q.coreVersion]), configs: json(base))
            var bad = base; bad["port"] = 7890; try rejects { try Q.validateReady(p, version: json(["version": Q.coreVersion]), configs: json(bad)) }
            try rejects { try Q.validateReady(p, version: json(["version": "relay-geodata-v1-3f27"]), configs: json(base)) }
        }
        test("name encoder has no raw route delimiter and preserves literal percent escapes") {
            for name in ["节点/a?%#", "literal%2F", ".", "..", "a/b"] {
                let path = try R.providerPath(name), segment = String(path.dropFirst("/providers/rules/".count))
                try expect(!segment.contains("/") && !segment.contains("?") && !segment.contains("#") && segment.removingPercentEncoding == name)
            }
            for bad in [" ", "bad,name", "bad\nname"] { try rejects { _ = try R.providerPath(bad) } }
        }
        peerTest("fixed GET and bodyless PUT send only exact escaped upstream routes") { p in
            _ = try p.live.readRuleProviders(before: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: {})
            p.status = 204; p.responseBody = Data()
            try p.live.updateRuleProvider(name: "节点/a?%#", before: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: {}, beforeDispatch: {})
            try expect(p.log == ["GET /providers/rules HTTP/1.0", "PUT /providers/rules/%E8%8A%82%E7%82%B9%2F%61%3F%25%23 HTTP/1.0"])
        }
        peerTest("final synchronous predispatch revocation sends zero request") { p in
            try rejects { try p.live.updateRuleProvider(name: "Only", before: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: {}, beforeDispatch: { throw Bad.revoked }) }
            try expect(p.log.isEmpty)
        }
        peerTest("nonempty 204 is rejected and never retried") { p in
            p.status = 204; p.responseBody = Data([1]); try rejects { try p.live.updateRuleProvider(name: "Only", before: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: {}, beforeDispatch: {}) }; try expect(p.log.count == 1)
        }
        peerTest("truncated or chunked GET is rejected not decoded or retried") { p in
            for response in ["HTTP/1.0 200 Fixture\r\nContent-Length: 50\r\n\r\n{}", "HTTP/1.1 200 Fixture\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n"] {
                p.rawResponse = Data(response.utf8); try rejects { _ = try p.live.readRuleProviders(before: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: {}) }
            }
            try expect(p.log.count == 2)
        }
        peerTest("GET response above provider-only 2MiB limit is rejected") { p in
            p.responseBody = Data(repeating: 32, count: 2 * 1024 * 1024 + 1)
            try rejects { _ = try p.live.readRuleProviders(before: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: {}) }; try expect(p.log.count == 1)
        }

        test("bound inline provider nodes and private filters remain while health checks are disabled") {
            let f = try Fixture { value in
                value["proxy-providers"] = ["Nodes": ["type": "inline", "payload": [["type": "ss", "name": "Node", "server": "synthetic.invalid", "port": 443, "cipher": "aes-128-gcm", "password": "private-synthetic"]], "filter": "Node", "override": ["udp": false], "health-check": ["enable": true, "url": "https://synthetic.invalid/health", "interval": 30]]]
                value["proxy-groups"] = [["name": "Group", "type": "url-test", "use": ["Nodes"], "url": "https://synthetic.invalid/health", "interval": 30]]
            }
            let p = try f.projection(), raw = try RelayTunStrictJSON.object(p.configuration), providers = raw["proxy-providers"] as! [String: Any], node = providers["Nodes"] as! [String: Any]
            try expect((node["payload"] as? [[String: Any]])?.count == 1 && node["filter"] as? String == "Node" && (node["override"] as? [String: Any])?["udp"] as? Bool == false)
            try expect((node["health-check"] as? [String: Any])?["enable"] as? Bool == false)
            let groups = raw["proxy-groups"] as! [[String: Any]]; try expect(groups[0]["type"] as? String == "select" && groups[0]["use"] as? [String] == ["Nodes"] && groups[0]["interval"] as? Int == 0)
            try expect(try RelayTunStrictJSON.object(f.configuration)["proxy-groups"] is [[String: Any]])
        }
        test("Session registers strong recovery capability before building or preparing files") {
            let p = try Fixture().projection(); var kept: Q.Session?, events = [String]()
            let session = Q.Session(projection: p, deadline: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: {}, buildWorkspace: { projection in
                try expect(kept != nil); events.append("build")
                return try .init(directory: "/private/tmp/relay-provider-probe-\(getuid())-synthetic", configuration: projection.configuration, coreSHA256: Q.corePin.sha256, coreBytes: Q.corePin.bytes,
                                 prepare: { events.append("prepare"); throw Bad.revoked }, verify: { events.append("verify") }, cleanup: { events.append("cleanup") })
            }, register: { kept = $0; events.append("register") })
            try rejects { _ = try session.perform() }; try expect(events == ["register", "build", "prepare", "cleanup"] && session.isSettled)
        }
        test("cancelled pure worker gate creates no workspace or process and settles registered cap") {
            let p = try Fixture().projection(); var builds = 0
            let session = Q.Session(projection: p, deadline: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: { throw Bad.revoked }, buildWorkspace: { _ in builds += 1; throw Bad.failed("unexpected") }, register: { _ in })
            try rejects { _ = try session.perform() }; try expect(builds == 0 && session.isSettled)
        }
        test("unknown workspace cleanup stays unsettled until explicit exact recovery succeeds") {
            let p = try Fixture().projection(); var complete = false, cleanups = 0
            let session = Q.Session(projection: p, deadline: DispatchTime.now().uptimeNanoseconds + 1_000_000_000, check: {}, buildWorkspace: { projection in
                try .init(directory: "/private/tmp/relay-provider-probe-\(getuid())-synthetic", configuration: projection.configuration, coreSHA256: Q.corePin.sha256, coreBytes: Q.corePin.bytes,
                          prepare: { throw Bad.revoked }, verify: {}, cleanup: { cleanups += 1; if !complete { throw Bad.revoked } })
            }, register: { _ in })
            try rejects { _ = try session.perform() }; try expect(!session.isSettled && cleanups == 1)
            complete = true; try session.cleanup(); try expect(session.isSettled && cleanups == 2)
        }

        test("four existing Geo assets survive complete candidate projection byte-exact") {
            let f = try Fixture(), s = f.snapshot
            var assets = s.assets
            for (i, kind) in G.Kind.allCases.enumerated() { let bytes = Data([UInt8(i + 1)]); assets.append(try .init(path: kind.basename, data: bytes, identity: identity(UInt64(i + 10), bytes.count))) }
            let full = try Q.Snapshot(configuration: s.configuration, assets: assets, context: s.context, group: s.group, expectedRuleCounts: s.expectedRuleCounts)
            let p = try Q.project(full, blob: f.blob, declaredRuleCount: 1)
            for (i, kind) in G.Kind.allCases.enumerated() { try expect(p.assets[kind.basename] == Data([UInt8(i + 1)])) }
        }
        test("non-target inline partial parsing or unknown name prevents whole-candidate acceptance") {
            let f = try Fixture(alias: false), s = f.snapshot
            var value = try RelayTunStrictJSON.object(s.configuration), defs = value["rule-providers"] as! [String: Any]
            defs["Other"] = ["type": "inline", "behavior": "classical", "payload": ["MATCH", "DOMAIN,synthetic.invalid"]]; value["rule-providers"] = defs
            let config = try json(value), owner = try P.Owner(heldGeneration: s.context.owner.heldGeneration, configurationRevision: G.digest(config), coreSHA256: s.context.owner.coreSHA256, ordinaryUID: getuid())
            let full = try Q.Snapshot(configuration: config, assets: s.assets, context: .init(owner: owner, geo: s.context.geo), group: s.group, expectedRuleCounts: ["Only": 1, "Other": 2])
            let p = try Q.project(full, blob: f.blob, declaredRuleCount: 1)
            var metadata = try RelayTunStrictJSON.object(f.metadata()), entries = metadata["providers"] as! [String: Any]
            entries["Other"] = ["name": "Other", "type": "Rule", "ruleCount": 1]; metadata["providers"] = entries
            try rejects { _ = try Q.accepted(p, putAccepted: ["Only"], metadata: json(metadata)) }
            entries["Other"] = ["name": "Other", "type": "Rule", "ruleCount": 2]; metadata["providers"] = entries
            try expect(Q.accepted(p, putAccepted: ["Only"], metadata: json(metadata)).counts["Other"] == 2)
            entries["Unknown"] = ["name": "Unknown", "type": "Rule", "ruleCount": 0]; metadata["providers"] = entries
            try rejects { _ = try Q.accepted(p, putAccepted: ["Only"], metadata: json(metadata)) }
        }
        let failed = rows.filter { $0["passed"] as? Bool == false }.count
        let result: [String: Any] = ["scope": "pure projection/receipt validation and ordinary UID private Unix responder; no actual Core acceptance/lifecycle", "passed": rows.count - failed, "failed": failed, "tests": rows]
        let bytes = try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]); FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10])); exit(failed == 0 ? 0 : 1)
    }
}
