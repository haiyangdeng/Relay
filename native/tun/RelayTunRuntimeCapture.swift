import Foundation
import Darwin

/// A separate, optional read capability. Its failures never enter the control
/// channel or invoke recovery. Only the explicitly versioned new launch opts in.
enum RelayTunRuntimeCapture {
    static let limit = 8192
    static let historyLimit = 768 * 1024
    static let bodyLimit = 512 * 1024
    static let duration: UInt64 = 3_000_000_000
    static var now: UInt64 { DispatchTime.now().uptimeNanoseconds }
    enum Failure: Error { case unsupported, unavailable, deadline }
    struct Snapshot {
        struct Port {
            let kind: String
            let port: Int
            var json: [String: Any] { ["kind": kind, "port": port, "ownership": "held-child-pcb-v1"] }
        }
        let originalLoadedSHA256: String
        let originalLoadedBytes: Int
        let mode: String
        let ports: [Port]
        var json: [String: Any] {
            ["originalLoadedSHA256": originalLoadedSHA256, "originalLoadedBytes": originalLoadedBytes,
             "mode": mode, "ports": ports.map { $0.json }]
        }
    }
    // Fixed /connections DTO. No arbitrary path, process arguments or full core
    // metadata crosses the optional history lane.
    static func connectionsSnapshot(_ data: Data) throws -> Data {
        let raw = try RelayTunStrictJSON.object(data, limit: bodyLimit)
        func integer(_ value: Any?) throws -> Int {
            guard let result = RelayTunStrictJSON.integer(value), result >= 0,
                  result <= 9_007_199_254_740_991 else { throw Failure.unavailable }
            return result
        }
        func text(_ value: Any?, required: Bool = false) throws -> String? {
            guard let value else { if required { throw Failure.unavailable }; return nil }
            guard let result = value as? String, result.utf8.count <= 4096, result.count <= 1024,
                  !result.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  !required || !result.isEmpty else { throw Failure.unavailable }
            return result
        }
        guard let rows = raw["connections"] as? [[String: Any]], rows.count <= 10000 else { throw Failure.unavailable }
        var connections = [[String: Any]]()
        for row in rows {
            guard let metadata = row["metadata"] as? [String: Any],
                  let id = try text(row["id"], required: true),
                  let start = try text(row["start"], required: true) else { throw Failure.unavailable }
            var fields = [String: Any]()
            for name in ["sourceIP", "host", "destinationIP", "process"] {
                if let value = try text(metadata[name]) { fields[name] = value }
            }
            var value: [String: Any] = ["id": id, "start": start, "upload": try integer(row["upload"]),
                                        "download": try integer(row["download"]), "metadata": fields]
            if let chains = row["chains"] {
                guard let items = chains as? [String], items.count <= 64 else { throw Failure.unavailable }
                value["chains"] = try items.map { item -> String in
                    guard let checked = try text(item, required: true) else { throw Failure.unavailable }; return checked
                }
            }
            connections.append(value)
        }
        let result: [String: Any] = ["connections": connections, "uploadTotal": try integer(raw["uploadTotal"]),
                                     "downloadTotal": try integer(raw["downloadTotal"])]
        let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .withoutEscapingSlashes])
        guard encoded.count <= bodyLimit else { throw Failure.unsupported }; return encoded
    }
    enum Result {
        case captured(Snapshot), busy, unsupported, unavailable
        var status: String {
            switch self {
            case .captured: return "captured"
            case .busy: return "busy"
            case .unsupported: return "unsupported"
            case .unavailable: return "unavailable"
            }
        }
    }
    enum TrafficResult {
        case sampled(Data), busy, unsupported, unavailable
        var status: String {
            switch self {
            case .sampled: return "sampled"
            case .busy: return "busy"
            case .unsupported: return "unsupported"
            case .unavailable: return "unavailable"
            }
        }
    }
    /// Created once at request admission. Cancellation and either clock fault
    /// permanently retire this read; a worker never renews the original budget.
    final class TrafficContext {
        private let lock = NSLock()
        private let wall: () -> Double, tick: () -> UInt64
        private let beganWall: Double
        private var lastWall: Double, lastTick: UInt64
        private var cancelled = false, ownerRetired = false
        private var ownerCheck: (() throws -> Void)?
        private var publicationCheck: ((() throws -> Void) throws -> Void)?
        private var publicationStarted = false
        let deadline: UInt64
        init(wall: @escaping () -> Double = { Date().timeIntervalSince1970 },
             tick: @escaping () -> UInt64 = { RelayTunRuntimeCapture.now }) {
            self.wall = wall; self.tick = tick
            let began = wall(), now = tick()
            beganWall = began; lastWall = began; lastTick = now
            deadline = min(now, UInt64.max - RelayTunRuntimeCapture.duration) + RelayTunRuntimeCapture.duration
        }
        func bindOwner(_ check: @escaping () throws -> Void) throws {
            lock.lock()
            guard !cancelled, !ownerRetired, ownerCheck == nil else { lock.unlock(); throw Failure.unavailable }
            ownerCheck = check; lock.unlock(); try self.check()
        }
        func bindPublication(_ check: @escaping (() throws -> Void) throws -> Void) throws {
            lock.lock(); defer { lock.unlock() }
            guard !cancelled, !ownerRetired, publicationCheck == nil, !publicationStarted else { throw Failure.unavailable }
            publicationCheck = check
        }
        private func clocksLocked() throws {
            let currentWall = wall(), currentTick = tick()
            guard !cancelled, beganWall.isFinite, currentWall.isFinite,
                  currentWall >= lastWall, currentWall - beganWall < 3,
                  currentTick >= lastTick, currentTick < deadline else {
                cancelled = true; throw Failure.deadline
            }
            lastWall = currentWall; lastTick = currentTick
        }
        /// A retired owner may still receive an unavailable record before any
        /// output bytes. Its original transport clocks must remain valid.
        func checkTransport() throws {
            lock.lock(); defer { lock.unlock() }; try clocksLocked()
        }
        var readWasRetired: Bool {
            lock.lock(); defer { lock.unlock() }; return ownerRetired && !cancelled
        }
        func check() throws {
            lock.lock(); defer { lock.unlock() }
            try clocksLocked()
            guard !ownerRetired else { throw Failure.unavailable }
            do { try ownerCheck?() }
            catch { ownerRetired = true; throw Failure.unavailable }
            try clocksLocked()
        }
        /// Full installation/asset digests occur once here, never once per
        /// poll or partial pipe write. The cheap owner/clock fence brackets it.
        func checkPublication() throws {
            try check(); lock.lock()
            guard !cancelled, !ownerRetired, !publicationStarted, let full = publicationCheck else {
                ownerRetired = true; lock.unlock(); throw Failure.unavailable
            }
            publicationStarted = true; lock.unlock()
            do { try full(self.check); try check() }
            catch { lock.lock(); ownerRetired = true; lock.unlock(); throw error }
        }
        func cancel() {
            lock.lock(); cancelled = true; ownerCheck = nil; publicationCheck = nil; lock.unlock()
        }
    }
    /// This session has one active read authority. A stop received before a
    /// queued mint permanently closes admission, even before phase changes.
    final class TrafficAuthority {
        private let lock = NSLock()
        private var stamp = UUID()
        private var revoked = false
        private var mutations = Set<UUID>()
        func begin() throws -> UUID {
            lock.lock(); defer { lock.unlock() }
            guard !revoked, mutations.isEmpty else { throw Failure.unavailable }; return stamp
        }
        func check(_ value: UUID) throws {
            lock.lock(); defer { lock.unlock() }
            guard !revoked, mutations.isEmpty, value == stamp else { throw Failure.unavailable }
        }
        func rotate() { lock.lock(); if !revoked { stamp = UUID() }; lock.unlock() }
        func beginMutation() -> UUID {
            lock.lock(); defer { lock.unlock() }
            let ticket = UUID(); mutations.insert(ticket); stamp = UUID(); return ticket
        }
        func finishMutation(_ ticket: UUID) {
            lock.lock(); defer { lock.unlock() }
            guard mutations.remove(ticket) != nil else { return }; stamp = UUID()
        }
        func revoke() { lock.lock(); revoked = true; lock.unlock() }
    }
    static func check(_ deadline: UInt64) throws {
        guard now < deadline else { throw Failure.deadline }
    }

    final class Channel {
        typealias Capture = (UInt64, @escaping (Result) -> Void) -> Void
        typealias Traffic = (TrafficContext, @escaping (TrafficResult) -> Void) -> Void
        let telemetryEnabled: Bool
        let historyEnabled: Bool
        private var version: Int { historyEnabled ? 3 : telemetryEnabled ? 2 : 1 }
        private let input: Int32, output: Int32
        private let queue = DispatchQueue(label: "local.relay.tun.runtime-capture.read")
        private let source: DispatchSourceRead
        private var buffer = Data()
        private var closed = false
        private var started = false
        private var lastID = 0
        private var pending: Int?
        private var pendingAction: String?
        private var pendingContext: TrafficContext?
        private var timer: DispatchSourceTimer?
        private var binding: [String: Any] = [:]
        private var capture: Capture?
        private var traffic: Traffic?
        private var connections: Traffic?

        /// The caller must gate this on --managed-session-runtime-capture-v1.
        /// Set CLOEXEC immediately, before any core could be spawned. Per-FD
        /// SIGPIPE suppression also makes a lost read peer harmless to control.
        init?(input: Int32 = 3, output: Int32 = 4, telemetry: Bool = false, history: Bool = false) {
            guard input >= 3, output >= 3, input != output else { return nil }
            for fd in [input, output] {
                let flags = fcntl(fd, F_GETFD)
                guard flags >= 0, fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0 else { return nil }
            }
            var readInfo = stat(), writeInfo = stat()
            func pipeOrSocket(_ info: stat) -> Bool {
                let type = info.st_mode & mode_t(S_IFMT)
                return type == mode_t(S_IFIFO) || type == mode_t(S_IFSOCK)
            }
            guard fstat(input, &readInfo) == 0, fstat(output, &writeInfo) == 0,
                  pipeOrSocket(readInfo), pipeOrSocket(writeInfo),
                  fcntl(output, F_SETNOSIGPIPE, 1) == 0 else { return nil }
            for fd in [input, output] {
                let flags = fcntl(fd, F_GETFL)
                guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { return nil }
            }
            self.input = input; self.output = output; telemetryEnabled = telemetry || history; historyEnabled = history
            source = DispatchSource.makeReadSource(fileDescriptor: input, queue: queue)
            source.setCancelHandler { [input, output] in Darwin.close(input); Darwin.close(output) }
        }
        deinit { source.cancel(); if !started { source.resume() } }
        func start(binding: [String: Any], clientSHA256: String, installationRevision: String,
                   traffic: Traffic? = nil, connections: Traffic? = nil, capture: @escaping Capture) {
            guard !started else { return }; started = true
            self.binding = binding; self.capture = capture; self.traffic = telemetryEnabled ? traffic : nil
            self.connections = historyEnabled ? connections : nil
            source.setEventHandler { [weak self] in self?.read() }
            queue.async { [self] in
                var hello = binding
                hello["version"] = version; hello["kind"] = "hello"
                hello["capability"] = historyEnabled ? "runtime-history-v3" : telemetryEnabled ? "runtime-telemetry-v2" : "runtime-capture-v1"
                hello["launchClientSHA256"] = clientSHA256; hello["installationRevision"] = installationRevision
                do { try send(hello, deadline: RelayTunRuntimeCapture.now + RelayTunRuntimeCapture.duration) }
                catch { close() }
            }
            source.resume()
        }
        private func close() {
            guard !closed else { return }; closed = true
            pendingContext?.cancel(); pendingContext = nil; pendingAction = nil
            pending = nil; capture = nil; traffic = nil; connections = nil; buffer.removeAll(); timer?.cancel(); timer = nil
            source.cancel()
        }
        func invalidate() { queue.async { [weak self] in self?.close() } }
        private func send(_ value: [String: Any], deadline: UInt64, check: () throws -> Void = {}, didWrite: () -> Void = {}) throws {
            var bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
            guard bytes.count <= (historyEnabled ? RelayTunRuntimeCapture.historyLimit : RelayTunRuntimeCapture.limit) else { throw Failure.unsupported }; bytes.append(10)
            try bytes.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    try check(); try RelayTunRuntimeCapture.check(deadline)
                    let count = Darwin.write(output, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if count > 0 { didWrite(); offset += count; continue }
                    if count < 0, errno == EINTR { continue }
                    guard count < 0, errno == EAGAIN || errno == EWOULDBLOCK else { throw Failure.unavailable }
                    var item = pollfd(fd: output, events: Int16(POLLOUT), revents: 0)
                    let result = poll(&item, 1, 10)
                    try check(); try RelayTunRuntimeCapture.check(deadline)
                    guard result >= 0 || errno == EINTR else { throw Failure.unavailable }
                    guard item.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0 else { throw Failure.unavailable }
                }
            }
            try check(); try RelayTunRuntimeCapture.check(deadline)
        }
        private func read() {
            guard !closed else { return }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while true {
                let count = Darwin.read(input, &bytes, bytes.count)
                if count < 0, errno == EINTR { continue }
                if count < 0, errno == EAGAIN || errno == EWOULDBLOCK { return }
                guard count > 0 else { close(); return }
                for byte in bytes.prefix(count) {
                    if byte == 10 {
                        do { try accept(buffer); buffer.removeAll(keepingCapacity: true) }
                        catch { close(); return }
                    } else {
                        guard buffer.count < RelayTunRuntimeCapture.limit else { close(); return }
                        buffer.append(byte)
                    }
                }
            }
        }
        private func accept(_ bytes: Data) throws {
            let raw = try RelayTunStrictJSON.object(bytes, limit: RelayTunRuntimeCapture.limit)
            guard Set(raw.keys) == ["version", "id", "action", "sessionId", "evidenceSHA256", "runtimeConfigurationSHA256"],
                  RelayTunStrictJSON.integer(raw["version"]) == version,
                  let id = RelayTunStrictJSON.integer(raw["id"]), id > lastID, id <= Int(Int32.max),
                  let action = raw["action"] as? String,
                  (action == "capture" || (telemetryEnabled && action == "traffic" && traffic != nil) ||
                   (historyEnabled && action == "connections" && connections != nil)), pending == nil,
                  raw["sessionId"] as? String == binding["sessionId"] as? String,
                  raw["evidenceSHA256"] as? String == binding["evidenceSHA256"] as? String,
                  raw["runtimeConfigurationSHA256"] as? String == binding["runtimeConfigurationSHA256"] as? String,
                  let capture else { throw Failure.unavailable }
            lastID = id; pending = id; pendingAction = action
            let context = action == "capture" ? nil : TrafficContext()
            pendingContext = context
            let deadline = context?.deadline ?? (RelayTunRuntimeCapture.now + RelayTunRuntimeCapture.duration)
            let timer = DispatchSource.makeTimerSource(queue: queue); self.timer = timer
            timer.schedule(deadline: .init(uptimeNanoseconds: deadline))
            timer.setEventHandler { [weak self] in
                if action != "capture" { self?.finishTraffic(id: id, action: action, result: .unavailable, deadline: deadline) }
                else { self?.finish(id: id, result: .unavailable, deadline: deadline) }
            }
            timer.resume()
            if let context, let read = (action == "connections" ? connections : traffic) {
                try context.check()
                read(context) { [weak self] result in
                    self?.queue.async { [weak self] in self?.finishTraffic(id: id, action: action, result: result, deadline: deadline) }
                }
            } else {
                capture(deadline) { [weak self] result in
                    self?.queue.async { [weak self] in self?.finish(id: id, result: result, deadline: deadline) }
                }
            }
        }
        private func finishTraffic(id: Int, action: String, result: TrafficResult, deadline: UInt64) {
            guard !closed, pending == id, pendingAction == action, let context = pendingContext else { return }
            defer { context.cancel() }
            pending = nil; pendingAction = nil; pendingContext = nil; timer?.cancel(); timer = nil
            var wrote = false
            func value(_ status: String) -> [String: Any] {
                var value = binding
                value["version"] = version; value["id"] = id; value["action"] = action; value["status"] = status
                return value
            }
            do {
                try context.check()
                var response = value(result.status)
                if case .sampled(let raw) = result {
                    if action == "connections" {
                        guard historyEnabled, !raw.isEmpty, raw.count <= RelayTunRuntimeCapture.bodyLimit else { throw Failure.unavailable }
                        response["status"] = "connections"
                        response["rawConnectionsBase64"] = raw.base64EncodedString()
                    } else {
                        guard !raw.isEmpty, raw.count <= 4096, raw.last == 10,
                              !raw.dropLast().contains(10) else { throw Failure.unavailable }
                        response["rawFrameBase64"] = raw.base64EncodedString()
                    }
                    try context.checkPublication()
                }
                try send(response, deadline: deadline, check: context.check, didWrite: { wrote = true })
            } catch {
                // A normal source/epoch rotation retires only this read. No
                // replacement record is safe after a partial pipe write.
                guard !wrote, context.readWasRetired else { close(); return }
                do { try send(value("unavailable"), deadline: deadline, check: context.checkTransport) }
                catch { close() }
            }
        }
        private func finish(id: Int, result: Result, deadline: UInt64) {
            guard !closed, pending == id, pendingAction == "capture" else { return }
            pending = nil; pendingAction = nil; timer?.cancel(); timer = nil
            guard RelayTunRuntimeCapture.now < deadline else { close(); return }
            var value = binding
            value["version"] = version; value["id"] = id; value["action"] = "capture"; value["status"] = result.status
            if case .captured(let snapshot) = result { value["snapshot"] = snapshot.json }
            do { try send(value, deadline: deadline) } catch { close() }
        }
    }
}
