import Foundation
import Darwin

@objc protocol RelaySystemProxyPrivilegedProtocol {
    func transact(_ data: NSData, withReply reply: @escaping (NSData) -> Void)
}

struct RelaySystemProxyHelperRequest: Codable {
    static let maximumBytes = 2 * 1024 * 1024
    enum Operation: String, Codable { case status, change }
    let version: Int
    let operation: Operation
    let nonce: String
    let deadline: TimeInterval
    let expected: RelaySystemProxyBackend.Snapshot?
    let target: RelaySystemProxyBackend.Snapshot?
    static func make(_ expected: RelaySystemProxyBackend.Snapshot?, _ target: RelaySystemProxyBackend.Snapshot?) -> Self {
        Self(version: 1, operation: expected == nil ? .status : .change, nonce: UUID().uuidString.lowercased(), deadline: ProcessInfo.processInfo.systemUptime + 8, expected: expected, target: target)
    }
    func validate(now: TimeInterval) throws {
        guard version == 1, UUID(uuidString: nonce)?.uuidString.lowercased() == nonce,
              now.isFinite, deadline.isFinite, deadline >= now, deadline - now <= 10 else { throw RelaySystemProxyHelperFailure.request }
        switch operation {
        case .status: guard expected == nil, target == nil else { throw RelaySystemProxyHelperFailure.request }
        case .change:
            guard let expected, let target else { throw RelaySystemProxyHelperFailure.request }
            _ = try RelaySystemProxyBackend.canonical(expected)
            _ = try RelaySystemProxyBackend.canonical(target)
            _ = try RelaySystemProxyBackend.changedServiceIDs(expected, target)
        }
    }
    static func parse(_ data: Data, now: TimeInterval) throws -> Self {
        guard !data.isEmpty, data.count <= maximumBytes else { throw RelaySystemProxyHelperFailure.request }
        let value = try JSONDecoder().decode(Self.self, from: data)
        try value.validate(now: now)
        return value
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

private final class RelaySystemProxyHelperHandler: NSObject, RelaySystemProxyPrivilegedProtocol {
    private weak var connection: NSXPCConnection?
    private let trust: RelaySystemProxyHelperTrust
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var live = true
    private var used = false
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
        lock.lock(); let admitted = live && !used; used = true; lock.unlock()
        guard admitted, data.length > 0, data.length <= RelaySystemProxyHelperRequest.maximumBytes else { reply(NSData()); connection?.invalidate(); return }
        do {
            let request = try RelaySystemProxyHelperRequest.parse(data as Data, now: ProcessInfo.processInfo.systemUptime)
            guard lifetime.acquire() else { reply(NSData()); connection?.invalidate(); return }
            queue.async { [self] in
                defer { lifetime.release() }
                let response: RelaySystemProxyHelperReply
                do {
                    guard authorized(until: request.deadline), try RelaySystemProxyHelperTrust.load().revision == trust.revision else { throw RelaySystemProxyHelperFailure.peer }
                    let result = try request.operation == .change ? RelaySystemProxyBackend.changeSystemRoot(request.expected!, request.target!, requestIsValid: { [self] in authorized(until: request.deadline) }) : nil
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
    static func transact(_ request: RelaySystemProxyHelperRequest) throws -> RelaySystemProxyHelperReply {
        let trust = try RelaySystemProxyHelperTrust.load()
        guard getuid() == trust.manifest.clientUID, geteuid() == getuid() else { throw RelaySystemProxyHelperFailure.peer }
        try request.validate(now: ProcessInfo.processInfo.systemUptime)
        let connection = NSXPCConnection(machServiceName: RelaySystemProxyHelperPaths.service, options: .privileged)
        connection.setCodeSigningRequirement(trust.manifest.helper.requirement)
        connection.remoteObjectInterface = NSXPCInterface(with: RelaySystemProxyPrivilegedProtocol.self)
        connection.activate()
        defer { connection.invalidate() }
        let condition = NSCondition()
        var outcome: Result<RelaySystemProxyHelperReply, Error>?
        func finish(_ value: Result<RelaySystemProxyHelperReply, Error>) {
            condition.lock(); defer { condition.unlock() }
            if outcome == nil { outcome = value; condition.broadcast() }
        }
        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in finish(.failure(RelaySystemProxyHelperFailure.unavailable)) }
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
        let timeout = Date().addingTimeInterval(12)
        while outcome == nil {
            if !condition.wait(until: timeout) { break }
        }
        let value = outcome
        condition.unlock()
        guard let value else { throw RelaySystemProxyHelperFailure.unavailable }
        return try value.get()
    }
}
