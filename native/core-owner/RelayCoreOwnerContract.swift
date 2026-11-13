import Foundation
import CoreFoundation
import CryptoKit
import Security
import Darwin

// Paired release authority; neither renderer input nor a state file can enable it.
enum RelayCoreOwnerRelease {
    static let enabled = false
    static let publisherTeamID: String? = nil
    static let contract = "relay-ordinary-core-owner-v1"
    static let applicationID = RelayGuardContract.applicationID
    static let helperID = RelayGuardContract.applicationID + ".core-owner"
    static let coreVersion = "v1.19.33"
    static let pins: [String: (String, Int)] = [
        "arm64": ("f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9", 56810034),
        "x64": ("291f5923c3dd3b8df36eaeccdd59eaf873ee021693cde65eb696f8b86ac99652", 60945968)
    ]
    static func require() throws {
        guard enabled, let team = publisherTeamID, team.count == 10,
              team.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }),
              getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { throw CoreOwnerFailure.unavailable }

    }
}
enum CoreOwnerFailure: String, Error { case unavailable, invalid, identity, stale, busy, deadline, uncertain, refused, resource, record, control }
func coreOwnerHash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func coreOwnerEncode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let bytes = try encoder.encode(value)
    // Optional identities/hash are explicit JSON null in the strict wire and
    // durable schemas, including before the first successful Core spawn.
    var object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
    if let runtime = value as? CoreOwnerRuntime {
        if runtime.configurationSHA256 == nil { object?["configurationSHA256"] = NSNull() }
    }
    if let snapshot = value as? CoreOwnerSnapshot {
        if snapshot.core == nil { object?["core"] = NSNull() }
        if snapshot.attachedMain == nil { object?["attachedMain"] = NSNull() }
        object?["runtime"] = try JSONSerialization.jsonObject(with: coreOwnerEncode(snapshot.runtime))
    }
    if let journal = value as? CoreOwnerJournal {
        if journal.core == nil { object?["core"] = NSNull() }
        if journal.attachedMain == nil { object?["attachedMain"] = NSNull() }
        object?["runtime"] = try JSONSerialization.jsonObject(with: coreOwnerEncode(journal.runtime))
    }
    guard let object else { return bytes }
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
}
func coreOwnerObject(_ data: Data, limit: Int = 3 * 1024 * 1024) throws -> [String: Any] {
    try RelayTunStrictJSON.object(data, limit: limit, maxNodes: 200000)
}
func coreOwnerUUID(_ value: Any?) throws -> String {
    guard let value = value as? String, UUID(uuidString: value)?.uuidString.lowercased() == value else { throw CoreOwnerFailure.invalid }; return value
}
func coreOwnerSHA(_ value: Any?) throws -> String {
    guard let value = value as? String, value.utf8.count == 64,
          value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw CoreOwnerFailure.invalid }; return value
}
func coreOwnerSafeInteger(_ raw: Any?) -> Int? {
    guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    guard value.isFinite, value >= 0, value.rounded() == value, value <= 9_007_199_254_740_991 else { return nil }
    return Int(value)
}
func coreOwnerBoolean(_ raw: Any?) -> Bool? {
    guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}
func coreOwnerNonce() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw CoreOwnerFailure.unavailable }
    return bytes.map { String(format: "%02x", $0) }.joined()
}
struct CoreOwnerContext: Codable, Equatable {
    let home: String
    let stateRoot: String
    func validate() throws {
        guard let account = getpwuid(getuid()), let path = account.pointee.pw_dir else { throw CoreOwnerFailure.identity }
        let actual = String(cString: path)
        guard home == actual, ["Relay", "Relay-Preview"].map({ home + "/Library/Application Support/" + $0 }).contains(stateRoot) else { throw CoreOwnerFailure.identity }
        try CoreOwnerFiles.pathChain(home)
    }
}
struct CoreOwnerProcessIdentity: Codable, Equatable {
    let pid: Int32
    let uid: UInt32
    let bornSeconds: String
    let bornMicroseconds: String
    let executable: String
    let resourceSHA256: String
    let fileIdentity: String
}
struct CoreOwnerLeaseBinding: Codable, Equatable {
    let token: String
    let directoryIdentity: String
    let ownerSHA256: String
}
struct CoreOwnerRuntime: Codable, Equatable {
    let directory: String
    let socket: String
    let httpPort: Int
    let profileId: String
    let sourceSHA256: String
    var configurationSHA256: String?
    let mode: String
    let coreResourceSHA256: String
}
struct CoreOwnerSnapshot: Codable {
    let version: Int
    let contract: String
    let sessionId: String
    let phase: String
    let revision: String
    let owner: CoreOwnerProcessIdentity
    let core: CoreOwnerProcessIdentity?
    let coreLease: CoreOwnerLeaseBinding
    let runtime: CoreOwnerRuntime
    let attachedMain: CoreOwnerProcessIdentity?
    let controlLost: Bool
    let detached: Bool
    let released: Bool
    let warnings: [String]
}
struct CoreOwnerJournal: Codable {
    let version: Int
    let contract: String
    let sessionId: String
    var phase: String
    let owner: CoreOwnerProcessIdentity
    var core: CoreOwnerProcessIdentity?
    var coreLease: CoreOwnerLeaseBinding
    var runtime: CoreOwnerRuntime
    var attachedMain: CoreOwnerProcessIdentity?
    var controlLost: Bool
    var detached: Bool
    let createdAt: String
    let workspaceIdentity: String
    var leaseRaw: String
    func snapshot(revision: String, released: Bool = false, warnings: [String] = []) -> CoreOwnerSnapshot {
        .init(version: version, contract: contract, sessionId: sessionId, phase: released ? "released" : phase,
              revision: revision, owner: owner, core: core, coreLease: coreLease, runtime: runtime,
              attachedMain: attachedMain, controlLost: controlLost, detached: detached, released: released, warnings: warnings)
    }
}
struct CoreOwnerConnection {
    let id: String
    let clientNonce: String
    let serverNonce: String
    let main: CoreOwnerProcessIdentity
    var sequence: Int = 0
}
