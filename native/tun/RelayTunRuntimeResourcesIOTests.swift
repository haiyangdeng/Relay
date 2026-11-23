import Foundation
import Darwin

private typealias M = RelayTunRuntimeResources
private typealias R = RelayTunCoreReadiness
private enum TestError: Error { case failed(String) }
private func require(_ value: @autoclosure () throws -> Bool, _ name: String = "assertion") throws {
    guard try value() else { throw TestError.failed(name) }
}
private func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
private let boot = "11111111-1111-4111-8111-111111111111"
private let configSHA = String(repeating: "a", count: 64), oldHead = String(repeating: "b", count: 64)
private let newHead = String(repeating: "c", count: 64), nonce = String(repeating: "d", count: 64)
private let oldBytes = Data("old".utf8), newBytes = Data("new fixture".utf8)
private let cleanupLock = NSLock()
private var cleanupErrors = [String]()

/// Adapted from the existing RulesIO private Unix fixture. This responder is
/// an ordinary-UID in-process listener, never a Core or lifecycle substitute.
private final class Peer {
    let directory: String, identity: stat, mode: String, source: Data
    private let listener: Int32, reader: DispatchSourceRead, group = DispatchGroup(), lock = NSLock()
    private let closed = DispatchSemaphore(value: 0)
    private var stopped = false, log = [[String: Any]](), published = false
    var live: R.Live!, beforePeer: (() throws -> Void)?
    init(_ mode: String = "normal") throws {
        self.mode = mode
        var pattern = Array("/private/tmp/relay-geoio-XXXXXX".utf8CString)
        guard mkdtemp(&pattern) != nil else { throw TestError.failed("mkdtemp") }
        directory = String(cString: pattern)
        var root = stat(); guard lstat(directory, &root) == 0 else { throw TestError.failed("root") }; identity = root
        source = try json(["synthetic": true])
        try source.write(to: URL(fileURLWithPath: directory + "/config.yaml"), options: .withoutOverwriting)
        guard chmod(directory + "/config.yaml", 0o600) == 0 else { throw TestError.failed("mode") }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0); listener = fd
        guard fd >= 0 else { throw TestError.failed("socket") }
        let path = directory + "/api.sock"
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8CString.map { UInt8(bitPattern: $0) }) }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, listen(listener, 8) == 0, fcntl(listener, F_SETFL, O_NONBLOCK) == 0 else { Darwin.close(listener); throw TestError.failed("listen") }
        reader = DispatchSource.makeReadSource(fileDescriptor: listener, queue: DispatchQueue(label: "resource-io-fixture.accept"))
        reader.setCancelHandler { [listener, closed] in Darwin.close(listener); closed.signal() }
        reader.setEventHandler { [weak self] in
            guard let self else { return }
            while true {
                let fd = accept(listener, nil, nil)
                if fd < 0, errno == EINTR { continue }
                if fd < 0 { return }
                group.enter()
                DispatchQueue.global().async { [self] in self.handle(fd); self.group.leave() }
            }
        }
        reader.resume()
        do {
            live = try R.Live(directory: directory, configuration: source, authorization: "synthetic-private-bearer", verifyPeer: { [weak self] fd in
                guard let self else { throw TestError.failed("peer") }
                var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0, effective: pid_t = 0
                var length = socklen_t(MemoryLayout<pid_t>.size), effectiveLength = length
                guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
                      getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid == getpid(),
                      getsockopt(fd, SOL_LOCAL, LOCAL_PEEREPID, &effective, &effectiveLength) == 0, effective == getpid() else { throw TestError.failed("peer identity") }
                try beforePeer?()
            })
        } catch { try? stop(); throw error }
    }
    deinit { try? stop() }
    var requests: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return log }
    var commits: Int { requests.filter { $0["action"] as? String == "commit" }.count }
    func state() -> [String: Any] {
        ["version": 1, "capability": "local-geodata-v1", "bootId": boot, "sequence": published ? 1 : 0,
         "generationSHA256": published ? newHead : oldHead,
         "resources": [["kind": "geosite-dat", "sha256": M.digest(published ? newBytes : oldBytes), "bytes": published ? newBytes.count : oldBytes.count, "active": true]]]
    }
    private func handle(_ fd: Int32) {
        defer { Darwin.close(fd) }
        // Darwin accept inherits the listener's O_NONBLOCK. This fixture uses
        // blocking request reads with bounded socket timeouts, so normalize
        // the accepted stream rather than treating an early EAGAIN as EOF.
        let flags = fcntl(fd, F_GETFL)
        var noSignal: Int32 = 1
        guard flags >= 0, fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) == 0,
              setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else { return }
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0 else { return }
        do {
            var request = Data(), buffer = [UInt8](repeating: 0, count: 1024)
            while request.range(of: Data("\r\n\r\n".utf8)) == nil {
                let count = Darwin.read(fd, &buffer, buffer.count)
                guard count > 0, request.count + count <= 8192 else { return }; request.append(contentsOf: buffer.prefix(count))
            }
            let boundary = request.range(of: Data("\r\n\r\n".utf8))!
            let header = String(decoding: request[..<boundary.lowerBound], as: UTF8.self), lines = header.components(separatedBy: "\r\n")
            guard lines.first == "POST /relay/geodata/v1 HTTP/1.0",
                  lines.contains("Authorization: Bearer synthetic-private-bearer"),
                  let declared = lines.first(where: { $0.hasPrefix("Content-Length: ") }),
                  let length = Int(declared.dropFirst(16)), (1...4096).contains(length) else { return }
            while request.count - boundary.upperBound < length {
                let count = Darwin.read(fd, &buffer, buffer.count); guard count > 0 else { return }; request.append(contentsOf: buffer.prefix(count))
            }
            let raw = try RelayTunStrictJSON.object(Data(request[boundary.upperBound...]), limit: 4096)
            guard let action = raw["action"] as? String else { return }
            lock.lock(); log.append(raw)
            var reply: [String: Any]
            switch action {
            case "state": reply = state()
            case "prepare":
                reply = ["version": 1, "status": "prepared", "bootId": boot, "kind": "geosite-dat", "nonce": nonce,
                         "oldSHA256": M.digest(oldBytes), "newSHA256": M.digest(newBytes), "bytes": newBytes.count,
                         "sequence": 0, "previousGenerationSHA256": oldHead, "remainingMS": 20000]
            case "commit":
                published = true
                reply = ["version": 1, "status": "applied", "bootId": boot, "kind": "geosite-dat",
                         "oldSHA256": M.digest(oldBytes), "newSHA256": M.digest(newBytes), "bytes": newBytes.count,
                         "sequence": 1, "previousGenerationSHA256": oldHead, "generationSHA256": newHead, "retainedOriginal": true]
                if mode == "bad-parent" { reply["previousGenerationSHA256"] = String(repeating: "f", count: 64) }
                if mode == "bad-sequence" { reply["sequence"] = 2 }
                if mode == "not-retained" { reply["retainedOriginal"] = false }
            case "cancel": reply = ["version": 1, "status": mode == "cancel-uncertain" ? "uncertain" : "cancelled"]
            default: lock.unlock(); return
            }
            lock.unlock()
            if mode == "disconnect", action == "commit" { return }
            if mode == "delay", action == "state" { usleep(650000) }
            var body = try json(reply), status = "200 OK", extra = ""
            if action == "state" {
                switch mode {
                case "stale": body = try json(["version": 1, "status": "stale"]); status = "409 Conflict"
                case "bad-utf8": body = Data([0xff])
                case "duplicate": body = Data("{\"version\":1,\"vers\\u0069on\":1}".utf8)
                case "unknown": reply["path"] = "/not-authority"; body = try json(reply)
                case "oversize": body = Data(repeating: 32, count: 8193)
                case "chunked": extra = "Transfer-Encoding: chunked\r\n"
                case "duplicate-length": extra = "Content-Length: \(body.count)\r\n"
                case "http204": status = "204 No Content"; body = Data()
                default: break
                }
            }
            var count = body.count
            if mode == "truncated" { count += 1 }
            let contentLength = mode == "eof" ? "" : "Content-Length: \(count)\r\n"
            var response = Data("HTTP/1.0 \(status)\r\n\(contentLength)\(extra)Connection: close\r\n\r\n".utf8); response.append(body)
            response.withUnsafeBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                    guard count > 0 else { return }; offset += count
                }
            }
        } catch { /* Private peer failure is reported by the fixed client. */ }
    }
    func stop() throws {
        guard !stopped else { return }; stopped = true
        do {
            reader.cancel()
            guard closed.wait(timeout: .now() + 3) == .success,
                  group.wait(timeout: .now() + 3) == .success else { throw TestError.failed("peer drain") }
            var current = stat()
            guard lstat(directory, &current) == 0, current.st_dev == identity.st_dev, current.st_ino == identity.st_ino,
                  current.st_uid == getuid(), current.st_mode & 0o7777 == 0o700 else { throw TestError.failed("root changed") }
            try FileManager.default.removeItem(atPath: directory)
        } catch {
            cleanupLock.lock(); cleanupErrors.append(directory + ": " + String(describing: error)); cleanupLock.unlock(); throw error
        }
    }
}

private final class Fixture {
    let peer: Peer, ledger: M.Ledger, owner: M.Owner, selection: M.Selection
    var controller: M.Controller!, authorized = true
    var beforeOwner: (() -> Void)?
    init(_ mode: String = "normal") throws {
        peer = try Peer(mode)
        let identity = try M.FileIdentity(device: 1, inode: 1, ownerUID: getuid(), mode: 0o100600, links: 1, bytes: oldBytes.count, modifiedNS: 1, changedNS: 1)
        ledger = try .init(bootId: boot, generationSHA256: oldHead, sequence: 0,
            resources: [.init(kind: .geosite, sha256: M.digest(oldBytes), identity: identity, active: true)])
        owner = try .init(heldGeneration: 1, configurationRevision: configSHA, coreBootId: boot, ordinaryUID: getuid())
        selection = try .init(kind: .geosite, configurationRevision: configSHA, expectedGenerationSHA256: oldHead,
            oldSHA256: M.digest(oldBytes), newSHA256: M.digest(newBytes), blobId: "22222222-2222-4222-8222-222222222222", selector: "fixture", bytes: newBytes.count)
        controller = try .init(ledger: ledger, staticAssetBytes: 0, driver: .init(currentOwner: { [unowned self] in
            beforeOwner?()
            guard authorized else { throw M.Failure.revoked }; return owner
        }, readBlob: { selection, _, done in
            do {
                let identity = try M.FileIdentity(device: 1, inode: 9, ownerUID: getuid(), mode: 0o100600, links: 1, bytes: newBytes.count, modifiedNS: 1, changedNS: 1)
                done(.success(try .init(id: selection.blobId, kind: selection.kind, data: newBytes, identity: identity)))
            } catch { done(.failure(error)) }
        }, prepareCore: { [unowned self] selection, _, access, done in
            do { done(.success(try peer.live.prepareResource(selection, access: access))) } catch { done(.failure(error)) }
        }, commitCore: { [unowned self] prepared, access, done in
            do {
                let receipt = try peer.live.commitResource(prepared, access: access)
                let state = try peer.live.readResources(before: access.deadline, check: access.check)
                let rows = try state.resources.map { row in
                    let identity = try M.FileIdentity(device: 1, inode: 2, ownerUID: getuid(), mode: 0o100600, links: 1, bytes: row.bytes, modifiedNS: 2, changedNS: 2)
                    return try M.Resource(kind: row.kind, sha256: row.sha256, identity: identity, active: row.active)
                }
                done(.success(.init(receipt: receipt, readback: try .init(bootId: state.bootId, generationSHA256: state.generationSHA256, sequence: state.sequence, resources: rows))))
            } catch { done(.failure(error)) }
        }, cancelPrepared: { [unowned self] prepared, _, deadline, done in
            do { done(.success(try peer.live.cancelResource(prepared, before: deadline, check: {}))) } catch { done(.failure(error)) }
        }))
    }
    func replace() throws -> M.Reply {
        var reply: M.Reply?; controller.replace(id: 1, selection: selection) { reply = $0 }
        guard let reply else { throw TestError.failed("not settled") }; return reply
    }
}

@main private struct ResourceIOTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid() else { exit(77) }
        var rows = [[String: Any]]()
        func test(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": true]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        test("authenticated fixed Unix state preserves opaque head and existing rows") {
            let peer = try Peer(); defer { try? peer.stop() }
            let state = try peer.live.readResources(before: DispatchTime.now().uptimeNanoseconds + 2_000_000_000, check: {})
            try require(state.generationSHA256 == oldHead && state.sequence == 0 && state.resources.count == 1)
            try require(peer.requests.count == 1 && peer.requests[0]["action"] as? String == "state")
        }
        test("model prepare commit exact readback advances once without exposing nonce") {
            let fixture = try Fixture(); defer { try? fixture.peer.stop() }; let reply = try fixture.replace()
            try require(reply.status == .updated && reply.ledger?.generationSHA256 == newHead && fixture.peer.commits == 1)
            try require(fixture.peer.requests.compactMap { $0["action"] as? String } == ["prepare", "commit", "state"])
            try require((fixture.peer.requests.first?["leaseMS"] as? Int ?? 0) <= 30000)
        }
        for mode in ["bad-parent", "bad-sequence", "not-retained", "disconnect"] {
            test("post-entry \(mode) is isolated uncertain with one attempt") {
                let f = try Fixture(mode); defer { try? f.peer.stop() }; let result = try f.replace()
                try require(result.status == .uncertain && result.ledger == nil && f.controller.isIsolated && f.peer.commits == 1)
                var again: M.Reply?; f.controller.replace(id: 2, selection: f.selection) { again = $0 }
                try require(again?.status == .uncertain && f.peer.commits == 1)
            }
        }
        test("peer observer revocation immediately before commit sends zero commit bytes") {
            let f = try Fixture(); defer { try? f.peer.stop() }; var checks = 0
            f.peer.beforePeer = { checks += 1; if checks == 2 { _ = f.controller.cancel(operationId: 1) } }
            let result = try f.replace()
            try require(result.status == .cancelled && f.peer.commits == 0)
            try require(f.peer.requests.compactMap { $0["action"] as? String } == ["prepare", "cancel"])
        }
        for mode in ["stale", "bad-utf8", "duplicate", "unknown", "oversize", "chunked", "duplicate-length", "http204", "truncated"] {
            test("state \(mode) rejects without mutation or retry") {
                let peer = try Peer(mode); defer { try? peer.stop() }; var rejected = false
                do { _ = try peer.live.readResources(before: DispatchTime.now().uptimeNanoseconds + 2_000_000_000, check: {}) } catch { rejected = true }
                try require(rejected && peer.requests.count == 1 && peer.commits == 0)
            }
        }
        test("HTTP1.0 EOF framing is supported without a chunk decoder") {
            let f = try Fixture("eof"); defer { try? f.peer.stop() }; try require(f.replace().status == .updated)
        }
        test("resource reads use the original remaining lease rather than readiness 500ms") {
            let peer = try Peer("delay"); defer { try? peer.stop() }
            let began = DispatchTime.now().uptimeNanoseconds
            let result = try peer.live.readResources(before: began + 2_000_000_000, check: {})
            try require(result.sequence == 0 && DispatchTime.now().uptimeNanoseconds - began > 500_000_000)
        }
        test("a resource exchange never renews the supplied deadline") {
            let peer = try Peer("delay"); defer { try? peer.stop() }; var rejected = false
            do { _ = try peer.live.readResources(before: DispatchTime.now().uptimeNanoseconds + 200_000_000, check: {}) } catch { rejected = true }
            try require(rejected && peer.requests.count == 1)
        }
        test("cancel before state dispatch sends no credential or operation") {
            let peer = try Peer(); defer { try? peer.stop() }; var failed = false
            do { _ = try peer.live.readResources(before: DispatchTime.now().uptimeNanoseconds + 2_000_000_000, check: { throw M.Failure.revoked }) } catch { failed = true }
            try require(failed && peer.requests.isEmpty)
        }
        test("empty state and inactive existing rows are valid without adopting missing kinds") {
            let peer = try Peer(); defer { try? peer.stop() }; var value = peer.state(); value["resources"] = [[String: Any]]()
            try require(R.resourceState(json(value)).resources.isEmpty)
            value["resources"] = [["kind": "asn-mmdb", "sha256": M.digest(oldBytes), "bytes": 3, "active": false]]
            try require(R.resourceState(json(value)).resources.first?.active == false)
        }
        test("invalid resource booleans and duplicate kinds fail closed") {
            let peer = try Peer(); defer { try? peer.stop() }
            for resources: Any in [ [["kind": "geosite-dat", "sha256": M.digest(oldBytes), "bytes": 3, "active": 1]],
                                    Array(repeating: ["kind": "geosite-dat", "sha256": M.digest(oldBytes), "bytes": 3, "active": true] as [String: Any], count: 2)] {
                var value = peer.state(); value["resources"] = resources; var rejected = false
                do { _ = try R.resourceState(json(value)) } catch { rejected = true }; try require(rejected)
            }
        }
        test("resource sequence uses the model safe-integer budget without changing legacy scanner integers") {
            let peer = try Peer(); defer { try? peer.stop() }; var value = peer.state()
            value["sequence"] = UInt64(UInt32.max) + 1
            try require(R.resourceState(json(value)).sequence == UInt64(UInt32.max) + 1)
            try require(RelayTunStrictJSON.integer(NSNumber(value: UInt64(UInt32.max) + 1)) == nil)
            for invalid: Any in [true, -1, 0.5, 9_007_199_254_740_992] {
                value["sequence"] = invalid; var rejected = false
                do { _ = try R.resourceState(json(value)) } catch { rejected = true }; try require(rejected)
            }
        }
        test("managed profile accepts only absent official or explicit exact signed geodata pins") {
            try require(RelayTunManagedInstallation.profile(nil) == .official)
            let profile = try RelayTunManagedInstallation.profile("local-geodata-v1")
            try require(profile == .localGeodata)
            try require(RelayTunManagedInstallation.pins(profile)["arm64"]?.0 == "a7dcd3ffe59be033ed1b4000a4ae90acdf2ab41450536e02445692ea124195c2")
            try require(RelayTunManagedInstallation.pins(.official)["arm64"]?.0 == "f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9")
            for invalid: Any in ["official", "local-geodata-v2", NSNull(), true, ["local-geodata-v1"]] {
                var rejected = false
                do { _ = try RelayTunManagedInstallation.profile(invalid) } catch { rejected = true }; try require(rejected)
            }
            let old = RelayTunOwnedChild.Launch(executable: "/not-executed/mihomo", directory: "/not-opened")
            let new = RelayTunOwnedChild.Launch(executable: old.executable, directory: old.directory, resources: true)
            try require(!old.managedEnvironment.contains("RELAY_LOCAL_GEODATA_V1=1"))
            try require(new.managedEnvironment.filter { $0 == "RELAY_LOCAL_GEODATA_V1=1" }.count == 1)
        }
        test("new exact Core version is scoped to resource profile and preserves old version checks") {
            let tun: [String: Any] = ["enable": true, "device": "utun42", "stack": "mixed", "mtu": 1500,
                "auto-route": false, "auto-detect-interface": false, "dns-hijack": [String](), "dns-mode": "disabled", "recvmsgx": false]
            let config: [String: Any] = ["tun": tun, "port": 0, "socks-port": 0, "mixed-port": 0, "redir-port": 0,
                "tproxy-port": 0, "mode": "rule", "ipv6": true, "allow-lan": false]
            let body = try json(config), official = try json(["version": "v1.19.33"]), extended = try json(["version": "relay-geodata-v1p1-3f27"])
            try R.validateManaged(configuration: body, version: official, configs: body)
            try R.validateManaged(configuration: body, version: extended, configs: body, resources: true)
            var oldResourceRejected = false
            do { try R.validateManaged(configuration: body, version: json(["version": "relay-geodata-v1-3f27"]), configs: body, resources: true) }
            catch { oldResourceRejected = true }; try require(oldResourceRejected)
            for resources in [false, true] {
                var rejected = false
                do { try R.validateManaged(configuration: body, version: resources ? official : extended, configs: body, resources: resources) }
                catch { rejected = true }; try require(rejected)
            }
        }
        test("owner callback cancellation at final commit admission sends zero commit") {
            let f = try Fixture(); defer { try? f.peer.stop() }
            var peers = 0, finalOwners = 0
            f.peer.beforePeer = {
                peers += 1
                if peers == 2 { f.beforeOwner = {
                    finalOwners += 1
                    if finalOwners == 3 { _ = f.controller.cancel(operationId: 1) }
                } }
            }
            let result = try f.replace()
            try require(finalOwners >= 3 && result.status == .cancelled && f.peer.commits == 0)
            try require(f.peer.requests.compactMap { $0["action"] as? String } == ["prepare", "cancel"])
            try require(!f.controller.isIsolated)
        }
        test("owner callback cancellation after actual commit write remains uncertain without retry") {
            let f = try Fixture(); defer { try? f.peer.stop() }
            var peers = 0, finalOwners = 0, cancellation: M.Reply?
            f.peer.beforePeer = {
                peers += 1
                if peers == 2 { f.beforeOwner = {
                    finalOwners += 1
                    if finalOwners == 4 { cancellation = f.controller.cancel(operationId: 1) }
                } }
            }
            let result = try f.replace()
            try require(finalOwners >= 4 && cancellation?.status == .uncertain)
            try require(result.status == .uncertain && result.ledger == nil && f.controller.isIsolated)
            let requests = f.peer.requests.count
            var retry: M.Reply?; f.controller.replace(id: 2, selection: f.selection) { retry = $0 }
            try require(retry?.status == .uncertain && f.peer.requests.count == requests && f.peer.commits <= 1)
        }
        cleanupLock.lock(); let cleanup = cleanupErrors; cleanupLock.unlock()
        rows.append(["name": "all private responders, accepted sockets and roots settled", "passed": cleanup.isEmpty, "errors": cleanup])
        let passed = rows.allSatisfy { $0["passed"] as? Bool == true }
        let result: [String: Any] = ["passed": passed, "checks": rows.count, "rows": rows,
            "scope": "ordinary UID in-process authenticated private Unix responder and synthetic model identities",
            "actualCoreStarted": false, "actualHelperOrTUN": false, "systemConfigurationChanged": false]
        if let data = try? json(result) { print(String(decoding: data, as: UTF8.self)) }
        if !passed { exit(1) }
    }
}
