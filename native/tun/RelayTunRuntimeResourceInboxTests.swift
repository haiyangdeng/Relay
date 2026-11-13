import Foundation
import Darwin

private typealias M = RelayTunRuntimeResources
private typealias Inbox = RelayTunRuntimeResourceInbox
private enum TestError: Error { case failed(String), cancelled }
private func expect(_ condition: @autoclosure () throws -> Bool, _ name: String = "assertion") throws {
    guard try condition() else { throw TestError.failed(name) }
}
private func rejects(_ body: () throws -> Void) throws {
    do { try body() } catch { return }; throw TestError.failed("expected rejection")
}
private let blobID = "11111111-1111-4111-8111-111111111111"
private let bootID = "22222222-2222-4222-8222-222222222222"
private func temp(_ pattern: String) throws -> String {
    var bytes = Array(pattern.utf8CString)
    guard mkdtemp(&bytes) != nil else { throw TestError.failed("mkdtemp") }
    return String(cString: bytes)
}
private func put(_ path: String, _ data: Data) throws {
    try data.write(to: URL(fileURLWithPath: path), options: .withoutOverwriting)
    guard chmod(path, 0o600) == 0 else { throw TestError.failed("chmod") }
}
private func bytes(_ path: String) throws -> Data { try Data(contentsOf: URL(fileURLWithPath: path)) }
private final class Fixture {
    let source: String, home: String, sourceIdentity: stat, homeIdentity: stat
    var reader: Inbox?
    init() throws {
        source = try temp("/private/tmp/relay-geo-main-\(getuid())-tests-XXXXXX")
        home = try temp("/private/tmp/relay-session-\(getuid())-inbox-tests-XXXXXX")
        var a = stat(), b = stat()
        guard lstat(source, &a) == 0, lstat(home, &b) == 0 else { throw TestError.failed("identity") }
        sourceIdentity = a; homeIdentity = b
    }
    func open() throws -> Inbox {
        let value = try Inbox(sourceRoot: source, coreHome: home); reader = value; return value
    }
    func add(_ kind: M.Kind = .geosite, id: String = blobID, data: Data = Data("fixture bytes".utf8)) throws -> M.Selection {
        guard mkdir(source + "/" + id, 0o700) == 0 else { throw TestError.failed("source mkdir") }
        try put(source + "/" + id + "/" + kind.basename, data)
        return try .init(kind: kind, configurationRevision: String(repeating: "a", count: 64),
            expectedGenerationSHA256: String(repeating: "b", count: 64), oldSHA256: String(repeating: "c", count: 64),
            newSHA256: M.digest(data), blobId: id, selector: "fixture", bytes: data.count)
    }
    func addProvider(_ kind: Inbox.ProviderKind = .yaml, id: String = blobID, data: Data = Data("synthetic provider bytes".utf8)) throws -> Inbox.ProviderTicket {
        guard mkdir(source + "/" + id, 0o700) == 0 else { throw TestError.failed("provider mkdir") }
        let filename = id + "." + kind.suffix; try put(source + "/" + id + "/" + filename, data)
        return try .init(blobId: id, kind: kind, sha256: M.digest(data), bytes: data.count, filename: filename)
    }
    func stagePath(_ s: M.Selection) -> String { home + "/RelayGeoInbox/" + s.blobId + "/" + s.kind.basename }
    func cleanupFixture() throws {
        reader = nil
        // Only synthetic test-owned roots are removed; substitutions survive.
        for (path, original) in [(source, sourceIdentity), (home, homeIdentity)] {
            var current = stat()
            guard lstat(path, &current) == 0, current.st_dev == original.st_dev, current.st_ino == original.st_ino,
                  current.st_uid == getuid(), current.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
                throw TestError.failed("changed fixture root retained")
            }
            try FileManager.default.removeItem(atPath: path)
        }
    }
}
@main private struct ResourceInboxTests {
    static func main() {
        guard getuid() > 0, getuid() == geteuid() else { exit(77) }
        var rows = [[String: Any]]()
        func test(_ name: String, _ body: (Fixture) throws -> Void) {
            var fixture: Fixture?, failure: Error?, cleanupError: Error?
            do { let f = try Fixture(); fixture = f; try body(f) } catch { failure = error }
            do { try fixture?.cleanupFixture() } catch { cleanupError = error }
            var row: [String: Any] = ["name": name, "passed": failure == nil && cleanupError == nil]
            if let failure { row["error"] = String(describing: failure) }
            if let cleanupError {
                row["cleanupError"] = String(describing: cleanupError)
                row["retainedSource"] = fixture?.source; row["retainedHome"] = fixture?.home
            }
            rows.append(row)
        }
        test("four fixed names copy exact verified bytes and preserve source") { f in
            let r = try f.open()
            for kind in M.Kind.allCases {
                let s = try f.add(kind, id: UUID().uuidString.lowercased()), blob = try r.read(s, check: {})
                try r.stage(s, blob: blob, check: {})
                try expect(bytes(f.stagePath(s)) == blob.data)
            }
            try expect(r.inventory.count == 9); try r.cleanup(); try r.cleanup()
            try expect(!FileManager.default.fileExists(atPath: f.home + "/RelayGeoInbox"))
            try expect(FileManager.default.contentsOfDirectory(atPath: f.source).count == 4)
        }
        test("consume retains immutable Data while deleting only its typed source") { f in
            let r = try f.open(), s = try f.add(), blob = try r.consume(s, check: {})
            try expect(!FileManager.default.fileExists(atPath: f.source + "/" + blobID))
            try r.stage(s, blob: blob, check: {}); try expect(bytes(f.stagePath(s)) == blob.data)
            try r.cleanup()
        }
        test("discard is spool-only and does not grant staging authority") { f in
            let r = try f.open(), s = try f.add(), blob = try r.read(s, check: {})
            try r.discardBlob(s)
            try expect(!FileManager.default.fileExists(atPath: f.source + "/" + blobID))
            try rejects { try r.stage(s, blob: blob, check: {}) }
            try expect(r.inventory.count == 1); try r.cleanup()
        }
        test("discard ACK is discarded once then absent only with matching tombstone") { f in
            let r = try f.open(), s = try f.add()
            try expect(r.discardBlob(s) == .discarded); try expect(r.discardBlob(s) == .absent)
            let wrong = try Inbox.Ticket(blobId: s.blobId, kind: s.kind, sha256: s.newSHA256, bytes: s.bytes, selector: "changed")
            try rejects { _ = try r.discardBlob(wrong) }
        }
        test("unregistered absence is never acknowledged") { f in
            let r = try f.open(), s = try f.add()
            try FileManager.default.removeItem(atPath: f.source + "/" + blobID)
            try rejects { _ = try r.discardBlob(s) }
        }
        test("consume and stage finish with neutral absent ACK") { f in
            let r = try f.open(), s = try f.add(), blob = try r.consume(s, check: {})
            try r.stage(s, blob: blob, check: {}); try expect(r.discardBlob(s) == .absent)
            try expect(bytes(f.stagePath(s)) == blob.data); try r.cleanup()
        }
        test("foreign reappearance cannot be deleted by a tombstone ACK") { f in
            let r = try f.open(), s = try f.add()
            try expect(r.discardBlob(s) == .discarded)
            try expect(mkdir(f.source + "/" + blobID, 0o700) == 0)
            try put(f.source + "/" + blobID + "/GeoSite.dat", Data("FOREIGN".utf8))
            try rejects { _ = try r.discardBlob(s) }
            try expect(bytes(f.source + "/" + blobID + "/GeoSite.dat") == Data("FOREIGN".utf8))
        }
        test("IO callback can observe metadata and concurrent discard reports busy") { f in
            let r = try f.open(), s = try f.add(); var sawBusy = false
            _ = try r.read(s) {
                _ = r.inventory
                do { _ = try r.discardBlob(s) }
                catch Inbox.Failure.busy { sawBusy = true }
                catch { throw error }
            }
            try expect(sawBusy)
        }
        test("unknown source sibling blocks deletion before touching known blob") { f in
            let r = try f.open(), s = try f.add(), path = f.source + "/" + blobID
            try put(path + "/FOREIGN", Data([8]))
            try rejects { try r.discardBlob(s) }
            try expect(FileManager.default.fileExists(atPath: path + "/GeoSite.dat"))
            try expect(bytes(path + "/FOREIGN") == Data([8]))
        }
        test("unknown source sibling added by the last observer preserves the known blob") { f in
            let r = try f.open(), s = try f.add(), path = f.source + "/" + blobID
            var calls = 0
            try rejects {
                _ = try r.consume(s) {
                    calls += 1
                    if calls == 7 { try put(path + "/FOREIGN", Data([8])) }
                }
            }
            try expect(calls == 7)
            try expect(bytes(path + "/GeoSite.dat") == Data("fixture bytes".utf8))
            try expect(bytes(path + "/FOREIGN") == Data([8]))
        }
        test("bad SHA discard cannot delete the material") { f in
            let r = try f.open(), s = try f.add()
            let bad = try M.Selection(kind: s.kind, configurationRevision: s.configurationRevision,
                expectedGenerationSHA256: s.expectedGenerationSHA256, oldSHA256: s.oldSHA256,
                newSHA256: String(repeating: "f", count: 64), blobId: blobID, selector: s.selector, bytes: s.bytes)
            try rejects { try r.discardBlob(bad) }
            try expect(FileManager.default.fileExists(atPath: f.source + "/" + blobID + "/GeoSite.dat"))
        }
        test("cancel before consume deletes nothing") { f in
            let r = try f.open(), s = try f.add()
            try rejects { _ = try r.consume(s, check: { throw TestError.cancelled }) }
            try expect(FileManager.default.fileExists(atPath: f.source + "/" + blobID + "/GeoSite.dat"))
        }
        test("pre-existing Core inbox is never adopted") { f in
            try expect(mkdir(f.home + "/RelayGeoInbox", 0o700) == 0)
            try put(f.home + "/RelayGeoInbox/FOREIGN", Data([1]))
            try rejects { _ = try f.open() }
            try expect(bytes(f.home + "/RelayGeoInbox/FOREIGN") == Data([1]))
        }
        test("nonprivate or symlink source root is rejected") { f in
            try expect(chmod(f.source, 0o755) == 0); try rejects { _ = try f.open() }
            try expect(chmod(f.source, 0o700) == 0)
            let alias = f.source + "-alias"
            try FileManager.default.createSymbolicLink(atPath: alias, withDestinationPath: f.source)
            defer { try? FileManager.default.removeItem(atPath: alias) }
            try rejects { _ = try Inbox(sourceRoot: alias, coreHome: f.home) }
        }
        test("source file symlink is not followed") { f in
            let r = try f.open(), s = try f.add(), file = f.source + "/" + blobID + "/GeoSite.dat"
            try put(f.source + "/foreign", Data([9])); try FileManager.default.removeItem(atPath: file)
            try FileManager.default.createSymbolicLink(atPath: file, withDestinationPath: f.source + "/foreign")
            try rejects { _ = try r.read(s, check: {}) }; try expect(bytes(f.source + "/foreign") == Data([9]))
        }
        test("hardlink and nonprivate file mode are rejected") { f in
            let r = try f.open(), s = try f.add(), file = f.source + "/" + blobID + "/GeoSite.dat"
            try expect(chmod(file, 0o644) == 0); try rejects { _ = try r.read(s, check: {}) }
            try expect(chmod(file, 0o600) == 0 && link(file, f.source + "/alias") == 0)
            try rejects { _ = try r.read(s, check: {}) }
        }
        test("in-place mutation during a bounded read is detected") { f in
            let r = try f.open(), s = try f.add(data: Data(repeating: 1, count: 70000)); var calls = 0
            try rejects {
                _ = try r.read(s) {
                    calls += 1
                    if calls == 4 { try Data(repeating: 2, count: 70000).write(to: URL(fileURLWithPath: f.source + "/" + blobID + "/GeoSite.dat")) }
                }
            }
            try expect(calls >= 4 && r.inventory.count == 1)
        }
        test("source replaced after read cannot stage identical new inode") { f in
            let r = try f.open(), s = try f.add(), blob = try r.read(s, check: {})
            let file = f.source + "/" + blobID + "/GeoSite.dat"
            try FileManager.default.moveItem(atPath: file, toPath: file + ".saved"); try put(file, blob.data)
            try rejects { try r.stage(s, blob: blob, check: {}) }
            try expect(FileManager.default.contentsOfDirectory(atPath: f.home + "/RelayGeoInbox").isEmpty)
        }
        test("a consumed UUID reappearing as foreign data blocks staging") { f in
            let r = try f.open(), s = try f.add(), blob = try r.consume(s, check: {})
            try expect(mkdir(f.source + "/" + blobID, 0o700) == 0)
            try put(f.source + "/" + blobID + "/GeoSite.dat", Data("FOREIGN".utf8))
            try rejects { try r.stage(s, blob: blob, check: {}) }
            try expect(bytes(f.source + "/" + blobID + "/GeoSite.dat") == Data("FOREIGN".utf8))
        }
        test("Core inbox substitution cannot redirect staging") { f in
            let r = try f.open(), s = try f.add(), blob = try r.read(s, check: {})
            let path = f.home + "/RelayGeoInbox", saved = f.home + "/saved"
            try FileManager.default.moveItem(atPath: path, toPath: saved); try expect(mkdir(path, 0o700) == 0)
            defer { try? FileManager.default.removeItem(atPath: path); try? FileManager.default.moveItem(atPath: saved, toPath: path) }
            try put(path + "/FOREIGN", Data([8])); try rejects { try r.stage(s, blob: blob, check: {}) }
            try expect(bytes(path + "/FOREIGN") == Data([8]))
            try expect(FileManager.default.contentsOfDirectory(atPath: saved).isEmpty)
        }
        test("partial cancelled stage is registered for exact cleanup") { f in
            let r = try f.open(), s = try f.add(data: Data(repeating: 1, count: 150000)), blob = try r.read(s, check: {})
            var calls = 0
            try rejects { try r.stage(s, blob: blob) { calls += 1; if calls == 5 { throw TestError.cancelled } } }
            try expect(r.inventory.count >= 2); try r.cleanup()
        }
        test("unknown staged sibling blocks all registered deletions") { f in
            let r = try f.open(), s = try f.add(), blob = try r.read(s, check: {})
            try r.stage(s, blob: blob, check: {})
            let foreign = f.home + "/RelayGeoInbox/" + blobID + "/FOREIGN"; try put(foreign, Data([7]))
            try rejects { try r.cleanup() }
            try expect(FileManager.default.fileExists(atPath: f.stagePath(s)) && FileManager.default.fileExists(atPath: foreign))
            try FileManager.default.removeItem(atPath: foreign); try r.cleanup()
        }
        test("staged UUID cannot be overwritten or reused") { f in
            let r = try f.open(), s = try f.add(), blob = try r.read(s, check: {})
            try r.stage(s, blob: blob, check: {}); try rejects { try r.stage(s, blob: blob, check: {}) }
            try expect(bytes(f.stagePath(s)) == blob.data)
        }
        test("terminal stage cleanup is scoped and permits the next fresh operation") { f in
            let r = try f.open(), s = try f.add(), blob = try r.consume(s, check: {})
            try r.stage(s, blob: blob, check: {}); try r.cleanupStage(s.blobId); try r.cleanupStage(s.blobId)
            try expect(r.discardBlob(s) == .absent)
            let next = try f.add(.asn, id: UUID().uuidString.lowercased()), nextBlob = try r.consume(next, check: {})
            try r.stage(next, blob: nextBlob, check: {}); try expect(bytes(f.stagePath(next)) == nextBlob.data)
            try r.cleanup()
        }
        test("terminal stage tombstone only succeeds while its UUID remains absent") { f in
            let r = try f.open(), s = try f.add(), blob = try r.read(s, check: {})
            try r.stage(s, blob: blob, check: {}); try r.cleanupStage(s.blobId)
            let path = f.home + "/RelayGeoInbox/" + s.blobId
            try expect(mkdir(path, 0o700) == 0); try put(path + "/FOREIGN", Data([8]))
            try rejects { try r.cleanupStage(s.blobId) }
            try expect(bytes(path + "/FOREIGN") == Data([8]))
        }
        test("unknown sibling blocks scoped stage cleanup without closing the reader") { f in
            let r = try f.open(), s = try f.add(), blob = try r.read(s, check: {})
            try r.stage(s, blob: blob, check: {})
            let foreign = f.home + "/RelayGeoInbox/" + blobID + "/FOREIGN"; try put(foreign, Data([1]))
            try rejects { try r.cleanupStage(s.blobId) }; try expect(FileManager.default.fileExists(atPath: f.stagePath(s)))
            try FileManager.default.removeItem(atPath: foreign); try r.cleanupStage(s.blobId)
            let next = try f.add(.asn, id: UUID().uuidString.lowercased()), nextBlob = try r.read(next, check: {})
            try r.stage(next, blob: nextBlob, check: {}); try r.cleanup()
        }
        test("changed staged inode with identical bytes prevents cleanup") { f in
            let r = try f.open(), s = try f.add(), blob = try r.read(s, check: {})
            try r.stage(s, blob: blob, check: {})
            try FileManager.default.moveItem(atPath: f.stagePath(s), toPath: f.home + "/saved-stage")
            try put(f.stagePath(s), blob.data); try rejects { try r.cleanup() }
            try expect(FileManager.default.fileExists(atPath: f.stagePath(s)))
        }
        func retained(_ f: Fixture, foreign: Bool) throws {
            let r = try f.open(), data = Data("old".utf8), nonce = String(repeating: "d", count: 64)
            let active = f.home + "/GeoSite.dat", saved = f.home + "/RelayGeo.retained-" + nonce
            try put(active, data); var info = stat(); try expect(lstat(active, &info) == 0)
            let id = try M.FileIdentity(device: UInt64(UInt32(bitPattern: info.st_dev)), inode: UInt64(info.st_ino),
                ownerUID: getuid(), mode: UInt32(info.st_mode), links: 1, bytes: data.count, modifiedNS: 1, changedNS: 1)
            let old = try M.Resource(kind: .geosite, sha256: M.digest(data), identity: id, active: true)
            let receipt = M.Receipt(bootId: bootID, kind: .geosite, oldSHA256: old.sha256, newSHA256: String(repeating: "e", count: 64),
                bytes: 4, previousGenerationSHA256: String(repeating: "a", count: 64), generationSHA256: String(repeating: "b", count: 64),
                sequence: 1, retainedOriginal: true)
            if foreign {
                try put(saved, data)
                try rejects { try r.registerRetained(nonce: nonce, previous: old, applied: receipt, check: {}) }
                try expect(r.inventory.count == 1); try r.cleanup(); try expect(bytes(saved) == data)
            } else {
                try FileManager.default.moveItem(atPath: active, toPath: saved); try put(active, Data("next".utf8))
                try r.registerRetained(nonce: nonce, previous: old, applied: receipt, check: {})
                try expect(r.inventory.count == 2); try r.cleanup(); try expect(bytes(active) == Data("next".utf8))
            }
        }
        test("same retained name and SHA cannot adopt a foreign inode") { try retained($0, foreign: true) }
        test("matched old retained inode is registered without deleting active data") { try retained($0, foreign: false) }
        test("three provider kinds consume exact bytes through shared source-root engine") { f in
            let r = try f.open()
            for kind in [Inbox.ProviderKind.yaml, .text, .mrs] {
                let t = try f.addProvider(kind, id: UUID().uuidString.lowercased()), blob = try r.consumeProvider(t, check: {})
                try expect(blob.ticket == t && M.digest(blob.data) == t.sha256 && blob.identity.ownerUID == getuid())
                try expect(!FileManager.default.fileExists(atPath: f.source + "/" + t.blobId))
                try expect(r.discardProviderBlob(t) == .absent)
            }
            try expect(r.inventory.count == 1)
        }
        test("provider ticket requires version4 canonical UUID and exact filename/budget") { _ in
            let hash = String(repeating: "a", count: 64)
            for id in ["11111111-1111-1111-8111-111111111111", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "bad"] {
                try rejects { _ = try Inbox.ProviderTicket(blobId: id, kind: .yaml, sha256: hash, bytes: 1, filename: id + ".yaml") }
            }
            try rejects { _ = try Inbox.ProviderTicket(blobId: blobID, kind: .yaml, sha256: hash, bytes: 1, filename: "../foreign") }
            try rejects { _ = try Inbox.ProviderTicket(blobId: blobID, kind: .text, sha256: hash, bytes: 8 * 1024 * 1024 + 1, filename: blobID + ".text") }
        }
        test("one UUID cannot be reinterpreted across Geo and provider families") { f in
            let r = try f.open(), geo = try f.add(), provider = try Inbox.ProviderTicket(blobId: blobID, kind: .yaml, sha256: geo.newSHA256, bytes: geo.bytes, filename: blobID + ".yaml")
            _ = try r.read(geo, check: {}); try rejects { _ = try r.consumeProvider(provider, check: {}) }
            try expect(FileManager.default.fileExists(atPath: f.source + "/" + blobID + "/" + geo.kind.basename))
        }
        test("provider removed ACK rejects different kind or reappeared UUID") { f in
            let r = try f.open(), t = try f.addProvider(); _ = try r.consumeProvider(t, check: {})
            let wrong = try Inbox.ProviderTicket(blobId: t.blobId, kind: .text, sha256: t.sha256, bytes: t.bytes, filename: t.blobId + ".text")
            try rejects { _ = try r.discardProviderBlob(wrong) }
            guard mkdir(f.source + "/" + t.blobId, 0o700) == 0 else { throw TestError.failed("reappear") }
            try put(f.source + "/" + t.blobId + "/" + t.filename, Data("foreign".utf8))
            try rejects { _ = try r.discardProviderBlob(t) }; try expect(bytes(f.source + "/" + t.blobId + "/" + t.filename) == Data("foreign".utf8))
        }
        test("provider final observer unknown sibling refuses before first unlink") { f in
            let r = try f.open(), t = try f.addProvider(); var calls = 0
            try rejects { _ = try r.consumeProvider(t, check: { calls += 1; if calls == 7 { try put(f.source + "/" + t.blobId + "/FOREIGN", Data([9])) } }) }
            try expect(FileManager.default.fileExists(atPath: f.source + "/" + t.blobId + "/" + t.filename))
            try expect(bytes(f.source + "/" + t.blobId + "/FOREIGN") == Data([9]))
        }
        test("provider final observer same-byte inode substitution is preserved") { f in
            let r = try f.open(), t = try f.addProvider(); var calls = 0
            let path = f.source + "/" + t.blobId + "/" + t.filename, original = try bytes(path)
            try rejects { _ = try r.consumeProvider(t, check: { calls += 1; if calls == 7 { guard unlink(path) == 0 else { throw TestError.failed("unlink") }; try put(path, original) } }) }
            try expect(bytes(path) == original)
        }
        test("provider declared bytes or SHA disagreement never removes source") { f in
            let r = try f.open(), t = try f.addProvider()
            for wrong in [try Inbox.ProviderTicket(blobId: t.blobId, kind: t.kind, sha256: t.sha256, bytes: 1, filename: t.filename), try Inbox.ProviderTicket(blobId: t.blobId, kind: t.kind, sha256: String(repeating: "a", count: 64), bytes: t.bytes, filename: t.filename)] {
                try rejects { _ = try r.consumeProvider(wrong, check: {}) }
            }
            try expect(FileManager.default.fileExists(atPath: f.source + "/" + t.blobId + "/" + t.filename))
        }
        test("text physical oversize fails stat bound before body chunks") { f in
            let r = try f.open(), t = try f.addProvider(.mrs, data: Data(repeating: 7, count: 8 * 1024 * 1024 + 1))
            let directory = f.source + "/" + t.blobId, name = t.blobId + ".text"
            guard rename(directory + "/" + t.filename, directory + "/" + name) == 0 else { throw TestError.failed("rename") }
            let wrong = try Inbox.ProviderTicket(blobId: t.blobId, kind: .text, sha256: t.sha256, bytes: 1, filename: name); var checks = 0
            try rejects { _ = try r.consumeProvider(wrong, check: { checks += 1 }) }; try expect(checks == 2 && FileManager.default.fileExists(atPath: directory + "/" + name))
        }
        test("cancel after real source removal retains exact absent ACK") { f in
            let r = try f.open(), t = try f.addProvider(); var checks = 0
            try rejects { _ = try r.consumeProvider(t, check: { checks += 1; if checks == 8 { throw TestError.cancelled } }) }
            try expect(r.discardProviderBlob(t) == .absent && !FileManager.default.fileExists(atPath: f.source + "/" + t.blobId))
        }
        let passed = rows.allSatisfy { $0["passed"] as? Bool == true }
        let report: [String: Any] = ["passed": passed, "checks": rows.count, "rows": rows,
            "scope": "ordinary UID owned temporary files only", "actualCoreStarted": false,
            "actualNetworkRequests": false, "actualHelperOrTUN": false, "systemConfigurationChanged": false]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            print(String(decoding: data, as: UTF8.self))
        }
        if !passed { exit(1) }
    }
}
