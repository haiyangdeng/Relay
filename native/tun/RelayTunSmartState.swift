// Private P34 prototype: fixed-name mutable files only. No process, network,
// installation, JSON decoder or collector writer authority is provided here.
import Foundation
import CryptoKit
import Darwin

final class RelayTunSmartStateFiles {
    typealias State = RelayTunSmartStateV1
    enum Failure: String, Error { case shape, changed, io, state, busy }

    // The caller supplies facts from its existing registry, never facts adopted
    // by scanning current names. checkSource owns verification of other trees.
    struct KnownCoreEntry {
        let name: String
        let identity: Darwin.stat
        let sha256: String?
        private enum Role { case user, authenticatedAPISocket }
        private let role: Role
        init(name: String, identity: Darwin.stat, sha256: String?) {
            self.name = name; self.identity = identity; self.sha256 = sha256; role = .user
        }
        private init(authenticated identity: Darwin.stat) {
            name = "api.sock"; self.identity = identity; sha256 = nil; role = .authenticatedAPISocket
        }
        // The caller may invoke this only with a snapshot already authenticated
        // by Readiness against its held child. This factory performs no name IO
        // and does not itself claim to authenticate a kernel peer.
        static func authenticatedAPISocket(_ identity: Darwin.stat) throws -> KnownCoreEntry {
            let entry = KnownCoreEntry(authenticated: identity)
            try entry.validateAdmission(); return entry
        }
        func validateAdmission() throws {
            if role == .authenticatedAPISocket {
                guard name == "api.sock", sha256 == nil,
                      identity.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
                      identity.st_mode & 0o7777 == 0o666, identity.st_nlink == 1,
                      identity.st_uid == 0 || identity.st_uid == getuid() else { throw Failure.shape }
            } else {
                guard identity.st_uid == getuid() else { throw Failure.changed }
            }
        }
    }
    struct MetadataFact {
        let identity: Darwin.stat
        let sha256: String
        let size: Int
    }
    static let maximumMetadataBytes = 16384
    struct InventoryFile {
        let name: String
        let identity: Darwin.stat
        // A live mutable file has identity authority, not a frozen body digest.
        let sha256: String?
    }
    struct Inventory {
        let seed: [InventoryFile]
        let core: [InventoryFile]
        let result: [InventoryFile]
    }
    private final class FD {
        let raw: Int32
        init(_ raw: Int32) { self.raw = raw }
        deinit { _ = Darwin.close(raw) }
    }
    private struct Image {
        let identity: Darwin.stat
        let sha256: String
    }
    private struct Captured {
        let bytes: Data
        let image: Image
    }
    private final class Record {
        let name: String
        let path: State.Path?
        let fd: FD
        let parent: Int32
        var image: Image
        var mutable = false
        var complete: Bool
        init(path: State.Path, fd: FD, parent: Int32, image: Image, complete: Bool = true) {
            name = path.rawValue; self.path = path; self.fd = fd; self.parent = parent; self.image = image
            self.complete = complete
        }
        init(name: String, fd: FD, parent: Int32, image: Image, complete: Bool = false) {
            self.name = name; path = nil; self.fd = fd; self.parent = parent; self.image = image
            self.complete = complete
        }
    }

    private let lock = NSRecursiveLock()
    private var operating = false
    private let stageRoot: FD
    private let coreRoot: FD
    private let seedRoot: FD
    private let resultRoot: FD
    private let stageIdentity: Darwin.stat
    private let coreIdentity: Darwin.stat
    private let seedIdentity: Darwin.stat
    private let resultIdentity: Darwin.stat
    private let seed: State.Seed
    private let collectCSV: Bool
    private let checkSource: () throws -> Void
    private let knownOtherCoreEntries: () throws -> [KnownCoreEntry]
    private var seedRecords: [State.Path: Record] = [:]
    private var coreRecords: [State.Path: Record] = [:]
    private var resultRecords: [State.Path: Record] = [:]
    private var resultMetadata: Record?
    private var prepared = false
    private var resultAttempted = false
    private var resultCompleted = false
    private var retired = false

    init(stageRootFD: Int32, coreHomeFD: Int32, seed: State.Seed, collectCSV: Bool,
         checkSource: @escaping () throws -> Void,
         knownOtherCoreEntries: @escaping () throws -> [KnownCoreEntry]) throws {
        try State.validateSeed(seed, collectCSV: collectCSV)
        self.seed = seed; self.collectCSV = collectCSV
        self.checkSource = checkSource; self.knownOtherCoreEntries = knownOtherCoreEntries
        stageRoot = try Self.duplicate(stageRootFD); coreRoot = try Self.duplicate(coreHomeFD)
        stageIdentity = try Self.directory(stageRoot.raw); coreIdentity = try Self.directory(coreRoot.raw)
        seedRoot = try Self.openDirectory(stageRoot.raw, "state-seed")
        resultRoot = try Self.openDirectory(stageRoot.raw, "state-result")
        seedIdentity = try Self.directory(seedRoot.raw); resultIdentity = try Self.directory(resultRoot.raw)
        let directories = [stageIdentity, coreIdentity, seedIdentity, resultIdentity]
        for i in directories.indices {
            for j in directories.indices where i < j {
                guard directories[i].st_dev != directories[j].st_dev || directories[i].st_ino != directories[j].st_ino else { throw Failure.shape }
            }
        }
        try checkSource()
        guard try Self.names(seedRoot.raw) == Set(seed.files.map { $0.path.rawValue }),
              try Self.names(resultRoot.raw).isEmpty else { throw Failure.changed }
        for file in seed.files {
            let fd = try Self.openRegular(seedRoot.raw, file.path.rawValue)
            let captured = try Self.read(fd.raw, parent: seedRoot.raw, name: file.path.rawValue)
            guard captured.bytes.count == file.size, captured.image.sha256 == file.sha256 else { throw Failure.changed }
            if file.path == .csv { try State.validateCSVPrefix(captured.bytes) }
            seedRecords[file.path] = Record(path: file.path, fd: fd, parent: seedRoot.raw, image: captured.image)
        }
        _ = try validateAll(others: knownOtherCoreEntries())
        try checkSource()
    }

    func inventory() -> Inventory {
        lock.lock(); defer { lock.unlock() }
        func entries(_ records: [State.Path: Record]) -> [InventoryFile] {
            records.values.sorted { $0.name < $1.name }.map {
                .init(name: $0.name, identity: $0.image.identity,
                      sha256: $0.mutable ? nil : $0.image.sha256)
            }
        }
        var result = entries(resultRecords)
        if let metadata = resultMetadata { result.append(.init(name: metadata.name, identity: metadata.image.identity, sha256: metadata.image.sha256)) }
        return .init(seed: entries(seedRecords), core: entries(coreRecords), result: result.sorted { $0.name < $1.name })
    }

    func prepare() throws {
        try operation {
            guard !prepared, !retired, coreRecords.isEmpty else { throw Failure.state }
            try checkSource()
            _ = try validateAll(others: knownOtherCoreEntries())
            for file in seed.files {
                try checkSource()
                guard let original = seedRecords[file.path] else { throw Failure.state }
                let captured = try verify(original)
                try create(file.path, bytes: captured.bytes, parent: coreRoot.raw, records: &coreRecords)
            }
            guard fsync(coreRoot.raw) == 0 else { throw Failure.io }
            try checkSource()
            _ = try validateAll(others: knownOtherCoreEntries())
            for record in coreRecords.values { record.mutable = true }
            prepared = true
        }
    }

    func verifyLayout() throws {
        try operation {
            try checkSource()
            _ = try validateAll(others: knownOtherCoreEntries())
        }
    }

    // Only an authenticated active-child owner uses this gate. Mutable bodies
    // may be mid-write (including a non-atomic CSV header/truncate). This does
    // not affirm their content or freeze timestamps. Before fork and after
    // reaping, callers retain verifyLayout/captureResult/cleanup's full reads.
    func verifyLiveLayout() throws {
        try operation {
            try checkSource()
            _ = try validateAll(others: knownOtherCoreEntries(), readMutableBodies: false)
        }
    }

    // The caller positively proves its own child reaped and host restored.
    // Result metadata is never such a lifecycle proof by itself.
    func captureResult(afterRestoration: () throws -> Void) throws -> State.Result {
        try operation {
            guard prepared, !retired, !resultAttempted else { throw Failure.state }
            try afterRestoration()
            try checkSource()
            let captured = try validateAll(others: knownOtherCoreEntries())
            guard Set(captured.keys) == Set(seed.files.map(\.path)) else { throw Failure.state }
            // Freeze every closed image before the first output. A failed copy
            // cannot later adopt a changed core inode/body as a new result.
            for (path, image) in captured {
                coreRecords[path]?.image = image.image
                coreRecords[path]?.mutable = false
            }
            resultAttempted = true
            var metadata: [State.File] = []
            for file in seed.files {
                try checkSource()
                guard let image = captured[file.path] else { throw Failure.state }
                try create(file.path, bytes: image.bytes, parent: resultRoot.raw, records: &resultRecords)
                metadata.append(try .init(path: file.path, sha256: image.image.sha256, size: image.bytes.count))
            }
            guard fsync(resultRoot.raw) == 0 else { throw Failure.io }
            try checkSource()
            _ = try validateAll(others: knownOtherCoreEntries())
            let result = try State.Result(key: seed.key, previousRevision: seed.previousRevision, files: metadata, collectCSV: collectCSV)
            resultCompleted = true
            return result
        }
    }

    // Fixed opaque receipt bytes, constructed by the single caller codec. This
    // file is not a mutable State.Path and grants no result/ACK lifecycle proof.
    func writeResultMetadata(_ bytes: Data) throws -> MetadataFact {
        try operation {
            guard resultCompleted, !retired, resultMetadata == nil,
                  bytes.count <= Self.maximumMetadataBytes else { throw Failure.state }
            try checkSource()
            _ = try validateAll(others: knownOtherCoreEntries())
            try createRecord(name: "receipt.json", path: nil, bytes: bytes, parent: resultRoot.raw) { resultMetadata = $0 }
            guard fsync(resultRoot.raw) == 0 else { throw Failure.io }
            try checkSource()
            _ = try validateAll(others: knownOtherCoreEntries())
            guard let metadata = resultMetadata else { throw Failure.state }
            return .init(identity: metadata.image.identity, sha256: metadata.image.sha256, size: bytes.count)
        }
    }

    // Only files created here in the core home may be removed. Node continues
    // to own its seed/result directories and bytes, including failed outputs.
    func cleanupCore(afterRestoration: () throws -> Void) throws {
        try operation {
            try afterRestoration()
            try checkSource()
            let others = try knownOtherCoreEntries()
            let captured = try validateAll(others: others)
            // Full seed/result/core union was checked before the first unlink.
            // No caller callback runs between that preflight and known unlinks.
            for path in coreRecords.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
                guard let record = coreRecords[path], let image = captured[path] else { throw Failure.state }
                let current = try verify(record)
                guard Self.stable(current.image.identity, image.image.identity),
                      current.image.sha256 == image.image.sha256 else { throw Failure.changed }
                guard unlinkat(coreRoot.raw, path.rawValue, 0) == 0 else { throw Failure.io }
                coreRecords.removeValue(forKey: path)
            }
            guard fsync(coreRoot.raw) == 0 else { throw Failure.io }
            retired = true; prepared = false
        }
    }

    private func operation<T>(_ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard !operating else { throw Failure.busy }
        operating = true; defer { operating = false }
        return try body()
    }

    private func validateAll(others: [KnownCoreEntry], readMutableBodies: Bool = true) throws -> [State.Path: Captured] {
        guard Self.sameDirectory(stageIdentity, try Self.directory(stageRoot.raw)),
              Self.sameDirectory(coreIdentity, try Self.directory(coreRoot.raw)),
              Self.sameDirectory(seedIdentity, try Self.directory(seedRoot.raw)),
              Self.sameDirectory(resultIdentity, try Self.directory(resultRoot.raw)),
              Self.sameDirectory(seedIdentity, try Self.at(stageRoot.raw, "state-seed")),
              Self.sameDirectory(resultIdentity, try Self.at(stageRoot.raw, "state-result")),
              try Self.names(seedRoot.raw) == Set(seedRecords.keys.map(\.rawValue)),
              try Self.names(resultRoot.raw) == Set(resultRecords.keys.map(\.rawValue)).union(resultMetadata == nil ? [] : ["receipt.json"]) else { throw Failure.changed }
        for record in seedRecords.values { _ = try verify(record) }
        for record in resultRecords.values { _ = try verify(record) }
        if let metadata = resultMetadata { _ = try verify(metadata) }
        var names = Set(coreRecords.keys.map(\.rawValue))
        for entry in others {
            guard Self.validOtherName(entry.name), names.insert(entry.name).inserted else { throw Failure.shape }
        }
        guard try Self.names(coreRoot.raw) == names else { throw Failure.changed }
        for entry in others { try verifyOther(entry) }
        var captured: [State.Path: Captured] = [:], total = 0
        for (path, record) in coreRecords {
            if record.mutable, !readMutableBodies {
                total += try verifyMutableIdentity(record)
                guard total <= State.maximumTotalBytes else { throw Failure.changed }
                continue
            }
            let image = try verify(record)
            total += image.bytes.count
            guard total <= State.maximumTotalBytes else { throw Failure.changed }
            captured[path] = image
        }
        return captured
    }

    private func verifyMutableIdentity(_ record: Record) throws -> Int {
        let before = try Self.regular(record.fd.raw)
        let linked = try Self.at(record.parent, record.name)
        guard Self.sameIdentity(record.image.identity, before),
              Self.sameIdentity(before, linked), linked.st_size >= 0,
              linked.st_size <= State.maximumFileBytes else { throw Failure.changed }
        // Size can change legitimately between observations. Bound both
        // observations without treating a time/length transition as a freeze.
        return max(Int(before.st_size), Int(linked.st_size))
    }

    private func verify(_ record: Record) throws -> Captured {
        let captured = try Self.read(record.fd.raw, parent: record.parent, name: record.name,
                                     limit: record.path == nil ? Self.maximumMetadataBytes : State.maximumFileBytes)
        guard Self.sameIdentity(record.image.identity, captured.image.identity) else { throw Failure.changed }
        if !record.mutable {
            guard Self.stable(record.image.identity, captured.image.identity),
                  record.image.sha256 == captured.image.sha256 else { throw Failure.changed }
        }
        if record.path == .csv, record.complete { try State.validateCSVPrefix(captured.bytes) }
        return captured
    }

    private func verifyOther(_ entry: KnownCoreEntry) throws {
        try entry.validateAdmission()
        let linked = try Self.at(coreRoot.raw, entry.name)
        guard Self.sameIdentity(entry.identity, linked) else { throw Failure.changed }
        switch linked.st_mode & mode_t(S_IFMT) {
        case mode_t(S_IFREG):
            guard let digest = entry.sha256, linked.st_nlink == 1,
                  Self.stable(entry.identity, linked) else { throw Failure.changed }
            let fd = try Self.openRegular(coreRoot.raw, entry.name, requiredMode: nil)
            let captured = try Self.read(fd.raw, parent: coreRoot.raw, name: entry.name, requiredMode: nil)
            guard Self.stable(entry.identity, captured.image.identity), captured.image.sha256 == digest else { throw Failure.changed }
        case mode_t(S_IFDIR):
            guard entry.sha256 == nil, linked.st_mode & 0o7777 == 0o700,
                  Self.sameDirectory(entry.identity, linked) else { throw Failure.changed }
        case mode_t(S_IFSOCK):
            guard entry.sha256 == nil, linked.st_mode & 0o7777 == 0o666 else { throw Failure.changed }
        default: throw Failure.changed
        }
    }

    private func create(_ path: State.Path, bytes: Data, parent: Int32,
                        records: inout [State.Path: Record]) throws {
        guard records[path] == nil else { throw Failure.state }
        try createRecord(name: path.rawValue, path: path, bytes: bytes, parent: parent) { records[path] = $0 }
    }
    private func createRecord(name: String, path: State.Path?, bytes: Data, parent: Int32,
                              retain: (Record) -> Void) throws {
        let raw = openat(parent, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard raw >= 0 else { throw Failure.io }
        let fd = FD(raw), initial = try Self.regular(raw)
        let record: Record
        let image = Image(identity: initial, sha256: State.digest(Data()))
        if let path { record = Record(path: path, fd: fd, parent: parent, image: image, complete: false) }
        else { record = Record(name: name, fd: fd, parent: parent, image: image) }
        // Retain creator capability before any data write or later validation.
        retain(record)
        guard initial.st_size == 0, Self.stable(initial, try Self.at(parent, name)) else { throw Failure.changed }
        var offset = 0, hasher = SHA256()
        try bytes.withUnsafeBytes { pointer in
            while offset < bytes.count {
                let count = min(65536, bytes.count - offset)
                let written = Darwin.write(raw, pointer.baseAddress!.advanced(by: offset), count)
                if written < 0, errno == EINTR { continue }
                guard written > 0 else { throw Failure.io }
                hasher.update(data: bytes.subdata(in: offset..<(offset + written)))
                offset += written
                let fact = try Self.regular(raw)
                let checkpoint = hasher
                record.image = .init(identity: fact, sha256: Self.hex(checkpoint.finalize()))
                guard fact.st_size == offset, Self.sameIdentity(initial, fact) else { throw Failure.changed }
            }
        }
        guard fsync(raw) == 0 else { throw Failure.io }
        let final = try Self.regular(raw)
        guard final.st_size == bytes.count, Self.sameIdentity(initial, final) else { throw Failure.changed }
        record.image = .init(identity: final, sha256: State.digest(bytes))
        record.complete = true
        _ = try verify(record)
    }

    private static func hex(_ digest: SHA256.Digest) -> String { digest.map { String(format: "%02x", $0) }.joined() }
    private static func duplicate(_ raw: Int32) throws -> FD {
        let copy = Darwin.dup(raw)
        guard copy >= 0 else { throw Failure.io }
        let fd = FD(copy)
        guard fcntl(copy, F_SETFD, FD_CLOEXEC) == 0 else { throw Failure.io }
        return fd
    }
    private static func inspect(_ raw: Int32) throws -> Darwin.stat {
        var fact = Darwin.stat()
        guard fstat(raw, &fact) == 0 else { throw Failure.io }
        return fact
    }
    private static func at(_ parent: Int32, _ name: String) throws -> Darwin.stat {
        var fact = Darwin.stat()
        guard fstatat(parent, name, &fact, AT_SYMLINK_NOFOLLOW) == 0 else { throw Failure.changed }
        return fact
    }
    private static func directory(_ raw: Int32) throws -> Darwin.stat {
        let fact = try inspect(raw)
        // Darwin can inherit a parent group different from the process primary
        // group. The captured group remains immutable in every identity check.
        guard fact.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), fact.st_mode & 0o7777 == 0o700,
              fact.st_uid == getuid() else { throw Failure.changed }
        return fact
    }
    private static func regular(_ raw: Int32, requiredMode: mode_t? = 0o600) throws -> Darwin.stat {
        let fact = try inspect(raw)
        guard fact.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), fact.st_nlink == 1,
              fact.st_uid == getuid(), fact.st_size >= 0,
              fact.st_size <= State.maximumFileBytes else { throw Failure.changed }
        if let requiredMode { guard fact.st_mode & 0o7777 == requiredMode else { throw Failure.changed } }
        return fact
    }
    private static func openDirectory(_ parent: Int32, _ name: String) throws -> FD {
        let raw = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard raw >= 0 else { throw Failure.changed }
        let fd = FD(raw), fact = try directory(raw)
        guard sameDirectory(fact, try at(parent, name)) else { throw Failure.changed }
        return fd
    }
    private static func openRegular(_ parent: Int32, _ name: String, requiredMode: mode_t? = 0o600) throws -> FD {
        let raw = openat(parent, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard raw >= 0 else { throw Failure.changed }
        let fd = FD(raw), fact = try regular(raw, requiredMode: requiredMode)
        guard stable(fact, try at(parent, name)) else { throw Failure.changed }
        return fd
    }
    private static func read(_ raw: Int32, parent: Int32, name: String,
                             requiredMode: mode_t? = 0o600, limit: Int = State.maximumFileBytes) throws -> Captured {
        let before = try regular(raw, requiredMode: requiredMode)
        guard before.st_size <= limit, stable(before, try at(parent, name)) else { throw Failure.changed }
        let expected = Int(before.st_size)
        var bytes = Data(count: expected + 1), count = 0
        try bytes.withUnsafeMutableBytes { pointer in
            while count < pointer.count {
                let received = pread(raw, pointer.baseAddress!.advanced(by: count), min(65536, pointer.count - count), off_t(count))
                if received < 0, errno == EINTR { continue }
                guard received >= 0 else { throw Failure.io }
                if received == 0 { break }
                count += received
            }
        }
        let after = try regular(raw, requiredMode: requiredMode)
        guard count == expected, stable(before, after), stable(after, try at(parent, name)) else { throw Failure.changed }
        bytes.removeSubrange(count..<bytes.count)
        return .init(bytes: bytes, image: .init(identity: after, sha256: State.digest(bytes)))
    }
    private static func names(_ raw: Int32) throws -> Set<String> {
        // dup would share directory offset with an earlier enumeration.
        let copy = openat(raw, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard copy >= 0 else { throw Failure.io }
        guard let directory = fdopendir(copy) else { _ = Darwin.close(copy); throw Failure.io }
        defer { _ = closedir(directory) }
        var result = Set<String>()
        errno = 0
        while let entry = readdir(directory) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name != ".", name != ".." { guard result.insert(name).inserted else { throw Failure.changed } }
            errno = 0
        }
        guard errno == 0 else { throw Failure.io }
        return result
    }
    private static func validOtherName(_ name: String) -> Bool {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.utf8.contains(0) else { return false }
        for path in State.Path.allCases where name == path.rawValue || name.hasPrefix(path.rawValue + ".") { return false }
        return true
    }
    private static func sameDirectory(_ a: Darwin.stat, _ b: Darwin.stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode
    }
    private static func sameIdentity(_ a: Darwin.stat, _ b: Darwin.stat) -> Bool {
        sameDirectory(a, b) && a.st_nlink == b.st_nlink
    }
    private static func stable(_ a: Darwin.stat, _ b: Darwin.stat) -> Bool {
        sameIdentity(a, b) && a.st_size == b.st_size &&
        a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
        a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
}
