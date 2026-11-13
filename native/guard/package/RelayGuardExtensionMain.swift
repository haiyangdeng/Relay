import Foundation
import NetworkExtension

/// Signed system-extension main registers extension mode before its listener.
/// Disabled-service reachability is never assumed. Provider starts fail-closed
/// until the separately confirmed enable is followed by a signed binding.
@main enum RelayGuardExtensionMain {
    private static let communication = RelayGuardProviderXPC()
    static func main() {
        autoreleasepool {
            NEProvider.startSystemExtensionMode()
            if RelayGuardManagementRelease.runtimeProtectionReady {
                do { try communication.start() }
                catch { return } // no listener/ready claim after identity failure
            }
        }
        dispatchMain()
    }
}
