import Darwin
import Foundation

/// The native supervisor owns this descriptor through its child lifetime.
final class RelayTerminalLeaseClient {
    let grant: RelayTerminalLeaseGrant
    private let identity: RelayTerminalLeaseIdentity
    private let peer: Data
    private let id: String
    private var fd: Int32
    private var committed = false

    var descriptor: Int32 { fd }

    private init(fd: Int32, grant: RelayTerminalLeaseGrant, identity: RelayTerminalLeaseIdentity, peer: Data, id: String) {
        self.fd = fd; self.grant = grant; self.identity = identity; self.peer = peer; self.id = id
    }

    static func acquire() throws -> RelayTerminalLeaseClient {
        let deadline = DispatchTime.now().uptimeNanoseconds + RelayTerminalLeaseWire.acquisitionBudget
        let identity = try RelayTerminalLeaseIdentity.local(.launcher)
        let endpoint = try RelayTerminalLeaseEndpoint(create: false)
        let socket = try endpoint.connect(deadline: deadline)
        do {
            let peer = try identity.peer(socket, role: .main)
            let id = UUID().uuidString.lowercased()
            try RelayTerminalLeaseSocket.write(RelayTerminalLeaseWire.command("acquire", id: id), to: socket, deadline: deadline)
            let bytes = try RelayTerminalLeaseSocket.frame(socket, maximum: RelayTerminalLeaseWire.responseLimit, deadline: deadline)
            guard let grant = try RelayTerminalLeaseWire.readResponse(bytes, kind: "grant", id: id) else {
                throw RelayTerminalLeaseFailure.invalid
            }
            _ = try identity.peer(socket, role: .main, expected: peer)
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw RelayTerminalLeaseFailure.deadline }
            return .init(fd: socket, grant: grant, identity: identity, peer: peer, id: id)
        } catch { Darwin.close(socket); throw error }
    }

    /// Once committed, the transport sends no more frames. The caller observes
    /// the same noninherited descriptor for cancellation until the child exits.
    func commit() throws {
        guard fd >= 3, !committed else { throw RelayTerminalLeaseFailure.stale }
        do {
            let deadline = DispatchTime.now().uptimeNanoseconds + RelayTerminalLeaseWire.acquisitionBudget
            _ = try identity.peer(fd, role: .main, expected: peer)
            try RelayTerminalLeaseSocket.write(RelayTerminalLeaseWire.command("commit", id: id), to: fd, deadline: deadline)
            let bytes = try RelayTerminalLeaseSocket.frame(fd, maximum: RelayTerminalLeaseWire.responseLimit, deadline: deadline)
            _ = try RelayTerminalLeaseWire.readResponse(bytes, kind: "committed", id: id)
            _ = try identity.peer(fd, role: .main, expected: peer)
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw RelayTerminalLeaseFailure.deadline }
            committed = true
        } catch { close(); throw error }
    }

    func close() {
        guard fd >= 0 else { return }
        let old = fd; fd = -1
        _ = shutdown(old, SHUT_RDWR)
        Darwin.close(old)
    }

    deinit { close() }
}
