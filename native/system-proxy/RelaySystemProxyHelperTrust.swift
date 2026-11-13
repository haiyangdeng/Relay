import Foundation
import CryptoKit
import Security
import Darwin

/// Adapted from RelayTunHelperTrust: a separate, administrator-owned install,
/// pinned ad-hoc code identities, and descriptor-relative protected-path reads.
/// No TUN service, Clash helper, user-selected path or executable is admitted.
enum RelaySystemProxyHelperFailure: Error, LocalizedError {
    case installation, peer, request, reply, unavailable
    var errorDescription: String? {
        switch self {
        case .installation: return "Relay 管理员组件未完整安装或版本校验失败，请重新安装配套组件。"
        case .peer: return "Relay 管理员组件身份校验失败，未执行系统代理操作。"
        case .request: return "Relay 管理员组件请求无效或已过期。"
        case .reply: return "Relay 管理员组件返回结果未确认，请刷新代理状态后再操作。"
        case .unavailable: return "Relay 管理员组件暂不可用，请检查后台服务后刷新代理状态。"
        }
    }
}

enum RelaySystemProxyHelperPaths {
    static let service = "local.relay.network.system-proxy"
    static let root = "/Library/Application Support/Relay/SystemProxy"
    static let client = root + "/RelaySystemProxyClient"
    static let manifest = root + "/installation.json"
    static let uninstaller = root + "/uninstall"
    static let helper = "/Library/PrivilegedHelperTools/" + service
    static let daemon = "/Library/LaunchDaemons/" + service + ".plist"
    static let files = [client, manifest, uninstaller, helper, daemon]
    static var present: Bool {
        ([root] + files).contains { path in var value = stat(); return lstat(path, &value) == 0 || errno != ENOENT }
    }
}

struct RelaySystemProxyCodePin: Codable {
    let sha256: String
    let size: Int
    let cdhashes: [String: String]
    var requirement: String { "(" + ["arm64", "x86_64"].map { "cdhash H\"\(cdhashes[$0]!)\"" }.joined(separator: " or ") + ")" }
    func validate() throws {
        guard RelaySystemProxyHelperTrust.hex(sha256, length: 64), size > 0, size <= 33554432,
              Set(cdhashes.keys) == ["arm64", "x86_64"], cdhashes.values.allSatisfy({ RelaySystemProxyHelperTrust.hex($0, length: 40) }) else { throw RelaySystemProxyHelperFailure.installation }
    }
}

struct RelaySystemProxyHelperTrust {
    struct Manifest: Codable {
        let version: Int
        let role: String
        let clientUID: UInt32
        let helper: RelaySystemProxyCodePin
        let client: RelaySystemProxyCodePin
        let daemonSHA256: String
        let uninstallerSHA256: String
    }
    let revision: String
    let manifest: Manifest
    static func hex(_ value: String, length: Int) -> Bool {
        value.utf8.count == length && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    static func protectedFile(_ path: String, limit: Int, mode: mode_t) throws -> Data {
        guard RelaySystemProxyHelperPaths.files.contains(path) else { throw RelaySystemProxyHelperFailure.installation }
        let parts = path.split(separator: "/").map(String.init)
        var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw RelaySystemProxyHelperFailure.installation }
        defer { Darwin.close(directory) }
        var root = stat()
        guard fstat(directory, &root) == 0, root.st_uid == 0, root.st_mode & 0o022 == 0 else { throw RelaySystemProxyHelperFailure.installation }
        for part in parts.dropLast() {
            let next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw RelaySystemProxyHelperFailure.installation }
            var info = stat()
            guard fstat(next, &info) == 0, info.st_uid == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o6022 == 0 else { Darwin.close(next); throw RelaySystemProxyHelperFailure.installation }
            Darwin.close(directory); directory = next
        }
        let fd = openat(directory, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw RelaySystemProxyHelperFailure.installation }
        defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_uid == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), before.st_mode & 0o7777 == mode, before.st_nlink == 1, before.st_size > 0, before.st_size <= limit else { throw RelaySystemProxyHelperFailure.installation }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0, data.count + count <= limit else { throw RelaySystemProxyHelperFailure.installation }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        guard data.count == before.st_size, fstat(fd, &after) == 0, fstatat(directory, parts.last!, &linked, AT_SYMLINK_NOFOLLOW) == 0, same(before, after), same(before, linked) else { throw RelaySystemProxyHelperFailure.installation }
        return data
    }
    static func verifyCode(_ path: String, pin: RelaySystemProxyCodePin) throws {
        try pin.validate()
        let bytes = try protectedFile(path, limit: 33554432, mode: 0o755)
        guard bytes.count == pin.size, digest(bytes) == pin.sha256 else { throw RelaySystemProxyHelperFailure.installation }
        for architecture in ["arm64", "x86_64"] {
            var code: SecStaticCode?, copied: CFDictionary?
            guard SecStaticCodeCreateWithPathAndAttributes(URL(fileURLWithPath: path) as CFURL, [], [kSecCodeAttributeArchitecture: architecture] as CFDictionary, &code) == errSecSuccess, let code,
                  SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate).union(.noNetworkAccess), nil) == errSecSuccess,
                  SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess,
                  let info = copied as? [String: Any], let hash = info[kSecCodeInfoUnique as String] as? Data,
                  hash.map({ String(format: "%02x", $0) }).joined() == pin.cdhashes[architecture],
                  let flags = info[kSecCodeInfoFlags as String] as? NSNumber, flags.uint32Value & 0x10000 != 0 else { throw RelaySystemProxyHelperFailure.installation }
            let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
            guard entitlements.isEmpty else { throw RelaySystemProxyHelperFailure.installation }
        }
    }
    static func parse(_ bytes: Data) throws -> Manifest {
        guard bytes.count <= 16384, let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == ["version", "role", "clientUID", "helper", "client", "daemonSHA256", "uninstallerSHA256"] else { throw RelaySystemProxyHelperFailure.installation }
        let value = try JSONDecoder().decode(Manifest.self, from: bytes)
        guard value.version == 1, value.role == "system-proxy-v1", value.clientUID > 0, value.clientUID < UInt32.max,
              hex(value.daemonSHA256, length: 64), hex(value.uninstallerSHA256, length: 64) else { throw RelaySystemProxyHelperFailure.installation }
        try value.helper.validate(); try value.client.validate()
        return value
    }
    static func load() throws -> Self {
        let bytes = try protectedFile(RelaySystemProxyHelperPaths.manifest, limit: 16384, mode: 0o644)
        let value = try parse(bytes)
        try verifyCode(RelaySystemProxyHelperPaths.helper, pin: value.helper)
        try verifyCode(RelaySystemProxyHelperPaths.client, pin: value.client)
        let daemon = try protectedFile(RelaySystemProxyHelperPaths.daemon, limit: 16384, mode: 0o644)
        let uninstall = try protectedFile(RelaySystemProxyHelperPaths.uninstaller, limit: 65536, mode: 0o755)
        guard digest(daemon) == value.daemonSHA256, digest(uninstall) == value.uninstallerSHA256 else { throw RelaySystemProxyHelperFailure.installation }
        let plist = try PropertyListSerialization.propertyList(from: daemon, format: nil) as? [String: Any]
        guard plist?["Label"] as? String == RelaySystemProxyHelperPaths.service,
              plist?["ProgramArguments"] as? [String] == [RelaySystemProxyHelperPaths.helper, "--serve"],
              (plist?["MachServices"] as? [String: Bool]) == [RelaySystemProxyHelperPaths.service: true],
              plist?["UserName"] == nil, plist?["EnvironmentVariables"] == nil else { throw RelaySystemProxyHelperFailure.installation }
        return Self(revision: digest(bytes), manifest: value)
    }
}
