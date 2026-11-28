// Exact execution-v2 receipt validation. The caller supplies an independently
// verified installation identity; a receipt alone cannot grant execution rights.
import Foundation
import CoreFoundation
import CryptoKit

enum RelayTunExecutionReceiptV2 {
    enum Failure: String, Error { case raw, schema, integer, expired, profile, configuration, asset, model, asn, budget }
    enum Architecture: String, CaseIterable { case arm64, x64 }
    enum Profile: String, CaseIterable { case stable, alpha, smart, localGeodata = "local-geodata-v1" }
    struct CoreIdentity: Equatable {
        let profile: Profile
        let architecture: Architecture
        let version: String
        let sha256: String
        let size: Int
    }
    struct ModelIdentity: Equatable { let version: String; let sha256: String; let size: Int }
    struct Asset {
        let path: String
        let data: Data
        let expectedRules: Int?
        init(path: String, data: Data, expectedRules: Int? = nil) {
            self.path = path; self.data = data; self.expectedRules = expectedRules
        }
    }
    struct AssetIdentity: Equatable { let path: String; let sha256: String; let size: Int; let expectedRules: Int? }
    struct Context {
        // A future held installation supplies this identity, not a renderer DTO.
        // This pure boundary still independently requires an exact compiled pin.
        let core: CoreIdentity
        let configuration: Data
        let assets: [Asset]
        let nowMS: Int64
    }
    struct Validated {
        let rawSHA256: String
        let snapshotSHA256: String
        let selectionSHA256: String
        let configurationSHA256: String
        let expiresAt: Int64
        let core: CoreIdentity
        let model: ModelIdentity?
        let assets: [AssetIdentity]
        let stateSeed: RelayTunSmartStateV1.Seed?
        private let raw: Data
        fileprivate init(raw: Data, rawSHA256: String, snapshotSHA256: String, selectionSHA256: String,
                         configurationSHA256: String, expiresAt: Int64, core: CoreIdentity,
                         model: ModelIdentity?, assets: [AssetIdentity], stateSeed: RelayTunSmartStateV1.Seed?) {
            self.raw = raw; self.rawSHA256 = rawSHA256; self.snapshotSHA256 = snapshotSHA256
            self.selectionSHA256 = selectionSHA256; self.configurationSHA256 = configurationSHA256
            self.expiresAt = expiresAt; self.core = core; self.model = model; self.assets = assets; self.stateSeed = stateSeed
        }
        // Preserve the producer's exact raw bytes. No JSON reencoding or claim
        // that the opaque capsule hash is a signature or Native authority.
        func encoded() -> Data { raw }
    }
    static let maximumReceiptBytes = 256 * 1024
    static let maximumConfigurationBytes = 2 * 1024 * 1024
    static let maximumAssetBytes = 128 * 1024 * 1024
    static let maximumTotalBytes = 256 * 1024 * 1024
    static let maximumAssets = 200
    static let maximumSafeInteger: Int64 = 9_007_199_254_740_991
    // COMPILED_PINS: generated solely from the three pinned local manifests.
    static let corePins: [CoreIdentity] = [
        .init(profile: .stable, architecture: .arm64, version: "v1.19.33", sha256: "f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9", size: 56810034),
        .init(profile: .stable, architecture: .x64, version: "v1.19.33", sha256: "291f5923c3dd3b8df36eaeccdd59eaf873ee021693cde65eb696f8b86ac99652", size: 60945968),
        .init(profile: .alpha, architecture: .arm64, version: "alpha-ca8d7c4", sha256: "0ea7c8e7d6f3ab26537a49e6d98570279152df604f2ff4c083dd8615a358c3b6", size: 56843474),
        .init(profile: .alpha, architecture: .x64, version: "alpha-ca8d7c4", sha256: "2249c77fa07e2dae31c4852714f2e10293d11d99927edd002d57359648c68cc6", size: 60970960),
        .init(profile: .smart, architecture: .arm64, version: "alpha-smart-4624551", sha256: "138c416dddf53af64a8cd01508c2e93c338e18c6cc04b0e480932bc819eda061", size: 57972626),
        .init(profile: .smart, architecture: .x64, version: "alpha-smart-4624551", sha256: "935572a8117acb3ab95d7c4235d07b475b8fdb19c1904413c0bb05131d007132", size: 62169184),
        .init(profile: .localGeodata, architecture: .arm64, version: "relay-geodata-v1p1-3f27", sha256: "6c211be8a99257e980ed6a69d7eb4c2cae12946eebcd2b7fd4a2e6b7aebfcbbe", size: 79397776),
        .init(profile: .localGeodata, architecture: .x64, version: "relay-geodata-v1p1-3f27", sha256: "bd9f2b38256b05b643f6a33273669b4df2c2b32b5a25db0b8db41a0a0199bc3b", size: 85466544)
    ]
    static let modelPins: [ModelIdentity] = [
        .init(version: "LightGBM-Model-530723858", sha256: "23633022a815fb34e510befe1c176ba50af3ced48f08b172454f4cd6b8327788", size: 9345218),
        .init(version: "LightGBM-Model-530724342", sha256: "6a17dffbb29862135c9e3706eabf60488862f578ef9edf60a5d325529873cfaa", size: 18357364),
        .init(version: "LightGBM-Model-530723977", sha256: "832920df1290454710dd04aa4c7d4b5324edfd7816a7c9ad2272708b5d5a13a8", size: 26787747)
    ]

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private static func hash(_ raw: Any?) throws -> String {
        guard let value = raw as? String, value.utf8.count == 64,
              value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw Failure.schema }
        return value
    }
    // Unix milliseconds alone need a safe integer larger than UInt32. The
    // mature RelayTunStrictJSON.integer and all count fields remain unchanged.
    private static func milliseconds(_ raw: Any?) throws -> Int64 {
        guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { throw Failure.integer }
        let number = value.doubleValue
        guard number.isFinite, number.rounded() == number, number >= 0,
              number <= Double(maximumSafeInteger) else { throw Failure.integer }
        return Int64(number)
    }
    private static func boolean(_ raw: Any?, is value: Bool) -> Bool {
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue == value
    }
    private static func boundedInteger(_ raw: Any?, maximum: Int) throws -> Int {
        guard let value = RelayTunStrictJSON.integer(raw), value <= maximum else { throw Failure.integer }
        return value
    }
    private static func relative(_ path: String, smart: Bool) -> Bool {
        if ["GeoSite.dat", "GeoIP.dat", "Country.mmdb", "ASN.mmdb"].contains(path) { return true }
        if smart && path == "Model.bin" { return true }
        return path.range(of: "^relay-files/[a-f0-9]{64}\\.(?:bin|yaml|text|mrs)$", options: .regularExpression) != nil
    }
    private static func groups(_ configuration: [String: Any]) throws -> [[String: Any]] {
        guard let raw = configuration["proxy-groups"] else { return [] }
        guard let groups = raw as? [[String: Any]] else { throw Failure.configuration }
        for group in groups where group["type"] as? String == "smart" {
            if let flag = group["prefer-asn"], !boolean(flag, is: true), !boolean(flag, is: false) { throw Failure.configuration }
        }
        return groups
    }
    private static func ruleList(_ raw: Any?) throws -> [String] {
        guard let raw else { return [] }
        guard let rules = raw as? [String] else { throw Failure.configuration }; return rules
    }
    private static func requiresASN(_ configuration: [String: Any], groups: [[String: Any]]) throws -> Bool {
        if groups.contains(where: { $0["type"] as? String == "smart" && boolean($0["prefer-asn"], is: true) }) { return true }
        var rules = try ruleList(configuration["rules"])
        if let raw = configuration["sub-rules"] {
            guard let subrules = raw as? [String: Any] else { throw Failure.configuration }
            for value in subrules.values { rules += try ruleList(value) }
        }
        if let raw = configuration["rule-providers"] {
            guard let providers = raw as? [String: [String: Any]] else { throw Failure.configuration }
            for provider in providers.values where provider["behavior"] as? String == "classical" {
                rules += try ruleList(provider["payload"])
            }
        }
        // Match mature rule parser strings.ToUpper without rewriting captured configuration bytes.
        return rules.contains { $0.uppercased().range(of: "\\b(?:SRC-)?IP-ASN\\s*,", options: .regularExpression) != nil }
    }
    static func decode(_ raw: Data, expectedRawSHA256: String, context: Context) throws -> Validated {
        guard !raw.isEmpty, raw.count <= maximumReceiptBytes,
              try hash(expectedRawSHA256) == digest(raw) else { throw Failure.raw }
        let envelope = try RelayTunStrictJSON.object(raw, limit: maximumReceiptBytes, maxNodes: 4096)
        let hasStateSeed = envelope.keys.contains("stateSeed")
        guard Set(envelope.keys) == Set(["version", "kind", "checked"]).union(hasStateSeed ? ["stateSeed"] : []),
              RelayTunStrictJSON.integer(envelope["version"]) == 2,
              envelope["kind"] as? String == "relay-core-execution",
              let checked = envelope["checked"] as? [String: Any],
              let family = checked["profile"] as? String, let profile = Profile(rawValue: family),
              let architectureValue = checked["architecture"] as? String,
              let architecture = Architecture(rawValue: architectureValue) else { throw Failure.schema }
        let required: Set<String> = ["version", "profile", "architecture", "core", "configurationSHA256", "selectionSHA256", "snapshotSHA256", "expiresAt", "assets"]
        guard Set(checked.keys) == required.union(profile == .smart ? ["model"] : []),
              RelayTunStrictJSON.integer(checked["version"]) == 2,
              corePins.contains(context.core), context.core.profile == profile,
              context.core.architecture == architecture,
              let core = checked["core"] as? [String: Any], Set(core.keys) == ["version", "sha256", "size"],
              core["version"] as? String == context.core.version,
              try hash(core["sha256"]) == context.core.sha256,
              try boundedInteger(core["size"], maximum: maximumAssetBytes) == context.core.size else { throw Failure.profile }
        let expiresAt = try milliseconds(checked["expiresAt"])
        guard context.nowMS >= 0, context.nowMS <= maximumSafeInteger - 60_000,
              expiresAt > context.nowMS, expiresAt <= context.nowMS + 60_000 else { throw Failure.expired }
        guard !context.configuration.isEmpty, context.configuration.count <= maximumConfigurationBytes,
              try hash(checked["configurationSHA256"]) == digest(context.configuration) else { throw Failure.configuration }
        let configuration = try RelayTunStrictJSON.object(context.configuration, limit: maximumConfigurationBytes, maxNodes: 200000)
        guard boolean(configuration["geo-auto-update"], is: false),
              let urls = configuration["geox-url"] as? [String: Any],
              urls.values.allSatisfy({ $0 as? String == "" }) else { throw Failure.configuration }
        let groups = try groups(configuration), usesSmart = groups.contains { $0["type"] as? String == "smart" }
        guard !usesSmart || profile == .smart else { throw Failure.profile }
        let collectCSV = try RelayTunSmartStateV1.collectsCSV(groups: groups)
        let stateSeed: RelayTunSmartStateV1.Seed?
        if hasStateSeed {
            guard profile == .smart, let rawState = envelope["stateSeed"] else { throw Failure.profile }
            stateSeed = try RelayTunSmartStateV1.decodeSeed(rawState, collectCSV: collectCSV)
        } else { stateSeed = nil }
        if profile == .smart {
            guard boolean(configuration["lgbm-auto-update"], is: false),
                  configuration["lgbm-url"] as? String == "http://127.0.0.1:1/relay-model-download-disabled" else { throw Failure.configuration }
        }
        guard let items = checked["assets"] as? [[String: Any]], items.count <= maximumAssets,
              context.assets.count <= maximumAssets, items.count == context.assets.count else { throw Failure.budget }
        var total = 0, names = Set<String>()
        for asset in context.assets {
            guard relative(asset.path, smart: profile == .smart), names.insert(asset.path).inserted else { throw Failure.asset }
            guard !asset.data.isEmpty, asset.data.count <= maximumAssetBytes else { throw Failure.budget }
            total += asset.data.count
            guard total <= maximumTotalBytes else { throw Failure.budget }
            if let count = asset.expectedRules, !(0...2_000_000).contains(count) { throw Failure.asset }
        }
        var identities: [AssetIdentity] = []
        for (index, item) in items.enumerated() {
            let asset = context.assets[index]
            let hasRules = item.keys.contains("expectedRules")
            guard Set(item.keys) == Set(["path", "sha256", "size"]).union(hasRules ? ["expectedRules"] : []),
                  item["path"] as? String == asset.path,
                  try hash(item["sha256"]) == digest(asset.data),
                  try boundedInteger(item["size"], maximum: maximumAssetBytes) == asset.data.count else { throw Failure.asset }
            let count: Int? = hasRules ? try boundedInteger(item["expectedRules"], maximum: 2_000_000) : nil
            guard count == asset.expectedRules else { throw Failure.asset }
            identities.append(.init(path: asset.path, sha256: try hash(item["sha256"]), size: asset.data.count, expectedRules: count))
        }
        var model: ModelIdentity?
        if profile == .smart {
            guard let row = checked["model"] as? [String: Any], Set(row.keys) == ["version", "sha256", "size", "path"],
                  row["path"] as? String == "Model.bin", let version = row["version"] as? String else { throw Failure.model }
            let fixed = ModelIdentity(version: version, sha256: try hash(row["sha256"]),
                                      size: try boundedInteger(row["size"], maximum: maximumAssetBytes))
            guard modelPins.contains(fixed), let asset = identities.first(where: { $0.path == "Model.bin" }),
                  asset.sha256 == fixed.sha256, asset.size == fixed.size else { throw Failure.model }
            model = fixed
        }
        let asn = try requiresASN(configuration, groups: groups)
        guard !asn || names.contains("ASN.mmdb") else { throw Failure.asn }
        return try .init(raw: raw, rawSHA256: expectedRawSHA256, snapshotSHA256: hash(checked["snapshotSHA256"]),
                         selectionSHA256: hash(checked["selectionSHA256"]), configurationSHA256: hash(checked["configurationSHA256"]),
                         expiresAt: expiresAt, core: context.core, model: model, assets: identities, stateSeed: stateSeed)
    }
}
