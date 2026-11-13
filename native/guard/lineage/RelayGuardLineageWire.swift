import Darwin
import Foundation

@objc protocol RelayGuardLineageCommunication {
    func transact(_ request: NSData, withReply reply: @escaping (NSData) -> Void)
}

@objc protocol RelayGuardLineageUpdates {
    func updated(_ update: NSData)
    func claimExecution(_ request: NSData, withReply reply: @escaping (NSData) -> Void)
    func settleExecution(_ settlement: NSData)
}

enum RelayGuardExecutionOutcome: String, Sendable {
    case committed, aborted, uncertain
}

struct RelayGuardExecutionTicket: Sendable {
    let claimID: String
    let actorToken: Data
    let targetToken: Data
    let subject: RelayGuardSubject
    let health: RelayGuardLineageHealth
    let tagVersion: UInt64
    let authSequence: UInt64
    let authGlobalSequence: UInt64
    let expiresMach: UInt64
    let clockDomain = RelayGuardExecutionClock.domain

    var process: RelayGuardLineageProcess? { .init(auditToken: targetToken) }
    fileprivate var object: [String: Any] {
        ["claimID": claimID, "actorToken": actorToken.base64EncodedString(),
         "targetToken": targetToken.base64EncodedString(), "subject": subject.rawValue,
         "health": health.object, "tagVersion": tagVersion,
         "authSequence": String(authSequence), "authGlobalSequence": String(authGlobalSequence),
         "expiresMach": String(expiresMach), "clockDomain": clockDomain ?? ""]
    }

    func matches(_ other: Self) -> Bool {
        claimID == other.claimID && actorToken == other.actorToken && targetToken == other.targetToken
            && subject == other.subject && tagVersion == other.tagVersion
            && authSequence == other.authSequence && authGlobalSequence == other.authGlobalSequence
            && expiresMach == other.expiresMach && clockDomain == other.clockDomain && clockDomain != nil
            && health.epoch == other.health.epoch
            && health.revision == other.health.revision && health.monitoring == other.health.monitoring
            && health.knownRootsAvailable == other.health.knownRootsAvailable
            && health.globalCoverageReady == other.health.globalCoverageReady && health.losses == other.health.losses
    }

    fileprivate static func decode(_ value: [String: Any]) throws -> Self {
        guard Set(value.keys) == ["claimID", "actorToken", "targetToken", "subject", "health", "tagVersion", "authSequence", "authGlobalSequence", "expiresMach", "clockDomain"],
              let domain = RelayGuardExecutionClock.domain, value["clockDomain"] as? String == domain,
              let id = value["claimID"] as? String, RelayGuardLineageWire.uuid(id),
              let actor = value["actorToken"] as? String, let target = value["targetToken"] as? String,
              let rawSubject = value["subject"] as? String, let subject = RelayGuardSubject(rawValue: rawSubject),
              [.desktop, .desktopHelper, .nativeCLI, .officialScriptCLI, .unverifiedProtected].contains(subject),
              let healthObject = value["health"] as? [String: Any] else { throw RelayGuardLineageWireFailure.invalid }
        let actorToken = try RelayGuardLineageWire.token(actor), targetToken = try RelayGuardLineageWire.token(target)
        guard let old = RelayGuardLineageProcess(auditToken: actorToken), let new = RelayGuardLineageProcess(auditToken: targetToken),
              old.pid == new.pid, old.pidversion != new.pidversion else { throw RelayGuardLineageWireFailure.invalid }
        let health = try RelayGuardLineageHealth.decode(healthObject)
        guard health.available else { throw RelayGuardLineageWireFailure.unavailable }
        return Self(claimID: id, actorToken: actorToken, targetToken: targetToken, subject: subject, health: health,
            tagVersion: try RelayGuardLineageWire.integer(value["tagVersion"]),
            authSequence: try RelayGuardLineageWire.rawCounter(value["authSequence"]),
            authGlobalSequence: try RelayGuardLineageWire.rawCounter(value["authGlobalSequence"]),
            expiresMach: try RelayGuardLineageWire.rawCounter(value["expiresMach"]))
    }
}

struct RelayGuardExecutionLease: Equatable, Sendable {
    let providerRunID: String
    let coreGeneration: UInt64
    let coreInstanceID: String
    let configurationSHA256: String
    fileprivate var object: [String: Any] {
        ["providerRunID": providerRunID, "coreGeneration": coreGeneration,
         "coreInstanceID": coreInstanceID, "configurationSHA256": configurationSHA256]
    }
    fileprivate static func decode(_ value: [String: Any]) throws -> Self {
        guard Set(value.keys) == ["providerRunID", "coreGeneration", "coreInstanceID", "configurationSHA256"],
              let run = value["providerRunID"] as? String, RelayGuardLineageWire.uuid(run),
              let instance = value["coreInstanceID"] as? String, RelayGuardLineageWire.uuid(instance),
              let hash = value["configurationSHA256"] as? String, hash.utf8.count == 64,
              hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw RelayGuardLineageWireFailure.invalid
        }
        return Self(providerRunID: run, coreGeneration: try RelayGuardLineageWire.integer(value["coreGeneration"]),
                    coreInstanceID: instance, configurationSHA256: hash)
    }
}

struct RelayGuardExecutionFrame: Sendable {
    let stamp: RelayGuardLineageAttestation
    let clientNonce: String
    let serverNonce: String
    let executionSequence: UInt64
    let ticket: RelayGuardExecutionTicket
    let outcome: RelayGuardExecutionOutcome?

    init(clientNonce: String, serverNonce: String, executionSequence: UInt64,
         ticket: RelayGuardExecutionTicket, outcome: RelayGuardExecutionOutcome? = nil) throws {
        self.stamp = try RelayGuardLineageIdentity.current()
        self.clientNonce = clientNonce; self.serverNonce = serverNonce
        self.executionSequence = executionSequence; self.ticket = ticket; self.outcome = outcome
    }
    private init(stamp: RelayGuardLineageAttestation, clientNonce: String, serverNonce: String,
                 executionSequence: UInt64, ticket: RelayGuardExecutionTicket, outcome: RelayGuardExecutionOutcome?) {
        self.stamp = stamp; self.clientNonce = clientNonce; self.serverNonce = serverNonce
        self.executionSequence = executionSequence; self.ticket = ticket; self.outcome = outcome
    }
    func encoded() throws -> Data {
        var object = RelayGuardLineageWire.metadata(stamp)
        object.merge(["kind": outcome == nil ? "prepare" : "settle", "clientNonce": clientNonce,
            "serverNonce": serverNonce, "executionSequence": executionSequence, "ticket": ticket.object]) { _, new in new }
        if let outcome { object["outcome"] = outcome.rawValue }
        return try RelayGuardLineageWire.encode(object)
    }
    static func decode(_ data: Data) throws -> Self {
        let object = try RelayGuardLineageWire.object(data), stamp = try RelayGuardLineageWire.attestation(object)
        guard let kind = object["kind"] as? String, ["prepare", "settle"].contains(kind),
              Set(object.keys) == RelayGuardLineageWire.metadataKeys.union(["kind", "clientNonce", "serverNonce", "executionSequence", "ticket"])
                .union(kind == "settle" ? ["outcome"] : []),
              let client = object["clientNonce"] as? String, RelayGuardLineageWire.nonce(client),
              let server = object["serverNonce"] as? String, RelayGuardLineageWire.nonce(server),
              let ticket = object["ticket"] as? [String: Any] else { throw RelayGuardLineageWireFailure.invalid }
        var outcome: RelayGuardExecutionOutcome?
        if kind == "settle" {
            guard let raw = object["outcome"] as? String, let decoded = RelayGuardExecutionOutcome(rawValue: raw) else {
                throw RelayGuardLineageWireFailure.invalid
            }
            outcome = decoded
        }
        return Self(stamp: stamp, clientNonce: client, serverNonce: server,
                    executionSequence: try RelayGuardLineageWire.integer(object["executionSequence"]),
                    ticket: try RelayGuardExecutionTicket.decode(ticket), outcome: outcome)
    }
}

struct RelayGuardExecutionAcknowledgement: Sendable {
    let request: RelayGuardExecutionFrame
    let lease: RelayGuardExecutionLease?
    func encoded() throws -> Data {
        var object = RelayGuardLineageWire.metadata(request.stamp)
        object.merge(["clientNonce": request.clientNonce, "serverNonce": request.serverNonce,
            "executionSequence": request.executionSequence, "ticket": request.ticket.object,
            "claimed": lease != nil]) { _, new in new }
        if let lease { object["lease"] = lease.object }
        return try RelayGuardLineageWire.encode(object)
    }
    static func decode(_ data: Data, for request: RelayGuardExecutionFrame) throws -> Self {
        let object = try RelayGuardLineageWire.object(data)
        guard request.outcome == nil, try RelayGuardLineageWire.attestation(object) == request.stamp,
              object["clientNonce"] as? String == request.clientNonce, object["serverNonce"] as? String == request.serverNonce,
              try RelayGuardLineageWire.integer(object["executionSequence"]) == request.executionSequence,
              let ticket = object["ticket"] as? [String: Any],
              try RelayGuardExecutionTicket.decode(ticket).matches(request.ticket) else { throw RelayGuardLineageWireFailure.stale }
        let claimed = try RelayGuardLineageWire.boolean(object["claimed"])
        guard Set(object.keys) == RelayGuardLineageWire.metadataKeys.union(["clientNonce", "serverNonce", "executionSequence", "ticket", "claimed"])
            .union(claimed ? ["lease"] : []) else { throw RelayGuardLineageWireFailure.invalid }
        let lease: RelayGuardExecutionLease?
        if claimed {
            guard let raw = object["lease"] as? [String: Any] else { throw RelayGuardLineageWireFailure.invalid }
            lease = try RelayGuardExecutionLease.decode(raw)
        } else { lease = nil }
        return Self(request: request, lease: lease)
    }
}

enum RelayGuardExecutionClock {
    private static let architecture: String? = {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return nil
        #endif
    }()
    private static let timebase: (numer: UInt64, denom: UInt64)? = {
        var value = mach_timebase_info_data_t()
        guard mach_timebase_info(&value) == KERN_SUCCESS, value.numer > 0, value.denom > 0 else { return nil }
        return (UInt64(value.numer), UInt64(value.denom))
    }()
    static let domain: String? = {
        guard let architecture, let timebase else { return nil }
        return "\(architecture):\(timebase.numer):\(timebase.denom)"
    }()

    static func remainingNanoseconds(until deadline: UInt64) -> UInt64? {
        let now = mach_absolute_time()
        guard domain != nil, deadline > now, let timebase else { return nil }
        let remaining = deadline - now
        let maximum = 2_000_000_000 * timebase.denom / timebase.numer
        guard remaining <= maximum else { return nil }
        let nanos = remaining * timebase.numer / timebase.denom
        return nanos > 0 ? nanos : nil
    }
}

enum RelayGuardLineageWireFailure: Error { case invalid, unavailable, stale, capacity }

struct RelayGuardLineageAttestation: Equatable, Sendable {
    let buildVersion: String
    let policyRevision: String
    let contractRevision: String
    let catalogRevision: String
}

struct RelayGuardLineageProcess: Hashable, Sendable {
    let pid: Int32
    let pidversion: UInt32
    init(pid: Int32, pidversion: UInt32) { self.pid = pid; self.pidversion = pidversion }
    init?(auditToken: Data) {
        guard let value = RelayGuardProcessGeneration(token: auditToken) else { return nil }
        self.init(pid: value.pid, pidversion: value.version)
    }
    fileprivate var object: [String: Any] { ["pid": pid, "pidversion": pidversion] }
    fileprivate static func decode(_ object: [String: Any]) throws -> Self {
        guard Set(object.keys) == ["pid", "pidversion"] else { throw RelayGuardLineageWireFailure.invalid }
        let pid = try RelayGuardLineageWire.integer(object["pid"], max: UInt64(Int32.max))
        let version = try RelayGuardLineageWire.integer(object["pidversion"], max: UInt64(UInt32.max), minimum: 0)
        return Self(pid: Int32(pid), pidversion: UInt32(version))
    }
}

struct RelayGuardLineageWireTag: Sendable {
    let pid: Int32
    let pidversion: UInt32
    let subject: RelayGuardSubject
    let tagVersion: UInt64
    var process: RelayGuardLineageProcess { .init(pid: pid, pidversion: pidversion) }
    fileprivate var object: [String: Any] {
        ["pid": pid, "pidversion": pidversion, "subject": subject.rawValue, "tagVersion": tagVersion]
    }
    fileprivate static func decode(_ object: [String: Any]) throws -> Self {
        guard Set(object.keys) == ["pid", "pidversion", "subject", "tagVersion"],
              let raw = object["subject"] as? String, let subject = RelayGuardSubject(rawValue: raw),
              [.desktop, .desktopHelper, .nativeCLI, .officialScriptCLI, .unverifiedProtected].contains(subject) else {
            throw RelayGuardLineageWireFailure.invalid
        }
        let process = try RelayGuardLineageProcess.decode(["pid": object["pid"] ?? NSNull(), "pidversion": object["pidversion"] ?? NSNull()])
        return Self(pid: process.pid, pidversion: process.pidversion, subject: subject,
                    tagVersion: try RelayGuardLineageWire.integer(object["tagVersion"]))
    }
}

struct RelayGuardLineageHealth: Sendable {
    let epoch: String
    let revision: UInt64
    let monitoring: Bool
    let knownRootsAvailable: Bool
    let globalCoverageReady: Bool
    let losses: [String]
    var available: Bool {
        monitoring && knownRootsAvailable && !globalCoverageReady && Set(losses).isSubset(of: ["lateAttach"])
    }
    fileprivate var object: [String: Any] {
        ["epoch": epoch, "revision": revision, "monitoring": monitoring,
         "knownRootsAvailable": knownRootsAvailable, "globalCoverageReady": globalCoverageReady, "losses": losses]
    }
    fileprivate static func decode(_ object: [String: Any]) throws -> Self {
        guard Set(object.keys) == ["epoch", "revision", "monitoring", "knownRootsAvailable", "globalCoverageReady", "losses"],
              let epoch = object["epoch"] as? String, RelayGuardLineageWire.uuid(epoch),
              let losses = object["losses"] as? [String], losses.count <= 7, Set(losses).count == losses.count,
              Set(losses).isSubset(of: ["lateAttach", "unsupportedMessage", "eventGap", "invalidTransition", "capacity", "disconnected", "queueOverflow"]) else {
            throw RelayGuardLineageWireFailure.invalid
        }
        let value = Self(epoch: epoch, revision: try RelayGuardLineageWire.integer(object["revision"]),
                         monitoring: try RelayGuardLineageWire.boolean(object["monitoring"]),
                         knownRootsAvailable: try RelayGuardLineageWire.boolean(object["knownRootsAvailable"]),
                         globalCoverageReady: try RelayGuardLineageWire.boolean(object["globalCoverageReady"]), losses: losses)
        guard !value.globalCoverageReady, !value.knownRootsAvailable || value.available else {
            throw RelayGuardLineageWireFailure.invalid
        }
        return value
    }
}

struct RelayGuardLineageRequest: Sendable {
    let stamp: RelayGuardLineageAttestation
    let id: String
    let clientNonce: String
    let serverNonce: String?
    let sequence: UInt64
    let action: String
    let tokens: [Data]?
    var buildVersion: String { stamp.buildVersion }
    var policyRevision: String { stamp.policyRevision }
    var contractRevision: String { stamp.contractRevision }
    var catalogRevision: String { stamp.catalogRevision }

    init(action: String, clientNonce: String, serverNonce: String? = nil, sequence: UInt64, tokens: [Data]? = nil) throws {
        self.init(stamp: try RelayGuardLineageIdentity.current(), id: UUID().uuidString.lowercased(),
                  clientNonce: clientNonce, serverNonce: serverNonce, sequence: sequence, action: action, tokens: tokens)
        _ = try Self.decode(encoded())
    }
    private init(stamp: RelayGuardLineageAttestation, id: String, clientNonce: String, serverNonce: String?, sequence: UInt64, action: String, tokens: [Data]?) {
        self.stamp = stamp; self.id = id; self.clientNonce = clientNonce; self.serverNonce = serverNonce
        self.sequence = sequence; self.action = action; self.tokens = tokens
    }
    func encoded() throws -> Data {
        var object = RelayGuardLineageWire.metadata(stamp)
        object.merge(["id": id, "clientNonce": clientNonce, "sequence": sequence, "action": action]) { _, new in new }
        if let serverNonce { object["serverNonce"] = serverNonce }
        if let tokens { object["tokens"] = tokens.map { $0.base64EncodedString() } }
        return try RelayGuardLineageWire.encode(object)
    }
    static func decode(_ data: Data) throws -> Self {
        let object = try RelayGuardLineageWire.object(data), stamp = try RelayGuardLineageWire.attestation(object)
        guard let action = object["action"] as? String, ["hello", "bootstrap", "status", "query"].contains(action),
              Set(object.keys) == RelayGuardLineageWire.metadataKeys.union(["id", "clientNonce", "sequence", "action"])
                .union(action == "hello" ? [] : ["serverNonce"]).union(action == "query" ? ["tokens"] : []),
              let id = object["id"] as? String, RelayGuardLineageWire.uuid(id),
              let client = object["clientNonce"] as? String, RelayGuardLineageWire.nonce(client) else {
            throw RelayGuardLineageWireFailure.invalid
        }
        let sequence = try RelayGuardLineageWire.integer(object["sequence"])
        let server = object["serverNonce"] as? String
        guard action == "hello" ? sequence == 1 : server.map(RelayGuardLineageWire.nonce) == true else {
            throw RelayGuardLineageWireFailure.invalid
        }
        var tokens: [Data]?
        if action == "query" {
            guard let values = object["tokens"] as? [String], (1...2).contains(values.count) else { throw RelayGuardLineageWireFailure.invalid }
            tokens = try values.map { try RelayGuardLineageWire.token($0) }
        }
        return Self(stamp: stamp, id: id, clientNonce: client, serverNonce: server, sequence: sequence, action: action, tokens: tokens)
    }
}

struct RelayGuardLineageResult: Sendable {
    let auditToken: Data
    let tag: RelayGuardLineageWireTag?
    fileprivate var object: [String: Any] {
        var result: [String: Any] = ["auditToken": auditToken.base64EncodedString()]
        if let tag { result["tag"] = tag.object }
        return result
    }
}

struct RelayGuardLineageBootstrapPage: Sendable {
    static let pageSize = 256
    static let maximumMembers = 65536
    let offset: Int
    let total: Int
    let members: [RelayGuardLineageProcess]
    let updateThrough: UInt64?

    fileprivate var object: [String: Any] {
        var value: [String: Any] = ["offset": offset, "total": total, "members": members.map(\.object)]
        if let updateThrough { value["updateThrough"] = updateThrough }
        return value
    }

    fileprivate static func decode(_ object: [String: Any]) throws -> Self {
        let total = Int(try RelayGuardLineageWire.integer(object["total"], max: UInt64(maximumMembers), minimum: 0))
        let offset = Int(try RelayGuardLineageWire.integer(object["offset"], max: UInt64(total), minimum: 0))
        guard let values = object["members"] as? [[String: Any]],
              values.count == min(pageSize, total - offset) else { throw RelayGuardLineageWireFailure.invalid }
        let final = offset + values.count == total
        let keys: Set<String> = final ? ["offset", "total", "members", "updateThrough"] : ["offset", "total", "members"]
        let members = try values.map(RelayGuardLineageProcess.decode)
        guard Set(object.keys) == keys, Set(members).count == members.count else {
            throw RelayGuardLineageWireFailure.invalid
        }
        return .init(offset: offset, total: total, members: members,
            updateThrough: final ? try RelayGuardLineageWire.integer(object["updateThrough"], minimum: 0) : nil)
    }
}

struct RelayGuardLineageReply: Sendable {
    let request: RelayGuardLineageRequest
    let serverNonce: String
    let health: RelayGuardLineageHealth
    let results: [RelayGuardLineageResult]
    let bootstrap: RelayGuardLineageBootstrapPage?
    init(request: RelayGuardLineageRequest, serverNonce: String, health: RelayGuardLineageHealth,
         results: [RelayGuardLineageResult], bootstrap: RelayGuardLineageBootstrapPage? = nil) {
        self.request = request; self.serverNonce = serverNonce; self.health = health; self.results = results
        self.bootstrap = bootstrap
    }
    func encoded() throws -> Data {
        var object = RelayGuardLineageWire.metadata(request.stamp)
        object.merge(["id": request.id, "clientNonce": request.clientNonce, "serverNonce": serverNonce,
                      "sequence": request.sequence, "health": health.object, "results": results.map(\.object)]) { _, new in new }
        if let bootstrap { object["bootstrap"] = bootstrap.object }
        return try RelayGuardLineageWire.encode(object)
    }
    static func decode(_ data: Data, for request: RelayGuardLineageRequest) throws -> Self {
        let object = try RelayGuardLineageWire.object(data)
        let keys = RelayGuardLineageWire.metadataKeys.union(["id", "clientNonce", "serverNonce", "sequence", "health", "results"])
        guard Set(object.keys) == keys.union(request.action == "bootstrap" ? ["bootstrap"] : []),
              try RelayGuardLineageWire.attestation(object) == request.stamp,
              object["id"] as? String == request.id, object["clientNonce"] as? String == request.clientNonce,
              try RelayGuardLineageWire.integer(object["sequence"]) == request.sequence,
              let nonce = object["serverNonce"] as? String, RelayGuardLineageWire.nonce(nonce),
              request.serverNonce == nil || request.serverNonce == nonce,
              let health = object["health"] as? [String: Any], let results = object["results"] as? [[String: Any]],
              results.count == (request.tokens?.count ?? 0) else { throw RelayGuardLineageWireFailure.invalid }
        var decoded: [RelayGuardLineageResult] = []
        for (index, value) in results.enumerated() {
            guard Set(value.keys) == Set(["auditToken"] + (value["tag"] == nil ? [] : ["tag"])),
                  let raw = value["auditToken"] as? String else { throw RelayGuardLineageWireFailure.invalid }
            let token = try RelayGuardLineageWire.token(raw)
            guard token == request.tokens?[index] else { throw RelayGuardLineageWireFailure.stale }
            var tag: RelayGuardLineageWireTag?
            if let rawTag = value["tag"] {
                guard let dictionary = rawTag as? [String: Any] else { throw RelayGuardLineageWireFailure.invalid }
                tag = try RelayGuardLineageWireTag.decode(dictionary)
                guard tag?.process == RelayGuardLineageProcess(auditToken: token) else { throw RelayGuardLineageWireFailure.stale }
            }
            decoded.append(.init(auditToken: token, tag: tag))
        }
        var bootstrap: RelayGuardLineageBootstrapPage?
        if request.action == "bootstrap" {
            guard let value = object["bootstrap"] as? [String: Any] else { throw RelayGuardLineageWireFailure.invalid }
            bootstrap = try RelayGuardLineageBootstrapPage.decode(value)
        }
        return Self(request: request, serverNonce: nonce, health: try RelayGuardLineageHealth.decode(health),
            results: decoded, bootstrap: bootstrap)
    }
}

struct RelayGuardLineageUpdate: Sendable {
    let stamp: RelayGuardLineageAttestation
    let clientNonce: String
    let serverNonce: String
    let updateSequence: UInt64
    let health: RelayGuardLineageHealth
    let changed: [RelayGuardLineageProcess]
    let invalidateAll: Bool
    init(clientNonce: String, serverNonce: String, updateSequence: UInt64, health: RelayGuardLineageHealth, changed: [RelayGuardLineageProcess], invalidateAll: Bool) throws {
        self.init(stamp: try RelayGuardLineageIdentity.current(), clientNonce: clientNonce, serverNonce: serverNonce,
                  updateSequence: updateSequence, health: health, changed: changed, invalidateAll: invalidateAll)
    }
    private init(stamp: RelayGuardLineageAttestation, clientNonce: String, serverNonce: String, updateSequence: UInt64, health: RelayGuardLineageHealth, changed: [RelayGuardLineageProcess], invalidateAll: Bool) {
        self.stamp = stamp; self.clientNonce = clientNonce; self.serverNonce = serverNonce; self.updateSequence = updateSequence
        self.health = health; self.changed = changed; self.invalidateAll = invalidateAll
    }
    func encoded() throws -> Data {
        var object = RelayGuardLineageWire.metadata(stamp)
        object.merge(["clientNonce": clientNonce, "serverNonce": serverNonce, "updateSequence": updateSequence,
                      "health": health.object, "changed": changed.map(\.object), "invalidateAll": invalidateAll]) { _, new in new }
        return try RelayGuardLineageWire.encode(object)
    }
    static func decode(_ data: Data) throws -> Self {
        let object = try RelayGuardLineageWire.object(data), stamp = try RelayGuardLineageWire.attestation(object)
        guard Set(object.keys) == RelayGuardLineageWire.metadataKeys.union(["clientNonce", "serverNonce", "updateSequence", "health", "changed", "invalidateAll"]),
              let client = object["clientNonce"] as? String, RelayGuardLineageWire.nonce(client),
              let server = object["serverNonce"] as? String, RelayGuardLineageWire.nonce(server),
              let health = object["health"] as? [String: Any], let raw = object["changed"] as? [[String: Any]], raw.count <= 256 else {
            throw RelayGuardLineageWireFailure.invalid
        }
        let changed = try raw.map(RelayGuardLineageProcess.decode), invalidate = try RelayGuardLineageWire.boolean(object["invalidateAll"])
        guard Set(changed).count == changed.count, !invalidate || changed.isEmpty else { throw RelayGuardLineageWireFailure.invalid }
        return Self(stamp: stamp, clientNonce: client, serverNonce: server,
                    updateSequence: try RelayGuardLineageWire.integer(object["updateSequence"]),
                    health: try RelayGuardLineageHealth.decode(health), changed: changed, invalidateAll: invalidate)
    }
}

private enum RelayGuardLineageWire {
    static let maximumCounter: UInt64 = 9_007_199_254_740_991
    static let metadataKeys: Set<String> = ["version", "contractRevision", "buildVersion", "policyRevision", "catalogRevision"]
    static func object(_ data: Data) throws -> [String: Any] { try RelayTunStrictJSON.object(data, limit: 32768) }
    static func encode(_ object: [String: Any]) throws -> Data {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard data.count <= 32768 else { throw RelayGuardLineageWireFailure.invalid }
        return data
    }
    static func integer(_ value: Any?, max: UInt64 = maximumCounter, minimum: UInt64 = 1) throws -> UInt64 {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= Double(minimum), number.doubleValue <= Double(max),
              number.doubleValue.rounded(.towardZero) == number.doubleValue else { throw RelayGuardLineageWireFailure.invalid }
        return number.uint64Value
    }
    static func boolean(_ value: Any?) throws -> Bool {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw RelayGuardLineageWireFailure.invalid }
        return value.boolValue
    }
    static func rawCounter(_ value: Any?) throws -> UInt64 {
        guard let string = value as? String, let number = UInt64(string), String(number) == string else {
            throw RelayGuardLineageWireFailure.invalid
        }
        return number
    }
    static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func nonce(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    static func token(_ value: String) throws -> Data {
        guard let data = Data(base64Encoded: value), data.count == 32, data.base64EncodedString() == value,
              RelayGuardLineageProcess(auditToken: data) != nil else { throw RelayGuardLineageWireFailure.invalid }
        return data
    }
    static func metadata(_ stamp: RelayGuardLineageAttestation) -> [String: Any] {
        ["version": 1, "buildVersion": stamp.buildVersion, "policyRevision": stamp.policyRevision,
         "contractRevision": stamp.contractRevision, "catalogRevision": stamp.catalogRevision]
    }
    static func attestation(_ object: [String: Any]) throws -> RelayGuardLineageAttestation {
        let actual = try RelayGuardLineageIdentity.current()
        guard try integer(object["version"]) == 1,
              object["buildVersion"] as? String == actual.buildVersion,
              object["policyRevision"] as? String == actual.policyRevision,
              object["contractRevision"] as? String == actual.contractRevision,
              object["catalogRevision"] as? String == actual.catalogRevision else { throw RelayGuardLineageWireFailure.stale }
        return actual
    }
}
