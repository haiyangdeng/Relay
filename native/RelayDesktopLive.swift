import AppKit
import Foundation
import Darwin

enum RelayDesktopLive {
    static func identityAvailable(_ identity: RelayDesktopIdentity) -> Bool {
        guard identity.valid, let url = URL(string: identity.appURL),
              url.resolvingSymlinksInPath().standardizedFileURL.path == url.path,
              let bundle = Bundle(url: url), bundle.bundleIdentifier == identity.bundleIdentifier,
              let executable = bundle.executableURL else { return false }
        return FileManager.default.isExecutableFile(atPath: executable.path)
    }
    @MainActor static func environment() -> RelayDesktopSessionEnvironment {
        return RelayDesktopSessionEnvironment(readOnly: .live, proxyReady: {
            // Authenticate the current Relay runtime. The session additionally
            // requires its dedicated SOCKS port to match Edge's fixed policy;
            // a Clash listener or an ordinary SOCKS listener cannot substitute.
            try RelayBrowserLauncher.requireOwnedBinding(home: RelayBrowserContract.realHome())
        }, identityAvailable: identityAvailable, setDefault: { identity, scheme in
            guard RelayDesktopInspection.schemes.contains(scheme), identityAvailable(identity),
                  let url = URL(string: identity.appURL) else { throw AssistantError("应用身份无法确认。") }
            // No timeout or cancellation that could abandon a pending setter.
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                NSWorkspace.shared.setDefaultApplication(at: url, toOpenURLsWithScheme: scheme) { error in
                    if error != nil { continuation.resume(throwing: AssistantError("系统默认浏览器切换未确认。")) }
                    else { continuation.resume() }
                }
            }
        }, openClaude: {
            let identity = RelayDesktopIdentity(bundleIdentifier: "com.anthropic.claudefordesktop", appURL: RelayDesktopInspection.claudeURL.absoluteString)
            guard identityAvailable(identity) else { throw AssistantError("Claude 应用身份无法确认。") }
            let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                NSWorkspace.shared.openApplication(at: RelayDesktopInspection.claudeURL, configuration: configuration) { _, error in
                    if error != nil { continuation.resume(throwing: AssistantError("Claude 打开未确认。")) }
                    else { continuation.resume() }
                }
            }
        })
    }
}

@MainActor
enum RelayDesktopProcess {
    static func run() async -> Int32 {
        // Parent/stdout loss must enter recovery, not terminate on SIGPIPE
        // while a setter or the active session still owns recovery state.
        signal(SIGPIPE, SIG_IGN)
        // The bounded stream preserves line order without blocking cancellation
        // on a long-lived setter. Overflow/EOF/malformed input all restore first.
        var input: AsyncThrowingStream<Data, Error>.Continuation!
        let stream = AsyncThrowingStream<Data, Error>(bufferingPolicy: .bufferingOldest(32)) { input = $0 }
        let continuation = input!
        return await withCheckedContinuation { exitContinuation in
            var ended = false
            let host = RelayDesktopHost(factory: { context in
                let actual = RelayBrowserContract.context(home: try RelayBrowserContract.realHome())
                guard context.home == actual.home, context.stateRoot == actual.stateRoot else { throw AssistantError("会话只接受当前用户固定数据目录。") }
                return RelayDesktopSession(store: try RelayDesktopStore(context), environment: RelayDesktopLive.environment())
            }, emit: { response in
                guard let bytes = try? JSONEncoder().encode(response), bytes.count < 65536 else { continuation.finish(); return }
                do { try FileHandle.standardOutput.write(contentsOf: bytes + Data([10])) }
                catch { continuation.finish() }
            }, ended: { code in
                if !ended { ended = true; continuation.finish(); exitContinuation.resume(returning: code) }
            })
            let signals = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
                signal(number, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
                source.setEventHandler { Task { @MainActor in host.disconnect() } }
                source.resume(); return source
            }
            host.signalSources = signals
            Task { @MainActor in
                do { for try await line in stream { host.accept(line) }; host.disconnect() }
                catch { host.disconnect(failed: true) }
            }
            DispatchQueue(label: "Relay.desktop.stdin").async {
                var pending = Data(), buffer = [UInt8](repeating: 0, count: 4096)
                while true {
                    let count = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 {
                        if count < 0 || !pending.isEmpty { continuation.finish(throwing: AssistantError("会话输入截断。")) }
                        else { continuation.finish() }
                        return
                    }
                    pending.append(contentsOf: buffer.prefix(count))
                    while let newline = pending.firstIndex(of: 10) {
                        let line = Data(pending[..<newline]); pending.removeSubrange(...newline)
                        if line.count > 65536 { continuation.finish(throwing: AssistantError("会话消息过长。")); return }
                        switch continuation.yield(line) {
                        case .enqueued: break
                        case .dropped: continuation.finish(throwing: AssistantError("会话输入过快。")); return
                        case .terminated: return
                        @unknown default: continuation.finish(); return
                        }
                    }
                    if pending.count > 65536 { continuation.finish(throwing: AssistantError("会话消息过长。")); return }
                }
            }
        }
    }
}
