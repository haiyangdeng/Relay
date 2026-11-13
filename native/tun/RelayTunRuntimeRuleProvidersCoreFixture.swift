// Test-only inherited-pipe integration. Never add to a shipping source list.
// The ordinary UID Node runner positively owns the active sandbox child; its
// held peer/root are injected here. This does not implement TUN authorization.
import Foundation
import Darwin
private typealias P = RelayTunRuntimeRuleProviders
private typealias C = RelayTunRuntimeRuleProvidersChannel
private typealias Q = RelayTunRuntimeRuleProviderProbe
private typealias F = RelayTunRuntimeRuleProviderFiles
private enum FixtureError: Error { case invalid, revoked, lostResult }
private final class ProviderCoreFixture {
    private let home: String, configuration: Data, core: Data, binding: C.Binding, peerPID: pid_t
    private let rootFD: Int32, root: stat, names: [String], path: String, format: P.Format, behavior: P.Behavior
    private let inbox: RelayTunRuntimeResourceInbox
    private let worker = DispatchQueue(label: "provider-runtime-fixture"), lock = NSLock(), outputLock = NSLock()
    private let releaseStage = DispatchSemaphore(value: 0)
    private var live = true, holding = false, loseNext = false, isolated = false
    private var controller: P.Controller?, files: F?, channel: C?, reader: RelayTunCoreReadiness.Live!
    private var context: P.Context?, projection: Q.Projection?, selected: P.Selection?, request: C.Context?
    private var probes = [Q.Session](), counts = ["reads": 0, "probes": 0, "stages": 0, "swaps": 0, "puts": 0]
    init(_ raw: [String: Any]) throws {
        guard Set(raw.keys) == ["home", "sourceRoot", "binding", "corePID", "path", "names", "format", "behavior"],
              let home = raw["home"] as? String, home.hasPrefix("/private/tmp/relay-session-\(getuid())-"),
              let source = raw["sourceRoot"] as? String, let bound = raw["binding"] as? [String: Any],
              let pid = RelayTunStrictJSON.integer(raw["corePID"]), pid > 0, pid <= Int(Int32.max),
              let path = raw["path"] as? String, let names = raw["names"] as? [String], names.count == 2,
              let f = raw["format"] as? String, let format = P.Format(rawValue: f),
              let b = raw["behavior"] as? String, let behavior = P.Behavior(rawValue: b) else { throw FixtureError.invalid }
        self.home = home; self.path = path; self.names = names.sorted(); self.format = format; self.behavior = behavior
        binding = try .init(bound); peerPID = pid_t(pid)
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: home))
        rootFD = open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard rootFD >= 0 else { throw FixtureError.invalid }
        var observed = stat(); guard fstat(rootFD, &observed) == 0, observed.st_uid == getuid(), observed.st_mode == mode_t(S_IFDIR) | 0o700 else { Darwin.close(rootFD); throw FixtureError.invalid }; root = observed
        configuration = try Self.read(home + "/config.yaml", maximum: 2 * 1024 * 1024, mode: 0o600)
        core = try Self.read(home + "/mihomo-probe", maximum: Q.corePin.bytes, mode: 0o500)
        guard P.Shared.digest(configuration) == binding.runtimeConfigurationSHA256, core.count == Q.corePin.bytes, P.Shared.digest(core) == Q.corePin.sha256 else { throw FixtureError.invalid }
        for name in names { _ = try P.Binding(name: name, originalPath: path, behavior: behavior, format: format) }
        inbox = try .init(sourceRoot: source, coreHome: home)
        reader = try .init(directory: home, configuration: configuration, authorization: nil, verifyPeer: { [weak self] fd in
            guard let self else { throw FixtureError.revoked }
            var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0, effective: pid_t = 0
            var size = socklen_t(MemoryLayout<pid_t>.size), other = size
            guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
                  getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0, pid == self.peerPID,
                  getsockopt(fd, SOL_LOCAL, LOCAL_PEEREPID, &effective, &other) == 0, effective == self.peerPID else { throw FixtureError.revoked }
        })
    }
    deinit { Darwin.close(rootFD) }
    private static func read(_ path: String, maximum: Int, mode: mode_t) throws -> Data {
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: path))
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC); guard fd >= 0 else { throw FixtureError.invalid }; defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_mode == mode_t(S_IFREG) | mode, before.st_uid == getuid(), before.st_nlink == 1, before.st_size > 0, before.st_size <= maximum else { throw FixtureError.invalid }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = Darwin.read(fd, &buffer, buffer.count); if n < 0, errno == EINTR { continue }
            guard n >= 0, result.count + max(n, 0) <= maximum else { throw FixtureError.invalid }
            if n == 0 { break }; result.append(contentsOf: buffer.prefix(n))
        }
        guard fstat(fd, &after) == 0, lstat(path, &linked) == 0, same(before, after), same(after, linked), result.count == before.st_size else { throw FixtureError.invalid }; return result
    }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private func authority() throws -> P.Context {
        lock.lock(); let valid = live; lock.unlock(); guard valid, let context else { throw FixtureError.revoked }
        var held = stat(), linked = stat()
        guard fstat(rootFD, &held) == 0, lstat(home, &linked) == 0, held.st_dev == root.st_dev, held.st_ino == root.st_ino,
              held.st_dev == linked.st_dev, held.st_ino == linked.st_ino, held.st_uid == getuid(), held.st_mode == root.st_mode else { throw FixtureError.revoked }
        return context
    }
    private func check(_ context: C.Context) throws { try context.check(); _ = try authority() }
    private func observation(_ c: C.Context) throws -> C.Observation {
        guard !isolated else { throw C.Failure.uncertain }
        try c.check()
        let metadata = try reader.readRuleProviders(before: c.deadline, check: c.check)
        if controller == nil {
            let state = try reader.readResources(before: c.deadline, check: c.check)
            guard state.sequence == 0, state.resources.isEmpty else { throw FixtureError.invalid }
            context = .init(owner: try .init(heldGeneration: 1, configurationRevision: binding.runtimeConfigurationSHA256, coreSHA256: Q.corePin.sha256, ordinaryUID: getuid()), geo: try .init(generationSHA256: state.generationSHA256, bytes: 0))
            let raw = try RelayTunStrictJSON.object(metadata), entries = raw["providers"] as? [String: Any]
            guard Set(entries?.keys.map { $0 } ?? []) == Set(names) else { throw FixtureError.invalid }
            let body = try Self.read(home + "/" + path, maximum: P.maximumBytes, mode: 0o600)
            var info = stat(); guard lstat(home + "/" + path, &info) == 0 else { throw FixtureError.invalid }
            let rows = try names.map { name -> P.Resource in
                guard let row = entries?[name] as? [String: Any], RelayTunStrictJSON.integer(row["ruleCount"]) == 1 else { throw FixtureError.invalid }
                return try .init(binding: .init(name: name, originalPath: path, behavior: behavior, format: format), fileSHA256: P.Shared.digest(body), identity: F.identity(info), ruleCount: 1, registeredFile: true)
            }
            files = try .init(coreHome: home, resources: rows, allowedFileNames: [String(path.split(separator: "/").last!)])
            let head = P.Shared.digest(Data(("provider fixture initial v1" + binding.runtimeConfigurationSHA256 + P.Shared.digest(body)).utf8))
            let created = try makeController(.init(generationSHA256: head, sequence: 0, resources: rows))
            lock.lock(); controller = created; let valid = live; lock.unlock(); if !valid { created.close() }
        }
        guard let controller, controller.isolation == nil, let files else { throw FixtureError.revoked }
        try files.verifyKnownLayouts(check: { try self.check(c) })
        // No later read adopts a foreign target/count or explains an unknown.
        let raw = try RelayTunStrictJSON.object(metadata), entries = raw["providers"] as? [String: Any]
        for row in controller.knownLedger.resources.values {
            guard let actual = entries?[row.binding.name] as? [String: Any], RelayTunStrictJSON.integer(actual["ruleCount"]) == row.ruleCount else { throw FixtureError.invalid }
        }
        counts["reads", default: 0] += 1
        return .init(configurationRevision: binding.runtimeConfigurationSHA256, ledger: controller.knownLedger)
    }
    private func makeController(_ ledger: P.Ledger) throws -> P.Controller {
        let driver = P.Driver(supportsSynchronousFileRead: true, currentContext: { try self.authority() }, readBlob: { [self] s, access, done in
            do {
                let kind = RelayTunRuntimeResourceInbox.ProviderKind(rawValue: "rule-" + format.rawValue)!
                let t = try RelayTunRuntimeResourceInbox.ProviderTicket(blobId: s.blobId, kind: kind, sha256: s.newSHA256, bytes: s.bytes, filename: s.blobId + "." + format.rawValue)
                let blob = try inbox.consumeProvider(t, check: access.check)
                done(.success(try .init(id: blob.id, format: format, data: blob.data, identity: blob.identity)))
            } catch { done(.failure(error)) }
        }, stage: { [self] group, blob, access, done in
            do {
                guard let s = selected, let c = request, let files else { throw FixtureError.invalid }
                try files.verifyKnownLayouts(check: access.check)
                let data = try Self.read(home + "/" + path, maximum: P.maximumBytes, mode: 0o600)
                let snapshot = try Q.Snapshot(configuration: configuration, assets: [.init(path: path, data: data, identity: group[0].identity)], context: authority(), group: group,
                    expectedRuleCounts: Dictionary(uniqueKeysWithValues: controller!.knownLedger.resources.values.map { ($0.binding.name, $0.ruleCount) }))
                let p = try Q.project(snapshot, blob: blob, declaredRuleCount: s.declaredRuleCount), fence = try access.preparePublishFence()
                counts["probes", default: 0] += 1
                let session = Q.Session(projection: p, deadline: access.deadline, check: { try access.validateFence(fence); try c.check() }, buildWorkspace: { try RelayTunRuleProviderProbeWorkspace.testWorkspace(projection: $0, core: self.core) }, register: { probes.append($0) })
                let receipt = try session.perform(); probes.removeAll { $0.isSettled }
                guard receipt.bodySHA256 == s.newSHA256 else { throw FixtureError.invalid }; projection = p
                lock.lock(); let hold = holding; lock.unlock()
                if hold { emit(["event": "stageHeld"]); guard releaseStage.wait(timeout: .now() + 10) == .success else { throw FixtureError.revoked } }
                try access.check()
                let stage = try files.stage(group: group, blob: blob, checkedRuleCounts: receipt.counts, check: access.check)
                counts["stages", default: 0] += 1; done(.success(stage))
            } catch { done(.failure(error)) }
        }, prune: { [self] records, access, done in done(.success(files!.prune(records, check: access.check))) }, publish: { [self] stage, access, done in
            do {
                let swap = try files!.swap(stage, access: access); counts["swaps", default: 0] += 1
                let fence = try access.preparePublishFence(); var puts = Set<String>()
                for binding in stage.bindings {
                    try reader.updateRuleProvider(name: binding.name, before: access.deadline, check: access.check, beforeDispatch: { try access.validateFence(fence) })
                    puts.insert(binding.name); counts["puts", default: 0] += 1
                }
                lock.lock(); let lose = loseNext; loseNext = false; lock.unlock(); if lose { throw FixtureError.lostResult }
                let metadata = try reader.readRuleProviders(before: access.deadline, check: access.check)
                let receipt = try Q.accepted(projection!, putAccepted: puts, metadata: metadata)
                _ = try files!.verifySwapped(stage, check: access.check)
                let names = Set(stage.bindings.map { $0.name })
                let rows = try controller!.knownLedger.resources.values.map { old -> P.Resource in
                    if !names.contains(old.binding.name) { return old }
                    return try .init(binding: old.binding, fileSHA256: stage.sha256, identity: swap.currentIdentity, ruleCount: receipt.counts[old.binding.name]!, registeredFile: true)
                }
                done(.success(.init(retained: swap.retained, resources: rows, acceptance: .synchronousFileRead)))
            } catch { done(.failure(error)) }
        }, cleanup: { [self] stage, action, done in
            do { if action == .discardUnpublished { try files!.discardUnpublished(stage, check: {}) } else { try files!.verifyKnownLayouts(check: {}) }; done(.success(())) } catch { done(.failure(error)) }
        })
        return try .init(ledger: ledger, staticAssetBytes: 0, initialGeo: context!.geo, driver: driver)
    }
    private func replace(_ id: Int, _ s: C.Selection, _ c: C.Context, done: @escaping (P.Reply) -> Void) {
        if isolated { done(.init(status: .uncertain)); return }
        do {
            _ = try observation(c); let authority = try authority()
            let input = try P.Selection(provider: s.provider, configurationRevision: s.configurationRevision, expectedGenerationSHA256: s.expectedGenerationSHA256, expectedGeoGenerationSHA256: authority.geo.generationSHA256, oldSHA256: s.oldSHA256, newSHA256: s.newSHA256, blobId: s.blobId, bytes: s.bytes, declaredRuleCount: s.declaredRuleCount)
            selected = input; request = c
            controller!.replace(id: id, selection: input, maximumDeadline: c.deadline) { [self] response in
                isolated = controller!.isolation != nil; selected = nil; request = nil; projection = nil; done(response)
            }
        } catch { done(.init(status: .unavailable)) }
    }
    func start() throws {
        let driver = C.Driver(read: { [self] c, done in do { done(.success(try observation(c))) } catch { done(.failure(error)) } }, replace: replace,
            cancelReplace: { [self] id in lock.lock(); let value = controller; lock.unlock(); return value?.cancel(operationId: id) ?? .init(status: .stale) },
            discard: { [self] ticket, c, done in
                do {
                    let t = try RelayTunRuntimeResourceInbox.ProviderTicket(blobId: ticket.blobId, kind: .init(rawValue: ticket.kind.rawValue)!, sha256: ticket.sha256, bytes: ticket.bytes, filename: ticket.filename)
                    let result = try inbox.discardProviderBlob(t, check: c.check); done(.success(result == .discarded ? .discarded : .absent))
                } catch { done(.failure(error)) }
            }, invalidate: { [weak self] in self?.invalidate() })
        let digest = P.Shared.digest(try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[0])))
        guard let channel = C(binding: binding, clientSHA256: digest, installationRevision: String(repeating: "e", count: 64), driver: driver, execute: { [self] work in worker.async { work() } }) else { throw FixtureError.invalid }
        self.channel = channel; emit(["event": "CONTROL_READY"]); channel.start()
    }
    private func invalidate() { lock.lock(); live = false; let value = controller; lock.unlock(); value?.close(); releaseStage.signal() }
    private func emit(_ value: [String: Any]) {
        outputLock.lock(); defer { outputLock.unlock() }
        if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { FileHandle.standardOutput.write(bytes + Data([10])) }
    }
    func command(_ value: String) throws {
        switch value {
        case "hold-stage": lock.lock(); holding = true; lock.unlock(); emit(["event": "holdReady"])
        case "release-stage": lock.lock(); holding = false; lock.unlock(); releaseStage.signal()
        case "lose-next": lock.lock(); loseNext = true; lock.unlock(); emit(["event": "loseReady"])
        case "state": worker.async { [self] in emit(["event": "state", "counts": counts, "isolated": isolated, "sequence": controller?.knownLedger.sequence ?? 0, "retained": controller?.retainedRecords.count ?? 0]) }
        case "core-closed-cleanup":
            // The runner positively reaps its own Core before this explicit
            // test-only command; no Core lifecycle action occurs here.
            worker.async { [self] in
                do { for probe in probes { try probe.cleanup() }; try files?.cleanup(); try inbox.cleanup(); emit(["event": "cleaned"]) }
                catch { emit(["event": "cleanupFailure", "error": String(describing: error)]) }
            }
        default: throw FixtureError.invalid
        }
    }
    func close() { channel?.invalidate(); worker.sync {}; channel = nil; emit(["event": "CLOSED"]) }
    static func descriptor(_ path: String) throws -> [String: Any] {
        guard path.hasPrefix("/private/tmp/relay-session-\(getuid())-") else { throw FixtureError.invalid }
        return try RelayTunStrictJSON.object(read(path, maximum: 8192, mode: 0o600), limit: 8192)
    }
}
@main private struct ProviderCoreMain {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 2 else { exit(77) }
        do { let fixture = try ProviderCoreFixture(ProviderCoreFixture.descriptor(CommandLine.arguments[1])); try fixture.start(); while let line = readLine() { try fixture.command(line) }; fixture.close() }
        catch { FileHandle.standardError.write(Data(("Private provider fixture failed: " + String(describing: error) + "\n").utf8)); exit(1) }
    }
}
