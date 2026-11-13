import Foundation
import Darwin

@main struct RelayCoreOwnerMain {
    static func main() {
        // Source completion never enables a release or runs a system manager.
        do {
            try RelayCoreOwnerRelease.require()
            let identity = try CoreOwnerIdentity.capture(getpid(), identifier: RelayCoreOwnerRelease.helperID)
            guard URL(fileURLWithPath: identity.executable).lastPathComponent == "RelayCoreOwner" else { throw CoreOwnerFailure.resource }
            let args = Array(CommandLine.arguments.dropFirst())
            guard args == ["--serve"] || args == ["--client"] || args == ["--recover"] else { throw CoreOwnerFailure.invalid }
            let main = try CoreOwnerIdentity.mainParent(getpid())
            signal(SIGPIPE, SIG_IGN)
            if args == ["--serve"] { try serve(identity, main: main) }
            else if args == ["--client"] { try client(identity, main: main) }
            else {
                guard let data = try CoreOwnerIO.frame(STDIN_FILENO, maximum: 8192) else { throw CoreOwnerFailure.invalid }
                try CoreOwnerIO.reply(CoreOwnerRecovery.perform(coreOwnerObject(data, limit: 8192), main: main, helper: identity), to: STDOUT_FILENO)
            }
        } catch {
            // No synthetic successful snapshot before a real session exists.
            let code = (error as? CoreOwnerFailure)?.rawValue ?? "unavailable"
            FileHandle.standardError.write(Data(("RelayCoreOwner: " + code + "\n").utf8))
            exit(2)
        }
    }
    private static func serve(_ identity: CoreOwnerProcessIdentity, main: CoreOwnerProcessIdentity) throws {
        guard let bytes = try CoreOwnerIO.frame(STDIN_FILENO, maximum: 8192) else { throw CoreOwnerFailure.invalid }
        let request = try coreOwnerObject(bytes, limit: 8192)
        let store = try CoreOwnerStore(request: request, main: main, owner: identity)
        var connection = CoreOwnerConnection(id: UUID().uuidString.lowercased(), clientNonce: try coreOwnerNonce(), serverNonce: try coreOwnerNonce(), main: main)
        let host = CoreOwnerHost(store: store, connection: connection)
        try host.startListener()
        do {
            try CoreOwnerIO.reply(host.initial(requestId: try coreOwnerUUID(request["requestId"]), connection: connection), to: STDOUT_FILENO)
            while !host.canExit, let frame = try CoreOwnerIO.frame(STDIN_FILENO, maximum: 3 * 1024 * 1024, idle: true, shouldExit: { host.canExit }) {
                try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
                let response = try host.handle(frame, connection: &connection)
                try CoreOwnerIO.reply(response, to: STDOUT_FILENO); host.didFlush(response)
            }
        } catch { host.lost(connection) }
        host.lost(connection)
        // A detached or uncertain owner keeps the exact child, listener and
        // journal. It never sleeps through a startup operation or auto-retries.
        while !host.canExit { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25)) }
        if host.exitWasUncertain { throw CoreOwnerFailure.uncertain }
    }
    private static func client(_ identity: CoreOwnerProcessIdentity, main: CoreOwnerProcessIdentity) throws {
        guard let frame = try CoreOwnerIO.frame(STDIN_FILENO, maximum: 8192) else { throw CoreOwnerFailure.invalid }
        let request = try coreOwnerObject(frame, limit: 8192)
        guard Set(request.keys) == ["version", "contract", "requestId", "action", "context"],
              RelayTunStrictJSON.integer(request["version"]) == 1, request["contract"] as? String == RelayCoreOwnerRelease.contract,
              request["action"] as? String == "connect", let contextObject = request["context"] as? [String: Any],
              Set(contextObject.keys) == ["home", "stateRoot"], let home = contextObject["home"] as? String,
              let root = contextObject["stateRoot"] as? String else { throw CoreOwnerFailure.invalid }
        let context = CoreOwnerContext(home: home, stateRoot: root), requestID = try coreOwnerUUID(request["requestId"])
        let (journal, bytes) = try CoreOwnerStore.load(context, allowMissingLease: true, closedMissingOnly: true)
        try CoreOwnerIdentity.verify(journal.owner, identifier: RelayCoreOwnerRelease.helperID)
        guard journal.owner.executable == identity.executable, journal.owner.resourceSHA256 == identity.resourceSHA256,
              journal.owner.fileIdentity == identity.fileIdentity else { throw CoreOwnerFailure.resource }
        let fd = try CoreOwnerIO.connect(journal.runtime.directory + "/owner.sock"); defer { Darwin.close(fd) }
        let owner = try CoreOwnerIdentity.peer(fd, selfIdentity: identity)
        guard owner == journal.owner else { throw CoreOwnerFailure.identity }
        // Revalidate journal/socket/owner immediately before fresh challenge;
        // none of these reads can stop or adopt the recorded Core PID.
        let current = try CoreOwnerStore.load(context, allowMissingLease: true, closedMissingOnly: true)
        guard current.1 == bytes else { throw CoreOwnerFailure.stale }
        try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
        let clientNonce = try coreOwnerNonce()
        try CoreOwnerIO.reply(["version": 1, "contract": RelayCoreOwnerRelease.contract, "requestId": requestID,
                               "action": "hello", "sessionId": journal.sessionId, "clientNonce": clientNonce], to: fd)
        guard let helloBytes = try CoreOwnerIO.frame(fd, maximum: 65536) else { throw CoreOwnerFailure.control }
        let hello = try coreOwnerObject(helloBytes, limit: 65536)
        guard hello["requestId"] as? String == requestID, hello["contract"] as? String == RelayCoreOwnerRelease.contract,
              hello["clientNonce"] as? String == clientNonce, RelayTunStrictJSON.integer(hello["sequence"]) == 0,
              let snapshot = hello["snapshot"] as? [String: Any], snapshot["sessionId"] as? String == journal.sessionId,
              let peerObject = snapshot["owner"] as? [String: Any],
              try JSONDecoder().decode(CoreOwnerProcessIdentity.self, from: JSONSerialization.data(withJSONObject: peerObject)) == owner else { throw CoreOwnerFailure.identity }
        let observed = try JSONDecoder().decode(CoreOwnerSnapshot.self, from: JSONSerialization.data(withJSONObject: snapshot))
        guard observed.coreLease == journal.coreLease, observed.runtime == journal.runtime,
              observed.core == journal.core else { throw CoreOwnerFailure.stale }
        _ = try coreOwnerSHA(hello["serverNonce"]); _ = try coreOwnerUUID(hello["connectionId"])
        try CoreOwnerIO.write(helloBytes + Data([10]), to: STDOUT_FILENO, deadline: DispatchTime.now().uptimeNanoseconds + 5_000_000_000)
        while let input = try CoreOwnerIO.frame(STDIN_FILENO, maximum: 3 * 1024 * 1024, idle: true) {
            try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
            try CoreOwnerIdentity.verify(owner, identifier: RelayCoreOwnerRelease.helperID)
            try CoreOwnerIO.write(input + Data([10]), to: fd, deadline: DispatchTime.now().uptimeNanoseconds + 30_000_000_000)
            guard let output = try CoreOwnerIO.frame(fd, maximum: 65536) else { throw CoreOwnerFailure.control }
            try CoreOwnerIdentity.verify(owner, identifier: RelayCoreOwnerRelease.helperID)
            try CoreOwnerIO.write(output + Data([10]), to: STDOUT_FILENO, deadline: DispatchTime.now().uptimeNanoseconds + 5_000_000_000)
        }
    }
}
