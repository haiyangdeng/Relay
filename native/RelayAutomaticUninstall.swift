import Foundation
import CoreFoundation
import Darwin
import Security

/// The administrator-owned Trash intent is the only authorization for this
/// worker. There are no caller-supplied paths, process IDs or root operations.
enum RelayAutomaticUninstall {
    static let installationRoot = URL(fileURLWithPath: "/Library/Application Support/Relay/Uninstall", isDirectory: true)
    static let executableName = "RelayNative"
    struct Manifest: Decodable {
        let version: Int
        let generation: String
        let clientUID: UInt32
        let home: String
        let appPath: String
        let appDevice: UInt64
        let appInode: UInt64
        let nativeSHA256: String
        let supervisorSHA256: String
    }
    struct Intent: Decodable { let version: Int; let generation: String; let clientUID: UInt32; let phase: String }
    struct Status: Encodable { let requested: Bool; let nativeExecutable: String? }
    struct Report: Encodable { let version = 1; let status = "cleaned" }
    struct AuthorityEnvironment {
        let root: URL
        let ancestor: URL
        let owner: uid_t
        let uid: uid_t
        let home: URL
        let applicationAbsent: () -> Bool
        static func live() throws -> Self {
            guard getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { throw AssistantError("自动卸载必须由安装绑定用户执行。") }
            return Self(root: installationRoot, ancestor: URL(fileURLWithPath: "/Library", isDirectory: true), owner: 0,
                        uid: getuid(), home: try RelayBrowserContract.realHome(), applicationAbsent: {
                            var info = stat()
                            return lstat("/Applications/Relay.app", &info) != 0 && errno == ENOENT
                        })
        }
    }
    struct Authorization {
        let environment: AuthorityEnvironment
        let manifest: Manifest
        let manifestBytes: Data
        let intentBytes: Data
        var context: RelayStateContext { RelayStateContext(home: environment.home.path,
            stateRoot: environment.home.appendingPathComponent("Library/Application Support/Relay-Preview").path) }
        func revalidate() throws {
            let current = try RelayAutomaticUninstall.authorize(environment)
            guard current.manifestBytes == manifestBytes, current.intentBytes == intentBytes else { throw AssistantError("自动卸载授权已改变。") }
        }
    }
    private static func failure() -> AssistantError { AssistantError("自动卸载安装记录或文件身份未通过核对。") }
    private static func digestValid(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func trustedDirectories(_ environment: AuthorityEnvironment) throws {
        let root = environment.root, ancestor = environment.ancestor
        guard root.path.hasPrefix(ancestor.path + "/"), NetworkConfiguration.canonicalPath(root) == root.path else { throw failure() }
        var cursor = ancestor
        for component in [""] + String(root.path.dropFirst(ancestor.path.count + 1)).components(separatedBy: "/") {
            if !component.isEmpty { cursor.appendPathComponent(component) }
            var info = stat()
            guard lstat(cursor.path, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  info.st_uid == environment.owner, info.st_mode & 0o022 == 0 else { throw failure() }
        }
    }
    private static func trustedFile(_ name: String, environment: AuthorityEnvironment, maximum: Int, executable: Bool = false) throws -> Data {
        let path = environment.root.appendingPathComponent(name)
        let fd = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw failure() }; defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_uid == environment.owner, before.st_nlink == 1,
              before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), before.st_mode & 0o022 == 0,
              !executable || before.st_mode & 0o111 != 0, before.st_size > 0, before.st_size <= maximum else { throw failure() }
        let bytes = FileHandle(fileDescriptor: fd, closeOnDealloc: false).readData(ofLength: maximum + 1)
        guard bytes.count == before.st_size, fstat(fd, &after) == 0, lstat(path.path, &linked) == 0,
              [after, linked].allSatisfy({ $0.st_dev == before.st_dev && $0.st_ino == before.st_ino && $0.st_uid == before.st_uid &&
                $0.st_mode == before.st_mode && $0.st_nlink == 1 && $0.st_size == before.st_size &&
                $0.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec && $0.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec &&
                $0.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec && $0.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec }) else { throw failure() }
        return bytes
    }
    static func authorize(_ environment: AuthorityEnvironment) throws -> Authorization {
        guard environment.applicationAbsent() else { throw failure() }
        try trustedDirectories(environment)
        let manifestBytes = try trustedFile("installation.json", environment: environment, maximum: 65536)
        let intentBytes = try trustedFile("intent.json", environment: environment, maximum: 4096)
        // Additional version-one installer metadata is permitted, but none can
        // supply cleanup paths or commands to this worker.
        let manifest = try JSONDecoder().decode(Manifest.self, from: manifestBytes)
        let intent = try JSONDecoder().decode(Intent.self, from: intentBytes)
        guard manifest.version == 1, intent.version == 1, UUID(uuidString: manifest.generation) != nil,
              manifest.generation == intent.generation, manifest.clientUID == environment.uid, intent.clientUID == environment.uid,
              environment.uid > 0, manifest.home == environment.home.path, manifest.appPath == "/Applications/Relay.app",
              manifest.appInode > 0, digestValid(manifest.nativeSHA256), digestValid(manifest.supervisorSHA256), intent.phase == "requested",
              NetworkConfiguration.digest(try trustedFile(executableName, environment: environment, maximum: 134217728, executable: true)) == manifest.nativeSHA256 else { throw failure() }
        return Authorization(environment: environment, manifest: manifest, manifestBytes: manifestBytes, intentBytes: intentBytes)
    }
    static func status(_ environment: AuthorityEnvironment) -> Status {
        guard (try? authorize(environment)) != nil else { return Status(requested: false, nativeExecutable: nil) }
        return Status(requested: true, nativeExecutable: environment.root.appendingPathComponent(executableName).path)
    }
    // Namespace roots only. Shared client files and other applications' data
    // are never recursive-delete targets. Recovery evidence is removed last.
    static let cleanupPaths = [
        "Library/LaunchAgents/local.relay.network.login.plist",
        "Library/Caches/Relay-Preview",
        "Library/Caches/local.relay.network.preview",
        "Library/HTTPStorages/local.relay.network.preview",
        "Library/HTTPStorages/local.relay.network.preview.binarycookies",
        "Library/Saved Application State/local.relay.network.preview.savedState",
        "Library/Preferences/local.relay.network.preview.plist",
        "Library/Logs/Relay",
        "Library/Caches/local.relay.browser",
        "Library/HTTPStorages/local.relay.browser",
        "Library/HTTPStorages/local.relay.browser.binarycookies",
        "Library/Saved Application State/local.relay.browser.savedState",
        "Library/Preferences/local.relay.browser.plist",
        "Library/Application Support/Relay-ScopedCLI",
        "Library/Application Support/Relay-Preview"
    ]
    struct CleanupEnvironment {
        let assertAuthorized: () throws -> Void
        let restoreProxy: () throws -> Void
        let restoreDesktop: () async throws -> Void
        let retireCore: () throws -> Void
        let restoreClients: () throws -> Void
        let assertIdle: () throws -> Void
        let clearPreferences: () throws -> Void
        let removeCredentials: () throws -> Void
        let removeTemporaryLease: () throws -> Void
        let remove: (String) throws -> Void
    }
    @MainActor static func cleanup(_ environment: CleanupEnvironment) async throws -> Report {
        try environment.assertAuthorized()
        try environment.assertIdle()
        try environment.restoreProxy()
        try environment.assertAuthorized()
        try await environment.restoreDesktop()
        try environment.retireCore()
        try environment.restoreClients()
        try environment.assertIdle()
        try environment.assertAuthorized()
        try environment.clearPreferences()
        try environment.assertAuthorized()
        try environment.removeCredentials()
        try environment.removeTemporaryLease()
        for relative in cleanupPaths {
            try environment.assertAuthorized()
            try environment.remove(relative)
        }
        return Report()
    }
    static func restoreProxy(_ context: RelayStateContext) throws {
        let active = URL(fileURLWithPath: context.stateRoot).appendingPathComponent("SystemProxy/active.json")
        guard try exists(active) else { return }
        func request(_ action: String, _ revision: String? = nil) -> RelaySystemProxy.Input {
            RelaySystemProxy.Input(context: context, action: action, settings: nil, expectedRevision: revision)
        }
        let inspected = try RelaySystemProxy.perform(request("inspect"))
        if inspected.recordID == nil { return }
        guard inspected.canRestore || inspected.canRetireDetached else { throw AssistantError("系统代理仍有未恢复的Relay引用，保留恢复记录。") }
        _ = try RelaySystemProxy.perform(request(inspected.canRetireDetached ? "retireDetached" : "restore", inspected.revision))
        guard try RelaySystemProxy.perform(request("inspect")).recordID == nil else { throw AssistantError("系统代理恢复未完成。") }
    }
    @MainActor static func restoreDesktop(_ context: RelayStateContext) async throws {
        guard try exists(URL(fileURLWithPath: context.stateRoot).appendingPathComponent("Desktop Login/state.json")) else { return }
        let session = RelayDesktopSession(store: try RelayDesktopStore(context), environment: RelayDesktopLive.environment())
        let result = await session.restore()
        guard !result.hasRecord, result.canClose, result.phase == "idle" else { throw AssistantError("Relay默认浏览器恢复未完成，保留恢复记录。") }
    }
    static func retireCore(_ context: RelayStateContext) throws {
        let report = try RelayCoreRecovery.perform(.init(action: .inspect, context: context, expectedRevision: nil))
        if report.status == "clear" { return }
        guard report.canArchive, let revision = report.revision else { throw AssistantError("Relay核心尚未确认退出，保留会话记录。") }
        guard try RelayCoreRecovery.perform(.init(action: .archive, context: context, expectedRevision: revision)).status == "archived" else { throw failure() }
    }
    static func restoreClients(_ context: RelayStateContext, browserObservation: ((URL) -> String)? = nil) throws {
        let paths = try RelayPreferenceStore(context)
        let inventory = paths.transactionBackend().backupMetadata()
        guard inventory.complete, ["readable", "missing"].contains(inventory.availability) else { throw AssistantError("Relay配置恢复清单不完整，保留原始记录。") }
        for entry in inventory.entries where !["restored", "rolledBack"].contains(entry.phase) {
            guard entry.version == 2 else { throw AssistantError("旧版配置记录缺少自动恢复凭据，保留原状。") }
            let selection = RelayRecoverySelection(source: "relay", id: entry.id)
            if try exists(paths.root.appendingPathComponent("Backups/" + selection.id + "/.automatic-uninstall.json")) {
                try restoreClientFields(paths, selection: selection); continue
            }
            let report = try RelayRecoveryInspector.inspect(.init(context: context, selection: selection), browserObservation: browserObservation)
            guard !report.issues.contains("manifestInvalid"), !report.issues.contains("targetOutsideScope") else { throw failure() }
            if report.issues.isEmpty {
                _ = try RelayRestore.execute(.init(context: context, selection: selection, expectedRevision: report.revision, allowLegacy: false), browserObservation: browserObservation)
            } else {
                // Private preferences/browser files are about to be removed.
                // An unrelated client edit must not prevent owned-field cleanup.
                try restoreClientFields(paths, selection: selection)
            }
        }
    }
    private static func restoreClientFields(_ paths: RelayPreferenceStore, selection: RelayRecoverySelection) throws {
        let backupRoot = paths.root.appendingPathComponent("Backups"), directory = backupRoot.appendingPathComponent(selection.id)
        let manifestPath = directory.appendingPathComponent("manifest.json"), marker = directory.appendingPathComponent(".automatic-uninstall.json")
        try RelayStateLock(root: paths.root).withLock {
            let lockPath = backupRoot.appendingPathComponent(".transaction.lock")
            let fd = Darwin.open(lockPath.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw failure() }; defer { Darwin.close(fd) }
            var lock = stat()
            guard fstat(fd, &lock) == 0, lock.st_uid == getuid(), lock.st_nlink == 1,
                  lock.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), lock.st_mode & 0o7777 == 0o600,
                  flock(fd, LOCK_EX | LOCK_NB) == 0,
                  let captured = try RelayRecoveryInspector.read(manifestPath, limit: 1048576) else { throw failure() }
            let digest = NetworkConfiguration.digest(captured.data)
            if let saved = try RelayRecoveryInspector.read(marker, limit: 4096) {
                let object = try NetworkConfiguration.json(saved.data)
                guard saved.mode == 0o600, Set(object.keys) == ["version", "manifestSHA256"],
                      RelayCoreRecovery.integer(object["version"]) == 1, object["manifestSHA256"] as? String == digest else { throw failure() }
                return
            }
            let manifest = try JSONDecoder().decode(BackupManifest.self, from: captured.data)
            guard manifest.version == 2, (1...4).contains(manifest.entries.count) else { throw failure() }
            let allowed = [paths.home.appendingPathComponent(".claude/settings.json").path, paths.preferenceURL.path,
                paths.root.appendingPathComponent("Private Browser/Local State").path,
                paths.root.appendingPathComponent("Private Browser/Default/Preferences").path]
            guard Set(manifest.entries.map(\.path)).count == manifest.entries.count,
                  manifest.entries.allSatisfy({ allowed.contains($0.path) && digestValid($0.installedDigest) }) else { throw failure() }
            for (index, entry) in manifest.entries.enumerated() where entry.path == allowed[0] {
                guard entry.backupName == "original-\(index).bin", (0...0o777).contains(entry.originalMode) else { throw failure() }
                let original: Data?
                if entry.originalExists {
                    guard let saved = try RelayRecoveryInspector.read(directory.appendingPathComponent(entry.backupName)),
                          entry.originalDigest == NetworkConfiguration.digest(saved.data) else { throw failure() }
                    original = saved.data
                } else { guard entry.originalDigest == nil else { throw failure() }; original = nil }
                let target = URL(fileURLWithPath: entry.path), current = try RelayRecoveryInspector.read(target)
                // Deleting or replacing the client file is itself an external
                // change. Never recreate a file the user has already removed.
                guard let current else { continue }
                if current.data == original { continue }
                var next: Data?, mode = current.mode
                if NetworkConfiguration.digest(current.data) == entry.installedDigest, current.mode == entry.installedMode {
                    next = original; mode = entry.originalMode
                } else {
                    guard let currentJSON = try? NetworkConfiguration.json(current.data),
                          currentJSON["env"] == nil || currentJSON["env"] is [String: Any] else { continue }
                    let originalJSON = try original.map(NetworkConfiguration.json) ?? [:]
                    guard originalJSON["env"] == nil || originalJSON["env"] is [String: Any] else { throw failure() }
                    let before = originalJSON["env"] as? [String: Any] ?? [:], now = currentJSON["env"] as? [String: Any] ?? [:]
                    guard let installed = try installedEnvironment(entry, original: originalJSON, current: now, paths: paths) else {
                        if NetworkConfiguration.claudeEnvironmentKeys.contains(where: { (now[$0] as? String).map(relayResourceReference) == true }) {
                            throw AssistantError("旧版客户端记录仍有无法核对的Relay字段，保留恢复凭据。")
                        }
                        continue
                    }
                    var changed = now, result = currentJSON
                    for key in NetworkConfiguration.claudeEnvironmentKeys where now[key] as? String == installed[key] {
                        if let value = before[key] { changed[key] = value } else { changed.removeValue(forKey: key) }
                    }
                    if changed.isEmpty, originalJSON["env"] == nil { result.removeValue(forKey: "env") }
                    else { result["env"] = changed }
                    guard !NSDictionary(dictionary: result).isEqual(to: currentJSON) else { continue }
                    next = try NetworkConfiguration.encode(result)
                }
                let latest = try RelayRecoveryInspector.read(target)
                guard latest?.data == current.data, latest?.mode == current.mode,
                      try RelayRecoveryInspector.read(manifestPath, limit: 1048576)?.data == captured.data else { throw failure() }
                if let next { try NetworkConfiguration.safeWrite(next, to: target, mode: mode) }
                else { try FileManager.default.removeItem(at: target) }
            }
            guard try RelayRecoveryInspector.read(manifestPath, limit: 1048576)?.data == captured.data else { throw failure() }
            try NetworkConfiguration.safeWrite(NetworkConfiguration.encode(["version": 1, "manifestSHA256": digest]), to: marker)
            try RelayCoreRecovery.sync(directory)
        }
    }
    private static func relayResourceReference(_ value: String) -> Bool {
        value.contains("/Relay.app/Contents/Resources/relay/") || value.contains("/Relay-Preview/NativeRuntime/")
    }
    private static func relayReference(_ value: String) -> Bool {
        if relayResourceReference(value) { return true }
        guard let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1", let port = url.port else { return false }
        return (1024...65535).contains(port)
    }
    private static func installedEnvironment(_ entry: BackupEntry, original: [String: Any], current: [String: Any], paths: RelayPreferenceStore) throws -> [String: String]? {
        let keys = NetworkConfiguration.claudeEnvironmentKeys, originalEnvironment = original["env"] as? [String: Any] ?? [:]
        func proven(_ fields: [String: String]) throws -> Bool {
            guard Set(fields.keys) == Set(keys) else { return false }
            var object = original, environment = originalEnvironment
            for (key, value) in fields { environment[key] = value }
            object["env"] = environment
            return NetworkConfiguration.digest(try NetworkConfiguration.encode(object)) == entry.installedDigest
        }
        if let fields = entry.installedEnvironment {
            guard try proven(fields) else { throw failure() }; return fields
        }
        // Older manifests contain the installed digest but not the seven
        // values. Recover candidates only when recreating the complete exact
        // old write proves them against that digest.
        let proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
        var proxies = Set(proxyKeys.compactMap { current[$0] as? String }.filter(relayReference))
        var browsers = Set([current["BROWSER"] as? String].compactMap { $0 })
        browsers.insert("/Applications/Relay.app/Contents/Resources/relay/RelayBrowser.app/Contents/MacOS/RelayBrowser")
        var bypasses = Set([current["NO_PROXY"] as? String, current["no_proxy"] as? String].compactMap { $0 })
        let previousBypasses = [originalEnvironment["NO_PROXY"] as? String, originalEnvironment["no_proxy"] as? String].compactMap { $0 }
        if let value = try? NetworkConfiguration.mergedNoProxy(existing: previousBypasses, additions: "") { bypasses.insert(value) }
        if let file = try? RelayRecoveryInspector.read(paths.preferenceURL), let object = try? NetworkConfiguration.json(file.data) {
            if let port = RelayCoreRecovery.integer(object["httpPort"]), (1024...65535).contains(port) { proxies.insert("http://127.0.0.1:\(port)") }
            if let additions = object["internalExceptions"] as? String,
               let value = try? NetworkConfiguration.mergedNoProxy(existing: previousBypasses, additions: additions) { bypasses.insert(value) }
        }
        for proxy in proxies { for browser in browsers { for bypass in bypasses {
            var fields = Dictionary(uniqueKeysWithValues: proxyKeys.map { ($0, proxy) })
            fields["BROWSER"] = browser; fields["NO_PROXY"] = bypass; fields["no_proxy"] = bypass
            if try proven(fields) { return fields }
        } } }
        return nil
    }
    private static func exists(_ url: URL) throws -> Bool {
        var info = stat()
        if lstat(url.path, &info) == 0 { return true }
        guard errno == ENOENT else { throw failure() }; return false
    }
    static func assertIdle(_ context: RelayStateContext) throws {
        let root = URL(fileURLWithPath: context.stateRoot)
        try assertStaleCoreOwner(context)
        try assertScopedCLIIdle(context)
        let core = try RelayCoreRecovery.perform(.init(action: .inspect, context: context, expectedRevision: nil))
        guard core.status == "clear" || core.canArchive else { throw AssistantError("Relay核心尚未确认退出。") }
        let profile = root.appendingPathComponent("Private Browser")
        if try exists(profile), RelayBrowserProcesses.status(profile) != "closed" { throw AssistantError("Relay专用浏览器尚未确认退出。") }
    }
    // The signed CoreOwner recovery executable requires its original Main
    // parent. Reuse its durable schema/ESRCH-only absence rule here solely to
    // retire stopped historical data; this never adopts or signals a process.
    static func assertStaleCoreOwner(_ context: RelayStateContext,
        absent: (pid_t) -> Bool = { Darwin.kill($0, 0) != 0 && errno == ESRCH }) throws {
        let home = URL(fileURLWithPath: context.home), root = URL(fileURLWithPath: context.stateRoot)
        let workspace = root.appendingPathComponent("CoreOwner/.session")
        guard let workspaceInfo = try RelayCoreRecovery.directory(workspace, home: home) else { return }
        guard workspaceInfo.st_mode & 0o7777 == 0o700,
              let file = try RelayRecoveryInspector.read(workspace.appendingPathComponent("owner.json"), limit: 32768), file.mode == 0o600,
              let journal = try JSONSerialization.jsonObject(with: file.data) as? [String: Any] else { throw failure() }
        let mandatory: Set<String> = ["version", "contract", "sessionId", "phase", "owner", "coreLease", "runtime", "controlLost", "detached", "createdAt", "workspaceIdentity", "leaseRaw"]
        guard Set(journal.keys).subtracting(["core", "attachedMain"]) == mandatory,
              RelayCoreRecovery.integer(journal["version"]) == 1, journal["contract"] as? String == "relay-ordinary-core-owner-v1",
              let session = journal["sessionId"] as? String, UUID(uuidString: session) != nil,
              let phase = journal["phase"] as? String, ["starting", "ready", "detachPrepared", "detached", "stopping", "closed", "uncertain"].contains(phase),
              journal["workspaceIdentity"] as? String == "\(workspaceInfo.st_dev):\(workspaceInfo.st_ino)",
              let created = journal["createdAt"] as? String, !created.isEmpty,
              ["controlLost", "detached"].allSatisfy({ (journal[$0] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true }),
              let lease = journal["coreLease"] as? [String: Any], Set(lease.keys) == ["token", "directoryIdentity", "ownerSHA256"],
              lease["token"] as? String == session, let leaseIdentity = lease["directoryIdentity"] as? String, !leaseIdentity.isEmpty,
              let leaseRaw = journal["leaseRaw"] as? String, leaseRaw.utf8.count <= 4096,
              lease["ownerSHA256"] as? String == NetworkConfiguration.digest(Data(leaseRaw.utf8)),
              let runtime = journal["runtime"] as? [String: Any],
              Set(runtime.keys) == ["directory", "socket", "httpPort", "profileId", "sourceSHA256", "configurationSHA256", "mode", "coreResourceSHA256"],
              runtime["directory"] as? String == workspace.path, runtime["socket"] as? String == workspace.appendingPathComponent("api.sock").path,
              let port = RelayCoreRecovery.integer(runtime["httpPort"]), (1024...65535).contains(port), runtime["mode"] as? String == "rule",
              let profile = runtime["profileId"] as? String, UUID(uuidString: profile) != nil,
              ["sourceSHA256", "configurationSHA256", "coreResourceSHA256"].allSatisfy({ (runtime[$0] as? String).map(digestValid) == true }) else { throw failure() }
        func identity(_ raw: Any?) throws -> (pid_t, String, String) {
            guard let value = raw as? [String: Any], Set(value.keys) == ["pid", "uid", "bornSeconds", "bornMicroseconds", "executable", "resourceSHA256", "fileIdentity"],
                  let pid = RelayCoreRecovery.integer(value["pid"]), pid > 1, pid <= Int(Int32.max),
                  RelayCoreRecovery.integer(value["uid"]) == Int(getuid()),
                  let seconds = value["bornSeconds"] as? String, let time = UInt64(seconds), time > 0, String(time) == seconds,
                  let micros = value["bornMicroseconds"] as? String, let micro = UInt64(micros), micro < 1_000_000, String(micro) == micros,
                  let path = value["executable"] as? String, path.hasPrefix("/"), !path.contains("\0"), path.utf8.count <= 4096,
                  let hash = value["resourceSHA256"] as? String, digestValid(hash),
                  let stamp = value["fileIdentity"] as? String, !stamp.isEmpty, stamp.utf8.count <= 512 else { throw failure() }
            return (pid_t(pid), path, hash)
        }
        let owner = try identity(journal["owner"]), core = try identity(journal["core"])
        guard owner.1.hasSuffix("/Contents/Resources/relay/RelayCoreOwner"), core.2 == runtime["coreResourceSHA256"] as? String,
              ["arm64", "x64"].contains(where: { core.1 == URL(fileURLWithPath: owner.1).deletingLastPathComponent().path + "/core/darwin-" + $0 + "/mihomo" }) else { throw failure() }
        if let main = journal["attachedMain"], !(main is NSNull) { _ = try identity(main) }
        let coreLease = root.appendingPathComponent("Core/.session")
        if let info = try RelayCoreRecovery.directory(coreLease, home: home) {
            guard info.st_mode & 0o7777 == 0o700, leaseIdentity == "\(info.st_dev):\(info.st_ino)",
                  try RelayCoreRecovery.read(coreLease.appendingPathComponent("owner.json")) == Data(leaseRaw.utf8) else { throw failure() }
        }
        guard absent(owner.0), absent(core.0),
              try RelayRecoveryInspector.read(workspace.appendingPathComponent("owner.json"), limit: 32768)?.data == file.data else {
            throw AssistantError("Relay核心所有者或核心仍在运行，保留会话记录。")
        }
    }
    static let preferenceDomains = ["local.relay.network.preview", "local.relay.browser"]
    struct PreferenceEnvironment {
        let synchronize: (String) -> Bool
        let keys: (String) throws -> [String]
        let deleteDomain: (String) throws -> Void
        static let live = Self(synchronize: { domain in
            CFPreferencesSynchronize(domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        }, keys: { domain in
            guard let raw = CFPreferencesCopyKeyList(domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { return [] }
            guard let keys = raw as? [String] else { throw failure() }
            return keys
        }, deleteDomain: { domain in
            // Per-key CFPreferences mutations can be pending in cfprefsd even
            // after a local key-list readback. Use the system defaults client
            // for the whole domain and wait for its transaction to finish.
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
            task.arguments = ["delete", domain]
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
            try task.run()
            task.waitUntilExit()
            guard task.terminationReason == .exit, task.terminationStatus == 0 else { throw failure() }
        })
    }
    static func clearPreferences(_ environment: PreferenceEnvironment, assertAuthorized: () throws -> Void) throws {
        for domain in preferenceDomains {
            try assertAuthorized()
            guard environment.synchronize(domain) else { throw AssistantError("Relay系统偏好同步失败，保留卸载进度。") }
            let keys = try environment.keys(domain)
            try assertAuthorized()
            if !keys.isEmpty { try environment.deleteDomain(domain) }
            guard environment.synchronize(domain), try environment.keys(domain).isEmpty else {
                throw AssistantError("Relay系统偏好清理未确认，保留卸载进度。")
            }
        }
    }
    private static func clearPreferences(_ authority: Authorization) throws {
        try clearPreferences(.live, assertAuthorized: {
            try authority.revalidate()
            guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(),
                  authority.environment.uid == getuid(),
                  authority.environment.home.path == (try RelayBrowserContract.realHome()).path else { throw failure() }
            let directory = authority.environment.home.appendingPathComponent("Library/Preferences", isDirectory: true)
            _ = try RelayCoreRecovery.directory(directory, home: authority.environment.home)
            for domain in preferenceDomains {
                let path = directory.appendingPathComponent(domain + ".plist")
                if let file = try RelayRecoveryInspector.read(path) {
                    guard file.mode & 0o022 == 0 else { throw failure() }
                }
            }
        })
    }
    static func removeCredentials() throws {
        // Electron 43 uses app_name + " Safe Storage" / app_name for its
        // generic-password key. Relay fixes app_name to "Relay" at startup.
        // Delete only that exact item; never read/decrypt any credential and
        // never touch Chrome, Claude, Codex or generic Chromium items.
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "Relay Safe Storage",
            kSecAttrAccount: "Relay", kSecUseAuthenticationUI: kSecUseAuthenticationUIFail]
        let result = SecItemDelete(query as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw AssistantError("Relay钥匙串记录删除未完成（\(result)），保留卸载进度。") }
    }
    static func removeTemporaryLease() throws {
        let size = confstr(_CS_DARWIN_USER_TEMP_DIR, nil, 0)
        guard size > 1, size <= 4096 else { throw failure() }
        var value = [CChar](repeating: 0, count: size)
        guard confstr(_CS_DARWIN_USER_TEMP_DIR, &value, value.count) == size,
              let physical = realpath(String(cString: value), nil) else { throw failure() }
        let path = String(cString: physical); free(physical)
        try removeOwnedPath(".rlt1", home: URL(fileURLWithPath: path, isDirectory: true), uid: getuid(), temporary: true)
    }
    static func assertScopedCLIIdle(_ context: RelayStateContext) throws {
        let home = URL(fileURLWithPath: context.home), root = home.appendingPathComponent("Library/Application Support/Relay-ScopedCLI")
        guard try RelayCoreRecovery.directory(root, home: home) != nil else { return }
        var mounts: UnsafeMutablePointer<statfs>?
        let mounted = getmntinfo(&mounts, MNT_NOWAIT)
        guard mounted > 0, let mounts else { throw failure() }
        for index in 0..<Int(mounted) {
            var entry = mounts[index]
            let path = withUnsafePointer(to: &entry.f_mntonname) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) } }
            guard path != root.path, !path.hasPrefix(root.path + "/") else { throw AssistantError("Relay受限CLI私有磁盘仍挂载，保留原件。") }
        }
        let rootNames = try FileManager.default.contentsOfDirectory(atPath: root.path)
        guard Set(rootNames).isSubset(of: ["Sessions", "Retained"]) else { throw failure() }
        var count = 0
        for name in rootNames {
            let collection = root.appendingPathComponent(name)
            guard try RelayCoreRecovery.directory(collection, home: home) != nil else { throw failure() }
            for id in try FileManager.default.contentsOfDirectory(atPath: collection.path) {
                count += 1
                guard UUID(uuidString: id) != nil, count <= 128 else { throw failure() }
                let base = collection.appendingPathComponent(id), storage = base.appendingPathComponent("storage")
                guard try RelayCoreRecovery.directory(storage, home: home) != nil,
                      let headFile = try RelayRecoveryInspector.read(storage.appendingPathComponent("head.json"), limit: 4096),
                      let head = try JSONSerialization.jsonObject(with: headFile.data) as? [String: Any],
                      Set(head.keys) == ["version", "record", "sha256"], RelayCoreRecovery.integer(head["version"]) == 1,
                      let recordName = head["record"] as? String, recordName.hasPrefix("record-"), recordName.hasSuffix(".json"),
                      UUID(uuidString: String(recordName.dropFirst(7).dropLast(5))) != nil,
                      let bytes = try RelayRecoveryInspector.read(storage.appendingPathComponent(recordName), limit: 32768),
                      head["sha256"] as? String == NetworkConfiguration.digest(bytes.data),
                      let record = try JSONSerialization.jsonObject(with: bytes.data) as? [String: Any],
                      RelayCoreRecovery.integer(record["version"]) == 1, record["id"] as? String == id, record["phase"] as? String == "closed",
                      let anchor = record["anchor"] as? [String: Any],
                      let volume = try RelayCoreRecovery.directory(base.appendingPathComponent("volume"), home: home),
                      volume.st_mode & 0o7777 == 0o500, RelayCoreRecovery.integer(anchor["dev"]) == Int(volume.st_dev),
                      RelayCoreRecovery.integer(anchor["ino"]) == Int(volume.st_ino),
                      RelayCoreRecovery.integer(anchor["uid"]) == Int(getuid()), RelayCoreRecovery.integer(anchor["mode"]) == Int(volume.st_mode),
                      try FileManager.default.contentsOfDirectory(atPath: base.appendingPathComponent("volume").path).isEmpty else {
                    throw AssistantError("Relay受限CLI磁盘收尾记录未确认，保留原件。")
                }
            }
        }
    }
    @MainActor static func performUser() async throws -> Report {
        let authority = try authorize(AuthorityEnvironment.live())
        // A copied or replaced App executable cannot execute the privileged
        // coordinator's delegated worker role.
        guard let physical = realpath(CommandLine.arguments[0], nil) else { throw failure() }
        let executable = String(cString: physical); free(physical)
        guard executable == installationRoot.appendingPathComponent(executableName).path else { throw failure() }
        let context = authority.context
        let result = try await cleanup(CleanupEnvironment(assertAuthorized: authority.revalidate,
            restoreProxy: { try restoreProxy(context) }, restoreDesktop: { try await restoreDesktop(context) },
            retireCore: { try retireCore(context) }, restoreClients: { try restoreClients(context) },
            assertIdle: { try assertIdle(context) }, clearPreferences: { try clearPreferences(authority) }, removeCredentials: removeCredentials, removeTemporaryLease: removeTemporaryLease,
            remove: { try removeOwnedPath($0, home: authority.environment.home, uid: authority.environment.uid) }))
        try authority.revalidate()
        for domain in preferenceDomains {
            guard try !exists(authority.environment.home.appendingPathComponent("Library/Preferences/" + domain + ".plist")) else {
                throw AssistantError("Relay 偏好文件仍然存在，保留卸载进度。")
            }
        }
        return result
    }

    /// Descriptor-relative deletion never follows a cache symlink, accepts a
    /// caller-selected root or crosses a filesystem mount. Every parent remains
    /// pinned by its descriptor while its child is checked and unlinked.
    static func removeOwnedPath(_ relative: String, home: URL, uid: uid_t, temporary: Bool = false) throws {
        guard (temporary ? relative == ".rlt1" && home.path.hasPrefix("/private/var/folders/") : cleanupPaths.contains(relative)), NetworkConfiguration.canonicalPath(home) == home.path else { throw failure() }
        let parts = relative.components(separatedBy: "/")
        var parent = Darwin.open(home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw failure() }; defer { Darwin.close(parent) }
        if temporary {
            // The user's temporary directory may have broader permissions.
            // An absent lease needs no deletion; existing leases still require
            // every original directory and deletion check below.
            var opened = stat(), linked = stat(), leaf = stat()
            guard fstat(parent, &opened) == 0, opened.st_uid == uid,
                  opened.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  lstat(home.path, &linked) == 0, linked.st_uid == uid,
                  linked.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  linked.st_dev == opened.st_dev, linked.st_ino == opened.st_ino else { throw failure() }
            if fstatat(parent, ".rlt1", &leaf, AT_SYMLINK_NOFOLLOW) != 0 {
                guard errno == ENOENT else { throw failure() }; return
            }
        }
        func checkedDirectory(_ fd: Int32) throws {
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_uid == uid, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o022 == 0 else { throw failure() }
        }
        try checkedDirectory(parent)
        for component in parts.dropLast() {
            let next = openat(parent, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if next < 0, errno == ENOENT { return }
            guard next >= 0 else { throw failure() }
            do { try checkedDirectory(next) } catch { Darwin.close(next); throw error }
            Darwin.close(parent); parent = next
        }
        var root = stat()
        if fstatat(parent, parts.last!, &root, AT_SYMLINK_NOFOLLOW) != 0 {
            guard errno == ENOENT else { throw failure() }; return
        }
        guard root.st_uid == uid, [mode_t(S_IFREG), mode_t(S_IFDIR)].contains(root.st_mode & mode_t(S_IFMT)) else { throw failure() }
        var count = 0
        func walk(_ directory: Int32, _ name: String, _ depth: Int, removing: Bool) throws {
            count += 1
            guard depth <= 64, count <= 500000 else { throw failure() }
            var before = stat()
            guard fstatat(directory, name, &before, AT_SYMLINK_NOFOLLOW) == 0, before.st_uid == uid, before.st_dev == root.st_dev else { throw failure() }
            let kind = before.st_mode & mode_t(S_IFMT)
            if kind == mode_t(S_IFDIR) {
                let fd = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw failure() }; defer { Darwin.close(fd) }
                try checkedDirectory(fd)
                var actual = stat()
                guard fstat(fd, &actual) == 0, actual.st_dev == before.st_dev, actual.st_ino == before.st_ino else { throw failure() }
                let copy = dup(fd)
                guard copy >= 0 else { throw failure() }
                guard let stream = fdopendir(copy) else { Darwin.close(copy); throw failure() }
                defer { closedir(stream) }
                while true {
                    errno = 0
                    guard let entry = readdir(stream) else { guard errno == 0 else { throw failure() }; break }
                    let child = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                        pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
                    }
                    if child != "." && child != ".." { try walk(fd, child, depth + 1, removing: removing) }
                }
            } else {
                guard [mode_t(S_IFREG), mode_t(S_IFLNK), mode_t(S_IFSOCK)].contains(kind) else { throw failure() }
            }
            if removing {
                var current = stat()
                guard fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
                      current.st_dev == before.st_dev, current.st_ino == before.st_ino, current.st_mode == before.st_mode,
                      unlinkat(directory, name, kind == mode_t(S_IFDIR) ? AT_REMOVEDIR : 0) == 0 else { throw failure() }
            }
        }
        try walk(parent, parts.last!, 0, removing: false)
        count = 0
        try walk(parent, parts.last!, 0, removing: true)
    }
}
