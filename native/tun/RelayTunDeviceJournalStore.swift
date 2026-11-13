import Foundation
import Darwin

/// Append-only intent/acknowledgement storage for device setup, independent of
/// the route/resolver transaction journal. No existing record is overwritten,
/// adopted or deleted. Only an exclusive directory for this new plan is owned.
final class RelayTunDeviceJournalStore {
    enum Failure: Error { case permission, invalid, busy, conflict, unsafe, uncertain, exhausted }
    private static let productionBase = "/Library/Application Support/Relay/Tun/DeviceJournal"
    private let plan: RelayTunNetworkTransaction.Plan
    private let base: String
    private let owner: uid_t
    private let group: gid_t
    private let testing: Bool
    private let lock = NSRecursiveLock()
    private var recording = false, failed = false
    private var directory: Int32 = -1
    private var identity: stat?
    private var previous: String?
    private var records: [(String, stat)] = []
    private static let recordLimit = 512
    private static let byteLimit = 262144

    private init(plan: RelayTunNetworkTransaction.Plan, base: String, owner: uid_t, group: gid_t, testing: Bool) throws {
        guard RelayTunNetworkEffects.uuid(plan.id), RelayTunNetworkEffects.digest(plan.configurationSHA256),
              RelayTunNetworkEffects.digest(plan.runtimeConfigurationSHA256), RelayTunNetworkEffects.digest(plan.effectsSHA256) else { throw Failure.invalid }
        self.plan = plan; self.base = base; self.owner = owner; self.group = group; self.testing = testing
    }
    deinit { if directory >= 0 { Darwin.close(directory) } }
    static func production(plan: RelayTunNetworkTransaction.Plan) throws -> RelayTunDeviceJournalStore {
        // Precedes all filesystem inspection and namespace creation.
        guard getuid() == 0, geteuid() == 0, getgid() == 0, getegid() == 0 else { throw Failure.permission }
        return try Self(plan: plan, base: productionBase, owner: 0, group: 0, testing: false)
    }
    #if RELAY_TUN_DEVICE_JOURNAL_TESTS
    static func isolated(plan: RelayTunNetworkTransaction.Plan, base: String) throws -> RelayTunDeviceJournalStore {
        guard getuid() > 0, geteuid() == getuid(), getegid() == getgid(), base.hasPrefix("/private/tmp/") else { throw Failure.permission }
        return try Self(plan: plan, base: base, owner: getuid(), group: getgid(), testing: true)
    }
    #endif
    private func gate() throws {
        guard !failed else { throw Failure.uncertain }
        #if RELAY_TUN_DEVICE_JOURNAL_TESTS
        if testing {
            guard getuid() == owner, geteuid() == owner, getgid() == group, getegid() == group else { throw Failure.permission }
            return
        }
        #endif
        guard !testing, base == Self.productionBase, getuid() == 0, geteuid() == 0,
              getgid() == 0, getegid() == 0, owner == 0, group == 0 else { throw Failure.permission }
    }
    private static func sameDirectory(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode
    }
    private static func sameFile(_ a: stat, _ b: stat) -> Bool {
        sameDirectory(a, b) && a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
            a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
            a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    /// Walk from / using held directory FDs. Only the final fixed DeviceJournal
    /// component may be created; unknown/unsafe ancestors are never repaired.
    private func openBase() throws -> Int32 {
        let parts = base.split(separator: "/").map(String.init)
        guard !parts.isEmpty, !parts.contains("."), !parts.contains("..") else { throw Failure.invalid }
        var parent = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw Failure.unsafe }
        do {
            for (index, part) in parts.enumerated() {
                var before = stat()
                let temporaryParent = testing && Array(parts.prefix(index)) == ["private", "tmp"]
                guard fstat(parent, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                      [uid_t(0), owner].contains(before.st_uid),
                      before.st_mode & 0o6022 == 0 || (temporaryParent && before.st_uid == 0 && before.st_mode & 0o7777 == 0o1777) else { throw Failure.unsafe }
                let last = index == parts.count - 1
                var child = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                if child < 0 && errno == ENOENT && last {
                    guard mkdirat(parent, part, 0o700) == 0 else { throw Failure.conflict }
                    guard fsync(parent) == 0 else { throw Failure.uncertain }
                    child = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                }
                guard child >= 0 else { throw Failure.unsafe }
                var held = stat(), linked = stat()
                let valid = fstat(child, &held) == 0 && fstatat(parent, part, &linked, AT_SYMLINK_NOFOLLOW) == 0 && Self.sameDirectory(held, linked)
                let temporaryChild = testing && Array(parts.prefix(index + 1)) == ["private", "tmp"]
                guard valid, [uid_t(0), owner].contains(held.st_uid), held.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                      held.st_mode & 0o6022 == 0 || (temporaryChild && held.st_uid == 0 && held.st_mode & 0o7777 == 0o1777),
                      !last || (held.st_uid == owner && held.st_gid == group && held.st_mode & 0o7777 == 0o700) else {
                    Darwin.close(child); throw Failure.unsafe
                }
                Darwin.close(parent); parent = child
            }
            return parent
        } catch { Darwin.close(parent); throw error }
    }
    private func ensureDirectory() throws {
        let parent = try openBase(); defer { Darwin.close(parent) }
        if directory < 0 {
            // Never resume an old writer or adopt a directory with this UUID.
            guard mkdirat(parent, plan.id, 0o700) == 0 else { throw Failure.conflict }
            guard fsync(parent) == 0 else { throw Failure.uncertain }
            directory = openat(parent, plan.id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard directory >= 0 else { throw Failure.uncertain }
            var info = stat()
            guard fstat(directory, &info) == 0, info.st_uid == owner, info.st_gid == group,
                  info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o7777 == 0o700 else { throw Failure.unsafe }
            identity = info
        }
        var linked = stat(), held = stat()
        guard let identity, fstat(directory, &held) == 0,
              fstatat(parent, plan.id, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              Self.sameDirectory(identity, held), Self.sameDirectory(held, linked) else { throw Failure.conflict }
    }
    private func inventory() throws {
        let copy = fcntl(directory, F_DUPFD_CLOEXEC, 10)
        guard copy >= 0 else { throw Failure.unsafe }
        guard let stream = fdopendir(copy) else { Darwin.close(copy); throw Failure.unsafe }
        defer { closedir(stream) }; rewinddir(stream)
        var names: Set<String> = []
        while true {
            errno = 0
            guard let entry = readdir(stream) else { guard errno == 0 else { throw Failure.unsafe }; break }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            guard names.count < Self.recordLimit, names.insert(name).inserted else { throw Failure.conflict }
        }
        guard names == Set(records.map { $0.0 }) else { throw Failure.conflict }
        for (name, original) in records {
            var current = stat()
            guard fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) == 0, Self.sameFile(original, current) else { throw Failure.conflict }
        }
    }
    /// Returns only after both the complete record and its namespace entry are
    /// synchronized. Any ambiguous write poisons this writer and retains files.
    func record(_ record: RelayTunDeviceLease.Record) throws {
        guard lock.try() else { throw Failure.busy }
        guard !recording else { lock.unlock(); throw Failure.busy }
        recording = true; defer { recording = false; lock.unlock() }
        try gate()
        guard record.plan == plan, record.sequence == records.count else { throw Failure.invalid }
        guard records.count < Self.recordLimit else { throw Failure.exhausted }
        let payload = try record.encoded()
        guard payload.count <= Self.byteLimit else { throw Failure.exhausted }
        let body = try JSONSerialization.data(withJSONObject: ["version": 1, "role": "tun-device-journal-record",
            "previousRecordSHA256": previous.map { $0 as Any } ?? NSNull(),
            "record": RelayTunStrictJSON.object(payload, limit: Self.byteLimit)], options: [.sortedKeys, .withoutEscapingSlashes])
        guard body.count <= Self.byteLimit + 1024 else { throw Failure.exhausted }
        let digest = RelayTunHelperTrust.digest(body), name = String(format: "%08u", record.sequence) + "-" + digest + ".json"
        do {
            try ensureDirectory(); try inventory()
            let fd = openat(directory, name, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw Failure.conflict }
            var released = false
            defer { if !released { Darwin.close(fd) } }
            var info = stat()
            guard fchmod(fd, 0o600) == 0, fstat(fd, &info) == 0, info.st_uid == owner, info.st_gid == group,
                  info.st_nlink == 1, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o7777 == 0o600 else { throw Failure.unsafe }
            var offset = 0
            try body.withUnsafeBytes { raw in
                while offset < raw.count {
                    let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw Failure.uncertain }; offset += count
                }
            }
            guard fsync(fd) == 0, fstat(fd, &info) == 0, info.st_size == body.count else { throw Failure.uncertain }
            let closed = Darwin.close(fd); released = true
            guard closed == 0, fsync(directory) == 0 else { throw Failure.uncertain }
            records.append((name, info)); previous = digest
            try ensureDirectory(); try inventory()
        } catch { failed = true; throw error }
    }
}
