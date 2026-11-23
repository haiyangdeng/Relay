import Foundation
import Darwin
import Security

/// Only a fixed upstream failure is retained. Unknown output, node names,
/// credentials and raw log lines never leave this bounded in-memory scanner.
struct RelayTunCoreStartDiagnosticScanner {
    private static let missingStack = Data("gVisor is not included in this build, rebuild with -tags with_gvisor".utf8)
    private var tail = Data()
    private(set) var code: String?
    var retainedByteCount: Int { tail.count }
    mutating func append(_ bytes: Data) {
        guard code == nil else { return }
        // The pipe reader supplies bounded chunks; keep this primitive bounded
        // as well so large fixture/input fragments cannot grow retained memory.
        for offset in stride(from: 0, to: bytes.count, by: 4096) {
            let combined = tail + bytes.subdata(in: offset..<min(offset + 4096, bytes.count))
            if combined.range(of: Self.missingStack) != nil {
                code = "core.tun.stack.unavailable"; tail.removeAll(); return
            }
            tail = Data(combined.suffix(Self.missingStack.count - 1))
        }
    }
}

/// Drain both output streams independently of startup polling, including after
/// success. A noisy child cannot block on a full pipe or create an unbounded log.
private final class RelayTunCoreStartDiagnostics {
    private let source: DispatchSourceRead
    private let reader: Int32
    private(set) var writer: Int32
    private let lock = NSLock()
    private var scanner = RelayTunCoreStartDiagnosticScanner()
    init() throws {
        var descriptors: [Int32] = [-1, -1]
        guard pipe(&descriptors) == 0 else { throw RelayTunOwnedChild.Failure.launch }
        let output = fcntl(descriptors[1], F_DUPFD_CLOEXEC, 10)
        Darwin.close(descriptors[1])
        guard output >= 0,
              fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) == 0,
              fcntl(descriptors[0], F_SETFL, O_NONBLOCK) == 0 else {
            Darwin.close(descriptors[0]); if output >= 0 { Darwin.close(output) }
            throw RelayTunOwnedChild.Failure.launch
        }
        reader = descriptors[0]; writer = output
        source = DispatchSource.makeReadSource(fileDescriptor: reader, queue: DispatchQueue(label: "relay.tun.core-diagnostics"))
        source.setEventHandler { [weak self] in self?.drain() }
        let input = reader
        source.setCancelHandler { Darwin.close(input) }
        source.resume()
    }
    deinit { closeWriter(); source.cancel() }
    func closeWriter() { if writer >= 0 { Darwin.close(writer); writer = -1 } }
    var code: String? { lock.lock(); defer { lock.unlock() }; return scanner.code }
    private func drain() {
        var buffer = [UInt8](repeating: 0, count: 4096)
        for _ in 0..<16 {
            let count = Darwin.read(reader, &buffer, buffer.count)
            if count > 0 {
                lock.lock(); scanner.append(Data(buffer.prefix(count))); lock.unlock()
            } else if count < 0 && errno == EINTR { continue }
            else {
                if count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK) { source.cancel() }
                return
            }
        }
    }
}

/// An in-memory capability for exactly one successful posix_spawn. It never
/// adopts a stored PID or searches by process name. No JSON/App entry point is
/// provided; the complete fixed-resource/configuration and consent gate must
/// be supplied by the ordinary-UID owning host before spawn.
final class RelayTunOwnedChild {
    enum Failure: Error { case permission, launch, identity, unknown, busy }
    struct Launch {
        let executable: String
        let directory: String
        var resources = false
        var managedEnvironment: [String] {
            ["PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "HOME=" + directory, "TMPDIR=" + directory]
                + (resources ? ["RELAY_LOCAL_GEODATA_V1=1"] : [])
        }
    }
    struct ExecutionLaunch {
        let installation: RelayTunExecutionInstallationV2
        let beforeSpawn: () throws -> Void
    }
    private let pid: pid_t
    private let effectiveUID: uid_t
    private let lock = NSLock()
    private var waitStatus: Int32?
    private var ownershipLost = false
    private var stopping = false
    private var forced = false
    private var diagnostics: RelayTunCoreStartDiagnostics?
    var startupDiagnostic: String? { diagnostics?.code }
    private init(pid: pid_t, effectiveUID: uid_t = getuid()) { self.pid = pid; self.effectiveUID = effectiveUID }

    /// Reuses the exact-child ownership/reaping path. Mihomo receives no TUN
    /// FD: descriptor 3 is only the installation lock, absent from tun config.
    /// Setuid is admitted solely by the separate fixed managed installation.
    static func spawnManaged(launch: Launch, installationLock: Int32,
                             execution: ExecutionLaunch? = nil,
                             verify: () throws -> Void, register: (RelayTunOwnedChild) -> Void) throws -> RelayTunOwnedChild {
        try ordinaryUID()
        guard RelayTunManagedInstallation.cores.values.contains(launch.executable),
              (launch.directory + "/api.sock").utf8.count < 100 else { throw Failure.launch }
        if let authority = execution {
            let execution = authority.installation
            let fresh = try RelayTunExecutionInstallationV2.load()
            guard fresh.revision == execution.revision, fresh.core == execution.core,
                  fresh.profile == execution.profile, launch.executable == fresh.executable,
                  launch.resources == (fresh.profile == .localGeodata) else { throw Failure.launch }
        } else {
            try RelayTunManagedInstallation.load().validateLaunch(resources: launch.resources)
        }
        let directory = try privateDirectory(launch.directory)
        try verify()
        let diagnostics = try RelayTunCoreStartDiagnostics()
        defer { diagnostics.closeWriter() }
        return try withManagedActions(installationLock: installationLock, directory: launch.directory, diagnostics: diagnostics) { actions, attributes in
            try sameDirectory(launch.directory, directory); try verify(); try sameDirectory(launch.directory, directory)
            let arguments = [launch.executable, "-d", launch.directory, "-f", launch.directory + "/config.yaml",
                             "-ext-ctl-unix", launch.directory + "/api.sock"]
            let child = try spawnOwned(executable: launch.executable, arguments: arguments, environment: launch.managedEnvironment + ["RELAY_MANAGED_TUN_HANDOFF=1"],
                actions: &actions, attributes: &attributes, effectiveUID: 0, beforeSpawn: execution?.beforeSpawn)
            child.diagnostics = diagnostics
            register(child)
            try child.verifyIdentity()
            return child
        }
    }

    /// The same descriptor mapping is exercised by the inert child fixture.
    private static func withManagedActions<T>(installationLock: Int32, directory: String,
        diagnostics: RelayTunCoreStartDiagnostics? = nil,
        body: (inout posix_spawn_file_actions_t?, inout posix_spawnattr_t?) throws -> T) throws -> T {
        let retained = fcntl(installationLock, F_DUPFD_CLOEXEC, 10)
        guard retained >= 0 else { throw Failure.launch }; defer { Darwin.close(retained) }
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw Failure.launch }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw Failure.launch }
        defer { posix_spawnattr_destroy(&attributes) }
        var mask = sigset_t(), defaults = sigset_t()
        sigemptyset(&mask); sigemptyset(&defaults)
        for signal in [SIGINT, SIGTERM, SIGPIPE] { sigaddset(&defaults, signal) }
        let flags = Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)
        guard posix_spawnattr_setflags(&attributes, flags) == 0,
              posix_spawnattr_setsigmask(&attributes, &mask) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaults) == 0 else { throw Failure.launch }
        for fd: Int32 in [0, 1, 2] {
            if fd != 0, let diagnostics {
                guard posix_spawn_file_actions_adddup2(&actions, diagnostics.writer, fd) == 0 else { throw Failure.launch }
            } else {
                guard posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0) == 0 else { throw Failure.launch }
            }
        }
        guard posix_spawn_file_actions_adddup2(&actions, retained, 3) == 0,
              posix_spawn_file_actions_addclose(&actions, retained) == 0,
              posix_spawn_file_actions_addchdir_np(&actions, directory) == 0 else { throw Failure.launch }
        return try body(&actions, &attributes)
    }

    private static func ordinaryUID() throws {
        guard getuid() > 0, geteuid() == getuid(), getegid() == getgid() else { throw Failure.permission }
    }
    private static func privateDirectory(_ path: String) throws -> stat {
        guard path.hasPrefix("/"), !path.contains("\0"),
              let physical = realpath(path, nil) else { throw Failure.launch }
        defer { free(physical) }
        guard String(cString: physical) == path else { throw Failure.launch }
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: path))
        var info = stat()
        guard lstat(path, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else { throw Failure.launch }
        return info
    }
    private static func sameDirectory(_ path: String, _ original: stat) throws {
        let info = try privateDirectory(path)
        guard original.st_dev == info.st_dev, original.st_ino == info.st_ino else { throw Failure.identity }
    }

    /// Native-private inert provider checker. The caller binds expectedCore to
    /// the compiled installation pin and supplies the complete no-TUN config /
    /// asset / authorization check. Only an ordinary-owned executable copy is
    /// admitted; the installed setuid executable is never launched here.
    static func spawnProviderProbe(directory: String, expectedCoreSHA256: String, expectedCoreBytes: Int,
                                   verify: () throws -> Void,
                                   register: (RelayTunOwnedChild) -> Void) throws -> RelayTunOwnedChild {
        try ordinaryUID()
        let prefix = "/private/tmp/relay-provider-probe-\(getuid())-"
        let suffix = directory.dropFirst(prefix.count)
        guard directory.hasPrefix(prefix), !suffix.isEmpty, suffix.utf8.allSatisfy({
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }), (directory + "/api.sock").utf8.count < 100,
              RelayTunHelperTrust.hex(expectedCoreSHA256, count: 64) != nil,
              expectedCoreBytes > 0, expectedCoreBytes <= 134217728 else { throw Failure.launch }
        let originalDirectory = try privateDirectory(directory)
        let root = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw Failure.launch }; defer { Darwin.close(root) }
        func rootLive() throws {
            try sameDirectory(directory, originalDirectory)
            var current = stat()
            guard fstat(root, &current) == 0, current.st_dev == originalDirectory.st_dev,
                  current.st_ino == originalDirectory.st_ino, current.st_gid == originalDirectory.st_gid,
                  current.st_uid == getuid(), current.st_mode & 0o7777 == 0o700 else { throw Failure.identity }
        }
        try rootLive()
        func openFile(_ name: String, _ mode: mode_t, _ limit: Int) throws -> (Int32, stat) {
            let fd = openat(root, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard fd >= 0 else { throw Failure.launch }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  info.st_mode & 0o7777 == mode, info.st_uid == getuid(), info.st_gid == originalDirectory.st_gid,
                  info.st_nlink == 1, info.st_size > 0, info.st_size <= limit else {
                Darwin.close(fd); throw Failure.identity
            }
            return (fd, info)
        }
        let (core, coreInfo) = try openFile("mihomo-probe", 0o500, expectedCoreBytes)
        defer { Darwin.close(core) }
        guard coreInfo.st_size == expectedCoreBytes else { throw Failure.identity }
        let (config, configInfo) = try openFile("config.yaml", 0o600, 2097152)
        defer { Darwin.close(config) }
        func same(_ a: stat, _ b: stat) -> Bool {
            a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid &&
                a.st_mode == b.st_mode && a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
                a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
                a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
        }
        func fileLive(_ fd: Int32, _ name: String, _ original: stat) throws {
            var held = stat(), linked = stat()
            guard fstat(fd, &held) == 0, fstatat(root, name, &linked, AT_SYMLINK_NOFOLLOW) == 0,
                  same(held, original), same(linked, original) else { throw Failure.identity }
        }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = Darwin.read(core, &buffer, buffer.count)
            if count < 0, errno == EINTR { continue }
            guard count >= 0, bytes.count + count <= expectedCoreBytes else { throw Failure.identity }
            if count == 0 { break }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        guard bytes.count == expectedCoreBytes, RelayTunHelperTrust.digest(bytes) == expectedCoreSHA256 else { throw Failure.identity }
        let executable = directory + "/mihomo-probe"
        var code: SecStaticCode?
        // Asking Security for this architecture also rejects an incompatible
        // Mach-O slice; no custom binary decoder or unsigned fallback is used.
        guard SecStaticCodeCreateWithPathAndAttributes(URL(fileURLWithPath: executable) as CFURL, [],
            [kSecCodeAttributeArchitecture: RelayTunManagedInstallation.architecture] as CFDictionary, &code) == errSecSuccess,
              let code, SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate).union(.noNetworkAccess), nil) == errSecSuccess else { throw Failure.identity }
        try fileLive(core, "mihomo-probe", coreInfo); try fileLive(config, "config.yaml", configInfo)
        let socket = directory + "/api.sock"
        // Safe alphabet above makes this literal unambiguous SBPL. No TCP,
        // other Unix endpoint, outbound allowance or inherited FD is granted.
        let policy = "(version 1)(allow default)(deny network*)" +
            "(allow network-bind (local unix-socket (path \"" + socket + "\")))" +
            "(allow network-inbound (local unix-socket (path \"" + socket + "\")))"
        return try withProbeActions(directory: directory) { actions, attributes in
            try verify()
            // No callback follows the final held-FD / linked-file checks.
            try rootLive(); try fileLive(core, "mihomo-probe", coreInfo); try fileLive(config, "config.yaml", configInfo)
            var previousSocket = stat()
            guard fstatat(root, "api.sock", &previousSocket, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else { throw Failure.identity }
            let child = try spawnOwned(executable: "/usr/bin/sandbox-exec", arguments: ["/usr/bin/sandbox-exec", "-p", policy,
                executable, "-d", directory, "-f", directory + "/config.yaml", "-ext-ctl-unix", socket],
                environment: Launch(executable: executable, directory: directory, resources: true).managedEnvironment,
                actions: &actions, attributes: &attributes)
            register(child)
            try child.verifyIdentity()
            return child
        }
    }

    private static func withProbeActions<T>(directory: String,
        body: (inout posix_spawn_file_actions_t?, inout posix_spawnattr_t?) throws -> T) throws -> T {
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw Failure.launch }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw Failure.launch }
        defer { posix_spawnattr_destroy(&attributes) }
        var mask = sigset_t(), defaults = sigset_t()
        sigemptyset(&mask); sigemptyset(&defaults)
        for signal in [SIGINT, SIGTERM, SIGPIPE] { sigaddset(&defaults, signal) }
        guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_RESETIDS | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)) == 0,
              posix_spawnattr_setsigmask(&attributes, &mask) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
              posix_spawn_file_actions_addchdir_np(&actions, directory) == 0 else { throw Failure.launch }
        for fd: Int32 in [0, 1, 2] {
            guard posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0) == 0 else { throw Failure.launch }
        }
        return try body(&actions, &attributes)
    }

    /// verify must bind the build-time core pin, complete private configuration
    /// and assets, authenticated receipt, current authorization and baseline.
    /// It is run again inside the validated-FD mapping immediately before
    /// spawn. register is mandatory: once a child exists, no later throw may
    /// discard its recovery capability. There is no automatic stop on failure.
    static func spawn(descriptor: RelayTunDescriptor.LiveDescriptor, launch: Launch,
                      verify: () throws -> Void,
                      register: (RelayTunOwnedChild) -> Void) throws -> RelayTunOwnedChild {
        try ordinaryUID()
        guard !launch.resources, launch.executable.hasPrefix("/"), !launch.executable.contains("\0"),
              URL(fileURLWithPath: launch.executable).lastPathComponent == "mihomo",
              URL(fileURLWithPath: launch.executable).standardizedFileURL.path == launch.executable,
              (launch.directory + "/api.sock").utf8.count < 100 else { throw Failure.launch }
        let directory = try privateDirectory(launch.directory)
        try verify()
        return try RelayTunDescriptor.withLiveSpawnActions(descriptor) { actions, attributes in
            try sameDirectory(launch.directory, directory)
            try verify()
            try sameDirectory(launch.directory, directory)
            guard posix_spawn_file_actions_addchdir_np(&actions, launch.directory) == 0 else { throw Failure.launch }
            let arguments = [launch.executable, "-d", launch.directory, "-f", launch.directory + "/config.yaml",
                             "-ext-ctl-unix", launch.directory + "/api.sock"]
            let environment = ["PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "HOME=" + launch.directory, "TMPDIR=" + launch.directory]
            let child = try spawnOwned(executable: launch.executable, arguments: arguments, environment: environment,
                                       actions: &actions, attributes: &attributes)
            register(child)
            try child.verifyIdentity()
            return child
        }
    }

    private static func spawnOwned(executable: String, arguments: [String], environment: [String],
                                   actions: inout posix_spawn_file_actions_t?,
                                   attributes: inout posix_spawnattr_t?, effectiveUID: uid_t = getuid(),
                                   beforeSpawn: (() throws -> Void)? = nil) throws -> RelayTunOwnedChild {
        try ordinaryUID()
        let argv = arguments.map { strdup($0) } + [nil], env = environment.map { strdup($0) } + [nil]
        defer { for pointer in argv + env { if let pointer { free(pointer) } } }
        var pid: pid_t = 0
        let result = try argv.withUnsafeBufferPointer { a in try env.withUnsafeBufferPointer { e in
            try beforeSpawn?()
            return posix_spawn(&pid, executable, &actions, &attributes, a.baseAddress!, e.baseAddress!)
        } }
        guard result == 0, pid > 0 else { throw Failure.launch }
        return RelayTunOwnedChild(pid: pid, effectiveUID: effectiveUID)
    }
    private static func credentials(_ pid: pid_t) throws -> proc_bsdshortinfo {
        // XNU requires matching effective UIDs for PROC_PIDTBSDINFO. An
        // ordinary parent therefore cannot use it for its setuid-root child.
        // SHORTBSDINFO exposes the same credentials without that restriction;
        // ownership still comes exclusively from the unreaped spawn capability.
        var info = proc_bsdshortinfo()
        guard pid > 0,
              proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdshortinfo>.size)) == Int32(MemoryLayout<proc_bsdshortinfo>.size),
              info.pbsi_pid == UInt32(pid) else { throw Failure.identity }
        return info
    }
    private func verifyIdentity() throws {
        lock.lock(); defer { lock.unlock() }
        guard case .running = observeLocked() else { throw Failure.identity }
        let info = try Self.credentials(pid)
        guard info.pbsi_ppid == UInt32(getpid()),
              info.pbsi_uid == effectiveUID, info.pbsi_ruid == getuid(),
              info.pbsi_gid == getgid(), info.pbsi_rgid == getgid() else { throw Failure.identity }
        guard case .running = observeLocked() else { throw Failure.identity }
    }
    private func observeLocked() -> RelayTunCoreProbePlan.ChildState {
        if let waitStatus { return .exited(waitStatus) }
        if ownershipLost { return .unknown }
        for _ in 0..<64 {
            var status: Int32 = 0
            let result = waitpid(pid, &status, WNOHANG)
            if result == pid { waitStatus = status; return .exited(status) }
            if result == 0 { return .running }
            if result < 0, errno == EINTR { continue }
            ownershipLost = true
            return .unknown
        }
        // Interrupted observations give no positive running evidence. Keep
        // ownership but never signal from this unknown observation.
        return .unknown
    }
    func observe() throws -> RelayTunCoreProbePlan.ChildState {
        try Self.ordinaryUID()
        lock.lock(); defer { lock.unlock() }
        return observeLocked()
    }
    /// Executes a readiness read only while this exact child is unreaped, and
    /// rechecks after the read. The reader must authenticate its private Unix
    /// socket and exact fixed-core/configuration response; it receives no PID.
    func whileRunning<T>(_ read: () throws -> T) throws -> T {
        guard case .running = try observe() else { throw Failure.unknown }
        let result = try read()
        guard case .running = try observe() else { throw Failure.unknown }
        return result
    }
    /// Only this unreaped spawn capability supplies a PID. The PCB snapshot is
    /// ordinary-UID read-only; it neither adopts a process nor opens a socket.
    func verifyHTTPListeners(_ ports: [Int], deadline: UInt64) throws {
        try Self.ordinaryUID()
        lock.lock(); defer { lock.unlock() }
        func identity() throws {
            guard !stopping, case .running = observeLocked() else { throw Failure.identity }
            let info = try Self.credentials(pid)
            guard info.pbsi_ppid == UInt32(getpid()), info.pbsi_uid == effectiveUID,
                  info.pbsi_ruid == getuid(), info.pbsi_gid == getgid(), info.pbsi_rgid == getgid() else { throw Failure.identity }
        }
        try identity()
        try RelayTunTCPListener.verifyLive(pid: pid, uid: effectiveUID, ports: ports, deadline: deadline)
        try identity()
    }
    /// Observe the peer of a caller-exclusively-held, already connected private
    /// Unix socket. This makes no connection and sends no request. Credentials
    /// and both kernel peer-PID observations must name this exact unreaped
    /// child with its admitted effective UID; no numeric PID crosses this capability boundary.
    func verifyPeer(socket: Int32) throws {
        try Self.ordinaryUID()
        lock.lock(); defer { lock.unlock() }
        guard socket >= 0, case .running = observeLocked() else { throw Failure.identity }
        var before = stat(), after = stat(), peerUID: uid_t = 0, peerGID: gid_t = 0
        var peerPID: pid_t = 0, effectivePID: pid_t = 0
        var peerLength = socklen_t(MemoryLayout<pid_t>.size), effectiveLength = peerLength
        guard fstat(socket, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
              getpeereid(socket, &peerUID, &peerGID) == 0, peerUID == effectiveUID, peerGID == getgid(),
              getsockopt(socket, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &peerLength) == 0,
              peerLength == MemoryLayout<pid_t>.size, peerPID == pid,
              getsockopt(socket, SOL_LOCAL, LOCAL_PEEREPID, &effectivePID, &effectiveLength) == 0,
              effectiveLength == MemoryLayout<pid_t>.size, effectivePID == pid,
              fstat(socket, &after) == 0, before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              case .running = observeLocked() else { throw Failure.identity }
    }
    private func signalOwned(_ signal: Int32) throws {
        lock.lock(); defer { lock.unlock() }
        switch observeLocked() {
        case .exited: return
        case .unknown: throw Failure.unknown
        case .running:
            // The same lock serializes every wait/reap and signal. A running
            // unreaped child cannot have its PID reused before this signal.
            guard Darwin.kill(pid, signal) == 0 || errno == ESRCH else { throw Failure.unknown }
            if signal == SIGKILL { forced = true }
        }
    }
    /// The caller must first obtain the current explicit stop authorization.
    /// This bounded operation only touches the held child. It never treats
    /// forced/nonzero exit as graceful shutdown or proof of network recovery.
    func stop() throws -> RelayTunCoreProbePlan.Stopped {
        try Self.ordinaryUID()
        lock.lock()
        guard !stopping else { lock.unlock(); throw Failure.busy }
        stopping = true; lock.unlock()
        defer { lock.lock(); stopping = false; lock.unlock() }
        let stopped = try RelayTunCoreProbePlan.stopOwnedChild(.init(wait: { try self.observe() },
            signal: { try self.signalOwned($0) }, now: { DispatchTime.now().uptimeNanoseconds / 1_000_000 },
            pause: { usleep(10000) }))
        lock.lock(); let wasForced = forced || stopped.forced; lock.unlock()
        return .init(waitStatus: stopped.waitStatus, forced: wasForced)
    }

    #if RELAY_TUN_FIXED_CORE_TESTS
    // This entry exists only in the dedicated non-root integration executable.
    // Its exact configuration cannot enable TUN, DNS, providers or IP listeners.
    static func fixedCoreFixtureConfiguration() throws -> Data {
        let value: [String: Any] = [
            "port": 0, "socks-port": 0, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0,
            "allow-lan": false, "bind-address": "127.0.0.1", "mode": "rule", "log-level": "silent", "ipv6": false,
            "external-controller": "", "external-controller-tls": "", "external-ui": "",
            "secret": "relay-offline-fixture", "dns": ["enable": false], "tun": ["enable": false],
            "ntp": ["enable": false], "sniffer": ["enable": false], "geo-auto-update": false,
            "geox-url": ["geoip": "", "geosite": "", "mmdb": "", "asn": ""], "find-process-mode": "off",
            "profile": ["store-selected": false, "store-fake-ip": false],
            "proxies": [Any](), "proxy-groups": [Any](), "proxy-providers": [String: Any](),
            "rule-providers": [String: Any](), "listeners": [Any](), "tunnels": [Any](), "rules": ["MATCH,REJECT"]
        ]
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    static func fixedCoreFixture(executable: String, directory: String, installationLock: Int32,
                                 register: (RelayTunOwnedChild) -> Void) throws -> RelayTunOwnedChild {
        try ordinaryUID()
        let original = try privateDirectory(directory), configuration = try fixedCoreFixtureConfiguration()
        let pin = RelayTunInstallationPaths.fixedCorePins[RelayTunManagedInstallation.architecture]!
        func verify() throws {
            try sameDirectory(directory, original)
            try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: executable))
            var info = stat(), source = stat()
            guard lstat(executable, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  info.st_uid == getuid(), info.st_mode & 0o6000 == 0, info.st_nlink == 1,
                  info.st_size == pin.1, URL(fileURLWithPath: executable).lastPathComponent == "mihomo",
                  RelayTunHelperTrust.digest(try Data(contentsOf: URL(fileURLWithPath: executable))) == pin.0,
                  lstat(directory + "/config.yaml", &source) == 0, source.st_uid == getuid(),
                  source.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), source.st_mode & 0o7777 == 0o600,
                  source.st_nlink == 1, try Data(contentsOf: URL(fileURLWithPath: directory + "/config.yaml")) == configuration else { throw Failure.identity }
        }
        try verify()
        return try withManagedActions(installationLock: installationLock, directory: directory) { actions, attributes in
            try verify()
            let child = try spawnOwned(executable: executable,
                arguments: [executable, "-d", directory, "-f", directory + "/config.yaml", "-ext-ctl-unix", directory + "/api.sock"],
                environment: ["PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "HOME=" + directory, "TMPDIR=" + directory],
                actions: &actions, attributes: &attributes)
            register(child)
            try child.verifyIdentity()
            return child
        }
    }
    #endif

    #if RELAY_TUN_OWNED_CHILD_TESTS
    // Read-only kernel-contract probe, never adopts or signals the supplied PID.
    static func inertCredentials(_ pid: pid_t) throws -> proc_bsdshortinfo {
        try ordinaryUID(); return try credentials(pid)
    }
    func inertVerifyIdentity() throws { try verifyIdentity() }
    /// Test-only fixed self re-exec. It maps no live descriptor and never starts
    /// a core; this branch and all of its parameters are absent from production.
    static func inert(directory: String, mode: String, installationLock: Int32? = nil,
                      identityEffectiveUID: uid_t? = nil, beforeSpawn: (() throws -> Void)? = nil,
                      register: (RelayTunOwnedChild) -> Void,
                      afterRegister: () throws -> Void = {}) throws -> RelayTunOwnedChild {
        try ordinaryUID()
        guard ["wait", "exit", "ignore", "inspect", "peer", "diagnostic"].contains(mode) else { throw Failure.launch }
        _ = try privateDirectory(directory)
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(getpid(), &path, UInt32(path.count)) > 0 else { throw Failure.launch }
        let executable = String(cString: path)
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: executable))
        if let installationLock {
            let diagnostics = try RelayTunCoreStartDiagnostics()
            defer { diagnostics.closeWriter() }
            return try withManagedActions(installationLock: installationLock, directory: directory, diagnostics: diagnostics) { actions, attributes in
                let child = try spawnOwned(executable: executable, arguments: [executable, "--inert-owned-child", mode],
                    environment: ["PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "HOME=" + directory, "TMPDIR=" + directory],
                    actions: &actions, attributes: &attributes, effectiveUID: identityEffectiveUID ?? getuid(), beforeSpawn: beforeSpawn)
                child.diagnostics = diagnostics
                register(child)
                try afterRegister()
                if identityEffectiveUID != nil { try child.verifyIdentity() }
                return child
            }
        }
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw Failure.launch }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw Failure.launch }
        defer { posix_spawnattr_destroy(&attributes) }
        let flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_RESETIDS | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF
        var mask = sigset_t(), defaults = sigset_t()
        sigemptyset(&mask); sigemptyset(&defaults)
        for signal in [SIGINT, SIGTERM, SIGPIPE] { sigaddset(&defaults, signal) }
        guard posix_spawnattr_setflags(&attributes, Int16(flags)) == 0,
              posix_spawnattr_setsigmask(&attributes, &mask) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
              posix_spawn_file_actions_addchdir_np(&actions, directory) == 0 else { throw Failure.launch }
        for fd: Int32 in [0, 1, 2] {
            guard posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0) == 0 else { throw Failure.launch }
        }
        let child = try spawnOwned(executable: executable, arguments: [executable, "--inert-owned-child", mode],
            environment: ["PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "HOME=" + directory, "TMPDIR=" + directory],
            actions: &actions, attributes: &attributes, effectiveUID: identityEffectiveUID ?? getuid(), beforeSpawn: beforeSpawn)
        register(child)
        try afterRegister()
        if identityEffectiveUID != nil { try child.verifyIdentity() }
        return child
    }
    /// Only the fixture can deliberately simulate another reaper. Production
    /// never exposes a raw PID, including for logging/status or test injection.
    func inertExternalReap() throws {
        lock.lock(); defer { lock.unlock() }
        var status: Int32 = 0
        while true {
            let result = waitpid(pid, &status, 0)
            if result == pid { return }
            if result < 0, errno == EINTR { continue }
            throw Failure.unknown
        }
    }
    #endif
}

/// Fixed Darwin24 XSO TLV ABI, reusing Mihomo v1.19.33 pcblist_n and Apple's
/// xnu-11417.140.69 definitions. TCP rawlen204 is padded to208; bare616-byte
/// stride alone is not a LISTEN/ownership proof. No table data leaves here.
enum RelayTunTCPListener {
    enum Failure: Error { case unsupported }
    static let maximum = 4 * 1024 * 1024
    private static func check(_ deadline: UInt64) throws {
        guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.unsupported }
    }
    static func verifyLive(pid: pid_t, uid: uid_t, ports: [Int], deadline: UInt64) throws {
        try check(deadline)
        var system = utsname()
        guard uname(&system) == 0 else { throw Failure.unsupported }
        let releaseCapacity = MemoryLayout.size(ofValue: system.release)
        let release = withUnsafePointer(to: &system.release) {
            $0.withMemoryRebound(to: CChar.self, capacity: releaseCapacity) { String(cString: $0) }
        }
        guard release.hasPrefix("24.") else { throw Failure.unsupported }
        var needed = 0
        guard sysctlbyname("net.inet.tcp.pcblist_n", nil, &needed, nil, 0) == 0,
              needed >= 48, needed <= maximum - 65536 else { throw Failure.unsupported }
        try check(deadline)
        var bytes = Data(count: needed + 65536), actual = bytes.count
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        let success = bytes.withUnsafeMutableBytes { raw in
            sysctlbyname("net.inet.tcp.pcblist_n", raw.baseAddress, &actual, nil, 0) == 0
        }
        guard success, actual <= bytes.count else { throw Failure.unsupported }
        try check(deadline)
        try bytes.withUnsafeBytes { try verify($0, count: actual, pid: pid, uid: uid, ports: ports) }
        try check(deadline)
    }
    static func verify(_ bytes: UnsafeRawBufferPointer, count: Int, pid: pid_t, uid: uid_t, ports: [Int]) throws {
        guard count >= 48, count <= maximum, count <= bytes.count, pid > 0,
              (1...2).contains(ports.count), Set(ports).count == ports.count,
              ports.allSatisfy({ (1024...65535).contains($0) }) else { throw Failure.unsupported }
        func u16(_ index: Int) -> UInt16 { bytes.loadUnaligned(fromByteOffset: index, as: UInt16.self) }
        func u32(_ index: Int) -> UInt32 { bytes.loadUnaligned(fromByteOffset: index, as: UInt32.self) }
        func u64(_ index: Int) -> UInt64 { bytes.loadUnaligned(fromByteOffset: index, as: UInt64.self) }
        guard u32(0) == 24 else { throw Failure.unsupported }
        let declared = u32(4), generation = u64(8), socketGeneration = u64(16)
        var offset = 24, mask: UInt32 = 0, rows: UInt32 = 0
        var inp = 0, socket = 0, tcp = 0, matched = [Int: Int]()
        while offset < count {
            guard count - offset >= 8 else { throw Failure.unsupported }
            let length = Int(u32(offset)), kind = u32(offset + 4)
            if length == 24, count - offset == 24 {
                guard mask == 0, kind == declared, u64(offset + 8) == generation,
                      u64(offset + 16) == socketGeneration, rows > 0, rows <= declared,
                      ports.allSatisfy({ matched[$0] == 1 }) else { throw Failure.unsupported }
                return
            }
            let aligned = (length + 7) & ~7
            guard length >= 8, aligned <= count - offset, kind != 0, kind & (kind - 1) == 0,
                  kind & 63 == kind, mask & kind == 0 else { throw Failure.unsupported }
            switch kind {
            case 16: guard length == 104 else { throw Failure.unsupported }; inp = offset
            case 1: guard length == 104 else { throw Failure.unsupported }; socket = offset
            case 2, 4: guard length == 32 else { throw Failure.unsupported }
            case 8: guard length == 136 else { throw Failure.unsupported }
            case 32: guard length == 204 else { throw Failure.unsupported }; tcp = offset
            default: throw Failure.unsupported
            }
            mask |= kind; offset += aligned
            guard mask == 63 else { continue }
            guard inp > 0, socket > 0, tcp > 0, u64(inp + 28) <= generation,
                  u64(socket + 76) <= socketGeneration, u32(tcp + 36) <= 10 else { throw Failure.unsupported }
            rows += 1
            let localPort = Int(UInt16(bigEndian: u16(inp + 18)))
            let listening = u32(socket + 36) == UInt32(IPPROTO_TCP) && u16(socket + 16) == UInt16(SOCK_STREAM) && u32(tcp + 36) == 1
            if listening, ports.contains(localPort) {
                // Refuse any competing/wildcard/IPv6/foreign listener on the
                // selected port. This first version proves exact127.0.0.1 only.
                let options = u32(socket + 20), effectivePID = u32(socket + 72)
                guard u32(socket + 40) == UInt32(AF_INET), bytes[inp + 44] & 1 == 1,
                      u32(inp + 76) == UInt32(INADDR_LOOPBACK).bigEndian, u16(inp + 16) == 0,
                      options & UInt32(SO_ACCEPTCONN) != 0, options & UInt32(SO_REUSEPORT) == 0,
                      u32(socket + 64) == uid, u32(socket + 68) == UInt32(pid),
                      effectivePID == 0 || effectivePID == UInt32(pid) else { throw Failure.unsupported }
                matched[localPort, default: 0] += 1
            }
            mask = 0; inp = 0; socket = 0; tcp = 0
        }
        throw Failure.unsupported
    }
}
