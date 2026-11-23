import Foundation
import CryptoKit
import Darwin

/// Trusted-main private bundle handoff. No renderer path or executable enters
/// this type. Even a main-owned source must pass exact metadata/hash checks;
/// the native core only sees a new private copy owned by this invocation.
final class RelayTunAppBundle {
    typealias ProviderModel = RelayTunRuntimeRuleProviders
    enum Failure: Error { case invalid, changed, conflict, resourceUncertain }
    struct Binding {
        let sessionId: String
        let evidenceSHA256: String
        let runtimeConfigurationSHA256: String
        var json: [String: Any] { ["sessionId": sessionId, "evidenceSHA256": evidenceSHA256,
            "runtimeConfigurationSHA256": runtimeConfigurationSHA256] }
    }
    struct Asset { let path: String; let sha256: String; let expectedRules: Int? }
    // ClientMain supplies a verified execution-v2 installation snapshot. The
    // launch factory independently reloads that identity before taking the lock.
    struct ExecutionContext {
        let core: RelayTunExecutionReceiptV2.CoreIdentity
        let installationRevision: String
        let receivedAtMS: Int64
        let receivedTickMS: UInt64
        init(core: RelayTunExecutionReceiptV2.CoreIdentity, installationRevision: String, receivedAtMS: Int64,
             receivedTickMS: UInt64 = DispatchTime.now().uptimeNanoseconds / 1_000_000) {
            self.core = core; self.installationRevision = installationRevision
            self.receivedAtMS = receivedAtMS; self.receivedTickMS = receivedTickMS
        }
    }
    private(set) var executionReceipt: RelayTunExecutionReceiptV2.Validated?
    private var executionSourceHandle: FileHandle?
    private var executionFileHandle: FileHandle?
    private var executionFileIdentity: stat?
    private var executionReceivedAtMS: Int64?
    private var executionReceivedTickMS: UInt64?
    static let maximumBootstrapBytes = 262144
    private static let maximumAssetBytes = 128 * 1024 * 1024
    private static let maximumTotalBytes = 256 * 1024 * 1024
    let binding: Binding
    let configurationSHA256: String
    let bundleSHA256: String
    let configuration: Data
    let projection: RelayTunNetworkProjection?
    let coreManaged: Bool
    let installationRevision: String?
    let baseline: RelayTunNetworkTransaction.Baseline
    let directory: String
    let managedMTU: Int
    let resourcesEnabled: Bool
    let ruleProvidersEnabled: Bool
    private(set) var ruleProviderLedger: ProviderModel.Ledger?
    private(set) var ruleProviderFiles: RelayTunRuntimeRuleProviderFiles?
    private(set) var ruleProviderIsolated = false
    private var providerOperation: (selection: ProviderModel.Selection, previous: ProviderModel.Ledger)?
    private var providerInlineCounts = [String: Int]()
    private var providerPaths = Set<String>()
    private(set) var resourceInbox: RelayTunRuntimeResourceInbox?
    private(set) var resourceLedger: RelayTunRuntimeResources.Ledger?
    private(set) var resourceIsolated = false
    private var resourceTransition: RelayTunRuntimeResources.Selection?
    private var resourcePostimage: (RelayTunRuntimeResources.Ledger, [String: (stat, String)])?
    private var directoryFD: Int32 = -1
    private let source: String
    private let sourceIdentity: stat
    private let directoryIdentity: stat
    private let assets: [Asset]
    private var inventories: [String: (stat, String)] = [:]
    private var removed = false
    private var cleanupSnapshot: [String: stat]?
    private var cleanupHashes = [String: String]()
    private var cleanupDirectories = Set<String>()
    private var deleted = Set<String>()
    private var recoveryRecord: (directory: stat, file: stat, sha256: String)?
    private var releaseRecord: (directory: stat, file: stat, sha256: String)?
    private let smartSourceLock = NSLock()
    private(set) var smartStateFiles: RelayTunSmartStateFiles?
    private(set) var smartStateHandoff: RelayTunSmartStateHandoff?
    private var smartOtherEntries: [RelayTunSmartStateFiles.KnownCoreEntry] = []
    private var smartSocket: RelayTunSmartStateFiles.KnownCoreEntry?
    var smartStateEnabled: Bool { executionReceipt?.core.profile == .smart }
    #if RELAY_TUN_APP_SESSION_TESTS
    var beforeSmartStateCaptureForTest: (() throws -> Void)?
    var afterSmartStateCaptureForTest: (() -> Void)?
    #endif
    #if RELAY_TUN_APP_BUNDLE_TESTS
    var afterRemovalForTest: (() throws -> Void)?
    #endif
    static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private static func hash(_ raw: Any?) throws -> String {
        guard let value = RelayTunHelperTrust.hex(raw, count: 64) else { throw Failure.invalid }; return value
    }
    private static func plainDirectory(_ path: String) throws -> stat {
        guard path.hasPrefix("/"), !path.contains("\0"), let physical = realpath(path, nil) else { throw Failure.invalid }
        defer { free(physical) }
        guard String(cString: physical) == path else { throw Failure.invalid }
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: path))
        var info = stat()
        guard lstat(path, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else { throw Failure.invalid }
        return info
    }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_mode == b.st_mode &&
        a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
        a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private static func relative(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf8.count <= 256, !path.hasPrefix("/"), !path.contains("\0") else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 95].contains($0) }
        }
    }
    private static func read(_ path: String, maximum: Int, held: (parent: Int32, file: Int32)? = nil) throws -> (Data, stat) {
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: path))
        let fd = held?.file ?? open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw Failure.invalid }; defer { if held == nil { Darwin.close(fd) } }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              before.st_uid == getuid(), before.st_mode & 0o7777 == 0o600, before.st_nlink == 1,
              before.st_size >= 0, before.st_size <= maximum else { throw Failure.invalid }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536), offset: off_t = 0
        while true {
            // pread leaves the retained file description's offset unchanged.
            let count = Darwin.pread(fd, &buffer, buffer.count, offset)
            if count < 0, errno == EINTR { continue }
            guard count >= 0, data.count + max(0, count) <= maximum else { throw Failure.invalid }
            if count == 0 { break }; data.append(contentsOf: buffer.prefix(count)); offset += off_t(count)
        }
        let linkedResult = held.map { fstatat($0.parent, "execution.json", &linked, AT_SYMLINK_NOFOLLOW) } ?? lstat(path, &linked)
        guard fstat(fd, &after) == 0, linkedResult == 0, same(before, after), same(after, linked), data.count == before.st_size else { throw Failure.changed }
        return (data, after)
    }
    private static func write(_ bytes: Data, path: String) throws -> stat {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.conflict }; defer { Darwin.close(fd) }
        guard fchmod(fd, 0o600) == 0 else { throw Failure.invalid }
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw Failure.invalid }; offset += count
            }
        }
        var info = stat(); guard fsync(fd) == 0, fstat(fd, &info) == 0 else { throw Failure.invalid }; return info
    }
    init(_ bytes: Data, resourcesEnabled: Bool = false, ruleProvidersEnabled: Bool = false,
         executionContext: ExecutionContext? = nil) throws {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { throw Failure.invalid }
        let raw = try RelayTunStrictJSON.object(bytes, limit: Self.maximumBootstrapBytes)
        let version = RelayTunStrictJSON.integer(raw["version"])
        let executionV2 = version == 3
        guard executionV2 == (executionContext != nil),
              !executionV2 || (!resourcesEnabled && !ruleProvidersEnabled) else { throw Failure.invalid }
        coreManaged = version == 2 || executionV2
        self.resourcesEnabled = resourcesEnabled
        self.ruleProvidersEnabled = ruleProvidersEnabled
        guard !ruleProvidersEnabled || resourcesEnabled else { throw Failure.invalid }
        let common: Set<String> = ["version", "action", "controlLossPolicy", "binding", "configurationSHA256", "bundleSHA256", "configurationPath", "directory", "assets", "pins", "baseline"]
        let keys = common.union(coreManaged ? ["installationRevision"] : ["projection", "managedMTU"])
            .union(resourcesEnabled ? ["resourceInboxRoot"] : [])
            .union(executionV2 ? ["executionPath", "executionSHA256"] : [])
        guard Set(raw.keys) == keys, version == 1 || version == 2 || executionV2,
              !resourcesEnabled || coreManaged,
              raw["action"] as? String == "bootstrap", raw["controlLossPolicy"] as? String == "restore-owned-session",
              raw["configurationPath"] as? String == "config.json",
              let bound = raw["binding"] as? [String: Any], Set(bound.keys) == ["sessionId", "evidenceSHA256", "runtimeConfigurationSHA256"],
              let session = bound["sessionId"] as? String, UUID(uuidString: session)?.uuidString.lowercased() == session,
              let source = raw["directory"] as? String,
              let items = raw["assets"] as? [[String: Any]], items.count <= 200,
              let pins = raw["pins"] as? [[String: Any]], pins.count <= 200,
              let baseline = raw["baseline"] as? [String: Any], Set(baseline.keys) == ["networkSHA256", "protectionSHA256"] else { throw Failure.invalid }
        binding = try .init(sessionId: session, evidenceSHA256: Self.hash(bound["evidenceSHA256"]), runtimeConfigurationSHA256: Self.hash(bound["runtimeConfigurationSHA256"]))
        configurationSHA256 = try Self.hash(raw["configurationSHA256"]); bundleSHA256 = try Self.hash(raw["bundleSHA256"])
        if coreManaged {
            projection = nil; managedMTU = 0
            installationRevision = try Self.hash(raw["installationRevision"])
            if let executionContext {
                guard installationRevision == executionContext.installationRevision else { throw Failure.changed }
            }
        } else {
            guard let encoded = raw["projection"] as? String,
                  let mtu = RelayTunStrictJSON.integer(raw["managedMTU"]), (1280...65535).contains(mtu) else { throw Failure.invalid }
            let decoded = try RelayTunNetworkProjection.decode(Data(encoded.utf8))
            guard decoded.encoded() == Data(encoded.utf8), decoded.mtu == mtu else { throw Failure.invalid }
            projection = decoded; managedMTU = mtu; installationRevision = nil
        }
        self.baseline = try .init(networkSHA256: Self.hash(baseline["networkSHA256"]), protectionSHA256: Self.hash(baseline["protectionSHA256"]))
        self.source = source; sourceIdentity = try Self.plainDirectory(source)
        let config = try Self.read(source + "/config.json", maximum: 16 * 1024 * 1024)
        let original = try Self.read(source + "/source.json", maximum: 2 * 1024 * 1024)
        let bundleBytes = try Self.read(source + "/bundle.json", maximum: 3 * 1024 * 1024)
        guard Self.digest(config.0) == binding.runtimeConfigurationSHA256,
              Self.digest(original.0) == configurationSHA256, Self.digest(bundleBytes.0) == bundleSHA256,
              let sourceConfiguration = try JSONSerialization.jsonObject(with: original.0) as? [String: Any],
              let bundled = try JSONSerialization.jsonObject(with: bundleBytes.0) as? [String: Any],
              Set(bundled.keys) == ["configuration", "assets", "pins", "unresolved"],
              NSDictionary(dictionary: sourceConfiguration).isEqual(to: bundled["configuration"] as? [String: Any] ?? [:]),
              (bundled["unresolved"] as? [Any])?.isEmpty == true,
              NSArray(array: items).isEqual(to: bundled["assets"] as? [Any] ?? []),
              NSArray(array: pins).isEqual(to: bundled["pins"] as? [Any] ?? []),
              let configuration = try JSONSerialization.jsonObject(with: config.0) as? [String: Any],
              let tun = configuration["tun"] as? [String: Any], tun["enable"] as? Bool == true else { throw Failure.invalid }
        var expected = sourceConfiguration
        guard var sourceTun = expected["tun"] as? [String: Any],
              sourceTun["file-descriptor"] == nil || RelayTunStrictJSON.integer(sourceTun["file-descriptor"]) == 0 else { throw Failure.invalid }
        if coreManaged {
            // Revalidate the privileged-only boundary even if a main process
            // bypasses its own schema gate. Do not silently rewrite the source.
            for key in ["external-controller", "external-controller-tls", "external-controller-unix", "external-controller-pipe"] {
                guard sourceConfiguration[key] == nil || sourceConfiguration[key] as? String == "" else { throw Failure.invalid }
            }
            if let ntp = sourceConfiguration["ntp"] as? [String: Any], let write = ntp["write-to-system"] {
                guard let flag = write as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(), !flag.boolValue else { throw Failure.invalid }
            }
            sourceTun.removeValue(forKey: "file-descriptor")
            if sourceTun["device"] as? String == "utun" {
                guard let value = UInt32(binding.evidenceSHA256.prefix(8), radix: 16) else { throw Failure.invalid }
                // Match fixed Mihomo's signed-16-bit Darwin name parser;
                // larger names would be silently replaced by the core.
                sourceTun["device"] = "utun\(10000 + value % (UInt32(Int16.max) - 10000 + 1))"
            }
            guard let device = sourceTun["device"] as? String, device.hasPrefix("utun"),
                  let index = UInt32(device.dropFirst(4)), index <= UInt32(Int16.max),
                  device == "utun\(index)" else { throw Failure.invalid }
            guard tun["file-descriptor"] == nil else { throw Failure.invalid }
        } else {
            guard RelayTunStrictJSON.integer(tun["file-descriptor"]) == 3,
                  tun["device"] as? String == projection?.device else { throw Failure.invalid }
            sourceTun["file-descriptor"] = 3
        }
        expected["tun"] = sourceTun
        guard NSDictionary(dictionary: expected).isEqual(to: configuration) else { throw Failure.invalid }
        self.configuration = config.0
        var assetPaths = Set<String>(), assets: [Asset] = []
        for item in items {
            guard Set(item.keys).isSubset(of: ["path", "sha256", "expectedRules"]),
                  Set(item.keys).isSuperset(of: ["path", "sha256"]), let path = item["path"] as? String,
                  Self.relative(path), path != "config.json", path != "config.yaml", path != "api.sock", path != "cache.db",
                  assetPaths.insert(path).inserted else { throw Failure.invalid }
            if resourcesEnabled {
                guard path.split(separator: "/").first != "RelayGeoInbox", !path.hasPrefix("RelayGeo.retained-") else { throw Failure.invalid }
            }
            if ruleProvidersEnabled { guard path.split(separator: "/").first.map(String.init) != RelayTunRuntimeRuleProviderFiles.stageDirectory else { throw Failure.invalid } }
            let rules = item["expectedRules"].flatMap(RelayTunStrictJSON.integer)
            guard item["expectedRules"] == nil || rules != nil else { throw Failure.invalid }
            assets.append(try .init(path: path, sha256: Self.hash(item["sha256"]), expectedRules: rules))
        }
        var pinKeys = Set<String>()
        for pin in pins {
            guard Set(pin.keys) == ["id", "sha256", "namespace", "revision"],
                  let namespace = pin["namespace"] as? String, ["resource", "provider"].contains(namespace),
                  let id = pin["id"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
                  pinKeys.insert(namespace + ":" + id).inserted else { throw Failure.invalid }
            _ = try Self.hash(pin["sha256"]); _ = try Self.hash(pin["revision"])
        }
        self.assets = assets
        if ruleProvidersEnabled {
            if let raw = configuration["rule-providers"] {
                guard let definitions = raw as? [String: Any], definitions.count <= 200 else { throw Failure.invalid }
                for item in definitions.values {
                    guard let row = item as? [String: Any] else { throw Failure.invalid }
                    if row["type"] as? String == "file", let path = row["path"] as? String { providerPaths.insert(path) }
                }
            }
        }
        if let executionContext {
            guard raw["executionPath"] as? String == "execution.json" else { throw Failure.invalid }
            let expectedSHA = try Self.hash(raw["executionSHA256"])
            let parentFD = open(source, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard parentFD >= 0 else { throw Failure.invalid }
            let parent = FileHandle(fileDescriptor: parentFD, closeOnDealloc: true)
            executionSourceHandle = parent
            var heldDirectory = stat()
            guard fstat(parentFD, &heldDirectory) == 0, Self.same(heldDirectory, sourceIdentity) else { throw Failure.changed }
            let fileFD = openat(parentFD, "execution.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard fileFD >= 0 else { throw Failure.invalid }
            let file = FileHandle(fileDescriptor: fileFD, closeOnDealloc: true)
            executionFileHandle = file
            let execution = try Self.read(source + "/execution.json", maximum: RelayTunExecutionReceiptV2.maximumReceiptBytes,
                                          held: (parentFD, fileFD))
            let actual = try assets.map { asset -> RelayTunExecutionReceiptV2.Asset in
                let read = try Self.read(source + "/" + asset.path, maximum: Self.maximumAssetBytes)
                guard Self.digest(read.0) == asset.sha256 else { throw Failure.changed }
                return .init(path: asset.path, data: read.0, expectedRules: asset.expectedRules)
            }
            executionReceipt = try RelayTunExecutionReceiptV2.decode(execution.0, expectedRawSHA256: expectedSHA,
                context: .init(core: executionContext.core, configuration: original.0, assets: actual, nowMS: executionContext.receivedAtMS))
            executionFileIdentity = execution.1
            executionReceivedAtMS = executionContext.receivedAtMS
            executionReceivedTickMS = executionContext.receivedTickMS
        }
        var pattern = Array("/private/tmp/relay-session-\(getuid())-XXXXXX".utf8CString)
        guard mkdtemp(&pattern) != nil else { throw Failure.invalid }
        directory = String(cString: pattern); directoryIdentity = try Self.plainDirectory(directory)
        if resourcesEnabled || executionReceipt?.stateSeed != nil {
            directoryFD = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard directoryFD >= 0 else { throw Failure.invalid }
        }
        // A thrown staging operation retains its private directory for explicit
        // inspection. No recursive deletion or unknown-file cleanup occurs.
        inventories["config.yaml"] = (try Self.write(config.0, path: directory + "/config.yaml"), Self.digest(config.0))
        var total = 0
        for asset in assets {
            let read = try Self.read(source + "/" + asset.path, maximum: Self.maximumAssetBytes)
            total += read.0.count
            guard total <= Self.maximumTotalBytes, Self.digest(read.0) == asset.sha256 else { throw Failure.invalid }
            let parent = URL(fileURLWithPath: directory + "/" + asset.path).deletingLastPathComponent().path
            if parent != directory {
                var current = directory
                for piece in asset.path.split(separator: "/").dropLast() {
                    current += "/" + piece
                    if mkdir(current, 0o700) != 0, errno != EEXIST { throw Failure.invalid }
                    _ = try Self.plainDirectory(current)
                }
            }
            inventories[asset.path] = (try Self.write(read.0, path: directory + "/" + asset.path), asset.sha256)
        }
        try verify()
        if let receipt = executionReceipt, let seed = receipt.stateSeed {
            guard receipt.core.profile == .smart, let sourceHandle = executionSourceHandle, directoryFD >= 0 else { throw Failure.invalid }
            let original = try RelayTunStrictJSON.object(try Self.read(source + "/source.json", maximum: 2 * 1024 * 1024).0,
                                                        limit: 2 * 1024 * 1024)
            let groups = original["proxy-groups"] as? [[String: Any]] ?? []
            let collect = try RelayTunSmartStateV1.collectsCSV(groups: groups)
            try captureSmartOtherEntries()
            smartStateHandoff = try .init(executionSHA256: receipt.rawSHA256, key: seed.key)
            smartStateFiles = try .init(stageRootFD: sourceHandle.fileDescriptor, coreHomeFD: directoryFD,
                seed: seed, collectCSV: collect, checkSource: { [unowned self] in try self.verify() },
                knownOtherCoreEntries: { [unowned self] in try self.knownSmartOtherEntries() })
            try smartStateFiles?.prepare()
        }
        if resourcesEnabled {
            guard let inbox = raw["resourceInboxRoot"] as? String else { throw Failure.invalid }
            resourceInbox = try .init(sourceRoot: inbox, coreHome: directory)
        }
    }
    deinit { if directoryFD >= 0 { Darwin.close(directoryFD) } }
    func workDirectoryProof() throws -> [String: String] {
        guard !removed, cleanupSnapshot == nil else { throw Failure.changed }
        let current = try Self.plainDirectory(directory)
        guard current.st_dev == directoryIdentity.st_dev, current.st_ino == directoryIdentity.st_ino,
              current.st_gid == directoryIdentity.st_gid, current.st_dev >= 0, current.st_ino > 0 else { throw Failure.changed }
        return ["path": directory, "device": String(current.st_dev), "inode": String(current.st_ino)]
    }
    func verify() throws {
        guard !removed, cleanupSnapshot == nil else { throw Failure.changed }
        try verifySource()
        let currentDirectory = try Self.plainDirectory(directory)
        guard currentDirectory.st_dev == directoryIdentity.st_dev, currentDirectory.st_ino == directoryIdentity.st_ino else { throw Failure.changed }
        for (path, (original, sha)) in inventories {
            if ruleProvidersEnabled, ruleProviderFiles != nil, providerPaths.contains(path) { continue }
            if resourcesEnabled, let kind = Self.resourceKind(path) {
                // Known uncertainty is confined to this one admitted kind.
                // It is not a verified new SHA and cannot authorize an update.
                if resourceIsolated, resourceTransition?.kind == kind { continue }
                let current = try readResource(kind, active: resourceLedger?.resources[kind]?.active ?? false, check: {})
                if let transition = resourceTransition, transition.kind == kind {
                    let old = current.0.sha256 == sha && Self.same(current.1, original)
                    let proposed = current.0.sha256 == transition.newSHA256 && current.0.bytes == transition.bytes
                    guard old || proposed else { throw Failure.changed }
                } else { guard Self.same(current.1, original), current.0.sha256 == sha else { throw Failure.changed } }
                continue
            }
            let current = try Self.read(directory + "/" + path, maximum: path == "config.yaml" ? 16 * 1024 * 1024 : Self.maximumAssetBytes)
            guard Self.same(current.1, original), Self.digest(current.0) == sha else { throw Failure.changed }
        }
        try ruleProviderFiles?.verifyKnownLayouts(check: {})
    }
    struct TrafficVerificationSnapshot {
        let verify: (() throws -> Void) throws -> Void
    }
    /// Owner-queue copy only. The worker verifies complete source and current
    /// admitted targets; it does not adopt provider staging/cleanup authority.
    /// No escaping closure reads this Bundle's mutable fields or FileHandles.
    func trafficVerificationSnapshot() throws -> TrafficVerificationSnapshot {
        guard !removed, cleanupSnapshot == nil, !resourceIsolated, resourceTransition == nil,
              !ruleProviderIsolated, providerOperation == nil else { throw Failure.changed }
        let sourcePath = source, corePath = directory, coreFact = directoryIdentity
        let config = configuration, configSHA = configurationSHA256, bundleSHA = bundleSHA256
        let capturedAssets = assets, files = inventories, managedProviderPaths = providerPaths
        let providerManaged = ruleProviderFiles != nil
        let providerTargets: [ProviderModel.Resource]
        if providerManaged {
            guard let ledger = ruleProviderLedger else { throw Failure.changed }
            let byPath = Dictionary(grouping: ledger.resources.values, by: { $0.binding.originalPath })
            providerTargets = byPath.values.compactMap { $0.first }.sorted { $0.binding.originalPath < $1.binding.originalPath }
        } else { providerTargets = [] }
        guard providerTargets.allSatisfy({ Self.relative($0.binding.originalPath) && managedProviderPaths.contains($0.binding.originalPath) }),
              !providerManaged || Set(providerTargets.map { $0.binding.originalPath }) == managedProviderPaths else { throw Failure.changed }
        smartSourceLock.lock(); let capturedRecovery = recoveryRecord; smartSourceLock.unlock()
        let sourceFact = capturedRecovery?.directory ?? sourceIdentity
        let receiptSHA = executionReceipt?.rawSHA256, receiptIdentity = executionFileIdentity
        let heldExecution: (FileHandle, FileHandle)?
        if receiptSHA != nil {
            guard let parent = executionSourceHandle, let file = executionFileHandle, receiptIdentity != nil else { throw Failure.changed }
            // These are private readonly source/file duplicates, not the Core
            // descriptor or installation lock. ARC closes only these new FDs.
            let parentFD = fcntl(parent.fileDescriptor, F_DUPFD_CLOEXEC, 3)
            guard parentFD >= 3 else { throw Failure.changed }
            let copiedParent = FileHandle(fileDescriptor: parentFD, closeOnDealloc: true)
            let fileFD = fcntl(file.fileDescriptor, F_DUPFD_CLOEXEC, 3)
            guard fileFD >= 3 else { try? copiedParent.close(); throw Failure.changed }
            heldExecution = (copiedParent, FileHandle(fileDescriptor: fileFD, closeOnDealloc: true))
        } else { heldExecution = nil }
        return .init(verify: { [sourcePath, corePath, coreFact, config, configSHA, bundleSHA, capturedAssets,
                               files, managedProviderPaths, providerManaged, providerTargets, capturedRecovery,
                               sourceFact, receiptSHA, receiptIdentity, heldExecution] check in
            func read(_ path: String, maximum: Int,
                      held: (parent: Int32, file: Int32)? = nil) throws -> (Data, stat) {
                try check()
                let result = try RelayTunAppBundle.read(path, maximum: maximum, held: held)
                try check(); return result
            }
            try check()
            guard RelayTunAppBundle.same(try RelayTunAppBundle.plainDirectory(sourcePath), sourceFact) else { throw Failure.changed }
            if let receiptSHA, let identity = receiptIdentity, let heldExecution {
                var held = stat()
                guard fstat(heldExecution.0.fileDescriptor, &held) == 0,
                      RelayTunAppBundle.same(held, sourceFact) else { throw Failure.changed }
                let execution = try read(sourcePath + "/execution.json", maximum: RelayTunExecutionReceiptV2.maximumReceiptBytes,
                                         held: (heldExecution.0.fileDescriptor, heldExecution.1.fileDescriptor))
                guard RelayTunAppBundle.same(execution.1, identity), RelayTunAppBundle.digest(execution.0) == receiptSHA else { throw Failure.changed }
                try check()
            }
            if let capturedRecovery {
                let current = try read(sourcePath + "/recovery.json", maximum: 4096)
                guard RelayTunAppBundle.same(current.1, capturedRecovery.file), RelayTunAppBundle.digest(current.0) == capturedRecovery.sha256 else { throw Failure.changed }
                try check()
            }
            guard try read(sourcePath + "/config.json", maximum: 16 * 1024 * 1024).0 == config,
                  RelayTunAppBundle.digest(try read(sourcePath + "/source.json", maximum: 2 * 1024 * 1024).0) == configSHA,
                  RelayTunAppBundle.digest(try read(sourcePath + "/bundle.json", maximum: 3 * 1024 * 1024).0) == bundleSHA else { throw Failure.changed }
            try check()
            for asset in capturedAssets {
                guard RelayTunAppBundle.digest(try read(sourcePath + "/" + asset.path, maximum: RelayTunAppBundle.maximumAssetBytes).0) == asset.sha256 else { throw Failure.changed }
                try check()
            }
            let currentDirectory = try RelayTunAppBundle.plainDirectory(corePath)
            guard currentDirectory.st_dev == coreFact.st_dev, currentDirectory.st_ino == coreFact.st_ino else { throw Failure.changed }
            for (path, (original, sha)) in files {
                if providerManaged, managedProviderPaths.contains(path) { continue }
                let current = try read(corePath + "/" + path, maximum: path == "config.yaml" ? 16 * 1024 * 1024 : RelayTunAppBundle.maximumAssetBytes)
                guard RelayTunAppBundle.same(current.1, original), RelayTunAppBundle.digest(current.0) == sha else { throw Failure.changed }
                try check()
            }
            for target in providerTargets {
                let current = try read(corePath + "/" + target.binding.originalPath, maximum: RelayTunAppBundle.maximumAssetBytes)
                guard try RelayTunRuntimeRuleProviderFiles.identity(current.1) == target.identity,
                      RelayTunAppBundle.digest(current.0) == target.fileSHA256 else { throw Failure.changed }
                try check()
            }
            guard RelayTunAppBundle.same(try RelayTunAppBundle.plainDirectory(sourcePath), sourceFact) else { throw Failure.changed }
            try check()
        })
    }
    /// This gate belongs only immediately before first launch. Active verify
    /// keeps checking identities/hashes and must not revoke a 60s-old session.
    func verifyExecutionBeforeLaunch(clock: () -> Int64,
                                    monotonicClock: () -> UInt64 = { DispatchTime.now().uptimeNanoseconds / 1_000_000 }) throws {
        try verify()
        // Source/asset hashes can be large: sample time only after that work.
        try checkExecutionDeadline(nowMS: clock(), nowTickMS: monotonicClock())
    }
    func checkExecutionDeadline(nowMS: Int64, nowTickMS: UInt64 = DispatchTime.now().uptimeNanoseconds / 1_000_000) throws {
        guard let receipt = executionReceipt, let received = executionReceivedAtMS,
              let receivedTick = executionReceivedTickMS, receipt.expiresAt > received,
              nowMS >= received, nowMS < receipt.expiresAt, nowTickMS >= receivedTick,
              nowTickMS - receivedTick < UInt64(receipt.expiresAt - received) else { throw Failure.changed }
    }
    func requireSmartStateSeed() throws {
        guard smartStateEnabled, executionReceipt?.stateSeed != nil,
              smartStateFiles != nil, smartStateHandoff != nil else { throw Failure.invalid }
    }
    func verifySmartStateBeforeFork() throws {
        if !smartStateEnabled { return }
        try requireSmartStateSeed(); try verifySmartStateLayout()
    }
    func verifySmartStateLayout() throws {
        try requireSmartStateSeed(); try smartStateFiles?.verifyLayout()
    }
    /// Called only after the held child's real API reader authenticated and
    /// registered its socket. Mutable writer bytes are not a snapshot here.
    func verifySmartStateActiveLayout() throws {
        try requireSmartStateSeed(); try smartStateFiles?.verifyLiveLayout()
    }
    private func captureSmartOtherEntries() throws {
        let top = Set(inventories.keys.compactMap { $0.split(separator: "/").first.map(String.init) })
        for name in top.sorted() {
            if let file = inventories[name] {
                smartOtherEntries.append(.init(name: name, identity: file.0, sha256: file.1))
            } else {
                smartOtherEntries.append(.init(name: name, identity: try Self.plainDirectory(directory + "/" + name), sha256: nil))
            }
        }
        _ = try knownSmartOtherEntries()
    }
    private func knownSmartOtherEntries() throws -> [RelayTunSmartStateFiles.KnownCoreEntry] {
        // Verify exact known descendants of immutable directories. The Files
        // owner independently verifies the complete top-level state/other union.
        for entry in smartOtherEntries where entry.identity.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) {
            let prefix = entry.name + "/"
            var expected = Set<String>()
            for path in inventories.keys where path.hasPrefix(prefix) {
                let relative = String(path.dropFirst(prefix.count)); expected.insert(relative)
                let pieces = relative.split(separator: "/")
                for index in pieces.indices.dropFirst() { expected.insert(pieces.prefix(index).joined(separator: "/")) }
            }
            guard Set(try FileManager.default.subpathsOfDirectory(atPath: directory + "/" + entry.name)) == expected else { throw Failure.changed }
        }
        return smartOtherEntries + (smartSocket.map { [$0] } ?? [])
    }
    func registerSmartStateSocket(_ fact: stat) throws {
        try requireSmartStateSeed()
        let entry = try RelayTunSmartStateFiles.KnownCoreEntry.authenticatedAPISocket(fact)
        if let previous = smartSocket {
            guard Self.same(previous.identity, fact), previous.identity.st_gid == fact.st_gid else { throw Failure.changed }
        } else { smartSocket = entry }
    }
    func exportSmartState(stamp: UInt64, afterRestoration: () throws -> Void,
                          contextCheck: () throws -> Void) throws -> RelayTunSmartStateHandoff.Snapshot {
        try requireSmartStateSeed()
        guard let files = smartStateFiles, let handoff = smartStateHandoff, let receipt = executionReceipt else { throw Failure.invalid }
        #if RELAY_TUN_APP_SESSION_TESTS
        defer { afterSmartStateCaptureForTest?() }
        #endif
        do {
            try contextCheck(); try handoff.checkExport(stamp)
            #if RELAY_TUN_APP_SESSION_TESTS
            try beforeSmartStateCaptureForTest?()
            #endif
            let result = try files.captureResult(afterRestoration: {
                try afterRestoration(); try contextCheck(); try handoff.checkExport(stamp)
            })
            try contextCheck(); try handoff.checkExport(stamp)
            var metadata = binding.json
            metadata["version"] = 1; metadata["kind"] = "relay-smart-state-result"
            metadata["executionSHA256"] = receipt.rawSHA256; metadata["key"] = result.key
            metadata["previousRevision"] = result.previousRevision.map { $0 as Any } ?? NSNull()
            metadata["files"] = result.files.map { ["path": $0.path.rawValue, "sha256": $0.sha256, "size": $0.size] as [String: Any] }
            let raw = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys, .withoutEscapingSlashes])
            let fact = try files.writeResultMetadata(raw)
            try contextCheck(); try handoff.checkExport(stamp)
            let snapshot = RelayTunSmartStateHandoff.Snapshot(result: result, executionSHA256: receipt.rawSHA256, resultSHA256: fact.sha256)
            try handoff.finishExport(stamp, snapshot: snapshot); return snapshot
        } catch {
            try? handoff.finishExport(stamp, snapshot: nil); throw error
        }
    }
    private static func resourceKind(_ path: String) -> RelayTunRuntimeResources.Kind? {
        RelayTunRuntimeResources.Kind.allCases.first { $0.basename == path }
    }
    var staticResourceBytes: Int {
        nonGeoNonProviderResourceBytes + physicalRuleProviderBytes
    }
    var nonGeoNonProviderResourceBytes: Int {
        inventories.reduce(0) { count, item in
            item.key == "config.yaml" || Self.resourceKind(item.key) != nil || providerPaths.contains(item.key) ? count : count + Int(item.value.0.st_size)
        }
    }
    var physicalRuleProviderBytes: Int {
        ruleProviderLedger?.bytes ?? providerPaths.reduce(0) { $0 + Int(inventories[$1]?.0.st_size ?? 0) }
    }
    var reservedRuleProviderBytes: Int {
        guard ruleProviderIsolated, let operation = providerOperation,
              let old = operation.previous.resources[operation.selection.provider] else { return physicalRuleProviderBytes }
        return operation.previous.bytes - old.bytes + max(old.bytes, operation.selection.bytes)
    }
    private func resourceRoot() throws {
        guard resourcesEnabled, !removed, cleanupSnapshot == nil, directoryFD >= 0 else { throw Failure.changed }
        let path = try Self.plainDirectory(directory); var held = stat()
        guard fstat(directoryFD, &held) == 0, held.st_dev == directoryIdentity.st_dev, held.st_ino == directoryIdentity.st_ino,
              path.st_dev == held.st_dev, path.st_ino == held.st_ino, held.st_uid == getuid(),
              held.st_gid == directoryIdentity.st_gid, held.st_mode & 0o7777 == 0o700 else { throw Failure.changed }
    }
    private func readResource(_ kind: RelayTunRuntimeResources.Kind, active: Bool,
                              check: () throws -> Void) throws -> (RelayTunRuntimeResources.Resource, stat) {
        try resourceRoot(); try check()
        let fd = openat(directoryFD, kind.basename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw Failure.changed }; defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_uid == getuid(), before.st_gid == directoryIdentity.st_gid,
              before.st_mode == mode_t(S_IFREG) | 0o600, before.st_nlink == 1,
              before.st_size > 0, before.st_size <= Self.maximumAssetBytes else { throw Failure.changed }
        var digest = SHA256(), count = 0, buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            try check()
            let size = Darwin.read(fd, &buffer, buffer.count)
            if size < 0, errno == EINTR { continue }
            guard size >= 0, count + max(0, size) <= before.st_size else { throw Failure.changed }
            if size == 0 { break }; count += size; digest.update(data: buffer.prefix(size))
        }
        guard count == before.st_size, fstat(fd, &after) == 0,
              fstatat(directoryFD, kind.basename, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              Self.same(before, after), Self.same(after, linked), after.st_gid == linked.st_gid else { throw Failure.changed }
        try resourceRoot(); try check()
        func ns(_ time: timespec) throws -> UInt64 {
            guard time.tv_sec >= 0, (0..<1_000_000_000).contains(time.tv_nsec),
                  UInt64(time.tv_sec) <= (UInt64.max - UInt64(time.tv_nsec)) / 1_000_000_000 else { throw Failure.changed }
            return UInt64(time.tv_sec) * 1_000_000_000 + UInt64(time.tv_nsec)
        }
        let identity = try RelayTunRuntimeResources.FileIdentity(device: UInt64(UInt32(bitPattern: after.st_dev)), inode: UInt64(after.st_ino),
            ownerUID: after.st_uid, mode: UInt32(after.st_mode), links: UInt64(after.st_nlink), bytes: count,
            modifiedNS: ns(after.st_mtimespec), changedNS: ns(after.st_ctimespec))
        let sha = digest.finalize().map { String(format: "%02x", $0) }.joined()
        return (try .init(kind: kind, sha256: sha, identity: identity, active: active), after)
    }
    /// Only authenticated fixed-Core state supplies boot/head/active. It is
    /// joined with independent fixed-target identity/hash reads, never adopted
    /// from a renderer or from a later unexplained Core head.
    func observeResourceState(_ state: RelayTunCoreReadiness.ResourceState,
                              check: () throws -> Void) throws -> RelayTunRuntimeResources.Ledger {
        guard !resourceIsolated, resourceTransition == nil else { throw Failure.resourceUncertain }
        try verify()
        let value = try resourceFiles(state, check: check)
        if let known = resourceLedger { guard known == value.0 else { throw Failure.changed } }
        else {
            guard state.sequence == 0, value.0.resources.values.allSatisfy({ row in
                guard let original = inventories[row.kind.basename], let observed = value.1[row.kind.basename] else { return false }
                return original.1 == row.sha256 && Self.same(original.0, observed.0)
            }) else { throw Failure.changed }
            resourceLedger = value.0
        }
        return value.0
    }
    private func resourceFiles(_ state: RelayTunCoreReadiness.ResourceState,
                               check: () throws -> Void) throws -> (RelayTunRuntimeResources.Ledger, [String: (stat, String)]) {
        let expected = Set(inventories.keys.compactMap(Self.resourceKind))
        guard Set(state.resources.map { $0.kind }) == expected else { throw Failure.changed }
        var rows = [RelayTunRuntimeResources.Resource]()
        var facts: [String: (stat, String)] = [:]
        for row in state.resources {
            let value = try readResource(row.kind, active: row.active, check: check)
            guard value.0.sha256 == row.sha256, value.0.bytes == row.bytes else { throw Failure.changed }
            rows.append(value.0); facts[row.kind.basename] = (value.1, row.sha256)
        }
        let ledger = try RelayTunRuntimeResources.Ledger(bootId: state.bootId, generationSHA256: state.generationSHA256,
            sequence: state.sequence, resources: rows)
        guard staticResourceBytes + rows.reduce(0, { $0 + $1.bytes }) <= Self.maximumTotalBytes else { throw Failure.changed }
        try check(); return (ledger, facts)
    }
    func beginResourceTransition(_ selection: RelayTunRuntimeResources.Selection, previous: RelayTunRuntimeResources.Ledger) throws {
        guard resourcesEnabled, !resourceIsolated, !ruleProviderIsolated, providerOperation == nil,
              resourceTransition == nil, resourceLedger == previous,
              previous.generationSHA256 == selection.expectedGenerationSHA256,
              previous.resources[selection.kind]?.sha256 == selection.oldSHA256 else { throw Failure.changed }
        try verify(); resourceTransition = selection; resourcePostimage = nil
    }
    func readResourcePostimage(_ state: RelayTunCoreReadiness.ResourceState,
                               check: () throws -> Void) throws -> RelayTunRuntimeResources.Ledger {
        guard resourcesEnabled, !resourceIsolated, resourceTransition != nil else { throw Failure.changed }
        let value = try resourceFiles(state, check: check); resourcePostimage = value; return value.0
    }
    /// No IO/observer follows Model's successful final CAS. Only the exact
    /// independently read postimage used by that CAS becomes the new ledger.
    func finishResourceTransition(_ reply: RelayTunRuntimeResources.Reply, isolated: Bool) throws {
        guard let selected = resourceTransition else { return }
        if isolated {
            resourceIsolated = true; resourcePostimage = nil; return
        }
        if reply.status == .updated {
            guard let ledger = reply.ledger, let postimage = resourcePostimage, postimage.0 == ledger,
                  let new = postimage.1[selected.kind.basename] else { throw Failure.changed }
            inventories[selected.kind.basename] = new; resourceLedger = ledger
        }
        resourceTransition = nil; resourcePostimage = nil
    }
    func isolateCompletedResource(_ selection: RelayTunRuntimeResources.Selection) {
        guard resourcesEnabled else { return }
        resourceTransition = selection; resourceIsolated = true; resourcePostimage = nil
    }
    private func providerDefinitions() throws -> [String: [String: Any]] {
        let object = try RelayTunStrictJSON.object(configuration, limit: 16 * 1024 * 1024, maxNodes: 200000)
        guard let raw = object["rule-providers"] else { return [:] }
        guard let definitions = raw as? [String: Any], definitions.count <= 200 else { throw Failure.invalid }
        var output = [String: [String: Any]]()
        for (name, value) in definitions {
            guard !name.isEmpty, name.utf8.count <= 256, name == name.trimmingCharacters(in: .whitespacesAndNewlines),
                  !name.contains(","), name.unicodeScalars.allSatisfy({ $0.value >= 32 && !(127...159).contains($0.value) }),
                  let row = value as? [String: Any], let behavior = row["behavior"] as? String,
                  ProviderModel.Behavior(rawValue: behavior) != nil else { throw Failure.invalid }
            switch row["type"] as? String {
            case "file":
                guard Set(row.keys) == ["type", "behavior", "format", "path", "interval"],
                      RelayTunStrictJSON.integer(row["interval"]) == 0,
                      let path = row["path"] as? String, let format = row["format"] as? String,
                      let kind = ProviderModel.Format(rawValue: format),
                      assets.contains(where: { $0.path == path }) else { throw Failure.invalid }
                _ = try ProviderModel.Binding(name: name, originalPath: path, behavior: ProviderModel.Behavior(rawValue: behavior)!, format: kind)
            case "inline":
                guard Set(row.keys).isSubset(of: ["type", "behavior", "format", "payload", "interval"]),
                      let payload = row["payload"] as? [String], payload.count <= ProviderModel.maximumDeclaredRules,
                      row["interval"] == nil || RelayTunStrictJSON.integer(row["interval"]) == 0,
                      row["format"] == nil || ["yaml", "text"].contains(row["format"] as? String ?? "") else { throw Failure.invalid }
            default: throw Failure.invalid // Unbound HTTP must never fetch here.
            }
            output[name] = row
        }
        return output
    }
    private func providerContext(_ context: ProviderModel.Context) throws {
        guard ruleProvidersEnabled, resourcesEnabled, !resourceIsolated, resourceTransition == nil,
              !ruleProviderIsolated, context.owner.configurationRevision == binding.runtimeConfigurationSHA256,
              context.owner.ordinaryUID == getuid(), context.owner.coreSHA256 == RelayTunRuntimeRuleProviderProbe.corePin.sha256,
              let geo = resourceLedger, geo.generationSHA256 == context.geo.generationSHA256,
              geo.resources.values.reduce(0, { $0 + $1.bytes }) == context.geo.bytes else { throw Failure.changed }
    }
    /// First authority joins the complete authenticated provider metadata to
    /// the immutable checked file map. Inline rows are validated and retained
    /// by the configuration, but never assigned a fabricated file capability.
    func observeRuleProviders(_ metadata: Data, context: ProviderModel.Context,
                              check: () throws -> Void) throws -> ProviderModel.Ledger {
        guard providerOperation == nil else { throw Failure.conflict }
        try providerContext(context); try check(); try verify()
        let definitions = try providerDefinitions()
        let object = try RelayTunStrictJSON.object(metadata, limit: 2 * 1024 * 1024, maxNodes: 200000)
        guard Set(object.keys) == ["providers"], let actual = object["providers"] as? [String: Any],
              Set(actual.keys) == Set(definitions.keys) else { throw Failure.changed }
        let behaviors = ["domain": "Domain", "ipcidr": "IPCIDR", "classical": "Classical"]
        let formats = ["yaml": "YamlRule", "text": "TextRule", "mrs": "MrsRule"]
        let base: Set<String> = ["name", "behavior", "format", "ruleCount", "type", "vehicleType", "updatedAt"]
        var rows = [ProviderModel.Resource](), inline = [String: Int]()
        for name in definitions.keys.sorted() {
            try check()
            let definition = definitions[name]!
            guard let row = actual[name] as? [String: Any], row["name"] as? String == name,
                  row["type"] as? String == "Rule", row["behavior"] as? String == behaviors[definition["behavior"] as! String],
                  let count = RelayTunStrictJSON.integer(row["ruleCount"]), count >= 0, count <= ProviderModel.maximumDeclaredRules,
                  let updated = row["updatedAt"] as? String, updated.utf8.count <= 64 else { throw Failure.changed }
            let date = ISO8601DateFormatter(); date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if date.date(from: updated) == nil { date.formatOptions = [.withInternetDateTime] }
            guard let parsed = date.date(from: updated), parsed.timeIntervalSince1970 > 0 else { throw Failure.changed }
            if definition["type"] as? String == "inline" {
                let payload = definition["payload"] as! [String]
                guard Set(row.keys) == base || Set(row.keys) == base.union(["payload"]),
                      row["vehicleType"] as? String == "Inline", row["format"] as? String == "", count == payload.count,
                      (row["payload"] as? [String] == payload) || (payload.isEmpty && row["payload"] == nil) else { throw Failure.changed }
                inline[name] = count; continue
            }
            let path = definition["path"] as! String, format = definition["format"] as! String
            guard Set(row.keys) == base, row["vehicleType"] as? String == "File", row["format"] as? String == formats[format],
                  let original = inventories[path] else { throw Failure.changed }
            let read = try Self.read(directory + "/" + path, maximum: Self.maximumAssetBytes)
            let sha = Self.digest(read.0), identity = try RelayTunRuntimeRuleProviderFiles.identity(read.1)
            if ruleProviderLedger == nil {
                guard Self.same(read.1, original.0), sha == original.1,
                      assets.first(where: { $0.path == path })?.expectedRules == count else { throw Failure.changed }
            }
            rows.append(try .init(binding: .init(name: name, originalPath: path,
                behavior: ProviderModel.Behavior(rawValue: definition["behavior"] as! String)!, format: ProviderModel.Format(rawValue: format)!),
                fileSHA256: sha, identity: identity, ruleCount: count, registeredFile: true))
        }
        let known = ruleProviderLedger
        let head = try known?.generationSHA256 ?? Self.digest(JSONSerialization.data(withJSONObject:
            ["domain": "Relay rule-provider initial ledger v1", "configurationSHA256": context.owner.configurationRevision,
             "resources": rows.map { ["name": $0.binding.name, "sha256": $0.fileSHA256, "bytes": $0.bytes, "rules": $0.ruleCount] }], options: [.sortedKeys, .withoutEscapingSlashes]))
        let ledger = try ProviderModel.Ledger(generationSHA256: head, sequence: known?.sequence ?? 0, resources: rows)
        guard nonGeoNonProviderResourceBytes + context.geo.bytes + ledger.bytes <= Self.maximumTotalBytes else { throw Failure.changed }
        if let known { guard ledger == known, inline == providerInlineCounts else { throw Failure.changed } }
        try check(); try verify(); try providerContext(context)
        if known == nil {
            if !rows.isEmpty {
                let allowed = Set(assets.compactMap { $0.path.hasPrefix("relay-files/") ? String($0.path.dropFirst("relay-files/".count)) : nil })
                ruleProviderFiles = try .init(coreHome: directory, resources: rows, allowedFileNames: allowed)
            }
            ruleProviderLedger = ledger; providerInlineCounts = inline
        }
        return ledger
    }
    func beginRuleProviderOperation(selection: ProviderModel.Selection, previous: ProviderModel.Ledger) throws {
        guard ruleProvidersEnabled, !ruleProviderIsolated, providerOperation == nil, !resourceIsolated,
              resourceTransition == nil, ruleProviderLedger == previous,
              selection.configurationRevision == binding.runtimeConfigurationSHA256,
              selection.expectedGenerationSHA256 == previous.generationSHA256,
              selection.expectedGeoGenerationSHA256 == resourceLedger?.generationSHA256,
              let old = previous.resources[selection.provider], old.fileSHA256 == selection.oldSHA256 else { throw Failure.changed }
        try verify(); providerOperation = (selection, previous)
    }
    /// The model has already performed its final CAS. Accept only its precise
    /// one-group result; there is no IO/owner observer after this assignment.
    func endRuleProviderOperation(_ reply: ProviderModel.Reply, isolated: Bool) throws {
        guard let operation = providerOperation else { return }
        guard !reply.pending else { throw Failure.conflict }
        if isolated || reply.status == .uncertain { ruleProviderIsolated = true; return }
        if reply.status == .published {
            guard let next = reply.ledger, next.sequence == operation.previous.sequence + 1,
                  next.generationSHA256 != operation.previous.generationSHA256,
                  Set(next.resources.keys) == Set(operation.previous.resources.keys) else { throw Failure.changed }
            let selected = Set(operation.previous.group(for: operation.selection.provider).map { $0.binding.name })
            for (name, old) in operation.previous.resources {
                guard let new = next.resources[name] else { throw Failure.changed }
                if selected.contains(name) {
                    guard new.binding == old.binding, new.fileSHA256 == operation.selection.newSHA256,
                          new.bytes == operation.selection.bytes, new.ruleCount == operation.selection.declaredRuleCount,
                          new.registeredFile else { throw Failure.changed }
                } else { guard new == old else { throw Failure.changed } }
            }
            ruleProviderLedger = next
        } else if reply.ledger != nil { guard reply.ledger == operation.previous else { throw Failure.changed } }
        providerOperation = nil
    }
    func captureProviderSnapshot(context: ProviderModel.Context, group: [ProviderModel.Resource],
                                 check: () throws -> Void) throws -> RelayTunRuntimeRuleProviderProbe.Snapshot {
        try providerContext(context)
        guard let ledger = ruleProviderLedger, let first = group.first,
              ledger.group(for: first.binding.name) == group else { throw Failure.changed }
        try check(); try verify()
        var copied = [RelayTunRuntimeRuleProviderProbe.Asset]()
        for asset in assets {
            try check()
            let read = try Self.read(directory + "/" + asset.path, maximum: Self.maximumAssetBytes)
            copied.append(try .init(path: asset.path, data: read.0, identity: RelayTunRuntimeRuleProviderFiles.identity(read.1)))
        }
        var counts = providerInlineCounts
        for (name, row) in ledger.resources { counts[name] = row.ruleCount }
        try check(); try verify(); try providerContext(context)
        return try .init(configuration: configuration, assets: copied, context: context, group: group, expectedRuleCounts: counts)
    }
    static func makeProviderProbeWorkspace(projection: RelayTunRuntimeRuleProviderProbe.Projection,
                                          corePin: (sha256: String, bytes: Int)) throws -> RelayTunRuntimeRuleProviderProbe.Workspace {
        try RelayTunRuleProviderProbeWorkspace(projection: projection, corePin: corePin).workspace
    }
    private func verifySource() throws {
        smartSourceLock.lock(); let recoveryRecord = self.recoveryRecord, releaseRecord = self.releaseRecord; smartSourceLock.unlock()
        guard Self.same(try Self.plainDirectory(source), releaseRecord?.directory ?? recoveryRecord?.directory ?? sourceIdentity) else { throw Failure.changed }
        if let executionReceipt {
            guard let sourceHandle = executionSourceHandle, let fileHandle = executionFileHandle,
                  let identity = executionFileIdentity else { throw Failure.changed }
            var held = stat()
            guard fstat(sourceHandle.fileDescriptor, &held) == 0,
                  Self.same(held, releaseRecord?.directory ?? recoveryRecord?.directory ?? sourceIdentity) else { throw Failure.changed }
            let execution = try Self.read(source + "/execution.json", maximum: RelayTunExecutionReceiptV2.maximumReceiptBytes,
                                          held: (sourceHandle.fileDescriptor, fileHandle.fileDescriptor))
            guard Self.same(execution.1, identity), Self.digest(execution.0) == executionReceipt.rawSHA256 else { throw Failure.changed }
        }
        if let recoveryRecord {
            let read = try Self.read(source + "/recovery.json", maximum: 4096)
            guard Self.same(read.1, recoveryRecord.file), Self.digest(read.0) == recoveryRecord.sha256 else { throw Failure.changed }
        }
        if let releaseRecord {
            let read = try Self.read(source + "/release.json", maximum: 4096)
            guard Self.same(read.1, releaseRecord.file), Self.digest(read.0) == releaseRecord.sha256 else { throw Failure.changed }
        }
        let sourceConfig = try Self.read(source + "/config.json", maximum: 16 * 1024 * 1024)
        guard sourceConfig.0 == configuration,
              Self.digest(try Self.read(source + "/source.json", maximum: 2 * 1024 * 1024).0) == configurationSHA256,
              Self.digest(try Self.read(source + "/bundle.json", maximum: 3 * 1024 * 1024).0) == bundleSHA256 else { throw Failure.changed }
        for asset in assets {
            guard Self.digest(try Self.read(source + "/" + asset.path, maximum: Self.maximumAssetBytes).0) == asset.sha256 else { throw Failure.changed }
        }
    }
    /// One terminal control-loss record, deliberately outside the core's
    /// runtime directory. Existing records are never overwritten or adopted.
    /// It contains no credentials, paths, descriptor numbers or process IDs.
    func recordControlRecovery(restored: Bool, failureStage: String? = nil) throws {
        try verifySource()
        let parent = open(source, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw Failure.changed }; defer { Darwin.close(parent) }
        var directory = stat()
        guard fstat(parent, &directory) == 0, directory.st_dev == sourceIdentity.st_dev,
              directory.st_ino == sourceIdentity.st_ino, directory.st_uid == getuid(),
              directory.st_mode & 0o7777 == 0o700 else { throw Failure.changed }
        var record = binding.json
        record["version"] = 1
        record["baseline"] = ["networkSHA256": baseline.networkSHA256, "protectionSHA256": baseline.protectionSHA256]
        record["status"] = restored ? "restored" : "uncertain"
        record["ownedRecoveryRetained"] = !restored
        // Only failure records carry an internal fixed code. The successful
        // recovery receipt retains its existing exact wire shape.
        if !restored, let failureStage {
            guard failureStage.utf8.count <= 80,
                  failureStage.range(of: "^[a-zA-Z][a-zA-Z0-9.-]*$", options: .regularExpression) != nil else { throw Failure.invalid }
            record["failureStage"] = failureStage
        }
        let bytes = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= 4096 else { throw Failure.invalid }
        let file = openat(parent, "recovery.json", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw Failure.conflict }; defer { Darwin.close(file) }
        guard fchmod(file, 0o600) == 0 else { throw Failure.invalid }
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(file, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw Failure.changed }; offset += count
            }
        }
        var after = stat()
        guard fsync(file) == 0, fsync(parent) == 0, fstat(file, &after) == 0,
              after.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), after.st_mode & 0o7777 == 0o600,
              after.st_uid == getuid(), after.st_nlink == 1, after.st_size == bytes.count else { throw Failure.changed }
        let closedRecord = (try Self.plainDirectory(source), after, Self.digest(bytes))
        smartSourceLock.lock(); recoveryRecord = closedRecord; smartSourceLock.unlock()
    }
    /// Separate, write-once proof of owned retirement. It never upgrades a
    /// prior uncertain recovery record or permits deleting private evidence.
    /// Failed writes/fsync preserve partial files and refuse success; neither
    /// partial files nor unknown existing files are adopted on a later retry.
    func recordReleasedResources() throws {
        try verifySource()
        let parent = open(source, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw Failure.changed }; defer { Darwin.close(parent) }
        var directory = stat()
        guard fstat(parent, &directory) == 0, directory.st_dev == sourceIdentity.st_dev,
              directory.st_ino == sourceIdentity.st_ino, directory.st_uid == getuid(),
              directory.st_mode & 0o7777 == 0o700 else { throw Failure.changed }
        var record = binding.json
        record["version"] = 1
        record["baseline"] = ["networkSHA256": baseline.networkSHA256, "protectionSHA256": baseline.protectionSHA256]
        record["status"] = "resources-released"
        record["ownedRecoveryRetained"] = false
        record["restorationVerified"] = false
        record["reason"] = "external-protection-changed"
        let bytes = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= 4096 else { throw Failure.invalid }
        let file = openat(parent, "release.json", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard file >= 0 else { throw Failure.conflict }; defer { Darwin.close(file) }
        guard fchmod(file, 0o600) == 0 else { throw Failure.invalid }
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(file, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw Failure.changed }; offset += count
            }
        }
        var after = stat()
        guard fsync(file) == 0, fsync(parent) == 0, fstat(file, &after) == 0,
              after.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), after.st_mode & 0o7777 == 0o600,
              after.st_uid == getuid(), after.st_nlink == 1, after.st_size == bytes.count else { throw Failure.changed }
        let closedRecord = (try Self.plainDirectory(source), after, Self.digest(bytes))
        smartSourceLock.lock(); releaseRecord = closedRecord; smartSourceLock.unlock()
    }
    enum FinalDisposition { case removed, retainedEvidence }
    /// Called only after the caller positively reaped its own Core and freshly
    /// verified host/device/network restoration. An already isolated Geo
    /// transition cannot identify Core-created postimage inodes after lost
    /// ACK. Keep the entire private directory as evidence; do not adopt a
    /// ledger, delete a name or keep the restored system lease alive for it.
    func finalizeAfterRestoration() throws -> FinalDisposition {
        if smartStateEnabled {
            try verify()
            guard let handoff = smartStateHandoff, handoff.cleanupGranted, !handoff.workerPending,
                  let files = smartStateFiles else { return .retainedEvidence }
            do { try files.cleanupCore(afterRestoration: {}) }
            catch is RelayTunSmartStateFiles.Failure { return .retainedEvidence }
            catch is RelayTunSmartStateV1.Failure { return .retainedEvidence }
            // Base/source errors are deliberately not swallowed by state retention.
        }
        if resourceIsolated {
            guard resourcesEnabled, let transition = resourceTransition,
                  transition.configurationRevision == binding.runtimeConfigurationSHA256,
                  inventories[transition.kind.basename] != nil, resourceLedger?.resources[transition.kind] != nil,
                  !ruleProviderIsolated, providerOperation == nil, cleanupSnapshot == nil else { throw Failure.resourceUncertain }
            try resourceRoot(); try verify()
            return .retainedEvidence
        }
        try cleanup(); return .removed
    }
    private func validateCoreRuntime(_ info: stat, name: String) throws {
        guard (info.st_uid == getuid() || (coreManaged && info.st_uid == 0)), info.st_nlink == 1,
              ((name == "api.sock" && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK)) ||
              (name == "cache.db" && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && info.st_mode & 0o7777 == 0o600)) else { throw Failure.conflict }
    }
    /// Only after positively reaped core and released helper/device. Unknown
    /// contents or changed files preserve the directory and fail disposal.
    func cleanup() throws {
        if removed { return }
        try verifySource()
        let root = try Self.plainDirectory(directory)
        guard root.st_dev == directoryIdentity.st_dev, root.st_ino == directoryIdentity.st_ino else { throw Failure.changed }
        if cleanupSnapshot == nil {
            guard !resourceIsolated, resourceTransition == nil else { throw Failure.resourceUncertain }
            guard providerOperation == nil || ruleProviderIsolated else { throw Failure.resourceUncertain }
            try verify()
            let providerTargets = try ruleProviderFiles?.validatedTargetInventory() ?? []
            var targetFacts = [String: RelayTunRuntimeRuleProviderFiles.Fact]()
            for entry in providerTargets {
                guard providerPaths.contains(entry.path), entry.facts.count == 1,
                      let fact = entry.facts.first, fact.sha256 != nil else { throw Failure.changed }
                targetFacts[entry.path] = fact
            }
            if resourceInbox != nil || ruleProviderFiles != nil {
                // Validate the complete union before either owner deletes.
                // No retained-name prefix or unknown inbox child is ignored.
                let managed = resourceInbox?.inventory ?? []
                let providerManaged = ruleProviderFiles?.inventory ?? []
                let allowed = Set(inventories.keys).union(["api.sock", "cache.db"])
                    .union(managed.map { $0.path }).union(providerManaged.map { $0.path })
                let parents = Set(allowed.flatMap { path -> [String] in
                    let pieces = path.split(separator: "/"); return pieces.indices.dropFirst().map { pieces.prefix($0).joined(separator: "/") }
                })
                let names = Set(try FileManager.default.subpathsOfDirectory(atPath: directory))
                guard names.isSubset(of: allowed.union(parents)) else { throw Failure.conflict }
                // Validate static parents and the two Core runtime entries
                // before either managed owner removes a retained payload.
                // A foreign socket/type must not cause partial cleanup.
                let managedNames = Set(managed.map { $0.path }).union(providerManaged.map { $0.path })
                for name in names {
                    if parents.contains(name) { _ = try Self.plainDirectory(directory + "/" + name) }
                    else if inventories[name] == nil, !managedNames.contains(name) {
                        var info = stat()
                        guard lstat(directory + "/" + name, &info) == 0 else { throw Failure.changed }
                        try validateCoreRuntime(info, name: name)
                    }
                }
                for entry in managed {
                    var current = stat(); guard lstat(directory + "/" + entry.path, &current) == 0 else { throw Failure.changed }
                    if entry.directory {
                        let plain = try Self.plainDirectory(directory + "/" + entry.path)
                        guard plain.st_dev == entry.identity.st_dev, plain.st_ino == entry.identity.st_ino,
                              plain.st_gid == entry.identity.st_gid else { throw Failure.changed }
                    } else {
                        guard Self.same(current, entry.identity), current.st_gid == entry.identity.st_gid else { throw Failure.changed }
                        if let sha = entry.sha256 {
                            guard Self.digest(try Self.read(directory + "/" + entry.path, maximum: Self.maximumAssetBytes).0) == sha else { throw Failure.changed }
                        }
                    }
                }
                // The caller has already proved the active Core closed. Files
                // validates paired finite layouts, including an uncertain swap,
                // without adopting a ledger or restoring the old body.
                try ruleProviderFiles?.cleanup()
                try resourceInbox?.cleanup()
            }
            let names = try FileManager.default.subpathsOfDirectory(atPath: directory)
            let allowedFiles = Set(inventories.keys).union(["api.sock", "cache.db"])
            let allowedDirs = Set(inventories.keys.flatMap { path -> [String] in
                let pieces = path.split(separator: "/"); return pieces.indices.dropFirst().map { pieces.prefix($0).joined(separator: "/") }
            })
            guard Set(names).isSubset(of: allowedFiles.union(allowedDirs)) else { throw Failure.conflict }
            var observed: [String: stat] = [:]
            for name in names {
                let path = directory + "/" + name
                var info = stat(); guard lstat(path, &info) == 0 else { throw Failure.conflict }
                if allowedDirs.contains(name) { _ = try Self.plainDirectory(path) }
                else if inventories[name] == nil {
                    try validateCoreRuntime(info, name: name)
                }
                if let fact = targetFacts[name] {
                    guard Self.same(info, fact.identity), info.st_gid == fact.identity.st_gid, let sha = fact.sha256 else { throw Failure.changed }
                    cleanupHashes[name] = sha
                } else if let original = inventories[name] { cleanupHashes[name] = original.1 }
                observed[name] = info
            }
            cleanupSnapshot = observed; cleanupDirectories = allowedDirs
        }
        guard let original = cleanupSnapshot else { throw Failure.conflict }
        let remaining = Set(original.keys).subtracting(deleted)
        let currentNames = Set(try FileManager.default.subpathsOfDirectory(atPath: directory))
        guard currentNames == remaining else { throw Failure.conflict }
        for name in deleted {
            var info = stat()
            guard lstat(directory + "/" + name, &info) == -1, errno == ENOENT else { throw Failure.changed }
        }
        for name in remaining.sorted(by: { $0.count > $1.count }) {
            let parent = try Self.plainDirectory(directory)
            guard parent.st_dev == directoryIdentity.st_dev, parent.st_ino == directoryIdentity.st_ino,
                  let before = original[name] else { throw Failure.changed }
            var current = stat()
            guard lstat(directory + "/" + name, &current) == 0 else { throw Failure.changed }
            if cleanupDirectories.contains(name) {
                // Our own earlier child removal changes directory times/size.
                _ = try Self.plainDirectory(directory + "/" + name)
                guard before.st_dev == current.st_dev, before.st_ino == current.st_ino,
                      before.st_uid == current.st_uid, before.st_mode == current.st_mode else { throw Failure.changed }
            } else {
                guard Self.same(before, current) else { throw Failure.changed }
                if let hash = cleanupHashes[name] {
                    guard Self.digest(try Self.read(directory + "/" + name, maximum: Self.maximumAssetBytes).0) == hash else { throw Failure.changed }
                }
            }
            guard (cleanupDirectories.contains(name) ? rmdir(directory + "/" + name) : unlink(directory + "/" + name)) == 0 else { throw Failure.conflict }
            deleted.insert(name)
            #if RELAY_TUN_APP_BUNDLE_TESTS
            try afterRemovalForTest?()
            #endif
        }
        guard rmdir(directory) == 0 else { throw Failure.conflict }; removed = true
    }
}
