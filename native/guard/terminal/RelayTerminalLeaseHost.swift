import Darwin
import Foundation

@objc(RelayTerminalLeaseHostBridge)
public final class RelayTerminalLeaseHostBridge: NSObject {
    private static let host = RelayTerminalLeaseHost()

    @objc(request:completion:)
    public static func request(_ text: NSString, completion: @escaping (NSString) -> Void) {
        host.request(Data((text as String).utf8), completion: completion)
    }

    @objc(invalidate)
    public static func invalidate() { host.invalidate() }
}

/// One authenticated launcher connection. Only the serial queue owns its
/// phases, pending Main waiter, exact event ID and descriptor sources.
private final class RelayTerminalLeaseHost: @unchecked Sendable {
    private final class Reply: @unchecked Sendable {
        let completion: (NSString) -> Void
        init(_ completion: @escaping (NSString) -> Void) { self.completion = completion }
        func send(_ action: String, error: RelayTerminalLeaseFailure? = nil, event: Event? = nil) {
            var result: [String: Any] = ["version": 1, "action": action, "ok": error == nil]
            if let error { result["reason"] = error.rawValue }
            if let event { result["event"] = ["kind": event.kind, "id": event.id] }
            let encoded = (try? RelayTerminalLeaseWire.encode(result)).flatMap { String(data: $0, encoding: .utf8) }
            completion((encoded ?? "{\"version\":1,\"action\":\"invalid\",\"ok\":false,\"reason\":\"invalid\"}") as NSString)
        }
    }
    private struct Event {
        let kind: String
        let id: String
    }
    private final class Session: @unchecked Sendable {
        enum Phase { case acquiring, requested, granted, committing, committed }
        let fd: Int32
        let token: Data
        let source: DispatchSourceRead
        var phase: Phase = .acquiring
        var bytes = Data()
        var id: String?
        var deadline: UInt64 = 0
        init(fd: Int32, token: Data, queue: DispatchQueue) {
            self.fd = fd; self.token = token
            source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setCancelHandler { Darwin.close(fd) }
        }
    }

    private let queue = DispatchQueue(label: "local.relay.guard.terminal.lease")
    private var publication: RelayTerminalLeaseEndpoint.Publication?
    private var listener: DispatchSourceRead?
    private var identity: RelayTerminalLeaseIdentity?
    private var session: Session?
    private var events: [Event] = []
    private var waiter: Reply?

    func request(_ data: Data, completion: @escaping (NSString) -> Void) {
        let reply = Reply(completion)
        queue.async { [self, reply] in dispatch(data, reply: reply) }
    }
    // Called only by the Node environment cleanup hook. Finish queued native
    // producers before the hook returns and Node can dispose its TSFNs.
    func invalidate() { queue.sync { stop() } }

    private func dispatch(_ data: Data, reply: Reply) {
        var action = "invalid"
        do {
            let request = try RelayTerminalLeaseWire.object(data)
            let fields: Set<String> = ["version", "action"]
            guard let name = request["action"] as? String,
                  ["start", "next", "respond", "confirm", "close", "stop"].contains(name) else {
                throw RelayTerminalLeaseFailure.invalid
            }
            action = name
            let keys: Set<String>
            switch action {
            case "respond": keys = fields.union(["id", "grant"])
            case "confirm": keys = fields.union(["id", "allow"])
            case "close": keys = fields.union(["id"])
            default: keys = fields
            }
            guard Set(request.keys) == keys else { throw RelayTerminalLeaseFailure.invalid }
            switch action {
            case "start":
                try start()
            case "next":
                guard listener != nil else { throw RelayTerminalLeaseFailure.unavailable }
                guard waiter == nil else { throw RelayTerminalLeaseFailure.busy }
                if events.isEmpty { waiter = reply }
                else { reply.send(action, event: events.removeFirst()) }
                return
            case "respond":
                let id = try RelayTerminalLeaseWire.id(request["id"])
                let current = try matching(id, phase: .requested)
                if request["grant"] is NSNull { retire(current) }
                else {
                    guard let raw = request["grant"] as? [String: Any] else { throw RelayTerminalLeaseFailure.invalid }
                    let grant = try RelayTerminalLeaseGrant(raw)
                    try send(current, bytes: RelayTerminalLeaseWire.response("grant", id: id, grant: grant))
                    current.phase = .granted
                    arm(current, budget: 20_000_000_000)
                }
            case "confirm":
                let id = try RelayTerminalLeaseWire.id(request["id"])
                let current = try matching(id, phase: .committing)
                guard let allow = request["allow"] as? NSNumber,
                      CFGetTypeID(allow) == CFBooleanGetTypeID() else { throw RelayTerminalLeaseFailure.invalid }
                if allow.boolValue {
                    try send(current, bytes: RelayTerminalLeaseWire.response("committed", id: id))
                    current.phase = .committed; current.deadline = 0
                } else { retire(current) }
            case "close":
                let id = try RelayTerminalLeaseWire.id(request["id"])
                if let current = session, current.id == id { retire(current) }
            case "stop":
                stop()
            default:
                throw RelayTerminalLeaseFailure.invalid
            }
            reply.send(action)
        } catch { reply.send(action, error: error as? RelayTerminalLeaseFailure ?? .transport) }
    }

    private func start() throws {
        if listener != nil { return }
        let identity = try RelayTerminalLeaseIdentity.local(.main)
        let endpoint = try RelayTerminalLeaseEndpoint(create: true)
        let publication = try endpoint.publish()
        let descriptor = publication.listener
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in self?.accept(descriptor) }
        source.setCancelHandler { Darwin.close(descriptor) }
        self.identity = identity
        self.publication = publication
        listener = source
        source.resume()
    }

    private func stop() {
        if let session { retire(session, notify: false) }
        let waiting = waiter; waiter = nil
        events.removeAll()
        let source = listener; listener = nil
        source?.cancel()
        publication = nil
        identity = nil
        waiting?.send("next", error: .unavailable)
    }

    private func accept(_ descriptor: Int32) {
        guard publication?.listener == descriptor, let identity else { return }
        // Bound the amount of accept/close work in one event turn.
        for _ in 0..<4 {
            let peer = Darwin.accept(descriptor, nil, nil)
            guard peer >= 0 else {
                if errno == EINTR { continue }
                return
            }
            do {
                try RelayTerminalLeaseSocket.configure(peer)
                guard session == nil, events.isEmpty else { throw RelayTerminalLeaseFailure.busy }
                let token = try identity.peer(peer, role: .launcher)
                let current = Session(fd: peer, token: token, queue: queue)
                current.source.setEventHandler { [weak self, weak current] in
                    guard let self, let current else { return }
                    self.receive(current)
                }
                session = current
                arm(current, budget: RelayTerminalLeaseWire.acquisitionBudget)
                current.source.resume()
            } catch { Darwin.close(peer) }
        }
    }

    private func arm(_ current: Session, budget: UInt64) {
        let deadline = DispatchTime.now().uptimeNanoseconds + budget
        current.deadline = deadline
        queue.asyncAfter(deadline: DispatchTime(uptimeNanoseconds: deadline)) { [weak self, weak current] in
            guard let self, let current, self.session === current, current.deadline == deadline else { return }
            self.retire(current)
        }
    }

    private func receive(_ current: Session) {
        guard session === current else { return }
        var buffer = [UInt8](repeating: 0, count: RelayTerminalLeaseWire.commandLimit + 1)
        let count = buffer.withUnsafeMutableBytes { Darwin.read(current.fd, $0.baseAddress, $0.count) }
        if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { return }
        guard count > 0, current.phase == .acquiring || current.phase == .granted,
              current.bytes.count + count <= RelayTerminalLeaseWire.commandLimit + 1 else { retire(current); return }
        current.bytes.append(contentsOf: buffer.prefix(count))
        guard let end = current.bytes.firstIndex(of: 10) else { return }
        guard end == current.bytes.count - 1, DispatchTime.now().uptimeNanoseconds < current.deadline,
              let identity else { retire(current); return }
        do {
            _ = try identity.peer(current.fd, role: .launcher, expected: current.token)
            let acquiring = current.phase == .acquiring
            let id = try RelayTerminalLeaseWire.readCommand(current.bytes.prefix(end), action: acquiring ? "acquire" : "commit")
            current.bytes.removeAll()
            if acquiring {
                current.id = id; current.phase = .requested
                emit(.init(kind: "request", id: id))
            } else {
                guard current.id == id else { throw RelayTerminalLeaseFailure.stale }
                current.phase = .committing
                arm(current, budget: RelayTerminalLeaseWire.acquisitionBudget)
                emit(.init(kind: "commit", id: id))
            }
        } catch { retire(current) }
    }

    private func matching(_ id: String, phase: Session.Phase) throws -> Session {
        guard let current = session, current.id == id, current.phase == phase else {
            throw RelayTerminalLeaseFailure.stale
        }
        guard DispatchTime.now().uptimeNanoseconds < current.deadline else {
            retire(current); throw RelayTerminalLeaseFailure.deadline
        }
        return current
    }

    private func send(_ current: Session, bytes: Data) throws {
        do {
            guard let identity else { throw RelayTerminalLeaseFailure.unavailable }
            _ = try identity.peer(current.fd, role: .launcher, expected: current.token)
            let deadline = min(current.deadline, DispatchTime.now().uptimeNanoseconds + 1_000_000_000)
            try RelayTerminalLeaseSocket.write(bytes, to: current.fd, deadline: deadline)
        } catch { retire(current); throw error }
    }

    private func emit(_ event: Event) {
        if let waiting = waiter {
            waiter = nil
            waiting.send("next", event: event)
        } else { events.append(event) }
    }

    private func retire(_ current: Session, notify: Bool = true) {
        guard session === current else { return }
        session = nil
        _ = shutdown(current.fd, SHUT_RDWR)
        current.source.cancel()
        if notify, let id = current.id { emit(.init(kind: "closed", id: id)) }
    }
}
