import Darwin
import Foundation
import Security

// Adapts CoreOwnerIO's bounded, nonblocking AF_UNIX lane. The listener uses a
// verified absolute path and directory-relative file operations in Electron.
enum RelayTerminalLeaseSocket {
    static func configure(_ fd: Int32) throws {
        let flags = fcntl(fd, F_GETFL)
        var yes: Int32 = 1
        guard fd >= 3, flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0,
              fcntl(fd, F_SETFD, FD_CLOEXEC) == 0,
              setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw RelayTerminalLeaseFailure.transport
        }
    }

    static func wait(_ fd: Int32, events: Int16, deadline: UInt64) throws {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw RelayTerminalLeaseFailure.deadline }
            var item = pollfd(fd: fd, events: events, revents: 0)
            let milliseconds = Int32(min(1000, max(1, (deadline - now) / 1_000_000)))
            let count = Darwin.poll(&item, 1, milliseconds)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw RelayTerminalLeaseFailure.transport }
            if count > 0 {
                guard DispatchTime.now().uptimeNanoseconds < deadline else { throw RelayTerminalLeaseFailure.deadline }
                guard item.revents & Int16(POLLERR | POLLNVAL) == 0,
                      item.revents & (events | Int16(POLLHUP)) != 0 else { throw RelayTerminalLeaseFailure.transport }
                return
            }
        }
    }

    static func write(_ data: Data, to fd: Int32, deadline: UInt64) throws {
        var offset = 0
        while offset < data.count {
            try wait(fd, events: Int16(POLLOUT), deadline: deadline)
            let count = data.withUnsafeBytes { bytes in
                Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), data.count - offset)
            }
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard count > 0 else { throw RelayTerminalLeaseFailure.transport }
            offset += count
        }
    }

    static func frame(_ fd: Int32, maximum: Int, deadline: UInt64) throws -> Data {
        var data = Data(), buffer = [UInt8](repeating: 0, count: 1024)
        while true {
            try wait(fd, events: Int16(POLLIN), deadline: deadline)
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard count > 0 else { throw RelayTerminalLeaseFailure.transport }
            let fragment = buffer.prefix(count)
            if let end = fragment.firstIndex(of: 10) {
                guard end == count - 1, data.count + end <= maximum else { throw RelayTerminalLeaseFailure.invalid }
                data.append(contentsOf: fragment.prefix(end))
                return data
            }
            guard data.count + count <= maximum else { throw RelayTerminalLeaseFailure.invalid }
            data.append(contentsOf: fragment)
        }
    }

    private static func address(_ path: String) throws -> sockaddr_un {
        let bytes = Array(path.utf8)
        guard path.hasPrefix("/"), !bytes.contains(0), bytes.count <= 103 else { throw RelayTerminalLeaseFailure.invalid }
        var value = sockaddr_un()
        value.sun_family = sa_family_t(AF_UNIX)
        value.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &value.sun_path) { output in
            bytes.withUnsafeBytes { output.copyMemory(from: $0) }
        }
        return value
    }

    static func connect(_ path: String, deadline: UInt64) throws -> Int32 {
        var address = try address(path)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw RelayTerminalLeaseFailure.transport }
        do {
            try configure(fd)
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard result == 0 || errno == EINPROGRESS else { throw RelayTerminalLeaseFailure.unavailable }
            if result != 0 { try wait(fd, events: Int16(POLLOUT), deadline: deadline) }
            var error: Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0,
                  length == MemoryLayout<Int32>.size, error == 0 else { throw RelayTerminalLeaseFailure.transport }
            return fd
        } catch { Darwin.close(fd); throw error }
    }

    static func bind(_ fd: Int32, to path: String) throws {
        var address = try address(path)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { throw RelayTerminalLeaseFailure.transport }
    }
}

struct RelayTerminalLeaseIdentity: Sendable {
    enum Role { case main, launcher }
    let root: String
    let team: String

    static func local(_ role: Role) throws -> Self {
        guard RelayGuardManagementRelease.terminalCLILaunchSupported, getuid() > 0, getuid() == geteuid(),
              let team = RelayGuardManagementRelease.publisherTeamID,
              team.utf8.count == 10,
              team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }) else {
            throw RelayTerminalLeaseFailure.unavailable
        }
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { throw RelayTerminalLeaseFailure.identity }
        return .init(root: try root(code, role: role, team: team), team: team)
    }

    func peer(_ fd: Int32, role: Role, expected: Data? = nil) throws -> Data {
        let token = try Self.token(fd)
        guard expected == nil || token == expected else { throw RelayTerminalLeaseFailure.identity }
        var code: SecCode?
        let attributes = [kSecGuestAttributeAudit as String: token] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code,
              try Self.root(code, role: role, team: team) == root,
              try Self.token(fd) == token else { throw RelayTerminalLeaseFailure.identity }
        return token
    }

    private static func token(_ fd: Int32) throws -> Data {
        var uid: uid_t = 0, gid: gid_t = 0, token = audit_token_t()
        var length = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0,
              length == MemoryLayout<audit_token_t>.size else { throw RelayTerminalLeaseFailure.identity }
        return withUnsafeBytes(of: &token) { Data($0) }
    }

    private static func root(_ code: SecCode, role: Role, team: String) throws -> String {
        let identifier = role == .main ? RelayGuardContract.applicationID : RelayTerminalLeaseWire.launcherID
        let expression = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
        var requirement: SecRequirement?, staticCode: SecStaticCode?, url: CFURL?
        guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCheckValidity(code, .noNetworkAccess, requirement) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopyPath(staticCode, [], &url) == errSecSuccess, let url else {
            throw RelayTerminalLeaseFailure.identity
        }
        let path = (url as URL).resolvingSymlinksInPath().path
        let app: String
        switch role {
        case .main:
            var information: CFDictionary?
            guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
                  let values = information as? [String: Any], let plist = values[kSecCodeInfoPList as String] as? [String: Any],
                  plist["CFBundleVersion"] as? String == RelayGuardManagementRelease.buildVersion else {
                throw RelayTerminalLeaseFailure.identity
            }
            app = path
        case .launcher:
            let suffix = RelayTerminalLeaseWire.launcherRelativePath
            guard path.hasSuffix(suffix) else { throw RelayTerminalLeaseFailure.identity }
            app = String(path.dropLast(suffix.count))
        }
        guard app.hasPrefix("/"), app.hasSuffix(".app") else { throw RelayTerminalLeaseFailure.identity }
        return app
    }
}

/// Per-user endpoint discovery carries only an opaque socket name. The socket
/// peer's audit token supplies identity, so locator replacement cannot impersonate
/// Main. A new listener uses a new name after a crash.
final class RelayTerminalLeaseEndpoint {
    private static let directory = ".rlt1"
    private static let locator = "active"
    private let temp: Int32
    private let fd: Int32
    private let path: String

    init(create: Bool) throws {
        let size = confstr(_CS_DARWIN_USER_TEMP_DIR, nil, 0)
        guard size > 1, size <= 4096 else { throw RelayTerminalLeaseFailure.unavailable }
        var value = [CChar](repeating: 0, count: size)
        guard confstr(_CS_DARWIN_USER_TEMP_DIR, &value, value.count) == size else {
            throw RelayTerminalLeaseFailure.unavailable
        }
        // Foundation keeps the /var alias on macOS. Darwin realpath provides
        // the physical parent used by the fixed /private/var/folders guard.
        guard let resolved = realpath(String(cString: value), nil) else { throw RelayTerminalLeaseFailure.unavailable }
        defer { free(resolved) }
        guard let temporary = String(validatingCString: resolved), temporary.hasPrefix("/private/var/folders/") else {
            throw RelayTerminalLeaseFailure.unavailable
        }
        let parent = Darwin.open(temporary, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 3 else { if parent >= 0 { Darwin.close(parent) }; throw RelayTerminalLeaseFailure.unavailable }
        var info = stat()
        guard fstat(parent, &info) == 0, Self.privateDirectory(info) else {
            Darwin.close(parent); throw RelayTerminalLeaseFailure.identity
        }
        if create && mkdirat(parent, Self.directory, 0o700) != 0 && errno != EEXIST {
            Darwin.close(parent); throw RelayTerminalLeaseFailure.transport
        }
        let child = openat(parent, Self.directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 3 else {
            if child >= 0 { Darwin.close(child) }
            Darwin.close(parent); throw RelayTerminalLeaseFailure.unavailable
        }
        temp = parent; fd = child; path = temporary + "/" + Self.directory
        try verify()
    }
    deinit { Darwin.close(fd); Darwin.close(temp) }

    private static func privateDirectory(_ value: stat) -> Bool {
        value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) && value.st_uid == getuid() && value.st_mode & 0o7777 == 0o700
    }
    private static func privateFile(_ value: stat, kind: mode_t) -> Bool {
        value.st_mode & mode_t(S_IFMT) == kind && value.st_uid == getuid()
            && value.st_mode & 0o7777 == 0o600 && value.st_nlink == 1
    }
    private static func same(_ left: stat, _ right: stat) -> Bool {
        left.st_dev == right.st_dev && left.st_ino == right.st_ino && left.st_mode == right.st_mode
            && left.st_uid == right.st_uid && left.st_nlink == right.st_nlink
    }
    private func verify() throws {
        var held = stat(), linked = stat(), absolute = stat()
        guard fstat(fd, &held) == 0, Self.privateDirectory(held),
              fstatat(temp, Self.directory, &linked, AT_SYMLINK_NOFOLLOW) == 0, Self.same(held, linked),
              lstat(path, &absolute) == 0, Self.same(held, absolute) else { throw RelayTerminalLeaseFailure.identity }
    }

    private static func nonce() -> String {
        String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(24))
    }
    private func locator() throws -> String {
        try verify()
        let file = openat(fd, Self.locator, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard file >= 3 else {
            if file >= 0 { Darwin.close(file) }
            throw RelayTerminalLeaseFailure.unavailable
        }
        defer { Darwin.close(file) }
        var held = stat(), linked = stat(), bytes = [UInt8](repeating: 0, count: 28)
        guard fstat(file, &held) == 0, Self.privateFile(held, kind: S_IFREG), held.st_size == 27 else {
            throw RelayTerminalLeaseFailure.identity
        }
        let count = bytes.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
        guard count == 27, bytes[26] == 10,
              let name = String(bytes: bytes.prefix(26), encoding: .utf8), name.hasPrefix("s-"),
              RelayTerminalLeaseGrant.hex(String(name.dropFirst(2)), count: 24),
              fstatat(fd, Self.locator, &linked, AT_SYMLINK_NOFOLLOW) == 0, Self.same(held, linked) else {
            throw RelayTerminalLeaseFailure.identity
        }
        try verify()
        return name
    }

    func connect(deadline: UInt64) throws -> Int32 {
        let leaf = try locator()
        var expected = stat(), actual = stat()
        guard fstatat(fd, leaf, &expected, AT_SYMLINK_NOFOLLOW) == 0, Self.privateFile(expected, kind: S_IFSOCK) else {
            throw RelayTerminalLeaseFailure.unavailable
        }
        let socket = try RelayTerminalLeaseSocket.connect(path + "/" + leaf, deadline: deadline)
        do {
            try verify()
            guard fstatat(fd, leaf, &actual, AT_SYMLINK_NOFOLLOW) == 0, Self.same(expected, actual),
                  try locator() == leaf else { throw RelayTerminalLeaseFailure.stale }
            return socket
        } catch { Darwin.close(socket); throw error }
    }

    final class Publication {
        let listener: Int32
        private let endpoint: RelayTerminalLeaseEndpoint
        private let lock: Int32
        private let leaf: String
        private let identity: stat
        fileprivate init(listener: Int32, endpoint: RelayTerminalLeaseEndpoint, lock: Int32, leaf: String, identity: stat) {
            self.listener = listener; self.endpoint = endpoint; self.lock = lock; self.leaf = leaf; self.identity = identity
        }
        // The DispatchSource cancel handler closes listener after cancelling IO.
        deinit { endpoint.remove(leaf, matching: identity); Darwin.close(lock) }
    }

    func publish() throws -> Publication {
        try verify()
        let lock = openat(fd, "lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard lock >= 3 else { if lock >= 0 { Darwin.close(lock) }; throw RelayTerminalLeaseFailure.unavailable }
        var locked = stat(), linked = stat()
        guard fstat(lock, &locked) == 0, Self.privateFile(locked, kind: S_IFREG),
              flock(lock, LOCK_EX | LOCK_NB) == 0,
              fstatat(fd, "lock", &linked, AT_SYMLINK_NOFOLLOW) == 0, Self.same(locked, linked) else {
            Darwin.close(lock); throw RelayTerminalLeaseFailure.busy
        }
        let listener = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { Darwin.close(lock); throw RelayTerminalLeaseFailure.transport }
        let leaf = "s-" + Self.nonce()
        var created: stat?
        do {
            try RelayTerminalLeaseSocket.configure(listener)
            try verify()
            try RelayTerminalLeaseSocket.bind(listener, to: path + "/" + leaf)
            var before = stat(), after = stat()
            guard fstatat(fd, leaf, &before, AT_SYMLINK_NOFOLLOW) == 0, before.st_uid == getuid(),
                  before.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK), before.st_nlink == 1 else {
                throw RelayTerminalLeaseFailure.identity
            }
            created = before
            guard fchmodat(fd, leaf, 0o600, AT_SYMLINK_NOFOLLOW) == 0,
                  fstatat(fd, leaf, &after, AT_SYMLINK_NOFOLLOW) == 0,
                  before.st_dev == after.st_dev, before.st_ino == after.st_ino, Self.privateFile(after, kind: S_IFSOCK) else {
                throw RelayTerminalLeaseFailure.identity
            }
            created = after
            guard Darwin.listen(listener, 4) == 0 else { throw RelayTerminalLeaseFailure.transport }
            try verify()
            try writeLocator(leaf)
            return Publication(listener: listener, endpoint: self, lock: lock, leaf: leaf, identity: after)
        } catch {
            if let created { remove(leaf, matching: created) }
            Darwin.close(listener); Darwin.close(lock)
            throw error
        }
    }

    private func writeLocator(_ leaf: String) throws {
        var existing = stat()
        if fstatat(fd, Self.locator, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
            _ = try locator()
        } else if errno != ENOENT { throw RelayTerminalLeaseFailure.identity }
        let temporary = "p-" + Self.nonce()
        let file = openat(fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
        guard file >= 3 else { if file >= 0 { Darwin.close(file) }; throw RelayTerminalLeaseFailure.transport }
        defer { Darwin.close(file) }
        var held = stat()
        guard fstat(file, &held) == 0, Self.privateFile(held, kind: S_IFREG) else { throw RelayTerminalLeaseFailure.identity }
        do {
            try RelayTerminalLeaseSocket.write(Data((leaf + "\n").utf8), to: file,
                deadline: DispatchTime.now().uptimeNanoseconds + 1_000_000_000)
            try verify()
            var linked = stat()
            guard fstatat(fd, temporary, &linked, AT_SYMLINK_NOFOLLOW) == 0, Self.same(held, linked),
                  renameat(fd, temporary, fd, Self.locator) == 0, try locator() == leaf else {
                throw RelayTerminalLeaseFailure.identity
            }
        } catch { remove(temporary, matching: held); throw error }
    }
    private func remove(_ leaf: String, matching identity: stat) {
        var current = stat()
        if fstatat(fd, leaf, &current, AT_SYMLINK_NOFOLLOW) == 0, Self.same(identity, current) {
            _ = unlinkat(fd, leaf, 0)
        }
    }
}
