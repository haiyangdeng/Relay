// Test target only. Never include this entry point in the shipping client.
import Foundation
import CryptoKit
import Darwin

private typealias M = RelayTunRuntimeResources
private typealias C = RelayTunRuntimeResourcesChannel
private enum FixtureError: Error { case invalid, scope, injectedPostEntry }
private final class ResourceCoreFixture {
    let binding: C.Binding, home: String, configuration: Data, inbox: RelayTunRuntimeResourceInbox
    private let rootFD: Int32, rootIdentity: stat, peerPID: pid_t, initialSHA: String, initialBytes: Int, kind: M.Kind
    private let worker = DispatchQueue(label: "resource-core-fixture.operations"), lock = NSLock(), outputLock = NSLock()
    private let releasePrepare = DispatchSemaphore(value: 0)
    private var liveScope = true, holdPrepare = false, unknownNext = false
    private var controller: M.Controller?, known: M.Ledger?, isolated = false
    private var readCount = 0, prepareCount = 0, commitCount = 0, cancelCount = 0
    private var channel: C?, reader: RelayTunCoreReadiness.Live!
    init(_ raw: [String: Any]) throws {
        guard Set(raw.keys) == ["home", "sourceRoot", "binding", "corePID", "kind", "initialSHA256", "initialBytes"],
              let home = raw["home"] as? String, home.hasPrefix("/private/tmp/relay-session-\(getuid())-"),
              let source = raw["sourceRoot"] as? String, let bound = raw["binding"] as? [String: Any],
              let pid = RelayTunStrictJSON.integer(raw["corePID"]), pid > 0, pid <= Int(Int32.max),
              let name = raw["kind"] as? String, let kind = M.Kind(rawValue: name),
              let sha = raw["initialSHA256"] as? String, M.hash(sha),
              let size = RelayTunStrictJSON.integer(raw["initialBytes"]), size > 0, size <= M.maximumBytes else { throw FixtureError.invalid }
        self.home = home; binding = try .init(bound); peerPID = pid_t(pid); self.kind = kind; initialSHA = sha; initialBytes = size
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: home))
        rootFD = open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard rootFD >= 0 else { throw FixtureError.invalid }
        var root = stat()
        guard fstat(rootFD, &root) == 0, root.st_uid == getuid(), root.st_mode & 0o7777 == 0o700 else { Darwin.close(rootFD); throw FixtureError.invalid }
        rootIdentity = root
        configuration = try Self.read(home + "/config.yaml", maximum: 2 * 1024 * 1024)
        guard M.digest(configuration) == binding.runtimeConfigurationSHA256 else { Darwin.close(rootFD); throw FixtureError.invalid }
        inbox = try .init(sourceRoot: source, coreHome: home)
        reader = try .init(directory: home, configuration: configuration, authorization: nil,
            verifyPeer: { [weak self] fd in
                guard let self else { throw FixtureError.scope }
                var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0, effective: pid_t = 0
                var length = socklen_t(MemoryLayout<pid_t>.size), effectiveLength = length
                guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
                      getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid == peerPID,
                      getsockopt(fd, SOL_LOCAL, LOCAL_PEEREPID, &effective, &effectiveLength) == 0, effective == peerPID else { throw FixtureError.scope }
            })
    }
    deinit { Darwin.close(rootFD) }
    private static func read(_ path: String, maximum: Int) throws -> Data {
        try RelayTunDescriptor.checkPlainPath(URL(fileURLWithPath: path))
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw FixtureError.invalid }; defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_uid == getuid(), before.st_mode == mode_t(S_IFREG) | 0o600,
              before.st_nlink == 1, before.st_size > 0, before.st_size <= maximum else { throw FixtureError.invalid }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let size = Darwin.read(fd, &buffer, buffer.count)
            if size < 0, errno == EINTR { continue }
            guard size >= 0, data.count + max(0, size) <= maximum else { throw FixtureError.invalid }
            if size == 0 { break }; data.append(contentsOf: buffer.prefix(size))
        }
        guard fstat(fd, &after) == 0, lstat(path, &linked) == 0, same(before, after), same(after, linked), data.count == before.st_size else { throw FixtureError.invalid }
        return data
    }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode &&
        a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
        a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private func check(_ context: C.Context) throws {
        try context.check(); lock.lock(); let live = liveScope; lock.unlock()
        guard live else { throw FixtureError.scope }
        var held = stat(), linked = stat()
        guard fstat(rootFD, &held) == 0, lstat(home, &linked) == 0, held.st_dev == rootIdentity.st_dev, held.st_ino == rootIdentity.st_ino,
              linked.st_dev == held.st_dev, linked.st_ino == held.st_ino, held.st_uid == getuid(), held.st_gid == rootIdentity.st_gid,
              held.st_mode & 0o7777 == 0o700 else { throw FixtureError.scope }
    }
    /// Test-only independent target oracle adapted from AppBundle's bounded
    /// NOFOLLOW streaming reader. Production AppBundle routing is tested in
    /// its own real AppSession/compile-time injected-child suite.
    private func files(_ state: RelayTunCoreReadiness.ResourceState, check: () throws -> Void) throws -> M.Ledger {
        guard state.resources.count == 1, state.resources[0].kind == kind else { throw FixtureError.invalid }
        let row = state.resources[0], fd = openat(rootFD, kind.basename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw FixtureError.invalid }; defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_uid == getuid(), before.st_gid == rootIdentity.st_gid,
              before.st_mode == mode_t(S_IFREG) | 0o600, before.st_nlink == 1, before.st_size == row.bytes else { throw FixtureError.invalid }
        var hasher = SHA256(), size = 0, buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            try check(); let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0, errno == EINTR { continue }
            guard count >= 0, size + max(0, count) <= M.maximumBytes else { throw FixtureError.invalid }
            if count == 0 { break }; size += count; hasher.update(data: buffer.prefix(count))
        }
        guard fstat(fd, &after) == 0, fstatat(rootFD, kind.basename, &linked, AT_SYMLINK_NOFOLLOW) == 0,
              Self.same(before, after), Self.same(after, linked), size == row.bytes,
              hasher.finalize().map({ String(format: "%02x", $0) }).joined() == row.sha256 else { throw FixtureError.invalid }
        let identity = try M.FileIdentity(device: UInt64(UInt32(bitPattern: after.st_dev)), inode: UInt64(after.st_ino), ownerUID: after.st_uid,
            mode: UInt32(after.st_mode), links: UInt64(after.st_nlink), bytes: size,
            modifiedNS: UInt64(after.st_mtimespec.tv_sec) * 1_000_000_000 + UInt64(after.st_mtimespec.tv_nsec),
            changedNS: UInt64(after.st_ctimespec.tv_sec) * 1_000_000_000 + UInt64(after.st_ctimespec.tv_nsec))
        try check()
        return try .init(bootId: state.bootId, generationSHA256: state.generationSHA256, sequence: state.sequence,
            resources: [.init(kind: row.kind, sha256: row.sha256, identity: identity, active: row.active)])
    }
    private func read(_ context: C.Context) throws -> C.Observation {
        guard !isolated else { throw C.Failure.uncertain }
        let state = try reader.readResources(before: context.deadline, check: { try self.check(context) })
        let value = try files(state, check: { try self.check(context) })
        if let known { guard known == value else { throw FixtureError.scope } }
        else {
            guard value.sequence == 0, value.resources[kind]?.sha256 == initialSHA,
                  value.resources[kind]?.bytes == initialBytes else { throw FixtureError.scope }; known = value
        }
        lock.lock(); readCount += 1; lock.unlock()
        return .init(configurationRevision: binding.runtimeConfigurationSHA256, ledger: value)
    }
    private func replace(_ id: Int, _ selected: M.Selection, _ context: C.Context, done: @escaping (M.Reply) -> Void) {
        if isolated { done(.init(status: .uncertain)); return }
        do {
            let previous = try read(context).ledger
            let driver = M.Driver(currentOwner: { [weak self] in
                guard let self else { throw FixtureError.scope }; try check(context)
                return try .init(heldGeneration: 1, configurationRevision: binding.runtimeConfigurationSHA256, coreBootId: previous.bootId, ordinaryUID: getuid())
            }, readBlob: { [self] selection, access, reply in
                do { reply(.success(try inbox.consume(selection, check: access.check))) } catch { reply(.failure(error)) }
            }, prepareCore: { [self] selection, blob, access, reply in
                do {
                    try inbox.stage(selection, blob: blob, check: access.check)
                    let prepared = try reader.prepareResource(selection, access: access)
                    lock.lock(); prepareCount += 1; let hold = holdPrepare; lock.unlock()
                    if hold {
                        emit(["event": "preparedHeld"])
                        guard releasePrepare.wait(timeout: .now() + 10) == .success else { throw FixtureError.scope }
                    }
                    reply(.success(prepared))
                } catch { reply(.failure(error)) }
            }, commitCore: { [self] prepared, access, reply in
                do {
                    let receipt = try reader.commitResource(prepared, access: access)
                    lock.lock(); commitCount += 1; let unknown = unknownNext; unknownNext = false; lock.unlock()
                    if unknown { throw FixtureError.injectedPostEntry }
                    let state = try reader.readResources(before: access.deadline, check: access.check)
                    let readback = try files(state, check: access.check)
                    guard readback.bootId == receipt.bootId, readback.sequence == receipt.sequence,
                          readback.generationSHA256 == receipt.generationSHA256, let old = previous.resources[selected.kind] else { throw FixtureError.scope }
                    try inbox.registerRetained(nonce: prepared.nonce, previous: old, applied: receipt, check: access.check)
                    reply(.success(.init(receipt: receipt, readback: readback)))
                } catch { reply(.failure(error)) }
            }, cancelPrepared: { [self] prepared, _, deadline, reply in
                do {
                    let value = try reader.cancelResource(prepared, before: deadline, check: {})
                    lock.lock(); cancelCount += 1; lock.unlock(); reply(.success(value))
                } catch { reply(.failure(error)) }
            })
            let current = try M.Controller(ledger: previous, staticAssetBytes: 0, driver: driver)
            lock.lock(); controller = current; let live = liveScope; lock.unlock(); if !live { current.close() }
            current.replace(id: id, selection: selected) { [self, current] response in
                var result = response
                isolated = current.isIsolated
                if response.status == .updated { known = response.ledger }
                try? inbox.cleanupStage(selected.blobId)
                do { try check(context) } catch { if result.status == .updated { isolated = true; result = .init(status: .uncertain) } }
                lock.lock(); if controller === current { controller = nil }; lock.unlock()
                done(result)
            }
        } catch { done(.init(status: .unavailable)) }
    }
    func start() throws {
        let digest = M.digest(try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[0])))
        let driver = C.Driver(read: { [weak self] context, done in
            guard let self else { done(.failure(FixtureError.scope)); return }
            do { done(.success(try read(context))) } catch { done(.failure(error)) }
        }, replace: { [weak self] id, selection, context, done in
            guard let self else { done(.init(status: .unavailable)); return }; replace(id, selection, context, done: done)
        }, cancelReplace: { [weak self] id in
            guard let self else { return .init(status: .unavailable) }
            lock.lock(); let current = controller; lock.unlock(); return current?.cancel(operationId: id) ?? .init(status: .stale)
        }, discard: { [weak self] ticket, context, done in
            guard let self else { done(.failure(FixtureError.scope)); return }
            do { done(.success(try inbox.discardBlob(ticket, check: context.check))) } catch { done(.failure(error)) }
        }, invalidate: { [weak self] in self?.invalidate() })
        guard let channel = C(binding: binding, clientSHA256: digest, installationRevision: String(repeating: "e", count: 64), driver: driver,
                              execute: { [weak self] work in self?.worker.async { work() } }) else { throw FixtureError.invalid }
        self.channel = channel; emit(["event": "CONTROL_READY"]); channel.start()
    }
    private func invalidate() {
        lock.lock(); liveScope = false; let current = controller; lock.unlock(); current?.close(); releasePrepare.signal()
    }
    private func emit(_ value: [String: Any]) {
        outputLock.lock(); defer { outputLock.unlock() }
        if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(bytes + Data([10]))
        }
    }
    func command(_ command: String) throws {
        switch command {
        case "hold-prepare": lock.lock(); holdPrepare = true; lock.unlock(); emit(["event": "holdReady"])
        case "release-prepare": lock.lock(); holdPrepare = false; lock.unlock(); releasePrepare.signal()
        case "unknown-next": lock.lock(); unknownNext = true; lock.unlock(); emit(["event": "unknownReady"])
        case "state":
            worker.async { [self] in
                lock.lock(); let counts = ["reads": readCount, "prepares": prepareCount, "commits": commitCount, "cancels": cancelCount]; lock.unlock()
                emit(["event": "state", "counts": counts, "isolated": isolated, "registeredEntries": inbox.inventory.count])
            }
        default: throw FixtureError.invalid
        }
    }
    func close() { channel?.invalidate(); worker.sync {}; channel = nil; emit(["event": "CLOSED"]) }
    static func descriptor(_ path: String) throws -> [String: Any] {
        guard path.hasPrefix("/private/tmp/relay-session-\(getuid())-") else { throw FixtureError.invalid }
        return try RelayTunStrictJSON.object(read(path, maximum: 8192), limit: 8192)
    }
}
@main private struct ResourceCoreMain {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 2 else { exit(77) }
        do {
            let fixture = try ResourceCoreFixture(ResourceCoreFixture.descriptor(CommandLine.arguments[1]))
            try fixture.start()
            while let line = readLine() { try fixture.command(line) }
            fixture.close()
        } catch { FileHandle.standardError.write(Data("Private resource fixture failed.\n".utf8)); exit(1) }
    }
}
