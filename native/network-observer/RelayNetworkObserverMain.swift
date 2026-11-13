import Foundation
import Darwin

@main struct RelayNetworkObserverMain {
    static func main() {
        guard CommandLine.arguments.dropFirst().elementsEqual(["--inspect"]),
              getuid() > 0, geteuid() == getuid() else { exit(77) }
        do {
            let report = try RelayNetworkObserver.inspect(uid: getuid(), sources: RelayTunEnvironmentInspector.live)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            FileHandle.standardOutput.write(try encoder.encode(report) + Data([10]))
        } catch {
            FileHandle.standardError.write(Data("Read-only network observation was incomplete.\n".utf8))
            exit(1)
        }
    }
}
