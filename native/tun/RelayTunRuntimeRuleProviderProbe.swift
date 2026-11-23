import Foundation
import CoreFoundation
import Darwin

/// Whole-candidate projection and actual acceptance receipt. Private Native
/// API only; no YAML/MRS decoder and no inferred Core in-memory body digest.
/// The IO driver must run a same-pin ordinary-UID inert child, PUT every alias,
/// then GET its reported counts. A parser-only -t or metadata/header cannot
/// construct a successful acceptance receipt.
enum RelayTunRuntimeRuleProviderProbe {
    typealias Model = RelayTunRuntimeRuleProviders
    enum Failure: Error { case invalid, changed, unsupported, incomplete, busy }
    static let coreVersion = "relay-geodata-v1p1-3f27"
    static var corePin: (sha256: String, bytes: Int) {
        #if arch(arm64)
        return ("a7dcd3ffe59be033ed1b4000a4ae90acdf2ab41450536e02445692ea124195c2", 79861968)
        #else
        return ("bd9f2b38256b05b643f6a33273669b4df2c2b32b5a25db0b8db41a0a0199bc3b", 85466544)
        #endif
    }
    static let maximumDeclaredRules = Model.maximumDeclaredRules
    struct Asset {
        let path: String, data: Data, sha256: String, identity: Model.FileIdentity
        init(path: String, data: Data, identity: Model.FileIdentity) throws {
            guard relative(path), data.count == identity.bytes else { throw Failure.invalid }
            self.path = path; self.data = data; sha256 = Model.Shared.digest(data); self.identity = identity
        }
    }
    struct Snapshot {
        let configuration: Data, assets: [Asset], context: Model.Context, group: [Model.Resource], expectedRuleCounts: [String: Int]
        init(configuration: Data, assets: [Asset], context: Model.Context, group: [Model.Resource], expectedRuleCounts: [String: Int]) throws {
            guard expectedRuleCounts.count <= 200, expectedRuleCounts.values.allSatisfy({ (0...maximumDeclaredRules).contains($0) }),
                  !configuration.isEmpty, configuration.count <= 2 * 1024 * 1024,
                  Model.Shared.digest(configuration) == context.owner.configurationRevision,
                  assets.count <= 2000, Set(assets.map { $0.path }).count == assets.count,
                  assets.reduce(0, { $0 + $1.data.count }) <= Model.maximumTotalBytes,
                  assets.allSatisfy({ $0.identity.ownerUID == context.owner.ordinaryUID }),
                  !group.isEmpty, group.count <= 200, group == group.sorted(by: { $0.binding.name < $1.binding.name }),
                  Set(group.map { $0.binding.name }).count == group.count, let first = group.first,
                  group.allSatisfy({ $0.registeredFile && $0.binding.originalPath == first.binding.originalPath && $0.binding.format == first.binding.format && $0.identity == first.identity && $0.fileSHA256 == first.fileSHA256 }),
                  let bound = assets.first(where: { $0.path == first.binding.originalPath }),
                  bound.sha256 == first.fileSHA256, bound.identity == first.identity else { throw Failure.invalid }
            self.configuration = configuration; self.assets = assets; self.context = context; self.group = group; self.expectedRuleCounts = expectedRuleCounts
        }
    }
    struct Projection {
        let configuration: Data, assets: [String: Data], configurationSHA256: String
        let sourceConfigurationSHA256: String, geoGenerationSHA256: String, coreSHA256: String, bodySHA256: String
        let bindings: [Model.Binding], declaredRuleCount: Int, expectedRuleCounts: [String: Int]
        /// Private secret, not part of any public/report DTO.
        let secret: String
    }
    struct Acceptance {
        let counts: [String: Int], coreSHA256: String, sourceConfigurationSHA256: String
        let geoGenerationSHA256: String, bodySHA256: String, projectedConfigurationSHA256: String
        fileprivate init(_ projection: Projection, counts: [String: Int]) {
            self.counts = counts; coreSHA256 = projection.coreSHA256; sourceConfigurationSHA256 = projection.sourceConfigurationSHA256
            geoGenerationSHA256 = projection.geoGenerationSHA256; bodySHA256 = projection.bodySHA256
            projectedConfigurationSHA256 = projection.configurationSHA256
        }
    }
    private static func relative(_ path: String) -> Bool {
        if Model.Shared.Kind.allCases.contains(where: { $0.basename == path }) { return true }
        let prefix = "relay-files/"
        guard path.hasPrefix(prefix), let dot = path.lastIndex(of: "."),
              ["yaml", "text", "mrs", "bin"].contains(String(path[path.index(after: dot)...])) else { return false }
        return Model.Shared.hash(String(path[path.index(path.startIndex, offsetBy: prefix.count)..<dot]))
    }
    private static func bool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }; return number.boolValue
    }
    static func project(_ snapshot: Snapshot, blob: Model.Blob, declaredRuleCount: Int) throws -> Projection {
        guard (1...maximumDeclaredRules).contains(declaredRuleCount), let first = snapshot.group.first,
              blob.format == first.binding.format, blob.identity.ownerUID == snapshot.context.owner.ordinaryUID else { throw Failure.invalid }
        var value = try RelayTunStrictJSON.object(snapshot.configuration, limit: 2 * 1024 * 1024)
        guard let definitions = value["rule-providers"] as? [String: Any], definitions.count <= 200, Set(definitions.keys) == Set(snapshot.expectedRuleCounts.keys) else { throw Failure.unsupported }
        let names = Set(snapshot.group.map { $0.binding.name })
        var matching = Set<String>()
        for (name, raw) in definitions {
            guard let item = raw as? [String: Any] else { throw Failure.invalid }
            if item["path"] as? String == first.binding.originalPath { matching.insert(name) }
        }
        guard matching == names else { throw Failure.changed }
        for row in snapshot.group {
            guard let item = definitions[row.binding.name] as? [String: Any],
                  Set(item.keys) == ["type", "behavior", "format", "path", "interval"], item["type"] as? String == "file",
                  item["behavior"] as? String == row.binding.behavior.rawValue, item["format"] as? String == row.binding.format.rawValue,
                  item["path"] as? String == row.binding.originalPath, RelayTunStrictJSON.integer(item["interval"]) == 0 else { throw Failure.changed }
        }
        // The existing binder turns acquired caches into inline providers.
        // Preserve their nodes/filter/override and all private referenced
        // assets, while suppressing only acquisition and health processes.
        if let raw = value["proxy-providers"] {
            guard let providers = raw as? [String: Any], providers.count <= 200 else { throw Failure.invalid }
            var inert = [String: Any]()
            let accepted: Set<String> = ["type", "path", "url", "proxy", "interval", "filter", "exclude-filter", "exclude-type", "dialer-proxy", "size-limit", "payload", "age-secret-key", "health-check", "override", "header"]
            for (name, raw) in providers {
                guard var item = raw as? [String: Any], Set(item.keys).isSubset(of: accepted), let type = item["type"] as? String else { throw Failure.unsupported }
                switch type {
                case "inline": guard let nodes = item["payload"] as? [[String: Any]], nodes.count <= 20000 else { throw Failure.invalid }
                case "file":
                    guard let path = item["path"] as? String, relative(path), path != first.binding.originalPath,
                          snapshot.assets.contains(where: { $0.path == path }) else { throw Failure.unsupported }
                default: throw Failure.unsupported
                }
                item["interval"] = 0; item["health-check"] = ["enable": false, "interval": 0, "lazy": true, "url": ""]
                for key in ["url", "proxy", "header"] { item.removeValue(forKey: key) }
                inert[name] = item
            }
            value["proxy-providers"] = inert
        }
        if let raw = value["proxy-groups"] {
            guard let groups = raw as? [[String: Any]], groups.count <= 1000 else { throw Failure.invalid }
            value["proxy-groups"] = try groups.map { raw -> [String: Any] in
                guard let type = raw["type"] as? String, ["select", "url-test", "fallback", "load-balance"].contains(type) else { throw Failure.unsupported }
                var item = raw
                // fixed outboundgroup/parser.go restores interval300 for
                // health groups at0. A selector keeps names/members/refs and
                // avoids that branch; original group settings stay in the
                // already-loaded source, never in this ephemeral checker.
                item["type"] = "select"; item["interval"] = 0; item["url"] = ""; item["lazy"] = true
                return item
            }
        }
        // Keep the complete checked proxy/group/rule/dependency content. Only
        // listener/network/lifecycle controls are projected to inert settings.
        for key in ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"] { value[key] = 0 }
        value["allow-lan"] = false; value["bind-address"] = "127.0.0.1"; value["mode"] = "rule"; value["log-level"] = "silent"; value["ipv6"] = false
        for key in ["external-controller", "external-controller-tls", "external-controller-unix", "external-ui", "external-ui-url", "external-doh-server", "interface-name"] { value[key] = "" }
        let secret = UUID().uuidString.lowercased() + UUID().uuidString.lowercased(); value["secret"] = secret
        value["tun"] = ["enable": false]; value["ntp"] = ["enable": false]; value["sniffer"] = ["enable": false]
        var dns = value["dns"] as? [String: Any] ?? [:]; dns["enable"] = false; value["dns"] = dns
        value["listeners"] = [Any](); value["tunnels"] = [Any](); value["find-process-mode"] = "off"
        value["profile"] = ["store-selected": false, "store-fake-ip": false]
        value["geo-auto-update"] = false; value["geo-update-interval"] = 0
        value["geox-url"] = ["geoip": "", "geosite": "", "mmdb": "", "asn": ""]
        var expectedRuleCounts = snapshot.expectedRuleCounts
        for name in names { expectedRuleCounts[name] = declaredRuleCount }
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= 2 * 1024 * 1024 else { throw Failure.invalid }
        var assets = Dictionary(uniqueKeysWithValues: snapshot.assets.map { ($0.path, $0.data) }); assets[first.binding.originalPath] = blob.data
        guard assets.values.reduce(0, { $0 + $1.count }) <= Model.maximumTotalBytes else { throw Failure.invalid }
        return .init(configuration: bytes, assets: assets, configurationSHA256: Model.Shared.digest(bytes),
                     sourceConfigurationSHA256: snapshot.context.owner.configurationRevision, geoGenerationSHA256: snapshot.context.geo.generationSHA256,
                     coreSHA256: snapshot.context.owner.coreSHA256, bodySHA256: Model.Shared.digest(blob.data),
                     bindings: snapshot.group.map { $0.binding }, declaredRuleCount: declaredRuleCount, expectedRuleCounts: expectedRuleCounts, secret: secret)
    }
    /// Called only after own held child supplied exact version+inert configs.
    static func validateReady(_ projection: Projection, version: Data, configs: Data) throws {
        let reported = try RelayTunStrictJSON.object(version), actual = try RelayTunStrictJSON.object(configs, limit: 65536)
        guard reported["version"] as? String == coreVersion,
              ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"].allSatisfy({ RelayTunStrictJSON.integer(actual[$0]) == 0 }),
              bool(actual["allow-lan"]) == false, bool(actual["ipv6"]) == false, actual["mode"] as? String == "rule",
              let tun = actual["tun"] as? [String: Any], bool(tun["enable"]) == false, tun["file-descriptor"] == nil || RelayTunStrictJSON.integer(tun["file-descriptor"]) == 0 else { throw Failure.changed }
    }
    /// Per-alias positive PUT ACKs AND independently decoded reported counts
    /// are both required. The scalar is a negative completeness constraint,
    /// not evidence of parser acceptance by itself (notably for MRS headers).
    static func accepted(_ projection: Projection, putAccepted: Set<String>, metadata: Data) throws -> Acceptance {
        let names = Set(projection.bindings.map { $0.name })
        guard putAccepted == names else { throw Failure.incomplete }
        let raw = try RelayTunStrictJSON.object(metadata, limit: 2 * 1024 * 1024, maxNodes: 200000)
        guard Set(raw.keys) == ["providers"], let rows = raw["providers"] as? [String: Any], rows.count <= 200,
              Set(rows.keys) == Set(projection.expectedRuleCounts.keys) else { throw Failure.invalid }
        let behaviors: [Model.Behavior: String] = [.domain: "Domain", .ipcidr: "IPCIDR", .classical: "Classical"]
        let formats: [Model.Format: String] = [.yaml: "YamlRule", .text: "TextRule", .mrs: "MrsRule"]
        var counts = [String: Int]()
        for (name, expected) in projection.expectedRuleCounts {
            guard let row = rows[name] as? [String: Any], row["name"] as? String == name, row["type"] as? String == "Rule",
                  let count = RelayTunStrictJSON.integer(row["ruleCount"]), count == expected else { throw Failure.incomplete }
            counts[name] = count
        }
        for binding in projection.bindings {
            guard let row = rows[binding.name] as? [String: Any], Set(row.keys) == ["name", "behavior", "format", "ruleCount", "type", "vehicleType", "updatedAt"],
                  row["name"] as? String == binding.name, row["type"] as? String == "Rule", row["vehicleType"] as? String == "File",
                  row["behavior"] as? String == behaviors[binding.behavior], row["format"] as? String == formats[binding.format],
                  let count = RelayTunStrictJSON.integer(row["ruleCount"]), count == projection.declaredRuleCount,
                  let updated = row["updatedAt"] as? String, updated.utf8.count <= 64 else { throw Failure.incomplete }
            let date = ISO8601DateFormatter(); date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if date.date(from: updated) == nil { date.formatOptions = [.withInternetDateTime] }
            guard let parsed = date.date(from: updated), parsed.timeIntervalSince1970 > 0 else { throw Failure.incomplete }
            counts[binding.name] = count
        }
        return .init(projection, counts: counts)
    }
    /// Root creates this using its existing AppBundle private filesystem
    /// registry. Build returns the owned empty-root capability, then prepare
    /// writes material after Session has retained that capability. No path or
    /// executable crosses a renderer/API boundary.
    struct Workspace {
        let directory: String, configuration: Data, coreSHA256: String, coreBytes: Int
        let prepare: () throws -> Void
        let didSpawn: (RelayTunOwnedChild) -> Void
        /// Private pinned-file/held-child facts only, with bounded peer checks
        /// allowed after spawn. No mutable session/owner observer or await.
        let verify: () throws -> Void
        /// Known-only cleanup, called after the own probe child is reaped.
        let cleanup: () throws -> Void
        init(directory: String, configuration: Data, coreSHA256: String, coreBytes: Int,
             prepare: @escaping () throws -> Void, didSpawn: @escaping (RelayTunOwnedChild) -> Void = { _ in }, verify: @escaping () throws -> Void, cleanup: @escaping () throws -> Void) throws {
            let pin = corePin
            guard getuid() > 0, geteuid() == getuid(), getgid() == getegid(),
                  directory.hasPrefix("/private/tmp/relay-provider-probe-\(getuid())-"),
                  (directory + "/api.sock").utf8.count < 100,
                  directory.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 47, 95].contains($0) }),
                  coreSHA256 == pin.sha256, coreBytes == pin.bytes, !configuration.isEmpty, configuration.count <= 2 * 1024 * 1024 else { throw Failure.invalid }
            self.directory = directory; self.configuration = configuration; self.coreSHA256 = coreSHA256; self.coreBytes = coreBytes
            self.prepare = prepare; self.didSpawn = didSpawn; self.verify = verify; self.cleanup = cleanup
        }
    }
    /// Runs only on a dedicated worker. check is a pre-minted pure liveness/
    /// monotonic-deadline gate (Access.validateFence + channel Context), never
    /// an AppBundle/ManagedCore owner observer across queues. Fresh full owner
    /// and aggregate-budget validation happens back on the mutation queue.
    final class Session {
        private let projection: Projection, deadline: UInt64, check: () throws -> Void, buildWorkspace: (Projection) throws -> Workspace
        private let lock = NSLock()
        private var registered = false, started = false, running = false, settled = false
        private var workspace: Workspace?, child: RelayTunOwnedChild?
        init(projection: Projection, deadline: UInt64, check: @escaping () throws -> Void,
             buildWorkspace: @escaping (Projection) throws -> Workspace, register: (Session) -> Void) {
            self.projection = projection; self.deadline = deadline; self.check = check; self.buildWorkspace = buildWorkspace
            // No FS, process or callback-driven run is permitted before the
            // caller has kept a strong reference for unknown cleanup recovery.
            register(self); registered = true
        }
        var isSettled: Bool { lock.lock(); defer { lock.unlock() }; return settled }
        /// Process disposal and private evidence cleanup are separate facts.
        /// Short-circuit while work runs; all child writes precede the final
        /// running=false lock release. This never accepts a Workspace result.
        var isDrained: Bool { lock.lock(); defer { lock.unlock() }; return !running && child == nil }
        private func live() throws {
            try check(); guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Model.Failure.expired }
        }
        func perform() throws -> Acceptance {
            lock.lock(); guard registered, !started, !running, !settled else { lock.unlock(); throw Failure.busy }
            started = true; running = true; lock.unlock()
            defer { lock.lock(); running = false; lock.unlock() }
            var receipt: Acceptance?, original: Error?
            do { receipt = try run() } catch { original = error }
            let graceful: Bool
            do { graceful = try finishOwned() } catch { throw Model.Failure.registryUncertain }
            if let original { throw original }
            guard graceful else { throw Failure.changed }
            try live(); guard let receipt else { throw Failure.incomplete }; return receipt
        }
        private func run() throws -> Acceptance {
            try live(); let w = try buildWorkspace(projection); workspace = w
            guard w.configuration == projection.configuration, w.coreSHA256 == projection.coreSHA256 else { throw Failure.changed }
            try live(); try w.prepare(); try live(); try w.verify()
            let owned = try RelayTunOwnedChild.spawnProviderProbe(directory: w.directory, expectedCoreSHA256: w.coreSHA256, expectedCoreBytes: w.coreBytes,
                verify: { try self.live(); try w.verify() }, register: { self.child = $0; w.didSpawn($0) })
            let reader = try RelayTunCoreReadiness.Live(directory: w.directory, configuration: w.configuration, authorization: projection.secret,
                verifyPeer: { try owned.verifyPeer(socket: $0) })
            func verify() throws { try live(); try w.verify(); guard case .running = try owned.observe() else { throw Failure.changed } }
            let names = Set(projection.bindings.map { $0.name })
            // Only startup reads may be retried within the original deadline.
            // No PUT/acceptance/commit is ever retried on failure or unknown.
            while true {
                try verify()
                do {
                    try owned.whileRunning {
                        let version = try reader.read("version", before: deadline), config = try reader.read("configs", before: deadline)
                        try validateReady(projection, version: version, configs: config)
                        let bytes = try reader.readRuleProviders(before: deadline, check: verify)
                        let raw = try RelayTunStrictJSON.object(bytes, limit: 2 * 1024 * 1024, maxNodes: 200000)
                        guard let rows = raw["providers"] as? [String: Any], names.isSubset(of: Set(rows.keys)) else { throw Failure.incomplete }
                    }
                    break
                } catch let error as RelayTunCoreReadiness.Failure where error.allowsStartupRetry {
                    try verify(); usleep(10000)
                } catch Failure.incomplete { try verify(); usleep(10000) }
            }
            var accepted = Set<String>()
            for binding in projection.bindings {
                try verify()
                try owned.whileRunning {
                    try reader.updateRuleProvider(name: binding.name, before: deadline, check: verify, beforeDispatch: {
                        // Both callbacks are private pure facts/latches, not
                        // mutable owner observers. This is the last sync gate.
                        try self.live(); try w.verify(); try reader.verifySource(); try self.live()
                    })
                }
                accepted.insert(binding.name); try verify()
            }
            let metadata = try owned.whileRunning { try reader.readRuleProviders(before: deadline, check: verify) }
            let receipt = try RelayTunRuntimeRuleProviderProbe.accepted(projection, putAccepted: accepted, metadata: metadata)
            try verify(); return receipt
        }
        /// Called by perform, or later explicit recovery after a failed drain.
        /// It never signals the active Core; only this newly registered child.
        @discardableResult private func finishOwned() throws -> Bool {
            var badExit = false
            if let child {
                let stopped = try child.stop(); self.child = nil
                badExit = stopped.forced || stopped.waitStatus != 0
            }
            if let workspace { try workspace.cleanup(); self.workspace = nil }
            lock.lock(); settled = true; lock.unlock()
            return !badExit
        }
        func cleanup() throws {
            lock.lock(); guard !running else { lock.unlock(); throw Failure.busy }; running = true; lock.unlock()
            defer { lock.lock(); running = false; lock.unlock() }; _ = try finishOwned()
        }
    }

}
