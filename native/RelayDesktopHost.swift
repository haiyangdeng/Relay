import Foundation

struct RelayDesktopWireRequest: Decodable {
    let id: Int
    let action: String
    let context: RelayStateContext?

    static func decode(_ data: Data) throws -> Self {
        guard data.count <= 65536, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let request = try? JSONDecoder().decode(Self.self, from: data),
              request.id > 0, request.id <= 1_000_000_000,
              ["initialize", "status", "start", "restore", "cancel", "close"].contains(request.action),
              Set(object.keys) == (request.action == "initialize" ? Set(["id", "action", "context"]) : Set(["id", "action"])),
              (request.action == "initialize") == (request.context != nil) else {
            throw AssistantError("登录会话消息无效。")
        }
        return request
    }
}
struct RelayDesktopWireResponse: Encodable {
    let version = 1
    let id: Int
    let snapshot: RelayDesktopSessionSnapshot
    let closing: Bool
}

/// Accept messages synchronously in stream order; asynchronous OS operations
/// remain cancellable while the main actor processes later control messages.
@MainActor
final class RelayDesktopHost {
    private let factory: (RelayStateContext) throws -> RelayDesktopSession
    private let emit: (RelayDesktopWireResponse) -> Void
    private let ended: (Int32) -> Void
    private var session: RelayDesktopSession?
    private var lastID = 0
    private var work: Task<RelayDesktopSessionSnapshot, Never>?
    private var stop: Task<Bool, Never>?
    private var queuedPhase: String?
    private var stopRequested = false
    private var disconnected = false
    private var finished = false
    private var protocolFailed = false
    private var closeIntent = false
    private var controls: [(Int, String)] = []
    var signalSources: [DispatchSourceSignal] = []

    init(factory: @escaping (RelayStateContext) throws -> RelayDesktopSession,
         emit: @escaping (RelayDesktopWireResponse) -> Void, ended: @escaping (Int32) -> Void) {
        self.factory = factory; self.emit = emit; self.ended = ended
    }
    private var snapshot: RelayDesktopSessionSnapshot? {
        guard let snapshot = session?.snapshot else { return nil }
        if let queuedPhase, work != nil || stop != nil {
            return RelayDesktopSessionSnapshot(phase: queuedPhase, busy: true, hasRecord: snapshot.hasRecord,
                source: snapshot.source, canClose: false, requiresRecoveryConsent: snapshot.requiresRecoveryConsent, warnings: snapshot.warnings)
        }
        return snapshot
    }
    private func finish(_ code: Int32) {
        if !finished { finished = true; signalSources.forEach { $0.cancel() }; signalSources.removeAll(); ended(protocolFailed ? 2 : code) }
    }
    private func respond(_ id: Int, _ snapshot: RelayDesktopSessionSnapshot, closing: Bool = false) {
        if !finished && !disconnected { emit(RelayDesktopWireResponse(id: id, snapshot: snapshot, closing: closing)) }
    }
    func accept(_ data: Data) {
        guard !finished && !disconnected else { return }
        do {
            let request = try RelayDesktopWireRequest.decode(data)
            guard request.id > lastID else { throw AssistantError("会话消息编号重复或倒退。") }
            lastID = request.id
            if request.action == "initialize" {
                guard session == nil, request.id == 1, let context = request.context else { throw AssistantError("会话不能重新初始化。") }
                session = try factory(context)
                respond(request.id, session!.snapshot)
                return
            }
            guard let session else { throw AssistantError("会话尚未初始化。") }
            if request.action == "status" { respond(request.id, snapshot!); return }
            if ["start", "restore"].contains(request.action) {
                guard work == nil && stop == nil && !closeIntent else { respond(request.id, snapshot!); return }
                stopRequested = false; queuedPhase = request.action == "start" ? "starting" : "restoring"
                let task = Task { @MainActor in
                    let value: RelayDesktopSessionSnapshot
                    if self.stopRequested { value = session.snapshot }
                    else { value = request.action == "start" ? await session.start() : await session.restore() }
                    self.work = nil
                    if self.stop == nil { self.queuedPhase = nil }
                    self.respond(request.id, value)
                    return value
                }
                work = task
            } else {
                controls.append((request.id, request.action))
                if request.action == "close" { closeIntent = true }
                if stop != nil { return }
                let task = stopping()
                Task { @MainActor in
                    let allowed = await task.value
                    let requests = self.controls; self.controls.removeAll()
                    let final = session.snapshot
                    self.stop = nil; self.queuedPhase = nil
                    for (id, action) in requests { self.respond(id, final, closing: action == "close" && allowed) }
                    if self.closeIntent && allowed { self.finish(0) }
                    else { self.closeIntent = false }
                }
            }
        } catch { disconnect(failed: true) }
    }
    private func stopping() -> Task<Bool, Never> {
        if let stop { return stop }
        stopRequested = true; queuedPhase = "restoring"
        session?.requestCancel()
        let pending = work
        let task = Task { @MainActor in
            _ = await pending?.value
            guard let session = self.session else { return true }
            return await session.requestClose()
        }
        stop = task
        return task
    }
    func disconnect(failed: Bool = false) {
        protocolFailed = protocolFailed || failed
        guard !finished && !disconnected else { return }
        disconnected = true
        let task = stopping()
        Task { @MainActor in
            let allowed = await task.value
            // An orphan cannot ask its parent for help. Leave the durable
            // journal for a fresh, explicitly confirmed recovery if this fails.
            self.finish(allowed && !self.protocolFailed ? 0 : 2)
        }
    }
}
