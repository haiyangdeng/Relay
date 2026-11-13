import Foundation
import Darwin

private typealias C = RelayTunRuntimeResourcesChannel
private typealias M = RelayTunRuntimeResources
private enum TestError: Error { case failed(String), timeout }
private func expect(_ value: @autoclosure () throws -> Bool, _ name: String = "assertion") throws {
    guard try value() else { throw TestError.failed(name) }
}
private final class Fixture {
    enum Mode { case normal, heldRead, heldReplace, unknownRead, missingSnapshot, unchanged, discardBusy, discarded }
    let binding: C.Binding, mode: Mode, worker = DispatchQueue(label: "resource-channel-test.worker")
    private let lock = NSLock()
    private var input = [Int32](repeating: -1, count: 2), output = [Int32](repeating: -1, count: 2)
    private var control = [Int32](repeating: -1, count: 2)
    private var channel: C?, buffer = Data(), transferred = false, stopped = false
    private var reads = 0, replaces = 0, cancels = 0, discards = 0, invalidations = 0
    private var heldRead: ((Result<C.Observation, Error>) -> Void)?
    private var heldReplace: ((M.Reply) -> Void)?, queued: [() -> Void] = []
    let began = DispatchSemaphore(value: 0), enqueued = DispatchSemaphore(value: 0)
    private let queueWork: Bool
    init(_ mode: Mode = .normal, queued: Bool = false, lease: Int = 30) throws {
        self.mode = mode; queueWork = queued
        binding = try .init(["sessionId": "11111111-1111-4111-8111-111111111111",
            "evidenceSHA256": String(repeating: "b", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64)])
        guard pipe(&control) == 0, pipe(&input) == 0, pipe(&output) == 0 else { throw TestError.failed("pipe") }
        _ = fcntl(input[1], F_SETNOSIGPIPE, 1)
        _ = fcntl(output[0], F_SETFL, O_NONBLOCK)
        let driver = C.Driver(read: { [weak self] context, reply in
            guard let self else { reply(.failure(C.Failure.unavailable)); return }
            let hold = sync { self.reads += 1; return mode == .heldRead && self.reads == 1 }
            if hold { sync { self.heldRead = reply }; began.signal(); return }
            began.signal()
            if mode == .unknownRead { reply(.failure(C.Failure.uncertain)); return }
            do { try context.check(); reply(.success(try observation())) } catch { reply(.failure(error)) }
        }, replace: { [weak self] _, _, context, reply in
            guard let self else { reply(.init(status: .unavailable)); return }
            sync { self.replaces += 1 }
            if mode == .heldReplace { sync { self.heldReplace = reply }; began.signal(); return }
            began.signal()
            do {
                try context.check()
                if mode == .missingSnapshot { reply(.init(status: .updated)); return }
                reply(.init(status: mode == .unchanged ? .unchanged : .updated, ledger: try observation().ledger))
            } catch { reply(.init(status: .cancelled)) }
        }, cancelReplace: { [weak self] _ in
            guard let self else { return .init(status: .unavailable) }
            sync { self.cancels += 1 }
            return .init(status: mode == .heldReplace ? .uncertain : .cancelling, pending: true)
        }, discard: { [weak self] _, context, reply in
            guard let self else { reply(.failure(C.Failure.unavailable)); return }
            sync { self.discards += 1 }
            do {
                try context.check()
                if mode == .discardBusy { reply(.failure(RelayTunRuntimeResourceInbox.Failure.busy)); return }
                reply(.success(mode == .discarded ? .discarded : .absent))
            } catch { reply(.failure(error)) }
        }, invalidate: { [weak self] in self?.sync { self?.invalidations += 1 } })
        channel = C(binding: binding, clientSHA256: String(repeating: "d", count: 64),
                    installationRevision: String(repeating: "e", count: 64), driver: driver,
                    input: input[0], output: output[1], leaseSeconds: lease, execute: { [weak self] work in
            guard let self else { return }
            if queueWork { sync { self.queued.append(work) }; enqueued.signal() }
            else { worker.async { work() } }
        })
        guard channel != nil else { stop(); throw TestError.failed("channel init") }
        transferred = true; channel?.start()
        guard let hello = try frame(), hello["capability"] as? String == "runtime-resources-v1" else { stop(); throw TestError.failed("hello") }
    }
    deinit { stop() }
    @discardableResult private func sync<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
    var counts: (Int, Int, Int, Int) { sync { (reads, replaces, cancels, discards) } }
    func observation() throws -> C.Observation {
        let identity = try M.FileIdentity(device: 1, inode: 10, ownerUID: getuid(), mode: 0o100600,
                                         links: 1, bytes: 3, modifiedNS: 1, changedNS: 1)
        let resource = try M.Resource(kind: .geosite, sha256: String(repeating: "f", count: 64), identity: identity, active: true)
        return .init(configurationRevision: binding.runtimeConfigurationSHA256,
                     ledger: try .init(bootId: "22222222-2222-4222-8222-222222222222",
                                       generationSHA256: String(repeating: "c", count: 64), sequence: 1, resources: [resource]))
    }
    func request(_ id: Int, _ action: String, extra: [String: Any] = [:]) throws {
        var value = binding.json; value["version"] = 1; value["id"] = id; value["action"] = action
        for (key, field) in extra { value[key] = field }
        try raw(JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data([10]))
    }
    func raw(_ data: Data) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(input[1], bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard count > 0 else { throw TestError.failed("request write") }; offset += count
            }
        }
    }
    var selection: [String: Any] {
        ["configurationRevision": binding.runtimeConfigurationSHA256, "expectedGenerationSHA256": String(repeating: "c", count: 64),
         "kind": "geosite-dat", "oldSHA256": String(repeating: "f", count: 64), "newSHA256": String(repeating: "9", count: 64),
         "blobId": "33333333-3333-4333-8333-333333333333", "selector": "private-test", "bytes": 3]
    }
    var ticket: [String: Any] {
        ["kind": "geosite-dat", "sha256": String(repeating: "9", count: 64), "blobId": "33333333-3333-4333-8333-333333333333",
         "selector": "private-test", "bytes": 3]
    }
    func frame(timeout: Double = 3) throws -> [String: Any]? {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeout * 1_000_000_000)
        while DispatchTime.now().uptimeNanoseconds < deadline {
            if let end = buffer.firstIndex(of: 10) {
                let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
                return try JSONSerialization.jsonObject(with: line) as? [String: Any]
            }
            var poller = pollfd(fd: output[0], events: Int16(POLLIN), revents: 0)
            let polled = poll(&poller, 1, 20)
            if polled < 0, errno == EINTR { continue }
            guard polled >= 0 else { throw TestError.failed("poll") }
            if polled == 0 { continue }
            var bytes = [UInt8](repeating: 0, count: 1024)
            let count = Darwin.read(output[0], &bytes, bytes.count)
            if count == 0 { return nil }
            if count < 0, errno == EAGAIN || errno == EINTR { continue }
            guard count > 0 else { throw TestError.failed("response read") }
            buffer.append(contentsOf: bytes.prefix(count)); guard buffer.count <= 32768 else { throw TestError.failed("output budget") }
        }
        throw TestError.timeout
    }
    func releaseRead() throws {
        let callback = sync { let value = heldRead; heldRead = nil; return value }
        callback?(.success(try observation()))
    }
    func releaseReplace() throws {
        let callback = sync { let value = heldReplace; heldReplace = nil; return value }
        callback?(.init(status: .updated, ledger: try observation().ledger))
    }
    func releaseQueue() {
        let jobs = sync { let value = queued; queued.removeAll(); return value }
        for job in jobs { worker.async { job() } }
    }
    func settleWorker() { worker.sync {} }
    func echoControl() throws {
        var byte: UInt8 = 7, output: UInt8 = 0
        try expect(Darwin.write(control[1], &byte, 1) == 1 && Darwin.read(control[0], &output, 1) == 1 && output == byte)
    }
    func eof() { if input[1] >= 0 { Darwin.close(input[1]); input[1] = -1 } }
    func stop() {
        guard !stopped else { return }; stopped = true; channel?.invalidate()
        if transferred { _ = try? frame(timeout: 4) }
        for fd in [input[1], output[0], control[0], control[1]] where fd >= 0 { Darwin.close(fd) }
        if !transferred { for fd in [input[0], output[1]] where fd >= 0 { Darwin.close(fd) } }
        channel = nil
    }
}
@main private struct ResourceChannelTests {
    static func main() {
        guard getuid() > 0, getuid() == geteuid() else { exit(77) }
        var rows = [[String: Any]]()
        func test(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": true]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        test("read emits only safe snapshot fields without boot or identities") {
            let f = try Fixture(); defer { f.stop() }
            try f.request(1, "read"); let reply = try f.frame()!, snapshot = reply["snapshot"] as! [String: Any]
            try expect(reply["status"] as? String == "snapshot" && Set(snapshot.keys) == ["configurationRevision", "generationSHA256", "resources"])
            let row = (snapshot["resources"] as! [[String: Any]])[0]
            try expect(Set(row.keys) == ["kind", "sha256", "bytes", "active"])
            try expect(!(String(data: JSONSerialization.data(withJSONObject: reply), encoding: .utf8) ?? "").contains("22222222-"))
        }
        test("replace and unchanged map only a verified model ledger") {
            for mode in [Fixture.Mode.normal, .unchanged] {
                let f = try Fixture(mode); defer { f.stop() }; try f.request(1, "replace", extra: f.selection)
                let reply = try f.frame()!; try expect(reply["status"] as? String == (mode == .normal ? "updated" : "unchanged"))
                try expect(reply["snapshot"] != nil && f.counts.1 == 1)
            }
        }
        test("unknown read never returns a usable snapshot") {
            let f = try Fixture(.unknownRead); defer { f.stop() }; try f.request(1, "read")
            let reply = try f.frame()!; try expect(reply["status"] as? String == "uncertain" && reply["snapshot"] == nil)
        }
        test("missing updated ledger is uncertain rather than success") {
            let f = try Fixture(.missingSnapshot); defer { f.stop() }; try f.request(1, "replace", extra: f.selection)
            let reply = try f.frame()!; try expect(reply["status"] as? String == "uncertain" && reply["snapshot"] == nil)
        }
        test("read cancellation remains pending until original callback") {
            let f = try Fixture(.heldRead); defer { f.stop() }; try f.request(1, "read")
            try expect(f.began.wait(timeout: .now() + 2) == .success)
            try f.request(2, "cancel", extra: ["operationId": 1]); let ack = try f.frame()!
            try expect(ack["status"] as? String == "cancelling" && ack["pending"] as? Bool == true)
            try f.request(3, "read"); try expect(f.frame()?["status"] as? String == "busy")
            try f.releaseRead(); let result = try f.frame()!
            try expect(result["id"] as? Int == 1 && result["status"] as? String == "cancelled" && result["snapshot"] == nil)
            try f.request(4, "read"); try expect(f.frame()?["status"] as? String == "snapshot")
        }
        test("queued read cancellation causes zero driver reads") {
            let f = try Fixture(queued: true); defer { f.stop() }; try f.request(1, "read")
            try expect(f.enqueued.wait(timeout: .now() + 2) == .success)
            try f.request(2, "cancel", extra: ["operationId": 1]); try expect(f.frame()?["pending"] as? Bool == true)
            f.releaseQueue(); let reply = try f.frame()!
            try expect(reply["status"] as? String == "cancelled" && f.counts.0 == 0)
        }
        test("queued replace cancellation causes zero model calls") {
            let f = try Fixture(queued: true); defer { f.stop() }; try f.request(1, "replace", extra: f.selection)
            try expect(f.enqueued.wait(timeout: .now() + 2) == .success)
            try f.request(2, "cancel", extra: ["operationId": 1]); try expect(f.frame()?["pending"] as? Bool == true)
            f.releaseQueue(); try expect(f.frame()?["status"] as? String == "cancelled" && f.counts.1 == 0)
        }
        test("late updated reply after cancellation is uncertain without snapshot") {
            let f = try Fixture(.heldReplace); defer { f.stop() }; try f.request(1, "replace", extra: f.selection)
            try expect(f.began.wait(timeout: .now() + 2) == .success)
            try f.request(2, "cancel", extra: ["operationId": 1]); try expect(f.frame()?["pending"] as? Bool == true)
            try f.releaseReplace(); let result = try f.frame()!
            try expect(result["status"] as? String == "uncertain" && result["snapshot"] == nil && f.counts.2 == 1)
        }
        test("stale cancel cannot revoke the active read") {
            let f = try Fixture(.heldRead); defer { f.stop() }; try f.request(1, "read")
            try expect(f.began.wait(timeout: .now() + 2) == .success)
            try f.request(2, "cancel", extra: ["operationId": 99]); try expect(f.frame()?["status"] as? String == "stale")
            try f.releaseRead(); try expect(f.frame()?["status"] as? String == "snapshot")
        }
        test("discard has exact neutral shape without head or Core access") {
            let f = try Fixture(); defer { f.stop() }; try f.request(1, "discardBlob", extra: f.ticket)
            let result = try f.frame()!
            try expect(result["status"] as? String == "absent" && result["pending"] as? Bool == false && result["snapshot"] == nil)
            try expect(f.counts.0 == 0 && f.counts.1 == 0 && f.counts.3 == 1)
        }
        test("discarded is an explicit neutral success") {
            let f = try Fixture(.discarded); defer { f.stop() }; try f.request(1, "discardBlob", extra: f.ticket)
            let result = try f.frame()!
            try expect(result["status"] as? String == "discarded" && result["pending"] as? Bool == false && result["snapshot"] == nil)
        }
        test("reader busy is preserved as neutral busy rather than a pending operation") {
            let f = try Fixture(.discardBusy); defer { f.stop() }; try f.request(1, "discardBlob", extra: f.ticket)
            let result = try f.frame()!
            try expect(result["status"] as? String == "busy" && result["pending"] as? Bool == false && result["snapshot"] == nil)
        }
        test("discard during work is busy without claiming a pending discard") {
            let f = try Fixture(.heldRead); defer { f.stop() }; try f.request(1, "read")
            try expect(f.began.wait(timeout: .now() + 2) == .success); try f.request(2, "discardBlob", extra: f.ticket)
            let result = try f.frame()!
            try expect(result["status"] as? String == "busy" && result["pending"] as? Bool == false)
            try f.releaseRead(); _ = try f.frame()
        }
        for (name, extra) in [("unknown path", ["path": "/not-read"] as [String: Any]),
                              ("wrong binding", ["sessionId": "33333333-3333-4333-8333-333333333333"]),
                              ("boolean frame id", ["id": true]), ("unexpected read payload", ["kind": "geosite-dat"])] {
            test("malformed " + name + " closes only resource descriptors") {
                let f = try Fixture(); defer { f.stop() }; try f.request(1, "read", extra: extra)
                try expect(f.frame() == nil && f.counts.0 == 0); try f.echoControl()
            }
        }
        test("decoded duplicate key is rejected before work") {
            let f = try Fixture(); defer { f.stop() }
            let json = String(data: try JSONSerialization.data(withJSONObject: f.binding.json), encoding: .utf8)!
            let raw = "{\"version\":1,\"id\":1,\"action\":\"read\",\"a\\u0063tion\":\"read\"," + json.dropFirst()
            try f.raw(Data((raw + "\n").utf8)); try expect(f.frame() == nil && f.counts.0 == 0); try f.echoControl()
        }
        test("used frame IDs cannot be replayed") {
            let f = try Fixture(); defer { f.stop() }; try f.request(1, "read"); _ = try f.frame()
            try f.request(1, "read"); try expect(f.frame() == nil && f.counts.0 == 1); try f.echoControl()
        }
        test("invalid replace scalar types never reach the model") {
            let f = try Fixture(); defer { f.stop() }; var invalid = f.selection; invalid["bytes"] = true
            try f.request(1, "replace", extra: invalid); try expect(f.frame() == nil && f.counts.1 == 0)
        }
        test("oversize input is bounded and old control remains alive") {
            let f = try Fixture(); defer { f.stop() }; try f.raw(Data(repeating: 32, count: C.frameLimit + 1))
            try expect(f.frame() == nil && f.counts.0 == 0); try f.echoControl()
        }
        test("EOF invalidates only the optional resource capability") {
            let f = try Fixture(); defer { f.stop() }; f.eof(); try expect(f.frame() == nil); try f.echoControl()
        }
        test("original read deadline is bounded even with held callback") {
            let f = try Fixture(.heldRead, lease: 1); defer { f.stop() }; try f.request(1, "read")
            try expect(f.began.wait(timeout: .now() + 2) == .success); try expect(f.frame(timeout: 2) == nil)
            try f.releaseRead(); try f.echoControl()
        }
        test("queued wait consumes the original replace deadline") {
            let f = try Fixture(queued: true, lease: 1); defer { f.stop() }; try f.request(1, "replace", extra: f.selection)
            try expect(f.enqueued.wait(timeout: .now() + 2) == .success && f.frame(timeout: 2) == nil)
            f.releaseQueue(); f.settleWorker(); try expect(f.counts.1 == 0); try f.echoControl()
        }
        let passed = rows.allSatisfy { $0["passed"] as? Bool == true }
        let result: [String: Any] = ["passed": passed, "checks": rows.count, "rows": rows,
            "scope": "ordinary UID self-owned pipes and injected drivers only", "actualCoreStarted": false,
            "actualAppHelperOrTUN": false, "systemConfigurationChanged": false]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            print(String(decoding: data, as: UTF8.self))
        }
        if !passed { exit(1) }
    }
}
