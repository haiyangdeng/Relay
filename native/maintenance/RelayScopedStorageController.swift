import AppKit
import Darwin
@preconcurrency import Foundation

// Persistent actual-Main controller. There is no short-lived CLI transport and
// no automatic mount, detach, force, retry, delete, disk adoption or app quit.
@MainActor final class RelayScopedStorageController {
    private var operating = false
    private var command: RelayScopedStorageCommand?
    private func current(_ validity: @Sendable () -> Bool) throws {
        guard validity() else { throw RelayScopedStorageFailure.cancelled }
    }
    private func execute(_ arguments: [String], files: RelayScopedStorageFiles) async throws -> Data {
        guard command == nil else { throw RelayScopedStorageFailure.pending }
        try RelayScopedStorageCommand.verifyTool()
        defer { if command?.drained == true { command = nil } }
        return try await withCheckedThrowingContinuation { continuation in
            let operation = RelayScopedStorageCommand(continuation, onDrained: { [weak self, files] in
                // Keep the exact directory lock and child until actual drain,
                // including after a deadline/oversize already rejected JS.
                Task { @MainActor in
                    _ = files
                    if self?.command?.drained == true { self?.command = nil }
                }
            })
            command = operation
            operation.start(arguments: arguments, privateHome: files.path)
        }
    }
    private func requireActionContext(_ validity: @escaping @Sendable () -> Bool) throws {
        try current(validity)
        do { try RelayGuardActionContext.check(isCurrent: validity) }
        catch RelayGuardManagementFailure.operationPending { throw RelayScopedStorageFailure.operationPending }
        catch RelayGuardManagementFailure.userCancelled { throw RelayScopedStorageFailure.cancelled }
    }
    private func mappings(_ data: Data, files: RelayScopedStorageFiles) throws -> [[String: Any]] {
        guard let plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let images = plist["images"] as? [[String: Any]], images.count <= 128 else { throw RelayScopedStorageFailure.uncertain }
        let own = images.filter { $0["image-path"] as? String == files.imagePath }
        guard own.count <= 1 else { throw RelayScopedStorageFailure.uncertain }
        if let image = own.first {
            guard image["shadow-path"] == nil, let entities = image["system-entities"] as? [[String: Any]],
                  !entities.isEmpty, entities.count <= 32 else { throw RelayScopedStorageFailure.uncertain }
            return entities
        }
        return []
    }
    private func info(_ files: RelayScopedStorageFiles) async throws -> [[String: Any]] {
        try mappings(await execute(["info", "-plist"], files: files), files: files)
    }
    private func mount(_ entities: [[String: Any]], files: RelayScopedStorageFiles,
                       expected: RelayScopedStorageRecord) throws -> RelayScopedStorageMount {
        guard try files.ownBase() == expected.base, try files.image() == expected.image else { throw RelayScopedStorageFailure.changed }
        try files.coveredAnchor(expected.anchor)
        let devices = try entities.map { entity -> String in
            guard let device = entity["dev-entry"] as? String,
                  device.range(of: "^/dev/disk[0-9]+(?:s[0-9]+)*$", options: .regularExpression) != nil else { throw RelayScopedStorageFailure.changed }
            return device
        }.sorted()
        guard Set(devices).count == devices.count, !devices.isEmpty else { throw RelayScopedStorageFailure.changed }
        let mounted = entities.filter { $0["mount-point"] != nil }
        guard mounted.count == 1, mounted[0]["mount-point"] as? String == files.volumePath,
              let device = mounted[0]["dev-entry"] as? String else { throw RelayScopedStorageFailure.changed }
        let (fs, root) = try files.filesystem()
        guard RelayScopedStorageFiles.text(fs.f_fstypename) == "apfs", RelayScopedStorageFiles.text(fs.f_mntfromname) == device,
              RelayScopedStorageFiles.text(fs.f_mntonname) == files.volumePath,
              fs.f_flags & UInt32(MNT_NOSUID) != 0, fs.f_flags & UInt32(MNT_RDONLY) == 0,
              fs.f_bsize > 0, fs.f_blocks <= 536_870_912 / UInt64(fs.f_bsize), root.dev != expected.anchor.dev else { throw RelayScopedStorageFailure.changed }
        return .init(devices: devices, volumeDevice: device, filesystem: [fs.f_fsid.val.0, fs.f_fsid.val.1], root: root)
    }
    private func item(_ files: RelayScopedStorageFiles, record: RelayScopedStorageRecord, revision: String) -> RelayScopedStorageItem {
        .init(id: files.id, revision: revision, phase: record.phase,
            canClose: !files.retained && ["mounted", "detaching", "closed"].contains(record.phase),
            writeClosure: record.phase == "closed" ? "closedForOrdinarySandboxedWriters" : "unconfirmed")
    }
    private func list() async throws -> [RelayScopedStorageItem] {
        let home = try RelayBrowserContract.realHome().path
        var result: [RelayScopedStorageItem] = [], seen = Set<String>(), mappingSnapshot: Data?
        for name in ["Sessions", "Retained"] {
            let path = home + "/Library/Application Support/Relay-ScopedCLI/" + name
            var stat = stat()
            if lstat(path, &stat) != 0 { guard errno == ENOENT else { throw RelayScopedStorageFailure.invalid }; continue }
            let directory = try RelayMaintenanceDirectory(home: home, components: ["Library", "Application Support", "Relay-ScopedCLI", name])
            for id in try directory.list() {
                guard RelayMaintenanceGate.uuid(id), seen.insert(id).inserted, result.count < 64 else { throw RelayScopedStorageFailure.invalid }
                let files = try RelayScopedStorageFiles(id: id, retained: name == "Retained")
                if let (record, revision) = try files.latest() {
                    if record.phase == "closed" {
                        if mappingSnapshot == nil { mappingSnapshot = try await execute(["info", "-plist"], files: files) }
                        guard try mappings(mappingSnapshot!, files: files).isEmpty,
                              try files.image() == record.image else { throw RelayScopedStorageFailure.uncertain }
                        try files.namedClosedAnchor(record.anchor)
                        var fs = statfs()
                        guard statfs(files.volumePath, &fs) == 0,
                              RelayScopedStorageFiles.text(fs.f_mntonname) != files.volumePath else { throw RelayScopedStorageFailure.uncertain }
                    }
                    result.append(item(files, record: record, revision: revision))
                } else {
                    // Legacy directory-only launch: retain without inventing a
                    // cold archive or a process-tree exit fact.
                    result.append(.init(id: id, revision: String(repeating: "0", count: 64), phase: "legacy", canClose: false, writeClosure: "unconfirmed"))
                }
            }
        }
        return result.sorted { $0.id < $1.id }
    }
    private func create(_ id: String, validity: @escaping @Sendable () -> Bool) async throws -> RelayScopedStorageItem {
        guard RelayGuardManagementRelease.scopedCLILaunchSupported else { throw RelayScopedStorageFailure.unavailable }
        let files = try RelayScopedStorageFiles(id: id, locking: true)
        guard !files.retained, try files.latest() == nil,
              try files.names() == [".storage.lock", "session.json", "support"] else { throw RelayScopedStorageFailure.changed }
        try requireActionContext(validity)
        try current(validity)
        let anchor = try files.makeAnchor()
        _ = try files.append(phase: "creating", anchor: anchor)
        try current(validity)
        _ = try await execute(["create", "-size", "512m", "-fs", "APFS", "-type", "SPARSE", "-uid", String(getuid()), "-gid", String(getgid()), "-mode", "0700", "-volname", "RelayCLI-" + id, files.imagePath], files: files)
        try files.base.verify()
        let descriptor = openat(files.base.fd, "capsule.sparseimage", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw RelayScopedStorageFailure.uncertain }
        defer { Darwin.close(descriptor) }
        var imageStat = stat()
        guard fstat(descriptor, &imageStat) == 0, imageStat.st_uid == getuid(), imageStat.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              imageStat.st_nlink == 1, fchmod(descriptor, 0o600) == 0, fsync(descriptor) == 0 else { throw RelayScopedStorageFailure.uncertain }
        let image = try files.image()
        _ = try files.append(phase: "created", anchor: anchor, image: image)
        guard try await info(files).isEmpty else { throw RelayScopedStorageFailure.uncertain }
        try files.namedClosedAnchor(anchor); try current(validity)
        let attaching = try files.append(phase: "attaching", anchor: anchor, image: image).0
        try current(validity)
        _ = try await execute(["attach", "-plist", "-nobrowse", "-noautoopen", "-owners", "on", "-mountpoint", files.volumePath, files.imagePath], files: files)
        let mounted = try mount(await info(files), files: files, expected: attaching)
        let volume = try RelayMaintenanceDirectory(home: files.home, components: ["Library", "Application Support", "Relay-ScopedCLI", "Sessions", id, "volume"])
        for name in ["home", "work"] {
            try volume.verify()
            guard mkdirat(volume.fd, name, 0o700) == 0 else { throw RelayScopedStorageFailure.uncertain }
        }
        let cliHome = try RelayMaintenanceDirectory(home: files.home, components: ["Library", "Application Support", "Relay-ScopedCLI", "Sessions", id, "volume", "home"])
        guard mkdirat(cliHome.fd, "tmp", 0o700) == 0, fsync(cliHome.fd) == 0, fsync(volume.fd) == 0 else { throw RelayScopedStorageFailure.uncertain }
        guard try mount(await info(files), files: files, expected: attaching) == mounted else { throw RelayScopedStorageFailure.changed }
        let (record, revision) = try files.append(phase: "mounted", anchor: anchor, image: image, mount: mounted)
        try current(validity)
        return item(files, record: record, revision: revision)
    }
    private func close(_ id: String, revision: String, validity: @escaping @Sendable () -> Bool) async throws -> RelayScopedStorageItem {
        let files = try RelayScopedStorageFiles(id: id, locking: true)
        guard let (record, actual) = try files.latest(), actual == revision, let image = record.image,
              ["mounted", "detaching", "closed"].contains(record.phase), try files.ownBase() == record.base,
              try files.image() == image else { throw RelayScopedStorageFailure.changed }
        try requireActionContext(validity)
        guard try files.latest()?.1 == revision else { throw RelayScopedStorageFailure.changed }
        let entities = try await info(files)
        if record.phase == "mounted" {
            guard try mount(entities, files: files, expected: record) == record.mount else { throw RelayScopedStorageFailure.changed }
            _ = try files.append(phase: "detaching", anchor: record.anchor, image: image, mount: record.mount)
            try current(validity)
            // Normal detach only. EBUSY/error/deadline preserves all records;
            // no force, retry, automatic inverse operation or numeric disk ID.
            do { _ = try await execute(["detach", files.volumePath], files: files) }
            catch RelayScopedStorageFailure.operationFailed {
                // A positively drained failed command (including busy) may
                // leave the same mount intact. Re-observe and journal that
                // fact so a later explicit action can try again. This
                // request never retries detach. Deadlines/lost replies do not
                // take this branch and remain unconfirmed.
                guard command == nil, try mount(await info(files), files: files, expected: record) == record.mount else { throw RelayScopedStorageFailure.uncertain }
                _ = try files.append(phase: "mounted", anchor: record.anchor, image: image, mount: record.mount)
                throw RelayScopedStorageFailure.operationFailed
            }
        } else {
            // A previous submitted detach may only be finalized by positive
            // absent-mapping evidence, never blindly issued a second time.
            guard entities.isEmpty else { throw RelayScopedStorageFailure.uncertain }
        }
        guard try await info(files).isEmpty, try files.image() == image else { throw RelayScopedStorageFailure.uncertain }
        try files.namedClosedAnchor(record.anchor)
        var fs = statfs()
        guard statfs(files.volumePath, &fs) == 0, RelayScopedStorageFiles.text(fs.f_mntonname) != files.volumePath else { throw RelayScopedStorageFailure.uncertain }
        let (closed, closedRevision) = record.phase == "closed" ? (record, revision) : try files.append(phase: "closed", anchor: record.anchor, image: image, mount: record.mount)
        try current(validity)
        try files.namedClosedAnchor(record.anchor)
        try files.archive()
        let retained = try RelayScopedStorageFiles(id: id, retained: true)
        guard try retained.latest()?.1 == closedRevision, try retained.image() == image else { throw RelayScopedStorageFailure.uncertain }
        try retained.namedClosedAnchor(record.anchor)
        return item(retained, record: closed, revision: closedRevision)
    }
    func handle(id: String, action: String, workspace: String?, revision: String?, validity: @escaping @Sendable () -> Bool) async -> String {
        var items: [RelayScopedStorageItem] = [], status = "refused", reason = "unavailable"
        if operating || command != nil { reason = "pending" }
        else {
            operating = true
            defer { operating = false }
            do {
                try RelayMaintenanceGate.ownIdentity(); try current(validity)
                switch action {
                case "list": items = try await list()
                case "create": items = [try await create(workspace!, validity: validity)]
                case "close": items = [try await close(workspace!, revision: revision!, validity: validity)]
                default: throw RelayScopedStorageFailure.invalid
                }
                status = "ok"; reason = "observed"
            } catch let failure as RelayScopedStorageFailure { reason = failure.rawValue; status = failure == .uncertain || failure == .changed ? "uncertain" : "refused" }
            catch { reason = "unconfirmed"; status = "uncertain" }
        }
        let reply = RelayScopedStorageReply(id: id, action: action, status: status, reason: reason, pending: command != nil, items: items)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(reply)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

@objc(RelayScopedStorageHostBridge) @MainActor final class RelayScopedStorageHostBridge: NSObject {
    private static let controller = RelayScopedStorageController()
    @objc(request:validity:completion:)
    nonisolated static func request(_ text: String, validity: @escaping @Sendable () -> Bool, completion: @escaping @Sendable (String) -> Void) {
        guard text.utf8.count <= 4096, let data = text.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any], raw["version"] as? Int == 1,
              let id = raw["id"] as? String, RelayMaintenanceGate.uuid(id), let action = raw["action"] as? String,
              ["list", "create", "close"].contains(action) else { completion("{}"); return }
        let expected = Set(["version", "id", "action"] + (action == "list" ? [] : action == "create" ? ["workspaceID"] : ["workspaceID", "revision"]))
        let workspace = raw["workspaceID"] as? String, revision = raw["revision"] as? String
        guard Set(raw.keys) == expected, action == "list" || workspace.map(RelayMaintenanceGate.uuid) == true,
              action != "close" || RelayMaintenanceGate.hash(revision) else { completion("{}"); return }
        Task { @MainActor in completion(await controller.handle(id: id, action: action, workspace: workspace, revision: revision, validity: validity)) }
    }
}
