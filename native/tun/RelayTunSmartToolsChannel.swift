import Foundation

/// Thin adapter over the mature inherited-pipe engine. The independent tools
/// capability owns FD9/10 only; it cannot export state or enter control recovery.
final class RelayTunSmartToolsChannel {
    typealias Model = RelayTunSmartTools
    struct DisabledTicket { fileprivate init() {} }
    typealias Engine = RelayTunRuntimeAssetChannel<Model.Clear, DisabledTicket, Model.Snapshot>
    typealias Context = Engine.Context
    struct Driver {
        let read: (Context, @escaping (Result<Model.Snapshot, Error>) -> Void) -> Void
        let clear: (Int, Context, @escaping (Engine.Reply) -> Void) -> Void
        let cancel: (Int) -> String
        let invalidate: () -> Void
    }
    private let engine: Engine
    init?(binding: Engine.Binding, clientSHA256: String, installationRevision: String, driver: Driver,
          input: Int32 = 9, output: Int32 = 10, leaseSeconds: Int = 30) {
        var codec = Engine.Codec(capability: "runtime-smart-tools-v1", frameLimit: Model.frameLimit,
            replaceFields: [], ticketFields: [], replacement: { _ in try .init([:]) },
            ticket: { _ in throw Engine.Failure.unsupported }, snapshot: { $0.json })
        codec.readAction = "weights"; codec.replaceAction = "clear-cache"; codec.allowDiscard = false
        codec.readStatus = "weights"; codec.replaceSuccessStatuses = ["accepted"]; codec.uncertainSuccessStatuses = ["accepted"]
        guard let engine = Engine(binding: binding, clientSHA256: clientSHA256, installationRevision: installationRevision,
            codec: codec, driver: .init(read: driver.read, replace: { id, _, context, done in
                driver.clear(id, context, done)
            }, cancelReplace: driver.cancel, discard: { _, _, done in done(.failure(Engine.Failure.unsupported)) },
            invalidate: driver.invalidate), input: input, output: output, leaseSeconds: leaseSeconds) else { return nil }
        self.engine = engine
    }
    func start() { engine.start() }
    func invalidate() { engine.invalidate() }
}
