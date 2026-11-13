import Foundation
import Darwin

/// Ordinary-UID read-only baseline probe. It prints the two consent digests
/// the privileged helper would bind and re-verify; nothing is created,
/// mutated, cached or sent anywhere.
@main struct RelayTunEnvironmentInspectorMain {
    static func main() {
        guard CommandLine.arguments.dropFirst().elementsEqual(["--inspect"]), getuid() > 0, geteuid() == getuid() else {
            FileHandle.standardError.write(Data("Use --inspect as the ordinary user for read-only baseline diagnostics.\n".utf8))
            exit(77)
        }
        do {
            let start = Date()
            let baseline = try RelayTunEnvironmentInspector.baseline(owned: nil, sources: RelayTunEnvironmentInspector.live)
            let report: [String: Any] = ["mode": "ordinary-uid-read-only", "uid": getuid(), "readCompleted": true,
                "networkSHA256": baseline.networkSHA256, "protectionSHA256": baseline.protectionSHA256,
                "systemConfigurationChanged": false, "actualTunAccepted": false,
                "milliseconds": Int(Date().timeIntervalSince(start) * 1000)]
            print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
        } catch {
            let report: [String: Any] = ["mode": "ordinary-uid-read-only", "uid": getuid(), "readCompleted": false,
                "systemConfigurationChanged": false, "actualTunAccepted": false, "error": String(reflecting: error)]
            FileHandle.standardError.write(Data((String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self) + "\n").utf8))
            exit(1)
        }
    }
}
