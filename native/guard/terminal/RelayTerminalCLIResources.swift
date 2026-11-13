import CryptoKit
import Darwin
import Foundation
import Security

enum RelayTerminalCLIResources {
    static let launcherName = "RelayTerminalCLI"
    static let launcherID = "local.relay.network.preview.guard.terminal-cli"
    private static let appID = "local.relay.network.preview"

    enum Failure: Error { case unavailable, terminal, resources, workspace }

    struct Image {
        let application: String
        let node: String
        let script: String
        fileprivate let stamps: [FileStamp]

        func verifyCurrent() throws {
            for stamp in stamps {
                guard try FileStamp(path: stamp.path) == stamp else { throw Failure.resources }
            }
        }
    }

    fileprivate struct FileStamp: Equatable {
        let path: String
        let identity: [Int64]
        let size: Int

        init(path: String, descriptor: Int32? = nil) throws {
            var info = stat()
            let status = descriptor.map { fstat($0, &info) } ?? lstat(path, &info)
            guard status == 0, info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o022 == 0,
                  info.st_uid == 0 || info.st_uid == getuid(), info.st_nlink == 1,
                  info.st_size > 0, info.st_size <= 128 * 1024 * 1024 else { throw Failure.resources }
            self.path = path
            size = Int(info.st_size)
            identity = [Int64(info.st_dev), Int64(bitPattern: UInt64(info.st_ino)),
                        Int64(info.st_mtimespec.tv_sec), Int64(info.st_mtimespec.tv_nsec),
                        Int64(info.st_ctimespec.tv_sec), Int64(info.st_ctimespec.tv_nsec)]
        }
    }

    private struct Process: Equatable {
        let pid: pid_t
        let parent: pid_t
        let uid: uid_t
        let started: UInt64
        let micros: UInt64

        init(_ pid: pid_t) throws {
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
                  info.pbi_pid == UInt32(pid), info.pbi_ppid <= UInt32(Int32.max),
                  (info.pbi_uid == getuid() || info.pbi_uid == 0),
                  info.pbi_ruid == getuid(), info.pbi_start_tvsec > 0 else {
                throw Failure.terminal
            }
            self.pid = pid
            parent = pid_t(info.pbi_ppid)
            uid = info.pbi_uid
            started = info.pbi_start_tvsec
            micros = info.pbi_start_tvusec
        }
    }

    static func verifyTerminalOrigin() throws {
        let requirement = try requirement("anchor apple and identifier \"com.apple.Terminal\"")
        let loginRequirement = try self.requirement("anchor apple and identifier \"com.apple.login\"")
        var chain = [try Process(getpid())]
        for _ in 0..<16 {
            guard let child = chain.last else { throw Failure.terminal }
            let parent = try Process(child.parent)
            guard (parent.started, parent.micros) <= (child.started, child.micros),
                  !chain.contains(where: { $0.pid == parent.pid }) else { throw Failure.terminal }
            chain.append(parent)
            var code: SecCode?
            let resolved = SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: parent.pid] as CFDictionary, [], &code)
            if parent.uid == 0 {
                // Apple's login retains a privileged PAM parent after
                // dropping UID in the child that execs the user's shell.
                var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
                guard proc_pidpath(parent.pid, &path, UInt32(path.count)) > 0,
                      path.withUnsafeBufferPointer({ String(cString: $0.baseAddress!) }) == "/usr/bin/login",
                      resolved == errSecSuccess, let code,
                      SecCodeCheckValidity(code, .noNetworkAccess, loginRequirement) == errSecSuccess else {
                    throw Failure.terminal
                }
            } else if resolved == errSecSuccess, let code,
                      SecCodeCheckValidity(code, .noNetworkAccess, requirement) == errSecSuccess {
                guard try chain.allSatisfy({ try Process($0.pid) == $0 }) else { throw Failure.terminal }
                return
            }
        }
        throw Failure.terminal
    }

    static func load() throws -> Image {
        guard RelayGuardManagementRelease.terminalCLILaunchSupported,
              RelayGuardManagementRelease.scopedCLILaunchSupported,
              let team = RelayGuardManagementRelease.publisherTeamID,
              team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { throw Failure.unavailable }
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard proc_pidpath(getpid(), &path, UInt32(path.count)) > 0,
              let executable = path.withUnsafeBufferPointer({ String(validatingCString: $0.baseAddress!) }) else {
            throw Failure.resources
        }
        let launcher = try physical(executable)
        let suffix = "/Contents/Resources/relay/guard-terminal/" + launcherName
        guard launcher.hasSuffix(suffix) else { throw Failure.resources }
        let app = String(launcher.dropLast(suffix.count))
        guard app.hasSuffix(".app"), let bundle = Bundle(path: app), bundle.bundleIdentifier == appID,
              bundle.infoDictionary?["CFBundleVersion"] as? String == RelayGuardManagementRelease.buildVersion else {
            throw Failure.resources
        }
        let launcherRequirement = try requirement(publisher(launcherID, team))
        var selfCode: SecCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode,
              SecCodeCheckValidity(selfCode, .noNetworkAccess, launcherRequirement) == errSecSuccess else {
            throw Failure.resources
        }
        let appRequirement = try requirement(publisher(appID, team))
        try verifyBundle(app, appRequirement)

        let relay = app + "/Contents/Resources/relay"
        let (terminalManifest, terminalStamp) = try manifest(relay + "/guard-terminal/manifest.json")
        guard Set(terminalManifest.keys) == ["schemaVersion", "contractRevision", "applicationID", "buildVersion",
                                            "minimumMacOS", "launcherName", "launcherID", "publisherTeamID", "runtimeReady", "launcherPin"],
              integer(terminalManifest["schemaVersion"]) == 1, enabled(terminalManifest["runtimeReady"]),
              terminalManifest["contractRevision"] as? String == "relay-guard-terminal-v1",
              terminalManifest["applicationID"] as? String == appID,
              terminalManifest["buildVersion"] as? String == RelayGuardManagementRelease.buildVersion,
              terminalManifest["minimumMacOS"] as? String == "13.0",
              terminalManifest["launcherName"] as? String == launcherName,
              terminalManifest["launcherID"] as? String == launcherID,
              terminalManifest["publisherTeamID"] as? String == team,
              let launcherPin = terminalManifest["launcherPin"] as? [String: Any],
              Set(launcherPin.keys) == ["size", "sha256"],
              let launcherSize = integer(launcherPin["size"]), let launcherHash = launcherPin["sha256"] as? String else {
            throw Failure.resources
        }
        let launcherStamp = try checkHash(launcher, launcherHash)
        guard launcherStamp.size == launcherSize else { throw Failure.resources }

        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x64"
        #endif
        let (cliManifest, cliStamp) = try manifest(relay + "/guard-cli/manifest.json")
        guard Set(cliManifest.keys) == ["schemaVersion", "runtimeReady", "assets"],
              integer(cliManifest["schemaVersion"]) == 1, enabled(cliManifest["runtimeReady"]),
              let assets = cliManifest["assets"] as? [String: Any], Set(assets.keys) == ["arm64", "x64"],
              let pins = assets[arch] as? [String: String], Set(pins.keys) == ["nodeVersion", "nodeSHA256", "cliSHA256"],
              let version = pins["nodeVersion"], version.range(of: "^24\\.(?:[5-9]|[1-9][0-9]+)\\.[0-9]+$", options: .regularExpression) != nil,
              let nodeHash = pins["nodeSHA256"], let cliHash = pins["cliSHA256"] else { throw Failure.resources }
        let dir = relay + "/guard-cli/" + arch
        let node = dir + "/node", script = dir + "/cli.js"
        let nodeStamp = try checkHash(node, nodeHash), scriptStamp = try checkHash(script, cliHash)
        guard access(node, X_OK) == 0 else { throw Failure.resources }
        try verifyBundle(app, appRequirement)
        let result = Image(application: app, node: node, script: script,
                           stamps: [launcherStamp, terminalStamp, cliStamp, nodeStamp, scriptStamp])
        try result.verifyCurrent()
        return result
    }

    static func physical(_ path: String) throws -> String {
        guard path.hasPrefix("/"), let resolved = realpath(path, nil) else { throw Failure.workspace }
        defer { free(resolved) }
        guard let result = String(validatingCString: resolved) else { throw Failure.workspace }
        return result
    }

    private static func publisher(_ identifier: String, _ team: String) -> String {
        "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
    }

    private static func requirement(_ expression: String) throws -> SecRequirement {
        var value: SecRequirement?
        guard SecRequirementCreateWithString(expression as CFString, [], &value) == errSecSuccess, let value else {
            throw Failure.resources
        }
        return value
    }

    private static func verifyBundle(_ path: String, _ requirement: SecRequirement) throws {
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode).union(.noNetworkAccess)
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess,
              let code, SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else {
            throw Failure.resources
        }
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == Double(number.intValue) else { return nil }
        return number.intValue
    }

    private static func enabled(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue
    }

    private static func manifest(_ path: String) throws -> ([String: Any], FileStamp) {
        var bytes = Data()
        let stamp = try read(path, limit: 8192) { bytes.append($0) }
        guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw Failure.resources
        }
        return (value, stamp)
    }

    private static func checkHash(_ path: String, _ expected: String) throws -> FileStamp {
        guard expected.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw Failure.resources }
        var hasher = SHA256()
        let stamp = try read(path, limit: 128 * 1024 * 1024) { hasher.update(data: $0) }
        guard hasher.finalize().map({ String(format: "%02x", $0) }).joined() == expected else { throw Failure.resources }
        return stamp
    }

    private static func read(_ path: String, limit: Int, consume: (Data) -> Void) throws -> FileStamp {
        let descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW_ANY)
        guard descriptor >= 3 else { throw Failure.resources }
        defer { close(descriptor) }
        let before = try FileStamp(path: path, descriptor: descriptor)
        guard before.size <= limit else { throw Failure.resources }
        var total = 0
        var buffer = [UInt8](repeating: 0, count: 128 * 1024)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count == 0 { break }
            if count < 0 && errno == EINTR { continue }
            guard count > 0, count <= before.size - total else { throw Failure.resources }
            total += count
            consume(Data(buffer.prefix(count)))
        }
        guard total == before.size, try FileStamp(path: path, descriptor: descriptor) == before,
              try FileStamp(path: path) == before else { throw Failure.resources }
        return before
    }
}
