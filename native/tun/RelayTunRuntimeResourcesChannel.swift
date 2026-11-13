import Foundation

/// Geo codec/driver adaptation of the shared asset pipe. Its old 8KiB wire,
/// model callbacks and independent resource-only failure scope stay unchanged.
final class RelayTunRuntimeResourcesChannel {
    typealias Model = RelayTunRuntimeResources
    typealias Inbox = RelayTunRuntimeResourceInbox
    typealias Binding = RelayTunRuntimeAssetScope.Binding
    typealias Context = RelayTunRuntimeAssetScope.Context
    typealias Failure = RelayTunRuntimeAssetScope.Failure
    static let frameLimit = 8192
    static let helloDuration = UInt64(3_000_000_000)
    struct Observation { let configurationRevision: String, ledger: Model.Ledger }
    struct Driver {
        let read: (Context, @escaping (Result<Observation, Error>) -> Void) -> Void
        let replace: (Int, Model.Selection, Context, @escaping (Model.Reply) -> Void) -> Void
        let cancelReplace: (Int) -> Model.Reply
        let discard: (Inbox.Ticket, Context, @escaping (Result<Inbox.Discard, Error>) -> Void) -> Void
        let invalidate: () -> Void
    }
    private typealias Engine = RelayTunRuntimeAssetChannel<Model.Selection, Inbox.Ticket, Observation>
    private let engine: Engine
    init?(binding: Binding, clientSHA256: String, installationRevision: String, driver: Driver,
          input: Int32 = 7, output: Int32 = 8, leaseSeconds: Int = Model.defaultLeaseSeconds,
          execute: @escaping (@escaping () -> Void) -> Void = { $0() }) {
        let codec = Engine.Codec(capability: Model.capability, frameLimit: Self.frameLimit,
            replaceFields: ["configurationRevision", "expectedGenerationSHA256", "kind", "oldSHA256", "newSHA256", "blobId", "selector", "bytes"],
            ticketFields: ["blobId", "kind", "sha256", "bytes", "selector"],
            replacement: { raw in
                guard let kind = raw["kind"] as? String, let typed = Model.Kind(rawValue: kind),
                      let revision = raw["configurationRevision"] as? String, let head = raw["expectedGenerationSHA256"] as? String,
                      let old = raw["oldSHA256"] as? String, let new = raw["newSHA256"] as? String,
                      let blob = raw["blobId"] as? String, let selector = raw["selector"] as? String,
                      let size = RelayTunStrictJSON.integer(raw["bytes"]) else { throw Failure.invalid }
                return try .init(kind: typed, configurationRevision: revision, expectedGenerationSHA256: head,
                    oldSHA256: old, newSHA256: new, blobId: blob, selector: selector, bytes: size)
            }, ticket: { raw in
                guard let id = raw["blobId"] as? String, let name = raw["kind"] as? String, let kind = Model.Kind(rawValue: name),
                      let sha = raw["sha256"] as? String, let size = RelayTunStrictJSON.integer(raw["bytes"]),
                      let selector = raw["selector"] as? String else { throw Failure.invalid }
                return try .init(blobId: id, kind: kind, sha256: sha, bytes: size, selector: selector)
            }, snapshot: { observation in
                guard observation.configurationRevision == binding.runtimeConfigurationSHA256 else { throw Failure.unavailable }
                return ["configurationRevision": observation.configurationRevision,
                    "generationSHA256": observation.ledger.generationSHA256,
                    "resources": Model.Kind.allCases.compactMap { kind -> [String: Any]? in
                        guard let row = observation.ledger.resources[kind] else { return nil }
                        return ["kind": kind.rawValue, "sha256": row.sha256, "bytes": row.bytes, "active": row.active]
                    }]
            })
        let callbacks = Engine.Driver(read: driver.read, replace: { id, selection, context, done in
            driver.replace(id, selection, context) { reply in
                done(.init(status: reply.status.rawValue,
                    observation: reply.ledger.map { Observation(configurationRevision: selection.configurationRevision, ledger: $0) }))
            }
        }, cancelReplace: { driver.cancelReplace($0).status.rawValue }, discard: { ticket, context, done in
            driver.discard(ticket, context) { result in
                switch result {
                case .success(let value): done(.success(value == .discarded ? .discarded : .absent))
                case .failure(let error):
                    if case Inbox.Failure.busy = error { done(.success(.busy)) }
                    else { done(.failure(error)) }
                }
            }
        }, invalidate: driver.invalidate)
        guard let engine = Engine(binding: binding, clientSHA256: clientSHA256, installationRevision: installationRevision,
            codec: codec, driver: callbacks, input: input, output: output, leaseSeconds: leaseSeconds, execute: execute) else { return nil }
        self.engine = engine
    }
    func start() { engine.start() }
    func invalidate() { engine.invalidate() }
}
