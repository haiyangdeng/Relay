import Foundation
import Security

/// Private Smart handoff only. This stamp owns no file, process or system
/// lease; every method is a fast in-memory operation under its own lock.
final class RelayTunSmartStateHandoff {
    typealias State = RelayTunSmartStateV1
    enum Failure: Error { case invalid, busy, revoked, state }
    struct Snapshot {
        let result: State.Result
        let executionSHA256: String
        let resultSHA256: String
        var committedRevision: String?
        var cleanupNonce: String?
        var json: [String: Any] {
            var value: [String: Any] = ["version": 1, "key": result.key,
                "previousRevision": result.previousRevision.map { $0 as Any } ?? NSNull(),
                "executionSHA256": executionSHA256, "resultSHA256": resultSHA256,
                "files": result.files.map { ["path": $0.path.rawValue, "sha256": $0.sha256, "size": $0.size] as [String: Any] }]
            if let committedRevision { value["committedRevision"] = committedRevision }
            if let cleanupNonce { value["cleanupNonce"] = cleanupNonce }
            return value
        }
    }
    struct Acknowledgement: Equatable {
        let executionSHA256: String, key: String, resultSHA256: String, committedRevision: String
        init(_ raw: [String: Any]) throws {
            func hash(_ name: String) throws -> String {
                guard let value = raw[name] as? String, RelayTunRuntimeResources.hash(value) else { throw Failure.invalid }
                return value
            }
            executionSHA256 = try hash("executionSHA256"); key = try hash("key")
            resultSHA256 = try hash("resultSHA256"); committedRevision = try hash("committedRevision")
        }
    }
    enum ExportClaim { case existing(Snapshot), start(UInt64) }
    private let lock = NSLock()
    private let executionSHA256: String, key: String
    private var began = false, worker = false, revoked = false, closing = false
    private var snapshot: Snapshot?
    private var pending: (Acknowledgement, String)?
    private var granted = false
    init(executionSHA256: String, key: String) throws {
        guard RelayTunRuntimeResources.hash(executionSHA256), RelayTunRuntimeResources.hash(key) else { throw Failure.invalid }
        self.executionSHA256 = executionSHA256; self.key = key
    }
    var workerPending: Bool { lock.lock(); defer { lock.unlock() }; return worker }
    var cleanupGranted: Bool { lock.lock(); defer { lock.unlock() }; return granted && !worker }
    func beginExport() throws -> ExportClaim {
        lock.lock(); defer { lock.unlock() }
        guard !revoked, !closing else { throw Failure.revoked }
        if let snapshot { return .existing(snapshot) }
        guard !worker else { throw Failure.busy }
        guard !began else { throw Failure.state }
        began = true; worker = true; return .start(1)
    }
    func checkExport(_ stamp: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        guard stamp == 1, worker, !revoked, !closing else { throw Failure.revoked }
    }
    func finishExport(_ stamp: UInt64, snapshot: Snapshot?) throws {
        lock.lock(); defer { lock.unlock() }
        guard stamp == 1, worker else { throw Failure.state }
        worker = false
        guard !revoked, !closing else { throw Failure.revoked }
        guard let snapshot, snapshot.executionSHA256 == executionSHA256,
              snapshot.result.key == key, RelayTunRuntimeResources.hash(snapshot.resultSHA256),
              snapshot.cleanupNonce == nil, snapshot.committedRevision == nil else { throw Failure.state }
        self.snapshot = snapshot
    }
    func acknowledge(_ acknowledgement: Acknowledgement) throws -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        guard !worker, !revoked, !closing, var snapshot,
              acknowledgement.executionSHA256 == executionSHA256, acknowledgement.key == key,
              acknowledgement.resultSHA256 == snapshot.resultSHA256 else { throw Failure.state }
        let nonce: String
        if let pending {
            guard pending.0 == acknowledgement else { throw Failure.state }; nonce = pending.1
        } else {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure.state }
            nonce = bytes.map { String(format: "%02x", $0) }.joined(); pending = (acknowledgement, nonce)
        }
        // A response written to a pipe is not proof that Main received it.
        // Only a subsequent bound control dispose can return this nonce.
        snapshot.committedRevision = acknowledgement.committedRevision; snapshot.cleanupNonce = nonce
        return snapshot
    }
    @discardableResult func beginDisposal(cleanupNonce: String?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        closing = true; revoked = true
        granted = !worker && snapshot != nil && cleanupNonce != nil && cleanupNonce == pending?.1
        return granted
    }
    func invalidatePublication() { lock.lock(); revoked = true; lock.unlock() }
}

/// A thin codec/driver adapter over the mature bounded inherited-pipe engine.
/// It owns FD7/8 only and never enters the control/recovery lifecycle.
final class RelayTunSmartStateChannel {
    typealias Model = RelayTunSmartStateHandoff
    struct DisabledTicket { fileprivate init() {} }
    typealias Engine = RelayTunRuntimeAssetChannel<Model.Acknowledgement, DisabledTicket, Model.Snapshot>
    typealias Context = Engine.Context
    struct Driver {
        let export: (Context, @escaping (Result<Model.Snapshot, Error>) -> Void) -> Void
        let acknowledge: (Model.Acknowledgement, Context) throws -> Model.Snapshot
        let invalidate: () -> Void
    }
    private let engine: Engine
    init?(binding: Engine.Binding, clientSHA256: String, installationRevision: String, driver: Driver,
          input: Int32 = 7, output: Int32 = 8, leaseSeconds: Int = 30) {
        var codec = Engine.Codec(capability: "smart-state-v1", frameLimit: 8192,
            replaceFields: ["executionSHA256", "key", "resultSHA256", "committedRevision"], ticketFields: [],
            replacement: { try .init($0) }, ticket: { _ in throw Engine.Failure.invalid }, snapshot: { $0.json })
        codec.readAction = "export"; codec.replaceAction = "ack"; codec.allowDiscard = false
        codec.readStatus = "exported"; codec.replaceSuccessStatuses = ["acknowledged"]
        guard let engine = Engine(binding: binding, clientSHA256: clientSHA256, installationRevision: installationRevision,
            codec: codec, driver: .init(read: driver.export, replace: { _, acknowledgement, context, done in
                do { try context.check(); done(.init(status: "acknowledged", observation: try driver.acknowledge(acknowledgement, context))) }
                catch { done(.init(status: "unavailable")) }
            }, cancelReplace: { _ in "cancelled" }, discard: { _, _, done in done(.failure(Engine.Failure.unsupported)) },
            invalidate: driver.invalidate), input: input, output: output, leaseSeconds: leaseSeconds) else { return nil }
        self.engine = engine
    }
    func start() { engine.start() }
    func invalidate() { engine.invalidate() }
    func invalidateAndDrain() -> Bool { engine.invalidateAndDrain() }
}
