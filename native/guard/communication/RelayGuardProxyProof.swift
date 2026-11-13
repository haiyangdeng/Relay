import CryptoKit
import Darwin
import Foundation
import Security

enum RelayGuardBindingFailure: Error { case invalid, publisher, process, resource, listener, route, stale }

/// Issued by the native main-process bridge after a Main-only immutable runtime
/// capture. No file path, permission flag or endpoint supplied by a renderer is
/// accepted. Only minimal proof metadata crosses the signed XPC connection;
/// profile text and proxy credentials stay in the main process.
struct RelayGuardProxyProof: Codable, Equatable, Sendable {
    let instanceID: String
    let configurationSHA256: String
    let pid: Int32
    let uid: UInt32
    let bornSeconds: UInt64
    let bornMicroseconds: UInt64
    let executable: String
    let resourceSHA256: String
    let fileIdentity: String
    let ports: [Int]

    static func issue(instanceID: String, configuration: String, pid: Int32) throws -> Self {
        guard getuid() > 0, geteuid() == getuid(), UUID(uuidString: instanceID)?.uuidString.lowercased() == instanceID,
              let bytes = configuration.data(using: .utf8), !bytes.isEmpty, bytes.count <= 2 * 1024 * 1024 else {
            throw RelayGuardBindingFailure.invalid
        }
        let config = try RelayTunStrictJSON.object(bytes, limit: 2 * 1024 * 1024, maxNodes: 200000)
        try validateRoute(config)
        let before = try process(pid)
        guard before.pbi_uid == getuid(), before.pbi_ruid == getuid() else { throw RelayGuardBindingFailure.process }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { throw RelayGuardBindingFailure.process }
        let executable = String(cString: path)
        let root = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/relay")
        let pins = RelayGuardCorePins.resources(root: root)
        guard let pin = pins[executable] else { throw RelayGuardBindingFailure.resource }
        let resource = URL(fileURLWithPath: executable)
        try RelayGuardResourcePath.check(resource)
        let identity = try fileStamp(resource)
        let data = try Data(contentsOf: resource)
        guard data.count == pin.size, digest(data) == pin.sha256,
              try fileStamp(resource) == identity else { throw RelayGuardBindingFailure.resource }
        let value = Self(instanceID: instanceID, configurationSHA256: digest(bytes), pid: pid, uid: getuid(),
            bornSeconds: before.pbi_start_tvsec, bornMicroseconds: before.pbi_start_tvusec,
            executable: executable, resourceSHA256: pin.sha256, fileIdentity: identity, ports: [17890, 17891])
        try value.verify()
        return value
    }

    /// Recheck immediately before each protected allow verdict. A heartbeat is
    /// not used as a substitute for listener ownership or PID-generation proof.
    func verify() throws {
        guard UUID(uuidString: instanceID)?.uuidString.lowercased() == instanceID,
              [configurationSHA256, resourceSHA256].allSatisfy({ $0.utf8.count == 64 && $0.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) }),
              uid > 0, bornSeconds > 0, bornMicroseconds < 1_000_000,
              executable.utf8.count <= 4096, fileIdentity.utf8.count <= 512,
              RelayGuardCorePins.accepts(executable: executable, sha256: resourceSHA256) else { throw RelayGuardBindingFailure.invalid }
        let live = try Self.process(pid)
        guard live.pbi_uid == uid, live.pbi_ruid == uid,
              live.pbi_start_tvsec == bornSeconds, live.pbi_start_tvusec == bornMicroseconds,
              ports == [17890, 17891], try Self.fileStamp(URL(fileURLWithPath: executable)) == fileIdentity else {
            throw RelayGuardBindingFailure.stale
        }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0, String(cString: path) == executable else {
            throw RelayGuardBindingFailure.process
        }
        // Exact existing kernel-listener observer is linked from the pinned TUN
        // source by the guard builder. Its unsupported-OS/ambiguity errors deny.
        do { try RelayTunTCPListener.verifyLive(pid: pid, uid: uid, ports: ports,
            deadline: DispatchTime.now().uptimeNanoseconds + 250_000_000) }
        catch { throw RelayGuardBindingFailure.listener }
        let after = try Self.process(pid)
        guard after.pbi_start_tvsec == bornSeconds, after.pbi_start_tvusec == bornMicroseconds else {
            throw RelayGuardBindingFailure.stale
        }
    }

    /// Only the socket flow's sourceProcessAuditToken may be passed here. The
    /// responsible-app token cannot identify the process holding this socket.
    /// A Core's fixed official bytes need not have a publisher signing Team.
    func verifyInfrastructureActor(_ data: Data?) throws {
        guard let data, data.count == MemoryLayout<audit_token_t>.size else {
            throw RelayGuardBindingFailure.process
        }
        var token = audit_token_t()
        _ = withUnsafeMutableBytes(of: &token) { data.copyBytes(to: $0) }
        // Reject unrelated processes before the expensive existing listener /
        // resource checks. Matching a PID is never sufficient for admission.
        guard RelayGuardAuditPID(token) == pid,
              RelayGuardAuditEffectiveUID(token) == uid,
              RelayGuardAuditRealUID(token) == uid else { throw RelayGuardBindingFailure.process }

        func verifyCurrentExecution() throws {
            var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
            let length = proc_pidpath_audittoken(&token, &path, UInt32(path.count))
            // This public API compares the kernel's current pidversion. A PID
            // reuse or an exec of even the same filename cannot satisfy it
            // using the old flow's audit token. No private proc_info ABI is used.
            guard length > 0, Int(length) < path.count, path[Int(length)] == 0,
                  String(cString: path) == executable else { throw RelayGuardBindingFailure.stale }
        }
        try verify()
        try verifyCurrentExecution()
        try verify()
        try verifyCurrentExecution()
    }

    private static func process(_ pid: Int32) throws -> proc_bsdinfo {
        var info = proc_bsdinfo()
        guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
            == MemoryLayout<proc_bsdinfo>.size else { throw RelayGuardBindingFailure.process }
        return info
    }
    private static func fileStamp(_ url: URL) throws -> String {
        try RelayGuardResourcePath.check(url)
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              info.st_mode & 0o022 == 0, info.st_nlink == 1 else { throw RelayGuardBindingFailure.resource }
        return "\(info.st_dev):\(info.st_ino):\(info.st_size):\(info.st_mtimespec.tv_sec):\(info.st_mtimespec.tv_nsec):\(info.st_ctimespec.tv_sec):\(info.st_ctimespec.tv_nsec)"
    }
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    private static func validateRoute(_ value: [String: Any]) throws {
        guard let listeners = value["listeners"] as? [[String: Any]], listeners.count == 2,
              let nodes = value["proxies"] as? [[String: Any]], nodes.count <= 10000 else { throw RelayGuardBindingFailure.route }
        var route: String?
        for (index, entry) in listeners.enumerated() {
            let type = index == 0 ? "http" : "socks", port = index == 0 ? 17891 : 17890
            guard Set(entry.keys) == ["listen", "name", "port", "proxy", "type", "udp"],
                  entry["name"] as? String == (index == 0 ? "relay-ai-http" : "relay-ai-socks"),
                  entry["type"] as? String == type, entry["listen"] as? String == "127.0.0.1",
                  RelayTunStrictJSON.integer(entry["port"]) == port,
                  let udp = entry["udp"] as CFTypeRef?, CFGetTypeID(udp) == CFBooleanGetTypeID(),
                  (udp as? Bool) == false,
                  let target = entry["proxy"] as? String, !target.isEmpty,
                  route == nil || route == target else { throw RelayGuardBindingFailure.route }
            route = target
        }
        let allowed: Set<String> = ["ss", "ssr", "snell", "socks5", "http", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "wireguard", "ssh", "anytls", "mieru"]
        var seen = Set<String>()
        while let name = route {
            guard seen.insert(name).inserted, seen.count <= 16,
                  let node = nodes.first(where: { $0["name"] as? String == name }),
                  nodes.filter({ $0["name"] as? String == name }).count == 1,
                  let kind = node["type"] as? String, allowed.contains(kind),
                  node["dialer-proxy"] == nil || node["dialer-proxy"] is String else { throw RelayGuardBindingFailure.route }
            route = node["dialer-proxy"] as? String
        }
    }
}
