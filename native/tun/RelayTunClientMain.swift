import Foundation
import Darwin

@main struct RelayTunClientMain {
    private static func warning(_ message: String) {
        let bytes = Array(message.utf8)
        _ = bytes.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
    }
    private static func prepareRulesDescriptors(_ descriptors: [Int32] = [5, 6]) -> Bool {
        // This is called only for the positively pinned new launch argv.
        // Protect both descriptors before bootstrap can admit any child spawn.
        for fd in descriptors {
            let flags = fcntl(fd, F_GETFD)
            guard flags >= 0, fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0 else {
                for fd in descriptors { Darwin.close(fd) }; return false
            }
        }
        return true
    }
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(),
              let physical = realpath(CommandLine.arguments[0], nil) else { exit(77) }
        let executable = String(cString: physical); free(physical)
        let managed = executable == RelayTunManagedInstallation.client
        let telemetryProviders = arguments == ["--managed-session-runtime-rule-providers-v1-runtime-telemetry-v2"]
        let telemetryExecution = arguments == ["--managed-session-execution-v2-runtime-telemetry-v2"]
        let telemetrySmartTools = arguments == ["--managed-session-execution-v2-smart-tools-v1-runtime-telemetry-v2"]
        let historyProviders = arguments == ["--managed-session-runtime-rule-providers-v1-runtime-history-v3"]
        let historyExecution = arguments == ["--managed-session-execution-v2-runtime-history-v3"]
        let historySmartTools = arguments == ["--managed-session-execution-v2-smart-tools-v1-runtime-history-v3"]
        let historyLaunch = managed && (historyProviders || historyExecution || historySmartTools)
        let telemetryLaunch = managed && (telemetryProviders || telemetryExecution || telemetrySmartTools || historyLaunch)
        let smartToolsLaunch = managed && (arguments == ["--managed-session-execution-v2-smart-tools-v1"] || telemetrySmartTools || historySmartTools)
        let executionLaunch = managed && (arguments == ["--managed-session-execution-v2"] || smartToolsLaunch || telemetryExecution || historyExecution)
        let executionInspect = managed && arguments == ["--managed-inspect-execution-v2"]
        let providersLaunch = managed && (arguments == ["--managed-session-runtime-rule-providers-v1"] || telemetryProviders || historyProviders)
        let resourcesLaunch = managed && (arguments == ["--managed-session-runtime-resources-v1"] || providersLaunch)
        let rulesLaunch = managed && (arguments == ["--managed-session-runtime-rules-v1"] || resourcesLaunch || executionLaunch)
        let captureLaunch = managed && (arguments == ["--managed-session-runtime-capture-v1"] || rulesLaunch)
        guard managed ? [["--managed-inspect"], ["--managed-inspect-execution-v2"], ["--managed-session"], ["--managed-session-execution-v2"], ["--managed-session-execution-v2-smart-tools-v1"], ["--managed-session-runtime-capture-v1"], ["--managed-session-runtime-rules-v1"], ["--managed-session-runtime-resources-v1"], ["--managed-session-runtime-rule-providers-v1"], ["--managed-session-runtime-rule-providers-v1-runtime-telemetry-v2"], ["--managed-session-execution-v2-runtime-telemetry-v2"], ["--managed-session-execution-v2-smart-tools-v1-runtime-telemetry-v2"], ["--managed-session-runtime-rule-providers-v1-runtime-history-v3"], ["--managed-session-execution-v2-runtime-history-v3"], ["--managed-session-execution-v2-smart-tools-v1-runtime-history-v3"]].contains(arguments) :
              (executable == RelayTunInstallationPaths.client && [["--status"], ["--inspect"], ["--tun-session"]].contains(arguments)) else { exit(77) }
        _ = umask(0o077)
        _ = Darwin.signal(SIGPIPE, SIG_IGN)
        let rulesDescriptorsReady = rulesLaunch && prepareRulesDescriptors()
        let stateDescriptorsReady = executionLaunch && prepareRulesDescriptors([7, 8])
        let smartToolsDescriptorsReady = smartToolsLaunch && prepareRulesDescriptors([9, 10])
        let resourcesDescriptorsReady = resourcesLaunch && prepareRulesDescriptors([7, 8])
        let providersDescriptorsReady = providersLaunch && prepareRulesDescriptors([9, 10])
        let runtimeCapture = captureLaunch ? RelayTunRuntimeCapture.Channel(telemetry: telemetryLaunch, history: historyLaunch) : nil
        if arguments != ["--tun-session"] && arguments != ["--managed-session"] && !captureLaunch {
            do {
                if arguments == ["--status"] {
                    print(String(decoding: try JSONEncoder().encode(RelayTunAppSession.status()), as: UTF8.self)); return
                }
                let report = try managed ? RelayTunAppSession.managedInspect(executionV2: executionInspect) : RelayTunAppSession.inspect()
                let bytes = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .withoutEscapingSlashes])
                FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
            } catch {
                warning("Relay TUN inspection was not verified. No system changes were requested.\n"); exit(1)
            }
            return
        }
        var session: RelayTunAppSession?, buffer = Data()
        do {
            var chunk = [UInt8](repeating: 0, count: 16384)
            while true {
                let count = Darwin.read(STDIN_FILENO, &chunk, chunk.count)
                if count < 0, errno == EINTR { continue }
                guard count >= 0 else { throw RelayTunAppSession.Failure.invalid }
                if count == 0 { break }
                var offset = 0
                while offset < count {
                    let tail = chunk[offset..<count]
                    let newline = tail.firstIndex(of: 10), end = newline ?? count
                    let maximum = session == nil ? RelayTunAppBundle.maximumBootstrapBytes : 8192
                    guard buffer.count + end - offset <= maximum else { throw RelayTunAppSession.Failure.invalid }
                    buffer.append(contentsOf: chunk[offset..<end])
                    if let newline {
                        if let current = session { try current.accept(buffer) }
                        else {
                            let context: RelayTunAppBundle.ExecutionContext?
                            if executionLaunch {
                                let receivedTickMS = DispatchTime.now().uptimeNanoseconds / 1_000_000
                                let receivedAtMS = Int64(Date().timeIntervalSince1970 * 1000)
                                let trust = try RelayTunExecutionInstallationV2.load()
                                guard !smartToolsLaunch || trust.profile == .smart else { throw RelayTunAppSession.Failure.binding }
                                context = .init(core: trust.core, installationRevision: trust.revision,
                                                receivedAtMS: receivedAtMS, receivedTickMS: receivedTickMS)
                            } else { context = nil }
                            let created = try RelayTunAppSession(bootstrap: buffer, coreManaged: managed, resourcesEnabled: resourcesLaunch,
                                                                 ruleProvidersEnabled: providersLaunch, executionContext: context)
                            session = created
                            // Optional read trust/FD errors never escape into
                            // the original control EOF/recovery catch below.
                            if let runtimeCapture { try? created.startRuntimeCapture(runtimeCapture) }
                            if rulesDescriptorsReady { try? created.startRuntimeRules() }
                            if resourcesDescriptorsReady { try? created.startRuntimeResources() }
                            if providersDescriptorsReady { try? created.startRuntimeRuleProviders() }
                            if smartToolsDescriptorsReady { try? created.startSmartTools() }
                            if stateDescriptorsReady {
                                if created.supportsSmartState { try? created.startSmartState() }
                                else { Darwin.close(7); Darwin.close(8) }
                            }
                        }
                        buffer.removeAll(keepingCapacity: true); offset = newline + 1
                    } else { offset = count }
                }
            }
            guard buffer.isEmpty else { throw RelayTunAppSession.Failure.invalid }
            if let session {
                session.inputEnded()
                session.waitForDisposal()
                if session.canExit { return }
                // Only an unresolved/externally changed recovery reaches here;
                // its private non-sensitive record remains available to App.
                withExtendedLifetime(session) { RunLoop.current.run() }
            }
        } catch {
            if let session {
                session.inputEnded()
                session.waitForDisposal()
                if session.canExit { return }
                warning("Relay TUN control was not verified; recovery ownership is retained.\n")
                withExtendedLifetime(session) { RunLoop.current.run() }
            } else {
                warning("Relay TUN private bootstrap was rejected before helper acquisition.\n"); exit(1)
            }
        }
    }
}
