import Foundation
import CryptoKit
import Security
import Darwin

/// Separate installation identity for the user-approved Mihomo-owned TUN
/// architecture. No legacy Mach service or shared Clash installation is used.
struct RelayTunManagedInstallation {
    static let root = "/Library/Application Support/Relay/TunManaged"
    static let manifest = root + "/installation.json"
    static let client = root + "/RelayTunClient"
    static let lockPath = root + "/busy.lock"
    static let uninstaller = root + "/uninstall.py"
    static let lockBytes = Data("Relay core-managed TUN v1\n".utf8)
    static let role = "core-managed-v1"
    static let cores = ["arm64": root + "/Core/darwin-arm64/mihomo", "x86_64": root + "/Core/darwin-x64/mihomo"]
    enum CoreProfile { case official, localGeodata }
    static let localGeodataPins = [
        "arm64": ("e9327b2ce0e5c4405ce2640145339be9e315943bdeb63ffee4b3f4fe18bee419", 65185184),
        "x86_64": ("1d110d7f958abd22ec011ac466f7451bf22101f8b6338a26a3e9fedcbd62ae26", 70035456)]
    static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }
    let revision: String
    let clientUID: uid_t
    let clientPin: RelayTunCodePin
    let coreProfile: CoreProfile
    var executable: String { Self.cores[Self.architecture]! }
    var coreSHA256: String { Self.pins(coreProfile)[Self.architecture]!.0 }
    static func pins(_ profile: CoreProfile) -> [String: (String, Int)] {
        profile == .localGeodata ? localGeodataPins : RelayTunInstallationPaths.fixedCorePins
    }
    static func profile(_ value: Any?) throws -> CoreProfile {
        if value == nil { return .official }
        guard value as? String == "local-geodata-v1" else { throw RelayTunHelperFailure.invalidManifest }
        return .localGeodata
    }
    func validateLaunch(resources: Bool) throws {
        guard resources == (coreProfile == .localGeodata) else { throw RelayTunHelperFailure.invalidManifest }
    }

    static func load() throws -> Self {
        let manifest = try RelayTunHelperTrust.managedFile(Self.manifest, limit: 16384, contents: true)
        guard manifest.mode == 0o644, let bytes = manifest.data else { throw RelayTunHelperFailure.unsafeInstallation }
        let raw = try RelayTunStrictJSON.object(bytes, limit: 16384)
        let profile = try Self.profile(raw["coreProfile"])
        let keys: Set<String> = ["version", "role", "clientUID", "client", "cores", "uninstallerSHA256"]
        guard Set(raw.keys) == keys.union(profile == .localGeodata ? ["coreProfile"] : []),
              RelayTunStrictJSON.integer(raw["version"]) == 1, raw["role"] as? String == role,
              let uid = RelayTunStrictJSON.integer(raw["clientUID"]), uid > 0, uid <= Int(UInt32.max),
              let cores = raw["cores"] as? [String: Any], Set(cores.keys) == ["arm64", "x86_64"] else { throw RelayTunHelperFailure.invalidManifest }
        let pin = try RelayTunHelperTrust.codePin(raw["client"])
        let client = try RelayTunHelperTrust.managedFile(Self.client, limit: 134217728, contents: false)
        guard client.mode == 0o755, client.sha256 == pin.sha256, client.size == pin.size else { throw RelayTunHelperFailure.changedResource }
        try RelayTunHelperTrust.verifySignature(Self.client, pin)
        for architecture in ["arm64", "x86_64"] {
            let fixed = Self.pins(profile)[architecture]!
            guard let item = cores[architecture] as? [String: Any], Set(item.keys) == ["sha256", "size"],
                  item["sha256"] as? String == fixed.0, RelayTunStrictJSON.integer(item["size"]) == fixed.1 else { throw RelayTunHelperFailure.invalidManifest }
            let core = try RelayTunHelperTrust.managedFile(Self.cores[architecture]!, limit: 134217728, contents: false, setuidCore: true)
            guard core.sha256 == fixed.0, core.size == fixed.1 else { throw RelayTunHelperFailure.changedResource }
        }
        let lock = try RelayTunHelperTrust.managedFile(lockPath, limit: 64, contents: true)
        guard lock.mode == 0o644, lock.data == lockBytes else { throw RelayTunHelperFailure.unsafeInstallation }
        let uninstall = try RelayTunHelperTrust.managedFile(uninstaller, limit: 65536, contents: false)
        guard uninstall.mode == 0o755, RelayTunHelperTrust.hex(raw["uninstallerSHA256"], count: 64) == uninstall.sha256 else { throw RelayTunHelperFailure.changedResource }
        return .init(revision: manifest.sha256, clientUID: uid_t(uid), clientPin: pin, coreProfile: profile)
    }

    /// The client and its held core inherit this same lock description. An
    /// orphan core still prevents another session or installer from proceeding.
    func holdInstallation() throws -> FileHandle {
        guard getuid() == clientUID, geteuid() == getuid() else { throw RelayTunHelperFailure.unsafeInstallation }
        let fd = open(Self.lockPath, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        do {
            var held = stat(), linked = stat()
            guard fstat(fd, &held) == 0, lstat(Self.lockPath, &linked) == 0,
                  held.st_dev == linked.st_dev, held.st_ino == linked.st_ino,
                  held.st_uid == 0, held.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  held.st_mode & 0o7777 == 0o644, held.st_nlink == 1,
                  flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw RelayTunHelperFailure.unsafeInstallation }
            guard try Self.load().revision == revision else { throw RelayTunHelperFailure.changedResource }
            var after = stat()
            guard fstat(fd, &after) == 0, lstat(Self.lockPath, &linked) == 0,
                  after.st_dev == held.st_dev, after.st_ino == held.st_ino,
                  after.st_dev == linked.st_dev, after.st_ino == linked.st_ino,
                  after.st_uid == 0, after.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  after.st_mode & 0o7777 == 0o644, after.st_nlink == 1 else { throw RelayTunHelperFailure.changedResource }
            return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        } catch { Darwin.close(fd); throw error }
    }
}

enum RelayTunHelperFailure: String, Error {
    case invalidJSON, invalidManifest, unsafeInstallation, changedResource, invalidSignature
    case invalidRequest, replayedRequest, untrustedPeer, executorUnavailable, invalidReply
}

/// A small structural pass rejects duplicate keys before Foundation decodes the
/// values. JSONDecoder alone silently accepts duplicate object keys.
enum RelayTunStrictJSON {
    static func object(_ data: Data, limit: Int = 16384, maxNodes: Int = 4096) throws -> [String: Any] {
        guard !data.isEmpty, data.count <= limit, (1...200000).contains(maxNodes),
              String(data: data, encoding: .utf8) != nil else { throw RelayTunHelperFailure.invalidJSON }
        var scanner = Scanner(bytes: Array(data), maxNodes: maxNodes)
        try scanner.value(depth: 0); scanner.space()
        guard scanner.index == data.count, let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw RelayTunHelperFailure.invalidJSON }
        return result
    }
    static func integer(_ raw: Any?) -> Int? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value.rounded() == value, value >= 0, value <= Double(UInt32.max) else { return nil }
        return Int(value)
    }
    private struct Scanner {
        let bytes: [UInt8]
        let maxNodes: Int
        var index = 0
        var count = 0
        mutating func space() { while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 } }
        mutating func take(_ byte: UInt8) throws { space(); guard index < bytes.count, bytes[index] == byte else { throw RelayTunHelperFailure.invalidJSON }; index += 1 }
        mutating func string() throws -> String {
            space(); let start = index; try take(34)
            while index < bytes.count {
                let byte = bytes[index]; index += 1
                if byte == 34 {
                    let data = Data(bytes[start..<index])
                    // One bounded typed projection may travel inside a prepare
                    // request as hex; total request/journal byte limits still
                    // bound every allocation. No other string may be this long.
                    guard let value = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? String, value.utf8.count <= 65536 else { throw RelayTunHelperFailure.invalidJSON }
                    return value
                }
                if byte == 92 { guard index < bytes.count else { throw RelayTunHelperFailure.invalidJSON }; index += 1 }
            }
            throw RelayTunHelperFailure.invalidJSON
        }
        mutating func value(depth: Int) throws {
            count += 1; space()
            guard depth <= 12, count <= maxNodes, index < bytes.count else { throw RelayTunHelperFailure.invalidJSON }
            switch bytes[index] {
            case 123:
                index += 1; space(); var names = Set<String>()
                if index < bytes.count && bytes[index] == 125 { index += 1; return }
                while true {
                    let name = try string(); guard names.insert(name).inserted else { throw RelayTunHelperFailure.invalidJSON }
                    try take(58); try value(depth: depth + 1); space()
                    guard index < bytes.count else { throw RelayTunHelperFailure.invalidJSON }
                    if bytes[index] == 125 { index += 1; return }; try take(44)
                }
            case 91:
                index += 1; space()
                if index < bytes.count && bytes[index] == 93 { index += 1; return }
                while true { try value(depth: depth + 1); space(); guard index < bytes.count else { throw RelayTunHelperFailure.invalidJSON }; if bytes[index] == 93 { index += 1; return }; try take(44) }
            case 34: _ = try string()
            default:
                let start = index
                while index < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[index]) { index += 1 }
                guard index > start else { throw RelayTunHelperFailure.invalidJSON }
                _ = try JSONSerialization.jsonObject(with: Data(bytes[start..<index]), options: .fragmentsAllowed)
            }
        }
    }
}

enum RelayTunInstallationPaths {
    static let service = "local.relay.network.tun"
    static let receiptID = "local.relay.network.tun.network-executor-v1"
    static let packageVersion = "0.30.1"
    static let manifestVersion = 2
    static let role = "network-executor-v1"
    static let container = "/Library/Application Support/Relay"
    static let root = container + "/Tun"
    static let manifest = root + "/installation.json"
    static let launchDaemon = "/Library/LaunchDaemons/" + service + ".plist"
    static let helper = "/Library/PrivilegedHelperTools/" + service
    static let client = root + "/RelayTunClient"
    static let uninstaller = "/Library/PrivilegedHelperTools/" + service + ".uninstall"
    static let uninstallIntent = "/Library/PrivilegedHelperTools/" + service + ".uninstall-intent.json"
    static let cores = ["arm64": root + "/Core/darwin-arm64/mihomo", "x86_64": root + "/Core/darwin-x64/mihomo"]
    static let ownedDirectories = [container, root, root + "/Core", root + "/Core/darwin-arm64", root + "/Core/darwin-x64"]
    static var files: [String] { [helper, client, uninstaller, manifest, launchDaemon] + [cores["arm64"]!, cores["x86_64"]!] }
    static var payloadFiles: [String] { files.filter { $0 != uninstaller } }
    static let fixedCorePins = ["arm64": ("f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9", 56810034), "x86_64": ("291f5923c3dd3b8df36eaeccdd59eaf873ee021693cde65eb696f8b86ac99652", 60945968)]
    static var launchDaemonConfiguration: [String: Any] {
        ["Label": service, "ProgramArguments": [helper, "--serve"], "MachServices": [service: true], "UserName": "root", "GroupName": "wheel", "ProcessType": "Background", "RunAtLoad": false, "KeepAlive": false]
    }
}

struct RelayTunCodePin {
    let sha256: String
    let size: Int
    let cdhashes: [String: String]
    var requirement: String {
        "(" + ["arm64", "x86_64"].map { "cdhash H\"" + cdhashes[$0]! + "\"" }.joined(separator: " or ") + ")"
    }
}
struct RelayTunInstallationTrust {
    let revision: String
    let clientUID: uid_t
    let helper: RelayTunCodePin
    let client: RelayTunCodePin
    let uninstaller: RelayTunCodePin
    let launchDaemonSHA256: String
    let coreSHA256: [String: String]
    static func load() throws -> Self { try RelayTunHelperTrust.loadLive() }
}

private struct RelayTunTrustedFile {
    let data: Data?
    let sha256: String
    let size: Int
    let owner: uid_t
    let mode: mode_t
    let plainParents: Bool
    let stable: Bool
    let regular: Bool
    let links: nlink_t
}

enum RelayTunHelperTrust {
    private static let maximumBinary = 134217728
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func hex(_ raw: Any?, count: Int) -> String? {
        guard let value = raw as? String, value.utf8.count == count, value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }; return value
    }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    /// openat keeps every checked parent pinned while the next component is
    /// opened. No environment override, user-selected path or root fallback.
    private static func liveFile(_ path: String, limit: Int, contents: Bool) throws -> RelayTunTrustedFile {
        try readRootFile(path, limit: limit, contents: contents, setuidCore: false)
    }
    // The new core-managed installation admits setuid only for its fixed core
    // resources. Legacy helper/client/uninstaller validation remains unchanged.
    fileprivate static func managedFile(_ path: String, limit: Int, contents: Bool, setuidCore: Bool = false) throws -> RelayTunTrustedFile {
        guard path.hasPrefix(RelayTunManagedInstallation.root + "/"),
              !setuidCore || RelayTunManagedInstallation.cores.values.contains(path) else { throw RelayTunHelperFailure.unsafeInstallation }
        return try readRootFile(path, limit: limit, contents: contents, setuidCore: setuidCore)
    }
    // New versioned readers share the mature descriptor and fixed-path checks
    // without exposing the private file type or changing any legacy admission.
    static func managedFileFacts(_ path: String, limit: Int, contents: Bool, setuidCore: Bool = false) throws ->
        (data: Data?, sha256: String, size: Int, owner: uid_t, mode: mode_t, plainParents: Bool, stable: Bool, regular: Bool, links: nlink_t) {
        let file = try managedFile(path, limit: limit, contents: contents, setuidCore: setuidCore)
        return (file.data, file.sha256, file.size, file.owner, file.mode, file.plainParents, file.stable, file.regular, file.links)
    }
    private static func readRootFile(_ path: String, limit: Int, contents: Bool, setuidCore: Bool) throws -> RelayTunTrustedFile {
        guard path.hasPrefix("/Library/"), !path.utf8.contains(0) else { throw RelayTunHelperFailure.unsafeInstallation }
        let parts = path.split(separator: "/").map(String.init)
        var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        defer { Darwin.close(directory) }
        var info = stat()
        guard fstat(directory, &info) == 0, info.st_uid == 0, info.st_mode & 0o022 == 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        for part in parts.dropLast() {
            let next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw RelayTunHelperFailure.unsafeInstallation }
            var parent = stat()
            guard fstat(next, &parent) == 0, parent.st_uid == 0, parent.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), parent.st_mode & 0o6022 == 0 else { Darwin.close(next); throw RelayTunHelperFailure.unsafeInstallation }
            Darwin.close(directory); directory = next
        }
        let descriptor = openat(directory, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw RelayTunHelperFailure.unsafeInstallation }
        defer { Darwin.close(descriptor) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(descriptor, &before) == 0, before.st_uid == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), before.st_nlink == 1,
              (setuidCore ? before.st_mode & 0o7777 == 0o4755 : before.st_mode & 0o7022 == 0),
              before.st_size > 0, before.st_size <= limit else { throw RelayTunHelperFailure.unsafeInstallation }
        var hasher = SHA256(), data = Data(), total = 0, buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw RelayTunHelperFailure.changedResource }
            if count == 0 { break }; total += count
            guard total <= limit else { throw RelayTunHelperFailure.changedResource }
            let bytes = Data(buffer.prefix(count)); hasher.update(data: bytes); if contents { data.append(bytes) }
        }
        guard total == before.st_size, fstat(descriptor, &after) == 0, fstatat(directory, parts.last!, &linked, AT_SYMLINK_NOFOLLOW) == 0, same(before, after), same(before, linked) else { throw RelayTunHelperFailure.changedResource }
        return RelayTunTrustedFile(data: contents ? data : nil, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined(), size: total, owner: before.st_uid, mode: before.st_mode & 0o7777, plainParents: true, stable: true, regular: true, links: before.st_nlink)
    }
    private static func checked(_ file: RelayTunTrustedFile, manifest: Bool) throws {
        guard file.owner == 0, file.plainParents, file.stable, file.regular, file.links == 1, file.mode & 0o7022 == 0, manifest ? file.mode == 0o644 : file.mode & 0o555 == 0o555 else { throw RelayTunHelperFailure.unsafeInstallation }
    }
    static func codePin(_ raw: Any?) throws -> RelayTunCodePin {
        guard let object = raw as? [String: Any], Set(object.keys) == ["sha256", "size", "cdhashes"], let sha = hex(object["sha256"], count: 64), let size = RelayTunStrictJSON.integer(object["size"]), (1...maximumBinary).contains(size), let hashes = object["cdhashes"] as? [String: Any], Set(hashes.keys) == ["arm64", "x86_64"], let arm = hex(hashes["arm64"], count: 40), let intel = hex(hashes["x86_64"], count: 40) else { throw RelayTunHelperFailure.invalidManifest }
        return RelayTunCodePin(sha256: sha, size: size, cdhashes: ["arm64": arm, "x86_64": intel])
    }
    private static func validate(_ read: (String, Int, Bool) throws -> RelayTunTrustedFile, signature: (String, RelayTunCodePin) throws -> Void) throws -> RelayTunInstallationTrust {
        let manifest = try read(RelayTunInstallationPaths.manifest, 16384, true); try checked(manifest, manifest: true)
        guard let data = manifest.data else { throw RelayTunHelperFailure.invalidManifest }
        let object = try RelayTunStrictJSON.object(data)
        guard Set(object.keys) == ["version", "role", "service", "clientUID", "helper", "client", "uninstaller", "launchDaemonSHA256", "cores"], RelayTunStrictJSON.integer(object["version"]) == RelayTunInstallationPaths.manifestVersion, object["role"] as? String == RelayTunInstallationPaths.role, object["service"] as? String == RelayTunInstallationPaths.service, let uid = RelayTunStrictJSON.integer(object["clientUID"]), uid > 0, let cores = object["cores"] as? [String: Any], Set(cores.keys) == ["arm64", "x86_64"], let daemonSHA = hex(object["launchDaemonSHA256"], count: 64) else { throw RelayTunHelperFailure.invalidManifest }
        let helper = try codePin(object["helper"]), client = try codePin(object["client"]), uninstaller = try codePin(object["uninstaller"])
        for (path, pin) in [(RelayTunInstallationPaths.helper, helper), (RelayTunInstallationPaths.client, client), (RelayTunInstallationPaths.uninstaller, uninstaller)] {
            let file = try read(path, maximumBinary, false); try checked(file, manifest: false)
            guard file.sha256 == pin.sha256, file.size == pin.size else { throw RelayTunHelperFailure.changedResource }; try signature(path, pin)
        }
        let daemon = try read(RelayTunInstallationPaths.launchDaemon, 16384, true); try checked(daemon, manifest: true)
        guard daemon.sha256 == daemonSHA, let daemonData = daemon.data, let dictionary = try PropertyListSerialization.propertyList(from: daemonData, options: [], format: nil) as? [String: Any], NSDictionary(dictionary: dictionary).isEqual(to: RelayTunInstallationPaths.launchDaemonConfiguration) else { throw RelayTunHelperFailure.invalidManifest }
        for key in ["RunAtLoad", "KeepAlive"] { guard let number = dictionary[key] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID(), !number.boolValue else { throw RelayTunHelperFailure.invalidManifest } }
        guard let mach = dictionary["MachServices"] as? [String: Any], let published = mach[RelayTunInstallationPaths.service] as? NSNumber, CFGetTypeID(published) == CFBooleanGetTypeID(), published.boolValue else { throw RelayTunHelperFailure.invalidManifest }
        let corePins = RelayTunInstallationPaths.fixedCorePins
        for arch in ["arm64", "x86_64"] {
            guard let core = cores[arch] as? [String: Any], Set(core.keys) == ["sha256", "size"], core["sha256"] as? String == corePins[arch]!.0, RelayTunStrictJSON.integer(core["size"]) == corePins[arch]!.1 else { throw RelayTunHelperFailure.invalidManifest }
            let file = try read(RelayTunInstallationPaths.cores[arch]!, maximumBinary, false); try checked(file, manifest: false)
            guard file.sha256 == corePins[arch]!.0, file.size == corePins[arch]!.1 else { throw RelayTunHelperFailure.changedResource }
        }
        let final = try read(RelayTunInstallationPaths.manifest, 16384, true); try checked(final, manifest: true)
        guard final.sha256 == manifest.sha256, final.data == data else { throw RelayTunHelperFailure.changedResource }
        return RelayTunInstallationTrust(revision: manifest.sha256, clientUID: uid_t(uid), helper: helper, client: client, uninstaller: uninstaller, launchDaemonSHA256: daemonSHA, coreSHA256: corePins.mapValues { $0.0 })
    }
    static func loadLive() throws -> RelayTunInstallationTrust { try validate(liveFile, signature: verifySignature) }
    static func verifyCandidateFile(_ path: String, sha256: String) throws {
        guard RelayTunInstallationPaths.files.contains(path), hex(sha256, count: 64) != nil else { throw RelayTunHelperFailure.unsafeInstallation }
        let file = try liveFile(path, limit: maximumBinary, contents: false)
        try checked(file, manifest: [RelayTunInstallationPaths.manifest, RelayTunInstallationPaths.launchDaemon].contains(path))
        guard file.sha256 == sha256 else { throw RelayTunHelperFailure.changedResource }
    }
    static func candidateDigestIfPresent(_ path: String) throws -> String? {
        guard RelayTunInstallationPaths.files.contains(path) else { throw RelayTunHelperFailure.unsafeInstallation }
        var info = stat()
        if lstat(path, &info) != 0 { guard errno == ENOENT else { throw RelayTunHelperFailure.unsafeInstallation }; return nil }
        let file = try liveFile(path, limit: maximumBinary, contents: false)
        try checked(file, manifest: [RelayTunInstallationPaths.manifest, RelayTunInstallationPaths.launchDaemon].contains(path))
        return file.sha256
    }
    static func removalIntentIfPresent() throws -> Data? {
        var info = stat()
        if lstat(RelayTunInstallationPaths.uninstallIntent, &info) != 0 { guard errno == ENOENT else { throw RelayTunHelperFailure.unsafeInstallation }; return nil }
        let file = try liveFile(RelayTunInstallationPaths.uninstallIntent, limit: 16384, contents: true)
        guard file.mode == 0o600, let bytes = file.data else { throw RelayTunHelperFailure.unsafeInstallation }; return bytes
    }
    static func runningUninstallerDigest() throws -> String {
        let file = try liveFile(RelayTunInstallationPaths.uninstaller, limit: maximumBinary, contents: false)
        try checked(file, manifest: false)
        let sha = file.sha256
        var hashes: [String: String] = [:]
        for arch in ["arm64", "x86_64"] {
            var code: SecStaticCode?, info: CFDictionary?
            guard SecStaticCodeCreateWithPathAndAttributes(URL(fileURLWithPath: RelayTunInstallationPaths.uninstaller) as CFURL, [], [kSecCodeAttributeArchitecture: arch] as CFDictionary, &code) == errSecSuccess, let code,
                  SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
                  let object = info as? [String: Any], let unique = object[kSecCodeInfoUnique as String] as? Data else { throw RelayTunHelperFailure.invalidSignature }
            hashes[arch] = unique.map { String(format: "%02x", $0) }.joined()
        }
        let pin = RelayTunCodePin(sha256: sha, size: file.size, cdhashes: hashes)
        try verifySignature(RelayTunInstallationPaths.uninstaller, pin)
        var running: SecCode?, runningStatic: SecStaticCode?, path: CFURL?, requirement: SecRequirement?
        guard SecCodeCopySelf([], &running) == errSecSuccess, let running,
              SecCodeCopyStaticCode(running, [], &runningStatic) == errSecSuccess, let runningStatic,
              SecCodeCopyPath(runningStatic, [], &path) == errSecSuccess, let path,
              (path as URL).standardizedFileURL.path == RelayTunInstallationPaths.uninstaller,
              SecRequirementCreateWithString(pin.requirement as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCheckValidity(running, SecCSFlags(rawValue: kSecCSStrictValidate).union(.noNetworkAccess), requirement) == errSecSuccess,
              try candidateDigestIfPresent(RelayTunInstallationPaths.uninstaller) == sha else { throw RelayTunHelperFailure.invalidSignature }
        return sha
    }
    static func verifySignature(_ path: String, _ pin: RelayTunCodePin) throws {
        for arch in ["arm64", "x86_64"] {
            var staticCode: SecStaticCode?, copied: CFDictionary?
            guard SecStaticCodeCreateWithPathAndAttributes(URL(fileURLWithPath: path) as CFURL, [], [kSecCodeAttributeArchitecture: arch] as CFDictionary, &staticCode) == errSecSuccess, let code = staticCode, SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate).union(.noNetworkAccess), nil) == errSecSuccess, SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess, let info = copied as? [String: Any], let cdhash = info[kSecCodeInfoUnique as String] as? Data, cdhash.map({ String(format: "%02x", $0) }).joined() == pin.cdhashes[arch], let flags = info[kSecCodeInfoFlags as String] as? NSNumber, flags.uint32Value & 0x10000 != 0 else { throw RelayTunHelperFailure.invalidSignature }
            let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
            for key in ["com.apple.security.get-task-allow", "com.apple.security.cs.disable-library-validation", "com.apple.security.cs.allow-dyld-environment-variables", "com.apple.security.cs.allow-unsigned-executable-memory"] {
                if let raw = entitlements[key], !(raw is NSNull) {
                    guard let value = raw as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID(), !value.boolValue else { throw RelayTunHelperFailure.invalidSignature }
                }
            }
        }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(pin.requirement as CFString, [], &requirement) == errSecSuccess else { throw RelayTunHelperFailure.invalidSignature }
    }
    #if RELAY_TUN_HELPER_TESTS
    /// Compiled only into the isolated self-test executable, never the daemon.
    static func testInstallation(manifest: Data, owner: uid_t = 0, safeParents: Bool = true, stable: Bool = true, links: nlink_t = 1, signatureValid: Bool = true, changedFile: Bool = false, daemonOverride: [String: Any]? = nil) throws -> RelayTunInstallationTrust {
        try validate({ path, _, contents in
            if path == RelayTunInstallationPaths.manifest { return RelayTunTrustedFile(data: manifest, sha256: digest(manifest), size: manifest.count, owner: owner, mode: 0o644, plainParents: safeParents, stable: stable, regular: true, links: links) }
            if path == RelayTunInstallationPaths.launchDaemon {
                let bytes = try PropertyListSerialization.data(fromPropertyList: daemonOverride ?? RelayTunInstallationPaths.launchDaemonConfiguration, format: .xml, options: 0)
                return RelayTunTrustedFile(data: bytes, sha256: digest(bytes), size: bytes.count, owner: owner, mode: 0o644, plainParents: safeParents, stable: stable, regular: true, links: links)
            }
            let object = try RelayTunStrictJSON.object(manifest)
            let pin: [String: Any]
            if path == RelayTunInstallationPaths.helper { pin = object["helper"] as! [String: Any] }
            else if path == RelayTunInstallationPaths.client { pin = object["client"] as! [String: Any] }
            else if path == RelayTunInstallationPaths.uninstaller { pin = object["uninstaller"] as! [String: Any] }
            else { let arch = path.contains("darwin-arm64") ? "arm64" : "x86_64"; pin = (object["cores"] as! [String: Any])[arch] as! [String: Any] }
            return RelayTunTrustedFile(data: nil, sha256: changedFile ? String(repeating: "0", count: 64) : pin["sha256"] as! String, size: pin["size"] as! Int, owner: owner, mode: 0o755, plainParents: safeParents, stable: stable, regular: true, links: links)
        }, signature: { _, _ in if !signatureValid { throw RelayTunHelperFailure.invalidSignature } })
    }
    #endif
}
