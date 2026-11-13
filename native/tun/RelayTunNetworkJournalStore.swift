import Foundation
import Darwin

/// Fixed-path root persistence for the pure journal contract. No installation,
/// privilege acquisition, route/DNS operation, terminal-record deletion or stale
/// lease recovery is provided. Root-protected ancestors and cooperating writers
/// are the trust boundary; an arbitrary malicious root process is not excluded
/// by POSIX. Every publication is exclusive and never overwrites an unknown key.
final class RelayTunNetworkJournalStore {
    private typealias Journal = RelayTunNetworkJournal
    private typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case permission, unsafe, conflict, uncertain, exhausted, busy }
    private static let fixedPath = "/Library/Application Support/Relay/Tun/NetworkJournal"
    private static let leaseName = "writer.lease"
    // Full legacy lifecycle: two records per install and per reverse removal,
    // plus fixed stages. Reserve two additional records per effect for explicit
    // undo/close intent reaffirmation; never silently drop recovery events.
    private static let maximumRecords = 6 * Effects.maximumEffects + 16
    private static let maximumRecordBytes = Effects.maximumBytes + 4096
    private static let maximumTotalBytes = maximumRecords * maximumRecordBytes
    private let path: String
    private let owner: uid_t
    private let group: gid_t
    private let testing: Bool
    private let mutex = NSRecursiveLock()
    private var mutating = false
    private var failed = false
    private var heldDirectory: Directory?
    private var lease: File?
    private var leaseData: Data?
    private var publishedRevision: String?
    private var publishedChain: Chain?
    private var observation: Observation?
    private var cacheDirectory: stat?
    private var records: [String: CachedRecord] = [:]
    private var synchronized = false

    private final class Directory {
        let fd: Int32
        let identity: stat
        let created: Bool
        init(fd: Int32, identity: stat, created: Bool) { self.fd = fd; self.identity = identity; self.created = created }
        deinit { Darwin.close(fd) }
    }
    private final class File {
        let fd: Int32
        let identity: stat
        init(fd: Int32, identity: stat) { self.fd = fd; self.identity = identity }
        deinit { Darwin.close(fd) }
    }
    private struct Chain {
        let snapshots: [Journal.Snapshot]
        let latestBytes: Data?
        let lastRecordSHA256: String?
        let identities: [stat]
    }
    private struct Contents { let data: Data; let identity: stat }
    private struct Observation { let directory: stat?; let chain: Chain? }
    private struct CachedRecord {
        let identity: stat
        let index: Int
        let snapshot: Journal.Snapshot
        let snapshotBytes: Data
        let recordSHA256: String
        let snapshotSHA256: String
        let previousRecord: String?
        let previousSnapshot: String?
    }
    private static func recordData(_ snapshot: Journal.Snapshot, previousRecord: String?, previousSnapshot: String?) throws -> Data {
        try canonicalRecord(["version": 1, "role": "network-journal-record", "index": snapshot.sequence,
            "previousRecordSHA256": previousRecord.map { $0 as Any } ?? NSNull(),
            "previousSnapshotSHA256": previousSnapshot.map { $0 as Any } ?? NSNull(), "snapshot": snapshot.json])
    }
    private static func canonicalRecord(_ value: Any) throws -> Data {
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= maximumRecordBytes else { throw Failure.exhausted }; return bytes
    }
    private init(path: String, owner: uid_t, group: gid_t, testing: Bool) {
        self.path = path; self.owner = owner; self.group = group; self.testing = testing
    }
    static func productionStorage(planID: String = "") throws -> RelayTunNetworkJournal.Storage {
        // This gate precedes ALL filesystem access, including path inspection.
        guard getuid() == 0, geteuid() == 0, getgid() == 0, getegid() == 0 else { throw Failure.permission }
        guard Effects.uuid(planID) else { throw Failure.unsafe }
        return RelayTunNetworkJournalStore(path: fixedPath + "/" + planID, owner: 0, group: 0, testing: false).storage
    }
    private var storage: Journal.Storage {
        .init(read: { try self.read() }, compareExchange: { try self.compareExchange(expected: $0, replacement: $1) }, sync: { try self.sync() })
    }
    private func gate() throws {
        guard !failed else { throw Failure.uncertain }
        if testing {
            #if RELAY_TUN_JOURNAL_STORE_TESTS
            guard getuid() == owner, geteuid() == owner, owner != 0, getgid() == group, getegid() == group else { throw Failure.permission }
            return
            #endif
        }
        guard getuid() == 0, geteuid() == 0, getgid() == 0, getegid() == 0, owner == 0, group == 0,
              path.hasPrefix(Self.fixedPath + "/"), Effects.uuid(String(path.dropFirst(Self.fixedPath.count + 1))) else { throw Failure.permission }
    }
    private func begin() throws {
        guard mutex.try() else { throw Failure.busy }
        guard !mutating else { mutex.unlock(); throw Failure.busy }
        do { try gate() } catch { mutex.unlock(); throw error }; mutating = true
    }
    private func end() { mutating = false; mutex.unlock() }
    private static func sameIdentity(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink
    }
    private static func sameDirectory(_ a: stat, _ b: stat) -> Bool {
        // APFS directory nlink changes when regular entries are added/removed.
        // Keep exact inode/owner/mode identity across our own publications;
        // complete inventory and stable-read checks cover entry changes.
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode
    }
    private static func sameFile(_ a: stat, _ b: stat) -> Bool {
        sameIdentity(a, b) && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private func statFile(_ fd: Int32, links: nlink_t = 1) throws -> stat {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == owner, info.st_gid == group,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o7777 == 0o600,
              info.st_nlink == links else { throw Failure.unsafe }; return info
    }
    private func openDirectory(create: Bool) throws -> Directory? {
        try gate()
        #if RELAY_TUN_JOURNAL_STORE_TESTS
        if !testing { Self.productionFilesystemEntries += 1 }
        #endif
        let parts = path.split(separator: "/").map(String.init)
        var current = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard current >= 0 else { throw Failure.unsafe }
        defer { Darwin.close(current) }
        for (index, part) in parts.enumerated() {
            var parent = stat()
            guard fstat(current, &parent) == 0, [uid_t(0), owner].contains(parent.st_uid),
                  parent.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), parent.st_mode & 0o6022 == 0 else { throw Failure.unsafe }
            let last = index == parts.count - 1
            if testing && last { guard parent.st_uid == owner, parent.st_gid == group, parent.st_mode & 0o7777 == 0o700 else { throw Failure.unsafe } }
            var created = false
            var child = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            let mayCreate = last || (!testing && index == parts.count - 2 && part == "NetworkJournal")
            if child < 0 && errno == ENOENT && mayCreate {
                guard create else { return nil }
                let result = mkdirat(current, part, 0o700)
                if result != 0 && errno != EEXIST { throw Failure.unsafe }; created = result == 0
                child = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard child >= 0 else { throw Failure.unsafe }
                do { try fault(.namespaceSync); guard fsync(current) == 0 else { throw Failure.uncertain } }
                catch { Darwin.close(child); throw error }
            }
            guard child >= 0 else { throw Failure.unsafe }
            var info = stat(), linked = stat()
            let valid = fstat(child, &info) == 0 && fstatat(current, part, &linked, AT_SYMLINK_NOFOLLOW) == 0 && Self.sameIdentity(info, linked)
            guard valid, [uid_t(0), owner].contains(info.st_uid), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o6022 == 0 else { Darwin.close(child); throw Failure.unsafe }
            if !testing && index == parts.count - 2 {
                guard info.st_uid == owner, info.st_gid == group, info.st_mode & 0o7777 == 0o700 else { Darwin.close(child); throw Failure.unsafe }
            }
            if last {
                guard info.st_uid == owner, info.st_gid == group, info.st_mode & 0o7777 == 0o700 else { Darwin.close(child); throw Failure.unsafe }
                return Directory(fd: child, identity: info, created: created)
            }
            Darwin.close(current); current = child
        }
        throw Failure.unsafe
    }
    private func directoryLinked(_ directory: Directory) throws {
        guard let current = try openDirectory(create: false), Self.sameDirectory(current.identity, directory.identity) else { throw Failure.conflict }
        var held = stat()
        guard fstat(directory.fd, &held) == 0, Self.sameDirectory(held, directory.identity) else { throw Failure.conflict }
    }
    private func names(_ directory: Directory) throws -> [String] {
        let duplicate = fcntl(directory.fd, F_DUPFD_CLOEXEC, 10)
        guard duplicate >= 0 else { throw Failure.unsafe }
        guard let stream = fdopendir(duplicate) else { Darwin.close(duplicate); throw Failure.unsafe }
        defer { closedir(stream) }; rewinddir(stream)
        var result: [String] = []
        errno = 0
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
            if name == "." || name == ".." { continue }
            guard !name.utf8.contains(0), name.utf8.count <= 100 else { throw Failure.unsafe }
            result.append(name); guard result.count <= Self.maximumRecords + 1 else { throw Failure.exhausted }
            errno = 0
        }
        guard errno == 0 else { throw Failure.unsafe }; return result.sorted()
    }
    private func readFile(_ name: String, in directory: Directory, limit: Int) throws -> Contents {
        let fd = openat(directory.fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unsafe }; defer { Darwin.close(fd) }
        let before = try statFile(fd)
        guard before.st_size > 0, before.st_size <= limit else { throw Failure.unsafe }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw Failure.unsafe }
            if count == 0 { break }
            guard data.count + count <= limit else { throw Failure.exhausted }; data.append(contentsOf: buffer.prefix(count))
        }
        let after = try statFile(fd); var linked = stat()
        guard data.count == before.st_size, Self.sameFile(before, after),
              fstatat(directory.fd, name, &linked, AT_SYMLINK_NOFOLLOW) == 0, Self.sameFile(after, linked) else { throw Failure.conflict }
        return Contents(data: data, identity: after)
    }
    private func metadata(_ name: String, in directory: Directory) throws -> stat {
        let fd = openat(directory.fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unsafe }; defer { Darwin.close(fd) }
        let before = try statFile(fd), after = try statFile(fd); var linked = stat()
        guard before.st_size > 0, before.st_size <= Self.maximumRecordBytes, Self.sameFile(before, after),
              fstatat(directory.fd, name, &linked, AT_SYMLINK_NOFOLLOW) == 0, Self.sameFile(after, linked) else { throw Failure.conflict }
        return after
    }
    private func decodeRecord(_ name: String, in directory: Directory) throws -> (CachedRecord, Bool) {
        if let cached = records[name] {
            // No content, checksum or stage trust is inferred from the name.
            // Reuse is allowed only for this previously fully decoded immutable
            // inode with exact owner/group/mode/link/size/mtime/ctime identity.
            guard try Self.sameFile(metadata(name, in: directory), cached.identity) else { throw Failure.conflict }
            return (cached, true)
        }
        let contents = try readFile(name, in: directory, limit: Self.maximumRecordBytes)
        let item = try Effects.object(RelayTunStrictJSON.object(contents.data, limit: Self.maximumRecordBytes), keys: ["version", "role", "index", "previousRecordSHA256", "previousSnapshotSHA256", "snapshot"])
        guard RelayTunStrictJSON.integer(item["version"]) == 1, item["role"] as? String == "network-journal-record",
              let index = RelayTunStrictJSON.integer(item["index"]), let snapshotObject = item["snapshot"] else { throw Failure.unsafe }
        let previousRecord = item["previousRecordSHA256"] is NSNull ? nil : try Effects.text(item["previousRecordSHA256"])
        let previousSnapshot = item["previousSnapshotSHA256"] is NSNull ? nil : try Effects.text(item["previousSnapshotSHA256"])
        let snapshotBytes = try Effects.bytes(snapshotObject), snapshot = try Journal.Snapshot.decode(snapshotBytes)
        guard try Self.canonicalRecord(item) == contents.data else { throw Failure.unsafe }
        return (CachedRecord(identity: contents.identity, index: index, snapshot: snapshot, snapshotBytes: snapshotBytes,
                             recordSHA256: RelayTunHelperTrust.digest(contents.data), snapshotSHA256: RelayTunHelperTrust.digest(snapshotBytes),
                             previousRecord: previousRecord, previousSnapshot: previousSnapshot), false)
    }
    private func verifyLease(_ directory: Directory) throws {
        guard let lease, let leaseData else { throw Failure.unsafe }
        let current = try statFile(lease.fd); var linked = stat()
        guard Self.sameFile(current, lease.identity), fstatat(directory.fd, Self.leaseName, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              Self.sameFile(current, linked), try readFile(Self.leaseName, in: directory, limit: 512).data == leaseData else { throw Failure.conflict }
    }
    private static func recordName(_ index: Int) -> String { String(format: "%010d.record", index) }
    private func chain(_ directory: Directory) throws -> Chain {
        try directoryLinked(directory)
        if let cacheDirectory { guard Self.sameDirectory(cacheDirectory, directory.identity) else { throw Failure.conflict } }
        var before = stat(); guard fstat(directory.fd, &before) == 0 else { throw Failure.unsafe }
        let entries = try names(directory)
        let records = entries.filter { $0 != Self.leaseName }
        if entries.contains(Self.leaseName) { try verifyLease(directory) }
        else { guard lease == nil else { throw Failure.conflict } }
        guard records.count <= Self.maximumRecords, records == (0..<records.count).map(Self.recordName) else { throw Failure.unsafe }
        guard records.count >= self.records.count else { throw Failure.conflict }
        var snapshots: [Journal.Snapshot] = [], identities: [stat] = [], previousRecord: String?, previousSnapshot: String?, latest: Data?, total = 0
        for (index, name) in records.enumerated() {
            let (record, cached) = try decodeRecord(name, in: directory); total += Int(record.identity.st_size)
            guard total <= Self.maximumTotalBytes else { throw Failure.exhausted }
            guard record.index == index, record.snapshot.sequence == index, record.previousRecord == previousRecord,
                  record.previousSnapshot == previousSnapshot else { throw Failure.conflict }
            // A cache hit is the exact immutable body whose stage edge was
            // already validated against these exact predecessor digests.
            if !cached {
                guard record.snapshot.follows(snapshots.last) else { throw Failure.unsafe }
                self.records[name] = record
            }
            snapshots.append(record.snapshot); identities.append(record.identity); latest = record.snapshotBytes
            previousRecord = record.recordSHA256; previousSnapshot = record.snapshotSHA256
        }
        var after = stat()
        guard fstat(directory.fd, &after) == 0, Self.sameFile(before, after), try names(directory) == entries else { throw Failure.conflict }
        try directoryLinked(directory)
        cacheDirectory = directory.identity
        return Chain(snapshots: snapshots, latestBytes: latest, lastRecordSHA256: previousRecord, identities: identities)
    }
    private func observationMatches(_ value: Observation, directory: Directory) throws -> Bool {
        try directoryLinked(directory)
        let expectedNames = (0..<(value.chain?.identities.count ?? 0)).map(Self.recordName)
        guard try names(directory) == expectedNames else { return false }
        if let original = value.chain {
            for (index, identity) in original.identities.enumerated() {
                guard try Self.sameFile(metadata(Self.recordName(index), in: directory), identity) else { return false }
            }
        }
        try directoryLinked(directory); return true
    }
    private static func sameChain(_ first: Chain, _ second: Chain) -> Bool {
        first.latestBytes == second.latestBytes && first.lastRecordSHA256 == second.lastRecordSHA256 &&
        first.identities.count == second.identities.count && zip(first.identities, second.identities).allSatisfy { sameFile($0.0, $0.1) }
    }
    private func acquireLease(_ directory: Directory) throws {
        guard lease == nil else { throw Failure.busy }
        let fd = openat(directory.fd, Self.leaseName, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.conflict }
        var retained = false; defer { if !retained { Darwin.close(fd) } }
        let data = try Effects.bytes(["version": 1, "role": "network-journal-write-lease", "nonce": UUID().uuidString.lowercased()])
        _ = try statFile(fd); try write(data, fd: fd); try fault(.leaseSync)
        guard fsync(fd) == 0, fsync(directory.fd) == 0 else { throw Failure.uncertain }
        lease = File(fd: fd, identity: try statFile(fd)); leaseData = data; heldDirectory = directory; retained = true
        try verifyLease(directory)
    }
    private func releaseLease(_ directory: Directory) throws {
        try verifyLease(directory); try directoryLinked(directory)
        guard unlinkat(directory.fd, Self.leaseName, 0) == 0 else { throw Failure.uncertain }
        guard fsync(directory.fd) == 0 else { throw Failure.uncertain }
        lease = nil; leaseData = nil; heldDirectory = nil; publishedRevision = nil; publishedChain = nil; synchronized = false
    }
    private func write(_ data: Data, fd: Int32) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < data.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), data.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw Failure.uncertain }; offset += count
            }
        }
    }
    private func read() throws -> Data? {
        try begin(); defer { end() }
        do {
            guard let directory = try openDirectory(create: false) else { observation = Observation(directory: nil, chain: nil); return nil }
            if let heldDirectory { guard Self.sameDirectory(heldDirectory.identity, directory.identity), synchronized else { throw Failure.uncertain } }
            let value = try chain(directory)
            if let publishedRevision {
                guard value.latestBytes.map(RelayTunHelperTrust.digest) == publishedRevision, let publishedChain,
                      Self.sameChain(publishedChain, value) else { throw Failure.conflict }
                try releaseLease(directory)
            }
            observation = Observation(directory: directory.identity, chain: value)
            return value.latestBytes
        } catch { failed = true; throw error }
    }
    private func compareExchange(expected: String?, replacement: Data) throws -> Bool {
        try begin(); defer { end() }
        do {
            guard lease == nil, publishedRevision == nil, expected == nil || Effects.digest(expected!) else { throw Failure.unsafe }
            guard let observation else { throw Failure.unsafe }
            guard observation.chain?.latestBytes.map(RelayTunHelperTrust.digest) == expected else { return false }
            let snapshot = try Journal.Snapshot.decode(replacement)
            guard try snapshot.encoded() == replacement else { throw Failure.unsafe }
            guard snapshot.follows(observation.chain?.snapshots.last) else { throw Failure.unsafe }
            guard let directory = try openDirectory(create: true) else { throw Failure.unsafe }
            if let original = observation.directory {
                guard Self.sameDirectory(original, directory.identity) else { return false }
            } else { guard directory.created else { return false } }
            guard try observationMatches(observation, directory: directory) else { return false }
            try acquireLease(directory)
            let previous = try chain(directory)
            guard previous.latestBytes.map(RelayTunHelperTrust.digest) == expected else { try releaseLease(directory); return false }
            if let original = observation.chain { guard Self.sameChain(original, previous) else { try releaseLease(directory); return false } }
            else { guard previous.snapshots.isEmpty else { try releaseLease(directory); return false } }
            guard previous.snapshots.count < Self.maximumRecords, snapshot.follows(previous.snapshots.last), snapshot.sequence == previous.snapshots.count else { throw Failure.unsafe }
            let record = try Self.recordData(snapshot, previousRecord: previous.lastRecordSHA256, previousSnapshot: expected)
            guard record.count <= Self.maximumRecordBytes else { throw Failure.exhausted }
            let pending = ".pending-" + UUID().uuidString.lowercased()
            let fd = openat(directory.fd, pending, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw Failure.uncertain }; defer { Darwin.close(fd) }
            let identity = try statFile(fd)
            try fault(.beforeWrite)
            try write(record, fd: fd); try fault(.fileSync)
            guard fsync(fd) == 0 else { throw Failure.uncertain }
            var linked = stat(); let completed = try statFile(fd)
            guard Self.sameIdentity(identity, completed), completed.st_size == record.count,
                  fstatat(directory.fd, pending, &linked, AT_SYMLINK_NOFOLLOW) == 0, Self.sameFile(completed, linked),
                  try readFile(pending, in: directory, limit: Self.maximumRecordBytes).data == record else { throw Failure.conflict }
            try directoryLinked(directory); try verifyLease(directory); try fault(.beforePublish)
            let name = Self.recordName(previous.snapshots.count)
            guard linkat(directory.fd, pending, directory.fd, name, 0) == 0 else { throw Failure.conflict }
            try fault(.afterPublish)
            let published = try statFile(fd, links: 2); var target = stat(), source = stat()
            guard published.st_dev == completed.st_dev, published.st_ino == completed.st_ino,
                  fstatat(directory.fd, name, &target, AT_SYMLINK_NOFOLLOW) == 0, fstatat(directory.fd, pending, &source, AT_SYMLINK_NOFOLLOW) == 0,
                  Self.sameFile(published, target), Self.sameFile(published, source), unlinkat(directory.fd, pending, 0) == 0 else { throw Failure.conflict }
            let finalIdentity = try statFile(fd)
            publishedRevision = RelayTunHelperTrust.digest(replacement); synchronized = false
            let current = try chain(directory)
            guard current.latestBytes == replacement, current.identities.count == previous.identities.count + 1,
                  zip(previous.identities, current.identities).allSatisfy({ Self.sameFile($0.0, $0.1) }),
                  let lastIdentity = current.identities.last, Self.sameFile(finalIdentity, lastIdentity) else { throw Failure.conflict }
            publishedChain = current
            return true
        } catch { failed = true; throw error }
    }
    private func sync() throws {
        try begin(); defer { end() }
        do {
            guard let directory = heldDirectory, let publishedRevision, !synchronized else { throw Failure.unsafe }
            try directoryLinked(directory); try verifyLease(directory)
            let current = try chain(directory)
            guard current.latestBytes.map(RelayTunHelperTrust.digest) == publishedRevision, let publishedChain,
                  Self.sameChain(publishedChain, current) else { throw Failure.conflict }
            try fault(.directorySync)
            guard fsync(directory.fd) == 0 else { throw Failure.uncertain }; synchronized = true
        } catch { failed = true; throw error }
    }

    private enum FaultPoint { case namespaceSync, leaseSync, beforeWrite, fileSync, beforePublish, afterPublish, directorySync }
    private func fault(_ point: FaultPoint) throws {
        #if RELAY_TUN_JOURNAL_STORE_TESTS
        try faultHook?(point)
        #endif
    }
    #if RELAY_TUN_JOURNAL_STORE_TESTS
    private var faultHook: ((FaultPoint) throws -> Void)?
    private(set) static var productionFilesystemEntries = 0
    static var testCapacity: (records: Int, perRecord: Int, total: Int) { (maximumRecords, maximumRecordBytes, maximumTotalBytes) }
    static func testRecord(_ snapshot: RelayTunNetworkJournal.Snapshot, previousRecord: String?, previousSnapshot: String?) throws -> Data {
        try recordData(snapshot, previousRecord: previousRecord, previousSnapshot: previousSnapshot)
    }
    enum TestPoint { case namespaceSync, leaseSync, beforeWrite, fileSync, beforePublish, afterPublish, directorySync }
    static func testStorage(path: String, fault: ((TestPoint) throws -> Void)? = nil) throws -> RelayTunNetworkJournal.Storage {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        let prefix = app + "/.relay-build/tun-journal-store-fixtures/"
        guard getuid() > 0, getuid() == geteuid(), path.hasPrefix(prefix), URL(fileURLWithPath: path).standardizedFileURL.path == path,
              path.dropFirst(prefix.count).split(separator: "/").count == 2, path.hasSuffix("/NetworkJournal") else { throw Failure.permission }
        let store = RelayTunNetworkJournalStore(path: path, owner: getuid(), group: getgid(), testing: true)
        store.faultHook = { point in
            let mapped: TestPoint
            switch point { case .namespaceSync: mapped = .namespaceSync; case .leaseSync: mapped = .leaseSync; case .beforeWrite: mapped = .beforeWrite; case .fileSync: mapped = .fileSync; case .beforePublish: mapped = .beforePublish; case .afterPublish: mapped = .afterPublish; case .directorySync: mapped = .directorySync }
            try fault?(mapped)
        }
        return store.storage
    }
    #if RELAY_TUN_JOURNAL_ARCHIVE_TESTS
    static func archiveTestStorage(path: String) throws -> RelayTunNetworkJournal.Storage {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        let prefix = app + "/.relay-build/tun-journal-archive-fixtures/"
        let suffix = String(path.dropFirst(prefix.count)).split(separator: "/").map(String.init)
        guard getuid() > 0, getuid() == geteuid(), path.hasPrefix(prefix), suffix.count == 3,
              Effects.uuid(suffix[0]), suffix[1] == "NetworkJournal", Effects.uuid(suffix[2]) else { throw Failure.permission }
        return RelayTunNetworkJournalStore(path: path, owner: getuid(), group: getgid(), testing: true).storage
    }
    #endif
    #endif
}
