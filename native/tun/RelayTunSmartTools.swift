import Foundation
import CoreFoundation
import CryptoKit

/// Fixed462 ranking/cache tools. This type owns no Core, file or lifecycle.
enum RelayTunSmartTools {
    static let payloadLimit = 240 * 1024
    static let frameLimit = 256 * 1024
    static let groupLimit = 200
    static let rowLimit = 2000
    enum Failure: Error { case invalid, unsupported, unavailable, revoked, uncertain }
    enum Rank: String, CaseIterable {
        case unranked = "", mostUsed = "MostUsed", occasional = "OccasionalUsed", rarelyUsed = "RarelyUsed"
    }
    struct Row {
        let name: String, rank: Rank
        let weight: Double
        var json: [String: Any] { ["Name": name, "Rank": rank.rawValue, "Weight": weight] }
    }
    struct Group {
        let name: String
        let available: Bool
        let rows: [Row]
        var json: [String: Any] { ["name": name, "status": available ? "ready" : "unavailable", "weights": rows.map { $0.json }] }
    }
    struct Definition {
        let configurationRevision: String
        let groups: [String]
        init(configuration: Data) throws {
            let raw = try RelayTunStrictJSON.object(configuration, limit: 2 * 1024 * 1024, maxNodes: 200000)
            guard let groups = raw["proxy-groups"] as? [[String: Any]] else { throw Failure.unsupported }
            var names = [String]()
            for group in groups where group["type"] as? String == "smart" {
                guard let name = group["name"] as? String, validName(name), !names.contains(name) else { throw Failure.invalid }
                names.append(name)
            }
            guard !names.isEmpty, names.count <= groupLimit else { throw Failure.unsupported }
            self.configurationRevision = SHA256.hash(data: configuration).map { String(format: "%02x", $0) }.joined()
            self.groups = names
        }
    }
    struct Snapshot {
        let configurationRevision: String
        let groups: [Group]?
        var json: [String: Any] {
            if let groups {
                return ["version": 1, "kind": "weights", "configurationRevision": configurationRevision, "groups": groups.map { $0.json }]
            }
            return ["version": 1, "kind": "clear-cache", "configurationRevision": configurationRevision, "accepted": true]
        }
    }
    struct Clear {
        init(_ raw: [String: Any]) throws {
            guard raw.isEmpty else { throw Failure.invalid }
        }
    }
    static func validName(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf16.count <= 256 &&
            value.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value != 127 }
    }
    static func rows(_ raw: Any) throws -> [Row] {
        guard let items = raw as? [Any], items.count <= rowLimit else { throw Failure.unavailable }
        var names = Set<String>()
        return try items.map { item in
            guard let item = item as? [String: Any], Set(item.keys) == ["Name", "Rank", "Weight"],
                  let name = item["Name"] as? String, validName(name), names.insert(name).inserted,
                  let rankName = item["Rank"] as? String, let rank = Rank(rawValue: rankName),
                  let number = item["Weight"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, (0...100).contains(number.doubleValue) else { throw Failure.unavailable }
            return Row(name: name, rank: rank, weight: number.doubleValue)
        }
    }
    static func decodeAggregate(_ bytes: Data, definition: Definition) throws -> Snapshot {
        guard bytes.count <= payloadLimit else { throw Failure.unavailable }
        let raw = try RelayTunStrictJSON.object(bytes, limit: payloadLimit, maxNodes: 20000)
        guard Set(raw.keys).isSubset(of: ["weights", "errors", "message"]),
              let weights = raw["weights"] as? [String: Any],
              raw["errors"] == nil || raw["errors"] is [String: Any],
              raw["message"] == nil || ((raw["message"] as? String)?.utf8.count ?? Int.max) <= 4096 else { throw Failure.unavailable }
        let errors = raw["errors"] as? [String: Any] ?? [:]
        let returned = Array(weights.keys) + Array(errors.keys)
        // getAllGroupWeights enumerates tunnel.Proxies' current Smart adapters,
        // not historical cache keys. Historical node rows within a current
        // group are retained exactly; they are not health-check observations.
        guard returned.count == definition.groups.count,
              Set(returned).count == returned.count, Set(returned) == Set(definition.groups) else { throw Failure.unavailable }
        var count = 0
        let groups: [Group] = try definition.groups.map { name in
            if let error = errors[name] {
                guard let error = error as? String, error.utf8.count <= 4096 else { throw Failure.unavailable }
                return Group(name: name, available: false, rows: [])
            }
            guard let value = weights[name] else { throw Failure.unavailable }
            // A nil []NodeRankItem is JSON null in the fixed aggregate endpoint.
            let entries = value is NSNull ? [] : try rows(value)
            count += entries.count
            guard count <= rowLimit else { throw Failure.unavailable }
            return Group(name: name, available: true, rows: entries)
        }
        let snapshot = Snapshot(configurationRevision: definition.configurationRevision, groups: groups)
        guard try JSONSerialization.data(withJSONObject: snapshot.json, options: [.sortedKeys, .withoutEscapingSlashes]).count <= payloadLimit else { throw Failure.unavailable }
        return snapshot
    }
    /// One operation's publication/write stamp. No file or Core owner is held
    /// under this lock; disposal/EOF can revoke it without waiting for IO.
    final class Operation {
        private let lock = NSLock()
        private var revoked = false, submitted = false, finished = false
        func check() throws { lock.lock(); defer { lock.unlock() }; if revoked { throw Failure.revoked } }
        func enterWrite() throws {
            lock.lock(); defer { lock.unlock() }
            guard !revoked else { throw Failure.revoked }; submitted = true
        }
        func cancel() -> String {
            lock.lock(); defer { lock.unlock() }; revoked = true
            return submitted ? "uncertain" : "cancelled"
        }
        func finish() { lock.lock(); finished = true; lock.unlock() }
        var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return finished }
        var mayHaveWritten: Bool { lock.lock(); defer { lock.unlock() }; return submitted }
    }
    final class Authority {
        private let lock = NSLock()
        private var closed = false
        private var operations = [Int: Operation]()
        func begin(_ id: Int) throws -> Operation {
            lock.lock(); defer { lock.unlock() }
            operations = operations.filter { !$0.value.isFinished }
            guard !closed, operations[id] == nil else { throw Failure.revoked }
            let operation = Operation(); operations[id] = operation; return operation
        }
        func finish(_ id: Int) { lock.lock(); let operation = operations[id]; lock.unlock(); operation?.finish() }
        func cancel(_ id: Int) -> String {
            lock.lock(); let operation = operations[id]; lock.unlock()
            return operation?.cancel() ?? "cancelled"
        }
        func revoke() {
            lock.lock(); closed = true; let active = Array(operations.values); lock.unlock()
            for operation in active { _ = operation.cancel() }
        }
    }
}
