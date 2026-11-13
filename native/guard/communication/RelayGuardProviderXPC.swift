import Foundation
import Darwin

/// Reuses Apple's system-extension Mach listener and Relay TUN's bidirectional
/// code-signing requirements. Unlike the sample, arbitrary same-group clients
/// never register, and interruption does not permit a protected connection.
final class RelayGuardProviderXPC: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var listener: NSXPCListener?
    private var connections: [UUID: NSXPCConnection] = [:]

    func start() throws {
        guard RelayGuardManagementRelease.runtimeProtectionReady, RelayGuardManagementRelease.completeClientScopeReady,
              Bundle.main.bundleIdentifier == RelayGuardContract.extensionID else { throw RelayGuardBindingFailure.publisher }
        let service = try RelayGuardXPCIdentity.machService()
        let value = NSXPCListener(machServiceName: service)
        value.setConnectionCodeSigningRequirement(try RelayGuardXPCIdentity.requirement(identifier: RelayGuardContract.applicationID))
        value.delegate = self
        lock.lock(); listener = value; lock.unlock()
        value.resume()
    }
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier > 0,
              let requirement = try? RelayGuardXPCIdentity.requirement(identifier: RelayGuardContract.applicationID) else { return false }
        let id = UUID()
        let handler = RelayGuardProviderRequestHandler(connection: id, uid: connection.effectiveUserIdentifier)
        connection.setCodeSigningRequirement(requirement)
        connection.exportedInterface = NSXPCInterface(with: RelayGuardProviderCommunication.self)
        connection.exportedObject = handler
        let retire: @Sendable () -> Void = { [weak self] in
            handler.retire()
            self?.retire(id)
        }
        connection.interruptionHandler = retire
        connection.invalidationHandler = retire
        lock.lock(); connections[id] = connection; lock.unlock()
        connection.resume()
        return true
    }
    private func retire(_ id: UUID) {
        lock.lock(); connections.removeValue(forKey: id); lock.unlock()
    }
}

final class RelayGuardProviderRequestHandler: NSObject, RelayGuardProviderCommunication, @unchecked Sendable {
    private let connection: UUID
    private let uid: UInt32
    private let lock = NSLock()
    private var seen = Set<String>()
    private var retired = false
    private static let unconfirmed = Data("{\"version\":2,\"error\":\"unconfirmed\"}".utf8)
    init(connection: UUID, uid: UInt32) { self.connection = connection; self.uid = uid }

    func retire() {
        lock.withLock {
            guard !retired else { return }
            retired = true
            RelayGuardProviderSession.shared.revoke(owner: connection)
        }
    }

    func transact(_ request: NSData, withReply reply: @escaping (NSData) -> Void) {
        // Serialize session changes with connection retirement. An exported
        // request may already be queued when XPC reports the peer is gone.
        let response = lock.withLock {
            guard !retired else { return Self.unconfirmed }
            do {
                let message = try RelayGuardSessionMessage.decode(request as Data)
                guard seen.count < 4096, seen.insert(message.id).inserted else {
                    throw RelayGuardBindingFailure.stale
                }
                let result = try RelayGuardProviderSession.shared.transact(message, connection: connection, uid: uid)
                return try JSONEncoder().encode(result)
            } catch {
                RelayGuardProviderSession.shared.revoke(owner: connection)
                return Self.unconfirmed
            }
        }
        reply(response as NSData)
    }
}
