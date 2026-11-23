import Foundation
import Darwin

/// The live backend only changes the Proxies protocol in the current network
/// location. User-owned transaction records stay here; the shared backend changes
/// only proxy preferences. No helper install, DNS/TUN edit or core lifecycle API.
enum RelaySystemProxy {
    typealias Service = RelaySystemProxyBackend.Service
    typealias Snapshot = RelaySystemProxyBackend.Snapshot
    struct Settings: Codable {
        let mode: String
        let host: String
        let port: Int
        let socks: Bool
        let bypass: [String]
        let excludeSimple: Bool
        let serviceIDs: [String]
        let pacURL: String?
    }
    struct Input: Decodable {
        let context: RelayStateContext
        let action: String
        let settings: Settings?
        let expectedRevision: String?
    }
    struct ServiceInfo: Encodable {
        let id: String
        let name: String
        let enabled: Bool
        let http: Bool
        let https: Bool
        let socks: Bool
        let pac: Bool
        let discovery: Bool
    }
    struct Report: Encodable {
        let status: String
        let revision: String
        let location: String
        let services: [ServiceInfo]
        let canApply: Bool
        let canRestore: Bool
        let canRetireDetached: Bool
        let recordID: String?
        let quitProxyPorts: [Int]?
        let currentProxyPorts: [Int]?
        let currentLoopbackProxyPorts: [Int]?
        let currentPacURLHashes: [String]?
        let warnings: [String]
    }
    typealias ChangeResult = RelaySystemProxyBackend.ChangeResult
    typealias LockedSession = RelaySystemProxyBackend.LockedSession
    typealias SystemFailure = RelaySystemProxyBackend.SystemFailure
    struct Environment {
        let read: () throws -> Snapshot
        let change: (_ expected: Snapshot, _ target: Snapshot) throws -> ChangeResult
        let isLive: Bool
        var readProxyConfigurations: (() throws -> [[String: Any]])? = nil
        static var live: Self {
            Self(read: { try readSystem() }, change: changeSystem, isLive: true,
                 readProxyConfigurations: RelaySystemProxyBackend.readProxyConfigurations)
        }
    }
    private struct Record: Codable {
        let version: Int
        let id: String
        let parent: String?
        let original: Snapshot
        let before: Snapshot
        let target: Snapshot
    }
    private struct Pointer: Codable { let version: Int; let id: String; let sha256: String }
    private struct Phase: Codable { let value: String }
    private struct Stored {
        let record: Record
        let phase: String
        let revision: String
    }
    private static func fromBackend<T>(_ operation: () throws -> T) throws -> T {
        do { return try operation() }
        catch let failure as RelaySystemProxyBackend.Failure { throw AssistantError(failure.message) }
    }
    static func digest<T: Encodable>(_ value: T) throws -> String { try RelaySystemProxyBackend.digest(value) }
    static func dictionary(_ data: Data?) throws -> [String: Any] { try fromBackend { try RelaySystemProxyBackend.dictionary(data) } }
    private static func packed(_ dictionary: [String: Any]) throws -> Data {
        try PropertyListSerialization.data(fromPropertyList: dictionary, format: .binary, options: 0)
    }
    private static func canonical(_ snapshot: Snapshot) throws -> Snapshot { try fromBackend { try RelaySystemProxyBackend.canonical(snapshot) } }
    private static func same(_ a: Snapshot, _ b: Snapshot) throws -> Bool { try fromBackend { try RelaySystemProxyBackend.same(a, b) } }
    static func readSystem() throws -> Snapshot { try fromBackend { try RelaySystemProxyBackend.readSystem() } }
    static func changedServiceIDs(_ before: Snapshot, _ target: Snapshot) throws -> Set<String> { try fromBackend { try RelaySystemProxyBackend.changedServiceIDs(before, target) } }
    private static func changeSystem(_ expected: Snapshot, _ target: Snapshot) throws -> ChangeResult {
        try fromBackend { try RelaySystemProxyHelperBridge.change(expected, target) }
    }
    static func changeLocked(_ expected: Snapshot, _ target: Snapshot, session: LockedSession) throws -> ChangeResult {
        try fromBackend { try RelaySystemProxyBackend.changeLocked(expected, target, session: session) }
    }
    private static func desired(_ current: Snapshot, _ settings: Settings) throws -> Snapshot {
        guard ["manual", "pac"].contains(settings.mode), (1024...65535).contains(settings.port), !settings.host.isEmpty, settings.host.utf8.count <= 253,
              settings.host.range(of: "^[a-zA-Z0-9.:-]+$", options: .regularExpression) != nil,
              !settings.serviceIDs.isEmpty, settings.serviceIDs.count <= 128, Set(settings.serviceIDs).count == settings.serviceIDs.count,
              settings.serviceIDs.allSatisfy({ id in current.services.contains { $0.id == id && $0.enabled } }),
              settings.bypass.count <= 256, settings.bypass.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 253 && !$0.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } }) else { throw AssistantError("系统代理参数或目标网络服务无效。") }
        if settings.host.contains(":") {
            var address = in6_addr()
            guard settings.host.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { throw AssistantError("IPv6代理主机无效。") }
        } else {
            guard settings.host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0.utf8.count <= 63 && $0.first != "-" && $0.last != "-" }) else { throw AssistantError("代理主机标签无效。") }
        }
        if settings.mode == "pac" {
            guard let raw = settings.pacURL, let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1", url.port.map({ (1024...65535).contains($0) }) == true, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                  url.path.range(of: "^/[a-f0-9-]{36}\\.pac$", options: .regularExpression) != nil else { throw AssistantError("只接受本次Relay回环PAC地址。") }
        } else if settings.pacURL != nil { throw AssistantError("手动代理不接受PAC地址。") }
        return Snapshot(location: current.location, services: try current.services.map { service in
            guard settings.serviceIDs.contains(service.id) else { return service }
            var value = try dictionary(service.configuration)
            for key in ["HTTPEnable", "HTTPSEnable", "SOCKSEnable", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"] { value[key] = 0 }
            value["ExceptionsList"] = settings.bypass
            value["ExcludeSimpleHostnames"] = settings.excludeSimple ? 1 : 0
            if settings.mode == "manual" {
                for prefix in ["HTTP", "HTTPS"] + (settings.socks ? ["SOCKS"] : []) {
                    value[prefix + "Enable"] = 1; value[prefix + "Proxy"] = settings.host; value[prefix + "Port"] = settings.port
                }
            } else { value["ProxyAutoConfigEnable"] = 1; value["ProxyAutoConfigURLString"] = settings.pacURL }
            return Service(id: service.id, name: service.name, enabled: service.enabled, configuration: try packed(value))
        })
    }
    private static func data(_ path: URL, limit: Int = 1048576) throws -> Data? {
        guard let file = try RelayRecoveryInspector.read(path, limit: limit) else { return nil }
        guard file.mode == 0o600 else { throw AssistantError("系统代理记录必须为私有权限，未覆盖。") }
        return file.data
    }
    private static func load(_ root: URL) throws -> Stored? {
        guard let pointerData = try data(root.appendingPathComponent("active.json"), limit: 4096) else { return nil }
        func keys(_ bytes: Data, allowed: Set<String>) throws {
            guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], Set(object.keys).isSubset(of: allowed) else { throw AssistantError("系统代理记录包含未知字段，未覆盖。") }
        }
        try keys(pointerData, allowed: ["version", "id", "sha256"])
        let decoder = JSONDecoder(), pointer = try decoder.decode(Pointer.self, from: pointerData)
        guard pointer.version == 1, UUID(uuidString: pointer.id)?.uuidString.lowercased() == pointer.id, pointer.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw AssistantError("系统代理事务指针异常。") }
        let directory = root.appendingPathComponent(pointer.id, isDirectory: true)
        var identity = stat()
        guard lstat(directory.path, &identity) == 0, identity.st_uid == getuid(), identity.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), identity.st_mode & 0o7777 == 0o700, NetworkConfiguration.canonicalPath(directory) == directory.path else { throw AssistantError("系统代理恢复目录身份或权限异常。") }
        guard let bytes = try data(directory.appendingPathComponent("record.json")), NetworkConfiguration.digest(bytes) == pointer.sha256, let phaseData = try data(directory.appendingPathComponent("phase.json"), limit: 4096) else { throw AssistantError("系统代理恢复证据不完整。") }
        try keys(bytes, allowed: ["version", "id", "parent", "original", "before", "target"])
        try keys(phaseData, allowed: ["value"])
        let encoded = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] ?? [:]
        for key in ["original", "before", "target"] {
            guard let snapshot = encoded[key] as? [String: Any], Set(snapshot.keys) == ["location", "services"], let services = snapshot["services"] as? [[String: Any]], services.allSatisfy({ Set($0.keys).isSubset(of: ["id", "name", "enabled", "configuration"]) }) else { throw AssistantError("系统代理快照包含未知或异常字段。") }
        }
        let record = try decoder.decode(Record.self, from: bytes), phase = try decoder.decode(Phase.self, from: phaseData).value
        guard record.id == pointer.id, record.version == 1, ["prepared", "committing", "applied", "restoring", "restored", "rolledBack", "uncertain"].contains(phase) else { throw AssistantError("系统代理事务版本或状态无效。") }
        _ = try canonical(record.original); _ = try canonical(record.before); _ = try canonical(record.target)
        return Stored(record: record, phase: phase, revision: NetworkConfiguration.digest(pointerData + bytes + phaseData))
    }
    private static func combined(_ current: Snapshot, _ stored: Stored?) throws -> String {
        // Compare property lists semantically; their binary serialization order
        // is not stable across independent SystemConfiguration sessions.
        var object: [String: Any] = ["location": current.location, "record": stored?.revision ?? "missing"]
        func normalized(_ value: Any) throws -> Any {
            if let dictionary = value as? [String: Any] { return ["dictionary", try dictionary.mapValues(normalized)] }
            if let array = value as? [Any] { return ["array", try array.map(normalized)] }
            if let data = value as? Data { return ["data", data.base64EncodedString()] }
            if let date = value as? Date { return ["date", date.timeIntervalSince1970] }
            if let string = value as? String { return ["string", string] }
            if let number = value as? NSNumber { return [CFGetTypeID(number) == CFBooleanGetTypeID() ? "boolean" : "number", number] }
            if value is NSNull { return ["null"] }
            throw AssistantError("代理值无法生成稳定版本。")
        }
        object["services"] = try current.services.map { service -> [String: Any] in
            ["id": service.id, "name": service.name, "enabled": service.enabled, "configuration": try service.configuration.map { try normalized(dictionary($0)) } ?? NSNull()]
        }
        return NetworkConfiguration.digest(try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }
    // Restoration owns only the services changed by this transaction chain.
    // Network service names, enablement and unrelated services can change while
    // Relay runs; replaying the complete original snapshot would overwrite them.
    private static func restorationTarget(_ current: Snapshot, _ stored: Stored?) throws -> Snapshot? {
        guard let record = stored?.record, current.location == record.original.location else { return nil }
        let changed = try changedServiceIDs(record.original, record.target)
            .union(changedServiceIDs(record.original, record.before))
        guard changed.isSubset(of: Set(current.services.map(\.id))) else { return nil }
        func equalConfiguration(_ left: Service, _ right: Service) throws -> Bool {
            try (left.configuration == nil) == (right.configuration == nil) &&
                NSDictionary(dictionary: dictionary(left.configuration)).isEqual(to: dictionary(right.configuration))
        }
        var services: [Service] = []
        for service in current.services {
            guard changed.contains(service.id) else { services.append(service); continue }
            guard let original = record.original.services.first(where: { $0.id == service.id }),
                  let before = record.before.services.first(where: { $0.id == service.id }),
                  let target = record.target.services.first(where: { $0.id == service.id }),
                  try equalConfiguration(service, original) || equalConfiguration(service, before) || equalConfiguration(service, target) else { return nil }
            services.append(Service(id: service.id, name: service.name, enabled: service.enabled, configuration: original.configuration))
        }
        return Snapshot(location: current.location, services: services)
    }
    private static func restorable(_ current: Snapshot, _ stored: Stored?) throws -> Bool {
        try restorationTarget(current, stored) != nil
    }
    // These are the local addresses accepted by the managed loopback listeners.
    private static func isLoopbackProxyHost(_ raw: String) -> Bool {
        let host = raw.hasPrefix("[") && raw.hasSuffix("]") ? String(raw.dropFirst().dropLast()) : raw
        if ["localhost", "localhost.", "127.0.0.1"].contains(host.lowercased()) { return true }
        guard host.contains(":"), !host.utf8.contains(0) else { return false }
        var v6 = in6_addr()
        guard inet_pton(AF_INET6, host, &v6) == 1 else { return false }
        let bytes = withUnsafeBytes(of: &v6) { Array($0) }
        return bytes == Array(repeating: 0, count: 15) + [1] ||
            bytes == Array(repeating: 0, count: 10) + [255, 255, 127, 0, 0, 1]
    }
    // Positive proof for a settled manual transaction only. A PAC, discovery,
    // malformed or uncertain configuration can hide endpoints we cannot verify.
    private static func manualPorts(_ configuration: [String: Any], allowAutomatic: Bool = false, loopbackOnly: Bool = false) throws -> Set<Int> {
        func enabled(_ key: String) throws -> Bool {
            guard let value = configuration[key] else { return false }
            guard let number = value as? NSNumber, number == 0 || number == 1 else {
                throw AssistantError("代理启用状态不可确认。")
            }
            return number == 1
        }
        if !allowAutomatic {
            guard try !enabled("ProxyAutoConfigEnable"), try !enabled("ProxyAutoDiscoveryEnable") else {
                throw AssistantError("自动代理依赖不可确认。")
            }
        }
        var ports: Set<Int> = []
        for prefix in ["HTTP", "HTTPS", "SOCKS", "FTP", "Gopher", "RTSP"] where try enabled(prefix + "Enable") {
            guard let host = configuration[prefix + "Proxy"] as? String, !host.isEmpty,
                  let port = configuration[prefix + "Port"] as? Int, (1...65535).contains(port) else {
                throw AssistantError("代理端点不可确认。")
            }
            if !loopbackOnly || isLoopbackProxyHost(host) { ports.insert(port) }
        }
        // SystemConfiguration places interface/service/domain overrides in
        // nested dictionaries/arrays. Check these as well as the global values.
        func collect(_ value: Any) throws {
            if let nested = value as? [String: Any] { ports.formUnion(try manualPorts(nested, allowAutomatic: allowAutomatic, loopbackOnly: loopbackOnly)) }
            else if let list = value as? [Any] { for item in list { try collect(item) } }
        }
        for value in configuration.values { try collect(value) }
        return ports
    }
    private static func pacReferences(_ configuration: [String: Any], loopbackOnly: Bool = false) throws -> (hashes: Set<String>, ports: Set<Int>) {
        var hashes: Set<String> = [], ports: Set<Int> = []
        if let raw = configuration["ProxyAutoConfigEnable"] {
            guard let enabled = raw as? NSNumber, enabled == 0 || enabled == 1 else { throw AssistantError("自动代理启用状态不可确认。") }
            if enabled == 1 {
                guard let rawURL = configuration["ProxyAutoConfigURLString"] as? String, !rawURL.isEmpty, rawURL.utf8.count <= 16384,
                      let url = URL(string: rawURL), let scheme = url.scheme?.lowercased() else { throw AssistantError("自动代理引用不可确认。") }
                // Report equality evidence without exposing private PAC URLs.
                hashes.insert(NetworkConfiguration.digest(Data(rawURL.utf8)))
                if ["http", "https"].contains(scheme) {
                    guard let host = url.host else { throw AssistantError("自动代理主机不可确认。") }
                    let port = url.port ?? (scheme == "https" ? 443 : 80)
                    guard (1...65535).contains(port) else { throw AssistantError("自动代理端口不可确认。") }
                    if !loopbackOnly || isLoopbackProxyHost(host) { ports.insert(port) }
                }
            }
        }
        func collect(_ value: Any) throws {
            if let nested = value as? [String: Any] {
                let references = try pacReferences(nested, loopbackOnly: loopbackOnly)
                hashes.formUnion(references.hashes); ports.formUnion(references.ports)
            } else if let list = value as? [Any] { for item in list { try collect(item) } }
        }
        for value in configuration.values { try collect(value) }
        return (hashes, ports)
    }
    private static func noProxyChanges(_ record: Record) throws -> Bool {
        guard record.parent == nil else { return false }
        return try same(record.original, record.target) && same(record.before, record.target)
    }
    private static func detachedProxyPorts(
        _ current: Snapshot,
        _ stored: Stored,
        canRestore: Bool,
        readProxyConfigurations: () throws -> [[String: Any]]
    ) throws -> [Int]? {
        guard stored.phase == "applied" else { return nil }
        let record = stored.record
        guard try noProxyChanges(record) ||
            (!same(current, record.target) && (same(current, record.original) || !canRestore)) else { return nil }
        let changed = try changedServiceIDs(record.original, record.target)
            .union(changedServiceIDs(record.before, record.target))
        var targetPorts: Set<Int> = []
        for service in record.target.services where changed.contains(service.id) {
            targetPorts.formUnion(try manualPorts(dictionary(service.configuration)))
        }
        if targetPorts.isEmpty, try !noProxyChanges(record) { return nil }
        // Match by port conservatively, so alternate address spellings/aliases
        // cannot make a reference to a Relay listener look unrelated.
        let configurations = try readProxyConfigurations()
        guard !configurations.isEmpty else { return nil }
        let currentPorts = try configurations.reduce(into: Set<Int>()) { ports, configuration in
            ports.formUnion(try manualPorts(configuration))
        }
        return currentPorts.isDisjoint(with: targetPorts) ? currentPorts.sorted() : nil
    }
    private static func report(
        _ current: Snapshot,
        _ stored: Stored?,
        _ status: String? = nil,
        apply: Bool = false,
        warnings: [String] = [],
        readProxyConfigurations: (() throws -> [[String: Any]])? = nil
    ) throws -> Report {
        let canRestore = try restorable(current, stored), active = try stored.map { value in
            guard value.phase == "applied" else { return false }
            return try same(current, value.record.target)
        } ?? false
        let status = status ?? (stored == nil ? "inactive" : active ? "active" : canRestore ? "pending" : "conflict")
        let detachedPorts: [Int]?
        if let stored, let readProxyConfigurations {
            detachedPorts = try? detachedProxyPorts(current, stored, canRestore: canRestore, readProxyConfigurations: readProxyConfigurations)
        } else {
            detachedPorts = nil
        }
        var currentPorts: [Int]?, currentLoopbackPorts: [Int]?, currentPacHashes: [String]?
        if let readProxyConfigurations {
            do {
                let values = try readProxyConfigurations()
                guard !values.isEmpty else { throw AssistantError("系统代理引用范围不可确认。") }
                var ports: Set<Int> = [], localPorts: Set<Int> = [], hashes: Set<String> = []
                for value in values {
                    ports.formUnion(try manualPorts(value, allowAutomatic: true))
                    let pac = try pacReferences(value)
                    ports.formUnion(pac.ports); hashes.formUnion(pac.hashes)
                    localPorts.formUnion(try manualPorts(value, allowAutomatic: true, loopbackOnly: true))
                    localPorts.formUnion(try pacReferences(value, loopbackOnly: true).ports)
                }
                currentPorts = ports.sorted(); currentLoopbackPorts = localPorts.sorted(); currentPacHashes = hashes.sorted()
            } catch { currentPorts = nil; currentPacHashes = nil }
        }
        return Report(status: status, revision: try combined(current, stored), location: current.location,
            services: try current.services.map { service in
                let value = try dictionary(service.configuration)
                func enabled(_ key: String) -> Bool { (value[key] as? NSNumber)?.intValue == 1 }
                return ServiceInfo(id: service.id, name: service.name, enabled: service.enabled, http: enabled("HTTPEnable"), https: enabled("HTTPSEnable"), socks: enabled("SOCKSEnable"), pac: enabled("ProxyAutoConfigEnable"), discovery: enabled("ProxyAutoDiscoveryEnable"))
            }, canApply: apply, canRestore: canRestore, canRetireDetached: detachedPorts != nil,
            recordID: stored?.record.id, quitProxyPorts: status == "conflict" ? detachedPorts : nil, currentProxyPorts: currentPorts, currentLoopbackProxyPorts: currentLoopbackPorts, currentPacURLHashes: currentPacHashes,
            warnings: warnings + ["只改写所选服务的代理协议，不改写DNS／TUN或调用核心启停。系统应用配置期间新连接可能短暂失败；偏好已写入不等于实际流量与禁止直连已验证。"])
    }
    static func perform(_ input: Input, environment: Environment = .live) throws -> Report {
        let paths = try RelayPreferenceStore(input.context), root = paths.root.appendingPathComponent("SystemProxy", isDirectory: true)
        guard ["inspect", "prepare", "apply", "prepareRestore", "restore", "retireDetached"].contains(input.action) else { throw AssistantError("系统代理操作无效。") }
        let writing = ["apply", "restore", "retireDetached"].contains(input.action)
        if writing && environment.isLive {
            guard paths.home.path == (try RelayBrowserContract.realHome()).path else { throw AssistantError("实际系统代理只能由当前用户固定目录管理。") }
        }
        if !["prepare", "apply"].contains(input.action), input.settings != nil { throw AssistantError("本操作不接受代理参数。") }
        if !writing, input.expectedRevision != nil { throw AssistantError("只读操作不接受提交凭据。") }
        func inspect() throws -> (Snapshot, Stored?) {
            _ = try RelayCoreRecovery.directory(root, home: paths.home)
            return (try canonical(environment.read()), try load(root))
        }
        if !writing {
            let (current, stored) = try inspect()
            if input.action == "prepare" {
                guard let settings = input.settings else { throw AssistantError("需要系统代理参数。") }
                _ = try desired(current, settings)
                let ready = try stored == nil || (stored?.phase == "applied" && same(current, stored!.record.target))
                return try report(current, stored, apply: ready)
            }
            return try report(current, stored, readProxyConfigurations: input.action == "inspect" ? environment.readProxyConfigurations : nil)
        }
        guard let revision = input.expectedRevision, revision.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw AssistantError("请先核对当前系统代理版本。") }
        return try RelayStateLock(root: paths.root).withLock {
            let (before, stored) = try inspect()
            guard try combined(before, stored) == revision else { throw AssistantError("系统代理或恢复记录在确认后改变，未覆盖。") }
            if input.action == "retireDetached" {
                // Uninstall may clear the pointer after a fresh read proves the
                // transaction no longer owns any proxy settings. Never replay
                // the original snapshot or discard transaction history here.
                guard let stored, let readProxyConfigurations = environment.readProxyConfigurations,
                      try detachedProxyPorts(before, stored, canRestore: restorable(before, stored), readProxyConfigurations: readProxyConfigurations) != nil else {
                    throw AssistantError("系统代理恢复记录仍可能在用或未确认，未归档。")
                }
                let retired = try report(before, nil)
                try FileManager.default.removeItem(at: root.appendingPathComponent("active.json"))
                try RelayCoreRecovery.sync(root)
                return retired
            }
            if try RelayCoreRecovery.directory(root, home: paths.home) == nil { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
            func phase(_ id: String, _ value: String) throws {
                try NetworkConfiguration.safeWrite(JSONEncoder().encode(Phase(value: value)), to: root.appendingPathComponent(id + "/phase.json"))
                try RelayCoreRecovery.sync(root.appendingPathComponent(id, isDirectory: true))
            }
            func activate(_ record: Record) throws {
                let directory = root.appendingPathComponent(record.id, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                let bytes = try JSONEncoder().encode(record)
                guard bytes.count <= 1048576 else { throw AssistantError("原始代理配置过长，未执行系统写入。") }
                try NetworkConfiguration.safeWrite(bytes, to: directory.appendingPathComponent("record.json"))
                try phase(record.id, "prepared")
                try NetworkConfiguration.safeWrite(JSONEncoder().encode(Pointer(version: 1, id: record.id, sha256: NetworkConfiguration.digest(bytes))), to: root.appendingPathComponent("active.json"))
                try RelayCoreRecovery.sync(root)
            }
            if input.action == "restore" {
                guard let stored, let target = try restorationTarget(before, stored) else { throw AssistantError("存在其他程序对本次代理的修改或网络位置变化，未覆盖；请先人工核对。") }
                try phase(stored.record.id, "restoring")
                var failureWarnings: [String] = []
                do {
                    let restored = try same(before, target) ? ChangeResult(status: "applied", snapshot: before) : environment.change(before, target)
                    failureWarnings = restored.warnings
                    if restored.status == "applied", try same(restored.snapshot, target), try same(environment.read(), target) {
                        try phase(stored.record.id, "restored")
                        try FileManager.default.removeItem(at: root.appendingPathComponent("active.json")); try RelayCoreRecovery.sync(root)
                        return try report(restored.snapshot, nil, "restored")
                    }
                    if restored.status == "notSubmitted", try same(restored.snapshot, before), try same(environment.read(), before),
                       try load(root)?.record.id == stored.record.id {
                        try phase(stored.record.id, stored.phase)
                        return try report(before, load(root), "rolledBack", warnings: restored.warnings)
                    }
                } catch { failureWarnings = [(error as? SystemFailure)?.message ?? "系统代理恢复后端结果未确认。"] }
                try phase(stored.record.id, "uncertain")
                return try report(environment.read(), load(root), "uncertain", warnings: failureWarnings + ["恢复结果未确认，保留原始证据；不重试、不清空系统代理或停止核心。"])
            }
            guard let settings = input.settings else { throw AssistantError("需要系统代理参数。") }
            guard try stored == nil || (stored?.phase == "applied" && same(before, stored!.record.target)) else { throw AssistantError("请先处理尚未恢复或已被其他程序修改的系统代理事务。") }
            let target = try desired(before, settings), record = Record(version: 1, id: UUID().uuidString.lowercased(), parent: stored?.record.id, original: stored?.record.original ?? before, before: before, target: target)
            try activate(record); try phase(record.id, "committing")
            var failureWarnings: [String] = []
            do {
                let changed = try environment.change(before, target)
                failureWarnings = changed.warnings
                if changed.status == "applied", try same(changed.snapshot, target), try same(environment.read(), target) {
                    try phase(record.id, "applied")
                    return try report(changed.snapshot, load(root), "applied")
                }
                if ["rolledBack", "unchanged", "notSubmitted"].contains(changed.status), try same(changed.snapshot, before),
                   try same(environment.read(), before), try load(root)?.record.id == record.id {
                    try phase(record.id, "rolledBack")
                    if let old = stored {
                        let bytes = try data(root.appendingPathComponent(old.record.id + "/record.json"))!
                        try NetworkConfiguration.safeWrite(JSONEncoder().encode(Pointer(version: 1, id: old.record.id, sha256: NetworkConfiguration.digest(bytes))), to: root.appendingPathComponent("active.json"))
                    } else { try FileManager.default.removeItem(at: root.appendingPathComponent("active.json")) }
                    try RelayCoreRecovery.sync(root)
                    return try report(before, load(root), "rolledBack", warnings: changed.warnings + ["候选未生效或应用失败后已核对恢复为提交前原值。"])
                }
            } catch { failureWarnings = [(error as? SystemFailure)?.message ?? "系统代理后端结果未确认。"] }
            try phase(record.id, "uncertain")
            return try report(environment.read(), load(root), "uncertain", warnings: failureWarnings + ["系统代理提交未确认，保留原值和候选；不自动重试或恢复。请显式检查后处理恢复。"])
        }
    }
}
