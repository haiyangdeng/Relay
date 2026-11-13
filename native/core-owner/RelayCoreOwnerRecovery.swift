import Foundation
import Darwin

// Same conservative, explicit ESRCH-only record archival as RelayCoreRecovery,
// extended to BOTH positively recorded actors. Never stop/adopt a stored PID.
enum CoreOwnerRecovery {
    struct Captured {
        let journal: CoreOwnerJournal
        let bytes: Data
        let leasePresent: Bool
        let revision: String
    }
    static func capture(_ context: CoreOwnerContext) throws -> Captured? {
        let (workspace, lease) = try CoreOwnerStore.locations(context)
        if try CoreOwnerFiles.absent(workspace) { return nil }
        let (journal, bytes) = try CoreOwnerStore.load(context, allowMissingLease: true)
        let present = !(try CoreOwnerFiles.absent(lease))
        let fingerprint = Data((journal.workspaceIdentity + ":" + (present ? journal.coreLease.directoryIdentity : "lease-absent") + ":").utf8) + bytes
        return .init(journal: journal, bytes: bytes, leasePresent: present, revision: coreOwnerHash(fingerprint))
    }
    static func complete(_ captured: Captured) -> Bool {
        let journal = captured.journal
        guard let core = journal.core, let configuration = journal.runtime.configurationSHA256,
              [journal.owner, core].allSatisfy({ identity in
                  identity.pid > 1 && identity.uid == getuid() &&
                  (UInt64(identity.bornSeconds) ?? 0) > 0 && (UInt64(identity.bornMicroseconds) ?? 1_000_000) < 1_000_000 &&
                  identity.executable.hasPrefix("/") && !identity.executable.contains("\0") && identity.executable.utf8.count <= 4096 &&
                  !identity.fileIdentity.isEmpty && identity.fileIdentity.utf8.count <= 512 &&
                  (try? coreOwnerSHA(identity.resourceSHA256)) != nil
              }), (try? coreOwnerSHA(configuration)) != nil,
              ["starting", "ready", "detachPrepared", "detached", "stopping", "closed", "uncertain"].contains(journal.phase),
              journal.owner.executable.hasSuffix("/Contents/Resources/relay/RelayCoreOwner"),
              RelayCoreOwnerRelease.pins.values.contains(where: { $0.0 == core.resourceSHA256 }),
              core.resourceSHA256 == journal.runtime.coreResourceSHA256,
              ["arm64", "x64"].contains(where: { architecture in
                  core.executable == URL(fileURLWithPath: journal.owner.executable).deletingLastPathComponent().path + "/core/darwin-" + architecture + "/mihomo" &&
                  RelayCoreOwnerRelease.pins[architecture]?.0 == core.resourceSHA256
              }), (1024...65535).contains(journal.runtime.httpPort), journal.runtime.mode == "rule" else { return false }
        return CoreOwnerIdentity.positivelyAbsent(journal.owner) && CoreOwnerIdentity.positivelyAbsent(core)
    }
    static func perform(_ request: [String: Any], main: CoreOwnerProcessIdentity, helper: CoreOwnerProcessIdentity) throws -> [String: Any] {
        let action = request["action"] as? String
        let keys: Set<String> = ["version", "contract", "requestId", "action", "context"]
        let hasWitness = request.keys.contains("closedOwnerWitness")
        let expectedKeys = keys.union(action == "archive" ? ["expectedRevision"] : []).union(action == "inspect" && hasWitness ? ["closedOwnerWitness"] : [])
        guard action == "inspect" || action == "archive", Set(request.keys) == expectedKeys,
              RelayTunStrictJSON.integer(request["version"]) == 1, request["contract"] as? String == RelayCoreOwnerRelease.contract,
              let object = request["context"] as? [String: Any], Set(object.keys) == ["home", "stateRoot"],
              let home = object["home"] as? String, let root = object["stateRoot"] as? String else { throw CoreOwnerFailure.invalid }
        let id = try coreOwnerUUID(request["requestId"]), context = CoreOwnerContext(home: home, stateRoot: root)
        let expected = action == "archive" ? try coreOwnerSHA(request["expectedRevision"]) : nil
        var witnessOwner: CoreOwnerProcessIdentity?, witnessSession: String?
        if hasWitness {
            guard action == "inspect", let witness = request["closedOwnerWitness"] as? [String: Any],
                  Set(witness.keys) == ["sessionId", "owner"], let owner = witness["owner"] as? [String: Any],
                  Set(owner.keys) == ["pid", "uid", "bornSeconds", "bornMicroseconds", "executable", "resourceSHA256", "fileIdentity"] else { throw CoreOwnerFailure.invalid }
            let session = try coreOwnerUUID(witness["sessionId"])
            let identity = try JSONDecoder().decode(CoreOwnerProcessIdentity.self, from: JSONSerialization.data(withJSONObject: owner))
            guard identity.pid > 1, identity.uid == getuid(), identity.uid == helper.uid,
                  let seconds = UInt64(identity.bornSeconds), seconds > 0, String(seconds) == identity.bornSeconds,
                  let micros = UInt64(identity.bornMicroseconds), micros < 1_000_000, String(micros) == identity.bornMicroseconds,
                  identity.executable == helper.executable, identity.resourceSHA256 == helper.resourceSHA256,
                  identity.fileIdentity == helper.fileIdentity else { throw CoreOwnerFailure.identity }
            try CoreOwnerIdentity.verify(helper, identifier: RelayCoreOwnerRelease.helperID)
            witnessOwner = identity; witnessSession = session
        }
        func report(_ status: String, _ captured: Captured? = nil, canArchive: Bool = false, warning: String? = nil) throws -> [String: Any] {
            var output: [String: Any] = ["version": 1, "contract": RelayCoreOwnerRelease.contract, "requestId": id, "status": status,
             "canArchive": canArchive, "revision": captured.map { $0.revision as Any } ?? NSNull(),
             "sessionId": captured.map { $0.journal.sessionId as Any } ?? NSNull(), "warnings": warning.map { [$0] } ?? []]
            if let owner = witnessOwner, let session = witnessSession {
                // Main supplies only its private authenticated closed witness.
                // This proves neither Core exit nor root idleness; only ESRCH
                // for this exact request's owner PID is returned. Reuse holds.
                try CoreOwnerIdentity.verify(helper, identifier: RelayCoreOwnerRelease.helperID)
                try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
                output["closedOwnerWitness"] = ["sessionId": session,
                    "owner": try coreOwnerObject(coreOwnerEncode(owner), limit: 8192),
                    "absent": CoreOwnerIdentity.positivelyAbsent(owner)]
            }
            return output
        }
        let original: Captured
        do {
            guard let captured = try capture(context) else {
                guard action == "inspect" else { throw CoreOwnerFailure.stale }
                return try report("clear")
            }
            original = captured
        } catch {
            return try report("liveOrUnknown", warning: "ownerRecordUnconfirmed")
        }
        let canArchive = complete(original)
        if action == "inspect" { return try report(canArchive ? "stale" : "liveOrUnknown", original, canArchive: canArchive, warning: canArchive ? "explicitArchiveRequired" : "actorOrSpawnGapUnconfirmed") }
        guard canArchive, original.revision == expected else { return try report("liveOrUnknown", original, warning: "archiveProofStale") }
        try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
        let ownerRoot = root + "/CoreOwner"
        _ = try CoreOwnerFiles.privateDirectory(ownerRoot, home: home)
        let lock = try CoreOwnerLock(ownerRoot + "/owner.lock")
        try lock.verify()
        do {
            guard let current = try capture(context), current.revision == original.revision, complete(current) else { throw CoreOwnerFailure.stale }
            let archives = ownerRoot + "/Closed"
            _ = try CoreOwnerFiles.directory(archives, create: true, home: home)
            _ = try CoreOwnerFiles.privateDirectory(archives, home: home)
            let target = archives + "/" + UUID().uuidString.lowercased()
            try CoreOwnerFiles.mkdirExclusive(target)
            try CoreOwnerFiles.sync(archives)
            try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
            try lock.verify()
            guard let final = try capture(context), final.revision == original.revision, complete(final) else { throw CoreOwnerFailure.stale }
            if final.leasePresent { try CoreOwnerFiles.moveExclusive(root + "/Core/.session", destination: target + "/core-session", identity: final.journal.coreLease.directoryIdentity) }
            try CoreOwnerFiles.moveExclusive(root + "/CoreOwner/.session", destination: target + "/owner-session", identity: final.journal.workspaceIdentity)
            guard try CoreOwnerFiles.read(target + "/owner-session/owner.json") == final.bytes else { throw CoreOwnerFailure.uncertain }
            if final.leasePresent {
                guard try CoreOwnerFiles.read(target + "/core-session/owner.json", maximum: 4096) == Data(final.journal.leaseRaw.utf8) else { throw CoreOwnerFailure.uncertain }
            }
            return try report("archived", original, warning: "deadRecordsPreservedNoProcessAction")
        } catch {
            return try report("uncertain", original, warning: "archiveUnconfirmedNoRetry")
        }
    }
}
