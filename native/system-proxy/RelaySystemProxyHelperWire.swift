import Foundation
import Darwin

@objc protocol RelaySystemProxyPrivilegedProtocol {
    func transact(_ data: NSData, withReply reply: @escaping (NSData) -> Void)
}

struct RelaySystemProxyHelperRequest: Codable {
    static let maximumBytes = 2 * 1024 * 1024
    static let connectionWindow: TimeInterval = 60
    static let writeWindow: TimeInterval = 8
    enum Operation: String, Codable { case status, change }
    enum Receiver { case localClient, daemon }
    let version: Int
    let operation: Operation
    let nonce: String
    let deadline: TimeInterval
    let expected: RelaySystemProxyBackend.Snapshot?
    let target: RelaySystemProxyBackend.Snapshot?
    static func make(_ expected: RelaySystemProxyBackend.Snapshot?, _ target: RelaySystemProxyBackend.Snapshot?) -> Self {
        Self(version: 1, operation: expected == nil ? .status : .change, nonce: UUID().uuidString.lowercased(), deadline: ProcessInfo.processInfo.systemUptime + connectionWindow, expected: expected, target: target)
    }
    func validate(now: TimeInterval, receiver: Receiver = .daemon) throws {
        // The local change envelope includes time to establish a connection.
        // Only a read-only handshake may carry that entire budget to the daemon.
        let maximum = receiver == .daemon && operation == .change ? Self.writeWindow : Self.connectionWindow
        guard version == 1, UUID(uuidString: nonce)?.uuidString.lowercased() == nonce,
              now.isFinite, deadline.isFinite, deadline >= now, deadline <= now + maximum else { throw RelaySystemProxyHelperFailure.request }
        switch operation {
        case .status: guard expected == nil, target == nil else { throw RelaySystemProxyHelperFailure.request }
        case .change:
            guard let expected, let target else { throw RelaySystemProxyHelperFailure.request }
            _ = try RelaySystemProxyBackend.canonical(expected)
            _ = try RelaySystemProxyBackend.canonical(target)
            _ = try RelaySystemProxyBackend.changedServiceIDs(expected, target)
        }
    }
    static func parse(_ data: Data, now: TimeInterval, receiver: Receiver = .daemon) throws -> Self {
        guard !data.isEmpty, data.count <= maximumBytes else { throw RelaySystemProxyHelperFailure.request }
        let value = try JSONDecoder().decode(Self.self, from: data)
        do { try value.validate(now: now, receiver: receiver) }
        catch { throw receiver == .localClient ? value.failureBeforeWrite(error) : error }
        return value
    }
    func failureBeforeWrite(_ error: Error) -> Error {
        guard operation == .change, UUID(uuidString: nonce)?.uuidString.lowercased() == nonce else { return error }
        return RelaySystemProxyHelperClient.NotSubmitted(nonce: nonce)
    }
}

struct RelaySystemProxyHelperReply: Codable {
    let version: Int
    let nonce: String
    let revision: String
    let clientUID: UInt32
    let result: RelaySystemProxyBackend.ChangeResult?
    let error: String?
    func validate(request: RelaySystemProxyHelperRequest, trust: RelaySystemProxyHelperTrust) throws {
        guard version == 1, nonce == request.nonce, revision == trust.revision, clientUID == trust.manifest.clientUID,
              error == nil || (result == nil && error!.utf8.count <= 1024) else { throw RelaySystemProxyHelperFailure.reply }
        if error == nil {
            if request.operation == .change {
                guard let result, ["applied", "rolledBack", "unchanged", "uncertain"].contains(result.status), result.warnings.count <= 16, result.warnings.allSatisfy({ $0.utf8.count <= 1024 }) else { throw RelaySystemProxyHelperFailure.reply }
                _ = try RelaySystemProxyBackend.canonical(result.snapshot)
            } else if result != nil { throw RelaySystemProxyHelperFailure.reply }
        }
    }
}

/// launchd retains the Mach service while an idle helper releases its process.
/// Leases cover both XPC connections and queued/in-flight transactions, so idle
/// shutdown cannot interrupt a commit, readback or rollback after disconnection.
final class RelaySystemProxyHelperLifetime {
    private let lock = NSLock()
    private var leases = 0
    private var lastActivity: TimeInterval
    private var stopping = false
    private let now: () -> TimeInterval
    init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.now = now; lastActivity = now()
    }
    func acquire() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !stopping else { return false }
        leases += 1; lastActivity = now(); return true
    }
    func release() {
        lock.lock(); defer { lock.unlock() }
        precondition(leases > 0)
        leases -= 1; lastActivity = now()
    }
    func beginIdleShutdown() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !stopping, leases == 0, now() - lastActivity >= 15 else { return false }
        stopping = true; return true
    }
}

/// A single helper-wide queue serializes all clients. The original backend
/// still takes the SCPreferences lock and compares the complete before value.
final class RelaySystemProxyHelperListener: NSObject, NSXPCListenerDelegate {
    let trust: RelaySystemProxyHelperTrust
    let lifetime = RelaySystemProxyHelperLifetime()
    private let queue = DispatchQueue(label: "local.relay.network.system-proxy.requests")
    init(trust: RelaySystemProxyHelperTrust) { self.trust = trust }
    func makeListener() throws -> NSXPCListener {
        guard getuid() == 0, geteuid() == 0 else { throw RelaySystemProxyHelperFailure.peer }
        let listener = NSXPCListener(machServiceName: RelaySystemProxyHelperPaths.service)
        listener.setConnectionCodeSigningRequirement(trust.manifest.client.requirement)
        listener.delegate = self
        return listener
    }
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard getuid() == 0, geteuid() == 0, connection.effectiveUserIdentifier == trust.manifest.clientUID,
              (try? RelaySystemProxyHelperTrust.load().revision) == trust.revision else { return false }
        guard lifetime.acquire() else { return false }
        connection.setCodeSigningRequirement(trust.manifest.client.requirement)
        connection.exportedInterface = NSXPCInterface(with: RelaySystemProxyPrivilegedProtocol.self)
        let handler = RelaySystemProxyHelperHandler(connection: connection, trust: trust, queue: queue, lifetime: lifetime)
        connection.exportedObject = handler
        connection.interruptionHandler = { [handler] in handler.disconnect() }
        connection.invalidationHandler = { [handler] in handler.disconnect() }
        connection.activate()
        return true
    }
}

/// A connection accepts a read-only status and at most its corresponding change.
enum RelaySystemProxyHelperAdmission {
    case fresh, checking, ready(String, TimeInterval), used

    mutating func admit(_ request: RelaySystemProxyHelperRequest) -> Bool {
        switch (self, request.operation) {
        case (.fresh, .status): self = .checking
        case let (.ready(nonce, deadline), .change) where nonce == request.nonce && request.deadline <= deadline:
            self = .used
        default: return false
        }
        return true
    }
}

private final class RelaySystemProxyHelperHandler: NSObject, RelaySystemProxyPrivilegedProtocol {
    private weak var connection: NSXPCConnection?
    private let trust: RelaySystemProxyHelperTrust
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var live = true
    private var admission = RelaySystemProxyHelperAdmission.fresh
    private let lifetime: RelaySystemProxyHelperLifetime
    init(connection: NSXPCConnection, trust: RelaySystemProxyHelperTrust, queue: DispatchQueue, lifetime: RelaySystemProxyHelperLifetime) {
        self.connection = connection; self.trust = trust; self.queue = queue; self.lifetime = lifetime
    }
    func disconnect() {
        lock.lock(); let wasLive = live; live = false; lock.unlock()
        if wasLive { lifetime.release() }
    }
    private func authorized(until deadline: TimeInterval) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return live && ProcessInfo.processInfo.systemUptime <= deadline && connection?.effectiveUserIdentifier == trust.manifest.clientUID && getuid() == 0 && geteuid() == 0
    }
    func transact(_ data: NSData, withReply reply: @escaping (NSData) -> Void) {
        guard data.length > 0, data.length <= RelaySystemProxyHelperRequest.maximumBytes else { reply(NSData()); connection?.invalidate(); return }
        do {
            let request = try RelaySystemProxyHelperRequest.parse(data as Data, now: ProcessInfo.processInfo.systemUptime)
            lock.lock(); let admitted = live && admission.admit(request); lock.unlock()
            guard admitted, lifetime.acquire() else { reply(NSData()); connection?.invalidate(); return }
            queue.async { [self] in
                defer { lifetime.release() }
                let response: RelaySystemProxyHelperReply
                do {
                    guard authorized(until: request.deadline), try RelaySystemProxyHelperTrust.load().revision == trust.revision else { throw RelaySystemProxyHelperFailure.peer }
                    let result = try request.operation == .change ? RelaySystemProxyBackend.changeSystemRoot(request.expected!, request.target!, requestIsValid: { [self] in authorized(until: request.deadline) }) : nil
                    if request.operation == .status {
                        lock.lock(); admission = .ready(request.nonce, request.deadline); lock.unlock()
                    }
                    response = RelaySystemProxyHelperReply(version: 1, nonce: request.nonce, revision: trust.revision, clientUID: trust.manifest.clientUID, result: result, error: nil)
                } catch {
                    response = RelaySystemProxyHelperReply(version: 1, nonce: request.nonce, revision: trust.revision, clientUID: trust.manifest.clientUID, result: nil, error: "管理员组件未确认系统代理事务，请刷新状态后检查。")
                }
                guard let bytes = try? JSONEncoder().encode(response), bytes.count <= RelaySystemProxyHelperRequest.maximumBytes else { reply(NSData()); return }
                reply(bytes as NSData)
            }
        } catch { reply(NSData()); connection?.invalidate() }
    }
}

enum RelaySystemProxyHelperClient {
    enum TransportFailure: Error { case interrupted }
    // Only the signed local CLI emits this nonce-bound exit receipt. It is
    // never accepted as a reply from a daemon or inferred from an XPC error.
    struct NotSubmitted: Error {
        let nonce: String
        static let exitStatus: Int32 = 75
    }

    static func transact(_ request: RelaySystemProxyHelperRequest) throws -> RelaySystemProxyHelperReply {
        let trust: RelaySystemProxyHelperTrust
        do {
            trust = try RelaySystemProxyHelperTrust.load()
            guard getuid() == trust.manifest.clientUID, geteuid() == getuid() else { throw RelaySystemProxyHelperFailure.peer }
        } catch { throw request.failureBeforeWrite(error) }
        return try transact(request, now: { ProcessInfo.processInfo.systemUptime }, connect: {
            let connection = NSXPCConnection(machServiceName: RelaySystemProxyHelperPaths.service, options: .privileged)
            connection.setCodeSigningRequirement(trust.manifest.helper.requirement)
            connection.remoteObjectInterface = NSXPCInterface(with: RelaySystemProxyPrivilegedProtocol.self)
            connection.activate()
            return connection
        }, close: { $0.invalidate() }, send: { try exchange($0, $1, trust: trust) })
    }

    static func transact<Connection>(_ request: RelaySystemProxyHelperRequest, now: () -> TimeInterval,
        connect: () -> Connection, close: (Connection) -> Void,
        send: (Connection, RelaySystemProxyHelperRequest) throws -> RelaySystemProxyHelperReply) throws -> RelaySystemProxyHelperReply {
        let status = RelaySystemProxyHelperRequest(version: request.version, operation: .status, nonce: request.nonce,
            deadline: request.deadline, expected: nil, target: nil)
        var submitted = false
        do {
            for attempt in 0...1 {
                try request.validate(now: now(), receiver: .localClient)
                let connection = connect()
                defer { close(connection) }
                let acknowledgement: RelaySystemProxyHelperReply
                do { acknowledgement = try send(connection, status) }
                catch TransportFailure.interrupted where attempt == 0 { continue }
                if request.operation == .status { return acknowledgement }
                guard acknowledgement.error == nil else { throw RelaySystemProxyHelperFailure.reply }
                let started = now()
                guard started < request.deadline else { throw RelaySystemProxyHelperFailure.request }
                let change = RelaySystemProxyHelperRequest(version: request.version, operation: .change, nonce: request.nonce,
                    deadline: min(request.deadline, started + RelaySystemProxyHelperRequest.writeWindow),
                    expected: request.expected, target: request.target)
                try change.validate(now: started)
                // From this point on any failure is an unknown write outcome.
                submitted = true
                return try send(connection, change)
            }
            throw RelaySystemProxyHelperFailure.unavailable
        } catch {
            throw submitted ? error : request.failureBeforeWrite(error)
        }
    }

    private static func exchange(_ connection: NSXPCConnection, _ request: RelaySystemProxyHelperRequest,
        trust: RelaySystemProxyHelperTrust) throws -> RelaySystemProxyHelperReply {
        let condition = NSCondition()
        var outcome: Result<RelaySystemProxyHelperReply, Error>?
        func finish(_ value: Result<RelaySystemProxyHelperReply, Error>) {
            condition.lock(); defer { condition.unlock() }
            if outcome == nil { outcome = value; condition.broadcast() }
        }
        let proxy = connection.remoteObjectProxyWithErrorHandler { error in
            let failure = error as NSError
            if failure.domain == NSCocoaErrorDomain && failure.code == CocoaError.Code.xpcConnectionInterrupted.rawValue {
                finish(.failure(TransportFailure.interrupted))
            } else { finish(.failure(RelaySystemProxyHelperFailure.unavailable)) }
        }
        guard let remote = proxy as? RelaySystemProxyPrivilegedProtocol else { throw RelaySystemProxyHelperFailure.unavailable }
        let bytes = try JSONEncoder().encode(request)
        guard bytes.count <= RelaySystemProxyHelperRequest.maximumBytes else { throw RelaySystemProxyHelperFailure.request }
        remote.transact(bytes as NSData) { data in
            do {
                guard connection.effectiveUserIdentifier == 0, data.length > 0, data.length <= RelaySystemProxyHelperRequest.maximumBytes,
                      try RelaySystemProxyHelperTrust.load().revision == trust.revision else { throw RelaySystemProxyHelperFailure.peer }
                let response = try JSONDecoder().decode(RelaySystemProxyHelperReply.self, from: data as Data)
                try response.validate(request: request, trust: trust)
                finish(.success(response))
            } catch { finish(.failure(error)) }
        }
        condition.lock()
        // A submitted write can finish commit/readback after its admission deadline.
        let grace: TimeInterval = request.operation == .change ? 4 : 0
        let timeout = Date().addingTimeInterval(request.deadline + grace - ProcessInfo.processInfo.systemUptime)
        while outcome == nil {
            if !condition.wait(until: timeout) { break }
        }
        let value = outcome
        condition.unlock()
        guard let value else { throw RelaySystemProxyHelperFailure.unavailable }
        return try value.get()
    }
}
