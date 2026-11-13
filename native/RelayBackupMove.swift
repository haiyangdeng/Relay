import Foundation
import Darwin
import CryptoKit

/// A thin adapter for the same RENAME_EXCL primitive used by the TUN journal
/// archive. It never accepts arbitrary paths or falls back to rename(2).
enum RelayBackupMove {
    enum Failure: Error { case invalid, conflict, uncertain }
    struct Context: Decodable { let home: String; let stateRoot: String }
    struct Identity: Codable, Equatable {
        let dev: UInt64
        let ino: UInt64
        let uid: UInt32
        let mode: UInt32
        func matches(_ value: stat) -> Bool {
            value.st_dev >= 0 && dev <= 9_007_199_254_740_991 && ino > 0 && ino <= 9_007_199_254_740_991 &&
            dev == UInt64(value.st_dev) && ino == UInt64(value.st_ino) &&
            uid == getuid() && uid == value.st_uid && mode == UInt32(value.st_mode)
        }
    }
    struct Request: Decodable {
        let journalRevision: Int
        let journalSHA256: String
        let id: String
        let root: String
        let operation: String
        let directoryIdentity: Identity
        let sourceIdentity: Identity
    }
    struct Input: Decodable { let context: Context; let request: Request }
    struct PublishRequest: Decodable {
        let id: String; let directoryIdentity: Identity; let revision: Int
        let parentSHA256: String?; let bytes: String
    }
    struct PublishInput: Decodable { let context: Context; let request: PublishRequest }
    struct FileRequest: Decodable {
        let namespace: String; let id: String; let directoryIdentity: Identity
        let name: String; let mode: UInt32; let bytes: String; let directory: Bool?
    }
    struct FileInput: Decodable { let context: Context; let request: FileRequest }
    struct FileReceipt: Encodable { let identity: Identity; let sha256: String }
    struct Published: Encodable { let status = "published" }
    private struct AccountFrame: Decodable {
        struct Account: Decodable { let id: String }
        let version: Int; let sequence: Int; let parentSHA256: String?; let account: Account
    }
    private struct ReceiptFrame: Decodable {
        struct Event: Decodable { let kind: String; let directoryIdentity: Identity? }
        let version: Int; let id: String; let sequence: Int; let parentSHA256: String?; let event: Event
    }
    private struct Frame: Decodable {
        let version: Int; let sequence: Int; let parentSHA256: String; let journal: Journal
    }
    private struct Head { let revision: Int; let sha256: String; let journal: Journal }

    struct Report: Encodable { let status = "moved" }
    private struct Journal: Decodable {
        struct Plan: Decodable { let id: String }
        struct Intent: Decodable {
            let root: String; let from: String; let to: String; let identity: Identity
        }
        let version: Int
        let plan: Plan
        let directoryIdentity: Identity
        let intent: Intent?
    }
    private static let directories: Set<String> = [
        "Configurations", "ProviderResources", "ResourceSnapshots", "SubscriptionSources",
        "Configuration", "Variants", "UI", "SubStore/Data", "Plugins"
    ]
    private static let files: Set<String> = ["preferences.json", "Core/selection.json"]
    #if RELAY_BACKUP_MOVE_TESTS
    static var beforeRename: (() throws -> Void)?
    static var beforeJournalCreate: (() throws -> Void)?
    static var beforeFileCreate: (() throws -> Void)?
    #endif

    private final class Chain {
        let home: String
        var descriptors: [Int32] = []
        var names: [String] = []
        init(home: String, components: [String]) throws {
            self.home = home
            let first = Darwin.open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard first >= 0 else { throw Failure.conflict }
            descriptors.append(first)
            do {
                for name in components {
                    guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else { throw Failure.invalid }
                    let next = openat(descriptors.last!, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    guard next >= 0 else { throw Failure.conflict }
                    descriptors.append(next); names.append(name)
                }
                try verify()
            } catch {
                closeAll()
                throw error
            }
        }
        init(parent: Chain, ancestorDepth: Int? = nil, components: [String], create: Bool) throws {
            home = parent.home
            let count = ancestorDepth ?? parent.descriptors.count
            guard count > 0, count <= parent.descriptors.count else { throw Failure.invalid }
            names = Array(parent.names.prefix(count - 1))
            descriptors = parent.descriptors.prefix(count).map { dup($0) }
            do {
                guard descriptors.allSatisfy({ $0 >= 0 }) else { throw Failure.conflict }
                try verify()
                for name in components {
                    guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else { throw Failure.invalid }
                    var next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    if next < 0 && errno == ENOENT && create {
                        try verify()
                        guard mkdirat(fd, name, 0o700) == 0 || errno == EEXIST else { throw Failure.conflict }
                        guard fsync(fd) == 0 else { throw Failure.uncertain }
                        next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    }
                    guard next >= 0 else { throw Failure.conflict }
                    descriptors.append(next); names.append(name)
                    try verify()
                }
            } catch { closeAll(); throw error }
        }
        deinit { closeAll() }
        private func closeAll() {
            for fd in descriptors.reversed() { Darwin.close(fd) }
            descriptors.removeAll()
        }
        var fd: Int32 { descriptors.last! }
        func verify() throws {
            guard !descriptors.isEmpty else { throw Failure.conflict }
            for index in descriptors.indices {
                var value = stat(), linked = stat()
                guard fstat(descriptors[index], &value) == 0,
                      value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), value.st_uid == getuid(),
                      value.st_mode & 0o7022 == 0 else { throw Failure.conflict }
                let result = index == 0 ? lstat(home, &linked) :
                    fstatat(descriptors[index - 1], names[index - 1], &linked, AT_SYMLINK_NOFOLLOW)
                guard result == 0, value.st_dev == linked.st_dev, value.st_ino == linked.st_ino,
                      value.st_uid == linked.st_uid, value.st_mode == linked.st_mode else { throw Failure.conflict }
            }
        }
    }
    private static func canonical(_ value: String) -> Bool {
        guard value.hasPrefix("/"), !value.utf8.contains(0), let resolved = realpath(value, nil) else { return false }
        defer { free(resolved) }
        return String(cString: resolved) == value
    }
    private static func readJournal(_ record: Chain, name: String = "journal.json", limit: Int = 65536, mode: UInt32 = 0o600, allowEmpty: Bool = false) throws -> Data {
        let fd = openat(record.fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.conflict }
        defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              UInt32(before.st_mode & 0o7777) == mode, before.st_uid == getuid(), before.st_nlink == 1,
              before.st_size >= (allowEmpty ? 0 : 1), before.st_size <= limit else { throw Failure.conflict }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            guard count >= 0 else { throw Failure.conflict }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= limit else { throw Failure.conflict }
        }
        guard fstat(fd, &after) == 0,
              fstatat(record.fd, name, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              [after, linked].allSatisfy({
                  $0.st_dev == before.st_dev && $0.st_ino == before.st_ino &&
                  $0.st_mode == before.st_mode && $0.st_uid == before.st_uid && $0.st_nlink == 1 &&
                  $0.st_size == before.st_size &&
                  $0.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec &&
                  $0.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec &&
                  $0.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec &&
                  $0.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec
              }), data.count == before.st_size else { throw Failure.conflict }
        return data
    }
    private static func hash(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    private static func revisionName(_ revision: Int) -> String {
        revision == 0 ? "journal.json" : String(format: "journal-%06d.json", revision)
    }
    private static func readChain(_ record: Chain) throws -> Head {
        let copied = dup(record.fd)
        guard copied >= 0, let directory = fdopendir(copied) else {
            if copied >= 0 { Darwin.close(copied) }; throw Failure.conflict
        }
        defer { closedir(directory) }
        rewinddir(directory)
        var names = [String]()
        while let entry = readdir(directory) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
            }
            if name.hasPrefix("journal-") {
                guard name.range(of: "^journal-[0-9]{6}\\.json$", options: .regularExpression) != nil,
                      names.count < 512 else { throw Failure.conflict }
                names.append(name)
            }
        }
        names.sort()
        var bytes = try readJournal(record), journal = try JSONDecoder().decode(Journal.self, from: bytes)
        var digest = hash(bytes), total = bytes.count
        let anchorID = journal.plan.id, anchorDirectory = journal.directoryIdentity
        for (index, name) in names.enumerated() {
            guard name == revisionName(index + 1) else { throw Failure.conflict }
            bytes = try readJournal(record, name: name); total += bytes.count
            guard total <= 32 * 1024 * 1024 else { throw Failure.conflict }
            let frame = try JSONDecoder().decode(Frame.self, from: bytes)
            guard frame.version == 1, frame.sequence == index + 1, frame.parentSHA256 == digest,
                  frame.journal.version == 2, frame.journal.plan.id == anchorID,
                  frame.journal.directoryIdentity == anchorDirectory else { throw Failure.conflict }
            journal = frame.journal; digest = hash(bytes)
        }
        return Head(revision: names.count, sha256: digest, journal: journal)
    }
    private static func record(_ context: Context, id: String, identity: Identity) throws -> Chain {
        guard canonical(context.home), canonical(context.stateRoot),
              ["Relay", "Relay-Preview"].contains(where: {
                  context.stateRoot == context.home + "/Library/Application Support/" + $0
              }), id.range(of: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$", options: .regularExpression) != nil else { throw Failure.invalid }
        let record = try Chain(home: context.home, components: ["Library", "Application Support",
            context.stateRoot.hasSuffix("/Relay-Preview") ? "Relay-Preview" : "Relay", "ApplicationBackups", "restore-" + id])
        var value = stat()
        guard fstat(record.fd, &value) == 0, identity.matches(value), value.st_mode & 0o7777 == 0o700 else { throw Failure.conflict }
        return record
    }
    private static func accountNames(_ record: Chain) throws -> [String] {
        let copied = dup(record.fd)
        guard copied >= 0, let directory = fdopendir(copied) else {
            if copied >= 0 { Darwin.close(copied) }; throw Failure.conflict
        }
        defer { closedir(directory) }; rewinddir(directory)
        var names = [String]()
        while let entry = readdir(directory) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            guard name == "account.json" || name.range(of: "^revision-[0-9]{6}\\.json$", options: .regularExpression) != nil,
                  names.count < 101 else { throw Failure.conflict }
            names.append(name)
        }
        return names.sorted()
    }
    private static func accountName(_ sequence: Int) -> String {
        sequence == 0 ? "account.json" : String(format: "revision-%06d.json", sequence)
    }
    private static func accountFrame(_ bytes: Data, id: String) throws -> AccountFrame {
        let frame = try JSONDecoder().decode(AccountFrame.self, from: bytes)
        guard frame.version == 1, frame.account.id == id, (0...100).contains(frame.sequence),
              frame.sequence == 0 ? frame.parentSHA256 == nil : frame.parentSHA256?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw Failure.conflict }
        return frame
    }
    private static func accountHead(_ record: Chain, id: String) throws -> (Int, String)? {
        let names = try accountNames(record)
        var digest: String?
        for (index, name) in names.enumerated() {
            guard name == accountName(index) else { throw Failure.conflict }
            let bytes = try readJournal(record, name: name, limit: 131072), frame = try accountFrame(bytes, id: id)
            guard frame.sequence == index, frame.parentSHA256 == digest else { throw Failure.conflict }
            digest = hash(bytes)
        }
        return digest.map { (names.count - 1, $0) }
    }
    private static func receiptFrame(_ bytes: Data, id: String) throws -> ReceiptFrame {
        let frame = try JSONDecoder().decode(ReceiptFrame.self, from: bytes)
        guard frame.version == 1, frame.id == id, (0..<10000).contains(frame.sequence),
              frame.sequence == 0 ? frame.parentSHA256 == nil && frame.event.kind == "created" :
                frame.parentSHA256?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
                ["uploaded", "deletion-started", "deleted", "not-submitted"].contains(frame.event.kind) else { throw Failure.conflict }
        return frame
    }
    private static func receiptHead(_ record: Chain, id: String) throws -> (Int, String)? {
        let copied = dup(record.fd)
        guard copied >= 0, let directory = fdopendir(copied) else {
            if copied >= 0 { Darwin.close(copied) }; throw Failure.conflict
        }
        defer { closedir(directory) }; rewinddir(directory)
        var names = [String]()
        while let entry = readdir(directory) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            guard names.count < 10000, name.range(of: "^receipt-[0-9]{6}\\.json$", options: .regularExpression) != nil else { throw Failure.conflict }
            names.append(name)
        }
        names.sort()
        var digest: String?, total = 0, value = stat()
        guard fstat(record.fd, &value) == 0 else { throw Failure.conflict }
        for (index, name) in names.enumerated() {
            guard name == String(format: "receipt-%06d.json", index) else { throw Failure.conflict }
            let bytes = try readJournal(record, name: name, limit: 16384), frame = try receiptFrame(bytes, id: id)
            total += bytes.count
            guard total <= 32 * 1024 * 1024, frame.sequence == index, frame.parentSHA256 == digest else { throw Failure.conflict }
            if index == 0 { guard frame.event.directoryIdentity?.matches(value) == true else { throw Failure.conflict } }
            digest = hash(bytes)
        }
        return digest.map { (names.count - 1, $0) }
    }
    private static func createAccountDirectory(_ input: FileInput) throws -> FileReceipt {
        let context = input.context, request = input.request
        guard request.name.isEmpty, request.directory == true, request.mode == 0o700, request.bytes.isEmpty,
              canonical(context.home), canonical(context.stateRoot),
              ["Relay", "Relay-Preview"].contains(where: { context.stateRoot == context.home + "/Library/Application Support/" + $0 }),
              request.id.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", options: .regularExpression) != nil else { throw Failure.invalid }
        let state = try Chain(home: context.home, components: ["Library", "Application Support", context.stateRoot.hasSuffix("/Relay-Preview") ? "Relay-Preview" : "Relay"])
        var value = stat()
        guard fstat(state.fd, &value) == 0, request.directoryIdentity.matches(value) else { throw Failure.conflict }
        #if RELAY_BACKUP_MOVE_TESTS
        try beforeFileCreate?()
        #endif
        try state.verify()
        let parent = try Chain(parent: state, components: request.namespace == "backup-receipt" ?
            ["RemoteBackupReceipts"] : ["Configuration", "BackupAccounts"], create: true)
        try state.verify(); try parent.verify()
        // Existing account directories are never adopted by a create request.
        guard mkdirat(parent.fd, request.id, 0o700) == 0 else { throw Failure.conflict }
        guard fsync(parent.fd) == 0 else { throw Failure.uncertain }
        let record = try Chain(parent: parent, components: [request.id], create: false)
        guard fstat(record.fd, &value) == 0, value.st_mode & 0o7777 == 0o700, value.st_dev >= 0 else { throw Failure.conflict }
        try record.verify(); try state.verify()
        return FileReceipt(identity: Identity(dev: UInt64(value.st_dev), ino: UInt64(value.st_ino), uid: value.st_uid, mode: UInt32(value.st_mode)), sha256: hash(Data()))
    }
    static func decodeFile(_ data: Data) throws -> FileInput {
        guard data.count <= 360 * 1024 * 1024,
              let outer = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(outer.keys) == ["context", "request"],
              let context = outer["context"] as? [String: Any], Set(context.keys) == ["home", "stateRoot"],
              let request = outer["request"] as? [String: Any],
              Set(request.keys).subtracting(["directory"]) == ["namespace", "id", "directoryIdentity", "name", "mode", "bytes"],
              let identity = request["directoryIdentity"] as? [String: Any],
              Set(identity.keys) == ["dev", "ino", "uid", "mode"] else { throw Failure.invalid }
        return try JSONDecoder().decode(FileInput.self, from: data)
    }
    static func publishFile(_ input: FileInput) throws -> FileReceipt {
        let context = input.context, request = input.request
        if ["backup-account", "backup-receipt"].contains(request.namespace) && request.directory == true { return try createAccountDirectory(input) }
        let isDirectory = request.directory == true
        let maxBytes: Int
        var relativeParent = [String](), leaf = request.name
        if request.namespace == "backup-account" {
            guard !isDirectory, request.mode == 0o600,
                  request.name == "account.json" || request.name.range(of: "^revision-[0-9]{6}\\.json$", options: .regularExpression) != nil else { throw Failure.invalid }
            maxBytes = 131072
        } else if request.namespace == "backup-receipt" {
            guard !isDirectory, request.mode == 0o600,
                  request.name.range(of: "^receipt-[0-9]{6}\\.json$", options: .regularExpression) != nil else { throw Failure.invalid }
            maxBytes = 16384
        } else if request.namespace == "migration" {
            guard !isDirectory else { throw Failure.invalid }
            switch request.name {
            case "original.zip": maxBytes = 128 * 1024 * 1024
            case "report.json": maxBytes = 4 * 1024 * 1024
            case "migration.json", "restore-plan.json": maxBytes = 65536
            default: throw Failure.invalid
            }
            guard request.mode == 0o600 else { throw Failure.invalid }
        } else if request.namespace == "recovery" {
            if isDirectory {
                guard request.mode == 0o700, request.bytes.isEmpty,
                      request.name == "candidate" || request.name.hasPrefix("candidate/") else { throw Failure.invalid }
                let path = request.name == "candidate" ? "" : String(request.name.dropFirst(10))
                guard (request.name == "candidate" || !path.isEmpty), path.utf8.count <= 1024,
                      !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0.value == 92 }),
                      path.isEmpty || path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") }),
                      path.isEmpty || directories.contains(where: { path == $0 || path.hasPrefix($0 + "/") || $0.hasPrefix(path + "/") }) || files.contains(where: { $0.hasPrefix(path + "/") }) else { throw Failure.invalid }
                relativeParent = request.name.split(separator: "/").map(String.init); leaf = ""; maxBytes = 0
            } else if request.name == "archive.zip" || request.name == "baseline.zip" { maxBytes = 128 * 1024 * 1024 }
            else if request.name == "recheck-pending" || request.name == "recovery-pending" { maxBytes = 1024 }
            else if request.name.range(of: "^settled-[a-f0-9]{64}\\.json$", options: .regularExpression) != nil { maxBytes = 8192 }
            else if request.name.hasPrefix("candidate/") {
                let value = String(request.name.dropFirst(10)), parts = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
                guard !value.isEmpty, value.utf8.count <= 1024,
                      !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0.value == 92 }),
                      parts.allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") }),
                      files.contains(value) || directories.contains(where: { value.hasPrefix($0 + "/") }) else { throw Failure.invalid }
                relativeParent = ["candidate"] + parts.dropLast(); leaf = parts.last!; maxBytes = 256 * 1024 * 1024
            } else { throw Failure.invalid }
            guard request.mode == 0o600 || (request.mode == 0o700 && !relativeParent.isEmpty) else { throw Failure.invalid }
        } else { throw Failure.invalid }
        guard request.bytes.utf8.count <= ((maxBytes + 2) / 3) * 4,
              let bytes = Data(base64Encoded: request.bytes), bytes.count <= maxBytes,
              canonical(context.home), canonical(context.stateRoot),
              ["Relay", "Relay-Preview"].contains(where: { context.stateRoot == context.home + "/Library/Application Support/" + $0 }),
              request.id.range(of: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$", options: .regularExpression) != nil else { throw Failure.invalid }
        let state = ["Library", "Application Support", context.stateRoot.hasSuffix("/Relay-Preview") ? "Relay-Preview" : "Relay"]
        let recordParts = state + (request.namespace == "migration" ? ["Migrations", request.id] :
            request.namespace == "backup-account" ? ["Configuration", "BackupAccounts", request.id] :
            request.namespace == "backup-receipt" ? ["RemoteBackupReceipts", request.id] : ["ApplicationBackups", "restore-" + request.id])
        let record = try Chain(home: context.home, components: recordParts)
        var value = stat()
        guard fstat(record.fd, &value) == 0, request.directoryIdentity.matches(value), value.st_mode & 0o7777 == 0o700 else { throw Failure.conflict }
        #if RELAY_BACKUP_MOVE_TESTS
        if isDirectory { try beforeFileCreate?() }
        #endif
        try record.verify()
        let parent = try Chain(parent: record, components: relativeParent, create: true)
        if isDirectory {
            var value = stat()
            guard fstat(parent.fd, &value) == 0 else { throw Failure.conflict }
            try record.verify(); try parent.verify()
            return FileReceipt(identity: Identity(dev: UInt64(value.st_dev), ino: UInt64(value.st_ino), uid: value.st_uid, mode: UInt32(value.st_mode)), sha256: hash(Data()))
        }
        try record.verify(); try parent.verify()
        var expectedAccountHead: (Int, String)?
        if request.namespace == "backup-account" {
            let frame = try accountFrame(bytes, id: request.id), head = try accountHead(record, id: request.id)
            guard request.name == accountName(frame.sequence), frame.sequence == (head.map { $0.0 + 1 } ?? 0),
                  frame.parentSHA256 == head?.1 else { throw Failure.conflict }
            expectedAccountHead = head
        } else if request.namespace == "backup-receipt" {
            let frame = try receiptFrame(bytes, id: request.id), head = try receiptHead(record, id: request.id)
            guard request.name == String(format: "receipt-%06d.json", frame.sequence),
                  frame.sequence == (head.map { $0.0 + 1 } ?? 0), frame.parentSHA256 == head?.1 else { throw Failure.conflict }
            if frame.sequence == 0 { guard frame.event.directoryIdentity?.matches(value) == true else { throw Failure.conflict } }
            expectedAccountHead = head
        }
        #if RELAY_BACKUP_MOVE_TESTS
        try beforeFileCreate?()
        #endif
        try record.verify(); try parent.verify()
        if request.namespace == "backup-account" {
            let head = try accountHead(record, id: request.id)
            guard head?.0 == expectedAccountHead?.0, head?.1 == expectedAccountHead?.1 else { throw Failure.conflict }
        } else if request.namespace == "backup-receipt" {
            let head = try receiptHead(record, id: request.id)
            guard head?.0 == expectedAccountHead?.0, head?.1 == expectedAccountHead?.1 else { throw Failure.conflict }
        }
        let fd = openat(parent.fd, leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(request.mode))
        guard fd >= 0 else { throw Failure.conflict }
        defer { Darwin.close(fd) }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw Failure.uncertain }; offset += count
            }
        }
        guard fsync(fd) == 0, fsync(parent.fd) == 0, fstat(fd, &value) == 0 else { throw Failure.uncertain }
        let digest = hash(bytes)
        guard hash(try readJournal(parent, name: leaf, limit: maxBytes, mode: request.mode, allowEmpty: true)) == digest else { throw Failure.uncertain }
        try record.verify(); try parent.verify()
        if request.namespace == "backup-account" {
            guard try accountHead(record, id: request.id)?.1 == digest else { throw Failure.uncertain }
        } else if request.namespace == "backup-receipt" {
            guard try receiptHead(record, id: request.id)?.1 == digest else { throw Failure.uncertain }
        }
        return FileReceipt(identity: Identity(dev: UInt64(value.st_dev), ino: UInt64(value.st_ino), uid: value.st_uid, mode: UInt32(value.st_mode)), sha256: digest)
    }
    static func decodePublish(_ data: Data) throws -> PublishInput {
        guard data.count <= 140000,
              let outer = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(outer.keys) == ["context", "request"],
              let context = outer["context"] as? [String: Any], Set(context.keys) == ["home", "stateRoot"],
              let request = outer["request"] as? [String: Any],
              Set(request.keys) == ["id", "directoryIdentity", "revision", "parentSHA256", "bytes"],
              let identity = request["directoryIdentity"] as? [String: Any],
              Set(identity.keys) == ["dev", "ino", "uid", "mode"] else { throw Failure.invalid }
        return try JSONDecoder().decode(PublishInput.self, from: data)
    }
    static func publish(_ input: PublishInput) throws -> Published {
        let request = input.request, bytes = Data(request.bytes.utf8)
        guard (0...512).contains(request.revision), bytes.count > 0, bytes.count <= 65536 else { throw Failure.invalid }
        let record = try record(input.context, id: request.id, identity: request.directoryIdentity)
        let journal: Journal
        var prior: Head?
        if request.revision == 0 {
            guard request.parentSHA256 == nil else { throw Failure.invalid }
            journal = try JSONDecoder().decode(Journal.self, from: bytes)
        } else {
            let head = try readChain(record), frame = try JSONDecoder().decode(Frame.self, from: bytes)
            guard head.revision + 1 == request.revision, request.parentSHA256 == head.sha256,
                  frame.version == 1, frame.sequence == request.revision,
                  frame.parentSHA256 == head.sha256 else { throw Failure.conflict }
            journal = frame.journal; prior = head
        }
        guard journal.version == 2, journal.plan.id == request.id,
              journal.directoryIdentity == request.directoryIdentity else { throw Failure.invalid }
        try record.verify()
        // The descriptor is pinned to the owned directory. A path replacement
        // cannot redirect this exclusive creation into a foreign directory.
        #if RELAY_BACKUP_MOVE_TESTS
        try beforeJournalCreate?()
        #endif
        try record.verify()
        if let prior = prior {
            let latest = try readChain(record)
            guard latest.revision == prior.revision, latest.sha256 == prior.sha256 else { throw Failure.conflict }
        }
        let fd = openat(record.fd, revisionName(request.revision), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.conflict }
        defer { Darwin.close(fd) }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw Failure.uncertain }; offset += count
            }
        }
        guard fsync(fd) == 0, fsync(record.fd) == 0 else { throw Failure.uncertain }
        try record.verify()
        let head = try readChain(record)
        guard head.revision == request.revision, head.sha256 == hash(bytes) else { throw Failure.uncertain }
        return Published()
    }
    static func decode(_ data: Data) throws -> Input {
        guard data.count <= 8192,
              let outer = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(outer.keys) == ["context", "request"],
              let context = outer["context"] as? [String: Any], Set(context.keys) == ["home", "stateRoot"],
              let request = outer["request"] as? [String: Any],
              Set(request.keys) == ["id", "root", "operation", "directoryIdentity", "sourceIdentity", "journalRevision", "journalSHA256"] else { throw Failure.invalid }
        for key in ["directoryIdentity", "sourceIdentity"] {
            guard let value = request[key] as? [String: Any], Set(value.keys) == ["dev", "ino", "uid", "mode"] else { throw Failure.invalid }
        }
        return try JSONDecoder().decode(Input.self, from: data)
    }
    static func perform(_ input: Input) throws -> Report {
        let context = input.context, request = input.request
        guard canonical(context.home), canonical(context.stateRoot),
              ["Relay", "Relay-Preview"].contains(where: {
                  context.stateRoot == context.home + "/Library/Application Support/" + $0
              }),
              request.id.range(of: "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$", options: .regularExpression) != nil,
              directories.contains(request.root) || files.contains(request.root) else { throw Failure.invalid }
        let slots: (String, String)
        switch request.operation {
        case "park-original": slots = ("current", "original")
        case "activate-candidate": slots = ("candidate", "current")
        case "park-restored": slots = ("current", "displaced")
        case "restore-original": slots = ("original", "current")
        default: throw Failure.invalid
        }
        let state = ["Library", "Application Support", context.stateRoot.hasSuffix("/Relay-Preview") ? "Relay-Preview" : "Relay"]
        let recordParts = state + ["ApplicationBackups", "restore-" + request.id]
        let record = try Chain(home: context.home, components: recordParts)
        var recordStat = stat()
        guard fstat(record.fd, &recordStat) == 0, request.directoryIdentity.matches(recordStat),
              recordStat.st_mode & 0o7777 == 0o700 else { throw Failure.conflict }
        let head = try readChain(record), journal = head.journal
        guard head.revision == request.journalRevision, head.sha256 == request.journalSHA256 else { throw Failure.conflict }
        guard journal.version == 2, journal.plan.id == request.id,
              journal.directoryIdentity == request.directoryIdentity, let intent = journal.intent,
              intent.root == request.root, intent.from == slots.0, intent.to == slots.1,
              intent.identity == request.sourceIdentity else { throw Failure.conflict }
        let parts = request.root.split(separator: "/").map(String.init), leaf = parts.last!
        func parent(_ slot: String, create: Bool) throws -> Chain {
            if slot == "current" {
                return try Chain(parent: record, ancestorDepth: state.count + 1, components: Array(parts.dropLast()), create: create)
            }
            return try Chain(parent: record, components: [slot] + parts.dropLast(), create: create)
        }
        let source = try parent(slots.0, create: false), destination = try parent(slots.1, create: true)
        var original = stat(), absent = stat()
        guard fstatat(source.fd, leaf, &original, AT_SYMLINK_NOFOLLOW) == 0,
              request.sourceIdentity.matches(original), original.st_mode & 0o7022 == 0,
              original.st_mode & mode_t(S_IFMT) == mode_t(directories.contains(request.root) ? S_IFDIR : S_IFREG),
              directories.contains(request.root) || original.st_nlink == 1,
              fstatat(destination.fd, leaf, &absent, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw Failure.conflict }
        try record.verify(); try source.verify(); try destination.verify()
        let currentHead = try readChain(record)
        guard currentHead.revision == head.revision, currentHead.sha256 == head.sha256 else { throw Failure.conflict }
        #if RELAY_BACKUP_MOVE_TESTS
        try beforeRename?()
        #endif
        try record.verify(); try source.verify(); try destination.verify()
        var finalSource = stat()
        let finalHead = try readChain(record)
        guard fstatat(source.fd, leaf, &finalSource, AT_SYMLINK_NOFOLLOW) == 0,
              request.sourceIdentity.matches(finalSource), finalSource.st_nlink == original.st_nlink,
              finalHead.revision == head.revision, finalHead.sha256 == head.sha256 else { throw Failure.conflict }

        guard renameatx_np(source.fd, leaf, destination.fd, leaf, UInt32(RENAME_EXCL)) == 0 else { throw Failure.conflict }
        guard fsync(source.fd) == 0, fsync(destination.fd) == 0 else { throw Failure.uncertain }
        var moved = stat(), missing = stat()
        guard fstatat(destination.fd, leaf, &moved, AT_SYMLINK_NOFOLLOW) == 0,
              request.sourceIdentity.matches(moved),
              fstatat(source.fd, leaf, &missing, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw Failure.uncertain }
        try record.verify(); try source.verify(); try destination.verify()
        return Report()
    }
}
