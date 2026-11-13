import Foundation
import Darwin

@main struct RelayTunHelperMain {
    static func main() {
        // Direct execution is inert unless root and the exact protected
        // installation are verified. --serve exposes only the bounded,
        // authenticated network executor; no operation is automatic.
        let args = Array(CommandLine.arguments.dropFirst())
        guard [["--serve"], ["--verify-installation"]].contains(args), geteuid() == 0, getuid() == 0,
              URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path == RelayTunInstallationPaths.helper else {
            FileHandle.standardError.write(Data("Relay TUN helper unavailable: fixed administrator installation and --serve required.\n".utf8)); exit(1)
        }
        do {
            let trust = try RelayTunInstallationTrust.load()
            if args == ["--verify-installation"] {
                print("{\"verified\":true,\"manifestVersion\":2,\"role\":\"network-executor-v1\",\"executorAvailable\":true,\"active\":false,\"protectionVerified\":false}")
                return
            }
            let service = RelayTunExecutorService()
            let delegate = RelayTunHelperListener(trust: trust, service: service)
            let listener = try delegate.makeListener()
            listener.activate()
            withExtendedLifetime((service, delegate, listener)) { RunLoop.current.run() }
        } catch {
            FileHandle.standardError.write(Data("Relay TUN helper unavailable: installation trust was not verified.\n".utf8)); exit(1)
        }
    }
}
