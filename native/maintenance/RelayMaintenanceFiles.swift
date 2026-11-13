import CryptoKit
import Darwin
import Foundation

// Adapted from RelayBackupMove.Chain and the TUN journal archive's exclusive
// rename primitive. The reset coordinator never accepts a user/renderer path.
enum RelayMaintenanceFailure: String, Error { case unavailable, publisher, identity, busy, unsafe, changed, pending, invalid, cancelled, uncertain, ownedRuntimePending, helperPending }
struct RelayMaintenanceIdentity: Codable, Equatable, Sendable {
    let dev: UInt64, ino: UInt64
    let uid: UInt32, mode: UInt32
    init(_ info: stat) throws {
        guard info.st_dev >= 0, info.st_ino > 0 else { throw RelayMaintenanceFailure.unsafe }
        dev = UInt64(info.st_dev); ino = UInt64(info.st_ino); uid = info.st_uid; mode = UInt32(info.st_mode)
    }
}
final class RelayMaintenanceDirectory {
    private let home: String
    private var descriptors: [Int32] = []
    private var names: [String] = []
    var fd: Int32 { descriptors.last! }
    init(home: String, components: [String], create: Bool = false) throws {
        self.home = home
        let initial = Darwin.open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard initial >= 0 else { throw RelayMaintenanceFailure.unsafe }
        descriptors = [initial]
        do {
            for name in components {
                try Self.name(name)
                var next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                if next < 0 && errno == ENOENT && create {
                    try verify()
                    guard mkdirat(fd, name, 0o700) == 0 || errno == EEXIST else { throw RelayMaintenanceFailure.unsafe }
                    guard fsync(fd) == 0 else { throw RelayMaintenanceFailure.uncertain }
                    next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                }
                guard next >= 0 else { throw RelayMaintenanceFailure.unsafe }
                descriptors.append(next); names.append(name)
                try verify()
            }
            try verify()
        } catch { closeAll(); throw error }
    }
    deinit { closeAll() }
    private func closeAll() { for fd in descriptors.reversed() { Darwin.close(fd) }; descriptors = [] }
    static func name(_ value: String) throws {
        guard !value.isEmpty, value != ".", value != "..", !value.contains("/"), !value.utf8.contains(0), value.utf8.count <= 255 else { throw RelayMaintenanceFailure.invalid }
    }
    func verify() throws {
        guard !descriptors.isEmpty else { throw RelayMaintenanceFailure.unsafe }
        for index in descriptors.indices {
            var held = stat(), linked = stat()
            guard fstat(descriptors[index], &held) == 0, held.st_uid == getuid(),
                  held.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), held.st_mode & 0o7022 == 0 else { throw RelayMaintenanceFailure.unsafe }
            let result = index == 0 ? lstat(home, &linked) : fstatat(descriptors[index - 1], names[index - 1], &linked, AT_SYMLINK_NOFOLLOW)
            guard result == 0, held.st_dev == linked.st_dev, held.st_ino == linked.st_ino,
                  held.st_mode == linked.st_mode, held.st_uid == linked.st_uid else { throw RelayMaintenanceFailure.changed }
        }
    }
    func identity(_ name: String) throws -> RelayMaintenanceIdentity? {
        try Self.name(name); try verify()
        var info = stat()
        if fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
            guard errno == ENOENT else { throw RelayMaintenanceFailure.unsafe }; return nil
        }
        guard info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o7022 == 0 else { throw RelayMaintenanceFailure.unsafe }
        return try .init(info)
    }
    func list() throws -> [String] {
        try verify()
        // Independent open description: repeated scans must not share offsets.
        let duplicate = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard duplicate >= 0, let stream = fdopendir(duplicate) else { if duplicate >= 0 { Darwin.close(duplicate) }; throw RelayMaintenanceFailure.unsafe }
        defer { closedir(stream) }
        var result: [String] = []
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                guard errno == 0 else { throw RelayMaintenanceFailure.unsafe }
                break
            }
            let value = withUnsafePointer(to: &entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
            if value == "." || value == ".." { continue }
            guard result.count < 1024 else { throw RelayMaintenanceFailure.unsafe }
            try Self.name(value); result.append(value)
        }
        try verify(); return result.sorted()
    }
    func read(_ name: String, limit: Int = 65536) throws -> Data? {
        try Self.name(name); try verify()
        let descriptor = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 && errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw RelayMaintenanceFailure.unsafe }
        defer { Darwin.close(descriptor) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(descriptor, &before) == 0, before.st_uid == getuid(), before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              before.st_mode & 0o7777 == 0o600, before.st_nlink == 1, before.st_size > 0, before.st_size <= limit else { throw RelayMaintenanceFailure.unsafe }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            guard count >= 0 else { throw RelayMaintenanceFailure.unsafe }
            if count == 0 { break }; bytes.append(buffer, count: count)
            guard bytes.count <= limit else { throw RelayMaintenanceFailure.unsafe }
        }
        guard fstat(descriptor, &after) == 0, fstatat(fd, name, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              Self.same(before, after), Self.same(before, linked), bytes.count == before.st_size else { throw RelayMaintenanceFailure.changed }
        try verify(); return bytes
    }
    func append(_ name: String, _ bytes: Data) throws {
        try Self.name(name); try verify()
        guard !bytes.isEmpty, bytes.count <= 65536 else { throw RelayMaintenanceFailure.invalid }
        let descriptor = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw RelayMaintenanceFailure.changed }
        defer { Darwin.close(descriptor) }
        var offset = 0
        try bytes.withUnsafeBytes { raw in
            while offset < raw.count {
                let count = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                guard count > 0 else { throw RelayMaintenanceFailure.uncertain }; offset += count
            }
        }
        guard fsync(descriptor) == 0, fsync(fd) == 0 else { throw RelayMaintenanceFailure.uncertain }
        guard try read(name) == bytes else { throw RelayMaintenanceFailure.uncertain }
    }
    func move(_ name: String, to target: RelayMaintenanceDirectory, as destination: String,
              identity expected: RelayMaintenanceIdentity? = nil) throws {
        try Self.name(name); try Self.name(destination); try verify(); try target.verify()
        if let expected { guard try identity(name) == expected else { throw RelayMaintenanceFailure.changed } }
        var targetItem = stat(), sourceDirectory = stat(), targetDirectory = stat()
        guard fstat(fd, &sourceDirectory) == 0, fstat(target.fd, &targetDirectory) == 0, sourceDirectory.st_dev == targetDirectory.st_dev,
              fstatat(target.fd, destination, &targetItem, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw RelayMaintenanceFailure.changed }
        // No rename(2) fallback, overwrite, copy, recursive delete or WAL opening.
        guard renameatx_np(fd, name, target.fd, destination, UInt32(RENAME_EXCL)) == 0 else { throw RelayMaintenanceFailure.changed }
        guard fsync(fd) == 0, fsync(target.fd) == 0 else { throw RelayMaintenanceFailure.uncertain }
        if let expected { guard try target.identity(destination) == expected else { throw RelayMaintenanceFailure.uncertain } }
        try verify(); try target.verify()
    }
    func replaceMarker(_ name: String, expected: Data, with bytes: Data) throws {
        try Self.name(name); try verify()
        guard try read(name) == expected else { throw RelayMaintenanceFailure.changed }
        let temporary = "replaced-intent-" + UUID().uuidString.lowercased() + ".json"
        try append(temporary, bytes)
        guard try read(name) == expected else { throw RelayMaintenanceFailure.changed }
        // Both immutable records survive the atomic swap. The active marker is
        // never absent, and no old intent is overwritten or silently discarded.
        guard renameatx_np(fd, temporary, fd, name, UInt32(RENAME_SWAP)) == 0,
              fsync(fd) == 0, try read(name) == bytes, try read(temporary) == expected else { throw RelayMaintenanceFailure.uncertain }
    }

    static func same(_ left: stat, _ right: stat) -> Bool {
        left.st_dev == right.st_dev && left.st_ino == right.st_ino && left.st_uid == right.st_uid && left.st_mode == right.st_mode &&
        left.st_nlink == right.st_nlink && left.st_size == right.st_size && left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec &&
        left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec && left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec && left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
