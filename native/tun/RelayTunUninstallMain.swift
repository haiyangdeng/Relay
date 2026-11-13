import Foundation
import Darwin

@main struct RelayTunUninstallMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 2, ["--remove", "--verify-recovery"].contains(arguments[0]), RelayTunHelperTrust.hex(arguments[1], count: 64) != nil, getuid() == 0, geteuid() == 0,
              URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path == RelayTunInstallationPaths.uninstaller else {
            FileHandle.standardError.write(Data("Relay candidate uninstall requires explicit administrator authentication and its fixed root-protected executable.\n".utf8)); exit(1)
        }
        do {
            if arguments[0] == "--verify-recovery" {
                try RelayTunUninstallLive.verifyRecovery(expectedManifestSHA256: arguments[1])
                print("{\"recoveryVerified\":true,\"role\":\"network-executor-v1\",\"networkRestorationClaimed\":false}")
                return
            }
            try RelayTunUninstallLive.remove(expectedManifestSHA256: arguments[1])
            let retained = try RelayTunJournalArchive.verifyPreserved()
            print("{\"uninstalled\":true,\"installationNamespaceAbsent\":true,\"auditArchiveRetained\":\(retained),\"role\":\"network-executor-v1\"}")
        } catch {
            // This is intentionally not an atomic crash recovery promise. Any
            // interruption/conflict needs the host's exact residual audit; no
            // recursive delete, force option or automatic retry is provided.
            FileHandle.standardError.write(Data("Relay candidate removal was not completed; preserve the candidate manifest and audit exact residuals. No other app or network configuration was targeted.\n".utf8)); exit(1)
        }
    }
}
