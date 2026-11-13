import Foundation
import Darwin

/// FD transport only. This module never creates a utun socket/interface,
/// installs a helper, changes routes/DNS, or selects/starts a live core.
enum RelayTunDescriptor {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }
    static func checkPlainPath(_ url: URL) throws {
        var cursor = url
        while cursor.path != "/" {
            var info = stat()
            if lstat(cursor.path, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFLNK) {
                throw Failure("TUN路径包含符号链接。")
            }
            cursor.deleteLastPathComponent()
        }
    }
    final class LiveDescriptor {
        let interface: String
        fileprivate let receipt: RelayTunAcquiredReceipt?
        fileprivate let fd: Int32
        private let lock = NSRecursiveLock()
        private var closeAttempted = false
        private var confirmedClosed = false
        fileprivate init(_ fd: Int32, interface: String, receipt: RelayTunAcquiredReceipt?) { self.fd = fd; self.interface = interface; self.receipt = receipt }
        deinit { if !closeAttempted { Darwin.close(fd) } }
        fileprivate func withHeldDescriptor<T>(_ body: (Int32) throws -> T) throws -> T {
            lock.lock(); defer { lock.unlock() }
            guard !closeAttempted else { throw Failure("本次TUN描述符已关闭或关闭结果未确认。") }
            return try body(fd)
        }
        /// Only close the copy owned by this capability. Never retry an
        /// ambiguous close against a descriptor number the OS could reuse.
        func close() throws {
            lock.lock(); defer { lock.unlock() }
            if closeAttempted {
                guard confirmedClosed else { throw Failure("本次TUN描述符关闭尚未确认。") }
                return
            }
            closeAttempted = true
            guard Darwin.close(fd) == 0 else { throw Failure("本次TUN描述符关闭尚未确认。") }
            confirmedClosed = true
        }
        var closureVerified: Bool {
            lock.lock(); defer { lock.unlock() }; return confirmedClosed
        }
    }

    private static func checked(_ status: Int32, _ stage: String) throws {
        guard status == 0 else { throw Failure("FD宿主阶段 \(stage) 失败，状态码 \(status)。") }
    }
    private static func duplicate(_ source: Int32) throws -> Int32 {
        guard source >= 0 else { throw Failure("FD宿主不接受无效描述符。") }
        let copy = fcntl(source, F_DUPFD_CLOEXEC, 10)
        guard copy >= 10 else { throw Failure("FD宿主无法保留描述符副本。") }
        return copy
    }
    static func validInterfaceName(_ value: String) -> Bool {
        guard value.utf8.count < Int(IFNAMSIZ), value.hasPrefix("utun") else { return false }
        let suffix = String(value.dropFirst(4))
        guard let index = UInt32(suffix), index < UInt32.max else { return false }
        return String(index) == suffix
    }

    static func verifyLive(_ descriptor: LiveDescriptor, receipt: RelayTunAcquiredReceipt) throws {
        try descriptor.withHeldDescriptor { held in
            let observed = try validateLive(held, receipt: receipt)
            try observed.close()
        }
    }

    /// Duplicate before inspecting so a later close of the caller's reference
    /// cannot replace the descriptor we validated. No ordinary file admission.
    static func validateLive(_ source: Int32, expectedInterface: String) throws -> LiveDescriptor {
        try validateLive(source, expectedInterface: expectedInterface, receipt: nil)
    }
    /// The caller separately authenticates the receipt's sender and binds its
    /// plan/deadline. This checks only the ordinary-UID held FD and its identity.
    static func validateLive(_ source: Int32, receipt: RelayTunAcquiredReceipt) throws -> LiveDescriptor {
        try receipt.validate()
        guard getuid() > 0, geteuid() == getuid(), getuid() == receipt.clientUID else {
            throw Failure("TUN交付回执与当前普通用户身份不一致。")
        }
        return try validateLive(source, expectedInterface: receipt.interfaceName, receipt: receipt)
    }
    private static func validateLive(_ source: Int32, expectedInterface: String, receipt: RelayTunAcquiredReceipt?) throws -> LiveDescriptor {
        guard validInterfaceName(expectedInterface) else {
            throw Failure("实际utun接口名称未确认。")
        }
        let fd = try duplicate(source)
        var retained = false
        defer { if !retained { Darwin.close(fd) } }
        var info = stat(), address = sockaddr_ctl(), addressLength = socklen_t(MemoryLayout<sockaddr_ctl>.size)
        guard fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) else {
            throw Failure("实际TUN描述符必须是utun控制套接字。")
        }
        // Darwin kernel-control sockets expose ctl_peeraddr, not pru_sockaddr.
        // Their connected control ID/unit must be read through getpeername.
        let named = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getpeername(fd, $0, &addressLength) }
        }
        guard named == 0, addressLength == MemoryLayout<sockaddr_ctl>.size, address.sc_len == MemoryLayout<sockaddr_ctl>.size,
              address.sc_family == UInt8(AF_SYSTEM), address.ss_sysaddr == UInt16(AF_SYS_CONTROL),
              address.sc_id > 0, address.sc_unit > 0 else { throw Failure("utun控制套接字身份未确认。") }
        // SDK net/if_utun.h: UTUN_OPT_IFNAME=2 at SYSPROTO_CONTROL.
        // getsockopt only observes an already connected FD; it does not connect.
        var name = [CChar](repeating: 0, count: Int(IFNAMSIZ)), length = socklen_t(IFNAMSIZ)
        guard getsockopt(fd, SYSPROTO_CONTROL, UTUN_OPT_IFNAME, &name, &length) == 0,
              length > 1, length <= IFNAMSIZ, name[Int(length) - 1] == 0,
              !name.prefix(Int(length) - 1).contains(0),
              String(bytes: name.prefix(Int(length) - 1).map { UInt8(bitPattern: $0) }, encoding: .utf8) == expectedInterface else {
            throw Failure("已有FD返回的utun接口与已批准接口不一致。")
        }
        guard let number = UInt32(expectedInterface.dropFirst(4)), address.sc_unit == number + 1 else {
            throw Failure("utun名称与控制单元身份不一致。")
        }
        if let receipt {
            guard address.sc_id == receipt.controlID, address.sc_unit == receipt.controlUnit,
                  if_nametoindex(expectedInterface) == receipt.interfaceIndex,
                  UInt64(truncatingIfNeeded: info.st_dev) == receipt.socketDeviceValue,
                  UInt64(info.st_ino) == receipt.socketInodeValue else {
                throw Failure("实际TUN描述符与认证回执的完整设备身份不一致。")
            }
        }
        retained = true
        return LiveDescriptor(fd, interface: expectedInterface, receipt: receipt)
    }

    /// A later fixed-core adapter may use this only after independently binding
    /// a pinned executable, configuration, authenticated helper and user consent.
    /// There is intentionally no path/PID/FD JSON entry point for this operation.
    static func withLiveSpawnActions<T>(_ descriptor: LiveDescriptor, stdout: Int32? = nil,
        _ body: (inout posix_spawn_file_actions_t?, inout posix_spawnattr_t?) throws -> T) throws -> T {
        try descriptor.withHeldDescriptor { held in
            // Re-observe the retained descriptor immediately before mapping it.
            let observation = try descriptor.receipt.map { try validateLive(held, receipt: $0) } ?? validateLive(held, expectedInterface: descriptor.interface)
            return try withMapping(observation.fd, stdout: stdout, body)
        }
    }

    #if RELAY_TUN_OWNED_CHILD_TESTS
    /// A test-only private ordinary file exercises close ownership without a
    /// utun. It can never pass withLiveSpawnActions' live-socket revalidation.
    static func inertClosureDescriptor(_ source: Int32) throws -> LiveDescriptor {
        var info = stat()
        guard getuid() > 0, geteuid() == getuid(), fstat(source, &info) == 0,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_uid == getuid(),
              info.st_nlink == 1, info.st_mode & 0o7777 == 0o600 else { throw Failure("私有关闭夹具无效。") }
        return LiveDescriptor(try duplicate(source), interface: "utun0", receipt: nil)
    }
    #endif

    private static func withMapping<T>(_ source: Int32, stdout: Int32?,
        _ body: (inout posix_spawn_file_actions_t?, inout posix_spawnattr_t?) throws -> T) throws -> T {
        guard getuid() != 0, geteuid() == getuid(), getegid() == getgid() else {
            throw Failure("FD宿主只允许普通用户同一真实及有效身份。")
        }
        let input = try duplicate(source)
        defer { Darwin.close(input) }
        let output = try stdout.map(duplicate)
        defer { if let output { Darwin.close(output) } }
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        try checked(posix_spawn_file_actions_init(&actions), "actions_init")
        defer { posix_spawn_file_actions_destroy(&actions) }
        try checked(posix_spawnattr_init(&attributes), "attributes_init")
        defer { posix_spawnattr_destroy(&attributes) }
        // Darwin spawn.h: only descriptors explicitly mentioned in file actions
        // survive CLOEXEC_DEFAULT. dup2 destinations remain open after exec.
        let flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_RESETIDS | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF
        try checked(posix_spawnattr_setflags(&attributes, Int16(flags)), "flags")
        var mask = sigset_t(), defaults = sigset_t()
        sigemptyset(&mask); sigemptyset(&defaults)
        for signal in [SIGINT, SIGTERM, SIGPIPE] { sigaddset(&defaults, signal) }
        try checked(posix_spawnattr_setsigmask(&attributes, &mask), "signal_mask")
        try checked(posix_spawnattr_setsigdefault(&attributes, &defaults), "signal_defaults")
        for fd: Int32 in [0, 1, 2] {
            try checked(posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0), "null_stdio")
        }
        try checked(posix_spawn_file_actions_adddup2(&actions, input, 3), "map_fd3")
        try checked(posix_spawn_file_actions_addclose(&actions, input), "close_input_copy")
        if let output {
            try checked(posix_spawn_file_actions_adddup2(&actions, output, 1), "map_stdout")
            try checked(posix_spawn_file_actions_addclose(&actions, output), "close_output_copy")
        }
        return try body(&actions, &attributes)
    }

    struct FixtureResult {
        let pid: pid_t
        let waitStatus: Int32
        let output: Data
    }
    private static func wait(_ pid: pid_t, milliseconds: Int) throws -> Int32? {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(milliseconds) * 1_000_000
        repeat {
            var status: Int32 = 0
            let value = waitpid(pid, &status, WNOHANG)
            if value == pid { return status }
            if value < 0, errno != EINTR { throw Failure("惰性子进程回收未确认。") }
            usleep(1000)
        } while DispatchTime.now().uptimeNanoseconds < deadline
        return nil
    }
    private static func cleanFixture(_ pid: pid_t) {
        // Only a PID returned by this call's successful spawn reaches here.
        // Check own unreaped-child status before each signal; never adopt a PID.
        var status: Int32 = 0
        guard waitpid(pid, &status, WNOHANG) == 0 else { return }
        _ = Darwin.kill(pid, SIGTERM)
        if (try? wait(pid, milliseconds: 500)) != nil { return }
        guard waitpid(pid, &status, WNOHANG) == 0 else { return }
        _ = Darwin.kill(pid, SIGKILL)
        repeat {
            let value = waitpid(pid, &status, 0)
            if value == pid || (value < 0 && errno != EINTR) { return }
        } while true
    }

    /// Restricted regular-file fixture. It can only re-exec this native binary
    /// into its inert test branch, with sanitized environment and no live core.
    static func inertFixture(_ source: Int32, nonce: String, exitEarly: Bool = false,
        failSpawn: Bool = false, afterSpawn: (pid_t) throws -> Void = { _ in }) throws -> FixtureResult {
        guard nonce.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
            throw Failure("惰性FD夹具标识无效。")
        }
        var original = stat()
        guard fstat(source, &original) == 0, original.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              original.st_uid == getuid(), original.st_mode & 0o7777 == 0o600,
              original.st_nlink == 1, original.st_size > 0, original.st_size <= 4096 else {
            throw Failure("惰性FD夹具只接受当前用户的私有普通文件。")
        }
        // proc_info.h's PROC_PIDPATHINFO_MAXSIZE is (4 * MAXPATHLEN), an
        // expression macro not imported by Swift.
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(getpid(), &path, UInt32(path.count)) > 0 else { throw Failure("本次惰性宿主路径未确认。") }
        let executable = String(cString: path), url = URL(fileURLWithPath: executable)
        try checkPlainPath(url)
        var binary = stat()
        guard lstat(executable, &binary) == 0, binary.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              binary.st_mode & 0o7022 == 0, binary.st_mode & 0o111 != 0,
              [0, getuid()].contains(binary.st_uid), binary.st_nlink == 1 else {
            throw Failure("惰性宿主资源类型或权限无效。")
        }
        var descriptors = [Int32](repeating: -1, count: 2)
        guard pipe(&descriptors) == 0 else { throw Failure("惰性夹具回执管道不可用。") }
        defer { for fd in descriptors where fd >= 0 { Darwin.close(fd) } }
        guard descriptors.allSatisfy({ fcntl($0, F_SETFD, FD_CLOEXEC) == 0 }) else {
            throw Failure("惰性夹具回执描述符不可隔离。")
        }
        var pid: pid_t = 0, reaped = false
        defer { if pid > 0, !reaped { cleanFixture(pid) } }
        try withMapping(source, stdout: descriptors[1]) { actions, attributes in
            let arguments = [executable, "--tun-descriptor-fixture"],
                environment = ["RELAY_TUN_DESCRIPTOR_NONCE=\(nonce)", "RELAY_TUN_DESCRIPTOR_UID=\(getuid())", "RELAY_TUN_DESCRIPTOR_GID=\(getgid())", "RELAY_TUN_DESCRIPTOR_EXIT=\(exitEarly ? "1" : "0")"]
            let argv = arguments.map { strdup($0) } + [nil], env = environment.map { strdup($0) } + [nil]
            defer { for pointer in argv + env { if let pointer { free(pointer) } } }
            let status = argv.withUnsafeBufferPointer { a in
                env.withUnsafeBufferPointer { e in
                    posix_spawn(&pid, failSpawn ? executable + "/missing-inert-fixture" : executable, &actions, &attributes, a.baseAddress!, e.baseAddress!)
                }
            }
            try checked(status, "inert_spawn")
            guard pid > 0 else { throw Failure("惰性子进程身份未确认。") }
        }
        Darwin.close(descriptors[1]); descriptors[1] = -1
        // withMapping's parent-owned duplicate has already closed here.
        try afterSpawn(pid)
        guard let status = try wait(pid, milliseconds: 4000) else { throw Failure("惰性FD夹具等待超时。") }
        reaped = true
        var bytes = [UInt8](repeating: 0, count: 4097), count: Int
        repeat { count = Darwin.read(descriptors[0], &bytes, bytes.count) } while count < 0 && errno == EINTR
        guard count >= 0, count <= 4096 else { throw Failure("惰性FD夹具回执无效。") }
        return FixtureResult(pid: pid, waitStatus: status, output: Data(bytes.prefix(count)))
    }
}
