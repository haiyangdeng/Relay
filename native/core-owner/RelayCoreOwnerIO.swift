import Foundation
import Darwin

// Same bounded poll/read/write discipline as the existing TUN Unix read lane.
enum CoreOwnerIO {
    static func wait(_ fd: Int32, events: Int16, deadline: UInt64) throws {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { throw CoreOwnerFailure.deadline }
            var descriptor = pollfd(fd: fd, events: events, revents: 0)
            let remaining = Int32(min(1000, max(1, (deadline - now) / 1_000_000)))
            let result = Darwin.poll(&descriptor, 1, remaining)
            if result < 0 && errno == EINTR { continue }
            guard result >= 0 else { throw CoreOwnerFailure.control }
            if result > 0 {
                guard descriptor.revents & Int16(POLLERR | POLLNVAL) == 0,
                      descriptor.revents & events != 0 || descriptor.revents & Int16(POLLHUP) != 0 else { throw CoreOwnerFailure.control }
                return
            }
        }
    }
    static func configure(_ fd: Int32) throws {
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0,
              fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw CoreOwnerFailure.control }
        var yes: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw CoreOwnerFailure.control }
    }
    static func write(_ bytes: Data, to fd: Int32, deadline: UInt64) throws {
        var offset = 0
        while offset < bytes.count {
            try wait(fd, events: Int16(POLLOUT), deadline: deadline)
            let written = bytes.withUnsafeBytes { raw in Darwin.write(fd, raw.baseAddress!.advanced(by: offset), bytes.count - offset) }
            if written < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            guard written > 0 else { throw CoreOwnerFailure.control }; offset += written
        }
    }
    static func frame(_ fd: Int32, maximum: Int, idle: Bool = false, shouldExit: (() -> Bool)? = nil) throws -> Data? {
        // A terminal owner may be waiting on its old still-open stdin while a
        // worker confirms release. Observe only that already-safe terminal
        // fact; an empty idle pipe itself never proves Main death or stops Core.
        var bytes = Data(), deadline = DispatchTime.now().uptimeNanoseconds + 30_000_000_000
        while true {
            if idle && bytes.isEmpty {
                if shouldExit?() == true { return nil }
                let interval: UInt64 = shouldExit == nil ? 30_000_000_000 : 1_000_000_000
                do { try wait(fd, events: Int16(POLLIN), deadline: DispatchTime.now().uptimeNanoseconds + interval) }
                catch CoreOwnerFailure.deadline { continue }
            } else { try wait(fd, events: Int16(POLLIN), deadline: deadline) }
            var byte: UInt8 = 0
            let count = Darwin.read(fd, &byte, 1)
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            if count == 0 { guard bytes.isEmpty else { throw CoreOwnerFailure.control }; return nil }
            guard count == 1 else { throw CoreOwnerFailure.control }
            if byte == 10 { guard !bytes.isEmpty else { throw CoreOwnerFailure.invalid }; return bytes }
            // The first byte gets a fresh full30s partial-frame budget, never
            // the remainder of the <=1s terminal-observation poll interval.
            if idle && bytes.isEmpty { deadline = DispatchTime.now().uptimeNanoseconds + 30_000_000_000 }
            bytes.append(byte); guard bytes.count <= maximum else { throw CoreOwnerFailure.invalid }
        }
    }
    static func reply(_ value: [String: Any], to fd: Int32) throws {
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= 65536 else { throw CoreOwnerFailure.invalid }
        try write(bytes + Data([10]), to: fd, deadline: DispatchTime.now().uptimeNanoseconds + 5_000_000_000)
    }
    static func address(_ path: String) throws -> sockaddr_un {
        guard !path.contains("\0"), path.utf8.count <= 103 else { throw CoreOwnerFailure.invalid }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.initializeMemory(as: UInt8.self, repeating: 0)
            path.utf8.withContiguousStorageIfAvailable { bytes in raw.copyMemory(from: UnsafeRawBufferPointer(bytes)) }
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return address
    }
    static func connect(_ path: String) throws -> Int32 {
        var address = try self.address(path)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw CoreOwnerFailure.control }
        do {
            try configure(fd)
            let result = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            guard result == 0 || errno == EINPROGRESS else { throw CoreOwnerFailure.control }
            if result != 0 { try wait(fd, events: Int16(POLLOUT), deadline: DispatchTime.now().uptimeNanoseconds + 5_000_000_000) }
            var error: Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0, error == 0 else { throw CoreOwnerFailure.control }
            return fd
        } catch { Darwin.close(fd); throw error }
    }
    static func listener(_ path: String) throws -> Int32 {
        let url = URL(fileURLWithPath: path), name = url.lastPathComponent
        let parent = try CoreOwnerDirectory(url.deletingLastPathComponent().path)
        try parent.privateParent(); try CoreOwnerDirectory.name(name)
        var existing = stat()
        guard fstatat(parent.fd, name, &existing, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw CoreOwnerFailure.record }
        var address = try self.address(name)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw CoreOwnerFailure.control }
        // Listener creation runs once before dispatch/child creation. Relative
        // bind under a held cwd prevents ancestor replacement from creating or
        // chmodding a foreign absolute-path socket. Restore cwd before serve.
        let cwd = Darwin.open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard cwd >= 0 else { Darwin.close(fd); throw CoreOwnerFailure.control }
        defer { Darwin.close(cwd) }
        do {
            try configure(fd); try parent.verify()
            guard fchdir(parent.fd) == 0 else { throw CoreOwnerFailure.control }
            let result = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            let restored = fchdir(cwd)
            guard restored == 0, result == 0,
                  fstatat(parent.fd, name, &existing, AT_SYMLINK_NOFOLLOW) == 0,
                  existing.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK), existing.st_uid == getuid(), existing.st_nlink == 1,
                  fchmodat(parent.fd, name, 0o600, AT_SYMLINK_NOFOLLOW) == 0,
                  Darwin.listen(fd, 4) == 0 else { throw CoreOwnerFailure.control }
            var after = stat()
            guard fstatat(parent.fd, name, &after, AT_SYMLINK_NOFOLLOW) == 0,
                  after.st_dev == existing.st_dev, after.st_ino == existing.st_ino, after.st_mode & 0o7777 == 0o600 else { throw CoreOwnerFailure.record }
            try parent.verify(); return fd
        } catch { _ = fchdir(cwd); Darwin.close(fd); throw error }
    }
}
