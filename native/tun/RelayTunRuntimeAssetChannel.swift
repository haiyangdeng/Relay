import Foundation
import Darwin

/// One bounded inherited-pipe engine for Geo and rule-provider assets. Only the
/// supplied descriptors are closed; failure never enters control or recovery.
enum RelayTunRuntimeAssetScope {
    enum Failure: Error { case invalid, unavailable, unsupported, uncertain, cancelled, expired }
    struct Binding: Equatable {
        let sessionId: String, evidenceSHA256: String, runtimeConfigurationSHA256: String
        init(_ raw: [String: Any]) throws {
            guard Set(raw.keys) == ["sessionId", "evidenceSHA256", "runtimeConfigurationSHA256"],
                  let session = raw["sessionId"] as? String, RelayTunRuntimeResources.uuid(session),
                  let evidence = raw["evidenceSHA256"] as? String, RelayTunRuntimeResources.hash(evidence),
                  let config = raw["runtimeConfigurationSHA256"] as? String, RelayTunRuntimeResources.hash(config) else { throw Failure.invalid }
            sessionId = session; evidenceSHA256 = evidence; runtimeConfigurationSHA256 = config
        }
        var json: [String: Any] {
            ["sessionId": sessionId, "evidenceSHA256": evidenceSHA256, "runtimeConfigurationSHA256": runtimeConfigurationSHA256]
        }
    }
    fileprivate final class Scope {
        private let lock = NSLock(); private var live = true
        func revoke() { lock.lock(); live = false; lock.unlock() }
        var isLive: Bool { lock.lock(); defer { lock.unlock() }; return live }
    }
    final class Context {
        let deadline: UInt64
        private let lock = NSLock(), scope: Scope
        private var cancelled = false
        fileprivate init(deadline: UInt64, scope: Scope) { self.deadline = deadline; self.scope = scope }
        func check() throws {
            lock.lock(); let valid = !cancelled; lock.unlock()
            guard valid, scope.isLive else { throw Failure.cancelled }
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.expired }
        }
        fileprivate func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    }
    enum Discard: String { case discarded, absent, busy, unavailable }
}

final class RelayTunRuntimeAssetChannel<Replacement, Ticket, Observation> {
    typealias Failure = RelayTunRuntimeAssetScope.Failure
    typealias Binding = RelayTunRuntimeAssetScope.Binding
    typealias Context = RelayTunRuntimeAssetScope.Context
    fileprivate typealias Scope = RelayTunRuntimeAssetScope.Scope
    typealias Discard = RelayTunRuntimeAssetScope.Discard
    static var helloDuration: UInt64 { 3_000_000_000 }
    struct Reply {
        let status: String
        var observation: Observation?
        init(status: String, observation: Observation? = nil) { self.status = status; self.observation = observation }
    }
    struct Codec {
        let capability: String, frameLimit: Int
        let replaceFields: Set<String>, ticketFields: Set<String>
        let replacement: ([String: Any]) throws -> Replacement
        let ticket: ([String: Any]) throws -> Ticket
        let snapshot: (Observation) throws -> [String: Any]
        var readAction = "read", replaceAction = "replace"
        var allowDiscard = true
        var readStatus = "snapshot"
        var replaceSuccessStatuses: Set<String> = ["updated", "unchanged"]
        var uncertainSuccessStatuses: Set<String> = ["updated"]
    }
    struct Driver {
        let read: (Context, @escaping (Result<Observation, Error>) -> Void) -> Void
        let replace: (Int, Replacement, Context, @escaping (Reply) -> Void) -> Void
        let cancelReplace: (Int) -> String
        let discard: (Ticket, Context, @escaping (Result<Discard, Error>) -> Void) -> Void
        let invalidate: () -> Void
    }
    private enum Operation {
        case read, replace(Replacement), cancel(Int), discard(Ticket)
        func action(_ codec: Codec) -> String {
            switch self { case .read: return codec.readAction; case .replace: return codec.replaceAction; case .cancel: return "cancel"; case .discard: return "discardBlob" }
        }
    }
    private struct Request {
        let id: Int, operation: Operation
    }
    private final class Work {
        let request: Request, context: Context
        init(_ request: Request, context: Context) { self.request = request; self.context = context }
    }
    private let input: Int32, output: Int32, binding: Binding, driver: Driver
    private let clientSHA256: String, installationRevision: String, duration: UInt64
    private let codec: Codec
    private let execute: (@escaping () -> Void) -> Void
    private let queue = DispatchQueue(label: "local.relay.tun.runtime-resources.pipe"), scope = Scope()
    private let source: DispatchSourceRead
    private var buffer = Data(), started = false, closed = false, lastID = 0
    private var work: Work?, neutral: Work?, timer: DispatchSourceTimer?
    init?(binding: Binding, clientSHA256: String, installationRevision: String, codec: Codec, driver: Driver,
          input: Int32, output: Int32, leaseSeconds: Int = 30,
          execute: @escaping (@escaping () -> Void) -> Void = { $0() }) {
        guard RelayTunRuntimeResources.hash(clientSHA256), RelayTunRuntimeResources.hash(installationRevision), input >= 3, output >= 3, input != output,
              (1...120).contains(leaseSeconds),
              (codec.capability == "runtime-resources-v1" && codec.frameLimit == 8192) ||
              (codec.capability == "runtime-rule-providers-v1" && codec.frameLimit == 262144) ||
              (codec.capability == "smart-state-v1" && codec.frameLimit == 8192 && codec.readAction == "export" &&
               codec.replaceAction == "ack" && !codec.allowDiscard && codec.readStatus == "exported" && codec.replaceSuccessStatuses == ["acknowledged"]) ||
              (codec.capability == "runtime-smart-tools-v1" && codec.frameLimit == 262144 && codec.readAction == "weights" &&
               codec.replaceAction == "clear-cache" && !codec.allowDiscard && codec.readStatus == "weights" &&
               codec.replaceFields.isEmpty && codec.ticketFields.isEmpty && codec.replaceSuccessStatuses == ["accepted"] &&
               codec.uncertainSuccessStatuses == ["accepted"]) else { return nil }
        for fd in [input, output] {
            let flags = fcntl(fd, F_GETFD)
            guard flags >= 0, fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0 else { return nil }
        }
        var reader = stat(), writer = stat()
        func pipe(_ value: stat) -> Bool { [mode_t(S_IFIFO), mode_t(S_IFSOCK)].contains(value.st_mode & mode_t(S_IFMT)) }
        guard fstat(input, &reader) == 0, fstat(output, &writer) == 0, pipe(reader), pipe(writer),
              fcntl(output, F_SETNOSIGPIPE, 1) == 0 else { return nil }
        for fd in [input, output] {
            let flags = fcntl(fd, F_GETFL)
            guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { return nil }
        }
        self.input = input; self.output = output; self.binding = binding; self.driver = driver; self.codec = codec
        self.clientSHA256 = clientSHA256; self.installationRevision = installationRevision
        self.execute = execute; duration = UInt64(leaseSeconds) * 1_000_000_000
        source = DispatchSource.makeReadSource(fileDescriptor: input, queue: queue)
        source.setCancelHandler { [input, output] in Darwin.close(input); Darwin.close(output) }
    }
    deinit { scope.revoke(); driver.invalidate(); source.cancel(); if !started { source.resume() } }
    /// AppSession starts this only after writing its initialize ACK. It owns
    /// this channel strongly; callbacks retain the session/coordinator weakly.
    func start() {
        guard !started else { return }; started = true
        source.setEventHandler { [weak self] in self?.readFrames() }
        queue.async { [self] in
            var hello = binding.json
            hello["version"] = 1; hello["kind"] = "hello"; hello["capability"] = codec.capability
            hello["launchClientSHA256"] = clientSHA256; hello["installationRevision"] = installationRevision
            do { try send(hello, deadline: DispatchTime.now().uptimeNanoseconds + Self.helloDuration) }
            catch { close() }
        }
        source.resume()
    }
    func invalidate() {
        scope.revoke(); driver.invalidate()
        queue.async { [weak self] in self?.close() }
    }
    private func close() {
        guard !closed else { return }; closed = true
        scope.revoke(); work?.context.cancel(); neutral?.context.cancel(); driver.invalidate()
        work = nil; neutral = nil; timer?.cancel(); timer = nil; buffer.removeAll(); source.cancel()
    }
    private func decode(_ bytes: Data) throws -> Request {
        let raw = try RelayTunStrictJSON.object(bytes, limit: codec.frameLimit)
        let base: Set<String> = ["version", "id", "action", "sessionId", "evidenceSHA256", "runtimeConfigurationSHA256"]
        guard RelayTunStrictJSON.integer(raw["version"]) == 1,
              let id = RelayTunStrictJSON.integer(raw["id"]), id > 0, id <= Int(Int32.max),
              let action = raw["action"] as? String else { throw Failure.invalid }
        let keys = Set(binding.json.keys)
        let supplied = try Binding(Dictionary(uniqueKeysWithValues: keys.map { ($0, raw[$0] ?? NSNull()) }))
        guard supplied == binding else { throw Failure.invalid }
        let operation: Operation
        switch action {
        case codec.readAction:
            guard Set(raw.keys) == base else { throw Failure.invalid }; operation = .read
        case "cancel":
            guard Set(raw.keys) == base.union(["operationId"]),
                  let target = RelayTunStrictJSON.integer(raw["operationId"]), target > 0, target <= Int(Int32.max) else { throw Failure.invalid }
            operation = .cancel(target)
        case codec.replaceAction:
            guard Set(raw.keys) == base.union(codec.replaceFields) else { throw Failure.invalid }
            operation = .replace(try codec.replacement(raw))
        case "discardBlob":
            guard codec.allowDiscard, Set(raw.keys) == base.union(codec.ticketFields) else { throw Failure.invalid }
            operation = .discard(try codec.ticket(raw))
        default: throw Failure.invalid
        }
        return .init(id: id, operation: operation)
    }
    private func readFrames() {
        var bytes = [UInt8](repeating: 0, count: 1024)
        while !closed {
            let count = Darwin.read(input, &bytes, bytes.count)
            if count < 0, errno == EINTR { continue }
            if count < 0, errno == EAGAIN || errno == EWOULDBLOCK { return }
            guard count > 0 else { close(); return }
            for byte in bytes.prefix(count) {
                if byte == 10 {
                    do {
                        let request = try decode(buffer)
                        guard request.id > lastID else { throw Failure.invalid }; lastID = request.id
                        buffer.removeAll(keepingCapacity: true); accept(request)
                        if closed { return }
                    } catch { close(); return }
                } else {
                    guard buffer.count < codec.frameLimit else { close(); return }; buffer.append(byte)
                }
            }
        }
    }
    private func accept(_ request: Request) {
        if case .cancel(let target) = request.operation {
            guard let current = work, current.request.id == target else {
                deliver(request, status: "stale", pending: work != nil); return
            }
            current.context.cancel()
            var status = "cancelling"
            if case .replace = current.request.operation, driver.cancelReplace(target) == "uncertain" { status = "uncertain" }
            deliver(request, status: status, pending: true); return
        }
        if work != nil || neutral != nil {
            if case .discard = request.operation { deliver(request, status: "busy", pending: false) }
            else { deliver(request, status: "busy", pending: true) }
            return
        }
        let time = DispatchTime.now().uptimeNanoseconds
        guard time <= UInt64.max - duration else { deliver(request, status: "unavailable", pending: false); return }
        let current = Work(request, context: .init(deadline: time + duration, scope: scope))
        if case .discard = request.operation { neutral = current } else { work = current }
        let timer = DispatchSource.makeTimerSource(queue: queue); self.timer = timer
        timer.schedule(deadline: .init(uptimeNanoseconds: current.context.deadline))
        timer.setEventHandler { [weak self] in self?.close() }; timer.resume()
        execute { [weak self, current] in
            guard let self else { return }
            do { try current.context.check() }
            catch { complete(current, status: errorStatus(error)); return }
            switch request.operation {
            case .read:
                driver.read(current.context) { [weak self, current] result in
                    guard let self else { return }
                    switch result {
                    case .success(let observation): complete(current, status: codec.readStatus, observation: observation)
                    case .failure(let error): complete(current, status: errorStatus(error))
                    }
                }
            case .replace(let selection):
                driver.replace(request.id, selection, current.context) { [weak self, current] reply in
                    guard let self else { return }
                    complete(current, status: reply.status, observation: reply.observation)
                }
            case .discard(let ticket):
                driver.discard(ticket, current.context) { [weak self, current] result in
                    guard let self else { return }
                    switch result {
                    case .success(let value): complete(current, status: value.rawValue)
                    case .failure: complete(current, status: "unavailable")
                    }
                }
            case .cancel: break
            }
        }
    }
    private func errorStatus(_ error: Error) -> String {
        switch error as? Failure {
        case .cancelled?: return "cancelled"
        case .expired?: return "expired"
        case .uncertain?: return "uncertain"
        case .unsupported?: return "unsupported"
        default: return "unavailable"
        }
    }
    private func complete(_ current: Work, status: String, observation: Observation? = nil) {
        queue.async { [weak self, current] in
            guard let self, !closed, work === current || neutral === current else { return }
            var terminal = status, snapshot: [String: Any]?
            do {
                try current.context.check()
                if let observation {
                    snapshot = try codec.snapshot(observation)
                }
            } catch {
                terminal = codec.uncertainSuccessStatuses.contains(status) || status == "uncertain" ? "uncertain" : errorStatus(error)
                snapshot = nil
            }
            if case .discard = current.request.operation {
                if !["discarded", "absent", "busy"].contains(terminal) { terminal = "unavailable" }
            } else if terminal != codec.readStatus && !codec.replaceSuccessStatuses.contains(terminal) { snapshot = nil }
            else if snapshot == nil { terminal = codec.uncertainSuccessStatuses.contains(terminal) ? "uncertain" : "unavailable" }
            work = nil; neutral = nil; timer?.cancel(); timer = nil
            deliver(current.request, status: terminal, pending: false, snapshot: snapshot,
                    check: snapshot == nil ? {} : current.context.check)
        }
    }
    private func deliver(_ request: Request, status: String, pending: Bool, snapshot: [String: Any]? = nil,
                         check: () throws -> Void = {}) {
        guard !closed else { return }
        var value = binding.json
        value["version"] = 1; value["id"] = request.id; value["action"] = request.operation.action(codec)
        value["status"] = status; value["pending"] = pending
        if let snapshot { value["snapshot"] = snapshot }
        do { try send(value, deadline: DispatchTime.now().uptimeNanoseconds + Self.helloDuration, check: check) }
        catch { close() }
    }
    private func send(_ value: [String: Any], deadline: UInt64, check: () throws -> Void = {}) throws {
        var bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= codec.frameLimit else { throw Failure.invalid }; bytes.append(10)
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                guard scope.isLive, DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.expired }
                try check()
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
}
