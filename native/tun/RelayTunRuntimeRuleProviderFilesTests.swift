// Ordinary-UID private filesystem and authority model. No Core/helper/TUN,
// socket, network, installation or production file is accessed by this target.
import Foundation
import Darwin
private typealias P = RelayTunRuntimeRuleProviders
private typealias F = RelayTunRuntimeRuleProviderFiles
private typealias G = RelayTunRuntimeResources
private enum Bad: Error { case assertion(String), cancelled }
private func expect(_ value: @autoclosure () throws -> Bool, _ message: String = "assertion") throws { guard try value() else { throw Bad.assertion(message) } }
private func rejects(_ body: () throws -> Void) throws { do { try body() } catch { return }; throw Bad.assertion("expected rejection") }
private func put(_ path: String, _ body: Data) throws { try body.write(to: URL(fileURLWithPath: path), options: .withoutOverwriting); guard chmod(path, 0o600) == 0 else { throw Bad.assertion("chmod") } }
private func data(_ path: String) throws -> Data { try Data(contentsOf: URL(fileURLWithPath: path)) }
private func info(_ path: String) throws -> stat { var value = stat(); guard lstat(path, &value) == 0 else { throw Bad.assertion("lstat") }; return value }
private final class Fixture {
    let home: String, originalRoot: stat, target: String, initial: [P.Resource], old = Data("DOMAIN,old.synthetic.invalid\n".utf8)
    var body = Data("DOMAIN,new.synthetic.invalid\n".utf8), files: F!, controller: P.Controller!
    var replies = [P.Reply](), time: UInt64 = 1, puts = 0, stage: P.Stage?, swapped: F.Swap?
    var stageCheck: (() throws -> Void)?, transition: (() throws -> Void)?, ownerHook: (() throws -> P.Context)?, pruneCheck: (() throws -> Void)?
    var afterSwap: (() throws -> Void)?, onReply: (() -> Void)?, publishQueue: DispatchQueue?, context: P.Context
    init(aliases: Bool = false) throws {
        var pattern = Array("/private/tmp/relay-session-\(getuid())-provider-files-XXXXXX".utf8CString)
        guard mkdtemp(&pattern) != nil else { throw Bad.assertion("mkdtemp") }; home = String(cString: pattern); originalRoot = try info(home)
        guard mkdir(home + "/relay-files", 0o700) == 0 else { throw Bad.assertion("mkdir") }
        let binding = try P.Binding(name: "Only", originalPath: "relay-files/" + G.digest(old) + ".yaml", behavior: .domain, format: .yaml)
        target = home + "/" + binding.originalPath; try put(target, old)
        let row = try P.Resource(binding: binding, fileSHA256: G.digest(old), identity: F.identity(info(target)), ruleCount: 1, registeredFile: true)
        if aliases {
            let b = try P.Binding(name: "Alias", originalPath: binding.originalPath, behavior: .classical, format: .yaml)
            initial = [try .init(binding: b, fileSHA256: row.fileSHA256, identity: row.identity, ruleCount: 2, registeredFile: true), row]
        } else { initial = [row] }
        context = .init(owner: try .init(heldGeneration: 1, configurationRevision: String(repeating: "c", count: 64), coreSHA256: String(repeating: "d", count: 64), ordinaryUID: getuid()), geo: try .init(generationSHA256: String(repeating: "b", count: 64), bytes: 0))
    }
    func open() throws {
        files = try .init(coreHome: home, resources: initial, allowedFileNames: [String(target.split(separator: "/").last!)])
        let driver = P.Driver(supportsSynchronousFileRead: true, currentContext: { [unowned self] in try ownerHook?() ?? context }, readBlob: { [unowned self] selection, access, done in
            do {
                try access.check(); let path = home + "/synthetic-blob-" + UUID().uuidString.lowercased(); try put(path, body)
                done(.success(try .init(id: selection.blobId, format: .yaml, data: body, identity: F.identity(info(path)))))
            } catch { done(.failure(error)) }
        }, stage: { [unowned self] group, blob, access, done in
            do {
                let counts = Dictionary(uniqueKeysWithValues: group.map { ($0.binding.name, 1) })
                let value = try files.stage(group: group, blob: blob, checkedRuleCounts: counts, check: { try access.check(); try stageCheck?() })
                stage = value; done(.success(value))
            } catch { done(.failure(error)) }
        }, prune: { [unowned self] victims, access, done in
            done(.success(files.prune(victims, check: { try access.check(); try pruneCheck?() })))
        }, publish: { [unowned self] stage, access, done in
            let operation = { [self] in
            do {
                let result = try files.swap(stage, access: access, onTransitionRegistered: { try transition?() }); swapped = result
                try afterSwap?(); puts += stage.bindings.count
                let names = Set(stage.bindings.map { $0.name })
                let rows = try controller.knownLedger.resources.values.map { row in
                    names.contains(row.binding.name) ? try P.Resource(binding: row.binding, fileSHA256: stage.sha256, identity: result.currentIdentity, ruleCount: stage.checkedRuleCounts[row.binding.name]!, registeredFile: true) : row
                }
                done(.success(.init(retained: result.retained, resources: rows, acceptance: .synchronousFileRead)))
            } catch { done(.failure(error)) }
            }
            if let publishQueue { publishQueue.async(execute: operation) } else { operation() }
        }, cleanup: { [unowned self] stage, action, done in
            do { if action == .discardUnpublished { try files.discardUnpublished(stage, check: {}) }; done(.success(())) } catch { done(.failure(error)) }
        })
        controller = try .init(ledger: .init(generationSHA256: String(repeating: "a", count: 64), sequence: 0, resources: initial), staticAssetBytes: 0, initialGeo: context.geo, driver: driver, clock: { [unowned self] in time })
    }
    func start(_ id: Int = 1) throws {
        let state = controller.knownLedger, row = state.resources["Only"]!
        let s = try P.Selection(provider: "Only", configurationRevision: context.owner.configurationRevision, expectedGenerationSHA256: state.generationSHA256,
                                expectedGeoGenerationSHA256: context.geo.generationSHA256, oldSHA256: row.fileSHA256, newSHA256: G.digest(body),
                                blobId: UUID().uuidString.lowercased(), bytes: body.count, declaredRuleCount: 1)
        controller.replace(id: id, selection: s) { [unowned self] in replies.append($0); onReply?() }
    }
    var stageRoot: String { home + "/" + F.stageDirectory }
    var children: [String] { (try? FileManager.default.contentsOfDirectory(atPath: stageRoot)) ?? [] }
    func cleanup() throws {
        controller = nil; files = nil
        let current = try info(home)
        guard current.st_dev == originalRoot.st_dev, current.st_ino == originalRoot.st_ino, current.st_uid == getuid(), current.st_mode == originalRoot.st_mode else { throw Bad.assertion("changed fixture root retained") }
        try FileManager.default.removeItem(atPath: home)
    }
}
@main private enum ProviderFileTests {
    static func main() {
        guard getuid() > 0, getuid() == geteuid() else { exit(77) }
        var rows = [[String: Any]]()
        func test(_ name: String, aliases: Bool = false, _ body: (Fixture) throws -> Void) {
            var f: Fixture?, failure: Error?, cleanup: Error?
            do { let value = try Fixture(aliases: aliases); f = value; try body(value) } catch { failure = error }
            do { try f?.cleanup() } catch { cleanup = error }
            var row: [String: Any] = ["name": name, "passed": failure == nil && cleanup == nil]
            if let failure { row["error"] = String(describing: failure) }; if let cleanup { row["cleanupError"] = String(describing: cleanup); row["retainedHome"] = f?.home }
            rows.append(row)
        }
        test("one swap replaces whole mixed-behavior group and retains exact old inode", aliases: true) { f in
            try f.open(); try f.start(); try expect(f.replies.last?.status == .published && f.puts == 2)
            try expect(data(f.target) == f.body && f.controller.knownLedger.groups == [["Alias", "Only"]])
            let stage = f.stage!, retained = f.controller.retainedRecords[stage.ticket]!
            try expect(data(f.stageRoot + "/" + stage.ticket + "/payload") == f.old)
            try expect(retained.identity.inode == f.initial[0].identity.inode && retained.identity != stage.identity)
            try expect(f.controller.knownLedger.resources["Alias"]?.ruleCount == 1 && f.controller.knownLedger.resources["Only"]?.ruleCount == 1)
            try f.files.verifyKnownLayouts(check: {})
        }
        test("inactive stage does not publish before its private complete-probe ticket") { f in
            try f.open(); let path = f.home + "/blob"; try put(path, f.body)
            let blob = try P.Blob(id: UUID().uuidString.lowercased(), format: .yaml, data: f.body, identity: F.identity(info(path)))
            let stage = try f.files.stage(group: f.initial, blob: blob, checkedRuleCounts: ["Only": 2], check: {})
            try expect(data(f.target) == f.old && stage.identity.inode != f.initial[0].identity.inode)
            try f.files.discardUnpublished(stage, check: {}); try expect(f.children.isEmpty && data(f.target) == f.old)
        }
        test("cancellation at exclusive empty file and after write drains only owned stage") { f in
            try f.open()
            for afterWrite in [false, true] {
                f.stageCheck = {
                    if let child = f.children.first {
                        let path = f.stageRoot + "/" + child + "/payload"
                        if let metadata = try? info(path), !afterWrite || metadata.st_size > 0 { throw Bad.cancelled }
                    }
                }
                try f.start(afterWrite ? 2 : 1)
                try expect(f.children.isEmpty && data(f.target) == f.old && f.puts == 0 && f.controller.isolation == nil)
            }
        }
        test("unknown sibling during stage cancellation is preserved and isolates lane") { f in
            try f.open(); var added = false
            f.stageCheck = { if !added, let child = f.children.first { added = true; try put(f.stageRoot + "/" + child + "/foreign", Data([7])); throw Bad.cancelled } }
            try f.start(); try expect(f.controller.isolation != nil && f.puts == 0 && f.children.count == 1)
            try expect(data(f.stageRoot + "/" + f.children[0] + "/foreign") == Data([7]))
        }
        test("final owner callback cancel is zero swap and stage cleanup remains possible") { f in
            try f.open(); f.transition = { f.ownerHook = { _ = f.controller.cancel(operationId: 1); return f.context } }
            try f.start(); try expect(f.replies.last?.status == .cancelled && f.puts == 0 && f.children.isEmpty && data(f.target) == f.old)
        }
        test("final owner callback target replacement fails pure fence and preserves foreign inode") { f in
            try f.open(); var once = false
            f.transition = { f.ownerHook = {
                if !once { once = true; guard unlink(f.target) == 0 else { throw Bad.cancelled }; try put(f.target, Data("foreign".utf8)) }; return f.context
            } }
            try f.start(); try expect(f.puts == 0 && f.replies.last?.status == .unavailable && f.controller.isolation != nil)
            try expect(data(f.target) == Data("foreign".utf8) && f.children.count == 1)
        }
        test("final owner callback unknown stage sibling prevents first swap") { f in
            try f.open(); var once = false
            f.transition = { f.ownerHook = { if !once { once = true; try put(f.stageRoot + "/" + f.stage!.ticket + "/foreign", Data([9])) }; return f.context } }
            try f.start(); try expect(f.puts == 0 && data(f.target) == f.old && f.controller.isolation != nil)
            try expect(data(f.stageRoot + "/" + f.stage!.ticket + "/foreign") == Data([9]))
        }
        test("lost acceptance after actual swap is unknown yet finite lifecycle layout remains valid") { f in
            try f.open(); f.afterSwap = { throw Bad.cancelled }; try f.start()
            try expect(f.replies.last?.status == .uncertain && f.controller.knownLedger.sequence == 0 && f.puts == 0)
            try expect(data(f.target) == f.body && data(f.stageRoot + "/" + f.stage!.ticket + "/payload") == f.old)
            try f.files.verifyKnownLayouts(check: {}); try f.start(2); try expect(f.replies.last?.status == .uncertain)
        }
        test("changed active target never passes known-layout inspection") { f in
            try f.open(); try f.start(); guard unlink(f.target) == 0 else { throw Bad.cancelled }; try put(f.target, f.body)
            try rejects { try f.files.verifyKnownLayouts(check: {}) }
        }
        test("confirmed retained prune preserves current target proof and rejects tombstone reappearance") { f in
            try f.open(); try f.start(); let retained = f.controller.retainedRecords[f.stage!.ticket]!
            let result = f.files.prune([retained], check: {}); try expect(result.complete && result.removed == [retained] && f.children.isEmpty)
            try f.files.verifyKnownLayouts(check: {})
            guard mkdir(f.stageRoot + "/" + retained.ticket, 0o700) == 0 else { throw Bad.cancelled }
            let again = f.files.prune([retained], check: {}); try expect(!again.complete && again.removed.isEmpty)
            try expect(FileManager.default.fileExists(atPath: f.stageRoot + "/" + retained.ticket))
        }
        test("last cleanup callback adding sibling preserves old retained payload before first unlink") { f in
            try f.open(); try f.start(); let retained = f.controller.retainedRecords[f.stage!.ticket]!, path = f.stageRoot + "/" + retained.ticket
            var calls = 0
            let result = f.files.prune([retained], check: { calls += 1; if calls == 6 { try put(path + "/foreign", Data([8])) } })
            try expect(!result.complete && result.removed.isEmpty && data(path + "/payload") == f.old && data(path + "/foreign") == Data([8]))
        }
        test("replaced retained inode is never removed even with same bytes") { f in
            try f.open(); try f.start(); let retained = f.controller.retainedRecords[f.stage!.ticket]!, path = f.stageRoot + "/" + retained.ticket + "/payload"
            guard unlink(path) == 0 else { throw Bad.cancelled }; try put(path, f.old)
            let result = f.files.prune([retained], check: {}); try expect(!result.complete && result.removed.isEmpty && data(path) == f.old)
        }
        test("six real swaps remain four retained tickets and exact current file") { f in
            try f.open()
            for id in 1...6 { f.body = Data("DOMAIN,version-\(id).synthetic.invalid\n".utf8); try f.start(id); try expect(f.replies.last?.status == .published) }
            try expect(f.children.count == 4 && f.controller.retainedRecords.count == 4 && f.puts == 6 && data(f.target) == f.body)
            try f.files.verifyKnownLayouts(check: {})
        }
        test("unsafe initial hardlink or permissive provider mode never creates stage namespace") { f in
            guard link(f.target, f.home + "/hardlink") == 0 else { throw Bad.cancelled }
            try rejects { try f.open() }; try expect(!FileManager.default.fileExists(atPath: f.stageRoot))
            guard unlink(f.home + "/hardlink") == 0, chmod(f.target, 0o644) == 0 else { throw Bad.cancelled }
            try rejects { try f.open() }; try expect(!FileManager.default.fileExists(atPath: f.stageRoot))
        }

        test("discard ACK binds full removed stage and does not accept forged tombstone metadata") { f in
            try f.open(); let path = f.home + "/blob"; try put(path, f.body)
            let blob = try P.Blob(id: UUID().uuidString.lowercased(), format: .yaml, data: f.body, identity: F.identity(info(path)))
            let stage = try f.files.stage(group: f.initial, blob: blob, checkedRuleCounts: ["Only": 2], check: {})
            try f.files.discardUnpublished(stage, check: {}); try f.files.discardUnpublished(stage, check: {})
            let forged = P.Stage(ticket: stage.ticket, bindings: stage.bindings, sha256: stage.sha256, identity: stage.identity, checkedRuleCounts: ["Only": 9])
            try rejects { try f.files.discardUnpublished(forged, check: {}) }; try expect(f.children.isEmpty)
        }
        test("final owner callback substituting target directory never escapes pinned namespace") { f in
            try f.open(); var once = false
            f.transition = { f.ownerHook = {
                if !once { once = true; guard rename(f.home + "/relay-files", f.home + "/kept-files") == 0, mkdir(f.home + "/relay-files", 0o700) == 0 else { throw Bad.cancelled } }
                return f.context
            } }
            try f.start(); try expect(f.puts == 0 && f.controller.isolation != nil)
            try expect(data(f.home + "/kept-files/" + String(f.target.split(separator: "/").last!)) == f.old)
            try expect(try FileManager.default.contentsOfDirectory(atPath: f.home + "/relay-files").isEmpty)
        }

        test("real IO queue blocked at final preflight does not block immediate control cancellation") { f in
            try f.open(); let io = DispatchQueue(label: "provider-files-io"), control = DispatchQueue(label: "provider-files-control")
            let held = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), cancelled = DispatchSemaphore(value: 0), settled = DispatchSemaphore(value: 0)
            f.publishQueue = io; f.transition = { held.signal(); guard release.wait(timeout: .now() + 3) == .success else { throw Bad.cancelled } }; f.onReply = { settled.signal() }
            try f.start(); try expect(held.wait(timeout: .now() + 3) == .success)
            control.async { _ = f.controller.cancel(operationId: 1); cancelled.signal() }
            let immediate = cancelled.wait(timeout: .now() + 3) == .success
            let busy = f.controller.isBusy; release.signal(); try expect(settled.wait(timeout: .now() + 3) == .success)
            try expect(immediate && busy && f.replies.last?.status == .cancelled && f.puts == 0 && f.children.isEmpty && data(f.target) == f.old)
        }
        test("Core-closed cleanup preserves target after six swaps and removes exact bounded registry") { f in
            try f.open()
            for id in 1...6 { f.body = Data("DOMAIN,cleanup-\(id).synthetic.invalid\n".utf8); try f.start(id) }
            let target = try info(f.target), ledger = f.controller.knownLedger
            try expect(f.files.inventory.count == 9)
            let inventory = try f.files.validatedTargetInventory()
            try expect(inventory.count == 1 && inventory[0].path == f.initial[0].binding.originalPath)
            try expect(inventory[0].facts.count == 1 && inventory[0].facts[0].identity.st_ino == target.st_ino && inventory[0].facts[0].sha256 == G.digest(f.body))
            try f.files.cleanup(); try f.files.cleanup()
            try expect(!FileManager.default.fileExists(atPath: f.stageRoot) && data(f.target) == f.body && info(f.target).st_ino == target.st_ino)
            try expect(f.files.inventory.isEmpty && f.controller.knownLedger == ledger)
        }
        test("attempted post-swap lost owner check cleans known stage without adopting ledger") { f in
            try f.open(); var cancelled = false
            f.ownerHook = {
                if !cancelled, (try? data(f.target)) == f.body { cancelled = true; _ = f.controller.cancel(operationId: 1) }
                return f.context
            }
            try f.start(); try expect(cancelled && f.replies.last?.status == .uncertain && f.controller.knownLedger.sequence == 0)
            try f.files.verifyKnownLayouts(check: {})
            let observed = try f.files.validatedTargetInventory()
            try expect(observed[0].facts[0].sha256 == G.digest(f.body))
            try f.files.cleanup()
            try expect(data(f.target) == f.body && !FileManager.default.fileExists(atPath: f.stageRoot) && f.controller.knownLedger.sequence == 0)
        }
        test("late foreign sibling in any retained record prevents every cleanup unlink") { f in
            try f.open(); try f.start()
            f.body = Data("DOMAIN,next.synthetic.invalid\n".utf8); try f.start(2)
            let children = f.children.sorted(), foreign = f.stageRoot + "/" + children.last! + "/foreign"
            try put(foreign, Data([7]))
            try rejects { try f.files.cleanup() }
            try expect(f.children.sorted() == children && data(foreign) == Data([7]))
            for child in children { try expect(FileManager.default.fileExists(atPath: f.stageRoot + "/" + child + "/payload")) }
        }
        test("final cleanup callback target substitution preserves every registered stage") { f in
            try f.open(); try f.start(); var called = false
            try rejects { try f.files.cleanup(check: {
                if !called { called = true; guard unlink(f.target) == 0 else { throw Bad.cancelled }; try put(f.target, f.body) }
            }) }
            try expect(called && f.children.count == 1 && data(f.stageRoot + "/" + f.children[0] + "/payload") == f.old && data(f.target) == f.body)
        }
        test("unpublished stage cleanup keeps original target and accepts empty stage registry") { f in
            try f.open(); let path = f.home + "/blob"; try put(path, f.body)
            let blob = try P.Blob(id: UUID().uuidString.lowercased(), format: .yaml, data: f.body, identity: F.identity(info(path)))
            _ = try f.files.stage(group: f.initial, blob: blob, checkedRuleCounts: ["Only": 1], check: {})
            try f.files.cleanup(); try expect(data(f.target) == f.old && !FileManager.default.fileExists(atPath: f.stageRoot))
        }
        let failures = rows.filter { $0["passed"] as? Bool == false }.count
        let value: [String: Any] = ["scope": "ordinary UID private FS/model; Core acceptance callbacks synthetic; no network/Core/TUN/helper", "passed": rows.count - failures, "failed": failures, "tests": rows]
        let output = try! JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]); FileHandle.standardOutput.write(output); FileHandle.standardOutput.write(Data([10])); exit(failures == 0 ? 0 : 1)
    }
}
