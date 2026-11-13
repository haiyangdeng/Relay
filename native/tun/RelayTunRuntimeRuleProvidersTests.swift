// Isolated test target only. No file, socket, Core, helper or TUN operations.
import Foundation
private typealias P = RelayTunRuntimeRuleProviders
private typealias G = RelayTunRuntimeResources
private enum Bad: Error { case assertion, injected }
private func require(_ ok: @autoclosure () -> Bool) throws { if !ok() { throw Bad.assertion } }
private func rejects(_ body: () throws -> Void) throws { do { try body() } catch { return }; throw Bad.assertion }
private let ticket = "10000000-0000-4000-8000-000000000001", blobId = "20000000-0000-4000-8000-000000000001"
private let cfg = String(repeating: "c", count: 64), geoHead = String(repeating: "b", count: 64)
private func identity(_ ino: UInt64, bytes: Int, uid: UInt32 = 501, modified: UInt64 = 1, changed: UInt64 = 1) throws -> P.FileIdentity {
    try .init(device: 1, inode: ino, ownerUID: uid, mode: 0o100600, links: 1, bytes: bytes, modifiedNS: modified, changedNS: changed)
}
private final class Fixture {
    let old = Data("old.synthetic.invalid\n".utf8), next = Data("new.synthetic.invalid\n".utf8)
    let binding: P.Binding, oldRow: P.Resource
    var context: P.Context, time: UInt64 = 1, writes = 0, blobReads = 0, stages = 0, cleanups = [P.Cleanup]()
    var supported = true, staticBytes = 0, initialGeo: P.GeoBudget
    var rows: [P.Resource], replies = [P.Reply](), ownerHook: (() throws -> P.Context)?
    var blobHook: ((P.Selection, P.Access, @escaping (Result<P.Blob, Error>) -> Void) -> Void)?
    var stageHook: (([P.Resource], P.Blob, P.Access, @escaping (Result<P.Stage, Error>) -> Void) -> Void)?
    var publishHook: ((P.Stage, P.Access, @escaping (Result<P.Publication, Error>) -> Void) -> Void)?
    var pruneHook: (([P.Retained], P.Access, @escaping (Result<P.Pruned, Error>) -> Void) -> Void)?
    var prunes = [[P.Retained]]()
    var cleanupHook: ((P.Stage, P.Cleanup, @escaping (Result<Void, Error>) -> Void) -> Void)?
    var controller: P.Controller!
    init() throws {
        binding = try .init(name: "Only", originalPath: "relay-files/" + G.digest(old) + ".yaml", behavior: .domain, format: .yaml)
        oldRow = try .init(binding: binding, fileSHA256: G.digest(old), identity: identity(1, bytes: old.count), ruleCount: 1, registeredFile: true)
        rows = [oldRow]; initialGeo = try .init(generationSHA256: geoHead, bytes: 0)
        context = .init(owner: try .init(heldGeneration: 1, configurationRevision: cfg, coreSHA256: String(repeating: "d", count: 64), ordinaryUID: 501), geo: initialGeo)
        try reset()
    }
    func reset() throws {
        let driver = P.Driver(supportsSynchronousFileRead: supported, currentContext: { [unowned self] in try ownerHook?() ?? context },
            readBlob: { [unowned self] s, a, done in
                blobReads += 1
                if let blobHook { blobHook(s, a, done); return }
                do { try a.check(); done(.success(try .init(id: s.blobId, format: .yaml, data: next, identity: identity(9, bytes: next.count)))) } catch { done(.failure(error)) }
            }, stage: { [unowned self] b, value, a, done in
                stages += 1
                if let stageHook { stageHook(b, value, a, done); return }
                do { try a.check(); done(.success(try stage())) } catch { done(.failure(error)) }
            }, prune: { [unowned self] records, access, done in
                prunes.append(records)
                if let pruneHook { pruneHook(records, access, done); return }
                do { try access.check(); done(.success(.init(removed: records, complete: true))) } catch { done(.failure(error)) }
            }, publish: { [unowned self] value, a, done in
                if let publishHook { publishHook(value, a, done); return }
                do { try a.enterPublish(); writes += 1; done(.success(try publication())) } catch { done(.failure(error)) }
            }, cleanup: { [unowned self] s, disposition, done in
                cleanups.append(disposition)
                if let cleanupHook { cleanupHook(s, disposition, done); return }; done(.success(()))
            })
        controller = try .init(ledger: .init(generationSHA256: String(repeating: "a", count: 64), sequence: 0, resources: rows),
                               staticAssetBytes: staticBytes, initialGeo: initialGeo, driver: driver, clock: { [unowned self] in time })
    }
    func selection(head: String = String(repeating: "a", count: 64), geo: String = geoHead, sha: String? = nil, bytes: Int? = nil, declared: Int = 1) throws -> P.Selection {
        try .init(provider: "Only", configurationRevision: cfg, expectedGenerationSHA256: head, expectedGeoGenerationSHA256: geo,
                  oldSHA256: G.digest(old), newSHA256: sha ?? G.digest(next), blobId: blobId, bytes: bytes ?? next.count, declaredRuleCount: declared)
    }
    func stage() throws -> P.Stage {
        let group = controller.knownLedger.group(for: "Only")
        return try .init(ticket: ticket, bindings: group.map { $0.binding }, sha256: G.digest(next), identity: identity(2, bytes: next.count, modified: 2, changed: 2), checkedRuleCounts: Dictionary(uniqueKeysWithValues: group.map { ($0.binding.name, 1) }))
    }
    func publication(acceptance: P.Acceptance = .synchronousFileRead, count: Int = 1, rows supplied: [P.Resource]? = nil, retainedSHA: String? = nil) throws -> P.Publication {
        let group = controller.knownLedger.group(for: "Only"), names = Set(group.map { $0.binding.name })
        let updated = try controller.knownLedger.resources.values.map { before in
            names.contains(before.binding.name) ? try P.Resource(binding: before.binding, fileSHA256: G.digest(next), identity: identity(2, bytes: next.count, modified: 2, changed: 3), ruleCount: count, registeredFile: true) : before
        }
        return .init(retained: try .init(ticket: ticket, originalPath: binding.originalPath, sha256: retainedSHA ?? G.digest(old), identity: identity(1, bytes: old.count, changed: 4)), resources: supplied ?? updated, acceptance: acceptance)
    }
    func start(_ selected: P.Selection? = nil, id: Int = 1, maximumDeadline: UInt64? = nil) throws { controller.replace(id: id, selection: try selected ?? selection(), maximumDeadline: maximumDeadline) { [unowned self] in replies.append($0) } }
    func advance(_ id: Int) throws {
        let before = controller.knownLedger, old = before.resources["Only"]!, body = Data("version-\(id).synthetic.invalid\n".utf8)
        let group = before.group(for: "Only"), names = Set(group.map { $0.binding.name })
        let stageTicket = String(format: "10000000-0000-4000-8000-%012d", id + 10)
        let nextIdentity = try identity(UInt64(100 + id), bytes: body.count, modified: UInt64(id + 10), changed: UInt64(id + 10))
        let value = P.Stage(ticket: stageTicket, bindings: group.map { $0.binding }, sha256: G.digest(body), identity: nextIdentity,
                            checkedRuleCounts: Dictionary(uniqueKeysWithValues: group.map { ($0.binding.name, 1) }))
        blobHook = { _, _, done in done(.success(try! .init(id: blobId, format: .yaml, data: body, identity: identity(9, bytes: body.count)))) }
        stageHook = { _, _, _, done in done(.success(value)) }
        publishHook = { _, access, done in
            do {
                try access.enterPublish(); self.writes += 1
                let rows = try before.resources.values.map { row in
                    names.contains(row.binding.name) ? try P.Resource(binding: row.binding, fileSHA256: G.digest(body), identity: nextIdentity, ruleCount: 1, registeredFile: true) : row
                }
                done(.success(.init(retained: .init(ticket: stageTicket, originalPath: old.binding.originalPath, sha256: old.fileSHA256, identity: old.identity), resources: rows, acceptance: .synchronousFileRead)))
            } catch { done(.failure(error)) }
        }
        let selected = try P.Selection(provider: "Only", configurationRevision: cfg, expectedGenerationSHA256: before.generationSHA256,
                                       expectedGeoGenerationSHA256: geoHead, oldSHA256: old.fileSHA256, newSHA256: G.digest(body), blobId: blobId, bytes: body.count, declaredRuleCount: 1)
        try start(selected, id: id)
    }

}
@main
private enum ProviderModelTests {
    static func main() {
        var results = [[String: Any]]()
        func test(_ name: String, _ body: () throws -> Void) {
            do { try body(); results.append(["name": name, "passed": true]) }
            catch { results.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        test("only fixed checked-provider relative names and compatible formats") {
            for path in ["/tmp/file", "../rules", "relay-files/../x.yaml", "relay-files/" + String(repeating: "x", count: 64) + ".yaml"] {
                try rejects { _ = try P.Binding(name: "Only", originalPath: path, behavior: .domain, format: .yaml) }
            }
            try rejects { _ = try P.Binding(name: "Only", originalPath: "relay-files/" + cfg + ".mrs", behavior: .classical, format: .mrs) }
        }
        test("published ledger advances only after exact synchronous accepted-file evidence") {
            let f = try Fixture(); try f.start()
            try require(f.replies.last?.status == .published && f.writes == 1 && !f.controller.isBusy)
            try require(f.controller.knownLedger.sequence == 1 && f.controller.knownLedger.resources["Only"]?.fileSHA256 == G.digest(f.next))
            try require(f.controller.retainedRecords[ticket]?.identity.inode == 1 && f.cleanups == [.keepPublishedAndRetained])
        }
        test("no Core content SHA is inferred from same-count metadata") {
            let f = try Fixture(); f.publishHook = { _, a, done in do { try a.enterPublish(); f.writes += 1; done(.success(try f.publication(acceptance: .metadataOnly))) } catch { done(.failure(error)) } }; try f.start()
            try require(f.replies.last?.status == .uncertain && f.controller.knownLedger.sequence == 0 && f.controller.isolation != nil)
        }
        test("unproven synchronous-read driver is unsupported before reading blob") {
            let f = try Fixture(); f.supported = false; try f.reset(); try f.start(); try require(f.replies.last?.status == .unsupported && f.blobReads == 0 && f.writes == 0)
        }
        test("one physical group may contain different behaviors and independent actual counts") {
            let f = try Fixture(), alias = try P.Binding(name: "Alias", originalPath: f.binding.originalPath, behavior: .classical, format: .yaml)
            f.rows.append(try .init(binding: alias, fileSHA256: G.digest(f.old), identity: f.oldRow.identity, ruleCount: 3, registeredFile: true)); try f.reset(); try f.start()
            try require(f.replies.last?.status == .published && f.blobReads == 1 && f.writes == 1)
            try require(f.controller.knownLedger.groups == [["Alias", "Only"]] && f.controller.knownLedger.bytes == f.next.count)
            try require(f.controller.knownLedger.resources["Alias"]?.ruleCount == 1 && f.controller.retainedRecords.count == 1)
        }
        test("initial static plus Geo plus unique-provider bytes is bounded") {
            let f = try Fixture(); f.staticBytes = P.maximumTotalBytes - f.old.count; f.initialGeo = try .init(generationSHA256: geoHead, bytes: 1)
            try rejects { try f.reset() }
        }
        test("replacement budget accounts for current Geo bytes before blob IO") {
            let f = try Fixture(); f.context = .init(owner: f.context.owner, geo: try .init(generationSHA256: geoHead, bytes: P.maximumTotalBytes - f.next.count + 1)); try f.start()
            try require(f.replies.last?.status == .unsupported && f.blobReads == 0 && f.writes == 0)
        }
        test("wrong current provider or Geo head is rejected before blob read") {
            for selected in [try Fixture().selection(head: String(repeating: "e", count: 64)), try Fixture().selection(geo: String(repeating: "e", count: 64))] {
                let f = try Fixture(); try f.start(selected); try require(f.replies.last?.status == .stale && f.blobReads == 0)
            }
        }
        test("unchanged exact bytes/count performs no blob read or publication") {
            let f = try Fixture(); try f.start(f.selection(sha: G.digest(f.old), bytes: f.old.count)); try require(f.replies.last?.status == .unchanged && f.blobReads == 0 && f.writes == 0)
        }
        test("cancellation waits for held blob callback without publication") {
            let f = try Fixture(); var release: ((Result<P.Blob, Error>) -> Void)?
            f.blobHook = { _, _, done in release = done }; try f.start(); try require(f.controller.cancel(operationId: 1).pending && f.controller.isBusy)
            release?(.success(try .init(id: blobId, format: .yaml, data: f.next, identity: identity(9, bytes: f.next.count))))
            try require(f.replies.last?.status == .cancelled && !f.controller.isBusy && f.writes == 0)
        }
        test("late stage after cancellation drains exact cleanup first") {
            let f = try Fixture(); var release: ((Result<P.Stage, Error>) -> Void)?, clean: ((Result<Void, Error>) -> Void)?
            f.stageHook = { _, _, _, done in release = done }; f.cleanupHook = { _, _, done in clean = done }; try f.start(); _ = f.controller.cancel(operationId: 1)
            release?(.success(try f.stage())); try require(f.controller.isBusy && f.replies.isEmpty && f.cleanups == [.discardUnpublished])
            clean?(.success(())); try require(f.replies.last?.status == .cancelled && f.writes == 0)
        }
        test("final owner callback can reenter cancel without entering write") {
            let f = try Fixture(); f.publishHook = { _, a, done in
                var once = true; f.ownerHook = { if once { once = false; _ = f.controller.cancel(operationId: 1) }; return f.context }
                do { try a.enterPublish(); f.writes += 1; done(.success(try f.publication())) } catch { done(.failure(error)) }
            }; try f.start(); try require(f.writes == 0 && f.replies.last?.status == .cancelled)
        }
        test("real two-queue preflight gate permits immediate cancel and zero writes") {
            let f = try Fixture(), io = DispatchQueue(label: "provider-test-io"), control = DispatchQueue(label: "provider-test-control")
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), cancelled = DispatchSemaphore(value: 0), settled = DispatchSemaphore(value: 0)
            f.publishHook = { _, a, done in io.async { entered.signal(); _ = release.wait(timeout: .now() + 2); do { try a.enterPublish(); f.writes += 1; done(.success(try f.publication())) } catch { done(.failure(error)) }; settled.signal() } }
            try f.start(); try require(entered.wait(timeout: .now() + 2) == .success)
            control.async { _ = f.controller.cancel(operationId: 1); cancelled.signal() }
            try require(cancelled.wait(timeout: .now() + 2) == .success); try require(f.controller.isBusy); release.signal(); try require(settled.wait(timeout: .now() + 2) == .success)
            try require(f.writes == 0 && f.replies.last?.status == .cancelled && !f.controller.isBusy)
        }
        test("cancellation after publication is uncertain and retains prior ledger") {
            let f = try Fixture(); f.publishHook = { _, a, done in do { try a.enterPublish(); f.writes += 1; _ = f.controller.cancel(operationId: 1); done(.success(try f.publication())) } catch { done(.failure(error)) } }; try f.start()
            try require(f.replies.last?.status == .uncertain && f.controller.isolation != nil && f.controller.knownLedger.sequence == 0 && f.cleanups == [.keepPublishedAndRetained])
            try f.start(id: 2); try require(f.replies.last?.status == .uncertain && f.writes == 1)
        }
        test("Geo change while staging invalidates budget/owner context before write") {
            let f = try Fixture(); f.stageHook = { _, _, _, done in f.context = .init(owner: f.context.owner, geo: try! .init(generationSHA256: String(repeating: "e", count: 64), bytes: 1)); done(.success(try! f.stage())) }; try f.start()
            try require(f.replies.last?.status == .stale && f.writes == 0 && f.cleanups == [.discardUnpublished])
        }
        test("deadline is one total monotonic lease and not reset by stage") {
            let f = try Fixture(); f.stageHook = { _, _, _, done in f.time += 30_000_000_000; done(.success(try! f.stage())) }; try f.start()
            try require(f.replies.last?.status == .expired && f.writes == 0)
        }
        test("postpublication timeout never becomes clean cancellation") {
            let f = try Fixture(); f.publishHook = { _, a, done in do { try a.enterPublish(); f.writes += 1; f.time += 30_000_000_000; done(.success(try f.publication())) } catch { done(.failure(error)) } }; try f.start(); try require(f.replies.last?.status == .uncertain && f.controller.knownLedger.sequence == 0)
        }
        test("changed expected count or retained preimage cannot advance ledger") {
            for wrongCount in [true, false] {
                let f = try Fixture(); f.publishHook = { _, a, done in do { try a.enterPublish(); f.writes += 1; done(.success(try f.publication(count: wrongCount ? 2 : 1, retainedSHA: wrongCount ? nil : cfg))) } catch { done(.failure(error)) } }; try f.start()
                try require(f.replies.last?.status == .uncertain && f.controller.retainedRecords.isEmpty)
            }
        }
        test("final cleanup callback revocation prevents adopting apparent success") {
            let f = try Fixture(); f.cleanupHook = { _, _, done in f.controller.close(); done(.success(())) }; try f.start()
            try require(f.replies.last?.status == .uncertain && f.controller.knownLedger.sequence == 0)
        }
        test("unrecognized stage is preserved and provider capability isolated") {
            let f = try Fixture(); f.stageHook = { _, _, _, done in done(.success(.init(ticket: ticket, bindings: [f.binding], sha256: cfg, identity: try! identity(2, bytes: f.next.count), checkedRuleCounts: ["Only": 1]))) }; try f.start()
            try require(f.replies.last?.status == .unavailable && f.controller.isolation != nil && f.cleanups.isEmpty && f.writes == 0)
        }
        test("duplicate stage and publication callbacks cannot double write or reply") {
            let f = try Fixture(); f.stageHook = { _, _, _, done in let value = try! f.stage(); done(.success(value)); done(.success(value)) }; f.publishHook = { _, a, done in do { try a.enterPublish(); f.writes += 1; let value = try f.publication(); done(.success(value)); done(.success(value)); try rejects { try a.enterPublish() } } catch { done(.failure(error)) } }; try f.start()
            try require(f.writes == 1 && f.replies.count == 1 && f.controller.knownLedger.sequence == 1)
        }
        test("unconfirmed cleanup drains but does not adopt unknown files") {
            let f = try Fixture(); f.cleanupHook = { _, _, done in done(.failure(Bad.injected)) }; try f.start(); try require(f.replies.last?.status == .uncertain && f.controller.isolation != nil && f.controller.knownLedger.sequence == 0)
        }
        test("initial ledger cannot adopt a file whose SHA differs from checked path") {
            let f = try Fixture(), wrong = try P.Resource(binding: f.binding, fileSHA256: cfg, identity: f.oldRow.identity, ruleCount: 1, registeredFile: true)
            try rejects { _ = try P.Ledger(generationSHA256: cfg, sequence: 0, resources: [wrong]) }
        }
        test("owner loss after blob await prevents even stage IO") {
            let f = try Fixture(); f.blobHook = { s, _, done in
                f.context = .init(owner: try! .init(heldGeneration: 2, configurationRevision: cfg, coreSHA256: f.context.owner.coreSHA256, ordinaryUID: 501), geo: f.context.geo)
                done(.success(try! .init(id: s.blobId, format: .yaml, data: f.next, identity: identity(9, bytes: f.next.count))))
            }; try f.start(); try require(f.replies.last?.status == .stale && f.stages == 0 && f.writes == 0)
        }
        test("changed blob digest cannot create a provider stage") {
            let f = try Fixture(); f.blobHook = { s, _, done in done(.success(try! .init(id: s.blobId, format: .yaml, data: f.old, identity: identity(9, bytes: f.old.count)))) }; try f.start()
            try require(f.replies.last?.status == .stale && f.stages == 0 && f.writes == 0)
        }
        test("Geo budget change in final cleanup callback cannot adopt publication") {
            let f = try Fixture(); f.cleanupHook = { _, _, done in
                f.context = .init(owner: f.context.owner, geo: try! .init(generationSHA256: cfg, bytes: P.maximumTotalBytes)); done(.success(()))
            }; try f.start(); try require(f.replies.last?.status == .uncertain && f.controller.knownLedger.sequence == 0)
        }
        test("postimage cannot change an unselected provider or drop its ledger row") {
            let f = try Fixture(), b = try P.Binding(name: "Other", originalPath: "relay-files/" + G.digest(Data([7])) + ".yaml", behavior: .domain, format: .yaml)
            let other = try P.Resource(binding: b, fileSHA256: G.digest(Data([7])), identity: identity(5, bytes: 1), ruleCount: 1, registeredFile: true)
            f.rows.append(other); try f.reset()
            f.publishHook = { _, a, done in do { try a.enterPublish(); f.writes += 1; let value = try f.publication(); done(.success(.init(retained: value.retained, resources: value.resources.filter { $0.binding.name == "Only" }, acceptance: value.acceptance))) } catch { done(.failure(error)) } }; try f.start()
            try require(f.replies.last?.status == .uncertain && f.controller.knownLedger.resources["Other"] == other && f.controller.knownLedger.sequence == 0)
        }
        test("reused retained ticket is preserved rather than dispatched to stage cleanup") {
            let f = try Fixture(); try f.start(); let current = f.controller.knownLedger, body = Data([9, 10, 11])
            let s = try P.Selection(provider: "Only", configurationRevision: cfg, expectedGenerationSHA256: current.generationSHA256,
                                    expectedGeoGenerationSHA256: geoHead, oldSHA256: G.digest(f.next), newSHA256: G.digest(body), blobId: blobId, bytes: body.count, declaredRuleCount: 1)
            f.blobHook = { _, _, done in done(.success(try! .init(id: blobId, format: .yaml, data: body, identity: identity(10, bytes: body.count)))) }
            f.stageHook = { _, _, _, done in done(.success(.init(ticket: ticket, bindings: [f.binding], sha256: G.digest(body), identity: try! identity(3, bytes: body.count), checkedRuleCounts: ["Only": 1]))) }
            try f.start(s, id: 2)
            try require(f.replies.last?.status == .unavailable && f.writes == 1 && f.cleanups.count == 1 && f.controller.retainedRecords.count == 1)
            try require(f.controller.knownLedger == current && f.controller.isolation != nil)
        }

        test("missing one alias probe result stops before publication") {
            let f = try Fixture(), alias = try P.Binding(name: "Alias", originalPath: f.binding.originalPath, behavior: .classical, format: .yaml)
            f.rows.append(try .init(binding: alias, fileSHA256: G.digest(f.old), identity: f.oldRow.identity, ruleCount: 2, registeredFile: true)); try f.reset()
            f.stageHook = { _, _, _, done in let s = try! f.stage(); done(.success(.init(ticket: s.ticket, bindings: s.bindings, sha256: s.sha256, identity: s.identity, checkedRuleCounts: ["Only": 1]))) }
            try f.start(); try require(f.writes == 0 && f.replies.last?.status == .unavailable && f.controller.isolation != nil)
        }
        test("one alias count mismatch after swap isolates whole group") {
            let f = try Fixture(), alias = try P.Binding(name: "Alias", originalPath: f.binding.originalPath, behavior: .classical, format: .yaml)
            f.rows.append(try .init(binding: alias, fileSHA256: G.digest(f.old), identity: f.oldRow.identity, ruleCount: 3, registeredFile: true)); try f.reset()
            f.publishHook = { _, a, done in do { try a.enterPublish(); f.writes += 1; done(.success(try f.publication(count: 2))) } catch { done(.failure(error)) } }
            try f.start(); try require(f.replies.last?.status == .uncertain && f.controller.knownLedger.sequence == 0)
        }
        test("typed blob format mismatch never enters stage") {
            let f = try Fixture(); f.blobHook = { s, _, done in done(.success(try! .init(id: s.blobId, format: .text, data: f.next, identity: identity(9, bytes: f.next.count)))) }
            try f.start(); try require(f.stages == 0 && f.writes == 0 && f.replies.last?.status == .stale)
        }
        test("prepared publish fence rechecks cancellation before write without rerunning observer") {
            let f = try Fixture(); var observerCalls = 0, pureObserverDelta = -1
            f.publishHook = { _, a, done in
                do {
                    f.ownerHook = { observerCalls += 1; return f.context }
                    let fence = try a.preparePublishFence(); _ = f.controller.cancel(operationId: 1)
                    let calls = observerCalls
                    do { try a.enterPublish(fence) } catch { pureObserverDelta = observerCalls - calls; throw error }
                    pureObserverDelta = observerCalls - calls; f.writes += 1; done(.success(try f.publication()))
                } catch { done(.failure(error)) }
            }
            try f.start(); try require(f.writes == 0 && pureObserverDelta == 0 && f.replies.last?.status == .cancelled)
        }
        test("publish fence expires while final FS checks run") {
            let f = try Fixture(); f.publishHook = { _, a, done in
                do { let fence = try a.preparePublishFence(); f.time += 30_000_000_000; try a.enterPublish(fence); f.writes += 1; done(.success(try f.publication())) } catch { done(.failure(error)) }
            }; try f.start(); try require(f.writes == 0 && f.replies.last?.status == .expired)
        }
        test("confirmed runtime history is FIFO bounded to four tickets") {
            let f = try Fixture(); for id in 1...6 { try f.advance(id); try require(f.replies.last?.status == .published) }
            try require(f.writes == 6 && f.controller.retainedRecords.count == 4 && f.prunes.count == 2)
            try require(f.prunes.flatMap { $0 }.map { $0.ticket } == ["10000000-0000-4000-8000-000000000011", "10000000-0000-4000-8000-000000000012"])
            try require(f.controller.knownLedger.sequence == 6 && f.controller.isolation == nil)
        }
        test("held prune keeps operation busy and cancellation never reaches next swap") {
            let f = try Fixture(); for id in 1...4 { try f.advance(id) }
            var release: ((Result<P.Pruned, Error>) -> Void)?, victims = [P.Retained]()
            f.pruneHook = { records, _, done in victims = records; release = done }; try f.advance(5)
            try require(f.controller.isBusy && f.writes == 4); _ = f.controller.cancel(operationId: 5)
            release?(.success(.init(removed: victims, complete: true)))
            try require(!f.controller.isBusy && f.writes == 4 && f.replies.last?.status == .cancelled && f.controller.isolation == nil)
            try require(f.controller.retainedRecords.count == 3 && f.cleanups.last == .discardUnpublished)
        }
        test("unknown prune ACK preserves confirmed registry and blocks lane") {
            let f = try Fixture(); for id in 1...4 { try f.advance(id) }
            let before = f.controller.knownLedger, retained = f.controller.retainedRecords
            f.pruneHook = { _, _, done in done(.success(.init(removed: [], complete: false))) }; try f.advance(5)
            try require(f.writes == 4 && f.controller.knownLedger == before && f.controller.retainedRecords == retained)
            try require(f.controller.isolation != nil && f.replies.last?.status == .unavailable)
            try f.advance(6); try require(f.writes == 4 && f.replies.last?.status == .uncertain)
        }
        test("unknown publication reserves max old-new physical bytes once for alias group") {
            let f = try Fixture(); f.publishHook = { _, a, done in do { try a.enterPublish(); f.writes += 1; done(.failure(Bad.injected)) } catch { done(.failure(error)) } }
            try f.start(); try require(f.controller.reservedProviderBytes == max(f.old.count, f.next.count) && f.controller.knownLedger.sequence == 0)
        }

        test("same SHA no-op checks every known alias count against declaration without upgrading it") {
            let f = try Fixture(), alias = try P.Binding(name: "Alias", originalPath: f.binding.originalPath, behavior: .classical, format: .yaml)
            f.rows.append(try .init(binding: alias, fileSHA256: G.digest(f.old), identity: f.oldRow.identity, ruleCount: 2, registeredFile: true)); try f.reset()
            try f.start(f.selection(sha: G.digest(f.old), bytes: f.old.count))
            try require(f.replies.last?.status == .stale && f.blobReads == 0 && f.writes == 0 && f.controller.knownLedger.resources["Alias"]?.ruleCount == 2)
        }
        test("declared count is only a negative constraint and mismatching stage actual count is zero write") {
            let f = try Fixture(); try f.start(f.selection(declared: 2))
            try require(f.writes == 0 && f.replies.last?.status == .unavailable && f.controller.knownLedger.sequence == 0)
            for invalid in [0, P.maximumDeclaredRules + 1] { try rejects { _ = try f.selection(declared: invalid) } }
        }
        test("after publication pure dispatch fence remains valid once but cannot republish") {
            let f = try Fixture(); f.publishHook = { _, a, done in
                do { try a.enterPublish(); f.writes += 1; let token = try a.preparePublishFence(); try a.validateFence(token); try rejects { try a.enterPublish(token) }; done(.success(try f.publication())) } catch { done(.failure(error)) }
            }; try f.start(); try require(f.writes == 1 && f.replies.last?.status == .published)
        }

        test("expired request deadline rejects before even owner or blob IO") {
            let f = try Fixture(); var owners = 0; f.ownerHook = { owners += 1; return f.context }
            try f.start(maximumDeadline: f.time); try require(f.replies.last?.status == .expired && f.blobReads == 0 && owners == 0 && f.writes == 0)
        }
        test("per-request earlier deadline spans stage and cannot be renewed by persistent controller") {
            let f = try Fixture(); f.stageHook = { _, _, _, done in f.time = 6; done(.success(try! f.stage())) }
            try f.start(maximumDeadline: 5); try require(f.writes == 0 && f.replies.last?.status == .expired && f.cleanups == [.discardUnpublished])
        }
        test("a later request deadline cannot extend model total lease") {
            let f = try Fixture(); f.stageHook = { _, _, _, done in f.time += 30_000_000_000; done(.success(try! f.stage())) }
            try f.start(maximumDeadline: 100_000_000_000); try require(f.writes == 0 && f.replies.last?.status == .expired)
        }
        let failed = results.filter { $0["passed"] as? Bool == false }.count
        let output: [String: Any] = ["scope": "standalone synthetic provider authority model; no Core/FS/network/lifecycle", "tests": results, "passed": results.count - failed, "failed": failed]
        let bytes = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10])); if failed > 0 { exit(1) }
    }
}
