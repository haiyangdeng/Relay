import Darwin
import Foundation

@MainActor final class RelayScopedStorageFiles {
    let home: String, id: String, retained: Bool
    let root: RelayMaintenanceDirectory, collection: RelayMaintenanceDirectory, base: RelayMaintenanceDirectory
    let path: String, imagePath: String, volumePath: String
    private var lockFD: Int32 = -1
    private var anchorFD: Int32 = -1
    init(id: String, retained: Bool = false, create: Bool = false, locking: Bool = false) throws {
        guard RelayMaintenanceGate.uuid(id) else { throw RelayScopedStorageFailure.invalid }
        self.id = id; self.retained = retained
        home = try RelayBrowserContract.realHome().path
        let prefix = ["Library", "Application Support", "Relay-ScopedCLI"]
        root = try .init(home: home, components: prefix, create: create)
        let name = retained ? "Retained" : "Sessions"
        collection = try .init(home: home, components: prefix + [name], create: create)
        base = try .init(home: home, components: prefix + [name, id])
        for directory in [root, collection] {
            var info = stat()
            guard fstat(directory.fd, &info) == 0, info.st_mode & 0o7777 == 0o700 else { throw RelayScopedStorageFailure.changed }
        }
        path = home + "/Library/Application Support/Relay-ScopedCLI/" + name + "/" + id
        imagePath = path + "/capsule.sparseimage"; volumePath = path + "/volume"
        if locking {
            lockFD = openat(base.fd, ".storage.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
            var info = stat()
            guard lockFD >= 0, fstat(lockFD, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o7777 == 0o600,
                  info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_nlink == 1,
                  flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { if lockFD >= 0 { Darwin.close(lockFD) }; lockFD = -1; throw RelayScopedStorageFailure.busy }
        }
        // Existing Main helper creates this marker before Native ever writes.
        guard let marker = try base.read("session.json", limit: 4096),
              let raw = try JSONSerialization.jsonObject(with: marker) as? [String: Any],
              Set(raw.keys) == Set(["version", "id", "createdAt", "storage", "descendantsExited"]),
              let version = raw["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.intValue == 1, raw["id"] as? String == id,
              let date = raw["createdAt"] as? NSNumber, CFGetTypeID(date) != CFBooleanGetTypeID(), date.doubleValue > 0, date.doubleValue.isFinite, date.doubleValue <= 9_007_199_254_740_991, date.doubleValue.rounded() == date.doubleValue,
              raw["storage"] as? String == "outsideRelayRoot", let descendants = raw["descendantsExited"] as? NSNumber, CFGetTypeID(descendants) == CFBooleanGetTypeID(), !descendants.boolValue else { throw RelayScopedStorageFailure.invalid }
    }
    deinit { if anchorFD >= 0 { Darwin.close(anchorFD) }; if lockFD >= 0 { Darwin.close(lockFD) } }
    func ownBase() throws -> RelayMaintenanceIdentity {
        try base.verify(); var info = stat()
        guard fstat(base.fd, &info) == 0, info.st_mode & 0o7777 == 0o700 else { throw RelayScopedStorageFailure.changed }
        return try .init(info)
    }
    private func emptyACL(_ descriptor: Int32) throws {
        guard let acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) else { throw RelayScopedStorageFailure.changed }
        defer { acl_free(UnsafeMutableRawPointer(acl)) }
        var entry: acl_entry_t?
        guard acl_get_entry(acl, Int32(ACL_FIRST_ENTRY.rawValue), &entry) == -1, errno == EINVAL else { throw RelayScopedStorageFailure.changed }
    }
    func makeAnchor() throws -> RelayMaintenanceIdentity {
        try base.verify()
        guard mkdirat(base.fd, "volume", 0o500) == 0 else { throw RelayScopedStorageFailure.changed }
        anchorFD = openat(base.fd, "volume", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard anchorFD >= 0, let acl = acl_init(0) else { throw RelayScopedStorageFailure.changed }
        defer { acl_free(UnsafeMutableRawPointer(acl)) }
        // Remove inherited ACL only from this exclusively-created empty object.
        guard acl_set_fd_np(anchorFD, acl, ACL_TYPE_EXTENDED) == 0, fchmod(anchorFD, 0o500) == 0,
              fsync(anchorFD) == 0, fsync(base.fd) == 0 else { throw RelayScopedStorageFailure.uncertain }
        return try anchor()
    }
    func anchor() throws -> RelayMaintenanceIdentity {
        try base.verify()
        if anchorFD < 0 {
            // Only after a verified unmounted mapping may the named anchor be
            // opened; a mounted APFS root is never the host DAC evidence.
            anchorFD = openat(base.fd, "volume", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        var info = stat()
        guard anchorFD >= 0, fstat(anchorFD, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o7777 == 0o500 else { throw RelayScopedStorageFailure.changed }
        try emptyACL(anchorFD)
        return try .init(info)
    }
    func coveredAnchor(_ expected: RelayMaintenanceIdentity) throws {
        try base.verify()
        // A held host FD plus the parent filesystem's directory entry proves
        // that hdiutil did not replace/remove the covered mountpoint. Recovery
        // in a new Main instead relies on the durable host identity and this
        // parent entry; the host FD cannot be reopened through an active mount.
        if anchorFD >= 0 { guard try anchor() == expected else { throw RelayScopedStorageFailure.changed } }
        let duplicate = dup(base.fd)
        guard duplicate >= 0, let directory = fdopendir(duplicate) else { if duplicate >= 0 { Darwin.close(duplicate) }; throw RelayScopedStorageFailure.changed }
        defer { closedir(directory) }; rewinddir(directory)
        var found = false, count = 0
        while true {
            errno = 0
            guard let entry = readdir(directory) else {
                guard errno == 0 else { throw RelayScopedStorageFailure.changed }
                break
            }
            count += 1; guard count <= 128 else { throw RelayScopedStorageFailure.changed }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
            if name == "volume" { guard UInt64(entry.pointee.d_ino) == expected.ino else { throw RelayScopedStorageFailure.changed }; found = true }
        }
        var parent = stat()
        guard found, fstat(base.fd, &parent) == 0, UInt64(parent.st_dev) == expected.dev else { throw RelayScopedStorageFailure.changed }
    }
    func namedClosedAnchor(_ expected: RelayMaintenanceIdentity) throws {
        guard try anchor() == expected, try base.identity("volume") == expected else { throw RelayScopedStorageFailure.changed }
        let duplicate = dup(anchorFD)
        guard duplicate >= 0, let directory = fdopendir(duplicate) else { if duplicate >= 0 { Darwin.close(duplicate) }; throw RelayScopedStorageFailure.changed }
        defer { closedir(directory) }; rewinddir(directory)
        while true {
            errno = 0
            guard let entry = readdir(directory) else {
                guard errno == 0 else { throw RelayScopedStorageFailure.changed }
                break
            }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
            guard name == "." || name == ".." else { throw RelayScopedStorageFailure.changed }
        }
    }
    func image() throws -> RelayMaintenanceIdentity {
        try base.verify(); var info = stat()
        guard fstatat(base.fd, "capsule.sparseimage", &info, AT_SYMLINK_NOFOLLOW) == 0,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & 0o7777 == 0o600, info.st_size > 0, info.st_size <= 1_073_741_824 else { throw RelayScopedStorageFailure.changed }
        return try .init(info)
    }
    func names() throws -> [String] {
        try base.verify()
        let duplicate = openat(base.fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard duplicate >= 0, let directory = fdopendir(duplicate) else { if duplicate >= 0 { Darwin.close(duplicate) }; throw RelayScopedStorageFailure.changed }
        defer { closedir(directory) }
        var names: [String] = []
        while true {
            errno = 0
            guard let entry = readdir(directory) else {
                guard errno == 0 else { throw RelayScopedStorageFailure.changed }
                break
            }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
            if name == "." || name == ".." { continue }
            guard names.count < 128 else { throw RelayScopedStorageFailure.changed }
            try RelayMaintenanceDirectory.name(name); names.append(name)
        }
        try base.verify(); return names.sorted()
    }
    private func metadata() throws -> RelayMaintenanceDirectory? {
        // The unpublished r1 storage-NN format is deliberately not guessed or
        // migrated. Its presence is unknown, never a legacy/no-image permit.
        guard try names().allSatisfy({ !$0.hasPrefix("storage-") }) else { throw RelayScopedStorageFailure.invalid }
        var info = stat()
        if fstatat(base.fd, "storage", &info, AT_SYMLINK_NOFOLLOW) != 0 {
            guard errno == ENOENT else { throw RelayScopedStorageFailure.changed }; return nil
        }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else { throw RelayScopedStorageFailure.changed }
        return try .init(home: home, components: ["Library", "Application Support", "Relay-ScopedCLI", retained ? "Retained" : "Sessions", id, "storage"])
    }
    private func journal() throws -> (RelayMaintenanceDirectory, Data, RelayScopedStorageRecord, String)? {
        guard let metadata = try metadata() else { return nil }
        // A missing first head or an interrupted publication is unknown. Never
        // scan orphan UUIDs and invent the latest committed system operation.
        guard try metadata.read("head-update.json") == nil, let bytes = try metadata.read("head.json", limit: 4096) else { throw RelayScopedStorageFailure.uncertain }
        let head = try RelayScopedStorageHead.decode(bytes)
        guard let recordBytes = try metadata.read(head.record), RelayMaintenanceDirectory.hash(recordBytes) == head.sha256 else { throw RelayScopedStorageFailure.uncertain }
        let record = try RelayScopedStorageRecord.decode(recordBytes)
        guard record.id == id else { throw RelayScopedStorageFailure.invalid }
        return (metadata, bytes, record, head.sha256)
    }
    func latest() throws -> (RelayScopedStorageRecord, String)? {
        try journal().map { ($0.2, $0.3) }
    }
    func append(phase: String, anchor: RelayMaintenanceIdentity, image: RelayMaintenanceIdentity? = nil,
                mount: RelayScopedStorageMount? = nil) throws -> (RelayScopedStorageRecord, String) {
        let previous = try journal()
        guard (previous?.2.sequence ?? 0) < 9_007_199_254_740_991 else { throw RelayScopedStorageFailure.uncertain }
        let identity = try ownBase()
        if let previous { guard previous.2.base == identity, previous.2.anchor == anchor else { throw RelayScopedStorageFailure.changed } }
        let record = RelayScopedStorageRecord(version: 1, id: id, sequence: (previous?.2.sequence ?? 0) + 1,
            previousSHA256: previous?.3 ?? "", phase: phase, base: identity, anchor: anchor, image: image, mount: mount)
        let bytes = try record.bytes(), sha = RelayMaintenanceDirectory.hash(bytes)
        let file = "record-" + UUID().uuidString.lowercased() + ".json"
        let head = try RelayScopedStorageHead(version: 1, record: file, sha256: sha).bytes()
        let directory: RelayMaintenanceDirectory
        if let previous { directory = previous.0 }
        else {
            try base.verify()
            guard mkdirat(base.fd, "storage", 0o700) == 0, fsync(base.fd) == 0, let created = try metadata(), try created.list().isEmpty else { throw RelayScopedStorageFailure.uncertain }
            directory = created
        }
        let update = try JSONSerialization.data(withJSONObject: ["version": 1, "previousHeadSHA256": previous.map { RelayMaintenanceDirectory.hash($0.1) } ?? "", "record": file, "sha256": sha], options: [.sortedKeys])
        // Durable publication intent precedes the record/head write. If any
        // subsequent receipt is unknown this marker remains and blocks every
        // operation; a new Main cannot treat an orphan record as committed.
        try directory.append("head-update.json", update)
        try directory.append(file, bytes)
        if let previous { try directory.replaceMarker("head.json", expected: previous.1, with: head) }
        else { try directory.append("head.json", head) }
        guard try directory.read("head.json") == head, try directory.read("head-update.json") == update else { throw RelayScopedStorageFailure.uncertain }
        let committed = "committed-" + UUID().uuidString.lowercased() + ".json"
        // Same exclusive file-rename primitive used by C05. Preserve every old
        // head and publication intent in storage/, without scanning history or
        // exhausting the fixed parent-dirent bound needed for mount identity.
        guard renameatx_np(directory.fd, "head-update.json", directory.fd, committed, UInt32(RENAME_EXCL)) == 0,
              fsync(directory.fd) == 0, try directory.read(committed) == update,
              try directory.read("head-update.json") == nil, try directory.read("head.json") == head else { throw RelayScopedStorageFailure.uncertain }
        guard let current = try journal(), current.3 == sha else { throw RelayScopedStorageFailure.uncertain }
        return (record, sha)
    }
    func filesystem() throws -> (statfs, RelayMaintenanceIdentity) {
        var fs = statfs(), info = stat()
        guard statfs(volumePath, &fs) == 0, lstat(volumePath, &info) == 0, info.st_uid == getuid(),
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o7777 == 0o700 else { throw RelayScopedStorageFailure.changed }
        return (fs, try .init(info))
    }
    static func text<T>(_ value: T) -> String {
        withUnsafePointer(to: value) { $0.withMemoryRebound(to: CChar.self, capacity: MemoryLayout<T>.size) { String(cString: $0) } }
    }
    func archive() throws {
        guard !retained else { return }
        let destination = try RelayMaintenanceDirectory(home: home, components: ["Library", "Application Support", "Relay-ScopedCLI", "Retained"], create: true)
        try collection.move(id, to: destination, as: id, identity: ownBase())
    }
}
