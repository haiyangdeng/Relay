import Foundation
import Darwin

private typealias Rules = RelayTunRuntimeRules
private typealias Readiness = RelayTunCoreReadiness
private enum Injected: Error { case failed }

@main struct RelayTunRuntimeRulesIOTests {
    private static let binding = try! Rules.Binding(["sessionId": "33333333-3333-4333-8333-333333333333",
        "evidenceSHA256": String(repeating: "e", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64)])
    static func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    static func table(_ count: Int = 2) -> [[String: Any]] {
        (0..<count).map { ["index": $0, "type": "Domain", "payload": "fixture-\($0).invalid", "proxy": "DIRECT", "size": -1,
                          "extra": ["disabled": false, "hitCount": 0]] }
    }
    static var configuration: [String: Any] {
        ["port": 0, "socks-port": 0, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0,
         "mode": "rule", "allow-lan": false, "ipv6": true, "secret": "synthetic-rules-fixture",
         "tun": ["enable": true, "device": "utun42", "stack": "mixed", "mtu": 1500,
                 "auto-route": false, "auto-detect-interface": false, "dns-hijack": [String](),
                 "auto-redirect": false, "gso": false, "recvmsgx": false, "sendmsgx": false, "dns-mode": "disabled"]]
    }
    static func write(_ path: String, _ data: Data) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Injected.failed }; defer { Darwin.close(fd) }
        try data.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                guard count > 0 else { throw Injected.failed }; sent += count
            }
        }
    }
    private final class Server {
        let directory: String, mode: String, source: [String: Any]
        let lock = NSLock()
        var rules = table(), log = [[String: Any]](), reads = 0
        init(_ directory: String, mode: String) throws {
            self.directory = directory; self.mode = mode
            source = try RelayTunStrictJSON.object(Data(contentsOf: URL(fileURLWithPath: directory + "/config.yaml")), limit: 2 * 1024 * 1024)
            if mode == "large" { rules = table(10000) }
        }
        func handle(_ fd: Int32) {
            defer { Darwin.close(fd) }
            do {
                var noSignal: Int32 = 1
                guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw Injected.failed }
                var request = Data(), buffer = [UInt8](repeating: 0, count: 1024)
                while request.range(of: Data("\r\n\r\n".utf8)) == nil {
                    let count = Darwin.read(fd, &buffer, buffer.count)
                    guard count > 0, request.count + count < 8192 else { return }
                    request.append(contentsOf: buffer.prefix(count))
                }
                guard let boundary = request.range(of: Data("\r\n\r\n".utf8)),
                      let header = String(data: request[..<boundary.lowerBound], encoding: .utf8),
                      let first = header.components(separatedBy: "\r\n").first else { throw Injected.failed }
                let parts = first.split(separator: " "); guard parts.count == 3 else { throw Injected.failed }
                let method = String(parts[0]), path = String(parts[1])
                var length = 0
                for line in header.components(separatedBy: "\r\n").dropFirst() where line.hasPrefix("Content-Length: ") {
                    guard let value = Int(line.dropFirst(16)), (0...1024).contains(value) else { throw Injected.failed }; length = value
                }
                while request.count - boundary.upperBound < length {
                    let count = Darwin.read(fd, &buffer, buffer.count); guard count > 0 else { return }
                    request.append(contentsOf: buffer.prefix(count))
                }
                let payload = Data(request[boundary.upperBound...])
                lock.lock()
                log.append(["method": method, "path": path, "body": String(data: payload, encoding: .utf8) ?? "invalid",
                            "syntheticAuthorizationMatched": header.contains("Authorization: Bearer synthetic-rules-fixture\r\n")])
                try write(directory + "/requests.json", bytes(log))
                var body = Data(), status = "200 OK", extraHeader = ""
                if method == "GET", path == "/version" { body = try bytes(["version": "v1.19.33"]) }
                else if method == "GET", path == "/configs" {
                    var configs = source
                    if let mode = try? String(contentsOfFile: directory + "/observed-mode", encoding: .utf8) { configs["mode"] = mode }
                    body = try bytes(configs)
                } else if method == "GET", path == "/rules" {
                    reads += 1
                    if mode == "drift", reads >= 4 { rules[1]["payload"] = "changed.invalid" }
                    body = try bytes(["rules": rules])
                    switch mode {
                    case "get503": status = "503 Unavailable"
                    case "get204": status = "204 No Content"
                    case "chunked": extraHeader = "Transfer-Encoding: chunked\r\n"
                    case "duplicate-length": extraHeader = "Content-Length: \(body.count)\r\n"
                    case "duplicate-json": body = Data("{\"rules\":[],\"rul\\u0065s\":[]}".utf8)
                    case "oversized": body = Data(repeating: 32, count: Rules.tableLimit + 1)
                    case "bad-utf8": body = Data([0xff])
                    default: break
                    }
                } else if method == "PATCH", path == "/rules/disable" {
                    let raw = try RelayTunStrictJSON.object(payload, limit: 1024)
                    guard raw.count == 1, let key = raw.keys.first, let index = Int(key), rules.indices.contains(index),
                          let disabled = Rules.boolean(raw[key]) else { throw Injected.failed }
                    if mode != "nochange" {
                        let target = mode == "other-bit" ? (index + 1) % rules.count : index
                        var value = rules[target]["extra"] as! [String: Any]; value["disabled"] = disabled; rules[target]["extra"] = value
                    }
                    status = mode == "patch200" ? "200 OK" : "204 No Content"
                    if mode == "patch-body" { body = Data("unexpected".utf8) }
                } else { status = "404 Not Found" }
                lock.unlock()
                if mode == "delay", path == "/rules" { usleep(650000) }
                if mode == "disconnect", method == "PATCH" { return }
                var declared = body.count
                if mode == "truncated" { declared += 10 }
                if mode == "wrong-length" { declared = max(0, declared - 1) }
                if mode == "patch-nonzero-length", method == "PATCH" { declared = 1 }
                let contentLength = mode == "eof" ? "" : "Content-Length: \(declared)\r\n"
                var response = Data("HTTP/1.0 \(status)\r\n\(extraHeader)\(contentLength)Connection: close\r\n\r\n".utf8)
                response.append(body)
                response.withUnsafeBytes { raw in
                    var sent = 0
                    while sent < raw.count {
                        let count = Darwin.write(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                        guard count > 0 else { return }; sent += count
                    }
                }
            } catch { /* A closed private fixture connection has no lifecycle effect. */ }
        }
    }
    static func serve(_ directory: String, mode: String) throws -> Never {
        var info = stat()
        guard directory.hasPrefix("/private/tmp/relay-rulesio-"), lstat(directory, &info) == 0,
              info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else { throw Injected.failed }
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: directory))
        let server = try Server(directory, mode: mode), fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Injected.failed }; defer { Darwin.close(fd) }
        let path = directory + "/api.sock"; guard path.utf8.count < 100 else { throw Injected.failed }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8CString.map { UInt8(bitPattern: $0) }) }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, listen(fd, 16) == 0 else { throw Injected.failed }
        FileHandle.standardOutput.write(Data("READY\n".utf8))
        while true {
            let connection = accept(fd, nil, nil)
            if connection < 0, errno == EINTR { continue }
            guard connection >= 0 else { throw Injected.failed }
            DispatchQueue.global().async { server.handle(connection) }
        }
    }
    private final class Peer {
        let directory = "/private/tmp/relay-rulesio-" + UUID().uuidString.lowercased()
        let process = Process(), ready = Pipe()
        var live: Readiness.Live!
        var beforePeer: (() throws -> Void)?, peerChecks = 0
        init(_ mode: String) throws {
            guard mkdir(directory, 0o700) == 0 else { throw Injected.failed }
            try write(directory + "/config.yaml", bytes(configuration)); try write(directory + "/requests.json", bytes([]))
            process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); process.arguments = ["--private-rules-peer", directory, mode]
            process.standardOutput = ready; process.standardError = FileHandle.nullDevice; try process.run()
            guard try ready.fileHandleForReading.read(upToCount: 6) == Data("READY\n".utf8) else { throw Injected.failed }
            live = try Readiness.Live(directory: directory, configuration: bytes(configuration), authorization: "synthetic-rules-fixture", verifyPeer: { [weak self] fd in
                guard let self else { throw Injected.failed }
                var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0, effective: pid_t = 0
                var length = socklen_t(MemoryLayout<pid_t>.size), effectiveLength = length
                guard self.process.isRunning, getpeereid(fd, &uid, &gid) == 0, uid == getuid(), gid == getgid(),
                      getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid == self.process.processIdentifier,
                      getsockopt(fd, SOL_LOCAL, LOCAL_PEEREPID, &effective, &effectiveLength) == 0,
                      effective == self.process.processIdentifier else { throw Injected.failed }
                self.peerChecks += 1; try self.beforePeer?()
            })
        }
        deinit {
            if process.isRunning { process.terminate() }; process.waitUntilExit()
            try? ready.fileHandleForReading.close(); try? ready.fileHandleForWriting.close()
            try? FileManager.default.removeItem(atPath: directory)
        }
        var requests: [[String: Any]] { (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: directory + "/requests.json"))) as? [[String: Any]]) ?? [] }
        var patches: Int { requests.filter { $0["method"] as? String == "PATCH" }.count }
    }
    private final class Model {
        let peer: Peer
        var controller: Rules.Controller!, ownerLive = true, duringFinalContext: (() throws -> Void)?
        let owner = try! Rules.Owner(generation: 1, configurationRevision: String(repeating: "a", count: 64))
        init(_ mode: String) throws {
            peer = try Peer(mode)
            controller = .init(binding: binding, driver: .init(currentOwner: { [unowned self] in
                guard self.ownerLive else { throw Rules.Failure.revoked }; return self.owner
            }, read: { [unowned self] access, done in
                do { done(.success(try self.peer.live.readRules(access))) } catch { done(.failure(error)) }
            }, apply: { [unowned self] mutation, access, done in
                do { done(.success(try self.peer.live.patchRule(mutation, access: access, verifyContext: { try self.duringFinalContext?() }))) }
                catch { done(.failure(error)) }
            }))
        }
        func perform(_ id: Int, _ operation: Rules.Operation) throws -> Rules.Reply {
            var answer: Rules.Reply?
            controller.perform(.init(id: id, binding: binding, operation: operation)) { answer = $0 }
            guard let answer else { throw Injected.failed }; return answer
        }
        func prepare() throws -> String {
            let snapshot = try perform(1, .read).snapshot
            guard let sha = snapshot?.sha256 else { throw Injected.failed }
            let reply = try perform(2, .prepare(configurationRevision: owner.configurationRevision, rulesSHA256: sha, index: 0, disabled: true))
            guard let nonce = reply.prepared?["nonce"] as? String else { throw Injected.failed }; return nonce
        }
    }
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), getgid() == getegid() else { exit(77) }
        if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--private-rules-peer" {
            do { try serve(CommandLine.arguments[2], mode: CommandLine.arguments[3]) } catch { exit(1) }
        }
        guard CommandLine.arguments.count == 1 else { exit(77) }
        var checks = [[String: Any]]()
        func check(_ name: String, _ value: Bool) { checks.append(["name": name, "passed": value]) }
        func rejects(_ name: String, _ run: () throws -> Void) {
            do { try run(); check(name, false) } catch { check(name, true) }
        }
        do {
            let boundary = try bytes(["values": Array(repeating: 0, count: 4094)])
            check("default scanner accepts exactly4096 nodes", (try? RelayTunStrictJSON.object(boundary, limit: 65536)) != nil)
            let beyond = try bytes(["values": Array(repeating: 0, count: 4095)])
            rejects("default scanner still refuses4097 nodes") { _ = try RelayTunStrictJSON.object(beyond, limit: 65536) }
            rejects("explicit scanner cannot exceed hard200000 budget") { _ = try RelayTunStrictJSON.object(boundary, limit: 65536, maxNodes: 200001) }
            let large = try bytes(["rules": table(10000)])
            check("rules-only raw decoder accepts complete10000 rows over64KiB", try Readiness.rulesSnapshot(large).rows.count == 10000 && large.count > 65536)
            rejects("raw rules count10001 is not truncated") { _ = try Readiness.rulesSnapshot(bytes(["rules": table(10001)])) }
            rejects("raw rules >2MiB rejected before parse") { _ = try Readiness.rulesSnapshot(Data(repeating: 32, count: Rules.tableLimit + 1)) }
            for data in [Data("{\"rules\":[],\"rul\\u0065s\":[]}".utf8), Data([0xff]), Data("{\"rules\":[],\"extra\":true}".utf8)] {
                rejects("rules raw decoder rejects duplicate UTF8 or unknown top-level") { _ = try Readiness.rulesSnapshot(data) }
            }
            do {
                let model = try Model("normal"), nonce = try model.prepare()
                check("actual authenticated Unix prepare sends no PATCH", model.peer.patches == 0)
                let result = try model.perform(3, .commit(nonce: nonce))
                check("actual Unix single-index PATCH204 requires exact full-table readback", result.status == .changed && result.snapshot?.rows[0].disabled == true && result.snapshot?.rows[1].disabled == false && model.peer.patches == 1)
                check("fixed request paths and synthetic bearer only follow peer proof", model.peer.requests.allSatisfy { ["/rules", "/rules/disable"].contains($0["path"] as? String ?? "") && $0["syntheticAuthorizationMatched"] as? Bool == true })
                check("PATCH exact one primitive boolean body", model.peer.requests.first { $0["method"] as? String == "PATCH" }?["body"] as? String == "{\"0\":true}")
                check("consumed nonce never resends actual PATCH", try model.perform(4, .commit(nonce: nonce)).status == .stale && model.peer.patches == 1)
                rejects("old read API cannot request rules or arbitrary path") { _ = try model.peer.live.read("rules") }
            }
            for mode in ["nochange", "other-bit", "patch200", "patch-body", "patch-nonzero-length", "disconnect"] {
                let model = try Model(mode), nonce = try model.prepare(), result = try model.perform(3, .commit(nonce: nonce))
                check("actual admitted \(mode) is uncertain with one attempt and no retry", result.status == .uncertain && model.peer.patches == 1)
            }
            do {
                let model = try Model("drift"), nonce = try model.prepare(), result = try model.perform(3, .commit(nonce: nonce))
                check("last writer GET full-table drift rejects before actual PATCH", result.status == .stale && model.peer.patches == 0)
            }
            for mode in ["get503", "get204", "chunked", "duplicate-length", "duplicate-json", "oversized", "bad-utf8", "truncated", "wrong-length", "delay"] {
                let model = try Model(mode), start = Rules.now, result = try model.perform(1, .read)
                check("actual Unix \(mode) fails closed without mutation", result.snapshot == nil && model.peer.patches == 0 && Rules.now - start < 1_500_000_000)
            }
            do {
                let model = try Model("eof"), nonce = try model.prepare(), result = try model.perform(3, .commit(nonce: nonce))
                check("HTTP1.0 EOF-delimited rules and empty204 require no chunk decoder", result.status == .changed && model.peer.patches == 1)
            }
            do {
                let model = try Model("large"), result = try model.perform(1, .read)
                check("actual Unix rules reader preserves10000 rows", result.snapshot?.rows.count == 10000)
                rejects("old readiness parser remains limited64KiB") { _ = try RelayTunCoreProbePlan.httpBody(Data("HTTP/1.0 200 OK\r\n\r\n".utf8) + large) }
            }
            do {
                let model = try Model("normal"), nonce = try model.prepare()
                model.duringFinalContext = { [weak model] in model?.controller.close() }
                let result = try model.perform(3, .commit(nonce: nonce))
                check("scope revocation in final private preflight dispatches0PATCH", result.status == .cancelled && model.peer.patches == 0)
            }
            do {
                let model = try Model("normal"), nonce = try model.prepare()
                model.duringFinalContext = { [weak model] in model?.ownerLive = false }
                let result = try model.perform(3, .commit(nonce: nonce))
                check("owner revocation after peer IO dispatches0PATCH", result.status == .stale && model.peer.patches == 0)
            }
            do {
                let model = try Model("normal"), nonce = try model.prepare()
                var finalChecks = 0
                model.duringFinalContext = { [weak model] in
                    finalChecks += 1; if finalChecks == 2 { model?.ownerLive = false }
                }
                let result = try model.perform(3, .commit(nonce: nonce))
                check("post-PATCH context loss remains uncertain and never retries GET or PATCH", result.status == .uncertain && model.peer.patches == 1 && model.peer.requests.last?["method"] as? String == "PATCH")
            }
            do {
                let model = try Model("normal")
                model.peer.beforePeer = { throw Injected.failed }
                let result = try model.perform(1, .read)
                check("unproved private peer receives0secret request", result.snapshot == nil && model.peer.requests.isEmpty)
            }
            do {
                let peer = try Peer("normal"), baseline = RelayTunNetworkTransaction.Baseline(networkSHA256: String(repeating: "b", count: 64), protectionSHA256: String(repeating: "c", count: 64))
                var launched = false, authorized = true, stops = 0, listenerChecks = 0, protectionChanged = false
                var afterCapture: ((String) throws -> Void)?
                let managed = try RelayTunManagedCore(configuration: bytes(configuration), baseline: baseline, authorized: { authorized }, driver: .init(verify: { try peer.live.verifySource() }, hold: {}, launch: { register in
                    launched = true
                    register(.init(observe: { launched ? .running : .exited(0) }, stop: { stops += 1; launched = false; return .init(waitStatus: 0, forced: false) }, read: { try peer.live.read($0) }, verifyListeners: { _, _ in listenerChecks += 1; throw Injected.failed }, readCapture: { endpoint, deadline in
                        let result = try peer.live.read(endpoint, before: deadline); try afterCapture?(endpoint); return result
                    }, readRules: { try peer.live.readRules($0) }, applyRule: { try peer.live.patchRule($0, access: $1, verifyContext: $2) }))
                }, interfacePresent: { launched }, baseline: {
                    protectionChanged ? .init(networkSHA256: baseline.networkSHA256, protectionSHA256: String(repeating: "d", count: 64)) : baseline
                }, dispose: {}))
                try managed.start()
                try write(peer.directory + "/observed-mode", Data("global".utf8))
                let controller = Rules.Controller(binding: binding, driver: .init(currentOwner: managed.runtimeRulesOwner, read: { access, done in
                    do { done(.success(try managed.readRuntimeRules(access))) } catch { done(.failure(error)) }
                }, apply: { mutation, access, done in
                    do { done(.success(try managed.applyRuntimeRule(mutation, access: access))) } catch { done(.failure(error)) }
                }))
                func perform(_ id: Int, _ operation: Rules.Operation) throws -> Rules.Reply {
                    var answer: Rules.Reply?; controller.perform(.init(id: id, binding: binding, operation: operation)) { answer = $0 }
                    guard let answer else { throw Injected.failed }; return answer
                }
                let observed = try perform(1, .read), owner = try managed.runtimeRulesOwner()
                let sourceSHA = RelayTunHelperTrust.digest(try bytes(configuration))
                check("actual managed composition supports HTTPport0 and legal mode drift without PCB", observed.status == .snapshot && listenerChecks == 0 && owner.configurationRevision == sourceSHA)
                let plan = try perform(2, .prepare(configurationRevision: owner.configurationRevision, rulesSHA256: observed.snapshot!.sha256, index: 0, disabled: true))
                let result = try perform(3, .commit(nonce: plan.prepared!["nonce"] as! String))
                check("managed context and held Unix callbacks complete only one exact bit", result.status == .changed && peer.patches == 1 && stops == 0)
                try write(peer.directory + "/observed-mode", Data("unknown".utf8))
                check("managed rules reject unsupported observed mode without stopping owner", try perform(4, .read).snapshot == nil && stops == 0)
                try write(peer.directory + "/observed-mode", Data("global".utf8))
                let beforeVersion = peer.requests.count
                afterCapture = { if $0 == "version" { authorized = false } }
                let between = try perform(5, .read)
                check("authorization lost after version prevents configs and rule request", between.snapshot == nil && peer.requests.count == beforeVersion + 1 && peer.requests.last?["path"] as? String == "/version" && stops == 0)
                authorized = true; afterCapture = nil; protectionChanged = true
                let beforeProtection = peer.requests.count
                check("managed baseline protection loss prevents further socket requests", try perform(6, .read).snapshot == nil && peer.requests.count == beforeProtection && stops == 0)
                protectionChanged = false
                let original = try bytes(configuration)
                try write(peer.directory + "/config.yaml", original + Data([10]))
                let beforeSource = peer.requests.count
                check("changed loaded source prevents rules and credentials", try perform(7, .read).snapshot == nil && peer.requests.count == beforeSource && stops == 0)
                try write(peer.directory + "/config.yaml", original)
                authorized = false
                let rejected = try perform(8, .read)
                check("read capability failure never stops or recovers managed owner", rejected.snapshot == nil && launched && stops == 0 && !managed.released)
            }
        } catch { check("fixture setup and every expected control path completed", false) }
        let failed = checks.filter { $0["passed"] as? Bool != true }.count
        let report: [String: Any] = ["scope": "ordinary UID private Unix peers and injected managed owner only", "passed": checks.count - failed, "failed": failed, "checks": checks,
            "actualCoreOrTUN": false, "actualUID0OrSetuidChild": false, "actualPrivateUnixHTTP": true, "installed": false, "systemNetworkChanged": false]
        if let raw = try? bytes(report) { FileHandle.standardOutput.write(raw); FileHandle.standardOutput.write(Data([10])) }
        exit(failed == 0 ? 0 : 1)
    }
}
