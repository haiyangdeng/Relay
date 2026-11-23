import Foundation
import Darwin

private enum Injected: Error { case failure }

@main struct RelayTunRuntimeCaptureTests {
    static let binding: [String: Any] = ["sessionId": "33333333-3333-4333-8333-333333333333",
        "evidenceSHA256": String(repeating: "e", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64)]
    static let clientSHA = String(repeating: "c", count: 64), revision = String(repeating: "d", count: 64)
    static var snapshot: RelayTunRuntimeCapture.Snapshot {
        .init(originalLoadedSHA256: String(repeating: "a", count: 64), originalLoadedBytes: 128,
              mode: "rule", ports: [.init(kind: "http", port: 18080)])
    }
    static func frame(_ id: Int) throws -> Data {
        var value = binding; value["version"] = 1; value["id"] = id; value["action"] = "capture"
        var bytes = try JSONSerialization.data(withJSONObject: value); bytes.append(10); return bytes
    }
    static func write(_ fd: Int32, _ bytes: Data) throws {
        try bytes.withUnsafeBytes { raw in
            guard Darwin.write(fd, raw.baseAddress!, raw.count) == raw.count else { throw Injected.failure }
        }
    }
    static func line(_ fd: Int32, seconds: Double = 2) throws -> [String: Any] {
        let deadline = RelayTunRuntimeCapture.now + UInt64(seconds * 1_000_000_000)
        var bytes = Data()
        while RelayTunRuntimeCapture.now < deadline {
            var item = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&item, 1, 10) >= 0 else { throw Injected.failure }
            if item.revents & Int16(POLLIN) == 0 { continue }
            var byte: UInt8 = 0
            guard Darwin.read(fd, &byte, 1) == 1 else { throw Injected.failure }
            if byte == 10 { return try RelayTunStrictJSON.object(bytes, limit: 8192) }
            bytes.append(byte); guard bytes.count <= 8192 else { throw Injected.failure }
        }
        throw Injected.failure
    }
    static func closed(_ fd: Int32) -> Bool {
        let deadline = RelayTunRuntimeCapture.now + 1_000_000_000
        while RelayTunRuntimeCapture.now < deadline {
            var item = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            if poll(&item, 1, 10) > 0 {
                var byte: UInt8 = 0
                if Darwin.read(fd, &byte, 1) == 0 { return true }
            }
        }
        return false
    }
    static func fixture() -> Never {
        guard let channel = RelayTunRuntimeCapture.Channel() else { exit(2) }
        channel.start(binding: binding, clientSHA256: clientSHA, installationRevision: revision) { _, reply in reply(.captured(snapshot)) }
        while let command = readLine() { print("control-alive:" + command); fflush(stdout) }
        withExtendedLifetime(channel) {}; exit(0)
    }
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), getgid() == getegid() else { exit(77) }
        if Array(CommandLine.arguments.dropFirst()) == ["--channel-fixture"] { fixture() }
        guard CommandLine.arguments.count == 1 else { exit(77) }
        var rows = [[String: Any]]()
        func check(_ name: String, _ condition: Bool) { rows.append(["name": name, "passed": condition]) }
        func put<T>(_ data: inout Data, _ offset: Int, _ value: T) {
            var value = value; withUnsafeBytes(of: &value) { data.replaceSubrange(offset..<(offset + $0.count), with: $0) }
        }
        func table() -> Data {
            var b = Data(count: 664)
            put(&b, 0, UInt32(24)); put(&b, 4, UInt32(1)); put(&b, 8, UInt64(4)); put(&b, 16, UInt64(7))
            var offset = 24
            for (kind, length) in [(16,104),(1,104),(2,32),(4,32),(8,136),(32,204)] {
                put(&b, offset, UInt32(length)); put(&b, offset + 4, UInt32(kind)); offset += (length + 7) & ~7
            }
            put(&b, 640, UInt32(24)); put(&b, 644, UInt32(1)); put(&b, 648, UInt64(4)); put(&b, 656, UInt64(7))
            put(&b, 42, UInt16(18080).bigEndian); put(&b, 52, UInt64(3)); b[68] = 1; put(&b, 100, UInt32(INADDR_LOOPBACK).bigEndian)
            put(&b, 144, UInt16(SOCK_STREAM)); put(&b, 148, UInt32(SO_ACCEPTCONN)); put(&b, 164, UInt32(IPPROTO_TCP)); put(&b, 168, UInt32(AF_INET))
            put(&b, 192, UInt32(501)); put(&b, 196, UInt32(9001)); put(&b, 468, UInt32(1))
            return b
        }
        func valid(_ data: Data, pid: pid_t = 9001, uid: uid_t = 501, ports: [Int] = [18080]) -> Bool {
            do { try data.withUnsafeBytes { try RelayTunTCPListener.verify($0, count: data.count, pid: pid, uid: uid, ports: ports) }; return true }
            catch { return false }
        }
        let original = table()
        check("strict known ABI held child LISTEN fixture", valid(original))
        check("wrong held child PID rejected", !valid(original, pid: 9002))
        check("wrong effective UID rejected", !valid(original, uid: 0))
        check("wrong selected port rejected", !valid(original, ports: [18081]))
        check("zero port rejected", !valid(original, ports: [0]))
        check("duplicate ports rejected", !valid(original, ports: [18080,18080]))
        check("truncated table rejected", !valid(original.dropLast()))
        for (name, offset, value) in [("unknown XSO kind",132,UInt32(64)),("raw TCP length208 is not204",432,208),
            ("non LISTEN",468,4),("missing accept flag",148,0),("reuseport",148,UInt32(SO_ACCEPTCONN|SO_REUSEPORT)),
            ("foreign delegated PID",200,9002),("wildcard address",100,0),("IPv6 family",168,UInt32(AF_INET6)),
            ("generation race",648,5),("declared below actual",4,0)] {
            var changed = original; put(&changed, offset, value); check(name + " rejected", !valid(changed))
        }
        var skipped = original; put(&skipped,4,UInt32(2)); put(&skipped,644,UInt32(2))
        check("kernel may skip dead PCB entries counted in header", valid(skipped))
        var socketGeneration = original; put(&socketGeneration,204,UInt64(8))
        check("future socket generation rejected", !valid(socketGeneration))
        var duplicate = original; duplicate.insert(contentsOf: original[24..<640], at: 640)
        put(&duplicate,4,UInt32(2)); put(&duplicate,1260,UInt32(2))
        check("duplicate listener rows cannot establish ownership", !valid(duplicate))
        var actualOrdinaryLoopbackVerified = false
        do {
            let listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
            guard listener >= 0 else { throw Injected.failure }; defer { Darwin.close(listener) }
            var local = sockaddr_in(); local.sin_family = sa_family_t(AF_INET); local.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            local.sin_addr.s_addr = UInt32(INADDR_LOOPBACK).bigEndian
            let bound = withUnsafePointer(to: &local) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            guard bound == 0, listen(listener, 1) == 0 else { throw Injected.failure }
            var size = socklen_t(MemoryLayout<sockaddr_in>.size)
            let named = withUnsafeMutablePointer(to: &local) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &size) } }
            guard named == 0 else { throw Injected.failure }
            let port = Int(UInt16(bigEndian: local.sin_port))
            try RelayTunTCPListener.verifyLive(pid: getpid(), uid: getuid(), ports: [port], deadline: RelayTunRuntimeCapture.now + RelayTunRuntimeCapture.duration)
            actualOrdinaryLoopbackVerified = true
            check("actual ordinary UID PCB parser identifies only its self-owned random loopback listener", true)
        } catch {
            check("actual snapshot race or unknown ABI fails closed without retry", error is RelayTunTCPListener.Failure)
        }
        do {
            for enabled in [false, true] {
                var request = [Int32](repeating: 0, count: 2), response = request
                guard pipe(&request) == 0, pipe(&response) == 0,
                      let channel = RelayTunRuntimeCapture.Channel(input: request[0], output: response[1], proxyGroups: enabled)
                      else { throw Injected.failure }
                defer { _ = channel.invalidateAndDrain(); Darwin.close(request[1]); Darwin.close(response[0]) }
                channel.start(binding: binding, clientSHA256: clientSHA, installationRevision: revision, proxies: { action, context, reply in
                    guard case .select("选择 / 组", "B") = action else { reply(.unavailable); return }
                    do {
                        try context.bindOwner({}); try context.bindPublication({ check in try check() })
                        reply(.sampled(Data("{}".utf8)))
                    } catch { reply(.unavailable) }
                }, capture: { _, reply in reply(.unavailable) })
                let hello = try line(response[0])
                var message = binding; message["version"] = enabled ? 4 : 1; message["id"] = 1
                message["action"] = "select"; message["group"] = "选择 / 组"; message["member"] = "B"
                var frame = try JSONSerialization.data(withJSONObject: message); frame.append(10); try write(request[1],frame)
                if enabled {
                    let reply = try line(response[0])
                    check("dedicated group pipe accepts a scoped Unicode selection and confirms it",
                          hello["capability"] as? String == "proxy-groups-v1" && reply["status"] as? String == "groups" &&
                          reply["groupsBase64"] as? String == Data("{}".utf8).base64EncodedString())
                } else {
                    check("ordinary read capability refuses proxy selection frames", closed(response[0]))
                }
            }
            for scenario in ["capture", "bad-binding", "duplicate-key", "late", "response-peer-closed"] {
                var request = [Int32](repeating: 0, count: 2), response = request
                guard pipe(&request) == 0, pipe(&response) == 0,
                      let channel = RelayTunRuntimeCapture.Channel(input: request[0], output: response[1]) else { throw Injected.failure }
                var callback: ((RelayTunRuntimeCapture.Result) -> Void)?
                var calls = 0
                channel.start(binding: binding, clientSHA256: clientSHA, installationRevision: revision) { _, reply in
                    calls += 1
                    if scenario == "late" { callback = reply } else { reply(.captured(snapshot)) }
                }
                let hello = try line(response[0])
                check(scenario + ": exact pinned hello and CLOEXEC", hello["launchClientSHA256"] as? String == clientSHA &&
                    hello["installationRevision"] as? String == revision && fcntl(request[0],F_GETFD) & FD_CLOEXEC != 0 && fcntl(response[1],F_GETFD) & FD_CLOEXEC != 0)
                if scenario == "response-peer-closed" {
                    Darwin.close(response[0]); try write(request[1],frame(1)); usleep(100_000)
                    check("FD4 EPIPE does not kill process via SIGPIPE", true)
                } else if scenario == "bad-binding" {
                    var bad = binding; bad["sessionId"] = "44444444-4444-4444-8444-444444444444"
                    bad["version"] = 1; bad["id"] = 1; bad["action"] = "capture"
                    var bytes = try JSONSerialization.data(withJSONObject: bad); bytes.append(10)
                    try write(request[1],bytes); check("bad read binding closes only read capability", closed(response[0]) && calls == 0)
                    Darwin.close(response[0])
                } else if scenario == "duplicate-key" {
                    let raw = String(decoding: try frame(1), as: UTF8.self).replacingOccurrences(of: "{", with: "{\"version\":1,")
                    try write(request[1],Data(raw.utf8)); check("duplicate read JSON keys rejected before callback", closed(response[0]) && calls == 0)
                    Darwin.close(response[0])
                } else if scenario == "late" {
                    try write(request[1],frame(1)); usleep(3_100_000)
                    callback?(.captured(snapshot)); check("expired read cannot publish late capture", closed(response[0]) && calls == 1)
                    Darwin.close(response[0])
                } else {
                    try write(request[1],frame(1)); let reply = try line(response[0])
                    check("bounded capture metadata with no private body or PID", reply["status"] as? String == "captured" &&
                        (reply["snapshot"] as? [String: Any])?["mode"] as? String == "rule" && calls == 1)
                    Darwin.close(response[0])
                }
                Darwin.close(request[1]); withExtendedLifetime(channel) {}; usleep(20_000)
            }
        } catch { check("unexpected read channel fixture failure: " + String(describing: error), false) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "backend": "actual Native read channel and strict PCB parser, synthetic bytes and private pipes only",
            "rootFixture": false, "helperOrCoreStarted": false, "systemConfigurationChanged": false,
            "actualOrdinaryLoopbackVerified": actualOrdinaryLoopbackVerified]
        if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) { print(String(decoding: bytes, as: UTF8.self)) }
        exit(passed == rows.count ? 0 : 1)
    }
}
