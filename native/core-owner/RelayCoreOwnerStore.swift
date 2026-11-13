import Foundation
import Darwin

// One explicitly confirmed release target. All parent FDs and original bytes
// survive a partial move, so recovery never guesses a different archive path.
private final class CoreOwnerReleaseAttempt {
    let coreParent: CoreOwnerDirectory, ownerParent: CoreOwnerDirectory, archive: CoreOwnerDirectory
    let coreIdentity: String, ownerIdentity: String
    let coreBytes: Data, ownerBytes: Data
    init(context: CoreOwnerContext, journal: CoreOwnerJournal, bytes: Data) throws {
        coreParent = try CoreOwnerDirectory(context.stateRoot + "/Core")
        ownerParent = try CoreOwnerDirectory(context.stateRoot + "/CoreOwner")
        let closed = context.stateRoot + "/CoreOwner/Closed"
        _ = try CoreOwnerFiles.directory(closed, create: true, home: context.home)
        _ = try CoreOwnerFiles.privateDirectory(closed, home: context.home)
        let target = closed + "/" + UUID().uuidString.lowercased()
        try CoreOwnerFiles.mkdirExclusive(target)
        archive = try CoreOwnerDirectory(target)
        coreIdentity = journal.coreLease.directoryIdentity; ownerIdentity = journal.workspaceIdentity
        coreBytes = Data(journal.leaseRaw.utf8); ownerBytes = bytes
    }
    private func position(_ core: Bool) throws -> (Bool, Bool) {
        let parent = core ? coreParent : ownerParent, identity = core ? coreIdentity : ownerIdentity
        let bytes = core ? coreBytes : ownerBytes
        // The known destination is authoritative for this original object. A
        // new unrelated .session may legitimately occupy its former name and
        // must neither be moved nor prevent this closed old owner retiring.
        let destination = try CoreOwnerFiles.directoryMatches(archive, name: core ? "core-session" : "owner-session",
            identity: identity, record: "owner.json", bytes: bytes, maximum: core ? 4096 : 32768)
        if destination {
            try parent.verify(); var info = stat()
            let result = fstatat(parent.fd, ".session", &info, AT_SYMLINK_NOFOLLOW), saved = errno
            guard result == 0 || saved == ENOENT else { throw CoreOwnerFailure.record }
            guard result != 0 || CoreOwnerFiles.identity(info) != identity else { throw CoreOwnerFailure.record }
            try parent.verify(); return (false, true)
        }
        let source = try CoreOwnerFiles.directoryMatches(parent, name: ".session", identity: identity,
            record: "owner.json", bytes: bytes, maximum: core ? 4096 : 32768)
        guard source else { throw CoreOwnerFailure.record }
        return (true, false)
    }
    func finalize() throws {
        let core = try position(true)
        if core.0 { try CoreOwnerFiles.moveExclusive(from: coreParent, name: ".session", to: archive, target: "core-session", identity: coreIdentity) }
        guard try position(true).1 else { throw CoreOwnerFailure.uncertain }
        let owner = try position(false)
        if owner.0 { try CoreOwnerFiles.moveExclusive(from: ownerParent, name: ".session", to: archive, target: "owner-session", identity: ownerIdentity) }
        guard try bothArchived() else { throw CoreOwnerFailure.uncertain }
        // A new user release may sync an already moved known target. It does
        // not reissue either rename when destination facts already prove it.
        guard fsync(coreParent.fd) == 0, fsync(ownerParent.fd) == 0, fsync(archive.fd) == 0 else { throw CoreOwnerFailure.uncertain }
        try coreParent.verify(); try ownerParent.verify(); try archive.verify()
    }
    func bothArchived() throws -> Bool { let core = try position(true), owner = try position(false); return core.1 && owner.1 }
}

final class CoreOwnerStore {
    let context: CoreOwnerContext
    let workspace: String
    let coreLease: String
    let controlSocket: String
    let ownerIdentity: CoreOwnerProcessIdentity
    private(set) var journal: CoreOwnerJournal
    private(set) var bytes: Data
    private let lockFile: CoreOwnerLock
    private var released = false
    private var releaseAttempt: CoreOwnerReleaseAttempt?
    var releasePending: Bool { releaseAttempt != nil && !released }
    func knownArchivedAfterFailure() -> Bool { (try? releaseAttempt?.bothArchived()) == true }
    private var attemptedJournal: Data?, attemptedLease: Data?
    var revision: String { coreOwnerHash(bytes) }

    static func locations(_ context: CoreOwnerContext) throws -> (String, String) {
        try context.validate()
        let workspace = context.stateRoot + "/CoreOwner/.session", core = context.stateRoot + "/Core/.session"
        // Before any directory/lock/lease creation, including partial journals.
        guard (workspace + "/owner.sock").utf8.count <= 103, (workspace + "/api.sock").utf8.count <= 103 else { throw CoreOwnerFailure.refused }
        return (workspace, core)
    }
    static func preferences(_ context: CoreOwnerContext) throws -> String {
        let path = context.stateRoot + "/Core/preferences.json"
        if try CoreOwnerFiles.absent(path) { return coreOwnerHash(Data("missing core preferences".utf8)) }
        let data = try CoreOwnerFiles.read(path, maximum: 4096)
        let object = try coreOwnerObject(data, limit: 4096)
        guard Set(object.keys) == ["version", "mode"], RelayTunStrictJSON.integer(object["version"]) == 1,
              ["rule", "global", "direct"].contains(object["mode"] as? String ?? "") else { throw CoreOwnerFailure.record }
        return coreOwnerHash(data)
    }
    init(request: [String: Any], main: CoreOwnerProcessIdentity, owner: CoreOwnerProcessIdentity) throws {
        guard Set(request.keys) == ["version", "contract", "requestId", "action", "context", "expectedRevision", "profileId", "sourceSHA256", "httpPort", "mode"],
              RelayTunStrictJSON.integer(request["version"]) == 1, request["contract"] as? String == RelayCoreOwnerRelease.contract,
              request["action"] as? String == "reserve", request["mode"] as? String == "rule",
              let object = request["context"] as? [String: Any], Set(object.keys) == ["home", "stateRoot"],
              let home = object["home"] as? String, let root = object["stateRoot"] as? String,
              let port = RelayTunStrictJSON.integer(request["httpPort"]), (1024...65535).contains(port) else { throw CoreOwnerFailure.invalid }
        _ = try coreOwnerUUID(request["requestId"])
        let profile = try coreOwnerUUID(request["profileId"]), source = try coreOwnerSHA(request["sourceSHA256"]), expected = try coreOwnerSHA(request["expectedRevision"])
        context = .init(home: home, stateRoot: root)
        (workspace, coreLease) = try Self.locations(context)
        controlSocket = workspace + "/owner.sock"; ownerIdentity = owner
        let (_, resourceSHA) = try CoreOwnerCore.resource(selfIdentity: owner)
        // No filesystem mutation precedes complete path/resource/caller checks.
        try CoreOwnerIdentity.verify(main, identifier: RelayCoreOwnerRelease.applicationID)
        try CoreOwnerIdentity.verify(owner, identifier: RelayCoreOwnerRelease.helperID)
        guard try Self.preferences(context) == expected,
              try CoreOwnerFiles.absent(workspace), try CoreOwnerFiles.absent(coreLease) else { throw CoreOwnerFailure.record }
        for parent in [root, root + "/CoreOwner", root + "/Core"] {
            _ = try CoreOwnerFiles.directory(parent, create: true, home: home)
        }
        _ = try CoreOwnerFiles.privateDirectory(root + "/CoreOwner", home: home)
        let lock = root + "/CoreOwner/owner.lock"
        lockFile = try CoreOwnerLock(lock)
        guard try Self.preferences(context) == expected, try CoreOwnerFiles.absent(workspace), try CoreOwnerFiles.absent(coreLease) else { throw CoreOwnerFailure.record }
        try lockFile.verify()
        try CoreOwnerFiles.mkdirExclusive(workspace)
        try CoreOwnerFiles.sync(root + "/CoreOwner")
        let workspaceInfo = try CoreOwnerFiles.privateDirectory(workspace, home: home), session = UUID().uuidString.lowercased()
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let created = formatter.string(from: Date())
        let rawObject: [String: Any] = ["version": 1, "token": session, "mode": "rule", "createdAt": created, "phase": "starting",
                                       "runtime": ["kind": "localProxy", "httpPort": port, "profileId": profile, "sourceSHA256": source, "resolverMode": "off"]]
        let raw = try JSONSerialization.data(withJSONObject: rawObject, options: [.sortedKeys, .withoutEscapingSlashes])
        journal = .init(version: 1, contract: RelayCoreOwnerRelease.contract, sessionId: session, phase: "reserved", owner: owner, core: nil,
                        coreLease: .init(token: session, directoryIdentity: "preparing", ownerSHA256: coreOwnerHash(raw)),
                        runtime: .init(directory: workspace, socket: workspace + "/api.sock", httpPort: port, profileId: profile,
                                       sourceSHA256: source, configurationSHA256: nil, mode: "rule", coreResourceSHA256: resourceSHA),
                        attachedMain: main, controlLost: false, detached: false, createdAt: created,
                        workspaceIdentity: CoreOwnerFiles.identity(workspaceInfo), leaseRaw: String(decoding: raw, as: UTF8.self))
        bytes = try coreOwnerEncode(journal)
        // Owner-only preparing journal precedes Core lease and every child. A
        // crash in this gap remains a known auxiliary actor, never idle.
        try CoreOwnerFiles.publish(bytes, path: workspace + "/owner.json")
        guard try Self.preferences(context) == expected, try CoreOwnerFiles.absent(coreLease) else { throw CoreOwnerFailure.record }
        try lockFile.verify(); try CoreOwnerFiles.mkdirExclusive(coreLease)
        try CoreOwnerFiles.sync(root + "/Core")
        try CoreOwnerFiles.publish(raw, path: coreLease + "/owner.json", maximum: 4096)
        journal.coreLease = .init(token: session, directoryIdentity: CoreOwnerFiles.identity(try CoreOwnerFiles.privateDirectory(coreLease, home: home)), ownerSHA256: coreOwnerHash(raw))
        try persist()
    }
    func assertCurrent() throws {
        try lockFile.verify()
        guard !released, try CoreOwnerFiles.identity(CoreOwnerFiles.privateDirectory(workspace, home: context.home)) == journal.workspaceIdentity,
              try CoreOwnerFiles.read(workspace + "/owner.json") == bytes,
              try CoreOwnerFiles.identity(CoreOwnerFiles.privateDirectory(coreLease, home: context.home)) == journal.coreLease.directoryIdentity,
              try CoreOwnerFiles.read(coreLease + "/owner.json", maximum: 4096) == Data(journal.leaseRaw.utf8) else { throw CoreOwnerFailure.record }
        try CoreOwnerIdentity.verify(ownerIdentity, identifier: RelayCoreOwnerRelease.helperID)
    }
    func persist(_ edit: ((inout CoreOwnerJournal) -> Void)? = nil) throws {
        // Initial preparing->reserved update has a now-complete Core lease.
        guard try CoreOwnerFiles.identity(CoreOwnerFiles.privateDirectory(workspace, home: context.home)) == journal.workspaceIdentity,
              try CoreOwnerFiles.read(workspace + "/owner.json") == bytes else { throw CoreOwnerFailure.record }
        var next = journal; edit?(&next)
        let proposed = try coreOwnerEncode(next)
        attemptedJournal = proposed
        try CoreOwnerFiles.publish(proposed, path: workspace + "/owner.json", previous: bytes)
        journal = next; bytes = proposed; attemptedJournal = nil
    }
    func updateLease(phase: String, pid: pid_t?) throws {
        try assertCurrent()
        var object = try coreOwnerObject(Data(journal.leaseRaw.utf8), limit: 4096)
        object["phase"] = phase
        if let pid { object["pid"] = Int(pid) } else { object.removeValue(forKey: "pid") }
        let raw = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        attemptedLease = raw
        try CoreOwnerFiles.publish(raw, path: coreLease + "/owner.json", previous: Data(journal.leaseRaw.utf8), maximum: 4096)
        // A crash between lease and owner journal writes is conservative unknown.
        journal.leaseRaw = String(decoding: raw, as: UTF8.self)
        journal.coreLease = .init(token: journal.sessionId, directoryIdentity: journal.coreLease.directoryIdentity, ownerSHA256: coreOwnerHash(raw))
        try persist(); attemptedLease = nil
    }
    // Explicit recovery only. Reconcile bytes from this exact in-memory
    // owner's attempted writes; never construct ownership from a disk PID.
    func reconcileAttempt() throws {
        let workspaceInfo = try CoreOwnerFiles.privateDirectory(workspace, home: context.home)
        let leaseInfo = try CoreOwnerFiles.privateDirectory(coreLease, home: context.home)
        guard CoreOwnerFiles.identity(workspaceInfo) == journal.workspaceIdentity,
              CoreOwnerFiles.identity(leaseInfo) == journal.coreLease.directoryIdentity else { throw CoreOwnerFailure.record }
        let observed = try CoreOwnerFiles.read(workspace + "/owner.json")
        guard observed == bytes || observed == attemptedJournal else { throw CoreOwnerFailure.record }
        var recovered = try JSONDecoder().decode(CoreOwnerJournal.self, from: observed)
        guard try coreOwnerEncode(recovered) == observed, recovered.owner == ownerIdentity,
              recovered.sessionId == journal.sessionId, recovered.workspaceIdentity == journal.workspaceIdentity else { throw CoreOwnerFailure.record }
        let rawLease = try CoreOwnerFiles.read(coreLease + "/owner.json", maximum: 4096)
        guard rawLease == Data(recovered.leaseRaw.utf8) || rawLease == attemptedLease else { throw CoreOwnerFailure.record }
        try CoreOwnerIdentity.verify(ownerIdentity, identifier: RelayCoreOwnerRelease.helperID)
        // Sync exactly observed known bytes; never retry launch/detach/stop.
        try CoreOwnerFiles.sync(workspace); try CoreOwnerFiles.sync(coreLease)
        if rawLease != Data(recovered.leaseRaw.utf8) {
            recovered.leaseRaw = String(decoding: rawLease, as: UTF8.self)
            recovered.coreLease = .init(token: recovered.sessionId, directoryIdentity: recovered.coreLease.directoryIdentity, ownerSHA256: coreOwnerHash(rawLease))
            recovered.phase = "uncertain"
            let repaired = try coreOwnerEncode(recovered)
            attemptedJournal = repaired
            try CoreOwnerFiles.publish(repaired, path: workspace + "/owner.json", previous: observed)
            bytes = repaired
        } else { bytes = observed }
        journal = recovered; attemptedJournal = nil; attemptedLease = nil
        try assertCurrent()
    }
    func release() throws -> CoreOwnerSnapshot {
        if releaseAttempt == nil {
            try assertCurrent()
            guard ["reserved", "closed"].contains(journal.phase), journal.core == nil || journal.phase == "closed" else { throw CoreOwnerFailure.refused }
            // Host already proves no live parser/Core, including a cancelled
            // reservation. A closed journal stays reachable after first move.
            if journal.phase == "reserved" { try persist { $0.phase = "closed" } }
            releaseAttempt = try CoreOwnerReleaseAttempt(context: context, journal: journal, bytes: bytes)
        }
        guard let attempt = releaseAttempt else { throw CoreOwnerFailure.record }
        try lockFile.verify()
        try attempt.finalize()
        released = true
        return journal.snapshot(revision: revision, released: true)
    }
    static func load(_ context: CoreOwnerContext, allowMissingLease: Bool = false, closedMissingOnly: Bool = false) throws -> (CoreOwnerJournal, Data) {
        let (workspace, coreLease) = try locations(context)
        let workspaceInfo = try CoreOwnerFiles.privateDirectory(workspace, home: context.home)
        let data = try CoreOwnerFiles.read(workspace + "/owner.json")
        let object = try coreOwnerObject(data, limit: 32768)
        let expected: Set<String> = ["version", "contract", "sessionId", "phase", "owner", "coreLease", "runtime", "controlLost", "detached", "createdAt", "workspaceIdentity", "leaseRaw"]
        guard Set(object.keys).subtracting(["core", "attachedMain"]) == expected else { throw CoreOwnerFailure.record }
        let journal = try JSONDecoder().decode(CoreOwnerJournal.self, from: data)
        guard try coreOwnerEncode(journal) == data, journal.version == 1, journal.contract == RelayCoreOwnerRelease.contract,
              journal.workspaceIdentity == CoreOwnerFiles.identity(workspaceInfo), journal.runtime.directory == workspace,
              journal.runtime.socket == workspace + "/api.sock", journal.coreLease.token == journal.sessionId,
              journal.coreLease.ownerSHA256 == coreOwnerHash(Data(journal.leaseRaw.utf8)) else { throw CoreOwnerFailure.record }
        if try CoreOwnerFiles.absent(coreLease) { guard allowMissingLease, !closedMissingOnly || journal.phase == "closed" else { throw CoreOwnerFailure.record } }
        else {
            guard try CoreOwnerFiles.identity(CoreOwnerFiles.privateDirectory(coreLease, home: context.home)) == journal.coreLease.directoryIdentity,
                  try CoreOwnerFiles.read(coreLease + "/owner.json", maximum: 4096) == Data(journal.leaseRaw.utf8) else { throw CoreOwnerFailure.record }
        }
        _ = try coreOwnerUUID(journal.sessionId); _ = try coreOwnerSHA(journal.runtime.sourceSHA256)
        return (journal, data)
    }
}
