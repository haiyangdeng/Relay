import Foundation

// Only these fixed messages may be surfaced from a failed preflight. Adapter
// errors can contain paths or URLs and remain redacted by the session boundary.
private enum RelayDesktopStartFailure: String, Error {
    case edgeMissing = "未找到身份匹配的 Microsoft Edge，未开始登录。"
    case claudeMissing = "未找到身份匹配的 Claude 桌面应用，未开始登录。"
    case edgePolicy = "Edge 强制代理策略未匹配；请在上方检查 Edge 策略，未开始登录。"
    case edgeRunning = "请先退出 Microsoft Edge，再开始登录；Relay 不会替你关闭浏览器。"
    case relayProxy = "Relay 固定节点专用代理未就绪；请在“Claude 与 Codex”启用专用 HTTP 和 SOCKS 17890，未开始登录。"
}

/// All mutating OS effects are mandatory adapters. There is deliberately no
/// implicit default environment. The persistent host supplies the live adapter.
struct RelayDesktopSessionEnvironment {
    var readOnly: RelayDesktopEnvironment
    var proxyReady: () async throws -> RelayBrowserBinding
    var identityAvailable: (RelayDesktopIdentity) -> Bool
    var setDefault: (RelayDesktopIdentity, String) async throws -> Void
    var openClaude: () async throws -> Void
}
struct RelayDesktopSessionSnapshot: Encodable {
    let phase: String
    let busy: Bool
    let hasRecord: Bool
    let source: String?
    let canClose: Bool
    let requiresRecoveryConsent: Bool
    let warnings: [String]
}

@MainActor
final class RelayDesktopSession {
    private let store: RelayDesktopStore
    private let environment: RelayDesktopSessionEnvironment
    private var phase = "idle"
    private var busy = false
    private var cancelRequested = false
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    private var warnings: [String] = []
    private var requiresRecoveryConsent = false

    init(store: RelayDesktopStore, environment: RelayDesktopSessionEnvironment) {
        self.store = store; self.environment = environment
    }
    private var closeSafe: Bool { phase == "idle" || (!store.locked && store.current == nil) }
    var snapshot: RelayDesktopSessionSnapshot {
        RelayDesktopSessionSnapshot(phase: phase, busy: busy, hasRecord: store.current != nil,
            source: store.current?.source, canClose: !busy && closeSafe, requiresRecoveryConsent: requiresRecoveryConsent, warnings: warnings)
    }
    private func pair() throws -> [String: RelayDesktopIdentity] {
        var result: [String: RelayDesktopIdentity] = [:]
        for scheme in RelayDesktopInspection.schemes {
            guard let value = environment.readOnly.currentDefault(scheme), value.valid else {
                throw AssistantError("无法完整核对默认应用。")
            }
            result[scheme] = value
        }
        return result
    }
    private func requireApplicationsAndBrowser(_ expected: RelayDesktopIdentity? = nil) throws -> RelayDesktopIdentity {
        let read = environment.readOnly
        guard let browser = read.loginBrowser(), browser == RelayDesktopInspection.edge,
              expected == nil || browser == expected,
              read.application(RelayDesktopInspection.edgeURL, browser.bundleIdentifier) else { throw RelayDesktopStartFailure.edgeMissing }
        guard read.application(RelayDesktopInspection.claudeURL, "com.anthropic.claudefordesktop") else { throw RelayDesktopStartFailure.claudeMissing }
        guard read.edgePoliciesReady() else { throw RelayDesktopStartFailure.edgePolicy }
        guard read.edgeClosed() else { throw RelayDesktopStartFailure.edgeRunning }
        return browser
    }
    private func requireEdgeProxy() async throws -> RelayBrowserBinding {
        do {
            let binding = try await environment.proxyReady()
            try binding.validate()
            guard binding.socksPort == RelayDesktopInspection.edgeProxyPort else { throw RelayDesktopStartFailure.relayProxy }
            return binding
        } catch { throw RelayDesktopStartFailure.relayProxy }
    }
    private func requireNotCancelled() throws {
        guard !cancelRequested else { throw AssistantError("已请求取消登录。") }
    }
    private func paired(_ current: [String: RelayDesktopIdentity], _ record: RelayDesktopRecord) -> Bool {
        record.originals["http"] == record.originals["https"] && RelayDesktopInspection.schemes.allSatisfy {
            current[$0] == record.originals[$0] || current[$0] == record.temporaryApplication
        }
    }
    private func endOperation() {
        busy = false
        let waiters = idleWaiters; idleWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
    func whenIdle() async {
        if busy { await withCheckedContinuation { idleWaiters.append($0) } }
    }
    func requestCancel() { cancelRequested = true }

    func start() async -> RelayDesktopSessionSnapshot {
        guard !busy, phase == "idle" else { return snapshot }
        busy = true; cancelRequested = false; phase = "starting"; warnings = []
        defer { endOperation() }
        do {
            try store.acquire(); try store.resume()
            if store.current != nil {
                requiresRecoveryConsent = true
                phase = "recoveryNeeded"
                warnings = ["发现待恢复登录记录，未开始新登录；须单独确认恢复。"]
            } else {
                try store.assertNoState()
                let browser = try requireApplicationsAndBrowser()
                let binding = try await requireEdgeProxy()
                try requireNotCancelled(); _ = try requireApplicationsAndBrowser(browser)
                let originals = try pair()
                guard originals["http"] == originals["https"] else { throw AssistantError("原默认应用不一致。") }
                let captured = RelayDesktopRecord(version: 1, sessionID: UUID().uuidString,
                    createdAt: ISO8601DateFormatter().string(from: Date()), originals: originals,
                    temporaryApplication: browser, attemptedSchemes: [], phase: "starting")
                // Durable original state precedes every possible setter, even
                // when one macOS setter also changes the other scheme.
                try store.save(captured, initial: true)
                for scheme in RelayDesktopInspection.schemes {
                    try requireNotCancelled(); try store.assertCurrent()
                    var saved = store.current!.record
                    let current = try pair()
                    guard paired(current, saved) else { throw AssistantError("默认应用发生外部更改。") }
                    if current[scheme] == saved.temporaryApplication {
                        guard saved.originals[scheme] == saved.temporaryApplication || saved.attemptedSchemes.contains(scheme) else {
                            throw AssistantError("临时默认应用并非本会话设置。")
                        }
                        continue
                    }
                    guard environment.identityAvailable(saved.temporaryApplication) else { throw AssistantError("临时应用已移动或身份变化。") }
                    if saved.attemptedSchemes.isEmpty {
                        saved = saved.updating(phase: "starting", attempted: RelayDesktopInspection.schemes)
                        try store.save(saved)
                    }
                    try requireNotCancelled(); try store.assertCurrent()
                    guard paired(try pair(), saved) else { throw AssistantError("默认应用在写入前改变。") }
                    guard try await requireEdgeProxy() == binding else { throw AssistantError("Relay 专用代理运行实例已变化。") }
                    try requireNotCancelled(); try store.assertCurrent()
                    _ = try requireApplicationsAndBrowser(browser)
                    guard paired(try pair(), saved) else { throw AssistantError("默认应用在代理核对期间改变。") }
                    try await environment.setDefault(saved.temporaryApplication, scheme)
                    guard try pair()[scheme] == saved.temporaryApplication else { throw AssistantError("默认应用切换结果未确认。") }
                }
                try requireNotCancelled(); _ = try requireApplicationsAndBrowser(browser)
                guard try await requireEdgeProxy() == binding else { throw AssistantError("Relay 专用代理运行实例已变化。") }
                try requireNotCancelled(); _ = try requireApplicationsAndBrowser(browser); try store.assertCurrent()
                guard try pair().values.allSatisfy({ $0 == captured.temporaryApplication }) else { throw AssistantError("默认应用最终核对失败。") }
                try store.save(store.current!.record.updating(phase: "active"))
                try requireNotCancelled()
                try await environment.openClaude()
                try requireNotCancelled()
                phase = "active"
                warnings = ["Edge 登录会话已建立；使用 Relay 的固定节点专用 SOCKS 17890，结束后请恢复原默认浏览器。"]
            }
        } catch {
            let preflightWarning = (error as? RelayDesktopStartFailure)?.rawValue
            if store.current != nil {
                let restored = await restoreOwnedRecord()
                warnings = [restored ? "登录未完成，已核对恢复原默认浏览器。" : "登录未完成，恢复尚未完成；记录与会话锁保留，不能直接退出。"]
            } else {
                // An unadopted/invalid record or a lost lease is not silently
                // dismissed as a clean preflight failure.
                do {
                    try store.assertNoState()
                    phase = "idle"; store.release()
                    warnings = [preflightWarning ?? "登录前置条件未满足，未开始登录。"]
                } catch {
                    phase = "blocked"
                    warnings = ["会话锁或恢复记录待处理，未继续登录；不得自动覆盖或删除。"]
                }
            }
        }
        // defer ends busy after this value is constructed; return a completed
        // snapshot explicitly rather than advertising a stale busy=true.
        return completedSnapshot()
    }
    private func completedSnapshot() -> RelayDesktopSessionSnapshot {
        RelayDesktopSessionSnapshot(phase: phase, busy: false, hasRecord: store.current != nil,
            source: store.current?.source, canClose: closeSafe, requiresRecoveryConsent: requiresRecoveryConsent, warnings: warnings)
    }

    private func restoreOwnedRecord() async -> Bool {
        phase = "restoring"
        guard let saved = store.current?.record else { phase = "blocked"; return false }
        do {
            if store.removalPending {
                guard try pair() == saved.originals else { throw AssistantError("删除待核对期间默认应用再次改变。") }
                try store.completeRemoval()
            } else {
                try store.assertCurrent()
                // A stage-write failure must not strand a recoverable default.
                // Continue only if the exact previous cursor remains valid.
                do { try store.save(saved.updating(phase: "restoring")) }
                catch { try store.assertCurrent() }
                for scheme in RelayDesktopInspection.schemes {
                    try store.assertCurrent()
                    let current = try pair(), original = saved.originals[scheme]!
                    if current[scheme] == original { continue }
                    guard saved.attemptedSchemes.contains(scheme), current[scheme] == saved.temporaryApplication,
                          paired(current, saved), environment.identityAvailable(original) else {
                        throw AssistantError("原应用不可用或存在外部更改，停止覆盖。")
                    }
                    try store.assertCurrent()
                    guard paired(try pair(), saved) else { throw AssistantError("恢复前默认应用再次改变。") }
                    try await environment.setDefault(original, scheme)
                    guard try pair()[scheme] == original else { throw AssistantError("恢复结果未确认。") }
                }
                guard try pair() == saved.originals else { throw AssistantError("两项默认应用尚未恢复。") }
                try store.assertCurrent(); try store.remove()
            }
            phase = "idle"; store.release()
            return true
        } catch {
            phase = "recoveryNeeded"
            return false
        }
    }
    func restore() async -> RelayDesktopSessionSnapshot {
        guard !busy else { return snapshot }
        requiresRecoveryConsent = false
        busy = true; warnings = []
        defer { endOperation() }
        do {
            try store.acquire(); try store.resume()
            if store.current == nil {
                try store.assertNoState(); phase = "idle"; store.release()
                warnings = ["没有待恢复登录记录。"]
            } else {
                let restored = await restoreOwnedRecord()
                warnings = [restored ? "已核对两项默认应用恢复，记录处理完成。" : "恢复未完成，记录与锁已保留；请处理后重试，不能直接退出。"]
            }
        } catch {
            phase = store.current == nil ? "blocked" : "recoveryNeeded"
            warnings = ["恢复记录或会话锁无法核对，未执行覆盖。"]
        }
        return completedSnapshot()
    }
    func cancelAndRestore() async -> RelayDesktopSessionSnapshot {
        if requiresRecoveryConsent { return snapshot }
        requestCancel()
        await whenIdle()
        if requiresRecoveryConsent { return snapshot }
        return await restore()
    }
    func requestClose() async -> Bool {
        if requiresRecoveryConsent { return false }
        // A never-started instance, or one that failed to obtain another
        // owner's lease, must not create state or take over recovery on quit.
        if !busy && !store.locked && store.current == nil { return true }
        let result = await cancelAndRestore()
        return result.canClose
    }
}
