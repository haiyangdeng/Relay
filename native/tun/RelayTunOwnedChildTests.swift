import Foundation
import Darwin

private var inertStop: sig_atomic_t = 0
private func inertSignal(_ signal: Int32) { inertStop = signal }
private enum Injected: Error { case failure }

@main struct RelayTunOwnedChildTests {
    private static func unixAddress(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(path.utf8CString).map { UInt8(bitPattern: $0) }
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw Injected.failure }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        return address
    }
    private static func unixCall(_ fd: Int32, _ path: String, bindSocket: Bool) throws -> Int32 {
        var address = try unixAddress(path)
        return withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bindSocket ? bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) : connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        } }
    }
    /// Compiled out of shipping: this signed self-copy accepts only the exact
    /// factory argv and opens its own Unix endpoint, never a Core/TUN/TCP port.
    private static func probeChild(_ args: [String]) -> Never {
        let directory = FileManager.default.currentDirectoryPath
        guard args == ["-d", directory, "-f", directory + "/config.yaml", "-ext-ctl-unix", directory + "/api.sock"],
              URL(fileURLWithPath: CommandLine.arguments[0]).lastPathComponent == "mihomo-probe",
              getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { exit(77) }
        _ = Darwin.signal(SIGTERM, inertSignal)
        let initialFDs = (3...255).filter { fcntl(Int32($0), F_GETFD) >= 0 }
        let listener = socket(AF_UNIX, SOCK_STREAM, 0), outbound = socket(AF_UNIX, SOCK_STREAM, 0), extra = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0, outbound >= 0, extra >= 0 else { exit(36) }
        defer { for fd in [listener, outbound, extra] { Darwin.close(fd) } }
        do {
            guard try unixCall(listener, directory + "/api.sock", bindSocket: true) == 0,
                  listen(listener, 1) == 0 else { exit(37) }
            let outboundResult = try unixCall(outbound, directory + "/sentinel.sock", bindSocket: false), outboundError = errno
            let extraResult = try unixCall(extra, directory + "/extra.sock", bindSocket: true), extraError = errno
            let environment = ProcessInfo.processInfo.environment
            let report: [String: Any] = ["uid": getuid(), "euid": geteuid(), "directory": directory,
                "openFDs": initialFDs, "environment": environment, "arguments": args,
                "outboundDenied": outboundResult == -1 && outboundError == EPERM,
                "otherBindDenied": extraResult == -1 && extraError == EPERM]
            try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]).write(to: URL(fileURLWithPath: directory + "/ready.json"), options: .withoutOverwriting)
            let deadline = DispatchTime.now().uptimeNanoseconds + 8_000_000_000
            while inertStop == 0, DispatchTime.now().uptimeNanoseconds < deadline { usleep(1000) }
            exit(inertStop == SIGTERM ? 0 : 32)
        } catch { exit(38) }
    }
    private static func child(_ mode: String) -> Never {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(),
              ["wait", "exit", "ignore", "inspect", "peer", "diagnostic"].contains(mode) else { exit(77) }
        if mode == "ignore" { _ = Darwin.signal(SIGTERM, SIG_IGN) }
        else { _ = Darwin.signal(SIGTERM, inertSignal) }
        let environment = ProcessInfo.processInfo.environment, directory = FileManager.default.currentDirectoryPath
        if mode == "diagnostic" {
            // Larger than the pipe capacity: a reader that only drains after
            // startup would deadlock before this inert child's ready receipt.
            for _ in 0..<256 { FileHandle.standardOutput.write(Data(repeating: 120, count: 4096)) }
            FileHandle.standardError.write(Data("private-secret-should-not-escape\ngVisor is not included in this build, ".utf8))
            FileHandle.standardError.write(Data("rebuild with -tags with_gvisor\n".utf8))
        }
        if mode == "peer" {
            let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
            guard descriptor >= 0 else { exit(33) }
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            let bytes = Array((directory + "/peer.sock").utf8CString).map { UInt8(bitPattern: $0) }
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { exit(34) }
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
            let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            guard bound == 0, listen(descriptor, 1) == 0 else { exit(35) }
        }
        let report: [String: Any] = ["uid": getuid(), "euid": geteuid(), "gid": getgid(), "egid": getegid(),
            "directory": directory, "home": environment["HOME"] ?? "", "temporary": environment["TMPDIR"] ?? "",
            "inheritedSecret": environment["RELAY_PARENT_PRIVATE"] != nil,
            "injectedLibrary": environment.keys.contains(where: { $0.hasPrefix("DYLD_") }),
            "openFDs": (3...255).filter { fcntl(Int32($0), F_GETFD) >= 0 },
            "actualNetworkConfigurationChanged": false]
        do {
            try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]).write(to: URL(fileURLWithPath: directory + "/ready.json"), options: .withoutOverwriting)
        } catch { exit(31) }
        if mode == "exit" { exit(23) }
        let deadline = DispatchTime.now().uptimeNanoseconds + 8_000_000_000
        while inertStop == 0, DispatchTime.now().uptimeNanoseconds < deadline {
            if FileManager.default.fileExists(atPath: directory + "/release") { exit(0) }
            usleep(1000)
        }
        exit(inertStop == SIGTERM ? 0 : 32)
    }
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        if args.count == 2, args[0] == "--inert-owned-child" { child(args[1]) }
        if args.first == "-d" { probeChild(args) }
        guard args.isEmpty, getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { exit(77) }
        _ = umask(0o077)
        var rows: [[String: Any]] = []
        func check(_ name: String, _ predicate: @autoclosure () throws -> Bool) {
            do { rows.append(["name": name, "passed": try predicate()]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": false]) }
            catch { rows.append(["name": name, "passed": true]) }
        }
        func directory(_ run: (String) throws -> Void) throws {
            var pattern = Array("/private/tmp/relay-owned-XXXXXX".utf8CString)
            guard mkdtemp(&pattern) != nil else { throw Injected.failure }
            let path = String(cString: pattern)
            defer { try? FileManager.default.removeItem(atPath: path) }
            try run(path)
        }
        func ready(_ directory: String) throws -> [String: Any] {
            let start = DispatchTime.now().uptimeNanoseconds
            repeat {
                if let bytes = try? Data(contentsOf: URL(fileURLWithPath: directory + "/ready.json")),
                   let report = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] { return report }
                usleep(1000)
            } while DispatchTime.now().uptimeNanoseconds - start < 2_000_000_000
            throw Injected.failure
        }
        func exited(_ child: RelayTunOwnedChild) throws -> Int32 {
            let start = DispatchTime.now().uptimeNanoseconds
            repeat {
                switch try child.observe() {
                case .running: usleep(1000)
                case .exited(let status): return status
                case .unknown: throw Injected.failure
                }
            } while DispatchTime.now().uptimeNanoseconds - start < 2_000_000_000
            throw Injected.failure
        }
        func descriptors() -> Set<Int32> { Set((0...255).map(Int32.init).filter { fcntl($0, F_GETFD) >= 0 }) }
        var scanner = RelayTunCoreStartDiagnosticScanner()
        scanner.append(Data(repeating: 120, count: 1024 * 1024))
        check("unknown private core output is discarded with bounded retained bytes", scanner.code == nil && scanner.retainedByteCount < 100)
        scanner.append(Data("gVisor is not included in this build, ".utf8))
        scanner.append(Data("rebuild with -tags with_gvisor".utf8))
        check("split fixed upstream stack error maps only to a public diagnostic code", scanner.code == "core.tun.stack.unavailable" && scanner.retainedByteCount == 0)
        func probeDirectory(_ run: (String, String, Int) throws -> Void) throws {
            var pattern = Array("/private/tmp/relay-provider-probe-\(getuid())-XXXXXX".utf8CString)
            guard mkdtemp(&pattern) != nil else { throw Injected.failure }
            let path = String(cString: pattern)
            defer { try? FileManager.default.removeItem(atPath: path) }
            var source = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
            guard proc_pidpath(getpid(), &source, UInt32(source.count)) > 0 else { throw Injected.failure }
            let bytes = try Data(contentsOf: URL(fileURLWithPath: String(cString: source)))
            try bytes.write(to: URL(fileURLWithPath: path + "/mihomo-probe"), options: .withoutOverwriting)
            guard chmod(path + "/mihomo-probe", 0o500) == 0 else { throw Injected.failure }
            try Data("inert-self-fixture-only\n".utf8).write(to: URL(fileURLWithPath: path + "/config.yaml"), options: .withoutOverwriting)
            try run(path, RelayTunHelperTrust.digest(bytes), bytes.count)
        }
        let before = descriptors()
        do {
            // Query launchd without spawning/adopting/signalling it. Unlike
            // same-UID fixtures, this exercises the cross-UID kernel contract.
            let privileged = try RelayTunOwnedChild.inertCredentials(1)
            check("ordinary caller can read privileged process identity through production query", privileged.pbsi_pid == 1 && privileged.pbsi_uid == 0)
            rejects("invalid PID cannot produce credentials") { _ = try RelayTunOwnedChild.inertCredentials(-1) }
            try directory { path in
                let source = open(path + "/close-fixture", O_CREAT | O_EXCL | O_RDWR, 0o600)
                guard source >= 0 else { throw Injected.failure }
                defer { Darwin.close(source) }
                let original = descriptors()
                let owned = try RelayTunDescriptor.inertClosureDescriptor(source)
                check("an admitted descriptor is not reported closed before explicit close", !owned.closureVerified)
                rejects("inert closure fixture cannot enter the live TUN mapping") {
                    try RelayTunDescriptor.withLiveSpawnActions(owned) { _, _ in throw Injected.failure }
                }
                try owned.close()
                check("explicit owned descriptor close has positive closure evidence", owned.closureVerified && descriptors() == original)
                let reused = open(path + "/reused", O_CREAT | O_EXCL | O_RDWR, 0o600)
                guard reused >= 0 else { throw Injected.failure }
                defer { Darwin.close(reused) }
                try owned.close()
                check("repeated close cannot touch a reused descriptor number", fcntl(reused, F_GETFD) >= 0)
                rejects("a closed descriptor cannot create live spawn mappings") {
                    try RelayTunDescriptor.withLiveSpawnActions(owned) { _, _ in throw Injected.failure }
                }
            }
            try directory { path in
                var registered: RelayTunOwnedChild?
                let sentinel = open(path + "/sentinel", O_CREAT | O_EXCL | O_RDWR, 0o600)
                guard sentinel >= 0, fcntl(sentinel, F_SETFD, 0) == 0 else { throw Injected.failure }
                defer { Darwin.close(sentinel) }
                setenv("RELAY_PARENT_PRIVATE", "not-for-child", 1)
                defer { unsetenv("RELAY_PARENT_PRIVATE") }
                let child = try RelayTunOwnedChild.inert(directory: path, mode: "inspect", register: { registered = $0 })
                defer { _ = try? child.stop() }
                let report = try ready(path)
                check("capability is registered before any post-spawn inspection", registered === child)
                check("running observation uses this successful spawn", try child.observe() == .running)
                try child.inertVerifyIdentity()
                check("production identity check confirms the held child's parent and credentials", true)
                check("child real and effective UID remain ordinary", report["uid"] as? UInt32 == getuid() && report["euid"] as? UInt32 == getuid())
                check("child real and effective GID remain unchanged", report["gid"] as? UInt32 == getgid() && report["egid"] as? UInt32 == getgid())
                check("child cwd HOME and TMPDIR use the private directory", report["directory"] as? String == path && report["home"] as? String == path && report["temporary"] as? String == path)
                check("inherited parent credentials and DYLD environment are absent", report["inheritedSecret"] as? Bool == false && report["injectedLibrary"] as? Bool == false)
                check("unrelated parent FDs are not inherited", (report["openFDs"] as? [Int])?.isEmpty == true)
                check("parent sentinel is preserved", fcntl(sentinel, F_GETFD) >= 0)
                check("readiness reader can only run with held running child", try child.whileRunning { true })
                let file = open("/dev/null", O_RDONLY | O_CLOEXEC)
                defer { if file >= 0 { Darwin.close(file) } }
                rejects("ordinary file cannot authenticate a core Unix peer") { try child.verifyPeer(socket: file) }
                rejects("invalid descriptor cannot authenticate a core Unix peer") { try child.verifyPeer(socket: -1) }
                var unrelated = [Int32](repeating: -1, count: 2)
                guard socketpair(AF_UNIX, SOCK_STREAM, 0, &unrelated) == 0 else { throw Injected.failure }
                defer { for descriptor in unrelated { Darwin.close(descriptor) } }
                rejects("same-UID parent socket peer cannot impersonate held child") { try child.verifyPeer(socket: unrelated[0]) }
                let stopped = try child.stop()
                check("explicit TERM reaps only this child gracefully", stopped.waitStatus == 0 && !stopped.forced)
                rejects("identity check cannot accept a reaped child") { try child.inertVerifyIdentity() }
                check("reaped terminal result is cached", try child.observe() == .exited(0) && child.observe() == .exited(0))
                let repeated = try child.stop()
                check("repeated explicit stop uses cached exit and sends no new signal", repeated.waitStatus == 0 && !repeated.forced)
                var invokedAfterExit = false
                rejects("readiness after exit is refused") { _ = try child.whileRunning { invokedAfterExit = true; return true } }
                check("readiness after exit does not invoke reader", !invokedAfterExit)
                rejects("exited child cannot authenticate even a socket peer") { try child.verifyPeer(socket: unrelated[0]) }
            }
            try directory { path in
                let pathToLock = path + "/busy.lock"
                var held = open(pathToLock, O_CREAT | O_EXCL | O_RDONLY | O_CLOEXEC, 0o600)
                guard held >= 0, flock(held, LOCK_EX | LOCK_NB) == 0 else { throw Injected.failure }
                defer { if held >= 0 { Darwin.close(held) } }
                let child = try RelayTunOwnedChild.inert(directory: path, mode: "diagnostic", installationLock: held, register: { _ in })
                defer { _ = try? child.stop() }
                let report = try ready(path)
                check("managed mapping inherits only the installation lock at FD3", report["openFDs"] as? [Int] == [3])
                let diagnosticDeadline = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
                while child.startupDiagnostic == nil && DispatchTime.now().uptimeNanoseconds < diagnosticDeadline { usleep(1000) }
                check("managed output is continuously drained and exposes no private log text", child.startupDiagnostic == "core.tun.stack.unavailable")
                let contender = open(pathToLock, O_RDONLY | O_CLOEXEC)
                guard contender >= 0 else { throw Injected.failure }
                defer { Darwin.close(contender) }
                check("installation lock blocks a separate uninstall owner", flock(contender, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK)
                guard Darwin.close(held) == 0 else { throw Injected.failure }; held = -1
                check("child retains installation lock after parent closes its handle", flock(contender, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK)
                let stopped = try child.stop()
                check("managed mapping child has a positive graceful exit", stopped.waitStatus == 0 && !stopped.forced)
                check("installation lock becomes available only after child exit", flock(contender, LOCK_EX | LOCK_NB) == 0)
            }
            try directory { path in
                let held = open(path + "/busy.lock", O_CREAT | O_EXCL | O_RDONLY | O_CLOEXEC, 0o600)
                guard held >= 0, flock(held, LOCK_EX | LOCK_NB) == 0 else { throw Injected.failure }
                defer { Darwin.close(held) }
                var gates = 0, registrations = 0
                rejects("final spawn gate refusal creates no child capability") {
                    _ = try RelayTunOwnedChild.inert(directory: path, mode: "wait", installationLock: held,
                        beforeSpawn: { gates += 1; throw Injected.failure }, register: { _ in registrations += 1 })
                }
                check("final gate runs once and never registers a refused child", gates == 1 && registrations == 0)
                check("refused spawn leaves original held lock open", fcntl(held, F_GETFD) >= 0)
                check("refused spawn never executes the inert self child", !FileManager.default.fileExists(atPath: path + "/ready.json"))
                let child = try RelayTunOwnedChild.inert(directory: path, mode: "wait", installationLock: held,
                    beforeSpawn: { gates += 1 }, register: { _ in registrations += 1 })
                defer { _ = try? child.stop() }
                _ = try ready(path)
                check("successful final gate admits exactly one held inert child", gates == 2 && registrations == 1)
                let stopped = try child.stop()
                check("gated inert child remains positively reapable", stopped.waitStatus == 0 && !stopped.forced)
            }
            try directory { path in
                var registered: RelayTunOwnedChild?
                rejects("credential mismatch refuses readiness after registering recovery ownership") {
                    _ = try RelayTunOwnedChild.inert(directory: path, mode: "wait", identityEffectiveUID: 0,
                        register: { registered = $0 })
                }
                guard let child = registered else { throw Injected.failure }
                defer { _ = try? child.stop() }
                _ = try ready(path)
                check("identity refusal retains a running owned child for explicit recovery", try child.observe() == .running)
                check("identity refusal does not prevent owned child restoration", try child.stop().waitStatus == 0)
            }
            try directory { path in
                var registered: RelayTunOwnedChild?
                rejects("post-spawn failure propagates without discarding capability") {
                    _ = try RelayTunOwnedChild.inert(directory: path, mode: "wait", register: { registered = $0 }, afterRegister: { throw Injected.failure })
                }
                guard let child = registered else { throw Injected.failure }
                _ = try ready(path)
                check("registered child survives caller postcheck failure", try child.observe() == .running)
                let stopped = try child.stop()
                check("failed launch caller can explicitly recover held child", stopped.waitStatus == 0 && !stopped.forced)
            }
            try directory { path in
                let child = try RelayTunOwnedChild.inert(directory: path, mode: "peer", register: { _ in })
                defer { _ = try? child.stop() }
                _ = try ready(path)
                let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
                guard descriptor >= 0 else { throw Injected.failure }
                defer { Darwin.close(descriptor) }
                var address = sockaddr_un()
                address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
                withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: (path + "/peer.sock").utf8CString.map { UInt8(bitPattern: $0) }) }
                let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
                guard connected == 0 else { throw Injected.failure }
                try child.verifyPeer(socket: descriptor)
                check("kernel Unix peer credentials and both PIDs match the held child", true)
                _ = try child.stop()
                rejects("a connection to an exited child cannot establish readiness") { try child.verifyPeer(socket: descriptor) }
            }
            try directory { path in
                let child = try RelayTunOwnedChild.inert(directory: path, mode: "exit", register: { _ in })
                _ = try ready(path)
                check("early exit preserves real wait status", try exited(child) == 23 << 8)
                let stopped = try child.stop()
                check("already-exited child is not converted to graceful status", stopped.waitStatus == 23 << 8 && !stopped.forced)
                rejects("nonzero exit cannot pass graceful policy") { try RelayTunCoreProbePlan.requireGracefulExit(stopped) }
            }
            try directory { path in
                let child = try RelayTunOwnedChild.inert(directory: path, mode: "ignore", register: { _ in })
                defer { _ = try? child.stop() }
                _ = try ready(path)
                let stopped = try child.stop()
                check("unresponsive own child is rechecked and boundedly escalated", stopped.forced && stopped.waitStatus & 0x7f == SIGKILL)
                check("forced result stays forced across repeat stop", try child.stop().forced)
                rejects("forced own child exit is never graceful proof") { try RelayTunCoreProbePlan.requireGracefulExit(stopped) }
            }
            try directory { path in
                let child = try RelayTunOwnedChild.inert(directory: path, mode: "exit", register: { _ in })
                _ = try ready(path)
                try child.inertExternalReap()
                check("external reaper yields unknown ownership", try child.observe() == .unknown)
                rejects("lost ownership cannot signal a historical PID") { _ = try child.stop() }
                check("unknown ownership remains sticky", try child.observe() == .unknown)
            }
            try directory { path in
                let child = try RelayTunOwnedChild.inert(directory: path, mode: "wait", register: { _ in })
                defer { _ = try? child.stop() }
                _ = try ready(path)
                var invoked = false
                rejects("exit during readiness read invalidates the read result") {
                    _ = try child.whileRunning {
                        invoked = true
                        try Data().write(to: URL(fileURLWithPath: path + "/release"))
                        _ = try exited(child)
                        return true
                    }
                }
                check("readiness race test actually ran reader before exit", invoked)
            }
            try directory { path in
                rejects("fixture rejects arbitrary operation strings before spawn") { _ = try RelayTunOwnedChild.inert(directory: path, mode: "mihomo", register: { _ in }) }
                chmod(path, 0o755)
                rejects("spawn rejects nonprivate cwd before creating child") { _ = try RelayTunOwnedChild.inert(directory: path, mode: "wait", register: { _ in }) }
                chmod(path, 0o700)
                let alias = path + "-alias"
                guard symlink(path, alias) == 0 else { throw Injected.failure }
                defer { unlink(alias) }
                rejects("spawn rejects symlink cwd before creating child") { _ = try RelayTunOwnedChild.inert(directory: alias, mode: "wait", register: { _ in }) }
            }
            try probeDirectory { path, hash, size in
                let sentinel = socket(AF_UNIX, SOCK_STREAM, 0)
                guard sentinel >= 0 else { throw Injected.failure }
                defer { Darwin.close(sentinel) }
                guard try unixCall(sentinel, path + "/sentinel.sock", bindSocket: true) == 0,
                      listen(sentinel, 1) == 0, fcntl(sentinel, F_SETFL, O_NONBLOCK) == 0 else { throw Injected.failure }
                let unrelated = open(path + "/unrelated", O_CREAT | O_EXCL | O_RDWR, 0o600)
                guard unrelated >= 0, fcntl(unrelated, F_SETFD, 0) == 0 else { throw Injected.failure }
                defer { Darwin.close(unrelated) }
                setenv("RELAY_PARENT_PRIVATE", "never-inherit", 1); defer { unsetenv("RELAY_PARENT_PRIVATE") }
                var registered: RelayTunOwnedChild?, verified = false
                defer { if let registered { _ = try? registered.stop() } }
                let child = try RelayTunOwnedChild.spawnProviderProbe(directory: path, expectedCoreSHA256: hash, expectedCoreBytes: size,
                    verify: { verified = true }, register: { registered = $0 })
                let report = try ready(path), environment = report["environment"] as? [String: String]
                check("probe uses registered ordinary-UID capability after mandatory verifier", verified && registered === child && report["uid"] as? UInt32 == getuid() && report["euid"] as? UInt32 == getuid())
                check("probe has no inherited descriptors including installation or TUN", (report["openFDs"] as? [Int])?.isEmpty == true)
                // CoreFoundation adds its own encoding hint after process
                // startup. It is not an input inherited by posix_spawn.
                let launchEnvironment = environment?.filter { $0.key != "__CF_USER_TEXT_ENCODING" }
                check("probe receives fixed inert args and private environment apart from Foundation encoding hint", report["arguments"] as? [String] == ["-d", path, "-f", path + "/config.yaml", "-ext-ctl-unix", path + "/api.sock"] && launchEnvironment == ["PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": path, "TMPDIR": path, "RELAY_LOCAL_GEODATA_V1": "1"])
                check("exact Unix sandbox denies outbound and other bind", report["outboundDenied"] as? Bool == true && report["otherBindDenied"] as? Bool == true)
                let accepted = accept(sentinel, nil, nil), acceptError = errno
                if accepted >= 0 { Darwin.close(accepted) }
                check("own outbound sentinel accepted zero connections", accepted == -1 && (acceptError == EAGAIN || acceptError == EWOULDBLOCK))
                let connection = socket(AF_UNIX, SOCK_STREAM, 0)
                guard connection >= 0 else { throw Injected.failure }; defer { Darwin.close(connection) }
                guard try unixCall(connection, path + "/api.sock", bindSocket: false) == 0 else { throw Injected.failure }
                try child.verifyPeer(socket: connection)
                check("allowed Unix endpoint authenticates exact unreaped probe", try child.whileRunning { true })
                let stopped = try child.stop()
                let terminal = try child.observe()
                check("probe shutdown is truly reaped through existing ownership path", stopped.waitStatus == 0 && !stopped.forced && terminal == .exited(0))
            }
            try probeDirectory { path, hash, size in
                var registrations = 0
                func run(_ sha: String? = nil, _ bytes: Int? = nil, verify: () throws -> Void = {}) throws {
                    var owned: RelayTunOwnedChild?
                    defer { if let owned { _ = try? owned.stop() } }
                    _ = try RelayTunOwnedChild.spawnProviderProbe(directory: path, expectedCoreSHA256: sha ?? hash, expectedCoreBytes: bytes ?? size,
                        verify: verify, register: { registrations += 1; owned = $0 })
                }
                rejects("probe refuses wrong exact digest") { try run(String(repeating: "0", count: 64)) }
                rejects("probe refuses wrong byte count") { try run(nil, size + 1) }
                rejects("probe refuses invalid digest syntax") { try run(String(repeating: "A", count: 64)) }
                rejects("probe cancellation before admission creates no child") { try run(verify: { throw Injected.failure }) }
                chmod(path + "/mihomo-probe", 0o4500)
                rejects("probe refuses setuid source rather than executing installed privilege") { try run() }
                chmod(path + "/mihomo-probe", 0o700)
                rejects("probe refuses writable executable copy") { try run() }
                chmod(path + "/mihomo-probe", 0o500)
                guard rename(path + "/mihomo-probe", path + "/original") == 0,
                      symlink(path + "/original", path + "/mihomo-probe") == 0 else { throw Injected.failure }
                rejects("probe refuses symlink executable rather than following source") { try run() }
                unlink(path + "/mihomo-probe")
                guard rename(path + "/original", path + "/mihomo-probe") == 0 else { throw Injected.failure }
                guard link(path + "/mihomo-probe", path + "/hardlink") == 0 else { throw Injected.failure }
                rejects("probe refuses multiply-linked executable") { try run() }
                unlink(path + "/hardlink")
                chmod(path + "/config.yaml", 0o644)
                rejects("probe refuses nonprivate configuration") { try run() }
                chmod(path + "/config.yaml", 0o600)
                chmod(path, 0o755)
                rejects("probe refuses nonprivate root") { try run() }
                chmod(path, 0o700)
                try Data("foreign".utf8).write(to: URL(fileURLWithPath: path + "/api.sock"))
                rejects("probe cannot reuse a preexisting endpoint name") { try run() }
                unlink(path + "/api.sock")
                rejects("final callback changing config is caught before spawn") {
                    try run(verify: { try Data("changed\n".utf8).write(to: URL(fileURLWithPath: path + "/config.yaml")) })
                }
                check("all failed probe admissions leave zero child capabilities", registrations == 0)
            }
            try probeDirectory { path, hash, size in
                var registered: RelayTunOwnedChild?
                defer { if let registered { _ = try? registered.stop() } }
                rejects("final callback replacing verified executable cannot become new trust anchor") {
                    _ = try RelayTunOwnedChild.spawnProviderProbe(directory: path, expectedCoreSHA256: hash, expectedCoreBytes: size, verify: {
                        guard rename(path + "/mihomo-probe", path + "/original") == 0 else { throw Injected.failure }
                        try FileManager.default.copyItem(atPath: path + "/original", toPath: path + "/mihomo-probe")
                    }, register: { registered = $0 })
                }
                check("replacement at final callback produces no child", registered == nil)
            }
            try probeDirectory { path, _, _ in
                chmod(path + "/mihomo-probe", 0o700)
                let invalid = Data("not a signed executable\n".utf8)
                try invalid.write(to: URL(fileURLWithPath: path + "/mihomo-probe"))
                chmod(path + "/mihomo-probe", 0o500)
                rejects("matching SHA alone cannot admit unsigned non-Mach bytes") {
                    _ = try RelayTunOwnedChild.spawnProviderProbe(directory: path, expectedCoreSHA256: RelayTunHelperTrust.digest(invalid), expectedCoreBytes: invalid.count, verify: {}, register: { _ in })
                }
            }
            try probeDirectory { path, hash, size in
                var registered: RelayTunOwnedChild?
                defer { if let registered { _ = try? registered.stop() } }
                rejects("probe post-spawn refusal occurs only after recovery capability registration") {
                    _ = try RelayTunOwnedChild.spawnProviderProbe(directory: path, expectedCoreSHA256: hash, expectedCoreBytes: size,
                        verify: {}, register: {
                            registered = $0
                            // A synchronous observer can retire this exact
                            // child before the factory's identity postcheck.
                            _ = try? $0.stop()
                        })
                }
                guard let registered else { throw Injected.failure }
                if case .exited = try registered.observe() {
                    check("registered probe remains truly reaped after post-spawn rejection", true)
                } else { check("registered probe remains truly reaped after post-spawn rejection", false) }
            }
            check("all test children and parent descriptors retired", descriptors() == before)
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "backend": "ordinary-UID self re-exec inert children; test-only branch",
            "liveTunUsed": false, "actualCoreStarted": false, "actualNetworkConfigurationChanged": false]
        if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) { print(String(decoding: bytes, as: UTF8.self)) }
        exit(passed == rows.count ? 0 : 1)
    }
}
