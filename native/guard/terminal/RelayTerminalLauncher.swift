import Darwin
import Foundation

/// Runs only after the entry point authenticates Apple Terminal, the target,
/// and the Main lease. This layer verifies the foreground job independently.
enum RelayTerminalLauncher {
    struct Foreground: Equatable {
        fileprivate let group: pid_t
        fileprivate let session: pid_t
        fileprivate let device: dev_t
        fileprivate let inode: ino_t
        fileprivate let terminal: dev_t
    }

    enum Failure: Error {
        case foregroundRequired
        case invalidLaunch
        case invalidLease
        case leaseRevoked
        case systemCall(String, Int32)
    }

    private static let stdio: [Int32] = [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO]
    private static let sandboxExecutable = "/usr/bin/sandbox-exec"

    static func captureForeground() throws -> Foreground {
        let group = getpgrp(), session = getsid(0)
        guard group > 0, session > 0, getuid() != 0, getuid() == geteuid() else {
            throw Failure.foregroundRequired
        }
        let terminals = try stdio.map { descriptor in
            var info = stat()
            guard isatty(descriptor) == 1, fstat(descriptor, &info) == 0,
                  info.st_mode & S_IFMT == S_IFCHR,
                  tcgetpgrp(descriptor) == group, tcgetsid(descriptor) == session else {
                throw Failure.foregroundRequired
            }
            return Foreground(group: group, session: session, device: info.st_dev,
                              inode: info.st_ino, terminal: info.st_rdev)
        }
        guard terminals[0] == terminals[1], terminals[0] == terminals[2] else {
            throw Failure.foregroundRequired
        }
        return terminals[0]
    }

    /// The entry point retains the authenticated stream until this returns.
    /// After the grant, any readability on it is a revocation, including EOF.
    static func run(foreground: Foreground, executable: String, arguments: [String],
                    environment: [String: String], workingDirectory: String,
                    profile: String, leaseFD: Int32) throws -> Int32 {
        guard executable.hasPrefix("/"), workingDirectory.hasPrefix("/"), !profile.isEmpty,
              environment.keys.allSatisfy({ key in
                  !key.isEmpty && !key.contains("=") && !key.hasPrefix("DYLD_") && !key.hasPrefix("LD_")
              }) else { throw Failure.invalidLaunch }
        let argv = [sandboxExecutable, "-p", profile, executable] + arguments
        let envp = environment.map { "\($0.key)=\($0.value)" }.sorted()
        let strings = argv + envp + [workingDirectory]
        guard strings.count <= 2048,
              strings.allSatisfy({ !$0.utf8.contains(0) }),
              strings.reduce(0, { $0 + $1.utf8.count + 1 }) <= 128 * 1024 else {
            throw Failure.invalidLaunch
        }
        try validateLease(leaseFD)

        let directory = open(workingDirectory, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY)
        guard directory >= 3 else { throw Failure.systemCall("open directory", errno) }
        defer { close(directory) }

        let queue = kqueue()
        guard queue >= 3 else { throw Failure.systemCall("kqueue", errno) }
        defer { close(queue) }
        guard fcntl(queue, F_SETFD, FD_CLOEXEC) == 0 else {
            throw Failure.systemCall("kqueue CLOEXEC", errno)
        }
        let changes = [event(leaseFD, EVFILT_READ), event(SIGCHLD, EVFILT_SIGNAL),
                       event(SIGHUP, EVFILT_SIGNAL), event(SIGTERM, EVFILT_SIGNAL)]
        let registered = changes.withUnsafeBufferPointer {
            kevent(queue, $0.baseAddress, Int32($0.count), nil, 0, nil)
        }
        guard registered == 0 else { throw Failure.systemCall("register supervisor", errno) }

        // The child receives the actual terminal group signals. Mirror a
        // confirmed child stop so the shell's direct job also stops.
        let ignored = [SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU, SIGHUP, SIGTERM]
        var previous: [(Int32, sigaction)] = []
        defer {
            for (number, var action) in previous.reversed() { _ = sigaction(number, &action, nil) }
        }
        for number in ignored + [SIGCHLD] {
            var old = sigaction(), action = sigaction()
            action.__sigaction_u.__sa_handler = number == SIGCHLD ? SIG_DFL : SIG_IGN
            sigemptyset(&action.sa_mask)
            guard sigaction(number, &action, &old) == 0 else {
                throw Failure.systemCall("install supervisor signal", errno)
            }
            previous.append((number, old))
        }

        let pending = try nextEvent(queue, blocking: false)
        guard pending == nil else { throw Failure.leaseRevoked }
        guard try captureForeground() == foreground else { throw Failure.foregroundRequired }

        let pid = try spawn(argv, envp, directory: directory)
        var childOwned = true
        defer {
            if childOwned {
                // Tell Main to revoke the grant before waiting for a child
                // whose exit could be delayed. The caller still owns close.
                _ = shutdown(leaseFD, SHUT_RDWR)
                terminateAndReap(pid)
            }
        }
        while let ready = try nextEvent(queue, blocking: true) {
            if ready.filter == EVFILT_READ { throw Failure.leaseRevoked }
            if ready.ident == UInt(SIGHUP) || ready.ident == UInt(SIGTERM) {
                return 128 + Int32(ready.ident)
            }
            var status: Int32 = 0
            var stopped = false
            while true {
                let result = waitpid(pid, &status, WNOHANG | WUNTRACED | WCONTINUED)
                if result < 0 && errno == EINTR { continue }
                if result < 0 {
                    let failure = errno
                    if failure == ECHILD { childOwned = false }
                    throw Failure.systemCall("waitpid", failure)
                }
                if result == 0 { break }
                if (status & 0x7f) != 0x7f {
                    childOwned = false
                    let terminatingSignal = status & 0x7f
                    return terminatingSignal == 0 ? (status >> 8) & 0xff : 128 + terminatingSignal
                }
                stopped = ((status >> 8) & 0xff) != SIGCONT
            }
            if stopped, kill(getpid(), SIGSTOP) != 0 {
                throw Failure.systemCall("suspend supervisor", errno)
            }
        }
        throw Failure.leaseRevoked
    }

    private static func validateLease(_ descriptor: Int32) throws {
        let flags = descriptor >= 3 ? fcntl(descriptor, F_GETFD) : -1
        var type: Int32 = 0
        var typeSize = socklen_t(MemoryLayout<Int32>.size)
        guard flags >= 0, flags & FD_CLOEXEC != 0,
              getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &typeSize) == 0, type == SOCK_STREAM else {
            throw Failure.invalidLease
        }
        var address = sockaddr_storage()
        var size = socklen_t(MemoryLayout<sockaddr_storage>.size)
        let connected = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getpeername(descriptor, $0, &size) }
        }
        if connected != 0 && errno == ENOTCONN { throw Failure.leaseRevoked }
        guard connected == 0, address.ss_family == AF_UNIX else { throw Failure.invalidLease }
    }

    private static func event(_ value: Int32, _ filter: Int32) -> kevent {
        kevent(ident: UInt(value), filter: Int16(filter), flags: UInt16(EV_ADD | EV_ENABLE),
               fflags: 0, data: 0, udata: nil)
    }

    private static func nextEvent(_ queue: Int32, blocking: Bool) throws -> kevent? {
        while true {
            var output = kevent()
            var timeout = timespec()
            let result = blocking ? kevent(queue, nil, 0, &output, 1, nil)
                : kevent(queue, nil, 0, &output, 1, &timeout)
            if result < 0 && errno == EINTR { continue }
            guard result >= 0 else { throw Failure.systemCall("supervisor events", errno) }
            if result == 0 { return nil }
            guard output.flags & UInt16(EV_ERROR) == 0 else {
                throw Failure.systemCall("supervisor event", Int32(clamping: output.data))
            }
            return output
        }
    }

    private static func spawn(_ argv: [String], _ envp: [String], directory: Int32) throws -> pid_t {
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        try checked(posix_spawn_file_actions_init(&actions), "spawn actions")
        defer { posix_spawn_file_actions_destroy(&actions) }
        try checked(posix_spawnattr_init(&attributes), "spawn attributes")
        defer { posix_spawnattr_destroy(&attributes) }

        var mask = sigset_t(), defaults = sigset_t()
        sigemptyset(&mask)
        sigfillset(&defaults)
        sigdelset(&defaults, SIGKILL)
        sigdelset(&defaults, SIGSTOP)
        let flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_RESETIDS |
            POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF
        try checked(posix_spawnattr_setflags(&attributes, Int16(flags)), "spawn flags")
        try checked(posix_spawnattr_setsigmask(&attributes, &mask), "spawn signal mask")
        try checked(posix_spawnattr_setsigdefault(&attributes, &defaults), "spawn signal defaults")
        for descriptor in stdio {
            try checked(posix_spawn_file_actions_addinherit_np(&actions, descriptor), "inherit tty")
        }
        // fchdir runs as a spawn action. It does not mark the directory FD
        // inherited under CLOEXEC_DEFAULT.
        try checked(posix_spawn_file_actions_addfchdir_np(&actions, directory), "spawn directory")
        let arguments = argv.map { strdup($0) }, environment = envp.map { strdup($0) }
        defer {
            for value in arguments + environment { free(value) }
        }
        guard arguments.allSatisfy({ $0 != nil }), environment.allSatisfy({ $0 != nil }) else {
            throw Failure.systemCall("allocate spawn strings", ENOMEM)
        }
        var terminatedArgs = arguments + [nil], terminatedEnv = environment + [nil]
        var pid: pid_t = 0
        try checked(terminatedArgs.withUnsafeMutableBufferPointer { a in
            terminatedEnv.withUnsafeMutableBufferPointer { e in
                posix_spawn(&pid, sandboxExecutable, &actions, &attributes, a.baseAddress!, e.baseAddress!)
            }
        }, "spawn sandbox")
        return pid
    }

    private static func checked(_ result: Int32, _ operation: String) throws {
        guard result == 0 else { throw Failure.systemCall(operation, result) }
    }

    private static func terminateAndReap(_ pid: pid_t) {
        // The single supervisor owns this unreaped child. No signal is ever
        // sent to its group, the shell, or a PID recovered from disk.
        _ = kill(pid, SIGKILL)
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    }
}
