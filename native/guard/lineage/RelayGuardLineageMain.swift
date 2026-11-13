import Darwin
import Foundation

@main
enum RelayGuardLineageMain {
    static func main() {
        guard RelayGuardLineageRelease.runtimeMonitoringReady,
              RelayGuardLineageRelease.systemInstallationSupported,
              RelayGuardLineageRelease.publisherTeamID != nil else { exit(2) }
        do {
            _ = try RelayGuardLineageIdentity.current()
            let monitor = RelayGuardESMonitor()
            let server = RelayGuardLineageServer(monitor: monitor)
            try server.start()
            // FDA/ES denial is observable unavailable health, never a fake
            // subscription success or an automatic retry loop.
            do { try monitor.start() } catch { _ = monitor.lineage.failed(.disconnected) }
            signal(SIGTERM, SIG_IGN)
            signal(SIGINT, SIG_IGN)
            let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
            let stop: @Sendable () -> Void = { monitor.stop(); server.stop(); exit(0) }
            termination.setEventHandler(handler: stop)
            interruption.setEventHandler(handler: stop)
            termination.resume(); interruption.resume()
            withExtendedLifetime((monitor, server, termination, interruption)) { RunLoop.main.run() }
        } catch { exit(2) }
    }
}
