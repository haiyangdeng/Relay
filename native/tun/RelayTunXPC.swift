import Foundation
import Security
import Darwin

@objc protocol RelayTunPrivilegedProtocol {
    // No arbitrary Objective-C object graph, executable, path, PID or descriptor
    // number is accepted. An FD can only travel as NSFileHandle in an XPC reply.
    func transact(_ request: NSData, withReply reply: @escaping (NSData, FileHandle?) -> Void)
}

struct RelayTunWireRequest {
    enum Operation: String, Codable { case status, prepare, acquire, activate, revoke, release }
    // A prepare carries its complete typed network projection inline as hex.
    // The bytes are the only accepted projection source; the helper never
    // reads a caller-selected path, descriptor, PID or pre-existing interface.
    static let maximumBytes = 40960
    // Inline projection byte bound. This target deliberately does not link the
    // projection module; RelayTunNetworkProjection.maximumBytes must stay equal
    // and the executor test target, which links both, asserts that equality.
    static let maximumProjectionBytes = 16384
    let operation: Operation
    let nonce: String
    let configurationSHA256: String?
    let runtimeConfigurationSHA256: String?
    let bundleSHA256: String?
    let evidenceSHA256: String?
    let sessionID: String?
    let projection: Data?
    let networkSHA256: String?
    let protectionSHA256: String?
    static func projectionBytes(_ raw: Any?) throws -> Data {
        guard let hex = raw as? String, hex.utf8.count >= 2, hex.utf8.count <= 32768, hex.utf8.count % 2 == 0 else { throw RelayTunHelperFailure.invalidRequest }
        var bytes = Data(); bytes.reserveCapacity(hex.utf8.count / 2)
        var high: UInt8?
        for byte in hex.utf8 {
            let digit: UInt8
            switch byte {
            case 48...57: digit = byte - 48
            case 97...102: digit = byte - 87
            default: throw RelayTunHelperFailure.invalidRequest
            }
            if let pending = high { bytes.append(pending << 4 | digit); high = nil } else { high = digit }
        }
        guard bytes.count <= Self.maximumProjectionBytes else { throw RelayTunHelperFailure.invalidRequest }
        return bytes
    }
    static func parse(_ data: Data) throws -> Self {
        let value = try RelayTunStrictJSON.object(data, limit: maximumBytes)
        guard RelayTunStrictJSON.integer(value["version"]) == 1, let raw = value["operation"] as? String, let operation = Operation(rawValue: raw), let nonce = RelayTunHelperTrust.hex(value["nonce"], count: 64) else { throw RelayTunHelperFailure.invalidRequest }
        let base: Set<String> = ["version", "operation", "nonce"]
        let extra: Set<String>
        switch operation {
        case .status: extra = []
        case .prepare: extra = ["configurationSHA256", "runtimeConfigurationSHA256", "bundleSHA256", "projection", "networkSHA256", "protectionSHA256"]
        case .acquire: extra = ["evidenceSHA256"]
        case .activate: extra = ["sessionID", "evidenceSHA256", "runtimeConfigurationSHA256"]
        case .release, .revoke: extra = ["sessionID"]
        }
        guard Set(value.keys) == base.union(extra) else { throw RelayTunHelperFailure.invalidRequest }
        for key in extra where key != "sessionID" && key != "projection" { guard RelayTunHelperTrust.hex(value[key], count: 64) != nil else { throw RelayTunHelperFailure.invalidRequest } }
        if operation == .release || operation == .activate || operation == .revoke {
            guard let id = value["sessionID"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id else { throw RelayTunHelperFailure.invalidRequest }
        }
        let projection = operation == .prepare ? try projectionBytes(value["projection"]) : nil
        return Self(operation: operation, nonce: nonce, configurationSHA256: value["configurationSHA256"] as? String, runtimeConfigurationSHA256: value["runtimeConfigurationSHA256"] as? String, bundleSHA256: value["bundleSHA256"] as? String, evidenceSHA256: value["evidenceSHA256"] as? String, sessionID: value["sessionID"] as? String, projection: projection, networkSHA256: value["networkSHA256"] as? String, protectionSHA256: value["protectionSHA256"] as? String)
    }
}

struct RelayTunAuthenticatedPeer {
    let uid: uid_t
    let installationRevision: String
}

struct RelayTunExecutorResult {
    enum State: String, Codable { case unavailable, idle, prepared, acquired, active, revoked, released, uncertain }
    let state: State
    let sessionID: String?
    let evidenceSHA256: String?
    // A delivery duplicate owned by this result, never the executor's primary
    // recovery handle. Invalid output may be closed before any XPC reply.
    let descriptor: FileHandle?
    var acquisition: RelayTunAcquiredReceipt? = nil
    static let unavailable = Self(state: .unavailable, sessionID: nil, evidenceSHA256: nil, descriptor: nil)
}
protocol RelayTunNetworkExecutor: AnyObject {
    /// A later typed adapter performs its own confirmation, snapshot and
    /// generation checks. This seam does not authorize network operations.
    func perform(request: RelayTunWireRequest, peer: RelayTunAuthenticatedPeer, trust: RelayTunInstallationTrust) throws -> RelayTunExecutorResult
    func suspend()
}
extension RelayTunNetworkExecutor { func suspend() {} }

struct RelayTunWireResponse: Codable {
    let version: Int
    let nonce: String
    let operation: RelayTunWireRequest.Operation
    let status: RelayTunExecutorResult.State
    let helperRevision: String
    let clientUID: uid_t
    let authenticated: Bool
    let rootOwned: Bool
    let runningAsRoot: Bool
    let executorAvailable: Bool
    let ready: Bool
    let active: Bool
    let protectionVerified: Bool
    let sessionID: String?
    let evidenceSHA256: String?
    let acquisition: RelayTunAcquiredReceipt?
    private static func validate(_ request: RelayTunWireRequest, trust: RelayTunInstallationTrust, state: RelayTunExecutorResult.State, sessionID: String?, evidenceSHA256: String?, hasDescriptor: Bool, acquisition: RelayTunAcquiredReceipt?) throws {
        guard state != .acquired || (request.operation == .acquire && hasDescriptor), state != .active || request.operation == .activate, state != .prepared || request.operation == .prepare, state != .released || request.operation == .release, state != .revoked || request.operation == .revoke, !hasDescriptor || (request.operation == .acquire && state == .acquired), sessionID == nil || UUID(uuidString: sessionID!)?.uuidString.lowercased() == sessionID, evidenceSHA256 == nil || RelayTunHelperTrust.hex(evidenceSHA256, count: 64) != nil, ![.acquired, .active, .released].contains(state) || sessionID != nil, state != .prepared || evidenceSHA256 != nil else { throw RelayTunHelperFailure.invalidReply }
        if state == .acquired {
            guard let acquisition else { throw RelayTunHelperFailure.invalidReply }
            try acquisition.validate()
            guard acquisition.installationRevision == trust.revision, acquisition.clientUID == trust.clientUID,
                  acquisition.sessionID == sessionID, acquisition.evidenceSHA256 == evidenceSHA256,
                  evidenceSHA256 == request.evidenceSHA256 else { throw RelayTunHelperFailure.invalidReply }
        } else if acquisition != nil { throw RelayTunHelperFailure.invalidReply }
    }
    static func make(_ request: RelayTunWireRequest, trust: RelayTunInstallationTrust, result: RelayTunExecutorResult, runningAsRoot: Bool) throws -> Self {
        try validate(request, trust: trust, state: result.state, sessionID: result.sessionID, evidenceSHA256: result.evidenceSHA256, hasDescriptor: result.descriptor != nil, acquisition: result.acquisition)
        return Self(version: 1, nonce: request.nonce, operation: request.operation, status: result.state, helperRevision: trust.revision, clientUID: trust.clientUID, authenticated: true, rootOwned: true, runningAsRoot: runningAsRoot, executorAvailable: result.state != .unavailable, ready: false, active: result.state == .active, protectionVerified: false, sessionID: result.sessionID, evidenceSHA256: result.evidenceSHA256, acquisition: result.acquisition)
    }
    static func parse(_ data: Data, request: RelayTunWireRequest, trust: RelayTunInstallationTrust, hasDescriptor: Bool) throws -> Self {
        let object = try RelayTunStrictJSON.object(data)
        let required: Set<String> = ["version", "nonce", "operation", "status", "helperRevision", "clientUID", "authenticated", "rootOwned", "runningAsRoot", "executorAvailable", "ready", "active", "protectionVerified"]
        guard required.isSubset(of: Set(object.keys)), Set(object.keys).isSubset(of: required.union(["sessionID", "evidenceSHA256", "acquisition"])) else { throw RelayTunHelperFailure.invalidReply }
        if object.keys.contains("acquisition"), object["acquisition"] is NSNull { throw RelayTunHelperFailure.invalidReply }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.version == 1, value.nonce == request.nonce, value.operation == request.operation, value.helperRevision == trust.revision, value.clientUID == trust.clientUID, value.authenticated, value.rootOwned, value.runningAsRoot, !value.ready, !value.protectionVerified, value.active == (value.status == .active), value.executorAvailable == (value.status != .unavailable) else { throw RelayTunHelperFailure.invalidReply }
        try validate(request, trust: trust, state: value.status, sessionID: value.sessionID, evidenceSHA256: value.evidenceSHA256, hasDescriptor: hasDescriptor, acquisition: value.acquisition)
        return value
    }
}

/// A per-connection, bounded replay cache. It is not a durable authorization or a
/// network plan; an executor must also reject stale preparation evidence.
final class RelayTunNonceWindow {
    private var entries: [String: TimeInterval] = [:]
    private var lastTime: TimeInterval?
    private let lock = NSLock()
    func consume(_ nonce: String, now: TimeInterval) throws {
        lock.lock(); defer { lock.unlock() }
        guard RelayTunHelperTrust.hex(nonce, count: 64) != nil, now.isFinite, now >= 0, lastTime == nil || now >= lastTime! else { throw RelayTunHelperFailure.replayedRequest }
        lastTime = now; entries = entries.filter { now - $0.value <= 60 }
        guard entries[nonce] == nil, entries.count < 128 else { throw RelayTunHelperFailure.replayedRequest }
        entries[nonce] = now
    }
}

/// A single listener-owned coordinator. Tests may inject this contract without
/// linking privileged network implementations into the wire-only target.
protocol RelayTunConnectionService: AnyObject {
    func perform(request: RelayTunWireRequest, peer: RelayTunAuthenticatedPeer, trust: RelayTunInstallationTrust,
                 connectionID: String, observer: RelayTunCoreObserver) throws -> RelayTunExecutorResult
    func disconnect(connectionID: String)
    func revokeAuthorization(connectionID: String)
}
extension RelayTunConnectionService { func revokeAuthorization(connectionID: String) {} }

private final class RelayTunConnectionHandler: NSObject, RelayTunPrivilegedProtocol {
    private weak var connection: NSXPCConnection?
    private let trust: RelayTunInstallationTrust
    private let peer: RelayTunAuthenticatedPeer
    private let executor: RelayTunNetworkExecutor?
    private let service: RelayTunConnectionService?
    private let connectionID: String
    private let observer: RelayTunCoreObserver
    private let nonces = RelayTunNonceWindow()
    private let queue = DispatchQueue(label: "local.relay.network.tun.requests")
    init(connection: NSXPCConnection, trust: RelayTunInstallationTrust, executor: RelayTunNetworkExecutor?,
         service: RelayTunConnectionService?, connectionID: String) throws {
        self.connection = connection; self.trust = trust; self.executor = executor
        self.service = service; self.connectionID = connectionID
        peer = RelayTunAuthenticatedPeer(uid: connection.effectiveUserIdentifier, installationRevision: trust.revision)
        observer = try RelayTunCoreObserver(verifyLocalTrust: { [weak connection] in
            guard let connection, connection.effectiveUserIdentifier == trust.clientUID,
                  try RelayTunInstallationTrust.load().revision == trust.revision else { throw RelayTunHelperFailure.untrustedPeer }
        }, query: { [weak connection] request, reply in
            guard let connection, connection.effectiveUserIdentifier == trust.clientUID else { reply(NSData()); return }
            let proxy = connection.remoteObjectProxyWithErrorHandler { _ in reply(NSData()) }
            guard let channel = proxy as? RelayTunCoreObservationChannel else { reply(NSData()); return }
            channel.query(request, withReply: reply)
        })
    }
    func disconnected() {
        // Independent latch: no wait for a request blocked in reverse IPC or
        // filesystem/kernel I/O. The service and executor remain strongly held
        // by the listener, with their exact recovery capabilities intact.
        service?.disconnect(connectionID: connectionID)
        executor?.suspend()
    }
    func transact(_ request: NSData, withReply reply: @escaping (NSData, FileHandle?) -> Void) {
        guard request.length > 0, request.length <= RelayTunWireRequest.maximumBytes else { disconnected(); connection?.invalidate(); reply(NSData(), nil); return }
        do {
            let data = Data(bytes: request.bytes, count: request.length)
            let parsed = try RelayTunWireRequest.parse(data)
            try nonces.consume(parsed.nonce, now: ProcessInfo.processInfo.systemUptime)
            if parsed.operation == .revoke {
                // This connection was already code/UID-authenticated at
                // acceptance. Reducing its authority must precede expensive
                // trust/resource I/O; the formal reply still verifies current
                // installation and the exact session below.
                service?.revokeAuthorization(connectionID: connectionID)
                executor?.suspend()
            }
            let operation = { [self] in
                do {
                    guard geteuid() == 0, let connection, connection.effectiveUserIdentifier == peer.uid,
                          peer.uid == trust.clientUID, try RelayTunInstallationTrust.load().revision == trust.revision else { throw RelayTunHelperFailure.untrustedPeer }
                    let result: RelayTunExecutorResult
                    if let service { result = try service.perform(request: parsed, peer: peer, trust: trust,
                        connectionID: connectionID, observer: observer) }
                    else { result = try executor?.perform(request: parsed, peer: peer, trust: trust) ?? .unavailable }
                    do {
                        let response = try RelayTunWireResponse.make(parsed, trust: trust, result: result, runningAsRoot: true)
                        reply(try JSONEncoder().encode(response) as NSData, result.descriptor)
                        // NSXPC serialized its own delivery copy before returning.
                        // Never retain an ordinary delivery duplicate in root.
                        try? result.descriptor?.close()
                    } catch { try? result.descriptor?.close(); throw error }
                } catch { disconnected(); connection?.invalidate(); reply(NSData(), nil) }
            }
            // revoke must overtake an activation waiting on its callback. It
            // only invalidates authorization; it does not restore or close FDs.
            if parsed.operation == .revoke { DispatchQueue.global().async(execute: operation) }
            else { queue.async(execute: operation) }
        } catch { disconnected(); connection?.invalidate(); reply(NSData(), nil) }
    }
}

final class RelayTunHelperListener: NSObject, NSXPCListenerDelegate {
    private let trust: RelayTunInstallationTrust
    private let executor: RelayTunNetworkExecutor?
    private let service: RelayTunConnectionService?
    init(trust: RelayTunInstallationTrust, executor: RelayTunNetworkExecutor? = nil,
         service: RelayTunConnectionService? = nil) { self.trust = trust; self.executor = executor; self.service = service }
    func makeListener() throws -> NSXPCListener {
        guard geteuid() == 0 else { throw RelayTunHelperFailure.untrustedPeer }
        let listener = NSXPCListener(machServiceName: RelayTunInstallationPaths.service)
        listener.setConnectionCodeSigningRequirement(trust.client.requirement)
        listener.delegate = self
        return listener
    }
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard geteuid() == 0, connection.effectiveUserIdentifier == trust.clientUID,
              (try? RelayTunInstallationTrust.load().revision) == trust.revision else { return false }
        do {
            connection.setCodeSigningRequirement(trust.client.requirement)
            connection.exportedInterface = NSXPCInterface(with: RelayTunPrivilegedProtocol.self)
            connection.remoteObjectInterface = NSXPCInterface(with: RelayTunCoreObservationChannel.self)
            let handler = try RelayTunConnectionHandler(connection: connection, trust: trust,
                executor: executor, service: service, connectionID: UUID().uuidString.lowercased())
            connection.exportedObject = handler
            connection.interruptionHandler = { [handler] in handler.disconnected() }
            connection.invalidationHandler = { [handler] in handler.disconnected() }
            connection.activate()
            return true
        } catch { return false }
    }
}

/// A production client always reads the fixed root-protected trust manifest.
/// There is no IPC argument for replacing a requirement or claiming peer UID.
final class RelayTunXPCClient {
    private let trust: RelayTunInstallationTrust
    private let connection: NSXPCConnection
    init(observation: RelayTunCoreObservationChannel? = nil) throws {
        trust = try RelayTunInstallationTrust.load()
        guard geteuid() == trust.clientUID, getuid() == trust.clientUID else { throw RelayTunHelperFailure.untrustedPeer }
        connection = NSXPCConnection(machServiceName: RelayTunInstallationPaths.service, options: .privileged)
        connection.setCodeSigningRequirement(trust.helper.requirement)
        connection.remoteObjectInterface = NSXPCInterface(with: RelayTunPrivilegedProtocol.self)
        if let observation {
            connection.exportedInterface = NSXPCInterface(with: RelayTunCoreObservationChannel.self)
            connection.exportedObject = observation
        }
        connection.activate()
    }
    func transact(_ data: Data, completion: @escaping (Result<(RelayTunWireResponse, FileHandle?), Error>) -> Void) throws {
        let request = try RelayTunWireRequest.parse(data)
        let gate = RelayTunReplyGate(completion)
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) { [connection] in
            if gate.finish(.failure(RelayTunHelperFailure.executorUnavailable)) { connection.invalidate() }
        }
        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in _ = gate.finish(.failure(RelayTunHelperFailure.untrustedPeer)) }
        guard let service = proxy as? RelayTunPrivilegedProtocol else { throw RelayTunHelperFailure.untrustedPeer }
        service.transact(data as NSData) { [self] raw, file in
            do {
                guard connection.effectiveUserIdentifier == 0, raw.length <= 16384, try RelayTunInstallationTrust.load().revision == trust.revision else { throw RelayTunHelperFailure.untrustedPeer }
                let response = try RelayTunWireResponse.parse(raw as Data, request: request, trust: trust, hasDescriptor: file != nil)
                _ = gate.finish(.success((response, file)))
            } catch { try? file?.close(); connection.invalidate(); _ = gate.finish(.failure(RelayTunHelperFailure.invalidReply)) }
        }
    }
    func invalidate() { connection.invalidate() }
    deinit { connection.invalidate() }
}

private final class RelayTunReplyGate {
    private let lock = NSLock()
    private var completed = false
    private let completion: (Result<(RelayTunWireResponse, FileHandle?), Error>) -> Void
    init(_ completion: @escaping (Result<(RelayTunWireResponse, FileHandle?), Error>) -> Void) { self.completion = completion }
    func finish(_ result: Result<(RelayTunWireResponse, FileHandle?), Error>) -> Bool {
        lock.lock()
        if completed { lock.unlock(); if case let .success((_, descriptor)) = result { try? descriptor?.close() }; return false }
        completed = true; lock.unlock(); completion(result); return true
    }
}
