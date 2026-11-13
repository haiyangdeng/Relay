import Foundation

/// Only FD9/10 of the positively admitted provider launch. The common engine
/// owns bounded framing/cancel/drain; this codec never opens a path or a URL.
final class RelayTunRuntimeRuleProvidersChannel {
    typealias Model = RelayTunRuntimeRuleProviders
    typealias Binding = RelayTunRuntimeAssetScope.Binding
    typealias Context = RelayTunRuntimeAssetScope.Context
    typealias Failure = RelayTunRuntimeAssetScope.Failure
    typealias Discard = RelayTunRuntimeAssetScope.Discard
    static let capability = "runtime-rule-providers-v1"
    static let frameLimit = 262144
    enum Kind: String {
        case yaml = "rule-yaml", text = "rule-text", mrs = "rule-mrs"
        var format: Model.Format { switch self { case .yaml: return .yaml; case .text: return .text; case .mrs: return .mrs } }
        var suffix: String { format.rawValue }
    }
    struct Ticket: Equatable {
        let blobId: String, kind: Kind, sha256: String, bytes: Int, filename: String
        init(blobId: String, kind: Kind, sha256: String, bytes: Int, filename: String) throws {
            guard blobId.utf8.count == 36, Model.Shared.uuid(blobId), blobId.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", options: .regularExpression) != nil,
                  Model.Shared.hash(sha256), bytes > 0, bytes <= kind.format.byteLimit,
                  filename == "\(blobId).\(kind.suffix)" else { throw Failure.invalid }
            self.blobId = blobId; self.kind = kind; self.sha256 = sha256; self.bytes = bytes; self.filename = filename
        }
    }
    struct Selection {
        let provider: String, configurationRevision: String, expectedGenerationSHA256: String, oldSHA256: String
        let ticket: Ticket, declaredRuleCount: Int
        var newSHA256: String { ticket.sha256 }
        var blobId: String { ticket.blobId }
        var kind: Kind { ticket.kind }
        var bytes: Int { ticket.bytes }
        var filename: String { ticket.filename }
        init(_ raw: [String: Any]) throws {
            guard let provider = raw["provider"] as? String, Self.name(provider),
                  let revision = raw["configurationRevision"] as? String, Model.Shared.hash(revision),
                  let head = raw["expectedGenerationSHA256"] as? String, Model.Shared.hash(head),
                  let old = raw["oldSHA256"] as? String, Model.Shared.hash(old),
                  let count = RelayTunStrictJSON.integer(raw["declaredRuleCount"]),
                  (1...Model.maximumDeclaredRules).contains(count) else { throw Failure.invalid }
            ticket = try Self.ticket(raw, hashKey: "newSHA256")
            self.provider = provider; configurationRevision = revision; expectedGenerationSHA256 = head
            oldSHA256 = old; declaredRuleCount = count
        }
        fileprivate static func name(_ value: String) -> Bool {
            !value.isEmpty && value.utf8.count <= 256 && value == value.trimmingCharacters(in: .whitespacesAndNewlines) &&
                !value.contains(",") && value.unicodeScalars.allSatisfy { $0.value >= 32 && !(127...159).contains($0.value) }
        }
        fileprivate static func ticket(_ raw: [String: Any], hashKey: String) throws -> Ticket {
            guard let id = raw["blobId"] as? String, let kindName = raw["kind"] as? String, let kind = Kind(rawValue: kindName),
                  let sha = raw[hashKey] as? String, let size = RelayTunStrictJSON.integer(raw["bytes"]),
                  let filename = raw["filename"] as? String else { throw Failure.invalid }
            return try .init(blobId: id, kind: kind, sha256: sha, bytes: size, filename: filename)
        }
    }
    struct Observation { let configurationRevision: String, ledger: Model.Ledger }
    struct Driver {
        let read: (Context, @escaping (Result<Observation, Error>) -> Void) -> Void
        // AppSession captures the actual Geo budget and held owner itself;
        // neither expectedGeoGeneration nor an acceptance claim is on the wire.
        let replace: (Int, Selection, Context, @escaping (Model.Reply) -> Void) -> Void
        let cancelReplace: (Int) -> Model.Reply
        let discard: (Ticket, Context, @escaping (Result<Discard, Error>) -> Void) -> Void
        let invalidate: () -> Void
    }
    private typealias Engine = RelayTunRuntimeAssetChannel<Selection, Ticket, Observation>
    private let engine: Engine
    init?(binding: Binding, clientSHA256: String, installationRevision: String, driver: Driver,
          input: Int32 = 9, output: Int32 = 10, leaseSeconds: Int = 30,
          execute: @escaping (@escaping () -> Void) -> Void = { $0() }) {
        let codec = Engine.Codec(capability: Self.capability, frameLimit: Self.frameLimit,
            replaceFields: ["configurationRevision", "expectedGenerationSHA256", "provider", "oldSHA256", "newSHA256", "blobId", "kind", "bytes", "filename", "declaredRuleCount"],
            ticketFields: ["blobId", "kind", "sha256", "bytes", "filename"], replacement: Selection.init,
            ticket: { try Selection.ticket($0, hashKey: "sha256") }, snapshot: { observation in
                guard observation.configurationRevision == binding.runtimeConfigurationSHA256 else { throw Failure.unavailable }
                let ledger = observation.ledger
                return ["configurationRevision": observation.configurationRevision,
                    "generationSHA256": ledger.generationSHA256, "groups": ledger.groups,
                    "providers": ledger.resources.values.sorted { $0.binding.name < $1.binding.name }.map { row -> [String: Any] in
                        ["name": row.binding.name, "kind": "rule-" + row.binding.format.rawValue,
                         "behavior": row.binding.behavior.rawValue, "fileSHA256": row.fileSHA256,
                         "bytes": row.bytes, "ruleCount": row.ruleCount]
                    }]
            })
        let callbacks = Engine.Driver(read: driver.read, replace: { id, selection, context, done in
            driver.replace(id, selection, context) { reply in
                done(.init(status: reply.status == .published ? "updated" : reply.status.rawValue,
                    observation: reply.ledger.map { Observation(configurationRevision: selection.configurationRevision, ledger: $0) }))
            }
        }, cancelReplace: { driver.cancelReplace($0).status.rawValue }, discard: driver.discard, invalidate: driver.invalidate)
        guard let engine = Engine(binding: binding, clientSHA256: clientSHA256, installationRevision: installationRevision,
            codec: codec, driver: callbacks, input: input, output: output, leaseSeconds: leaseSeconds, execute: execute) else { return nil }
        self.engine = engine
    }
    func start() { engine.start() }
    func invalidate() { engine.invalidate() }
}
