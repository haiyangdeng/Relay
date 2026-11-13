import Darwin
import Foundation

// Only Native-created records authorize a storage operation. No JS path,
// device name, writer-exited bit, capacity or readiness assertion is accepted.
struct RelayScopedStorageMount: Codable, Equatable {
    let devices: [String], volumeDevice: String, filesystem: [Int32]
    let root: RelayMaintenanceIdentity
}
struct RelayScopedStorageRecord: Codable {
    let version: Int, id: String, sequence: Int, previousSHA256: String
    let phase: String
    let base, anchor: RelayMaintenanceIdentity
    let image: RelayMaintenanceIdentity?
    let mount: RelayScopedStorageMount?
    static let phases = ["creating", "created", "attaching", "mounted", "detaching", "closed"]
    func bytes() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
    static func decode(_ data: Data) throws -> Self {
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.version == 1, RelayMaintenanceGate.uuid(value.id), (1...9_007_199_254_740_991).contains(value.sequence),
              value.sequence == 1 ? value.previousSHA256.isEmpty : RelayMaintenanceGate.hash(value.previousSHA256),
              phases.contains(value.phase), try value.bytes() == data else { throw RelayScopedStorageFailure.invalid }
        return value
    }
}
struct RelayScopedStorageHead: Codable {
    let version: Int, record: String, sha256: String
    func bytes() throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
    static func decode(_ bytes: Data) throws -> Self {
        let value = try JSONDecoder().decode(Self.self, from: bytes)
        guard value.version == 1, value.record.hasPrefix("record-"), value.record.hasSuffix(".json"),
              RelayMaintenanceGate.uuid(String(value.record.dropFirst(7).dropLast(5))), RelayMaintenanceGate.hash(value.sha256),
              try value.bytes() == bytes else { throw RelayScopedStorageFailure.invalid }
        return value
    }
}
struct RelayScopedStorageItem: Encodable {
    let id: String, revision: String, phase: String, canClose: Bool
    let writeClosure: String
    let descendantsExited = false
}
struct RelayScopedStorageReply: Encodable {
    let version = 1
    let id: String, action: String, status: String, reason: String
    let pending: Bool
    let items: [RelayScopedStorageItem]
}

// Directory+mount identities deliberately omit process-exit claims. A normal
// successful unmount may close ordinary sandboxed writes while a process with
// no open file is still alive. Elevated/malicious local cooperation is outside
// this limited launcher; completeClientScopeReady remains false.
