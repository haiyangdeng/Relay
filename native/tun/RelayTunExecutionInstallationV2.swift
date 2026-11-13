// Separate version-2 installation contract. Legacy readers do not call this
// adapter. Live reads reuse the existing root-owned, descriptor-checked reader.
import Foundation
import Darwin

struct RelayTunExecutionInstallationV2 {
    typealias Receipt = RelayTunExecutionReceiptV2
    enum Failure: Error { case schema, file, identity, uid }
    struct FileFacts {
        let data: Data?, sha256: String, size: Int
        let owner: uid_t, mode: mode_t, plainParents: Bool, stable: Bool, regular: Bool, links: nlink_t
    }
    typealias Reader = (String, Int, Bool, Bool) throws -> FileFacts
    typealias Signature = (String, RelayTunCodePin) throws -> Void
    let revision: String
    let clientUID: uid_t
    let clientPin: RelayTunCodePin
    let profile: Receipt.Profile
    let core: Receipt.CoreIdentity
    var executable: String { Self.corePath(core.architecture) }
    static let root = RelayTunManagedInstallation.root
    static let manifest = root + "/installation.json"
    static let client = root + "/RelayTunClient"
    static let lock = root + "/busy.lock"
    static let uninstaller = root + "/uninstall.py"
    static let role = "core-managed-v2"
    static func corePath(_ architecture: Receipt.Architecture) -> String {
        root + "/Core/darwin-" + architecture.rawValue + "/mihomo"
    }
    private static func checked(_ value: FileFacts, mode: mode_t, limit: Int = 134217728) throws {
        guard value.owner == 0, value.mode == mode, value.plainParents, value.stable,
              value.regular, value.links == 1, value.size > 0, value.size <= limit else { throw Failure.file }
    }
    static func load(currentUID: uid_t, architecture: Receipt.Architecture,
                     read: Reader, signature: Signature) throws -> Self {
        guard currentUID > 0 else { throw Failure.uid }
        let record = try read(manifest, 16384, true, false)
        try checked(record, mode: 0o644, limit: 16384)
        guard let bytes = record.data, record.size == bytes.count,
              record.sha256 == Receipt.digest(bytes) else { throw Failure.identity }
        let value = try RelayTunStrictJSON.object(bytes, limit: 16384)
        guard Set(value.keys) == ["version", "role", "clientUID", "client", "coreProfile", "cores", "uninstallerSHA256"],
              RelayTunStrictJSON.integer(value["version"]) == 2,
              value["role"] as? String == role,
              let uid = RelayTunStrictJSON.integer(value["clientUID"]), uid > 0,
              UInt64(uid) == UInt64(currentUID),
              let family = value["coreProfile"] as? String, let profile = Receipt.Profile(rawValue: family),
              let listed = value["cores"] as? [String: Any], Set(listed.keys) == ["arm64", "x86_64"] else { throw Failure.schema }
        let pin = try RelayTunHelperTrust.codePin(value["client"])
        let clientFile = try read(client, 134217728, false, false)
        try checked(clientFile, mode: 0o755)
        guard clientFile.sha256 == pin.sha256, clientFile.size == pin.size else { throw Failure.identity }
        try signature(client, pin)
        var selected: Receipt.CoreIdentity?
        for arch in Receipt.Architecture.allCases {
            let candidates = Receipt.corePins.filter { $0.profile == profile && $0.architecture == arch }
            guard candidates.count == 1, let expected = candidates.first else { throw Failure.identity }
            let key = arch == .arm64 ? "arm64" : "x86_64"
            guard let item = listed[key] as? [String: Any], Set(item.keys) == ["sha256", "size"],
                  item["sha256"] as? String == expected.sha256,
                  RelayTunStrictJSON.integer(item["size"]) == expected.size else { throw Failure.identity }
            let body = try read(corePath(arch), 134217728, false, true)
            try checked(body, mode: 0o4755)
            guard body.sha256 == expected.sha256, body.size == expected.size else { throw Failure.identity }
            if arch == architecture { selected = expected }
        }
        let busy = try read(lock, 64, true, false)
        try checked(busy, mode: 0o644, limit: 64)
        guard let busyBytes = busy.data, busyBytes == RelayTunManagedInstallation.lockBytes,
              busy.size == busyBytes.count, busy.sha256 == Receipt.digest(busyBytes) else { throw Failure.identity }
        let uninstall = try read(uninstaller, 65536, false, false)
        try checked(uninstall, mode: 0o755, limit: 65536)
        guard RelayTunHelperTrust.hex(value["uninstallerSHA256"], count: 64) == uninstall.sha256,
              let selected else { throw Failure.identity }
        return .init(revision: record.sha256, clientUID: currentUID, clientPin: pin, profile: profile, core: selected)
    }
}

// These live operations are reached only by the execution-v2 launch contract.
// The pure loader remains independently testable without /Library or a Core.
extension RelayTunExecutionInstallationV2 {
    static func load() throws -> Self {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { throw Failure.uid }
        #if arch(arm64)
        let architecture: Receipt.Architecture = .arm64
        #else
        let architecture: Receipt.Architecture = .x64
        #endif
        return try load(currentUID: getuid(), architecture: architecture, read: { path, limit, contents, setuidCore in
            let file = try RelayTunHelperTrust.managedFileFacts(path, limit: limit, contents: contents, setuidCore: setuidCore)
            return .init(data: file.data, sha256: file.sha256, size: file.size, owner: file.owner, mode: file.mode,
                         plainParents: file.plainParents, stable: file.stable, regular: file.regular, links: file.links)
        }, signature: RelayTunHelperTrust.verifySignature)
    }
    // Share the established lock description with this invocation's exact Core.
    // The complete installation is re-read after flock; a changed revision is
    // terminal and never falls back to the old manifest or another profile.
    func holdInstallation() throws -> FileHandle {
        guard getuid() == clientUID, getuid() > 0, geteuid() == getuid(), getgid() == getegid() else { throw Failure.uid }
        let fd = open(Self.lock, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.file }
        do {
            var held = stat(), linked = stat()
            guard fstat(fd, &held) == 0, lstat(Self.lock, &linked) == 0,
                  held.st_dev == linked.st_dev, held.st_ino == linked.st_ino,
                  held.st_uid == 0, held.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  held.st_mode & 0o7777 == 0o644, held.st_nlink == 1,
                  flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw Failure.file }
            guard try Self.load().revision == revision else { throw Failure.identity }
            var after = stat()
            guard fstat(fd, &after) == 0, lstat(Self.lock, &linked) == 0,
                  after.st_dev == held.st_dev, after.st_ino == held.st_ino,
                  after.st_dev == linked.st_dev, after.st_ino == linked.st_ino,
                  after.st_uid == 0, after.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  after.st_mode & 0o7777 == 0o644, after.st_nlink == 1 else { throw Failure.identity }
            return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        } catch { Darwin.close(fd); throw error }
    }
}
