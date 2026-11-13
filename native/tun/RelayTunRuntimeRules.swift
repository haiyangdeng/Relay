import Foundation
import CoreFoundation
import CryptoKit
import Darwin

/// A separate positive capability, not an extension of runtime-capture-v1 or
/// the lifecycle channel. This file performs no HTTP, process or system action.
enum RelayTunRuntimeRules {
    static let requestLimit = 8192
    static let tableLimit = 2 * 1024 * 1024
    static let responseLimit = tableLimit + requestLimit
    static let maximumRules = 10000
    static let duration: UInt64 = 3_000_000_000
    static var now: UInt64 { DispatchTime.now().uptimeNanoseconds }
    enum Failure: Error { case invalid, unavailable, revoked, expired, entered }

    static func hash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value)?.uuidString.lowercased() == value
    }
    static func boolean(_ value: Any?) -> Bool? {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value.boolValue
    }
    static func integer(_ value: Any?) -> Int? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let number = value.doubleValue
        guard number.isFinite, number.rounded() == number,
              number >= -1, number <= 9_007_199_254_740_991 else { return nil }
        return Int(number)
    }
    struct Binding: Equatable {
        let sessionId: String, evidenceSHA256: String, runtimeConfigurationSHA256: String
        init(_ raw: [String: Any]) throws {
            guard Set(raw.keys) == ["sessionId", "evidenceSHA256", "runtimeConfigurationSHA256"],
                  let session = raw["sessionId"] as? String, uuid(session),
                  let evidence = raw["evidenceSHA256"] as? String, hash(evidence),
                  let configuration = raw["runtimeConfigurationSHA256"] as? String, hash(configuration) else { throw Failure.invalid }
            sessionId = session; evidenceSHA256 = evidence; runtimeConfigurationSHA256 = configuration
        }
        var json: [String: Any] {
            ["sessionId": sessionId, "evidenceSHA256": evidenceSHA256,
             "runtimeConfigurationSHA256": runtimeConfigurationSHA256]
        }
    }
    struct Row {
        let index: Int, type: String, payload: String, proxy: String
        let size: Int?, disabled: Bool?
        init(_ raw: [String: Any], index expected: Int) throws {
            guard integer(raw["index"]) == expected, expected >= 0, expected < maximumRules,
                  let type = raw["type"] as? String, !type.isEmpty,
                  let payload = raw["payload"] as? String, let proxy = raw["proxy"] as? String,
                  [type, payload, proxy].allSatisfy({ $0.utf16.count <= 65536 }) else { throw Failure.invalid }
            let size = raw["size"].flatMap { integer($0) }
            guard raw["size"] == nil || size != nil else { throw Failure.invalid }
            var disabled: Bool?
            if let value = raw["extra"] {
                guard let extra = value as? [String: Any] else { throw Failure.invalid }
                disabled = boolean(extra["disabled"])
                guard extra["disabled"] == nil || disabled != nil else { throw Failure.invalid }
            }
            index = expected; self.type = type; self.payload = payload; self.proxy = proxy
            self.size = size; self.disabled = disabled
        }
        private init(_ row: Row, disabled: Bool) {
            index = row.index; type = row.type; payload = row.payload; proxy = row.proxy
            size = row.size; self.disabled = disabled
        }
        var json: [String: Any] {
            var value: [String: Any] = ["index": index, "type": type, "payload": payload, "proxy": proxy]
            if let size { value["size"] = size }; if let disabled { value["disabled"] = disabled }
            return value
        }
        fileprivate var canonical: [String: Any] {
            ["index": index, "type": type, "payload": payload, "proxy": proxy,
             "size": size.map { $0 as Any } ?? NSNull(), "disabled": disabled.map { $0 as Any } ?? NSNull()]
        }
        fileprivate func settingDisabled(_ value: Bool) throws -> Row {
            guard disabled != nil else { throw Failure.invalid }; return Row(self, disabled: value)
        }
    }
    struct Snapshot {
        let rows: [Row], sha256: String
        /// The future authenticated HTTP reader must bound its raw body before
        /// decoding. This typed projection is independent of the old small
        /// request JSON scanner and never truncates a large rule table.
        init(_ raw: [Any]) throws {
            guard raw.count <= maximumRules else { throw Failure.invalid }
            let rows = try raw.enumerated().map { index, item -> Row in
                guard let value = item as? [String: Any] else { throw Failure.invalid }
                return try Row(value, index: index)
            }
            try self.init(rows: rows)
        }
        private init(rows: [Row]) throws {
            guard rows.count <= maximumRules else { throw Failure.invalid }
            let bytes = try JSONSerialization.data(withJSONObject: rows.map { $0.canonical }, options: [.sortedKeys, .withoutEscapingSlashes])
            guard bytes.count <= tableLimit else { throw Failure.invalid }
            self.rows = rows
            // Opaque outside Native: no cross-language JSON encoding equality
            // is assumed, and volatile counters/time never enter this digest.
            sha256 = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        }
        func settingDisabled(index: Int, value: Bool) throws -> Snapshot {
            guard rows.indices.contains(index) else { throw Failure.invalid }
            var next = rows; next[index] = try next[index].settingDisabled(value)
            return try Snapshot(rows: next)
        }
    }
    struct Owner: Equatable {
        // A private held-owner generation, never a renderer PID or path.
        let generation: UInt64, configurationRevision: String
        init(generation: UInt64, configurationRevision: String) throws {
            guard hash(configurationRevision) else { throw Failure.invalid }
            self.generation = generation; self.configurationRevision = configurationRevision
        }
    }
    enum Operation {
        case read
        case prepare(configurationRevision: String, rulesSHA256: String, index: Int, disabled: Bool)
        case commit(nonce: String)
        case cancel(operationId: Int)
    }
    struct Request {
        let id: Int, binding: Binding, operation: Operation
        static func decode(_ bytes: Data, binding expected: Binding) throws -> Request {
            let raw = try RelayTunStrictJSON.object(bytes, limit: requestLimit)
            let base = Set(["version", "id", "action", "sessionId", "evidenceSHA256", "runtimeConfigurationSHA256"])
            guard RelayTunStrictJSON.integer(raw["version"]) == 1,
                  let id = RelayTunStrictJSON.integer(raw["id"]), id > 0, id <= Int(Int32.max),
                  let action = raw["action"] as? String else { throw Failure.invalid }
            let bound = try Binding(Dictionary(uniqueKeysWithValues: expected.json.keys.map { ($0, raw[$0] ?? NSNull()) }))
            guard bound == expected else { throw Failure.invalid }
            let operation: Operation
            switch action {
            case "read":
                guard Set(raw.keys) == base else { throw Failure.invalid }; operation = .read
            case "prepare":
                guard Set(raw.keys) == base.union(["configurationRevision", "rulesSHA256", "index", "disabled"]),
                      let revision = raw["configurationRevision"] as? String, hash(revision),
                      let sha = raw["rulesSHA256"] as? String, hash(sha),
                      let index = RelayTunStrictJSON.integer(raw["index"]), index < maximumRules,
                      let disabled = boolean(raw["disabled"]) else { throw Failure.invalid }
                operation = .prepare(configurationRevision: revision, rulesSHA256: sha, index: index, disabled: disabled)
            case "commit":
                guard Set(raw.keys) == base.union(["nonce"]), let nonce = raw["nonce"] as? String, uuid(nonce) else { throw Failure.invalid }
                operation = .commit(nonce: nonce)
            case "cancel":
                guard Set(raw.keys) == base.union(["operationId"]),
                      let target = RelayTunStrictJSON.integer(raw["operationId"]), target > 0, target <= Int(Int32.max) else { throw Failure.invalid }
                operation = .cancel(operationId: target)
            default: throw Failure.invalid
            }
            return .init(id: id, binding: bound, operation: operation)
        }
    }

    fileprivate final class Scope {
        private let lock = NSLock(); private var live = true
        func revoke() { lock.lock(); live = false; lock.unlock() }
        var isLive: Bool { lock.lock(); defer { lock.unlock() }; return live }
    }
    final class Access {
        let deadline: UInt64
        private let lock = NSLock(), scope: Scope, owner: Owner, clock: () -> UInt64
        private let currentOwner: () throws -> Owner, writable: Bool
        private var revoked = false, entered = false, finished = false
        fileprivate init(deadline: UInt64, owner: Owner, scope: Scope, writable: Bool,
                         clock: @escaping () -> UInt64, currentOwner: @escaping () throws -> Owner) {
            self.deadline = deadline; self.owner = owner; self.scope = scope; self.writable = writable
            self.clock = clock; self.currentOwner = currentOwner
        }
        private func validate(enter: Bool) throws {
            // Never run an owner callback while holding the access lock.
            guard try currentOwner() == owner else { throw Failure.revoked }
            lock.lock(); defer { lock.unlock() }
            guard !revoked, !finished, scope.isLive else { throw Failure.revoked }
            guard clock() < deadline else { throw Failure.expired }
            if enter {
                guard writable, !entered else { throw Failure.entered }; entered = true
            }
        }
        func check() throws { try validate(enter: false) }
        /// The future fixed HTTP writer must call this immediately before its
        /// first PATCH byte, after all awaited peer/source checks. No observer
        /// or await belongs between this admission and the actual write.
        func enterWrite() throws { try validate(enter: true) }
        fileprivate func cancel() { lock.lock(); revoked = true; lock.unlock() }
        fileprivate func finish() { lock.lock(); finished = true; lock.unlock() }
        var didEnter: Bool { lock.lock(); defer { lock.unlock() }; return entered }
    }
    struct Mutation {
        let index: Int, disabled: Bool, expectedRulesSHA256: String
    }
    struct Driver {
        let currentOwner: () throws -> Owner
        let read: (Access, @escaping (Result<Snapshot, Error>) -> Void) -> Void
        let apply: (Mutation, Access, @escaping (Result<Snapshot, Error>) -> Void) -> Void
    }
    enum Status: String { case snapshot, prepared, changed, unchanged, cancelled, cancelling, uncertain, busy, stale, expired, unavailable }
    struct Reply {
        let status: Status
        var pending = false
        var snapshot: Snapshot?
        var owner: Owner?
        var prepared: [String: Any]?
        // Native-only send budget, never an authority supplied on the wire.
        var deadline: UInt64?
        var json: [String: Any] {
            var value: [String: Any] = ["status": status.rawValue, "pending": pending]
            if let snapshot, let owner {
                value["snapshot"] = ["configurationRevision": owner.configurationRevision,
                    "rulesSHA256": snapshot.sha256, "rules": snapshot.rows.map { $0.json }]
            }
            if let prepared { value["prepared"] = prepared }; return value
        }
    }
    final class Controller {
        private final class Work {
            let request: Request, operationId: Int, deadline: UInt64, reply: (Reply) -> Void
            var owner: Owner?, access: Access?, expected: Snapshot?, cancelled = false, preflightFinished = false
            init(_ request: Request, operationId: Int? = nil, deadline: UInt64, reply: @escaping (Reply) -> Void) {
                self.request = request; self.operationId = operationId ?? request.id
                self.deadline = deadline; self.reply = reply
            }
        }
        private struct Plan {
            let requestId: Int, nonce: String, deadline: UInt64, owner: Owner
            let snapshot: Snapshot, mutation: Mutation
        }
        private let lock = NSLock(), scope = Scope(), binding: Binding, driver: Driver, clock: () -> UInt64
        private var work: Work?, plan: Plan?, closed = false, lastID = 0
        init(binding: Binding, driver: Driver, clock: @escaping () -> UInt64 = { RelayTunRuntimeRules.now }) {
            self.binding = binding; self.driver = driver; self.clock = clock
        }
        deinit { scope.revoke(); work?.access?.cancel() }
        var isBusy: Bool { lock.lock(); defer { lock.unlock() }; return work != nil }
        func close() {
            scope.revoke()
            lock.lock(); closed = true; plan = nil; work?.cancelled = true; work?.access?.cancel(); lock.unlock()
        }
        func perform(_ request: Request, reply: @escaping (Reply) -> Void) {
            lock.lock()
            guard !closed, request.binding == binding, request.id > lastID else {
                lock.unlock(); reply(.init(status: .unavailable)); return
            }
            lastID = request.id
            if let value = plan, clock() >= value.deadline {
                plan = nil
                if case .commit(let nonce) = request.operation, nonce == value.nonce {
                    lock.unlock(); reply(.init(status: .expired)); return
                }
            }
            if case .cancel(let target) = request.operation {
                let result: Reply
                if let current = work, current.operationId == target {
                    current.cancelled = true; current.access?.cancel()
                    result = .init(status: current.access?.didEnter == true ? .uncertain : .cancelling, pending: true)
                } else if plan?.requestId == target {
                    plan = nil; result = .init(status: .cancelled)
                } else { result = .init(status: .stale, pending: work != nil) }
                lock.unlock(); reply(result); return
            }
            guard work == nil else { lock.unlock(); reply(.init(status: .busy, pending: true)); return }
            if case .commit(let nonce) = request.operation {
                guard let prepared = plan, prepared.nonce == nonce else {
                    lock.unlock(); reply(.init(status: .stale)); return
                }
                plan = nil
                // Cancellation uses the logical prepare operation throughout
                // commit; the pipe frame id remains distinct for correlation.
                let current = Work(request, operationId: prepared.requestId, deadline: prepared.deadline, reply: reply)
                current.owner = prepared.owner
                do { current.expected = try prepared.snapshot.settingDisabled(index: prepared.mutation.index, value: prepared.mutation.disabled) }
                catch { lock.unlock(); reply(.init(status: .stale)); return }
                let access = Access(deadline: prepared.deadline, owner: prepared.owner, scope: scope,
                    writable: false, clock: clock, currentOwner: driver.currentOwner)
                current.access = access; work = current; lock.unlock()
                do { try access.check() }
                catch { finish(current, result: .failure(error)); return }
                // A commit performs a fresh, non-writable observation first.
                // Postconditions alone cannot prevent changing a stale index.
                driver.read(access) { [self, current] result in preflight(current, plan: prepared, result: result) }
                return
            }
            guard plan == nil else { lock.unlock(); reply(.init(status: .busy)); return }
            let start = clock()
            guard start <= UInt64.max - duration else { lock.unlock(); reply(.init(status: .unavailable)); return }
            let current = Work(request, deadline: start + duration, reply: reply); work = current; lock.unlock()
            do {
                let owner = try driver.currentOwner()
                let access = Access(deadline: current.deadline, owner: owner, scope: scope,
                    writable: false, clock: clock, currentOwner: driver.currentOwner)
                lock.lock()
                current.owner = owner; current.access = access
                if current.cancelled || closed { access.cancel() }
                lock.unlock()
                if case .prepare(let revision, _, _, _) = request.operation, revision != owner.configurationRevision {
                    throw Failure.revoked
                }
                try access.check()
                driver.read(access) { [self, current] result in finish(current, result: result) }
            } catch { finish(current, result: .failure(error)) }
        }
        private func preflight(_ current: Work, plan prepared: Plan, result: Result<Snapshot, Error>) {
            lock.lock()
            guard work === current, !current.preflightFinished else { lock.unlock(); return }
            current.preflightFinished = true; lock.unlock()
            do {
                try current.access?.check()
                let snapshot = try result.get()
                guard snapshot.sha256 == prepared.snapshot.sha256 else { throw Failure.revoked }
            } catch { finish(current, result: .failure(error)); return }
            lock.lock()
            guard work === current else { lock.unlock(); return }
            if closed || current.cancelled || clock() >= current.deadline {
                lock.unlock(); finish(current, result: .failure(Failure.revoked)); return
            }
            current.access?.finish()
            let access = Access(deadline: current.deadline, owner: prepared.owner, scope: scope,
                writable: true, clock: clock, currentOwner: driver.currentOwner)
            current.access = access; lock.unlock()
            do { try access.check() }
            catch { finish(current, result: .failure(error)); return }
            // The fixed writer also receives the opaque preimage digest, so it
            // can keep its final table/peer check next to enterWrite and PATCH.
            driver.apply(prepared.mutation, access) { [self, current] value in finish(current, result: value) }
        }
        private func finish(_ current: Work, result: Result<Snapshot, Error>) {
            let valid: Bool
            do { try current.access?.check(); valid = current.access != nil }
            catch { valid = false }
            lock.lock()
            guard work === current else { lock.unlock(); return }
            let entered = current.access?.didEnter == true
            let finishedAt = clock()
            var answer = Reply(status: entered ? .uncertain : .unavailable)
            if !entered, case .failure(let error) = result {
                switch error as? Failure {
                case .revoked?: answer = .init(status: .stale)
                case .expired?: answer = .init(status: .expired)
                default: break
                }
            }
            if closed || current.cancelled {
                answer = .init(status: entered ? .uncertain : .cancelled)
            } else if finishedAt >= current.deadline {
                answer = .init(status: entered ? .uncertain : .expired)
            } else if !valid {
                answer = .init(status: entered ? .uncertain : .stale)
            } else if case .success(let snapshot) = result, let owner = current.owner {
                switch current.request.operation {
                case .read: answer = .init(status: .snapshot, snapshot: snapshot, owner: owner)
                case .prepare(_, let sha, let index, let disabled):
                    if snapshot.sha256 == sha, snapshot.rows.indices.contains(index), let previous = snapshot.rows[index].disabled {
                        if previous == disabled { answer = .init(status: .unchanged, snapshot: snapshot, owner: owner) }
                        else {
                            let nonce = UUID().uuidString.lowercased()
                            plan = .init(requestId: current.request.id, nonce: nonce, deadline: current.deadline,
                                owner: owner, snapshot: snapshot,
                                mutation: .init(index: index, disabled: disabled, expectedRulesSHA256: snapshot.sha256))
                            answer = .init(status: .prepared, prepared: ["nonce": nonce, "operationId": current.request.id,
                                "leaseMilliseconds": Int((current.deadline - finishedAt) / 1_000_000),
                                "configurationRevision": owner.configurationRevision, "rulesSHA256": snapshot.sha256,
                                "index": index, "disabled": disabled])
                        }
                    } else { answer = .init(status: .stale) }
                case .commit:
                    if entered, snapshot.sha256 == current.expected?.sha256 {
                        answer = .init(status: .changed, snapshot: snapshot, owner: owner)
                    }
                case .cancel: break
                }
            }
            answer.deadline = current.deadline
            current.access?.finish(); work = nil; lock.unlock(); current.reply(answer)
        }
    }

    final class Channel {
        typealias Execute = (@escaping () -> Void) -> Void
        private let input: Int32, output: Int32, binding: Binding, controller: Controller
        private let execute: Execute
        private let clientSHA256: String, installationRevision: String
        private let queue = DispatchQueue(label: "local.relay.tun.runtime-rules.pipe")
        private let source: DispatchSourceRead
        private var buffer = Data(), started = false, closed = false
        private var pending: Int?, timer: DispatchSourceTimer?, lastID = 0
        /// Only a positively pinned future launch argv may instantiate FD5/6.
        init?(binding: Binding, clientSHA256: String, installationRevision: String, driver: Driver,
              input: Int32 = 5, output: Int32 = 6, execute: @escaping Execute = { $0() }) {
            guard hash(clientSHA256), hash(installationRevision), input >= 3, output >= 3, input != output else { return nil }
            for fd in [input, output] {
                let flags = fcntl(fd, F_GETFD)
                guard flags >= 0, fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0 else { return nil }
            }
            var readInfo = stat(), writeInfo = stat()
            func pipeOrSocket(_ value: stat) -> Bool {
                [mode_t(S_IFIFO), mode_t(S_IFSOCK)].contains(value.st_mode & mode_t(S_IFMT))
            }
            guard fstat(input, &readInfo) == 0, fstat(output, &writeInfo) == 0,
                  pipeOrSocket(readInfo), pipeOrSocket(writeInfo), fcntl(output, F_SETNOSIGPIPE, 1) == 0 else { return nil }
            for fd in [input, output] {
                let flags = fcntl(fd, F_GETFL)
                guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { return nil }
            }
            self.input = input; self.output = output; self.binding = binding
            self.execute = execute
            self.clientSHA256 = clientSHA256; self.installationRevision = installationRevision
            controller = Controller(binding: binding, driver: driver)
            source = DispatchSource.makeReadSource(fileDescriptor: input, queue: queue)
            source.setCancelHandler { [input, output] in Darwin.close(input); Darwin.close(output) }
        }
        deinit { controller.close(); source.cancel(); if !started { source.resume() } }
        func start() {
            guard !started else { return }; started = true
            source.setEventHandler { [weak self] in self?.read() }
            queue.async { [self] in
                var hello = binding.json; hello["version"] = 1; hello["kind"] = "hello"
                hello["capability"] = "runtime-rules-v1"; hello["launchClientSHA256"] = clientSHA256
                hello["installationRevision"] = installationRevision
                do { try send(hello, deadline: RelayTunRuntimeRules.now + duration) }
                catch { close() }
            }
            source.resume()
        }
        /// Lifecycle may revoke this capability immediately without waiting
        /// for its pipe queue or the session's currently running bounded IO.
        func invalidate() {
            controller.close()
            queue.async { [weak self] in self?.close() }
        }
        private func close() {
            guard !closed else { return }; closed = true; controller.close()
            pending = nil; timer?.cancel(); timer = nil; buffer.removeAll(); source.cancel()
        }
        private func send(_ value: [String: Any], deadline: UInt64) throws {
            var bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
            guard bytes.count <= responseLimit else { throw Failure.invalid }; bytes.append(10)
            try bytes.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    guard RelayTunRuntimeRules.now < deadline else { throw Failure.expired }
                    let count = Darwin.write(output, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if count > 0 { offset += count; continue }
                    if count < 0, errno == EINTR { continue }
                    guard count < 0, errno == EAGAIN || errno == EWOULDBLOCK else { throw Failure.unavailable }
                    var item = pollfd(fd: output, events: Int16(POLLOUT), revents: 0)
                    guard poll(&item, 1, 10) >= 0 || errno == EINTR,
                          item.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0 else { throw Failure.unavailable }
                }
            }
        }
        private func read() {
            var bytes = [UInt8](repeating: 0, count: 1024)
            while !closed {
                let count = Darwin.read(input, &bytes, bytes.count)
                if count < 0, errno == EINTR { continue }
                if count < 0, errno == EAGAIN || errno == EWOULDBLOCK { return }
                guard count > 0 else { close(); return }
                for byte in bytes.prefix(count) {
                    if byte == 10 {
                        do {
                            let request = try Request.decode(buffer, binding: binding)
                            guard request.id > lastID else { throw Failure.invalid }; lastID = request.id
                            buffer.removeAll(keepingCapacity: true); accept(request)
                            if closed { return }
                        }
                        catch { close(); return }
                    } else {
                        guard buffer.count < requestLimit else { close(); return }; buffer.append(byte)
                    }
                }
            }
        }
        private func accept(_ request: Request) {
            if case .cancel = request.operation {
                // Cancel is an IO-free lock/latch fast path. Enqueueing it
                // behind session IO would let a revoked operation enter write.
                controller.perform(request) { [weak self] reply in self?.queue.async { [weak self] in self?.deliver(request, reply: reply) } }
                return
            }
            // Valid overlap gets a bounded busy response; it cannot replace the
            // actual pending operation or its original timeout reservation.
            if pending != nil {
                deliver(request, reply: .init(status: .busy, pending: true)); return
            }
            pending = request.id
            let deadline = RelayTunRuntimeRules.now + duration
            let timer = DispatchSource.makeTimerSource(queue: queue); self.timer = timer
            timer.schedule(deadline: .init(uptimeNanoseconds: deadline))
            timer.setEventHandler { [weak self] in self?.close() }; timer.resume()
            execute { [weak self] in
                guard let self else { return }
                self.controller.perform(request) { [weak self] reply in
                    self?.queue.async { [weak self] in
                        guard let self, !self.closed, self.pending == request.id else { return }
                        self.pending = nil; self.timer?.cancel(); self.timer = nil
                        self.deliver(request, reply: reply, deadline: min(deadline, reply.deadline ?? deadline))
                    }
                }
            }
        }
        private func deliver(_ request: Request, reply: Reply, deadline: UInt64? = nil) {
            guard !closed else { return }
            var value = binding.json; value["version"] = 1; value["id"] = request.id
            let action: String
            switch request.operation { case .read: action = "read"; case .prepare: action = "prepare"; case .commit: action = "commit"; case .cancel: action = "cancel" }
            value["action"] = action; for (key, entry) in reply.json { value[key] = entry }
            do { try send(value, deadline: deadline ?? (RelayTunRuntimeRules.now + duration)) }
            catch { close() }
        }
    }
}
