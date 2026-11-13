import CryptoKit
import Darwin
@preconcurrency import Foundation
import Security

// A bounded read-only installed-client invocation. No session/start/action
// argument, shell, PID adoption or existing-process termination is available.
private final class RelayMaintenanceProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Data, Error>?
    private var bytes = Data(), eof = false, exited = false, status: Int32 = -1
    private let process = Process(), output = Pipe()
    init(_ continuation: CheckedContinuation<Data, Error>) { self.continuation = continuation }
    private func finish(_ result: Result<Data, Error>) {
        lock.lock(); let done = continuation; continuation = nil; lock.unlock()
        done?.resume(with: result)
    }
    private func settled() {
        lock.lock(); let done = eof && exited, value = bytes, code = status; lock.unlock()
        if done {
            output.fileHandleForReading.readabilityHandler = nil; process.terminationHandler = nil
            try? output.fileHandleForReading.close()
            finish(code == 0 ? .success(value) : .failure(RelayMaintenanceFailure.pending))
        }
    }
    func run(path: String, argument: String) {
        process.executableURL = URL(fileURLWithPath: path); process.arguments = [argument]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"]
        output.fileHandleForReading.readabilityHandler = { [self] handle in
            let part = handle.availableData
            lock.lock()
            let oversized = bytes.count + part.count > 65536
            if part.isEmpty { eof = true } else if !oversized && continuation != nil { bytes.append(part) }
            lock.unlock()
            if part.isEmpty { handle.readabilityHandler = nil; settled() }
            if oversized {
                finish(.failure(RelayMaintenanceFailure.unsafe))
                if process.isRunning { process.terminate() } // This newly-created readonly child only.
            }
        }
        process.terminationHandler = { [self] child in
            lock.lock(); exited = true; status = child.terminationStatus; lock.unlock(); settled()
        }
        do { try process.run() }
        catch { output.fileHandleForReading.readabilityHandler = nil; process.terminationHandler = nil; try? output.fileHandleForReading.close(); finish(.failure(RelayMaintenanceFailure.pending)); return }
        DispatchQueue.global().asyncAfter(deadline: .now() + 40) { [self] in
            lock.lock(); let unfinished = continuation != nil; lock.unlock()
            if unfinished {
                finish(.failure(RelayMaintenanceFailure.pending))
                if process.isRunning { process.terminate() }
            }
        }
    }
    static func read(path: String, argument: String) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let reader = RelayMaintenanceProbe(continuation); reader.run(path: path, argument: argument)
        }
    }
}

extension RelayMaintenanceGate {
    @MainActor private static var probeLocks: [Int32] = []
    @MainActor static func releaseProbeLocksSync() { for fd in probeLocks { Darwin.close(fd) }; probeLocks = [] }
    @MainActor static func releaseProbeLocks() async { releaseProbeLocksSync() }
    private static func rootFile(_ path: String, limit: Int) throws -> Data? {
        guard path.hasPrefix("/Library/"), !path.utf8.contains(0) else { throw RelayMaintenanceFailure.invalid }
        var cursor = URL(fileURLWithPath: path).deletingLastPathComponent()
        while cursor.path != "/" {
            var info = stat()
            guard lstat(cursor.path, &info) == 0, info.st_uid == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o6022 == 0 else { throw RelayMaintenanceFailure.unsafe }
            cursor.deleteLastPathComponent()
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 && errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw RelayMaintenanceFailure.unsafe }
        defer { Darwin.close(descriptor) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(descriptor, &before) == 0, before.st_uid == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              before.st_mode & 0o7022 == 0, before.st_nlink == 1, before.st_size > 0, before.st_size <= limit else { throw RelayMaintenanceFailure.unsafe }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 16384)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            guard count >= 0 else { throw RelayMaintenanceFailure.unsafe }
            if count == 0 { break }; data.append(buffer, count: count)
            guard data.count <= limit else { throw RelayMaintenanceFailure.unsafe }
        }
        guard fstat(descriptor, &after) == 0, lstat(path, &linked) == 0,
              RelayMaintenanceDirectory.same(before, after), RelayMaintenanceDirectory.same(before, linked), data.count == before.st_size else { throw RelayMaintenanceFailure.changed }
        return data
    }
    @MainActor static func tunIdle() async throws {
        // Active/uncertain effect journals require the mature TUN recovery path;
        // a full UI/data reset never archives or clears system recovery records.
        for path in ["/Library/Application Support/Relay/Tun/NetworkJournal", "/Library/Application Support/Relay/Tun/DeviceJournal"] {
            var info = stat()
            if lstat(path, &info) == 0 { throw RelayMaintenanceFailure.pending }
            guard errno == ENOENT else { throw RelayMaintenanceFailure.unsafe }
        }
        for managed in [false, true] {
            let root = "/Library/Application Support/Relay/" + (managed ? "TunManaged" : "Tun")
            // Missing complete fixed ancestors is absence only after checking
            // each existing prefix; a symlink/unreadable installation is unknown.
            var missing = false
            var prefix = ""
            for component in (root + "/installation.json").split(separator: "/") {
                prefix += "/" + component
                var value = stat()
                if lstat(prefix, &value) != 0 { guard errno == ENOENT else { throw RelayMaintenanceFailure.unsafe }; missing = true; break }
                guard value.st_uid == 0, value.st_mode & mode_t(S_IFMT) != mode_t(S_IFLNK), value.st_mode & 0o022 == 0 else { throw RelayMaintenanceFailure.unsafe }
            }
            if missing { continue }
            guard let manifest = try rootFile(root + "/installation.json", limit: 16384) else { throw RelayMaintenanceFailure.unsafe }
            let item = try RelayTunStrictJSON.object(manifest)
            let role = item["role"] as? String
            guard RelayTunStrictJSON.integer(item["clientUID"]) == Int(getuid()),
                  managed ? ["core-managed-v1", "core-managed-v2"].contains(role ?? "") : role == "network-executor-v1",
                  let pin = item["client"] as? [String: Any], Set(pin.keys) == ["sha256", "size", "cdhashes"], hash(pin["sha256"]),
                  let hashes = pin["cdhashes"] as? [String: String], Set(hashes.keys) == ["arm64", "x86_64"],
                  hashes.values.allSatisfy({ $0.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil }),
                  let expected = RelayTunStrictJSON.integer(pin["size"]), expected > 0, expected <= 134217728,
                  let binary = try rootFile(root + "/RelayTunClient", limit: 134217728), binary.count == expected,
                  RelayMaintenanceDirectory.hash(binary) == pin["sha256"] as? String else { throw RelayMaintenanceFailure.identity }
            let expression = "(" + ["arm64", "x86_64"].map { "cdhash H\"" + hashes[$0]! + "\"" }.joined(separator: " or ") + ")"
            let requirement = try codeRequirement(expression)
            var code: SecStaticCode?
            guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: root + "/RelayTunClient") as CFURL, [], &code) == errSecSuccess, let code,
                  SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess), requirement) == errSecSuccess else { throw RelayMaintenanceFailure.identity }
            if managed {
                let descriptor = Darwin.open(root + "/busy.lock", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
                guard descriptor >= 0 else { throw RelayMaintenanceFailure.pending }
                var value = stat(), linked = stat()
                guard fstat(descriptor, &value) == 0, lstat(root + "/busy.lock", &linked) == 0,
                      value.st_uid == 0, value.st_nlink == 1, value.st_mode & 0o7777 == 0o644, value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                      RelayMaintenanceDirectory.same(value, linked), flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(descriptor); throw RelayMaintenanceFailure.pending }
                probeLocks.append(descriptor)
            }
            let argument = managed ? role == "core-managed-v2" ? "--managed-inspect-execution-v2" : "--managed-inspect" : "--inspect"
            let bytes = try await RelayMaintenanceProbe.read(path: root + "/RelayTunClient", argument: argument)
            guard try rootFile(root + "/installation.json", limit: 16384) == manifest else { throw RelayMaintenanceFailure.changed }
            let report = try RelayTunStrictJSON.object(bytes, limit: 65536)
            guard Set(report.keys) == ["helper", "network", "baseline"], let helper = report["helper"] as? [String: Any], let network = report["network"] as? [String: Any],
                  RelayTunStrictJSON.integer(helper["version"]) == 1, helper["source"] as? String == "native", helper["identity"] as? String == "authenticated",
                  RelayTunStrictJSON.integer(helper["clientUID"]) == Int(getuid()), helper["authorization"] as? String == "approved",
                  network["source"] as? String == "native", network["state"] as? String == "observed", network["existingTunnel"] as? String == "none",
                  network["recovery"] as? String == "available", let time = RelayTunStrictJSON.integer(network["observedAt"]),
                  abs(Date().timeIntervalSince1970 * 1000 - Double(time)) <= 60000 else { throw RelayMaintenanceFailure.pending }
        }
    }
    static func backupsIdle(root: URL) throws {
        let path = root.appendingPathComponent("ApplicationBackups")
        var info = stat()
        if lstat(path.path, &info) != 0 { guard errno == ENOENT else { throw RelayMaintenanceFailure.unsafe }; return }
        guard info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o7022 == 0 else { throw RelayMaintenanceFailure.unsafe }
        let names = try FileManager.default.contentsOfDirectory(atPath: path.path)
        guard names.count <= 1024 else { throw RelayMaintenanceFailure.unsafe }
        for name in names where name.hasPrefix("restore-") {
            let id = String(name.dropFirst(8)); guard uuid(id) else { throw RelayMaintenanceFailure.invalid }
            let directory = path.appendingPathComponent(name)
            guard let initial = try RelayRecoveryInspector.read(directory.appendingPathComponent("journal.json"), limit: 65536), initial.mode == 0o600 else { throw RelayMaintenanceFailure.pending }
            var bytes = initial.data, value = try RelayTunStrictJSON.object(bytes), total = bytes.count
            let anchor = value["plan"] as? [String: Any]
            guard anchor?["id"] as? String == id else { throw RelayMaintenanceFailure.invalid }
            let entries = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            guard !entries.contains("recheck-pending"), !entries.contains("recovery-pending") else { throw RelayMaintenanceFailure.pending }
            let histories = entries.filter { $0.hasPrefix("journal-") }.sorted()
            guard histories.count <= 512 else { throw RelayMaintenanceFailure.unsafe }
            for (index, entry) in histories.enumerated() {
                guard entry == String(format: "journal-%06d.json", index + 1),
                      let next = try RelayRecoveryInspector.read(directory.appendingPathComponent(entry), limit: 65536), next.mode == 0o600 else { throw RelayMaintenanceFailure.invalid }
                total += next.data.count; guard total <= 32 * 1024 * 1024 else { throw RelayMaintenanceFailure.unsafe }
                let frame = try RelayTunStrictJSON.object(next.data)
                guard Set(frame.keys) == ["version", "sequence", "parentSHA256", "journal"], RelayTunStrictJSON.integer(frame["version"]) == 1,
                      RelayTunStrictJSON.integer(frame["sequence"]) == index + 1, frame["parentSHA256"] as? String == RelayMaintenanceDirectory.hash(bytes),
                      let journal = frame["journal"] as? [String: Any], (journal["plan"] as? [String: Any])?["id"] as? String == id else { throw RelayMaintenanceFailure.invalid }
                value = journal; bytes = next.data
            }
            let version = RelayTunStrictJSON.integer(value["version"]), phase = value["phase"] as? String
            guard [1, 2].contains(version ?? 0), ["staged", "applied", "rolled-back"].contains(phase ?? ""), value["intent"] == nil, value["marker"] == nil else { throw RelayMaintenanceFailure.pending }
            // The signed Main's existing BackupStore/recoveryJournal owns the
            // richer nested schema validation. This native additional gate
            // independently pins the chain, fixed scope and unresolved phase.
        }
    }
}
