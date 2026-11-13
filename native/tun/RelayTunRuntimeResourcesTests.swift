import Foundation

/// Pure injected model: no Core, file, socket, helper, root or TUN action.
private typealias R = RelayTunRuntimeResources
private enum TestFailure: Error { case assertion(String), synthetic }
private func require(_ condition: @autoclosure () -> Bool, _ message: String = "assertion") throws {
    if !condition() { throw TestFailure.assertion(message) }
}
private func rejects(_ body: () throws -> Void) throws {
    do { try body() } catch { return }; throw TestFailure.assertion("expected rejection")
}
private func identity(_ inode: UInt64, uid: UInt32 = 501, bytes: Int) throws -> R.FileIdentity {
    try .init(device: 1, inode: inode, ownerUID: uid, mode: 0o100600, links: 1,
              bytes: bytes, modifiedNS: 1, changedNS: 2)
}
private let boot = "11111111-1111-4111-8111-111111111111"
private let blobID = "22222222-2222-4222-8222-222222222222"
private let configSHA = String(repeating: "a", count: 64)
private let initialHead = String(repeating: "b", count: 64)
private let nextHead = String(repeating: "c", count: 64)

private final class Fixture {
    var now: UInt64 = 1_000_000_000
    var owner: R.Owner
    var controller: R.Controller!
    var data = Data("new fixture bytes".utf8)
    var reads = 0, prepares = 0, commits = 0, writes = 0, ownerReads = 0, coreCancels = 0
    var replies = [R.Reply]()
    var ownerHook: (() -> Void)?
    var readHook: ((R.Selection, R.Access, @escaping (Result<R.Blob, Error>) -> Void) -> Void)?
    var prepareHook: ((R.Selection, R.Blob, R.Access, @escaping (Result<R.Prepared, Error>) -> Void) -> Void)?
    var commitHook: ((R.Prepared, R.Access, @escaping (Result<R.Publication, Error>) -> Void) -> Void)?
    var cancelHook: ((@escaping (Result<R.Cancellation, Error>) -> Void) -> Void)?
    init(kinds: [R.Kind] = R.Kind.allCases, lease: Int = R.defaultLeaseSeconds, sequence: UInt64 = 0,
         active: Bool = true, staticAssetBytes: Int = 0) throws {
        owner = try .init(heldGeneration: 7, configurationRevision: configSHA, coreBootId: boot, ordinaryUID: 501)
        let resources = try kinds.enumerated().map { offset, kind in
            let original = Data(("original-" + kind.rawValue).utf8)
            return try R.Resource(kind: kind, sha256: R.digest(original), identity: identity(UInt64(10 + offset), bytes: original.count), active: active)
        }
        let ledger = try R.Ledger(bootId: boot, generationSHA256: initialHead, sequence: sequence, resources: resources)
        let driver = R.Driver(currentOwner: { [unowned self] in
            self.ownerReads += 1; self.ownerHook?(); return self.owner
        }, readBlob: { [unowned self] selection, access, reply in
            self.reads += 1
            if let hook = self.readHook { hook(selection, access, reply); return }
            do { reply(.success(try self.blob(selection.kind))) } catch { reply(.failure(error)) }
        }, prepareCore: { [unowned self] selection, blob, access, reply in
            self.prepares += 1
            if let hook = self.prepareHook { hook(selection, blob, access, reply); return }
            reply(.success(self.prepared(selection)))
        }, commitCore: { [unowned self] prepared, access, reply in
            self.commits += 1
            if let hook = self.commitHook { hook(prepared, access, reply); return }
            do {
                try access.enterWrite(); self.writes += 1
                reply(.success(try self.publication(prepared)))
            } catch { reply(.failure(error)) }
        }, cancelPrepared: { [unowned self] _, _, _, reply in
            self.coreCancels += 1
            if let hook = self.cancelHook { hook(reply) } else { reply(.success(.cancelled)) }
        })
        controller = try .init(ledger: ledger, staticAssetBytes: staticAssetBytes, driver: driver,
                               leaseSeconds: lease, clock: { [unowned self] in self.now })
    }
    func blob(_ kind: R.Kind, id: String = blobID, uid: UInt32 = 501, data: Data? = nil) throws -> R.Blob {
        let bytes = data ?? self.data
        return try .init(id: id, kind: kind, data: bytes, identity: identity(50, uid: uid, bytes: bytes.count))
    }
    func selection(_ kind: R.Kind = .geosite, oldSHA: String? = nil, head: String? = nil,
                   revision: String = configSHA, newSHA: String? = nil, selector: String = "fixture", bytes: Int? = nil) throws -> R.Selection {
        try .init(kind: kind, configurationRevision: revision, expectedGenerationSHA256: head ?? controller.knownLedger.generationSHA256,
                  oldSHA256: oldSHA ?? controller.knownLedger.resources[kind]?.sha256 ?? String(repeating: "f", count: 64),
                  newSHA256: newSHA ?? R.digest(data), blobId: blobID, selector: selector, bytes: bytes ?? data.count)
    }
    func prepared(_ s: R.Selection, nonce: String = String(repeating: "d", count: 64),
                  head: String? = nil, sequence: UInt64? = nil, bootId: String = boot,
                  kind: R.Kind? = nil, oldSHA: String? = nil, newSHA: String? = nil,
                  bytes: Int? = nil, remaining: Int = 30_000) -> R.Prepared {
        .init(nonce: nonce, bootId: bootId, kind: kind ?? s.kind, oldSHA256: oldSHA ?? s.oldSHA256,
              newSHA256: newSHA ?? s.newSHA256, previousGenerationSHA256: head ?? s.expectedGenerationSHA256,
              sequence: sequence ?? controller.knownLedger.sequence, bytes: bytes ?? s.bytes, remainingMilliseconds: remaining)
    }
    func publication(_ p: R.Prepared, kind: R.Kind? = nil, oldSHA: String? = nil, newSHA: String? = nil,
                     head: String = nextHead, parent: String? = nil, sequence: UInt64? = nil,
                     retained: Bool = true, uid: UInt32 = 501, inode: UInt64 = 100,
                     alterOther: Bool = false) throws -> R.Publication {
        let previous = controller.knownLedger, n = sequence ?? previous.sequence + 1
        let resource = try R.Resource(kind: p.kind, sha256: p.newSHA256, identity: identity(inode, uid: uid, bytes: p.bytes), active: true)
        var entries = previous.resources; entries[p.kind] = resource
        if alterOther, let other = entries.keys.first(where: { $0 != p.kind }), let old = entries[other] {
            entries[other] = try .init(kind: other, sha256: String(repeating: "e", count: 64), identity: old.identity, active: old.active)
        }
        let readback = try R.Ledger(bootId: p.bootId, generationSHA256: head, sequence: n, resources: Array(entries.values))
        let receipt = R.Receipt(bootId: p.bootId, kind: kind ?? p.kind, oldSHA256: oldSHA ?? p.oldSHA256,
                                newSHA256: newSHA ?? p.newSHA256, bytes: p.bytes,
                                previousGenerationSHA256: parent ?? previous.generationSHA256,
                                generationSHA256: head, sequence: n, retainedOriginal: retained)
        return .init(receipt: receipt, readback: readback)
    }
    func start(_ id: Int = 1, _ selection: R.Selection? = nil) throws {
        controller.replace(id: id, selection: try selection ?? self.selection()) { [unowned self] in self.replies.append($0) }
    }
    func loseOwner() throws {
        owner = try .init(heldGeneration: owner.heldGeneration + 1, configurationRevision: configSHA,
                          coreBootId: boot, ordinaryUID: 501)
    }
    var status: R.Status? { replies.last?.status }
}

@main
private struct RuntimeResourceTests {
    static func main() {
        var rows = [[String: Any]]()
        func test(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": true]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        test("four kinds have only fixed basenames") {
            try require(Set(R.Kind.allCases.map { $0.basename }) == ["GeoSite.dat", "GeoIP.dat", "Country.mmdb", "ASN.mmdb"])
            try require(R.Kind(rawValue: "../../GeoSite.dat") == nil)
        }
        test("identity rejects root fallback, symlink mode, hardlink and oversized input") {
            for (uid, mode, links, bytes) in [(UInt32(0), UInt32(0o100600), UInt64(1), 1), (501, 0o120600, 1, 1),
                                             (501, 0o100644, 1, 1), (501, 0o100600, 2, 1), (501, 0o100600, 1, R.maximumBytes + 1)] {
                try rejects { _ = try R.FileIdentity(device: 1, inode: 1, ownerUID: uid, mode: mode, links: links,
                                                     bytes: bytes, modifiedNS: 1, changedNS: 1) }
            }
        }
        test("duplicate kinds and malformed selection are rejected") {
            let f = try Fixture(), entry = f.controller.knownLedger.resources[.geosite]!
            try rejects { _ = try R.Ledger(bootId: boot, generationSHA256: initialHead, sequence: 0, resources: [entry, entry]) }
            try rejects { _ = try f.selection(oldSHA: "missing") }
            try rejects { _ = try R.Blob(id: blobID, kind: .geosite, data: Data([1]), identity: identity(1, bytes: 2)) }
        }
        test("bounded configurable lease rejects zero and above120 seconds") {
            try rejects { _ = try Fixture(lease: 0) }; try rejects { _ = try Fixture(lease: 121) }
            _ = try Fixture(lease: 1); _ = try Fixture(lease: 120)
        }
        test("initial total includes static assets and rejects beyond256MiB") {
            try rejects { _ = try Fixture(staticAssetBytes: -1) }
            try rejects { _ = try Fixture(staticAssetBytes: R.maximumTotalBytes) }
            try rejects { _ = try Fixture(staticAssetBytes: R.maximumTotalBytes + 1) }
        }
        test("replacement over256MiB including nonGeo assets performs zero IO") {
            let initial = try Fixture(), geoBytes = initial.controller.knownLedger.resources.values.reduce(0) { $0 + $1.bytes }
            let f = try Fixture(staticAssetBytes: R.maximumTotalBytes - geoBytes)
            let old = f.controller.knownLedger.resources[.geosite]!
            try f.start(1, f.selection(bytes: old.bytes + 1))
            try require(f.status == .unsupported && f.reads == 0 && f.prepares == 0 && f.writes == 0)
        }
        test("exact256MiB active total remains allowed without allocating the budget") {
            let initial = try Fixture(), old = initial.controller.knownLedger.resources[.geosite]!
            let geoBytes = initial.controller.knownLedger.resources.values.reduce(0) { $0 + $1.bytes }
            let data = Data(repeating: 1, count: 64)
            let f = try Fixture(staticAssetBytes: R.maximumTotalBytes - geoBytes - (data.count - old.bytes))
            f.data = data; try f.start()
            try require(f.status == .updated && f.writes == 1)
        }
        for kind in R.Kind.allCases {
            test("verified replacement updates only " + kind.rawValue) {
                let f = try Fixture(), previous = f.controller.knownLedger
                try f.start(1, f.selection(kind))
                try require(f.status == .updated && f.writes == 1 && !f.controller.isBusy)
                try require(f.controller.knownLedger.generationSHA256 == nextHead && f.controller.knownLedger.sequence == 1)
                try require(previous.resources.allSatisfy { $0.key == kind || f.controller.knownLedger.resources[$0.key] == $0.value })
            }
        }
        test("mutable head advancement does not revoke the immutable owner") {
            let f = try Fixture(); try f.start()
            f.data = Data("next second generation".utf8)
            f.commitHook = { p, access, reply in
                do { try access.enterWrite(); f.writes += 1; reply(.success(try f.publication(p, head: String(repeating: "e", count: 64), inode: 101))) }
                catch { reply(.failure(error)) }
            }
            try f.start(2); try require(f.status == .updated && f.writes == 2 && f.controller.knownLedger.sequence == 2)
        }
        test("missing kind is unsupported and never adopted using a sentinel hash") {
            let f = try Fixture(kinds: [.geosite]); try f.start(1, f.selection(.asn, oldSHA: String(repeating: "0", count: 64)))
            try require(f.status == .unsupported && f.reads == 0 && f.commits == 0)
        }
        test("existing inactive kind is not eligible for publication") {
            let f = try Fixture(active: false); try f.start()
            try require(f.status == .unsupported && f.reads == 0 && f.commits == 0)
        }
        test("selector is an exact bounded existing descriptor rather than fixed CN") {
            let f = try Fixture()
            for selector in ["", " CN", "CN,other", "a\u{0}b", String(repeating: "中", count: 86)] {
                try rejects { _ = try f.selection(selector: selector) }
            }
            _ = try f.selection(selector: "private-test@ads")
        }
        test("exhausted safe sequence is rejected before any IO") {
            let f = try Fixture(sequence: 9_007_199_254_740_991); try f.start()
            try require(f.status == .unsupported && f.reads == 0 && f.writes == 0)
        }
        test("stale config, generation or preimage causes zero blob read") {
            for mode in 0..<3 {
                let f = try Fixture(), bad = String(repeating: "f", count: 64)
                let selection = try f.selection(oldSHA: mode == 0 ? bad : nil, head: mode == 1 ? bad : nil, revision: mode == 2 ? bad : configSHA)
                try f.start(1, selection); try require(f.status == .stale && f.reads == 0)
            }
        }
        test("a different private Core boot identity is rejected before IO") {
            let f = try Fixture()
            f.owner = try .init(heldGeneration: 7, configurationRevision: configSHA, coreBootId: blobID, ordinaryUID: 501)
            try f.start(); try require(f.status == .stale && f.reads == 0)
        }
        test("blob id kind digest and fixed owner are checked before Core prepare") {
            for mode in 0..<4 {
                let f = try Fixture()
                f.readHook = { _, _, reply in
                    do { reply(.success(try f.blob(mode == 1 ? .asn : .geosite, id: mode == 0 ? boot : blobID,
                                                  uid: mode == 3 ? 502 : 501, data: mode == 2 ? Data("wrong".utf8) : nil))) }
                    catch { reply(.failure(error)) }
                }
                try f.start(); try require(f.status == .stale && f.prepares == 0 && f.writes == 0)
            }
        }
        test("unvalidated prepare cannot enter the active write gate") {
            let f = try Fixture()
            f.readHook = { _, access, reply in
                do { try rejects { try access.enterWrite() }; reply(.success(try f.blob(.geosite))) }
                catch { reply(.failure(error)) }
            }
            try f.start(); try require(f.status == .updated && f.writes == 1)
        }
        test("prepared nonce boot head sequence kind and body fields are exact") {
            for mode in 0..<8 {
                let f = try Fixture()
                f.prepareHook = { s, _, _, reply in reply(.success(f.prepared(s, nonce: mode == 0 ? "nonce" : String(repeating: "d", count: 64),
                    head: mode == 1 ? configSHA : nil, sequence: mode == 2 ? 9 : nil, bootId: mode == 3 ? blobID : boot,
                    kind: mode == 4 ? .asn : nil, oldSHA: mode == 5 ? configSHA : nil,
                    newSHA: mode == 6 ? configSHA : nil, bytes: mode == 7 ? 1 : nil))) }
                try f.start(); try require(f.status == .stale && f.commits == 0 && f.writes == 0)
            }
        }
        test("invalid remaining budget is rejected") {
            for remaining in [0, 120_001] {
                let f = try Fixture(); f.prepareHook = { s, _, _, reply in reply(.success(f.prepared(s, remaining: remaining))) }
                try f.start(); try require(f.commits == 0 && f.writes == 0)
            }
        }
        test("prepared remaining budget never extends original total lease") {
            let f = try Fixture()
            f.prepareHook = { s, _, _, reply in f.now += 29_000_000_000; reply(.success(f.prepared(s))) }
            f.commitHook = { _, access, reply in f.now += 2_000_000_000; do { try access.enterWrite(); f.writes += 1; reply(.failure(TestFailure.synthetic)) } catch { reply(.failure(error)) } }
            try f.start(); try require(f.status == .expired && f.writes == 0 && !f.controller.isIsolated)
        }
        test("Core remaining budget can only shorten the lease") {
            let f = try Fixture()
            f.prepareHook = { s, _, _, reply in reply(.success(f.prepared(s, remaining: 5))) }
            f.commitHook = { _, access, reply in f.now += 6_000_000; do { try access.enterWrite(); f.writes += 1; reply(.failure(TestFailure.synthetic)) } catch { reply(.failure(error)) } }
            try f.start(); try require(f.status == .expired && f.writes == 0)
        }
        test("initial owner observation consumes the original budget") {
            let f = try Fixture(); f.ownerHook = { f.ownerHook = nil; f.now += 30_000_000_000 }
            try f.start(); try require(f.status == .expired && f.reads == 0)
        }
        test("first owner callback cancellation cannot start IO") {
            let f = try Fixture(); var cancellation: R.Reply?
            f.ownerHook = { f.ownerHook = nil; cancellation = f.controller.cancel(operationId: 1) }
            try f.start(); try require(cancellation?.pending == true && f.status == .cancelled && f.reads == 0)
        }
        test("owner callback reentry cannot start a second logical flight") {
            let f = try Fixture(); var nested: R.Reply?
            f.ownerHook = { f.ownerHook = nil; f.controller.replace(id: 2, selection: try! f.selection()) { nested = $0 } }
            try f.start(); try require(nested?.status == .busy && f.writes == 1)
        }
        test("cancelled blob read remains busy until the original callback settles") {
            let f = try Fixture(); var held: ((Result<R.Blob, Error>) -> Void)?
            f.readHook = { _, _, reply in held = reply }
            try f.start(); try require(f.controller.isBusy && f.replies.isEmpty)
            try require(f.controller.cancel(operationId: 1).pending)
            try f.start(2); try require(f.status == .busy && f.controller.isBusy)
            held?(.success(try f.blob(.geosite)))
            try require(f.status == .cancelled && !f.controller.isBusy && f.prepares == 0)
        }
        test("cancelled Core prepare callback cannot commit") {
            let f = try Fixture(); var held: ((Result<R.Prepared, Error>) -> Void)?; var prepared: R.Prepared?
            f.prepareHook = { s, _, _, reply in prepared = f.prepared(s); held = reply }
            try f.start(); _ = f.controller.cancel(operationId: 1)
            try require(f.controller.isBusy); held?(.success(prepared!))
            try require(f.status == .cancelled && f.commits == 0 && f.writes == 0 && f.coreCancels == 1)
        }
        test("private Core cancel acknowledgment must settle before releasing busy") {
            let f = try Fixture(); var held: ((Result<R.Cancellation, Error>) -> Void)?
            f.prepareHook = { s, _, _, reply in _ = f.controller.cancel(operationId: 1); reply(.success(f.prepared(s))) }
            f.cancelHook = { held = $0 }; try f.start()
            try require(f.controller.isBusy && f.replies.isEmpty && f.commits == 0)
            held?(.success(.cancelled)); try require(!f.controller.isBusy && f.status == .cancelled && f.coreCancels == 1)
        }
        test("missing Core cancel acknowledgment is not reported as confirmed cancelled") {
            let f = try Fixture()
            f.prepareHook = { s, _, _, reply in _ = f.controller.cancel(operationId: 1); reply(.success(f.prepared(s))) }
            f.cancelHook = { $0(.failure(TestFailure.synthetic)) }; try f.start()
            try require(f.status == .unavailable && f.writes == 0 && !f.controller.isIsolated)
        }
        test("Core uncertain cancellation isolates even without a Native commit marker") {
            let f = try Fixture()
            f.prepareHook = { s, _, _, reply in _ = f.controller.cancel(operationId: 1); reply(.success(f.prepared(s))) }
            f.cancelHook = { $0(.success(.uncertain)) }; try f.start()
            try require(f.status == .uncertain && f.controller.isIsolated && f.writes == 0 && f.replies.last?.ledger == nil)
        }
        test("silent owner loss after prepare causes zero commit") {
            let f = try Fixture()
            f.prepareHook = { s, _, _, reply in try! f.loseOwner(); reply(.success(f.prepared(s))) }
            try f.start(); try require(f.status == .stale && f.commits == 0)
        }
        test("final synchronous owner observer cancellation causes zero write") {
            let f = try Fixture()
            f.commitHook = { _, access, reply in
                f.ownerHook = { f.ownerHook = nil; _ = f.controller.cancel(operationId: 1) }
                do { try access.enterWrite(); f.writes += 1; reply(.failure(TestFailure.synthetic)) } catch { reply(.failure(error)) }
            }
            try f.start(); try require(f.status == .cancelled && f.writes == 0)
        }
        test("admitted cancellation keeps busy and isolates without rollback or retry") {
            let f = try Fixture(); var held: ((Result<R.Publication, Error>) -> Void)?
            f.commitHook = { _, access, reply in try! access.enterWrite(); f.writes += 1; held = reply }
            try f.start(); try require(f.controller.cancel(operationId: 1).status == .uncertain && f.controller.isBusy)
            held?(.failure(TestFailure.synthetic))
            try require(f.status == .uncertain && f.replies.last?.ledger == nil && f.controller.isIsolated)
            try f.start(2); try require(f.status == .uncertain && f.writes == 1 && f.controller.knownLedger.sequence == 0)
        }
        test("owner loss after admitted publication cannot return a usable new ledger") {
            let f = try Fixture()
            f.commitHook = { p, access, reply in
                do { try access.enterWrite(); f.writes += 1; let result = try f.publication(p); try f.loseOwner(); reply(.success(result)) }
                catch { reply(.failure(error)) }
            }
            try f.start(); try require(f.status == .uncertain && f.replies.last?.ledger == nil && f.controller.isIsolated)
            try require(f.controller.knownLedger.sequence == 0 && f.controller.isolation?.observedPublication != nil)
        }
        test("deadline after write is uncertain and never renewed") {
            let f = try Fixture()
            f.commitHook = { p, access, reply in
                do { try access.enterWrite(); f.writes += 1; f.now += 30_000_000_000; reply(.success(try f.publication(p))) }
                catch { reply(.failure(error)) }
            }
            try f.start(); try require(f.status == .uncertain && f.controller.isIsolated)
        }
        test("prewrite transport failure is not a confirmed or unknown publication") {
            let f = try Fixture(); f.commitHook = { _, _, reply in reply(.failure(TestFailure.synthetic)) }
            try f.start(); try require(f.status == .unavailable && !f.controller.isIsolated && f.writes == 0)
        }
        test("postimage receipt parent sequence body retention and other kinds must match") {
            for mode in 0..<7 {
                let f = try Fixture()
                f.commitHook = { p, access, reply in
                    do {
                        try access.enterWrite(); f.writes += 1
                        reply(.success(try f.publication(p, kind: mode == 0 ? .asn : nil, oldSHA: mode == 1 ? configSHA : nil,
                            newSHA: mode == 2 ? configSHA : nil, parent: mode == 3 ? configSHA : nil,
                            sequence: mode == 4 ? 2 : nil, retained: mode != 5, alterOther: mode == 6)))
                    } catch { reply(.failure(error)) }
                }
                try f.start(); try require(f.status == .uncertain && f.controller.knownLedger.sequence == 0 && f.writes == 1)
            }
        }
        test("inplace or foreign-owner postimage is not accepted") {
            for mode in 0..<2 {
                let f = try Fixture(), oldInode = f.controller.knownLedger.resources[.geosite]!.identity.inode
                f.commitHook = { p, access, reply in
                    do { try access.enterWrite(); f.writes += 1; reply(.success(try f.publication(p, uid: mode == 0 ? 502 : 501, inode: mode == 1 ? oldInode : 100))) }
                    catch { reply(.failure(error)) }
                }
                try f.start(); try require(f.status == .uncertain && f.controller.isIsolated)
            }
        }
        test("an applied Core receipt without independent matching readback is uncertain") {
            let f = try Fixture()
            f.commitHook = { p, access, reply in
                do {
                    try access.enterWrite(); f.writes += 1
                    let receipt = try f.publication(p).receipt
                    reply(.success(.init(receipt: receipt, readback: f.controller.knownLedger)))
                } catch { reply(.failure(error)) }
            }
            try f.start(); try require(f.status == .uncertain && f.controller.knownLedger.sequence == 0)
        }
        test("duplicate callbacks never submit a second commit") {
            let f = try Fixture()
            f.readHook = { _, _, reply in let result = Result<R.Blob, Error>.success(try! f.blob(.geosite)); reply(result); reply(result) }
            try f.start(); try require(f.writes == 1 && f.commits == 1 && f.replies.count == 1)
        }
        test("duplicate prepare and commit completions cannot advance a second generation") {
            let f = try Fixture()
            f.prepareHook = { s, _, _, reply in let result = Result<R.Prepared, Error>.success(f.prepared(s)); reply(result); reply(result) }
            f.commitHook = { p, access, reply in
                do { try access.enterWrite(); f.writes += 1; let result = Result<R.Publication, Error>.success(try f.publication(p)); reply(result); reply(result) }
                catch { reply(.failure(error)) }
            }
            try f.start(); try require(f.replies.count == 1 && f.writes == 1 && f.controller.knownLedger.sequence == 1)
        }
        test("used operation ids cannot be replayed") {
            let f = try Fixture(); try f.start(); try f.start(1)
            try require(f.status == .unavailable && f.commits == 1 && f.writes == 1)
        }
        test("old cancel id cannot revoke a new operation") {
            let f = try Fixture(); var held: ((Result<R.Blob, Error>) -> Void)?
            f.readHook = { _, _, reply in held = reply }; try f.start(2)
            try require(f.controller.cancel(operationId: 1).status == .stale)
            held?(.success(try f.blob(.geosite))); try require(f.status == .updated)
        }
        test("close revokes only this capability and does not release its busy early") {
            let f = try Fixture(); var held: ((Result<R.Blob, Error>) -> Void)?
            f.readHook = { _, _, reply in held = reply }; try f.start(); f.controller.close()
            try require(f.controller.isBusy); held?(.success(try f.blob(.geosite)))
            try require(f.status == .cancelled && f.commits == 0); try f.start(2); try require(f.status == .unavailable)
        }
        test("unchanged bytes skip staging and never advance the ledger") {
            let f = try Fixture(), old = f.controller.knownLedger.resources[.geosite]!
            try f.start(1, f.selection(newSHA: old.sha256, bytes: old.bytes))
            try require(f.status == .unchanged && f.reads == 0 && f.commits == 0 && f.controller.knownLedger.sequence == 0)
        }
        let passed = rows.allSatisfy { $0["passed"] as? Bool == true }
        let report: [String: Any] = ["scope": "pure injected Native resource authority and generation model",
            "checks": rows.count, "passed": passed, "rows": rows, "actualCoreStarted": false,
            "actualFilesystemOrNetworkIO": false, "actualHelperOrTUN": false, "systemConfigurationChanged": false]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            print(String(decoding: data, as: UTF8.self))
        }
        if !passed { exit(1) }
    }
}
