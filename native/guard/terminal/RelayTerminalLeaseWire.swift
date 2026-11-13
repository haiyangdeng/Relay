import Foundation
import Security

enum RelayTerminalLeaseFailure: String, Error {
    case unavailable, invalid, identity, busy, stale, deadline, transport
}

struct RelayTerminalLeaseGrant: Sendable {
    let proxyURL: String
    let caPEM: String

    init(_ object: [String: Any]) throws {
        guard Set(object.keys) == ["proxyURL", "caPEM"],
              let proxy = object["proxyURL"] as? String, let ca = object["caPEM"] as? String,
              let endpoint = URLComponents(string: proxy), let port = endpoint.port,
              (1...65535).contains(port), let secret = endpoint.password,
              Self.hex(secret, count: 64), proxy == "https://relay:\(secret)@127.0.0.1:\(port)",
              ca.utf8.count <= 8192 else { throw RelayTerminalLeaseFailure.invalid }
        let lines = ca.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count >= 4, lines.first == "-----BEGIN CERTIFICATE-----",
              lines[lines.count - 2] == "-----END CERTIFICATE-----", lines.last == "",
              let der = Data(base64Encoded: lines.dropFirst().dropLast(2).joined()),
              !der.isEmpty, SecCertificateCreateWithData(nil, der as CFData) != nil else {
            throw RelayTerminalLeaseFailure.invalid
        }
        proxyURL = proxy
        caPEM = ca
    }

    var object: [String: Any] { ["proxyURL": proxyURL, "caPEM": caPEM] }

    static func hex(_ value: String, count: Int) -> Bool {
        value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

enum RelayTerminalLeaseWire {
    static let contract = "relay-guard-terminal-v1"
    static let launcherID = "local.relay.network.preview.guard.terminal-cli"
    static let launcherRelativePath = "/Contents/Resources/relay/guard-terminal/RelayTerminalCLI"
    static let commandLimit = 1024
    static let responseLimit = 16384
    static let acquisitionBudget: UInt64 = 10_000_000_000

    static func id(_ value: Any?) throws -> String {
        guard let value = value as? String, UUID(uuidString: value)?.uuidString.lowercased() == value else {
            throw RelayTerminalLeaseFailure.invalid
        }
        return value
    }
    static func object(_ data: Data, maximum: Int = responseLimit) throws -> [String: Any] {
        do {
            let value = try RelayTunStrictJSON.object(data, limit: maximum, maxNodes: 32)
            guard RelayTunStrictJSON.integer(value["version"]) == 1 else { throw RelayTerminalLeaseFailure.invalid }
            return value
        } catch { throw RelayTerminalLeaseFailure.invalid }
    }
    static func encode(_ object: [String: Any], frame: Bool = false) throws -> Data {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        guard data.count <= responseLimit else { throw RelayTerminalLeaseFailure.invalid }
        return frame ? data + Data([10]) : data
    }
    static func command(_ action: String, id: String) throws -> Data {
        try encode(["version": 1, "contract": contract, "action": action, "id": id], frame: true)
    }
    static func readCommand(_ bytes: Data, action: String) throws -> String {
        let value = try object(bytes, maximum: commandLimit)
        guard Set(value.keys) == ["version", "contract", "action", "id"], value["contract"] as? String == contract,
              value["action"] as? String == action else { throw RelayTerminalLeaseFailure.invalid }
        return try id(value["id"])
    }
    static func response(_ kind: String, id: String, grant: RelayTerminalLeaseGrant? = nil) throws -> Data {
        var value: [String: Any] = ["version": 1, "contract": contract, "kind": kind, "id": id]
        if let grant { value["grant"] = grant.object }
        return try encode(value, frame: true)
    }
    static func readResponse(_ data: Data, kind: String, id: String) throws -> RelayTerminalLeaseGrant? {
        let value = try object(data)
        let fields: Set<String> = ["version", "contract", "kind", "id"]
        guard Set(value.keys) == fields.union(kind == "grant" ? ["grant"] : []), value["contract"] as? String == contract,
              value["kind"] as? String == kind, value["id"] as? String == id else { throw RelayTerminalLeaseFailure.stale }
        guard kind == "grant" else { return nil }
        guard let grant = value["grant"] as? [String: Any] else { throw RelayTerminalLeaseFailure.invalid }
        return try RelayTerminalLeaseGrant(grant)
    }
}
