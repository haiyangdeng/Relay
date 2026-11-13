import Foundation
import Darwin

/// Fixed-name private material handoff. This reader never opens a URL,
/// selects a PID, publishes an active Geo file or removes an unknown entry.
final class RelayTunRuntimeResourceInbox {
    typealias Model = RelayTunRuntimeResources
    enum Failure: Error { case invalid, changed, conflict, busy, closed }
    enum Discard: String { case discarded, absent }
    struct Ticket: Equatable {
        let blobId: String, kind: Model.Kind, sha256: String, bytes: Int, selector: String
        init(_ selection: Model.Selection) {
            blobId = selection.blobId; kind = selection.kind; sha256 = selection.newSHA256
            bytes = selection.bytes; selector = selection.selector
        }
        init(blobId: String, kind: Model.Kind, sha256: String, bytes: Int, selector: String) throws {
            guard Model.uuid(blobId), Model.hash(sha256), bytes > 0, bytes <= Model.maximumBytes,
                  !selector.isEmpty, selector.utf8.count <= 256, !selector.contains(","),
                  selector == selector.trimmingCharacters(in: .whitespacesAndNewlines),
                  selector.unicodeScalars.allSatisfy({ $0.value >= 32 && !(127...159).contains($0.value) }) else { throw Failure.invalid }
            self.blobId = blobId; self.kind = kind; self.sha256 = sha256; self.bytes = bytes; self.selector = selector
        }
    }
    enum ProviderKind: String { 
        case yaml = "rule-yaml", text = "rule-text", mrs = "rule-mrs"
        var suffix: String { switch self { case .yaml: return "yaml"; case .text: return "text"; case .mrs: return "mrs" } }
        var maximumBytes: Int { self == .mrs ? Model.maximumBytes : 8 * 1024 * 1024 }
    }
    struct ProviderTicket: Equatable {
        let blobId: String, kind: ProviderKind, sha256: String, bytes: Int, filename: String
        init(blobId: String, kind: ProviderKind, sha256: String, bytes: Int, filename: String) throws {
            let raw = Array(blobId.utf8)
            guard Model.uuid(blobId), raw[14] == 52, [56, 57, 97, 98].contains(raw[19]), Model.hash(sha256),
                  bytes > 0, bytes <= kind.maximumBytes, filename == blobId + "." + kind.suffix else { throw Failure.invalid }
            self.blobId = blobId; self.kind = kind; self.sha256 = sha256; self.bytes = bytes; self.filename = filename
        }
    }
    struct ProviderBlob {
        let ticket: ProviderTicket, data: Data, identity: Model.FileIdentity
        var id: String { ticket.blobId }
    }
    struct Entry {
        let path: String
        let identity: stat
        let sha256: String?
        var directory: Bool { identity.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) }
    }
    private let sourcePath: String, homePath: String, uid: uid_t
    private let sourceFD: Int32, homeFD: Int32, inboxFD: Int32
    private let sourceIdentity: stat, homeIdentity: stat, inboxIdentity: stat
    private let lock = NSLock(), registryLock = NSLock()
    private var entries: [String: Entry] = [:]
    private var usedIDs = Set<String>(), deleted = Set<String>()
    private struct SourceRecord {
        let directory: stat, identity: Model.FileIdentity, ticket: Ticket
    }
    private var sourceRecords: [String: SourceRecord] = [:]
    private struct ProviderSourceRecord { let directory: stat, identity: Model.FileIdentity, ticket: ProviderTicket }
    private var providerRecords = [String: ProviderSourceRecord](), providerRemoved = [String: ProviderSourceRecord]()
    private var consumed: [String: SourceRecord] = [:]
    private var removedSource: [String: SourceRecord] = [:]
    private var discarded = Set<String>()
    private var cleanupStarted = false, cleanupComplete = false
    private static let inboxName = "RelayGeoInbox"

    init(sourceRoot: String, coreHome: String) throws {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(),
              sourceRoot.hasPrefix("/private/tmp/relay-geo-main-\(getuid())-"),
              coreHome.hasPrefix("/private/tmp/relay-session-\(getuid())-") else { throw Failure.invalid }
        let source = try Self.openRoot(sourceRoot), home: (Int32, stat)
        do { home = try Self.openRoot(coreHome) } catch { Darwin.close(source.0); throw error }
        var inbox: Int32 = -1
        do {
            // A pre-existing directory is not adopted, even if its mode/name
            // looks valid. Only this invocation creates its managed inbox.
            guard mkdirat(home.0, Self.inboxName, 0o700) == 0 else { throw Failure.conflict }
            inbox = openat(home.0, Self.inboxName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard inbox >= 0 else { throw Failure.changed }
            let observed = try Self.directory(inbox)
            guard observed.st_gid == home.1.st_gid else { throw Failure.changed }
            try Self.linked(home.0, Self.inboxName, observed, isDirectory: true)
            guard fsync(home.0) == 0 else { throw Failure.invalid }
            sourcePath = sourceRoot; homePath = coreHome; uid = getuid()
            sourceFD = source.0; homeFD = home.0; inboxFD = inbox
            sourceIdentity = source.1; homeIdentity = home.1; inboxIdentity = observed
            entries[Self.inboxName] = .init(path: Self.inboxName, identity: observed, sha256: nil)
        } catch {
            if inbox >= 0 { Darwin.close(inbox) }; Darwin.close(source.0); Darwin.close(home.0)
            // An interrupted exclusive creation is retained for inspection;
            // initialization failure grants no recursive cleanup authority.
            throw error
        }
    }
    deinit { Darwin.close(inboxFD); Darwin.close(homeFD); Darwin.close(sourceFD) }

    private static func canonical(_ path: String) -> Bool {
        guard !path.contains("\0"), let physical = realpath(path, nil) else { return false }
        defer { free(physical) }; return String(cString: physical) == path
    }
    private static func openRoot(_ path: String) throws -> (Int32, stat) {
        guard canonical(path) else { throw Failure.invalid }
        let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.invalid }
        do {
            let info = try directory(fd); var linked = stat()
            guard lstat(path, &linked) == 0, sameDirectory(info, linked), canonical(path) else { throw Failure.changed }
            return (fd, info)
        } catch { Darwin.close(fd); throw error }
    }
    private static func sameDirectory(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid &&
        a.st_mode == b.st_mode && a.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR)
    }
    private static func sameFile(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode &&
        a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
        a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
        a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private static func directory(_ fd: Int32) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0, value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              value.st_uid == getuid(), value.st_mode & 0o7777 == 0o700 else { throw Failure.invalid }
        return value
    }
    private static func linked(_ parent: Int32, _ name: String, _ expected: stat, isDirectory: Bool) throws {
        var value = stat()
        guard fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) == 0,
              isDirectory ? sameDirectory(expected, value) : sameFile(expected, value) else { throw Failure.changed }
    }
    private func roots() throws {
        guard getuid() == uid, geteuid() == uid, getgid() == getegid() else { throw Failure.changed }
        for (fd, path, original) in [(sourceFD, sourcePath, sourceIdentity), (homeFD, homePath, homeIdentity)] {
            let held = try Self.directory(fd); var value = stat()
            guard Self.sameDirectory(original, held), Self.canonical(path), lstat(path, &value) == 0,
                  Self.sameDirectory(held, value) else { throw Failure.changed }
        }
        guard Self.sameDirectory(try Self.directory(inboxFD), inboxIdentity) else { throw Failure.changed }
        try Self.linked(homeFD, Self.inboxName, inboxIdentity, isDirectory: true)
    }
    private static func identity(_ value: stat) throws -> Model.FileIdentity {
        func nanos(_ time: timespec) throws -> UInt64 {
            guard time.tv_sec >= 0, time.tv_nsec >= 0, time.tv_nsec < 1_000_000_000,
                  UInt64(time.tv_sec) <= (UInt64.max - UInt64(time.tv_nsec)) / 1_000_000_000 else { throw Failure.invalid }
            return UInt64(time.tv_sec) * 1_000_000_000 + UInt64(time.tv_nsec)
        }
        return try .init(device: UInt64(UInt32(bitPattern: value.st_dev)), inode: UInt64(value.st_ino),
                         ownerUID: value.st_uid, mode: UInt32(value.st_mode), links: UInt64(value.st_nlink),
                         bytes: Int(value.st_size), modifiedNS: nanos(value.st_mtimespec), changedNS: nanos(value.st_ctimespec))
    }
    private static func readFile(_ parent: Int32, _ name: String, allowEmpty: Bool = false, maximum: Int = Model.maximumBytes,
                                 check: () throws -> Void) throws -> (Data, stat) {
        try check()
        let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.invalid }; defer { Darwin.close(fd) }
        let parentGroup = try directory(parent).st_gid
        var before = stat(), after = stat()
        guard fstat(fd, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              before.st_uid == getuid(), before.st_gid == parentGroup, before.st_mode & 0o7777 == 0o600, before.st_nlink == 1,
              maximum > 0, maximum <= Model.maximumBytes, before.st_size >= (allowEmpty ? 0 : 1), before.st_size <= maximum else { throw Failure.invalid }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            try check()
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0, errno == EINTR { continue }
            guard count >= 0, data.count + max(count, 0) <= maximum else { throw Failure.invalid }
            if count == 0 { break }; data.append(contentsOf: buffer.prefix(count))
        }
        guard data.count == before.st_size, fstat(fd, &after) == 0, sameFile(before, after) else { throw Failure.changed }
        try linked(parent, name, after, isDirectory: false); try check()
        return (data, after)
    }
    private func sourceDirectory(_ id: String) throws -> (Int32, stat) {
        guard Model.uuid(id) else { throw Failure.invalid }
        let fd = openat(sourceFD, id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.invalid }
        do {
            let info = try Self.directory(fd)
            guard info.st_gid == sourceIdentity.st_gid else { throw Failure.changed }
            try Self.linked(sourceFD, id, info, isDirectory: true)
            return (fd, info)
        } catch { Darwin.close(fd); throw error }
    }
    func read(_ selection: Model.Selection, check: () throws -> Void) throws -> Model.Blob {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        return try readLocked(selection, check: check)
    }
    private func readLocked(_ selection: Model.Selection, check: () throws -> Void) throws -> Model.Blob {
        try readTicketLocked(Ticket(selection), check: check)
    }
    private func readTicketLocked(_ ticket: Ticket, allowUsed: Bool = false, check: () throws -> Void) throws -> Model.Blob {
        guard !cleanupStarted else { throw Failure.closed }
        guard providerRecords[ticket.blobId] == nil, providerRemoved[ticket.blobId] == nil else { throw Failure.conflict }
        guard allowUsed || !usedIDs.contains(ticket.blobId), !discarded.contains(ticket.blobId) else { throw Failure.conflict }
        try check(); try roots()
        let child = try sourceDirectory(ticket.blobId); defer { Darwin.close(child.0) }
        let (data, info) = try Self.readFile(child.0, ticket.kind.basename, check: check)
        let blob = try Model.Blob(id: ticket.blobId, kind: ticket.kind, data: data, identity: Self.identity(info))
        guard blob.sha256 == ticket.sha256, blob.data.count == ticket.bytes else { throw Failure.changed }
        try Self.linked(sourceFD, ticket.blobId, child.1, isDirectory: true); try roots(); try check()
        if let previous = sourceRecords[blob.id] {
            guard Self.sameDirectory(previous.directory, child.1), previous.identity == blob.identity,
                  previous.ticket == ticket else { throw Failure.changed }
        }
        sourceRecords[blob.id] = .init(directory: child.1, identity: blob.identity, ticket: ticket)
        return blob
    }
    /// Retain the exact Data first, then remove only the fully verified source
    /// leaf/UUID. No Node recursive rm or caller-supplied path participates.
    func consume(_ selection: Model.Selection, check: () throws -> Void) throws -> Model.Blob {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        let blob = try readLocked(selection, check: check)
        try removeSource(blob, check: check)
        consumed[blob.id] = sourceRecords[blob.id]
        removedSource[blob.id] = sourceRecords[blob.id]
        return blob
    }
    /// Spool-only cancellation. This does not stage anything or call Core,
    /// and its successful deletion never creates write authority.
    @discardableResult func discardBlob(_ selection: Model.Selection, check: () throws -> Void = {}) throws -> Discard {
        try discardBlob(Ticket(selection), check: check)
    }
    func discardBlob(_ ticket: Ticket, check: () throws -> Void = {}) throws -> Discard {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !cleanupStarted else { throw Failure.closed }
        try roots(); try check()
        if let previous = removedSource[ticket.blobId] {
            var value = stat()
            guard previous.ticket == ticket, fstatat(sourceFD, ticket.blobId, &value, AT_SYMLINK_NOFOLLOW) == -1,
                  errno == ENOENT else { throw Failure.changed }
            consumed[ticket.blobId] = nil; discarded.insert(ticket.blobId); return .absent
        }
        let blob = try readTicketLocked(ticket, allowUsed: true, check: check)
        try removeSource(blob, check: check)
        removedSource[blob.id] = sourceRecords[blob.id]
        discarded.insert(blob.id); sourceRecords[blob.id] = nil
        return .discarded
    }
    /// One shared sourceRoot/operation lock/used-ID namespace, with a typed
    /// provider ticket. No second pool, no Geo selector, no arbitrary filename.
    private func readProviderLocked(_ ticket: ProviderTicket, allowUsed: Bool = false, check: () throws -> Void) throws -> ProviderBlob {
        guard !cleanupStarted, sourceRecords[ticket.blobId] == nil, removedSource[ticket.blobId] == nil,
              !discarded.contains(ticket.blobId), allowUsed || !usedIDs.contains(ticket.blobId) else { throw Failure.conflict }
        try check(); try roots()
        let child = try sourceDirectory(ticket.blobId); defer { Darwin.close(child.0) }
        guard try Self.names(child.0) == [ticket.filename] else { throw Failure.conflict }
        let value = try Self.readFile(child.0, ticket.filename, maximum: ticket.kind.maximumBytes, check: check)
        let identity = try Self.identity(value.1)
        guard identity.bytes == ticket.bytes, Model.digest(value.0) == ticket.sha256 else { throw Failure.changed }
        if let previous = providerRecords[ticket.blobId] {
            guard Self.sameDirectory(previous.directory, child.1), previous.identity == identity, previous.ticket == ticket else { throw Failure.changed }
        }
        try check(); try roots()
        guard try Self.names(child.0) == [ticket.filename] else { throw Failure.conflict }
        try Self.linked(sourceFD, ticket.blobId, child.1, isDirectory: true)
        providerRecords[ticket.blobId] = .init(directory: child.1, identity: identity, ticket: ticket)
        return .init(ticket: ticket, data: value.0, identity: identity)
    }
    func consumeProvider(_ ticket: ProviderTicket, check: () throws -> Void) throws -> ProviderBlob {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        let blob = try readProviderLocked(ticket, check: check)
        guard let original = providerRecords[ticket.blobId] else { throw Failure.changed }
        try removeSource(id: blob.id, filename: ticket.filename, identity: blob.identity, directory: original.directory,
                         removed: { providerRemoved[blob.id] = original; usedIDs.insert(blob.id) }, check: check)
        return blob
    }
    @discardableResult func discardProviderBlob(_ ticket: ProviderTicket, check: () throws -> Void = {}) throws -> Discard {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !cleanupStarted else { throw Failure.closed }; try check(); try roots()
        if let previous = providerRemoved[ticket.blobId] {
            var absent = stat()
            guard previous.ticket == ticket, fstatat(sourceFD, ticket.blobId, &absent, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else { throw Failure.changed }
            discarded.insert(ticket.blobId); return .absent
        }
        let blob = try readProviderLocked(ticket, allowUsed: true, check: check)
        guard let original = providerRecords[blob.id] else { throw Failure.changed }
        try removeSource(id: blob.id, filename: ticket.filename, identity: blob.identity, directory: original.directory,
                         removed: { providerRemoved[blob.id] = original; usedIDs.insert(blob.id) }, check: check)
        discarded.insert(blob.id); return .discarded
    }
    private func removeSource(_ blob: Model.Blob, check: () throws -> Void) throws {
        guard let original = sourceRecords[blob.id], original.identity == blob.identity else { throw Failure.changed }
        try removeSource(id: blob.id, filename: blob.kind.basename, identity: blob.identity, directory: original.directory,
                         removed: { removedSource[blob.id] = original }, check: check)
    }
    /// Both payload families share these held-parent/name/identity/final-fence
    /// removals. The private removed callback records an already-real unlink;
    /// it never comes from a renderer or invokes an external observer.
    private func removeSource(id: String, filename: String, identity: Model.FileIdentity, directory: stat,
                              removed: () -> Void, check: () throws -> Void) throws {
        let child = try sourceDirectory(id); defer { Darwin.close(child.0) }
        guard Self.sameDirectory(child.1, directory), try Self.names(child.0) == [filename] else { throw Failure.conflict }
        var info = stat()
        guard fstatat(child.0, filename, &info, AT_SYMLINK_NOFOLLOW) == 0,
              try Self.identity(info) == identity else { throw Failure.changed }
        try roots(); try check(); try roots()
        // Both deletion parents are held descriptors. Every path is one fixed
        // basename, never a slash-containing path through a replaced parent.
        // A callback may introduce an unknown sibling. Recheck the complete
        // typed entry and original leaf after that last observer, before the
        // first unlink; no callback follows this gate.
        guard try Self.names(child.0) == [filename],
              fstatat(child.0, filename, &info, AT_SYMLINK_NOFOLLOW) == 0,
              try Self.identity(info) == identity else { throw Failure.conflict }
        try Self.linked(sourceFD, id, directory, isDirectory: true)
        try Self.linked(child.0, filename, info, isDirectory: false)
        guard unlinkat(child.0, filename, 0) == 0, fsync(child.0) == 0 else { throw Failure.changed }
        guard try Self.names(child.0).isEmpty else { throw Failure.conflict }
        try Self.linked(sourceFD, id, directory, isDirectory: true)
        guard unlinkat(sourceFD, id, AT_REMOVEDIR) == 0 else { throw Failure.changed }
        removed()
        guard fsync(sourceFD) == 0 else { throw Failure.changed }
        try roots(); try check()
    }
    func stage(_ selection: Model.Selection, blob: Model.Blob, check: () throws -> Void) throws {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !cleanupStarted, !usedIDs.contains(selection.blobId), !discarded.contains(selection.blobId) else { throw Failure.conflict }
        guard blob.id == selection.blobId, blob.kind == selection.kind, blob.sha256 == selection.newSHA256,
              blob.data.count == selection.bytes else { throw Failure.invalid }
        try check(); try roots()
        guard let original = sourceRecords[blob.id], original.identity == blob.identity,
              original.ticket == Ticket(selection) else { throw Failure.changed }
        if let held = consumed[blob.id] {
            var absent = stat()
            guard held.identity == blob.identity, fstatat(sourceFD, blob.id, &absent, AT_SYMLINK_NOFOLLOW) == -1,
                  errno == ENOENT else { throw Failure.changed }
        } else {
            // Revalidate the same source inode immediately before a copy.
            let source = try sourceDirectory(blob.id); defer { Darwin.close(source.0) }
            guard Self.sameDirectory(source.1, original.directory) else { throw Failure.changed }
            var info = stat()
            guard fstatat(source.0, selection.kind.basename, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_gid == source.1.st_gid,
                  try Self.identity(info) == blob.identity else { throw Failure.changed }
        }
        try check(); try roots()
        guard mkdirat(inboxFD, blob.id, 0o700) == 0 else { throw Failure.conflict }
        usedIDs.insert(blob.id)
        consumed[blob.id] = nil
        let directory = Self.inboxName + "/" + blob.id
        let fd = openat(inboxFD, blob.id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.changed }; defer { Darwin.close(fd) }
        let dirInfo = try Self.directory(fd)
        guard dirInfo.st_gid == inboxIdentity.st_gid else { throw Failure.changed }
        try Self.linked(inboxFD, blob.id, dirInfo, isDirectory: true)
        record(.init(path: directory, identity: dirInfo, sha256: nil))
        try check()
        let file = openat(fd, selection.kind.basename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw Failure.conflict }
        var written = 0
        let name = directory + "/" + selection.kind.basename
        defer {
            var info = stat()
            if fstat(file, &info) == 0, info.st_uid == uid, info.st_gid == dirInfo.st_gid, info.st_mode == mode_t(S_IFREG) | 0o600,
               info.st_nlink == 1, info.st_size == written {
                let expectedSHA = written == blob.data.count ? blob.sha256 : Model.digest(blob.data.prefix(written))
                record(.init(path: name, identity: info, sha256: expectedSHA))
            }
            Darwin.close(file)
        }
        guard fchmod(file, 0o600) == 0 else { throw Failure.invalid }
        try blob.data.withUnsafeBytes { raw in
            while written < raw.count {
                try check()
                let count = Darwin.write(file, raw.baseAddress!.advanced(by: written), min(65536, raw.count - written))
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw Failure.invalid }; written += count
            }
        }
        guard fsync(file) == 0, fsync(fd) == 0, fsync(inboxFD) == 0 else { throw Failure.invalid }
        var after = stat(); guard fstat(file, &after) == 0 else { throw Failure.changed }
        try Self.linked(fd, selection.kind.basename, after, isDirectory: false)
        try Self.linked(inboxFD, blob.id, dirInfo, isDirectory: true); try roots(); try check()
    }

    /// Only a matched applied response plus the exact displaced old inode/SHA
    /// permits adoption. A failed/root-owned/FOREIGN candidate is never added.
    func registerRetained(nonce: String, previous: Model.Resource, applied: Model.Receipt,
                          check: () throws -> Void) throws {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !cleanupStarted, Model.hash(nonce), applied.retainedOriginal,
              applied.kind == previous.kind, applied.oldSHA256 == previous.sha256 else { throw Failure.invalid }
        try roots(); try check()
        let name = "RelayGeo.retained-" + nonce
        guard entries[name] == nil else { throw Failure.conflict }
        let (data, info) = try Self.readFile(homeFD, name, check: check), id = try Self.identity(info)
        // Rename may change timestamps. Stable inode/owner/mode plus the full
        // old bytes must match before recording a new cleanup identity.
        guard id.device == previous.identity.device, id.inode == previous.identity.inode,
              id.ownerUID == previous.identity.ownerUID, id.mode == previous.identity.mode,
              id.links == previous.identity.links, id.bytes == previous.bytes,
              Model.digest(data) == previous.sha256 else { throw Failure.changed }
        try roots(); try check(); record(.init(path: name, identity: info, sha256: previous.sha256))
    }
    private func record(_ entry: Entry) {
        registryLock.lock(); entries[entry.path] = entry; registryLock.unlock()
    }
    var inventory: [Entry] {
        // A source/owner check may inspect metadata from inside an IO callback.
        // Do not reacquire the operation gate or wait for that same operation.
        registryLock.lock(); defer { registryLock.unlock() }; return entries.values.filter { !deleted.contains($0.path) }
    }
    private static func names(_ fd: Int32) throws -> Set<String> {
        // dup would share a directory offset, making later scans falsely
        // empty. A fixed dot opens a new description of the same held dir.
        let copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard copy >= 0, let stream = fdopendir(copy) else { if copy >= 0 { Darwin.close(copy) }; throw Failure.invalid }
        defer { closedir(stream) }; var result = Set<String>()
        errno = 0
        while let entry = readdir(stream) {
            let data = withUnsafeBytes(of: entry.pointee.d_name) { Array($0.prefix { $0 != 0 }) }
            guard let name = String(bytes: data, encoding: .utf8) else { throw Failure.conflict }
            if name != ".", name != ".." { result.insert(name) }; errno = 0
        }
        guard errno == 0 else { throw Failure.invalid }; return result
    }
    private func withParent<T>(_ path: String, _ body: (Int32, String) throws -> T) throws -> T {
        let pieces = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if pieces.count == 1 { return try body(homeFD, pieces[0]) }
        guard pieces[0] == Self.inboxName, Model.uuid(pieces[1]) else { throw Failure.invalid }
        if pieces.count == 2 { return try body(inboxFD, pieces[1]) }
        guard pieces.count == 3, Model.Kind.allCases.contains(where: { $0.basename == pieces[2] }),
              let expected = entries[Self.inboxName + "/" + pieces[1]] else { throw Failure.invalid }
        let parent = openat(inboxFD, pieces[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw Failure.changed }; defer { Darwin.close(parent) }
        guard Self.sameDirectory(try Self.directory(parent), expected.identity) else { throw Failure.changed }
        try Self.linked(inboxFD, pieces[1], expected.identity, isDirectory: true)
        return try body(parent, pieces[2])
    }
    /// AppBundle must first compare this inventory union with its static/core
    /// entries. This method handles only registered resource staging facts.
    func cleanup() throws {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        if cleanupComplete { return }
        cleanupStarted = true; try roots()
        let remaining = entries.filter { !deleted.contains($0.key) }
        let expectedChildren = Set(remaining.keys.compactMap { path -> String? in
            let p = path.split(separator: "/"); return p.count > 1 && p[0] == Self.inboxName ? String(p[1]) : nil
        })
        guard try Self.names(inboxFD) == expectedChildren else { throw Failure.conflict }
        try validate(remaining); try remove(remaining)
        cleanupComplete = true
    }
    /// Reclaim only a terminal operation's exact staged UUID; the fixed inbox
    /// stays available for later operations. Never scan/adopt another UUID.
    func cleanupStage(_ blobId: String) throws {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !cleanupStarted, Model.uuid(blobId) else { throw Failure.closed }
        let name = Self.inboxName + "/" + blobId
        guard entries[name] != nil else { throw Failure.conflict }
        try roots()
        if deleted.contains(name) {
            var current = stat()
            guard fstatat(inboxFD, blobId, &current, AT_SYMLINK_NOFOLLOW) == -1,
                  errno == ENOENT else { throw Failure.changed }
            return
        }
        let selected = entries.filter { !deleted.contains($0.key) && ($0.key == name || $0.key.hasPrefix(name + "/")) }
        try validate(selected); try remove(selected)
    }
    private func validate(_ remaining: [String: Entry]) throws {
        // Complete validation precedes the first removal, including unknown
        // siblings inside every registered UUID directory.
        for (name, entry) in remaining {
            if entry.directory {
                if name == Self.inboxName { continue }
                let id = String(name.split(separator: "/").last!)
                let fd = openat(inboxFD, id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw Failure.changed }; defer { Darwin.close(fd) }
                guard Self.sameDirectory(try Self.directory(fd), entry.identity) else { throw Failure.changed }
                let expected = Set(remaining.keys.filter { $0.hasPrefix(name + "/") }.map { String($0.split(separator: "/").last!) })
                guard try Self.names(fd) == expected else { throw Failure.conflict }
            } else {
                let (data, info) = try withParent(name) { try Self.readFile($0, $1, allowEmpty: true, check: {}) }
                guard Self.sameFile(info, entry.identity), Model.digest(data) == entry.sha256 else { throw Failure.changed }
            }
        }
    }
    private func remove(_ remaining: [String: Entry]) throws {
        for name in remaining.keys.sorted(by: { $0.count > $1.count }) {
            let entry = remaining[name]!
            try roots()
            try withParent(name) { parent, leaf in
                var current = stat()
                guard fstatat(parent, leaf, &current, AT_SYMLINK_NOFOLLOW) == 0,
                      entry.directory ? Self.sameDirectory(current, entry.identity) : Self.sameFile(current, entry.identity) else { throw Failure.changed }
                guard unlinkat(parent, leaf, entry.directory ? AT_REMOVEDIR : 0) == 0 else { throw Failure.conflict }
            }
            registryLock.lock(); deleted.insert(name); registryLock.unlock()
        }
    }
}
