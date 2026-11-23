import Foundation
import Darwin

@main struct RelaySystemProxyClientMain {
    static func main() {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard arguments == ["--transact"] || arguments == ["--status"] else { throw RelaySystemProxyHelperFailure.request }
            let request: RelaySystemProxyHelperRequest
            if arguments == ["--status"] { request = .make(nil, nil) }
            else {
                var data = Data()
                while true {
                    let part = FileHandle.standardInput.readData(ofLength: 65536)
                    if part.isEmpty { break }; data.append(part)
                    guard data.count <= RelaySystemProxyHelperRequest.maximumBytes else { throw RelaySystemProxyHelperFailure.request }
                }
                request = try RelaySystemProxyHelperRequest.parse(data, now: ProcessInfo.processInfo.systemUptime, receiver: .localClient)
            }
            let response = try RelaySystemProxyHelperClient.transact(request)
            try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(response))
        } catch let receipt as RelaySystemProxyHelperClient.NotSubmitted {
            do { try FileHandle.standardOutput.write(contentsOf: Data(receipt.nonce.utf8)) }
            catch { exit(1) }
            exit(RelaySystemProxyHelperClient.NotSubmitted.exitStatus)
        } catch { FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1) }
    }
}
