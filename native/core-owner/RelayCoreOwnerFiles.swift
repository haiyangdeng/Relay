import Foundation
import Darwin

private enum CoreOwnerPathFailure: Error { case missing }

// Minimal generalization of the already-reviewed RelayMaintenanceDirectory:
// retain each directory FD, open children with openat/O_NOFOLLOW, and bind every
// parent dirent before/after use. Root-owned resource parents are also admitted;
// all state writes still require a private current-user final parent.
final class CoreOwnerDirectory {
    let path: String
    private var descriptors: [Int32] = []
    private var names: [String] = []
    var fd: Int32 { descriptors.last! }
    init(_ path: String, createBelow home: String? = nil) throws {
        guard path.hasPrefix("/"), !path.contains("\0"), path.utf8.count <= 4096,
              URL(fileURLWithPath: path).standardizedFileURL.path == path else { throw CoreOwnerFailure.record }
        self.path = path
        let first = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard first >= 0 else { throw CoreOwnerFailure.record }; descriptors = [first]
        do {
            var walked = ""
            for raw in path.split(separator: "/") {
                let name = String(raw); try Self.name(name); walked += "/" + name
                var next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                if next < 0 && errno == ENOENT, let home, walked.hasPrefix(home + "/") {
                    try verify()
                    guard mkdirat(fd, name, 0o700) == 0 || errno == EEXIST, fsync(fd) == 0 else { throw CoreOwnerFailure.record }
                    next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                }
                if next < 0 && errno == ENOENT { throw CoreOwnerPathFailure.missing }
                guard next >= 0 else { throw CoreOwnerFailure.record }
                descriptors.append(next); names.append(name); try verify()
            }
            try verify()
        } catch { close(); throw error }
    }
    private func close() { for fd in descriptors.reversed() { Darwin.close(fd) }; descriptors = [] }
    deinit { close() }
    static func name(_ value: String) throws {
        guard !value.isEmpty, value != ".", value != "..", !value.contains("/"), !value.contains("\0"), value.utf8.count <= 255 else { throw CoreOwnerFailure.record }
    }
    func verify() throws {
        guard !descriptors.isEmpty else { throw CoreOwnerFailure.record }
        for index in descriptors.indices {
            var held = stat(), linked = stat()
            guard fstat(descriptors[index], &held) == 0, [getuid(), 0].contains(held.st_uid),
                  held.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), held.st_mode & 0o7022 == 0 else { throw CoreOwnerFailure.record }
            let result = index == 0 ? lstat("/", &linked) : fstatat(descriptors[index - 1], names[index - 1], &linked, AT_SYMLINK_NOFOLLOW)
            guard result == 0, held.st_dev == linked.st_dev, held.st_ino == linked.st_ino,
                  held.st_uid == linked.st_uid, held.st_mode == linked.st_mode else { throw CoreOwnerFailure.record }
        }
    }
    func info() throws -> stat { try verify(); var info = stat(); guard fstat(fd, &info) == 0 else { throw CoreOwnerFailure.record }; return info }
    func userOwnedParent() throws { let value = try info(); guard value.st_uid == getuid(), value.st_mode & 0o7022 == 0 else { throw CoreOwnerFailure.record } }
    func privateParent() throws { let value = try info(); guard value.st_uid == getuid(), value.st_mode & 0o7777 == 0o700 else { throw CoreOwnerFailure.record } }
    private init(parent: CoreOwnerDirectory, name: String) throws {
        try Self.name(name); try parent.verify(); path = parent.path + (parent.path == "/" ? "" : "/") + name
        do {
            for fd in parent.descriptors {
                let copy = fcntl(fd, F_DUPFD_CLOEXEC, 3)
                guard copy >= 0 else { throw CoreOwnerFailure.record }; descriptors.append(copy)
            }
            names = parent.names
            let child = openat(parent.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard child >= 0 else { throw CoreOwnerFailure.record }; descriptors.append(child); names.append(name)
            try verify()
        } catch { close(); throw error }
    }
    func child(_ name: String) throws -> CoreOwnerDirectory { try CoreOwnerDirectory(parent: self, name: name) }
}

final class CoreOwnerLock {
    let parent: CoreOwnerDirectory
    let name: String
    let fd: Int32
    private let dev: dev_t, ino: ino_t
    init(_ path: String) throws {
        parent = try CoreOwnerDirectory(URL(fileURLWithPath: path).deletingLastPathComponent().path)
        name = URL(fileURLWithPath: path).lastPathComponent; try CoreOwnerDirectory.name(name); try parent.privateParent()
        fd = openat(parent.fd, name, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw CoreOwnerFailure.record }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_uid == getuid(),
              info.st_mode & 0o7777 == 0o600, info.st_nlink == 1, flock(fd, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(fd); throw CoreOwnerFailure.record }
        dev = info.st_dev; ino = info.st_ino
        try verify()
    }
    func verify() throws {
        try parent.privateParent(); var held = stat(), linked = stat()
        guard fstat(fd, &held) == 0, fstatat(parent.fd, name, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              held.st_dev == dev, held.st_ino == ino, held.st_uid == getuid(), held.st_nlink == 1,
              held.st_mode & 0o7777 == 0o600, CoreOwnerFiles.same(held, linked) else { throw CoreOwnerFailure.record }
    }
    deinit { Darwin.close(fd) }
}

enum CoreOwnerFiles {
    static func identity(_ info: stat) -> String { "\(info.st_dev):\(info.st_ino)" }
    static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_uid == b.st_uid &&
        a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
        a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
        a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private static func parent(_ path: String) throws -> (CoreOwnerDirectory, String) {
        guard path.hasPrefix("/"), !path.contains("\0"), URL(fileURLWithPath: path).standardizedFileURL.path == path else { throw CoreOwnerFailure.record }
        let url = URL(fileURLWithPath: path), name = url.lastPathComponent
        try CoreOwnerDirectory.name(name)
        return (try CoreOwnerDirectory(url.deletingLastPathComponent().path), name)
    }
    static func pathChain(_ path: String, file: Bool = false) throws {
        if !file { try CoreOwnerDirectory(path).verify(); return }
        let (directory, name) = try parent(path); var value = stat()
        guard fstatat(directory.fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0,
              value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw CoreOwnerFailure.record }
        try directory.verify()
    }
    @discardableResult static func directory(_ path: String, create: Bool = false, home: String) throws -> stat {
        guard path == home || path.hasPrefix(home + "/") else { throw CoreOwnerFailure.record }
        let directory = try CoreOwnerDirectory(path, createBelow: create ? home : nil), value = try directory.info()
        guard value.st_uid == getuid() else { throw CoreOwnerFailure.record }; return value
    }
    static func privateDirectory(_ path: String, home: String) throws -> stat {
        let value = try directory(path, home: home)
        guard value.st_mode & 0o7777 == 0o700 else { throw CoreOwnerFailure.record }; return value
    }
    static func mkdirExclusive(_ path: String) throws {
        let (directory, name) = try parent(path); try directory.userOwnedParent()
        var existing = stat()
        guard fstatat(directory.fd, name, &existing, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT,
              mkdirat(directory.fd, name, 0o700) == 0, fsync(directory.fd) == 0 else { throw CoreOwnerFailure.record }
        guard fstatat(directory.fd, name, &existing, AT_SYMLINK_NOFOLLOW) == 0,
              existing.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), existing.st_uid == getuid(), existing.st_mode & 0o7777 == 0o700 else { throw CoreOwnerFailure.record }
        try directory.verify()
    }
    static func absent(_ path: String) throws -> Bool {
        do {
            let (directory, name) = try parent(path); var info = stat()
            let result = fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW), saved = errno
            try directory.verify()
            if result == 0 { return false }; guard saved == ENOENT else { throw CoreOwnerFailure.record }; return true
        } catch CoreOwnerPathFailure.missing { return true }
    }
    static func read(_ directory: CoreOwnerDirectory, name: String, maximum: Int, privateFile: Bool) throws -> Data {
        try directory.verify(); try CoreOwnerDirectory.name(name)
        let fd = openat(directory.fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw CoreOwnerFailure.record }; defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), before.st_nlink == 1,
              before.st_size >= 0, before.st_size <= maximum,
              privateFile ? before.st_uid == getuid() && before.st_mode & 0o7777 == 0o600 : [getuid(), 0].contains(before.st_uid) && before.st_mode & 0o7022 == 0 else { throw CoreOwnerFailure.record }
        let bytes = FileHandle(fileDescriptor: fd, closeOnDealloc: false).readData(ofLength: maximum + 1)
        guard bytes.count == before.st_size, fstat(fd, &after) == 0, fstatat(directory.fd, name, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              same(before, after), same(before, linked) else { throw CoreOwnerFailure.record }
        try directory.verify(); return bytes
    }
    static func read(_ path: String, maximum: Int = 32768, privateFile: Bool = true) throws -> Data {
        let (directory, name) = try parent(path)
        return try read(directory, name: name, maximum: maximum, privateFile: privateFile)
    }
    static func metadata(_ path: String) throws -> stat {
        let (directory, name) = try parent(path); var info = stat()
        guard fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw CoreOwnerFailure.record }
        try directory.verify(); return info
    }
    static func directoryMatches(_ parent: CoreOwnerDirectory, name: String, identity expected: String, record: String, bytes: Data, maximum: Int = 32768) throws -> Bool {
        try parent.verify(); try CoreOwnerDirectory.name(name)
        var info = stat()
        if fstatat(parent.fd, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
            guard errno == ENOENT else { throw CoreOwnerFailure.record }; try parent.verify(); return false
        }
        guard identity(info) == expected, info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o7777 == 0o700 else { throw CoreOwnerFailure.record }
        let child = try parent.child(name)
        guard identity(try child.info()) == expected, try read(child, name: record, maximum: maximum, privateFile: true) == bytes else { throw CoreOwnerFailure.record }
        try parent.verify(); return true
    }
    static func sync(_ path: String) throws { let directory = try CoreOwnerDirectory(path); guard fsync(directory.fd) == 0 else { throw CoreOwnerFailure.record }; try directory.verify() }
    static func publish(_ bytes: Data, path: String, previous: Data? = nil, maximum: Int = 32768) throws {
        guard !bytes.isEmpty, bytes.count <= maximum else { throw CoreOwnerFailure.record }
        let (directory, name) = try parent(path); try directory.privateParent()
        func checkTarget() throws {
            if let previous { guard try read(directory, name: name, maximum: maximum, privateFile: true) == previous else { throw CoreOwnerFailure.stale } }
            else { var existing = stat(); guard fstatat(directory.fd, name, &existing, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw CoreOwnerFailure.record } }
            try directory.verify()
        }
        try checkTarget()
        let temporary = ".pending-" + UUID().uuidString.lowercased()
        let fd = openat(directory.fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CoreOwnerFailure.record }; defer { Darwin.close(fd) }
        var info = stat(); guard fstat(fd, &info) == 0 else { throw CoreOwnerFailure.record }
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: bytes)
        guard fsync(fd) == 0 else { throw CoreOwnerFailure.record }
        try checkTarget()
        var held = stat(), linked = stat()
        guard fstat(fd, &held) == 0, fstatat(directory.fd, temporary, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              held.st_dev == info.st_dev, held.st_ino == info.st_ino, held.st_uid == getuid(), held.st_nlink == 1,
              held.st_mode & 0o7777 == 0o600, same(held, linked) else { throw CoreOwnerFailure.record }
        if previous == nil {
            guard renameatx_np(directory.fd, temporary, directory.fd, name, UInt32(RENAME_EXCL)) == 0 else { throw CoreOwnerFailure.record }
        } else {
            // C05's RENAME_SWAP preserves the actual displaced leaf even if it
            // changed after checkTarget. Never overwrite/discard or roll back.
            guard renameatx_np(directory.fd, temporary, directory.fd, name, UInt32(RENAME_SWAP)) == 0 else { throw CoreOwnerFailure.record }
            guard let previous, try read(directory, name: temporary, maximum: maximum, privateFile: true) == previous else { throw CoreOwnerFailure.uncertain }
        }
        guard fsync(directory.fd) == 0 else { throw CoreOwnerFailure.record }
        try directory.verify()
        guard try read(directory, name: name, maximum: maximum, privateFile: true) == bytes else { throw CoreOwnerFailure.record }
    }
    static func moveExclusive(_ source: String, destination: String, identity expected: String) throws {
        let (from, name) = try parent(source), (to, target) = try parent(destination)
        try from.userOwnedParent(); try to.privateParent()
        try moveExclusive(from: from, name: name, to: to, target: target, identity: expected)
    }
    static func moveExclusive(from: CoreOwnerDirectory, name: String, to: CoreOwnerDirectory, target: String, identity expected: String) throws {
        try CoreOwnerDirectory.name(name); try CoreOwnerDirectory.name(target)
        try from.userOwnedParent(); try to.privateParent()
        var before = stat(), destinationInfo = stat()
        guard fstatat(from.fd, name, &before, AT_SYMLINK_NOFOLLOW) == 0, before.st_uid == getuid(),
              before.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), before.st_mode & 0o7777 == 0o700,
              identity(before) == expected,
              fstatat(to.fd, target, &destinationInfo, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw CoreOwnerFailure.record }
        try from.verify(); try to.verify()
        guard renameatx_np(from.fd, name, to.fd, target, UInt32(RENAME_EXCL)) == 0 else { throw CoreOwnerFailure.record }
        guard fstatat(to.fd, target, &destinationInfo, AT_SYMLINK_NOFOLLOW) == 0, identity(destinationInfo) == expected,
              destinationInfo.st_mode == before.st_mode, destinationInfo.st_uid == before.st_uid,
              fsync(from.fd) == 0, fsync(to.fd) == 0 else { throw CoreOwnerFailure.uncertain }
        try from.verify(); try to.verify()
    }
}
