import Darwin
@preconcurrency import Foundation
import Security

enum RelayScopedStorageFailure: String, Error {
    case unavailable, invalid, changed, cancelled, busy, pending, uncertain, toolUnavailable, operationFailed, operationPending
}

// Adapted from the existing bounded C05 readonly Process reader. This runner
// only receives internally constructed fixed hdiutil arguments. A timeout or
// oversized reply never proves exit and never kills a possibly submitted disk
// operation. Its exact newly-created handle remains retained until EOF+exit.
final class RelayScopedStorageCommand: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Data, Error>?
    private let child = Process(), output = Pipe()
    private var bytes = Data(), eof = false, exited = false, code: Int32 = -1
    private let onDrained: @Sendable () -> Void
    init(_ continuation: CheckedContinuation<Data, Error>, onDrained: @escaping @Sendable () -> Void) {
        self.continuation = continuation; self.onDrained = onDrained
    }
    var drained: Bool { lock.lock(); defer { lock.unlock() }; return eof && exited }
    private func finish(_ result: Result<Data, Error>) {
        lock.lock(); let pending = continuation; continuation = nil; lock.unlock()
        pending?.resume(with: result)
    }
    private func settle() {
        lock.lock(); let done = eof && exited, data = bytes, status = code; lock.unlock()
        guard done else { return }
        output.fileHandleForReading.readabilityHandler = nil; child.terminationHandler = nil
        try? output.fileHandleForReading.close()
        onDrained()
        finish(status == 0 ? .success(data) : .failure(RelayScopedStorageFailure.operationFailed))
    }
    func start(arguments: [String], privateHome: String) {
        child.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        child.arguments = arguments; child.standardInput = FileHandle.nullDevice
        child.standardOutput = output; child.standardError = FileHandle.nullDevice
        child.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "HOME": privateHome]
        output.fileHandleForReading.readabilityHandler = { [self] handle in
            let part = handle.availableData
            lock.lock()
            let oversized = bytes.count + part.count > 524288
            if part.isEmpty { eof = true } else if !oversized && continuation != nil { bytes.append(part) }
            lock.unlock()
            if oversized { finish(.failure(RelayScopedStorageFailure.uncertain)) }
            if part.isEmpty { handle.readabilityHandler = nil; settle() }
        }
        child.terminationHandler = { [self] process in
            lock.lock(); exited = true; code = process.terminationStatus; lock.unlock(); settle()
        }
        do { try child.run() }
        catch {
            lock.lock(); eof = true; exited = true; lock.unlock()
            output.fileHandleForReading.readabilityHandler = nil; child.terminationHandler = nil
            try? output.fileHandleForReading.close(); onDrained()
            finish(.failure(RelayScopedStorageFailure.toolUnavailable)); return
        }
        // Controller + exact Process callbacks retain undrained commands. The
        // deadline must not retain a drained command's Files/flock for 120s.
        DispatchQueue.global().asyncAfter(deadline: .now() + 120) { [weak self] in
            self?.finish(.failure(RelayScopedStorageFailure.uncertain))
        }
    }
    static func verifyTool() throws {
        var code: SecStaticCode?, requirement: SecRequirement?
        let path = URL(fileURLWithPath: "/usr/bin/hdiutil")
        try NetworkConfiguration.checkPlainPath(path)
        var info = stat()
        guard lstat(path.path, &info) == 0, info.st_uid == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              info.st_mode & 0o7022 == 0, info.st_mode & 0o111 != 0, info.st_nlink == 1 else { throw RelayScopedStorageFailure.toolUnavailable }
        let text = "anchor apple"
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(path as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess), requirement) == errSecSuccess else {
            throw RelayScopedStorageFailure.toolUnavailable
        }
    }
}
