import Foundation
import Darwin
import Security

struct RelayBrowserBinding: Codable, Equatable {
    let instanceId: String
    let configurationRevision: String
    let pid: Int32
    let httpPort: Int
    let socksPort: Int?
    let route: String

    func validate() throws {
        guard UUID(uuidString: instanceId)?.uuidString.lowercased() == instanceId,
              configurationRevision.utf8.count == 64,
              configurationRevision.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              pid > 0, (1024...65535).contains(httpPort),
              socksPort.map({ (1024...65535).contains($0) && $0 != httpPort }) ?? true,
              !route.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, route.utf16.count <= 256,
              !route.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !["DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL", "COMPATIBLE"].contains(route) else {
            throw AssistantError("Relay 专用代理归属未确认。")
        }
    }
}

// Adapted from RelayTerminalLeaseSocket's bounded AF_UNIX lane. No request
// carries a URL, credentials, proxy mutation or arbitrary path. The locator
// supplies discovery; the live peer's audit token supplies authority.
enum RelayBrowserBindingClient {
    static func resources() throws -> URL {
        var bytes = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(getpid(), &bytes, UInt32(bytes.count)) > 0 else { throw AssistantError("浏览器资源身份未确认。") }
        let executable = URL(fileURLWithPath: String(cString: bytes)).resolvingSymlinksInPath()
        let directory = executable.deletingLastPathComponent()
        let resources: URL
        if directory.lastPathComponent == "MacOS", directory.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "RelayBrowser.app" {
            resources = directory.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        } else { resources = directory }
        guard resources.lastPathComponent == "relay", resources.deletingLastPathComponent().lastPathComponent == "Resources",
              resources.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "Contents",
              ["RelayNative", "RelayBrowser"].contains(executable.lastPathComponent) else { throw AssistantError("浏览器必须从 Relay 安装包运行。") }
        return resources
    }

    private static func peer(_ fd: Int32, app: URL) throws -> Data {
        var uid: uid_t = 0, gid: gid_t = 0, token = audit_token_t()
        var count = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &count) == 0,
              count == MemoryLayout<audit_token_t>.size else { throw AssistantError("Relay 在线进程身份未确认。") }
        let audit = withUnsafeBytes(of: &token) { Data($0) }
        var code: SecCode?, staticCode: SecStaticCode?, path: CFURL?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit as String: audit] as CFDictionary, [], &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, .noNetworkAccess, nil) == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopyPath(staticCode, [], &path) == errSecSuccess, let path,
              (path as URL).resolvingSymlinksInPath() == app,
              Bundle(url: app)?.bundleIdentifier == "local.relay.network.preview" else {
            throw AssistantError("浏览器未连接到同一安装包的 Relay。")
        }
        return audit
    }

    static func decode(_ bytes: Data, nonce: String) throws -> RelayBrowserBinding {
        guard bytes.count <= 4096,
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(value.keys) == ["version", "nonce", "binding"], value["version"] as? Int == 1,
              value["nonce"] as? String == nonce, let object = value["binding"] as? [String: Any],
              Set(object.keys) == ["instanceId", "configurationRevision", "pid", "httpPort", "route"] ||
                Set(object.keys) == ["instanceId", "configurationRevision", "pid", "httpPort", "socksPort", "route"] else {
            throw AssistantError("浏览器代理回执无效。")
        }
        let binding = try JSONDecoder().decode(RelayBrowserBinding.self, from: JSONSerialization.data(withJSONObject: object))
        try binding.validate()
        return binding
    }

    static func read(home: URL) throws -> RelayBrowserBinding {
        let root = try RelayPreferenceStore(RelayBrowserContract.context(home: home)).root
        let directory = root.appendingPathComponent("Browser", isDirectory: true)
        let locator = directory.appendingPathComponent("active.json")
        guard let first = try RelayRecoveryInspector.read(locator, limit: 256), first.mode == 0o600,
              let object = try JSONSerialization.jsonObject(with: first.data) as? [String: Any],
              Set(object.keys) == ["version", "endpoint"], object["version"] as? Int == 1,
              let endpoint = object["endpoint"] as? String,
              endpoint.range(of: "^b-[a-f0-9]{16}\\.sock$", options: .regularExpression) != nil else { throw AssistantError("Relay 浏览器入口未在线。") }
        let path = directory.appendingPathComponent(endpoint).path
        try NetworkConfiguration.checkPlainPath(URL(fileURLWithPath: path))
        var info = stat()
        guard lstat(path, &info) == 0, info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
              info.st_mode & 0o777 == 0o600, path.utf8.count <= 103 else { throw AssistantError("Relay 浏览器通道不可用。") }
        let app = try resources().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw AssistantError("Relay 浏览器通道不可用。") }
        defer { Darwin.close(fd) }
        var timeout = timeval(tv_sec: 3, tv_usec: 0), yes: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0,
              fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw AssistantError("Relay 浏览器通道不可用。") }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: Array(path.utf8)) }
        let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard connected == 0 else { throw AssistantError("Relay 浏览器入口未在线。") }
        let identity = try peer(fd, app: app)
        var random = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw AssistantError("浏览器通道随机数不可用。") }
        let nonce = random.map { String(format: "%02x", $0) }.joined()
        let request = Data(("{\"version\":1,\"action\":\"binding\",\"nonce\":\"" + nonce + "\"}\n").utf8)
        var offset = 0
        while offset < request.count {
            let sent = request.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), request.count - offset) }
            if sent < 0 && errno == EINTR { continue }
            guard sent > 0 else { throw AssistantError("Relay 浏览器通道已关闭。") }; offset += sent
        }
        var response = Data(), buffer = [UInt8](repeating: 0, count: 1024)
        while response.last != 10 {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0, response.count + count <= 4097 else { throw AssistantError("Relay 浏览器回执未确认。") }
            response.append(contentsOf: buffer.prefix(count))
        }
        guard try peer(fd, app: app) == identity,
              try RelayRecoveryInspector.read(locator, limit: 256)?.data == first.data else { throw AssistantError("Relay 浏览器归属已改变。") }
        return try decode(response.dropLast(), nonce: nonce)
    }
}
