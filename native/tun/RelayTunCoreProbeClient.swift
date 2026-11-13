import Foundation
import CryptoKit
import Darwin

// This flag records signal intent only. Cleanup remains on the owning main
// thread, with bounded waits and no stored-PID/process-name adoption.
private var probeInterrupted: sig_atomic_t = 0
private func probeSignal(_ value: Int32) { probeInterrupted = value }

private final class RelayTunCoreProbeRun {
    enum Failure: Error { case refused }
    var stage = "receipt", directory: String?
    var pid: pid_t = 0, waitStatus: Int32?, coreResourceVerified = false, coreVersionVerified = false, coreTunFDVerified = false
    var forced = false, removed = false, originalClosed = false
    private var ownedDirectory: stat?, configBytes: Data?
    private func require(_ condition: Bool) throws { guard condition else { throw Failure.refused } }
    private static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000_000 }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode &&
            a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
            a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private func attributes(_ path: String) throws {
        let count = listxattr(path, nil, 0, XATTR_NOFOLLOW)
        try require(count >= 0 && count <= 4096)
        if count == 0 { return }
        var buffer = [CChar](repeating: 0, count: count)
        try require(listxattr(path, &buffer, count, XATTR_NOFOLLOW) == count)
        let names = buffer.split(separator: 0).map { String(decoding: $0.map { UInt8(bitPattern: $0) }, as: UTF8.self) }
        try require(Set(names).isSubset(of: ["com.apple.provenance"]))
    }
    fileprivate func verifyCore() throws {
        coreResourceVerified = false
        let path = RelayTunCoreProbeBuild.executable
        try require(path.hasPrefix("/Users/") && path.contains("/Library/Caches/") && path.hasSuffix("/mihomo"))
        var cursor = URL(fileURLWithPath: path)
        while cursor.path != "/" {
            var info = stat(); try require(lstat(cursor.path, &info) == 0 && info.st_mode & mode_t(S_IFMT) != mode_t(S_IFLNK))
            cursor.deleteLastPathComponent()
        }
        var before = stat(), opened = stat(), after = stat(), linked = stat()
        try require(lstat(path, &before) == 0 && before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && before.st_uid == getuid() &&
                    before.st_nlink == 1 && before.st_mode & 0o7777 == 0o755 && before.st_size == RelayTunCoreProbeBuild.size)
        try attributes(path)
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        try require(fd >= 0); defer { Darwin.close(fd) }
        try require(fstat(fd, &opened) == 0 && Self.same(before, opened))
        var hash = SHA256(), count = 0, first = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let amount = Darwin.read(fd, &buffer, buffer.count)
            if amount < 0 && errno == EINTR { continue }
            try require(amount >= 0)
            if amount == 0 { break }
            if count == 0 { first = Data(buffer.prefix(8)) }
            count += amount; try require(count <= RelayTunCoreProbeBuild.size)
            hash.update(data: Data(buffer.prefix(amount)))
        }
        try require(count == RelayTunCoreProbeBuild.size && first.count == 8)
        let header = [UInt8](first), magic = UInt32(header[0]) | UInt32(header[1]) << 8 | UInt32(header[2]) << 16 | UInt32(header[3]) << 24
        let cpu = UInt32(header[4]) | UInt32(header[5]) << 8 | UInt32(header[6]) << 16 | UInt32(header[7]) << 24
        try require(magic == 0xfeedfacf && cpu == RelayTunCoreProbeBuild.cpuType &&
                    hash.finalize().map { String(format: "%02x", $0) }.joined() == RelayTunCoreProbeBuild.sha256)
        try require(fstat(fd, &after) == 0 && lstat(path, &linked) == 0 && Self.same(opened, after) && Self.same(after, linked))
        try attributes(path); coreResourceVerified = true
    }
    private func checkDirectory() throws {
        guard let directory, let original = ownedDirectory else { throw Failure.refused }
        var current = stat()
        try require(lstat(directory, &current) == 0 && current.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) &&
                    current.st_uid == getuid() && current.st_mode & 0o7777 == 0o700 && current.st_dev == original.st_dev && current.st_ino == original.st_ino)
    }
    private func makeDirectory(_ receipt: RelayTunAcquiredReceipt) throws {
        var template = Array("/private/tmp/relay-fd-\(getuid())-XXXXXX".utf8CString)
        try require(mkdtemp(&template) != nil)
        let path = String(cString: template); directory = path
        var info = stat(); try require(lstat(path, &info) == 0); ownedDirectory = info
        try checkDirectory()
        let bytes = try RelayTunCoreProbePlan.configuration(receipt: receipt), config = path + "/config.yaml"
        let fd = open(config, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        try require(fd >= 0); defer { Darwin.close(fd) }
        try require(fchmod(fd, 0o600) == 0)
        var offset = 0
        try bytes.withUnsafeBytes { raw in
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0 && errno == EINTR { continue }
                try require(count > 0); offset += count
            }
        }
        try require(fsync(fd) == 0); configBytes = bytes
        try checkDirectory()
    }
    private func pollChild() throws -> RelayTunCoreProbePlan.ChildState {
        if let waitStatus { return .exited(waitStatus) }
        try require(pid > 0)
        var status: Int32 = 0
        let result = waitpid(pid, &status, WNOHANG)
        if result == pid { waitStatus = status; return .exited(status) }
        if result == 0 || (result < 0 && errno == EINTR) { return .running }
        return .unknown
    }
    private func signalChild(_ signal: Int32) throws {
        guard case .running = try pollChild() else { return }
        try require(Darwin.kill(pid, signal) == 0 || errno == ESRCH)
    }
    private func stop() throws {
        if pid == 0 { return }
        let result = try RelayTunCoreProbePlan.stopOwnedChild(.init(wait: { try self.pollChild() }, signal: { try self.signalChild($0) },
            now: Self.now, pause: { usleep(10000) }))
        waitStatus = result.waitStatus; forced = result.forced
    }
    private func spawn(_ descriptor: RelayTunDescriptor.LiveDescriptor) throws {
        guard let directory else { throw Failure.refused }
        try require(probeInterrupted == 0); try checkDirectory(); try verifyCore()
        try RelayTunDescriptor.withLiveSpawnActions(descriptor) { actions, attributes in
            try require(posix_spawn_file_actions_addchdir_np(&actions, directory) == 0)
            let strings = [RelayTunCoreProbeBuild.executable, "-d", directory, "-f", directory + "/config.yaml", "-ext-ctl-unix", directory + "/api.sock"]
            let environment = ["PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "HOME=" + directory, "TMPDIR=" + directory]
            let args = strings.map { strdup($0) } + [nil], env = environment.map { strdup($0) } + [nil]
            defer { for value in args + env { if let value { free(value) } } }
            var child: pid_t = 0
            let status = args.withUnsafeBufferPointer { a in env.withUnsafeBufferPointer { e in
                posix_spawn(&child, RelayTunCoreProbeBuild.executable, &actions, &attributes, a.baseAddress!, e.baseAddress!)
            } }
            try require(status == 0 && child > 0); pid = child
        }
        var info = proc_bsdinfo()
        try require(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size) &&
                    info.pbi_uid == getuid() && info.pbi_ruid == getuid() && info.pbi_gid == getgid() && info.pbi_rgid == getgid())
    }
    private var socketIdentity: (dev_t, ino_t)?
    private func api(_ endpoint: String) throws -> Data {
        guard let directory, ["version", "configs"].contains(endpoint) else { throw Failure.refused }
        try checkDirectory(); try require(probeInterrupted == 0)
        guard case .running = try pollChild() else { throw Failure.refused }
        let path = directory + "/api.sock"; var observed = stat()
        try require(path.utf8.count < 100 && lstat(path, &observed) == 0 && observed.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) && observed.st_uid == getuid())
        if let identity = socketIdentity { try require(identity == (observed.st_dev, observed.st_ino)) }
        else { socketIdentity = (observed.st_dev, observed.st_ino) }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0); try require(fd >= 0); defer { Darwin.close(fd) }
        try require(fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 && fcntl(fd, F_SETFL, O_NONBLOCK) == 0)
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8CString.map { UInt8(bitPattern: $0) }) }
        let start = Self.now()
        func ready(_ events: Int16) throws {
            try require(Self.now() - start < 500 && probeInterrupted == 0)
            var poller = pollfd(fd: fd, events: events, revents: 0)
            try require(poll(&poller, 1, 50) >= 0 && poller.revents & Int16(POLLERR | POLLNVAL) == 0)
        }
        let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        if connected != 0 {
            try require(errno == EINPROGRESS || errno == EAGAIN); try ready(Int16(POLLOUT))
            var error: Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
            try require(getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0 && error == 0)
        }
        let request = Data("GET /\(endpoint) HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n".utf8)
        var sent = 0
        try request.withUnsafeBytes { raw in
            while sent < raw.count {
                let n = Darwin.write(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                if n < 0 && (errno == EAGAIN || errno == EINTR) { try ready(Int16(POLLOUT)); continue }
                try require(n > 0); sent += n
            }
        }
        var response = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            try require(Self.now() - start < 500 && probeInterrupted == 0)
            let n = Darwin.read(fd, &buffer, buffer.count)
            if n < 0 && (errno == EAGAIN || errno == EINTR) { try ready(Int16(POLLIN)); continue }
            try require(n >= 0); if n == 0 { break }
            response.append(contentsOf: buffer.prefix(n))
            try require(response.count <= RelayTunCoreProbePlan.headerLimit + 4 + RelayTunCoreProbePlan.responseLimit)
        }
        var after = stat(); try require(lstat(path, &after) == 0 && observed.st_dev == after.st_dev && observed.st_ino == after.st_ino && observed.st_uid == after.st_uid)
        return try RelayTunCoreProbePlan.httpBody(response)
    }
    private func cleanup() throws {
        guard let directory else { return }
        try require(pid == 0 || waitStatus != nil); try checkDirectory()
        let names = try FileManager.default.contentsOfDirectory(atPath: directory)
        try require(Set(names).isSubset(of: ["config.yaml", "cache.db", "api.sock"]))
        var inventories: [(String, stat)] = []
        for name in names {
            let path = directory + "/" + name; var info = stat()
            try require(lstat(path, &info) == 0 && info.st_uid == getuid() && info.st_nlink == 1)
            if name == "api.sock" { try require(info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK)) }
            else {
                try require(info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && info.st_mode & 0o7777 == 0o600)
                if name == "config.yaml" { try require(try Data(contentsOf: URL(fileURLWithPath: path)) == configBytes) }
            }
            inventories.append((path, info))
        }
        try checkDirectory()
        for (path, original) in inventories {
            var now = stat(); try require(lstat(path, &now) == 0 && Self.same(original, now) && unlink(path) == 0)
        }
        try checkDirectory(); try require(rmdir(directory) == 0); removed = true
    }
    func execute(_ receipt: RelayTunAcquiredReceipt) throws {
        stage = "admit"; let descriptor = try RelayTunDescriptor.validateLive(3, receipt: receipt)
        do {
            stage = "resource"; try verifyCore()
            stage = "directory"; try makeDirectory(receipt)
            stage = "spawn"; try spawn(descriptor)
            stage = "readiness"; let start = Self.now(); var accepted = false
            while Self.now() - start < RelayTunCoreProbePlan.readyMilliseconds && probeInterrupted == 0 {
                do {
                    let version = try api("version"), config = try api("configs")
                    _ = try RelayTunStrictJSON.object(version, limit: RelayTunCoreProbePlan.responseLimit)
                    _ = try RelayTunStrictJSON.object(config, limit: RelayTunCoreProbePlan.responseLimit)
                    try RelayTunCoreProbePlan.validateReady(version: version, configs: config, receipt: receipt)
                    coreVersionVerified = true; coreTunFDVerified = true; accepted = true; break
                } catch { guard case .running = try pollChild() else { throw Failure.refused }; usleep(50000) }
            }
            try require(accepted && probeInterrupted == 0)
            stage = "stop"; try stop()
            guard let waitStatus else { throw Failure.refused }
            try RelayTunCoreProbePlan.requireGracefulExit(.init(waitStatus: waitStatus, forced: forced))
            stage = "cleanup"; try cleanup()
        } catch {
            let original = error
            if pid > 0 && waitStatus == nil { stage = "failure_stop"; try stop() }
            if directory != nil { stage = "failure_cleanup"; try cleanup() }
            throw original
        }
        // descriptor's validated private copy closes when this function returns.
        withExtendedLifetime(descriptor) { }
    }
    func failureReport() -> [String: Any] {
        ["version": 1, "status": "fixed_core_fd_probe_unverified", "stage": stage, "ordinaryUID": getuid() > 0 && geteuid() == getuid(),
         "coreResourceVerified": coreResourceVerified, "coreVersionVerified": coreVersionVerified, "coreTunFDVerified": coreTunFDVerified,
         "coreSpawned": pid > 0, "coreExited": waitStatus != nil, "coreWaitStatus": waitStatus.map { $0 as Any } ?? NSNull(),
         "forcedOwnChildExit": forced, "privateDirectoryRemoved": removed, "privateDirectory": directory.map { $0 as Any } ?? NSNull(),
         "FDClosed": originalClosed, "signalObserved": probeInterrupted, "actualTunAccepted": false, "dnsCacheRestorationVerified": false]
    }
}

@main struct RelayTunCoreProbeClient {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard getuid() > 0, geteuid() == getuid(), getgid() == getegid(),
              arguments == ["--adopt-received-device-in-fixed-core"] || arguments == ["--verify-core-only"] else { exit(77) }
        // Fixed Mihomo cachefile uses mode 0666. Constrain its inherited mask
        // before spawn so the private-directory cleanup's 0600 check is true.
        _ = umask(0o077)
        _ = Darwin.signal(SIGPIPE, SIG_IGN); _ = Darwin.signal(SIGTERM, probeSignal); _ = Darwin.signal(SIGINT, probeSignal)
        let run = RelayTunCoreProbeRun()
        if arguments == ["--verify-core-only"] {
            do {
                try run.verifyCore()
                print("{\"version\":1,\"ordinaryUID\":true,\"coreResourceVerified\":true,\"coreStarted\":false,\"actualTunAccepted\":false}")
            } catch {
                print("{\"version\":1,\"ordinaryUID\":true,\"coreResourceVerified\":false,\"coreStarted\":false,\"actualTunAccepted\":false}")
                exit(1)
            }
            return
        }
        do {
            var input = Data()
            while true {
                guard let block = try FileHandle.standardInput.read(upToCount: 4097 - input.count), !block.isEmpty else { break }
                input.append(block); guard input.count <= 4096 else { throw RelayTunCoreProbePlan.Failure.invalid }
            }
            _ = try RelayTunStrictJSON.object(input, limit: 4096)
            let receipt = try JSONDecoder().decode(RelayTunAcquiredReceipt.self, from: input)
            guard receipt.clientUID == getuid() else { throw RelayTunCoreProbePlan.Failure.invalid }
            let before = Set((0...1024).map(Int32.init).filter { fcntl($0, F_GETFD) >= 0 })
            try run.execute(receipt)
            let after = Set((0...1024).map(Int32.init).filter { fcntl($0, F_GETFD) >= 0 })
            guard after == before else { throw RelayTunCoreProbePlan.Failure.invalid }
            let closed = Darwin.close(3); run.originalClosed = true
            guard closed == 0, fcntl(3, F_GETFD) == -1, errno == EBADF else { throw RelayTunCoreProbePlan.Failure.invalid }
            print("{\"version\":1,\"receiptBindingValidated\":true,\"ordinaryUID\":true,\"coreResourceVerified\":true,\"coreVersionVerified\":true,\"coreTunFDVerified\":true,\"coreExited\":true,\"FDClosed\":true,\"privateDirectoryRemoved\":true,\"actualTunAccepted\":false}")
        } catch {
            if !run.originalClosed { run.originalClosed = Darwin.close(3) == 0 }
            let bytes = try? JSONSerialization.data(withJSONObject: run.failureReport(), options: [.sortedKeys, .withoutEscapingSlashes])
            if let bytes, bytes.count <= 4096 { print(String(decoding: bytes, as: UTF8.self)) }
            else { print("{\"version\":1,\"status\":\"fixed_core_fd_probe_unverified\",\"actualTunAccepted\":false}") }
            exit(1)
        }
    }
}
