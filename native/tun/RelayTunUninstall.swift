import Foundation
import Darwin

/// All paths and commands are fixed by this network-executor candidate.
/// Neither the ordinary client nor an IPC request can invoke this operation.
struct RelayTunRemovalPlan {
    let clientUID: uid_t
    let pins: [String: String]
    init(trust: RelayTunInstallationTrust) {
        clientUID = trust.clientUID
        pins = [RelayTunInstallationPaths.manifest: trust.revision,
                RelayTunInstallationPaths.launchDaemon: trust.launchDaemonSHA256,
                RelayTunInstallationPaths.helper: trust.helper.sha256,
                RelayTunInstallationPaths.client: trust.client.sha256,
                RelayTunInstallationPaths.uninstaller: trust.uninstaller.sha256,
                RelayTunInstallationPaths.cores["arm64"]!: trust.coreSHA256["arm64"]!,
                RelayTunInstallationPaths.cores["x86_64"]!: trust.coreSHA256["x86_64"]!]
    }
    private init(clientUID: uid_t, pins: [String: String]) { self.clientUID = clientUID; self.pins = pins }
    func intentData() throws -> Data {
        try JSONSerialization.data(withJSONObject: ["version": 1, "role": "network-executor-v1-uninstall", "service": RelayTunInstallationPaths.service, "receiptID": RelayTunInstallationPaths.receiptID, "clientUID": clientUID, "pins": pins], options: [.sortedKeys])
    }
    static func parseIntent(_ data: Data, expectedManifestSHA256: String) throws -> Self {
        let object = try RelayTunStrictJSON.object(data)
        guard Set(object.keys) == ["version", "role", "service", "receiptID", "clientUID", "pins"],
              RelayTunStrictJSON.integer(object["version"]) == 1, object["role"] as? String == "network-executor-v1-uninstall", object["service"] as? String == RelayTunInstallationPaths.service,
              object["receiptID"] as? String == RelayTunInstallationPaths.receiptID, let uid = RelayTunStrictJSON.integer(object["clientUID"]), uid > 0,
              let pins = object["pins"] as? [String: String], Set(pins.keys) == Set(RelayTunInstallationPaths.files),
              pins.values.allSatisfy({ RelayTunHelperTrust.hex($0, count: 64) != nil }),
              RelayTunHelperTrust.hex(expectedManifestSHA256, count: 64) != nil, pins[RelayTunInstallationPaths.manifest] == expectedManifestSHA256,
              pins[RelayTunInstallationPaths.cores["arm64"]!] == RelayTunInstallationPaths.fixedCorePins["arm64"]!.0,
              pins[RelayTunInstallationPaths.cores["x86_64"]!] == RelayTunInstallationPaths.fixedCorePins["x86_64"]!.0 else { throw RelayTunHelperFailure.invalidManifest }
        return .init(clientUID: uid_t(uid), pins: pins)
    }
    static var expectedChildren: [String: Set<String>] {
        [RelayTunInstallationPaths.container: ["Tun"],
         RelayTunInstallationPaths.root: ["Core", "RelayTunClient", "installation.json"],
         RelayTunInstallationPaths.root + "/Core": ["darwin-arm64", "darwin-x64"],
         RelayTunInstallationPaths.root + "/Core/darwin-arm64": ["mihomo"],
         RelayTunInstallationPaths.root + "/Core/darwin-x64": ["mihomo"]]
    }
    static func checkChildren(_ value: [String: Set<String>], allowMissing: Bool = false) throws {
        if !allowMissing { guard value == expectedChildren else { throw RelayTunHelperFailure.unsafeInstallation }; return }
        guard Set(value.keys).isSubset(of: Set(expectedChildren.keys)) else { throw RelayTunHelperFailure.unsafeInstallation }
        for (path, children) in value { guard children.isSubset(of: expectedChildren[path]!) else { throw RelayTunHelperFailure.unsafeInstallation } }
    }
    struct Environment {
        let verify: () throws -> Void
        let jobPresent: () throws -> Bool
        let bootout: () throws -> Void
        let receiptPresent: () throws -> Bool
        let removeFile: (String, String) throws -> Void
        let removeDirectory: (String) throws -> Void
        let forgetReceipt: () throws -> Void
        let otherPathsAbsent: () throws -> Bool
        let removeIntent: () throws -> Void
        let restoreIntent: () throws -> Void
        let allPathsAbsent: () throws -> Bool
        var beforeFinalRemoval: () throws -> Void = {}
    }
    func execute(_ environment: Environment) throws {
        try environment.verify()
        let receipt = try environment.receiptPresent()
        if try environment.jobPresent() {
            try environment.bootout()
            guard try !environment.jobPresent() else { throw RelayTunHelperFailure.unsafeInstallation }
        }
        // Recheck every installation byte and exact directory contents after
        // unregistering our own job and before the first filesystem deletion.
        try environment.verify()
        for path in [RelayTunInstallationPaths.helper, RelayTunInstallationPaths.launchDaemon,
                     RelayTunInstallationPaths.cores["arm64"]!, RelayTunInstallationPaths.cores["x86_64"]!,
                     RelayTunInstallationPaths.client, RelayTunInstallationPaths.manifest] {
            guard let pin = pins[path] else { throw RelayTunHelperFailure.unsafeInstallation }
            try environment.removeFile(path, pin)
        }
        for path in RelayTunInstallationPaths.ownedDirectories.reversed() { try environment.removeDirectory(path) }
        if receipt { try environment.forgetReceipt() }
        guard try environment.otherPathsAbsent(), try !environment.jobPresent(), try !environment.receiptPresent() else { throw RelayTunHelperFailure.unsafeInstallation }
        do {
            try environment.beforeFinalRemoval()
            try environment.removeIntent()
            try environment.removeFile(RelayTunInstallationPaths.uninstaller, pins[RelayTunInstallationPaths.uninstaller]!)
        } catch {
            try environment.restoreIntent()
            throw error
        }
        guard try environment.allPathsAbsent(), try !environment.jobPresent(), try !environment.receiptPresent() else { throw RelayTunHelperFailure.unsafeInstallation }
    }
}

enum RelayTunLoadedJob {
    /// launchctl text is deliberately treated as a closed feasibility format,
    /// not a stable API. Unknown output blocks cleanup rather than guessing.
    static func matches(_ data: Data) -> Bool {
        guard let text = String(data: data, encoding: .utf8) else { return false }
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard lines.first == "system/" + RelayTunInstallationPaths.service + " = {" else { return false }
        var depth = 0, paths: [String] = [], programs: [String] = [], arguments: [String] = [], argumentBlocks = 0, collecting = false
        for line in lines {
            if depth == 1 {
                if line.hasPrefix("path = ") { paths.append(String(line.dropFirst(7))) }
                if line.hasPrefix("program = ") { programs.append(String(line.dropFirst(10))) }
                if line == "arguments = {" { argumentBlocks += 1; collecting = true }
            } else if collecting && depth == 2 && line != "}" { arguments.append(line) }
            if line.hasSuffix("{") { depth += 1 }
            if line == "}" { depth -= 1; if depth == 1 { collecting = false } }
            if depth < 0 { return false }
        }
        return depth == 0 && paths == [RelayTunInstallationPaths.launchDaemon] && programs == [RelayTunInstallationPaths.helper] && argumentBlocks == 1 && arguments == [RelayTunInstallationPaths.helper, "--serve"]
    }
}

enum RelayTunReceiptInventory {
    static func containsCandidate(status: Int32, data: Data) throws -> Bool {
        guard status == 0, let value = String(data: data, encoding: .utf8), !value.contains("\0") else { throw RelayTunHelperFailure.unsafeInstallation }
        let matches = value.split(separator: "\n").filter { $0 == RelayTunInstallationPaths.receiptID }
        guard matches.count <= 1 else { throw RelayTunHelperFailure.unsafeInstallation }
        return matches.count == 1
    }
}

enum RelayTunUninstallLive {
    private enum Command: Equatable {
        case jobStatus, bootout, receiptIDs, receiptInfo, receiptFiles, forget
        var executable: String { [.jobStatus, .bootout].contains(self) ? "/bin/launchctl" : "/usr/sbin/pkgutil" }
        var arguments: [String] {
            switch self {
            case .jobStatus: return ["print", "system/" + RelayTunInstallationPaths.service]
            case .bootout: return ["bootout", "system/" + RelayTunInstallationPaths.service]
            case .receiptIDs: return ["--pkgs"]
            case .receiptInfo: return ["--pkg-info-plist", RelayTunInstallationPaths.receiptID]
            case .receiptFiles: return ["--only-files", "--files", RelayTunInstallationPaths.receiptID]
            case .forget: return ["--forget", RelayTunInstallationPaths.receiptID]
            }
        }
        var captures: Bool { [.jobStatus, .receiptIDs, .receiptInfo, .receiptFiles].contains(self) }
        var maximumOutputBytes: Int { self == .receiptIDs ? 1048576 : 16384 }
    }
    private final class Output {
        private let lock = NSLock()
        private var bytes = Data()
        private var overflow = false
        private let maximumBytes: Int
        init(maximumBytes: Int) { self.maximumBytes = maximumBytes }
        func append(_ data: Data) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard bytes.count + data.count <= maximumBytes else { overflow = true; return false }
            bytes.append(data); return true
        }
        func result() throws -> Data {
            lock.lock(); defer { lock.unlock() }
            guard !overflow else { throw RelayTunHelperFailure.unsafeInstallation }; return bytes
        }
    }
    private static func run(_ command: Command) throws -> (Int32, Data) {
        let process = Process(), ended = DispatchSemaphore(value: 0), readEnded = DispatchSemaphore(value: 0), output = Output(maximumBytes: command.maximumOutputBytes)
        process.executableURL = URL(fileURLWithPath: command.executable)
        process.arguments = command.arguments
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C"]
        process.currentDirectoryURL = URL(fileURLWithPath: "/", isDirectory: true)
        process.standardError = FileHandle.nullDevice
        let pipe = command.captures ? Pipe() : nil
        if let pipe { process.standardOutput = pipe } else { process.standardOutput = FileHandle.nullDevice }
        process.terminationHandler = { _ in ended.signal() }
        try process.run()
        if let pipe {
            try pipe.fileHandleForWriting.close()
            DispatchQueue.global().async {
                defer { try? pipe.fileHandleForReading.close(); readEnded.signal() }
                while true {
                    let part = pipe.fileHandleForReading.readData(ofLength: 4096)
                    if part.isEmpty { return }
                    if !output.append(part) { if process.isRunning { process.terminate() }; return }
                }
            }
        } else { readEnded.signal() }
        guard ended.wait(timeout: .now() + 15) == .success else { if process.isRunning { process.terminate() }; throw RelayTunHelperFailure.unsafeInstallation }
        guard readEnded.wait(timeout: .now() + 3) == .success, process.terminationReason == .exit else { throw RelayTunHelperFailure.unsafeInstallation }
        return (process.terminationStatus, try output.result())
    }
    private static func jobPresent() throws -> Bool {
        let (status, data) = try run(.jobStatus)
        guard [0, 113].contains(status), status != 0 || RelayTunLoadedJob.matches(data) else { throw RelayTunHelperFailure.unsafeInstallation }; return status == 0
    }
    private static func receiptPresent() throws -> Bool {
        let (status, bytes) = try run(.receiptIDs)
        guard try RelayTunReceiptInventory.containsCandidate(status: status, data: bytes) else { return false }
        let (infoStatus, infoBytes) = try run(.receiptInfo), (filesStatus, fileBytes) = try run(.receiptFiles)
        guard infoStatus == 0, filesStatus == 0,
              let info = try PropertyListSerialization.propertyList(from: infoBytes, options: [], format: nil) as? [String: Any],
              info["pkgid"] as? String == RelayTunInstallationPaths.receiptID, info["pkg-version"] as? String == RelayTunInstallationPaths.packageVersion,
              info["volume"] as? String == "/", ["", "/"].contains(info["install-location"] as? String ?? "invalid"),
              let fileText = String(data: fileBytes, encoding: .utf8),
              Set(fileText.split(separator: "\n").map(String.init)) == Set(RelayTunInstallationPaths.payloadFiles.map { String($0.dropFirst()) }) else { throw RelayTunHelperFailure.unsafeInstallation }
        return true
    }
    private static func tree(allowMissing: Bool) throws {
        var children: [String: Set<String>] = [:]
        for path in RelayTunInstallationPaths.ownedDirectories {
            var info = stat()
            if lstat(path, &info) != 0 { guard allowMissing && errno == ENOENT else { throw RelayTunHelperFailure.unsafeInstallation }; continue }
            let mode = info.st_mode & 0o7777
            guard info.st_uid == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), [0o755, 0o750, 0o700].contains(mode), allowMissing || mode == 0o755 else { throw RelayTunHelperFailure.unsafeInstallation }
            children[path] = Set(try FileManager.default.contentsOfDirectory(atPath: path))
        }
        try RelayTunRemovalPlan.checkChildren(children, allowMissing: allowMissing)
    }
    private static func pathsAbsent(includeUninstaller: Bool, includeIntent: Bool) throws -> Bool {
        let files = RelayTunInstallationPaths.files.filter { includeUninstaller || $0 != RelayTunInstallationPaths.uninstaller }
        for path in files + RelayTunInstallationPaths.ownedDirectories + (includeIntent ? [RelayTunInstallationPaths.uninstallIntent] : []) {
            var info = stat()
            if lstat(path, &info) == 0 { return false }
            guard errno == ENOENT else { throw RelayTunHelperFailure.unsafeInstallation }
        }
        return true
    }
    private static func syncParent() throws {
        let directory = Darwin.open("/Library/PrivilegedHelperTools", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        defer { Darwin.close(directory) }
        var info = stat()
        guard fstat(directory, &info) == 0, info.st_uid == 0, info.st_mode & 0o6022 == 0, fsync(directory) == 0 else { throw RelayTunHelperFailure.unsafeInstallation }
    }
    private static func saveIntent(_ data: Data) throws {
        let path = RelayTunInstallationPaths.uninstallIntent
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        defer { Darwin.close(descriptor) }
        var identity = stat()
        guard fstat(descriptor, &identity) == 0, identity.st_uid == 0, identity.st_nlink == 1, identity.st_mode & 0o7777 == 0o600 else { throw RelayTunHelperFailure.unsafeInstallation }
        do {
            try data.withUnsafeBytes { buffer in
                var offset = 0
                while offset < data.count {
                    let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), data.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw RelayTunHelperFailure.unsafeInstallation }; offset += count
                }
            }
            guard fsync(descriptor) == 0 else { throw RelayTunHelperFailure.unsafeInstallation }
            try syncParent()
        } catch {
            // Only our just-created inode may be retired after an ordinary
            // write failure. Crash residue is preserved for explicit audit.
            var linked = stat()
            if lstat(path, &linked) == 0, linked.st_dev == identity.st_dev, linked.st_ino == identity.st_ino, linked.st_uid == 0, linked.st_nlink == 1 { _ = unlink(path); try? syncParent() }
            throw error
        }
    }
    static func remove(expectedManifestSHA256: String) throws {
        guard getuid() == 0, geteuid() == 0, getgid() == 0, getegid() == 0 else { throw RelayTunHelperFailure.untrustedPeer }
        guard RelayTunHelperTrust.hex(expectedManifestSHA256, count: 64) != nil else { throw RelayTunHelperFailure.invalidRequest }
        let plan: RelayTunRemovalPlan
        if let existing = try RelayTunHelperTrust.removalIntentIfPresent() {
            plan = try RelayTunRemovalPlan.parseIntent(existing, expectedManifestSHA256: expectedManifestSHA256)
        } else {
            let trust = try RelayTunInstallationTrust.load()
            guard trust.revision == expectedManifestSHA256 else { throw RelayTunHelperFailure.changedResource }
            plan = .init(trust: trust)
            _ = try receiptPresent(); _ = try jobPresent()
            try saveIntent(plan.intentData())
        }
        try RelayTunUninstallFence.withRemoval(manifestSHA256: expectedManifestSHA256) { retireFence in
            // Exclusive operation lock prevents a new acquisition between
            // this exact empty-journal check and removal of the fixed job.
            try RelayTunJournalArchive.verifyLiveEmpty()
            _ = try RelayTunJournalArchive.verifyPreserved()
            try RelayTunJournalArchive.removeEmptyLiveRoots()
            try plan.execute(environment(plan: plan, retireFence: retireFence))
        }
    }
    static func verifyRecovery(expectedManifestSHA256: String) throws {
        guard let raw = try RelayTunHelperTrust.removalIntentIfPresent() else { throw RelayTunHelperFailure.unsafeInstallation }
        let plan = try RelayTunRemovalPlan.parseIntent(raw, expectedManifestSHA256: expectedManifestSHA256)
        guard try RelayTunHelperTrust.runningUninstallerDigest() == plan.pins[RelayTunInstallationPaths.uninstaller] else { throw RelayTunHelperFailure.changedResource }
        for path in [RelayTunInstallationPaths.uninstaller, RelayTunInstallationPaths.uninstallIntent] {
            let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            guard descriptor >= 0 else { throw RelayTunHelperFailure.unsafeInstallation }
            defer { Darwin.close(descriptor) }
            var info = stat()
            guard fstat(descriptor, &info) == 0, info.st_uid == 0, info.st_nlink == 1, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), fsync(descriptor) == 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        }
        try syncParent()
    }
    private static func environment(plan: RelayTunRemovalPlan, retireFence: @escaping () throws -> Void) throws -> RelayTunRemovalPlan.Environment {
        let intentData = try plan.intentData()
        func sameIntent() throws -> Bool {
            guard let raw = try RelayTunHelperTrust.removalIntentIfPresent() else { return false }
            let current = try RelayTunRemovalPlan.parseIntent(raw, expectedManifestSHA256: plan.pins[RelayTunInstallationPaths.manifest]!)
            return current.clientUID == plan.clientUID && current.pins == plan.pins
        }
        return .init(verify: {
            guard try sameIntent(),
                  try RelayTunHelperTrust.runningUninstallerDigest() == plan.pins[RelayTunInstallationPaths.uninstaller] else { throw RelayTunHelperFailure.changedResource }
            for (path, expected) in plan.pins {
                if let actual = try RelayTunHelperTrust.candidateDigestIfPresent(path), actual != expected { throw RelayTunHelperFailure.changedResource }
            }
            try tree(allowMissing: true)
            try RelayTunJournalArchive.verifyLiveEmpty()
            _ = try RelayTunJournalArchive.verifyPreserved()
        }, jobPresent: jobPresent, bootout: {
            guard try run(.bootout).0 == 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        }, receiptPresent: receiptPresent, removeFile: { path, pin in
            guard let current = try RelayTunHelperTrust.candidateDigestIfPresent(path) else { return }
            guard current == pin else { throw RelayTunHelperFailure.changedResource }
            try RelayTunHelperTrust.verifyCandidateFile(path, sha256: pin)
            guard unlink(path) == 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        }, removeDirectory: { path in
            guard RelayTunInstallationPaths.ownedDirectories.contains(path) else { throw RelayTunHelperFailure.unsafeInstallation }
            if rmdir(path) != 0 { guard errno == ENOENT else { throw RelayTunHelperFailure.unsafeInstallation } }
        }, forgetReceipt: {
            guard try run(.forget).0 == 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        }, otherPathsAbsent: { try pathsAbsent(includeUninstaller: false, includeIntent: false) }, removeIntent: {
            guard try sameIntent(),
                  unlink(RelayTunInstallationPaths.uninstallIntent) == 0 else { throw RelayTunHelperFailure.changedResource }
            try syncParent()
        }, restoreIntent: {
            if try RelayTunHelperTrust.removalIntentIfPresent() != nil { guard try sameIntent() else { throw RelayTunHelperFailure.changedResource } }
            else { try saveIntent(intentData) }
        }, allPathsAbsent: { try pathsAbsent(includeUninstaller: true, includeIntent: true) }, beforeFinalRemoval: retireFence)
    }
}
