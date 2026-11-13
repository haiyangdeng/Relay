// macOS 13+. Build as an ordinary, non-sandboxed Cocoa app.
// Integrated desktop-login coordinator. Changes defaults only after Start is clicked.
// --status is read-only. --self-test uses only in-memory data.
// Normal termination/SIGINT/SIGTERM requests restoration; SIGKILL/power loss
// cannot run cleanup, so a durable recovery record is written before changes.
import AppKit
import CoreServices
import CoreFoundation
import Foundation
import Network
import Darwin

private let schemes = ["http", "https"]
private let edgeURL = URL(fileURLWithPath: "/Applications/Microsoft Edge.app", isDirectory: true)
private let claudeURL = URL(fileURLWithPath: "/Applications/Claude.app", isDirectory: true)
private let edgePolicyDomain = "com.microsoft.Edge"
private let expectedProxy = "socks5://127.0.0.1:17890"

private struct LoginError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

private struct AppIdentity: Codable, Equatable {
    let bundleIdentifier: String
    let appURL: String
}

private func canonicalApplicationURL(_ url: URL) -> URL {
    URL(fileURLWithPath: url.resolvingSymlinksInPath().standardizedFileURL.path, isDirectory: true)
}

private struct RecoveryState: Codable {
    let version: Int
    let sessionID: String
    let createdAt: String
    let originals: [String: AppIdentity]
    let temporaryApplication: AppIdentity
    // Both schemes are persisted BEFORE the first setter: macOS can change
    // HTTP and HTTPS together, even if only one scheme was requested.
    var attemptedSchemes: [String]
    var phase: String
}

private enum RestoreDecision: Equatable {
    case alreadyOriginal, restore, leaveExternalChange
}

private func restoreDecision(original: AppIdentity, current: AppIdentity,
                             temporary: AppIdentity, attempted: Bool) -> RestoreDecision {
    if current == original { return .alreadyOriginal }
    if attempted && current == temporary { return .restore }
    return .leaveExternalChange
}

private enum SwitchDecision: Equatable {
    case alreadyTemporary, switchToTemporary, leaveExternalChange
}

private func switchDecision(original: AppIdentity, current: AppIdentity,
                            temporary: AppIdentity) -> SwitchDecision {
    if current == temporary { return .alreadyTemporary }
    if current == original { return .switchToTemporary }
    return .leaveExternalChange
}

private func hasSharedOriginals(_ originals: [String: AppIdentity]) -> Bool {
    guard Set(originals.keys) == Set(schemes), let original = originals["http"] else { return false }
    return originals["https"] == original
}

// Before either setter, protect BOTH schemes against collateral overwrites.
private func canSetPairedDefaults(originals: [String: AppIdentity],
                                  current: [String: AppIdentity], temporary: AppIdentity) -> Bool {
    hasSharedOriginals(originals) && Set(current.keys) == Set(schemes)
        && schemes.allSatisfy { current[$0] == originals[$0] || current[$0] == temporary }
}

private struct PolicyResult: Codable {
    let key: String
    let forced: Bool
    let valueMatches: Bool
    var valid: Bool { forced && valueMatches }
}

// Pure validation, shared by live preflight and --self-test. Only loopback
// bypasses are accepted; a public-domain/direct fallback would defeat scope.
private func policyValueMatches(_ key: String, _ value: Any?) -> Bool {
    switch key {
    case "ProxySettings":
        guard let dict = value as? [String: Any],
              dict["ProxyMode"] as? String == "fixed_servers",
              dict["ProxyServer"] as? String == expectedProxy else { return false }
        if let raw = dict["ProxyBypassList"] {
            guard let bypass = raw as? String else { return false }
            let allowed: Set<String> = ["localhost", "*.localhost", "127.0.0.1", "[::1]", "::1"]
            let entries = bypass.components(separatedBy: CharacterSet(charactersIn: ",;"))
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            guard entries.allSatisfy({ allowed.contains($0) }) else { return false }
        }
        return true
    case "DnsOverHttpsMode":
        return value as? String == "off"
    case "WebRtcLocalhostIpHandling":
        return value as? String == "disable_non_proxied_udp"
    case "NetworkPredictionOptions":
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue == 2
    default:
        return false
    }
}

private func readPolicies() -> [PolicyResult] {
    ["ProxySettings", "DnsOverHttpsMode", "WebRtcLocalhostIpHandling", "NetworkPredictionOptions"].map { key in
        let forced = CFPreferencesAppValueIsForced(key as CFString, edgePolicyDomain as CFString)
        let value = CFPreferencesCopyAppValue(key as CFString, edgePolicyDomain as CFString)
        return PolicyResult(key: key, forced: forced, valueMatches: policyValueMatches(key, value))
    }
}

@MainActor
private func applicationIdentity(at url: URL) throws -> AppIdentity {
    guard url.isFileURL, let bundle = Bundle(url: url),
          let identifier = bundle.bundleIdentifier, !identifier.isEmpty else {
        throw LoginError("无法确认应用身份：\(url.path)")
    }
    return AppIdentity(bundleIdentifier: identifier,
                       appURL: canonicalApplicationURL(url).absoluteString)
}

@MainActor
private func currentDefault(_ scheme: String) throws -> AppIdentity {
    // This asks Launch Services only; it does not navigate to this URL.
    guard let copied = LSCopyDefaultHandlerForURLScheme(scheme as CFString),
          let queryURL = URL(string: "\(scheme)://localhost/"),
          let appURL = NSWorkspace.shared.urlForApplication(toOpen: queryURL) else {
        throw LoginError("无法读取 \(scheme.uppercased()) 原默认应用，未进行切换。")
    }
    let identifier = copied.takeRetainedValue() as String
    let identity = try applicationIdentity(at: appURL)
    guard identity.bundleIdentifier == identifier else {
        throw LoginError("\(scheme.uppercased()) 默认应用查询结果不一致，请稍后重试。")
    }
    return identity
}

@MainActor
private func setDefault(_ application: AppIdentity, for scheme: String) async throws {
    guard let url = URL(string: application.appURL), url.isFileURL,
          try applicationIdentity(at: url) == application else {
        throw LoginError("保存的应用已移动或身份变化：\(application.appURL)")
    }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        NSWorkspace.shared.setDefaultApplication(at: url, toOpenURLsWithScheme: scheme,
                                                completion: { error in
            if let error { continuation.resume(throwing: error) }
            else { continuation.resume() }
        })
    }
    guard try currentDefault(scheme) == application else {
        throw LoginError("\(scheme.uppercased()) 默认应用未变为预期值；将尝试恢复。")
    }
}

// Each call owns one private serial queue, so timeout and NWConnection state
// changes cannot resume the continuation twice. No HTTP request is sent.
private func checkLocalProxy() async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let queue = DispatchQueue(label: "ClaudeDesktopLogin.proxy-check")
        let connection = NWConnection(host: "127.0.0.1", port: 17890, using: .tcp)
        var finished = false
        let finish: (Error?) -> Void = { error in
            guard !finished else { return }
            finished = true
            connection.stateUpdateHandler = nil
            connection.cancel()
            if let error { continuation.resume(throwing: error) }
            else { continuation.resume() }
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready: finish(nil)
            case .failed(let error): finish(LoginError("本地代理 127.0.0.1:17890 无法连接：\(error.localizedDescription)"))
            default: break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 3) {
            finish(LoginError("本地代理 127.0.0.1:17890 连接超时。请先检查 Clash Party。"))
        }
    }
}

private final class RecoveryStore {
    let directory: URL
    let stateURL: URL
    private var lockFD: Int32 = -1
    private let fileManager = FileManager.default

    init() {
        directory = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Claude Desktop Login", isDirectory: true)
        stateURL = directory.appendingPathComponent("state.json")
    }

    deinit { if lockFD >= 0 { Darwin.close(lockFD) } }

    var exists: Bool {
        var info = stat()
        return lstat(stateURL.path, &info) == 0
    }

    private func systemError(_ action: String) -> LoginError {
        LoginError("\(action)：\(String(cString: strerror(errno)))")
    }

    // Acquired by GUI only. CLI read-only modes never call this method.
    func lock() throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: NSNumber(value: 0o700)])
        var info = stat()
        guard lstat(directory.path, &info) == 0,
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR), info.st_uid == getuid() else {
            throw LoginError("恢复目录不是当前用户拥有的普通目录，拒绝操作。")
        }
        guard chmod(directory.path, 0o700) == 0 else { throw systemError("无法保护恢复目录") }
        let lockURL = directory.appendingPathComponent(".lock")
        let descriptor = Darwin.open(lockURL.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw systemError("无法创建恢复锁") }
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              fchmod(descriptor, 0o600) == 0, flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(descriptor)
            throw LoginError("另一个登录辅助入口正在运行，或恢复锁不可用。请使用已打开的窗口。")
        }
        lockFD = descriptor
    }

    func load() throws -> RecoveryState? {
        guard exists else { return nil }
        let descriptor = Darwin.open(stateURL.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw systemError("无法读取恢复记录") }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              (info.st_mode & 0o777) == 0o600, info.st_size <= 64 * 1024 else {
            throw LoginError("恢复记录的所有者、权限或格式异常；记录已保留，禁止开始新登录。")
        }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        var count = 0
        while count < bytes.count {
            let received = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(descriptor, buffer.baseAddress!.advanced(by: count), buffer.count - count)
            }
            if received < 0 && errno == EINTR { continue }
            guard received > 0 else { throw LoginError("恢复记录不完整，已保留且未修改系统。") }
            count += received
        }
        let state = try JSONDecoder().decode(RecoveryState.self, from: Data(bytes))
        guard state.version == 1, UUID(uuidString: state.sessionID) != nil,
              Set(state.originals.keys) == Set(schemes),
              Set(state.attemptedSchemes).isSubset(of: Set(schemes)),
              state.temporaryApplication.bundleIdentifier == "com.microsoft.edgemac",
              state.temporaryApplication.appURL == canonicalApplicationURL(edgeURL).absoluteString,
              state.originals.values.allSatisfy({ URL(string: $0.appURL)?.isFileURL == true && !$0.bundleIdentifier.isEmpty }) else {
            throw LoginError("恢复记录内容不符合预期；保留记录并禁止新登录。")
        }
        return state
    }

    // Temporary files are created 0600 from their first byte. link() publishes
    // initial state atomically and fails if ANY existing state is present.
    func save(_ state: RecoveryState, initial: Bool = false) throws {
        guard lockFD >= 0 else { throw LoginError("没有恢复锁，拒绝写入。") }
        if !initial {
            guard try load()?.sessionID == state.sessionID else {
                throw LoginError("恢复记录已被外部改变，拒绝覆盖。")
            }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(state)
        let temporaryURL = directory.appendingPathComponent(".state-\(UUID().uuidString).tmp")
        let descriptor = Darwin.open(temporaryURL.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw systemError("无法保存恢复记录") }
        defer { Darwin.close(descriptor); unlink(temporaryURL.path) }
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw systemError("恢复记录写入失败") }
                offset += written
            }
        }
        guard fchmod(descriptor, 0o600) == 0, fsync(descriptor) == 0 else {
            throw systemError("恢复记录持久化失败")
        }
        let result = initial ? link(temporaryURL.path, stateURL.path) : rename(temporaryURL.path, stateURL.path)
        guard result == 0 else { throw systemError("发布恢复记录失败（已有记录不会被覆盖）") }
        guard try load()?.sessionID == state.sessionID else { throw LoginError("恢复记录写入后校验失败。") }
    }

    func remove(sessionID: String) throws {
        guard lockFD >= 0, try load()?.sessionID == sessionID else {
            throw LoginError("恢复记录已变化，不能删除。")
        }
        guard unlink(stateURL.path) == 0 else { throw systemError("已恢复默认浏览器，但无法删除恢复记录") }
    }
}

@MainActor
final class DesktopLoginCoordinator: NSObject, NSWindowDelegate {
    private let store = RecoveryStore()
    private var state: RecoveryState?
    private var ownsRecoveryLock = false
    private var blockingError: String?
    private var busy = false
    private var cancelRequested = false
    private var awaitingTerminationReply = false
    private var permitTermination = false
    private var prepared = false
    private var closeRequested = false
    private var signalSources: [DispatchSourceSignal] = []
    private var window: NSWindow!
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let details = NSTextView()
    private let startButton = NSButton(title: "开始登录", target: nil, action: nil)
    private let finishButton = NSButton(title: "完成登录并恢复", target: nil, action: nil)
    private let cancelButton = NSButton(title: "取消并恢复", target: nil, action: nil)

    func prepare() {
        guard !prepared else { return }
        prepared = true
        buildWindow()
        do {
            try store.lock()
            ownsRecoveryLock = true
            state = try store.load()
            if let state {
                log("发现未恢复记录（\(state.createdAt)）。请先点击“恢复原默认浏览器”，不会覆盖原记录。")
            } else {
                log("尚未修改默认浏览器。只有点击“开始登录”后才会切换。")
            }
        } catch {
            blockingError = error.localizedDescription
            log("不能开始：\(error.localizedDescription)")
        }
        installTerminationSignals()
        refreshUI()
        if state != nil || (ownsRecoveryLock && store.exists) { present() }
    }

    func present() {
        prepare()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 530),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "AI 网络助手 · Claude 桌面登录"
        window.center()
        window.delegate = self
        let intro = NSTextField(wrappingLabelWithString:
            "登录期间临时把 HTTP / HTTPS 默认浏览器改为专用 Edge。其他应用在此期间打开的网页也会进入 Edge。\n\n请先完全退出 Edge，并使用未登录微软账号的专用配置；部分隐私策略不适用于微软个人账号。辅助入口只打开 Claude 应用，登录由你操作。结束后请点“完成登录并恢复”。")
        intro.font = .systemFont(ofSize: 14)
        statusLabel.font = .boldSystemFont(ofSize: 14)
        startButton.target = self; startButton.action = #selector(startLogin)
        finishButton.target = self; finishButton.action = #selector(finishLogin)
        cancelButton.target = self; cancelButton.action = #selector(cancelLogin)
        let buttons = NSStackView(views: [startButton, finishButton, cancelButton])
        buttons.orientation = .horizontal; buttons.spacing = 10
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        details.isEditable = false
        details.isSelectable = true
        details.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        details.autoresizingMask = [.width]
        details.textContainer?.widthTracksTextView = true
        scroll.documentView = details
        let footer = NSTextField(wrappingLabelWithString:
            "不会操作账号、读取凭据或修改 Chrome / Claude Code。强制结束进程或断电后，请重新打开本入口恢复。")
        footer.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [intro, statusLabel, buttons, scroll, footer])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 15
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -22),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -22),
            intro.widthAnchor.constraint(equalTo: stack.widthAnchor),
            statusLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])

    }

    private func log(_ text: String) {
        details.string += (details.string.isEmpty ? "" : "\n\n") + text
        details.scrollToEndOfDocument(nil)
    }

    private func refreshUI() {
        startButton.isEnabled = !busy && state == nil && blockingError == nil && !store.exists
        finishButton.isEnabled = !busy && state != nil
        cancelButton.isEnabled = state != nil || busy
        finishButton.title = state?.phase == "active" ? "完成登录并恢复" : "恢复原默认浏览器"
        if let blockingError { statusLabel.stringValue = "需要处理：\(blockingError)" }
        else if busy { statusLabel.stringValue = cancelRequested ? "正在取消并恢复，请勿强制退出…" : "正在处理；请留意系统确认窗口…" }
        else if state != nil { statusLabel.stringValue = "存在待恢复记录。结束登录后请恢复原默认浏览器。" }
        else { statusLabel.stringValue = "未处于临时登录状态。" }
    }

    private func requireNotCancelled() throws {
        if cancelRequested { throw LoginError("已取消登录。") }
    }

    private func requirePolicies() throws {
        let failed = readPolicies().filter { !$0.valid }
        guard failed.isEmpty else {
            throw LoginError("Edge 强制策略不符合要求：\(failed.map { "\($0.key)（forced=\($0.forced)，value=\($0.valueMatches)）" }.joined(separator: "、"))。没有启动登录。")
        }
    }

    @objc private func startLogin() {
        guard !busy, state == nil, blockingError == nil, !store.exists else { return }
        busy = true; cancelRequested = false; refreshUI()
        Task { @MainActor in
            do {
                let edge = try applicationIdentity(at: edgeURL)
                guard edge.bundleIdentifier == "com.microsoft.edgemac" else { throw LoginError("Microsoft Edge 应用身份不符。") }
                _ = try applicationIdentity(at: claudeURL)
                guard NSRunningApplication.runningApplications(withBundleIdentifier: edge.bundleIdentifier).isEmpty else {
                    throw LoginError("请先在 Edge 菜单中选择“退出 Microsoft Edge”，再开始登录。WebRTC 策略需要重新启动 Edge 才能可靠加载。")
                }
                try requirePolicies()
                try await checkLocalProxy()
                try requireNotCancelled()
                guard !store.exists else { throw LoginError("已有未恢复记录，禁止覆盖。") }
                var originals: [String: AppIdentity] = [:]
                for scheme in schemes { originals[scheme] = try currentDefault(scheme) }
                guard hasSharedOriginals(originals) else {
                    throw LoginError("HTTP 与 HTTPS 当前使用不同默认应用。macOS 可能关联切换两者，为保护现有设置，本入口不会更改默认浏览器。")
                }
                let captured = RecoveryState(version: 1, sessionID: UUID().uuidString,
                                             createdAt: ISO8601DateFormatter().string(from: Date()),
                                             originals: originals, temporaryApplication: edge,
                                             attemptedSchemes: [], phase: "starting")
                try store.save(captured, initial: true)
                state = captured
                log("已安全保存原默认浏览器：\(originals.map { "\($0.key)=\($0.value.bundleIdentifier)" }.sorted().joined(separator: "；"))")
                for scheme in schemes {
                    try requireNotCancelled()
                    guard let original = state?.originals[scheme] else { throw LoginError("缺少原默认应用记录。") }
                    switch switchDecision(original: original, current: try currentDefault(scheme), temporary: edge) {
                    case .alreadyTemporary:
                        // A preceding setter may already have changed both.
                        continue
                    case .switchToTemporary:
                        var current: [String: AppIdentity] = [:]
                        for checkedScheme in schemes { current[checkedScheme] = try currentDefault(checkedScheme) }
                        guard canSetPairedDefaults(originals: originals, current: current, temporary: edge) else {
                            throw LoginError("默认浏览器在准备期间被其他程序改变，停止切换以免关联覆盖。")
                        }
                        if state!.attemptedSchemes.isEmpty {
                            state!.attemptedSchemes = schemes
                            try store.save(state!)
                        }
                        try await setDefault(edge, for: scheme)
                    case .leaveExternalChange:
                        throw LoginError("\(scheme.uppercased()) 默认浏览器在准备期间被其他程序改变，停止切换。")
                    }
                }
                try requireNotCancelled()
                try requirePolicies()
                try await checkLocalProxy()
                try requireNotCancelled()
                guard try schemes.allSatisfy({ try currentDefault($0) == edge }) else {
                    throw LoginError("默认浏览器复核失败，停止登录并恢复。")
                }
                state!.phase = "active"
                try store.save(state!)
                try await openClaudeApplication()
                try requireNotCancelled()
                log("已打开 Claude。请自行点击登录；登录完成或取消后，回到此窗口恢复默认浏览器。辅助入口不会自动判断账号登录状态。")
            } catch {
                log("登录准备未完成：\(error.localizedDescription)")
                if state == nil && store.exists {
                    do { state = try store.load() }
                    catch { blockingError = "恢复记录读取失败：\(error.localizedDescription)" }
                }
                if state != nil { _ = await restoreOriginals() }
            }
            endOperation()
        }
    }

    private func openClaudeApplication() async throws {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            NSWorkspace.shared.openApplication(at: claudeURL, configuration: configuration) { _, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    @objc private func finishLogin() { beginRestoration() }

    @objc private func cancelLogin() {
        cancelRequested = true
        if busy { log("已请求取消；等待正在进行的系统操作结束后立即恢复。"); refreshUI() }
        else { beginRestoration() }
    }

    private func beginRestoration() {
        guard !busy, state != nil else { return }
        busy = true; refreshUI()
        Task { @MainActor in
            _ = await restoreOriginals()
            endOperation()
        }
    }

    private func restoreOriginals() async -> Bool {
        guard var saved = state else { return !store.exists }
        var failures: [String] = []
        saved.phase = "restoring"
        // A write failure must not prevent safe restoration using the record
        // already persisted before any default-handler changes.
        do { try store.save(saved); state = saved }
        catch { log("无法更新恢复阶段，仍尝试恢复已保存的原应用：\(error.localizedDescription)") }
        for scheme in schemes {
            do {
                guard let original = saved.originals[scheme] else { throw LoginError("缺少 \(scheme) 原默认值。") }
                let current = try currentDefault(scheme)
                switch restoreDecision(original: original, current: current,
                                       temporary: saved.temporaryApplication,
                                       attempted: saved.attemptedSchemes.contains(scheme)) {
                case .alreadyOriginal:
                    break
                case .restore:
                    // Recheck both immediately before the setter: restoring
                    // one scheme may also change the other. No native CAS exists.
                    var currentPair: [String: AppIdentity] = [:]
                    for checkedScheme in schemes { currentPair[checkedScheme] = try currentDefault(checkedScheme) }
                    guard canSetPairedDefaults(originals: saved.originals, current: currentPair,
                                               temporary: saved.temporaryApplication) else {
                        throw LoginError("HTTP / HTTPS 存在外部更改或原默认应用不一致，未执行可能关联覆盖的恢复。请手动恢复两项原默认应用后再点击恢复按钮核验。")
                    }
                    if currentPair[scheme] == original {
                        continue
                    }
                    try await setDefault(original, for: scheme)
                case .leaveExternalChange:
                    throw LoginError("\(scheme.uppercased()) 已被改为 \(current.bundleIdentifier)，不会覆盖。请在系统设置中手动恢复为 \(original.bundleIdentifier)，再点击恢复按钮核验。")
                }
            } catch { failures.append(error.localizedDescription) }
        }
        for scheme in schemes {
            do {
                guard try currentDefault(scheme) == saved.originals[scheme] else {
                    throw LoginError("\(scheme.uppercased()) 尚未恢复原应用。")
                }
            } catch { failures.append(error.localizedDescription) }
        }
        if failures.isEmpty {
            do {
                try store.remove(sessionID: saved.sessionID)
                state = nil; blockingError = nil
                log("已核验 HTTP 与 HTTPS 均恢复原默认应用；恢复记录已删除。Edge 窗口不会被强制关闭。")
                return true
            } catch { failures.append(error.localizedDescription) }
        }
        state = saved
        let message = Array(Set(failures)).sorted().joined(separator: "\n")
        log("恢复未完成，记录仍保留在：\(store.stateURL.path)\n\(message)")
        statusLabel.stringValue = "恢复失败：记录已保留，请处理后再次点击恢复。"
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "默认浏览器尚未完全恢复"
        alert.informativeText = message + "\n\n不会静默退出；请保留恢复记录并重试。"
        alert.addButton(withTitle: "返回并处理")
        alert.runModal()
        return false
    }

    private func endOperation() {
        busy = false; refreshUI()
        if awaitingTerminationReply {
            let restored = state == nil && !store.exists && blockingError == nil
            awaitingTerminationReply = false
            permitTermination = restored
            NSApp.reply(toApplicationShouldTerminate: restored)
        }
        if closeRequested {
            closeRequested = false
            if state == nil && !store.exists { window.close() }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if !ownsRecoveryLock || (!busy && state == nil && !store.exists) { return true }
        closeRequested = true
        cancelRequested = true
        if busy { refreshUI() }
        else if state != nil { beginRestoration() }
        else {
            closeRequested = false
            _ = applicationShouldTerminate(NSApp)
        }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // A second process that failed to acquire the lock made no changes;
        // the first process owns any recovery record and must remain in charge.
        if !ownsRecoveryLock { return .terminateNow }
        if permitTermination { return .terminateNow }
        if !busy && state == nil && !store.exists { return .terminateNow }
        if state == nil && !busy {
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "存在无法读取的恢复记录"
            alert.informativeText = "不能确认默认浏览器已经恢复。请保留记录并人工检查：\(store.stateURL.path)\n\(blockingError ?? "")"
            alert.addButton(withTitle: "返回处理")
            alert.runModal()
            return .terminateCancel
        }
        if awaitingTerminationReply { return .terminateCancel }
        awaitingTerminationReply = true
        cancelRequested = true
        if busy { log("收到退出请求；等待系统操作结束后恢复原默认浏览器。"); refreshUI() }
        else { beginRestoration() }
        return .terminateLater
    }

    private func installTerminationSignals() {
        for value in [SIGTERM, SIGINT, SIGHUP] {
            signal(value, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }
}

func runDesktopLoginSelfTests() -> Int32 {
    let original = AppIdentity(bundleIdentifier: "example.original", appURL: "file:///Applications/Original.app/")
    let temporary = AppIdentity(bundleIdentifier: "com.microsoft.edgemac", appURL: "file:///Applications/Microsoft%20Edge.app/")
    let external = AppIdentity(bundleIdentifier: "example.external", appURL: "file:///Applications/External.app/")
    var failures: [String] = []
    var passed = 0
    func check(_ value: Bool, _ label: String) { if !value { failures.append(label) } else { passed += 1 } }
    check(restoreDecision(original: original, current: original, temporary: temporary, attempted: true) == .alreadyOriginal, "already restored")
    check(restoreDecision(original: original, current: temporary, temporary: temporary, attempted: true) == .restore, "partial switch restores")
    check(restoreDecision(original: original, current: external, temporary: temporary, attempted: true) == .leaveExternalChange, "external change preserved")
    check(restoreDecision(original: original, current: temporary, temporary: temporary, attempted: false) == .leaveExternalChange, "untouched scheme preserved")
    check(restoreDecision(original: temporary, current: temporary, temporary: temporary, attempted: false) == .alreadyOriginal, "original Edge needs no setter")
    let sameOriginals = ["http": original, "https": original]
    check(hasSharedOriginals(sameOriginals), "matching originals accepted")
    check(!hasSharedOriginals(["http": original, "https": external]), "different originals refused before switching")
    check(!hasSharedOriginals(["http": original]), "missing scheme refused")
    check(switchDecision(original: original, current: temporary, temporary: temporary) == .alreadyTemporary, "linked second scheme already switched")
    check(switchDecision(original: original, current: original, temporary: temporary) == .switchToTemporary, "unchanged scheme can switch")
    check(switchDecision(original: original, current: external, temporary: temporary) == .leaveExternalChange, "forward external change refused")
    check(canSetPairedDefaults(originals: sameOriginals, current: ["http": temporary, "https": temporary], temporary: temporary), "linked defaults may restore")
    check(canSetPairedDefaults(originals: sameOriginals, current: ["http": temporary, "https": original], temporary: temporary), "partial defaults may restore")
    check(!canSetPairedDefaults(originals: sameOriginals, current: ["http": temporary, "https": external], temporary: temporary), "paired setter cannot overwrite external HTTPS")
    check(!canSetPairedDefaults(originals: ["http": original, "https": external], current: ["http": temporary, "https": temporary], temporary: temporary), "old differing-original record cannot auto-restore")
    let attemptedPair = schemes
    check(schemes.allSatisfy { restoreDecision(original: original, current: temporary, temporary: temporary, attempted: attemptedPair.contains($0)) == .restore }, "both linked changes recorded before first setter")
    check(schemes.allSatisfy { restoreDecision(original: original, current: original, temporary: temporary, attempted: attemptedPair.contains($0)) == .alreadyOriginal }, "linked restoration skips already restored second scheme")
    check(policyValueMatches("ProxySettings", ["ProxyMode": "fixed_servers", "ProxyServer": expectedProxy]), "expected proxy")
    check(!policyValueMatches("ProxySettings", ["ProxyMode": "fixed_servers", "ProxyServer": expectedProxy, "ProxyBypassList": "*"]), "wildcard bypass rejected")
    check(!policyValueMatches("ProxySettings", ["ProxyMode": "system", "ProxyServer": expectedProxy]), "system proxy rejected")
    check(policyValueMatches("DnsOverHttpsMode", "off"), "DoH off")
    check(policyValueMatches("WebRtcLocalhostIpHandling", "disable_non_proxied_udp"), "WebRTC restriction")
    check(policyValueMatches("NetworkPredictionOptions", NSNumber(value: 2)), "prediction integer")
    check(!policyValueMatches("NetworkPredictionOptions", NSNumber(value: true)), "prediction bool rejected")
    check(!PolicyResult(key: "x", forced: false, valueMatches: true).valid, "unforced preference rejected")
    let fixture = RecoveryState(version: 1, sessionID: "01234567-89AB-CDEF-0123-456789ABCDEF", createdAt: "test",
                                originals: sameOriginals, temporaryApplication: temporary,
                                attemptedSchemes: schemes, phase: "starting")
    do {
        let data = try JSONEncoder().encode(fixture)
        let decoded = try JSONDecoder().decode(RecoveryState.self, from: data)
        check(decoded.originals == fixture.originals && decoded.attemptedSchemes == schemes, "state round trip preserves both attempted schemes")
    } catch { failures.append("state serialization") }
    print(failures.isEmpty ? "PASS: \(passed) pure-data recovery and policy checks; no settings or files accessed." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}

