import Foundation

/// Only absence selects the existing macOS authorization flow. A partial,
/// changed, disconnected or uncertain helper never triggers a second write.
enum RelaySystemProxyHelperBridge {
    static func change(_ expected: RelaySystemProxyBackend.Snapshot, _ target: RelaySystemProxyBackend.Snapshot) throws -> RelaySystemProxyBackend.ChangeResult {
        try selectBackend(helperPresent: RelaySystemProxyHelperPaths.present,
                          authorized: { try RelaySystemProxyBackend.changeSystemAuthorized(expected, target) },
                          installed: { try changeInstalled(expected, target) })
    }
    /// The route is chosen once. In particular, helper errors and uncertain
    /// replies are never retried through the authorization backend.
    static func selectBackend(helperPresent: Bool, authorized: () throws -> RelaySystemProxyBackend.ChangeResult, installed: () throws -> RelaySystemProxyBackend.ChangeResult) rethrows -> RelaySystemProxyBackend.ChangeResult {
        if helperPresent { return try installed() }
        return try authorized()
    }
    private static func changeInstalled(_ expected: RelaySystemProxyBackend.Snapshot, _ target: RelaySystemProxyBackend.Snapshot) throws -> RelaySystemProxyBackend.ChangeResult {
        let trust = try RelaySystemProxyHelperTrust.load()
        let request = RelaySystemProxyHelperRequest.make(expected, target)
        let bytes = try JSONEncoder().encode(request)
        guard bytes.count <= RelaySystemProxyHelperRequest.maximumBytes else { throw RelaySystemProxyHelperFailure.request }
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: RelaySystemProxyHelperPaths.client)
        process.arguments = ["--transact"]
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run()
        do { try input.fileHandleForWriting.write(contentsOf: bytes); try input.fileHandleForWriting.close() }
        catch { try? input.fileHandleForWriting.close(); process.waitUntilExit(); throw RelaySystemProxyHelperFailure.unavailable }
        var received = Data()
        while true {
            let part = output.fileHandleForReading.readData(ofLength: 65536)
            if part.isEmpty { break }
            received.append(part)
            guard received.count <= RelaySystemProxyHelperRequest.maximumBytes else { process.terminate(); process.waitUntilExit(); throw RelaySystemProxyHelperFailure.reply }
        }
        process.waitUntilExit()
        guard process.terminationReason == .exit, try RelaySystemProxyHelperTrust.load().revision == trust.revision else { throw RelaySystemProxyHelperFailure.unavailable }
        if process.terminationStatus == RelaySystemProxyHelperClient.NotSubmitted.exitStatus {
            guard received == Data(request.nonce.utf8) else { throw RelaySystemProxyHelperFailure.reply }
            return RelaySystemProxyBackend.ChangeResult(status: "notSubmitted", snapshot: try RelaySystemProxyBackend.readSystem(),
                warnings: ["管理员组件连接未就绪，本次未提交系统代理修改。"])
        }
        guard process.terminationStatus == 0 else { throw RelaySystemProxyHelperFailure.unavailable }
        let response = try JSONDecoder().decode(RelaySystemProxyHelperReply.self, from: received)
        try response.validate(request: request, trust: trust)
        guard response.error == nil, let result = response.result else { throw RelaySystemProxyHelperFailure.reply }
        return result
    }
}
