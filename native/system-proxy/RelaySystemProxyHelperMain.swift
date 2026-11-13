import Foundation
import Darwin

@main struct RelaySystemProxyHelperMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            guard getuid() == 0, geteuid() == 0, [["--serve"], ["--verify-installation"]].contains(arguments) else { throw RelaySystemProxyHelperFailure.peer }
            let trust = try RelaySystemProxyHelperTrust.load()
            if arguments == ["--verify-installation"] { print("{\"verified\":true,\"role\":\"system-proxy-v1\"}"); return }
            let delegate = RelaySystemProxyHelperListener(trust: trust)
            let listener = try delegate.makeListener()
            listener.activate()
            let idle = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                if delegate.lifetime.beginIdleShutdown() { listener.invalidate(); exit(0) }
            }
            withExtendedLifetime((delegate, listener, idle)) { RunLoop.current.run() }
        } catch { FileHandle.standardError.write(Data("Relay system proxy helper unavailable.\n".utf8)); exit(1) }
    }
}
