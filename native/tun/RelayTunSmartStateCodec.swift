// Shared Smart state DTO/validation. No filesystem, collector writer, runtime
// permission or second JSON/raw decoder lives in the mutable-file component.
import Foundation
import CoreFoundation
import CryptoKit

enum RelayTunSmartStateV1 {
    enum Failure: String, Error { case schema, path, digest, size, files, collection, header }
    enum Path: String, CaseIterable { case cache = "cache.db", csv = "smart_weight_data.csv" }
    struct File: Equatable {
        let path: Path
        let sha256: String
        let size: Int
        init(path: Path, sha256: String, size: Int) throws {
            self.path = path; self.sha256 = sha256; self.size = size
            try RelayTunSmartStateV1.validateFile(self)
        }
    }
    struct Seed: Equatable {
        let version: Int
        let key: String
        let previousRevision: String?
        let files: [File]
        // The file component independently calls shared validateSeed before IO.
        init(version: Int = 1, key: String, previousRevision: String?, files: [File]) {
            self.version = version; self.key = key; self.previousRevision = previousRevision; self.files = files
        }
    }
    struct Result: Equatable {
        let version: Int
        let key: String
        let previousRevision: String?
        let files: [File]
        // A Result is metadata only; a post-reap/restoration owner creates it.
        // Its existence does not prove that those lifecycle observations ran.
        init(key: String, previousRevision: String?, files: [File], collectCSV: Bool) throws {
            try RelayTunSmartStateV1.validateSeed(.init(key: key, previousRevision: previousRevision, files: files), collectCSV: collectCSV)
            version = 1; self.key = key; self.previousRevision = previousRevision; self.files = files
        }
    }
    static let csvHeaderBytes = 555
    static let csvHeaderSHA256 = "14535c00a00d6f4e380acfc91b2da9f312d9fd78c9322eae1aa14f8587067b84"
    static let maximumFileBytes = 128 * 1024 * 1024
    static let maximumTotalBytes = 256 * 1024 * 1024
    static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private static func hash(_ raw: Any?) throws -> String {
        guard let value = raw as? String, value.utf8.count == 64,
              value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw Failure.digest }
        return value
    }
    private static func integer(_ raw: Any?) throws -> Int {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw Failure.size }
        let value = number.doubleValue
        guard value.isFinite, value.rounded() == value, value >= 0, value <= Double(maximumFileBytes) else { throw Failure.size }
        return Int(value)
    }
    private static func validateFile(_ file: File) throws {
        _ = try hash(file.sha256)
        guard (0...maximumFileBytes).contains(file.size), file.path != .csv || file.size >= csvHeaderBytes else { throw Failure.size }
        if file.size == 0, file.sha256 != digest(Data()) { throw Failure.digest }
    }
    static func validateSeed(_ seed: Seed, collectCSV: Bool) throws {
        guard seed.version == 1 else { throw Failure.schema }
        _ = try hash(seed.key)
        if let previous = seed.previousRevision { _ = try hash(previous) }
        let required: Set<Path> = collectCSV ? [.cache, .csv] : [.cache]
        guard seed.files.count == required.count else { throw Failure.files }
        var paths = Set<Path>(), total = 0
        for file in seed.files {
            try validateFile(file)
            guard paths.insert(file.path).inserted else { throw Failure.files }
            total += file.size
            guard total <= maximumTotalBytes else { throw Failure.size }
        }
        guard paths == required else { throw Failure.files }
    }
    // Called by the sole receipt decoder after RelayTunStrictJSON already
    // rejected duplicate keys and bound the entire exact raw envelope SHA.
    static func decodeSeed(_ parsed: Any, collectCSV: Bool) throws -> Seed {
        guard let object = parsed as? [String: Any], Set(object.keys) == ["version", "key", "previousRevision", "files"],
              let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let items = object["files"] as? [[String: Any]], items.count <= 2 else { throw Failure.schema }
        let previous: String?
        if object["previousRevision"] is NSNull { previous = nil } else { previous = try hash(object["previousRevision"]) }
        let files = try items.map { item -> File in
            guard Set(item.keys) == ["path", "sha256", "size"], let name = item["path"] as? String,
                  let path = Path(rawValue: name) else { throw Failure.path }
            return try .init(path: path, sha256: hash(item["sha256"]), size: integer(item["size"]))
        }
        let seed = Seed(key: try hash(object["key"]), previousRevision: previous, files: files)
        try validateSeed(seed, collectCSV: collectCSV); return seed
    }
    // Fixed462 constructs SmartOption{} (bool zero value) then copies
    // CollectData. Omitted collectdata is false; explicit non-bools are closed.
    static func collectsCSV(groups: [[String: Any]]) throws -> Bool {
        var enabled = false
        for group in groups where group["type"] as? String == "smart" {
            guard let raw = group["collectdata"] else { continue }
            guard let flag = raw as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { throw Failure.collection }
            enabled = enabled || flag.boolValue
        }
        return enabled
    }
    static func validateHeader(_ bytes: Data) throws {
        guard bytes.count == csvHeaderBytes, digest(bytes) == csvHeaderSHA256 else { throw Failure.header }
    }
    static func validateCSVPrefix(_ bytes: Data) throws {
        guard bytes.count >= csvHeaderBytes else { throw Failure.header }
        try validateHeader(Data(bytes.prefix(csvHeaderBytes)))
    }
}
