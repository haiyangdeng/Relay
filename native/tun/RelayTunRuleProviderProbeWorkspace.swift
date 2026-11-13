import Foundation
import Darwin
import Security

/// An owned empty-root capability is returned before prepare writes anything.
/// No supplied pathname names executable material. The source is the fixed
/// positively verified installation; the child executes only its 0500 copy.
final class RelayTunRuleProviderProbeWorkspace {
    typealias Probe = RelayTunRuntimeRuleProviderProbe
    enum Failure: Error { case invalid, changed, busy, conflict }
    private final class File {
        let fd: Int32, parent: Int32, name: String, data: Data
        var written = 0
        var identity: stat
        init(fd: Int32, parent: Int32, name: String, data: Data, identity: stat) {
            self.fd = fd; self.parent = parent; self.name = name; self.data = data; self.identity = identity
        }
        deinit { Darwin.close(fd) }
    }
    private let projection: Probe.Projection, pin: (sha256: String, bytes: Int), directory: String, root: stat, fd: Int32
    private let source: () throws -> Data
    private var files = [String: File]()
    private var directories: [String: stat] = [:]
    private var runtime: [String: stat] = [:]
    private var directoryFDs = [String: Int32]()
    private var child: RelayTunOwnedChild?, spawned = false, started = false, prepared = false, removed = false
    private var deleted = Set<String>()

    convenience init(projection: Probe.Projection, corePin: (sha256: String, bytes: Int)) throws {
        try self.init(projection: projection, corePin: corePin, source: { try Self.installedCore(corePin) })
    }
    private init(projection: Probe.Projection, corePin: (sha256: String, bytes: Int), source: @escaping () throws -> Data) throws {
        let known = Probe.corePin
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(), corePin.sha256 == known.sha256,
              corePin.bytes == known.bytes, projection.coreSHA256 == known.sha256,
              !projection.configuration.isEmpty, projection.configuration.count <= 2 * 1024 * 1024,
              Probe.Model.Shared.digest(projection.configuration) == projection.configurationSHA256,
              projection.assets.count <= 200, projection.assets.values.reduce(0, { $0 + $1.count }) <= Probe.Model.maximumTotalBytes,
              projection.assets.keys.allSatisfy(Self.assetPath) else { throw Failure.invalid }
        var pattern = Array("/private/tmp/relay-provider-probe-\(getuid())-XXXXXX".utf8CString)
        guard mkdtemp(&pattern) != nil else { throw Failure.invalid }
        let path = String(cString: pattern), descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw Failure.changed }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_mode == mode_t(S_IFDIR) | 0o700 else {
            Darwin.close(descriptor); throw Failure.changed
        }
        self.projection = projection; pin = corePin; directory = path; root = info; fd = descriptor; self.source = source
    }
    deinit { for fd in directoryFDs.values { Darwin.close(fd) }; Darwin.close(fd) }
    var workspace: Probe.Workspace {
        get throws {
            try .init(directory: directory, configuration: projection.configuration, coreSHA256: pin.sha256, coreBytes: pin.bytes,
                prepare: { try self.prepare() }, didSpawn: { self.child = $0; self.spawned = true },
                verify: { try self.verify() }, cleanup: { try self.cleanup() })
        }
    }
    private static func assetPath(_ path: String) -> Bool {
        if Probe.Model.Shared.Kind.allCases.contains(where: { $0.basename == path }) { return true }
        let pieces = path.split(separator: "/", omittingEmptySubsequences: false)
        guard pieces.count == 2, pieces[0] == "relay-files" else { return false }
        let parts = pieces[1].split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 2 && Probe.Model.Shared.hash(String(parts[0])) && ["yaml", "text", "mrs", "bin"].contains(String(parts[1]))
    }
    private static func same(_ a: stat, _ b: stat, contents: Bool = true, links: Bool = true) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid &&
            a.st_mode == b.st_mode && (!links || a.st_nlink == b.st_nlink) && (!contents || (a.st_size == b.st_size &&
            a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
            a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec))
    }
    private func rootLive() throws {
        guard !removed, let physical = realpath(directory, nil) else { throw Failure.changed }
        defer { free(physical) }
        var held = stat(), linked = stat()
        guard String(cString: physical) == directory, fstat(fd, &held) == 0, lstat(directory, &linked) == 0,
              root.st_dev == held.st_dev, root.st_ino == held.st_ino, root.st_uid == held.st_uid,
              root.st_gid == held.st_gid, root.st_mode == held.st_mode,
              held.st_dev == linked.st_dev, held.st_ino == linked.st_ino, held.st_uid == linked.st_uid,
              held.st_gid == linked.st_gid, held.st_mode == linked.st_mode else { throw Failure.changed }
    }
    private static func signature(_ path: String) throws {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPathAndAttributes(URL(fileURLWithPath: path) as CFURL, [],
            [kSecCodeAttributeArchitecture: RelayTunManagedInstallation.architecture] as CFDictionary, &code) == errSecSuccess,
              let code, SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate).union(.noNetworkAccess), nil) == errSecSuccess else { throw Failure.invalid }
    }
    private static func installedCore(_ pin: (sha256: String, bytes: Int)) throws -> Data {
        let installation = try RelayTunManagedInstallation.load()
        guard installation.coreProfile == .localGeodata, installation.coreSHA256 == pin.sha256 else { throw Failure.invalid }
        let path = installation.executable
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: path))
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw Failure.invalid }; defer { Darwin.close(fd) }
        var original = stat(), current = stat(), linked = stat()
        guard fstat(fd, &original) == 0, original.st_mode == mode_t(S_IFREG) | 0o4755,
              original.st_uid == 0, original.st_gid == 0, original.st_nlink == 1, original.st_size == pin.bytes else { throw Failure.invalid }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0, errno == EINTR { continue }
            guard count >= 0, bytes.count + max(count, 0) <= pin.bytes else { throw Failure.changed }
            if count == 0 { break }; bytes.append(contentsOf: buffer.prefix(count))
        }
        guard bytes.count == pin.bytes, Probe.Model.Shared.digest(bytes) == pin.sha256 else { throw Failure.changed }
        try signature(path)
        guard fstat(fd, &current) == 0, lstat(path, &linked) == 0,
              same(original, current), same(current, linked) else { throw Failure.changed }
        return bytes
    }
    private func write(_ data: Data, path: String, mode: mode_t = 0o600) throws {
        try rootLive()
        if path.hasPrefix("relay-files/"), directories["relay-files"] == nil {
            guard mkdirat(fd, "relay-files", 0o700) == 0 else { throw Failure.conflict }
            let parent = openat(fd, "relay-files", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard parent >= 0 else { throw Failure.changed }
            var info = stat()
            guard fstat(parent, &info) == 0, info.st_mode == mode_t(S_IFDIR) | 0o700,
                  info.st_uid == root.st_uid, info.st_gid == root.st_gid else { Darwin.close(parent); throw Failure.changed }
            directories["relay-files"] = info; directoryFDs["relay-files"] = parent
        }
        let parent = path.hasPrefix("relay-files/") ? directoryFDs["relay-files"]! : fd
        let name = String(path.split(separator: "/").last!)
        let own = openat(parent, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard own >= 0 else { throw Failure.conflict }
        var original = stat()
        guard fstat(own, &original) == 0, original.st_mode == mode_t(S_IFREG) | 0o600,
              original.st_uid == root.st_uid, original.st_gid == root.st_gid, original.st_nlink == 1 else {
            Darwin.close(own); throw Failure.changed
        }
        let record = File(fd: own, parent: parent, name: name, data: data, identity: original); files[path] = record
        // The exclusive inode is registered before the first write, including
        // an interrupted write. Cleanup can only recognize its recorded prefix.
        try data.withUnsafeBytes { bytes in
            while record.written < bytes.count {
                let count = Darwin.write(own, bytes.baseAddress!.advanced(by: record.written), min(65536, bytes.count - record.written))
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw Failure.changed }; record.written += count
                guard fstat(own, &record.identity) == 0 else { throw Failure.changed }
            }
        }
        guard fsync(own) == 0, fchmod(own, mode) == 0, fstat(own, &record.identity) == 0 else { throw Failure.changed }
    }
    private func prepare() throws {
        guard !started else { throw Failure.busy }; started = true
        try rootLive(); guard try FileManager.default.contentsOfDirectory(atPath: directory).isEmpty else { throw Failure.conflict }
        let bytes = try source()
        guard bytes.count == pin.bytes, Probe.Model.Shared.digest(bytes) == pin.sha256 else { throw Failure.changed }
        try write(bytes, path: "mihomo-probe", mode: 0o500)
        try Self.signature(directory + "/mihomo-probe")
        try write(projection.configuration, path: "config.yaml")
        // Fixed Mihomo cachefile.initCache uses pinned bbolt.Open, which
        // initializes an existing zero-length file in place. Register this
        // exclusive inode before spawn; its basename never grants ownership.
        try write(Data(), path: "cache.db")
        for path in projection.assets.keys.sorted() { try write(projection.assets[path]!, path: path) }
        guard fsync(fd) == 0 else { throw Failure.changed }
        for (path, record) in files { try verifyFile(path, record, contents: true) }
        prepared = true; try verify()
    }
    private func verifyFile(_ path: String, _ record: File, contents: Bool = false) throws {
        var held = stat(), linked = stat()
        guard fstat(record.fd, &held) == 0, fstatat(record.parent, record.name, &linked, AT_SYMLINK_NOFOLLOW) == 0 else { throw Failure.changed }
        if path == "cache.db", spawned {
            // The held, pre-created inode may grow under the registered child.
            // Neither a fresh inode nor a post-spawn path spelling is adopted.
            guard Self.same(held, record.identity, contents: false), Self.same(held, linked, contents: false),
                  held.st_size >= 0, held.st_size <= 128 * 1024 * 1024 else { throw Failure.changed }
            return
        }
        guard Self.same(held, record.identity), Self.same(held, linked), held.st_size == record.written else { throw Failure.changed }
        guard contents else { return }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536), offset = 0
        while offset < record.written {
            let count = pread(record.fd, &buffer, min(buffer.count, record.written - offset), off_t(offset))
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw Failure.changed }; offset += count; data.append(contentsOf: buffer.prefix(count))
        }
        guard data == record.data.prefix(record.written), fstat(record.fd, &held) == 0,
              fstatat(record.parent, record.name, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              Self.same(held, record.identity), Self.same(held, linked) else { throw Failure.changed }
    }
    private func runtimeFiles(running: RelayTunOwnedChild?) throws {
        for name in ["api.sock"] {
            var current = stat()
            if fstatat(fd, name, &current, AT_SYMLINK_NOFOLLOW) != 0 {
                guard errno == ENOENT else { throw Failure.changed }; continue
            }
            guard current.st_uid == root.st_uid, current.st_gid == root.st_gid, current.st_nlink == 1,
                  current.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) else { throw Failure.changed }
            if let known = runtime[name] {
                guard Self.same(known, current, contents: false) else { throw Failure.changed }
            } else {
                guard let running else { throw Failure.conflict }
                // The fixed Core listens before chmod(0666), then starts its
                // HTTP server. Never freeze that initial umask-derived mode.
                // Readiness retries a first read that spans the same change;
                // only the final mode plus held peer/inode admits this name.
                guard current.st_mode & 0o7777 == 0o666 else { continue }
                if name == "api.sock" {
                    let connection = socket(AF_UNIX, SOCK_STREAM, 0)
                    guard connection >= 0 else { throw Failure.changed }; defer { Darwin.close(connection) }
                    guard fcntl(connection, F_SETFL, O_NONBLOCK) == 0, fcntl(connection, F_SETFD, FD_CLOEXEC) == 0 else { throw Failure.changed }
                    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
                    let bytes = Array((directory + "/api.sock").utf8CString).map { UInt8(bitPattern: $0) }
                    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw Failure.changed }
                    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
                    let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(connection, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
                    if result != 0, [ECONNREFUSED, EINPROGRESS, EAGAIN].contains(errno) { continue } // Not yet listening; never registered/adopted.
                    guard result == 0 else { throw Failure.changed }; try running.verifyPeer(socket: connection)
                }
                var linked = stat()
                guard case .running = try running.observe(),
                      fstatat(fd, name, &linked, AT_SYMLINK_NOFOLLOW) == 0,
                      Self.same(current, linked, contents: false) else { throw Failure.changed }
                runtime[name] = linked
            }
        }
    }
    private func validateNames(allowRunningNames: Bool = false) throws {
        for (path, original) in directories where !deleted.contains(path) {
            var current = stat(), held = stat()
            guard let directoryFD = directoryFDs[path], fstat(directoryFD, &held) == 0,
                  fstatat(fd, path, &current, AT_SYMLINK_NOFOLLOW) == 0,
                  Self.same(original, current, contents: false, links: false), Self.same(current, held, contents: false, links: false) else { throw Failure.changed }
        }
        let remaining = Set(files.keys).union(directories.keys).union(runtime.keys).subtracting(deleted)
        let names = Set(try FileManager.default.subpathsOfDirectory(atPath: directory))
        let allowed = allowRunningNames ? remaining.union(["api.sock"]) : remaining
        guard names.isSubset(of: allowed), remaining.subtracting(runtime.keys).isSubset(of: names) else { throw Failure.conflict }
        for path in deleted { var current = stat(); guard fstatat(fd, path, &current, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else { throw Failure.changed } }
    }
    private func verify() throws {
        guard prepared else { throw Failure.changed }; try rootLive()
        let running: RelayTunOwnedChild?
        if let child, case .running = try child.observe() { running = child } else { running = nil }
        try validateNames(allowRunningNames: running != nil)
        for (path, record) in files { try verifyFile(path, record) }
        try runtimeFiles(running: running); try rootLive(); try validateNames(allowRunningNames: running != nil)
    }
    private func cleanup() throws {
        if removed { var info = stat(); guard lstat(directory, &info) == -1, errno == ENOENT else { throw Failure.changed }; return }
        if let child { guard case .exited = try child.observe() else { throw Failure.busy } }
        try rootLive(); try validateNames()
        for (path, record) in files where !deleted.contains(path) { try verifyFile(path, record, contents: true) }
        try runtimeFiles(running: nil)
        for path in Set(files.keys).union(runtime.keys).subtracting(deleted).sorted() {
            try rootLive(); try validateNames()
            if let record = files[path] { try verifyFile(path, record) }
            else if let original = runtime[path] {
                var current = stat()
                if fstatat(fd, path, &current, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT { deleted.insert(path); continue }
                guard Self.same(original, current, contents: false) else { throw Failure.changed }
            }
            let parent = files[path]?.parent ?? fd, name = files[path]?.name ?? path
            guard unlinkat(parent, name, 0) == 0 else { throw Failure.changed }; deleted.insert(path)
        }
        for path in directories.keys.sorted(by: { $0.count > $1.count }) where !deleted.contains(path) {
            try rootLive(); try validateNames()
            guard unlinkat(fd, path, AT_REMOVEDIR) == 0 else { throw Failure.changed }; deleted.insert(path)
        }
        try rootLive(); try validateNames()
        guard rmdir(directory) == 0 else { throw Failure.changed }; removed = true
    }
    #if RELAY_TUN_APP_BUNDLE_TESTS
    static func testWorkspace(projection: Probe.Projection, core: Data) throws -> Probe.Workspace {
        try Self(projection: projection, corePin: Probe.corePin, source: { core }).workspace
    }
    #endif
}
