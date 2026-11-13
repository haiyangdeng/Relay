import Foundation
import Darwin
import CryptoKit

// Compile with -D RELAY_BACKUP_MOVE_TESTS and RelayBackupMove.swift only.
// Every path belongs to a newly created private fixture; no App is launched.
@main struct BackupPublicationTests {
    struct Failure: Error { let message: String }
    static let fm = FileManager.default
    static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !condition() { throw Failure(message: message) }
    }
    static func mustRefuse(_ action: () throws -> Void) throws {
        var refused = false
        do { try action() } catch { refused = true }
        try require(refused, "the operation unexpectedly succeeded")
    }
    static func hash(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    static func mkdir(_ path: String) throws {
        try fm.createDirectory(atPath: path, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
    }
    static func write(_ path: String, _ text: String) throws {
        try Data(text.utf8).write(to: URL(fileURLWithPath: path))
        guard chmod(path, 0o600) == 0 else { throw Failure(message: "fixture chmod failed") }
    }
    static func read(_ path: String) throws -> String {
        try String(contentsOfFile: path, encoding: .utf8)
    }
    static func identity(_ path: String) throws -> RelayBackupMove.Identity {
        var value = stat()
        guard lstat(path, &value) == 0 else { throw Failure(message: "fixture stat failed") }
        return RelayBackupMove.Identity(dev: UInt64(value.st_dev), ino: UInt64(value.st_ino),
                                         uid: value.st_uid, mode: UInt32(value.st_mode))
    }
    struct Fixture {
        let home: String
        let context: RelayBackupMove.Context
        let id: String
        let directory: String
        let recordIdentity: RelayBackupMove.Identity
    }
    static func fixture(_ namespace: String = "recovery", _ action: (Fixture) throws -> Void) throws {
        let home = "/private/tmp/relay-backup-publication-native-" + UUID().uuidString.lowercased()
        try mkdir(home)
        defer {
            RelayBackupMove.beforeJournalCreate = nil
            RelayBackupMove.beforeFileCreate = nil
            RelayBackupMove.beforeRename = nil
            try? fm.removeItem(atPath: home)
        }
        let state = home + "/Library/Application Support/Relay", id = UUID().uuidString.lowercased()
        let directory = state + (namespace == "migration" ? "/Migrations/" + id : "/ApplicationBackups/restore-" + id)
        try mkdir(directory)
        try action(Fixture(home: home, context: RelayBackupMove.Context(home: home, stateRoot: state),
                           id: id, directory: directory, recordIdentity: identity(directory)))
    }
    static func journal(_ f: Fixture, intent: Bool = false) throws -> Data {
        let encodedIdentity = try JSONSerialization.jsonObject(with: JSONEncoder().encode(f.recordIdentity))
        var item: [String: Any] = ["version": 2, "plan": ["id": f.id], "directoryIdentity": encodedIdentity]
        if intent {
            item["intent"] = ["root": "preferences.json", "from": "current", "to": "original",
                              "identity": try JSONSerialization.jsonObject(with: JSONEncoder().encode(identity(f.context.stateRoot + "/preferences.json")))]
        }
        // The native capability checks paths, identities, chain and exact intent;
        // the main-process store separately validates the complete journal schema.
        return try JSONSerialization.data(withJSONObject: item, options: [.sortedKeys])
    }
    static func publish(_ f: Fixture, bytes: Data, revision: Int = 0, parent: String? = nil) throws {
        _ = try RelayBackupMove.publish(RelayBackupMove.PublishInput(context: f.context,
            request: RelayBackupMove.PublishRequest(id: f.id, directoryIdentity: f.recordIdentity,
                revision: revision, parentSHA256: parent, bytes: String(decoding: bytes, as: UTF8.self))))
    }
    static func next(_ f: Fixture, anchor: Data) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["version": 1, "sequence": 1,
            "parentSHA256": hash(anchor), "journal": JSONSerialization.jsonObject(with: anchor)], options: [.sortedKeys])
    }
    static func publishFile(_ f: Fixture, name: String = "original.zip") throws {
        _ = try RelayBackupMove.publishFile(RelayBackupMove.FileInput(context: f.context,
            request: RelayBackupMove.FileRequest(namespace: "migration", id: f.id,
                directoryIdentity: f.recordIdentity, name: name, mode: 0o600,
                bytes: Data("FIXTURE-SECRET".utf8).base64EncodedString(), directory: nil)))
    }
    static func move(_ f: Fixture, anchor: Data) throws {
        _ = try RelayBackupMove.perform(RelayBackupMove.Input(context: f.context,
            request: RelayBackupMove.Request(journalRevision: 0, journalSHA256: hash(anchor), id: f.id,
                root: "preferences.json", operation: "park-original", directoryIdentity: f.recordIdentity,
                sourceIdentity: identity(f.context.stateRoot + "/preferences.json"))))
    }
    static func main() throws {
        var checks = [String]()
        try fixture { f in
            let anchor = try journal(f)
            try publish(f, bytes: anchor)
            let leaf = f.directory + "/journal-000001.json"
            RelayBackupMove.beforeJournalCreate = { try write(leaf, "FOREIGN-JOURNAL") }
            try mustRefuse { try publish(f, bytes: next(f, anchor: anchor), revision: 1, parent: hash(anchor)) }
            try require(read(leaf) == "FOREIGN-JOURNAL", "foreign journal was overwritten")
            try require(Data(contentsOf: URL(fileURLWithPath: f.directory + "/journal.json")) == anchor, "anchor changed")
            checks.append("late journal publication refuses an existing foreign revision without overwriting it")
        }
        try fixture { f in
            let anchor = try journal(f)
            try publish(f, bytes: anchor)
            RelayBackupMove.beforeJournalCreate = {
                try fm.moveItem(atPath: f.directory, toPath: f.directory + "-retained")
                try mkdir(f.directory); try write(f.directory + "/foreign", "KEEP")
            }
            try mustRefuse { try publish(f, bytes: next(f, anchor: anchor), revision: 1, parent: hash(anchor)) }
            try require(fm.contentsOfDirectory(atPath: f.directory) == ["foreign"], "replacement directory received a journal")
            try require(read(f.directory + "/foreign") == "KEEP", "foreign data changed")
            checks.append("late record-directory substitution receives no journal or secret content")
        }
        try fixture("migration") { f in
            RelayBackupMove.beforeFileCreate = { try write(f.directory + "/original.zip", "FOREIGN-ARCHIVE") }
            try mustRefuse { try publishFile(f) }
            try require(read(f.directory + "/original.zip") == "FOREIGN-ARCHIVE", "foreign archive overwritten")
            checks.append("late original-archive collision preserves the foreign file")
        }
        try fixture("migration") { f in
            RelayBackupMove.beforeFileCreate = {
                try fm.moveItem(atPath: f.directory, toPath: f.directory + "-retained")
                try mkdir(f.directory); try write(f.directory + "/foreign", "KEEP")
            }
            try mustRefuse { try publishFile(f) }
            try require(fm.contentsOfDirectory(atPath: f.directory) == ["foreign"], "replacement directory received secret content")
            checks.append("late migration-directory substitution cannot redirect original secret bytes")
        }
        try fixture { f in
            RelayBackupMove.beforeFileCreate = {
                try fm.moveItem(atPath: f.directory, toPath: f.directory + "-retained")
                try mkdir(f.directory); try write(f.directory + "/foreign", "KEEP")
            }
            try mustRefuse {
                _ = try RelayBackupMove.publishFile(RelayBackupMove.FileInput(context: f.context,
                    request: RelayBackupMove.FileRequest(namespace: "recovery", id: f.id,
                        directoryIdentity: f.recordIdentity, name: "candidate/Configuration",
                        mode: 0o700, bytes: "", directory: true)))
            }
            try require(fm.contentsOfDirectory(atPath: f.directory) == ["foreign"], "replacement directory received staging directories")
            checks.append("pinned mkdirat cannot add staging directories into a substituted record")
        }
        for substituteSource in [false, true] {
            try fixture { f in
                let source = f.context.stateRoot + "/preferences.json", target = f.directory + "/original/preferences.json"
                try mkdir(f.directory + "/original"); try write(source, "OWNED-BASELINE")
                let anchor = try journal(f, intent: true)
                try publish(f, bytes: anchor)
                RelayBackupMove.beforeRename = {
                    if substituteSource {
                        try fm.moveItem(atPath: source, toPath: source + ".retained")
                        try write(source, "FOREIGN-SOURCE")
                    } else { try write(target, "FOREIGN-TARGET") }
                }
                try mustRefuse { try move(f, anchor: anchor) }
                if substituteSource {
                    try require(read(source) == "FOREIGN-SOURCE", "foreign source moved")
                    try require(!fm.fileExists(atPath: target), "foreign source published to target")
                    try require(read(source + ".retained") == "OWNED-BASELINE", "owned baseline changed")
                } else {
                    try require(read(target) == "FOREIGN-TARGET", "foreign destination overwritten")
                    try require(read(source) == "OWNED-BASELINE", "owned source moved despite destination conflict")
                }
                checks.append(substituteSource ? "late source substitution is rechecked and refused before moving it" : "RENAME_EXCL preserves a destination appearing at the final syscall boundary")
            }
        }
        let evidence: [String: Any] = ["scope": "Darwin backup publication and move race fixtures", "checks": checks,
            "passed": checks.count, "realNativeSyscalls": true, "actualUserDataTouched": false, "systemNetworkChanged": false]
        print(String(decoding: try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
