import Foundation
import Darwin

typealias Rules = RelayTunRuntimeRules
private enum Injected: Error { case failure, missing, deadline }

private final class SelfPipeGate {
    private var descriptors: [Int32] = [-1, -1]
    private let lock = NSLock()
    private var released = false
    init() throws { guard pipe(&descriptors) == 0 else { throw Injected.failure } }
    deinit { release(); for fd in descriptors { Darwin.close(fd) } }
    func wait() throws {
        var byte: UInt8 = 0
        while true {
            let count = Darwin.read(descriptors[0], &byte, 1)
            if count < 0, errno == EINTR { continue }
            guard count == 1 else { throw Injected.failure }; return
        }
    }
    func release() {
        lock.lock(); defer { lock.unlock() }; guard !released else { return }; released = true
        var byte: UInt8 = 1; _ = Darwin.write(descriptors[1], &byte, 1)
    }
}

private final class Fixture {
    typealias Completion = (Result<Rules.Snapshot, Error>) -> Void
    private let lock = NSLock()
    private var time: UInt64 = 1_000_000
    private var generation: UInt64 = 1
    private var table: Rules.Snapshot
    private var readCount = 0, writeCount = 0, applyCount = 0
    private var holdRead = false, holdApply = false, holdAfterEnter = false
    private var failBefore = false, failAfter = false, skipAdmission = false, noChange = false, otherBit = false, changeOwner = false
    private var pendingRead: (Rules.Access, Completion)?
    private var pendingApply: (Rules.Mutation, Rules.Access, Completion)?
    private var pendingAfterEnter: (Rules.Snapshot, Completion)?
    init(_ raw: [Any] = RelayTunRuntimeRulesTests.table()) throws { table = try .init(raw) }
    var clock: UInt64 { lock.lock(); defer { lock.unlock() }; return time }
    var reads: Int { lock.lock(); defer { lock.unlock() }; return readCount }
    var writes: Int { lock.lock(); defer { lock.unlock() }; return writeCount }
    var applies: Int { lock.lock(); defer { lock.unlock() }; return applyCount }
    var waitingApply: Bool { lock.lock(); defer { lock.unlock() }; return pendingApply != nil }
    var snapshot: Rules.Snapshot { lock.lock(); defer { lock.unlock() }; return table }
    func replaceRules(_ raw: [Any]) throws {
        let value = try Rules.Snapshot(raw); lock.lock(); table = value; lock.unlock()
    }
    func advance(_ amount: UInt64) { lock.lock(); time += amount; lock.unlock() }
    func replaceOwner() { lock.lock(); generation += 1; lock.unlock() }
    func owner() throws -> Rules.Owner {
        lock.lock(); defer { lock.unlock() }
        return try .init(generation: generation, configurationRevision: String(repeating: "c", count: 64))
    }
    func options(read: Bool = false, apply: Bool = false, afterEnter: Bool = false,
                 beforeFailure: Bool = false, afterFailure: Bool = false, skip: Bool = false,
                 unchanged: Bool = false, anotherBit: Bool = false, ownerChange: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        holdRead = read; holdApply = apply; holdAfterEnter = afterEnter
        failBefore = beforeFailure; failAfter = afterFailure; skipAdmission = skip
        noChange = unchanged; otherBit = anotherBit; changeOwner = ownerChange
    }
    var driver: Rules.Driver {
        .init(currentOwner: { [self] in try owner() }, read: { [self] access, reply in
            lock.lock(); readCount += 1
            if holdRead { pendingRead = (access, reply); lock.unlock(); return }
            lock.unlock(); completeRead(access, reply)
        }, apply: { [self] mutation, access, reply in
            lock.lock(); applyCount += 1
            if holdApply { pendingApply = (mutation, access, reply); lock.unlock(); return }
            lock.unlock(); completeApply(mutation, access, reply)
        })
    }
    private func completeRead(_ access: Rules.Access, _ reply: Completion) {
        do { try access.check(); reply(.success(snapshot)) } catch { reply(.failure(error)) }
    }
    private func completeApply(_ mutation: Rules.Mutation, _ access: Rules.Access, _ reply: @escaping Completion) {
        do {
            try access.check()
            guard snapshot.sha256 == mutation.expectedRulesSHA256 else { throw Rules.Failure.revoked }
            lock.lock()
            let before = failBefore, skip = skipAdmission, unchanged = noChange, another = otherBit
            let after = failAfter, changedOwner = changeOwner, hold = holdAfterEnter
            lock.unlock()
            if before { throw Injected.failure }
            if skip { reply(.success(try snapshot.settingDisabled(index: mutation.index, value: mutation.disabled))); return }
            try access.enterWrite()
            lock.lock(); writeCount += 1
            let result: Rules.Snapshot
            do {
                if !unchanged { table = try table.settingDisabled(index: mutation.index, value: mutation.disabled) }
                if another { table = try table.settingDisabled(index: 1, value: true) }
                if changedOwner { generation += 1 }
                result = table
                if hold { pendingAfterEnter = (result, reply) }
            } catch { lock.unlock(); throw error }
            lock.unlock()
            if after { throw Injected.failure }
            if !hold { reply(.success(result)) }
        } catch { reply(.failure(error)) }
    }
    func releaseRead() throws {
        lock.lock(); let value = pendingRead; pendingRead = nil; lock.unlock()
        guard let value else { throw Injected.missing }; completeRead(value.0, value.1)
    }
    func heldReadCannotWrite() throws -> Bool {
        lock.lock(); let value = pendingRead; lock.unlock()
        guard let value else { throw Injected.missing }
        do { try value.0.enterWrite(); return false } catch { return true }
    }
    func releaseApply() throws {
        lock.lock(); let value = pendingApply; pendingApply = nil; lock.unlock()
        guard let value else { throw Injected.missing }; completeApply(value.0, value.1, value.2)
    }
    func releaseAfterEnter() throws {
        lock.lock(); let value = pendingAfterEnter; pendingAfterEnter = nil; lock.unlock()
        guard let value else { throw Injected.missing }; value.1(.success(value.0))
    }
}

private final class PipeFixture {
    let fixture: Fixture
    private var channel: Rules.Channel?
    private var input: Int32, output: Int32
    private var buffer = Data()
    init(_ fixture: Fixture, driver: Rules.Driver? = nil, execute: @escaping Rules.Channel.Execute = { $0() }) throws {
        self.fixture = fixture
        var a: [Int32] = [-1, -1], b: [Int32] = [-1, -1]
        guard pipe(&a) == 0 else { throw Injected.failure }
        guard pipe(&b) == 0 else { Darwin.close(a[0]); Darwin.close(a[1]); throw Injected.failure }
        input = a[1]; output = b[0]
        guard fcntl(input, F_SETNOSIGPIPE, 1) == 0,
              let channel = Rules.Channel(binding: try RelayTunRuntimeRulesTests.bound(),
                clientSHA256: String(repeating: "d", count: 64), installationRevision: String(repeating: "e", count: 64),
                driver: driver ?? fixture.driver, input: a[0], output: b[1], execute: execute) else {
            for fd in a + b { Darwin.close(fd) }; throw Injected.failure
        }
        self.channel = channel; channel.start()
    }
    deinit { closeInput(); closeOutput(); channel = nil }
    func closeInput() { if input >= 0 { Darwin.close(input); input = -1 } }
    func invalidate() { channel?.invalidate() }
    func closeOutput() { if output >= 0 { Darwin.close(output); output = -1 } }
    func send(_ value: Data) throws {
        guard input >= 0 else { throw Injected.failure }
        try value.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(input, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw Injected.failure }; offset += count
            }
        }
    }
    func line() throws -> [String: Any] {
        let deadline = Rules.now + 2_000_000_000
        while Rules.now < deadline {
            if let newline = buffer.firstIndex(of: 10) {
                let bytes = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw Injected.failure }
                return value
            }
            var item = pollfd(fd: output, events: Int16(POLLIN), revents: 0)
            guard poll(&item, 1, 10) >= 0 else { throw Injected.failure }
            if item.revents & Int16(POLLIN | POLLHUP) == 0 { continue }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(output, &bytes, bytes.count)
            guard count > 0 else { throw Injected.failure }
            buffer.append(contentsOf: bytes.prefix(count))
            guard buffer.count <= Rules.responseLimit + 1 else { throw Injected.failure }
        }
        throw Injected.deadline
    }
    func isClosed(seconds: UInt64 = 1) -> Bool {
        let deadline = Rules.now + seconds * 1_000_000_000
        while output >= 0, Rules.now < deadline {
            var item = pollfd(fd: output, events: Int16(POLLIN), revents: 0)
            if poll(&item, 1, 10) > 0 {
                var bytes = [UInt8](repeating: 0, count: 1024)
                if Darwin.read(output, &bytes, bytes.count) == 0 { return true }
            }
        }
        return false
    }
    var inputClosedByPeer: Bool {
        guard input >= 0 else { return true }
        var item = pollfd(fd: input, events: Int16(POLLOUT), revents: 0)
        return poll(&item, 1, 0) > 0 && item.revents & Int16(POLLERR | POLLHUP | POLLNVAL) != 0
    }
}

@main struct RelayTunRuntimeRulesTests {
    static let binding: [String: Any] = ["sessionId": "11111111-1111-4111-8111-111111111111",
        "evidenceSHA256": String(repeating: "a", count: 64), "runtimeConfigurationSHA256": String(repeating: "b", count: 64)]
    static func bound() throws -> Rules.Binding { try .init(binding) }
    static func table(_ count: Int = 2) -> [Any] {
        (0..<count).map { index -> [String: Any] in
            ["index": index, "type": index == 0 ? "DomainSuffix" : "Match", "payload": index == 0 ? "fixture.invalid" : "",
             "proxy": "REJECT", "size": -1, "extra": ["disabled": false, "hitCount": 0]]
        }
    }
    static func bytes(_ id: Int, _ action: String, _ extra: [String: Any] = [:], newline: Bool = false) throws -> Data {
        var raw = binding; raw["version"] = 1; raw["id"] = id; raw["action"] = action
        for (key, value) in extra { raw[key] = value }
        var bytes = try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys])
        if newline { bytes.append(10) }; return bytes
    }
    static func request(_ id: Int, _ action: String, _ extra: [String: Any] = [:]) throws -> Rules.Request {
        try Rules.Request.decode(bytes(id, action, extra), binding: bound())
    }
    fileprivate static func preparation(_ fixture: Fixture) -> [String: Any] {
        ["configurationRevision": String(repeating: "c", count: 64), "rulesSHA256": fixture.snapshot.sha256, "index": 0, "disabled": true]
    }
    static func perform(_ controller: Rules.Controller, _ request: Rules.Request) -> Rules.Reply? {
        var result: Rules.Reply?; controller.perform(request) { result = $0 }; return result
    }
    fileprivate static func prepare(_ controller: Rules.Controller, _ fixture: Fixture, id: Int = 1) throws -> String {
        guard let reply = perform(controller, try request(id, "prepare", preparation(fixture))),
              reply.status == .prepared, let nonce = reply.prepared?["nonce"] as? String else { throw Injected.missing }
        return nonce
    }
    static func eventually(_ condition: () -> Bool) -> Bool {
        let deadline = Rules.now + 1_000_000_000
        while Rules.now < deadline { if condition() { return true }; usleep(1000) }; return false
    }
    /// This mode exists only in the isolated test target. Shipping ClientMain
    /// never compiles this file or accepts this argument/trust substitution.
    static func channelFixture() -> Never {
        do {
            let fixture = try Fixture(), operations = DispatchQueue(label: "local.relay.rules.fixture.operations")
            let original = fixture.driver
            let driver = Rules.Driver(currentOwner: original.currentOwner, read: { access, reply in
                operations.async { original.read(access, reply) }
            }, apply: { mutation, access, reply in
                operations.async { original.apply(mutation, access, reply) }
            })
            guard let channel = Rules.Channel(binding: try bound(), clientSHA256: String(repeating: "d", count: 64),
                installationRevision: String(repeating: "e", count: 64), driver: driver,
                execute: { work in operations.async { work() } }) else { exit(2) }
            print("CONTROL_READY"); fflush(stdout); channel.start()
            while let command = readLine() {
                switch command {
                case "hold-read": fixture.options(read: true)
                case "release-read": try fixture.releaseRead()
                case "hold-apply": fixture.options(apply: true)
                case "release-apply": try fixture.releaseApply()
                case "owner-loss": fixture.replaceOwner()
                case "state": print("fixture-state:\(fixture.reads):\(fixture.applies):\(fixture.writes)")
                default: print("control-alive:" + command)
                }
                fflush(stdout)
            }
            channel.invalidate(); withExtendedLifetime(channel) {}; exit(0)
        } catch { exit(2) }
    }
    static func main() {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { exit(77) }
        if Array(CommandLine.arguments.dropFirst()) == ["--rules-channel-fixture"] { channelFixture() }
        guard CommandLine.arguments.count == 1 else { exit(77) }
        var checks = [[String: Any]]()
        func check(_ name: String, _ condition: Bool) { checks.append(["name": name, "passed": condition]) }
        func test(_ name: String, _ body: () throws -> Bool) {
            do { check(name, try body()) } catch { check(name, false) }
        }
        test("known table preserves false and ignores volatile fields") {
            let raw = table(), first = try Rules.Snapshot(raw)
            var changed = raw; var row = changed[0] as! [String: Any]
            row["extra"] = ["disabled": false, "hitCount": UInt64.max, "hitAt": "not-a-date"]
            changed[0] = row
            return try first.rows[0].disabled == false && Rules.Snapshot(changed).sha256 == first.sha256
        }
        test("missing disabled is a different readonly identity") {
            var raw = table(); var row = raw[0] as! [String: Any]; row.removeValue(forKey: "extra"); raw[0] = row
            let snapshot = try Rules.Snapshot(raw)
            do { _ = try snapshot.settingDisabled(index: 0, value: true); return false } catch {}
            let original = try Rules.Snapshot(table())
            return snapshot.rows[0].disabled == nil && snapshot.sha256 != original.sha256
        }
        for (name, value) in [("index boolean", ["index": true]), ("size boolean", ["size": false]),
                              ("size negative", ["size": -2]), ("size fraction", ["size": 1.5]),
                              ("disabled numeric", ["extra": ["disabled": 0]]),
                              ("disabled null", ["extra": ["disabled": NSNull()]]),
                              ("payload type", ["payload": []])] as [(String, [String: Any])] {
            test(name + " rejected") {
                var raw = table(); var row = raw[0] as! [String: Any]
                for (key, entry) in value { row[key] = entry }; raw[0] = row
                do { _ = try Rules.Snapshot(raw); return false } catch { return true }
            }
        }
        test("full10000 table accepted independent of small request scanner") { try Rules.Snapshot(table(10000)).rows.count == 10000 }
        test("10001 rows rejected without truncation") { do { _ = try Rules.Snapshot(table(10001)); return false } catch { return true } }
        test("2MiB canonical table rejected without truncation") {
            let raw: [Any] = (0..<40).map { ["index": $0, "type": "Domain", "payload": String(repeating: "x", count: 65536), "proxy": "REJECT"] as [String: Any] }
            do { _ = try Rules.Snapshot(raw); return false } catch { return true }
        }
        for (name, change) in [("unknown path", ["path": "/rules"]), ("unknown action", ["action": "stopCore"]),
                               ("wrong binding", ["evidenceSHA256": String(repeating: "f", count: 64)]),
                               ("boolean index", ["index": true]), ("numeric disabled", ["disabled": 1]),
                               ("large index", ["index": 10000]), ("boolean request id", ["id": false])] as [(String, [String: Any])] {
            test(name + " frame rejected") {
                let f = try Fixture(); var values = preparation(f)
                for (key, value) in change { values[key] = value }
                do { _ = try request(1, "prepare", values); return false } catch { return true }
            }
        }
        test("decoded duplicate request fields rejected") {
            let source = String(decoding: try bytes(1, "read"), as: UTF8.self)
            let duplicate = Data((String(source.dropLast()) + ",\"\\u0069d\":2}").utf8)
            do { _ = try Rules.Request.decode(duplicate, binding: bound()); return false } catch { return true }
        }
        test("prepare is read-only and reserves exactly one nonce") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            _ = try prepare(c, f)
            let overlap = perform(c, try request(2, "read"))
            return f.reads == 1 && f.writes == 0 && overlap?.status == .busy
        }
        test("a read guard cannot be spent as a write admission") {
            let f = try Fixture(); f.options(read: true)
            let c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            c.perform(try request(1, "read")) { _ in }
            let denied = try f.heldReadCannotWrite(); try f.releaseRead()
            return denied && f.writes == 0 && !c.isBusy
        }
        test("one nonce commits one exact bit and cannot replay") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f)
            let changed = perform(c, try request(2, "commit", ["nonce": nonce]))
            let replay = perform(c, try request(3, "commit", ["nonce": nonce]))
            return changed?.status == .changed && replay?.status == .stale && f.writes == 1 && f.snapshot.rows[0].disabled == true && f.snapshot.rows[1].disabled == false
        }
        test("wrong nonce cannot consume a valid prepared operation") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f)
            let wrong = perform(c, try request(2, "commit", ["nonce": UUID().uuidString.lowercased()]))
            let right = perform(c, try request(3, "commit", ["nonce": nonce]))
            return wrong?.status == .stale && right?.status == .changed && f.writes == 1
        }
        test("cancellation of an old operation cannot revoke a newer prepared nonce") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            _ = try prepare(c, f)
            _ = perform(c, try request(2, "cancel", ["operationId": 1]))
            let nonce = try prepare(c, f, id: 3)
            let stale = perform(c, try request(4, "cancel", ["operationId": 1]))
            let changed = perform(c, try request(5, "commit", ["nonce": nonce]))
            return stale?.status == .stale && changed?.status == .changed && f.writes == 1
        }
        test("expired preparation cannot reset its lease at commit") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f); f.advance(Rules.duration)
            let value = perform(c, try request(2, "commit", ["nonce": nonce]))
            return value?.status != .changed && f.writes == 0
        }
        test("held owner generation change prevents a prepared commit") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f); f.replaceOwner()
            let value = perform(c, try request(2, "commit", ["nonce": nonce]))
            return value?.status == .stale && f.writes == 0
        }
        for behavior in ["target-identity", "unrelated-disabled"] {
            test("fresh commit preflight refuses " + behavior + " drift before any write") {
                let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
                let nonce = try prepare(c, f); var raw = table()
                let index = behavior == "target-identity" ? 0 : 1
                var row = raw[index] as! [String: Any]
                if index == 0 { row["payload"] = "another.invalid" }
                else { row["extra"] = ["disabled": true] }
                raw[index] = row; try f.replaceRules(raw)
                let value = perform(c, try request(2, "commit", ["nonce": nonce]))
                return value?.status == .stale && f.writes == 0 && f.reads == 2 && f.applies == 0
            }
        }
        test("wrong configuration revision refuses preparation before any rule read") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            var values = preparation(f); values["configurationRevision"] = String(repeating: "f", count: 64)
            return perform(c, try request(1, "prepare", values))?.status == .stale && f.reads == 0 && f.writes == 0
        }
        test("changed or readonly target cannot prepare a write") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            var values = preparation(f); values["rulesSHA256"] = String(repeating: "f", count: 64)
            return perform(c, try request(1, "prepare", values))?.status == .stale && f.writes == 0
        }
        test("late read after cancellation stays busy to real settlement") {
            let f = try Fixture(); f.options(read: true)
            let c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            var completed: Rules.Reply?
            c.perform(try request(1, "prepare", preparation(f))) { completed = $0 }
            let cancel = perform(c, try request(2, "cancel", ["operationId": 1]))
            let held = c.isBusy && completed == nil; try f.releaseRead()
            return held && cancel?.status == .cancelling && completed?.status == .cancelled && !c.isBusy && f.writes == 0
        }
        test("cancel before entry prevents actual mutation and does not release busy early") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f); f.options(apply: true)
            var completed: Rules.Reply?
            c.perform(try request(2, "commit", ["nonce": nonce])) { completed = $0 }
            let cancel = perform(c, try request(3, "cancel", ["operationId": 1]))
            let held = c.isBusy && completed == nil; try f.releaseApply()
            return held && cancel?.status == .cancelling && completed?.status == .cancelled && !c.isBusy && f.writes == 0
        }
        test("cancel during commit's fresh read prevents apply and keeps the same operation id") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f); f.options(read: true)
            var completed: Rules.Reply?
            c.perform(try request(2, "commit", ["nonce": nonce])) { completed = $0 }
            let cancel = perform(c, try request(3, "cancel", ["operationId": 1]))
            let held = c.isBusy && completed == nil; try f.releaseRead()
            return held && cancel?.status == .cancelling && completed?.status == .cancelled && f.writes == 0
        }
        test("cancel after actual admission never reports a clean cancellation") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f); f.options(afterEnter: true)
            var completed: Rules.Reply?
            c.perform(try request(2, "commit", ["nonce": nonce])) { completed = $0 }
            let cancel = perform(c, try request(3, "cancel", ["operationId": 1]))
            let held = c.isBusy && f.writes == 1; try f.releaseAfterEnter()
            return held && cancel?.status == .uncertain && completed?.status == .uncertain && !c.isBusy
        }
        test("lease expiry during held pre-entry apply prevents a late write") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f); f.options(apply: true)
            var completed: Rules.Reply?
            c.perform(try request(2, "commit", ["nonce": nonce])) { completed = $0 }
            f.advance(Rules.duration); let held = c.isBusy; try f.releaseApply()
            return held && completed?.status == .expired && f.writes == 0 && !c.isBusy
        }
        test("fixed writer receives the preimage digest and rejects late table drift before admission") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f); f.options(apply: true)
            var completed: Rules.Reply?
            c.perform(try request(2, "commit", ["nonce": nonce])) { completed = $0 }
            var raw = table(); var row = raw[0] as! [String: Any]; row["payload"] = "late.invalid"; raw[0] = row
            try f.replaceRules(raw); try f.releaseApply()
            return completed?.status == .stale && f.applies == 1 && f.writes == 0
        }
        test("rules EOF after entry yields uncertainty and does not erase the actual target bit") {
            let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
            let nonce = try prepare(c, f); f.options(afterEnter: true)
            var completed: Rules.Reply?
            c.perform(try request(2, "commit", ["nonce": nonce])) { completed = $0 }
            c.close(); let held = c.isBusy; try f.releaseAfterEnter()
            return held && completed?.status == .uncertain && f.writes == 1 && f.snapshot.rows[0].disabled == true
        }
        for behavior in ["unchanged", "other-bit", "missing-entry", "after-failure", "owner-change"] {
            test("postcondition rejects " + behavior + " without retry") {
                let f = try Fixture(), c = Rules.Controller(binding: try bound(), driver: f.driver, clock: { f.clock })
                let nonce = try prepare(c, f)
                f.options(afterFailure: behavior == "after-failure", skip: behavior == "missing-entry",
                    unchanged: behavior == "unchanged", anotherBit: behavior == "other-bit", ownerChange: behavior == "owner-change")
                let value = perform(c, try request(2, "commit", ["nonce": nonce]))
                return value?.status != .changed && value?.status != .cancelled && f.writes == (behavior == "missing-entry" ? 0 : 1)
            }
        }
        test("closing one rules capability leaves the synthetic held owner and another capability usable") {
            let f = try Fixture(), a = Rules.Controller(binding: try bound(), driver: f.driver), b = Rules.Controller(binding: try bound(), driver: f.driver)
            a.close()
            let first = perform(a, try request(1, "read")), second = perform(b, try request(1, "read"))
            return first?.status == .unavailable && second?.status == .snapshot && f.writes == 0
        }
        test("real pipe hello and read prepare commit are framed with no lifecycle transport") {
            let f = try Fixture(), pipe = try PipeFixture(f)
            let hello = try pipe.line()
            try pipe.send(bytes(1, "prepare", preparation(f), newline: true))
            let prepared = try pipe.line()
            guard let value = prepared["prepared"] as? [String: Any], let nonce = value["nonce"] as? String else { return false }
            let before = f.writes == 0
            try pipe.send(bytes(2, "commit", ["nonce": nonce], newline: true))
            let changed = try pipe.line()
            return hello["capability"] as? String == "runtime-rules-v1" && prepared["status"] as? String == "prepared" && before && changed["status"] as? String == "changed" && f.writes == 1
        }
        test("real pipe cancellation before delayed apply has pending ack then cancelled settlement") {
            let f = try Fixture(), pipe = try PipeFixture(f); _ = try pipe.line()
            try pipe.send(bytes(1, "prepare", preparation(f), newline: true))
            let prepared = try pipe.line(); guard let value = prepared["prepared"] as? [String: Any], let nonce = value["nonce"] as? String else { return false }
            f.options(apply: true); try pipe.send(bytes(2, "commit", ["nonce": nonce], newline: true))
            try pipe.send(bytes(3, "cancel", ["operationId": 1], newline: true))
            let ack = try pipe.line(); try f.releaseApply(); let result = try pipe.line()
            return ack["status"] as? String == "cancelling" && ack["pending"] as? Bool == true && result["status"] as? String == "cancelled" && f.writes == 0
        }
        test("EOF only revokes rules and prevents delayed pre-entry write") {
            let f = try Fixture(), pipe = try PipeFixture(f); _ = try pipe.line()
            try pipe.send(bytes(1, "prepare", preparation(f), newline: true))
            let prepared = try pipe.line(); guard let value = prepared["prepared"] as? [String: Any], let nonce = value["nonce"] as? String else { return false }
            f.options(apply: true); try pipe.send(bytes(2, "commit", ["nonce": nonce], newline: true))
            guard eventually({ f.waitingApply }) else { return false }
            pipe.closeInput(); let closed = pipe.isClosed(); try f.releaseApply()
            _ = try f.owner(); return closed && f.writes == 0
        }
        test("malformed frame closes rules only with zero owner callbacks") {
            let f = try Fixture(), pipe = try PipeFixture(f); _ = try pipe.line()
            try pipe.send(Data("{\"version\":1,\"action\":\"stopCore\"}\n".utf8))
            let closed = pipe.isClosed(); _ = try f.owner(); return closed && f.reads == 0 && f.writes == 0
        }
        test("oversized request closes only rules before any owner operation") {
            let f = try Fixture(), pipe = try PipeFixture(f); _ = try pipe.line()
            try pipe.send(Data((String(repeating: "x", count: Rules.requestLimit + 1) + "\n").utf8))
            let closed = pipe.isClosed(); _ = try f.owner(); return closed && f.reads == 0 && f.writes == 0
        }
        test("real pipe timeout revokes queued preparation and late callback cannot publish a nonce") {
            let f = try Fixture(); f.options(read: true)
            let pipe = try PipeFixture(f); _ = try pipe.line()
            try pipe.send(bytes(1, "prepare", preparation(f), newline: true))
            guard eventually({ f.reads == 1 }) else { return false }
            let closed = pipe.isClosed(seconds: 4); try f.releaseRead()
            _ = try f.owner(); return closed && f.writes == 0
        }
        test("overlapping busy frame still consumes its id and replay closes only rules") {
            let f = try Fixture(); f.options(read: true)
            let pipe = try PipeFixture(f); _ = try pipe.line()
            try pipe.send(bytes(1, "read", newline: true)); guard eventually({ f.reads == 1 }) else { return false }
            try pipe.send(bytes(3, "read", newline: true)); let busy = try pipe.line()
            try pipe.send(bytes(2, "read", newline: true)); let closed = pipe.isClosed(); try f.releaseRead()
            return busy["status"] as? String == "busy" && closed && f.writes == 0
        }
        test("lost output peer cannot SIGPIPE-kill the owner process") {
            let f = try Fixture(), pipe = try PipeFixture(f); _ = try pipe.line(); pipe.closeOutput()
            try pipe.send(bytes(1, "read", newline: true))
            let closed = eventually { pipe.inputClosedByPeer }
            _ = try f.owner(); return closed && f.reads == 1 && f.writes == 0
        }
        test("real pipe emits a rules table larger than old readiness64KiB without truncation") {
            let f = try Fixture(table(1000)), pipe = try PipeFixture(f); _ = try pipe.line()
            try pipe.send(bytes(1, "read", newline: true)); let result = try pipe.line()
            let snapshot = result["snapshot"] as? [String: Any]
            return (snapshot?["rules"] as? [[String: Any]])?.count == 1000 && result["status"] as? String == "snapshot" && f.writes == 0
        }
        for cancellation in ["cancel", "EOF", "lifecycle-invalidate"] {
            test("actual session and pipe queues: blocked pre-entry \(cancellation) prevents write") {
                let f = try Fixture(), gate = try SelfPipeGate(), entered = DispatchSemaphore(value: 0), settled = DispatchSemaphore(value: 0)
                defer { gate.release() }
                let operations = DispatchQueue(label: "local.relay.rules.blocked.fixture"), original = f.driver
                let driver = Rules.Driver(currentOwner: original.currentOwner, read: { access, reply in
                    operations.async { original.read(access, reply) }
                }, apply: { mutation, access, reply in
                    operations.async {
                        entered.signal()
                        do { try gate.wait(); original.apply(mutation, access, reply) }
                        catch { reply(.failure(error)) }
                        settled.signal()
                    }
                })
                let pipe = try PipeFixture(f, driver: driver, execute: { work in operations.async { work() } }); _ = try pipe.line()
                try pipe.send(bytes(1, "prepare", preparation(f), newline: true)); let prepared = try pipe.line()
                guard let nonce = (prepared["prepared"] as? [String: Any])?["nonce"] as? String else { return false }
                try pipe.send(bytes(2, "commit", ["nonce": nonce], newline: true))
                guard entered.wait(timeout: .now() + 2) == .success else { return false }
                let blockedStill = settled.wait(timeout: .now()) == .timedOut
                var revoked = false
                if cancellation == "cancel" {
                    try pipe.send(bytes(3, "cancel", ["operationId": 1], newline: true)); let ack = try pipe.line()
                    try pipe.send(bytes(4, "read", newline: true)); let busy = try pipe.line()
                    revoked = ack["status"] as? String == "cancelling" && ack["pending"] as? Bool == true && busy["status"] as? String == "busy"
                } else {
                    if cancellation == "EOF" { pipe.closeInput() } else { pipe.invalidate() }
                    revoked = pipe.isClosed()
                }
                gate.release(); guard settled.wait(timeout: .now() + 2) == .success else { return false }
                if cancellation == "cancel" { let final = try pipe.line(); revoked = revoked && final["status"] as? String == "cancelled" }
                _ = try f.owner(); return blockedStill && revoked && f.writes == 0
            }
        }
        test("actual two queues: cancellation after admitted write cannot become clean cancelled") {
            let f = try Fixture(), gate = try SelfPipeGate(), entered = DispatchSemaphore(value: 0), settled = DispatchSemaphore(value: 0)
            defer { gate.release() }; f.options(afterEnter: true)
            let operations = DispatchQueue(label: "local.relay.rules.submitted.fixture"), original = f.driver
            let driver = Rules.Driver(currentOwner: original.currentOwner, read: { access, reply in
                operations.async { original.read(access, reply) }
            }, apply: { mutation, access, reply in
                operations.async {
                    original.apply(mutation, access, reply); entered.signal()
                    do { try gate.wait(); try f.releaseAfterEnter() } catch { reply(.failure(error)) }
                    settled.signal()
                }
            })
            let pipe = try PipeFixture(f, driver: driver, execute: { work in operations.async { work() } }); _ = try pipe.line()
            try pipe.send(bytes(1, "prepare", preparation(f), newline: true)); let prepared = try pipe.line()
            guard let nonce = (prepared["prepared"] as? [String: Any])?["nonce"] as? String else { return false }
            try pipe.send(bytes(2, "commit", ["nonce": nonce], newline: true))
            guard entered.wait(timeout: .now() + 2) == .success, f.writes == 1 else { return false }
            try pipe.send(bytes(3, "cancel", ["operationId": 1], newline: true)); let ack = try pipe.line()
            gate.release(); guard settled.wait(timeout: .now() + 2) == .success else { return false }
            let final = try pipe.line()
            return ack["status"] as? String == "uncertain" && ack["pending"] as? Bool == true && final["status"] as? String == "uncertain" && f.writes == 1
        }
        let passed = checks.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["scope": "runtime-rules-v1 phase1 typed model and ordinary-UID private pipes only", "passed": passed,
            "failed": checks.count - passed, "checks": checks, "actualHTTP": false, "actualCoreOrTUN": false, "installed": false]
        let reportBytes = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        FileHandle.standardOutput.write(reportBytes); FileHandle.standardOutput.write(Data([10]))
        if passed != checks.count { exit(1) }
    }
}
