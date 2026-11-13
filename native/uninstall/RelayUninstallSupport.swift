import Foundation
import CryptoKit
import Darwin

// Fixed installation namespace. No user-supplied removal path is accepted.
enum RelayRemoval {
    static let root = "/Library/Application Support/Relay/Uninstall"
    static let app = "/Applications/Relay.app"
    static let label = "local.relay.network.uninstall"
    static let daemon = "/Library/LaunchDaemons/\(label).plist"
    static let executable = "\(root)/RelayUninstallSupervisor"
    static let native = "\(root)/RelayNative"
    static let receipts = ["local.relay.network.app", "local.relay.network.system-proxy.v1", "local.relay.network.tun.core-managed-v1", "local.relay.network.tun.core-managed-v2"]
    static func fail(_ message: String) -> NSError { NSError(domain: "RelayAutomaticRemoval", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func info(_ path: String) -> stat? { var value = stat(); return lstat(path, &value) == 0 ? value : nil }
    static func present(_ path: String) -> Bool {
        var value = stat()
        if lstat(path, &value) == 0 { return true }
        // Access errors are never evidence of removal. The subsequent strict
        // reader will surface the error rather than declaring cleanup complete.
        return errno != ENOENT
    }
    static func directory(_ path: String) throws {
        guard let s = info(path), (s.st_mode & S_IFMT) == S_IFDIR, s.st_uid == 0,
              s.st_mode & 0o6022 == 0 else { throw fail("Unsafe administrator directory: \(path)") }
    }
    static func parents(_ path: String) throws {
        var p = URL(fileURLWithPath: path).deletingLastPathComponent().path
        while true { try directory(p); if p == "/" { break }; p = URL(fileURLWithPath: p).deletingLastPathComponent().path }
    }
    static func file(_ path: String, mode: mode_t = 0o644) throws -> Data {
        try parents(path)
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw fail("Cannot open administrator file: \(path)") }
        defer { close(fd) }
        var before = stat(); var after = stat(); var linked = stat()
        guard fstat(fd, &before) == 0, before.st_uid == 0, before.st_nlink == 1,
              before.st_mode & S_IFMT == S_IFREG, before.st_mode & 0o7777 == mode,
              before.st_size >= 0, before.st_size <= 134217728 else { throw fail("Unsafe administrator file: \(path)") }
        var bytes = Data(); var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count < 0 { if errno == EINTR { continue }; throw fail("Cannot read administrator file") }
            if count == 0 { break }
            bytes.append(contentsOf: buffer.prefix(count))
            if bytes.count > 134217728 { throw fail("Oversized administrator file") }
        }
        guard fstat(fd, &after) == 0, lstat(path, &linked) == 0,
              same(before, after), same(after, linked) else { throw fail("Administrator file changed during read") }
        return bytes
    }
    static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_uid == b.st_uid &&
        a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
        a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    static func json(_ path: String) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: file(path)) as? [String: Any] else { throw fail("Invalid installation record") }
        return value
    }
    static func save(_ value: [String: Any], _ name: String) throws {
        try directory(root)
        let path = "\(root)/\(name)"
        if present(path) { _ = try file(path) }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        let temp = "\(root)/.write-\(UUID().uuidString)"
        let fd = open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
        guard fd >= 0 else { throw fail("Cannot stage recovery record") }
        defer { close(fd); unlink(temp) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let n = write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard n > 0 else { throw fail("Cannot persist recovery record") }; offset += n
            }
        }
        guard fchmod(fd, 0o644) == 0, fsync(fd) == 0, rename(temp, path) == 0 else { throw fail("Cannot publish recovery record") }
        let dir = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        if dir >= 0 { _ = fsync(dir); close(dir) }
    }
    static func run(_ command: String, _ arguments: [String], timeout: TimeInterval = 60) throws -> (Int32, Data) {
        let process = Process(); process.executableURL = URL(fileURLWithPath: command); process.arguments = arguments
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        let pipe = Pipe(); process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        let completed = DispatchSemaphore(value: 0); process.terminationHandler = { _ in completed.signal() }
        try process.run()
        let output = DispatchGroup(); output.enter()
        let capture = RelayRemovalCapture()
        DispatchQueue.global().async {
            while true { let data = pipe.fileHandleForReading.availableData; if data.isEmpty { break }; capture.append(data) }
            output.leave()
        }
        if completed.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate() // Only this exact spawned cleanup child, never an app/core PID.
            if completed.wait(timeout: .now() + 5) == .timedOut, process.isRunning {
                // An unreaped child retains its PID; this cannot target another
                // process or an owned core discovered from a stale record.
                _ = kill(process.processIdentifier, SIGKILL)
                _ = completed.wait(timeout: .now() + 5)
            }
            throw fail("Cleanup child did not finish")
        }
        guard output.wait(timeout: .now() + 5) == .success else { throw fail("Cleanup output did not close") }
        return (process.terminationStatus, capture.data)
    }
    static func requireRun(_ command: String, _ args: [String], timeout: TimeInterval = 60) throws -> Data {
        let result = try run(command, args, timeout: timeout)
        guard result.0 == 0 else { throw fail("Cleanup command failed: \(URL(fileURLWithPath: command).lastPathComponent)") }; return result.1
    }
    static func remove(_ path: String, mode: mode_t = 0o644, digest: String? = nil) throws {
        if !present(path) { return }
        let data = try file(path, mode: mode)
        if let digest, hash(data) != digest { throw fail("Changed component retained: \(path)") }
        guard unlink(path) == 0 else { throw fail("Cannot remove fixed component: \(path)") }
    }
    static func trackedPath(_ fd: Int32) -> String? {
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(fd, F_GETPATH, &path) == 0 else { return nil }; return String(cString: path)
    }
    static func trashPath(_ path: String, home: String, uid: UInt32) -> Bool {
        let clean = URL(fileURLWithPath: path).standardizedFileURL.path
        var homes = [home]
        // Canonicalize only the account home, never enumerate or resolve Trash.
        // F_GETPATH returns physical /private/var paths for aliased home roots.
        if let physical = realpath(home, nil) { homes.append(String(cString: physical)); free(physical) }
        if homes.contains(where: { clean.hasPrefix($0 + "/.Trash/") }) { return true }
        // /Applications lives on the startup data volume. Its per-user Trash
        // is normally ~/.Trash; /Volumes/.../.Trashes/UID covers same-vnode moves.
        let parts = clean.split(separator: "/")
        return parts.count >= 5 && parts[0] == "Volumes" && parts[2] == ".Trashes" && parts[3] == String(uid)
    }
    static func removalFact(currentPath: String?, links: UInt16, descriptorDeleted: Bool = false, originalOccupied: Bool, home: String, uid: UInt32) -> Bool {
        guard !originalOccupied else { return false }
        return links == 0 || descriptorDeleted || currentPath.map { trashPath($0, home: home, uid: uid) } == true
    }
}

final class RelayRemovalCapture: @unchecked Sendable {
    private let lock = NSLock(); private var storage = Data()
    func append(_ value: Data) { lock.lock(); defer { lock.unlock() }; if storage.count < 1048576 { storage.append(value.prefix(1048576 - storage.count)) } }
    var data: Data { lock.lock(); defer { lock.unlock() }; return storage }
}

struct RelayRemovalInstallation {
    let record: [String: Any]
    let generation: String
    let uid: UInt32
    let home: String
    let device: UInt64
    let inode: UInt64
    init() throws {
        let finalizing = RelayRemoval.present(RelayRemoval.root + "/finalization.json")
        let m = try RelayRemoval.json(RelayRemoval.root + (finalizing ? "/finalization.json" : "/installation.json"))
        guard m["version"] as? Int == 1, let generation = m["generation"] as? String, UUID(uuidString: generation) != nil,
              let uidValue = m["clientUID"] as? UInt32, uidValue >= 501,
              let user = getpwuid(uidValue), let directory = user.pointee.pw_dir,
              let home = m["home"] as? String, home == String(cString: directory),
              m["appPath"] as? String == RelayRemoval.app,
              let device = m["appDevice"] as? UInt64, let inode = m["appInode"] as? UInt64,
              let native = m["nativeSHA256"] as? String, let supervisor = m["supervisorSHA256"] as? String,
              try (finalizing || RelayRemoval.hash(RelayRemoval.file(RelayRemoval.native, mode: 0o755)) == native),
              RelayRemoval.hash(try RelayRemoval.file(RelayRemoval.executable, mode: 0o755)) == supervisor else { throw RelayRemoval.fail("Uninstall installation binding mismatch") }
        self.record = m; self.generation = generation; self.uid = uidValue; self.home = home; self.device = device; self.inode = inode
    }
    func matches(_ s: stat) -> Bool { UInt64(s.st_dev) == device && UInt64(s.st_ino) == inode && s.st_mode & S_IFMT == S_IFDIR }
}

// Durable phase ordering shared by the real monitor and injected failure tests.
// A failure never advances the checkpoint and never runs a later destructive step.
enum RelayRemovalLifecycle {
    static func run(phase initial: String, restoreUser: () throws -> Void,
                    removeComponents: () throws -> Void, checkpoint: (String) throws -> Void,
                    finish: () throws -> Void) throws {
        guard ["requested", "user-cleaned", "components-cleaned"].contains(initial) else { throw RelayRemoval.fail("Unknown cleanup phase") }
        var phase = initial
        if phase == "requested" {
            try restoreUser(); try checkpoint("user-cleaned"); phase = "user-cleaned"
        }
        if phase == "user-cleaned" {
            try removeComponents(); try checkpoint("components-cleaned")
        }
        try finish()
    }
}
