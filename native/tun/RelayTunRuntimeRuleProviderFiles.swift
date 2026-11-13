import Foundation
import Darwin

/// Private fixed-namespace IO for the held provider capability. The caller
/// supplies the AppBundle's already-checked provider rows and complete file
/// inventory, never a renderer path. A swap may immediately trigger watchers.
final class RelayTunRuntimeRuleProviderFiles {
    typealias Model = RelayTunRuntimeRuleProviders
    enum Failure: Error { case invalid, changed, conflict, busy, closed }
    static let stageDirectory = "RelayRuleProviderStages"
    private static let payload = "payload"
    private enum Layout { case staged, attempted, swapped, removed }
    private final class Record {
        let stage: Model.Stage, before: Model.Resource, directory: stat, fd: Int32
        var payloadFact: Fact
        var layout = Layout.staged, retained: Model.Retained?
        init(stage: Model.Stage, before: Model.Resource, directory: stat, fd: Int32, payload: stat) {
            self.stage = stage; self.before = before; self.directory = directory; self.fd = fd
            payloadFact = .init(identity: payload, sha256: stage.sha256)
        }
        deinit { Darwin.close(fd) }
    }
    struct Swap { let retained: Model.Retained, currentIdentity: Model.FileIdentity }
    struct Fact { let identity: stat, sha256: String? }
    struct Entry { let path: String, directory: Bool, facts: [Fact] }
    private let homePath: String, homeFD: Int32, filesFD: Int32, stagesFD: Int32
    private let home: stat, files: stat, stages: stat, allowedFileNames: Set<String>, uid: uid_t
    private let lock = NSLock()
    private var records = [String: Record](), tombstones = Set<String>(), discardedStages = [String: Model.Stage](), closed = false
    private struct FileVersion { let binding: Model.Binding, sha256: String, identity: Model.FileIdentity }
    private var currentFiles: [String: FileVersion]
    private var latest = [String: Record]()
    private var cleanupStarted = false

    /// Registered names for AppBundle's complete-union preflight. Historical
    /// payload facts are not a claim about an attempted swap's actual layout;
    /// only validatedTargetInventory/verifyKnownLayouts perform that check.
    var inventory: [Entry] {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return [] }
        var rows = [Entry(path: Self.stageDirectory, directory: true, facts: [.init(identity: stages, sha256: nil)])]
        for (ticket, record) in records.sorted(by: { $0.key < $1.key }) {
            let path = Self.stageDirectory + "/" + ticket
            rows.append(.init(path: path, directory: true, facts: [.init(identity: record.directory, sha256: nil)]))
            rows.append(.init(path: path + "/" + Self.payload, directory: false, facts: [record.payloadFact]))
        }
        return rows
    }

    init(coreHome: String, resources: [Model.Resource], allowedFileNames: Set<String>) throws {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(),
              coreHome.hasPrefix("/private/tmp/relay-session-\(getuid())-"), Self.canonical(coreHome),
              resources.count <= 200, !resources.isEmpty,
              allowedFileNames.allSatisfy({ !$0.isEmpty && !$0.contains("/") && !$0.contains("\0") && $0 != "." && $0 != ".." }) else { throw Failure.invalid }
        _ = try Model.Ledger(generationSHA256: Model.Shared.digest(Data()), sequence: 0, resources: resources)
        let h = open(coreHome, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard h >= 0 else { throw Failure.invalid }
        var f: Int32 = -1, s: Int32 = -1
        do {
            let hi = try Self.directory(h); var linked = stat()
            guard lstat(coreHome, &linked) == 0, Self.sameDirectory(hi, linked) else { throw Failure.changed }
            f = openat(h, "relay-files", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard f >= 0 else { throw Failure.invalid }
            let fi = try Self.directory(f)
            guard fi.st_gid == hi.st_gid, try Self.names(f) == allowedFileNames else { throw Failure.changed }
            try Self.linked(h, "relay-files", fi, directory: true)
            for row in resources {
                guard row.registeredFile, allowedFileNames.contains(Self.basename(row.binding)) else { throw Failure.invalid }
                let actual = try Self.read(f, Self.basename(row.binding), check: {})
                guard actual.1 == row.identity, Model.Shared.digest(actual.0) == row.fileSHA256 else { throw Failure.changed }
            }
            guard mkdirat(h, Self.stageDirectory, 0o700) == 0 else { throw Failure.conflict }
            s = openat(h, Self.stageDirectory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard s >= 0 else { throw Failure.changed }
            let si = try Self.directory(s)
            guard si.st_gid == hi.st_gid, try Self.names(s).isEmpty, fsync(h) == 0 else { throw Failure.changed }
            try Self.linked(h, Self.stageDirectory, si, directory: true)
            homePath = coreHome; homeFD = h; filesFD = f; stagesFD = s
            home = hi; files = fi; stages = si; uid = getuid(); self.allowedFileNames = allowedFileNames
            currentFiles = resources.reduce(into: [:]) { $0[$1.binding.originalPath] = FileVersion(binding: $1.binding, sha256: $1.fileSHA256, identity: $1.identity) }
        } catch {
            if s >= 0 { Darwin.close(s) }; if f >= 0 { Darwin.close(f) }; Darwin.close(h)
            // An interrupted exclusive directory is deliberately not adopted
            // or recursively deleted on a later initialization.
            throw error
        }
    }
    deinit { Darwin.close(stagesFD); Darwin.close(filesFD); Darwin.close(homeFD) }
    private static func basename(_ binding: Model.Binding) -> String { String(binding.originalPath.dropFirst("relay-files/".count)) }
    private static func canonical(_ path: String) -> Bool {
        guard !path.contains("\0"), let value = realpath(path, nil) else { return false }
        defer { free(value) }; return String(cString: value) == path
    }
    private static func sameDirectory(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode
    }
    private static func directory(_ fd: Int32) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0, value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), value.st_uid == getuid(),
              value.st_mode & 0o7777 == 0o700 else { throw Failure.invalid }; return value
    }
    static func identity(_ value: stat) throws -> Model.FileIdentity {
        func ns(_ t: timespec) throws -> UInt64 {
            guard t.tv_sec >= 0, t.tv_nsec >= 0, t.tv_nsec < 1_000_000_000,
                  UInt64(t.tv_sec) <= (UInt64.max - UInt64(t.tv_nsec)) / 1_000_000_000 else { throw Failure.invalid }
            return UInt64(t.tv_sec) * 1_000_000_000 + UInt64(t.tv_nsec)
        }
        return try .init(device: UInt64(UInt32(bitPattern: value.st_dev)), inode: UInt64(value.st_ino), ownerUID: value.st_uid,
                         mode: UInt32(value.st_mode), links: UInt64(value.st_nlink), bytes: Int(value.st_size),
                         modifiedNS: ns(value.st_mtimespec), changedNS: ns(value.st_ctimespec))
    }
    private static func linked(_ parent: Int32, _ name: String, _ info: stat, directory: Bool) throws {
        var value = stat()
        guard fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) == 0 else { throw Failure.changed }
        if directory { guard sameDirectory(info, value) else { throw Failure.changed } }
        else { guard info.st_gid == value.st_gid, try identity(info) == identity(value) else { throw Failure.changed } }
    }
    private static func names(_ fd: Int32) throws -> Set<String> {
        // openat gives an independent directory offset; dup(fd) would share it.
        let own = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard own >= 0 else { throw Failure.changed }
        guard let stream = fdopendir(own) else { Darwin.close(own); throw Failure.changed }
        defer { closedir(stream) }; var output = Set<String>()
        errno = 0
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name != ".", name != ".." { guard output.insert(name).inserted, output.count <= 201 else { throw Failure.changed } }
            errno = 0
        }
        guard errno == 0 else { throw Failure.changed }; return output
    }
    private static func read(_ parent: Int32, _ name: String, check: () throws -> Void) throws -> (Data, Model.FileIdentity, stat) {
        try check(); let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.changed }; defer { Darwin.close(fd) }
        var info = stat(); guard fstat(fd, &info) == 0 else { throw Failure.changed }
        let before = try identity(info)
        guard info.st_gid == (try directory(parent)).st_gid, info.st_uid == getuid() else { throw Failure.changed }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            try check(); let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0, errno == EINTR { continue }
            guard count >= 0, data.count + max(0, count) <= before.bytes else { throw Failure.changed }
            if count == 0 { break }; data.append(contentsOf: buffer.prefix(count))
        }
        var after = stat()
        guard data.count == before.bytes, fstat(fd, &after) == 0, after.st_gid == info.st_gid,
              try identity(after) == before else { throw Failure.changed }
        try linked(parent, name, after, directory: false); try check(); return (data, before, after)
    }
    private func roots(extra: String? = nil) throws {
        guard getuid() == uid, geteuid() == uid, getgid() == getegid(), Self.canonical(homePath) else { throw Failure.changed }
        var path = stat()
        guard lstat(homePath, &path) == 0, Self.sameDirectory(path, home), Self.sameDirectory(try Self.directory(homeFD), home),
              Self.sameDirectory(try Self.directory(filesFD), files), Self.sameDirectory(try Self.directory(stagesFD), stages),
              try Self.names(filesFD) == allowedFileNames,
              try Self.names(stagesFD) == Set(records.keys).union(extra.map { [$0] } ?? []) else { throw Failure.changed }
        try Self.linked(homeFD, "relay-files", files, directory: true)
        try Self.linked(homeFD, Self.stageDirectory, stages, directory: true)
        for (ticket, record) in records { try Self.linked(stagesFD, ticket, record.directory, directory: true) }
        for ticket in tombstones {
            var value = stat(); guard fstatat(stagesFD, ticket, &value, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else { throw Failure.changed }
        }
    }
    private func record(_ stage: Model.Stage) throws -> Record {
        guard let value = records[stage.ticket], value.stage.ticket == stage.ticket, value.stage.bindings == stage.bindings,
              value.stage.sha256 == stage.sha256, value.stage.identity == stage.identity,
              value.stage.checkedRuleCounts == stage.checkedRuleCounts else { throw Failure.changed }; return value
    }
    func stage(group: [Model.Resource], blob: Model.Blob, checkedRuleCounts: [String: Int], check: () throws -> Void) throws -> Model.Stage {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !closed, !cleanupStarted, records.count <= Model.maximumRetainedFiles, records.values.allSatisfy({ $0.layout == .swapped }),
              let first = group.first, group.count <= 200, blob.format == first.binding.format,
              group == group.sorted(by: { $0.binding.name < $1.binding.name }),
              Set(group.map { $0.binding.name }).count == group.count,
              Set(checkedRuleCounts.keys) == Set(group.map { $0.binding.name }),
              checkedRuleCounts.values.allSatisfy({ $0 >= 0 && UInt64($0) <= Model.maximumSequence }),
              group.allSatisfy({ $0.binding.originalPath == first.binding.originalPath && $0.binding.format == first.binding.format && $0.identity == first.identity && $0.fileSHA256 == first.fileSHA256 && $0.registeredFile }) else { throw Failure.invalid }
        try check(); try roots()
        let target = try Self.read(filesFD, Self.basename(first.binding), check: check)
        guard target.1 == first.identity, Model.Shared.digest(target.0) == first.fileSHA256 else { throw Failure.changed }
        let ticket = UUID().uuidString.lowercased()
        guard records[ticket] == nil, !tombstones.contains(ticket), mkdirat(stagesFD, ticket, 0o700) == 0 else { throw Failure.conflict }
        let child = openat(stagesFD, ticket, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { throw Failure.changed }
        var keep = false; defer { if !keep { Darwin.close(child) } }
        var fd: Int32 = -1, offset = 0
        defer { if fd >= 0 { Darwin.close(fd) } }
        do {
            let directory = try Self.directory(child)
            guard directory.st_gid == stages.st_gid else { throw Failure.changed }
            try Self.linked(stagesFD, ticket, directory, directory: true)
            fd = openat(child, Self.payload, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw Failure.changed }
            try blob.data.withUnsafeBytes { buffer in
                while offset < buffer.count {
                    try check(); let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if count < 0, errno == EINTR { continue }
                    guard count > 0 else { throw Failure.changed }; offset += count
                }
            }
            guard fsync(fd) == 0, fsync(child) == 0, fsync(stagesFD) == 0 else { throw Failure.changed }
            let payload = try Self.read(child, Self.payload, check: check)
            guard payload.0 == blob.data, try Self.names(child) == [Self.payload] else { throw Failure.changed }
            let stage = Model.Stage(ticket: ticket, bindings: group.map { $0.binding }, sha256: Model.Shared.digest(blob.data), identity: payload.1, checkedRuleCounts: checkedRuleCounts)
            try check(); try roots(extra: ticket)
            try Self.linked(stagesFD, ticket, directory, directory: true)
            let final = try Self.read(child, Self.payload, check: {})
            guard final.1 == stage.identity, final.0 == blob.data else { throw Failure.changed }
            records[ticket] = Record(stage: stage, before: first, directory: directory, fd: child, payload: final.2); keep = true
            return stage
        } catch {
            let original = error
            do { try discardPartial(child: child, ticket: ticket, fd: fd, written: offset, blob: blob) }
            catch { throw Model.Failure.registryUncertain }
            throw original
        }
    }
    /// Cancellation during an exclusive inactive write drains exactly its
    /// known prefix (including a still-empty inode), not an arbitrary sibling.
    private func discardPartial(child: Int32, ticket: String, fd: Int32, written: Int, blob: Model.Blob) throws {
        try roots(extra: ticket); let directory = try Self.directory(child)
        guard directory.st_gid == stages.st_gid else { throw Failure.changed }
        try Self.linked(stagesFD, ticket, directory, directory: true)
        if fd >= 0 {
            var before = stat(), after = stat(), linked = stat()
            guard fstat(fd, &before) == 0, before.st_mode == mode_t(S_IFREG) | 0o600,
                  before.st_uid == uid, before.st_gid == directory.st_gid, before.st_nlink == 1,
                  before.st_size == written, written <= blob.data.count,
                  try Self.names(child) == [Self.payload] else { throw Failure.changed }
            var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
            while data.count < written {
                let n = pread(fd, &buffer, min(buffer.count, written - data.count), off_t(data.count))
                if n < 0, errno == EINTR { continue }
                guard n > 0 else { throw Failure.changed }; data.append(contentsOf: buffer.prefix(n))
            }
            guard data == blob.data.prefix(written), fstat(fd, &after) == 0,
                  fstatat(child, Self.payload, &linked, AT_SYMLINK_NOFOLLOW) == 0,
                  Self.sameRawFile(before, after), Self.sameRawFile(after, linked) else { throw Failure.changed }
            try roots(extra: ticket); try Self.linked(stagesFD, ticket, directory, directory: true)
            guard try Self.names(child) == [Self.payload], unlinkat(child, Self.payload, 0) == 0, fsync(child) == 0 else { throw Failure.changed }
        }
        guard try Self.names(child).isEmpty, unlinkat(stagesFD, ticket, AT_REMOVEDIR) == 0, fsync(stagesFD) == 0 else { throw Failure.changed }
        var absent = stat()
        guard fstatat(stagesFD, ticket, &absent, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else { throw Failure.changed }
        tombstones.insert(ticket)
    }
    private static func sameRawFile(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode &&
        a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
        a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }

    /// First actual active mutation. No callback is allowed after the final
    /// effectful owner fence and the pure pinned-file checks before swap.
    func swap(_ stage: Model.Stage, access: Model.Access, onTransitionRegistered: () throws -> Void = {}) throws -> Swap {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !closed, !cleanupStarted else { throw Failure.closed }; let r = try record(stage)
        guard r.layout == .staged, records.count <= Model.maximumRetainedFiles,
              records.values.reduce(0, { $0 + ($1.retained?.identity.bytes ?? 0) }) + r.before.bytes <= Model.maximumRetainedBytes else { throw Failure.conflict }
        try access.check(); try roots(); try preimage(r, check: { try access.check() })
        // Registration precedes the possible active write, so later lifecycle
        // verification can admit only these exact pre/post layouts on lost ACK.
        let prior = latest[r.before.binding.originalPath]
        r.layout = .attempted; latest[r.before.binding.originalPath] = r
        defer {
            if !access.didEnter { r.layout = .staged; latest[r.before.binding.originalPath] = prior }
        }
        try onTransitionRegistered()
        let fence = try access.preparePublishFence()
        try roots(); try preimage(r, check: {})
        try access.enterPublish(fence)
        guard renameatx_np(filesFD, Self.basename(r.before.binding), r.fd, Self.payload, UInt32(RENAME_SWAP)) == 0 else { throw Failure.changed }
        guard fsync(filesFD) == 0, fsync(r.fd) == 0 else { throw Failure.changed }
        let current = try postimage(r, check: { try access.check() })
        r.layout = .swapped; r.retained = current.retained
        r.payloadFact = .init(identity: try Self.read(r.fd, Self.payload, check: {}).2, sha256: current.retained.sha256)
        currentFiles[r.before.binding.originalPath] = .init(binding: r.before.binding, sha256: stage.sha256, identity: current.currentIdentity)
        return current
    }
    private func preimage(_ r: Record, check: () throws -> Void) throws {
        guard try Self.names(r.fd) == [Self.payload] else { throw Failure.changed }
        let old = try Self.read(filesFD, Self.basename(r.before.binding), check: check), new = try Self.read(r.fd, Self.payload, check: check)
        guard old.1 == r.before.identity, Model.Shared.digest(old.0) == r.before.fileSHA256,
              new.1 == r.stage.identity, Model.Shared.digest(new.0) == r.stage.sha256 else { throw Failure.changed }
    }
    private static func sameMoved(_ a: Model.FileIdentity, _ b: Model.FileIdentity) -> Bool {
        a.device == b.device && a.inode == b.inode && a.ownerUID == b.ownerUID && a.mode == b.mode && a.links == b.links && a.bytes == b.bytes && a.modifiedNS == b.modifiedNS
    }
    private func postimage(_ r: Record, check: () throws -> Void) throws -> Swap {
        guard try Self.names(r.fd) == [Self.payload] else { throw Failure.changed }
        let new = try Self.read(filesFD, Self.basename(r.before.binding), check: check), old = try Self.read(r.fd, Self.payload, check: check)
        guard Self.sameMoved(new.1, r.stage.identity), Model.Shared.digest(new.0) == r.stage.sha256,
              Self.sameMoved(old.1, r.before.identity), Model.Shared.digest(old.0) == r.before.fileSHA256 else { throw Failure.changed }
        return .init(retained: .init(ticket: r.stage.ticket, originalPath: r.before.binding.originalPath, sha256: r.before.fileSHA256, identity: old.1), currentIdentity: new.1)
    }
    func verifySwapped(_ stage: Model.Stage, check: () throws -> Void) throws -> Swap {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }; try check(); try roots()
        let r = try record(stage); guard r.layout == .swapped else { throw Failure.changed }
        return try postimage(r, check: check)
    }
    /// Known file facts only: accepts the authorized pre OR post layout for
    /// inspection/recovery without adopting a Core result or advancing a head.
    func verifyKnownLayouts(check: () throws -> Void) throws {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !closed else { throw Failure.closed }; try verifyKnownLayoutsLocked(check: check)
    }
    private func verifyKnownLayoutsLocked(check: () throws -> Void) throws {
        try check(); try roots()
        for (path, row) in currentFiles {
            if let r = latest[path] {
                switch r.layout {
                case .attempted: do { try preimage(r, check: check) } catch { _ = try postimage(r, check: check) }
                case .swapped:
                    let actual = try Self.read(filesFD, Self.basename(row.binding), check: check)
                    guard actual.1 == row.identity, Model.Shared.digest(actual.0) == row.sha256 else { throw Failure.changed }
                default: throw Failure.changed
                }
            } else {
                let actual = try Self.read(filesFD, Self.basename(row.binding), check: check)
                guard actual.1 == row.identity, Model.Shared.digest(actual.0) == row.sha256 else { throw Failure.changed }
            }
        }
        for r in records.values {
            switch r.layout {
            case .staged: try preimage(r, check: check)
            case .attempted: do { try preimage(r, check: check) } catch { _ = try postimage(r, check: check) }
            case .swapped:
                // A later authorized swap may own the current target. Only the
                // retained payload remains this historical record's authority.
                _ = try retainedImage(r, check: check)
            case .removed: throw Failure.changed
            }
        }
        try check(); try roots()
    }
    /// Actual matched physical targets, including an authorized attempted
    /// pre/post layout, solely for eventual Core-closed private-home cleanup.
    /// Neither currentFiles nor the published provider ledger is advanced.
    func validatedTargetInventory(check: () throws -> Void = {}) throws -> [Entry] {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        guard !closed else { throw Failure.closed }; try verifyKnownLayoutsLocked(check: check)
        var rows = [Entry]()
        for (path, row) in currentFiles.sorted(by: { $0.key < $1.key }) {
            let actual = try Self.read(filesFD, Self.basename(row.binding), check: check)
            rows.append(.init(path: path, directory: false, facts: [.init(identity: actual.2, sha256: Model.Shared.digest(actual.0))]))
        }
        try verifyKnownLayoutsLocked(check: check); return rows
    }
    /// Caller must have positively reaped its own active Core. Preserve the
    /// current target bytes, even after a lost result, and remove only exact
    /// registered inactive stage payloads. Validate the whole set before any
    /// unlink so a foreign sibling or changed retained body grants no cleanup.
    func cleanup(check: () throws -> Void = {}) throws {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }
        if closed { return }
        try verifyKnownLayoutsLocked(check: check); try check()
        // Last caller callback precedes a fresh, callback-free whole-set
        // check. There are no effectful observers between it and deletion.
        try verifyKnownLayoutsLocked(check: {}); cleanupStarted = true
        for (_, record) in records.sorted(by: { $0.key < $1.key }) {
            try roots()
            switch record.layout {
            case .staged: try preimage(record, check: {})
            case .attempted: do { try preimage(record, check: {}) } catch { _ = try postimage(record, check: {}) }
            case .swapped: _ = try retainedImage(record, check: {})
            case .removed: throw Failure.changed
            }
            try remove(record)
        }
        try roots()
        guard try Self.names(stagesFD).isEmpty,
              unlinkat(homeFD, Self.stageDirectory, AT_REMOVEDIR) == 0,
              fsync(homeFD) == 0 else { throw Failure.changed }
        var absent = stat()
        guard fstatat(homeFD, Self.stageDirectory, &absent, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else { throw Failure.changed }
        closed = true
    }
    private func retainedImage(_ r: Record, check: () throws -> Void) throws -> Model.Retained {
        guard let retained = r.retained, try Self.names(r.fd) == [Self.payload] else { throw Failure.changed }
        let value = try Self.read(r.fd, Self.payload, check: check)
        guard value.1 == retained.identity, Model.Shared.digest(value.0) == retained.sha256 else { throw Failure.changed }; return retained
    }
    func discardUnpublished(_ stage: Model.Stage, check: () throws -> Void) throws {
        guard lock.try() else { throw Failure.busy }; defer { lock.unlock() }; try check(); try roots()
        guard !closed, !cleanupStarted else { throw Failure.closed }
        if tombstones.contains(stage.ticket) { guard discardedStages[stage.ticket] == stage else { throw Failure.changed }; return }
        let r = try record(stage); guard r.layout == .staged else { throw Failure.conflict }
        try preimage(r, check: check); try check(); try roots(); try preimage(r, check: {})
        try remove(r)
    }
    /// Victims come only from the model's bounded confirmed FIFO, never from
    /// a directory listing. Removed-prefix facts survive later cancellation.
    func prune(_ victims: [Model.Retained], check: () throws -> Void) -> Model.Pruned {
        guard lock.try() else { return .init(removed: [], complete: false) }; defer { lock.unlock() }
        var removed = [Model.Retained]()
        do {
            guard !closed, !cleanupStarted, victims.count <= Model.maximumRetainedFiles, Set(victims.map { $0.ticket }).count == victims.count else { throw Failure.invalid }
            for victim in victims {
                try check(); try roots()
                guard let r = records[victim.ticket], r.layout == .swapped, r.retained == victim else { throw Failure.changed }
                _ = try retainedImage(r, check: check)
                try check(); try roots(); _ = try retainedImage(r, check: {})
                try remove(r); removed.append(victim)
            }
            return .init(removed: removed, complete: true)
        } catch { return .init(removed: removed, complete: false) }
    }
    private func remove(_ r: Record) throws {
        guard unlinkat(r.fd, Self.payload, 0) == 0, fsync(r.fd) == 0,
              try Self.names(r.fd).isEmpty,
              unlinkat(stagesFD, r.stage.ticket, AT_REMOVEDIR) == 0, fsync(stagesFD) == 0 else { throw Failure.changed }
        var value = stat()
        guard fstatat(stagesFD, r.stage.ticket, &value, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else { throw Failure.changed }
        if latest[r.before.binding.originalPath] === r { latest.removeValue(forKey: r.before.binding.originalPath) }
        r.layout = .removed; records.removeValue(forKey: r.stage.ticket); tombstones.insert(r.stage.ticket); discardedStages[r.stage.ticket] = r.stage
    }
}
