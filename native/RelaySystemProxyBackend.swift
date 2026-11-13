import Foundation
import SystemConfiguration
import Security
import CryptoKit
import Darwin

/// Proxy-protocol snapshots and the shared locked system transaction. This file
/// has no Relay user-state, helper installation, core or TUN dependencies.
enum RelaySystemProxyBackend {
    struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
    struct Service: Codable, Equatable {
        let id: String
        let name: String
        let enabled: Bool
        let configuration: Data?
    }
    struct Snapshot: Codable, Equatable {
        let location: String
        let services: [Service]
        var revision: String { get throws { try digest(self) } }
    }
    struct ChangeResult: Codable {
        let status: String // applied, rolledBack, unchanged, uncertain
        let snapshot: Snapshot
        var warnings: [String] = []
    }
    struct LockedSession {
        let synchronize: () -> Void
        let read: () throws -> Snapshot
        let stage: (Snapshot) throws -> Void
        let commit: () -> Bool
        let apply: () -> Bool
        var diagnostic: (String) -> String = { "系统代理阶段 \($0) 未确认。" }
        var requestIsValid: () -> Bool = { true }
    }
    static func digest<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(value)).map { String(format: "%02x", $0) }.joined()
    }
    static func dictionary(_ data: Data?) throws -> [String: Any] {
        guard let data else { return [:] }
        guard data.count <= 65536, let value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] else { throw Failure("系统代理值格式不可确认。") }
        return value
    }
    private static func packed(_ dictionary: [String: Any]) throws -> Data {
        try PropertyListSerialization.data(fromPropertyList: dictionary, format: .binary, options: 0)
    }
    static func canonical(_ snapshot: Snapshot) throws -> Snapshot {
        guard !snapshot.location.isEmpty, snapshot.location.utf8.count <= 256, snapshot.services.count <= 128,
              Set(snapshot.services.map(\.id)).count == snapshot.services.count else { throw Failure("系统网络服务清单无效。") }
        return Snapshot(location: snapshot.location, services: try snapshot.services.sorted { $0.id < $1.id }.map {
            guard !$0.id.isEmpty, $0.id.utf8.count <= 256, $0.name.utf8.count <= 1024 else { throw Failure("系统网络服务标识无效。") }
            // Binary plist byte order is not the identity; comparison below
            // decodes the original bytes rather than comparing serialization.
            _ = try dictionary($0.configuration)
            return $0
        })
    }
    static func same(_ a: Snapshot, _ b: Snapshot) throws -> Bool {
        guard a.location == b.location, a.services.map(\.id) == b.services.map(\.id) else { return false }
        return try zip(a.services, b.services).allSatisfy { left, right in
            guard left.name == right.name, left.enabled == right.enabled, (left.configuration == nil) == (right.configuration == nil) else { return false }
            return try NSDictionary(dictionary: dictionary(left.configuration)).isEqual(to: dictionary(right.configuration))
        }
    }
    private static func network(_ preferences: SCPreferences) throws -> Snapshot {
        guard let set = SCNetworkSetCopyCurrent(preferences), let services = SCNetworkSetCopyServices(set) as? [SCNetworkService] else { throw Failure("当前网络位置不可读取。") }
        let entries: [Service] = try services.compactMap { service in
            guard let proxy = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies), let id = SCNetworkServiceGetServiceID(service) else { return nil }
            let config = SCNetworkProtocolGetConfiguration(proxy) as? [String: Any]
            return Service(id: id as String, name: SCNetworkServiceGetName(service).map { $0 as String } ?? "Network service", enabled: SCNetworkServiceGetEnabled(service) && SCNetworkProtocolGetEnabled(proxy), configuration: try config.map(packed))
        }
        guard let id = SCNetworkSetGetSetID(set) else { throw Failure("当前网络位置标识不可读取。") }
        return try canonical(Snapshot(location: id as String, services: entries))
    }
    static func readSystem() throws -> Snapshot {
        guard let preferences = SCPreferencesCreate(nil, "Relay read-only proxy inspection" as CFString, nil) else { throw Failure("系统网络偏好不可读取。") }
        return try network(preferences)
    }
    static func readProxyConfigurations() throws -> [[String: Any]] {
        guard let preferences = SCPreferencesCreate(nil, "Relay read-only proxy exit inspection" as CFString, nil),
              let services = SCNetworkServiceCopyAll(preferences) as? [SCNetworkService],
              let effective = SCDynamicStoreCopyProxies(nil) as? [String: Any] else {
            throw Failure("系统代理引用范围不可确认。")
        }
        // A different network location can retain a service's configured proxy.
        // Include disabled services and the effective (including scoped) values.
        var configurations = [effective]
        for service in services {
            guard let proxy = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies),
                  let raw = SCNetworkProtocolGetConfiguration(proxy) else { continue }
            guard let configuration = raw as? [String: Any] else { throw Failure("系统代理值格式不可确认。") }
            configurations.append(configuration)
        }
        return configurations
    }
    struct SystemFailure: Error {
        let stage: String
        let code: Int32
        var message: String { "系统代理阶段 \(stage) 失败，状态码 \(code)。" }
    }
    static func changedServiceIDs(_ before: Snapshot, _ target: Snapshot) throws -> Set<String> {
        guard before.location == target.location, before.services.map(\.id) == target.services.map(\.id) else { throw Failure("网络服务清单已变化，未暂存。") }
        return try Set(zip(before.services, target.services).compactMap { left, right in
            guard left.name == right.name, left.enabled == right.enabled else { throw Failure("网络服务身份已变化，未暂存。") }
            let equal = try (left.configuration == nil) == (right.configuration == nil) && NSDictionary(dictionary: dictionary(left.configuration)).isEqual(to: dictionary(right.configuration))
            return equal ? nil : right.id
        })
    }
    static func changeSystemAuthorized(_ expected: Snapshot, _ target: Snapshot) throws -> ChangeResult {
        let expected = try canonical(expected), target = try canonical(target)
        _ = try changedServiceIDs(expected, target)
        var authorization: AuthorizationRef?
        let authorizationStatus = AuthorizationCreate(nil, nil, [], &authorization)
        guard authorizationStatus == errAuthorizationSuccess, let authorization else { throw SystemFailure(stage: "authorization_create", code: authorizationStatus) }
        defer { AuthorizationFree(authorization, []) }
        guard let preferences = SCPreferencesCreateWithAuthorization(nil, "Relay system proxy transaction" as CFString, nil, authorization) else { throw SystemFailure(stage: "preferences_create", code: SCError()) }
        return try changeSystem(expected, target, preferences: preferences)
    }
    /// Called only by the root-owned daemon after authenticating its XPC peer.
    /// This adapter never creates an authorization prompt or changes user state.
    static func changeSystemRoot(_ expected: Snapshot, _ target: Snapshot, requestIsValid: @escaping () -> Bool = { true }) throws -> ChangeResult {
        guard getuid() == 0, geteuid() == 0 else { throw Failure("系统代理后台组件必须由管理员服务运行。") }
        let expected = try canonical(expected), target = try canonical(target)
        _ = try changedServiceIDs(expected, target)
        guard let preferences = SCPreferencesCreate(nil, "Relay system proxy transaction" as CFString, nil) else { throw SystemFailure(stage: "preferences_create", code: SCError()) }
        return try changeSystem(expected, target, preferences: preferences, requestIsValid: requestIsValid)
    }
    private static func changeSystem(_ expected: Snapshot, _ target: Snapshot, preferences: SCPreferences, requestIsValid: @escaping () -> Bool = { true }) throws -> ChangeResult {
        let changedIDs = try changedServiceIDs(expected, target)
        guard SCPreferencesLock(preferences, false) else { throw SystemFailure(stage: "preferences_lock", code: SCError()) }
        defer { SCPreferencesUnlock(preferences) }
        func stage(_ value: Snapshot) throws {
            guard let services = SCNetworkServiceCopyAll(preferences) as? [SCNetworkService] else { throw SystemFailure(stage: "service_list", code: SCError()) }
            for item in value.services where changedIDs.contains(item.id) {
                guard let service = services.first(where: { SCNetworkServiceGetServiceID($0).map { $0 as String } == item.id }) else { throw SystemFailure(stage: "service_lookup", code: SCError()) }
                guard let proxy = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies) else { throw SystemFailure(stage: "protocol_lookup", code: SCError()) }
                let dictionary = try item.configuration.map { try Self.dictionary($0) as CFDictionary }
                guard SCNetworkProtocolSetConfiguration(proxy, dictionary) else { throw SystemFailure(stage: "protocol_stage", code: SCError()) }
            }
        }
        return try changeLocked(expected, target, session: LockedSession(synchronize: { SCPreferencesSynchronize(preferences) }, read: { try network(preferences) }, stage: stage, commit: { SCPreferencesCommitChanges(preferences) }, apply: { SCPreferencesApplyChanges(preferences) }, diagnostic: { SystemFailure(stage: $0, code: SCError()).message }, requestIsValid: requestIsValid))
    }
    /// The exact same commit/apply/conditional rollback algorithm is exercised
    /// with an in-memory session; only the live adapter above talks to macOS.
    static func changeLocked(_ expected: Snapshot, _ target: Snapshot, session: LockedSession) throws -> ChangeResult {
        func current() throws -> Snapshot { session.synchronize(); return try session.read() }
        let validAfterLock = session.requestIsValid()
        let before = try current()
        guard try same(before, expected) else { throw Failure("确认后网络位置或代理值已变化，未覆盖。") }
        let expiredWarning = "系统代理后台请求已失效，未提交。"
        guard validAfterLock, session.requestIsValid() else { return ChangeResult(status: "unchanged", snapshot: before, warnings: [expiredWarning]) }
        do { try session.stage(target) }
        catch {
            let warning = (error as? SystemFailure)?.message ?? "系统代理阶段 stage 未确认。"
            let observed = try current()
            return ChangeResult(status: try same(observed, before) ? "unchanged" : "uncertain", snapshot: observed, warnings: [warning])
        }
        guard session.requestIsValid() else {
            let observed = try current()
            return ChangeResult(status: try same(observed, before) ? "unchanged" : "uncertain", snapshot: observed, warnings: [expiredWarning])
        }
        // Once commit is attempted, finish readback and conditional rollback even
        // if the client disconnects; cancellation must not abandon recovery.
        guard session.commit() else {
            let warning = session.diagnostic("commit")
            let current = try current()
            return ChangeResult(status: try same(current, before) ? "unchanged" : "uncertain", snapshot: current, warnings: [warning])
        }
        if session.apply() {
            let current = try current()
            return ChangeResult(status: try same(current, target) ? "applied" : "uncertain", snapshot: current)
        }
        let applyWarning = session.diagnostic("apply")
        // A failed apply may already have committed preferences. Roll back only
        // our exact candidate under the same SCPreferences lock, never a stranger's.
        let failed = try current()
        guard try same(failed, target) else { return ChangeResult(status: "uncertain", snapshot: failed, warnings: [applyWarning]) }
        do {
            try session.stage(before)
            guard session.commit() else { let warning = session.diagnostic("rollback_commit"); return ChangeResult(status: "uncertain", snapshot: try current(), warnings: [applyWarning, warning]) }
            guard session.apply() else { let warning = session.diagnostic("rollback_apply"); return ChangeResult(status: "uncertain", snapshot: try current(), warnings: [applyWarning, warning]) }
            let current = try current()
            return ChangeResult(status: try same(current, before) ? "rolledBack" : "uncertain", snapshot: current, warnings: [applyWarning])
        } catch { return ChangeResult(status: "uncertain", snapshot: try current(), warnings: [applyWarning, (error as? SystemFailure)?.message ?? "系统代理阶段 rollback_stage 未确认。"]) }
    }
}
