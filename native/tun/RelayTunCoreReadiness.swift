import Foundation
import CoreFoundation
import CryptoKit
import Darwin

/// The digest identifies the exact launch bytes, not an arbitrary /configs
/// payload. Every observation additionally checks the fixed core version and
/// supplied-FD TUN fields on the socket of the held ordinary-UID child.
struct RelayTunCoreReadiness {
    static let resourceVersion = "relay-geodata-v1p1-3f27"
    enum Endpoint: String, CaseIterable { case version, configs }
    enum Field: String, CaseIterable {
        case version, tun
        case enable = "tun.enable", descriptor = "tun.file-descriptor", device = "tun.device", stack = "tun.stack"
        case mtu = "tun.mtu", autoRoute = "tun.auto-route", autoDetect = "tun.auto-detect-interface"
        case port, socksPort = "socks-port", mixedPort = "mixed-port", redirPort = "redir-port", tproxyPort = "tproxy-port"
        case mode, allowLAN = "allow-lan", ipv6
        case autoRedirect = "tun.auto-redirect", gso = "tun.gso", recvmsgx = "tun.recvmsgx", sendmsgx = "tun.sendmsgx"
        case dnsHijack = "tun.dns-hijack", dnsMode = "tun.dns-mode"
    }
    enum ReadStage: String, CaseIterable { case busy, socket, options, poll, write, receive, limit }
    enum Failure: Error, Equatable {
        case invalid, resource, response, deadline, peer
        case field(Field), io(Endpoint, ReadStage), json(Endpoint), http(Endpoint)
        case rulesIO(ReadStage), rulesJSON, rulesHTTP
        case resourcesIO(ReadStage), resourcesJSON, resourcesHTTP, resourceStatus(String)
        case providersIO(ReadStage), providersHTTP
        case smartToolsIO(ReadStage), smartToolsHTTP
        case trafficIO(ReadStage), trafficHTTP

        // Keep the former response/peer/deadline retry policy. Malformed JSON
        // and HTTP were not retried before these diagnostics were introduced.
        var allowsStartupRetry: Bool {
            switch self {
            case .peer, .response, .deadline, .field, .io: return true
            default: return false
            }
        }
        var diagnosticCode: String {
            switch self {
            case .invalid: return "readiness.invalid"
            case .resource: return "readiness.resource"
            case .response: return "readiness.response"
            case .deadline: return "readiness.deadline"
            case .peer: return "readiness.peer"
            case .field(let field): return "readiness.field." + field.rawValue
            case .io(let endpoint, let stage): return "readiness.io." + endpoint.rawValue + "." + stage.rawValue
            case .json(let endpoint): return "readiness.json." + endpoint.rawValue
            case .http(let endpoint): return "readiness.http." + endpoint.rawValue
            case .rulesIO(let stage): return "rules.io." + stage.rawValue
            case .rulesJSON: return "rules.json"
            case .rulesHTTP: return "rules.http"
            case .resourcesIO(let stage): return "resources.io." + stage.rawValue
            case .resourcesJSON: return "resources.json"
            case .resourcesHTTP: return "resources.http"
            case .resourceStatus(let status): return "resources.status." + status
            case .providersIO(let stage): return "providers.io." + stage.rawValue
            case .providersHTTP: return "providers.http"
            case .smartToolsIO(let stage): return "smart-tools.io." + stage.rawValue
            case .smartToolsHTTP: return "smart-tools.http"
            case .trafficIO(let stage): return "traffic.io." + stage.rawValue
            case .trafficHTTP: return "traffic.http"
            }
        }
    }
    let binding: RelayTunCoreHost.Binding
    private let configuration: Data
    private let expected: [String: Any]
    private let tun: [String: Any]
    private let mtu: Int
    private let authorization: String?

    init(binding: RelayTunCoreHost.Binding, configuration: Data, managedMTU: Int) throws {
        guard !configuration.isEmpty, configuration.count <= 2 * 1024 * 1024,
              RelayTunHelperTrust.digest(configuration) == binding.receipt.runtimeConfigurationSHA256 else { throw Failure.invalid }
        let value = try RelayTunStrictJSON.object(configuration, limit: 2 * 1024 * 1024)
        guard let tun = value["tun"] as? [String: Any],
              Self.boolean(tun["enable"]) == true, Self.integer(tun["file-descriptor"]) == 3,
              let device = tun["device"] as? String, device == "utun" || device == binding.receipt.interfaceName,
              let stack = tun["stack"] as? String, ["gvisor", "system", "mixed"].contains(stack.lowercased()),
              Self.boolean(tun["auto-route"]) != nil, Self.boolean(tun["auto-detect-interface"]) != nil,
              (576...65535).contains(managedMTU),
              ((tun["mtu"] == nil || Self.integer(tun["mtu"]) == 0) ? managedMTU == 9000 : Self.integer(tun["mtu"]) == managedMTU),
              let hijack = tun["dns-hijack"] as? [String], hijack.count <= 256 else { throw Failure.invalid }
        let secret = value["secret"] as? String
        guard value["secret"] == nil || secret != nil,
              secret == nil || (secret!.utf8.count <= 4096 && secret!.utf8.allSatisfy({ $0 >= 32 && $0 != 127 })) else { throw Failure.invalid }
        self.binding = binding; self.configuration = configuration; self.expected = value; self.tun = tun
        self.mtu = managedMTU; authorization = secret.flatMap { $0.isEmpty ? nil : $0 }
    }
    private static func integer(_ raw: Any?) -> Int? { RelayTunStrictJSON.integer(raw) }
    private static func boolean(_ raw: Any?) -> Bool? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    private func validate(version: Data, configs: Data) throws {
        try Self.validate(expected: expected, tun: tun, mtu: mtu, descriptor: 3, version: version, configs: configs)
    }
    static func validateManaged(configuration: Data, version: Data, configs: Data, resources: Bool = false,
                                execution: RelayTunExecutionReceiptV2.CoreIdentity? = nil) throws {
        let expected = try RelayTunStrictJSON.object(configuration, limit: 2 * 1024 * 1024)
        guard let tun = expected["tun"] as? [String: Any], tun["file-descriptor"] == nil,
              boolean(tun["enable"]) == true else { throw Failure.invalid }
        let mtu = integer(tun["mtu"]) ?? 0
        try validate(expected: expected, tun: tun, mtu: mtu == 0 ? 9000 : mtu,
                     descriptor: 0, version: version, configs: configs, resources: resources, execution: execution)
    }
    /// Capture observes a supported live mode without weakening startup's
    /// strict expected-mode validation or its recovery behavior.
    static func validateManagedCapture(configuration: Data, version: Data, configs: Data, resources: Bool = false,
                                       execution: RelayTunExecutionReceiptV2.CoreIdentity? = nil) throws -> String {
        var expected = try RelayTunStrictJSON.object(configuration, limit: 2 * 1024 * 1024)
        let current = try RelayTunStrictJSON.object(configs, limit: RelayTunCoreProbePlan.responseLimit)
        guard let mode = current["mode"] as? String, ["rule", "global", "direct"].contains(mode),
              let tun = expected["tun"] as? [String: Any], tun["file-descriptor"] == nil,
              boolean(tun["enable"]) == true else { throw Failure.invalid }
        expected["mode"] = mode
        let mtu = integer(tun["mtu"]) ?? 0
        try validate(expected: expected, tun: tun, mtu: mtu == 0 ? 9000 : mtu,
                     descriptor: 0, version: version, configs: configs, resources: resources, execution: execution)
        return mode
    }
    private static func validate(expected: [String: Any], tun: [String: Any], mtu: Int,
                                 descriptor: Int, version: Data, configs: Data, resources: Bool = false,
                                 execution: RelayTunExecutionReceiptV2.CoreIdentity? = nil) throws {
        if let execution {
            guard descriptor == 0, RelayTunExecutionReceiptV2.corePins.contains(execution),
                  !resources || execution.profile == .localGeodata else { throw Failure.resource }
        }
        func object(_ bytes: Data, _ endpoint: Endpoint) throws -> [String: Any] {
            do { return try RelayTunStrictJSON.object(bytes, limit: RelayTunCoreProbePlan.responseLimit) }
            catch { throw Failure.json(endpoint) }
        }
        func require(_ condition: Bool, _ field: Field) throws {
            guard condition else { throw Failure.field(field) }
        }
        let reported = try object(version, .version), config = try object(configs, .configs)
        try require(reported["version"] as? String == (execution?.version ?? (resources ? resourceVersion : RelayTunCoreProbePlan.version)), .version)
        guard let actual = config["tun"] as? [String: Any] else { throw Failure.field(.tun) }
        try require(Self.boolean(actual["enable"]) == true, .enable)
        try require(Self.integer(actual["file-descriptor"] ?? 0) == descriptor, .descriptor)
        // v1.19.33 keeps the declared device in /configs when supplied
        // an FD. The actual interface is verified through the held FD.
        try require(actual["device"] as? String == tun["device"] as? String, .device)
        try require((actual["stack"] as? String)?.lowercased() == (tun["stack"] as? String)?.lowercased(), .stack)
        try require((tun["mtu"] == nil || Self.integer(tun["mtu"]) == 0) ?
            (actual["mtu"] == nil || Self.integer(actual["mtu"]) == 0) : Self.integer(actual["mtu"]) == mtu, .mtu)
        try require(Self.boolean(actual["auto-route"]) == Self.boolean(tun["auto-route"]), .autoRoute)
        try require(Self.boolean(actual["auto-detect-interface"]) == Self.boolean(tun["auto-detect-interface"]), .autoDetect)
        for field: Field in [.port, .socksPort, .mixedPort, .redirPort, .tproxyPort] {
            let key = field.rawValue
            guard let port = Self.integer(expected[key] ?? 0), (0...65535).contains(port),
                  Self.integer(config[key]) == port else { throw Failure.field(field) }
        }
        try require(config["mode"] as? String == (expected["mode"] as? String ?? "rule"), .mode)
        try require(Self.boolean(config["allow-lan"]) == Self.boolean(expected["allow-lan"] ?? false), .allowLAN)
        try require(Self.boolean(config["ipv6"]) == Self.boolean(expected["ipv6"] ?? true), .ipv6)
        for field: Field in [.autoRedirect, .gso, .recvmsgx, .sendmsgx] {
            let key = String(field.rawValue.dropFirst(4))
            let intended = Self.boolean(tun[key] ?? (key == "recvmsgx"))
            guard intended != nil,
                  Self.boolean(actual[key] ?? false) == intended else { throw Failure.field(field) }
        }
        let hijack = actual["dns-hijack"] is NSNull ? [] : actual["dns-hijack"] as? [String]
        try require(hijack == tun["dns-hijack"] as? [String], .dnsHijack)
        // The pinned core serializes the declared option, not sing-tun's
        // effective Darwin default. Omitted dns-mode remains "" in /configs.
        guard let intendedDNSMode = (tun["dns-mode"] ?? "") as? String,
              let actualDNSMode = actual["dns-mode"] as? String,
              actualDNSMode == intendedDNSMode else { throw Failure.field(.dnsMode) }
    }
    /// All closures capture held capabilities. verify checks the resource,
    /// source file, admitted FD, current consent and child's continued life;
    /// read must authenticate the socket peer before sending any secret.
    func observe(read: (String) throws -> Data, verify: () throws -> Void) throws -> RelayTunCoreHost.RuntimeObservation {
        try verify()
        let version = try read("version")
        try verify()
        let configs = try read("configs")
        try validate(version: version, configs: configs)
        try verify()
        return .init(binding: binding, runtimeConfigurationSHA256: binding.receipt.runtimeConfigurationSHA256,
                     coreVersion: RelayTunCoreProbePlan.version, inheritedDescriptor: 3)
    }

    func live(directory: String, verifyPeer: @escaping (Int32) throws -> Void) throws -> Live {
        try Live(directory: directory, configuration: configuration, authorization: authorization,
                 verifyPeer: verifyPeer)
    }

    /// Only the fixed rules reader opts into a larger node budget. The old
    /// request/readiness scanner defaults and all raw byte limits stay intact.
    static func rulesSnapshot(_ bytes: Data) throws -> RelayTunRuntimeRules.Snapshot {
        do {
            let raw = try RelayTunStrictJSON.object(bytes, limit: RelayTunRuntimeRules.tableLimit, maxNodes: 200000)
            guard Set(raw.keys) == ["rules"], let rules = raw["rules"] as? [Any] else { throw Failure.rulesJSON }
            return try .init(rules)
        } catch { throw Failure.rulesJSON }
    }

    /// Same deliberately small EOF/Content-Length HTTP policy as the existing
    /// readiness parser, with rules-only bounds and an empty 204 variant.
    private static func rulesHTTPBody(_ bytes: Data, mutation: Bool) throws -> Data {
        let limit = mutation ? 0 : RelayTunRuntimeRules.tableLimit
        return try boundedHTTPBody(bytes, limit: limit, statusCodes: [mutation ? "204" : "200"], empty: mutation)
    }
    private static func boundedHTTPBody(_ bytes: Data, limit: Int, statusCodes: Set<String>, empty: Bool) throws -> Data {
        guard bytes.count <= RelayTunCoreProbePlan.headerLimit + 4 + limit,
              let boundary = bytes.range(of: Data([13, 10, 13, 10])),
              boundary.lowerBound <= RelayTunCoreProbePlan.headerLimit,
              let header = String(data: bytes[..<boundary.lowerBound], encoding: .ascii) else { throw Failure.rulesHTTP }
        let lines = header.components(separatedBy: "\r\n")
        guard let status = lines.first else { throw Failure.rulesHTTP }
        let pieces = status.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
        guard pieces.count == 3, ["HTTP/1.0", "HTTP/1.1"].contains(String(pieces[0])),
              statusCodes.contains(String(pieces[1])) else { throw Failure.rulesHTTP }
        var length: Int?
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex,
                  line[..<colon].utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || $0 == 45 }) else { throw Failure.rulesHTTP }
            let key = line[..<colon].lowercased(), value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard value.utf8.allSatisfy({ (32...126).contains($0) || $0 == 9 }), key != "transfer-encoding" else { throw Failure.rulesHTTP }
            if key == "content-length" {
                guard length == nil, let count = Int(value), String(count) == value,
                      count >= 0, count <= limit else { throw Failure.rulesHTTP }
                length = count
            }
        }
        let body = Data(bytes[boundary.upperBound...])
        guard body.count <= limit, length == nil || length == body.count,
              empty ? body.isEmpty : !body.isEmpty else { throw Failure.rulesHTTP }
        return body
    }

    struct ResourceState {
        struct Row {
            let kind: RelayTunRuntimeResources.Kind, sha256: String, bytes: Int, active: Bool
        }
        let bootId: String, generationSHA256: String, sequence: UInt64, resources: [Row]
    }
    private static func resourceObject(_ bytes: Data) throws -> [String: Any] {
        do {
            let raw = try RelayTunStrictJSON.object(bytes, limit: 8192)
            guard integer(raw["version"]) == 1 else { throw Failure.resourcesJSON }
            if let status = raw["status"] as? String, !["prepared", "applied"].contains(status) {
                guard Set(raw.keys) == ["version", "status"],
                      ["busy", "stale", "unsupported", "cancelled", "uncertain"].contains(status) else { throw Failure.resourcesJSON }
                throw Failure.resourceStatus(status)
            }
            return raw
        } catch let error as Failure { throw error }
        catch { throw Failure.resourcesJSON }
    }
    private static func resourceSequence(_ value: Any?) throws -> UInt64 {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991 else { throw Failure.resourcesJSON }
        return UInt64(number.doubleValue)
    }
    static func resourceState(_ bytes: Data) throws -> ResourceState {
        let raw = try resourceObject(bytes)
        guard Set(raw.keys) == ["version", "capability", "bootId", "sequence", "generationSHA256", "resources"],
              raw["capability"] as? String == "local-geodata-v1",
              let boot = raw["bootId"] as? String, RelayTunRuntimeResources.uuid(boot),
              let head = raw["generationSHA256"] as? String, RelayTunRuntimeResources.hash(head),
              let rows = raw["resources"] as? [[String: Any]], rows.count <= 4 else { throw Failure.resourcesJSON }
        var kinds = Set<RelayTunRuntimeResources.Kind>(), resources = [ResourceState.Row](), total = 0
        for row in rows {
            guard Set(row.keys) == ["kind", "sha256", "bytes", "active"],
                  let name = row["kind"] as? String, let kind = RelayTunRuntimeResources.Kind(rawValue: name), kinds.insert(kind).inserted,
                  let sha = row["sha256"] as? String, RelayTunRuntimeResources.hash(sha),
                  let size = integer(row["bytes"]), size > 0, size <= RelayTunRuntimeResources.maximumBytes,
                  let active = boolean(row["active"]) else { throw Failure.resourcesJSON }
            total += size; guard total <= RelayTunRuntimeResources.maximumTotalBytes else { throw Failure.resourcesJSON }
            resources.append(.init(kind: kind, sha256: sha, bytes: size, active: active))
        }
        return try .init(bootId: boot, generationSHA256: head, sequence: resourceSequence(raw["sequence"]), resources: resources)
    }
    private static func resourcePrepared(_ bytes: Data) throws -> RelayTunRuntimeResources.Prepared {
        let raw = try resourceObject(bytes)
        guard Set(raw.keys) == ["version", "status", "bootId", "kind", "nonce", "oldSHA256", "newSHA256", "bytes", "sequence", "previousGenerationSHA256", "remainingMS"],
              raw["status"] as? String == "prepared", let boot = raw["bootId"] as? String, RelayTunRuntimeResources.uuid(boot),
              let name = raw["kind"] as? String, let kind = RelayTunRuntimeResources.Kind(rawValue: name),
              let nonce = raw["nonce"] as? String, RelayTunRuntimeResources.hash(nonce),
              let old = raw["oldSHA256"] as? String, RelayTunRuntimeResources.hash(old),
              let new = raw["newSHA256"] as? String, RelayTunRuntimeResources.hash(new),
              let head = raw["previousGenerationSHA256"] as? String, RelayTunRuntimeResources.hash(head),
              let count = integer(raw["bytes"]), count > 0, count <= RelayTunRuntimeResources.maximumBytes,
              let remaining = integer(raw["remainingMS"]), remaining > 0, remaining <= 120000 else { throw Failure.resourcesJSON }
        return try .init(nonce: nonce, bootId: boot, kind: kind, oldSHA256: old, newSHA256: new,
            previousGenerationSHA256: head, sequence: resourceSequence(raw["sequence"]), bytes: count, remainingMilliseconds: remaining)
    }
    private static func resourceReceipt(_ bytes: Data) throws -> RelayTunRuntimeResources.Receipt {
        let raw = try resourceObject(bytes)
        guard Set(raw.keys) == ["version", "status", "bootId", "kind", "oldSHA256", "newSHA256", "bytes", "sequence", "previousGenerationSHA256", "generationSHA256", "retainedOriginal"],
              raw["status"] as? String == "applied", let boot = raw["bootId"] as? String, RelayTunRuntimeResources.uuid(boot),
              let name = raw["kind"] as? String, let kind = RelayTunRuntimeResources.Kind(rawValue: name),
              let old = raw["oldSHA256"] as? String, RelayTunRuntimeResources.hash(old),
              let new = raw["newSHA256"] as? String, RelayTunRuntimeResources.hash(new),
              let parent = raw["previousGenerationSHA256"] as? String, RelayTunRuntimeResources.hash(parent),
              let head = raw["generationSHA256"] as? String, RelayTunRuntimeResources.hash(head),
              let count = integer(raw["bytes"]), count > 0, count <= RelayTunRuntimeResources.maximumBytes,
              boolean(raw["retainedOriginal"]) == true else { throw Failure.resourcesJSON }
        return try .init(bootId: boot, kind: kind, oldSHA256: old, newSHA256: new, bytes: count,
            previousGenerationSHA256: parent, generationSHA256: head, sequence: resourceSequence(raw["sequence"]), retainedOriginal: true)
    }

    /// Ordinary-UID Unix IPC to the positively held child. Rules use separate
    /// fixed methods; no TCP fallback, arbitrary endpoint, reload or lifecycle
    /// action is accepted by this reader.
    /// RFC3986 single segment, including slash/percent/query/fragment and
    /// every UTF8 byte. Fixed Chi RawPath + getEscapeParam unescapes once.
    static func providerPath(_ name: String) throws -> String {
        guard !name.isEmpty, name.utf8.count <= 256,
              name == name.trimmingCharacters(in: .whitespacesAndNewlines), !name.contains(","),
              name.unicodeScalars.allSatisfy({ $0.value >= 32 && !(127...159).contains($0.value) }) else { throw Failure.invalid }
        // Encoding unreserved bytes as well deliberately preserves RawPath
        // through the fixed net/http + Chi path. Otherwise literal "%2F"
        // can reach getEscapeParam already decoded once and become "/".
        let segment = name.utf8.map { String(format: "%%%02X", $0) }.joined()
        return "/providers/rules/" + segment
    }
    struct TrafficFirstFrameCollector {
        enum Failure: String, Error {
            case rulesHTTP, chunkLimit, headerLimit, frameLimit, incomplete, terminal
        }
        static let readChunkLimit = 4096
        static let frameLimit = 4096 // Includes the terminating LF on the wire.
        private var headers = Data()
        private var frame = Data()
        private var hasHeaders = false
        private var terminal = false
        private var completed = false

        // Returns the first body line excluding LF. A preceding CR is preserved.
        // Any later bytes in this same bounded read are intentionally discarded.
        // After success or failure, another append is rejected.
        mutating func append(_ chunk: Data) throws -> Data? {
            guard !terminal else { throw Failure.terminal }
            do {
                guard chunk.count <= Self.readChunkLimit else { throw Failure.chunkLimit }
                for byte in chunk {
                    if !hasHeaders {
                        headers.append(byte)
                        guard headers.count <= RelayTunCoreProbePlan.headerLimit + 4 else { throw Failure.headerLimit }
                        if headers.count >= 4 && headers.suffix(4).elementsEqual([13, 10, 13, 10]) {
                            // Keep the copied HTTP policy intact; refuse control bytes
                            // in the first status line before applying that policy.
                            guard let statusEnd = headers.range(of: Data([13, 10])),
                                  headers[..<statusEnd.lowerBound].allSatisfy({ (32...126).contains($0) || $0 == 9 }) else { throw Failure.rulesHTTP }
                            hasHeaders = true
                        }
                    } else {
                        guard frame.count < Self.frameLimit else { throw Failure.frameLimit }
                        frame.append(byte)
                        if byte == 10 {
                            let body: Data
                            do { body = try RelayTunCoreReadiness.boundedHTTPBody(headers + frame, limit: Self.frameLimit, statusCodes: ["200"], empty: false) }
                            catch { throw Failure.rulesHTTP }
                            completed = true
                            terminal = true
                            return Data(body.dropLast())
                        }
                    }
                }
                return nil
            } catch {
                terminal = true
                throw error
            }
        }

        // EOF is never a frame delimiter. Completed collectors may be closed;
        // incomplete headers/body are rejected and become permanently terminal.
        mutating func eof() throws {
            if terminal {
                guard completed else { throw Failure.terminal }
                return
            }
            terminal = true
            throw Failure.incomplete
        }

    }
    struct TrafficSourceSnapshot {
        fileprivate let configuration: stat
        fileprivate let socket: stat
    }
    final class Live {
        private let directory: String
        private let configuration: Data
        private let authorization: String?
        private let verifyPeer: (Int32) throws -> Void
        private let socketUID: uid_t
        private let identity: stat
        private var socketIdentity: stat?
        private let lock = NSLock()
        private static func canonical(_ path: String) -> Bool {
            guard !path.contains("\0"), let physical = realpath(path, nil) else { return false }
            defer { free(physical) }
            return String(cString: physical) == path
        }
        init(directory: String, configuration: Data, authorization: String?,
             verifyPeer: @escaping (Int32) throws -> Void, socketUID: uid_t = getuid()) throws {
            guard getuid() > 0, geteuid() == getuid(), getgid() == getegid(),
                  socketUID == 0 || socketUID == getuid(),
                  authorization == nil || (authorization!.utf8.count <= 4096 && authorization!.utf8.allSatisfy { $0 >= 32 && $0 != 127 }),
                  directory.hasPrefix("/"), Self.canonical(directory),
                  (directory + "/api.sock").utf8.count < 100 else { throw Failure.resource }
            self.directory = directory; self.configuration = configuration; self.authorization = authorization
            self.verifyPeer = verifyPeer; self.socketUID = socketUID
            var info = stat()
            guard lstat(directory, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else { throw Failure.resource }
            identity = info
            try verifySource()
        }
        private init(delegating original: Live, registeredSocket: stat) {
            directory = original.directory; configuration = original.configuration
            authorization = original.authorization; verifyPeer = original.verifyPeer
            socketUID = original.socketUID; identity = original.identity
            socketIdentity = registeredSocket
        }
        /// An independent IO lock over already authenticated directory/socket
        /// facts. No new pathname observation grants registration authority.
        func delegatedSmartToolsReader() throws -> Live {
            guard lock.try() else { throw Failure.smartToolsIO(.busy) }; defer { lock.unlock() }
            guard let socketIdentity else { throw Failure.peer }
            return Live(delegating: self, registeredSocket: socketIdentity)
        }
        /// Mint on the owner queue from the already authenticated reader.
        /// Bytes must still pass the worker's full check before any sample.
        func trafficSourceSnapshot() throws -> TrafficSourceSnapshot {
            guard lock.try() else { throw Failure.trafficIO(.busy) }; defer { lock.unlock() }
            guard let registered = socketIdentity else { throw Failure.peer }
            try checkedDirectory()
            var current = stat()
            guard lstat(directory + "/config.yaml", &current) == 0,
                  current.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), current.st_uid == getuid(),
                  current.st_mode & 0o7777 == 0o600, current.st_nlink == 1,
                  current.st_size == configuration.count else { throw Failure.resource }
            let snapshot = TrafficSourceSnapshot(configuration: current, socket: registered)
            try assertTrafficMetadata(snapshot); return snapshot
        }
        /// No Live.lock or mutable socketIdentity access and no body read.
        /// Existing same() includes inode/mode/size/nlink/mtime/ctime/UID.
        func assertTrafficMetadata(_ snapshot: TrafficSourceSnapshot) throws {
            try checkedDirectory()
            var file = stat(), socket = stat()
            guard lstat(directory + "/config.yaml", &file) == 0, Self.same(snapshot.configuration, file),
                  lstat(directory + "/api.sock", &socket) == 0, Self.same(snapshot.socket, socket),
                  socket.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK), socket.st_uid == socketUID,
                  socket.st_nlink == 1 else { throw Failure.peer }
        }
        /// Finite full checks bracket the body read with the immutable facts.
        func verifyTrafficSource(_ snapshot: TrafficSourceSnapshot) throws {
            try assertTrafficMetadata(snapshot); try verifySource(); try assertTrafficMetadata(snapshot)
        }
        func delegatedTrafficReader() throws -> Live {
            guard lock.try() else { throw Failure.trafficIO(.busy) }; defer { lock.unlock() }
            guard let socketIdentity else { throw Failure.peer }
            return Live(delegating: self, registeredSocket: socketIdentity)
        }
        private static func same(_ a: stat, _ b: stat) -> Bool {
            a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_mode == b.st_mode &&
                a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
                a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec &&
                a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
        }
        private func checkedDirectory() throws {
            guard getuid() > 0, geteuid() == getuid(), getgid() == getegid() else { throw Failure.resource }
            var cursor = URL(fileURLWithPath: directory)
            while cursor.path != "/" {
                var part = stat()
                guard lstat(cursor.path, &part) == 0, part.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else { throw Failure.resource }
                cursor.deleteLastPathComponent()
            }
            var info = stat()
            guard lstat(directory, &info) == 0, info.st_dev == identity.st_dev, info.st_ino == identity.st_ino,
                  info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else { throw Failure.resource }
        }
        func verifySource() throws {
            try checkedDirectory()
            let path = directory + "/config.yaml", fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw Failure.resource }; defer { Darwin.close(fd) }
            var before = stat(), after = stat(), linked = stat()
            guard fstat(fd, &before) == 0, before.st_uid == getuid(), before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  before.st_mode & 0o7777 == 0o600, before.st_nlink == 1, before.st_size == configuration.count else { throw Failure.resource }
            var bytes = Data(), buffer = [UInt8](repeating: 0, count: 65536)
            while true {
                let count = Darwin.read(fd, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                guard count >= 0 else { throw Failure.resource }
                if count == 0 { break }
                guard bytes.count + count <= configuration.count else { throw Failure.resource }
                bytes.append(contentsOf: buffer.prefix(count))
            }
            guard bytes == configuration, fstat(fd, &after) == 0, lstat(path, &linked) == 0,
                  Self.same(before, after), Self.same(before, linked) else { throw Failure.resource }
            try checkedDirectory()
        }
        /// Read-only fact already pinned after a successful authenticated exchange.
        /// No current-name lookup here can create socket registration authority.
        func registeredSocketSnapshot() throws -> stat {
            guard lock.try() else { throw Failure.peer }; defer { lock.unlock() }
            guard let socketIdentity else { throw Failure.peer }; return socketIdentity
        }
        func read(_ endpoint: String, before outerDeadline: UInt64? = nil) throws -> Data {
            guard let endpoint = Endpoint(rawValue: endpoint) else { throw Failure.response }
            guard lock.try() else { throw Failure.io(endpoint, .busy) }
            defer { lock.unlock() }
            return try exchange(.readiness(endpoint), before: outerDeadline, check: {})
        }
        func trafficReadiness(_ endpoint: Endpoint, before deadline: UInt64, check: () throws -> Void) throws -> Data {
            guard lock.try() else { throw Failure.trafficIO(.busy) }; defer { lock.unlock() }
            return try exchange(.readiness(endpoint), before: deadline, check: check)
        }
        func readTraffic(before deadline: UInt64, check: () throws -> Void) throws -> Data {
            guard lock.try() else { throw Failure.trafficIO(.busy) }; defer { lock.unlock() }
            return try exchange(.traffic, before: deadline, check: check)
        }
        /// Uses the same held peer and bearer as readiness. Only node presentation
        /// fields can leave the client; provider URLs and subscription metadata stay here.
        func proxyGroups(_ action: RelayTunRuntimeCapture.ProxyAction, before deadline: UInt64, check: () throws -> Void) throws -> Data {
            guard lock.try() else { throw Failure.trafficIO(.busy) }; defer { lock.unlock() }
            func rows(_ endpoint: Exchange, _ key: String) throws -> [String: Any] {
                let bytes = try exchange(endpoint, before: deadline, check: check)
                guard let document = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                      let table = document[key] as? [String: Any] else { throw Failure.invalid }
                return table
            }
            let table = try rows(.proxies, "proxies")
            func change(_ group: String, _ member: String?) throws {
                guard let row = table[group] as? [String: Any], let members = row["all"] as? [String],
                      let type = row["type"] as? String, ["Selector", "URLTest", "Fallback", "LoadBalance", "Smart"].contains(type),
                      member.map(members.contains) ?? (type != "Selector") else { throw Failure.invalid }
                _ = try exchange(.proxySelection(group, member), before: deadline, check: check)
                let after = try rows(.proxies, "proxies")
                guard let actual = after[group] as? [String: Any] else { throw Failure.invalid }
                if let member {
                    guard actual["now"] as? String == member || actual["fixed"] as? String == member else { throw Failure.invalid }
                } else if let fixed = actual["fixed"] as? String, !fixed.isEmpty { throw Failure.invalid }
            }
            switch action {
            case .select(let group, let member): try change(group, member); return Data("{}".utf8)
            case .automatic(let group): try change(group, nil); return Data("{}".utf8)
            case .list: break
            }
            // Clash Party resolves provider members absent from the top-level table.
            let missing = Set(table.values.compactMap { ($0 as? [String: Any])?["all"] as? [String] }.joined()).subtracting(table.keys)
            let providers = missing.isEmpty ? [:] : try rows(.proxyProviders, "providers")
            var output: [String: [String: Any]] = [:]
            func add(_ value: Any, provider: String? = nil) throws {
                guard let row = value as? [String: Any], let name = row["name"] as? String,
                      let type = row["type"] as? String, !name.isEmpty else { throw Failure.invalid }
                if provider != nil && !missing.contains(name) { return }
                var node: [String: Any] = ["name": name, "type": type, "history": [], "extra": [:]]
                for key in ["alive","tfo","udp","uot","xudp","mptcp","smux","hidden"] { if let flag = row[key] as? Bool { node[key] = flag } }
                for key in ["now","fixed","id","provider-name"] { if let text = row[key] as? String { node[key] = text } }
                if let all = row["all"] as? [String] { node["all"] = all }
                if let history = row["history"] as? [[String: Any]] { node["history"] = history.suffix(1).map { $0.filter { ["time","delay"].contains($0.key) } } }
                if node["provider-name"] == nil, let provider { node["provider-name"] = provider }
                output[name] = node
            }
            for value in table.values { try add(value) }
            for (provider, value) in providers {
                guard let record = value as? [String: Any] else { throw Failure.invalid }
                for value in record["proxies"] as? [Any] ?? [] { try add(value, provider: provider) }
            }
            try check()
            return try JSONSerialization.data(withJSONObject: output)
        }
        func readConnections(before deadline: UInt64, check: () throws -> Void) throws -> Data {
            guard lock.try() else { throw Failure.trafficIO(.busy) }; defer { lock.unlock() }
            let raw = try exchange(.connections, before: deadline, check: check)
            try check()
            return try RelayTunRuntimeCapture.connectionsSnapshot(raw)
        }
        func readRules(_ access: RelayTunRuntimeRules.Access) throws -> RelayTunRuntimeRules.Snapshot {
            guard lock.try() else { throw Failure.rulesIO(.busy) }; defer { lock.unlock() }
            let bytes = try exchange(.rules, before: access.deadline, check: access.check)
            let snapshot = try RelayTunCoreReadiness.rulesSnapshot(bytes)
            try access.check(); return snapshot
        }
        func patchRule(_ mutation: RelayTunRuntimeRules.Mutation, access: RelayTunRuntimeRules.Access,
                       verifyContext: () throws -> Void) throws -> RelayTunRuntimeRules.Snapshot {
            guard (0..<RelayTunRuntimeRules.maximumRules).contains(mutation.index),
                  RelayTunRuntimeRules.hash(mutation.expectedRulesSHA256) else { throw Failure.invalid }
            guard lock.try() else { throw Failure.rulesIO(.busy) }; defer { lock.unlock() }
            var expected: RelayTunRuntimeRules.Snapshot?
            _ = try exchange(.patch(mutation.index, mutation.disabled), before: access.deadline, check: access.check,
                prepareWrite: { fd, deadline in
                    // The PATCH stream is already connected and authenticated.
                    // A second fixed GET uses this same held Live lock; there
                    // is no generic/nested public request or unlocked adoption.
                    let bytes = try self.exchange(.rules, before: access.deadline, check: access.check)
                    try verifyContext(); try self.verifySource(); try self.verifyPeer(fd)
                    let previous = try RelayTunCoreReadiness.rulesSnapshot(bytes)
                    guard previous.sha256 == mutation.expectedRulesSHA256 else { throw RelayTunRuntimeRules.Failure.revoked }
                    expected = try previous.settingDisabled(index: mutation.index, value: mutation.disabled)
                    guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.deadline }
                    // No observer or await follows this admission. A failed
                    // first write attempt is conservatively an unknown write.
                    try access.enterWrite()
                })
            try verifyContext(); try access.check()
            let bytes = try exchange(.rules, before: access.deadline, check: access.check)
            let observed = try RelayTunCoreReadiness.rulesSnapshot(bytes)
            try verifyContext(); try access.check()
            guard observed.sha256 == expected?.sha256 else { throw Failure.rulesHTTP }
            return observed
        }
        /// No caller path or request body. Both the active Core and an inert
        /// complete candidate use this exact upstream File-provider route.
        func readRuleProviders(before deadline: UInt64, check: () throws -> Void) throws -> Data {
            guard lock.try() else { throw Failure.providersIO(.busy) }; defer { lock.unlock() }
            return try exchange(.providers, before: deadline, check: check)
        }
        /// File publication, not this PUT, is the active write boundary. The
        /// supplied final gate must finish owner/whole-file/source checks with
        /// a pure latch; exchange invokes no observer between it and write.
        func updateRuleProvider(name: String, before deadline: UInt64, check: () throws -> Void,
                                beforeDispatch: () throws -> Void) throws {
            _ = try RelayTunCoreReadiness.providerPath(name)
            guard lock.try() else { throw Failure.providersIO(.busy) }; defer { lock.unlock() }
            _ = try exchange(.providerUpdate(name), before: deadline, check: check, prepareWrite: { fd, _ in
                try self.verifySource(); try self.verifyPeer(fd); try beforeDispatch()
            })
        }
        /// The extended Core API has one fixed authenticated Unix endpoint.
        /// Its original total lease replaces the readiness-only 500ms slice;
        /// no request can renew the supplied monotonic deadline.
        func readResources(before deadline: UInt64, check: () throws -> Void) throws -> ResourceState {
            guard lock.try() else { throw Failure.resourcesIO(.busy) }; defer { lock.unlock() }
            let bytes = try resourceExchange(["version": 1, "action": "state"], before: deadline, check: check)
            let state = try RelayTunCoreReadiness.resourceState(bytes)
            try check(); return state
        }
        func prepareResource(_ selection: RelayTunRuntimeResources.Selection,
                             access: RelayTunRuntimeResources.Access) throws -> RelayTunRuntimeResources.Prepared {
            guard lock.try() else { throw Failure.resourcesIO(.busy) }; defer { lock.unlock() }
            try access.check()
            let time = DispatchTime.now().uptimeNanoseconds
            guard access.deadline > time else { throw Failure.deadline }
            let remaining = min(UInt64(120000), (access.deadline - time) / 1_000_000)
            guard remaining >= 1000 else { throw Failure.deadline }
            let bytes = try resourceExchange(["version": 1, "action": "prepare", "kind": selection.kind.rawValue,
                "oldSHA256": selection.oldSHA256, "newSHA256": selection.newSHA256,
                "expectedGenerationSHA256": selection.expectedGenerationSHA256, "blobId": selection.blobId,
                "selector": selection.selector, "leaseMS": remaining], before: access.deadline, check: access.check)
            let prepared = try RelayTunCoreReadiness.resourcePrepared(bytes)
            // The model keeps this nonce even if scope was lost while prepare
            // replied, so it can neutralize this exact ticket before settling.
            return prepared
        }
        func commitResource(_ prepared: RelayTunRuntimeResources.Prepared,
                            access: RelayTunRuntimeResources.Access) throws -> RelayTunRuntimeResources.Receipt {
            guard RelayTunRuntimeResources.hash(prepared.nonce) else { throw Failure.invalid }
            guard lock.try() else { throw Failure.resourcesIO(.busy) }; defer { lock.unlock() }
            let bytes = try resourceExchange(["version": 1, "action": "commit", "nonce": prepared.nonce],
                before: access.deadline, check: access.check, enter: access.enterWrite)
            let receipt = try RelayTunCoreReadiness.resourceReceipt(bytes)
            guard receipt.bootId == prepared.bootId, receipt.kind == prepared.kind,
                  receipt.oldSHA256 == prepared.oldSHA256, receipt.newSHA256 == prepared.newSHA256,
                  receipt.bytes == prepared.bytes, receipt.previousGenerationSHA256 == prepared.previousGenerationSHA256,
                  receipt.sequence == prepared.sequence + 1,
                  receipt.generationSHA256 != receipt.previousGenerationSHA256 else { throw Failure.resourcesJSON }
            try access.check(); return receipt
        }
        func cancelResource(_ prepared: RelayTunRuntimeResources.Prepared, before deadline: UInt64,
                            check: () throws -> Void) throws -> RelayTunRuntimeResources.Cancellation {
            guard RelayTunRuntimeResources.hash(prepared.nonce) else { throw Failure.invalid }
            guard lock.try() else { throw Failure.resourcesIO(.busy) }; defer { lock.unlock() }
            let bytes = try resourceExchange(["version": 1, "action": "cancel", "nonce": prepared.nonce], before: deadline, check: check)
            do { _ = try RelayTunCoreReadiness.resourceObject(bytes); throw Failure.resourcesJSON }
            catch Failure.resourceStatus("cancelled") { return .cancelled }
            catch Failure.resourceStatus("uncertain") { return .uncertain }
        }
        private func resourceExchange(_ value: [String: Any], before deadline: UInt64,
                                      check: () throws -> Void, enter: () throws -> Void = {}) throws -> Data {
            let body = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
            guard body.count <= 4096 else { throw Failure.resourcesJSON }
            return try exchange(.resources(body), before: deadline, check: check,
                                prepareWrite: { _, _ in try enter() })
        }
        func smartWeights(before deadline: UInt64, check: () throws -> Void) throws -> Data {
            guard lock.try() else { throw Failure.smartToolsIO(.busy) }; defer { lock.unlock() }
            return try exchange(.smartWeights, before: deadline, check: check)
        }
        func clearSmartCache(before deadline: UInt64, check: () throws -> Void,
                             enterWrite: () throws -> Void) throws {
            guard lock.try() else { throw Failure.smartToolsIO(.busy) }; defer { lock.unlock() }
            _ = try exchange(.smartClear, before: deadline, check: check, prepareWrite: { _, _ in try enterWrite() })
        }
        private enum Exchange {
            case proxies, proxyProviders, proxySelection(String, String?)
            case readiness(Endpoint), rules, patch(Int, Bool), resources(Data), providers, providerUpdate(String), smartWeights, smartClear, traffic, connections
            var bodyLimit: Int {
                switch self {
                case .readiness: return RelayTunCoreProbePlan.responseLimit
                case .rules: return RelayTunRuntimeRules.tableLimit
                case .patch: return 0
                case .resources: return 8192
                case .proxies, .proxyProviders: return 8 * 1024 * 1024
                case .proxySelection: return 0
                case .providers: return 2 * 1024 * 1024
                case .providerUpdate, .smartClear: return 0
                case .smartWeights: return RelayTunSmartTools.payloadLimit
                case .connections: return RelayTunRuntimeCapture.bodyLimit
                case .traffic: return 4096
                }
            }
            func failure(_ stage: ReadStage) -> Failure {
                if case .readiness(let endpoint) = self { return .io(endpoint, stage) }
                if case .resources = self { return .resourcesIO(stage) }
                if case .providers = self { return .providersIO(stage) }
                if case .providerUpdate = self { return .providersIO(stage) }
                if case .smartWeights = self { return .smartToolsIO(stage) }
                if case .smartClear = self { return .smartToolsIO(stage) }
                if case .traffic = self { return .trafficIO(stage) }
                if case .connections = self { return .trafficIO(stage) }
                return .rulesIO(stage)
            }
            func request(_ bearer: String) throws -> Data {
                let method: String, path: String, body: Data
                switch self {
                case .readiness(let endpoint): method = "GET"; path = "/" + endpoint.rawValue; body = Data()
                case .rules: method = "GET"; path = "/rules"; body = Data()
                case .patch(let index, let disabled):
                    method = "PATCH"; path = "/rules/disable"
                    body = try JSONSerialization.data(withJSONObject: [String(index): disabled], options: [.sortedKeys])
                case .resources(let value): method = "POST"; path = "/relay/geodata/v1"; body = value
                case .proxies: method = "GET"; path = "/proxies"; body = Data()
                case .proxyProviders: method = "GET"; path = "/providers/proxies"; body = Data()
                case .proxySelection(let name, let member):
                    guard RelayTunRuntimeCapture.ProxyAction.name(name) != nil else { throw Failure.invalid }
                    path = "/proxies/" + name.utf8.map { String(format: "%%%02X", $0) }.joined()
                    if let member {
                        method = "PUT"; body = try JSONSerialization.data(withJSONObject: ["name": member])
                    } else { method = "DELETE"; body = Data() }
                case .providers: method = "GET"; path = "/providers/rules"; body = Data()
                case .providerUpdate(let name): method = "PUT"; path = try RelayTunCoreReadiness.providerPath(name); body = Data()
                case .smartWeights: method = "GET"; path = "/group/weights"; body = Data()
                case .smartClear: method = "POST"; path = "/cache/smart/flush"; body = Data()
                case .traffic: method = "GET"; path = "/traffic"; body = Data()
                case .connections: method = "GET"; path = "/connections"; body = Data()
                }
                let content = body.isEmpty ? "" : "Content-Type: application/json\r\nContent-Length: \(body.count)\r\n"
                var bytes = Data("\(method) \(path) HTTP/1.0\r\nHost: localhost\r\n\(bearer)\(content)Connection: close\r\n\r\n".utf8)
                bytes.append(body); return bytes
            }
            func body(_ bytes: Data) throws -> Data {
                if case .proxySelection = self {
                    return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: 0, statusCodes: ["204"], empty: true)
                }
                if case .proxies = self { return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: bodyLimit, statusCodes: ["200"], empty: false) }
                if case .proxyProviders = self { return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: bodyLimit, statusCodes: ["200"], empty: false) }
                if case .connections = self {
                    do { return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: bodyLimit, statusCodes: ["200"], empty: false) }
                    catch { throw Failure.trafficHTTP }
                }
                if case .traffic = self { throw Failure.trafficHTTP } // First-frame collector handles this fixed path.
                if case .readiness(let endpoint) = self {
                    do { return try RelayTunCoreProbePlan.httpBody(bytes) }
                    catch { throw Failure.http(endpoint) }
                }
                if case .patch = self { return try RelayTunCoreReadiness.rulesHTTPBody(bytes, mutation: true) }
                if case .resources = self {
                    do { return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: 8192, statusCodes: ["200", "409"], empty: false) }
                    catch { throw Failure.resourcesHTTP }
                }
                if case .providers = self {
                    do { return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: bodyLimit, statusCodes: ["200"], empty: false) }
                    catch { throw Failure.providersHTTP }
                }
                if case .providerUpdate = self {
                    do { return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: 0, statusCodes: ["204"], empty: true) }
                    catch { throw Failure.providersHTTP }
                }
                if case .smartWeights = self {
                    do { return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: bodyLimit, statusCodes: ["200"], empty: false) }
                    catch { throw Failure.smartToolsHTTP }
                }
                if case .smartClear = self {
                    do { return try RelayTunCoreReadiness.boundedHTTPBody(bytes, limit: 0, statusCodes: ["204"], empty: true) }
                    catch { throw Failure.smartToolsHTTP }
                }
                return try RelayTunCoreReadiness.rulesHTTPBody(bytes, mutation: false)
            }
        }
        /// Caller owns Live.lock. Only the fixed PATCH path can supply an
        /// admission callback; it is called directly before the first syscall.
        private func exchange(_ exchange: Exchange, before outerDeadline: UInt64?, check: () throws -> Void,
                              prepareWrite: (Int32, UInt64) throws -> Void = { _, _ in }) throws -> Data {
            if let outerDeadline, DispatchTime.now().uptimeNanoseconds >= outerDeadline { throw Failure.deadline }
            try check(); try verifySource(); try check()
            let path = directory + "/api.sock"; var before = stat()
            guard lstat(path, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
                  before.st_uid == socketUID, before.st_nlink == 1 else { throw Failure.peer }
            if let previous = socketIdentity {
                guard previous.st_dev == before.st_dev, previous.st_ino == before.st_ino else { throw Failure.peer }
            }
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw exchange.failure(.socket) }
            var requestOpen = true
            defer { if requestOpen { Darwin.close(fd) } }
            var noSignal: Int32 = 1
            guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0, fcntl(fd, F_SETFL, O_NONBLOCK) == 0,
                  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw exchange.failure(.options) }
            var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8CString.map { UInt8(bitPattern: $0) }) }
            let deadline: UInt64
            switch exchange {
            case .resources, .providers, .providerUpdate, .proxies, .proxyProviders, .proxySelection:
                guard let outerDeadline else { throw Failure.deadline }; deadline = outerDeadline
            case .traffic, .connections:
                guard let outerDeadline else { throw Failure.deadline }
                deadline = min(DispatchTime.now().uptimeNanoseconds + 2_500_000_000, outerDeadline)
            case .smartWeights, .smartClear:
                guard let outerDeadline else { throw Failure.deadline }
                deadline = min(DispatchTime.now().uptimeNanoseconds + 1_500_000_000, outerDeadline)
            default: deadline = min(DispatchTime.now().uptimeNanoseconds + 500_000_000, outerDeadline ?? UInt64.max)
            }
            guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.deadline }
            func wait(_ event: Int16) throws {
                while DispatchTime.now().uptimeNanoseconds < deadline {
                    try check()
                    var item = pollfd(fd: fd, events: event, revents: 0)
                    let result = poll(&item, 1, 10)
                    try check()
                    guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.deadline }
                    if result < 0 && errno == EINTR { continue }
                    guard result >= 0, item.revents & Int16(POLLERR | POLLNVAL) == 0 else { throw exchange.failure(.poll) }
                    if item.revents & (event | Int16(POLLHUP)) != 0 { return }
                }
                throw Failure.deadline
            }
            try check()
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            if connected != 0 {
                guard errno == EINPROGRESS || errno == EAGAIN else { throw Failure.peer }
                try wait(Int16(POLLOUT))
                var problem: Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
                guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &problem, &length) == 0, problem == 0 else { throw Failure.peer }
            }
            // This gate must be derived from the held spawned child, not the
            // pathname's owner alone. Authenticate before writing credentials.
            try check(); try verifyPeer(fd); try check()
            let bearer = authorization.map { "Authorization: Bearer \($0)\r\n" } ?? ""
            let request = try exchange.request(bearer)
            try request.withUnsafeBytes { raw in
                var sent = 0, attempted = false
                while sent < raw.count {
                    guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.deadline }
                    try check()
                    if !attempted { attempted = true; try prepareWrite(fd, deadline) }
                    let count = Darwin.write(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                    if count < 0 && (errno == EAGAIN || errno == EINTR) { try wait(Int16(POLLOUT)); continue }
                    guard count > 0 else { throw exchange.failure(.write) }; sent += count
                }
            }
            var response = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            var traffic = TrafficFirstFrameCollector()
            while true {
                guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.deadline }
                try check()
                let count = Darwin.read(fd, &buffer, buffer.count)
                if count < 0 && (errno == EAGAIN || errno == EINTR) { try wait(Int16(POLLIN)); continue }
                guard count >= 0 else { throw exchange.failure(.receive) }
                if case .traffic = exchange {
                    guard count > 0 else { throw Failure.trafficHTTP }
                    let frame: Data?
                    do { frame = try traffic.append(Data(buffer.prefix(count))) }
                    catch { throw Failure.trafficHTTP }
                    if let frame {
                        try check()
                        guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure.deadline }
                        response = frame; response.append(10) // Preserve the original LF frame, no JSON reserialization.
                        requestOpen = false // Exactly one close attempt; never retry a potentially reused descriptor.
                        guard Darwin.close(fd) == 0 else { throw exchange.failure(.receive) }
                        try check(); break
                    }
                } else {
                    if count == 0 { break }
                    guard response.count + count <= RelayTunCoreProbePlan.headerLimit + 4 + exchange.bodyLimit else { throw exchange.failure(.limit) }
                    response.append(contentsOf: buffer.prefix(count))
                }
            }
            // The connected peer was authenticated before any request/secret.
            // Darwin drops LOCAL_PEERPID/LOCAL_PEEREPID at EOF (ENOTCONN).
            // This exclusively held stream cannot change peers; observe()
            // brackets the read with fresh held-child, FD and bundle checks.
            var after = stat()
            guard lstat(path, &after) == 0, Self.same(before, after) else { throw Failure.peer }
            try check(); try verifySource(); try check(); socketIdentity = before
            if case .traffic = exchange { return response }
            return try exchange.body(response)
        }
    }
}
