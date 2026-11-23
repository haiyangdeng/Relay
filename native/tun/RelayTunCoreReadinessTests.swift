import Foundation
import CryptoKit
import Darwin

private typealias Readiness = RelayTunCoreReadiness
private typealias Host = RelayTunCoreHost
private enum Injected: Error { case failure }

private struct Fixture {
    var configuration: [String: Any] = [
        "port": 18291, "socks-port": 18292, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0,
        "mode": "rule", "allow-lan": false, "ipv6": true,
        "tun": ["enable": true, "file-descriptor": 3, "device": "utun", "stack": "mixed", "mtu": 1500,
                "auto-route": true, "auto-detect-interface": true, "dns-hijack": ["any:53"],
                "auto-redirect": false, "gso": false, "recvmsgx": false, "sendmsgx": false, "dns-mode": "hijack"]
    ]
    // Fixed v1.19.33 returns its declared device, even when FD 3 is utun42.
    var response: [String: Any] { configuration }
    static func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    func bytes() throws -> Data { try Self.data(configuration) }
    func binding(_ data: Data? = nil) throws -> Host.Binding {
        let bytes = try data ?? self.bytes()
        let receipt = try RelayTunAcquiredReceipt(installationRevision: String(repeating: "a", count: 64), clientUID: getuid(),
            evidenceSHA256: String(repeating: "b", count: 64), runtimeConfigurationSHA256: RelayTunHelperTrust.digest(bytes),
            planID: "11111111-1111-4111-8111-111111111111", sessionID: "22222222-2222-4222-8222-222222222222",
            deviceID: "33333333-3333-4333-8333-333333333333", interfaceName: "utun42", interfaceIndex: 91,
            controlID: 17, controlUnit: 43, socketDevice: "7", socketInode: "18446744073709551615")
        return try .init(receipt: receipt, coreSHA256: RelayTunInstallationPaths.fixedCorePins["arm64"]!.0)
    }
    func readiness(_ bytes: Data? = nil, mtu: Int = 1500) throws -> Readiness {
        let data = try bytes ?? self.bytes()
        return try .init(binding: binding(data), configuration: data, managedMTU: mtu)
    }
    mutating func tun(_ key: String, _ value: Any?) {
        var tun = configuration["tun"] as! [String: Any]; tun[key] = value; configuration["tun"] = tun
    }
    func observe(_ response: [String: Any]? = nil, version: Data? = nil, mtu: Int = 1500) throws -> Host.RuntimeObservation {
        let readiness = try self.readiness(mtu: mtu), configs = try Self.data(response ?? self.response)
        return try readiness.observe(read: { endpoint in
            endpoint == "version" ? (version ?? Data("{\"version\":\"v1.19.33\"}".utf8)) : configs
        }, verify: {})
    }
}

@main struct RelayTunCoreReadinessTests {
    // Inert HTTP server used only by this test executable. It owns no TUN,
    // proxy port, DNS listener or external connection.
    private static func servePrivatePeer(_ directory: String, mode: String) throws {
        var info = stat()
        guard directory.hasPrefix("/private/tmp/relay-ready-"),
              lstat(directory, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else { throw Injected.failure }
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: directory))
        let configs = try Data(contentsOf: URL(fileURLWithPath: directory + "/config.yaml"))
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw Injected.failure }; defer { Darwin.close(listener) }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let path = directory + "/api.sock"
        guard path.utf8.count < 100 else { throw Injected.failure }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8CString.map { UInt8(bitPattern: $0) }) }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, listen(listener, 4) == 0 else { throw Injected.failure }
        FileHandle.standardOutput.write(Data("READY\n".utf8))
        var selection = "NodeA"
        while true {
            let connection = accept(listener, nil, nil)
            if connection < 0 && errno == EINTR { continue }
            guard connection >= 0 else { throw Injected.failure }
            do {
                defer { Darwin.close(connection) }
                var request = Data(), buffer = [UInt8](repeating: 0, count: 1024)
                while request.range(of: Data("\r\n\r\n".utf8)) == nil {
                    let count = Darwin.read(connection, &buffer, buffer.count)
                    guard count > 0, request.count + count <= 4096 else { throw Injected.failure }
                    request.append(contentsOf: buffer.prefix(count))
                }
                let isVersion = request.starts(with: Data("GET /version ".utf8))
                var body = isVersion ? Data("{\"version\":\"v1.19.33\"}".utf8) : configs
                if !isVersion && mode == "invalid-json" { body = Data("{\"private-invalid-response\":".utf8) }
                if !isVersion && mode == "oversized" { body = Data(repeating: 65, count: 80000) }
                var status = !isVersion && mode == "invalid-http" ? "503 Unavailable" : "200 OK"
                if mode == "normal", let message = String(data: request, encoding: .utf8) {
                    let group = "节点 / Group%2F", segment = group.utf8.map { String(format: "%%%02X", $0) }.joined()
                    if message.hasPrefix("GET /proxies ") {
                        body = try Fixture.data(["proxies":[group:["name":group, "type":"Selector", "all":["NodeA","NodeB"],"now":selection],
                            "NodeA":["name":"NodeA", "type":"Http"]]])
                    } else if message.hasPrefix("GET /providers/proxies ") {
                        body = try Fixture.data(["providers":["Fixture":["subscriptionInfo":["secret":"private-source"],"proxies":[["name":"NodeB","type":"Http","server":"private-fixture"]]]]])
                    } else if message.hasPrefix("PUT /proxies/" + segment + " ") {
                        guard let separator = request.range(of: Data("\r\n\r\n".utf8)),
                              let change = try JSONSerialization.jsonObject(with: request[separator.upperBound...]) as? [String:String],
                              change == ["name":"NodeB"] else { throw Injected.failure }
                        selection = "NodeB"; body = Data(); status = "204 No Content"
                    }
                }
                var response = Data("HTTP/1.0 \(status)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
                response.append(body)
                try response.withUnsafeBytes { raw in
                    var sent = 0
                    while sent < raw.count {
                        let count = Darwin.write(connection, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                        guard count > 0 else { throw Injected.failure }; sent += count
                    }
                }
            }
        }
    }
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), getgid() == getegid() else { exit(77) }
        if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--private-http-peer",
           ["normal", "invalid-http", "invalid-json", "oversized"].contains(CommandLine.arguments[3]) {
            do { try servePrivatePeer(CommandLine.arguments[2], mode: CommandLine.arguments[3]) } catch { exit(1) }
            return
        }
        guard CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = [], stage = "injected", privateSocketConnected = false
        func check(_ value: Bool, _ name: String) { rows.append(["name": name, "passed": value]) }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); check(false, name) } catch { check(true, name) }
        }
        func diagnoses(_ name: String, _ failure: Readiness.Failure, _ body: () throws -> Void) {
            do { try body(); check(false, name) }
            catch { check(error as? Readiness.Failure == failure, name) }
        }
        do {
            let fixture = Fixture(), readiness = try fixture.readiness(), configs = try Fixture.data(fixture.response)
            do {
                let fd = open("/dev/null", O_RDONLY | O_CLOEXEC)
                guard fd >= 0 else { throw Injected.failure }
                let delivered = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                var checkedBundle = false
                let live = try RelayTunLiveCore(receipt: fixture.binding().receipt, delivered: delivered,
                    configuration: fixture.bytes(), directory: "/not-opened", managedMTU: 1500,
                    authorization: { false }, verifyBundle: { checkedBundle = true })
                let host = try live.makeHost(), token = host.recoveryToken
                rejects("live composition cannot create another host for the same delivery") { _ = try live.makeHost() }
                rejects("revoked live composition refuses before root trust, FD admission or spawn") { _ = try host.start() }
                check(!checkedBundle && fcntl(fd, F_GETFD) >= 0 && Host.recover(token) === host,
                      "failed pre-admission start retains original delivery and recovery owner")
                let released = try host.release()
                check(released.released && released.clientFDClosed && fcntl(fd, F_GETFD) == -1,
                      "explicit pre-admission release positively closes original delivered FD")
                check(Host.recover(token) == nil, "only confirmed pre-admission FD closure retires recovery owner")
            }
            do {
                let fd = open("/dev/null", O_RDONLY | O_CLOEXEC)
                guard fd >= 0 else { throw Injected.failure }
                let delivered = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                let live = try RelayTunLiveCore(receipt: fixture.binding().receipt, delivered: delivered,
                    configuration: fixture.bytes(), directory: "/not-opened", managedMTU: 1500,
                    authorization: { true }, verifyBundle: { throw Injected.failure })
                let host = try live.makeHost()
                let released = try host.release()
                check(released.released && fcntl(fd, F_GETFD) == -1,
                      "cancellation before start closes an already-delivered FD without spawn or trust IO")
            }
            var order: [String] = []
            let observed = try readiness.observe(read: { endpoint in
                order.append(endpoint)
                return endpoint == "version" ? Data("{\"version\":\"v1.19.33\"}".utf8) : configs
            }, verify: { order.append("verify") })
            check(order == ["verify", "version", "verify", "configs", "verify"], "verification brackets both response reads and readiness publication")
            check(observed.binding == readiness.binding && observed.coreVersion == "v1.19.33" && observed.inheritedDescriptor == 3 &&
                  observed.runtimeConfigurationSHA256 == readiness.binding.receipt.runtimeConfigurationSHA256,
                  "observation binds exact receipt, runtime digest, fixed version and inherited FD")
            do {
                var managed = fixture.configuration, managedTun = managed["tun"] as! [String: Any]
                managedTun.removeValue(forKey: "file-descriptor"); managed["tun"] = managedTun
                var response = fixture.response, actualTun = response["tun"] as! [String: Any]
                actualTun["file-descriptor"] = 0; response["tun"] = actualTun; response["mode"] = "global"
                let source = try Fixture.data(managed), changed = try Fixture.data(response)
                check(try Readiness.validateManagedCapture(configuration: source, version: Data("{\"version\":\"v1.19.33\"}".utf8), configs: changed) == "global",
                    "read-only managed capture accepts observed supported mode")
                rejects("startup managed readiness still rejects mode drift") {
                    try Readiness.validateManaged(configuration: source, version: Data("{\"version\":\"v1.19.33\"}".utf8), configs: changed)
                }
                response["mode"] = "unknown"
                rejects("read-only managed capture rejects unknown mode") {
                    _ = try Readiness.validateManagedCapture(configuration: source, version: Data("{\"version\":\"v1.19.33\"}".utf8), configs: Fixture.data(response))
                }
            }
            do {
                // Generated by the fixed upstream parser and the same Tun
                // serializer used by /configs, without starting a core/device.
                let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                    .appendingPathComponent("fixtures/mihomo-3f27-tun-readiness.json")
                let contract = try RelayTunStrictJSON.object(Data(contentsOf: url), limit: 65536)
                guard contract["upstreamCommit"] as? String == "3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8",
                      let cases = contract["cases"] as? [[String: Any]], cases.count == 5 else { throw Injected.failure }
                for item in cases {
                    guard let name = item["name"] as? String, let source = item["source"] as? [String: Any],
                          let sourceTun = source["tun"] as? [String: Any], let apiTun = item["apiTun"] as? [String: Any] else { throw Injected.failure }
                    var response = source; response["tun"] = apiTun
                    let version = Data("{\"version\":\"v1.19.33\"}".utf8)
                    do {
                        try Readiness.validateManaged(configuration: Fixture.data(source), version: version, configs: Fixture.data(response))
                        check(true, "upstream DNS mode contract managed startup: " + name)
                    } catch { check(false, "upstream DNS mode contract managed startup: " + name) }
                    response["mode"] = "global"
                    do {
                        check(try Readiness.validateManagedCapture(configuration: Fixture.data(source), version: version, configs: Fixture.data(response)) == "global",
                              "upstream DNS mode contract managed capture: " + name)
                    } catch { check(false, "upstream DNS mode contract managed capture: " + name) }
                    var inherited = fixture, inheritedSource = sourceTun, inheritedActual = apiTun
                    inheritedSource["file-descriptor"] = 3; inheritedActual["file-descriptor"] = 3
                    inherited.configuration = source; inherited.configuration["tun"] = inheritedSource
                    response["mode"] = "rule"; response["tun"] = inheritedActual
                    do { check(try inherited.observe(response).inheritedDescriptor == 3, "upstream DNS mode contract supplied FD: " + name) }
                    catch { check(false, "upstream DNS mode contract supplied FD: " + name) }
                    for replacement: Any? in [nil, NSNull(), true, 7, "unsupported", name == "disabled" ? "" : "disabled"] {
                        var mutated = apiTun; mutated["dns-mode"] = replacement; response["tun"] = mutated
                        diagnoses("upstream DNS mode contract rejects absent, malformed or changed response: " + name, .field(.dnsMode)) {
                            try Readiness.validateManaged(configuration: Fixture.data(source), version: version, configs: Fixture.data(response))
                        }
                    }
                    for replacement: Any in [NSNull(), true, 7] {
                        var changedSource = source, changedTun = sourceTun
                        changedTun["dns-mode"] = replacement; changedSource["tun"] = changedTun
                        response["tun"] = apiTun
                        diagnoses("malformed source DNS mode cannot become an implicit default: " + name, .field(.dnsMode)) {
                            try Readiness.validateManaged(configuration: Fixture.data(changedSource), version: version, configs: Fixture.data(response))
                        }
                    }
                }
            }
            check(observed.binding.receipt.interfaceName == "utun42" &&
                  (fixture.response["tun"] as? [String: Any])?["device"] as? String == "utun",
                  "supplied-FD readiness accepts the declared device without replacing the acquired interface identity")
            rejects("changed bytes cannot reuse a valid receipt digest") {
                _ = try Readiness(binding: fixture.binding(), configuration: Data("{}".utf8), managedMTU: 1500)
            }
            rejects("empty source is refused") { _ = try fixture.readiness(Data()) }
            rejects("oversized source is refused before parsing") { _ = try fixture.readiness(Data(repeating: 32, count: 2 * 1024 * 1024 + 1)) }
            for (field, value) in [
                ("enable", false as Any), ("enable", 1 as Any), ("file-descriptor", 4 as Any), ("file-descriptor", true as Any),
                ("device", "utun43" as Any), ("stack", "unknown" as Any), ("auto-route", 1 as Any),
                ("auto-detect-interface", "true" as Any), ("mtu", 1499 as Any), ("mtu", true as Any),
                ("dns-hijack", [53] as Any), ("dns-hijack", [String](repeating: "any:53", count: 257) as Any)
            ] {
                var changed = fixture; changed.tun(field, value)
                rejects("invalid source field is refused: " + field + "/" + String(describing: value).prefix(40)) { _ = try changed.readiness() }
            }
            for mtu in [575, 65536, -1] { rejects("managed MTU bounds: \(mtu)") { _ = try fixture.readiness(mtu: mtu) } }
            do {
                var changed = fixture; changed.tun("device", "utun42"); changed.tun("stack", "MiXeD")
                check(try changed.observe().coreVersion == "v1.19.33", "explicit receipt interface and case-insensitive supported stack are accepted")
                var response = changed.response, tun = response["tun"] as! [String: Any]
                tun["device"] = "utun"; response["tun"] = tun
                rejects("generic device cannot replace an explicitly declared acquired interface") { _ = try changed.observe(response) }
            }
            for key in ["version", "configs"] {
                for payload in [Data("{\"version\":\"v1.19.33\",\"version\":\"v1.19.33\"}".utf8),
                                Data("{\"tun\":{\"enable\":true,\"\\u0065nable\":true}}".utf8), Data([0xff]), Data("[]".utf8)] {
                    diagnoses("strict response identifies malformed JSON at " + key, .json(Readiness.Endpoint(rawValue: key)!)) {
                        _ = try readiness.observe(read: { endpoint in endpoint == key ? payload : (endpoint == "version" ? Data("{\"version\":\"v1.19.33\"}".utf8) : configs) }, verify: {})
                    }
                }
            }
            for replacement in ["\"file-descriptor\":3,\"file-descriptor\":3", "\"file-descriptor\":3,\"file-\\u0064escriptor\":3"] {
                let repeated = Data(String(decoding: configs, as: UTF8.self).replacingOccurrences(of: "\"file-descriptor\":3", with: replacement).utf8)
                var verifies = 0
                rejects("otherwise valid configs rejects repeated decoded descriptor key") {
                    _ = try readiness.observe(read: { endpoint in endpoint == "version" ? Data("{\"version\":\"v1.19.33\"}".utf8) : repeated }, verify: { verifies += 1 })
                }
                check(verifies == 2, "invalid configs never reaches final readiness verification")
            }
            for version in ["v1.19.32", "1.19.33", "v1.19.33-extra", ""] {
                diagnoses("version must exactly equal fixed release: " + version, .field(.version)) { _ = try fixture.observe(version: Fixture.data(["version": version])) }
            }
            for (key, value) in [("mode", "global" as Any), ("allow-lan", true as Any), ("ipv6", false as Any),
                                 ("port", 0 as Any), ("socks-port", 0 as Any), ("mixed-port", 1 as Any),
                                 ("redir-port", 1 as Any), ("tproxy-port", 1 as Any), ("port", true as Any)] {
                var response = fixture.response; response[key] = value
                diagnoses("effective top-level response mismatch: " + key, .field(Readiness.Field(rawValue: key)!)) { _ = try fixture.observe(response) }
            }
            for (key, value) in [
                ("enable", false as Any), ("file-descriptor", 0 as Any), ("file-descriptor", true as Any),
                ("device", "utun43" as Any), ("device", "utun42" as Any), ("stack", "system" as Any),
                ("mtu", 1499 as Any), ("auto-route", false as Any), ("auto-detect-interface", false as Any),
                ("auto-redirect", true as Any), ("gso", true as Any), ("recvmsgx", true as Any), ("sendmsgx", true as Any),
                ("dns-hijack", ["udp://any:53"] as Any), ("dns-hijack", NSNull() as Any), ("dns-mode", "redirect" as Any)
            ] {
                var response = fixture.response, tun = response["tun"] as! [String: Any]
                tun[key] = value; response["tun"] = tun
                diagnoses("effective TUN response mismatch: " + key, .field(Readiness.Field(rawValue: "tun." + key)!)) { _ = try fixture.observe(response) }
            }
            for key in ["enable", "file-descriptor", "device", "stack", "mtu", "auto-route", "auto-detect-interface", "dns-hijack"] {
                var response = fixture.response, tun = response["tun"] as! [String: Any]
                tun.removeValue(forKey: key); response["tun"] = tun
                diagnoses("required effective TUN field cannot be omitted: " + key, .field(Readiness.Field(rawValue: "tun." + key)!)) { _ = try fixture.observe(response) }
            }
            do {
                var response = fixture.response
                response["tun"] = NSNull()
                diagnoses("missing or nonobject TUN response is distinguished from enable=false", .field(.tun)) { _ = try fixture.observe(response) }
                response = fixture.response
                var tun = response["tun"] as! [String: Any]
                tun["enable"] = false; tun["device"] = "private-do-not-log"
                response["tun"] = tun
                diagnoses("first failing field is retained without emitting any response values", .field(.enable)) { _ = try fixture.observe(response) }
            }
            do {
                var changed = fixture; changed.configuration.removeValue(forKey: "port"); changed.configuration.removeValue(forKey: "socks-port")
                changed.configuration.removeValue(forKey: "allow-lan"); changed.configuration.removeValue(forKey: "mode")
                changed.configuration.removeValue(forKey: "ipv6"); changed.tun("mtu", nil); changed.tun("dns-hijack", [String]())
                changed.tun("recvmsgx", nil); changed.tun("dns-mode", nil)
                var response = changed.response, tun = response["tun"] as! [String: Any]
                response["port"] = 0; response["socks-port"] = 0; response["allow-lan"] = false; response["mode"] = "rule"; response["ipv6"] = true
                tun["mtu"] = 0; tun["recvmsgx"] = true; tun["dns-mode"] = ""; tun["dns-hijack"] = NSNull(); response["tun"] = tun
                check(try changed.observe(response, mtu: 9000).inheritedDescriptor == 3, "fixed-core default IPv6/recvmsgx, raw MTU zero and raw DNS mode are observed exactly")
                tun.removeValue(forKey: "mtu"); response["tun"] = tun
                check(try changed.observe(response, mtu: 9000).inheritedDescriptor == 3, "omitted raw MTU with managed Darwin default 9000 is accepted")
                rejects("implicit Darwin MTU cannot be paired with arbitrary managed MTU") { _ = try changed.observe(response, mtu: 1500) }
                response["ipv6"] = false
                rejects("absent source IPv6 does not authorize false effective IPv6") { _ = try changed.observe(response, mtu: 9000) }
                response["ipv6"] = true; tun["recvmsgx"] = false; response["tun"] = tun
                rejects("absent source recvmsgx does not authorize false effective recvmsgx") { _ = try changed.observe(response, mtu: 9000) }
            }
            for secret: Any in ["bad\r\nInjected: yes", "bad\0secret", "bad\tsecret", "bad\u{7f}", String(repeating: "a", count: 4097), 123] {
                var changed = fixture; changed.configuration["secret"] = secret
                rejects("source secret cannot inject a header or exceed bounds") { _ = try changed.readiness() }
            }
            for secret in ["", "valid-private-bearer", "中😀", String(repeating: "a", count: 4096)] {
                var changed = fixture; changed.configuration["secret"] = secret
                check(try changed.observe().inheritedDescriptor == 3, "valid bounded secret is accepted without appearing in observation")
            }
            let duplicatedSource = Data("{\"tun\":{\"enable\":false,\"enable\":true,\"file-descriptor\":3,\"device\":\"utun\",\"stack\":\"mixed\",\"auto-route\":true,\"auto-detect-interface\":true,\"dns-hijack\":[]}}".utf8)
            rejects("source configuration rejects repeated JSON keys before effective intent is interpreted") { _ = try fixture.readiness(duplicatedSource) }
            for failurePoint in 1...3 {
                var verifies = 0, reads = 0
                rejects("verification failure at boundary \(failurePoint) cannot publish readiness") {
                    _ = try readiness.observe(read: { endpoint in reads += 1; return endpoint == "version" ? Data("{\"version\":\"v1.19.33\"}".utf8) : configs }, verify: {
                        verifies += 1; if verifies == failurePoint { throw Injected.failure }
                    })
                }
                check(verifies == failurePoint && reads == failurePoint - 1, "failed verification prevents subsequent work at boundary \(failurePoint)")
            }
            for failingRead in ["version", "configs"] {
                var order: [String] = []
                rejects("read failure at \(failingRead) cannot publish readiness") {
                    _ = try readiness.observe(read: { endpoint in
                        order.append(endpoint); if endpoint == failingRead { throw Injected.failure }
                        return Data("{\"version\":\"v1.19.33\"}".utf8)
                    }, verify: { order.append("verify") })
                }
                check(order == (failingRead == "version" ? ["verify", "version"] : ["verify", "version", "verify", "configs"]), "read failure performs no later verification or endpoint")
            }

            let directory = "/private/tmp/relay-ready-" + UUID().uuidString.lowercased(), file = directory + "/config.yaml"
            guard mkdir(directory, 0o700) == 0 else { throw Injected.failure }
            defer { try? FileManager.default.removeItem(atPath: directory) }
            let bytes = try fixture.bytes()
            func write(_ path: String, _ data: Data) throws {
                let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
                guard fd >= 0 else { throw Injected.failure }; defer { Darwin.close(fd) }
                try data.withUnsafeBytes { raw in
                    var written = 0
                    while written < raw.count {
                        let count = Darwin.write(fd, raw.baseAddress!.advanced(by: written), raw.count - written)
                        guard count > 0 else { throw Injected.failure }; written += count
                    }
                }
            }
            try write(file, bytes)
            for mode in ["normal", "invalid-http", "invalid-json", "oversized"] {
                let server = Process(), ready = Pipe()
                server.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
                server.arguments = ["--private-http-peer", directory, mode]
                server.standardOutput = ready; server.standardError = FileHandle.nullDevice
                try server.run()
                defer {
                    if server.isRunning { server.terminate() }; server.waitUntilExit()
                    check(unlink(directory + "/api.sock") == 0, "owned HTTP fixture removes its socket before other cases")
                }
                guard try ready.fileHandleForReading.read(upToCount: 6) == Data("READY\n".utf8) else { throw Injected.failure }
                var peers = 0, verifications = 0
                let live = try readiness.live(directory: directory, verifyPeer: { fd in
                    var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0, effective: pid_t = 0
                    var length = socklen_t(MemoryLayout<pid_t>.size), effectiveLength = length
                    guard server.isRunning, getpeereid(fd, &uid, &gid) == 0, uid == getuid(), gid == getgid(),
                          getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid == server.processIdentifier,
                          getsockopt(fd, SOL_LOCAL, LOCAL_PEEREPID, &effective, &effectiveLength) == 0,
                          effective == server.processIdentifier, server.isRunning else { throw Injected.failure }
                    peers += 1
                    privateSocketConnected = true
                })
                diagnoses("shared expired capture deadline rejects before peer credential exchange", .deadline) {
                    _ = try live.read("version", before: 0)
                }
                check(peers == 0, "expired shared deadline sends no local credential request")
                do {
                    let result = try readiness.observe(read: { try live.read($0) }, verify: {
                        guard server.isRunning else { throw Injected.failure }; verifications += 1
                    })
                    check(mode == "normal" && result.inheritedDescriptor == 3, "authenticated HTTP/1.0 response: " + mode)
                } catch {
                    let expected: [String: Readiness.Failure] = ["invalid-http": .http(.configs), "invalid-json": .json(.configs), "oversized": .io(.configs, .limit)]
                    check(expected[mode] != nil && error as? Readiness.Failure == expected[mode], "actual private socket failure has exact endpoint and stage: " + mode)
                }
                check(peers == 2 && verifications == (mode == "normal" ? 3 : 2),
                      "both peers authenticated and failed responses never publish readiness: " + mode)
                if mode == "normal" {
                    let name = "节点 / Group%2F", reader = try live.delegatedTrafficReader()
                    func groups(_ action: RelayTunRuntimeCapture.ProxyAction) throws -> [String:[String:Any]] {
                        let bytes = try reader.proxyGroups(action, before: DispatchTime.now().uptimeNanoseconds + 3_000_000_000, check: {})
                        guard let result = try JSONSerialization.jsonObject(with: bytes) as? [String:[String:Any]] else { throw Injected.failure }
                        return result
                    }
                    let first = try groups(.list)
                    check(first[name]?["now"] as? String == "NodeA" && first["NodeB"]?["provider-name"] as? String == "Fixture" && first["NodeB"]?["server"] == nil,
                          "provider-only member resolves from owned socket without source credentials")
                    rejects("rejects absent member before dispatch") { _ = try groups(.select(name, "unknown")) }
                    _ = try groups(.select(name,"NodeB"))
                    let second = try groups(.list)
                    check(second[name]?["now"] as? String == "NodeB", "escaped unicode selector is written and reread on same held peer")
                }
            }
            var directoryInfo = stat(), fileInfo = stat()
            let diskBytes = try Data(contentsOf: URL(fileURLWithPath: file))
            check(lstat(directory, &directoryInfo) == 0 && directoryInfo.st_uid == getuid() && directoryInfo.st_mode & 0o7777 == 0o700 &&
                  directoryInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) &&
                  (directory + "/api.sock").utf8.count < 100, "live fixture starts as a canonical ordinary-UID 0700 directory")
            check(lstat(file, &fileInfo) == 0 && fileInfo.st_uid == getuid() && fileInfo.st_mode & 0o7777 == 0o600 && fileInfo.st_nlink == 1 &&
                  fileInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && fileInfo.st_size == bytes.count && diskBytes == bytes &&
                  RelayTunHelperTrust.digest(bytes) == readiness.binding.receipt.runtimeConfigurationSHA256,
                  "live fixture file has private permissions and exact originally bound bytes")
            var peerCalls = 0
            stage = "live-init"
            let live = try readiness.live(directory: directory, verifyPeer: { _ in peerCalls += 1; throw Injected.failure })
            stage = "live-verify"
            try live.verifySource()
            check(peerCalls == 0, "private ordinary-UID source verification reads exact file without connecting or invoking peer gate")
            rejects("read-only live adapter accepts only version and configs endpoints") { _ = try live.read("configs?force=true") }
            rejects("missing private Unix socket fails before any peer or network read") { _ = try live.read("version") }
            try write(directory + "/api.sock", Data("not a socket".utf8))
            rejects("a regular file cannot stand in for the private Unix socket") { _ = try live.read("version") }
            guard unlink(directory + "/api.sock") == 0, symlink(file, directory + "/api.sock") == 0 else { throw Injected.failure }
            rejects("a symbolic link cannot stand in for the private Unix socket") { _ = try live.read("version") }
            guard unlink(directory + "/api.sock") == 0 else { throw Injected.failure }
            check(peerCalls == 0, "rejected endpoints and missing socket never invoke peer verification")
            try write(file, Data(repeating: 32, count: bytes.count))
            rejects("changed same-length private source bytes are refused") { try live.verifySource() }
            try write(file, bytes)
            guard chmod(file, 0o644) == 0 else { throw Injected.failure }
            rejects("source file must retain private 0600 permissions") { try live.verifySource() }
            guard chmod(file, 0o600) == 0 else { throw Injected.failure }
            let hard = directory + "/hard"
            guard link(file, hard) == 0 else { throw Injected.failure }
            rejects("source hard links are refused") { try live.verifySource() }
            guard unlink(hard) == 0 else { throw Injected.failure }
            let saved = directory + "/saved"
            guard rename(file, saved) == 0, symlink(saved, file) == 0 else { throw Injected.failure }
            rejects("source symbolic link is refused") { try live.verifySource() }
            guard unlink(file) == 0, rename(saved, file) == 0 else { throw Injected.failure }
            guard rename(file, saved) == 0, mkfifo(file, 0o600) == 0 else { throw Injected.failure }
            rejects("nonblocking source open refuses a FIFO without waiting for a writer") { try live.verifySource() }
            guard unlink(file) == 0, mkdir(file, 0o700) == 0 else { throw Injected.failure }
            rejects("source cannot be replaced by a directory") { try live.verifySource() }
            guard rmdir(file) == 0, rename(saved, file) == 0 else { throw Injected.failure }
            guard chmod(directory, 0o755) == 0 else { throw Injected.failure }
            rejects("held directory cannot lose private permissions") { try live.verifySource() }
            rejects("unprivate directory cannot create live adapter") { _ = try readiness.live(directory: directory, verifyPeer: { _ in }) }
            guard chmod(directory, 0o700) == 0 else { throw Injected.failure }
            for path in ["relative", directory + "/../" + URL(fileURLWithPath: directory).lastPathComponent,
                         directory + "/", directory + "/./", directory + "\0tail", "/private/tmp/" + String(repeating: "a", count: 100)] {
                rejects("noncanonical or oversized live path is refused") { _ = try readiness.live(directory: path, verifyPeer: { _ in }) }
            }
            let alias = directory + "-alias"
            guard symlink(directory, alias) == 0 else { throw Injected.failure }
            defer { _ = unlink(alias) }
            rejects("live directory symbolic link is refused") { _ = try readiness.live(directory: alias, verifyPeer: { _ in }) }
            let nested = directory + "/nested", nestedFile = directory + "/nested/config.yaml", ancestor = directory + "/ancestor"
            guard mkdir(nested, 0o700) == 0, symlink(directory, ancestor) == 0 else { throw Injected.failure }
            try write(nestedFile, bytes)
            rejects("symbolic-link ancestor is refused") { _ = try readiness.live(directory: ancestor + "/nested", verifyPeer: { _ in }) }
            guard rename(directory, directory + "-old") == 0 else { throw Injected.failure }
            defer { try? FileManager.default.removeItem(atPath: directory + "-old") }
            guard mkdir(directory, 0o700) == 0 else { throw Injected.failure }; try write(file, bytes)
            rejects("replacement directory cannot inherit held source identity") { try live.verifySource() }
            check(peerCalls == 0, "all file and path checks completed without opening Unix socket or launching a core")
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error), "stage": stage]) }
        let diagnosticFailures: [Readiness.Failure] = [.invalid, .resource, .response, .deadline, .peer] +
            Readiness.Field.allCases.map { .field($0) } + Readiness.Endpoint.allCases.flatMap { endpoint in
                [.json(endpoint), .http(endpoint)] + Readiness.ReadStage.allCases.map { .io(endpoint, $0) }
            }
        let codes = diagnosticFailures.map { $0.diagnosticCode }
        check(Set(codes).count == codes.count && codes.allSatisfy { $0.utf8.count < 100 && $0.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 } },
              "all native diagnostic codes are unique bounded literals without response data")
        check(!Readiness.Failure.json(.configs).allowsStartupRetry && !Readiness.Failure.http(.version).allowsStartupRetry &&
              !Readiness.Failure.resource.allowsStartupRetry && !Readiness.Failure.invalid.allowsStartupRetry &&
              Readiness.Failure.field(.enable).allowsStartupRetry && Readiness.Failure.io(.configs, .receive).allowsStartupRetry,
              "field and IO diagnostics preserve retry policy; malformed JSON and HTTP remain immediate failures")
        let failures = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failures == 0, "checksPassed": rows.count - failures, "checksTotal": rows.count,
            "ordinaryUIDPrivateFileReadOnly": true, "actualCoreLaunched": false, "actualTunCreated": false,
            "actualUnixSocketConnected": privateSocketConnected, "systemConfigurationChanged": false, "checks": rows,
            "diagnosticCodes": codes]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failures > 0 { exit(1) }
    }
}
