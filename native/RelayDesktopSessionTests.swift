import Foundation
import Darwin

private func desktopFixtureRecord(phase: String = "starting", attempted: [String] = []) -> RelayDesktopRecord {
    let original = RelayDesktopIdentity(bundleIdentifier: "org.fixture.browser", appURL: URL(fileURLWithPath: "/fixture/Original.app", isDirectory: true).absoluteString)
    return RelayDesktopRecord(version: 1, sessionID: UUID().uuidString, createdAt: "2026-10-24T00:00:00Z",
        originals: ["http": original, "https": original], temporaryApplication: RelayDesktopInspection.edge,
        attemptedSchemes: attempted, phase: phase)
}

func runRelayDesktopStoreSelfTests() -> Int32 {
    let fm = FileManager.default, temporary = fm.temporaryDirectory.appendingPathComponent("relay-login-store-" + UUID().uuidString)
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    func rejects(_ name: String, _ operation: () throws -> Void) {
        do { try operation(); check(false, name) } catch { check(true, name) }
    }
    defer { try? fm.removeItem(at: temporary) }
    do {
        try fm.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let home = NetworkConfiguration(home: temporary).home
        let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path)
        var events: [String] = []
        let store = try RelayDesktopStore(context, checkpoint: { events.append($0) })
        check(!fm.fileExists(atPath: store.root.path) && !fm.fileExists(atPath: store.legacyDirectory.path), "constructing store has no side effects")
        try store.acquire(); try store.resume()
        check(store.locked && store.current == nil, "complete persistent lease acquired")
        check(events == ["directoryDurable"], "new directory ancestry synchronized before journal publication")
        let competitor = try RelayDesktopStore(context)
        rejects("another session cannot acquire legacy/shared locks") { try competitor.acquire() }
        check(!competitor.locked, "partial lock acquisition releases descriptors")
        rejects("configuration cannot interleave with a login lease") { try RelayStateLock(root: store.root).withLock {} }
        let record = desktopFixtureRecord()
        try store.save(record, initial: true)
        check(events.firstIndex(of: "directoryDurable")! < events.firstIndex(of: "beforePublish")!, "durable directory ancestry precedes first original record")
        let state = try store.stateURL("relay"), originalData = try Data(contentsOf: state)
        check(try RelayDesktopRecord.decode(RelayRecoveryInspector.read(state)!) == record, "published initial record verifies")
        check(try fm.attributesOfItem(atPath: state.path)[.posixPermissions] as? Int == 0o600, "first published byte is private")
        rejects("initial record is not overwritten") { try store.save(desktopFixtureRecord(), initial: true) }
        rejects("record identity cannot be replaced") { try store.save(desktopFixtureRecord()) }
        let attempted = record.updating(phase: "starting", attempted: ["http", "https"])
        try store.save(attempted)
        check(store.current?.record.attemptedSchemes == ["http", "https"], "both setter attempts durable before change")
        rejects("attempts cannot be erased") { try store.save(record) }
        try store.save(attempted.updating(phase: "active"))
        rejects("active session cannot return to starting") { try store.save(attempted) }
        let activeData = try Data(contentsOf: state)
        try NetworkConfiguration.safeWrite(activeData + Data("\n".utf8), to: state)
        rejects("exact digest detects same-session external rewrite") { try store.assertCurrent() }
        rejects("external bytes are not overwritten by a new phase") { try store.save(attempted.updating(phase: "restoring")) }
        check(try Data(contentsOf: state) == activeData + Data("\n".utf8), "external record retained exactly")
        try NetworkConfiguration.safeWrite(activeData, to: state)
        try store.save(attempted.updating(phase: "restoring"))
        try store.remove()
        check(store.current == nil && !fm.fileExists(atPath: state.path), "durable remove clears cursor")
        store.release()
        try competitor.acquire(); try competitor.resume()
        check(competitor.current == nil, "lease released only after explicit completion")
        competitor.release()
        let legacy = try store.stateURL("legacy")
        try NetworkConfiguration.safeWrite(originalData, to: legacy)
        try store.acquire(); try store.resume()
        check(store.current?.source == "legacy" && !fm.fileExists(atPath: state.path), "legacy record adopted in place without copying")
        try store.save(record.updating(phase: "restoring"))
        check(try RelayDesktopRecord.decode(RelayRecoveryInspector.read(legacy)!).phase == "restoring", "explicit recovery updates original legacy journal")
        try store.remove(); store.release()
        try NetworkConfiguration.safeWrite(originalData, to: legacy)
        try NetworkConfiguration.safeWrite(originalData, to: state)
        try store.acquire()
        rejects("two records cannot be silently selected") { try store.resume() }
        check(try Data(contentsOf: state) == originalData && Data(contentsOf: legacy) == originalData, "both conflicting records preserved")
        store.release()
        try fm.removeItem(at: state); try fm.removeItem(at: legacy)
        let lockURL = store.legacyDirectory.appendingPathComponent(".lock")
        let fd = Darwin.open(lockURL.path, O_RDWR | O_NOFOLLOW)
        guard fd >= 0 else { throw AssistantError("fixture lock") }
        check(flock(fd, LOCK_EX | LOCK_NB) == 0, "simulate legacy app owning actual lock")
        rejects("legacy owner blocks new login before journal write") { try store.acquire() }
        Darwin.close(fd)
        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: lockURL.path)
        rejects("unsafe lock mode is not repaired or reused") { try store.acquire() }
        check(try fm.attributesOfItem(atPath: lockURL.path)[.posixPermissions] as? Int == 0o644, "lock permissions left unchanged")
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lockURL.path)
        try store.acquire(); try store.save(record, initial: true)
        let heldLock = store.directory.appendingPathComponent(".lock")
        try fm.removeItem(at: heldLock)
        try NetworkConfiguration.safeWrite(Data(), to: heldLock)
        rejects("lock inode replacement invalidates lease") { try store.assertCurrent() }
        store.release()
        try fm.removeItem(at: state)
        try NetworkConfiguration.safeWrite(Data("PRIVATE invalid state".utf8), to: legacy)
        try store.acquire()
        rejects("invalid legacy record cannot be overwritten or ignored") { try store.resume() }
        check(try Data(contentsOf: legacy) == Data("PRIVATE invalid state".utf8), "malformed legacy bytes preserved")
        store.release()
    } catch { failures.append("unexpected fixture failure") }
    print(failures.isEmpty ? "PASS: \(count) desktop durable store checks; fixture HOME only, no application or default changes." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}

private let desktopFixtureBrowser = RelayDesktopInspection.edge

@MainActor
private final class DesktopSessionFixture {
    let home: URL
    let context: RelayStateContext
    let original = desktopFixtureRecord().originals["http"]!
    var defaults: [String: RelayDesktopIdentity]
    var edgePoliciesReady = true, edgeAvailable = true, edgeClosed = true, originalAvailable = true
    var binding = RelayBrowserBinding(instanceId: "00000000-0000-4000-8000-000000000001", configurationRevision: String(repeating: "a", count: 64),
        pid: 12345, httpPort: 18193, socksPort: 17890, route: "fixture-node")
    var proxyCalls = 0, opens = 0
    var setters: [(RelayDesktopIdentity, String)] = []
    var checkpoint: (String) throws -> Void = { _ in }
    var proxy: (() async throws -> Void)?
    var setter: ((RelayDesktopIdentity, String) async throws -> Void)?
    var opener: (() async throws -> Void)?
    var durableBeforeSetter = true
    let store: RelayDesktopStore

    init() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("relay-login-session-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let normalized = NetworkConfiguration(home: directory).home
        home = normalized
        context = RelayStateContext(home: normalized.path, stateRoot: normalized.appendingPathComponent("Library/Application Support/Relay-Preview").path)
        defaults = desktopFixtureRecord().originals
        // A reference box avoids capturing partially initialized self.
        let hook = DesktopCheckpointBox()
        store = try RelayDesktopStore(context, checkpoint: { try hook.call($0) })
        hook.call = { [weak self] point in try self?.checkpoint(point) }
    }
    func environment(for observedStore: RelayDesktopStore? = nil) -> RelayDesktopSessionEnvironment {
        let observed = observedStore ?? store
        return RelayDesktopSessionEnvironment(readOnly: RelayDesktopEnvironment(application: { _, _ in true },
            loginBrowser: { self.edgeAvailable ? desktopFixtureBrowser : nil },
            edgePoliciesReady: { self.edgePoliciesReady }, edgeClosed: { self.edgeClosed }, currentDefault: { self.defaults[$0] }), proxyReady: {
                self.proxyCalls += 1
                try await self.proxy?()
                return self.binding
            }, identityAvailable: { $0 == self.original ? self.originalAvailable : true }, setDefault: { identity, scheme in
                self.setters.append((identity, scheme))
                if identity == desktopFixtureBrowser {
                    let data = try RelayRecoveryInspector.read(observed.stateURL(observed.current!.source))!
                    let record = try RelayDesktopRecord.decode(data)
                    self.durableBeforeSetter = self.durableBeforeSetter && Set(record.attemptedSchemes) == Set(["http", "https"])
                }
                if let setter = self.setter { try await setter(identity, scheme) }
                else { self.defaults = ["http": identity, "https": identity] }
            }, openClaude: {
                self.opens += 1
                try await self.opener?()
            })
    }
    func session() -> RelayDesktopSession { RelayDesktopSession(store: store, environment: environment()) }
    func cleanup() { store.release(); try? FileManager.default.removeItem(at: home) }
}
private final class DesktopCheckpointBox { var call: (String) throws -> Void = { _ in } }

@MainActor
func runRelayDesktopSessionSelfTests() async -> Int32 {
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    func scenario(_ body: (DesktopSessionFixture) async throws -> Void) async {
        do { let fixture = try DesktopSessionFixture(); defer { fixture.cleanup() }; try await body(fixture) }
        catch { failures.append("unexpected session fixture failure") }
    }
    await scenario { f in
        let session = f.session()
        check(session.snapshot.phase == "idle" && !f.store.locked, "engine construction is inert")
        let active = await session.start()
        check(active.phase == "active" && !active.busy && !active.canClose && active.hasRecord, "start returns completed active snapshot")
        check(f.opens == 1 && f.setters.count == 1 && f.proxyCalls == 3, "collateral setter skips second write and opens only after three owned-binding checks")
        check(f.durableBeforeSetter && f.store.locked, "both attempts saved before setter and lease stays held during login")
        let repeated = await session.start()
        check(repeated.phase == "active" && f.opens == 1, "active login cannot start again")
        f.edgePoliciesReady = false; f.proxy = { throw AssistantError("PRIVATE proxy offline") }
        let restored = await session.restore()
        check(restored.phase == "idle" && restored.canClose && !restored.hasRecord && !f.store.locked, "restore clears durable journal and releases lease")
        check(f.defaults == desktopFixtureRecord().originals && f.proxyCalls == 3, "restoration independent of unready browser or proxy")
    }
    await scenario { f in
        let session = f.session(), result = await session.start()
        check(result.phase == "active" && f.store.current?.record.version == 1
            && f.store.current?.record.temporaryApplication == desktopFixtureBrowser,
            "new session durably records direct Edge identity with compatible v1 journal")
        _ = await session.restore()
    }
    for failAt in [2, 3] {
        await scenario { f in
            f.proxy = {
                if f.proxyCalls == failAt {
                    f.binding = RelayBrowserBinding(instanceId: "00000000-0000-4000-8000-000000000002", configurationRevision: String(repeating: "b", count: 64),
                        pid: 54321, httpPort: 18194, socksPort: nil, route: "another-node")
                }
            }
            let result = await f.session().start()
            check(result.phase == "idle" && f.opens == 0 && f.defaults["http"] == f.original,
                "changed binding blocks setter/launch and restores originals at check \(failAt)")
            if failAt == 2 { check(f.setters.isEmpty, "binding replacement before setter causes no default write") }
        }
    }
    await scenario { f in
        f.edgePoliciesReady = false
        let result = await f.session().start()
        check(result.phase == "idle" && f.setters.isEmpty && f.opens == 0 && f.proxyCalls == 0, "browser preflight fails before proxy or settings")
        check(f.store.current == nil && !f.store.locked, "clean preflight failure releases locks")
    }
    await scenario { f in
        f.edgeAvailable = false
        let result = await f.session().start()
        check(result.phase == "idle" && f.setters.isEmpty && f.opens == 0 && f.proxyCalls == 0, "missing Edge blocks login before any setter or probe")
    }
    await scenario { f in
        f.edgeClosed = false
        let result = await f.session().start()
        check(result.phase == "idle" && f.setters.isEmpty && f.opens == 0 && f.proxyCalls == 0,
            "running Edge blocks login before binding check or default changes")
        check(result.warnings.joined().contains("先退出 Microsoft Edge"), "running Edge produces actionable fixed warning")
    }
    for socksPort in [nil, 18190] as [Int?] {
        await scenario { f in
            f.binding = RelayBrowserBinding(instanceId: f.binding.instanceId, configurationRevision: f.binding.configurationRevision,
                pid: f.binding.pid, httpPort: f.binding.httpPort, socksPort: socksPort, route: f.binding.route)
            let result = await f.session().start()
            check(result.phase == "idle" && f.setters.isEmpty && f.opens == 0 && f.store.current == nil,
                "missing or mismatched dedicated SOCKS cannot use another application on 17890")
            check(result.warnings.joined().contains("专用 HTTP 和 SOCKS 17890"), "port mismatch produces actionable fixed warning")
        }
    }
    await scenario { f in
        f.proxy = { throw AssistantError("PRIVATE unowned listener on 17890") }
        let result = await f.session().start()
        check(f.setters.isEmpty && f.opens == 0 && result.warnings.joined().contains("专用 HTTP 和 SOCKS 17890"),
            "unauthenticated binding never falls back to a raw port probe or another browser")
        check(!result.warnings.joined().contains("PRIVATE"), "binding error details remain redacted")
    }
    await scenario { f in
        f.setter = { identity, _ in
            f.defaults = ["http": identity, "https": identity]
            if identity == desktopFixtureBrowser { f.edgeClosed = false }
        }
        let result = await f.session().start()
        check(result.phase == "idle" && f.opens == 0 && f.defaults["http"] == f.original,
            "Edge opened during default switch aborts and restores original browser")
    }
    await scenario { f in
        let wrapper = RelayDesktopIdentity(bundleIdentifier: "local.relay.browser",
            appURL: URL(fileURLWithPath: "/fixture/Relay.app/Contents/Resources/relay/RelayBrowser.app", isDirectory: true).absoluteString)
        let record = RelayDesktopRecord(version: 2, sessionID: UUID().uuidString, createdAt: "2026-10-24T00:00:00Z",
            originals: ["http": f.original, "https": f.original], temporaryApplication: wrapper,
            attemptedSchemes: ["http", "https"], phase: "active")
        try NetworkConfiguration.safeWrite(JSONEncoder().encode(record), to: f.store.stateURL("relay"))
        f.defaults = ["http": wrapper, "https": wrapper]
        f.edgeAvailable = false; f.edgePoliciesReady = false; f.edgeClosed = false
        f.proxy = { throw AssistantError("PRIVATE offline") }
        let result = await f.session().restore()
        check(result.phase == "idle" && f.defaults["http"] == f.original && f.proxyCalls == 0 && f.opens == 0,
            "old v2 wrapper recovery still works without Edge, policies or Relay proxy")
    }
    await scenario { f in
        let session = f.session()
        check(await session.requestClose(), "never-started instance may close immediately")
        check(!FileManager.default.fileExists(atPath: f.store.root.path) && !FileManager.default.fileExists(atPath: f.store.legacyDirectory.path), "closing a never-started instance creates no lock or state directory")
    }
    await scenario { f in
        f.checkpoint = { point in if point == "directoryDurable" { throw AssistantError("directory sync not acknowledged") } }
        let result = await f.session().start()
        check(result.phase == "blocked" && result.canClose && f.setters.isEmpty && f.store.current == nil && !f.store.locked, "directory persistence failure blocks login before any journal or setter")
    }
    await scenario { f in
        let owner = f.session(); _ = await owner.start()
        let otherStore = try RelayDesktopStore(f.context)
        defer { otherStore.release() }
        let other = RelayDesktopSession(store: otherStore, environment: f.environment(for: otherStore))
        let result = await other.start(), before = f.setters.count
        check(result.phase == "blocked" && result.canClose && !otherStore.locked, "failed lease contender can exit without claiming restoration")
        check(await other.requestClose() && f.setters.count == before && f.store.locked, "contender close leaves actual owner and defaults untouched")
        check(await owner.requestClose(), "actual lease owner still completes restoration")
    }
    await scenario { f in
        f.setter = { identity, scheme in f.defaults[scheme] = identity }
        let session = f.session(), active = await session.start()
        check(active.phase == "active" && f.setters.count == 2 && f.durableBeforeSetter, "independent scheme setters both retain durable intent")
        check(await session.requestClose() && f.setters.count == 4, "independent scheme restoration completes both setters")
    }
    await scenario { f in
        var calls = 0
        f.setter = { identity, scheme in
            calls += 1
            if calls == 2 { throw AssistantError("second scheme denied") }
            f.defaults[scheme] = identity
        }
        let result = await f.session().start()
        check(result.phase == "idle" && f.defaults["http"] == f.original && f.defaults["https"] == f.original, "second independent setter failure restores the first scheme")
    }
    await scenario { f in
        var firstPublication = true
        f.checkpoint = { point in
            if point == "afterPublish" && firstPublication {
                firstPublication = false
                f.defaults = ["http": desktopFixtureBrowser, "https": desktopFixtureBrowser]
            }
        }
        let session = f.session(), result = await session.start()
        check(result.phase == "recoveryNeeded" && f.setters.isEmpty && f.opens == 0, "external Edge choice before our setter is not adopted or restored")
        f.defaults = ["http": f.original, "https": f.original]
        check(await session.requestClose(), "unattempted external change requires manual restoration before finalizing")
    }
    await scenario { f in
        f.edgeAvailable = false
        check(await f.session().start().phase == "idle" && f.opens == 0, "unknown Edge identity blocks login")
    }
    await scenario { f in
        f.defaults["https"] = RelayDesktopInspection.edge
        check(await f.session().start().phase == "idle" && f.setters.isEmpty, "split original defaults block before journal")
    }
    await scenario { f in
        f.opener = { throw AssistantError("PRIVATE opener error") }
        let result = await f.session().start()
        check(result.phase == "idle" && f.defaults["http"] == f.original, "open failure restores defaults")
        check(!result.warnings.joined().contains("PRIVATE"), "controlled error does not expose adapter details")
    }
    await scenario { f in
        var first = true
        f.setter = { identity, _ in
            f.defaults = ["http": identity, "https": identity]
            if first { first = false; throw AssistantError("setter changed both then failed") }
        }
        let result = await f.session().start()
        check(result.phase == "idle" && f.defaults["https"] == f.original && f.setters.count == 2, "setter failure after collateral change still recovers")
    }
    await scenario { f in
        f.setter = { _, _ in throw AssistantError("denied before mutation") }
        check(await f.session().start().phase == "idle" && f.setters.count == 1, "denied setter recognizes already-original defaults")
    }
    await scenario { f in
        f.setter = { identity, _ in
            f.defaults = ["http": identity, "https": identity]
            if identity == desktopFixtureBrowser { f.edgePoliciesReady = false }
        }
        check(await f.session().start().phase == "idle" && f.opens == 0 && f.defaults["http"] == f.original, "browser readiness change aborts launch but never blocks restoration")
    }
    await scenario { f in
        let session = f.session(); _ = await session.start()
        let external = RelayDesktopIdentity(bundleIdentifier: "org.fixture.external", appURL: URL(fileURLWithPath: "/fixture/External.app", isDirectory: true).absoluteString)
        f.defaults["https"] = external
        let before = f.setters.count, blocked = await session.restore()
        check(blocked.phase == "recoveryNeeded" && !blocked.canClose && f.store.locked, "external change preserves record and session lease")
        check(f.setters.count == before && f.defaults["https"] == external, "one external scheme prevents collateral overwrite of both")
        f.defaults = ["http": f.original, "https": f.original]
        check(await session.requestClose(), "manual restoration can be verified and finalized")
    }
    await scenario { f in
        let session = f.session(); _ = await session.start()
        f.originalAvailable = false
        check(!(await session.requestClose()) && session.snapshot.hasRecord && f.store.locked, "moved original app blocks close and retains recovery")
        f.originalAvailable = true
        check(await session.requestClose(), "retry after identity fixed completes close handshake")
    }
    await scenario { f in
        let session = f.session(); _ = await session.start()
        let target = try f.store.stateURL("relay"), data = try Data(contentsOf: target), before = f.setters.count
        try NetworkConfiguration.safeWrite(data + Data("\n".utf8), to: target)
        let blocked = await session.restore()
        check(blocked.phase == "recoveryNeeded" && f.setters.count == before, "same-session external record rewrite stops restore before setter")
        try NetworkConfiguration.safeWrite(data, to: target)
        check(await session.requestClose(), "exact original record can be rechecked without adopting changed bytes")
    }
    await scenario { f in
        let session = f.session(); _ = await session.start()
        try FileManager.default.removeItem(at: f.store.stateURL("relay"))
        let before = f.setters.count
        check(!(await session.requestClose()) && f.setters.count == before, "missing active journal is not re-created or treated as restored")
    }
    await scenario { f in
        let session = f.session(); _ = await session.start()
        var fail = true
        f.checkpoint = { point in if point == "beforePublish" && fail { fail = false; throw AssistantError("stage write failed") } }
        check(await session.requestClose() && f.defaults["http"] == f.original, "phase-write failure still restores exact known record")
    }
    await scenario { f in
        var fail = true
        f.checkpoint = { point in if point == "afterPublish" && fail { fail = false; throw AssistantError("publication sync uncertain") } }
        let result = await f.session().start()
        check(result.phase == "idle" && f.setters.isEmpty && f.store.current == nil, "failure after initial publication safely finalizes already-original state")
    }
    for checkpoint in ["beforeRemove", "afterRemove"] {
        await scenario { f in
            let session = f.session(); _ = await session.start()
            var fail = true
            f.checkpoint = { point in if point == checkpoint && fail { fail = false; throw AssistantError("removal uncertain") } }
            let result = await session.restore(), before = f.setters.count
            check(result.phase == "recoveryNeeded" && !result.canClose && f.store.locked, "removal failure keeps close blocked: " + checkpoint)
            check(await session.requestClose() && f.setters.count == before, "removal retry does not replay default setter: " + checkpoint)
        }
    }
    await scenario { f in
        let first = f.session(); _ = await first.start()
        f.store.release() // Simulate process death: OS drops locks, disk remains.
        let resumedStore = try RelayDesktopStore(f.context)
        defer { resumedStore.release() }
        let resumed = RelayDesktopSession(store: resumedStore, environment: f.environment(for: resumedStore))
        let opens = f.opens, before = f.setters.count, result = await resumed.start()
        check(result.phase == "recoveryNeeded" && f.opens == opens && f.setters.count == before, "new process detects existing record instead of beginning login")
        check(!(await resumed.requestClose()) && resumed.snapshot.requiresRecoveryConsent, "recovery from another instance requires separate consent")
        _ = await resumed.restore()
        check(await resumed.requestClose() && f.defaults["http"] == f.original, "confirmed crash recovery restores under a fresh lease")
    }
    await scenario { f in
        let legacy = try f.store.stateURL("legacy")
        try NetworkConfiguration.safeWrite(JSONEncoder().encode(desktopFixtureRecord(phase: "active", attempted: ["http", "https"])), to: legacy)
        f.defaults = ["http": RelayDesktopInspection.edge, "https": RelayDesktopInspection.edge]
        let session = f.session(), result = await session.start()
        check(result.source == "legacy" && result.phase == "recoveryNeeded" && f.opens == 0, "legacy record requires recovery instead of start")
        let closeDenied = !(await session.requestClose()), cancellation = await session.cancelAndRestore()
        check(closeDenied && cancellation.requiresRecoveryConsent, "close and cancel cannot authorize legacy recovery")
        _ = await session.restore()
        check(await session.requestClose() && !FileManager.default.fileExists(atPath: legacy.path), "confirmed legacy recovery completed in place")
        check(!FileManager.default.fileExists(atPath: try f.store.stateURL("relay").path), "legacy journal not cloned to Relay")
    }
    await scenario { f in
        let session = f.session()
        var gate: CheckedContinuation<Void, Never>?
        f.proxy = { await withCheckedContinuation { gate = $0 } }
        let start = Task { await session.start() }
        for _ in 0..<1000 { if gate != nil { break }; await Task.yield() }
        check(gate != nil && session.snapshot.busy, "start suspended in proxy check")
        let close = Task { await session.requestClose() }
        await Task.yield()
        check(session.snapshot.busy && f.setters.isEmpty, "close waits for outstanding preflight and requests cancellation")
        session.requestCancel()
        gate?.resume(); gate = nil
        _ = await start.value
        check(await close.value && f.setters.isEmpty && f.opens == 0, "cancellation before first journal never switches defaults")
    }
    await scenario { f in
        let session = f.session()
        var gate: CheckedContinuation<Void, Never>?, first = true
        f.setter = { identity, _ in
            if first { first = false; await withCheckedContinuation { gate = $0 } }
            f.defaults = ["http": identity, "https": identity]
        }
        let start = Task { await session.start() }
        for _ in 0..<1000 { if gate != nil { break }; await Task.yield() }
        check(gate != nil && f.durableBeforeSetter && session.snapshot.busy, "setter suspended only after durable intent")
        let close = Task { await session.requestClose() }
        await Task.yield(); session.requestCancel()
        check(session.snapshot.busy && f.store.locked, "close cannot finish while setter callback is outstanding")
        gate?.resume(); gate = nil
        _ = await start.value
        check(await close.value && f.defaults["http"] == f.original && f.opens == 0, "cancellation during setter waits then restores collateral changes")
    }
    print(failures.isEmpty ? "PASS: \(count) desktop session lifecycle checks; fake defaults, injected async OS effects and fixture HOME only." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}

@MainActor
func runRelayDesktopHostSelfTests() async -> Int32 {
    var count = 0, failures: [String] = []
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    func settle(_ condition: () -> Bool) async {
        for _ in 0..<3000 { if condition() { return }; await Task.yield() }
    }
    func scenario(_ body: (DesktopSessionFixture) async throws -> Void) async {
        do { let fixture = try DesktopSessionFixture(); defer { fixture.cleanup() }; try await body(fixture) }
        catch { failures.append("unexpected host fixture failure") }
    }
    func packet(_ id: Int, _ action: String, context: RelayStateContext? = nil) throws -> Data {
        var json: [String: Any] = ["id": id, "action": action]
        if let context { json["context"] = ["home": context.home, "stateRoot": context.stateRoot] }
        return try JSONSerialization.data(withJSONObject: json)
    }
    await scenario { f in
        var replies: [RelayDesktopWireResponse] = [], ended: Int32?
        let host = RelayDesktopHost(factory: { _ in f.session() }, emit: { replies.append($0) }, ended: { ended = $0 })
        host.accept(try packet(1, "initialize", context: f.context))
        check(replies.count == 1 && replies[0].snapshot.canClose && !f.store.locked, "host initialization is inert")
        host.accept(try packet(2, "start")); host.accept(try packet(3, "cancel")); host.accept(try packet(4, "close"))
        await settle { ended != nil }
        check(ended == 0 && f.setters.isEmpty && f.proxyCalls == 0, "cancel before queued start prevents all effects")
        check(Set(replies.map(\.id)) == Set([1, 2, 3, 4]) && replies.last?.closing == true, "overlapping cancel and close both acknowledged before exit")
        check(!FileManager.default.fileExists(atPath: f.store.root.path), "queued cancellation does not create state")
    }
    await scenario { f in
        var replies: [RelayDesktopWireResponse] = [], ended: Int32?
        let host = RelayDesktopHost(factory: { _ in f.session() }, emit: { replies.append($0) }, ended: { ended = $0 })
        host.accept(try packet(1, "initialize", context: f.context)); host.accept(try packet(2, "start"))
        await settle { replies.contains { $0.id == 2 } }
        check(replies.last?.snapshot.phase == "active" && f.store.locked, "host keeps active engine and lease alive")
        host.accept(try packet(3, "status"))
        check(replies.last?.id == 3 && replies.last?.snapshot.phase == "active", "status observes same persistent instance")
        host.disconnect()
        await settle { ended != nil }
        check(ended == 0 && f.defaults["http"] == f.original && !f.store.locked, "EOF restores before host terminates")
    }
    await scenario { f in
        var replies: [RelayDesktopWireResponse] = [], ended: Int32?
        let host = RelayDesktopHost(factory: { _ in f.session() }, emit: { replies.append($0) }, ended: { ended = $0 })
        host.accept(try packet(1, "initialize", context: f.context)); host.accept(try packet(2, "start"))
        await settle { replies.contains { $0.id == 2 } }
        host.accept(try packet(2, "start"))
        await settle { ended != nil }
        check(ended == 2 && f.opens == 1 && f.defaults["https"] == f.original, "replayed request is refused and recovered before protocol failure exit")
        check(!f.store.locked && f.store.current == nil, "protocol failure does not strand a recoverable session")
    }
    await scenario { f in
        var replies: [RelayDesktopWireResponse] = [], ended: Int32?, gate: CheckedContinuation<Void, Never>?
        var first = true
        f.setter = { identity, _ in
            if first { first = false; await withCheckedContinuation { gate = $0 } }
            f.defaults = ["http": identity, "https": identity]
        }
        let host = RelayDesktopHost(factory: { _ in f.session() }, emit: { replies.append($0) }, ended: { ended = $0 })
        host.accept(try packet(1, "initialize", context: f.context)); host.accept(try packet(2, "start"))
        await settle { gate != nil }
        check(gate != nil && f.store.locked, "host setter reached durable suspended state")
        host.accept(try packet(3, "cancel")); host.accept(try packet(4, "close")); host.accept(try packet(5, "start"))
        await Task.yield()
        check(ended == nil && f.store.locked, "close cannot end a pending setter or release its lease")
        check(replies.contains { $0.id == 5 && $0.snapshot.busy }, "new start rejected while close is pending")
        gate?.resume(); gate = nil
        await settle { ended != nil }
        check(ended == 0 && f.opens == 0 && f.defaults["http"] == f.original, "pending callback settles then restores before close")
        check(replies.contains { $0.id == 3 } && replies.contains { $0.id == 4 && $0.closing }, "cancel and close completion replies preserved")
    }
    await scenario { f in
        var replies: [RelayDesktopWireResponse] = [], ended: Int32?
        let host = RelayDesktopHost(factory: { _ in f.session() }, emit: { replies.append($0) }, ended: { ended = $0 })
        host.accept(try packet(1, "initialize", context: f.context)); host.accept(try packet(2, "start"))
        await settle { replies.contains { $0.id == 2 } }; f.originalAvailable = false
        host.accept(try packet(3, "close"))
        await settle { replies.contains { $0.id == 3 } }
        check(ended == nil && replies.last?.closing == false && f.store.locked, "failed restore keeps host and lease alive")
        check(replies.last?.snapshot.phase == "recoveryNeeded" && replies.last?.snapshot.canClose == false, "failed close reports unresolved recovery")
        f.originalAvailable = true; host.accept(try packet(4, "restore"))
        await settle { replies.contains { $0.id == 4 } }
        host.accept(try packet(5, "close")); await settle { ended != nil }
        check(ended == 0 && f.defaults["https"] == f.original, "explicit retry recovers and subsequent close succeeds")
    }
    await scenario { f in
        var replies: [RelayDesktopWireResponse] = [], ended: Int32?
        let host = RelayDesktopHost(factory: { _ in f.session() }, emit: { replies.append($0) }, ended: { ended = $0 })
        host.accept(try packet(1, "initialize", context: f.context)); host.accept(try packet(2, "start"))
        await settle { replies.contains { $0.id == 2 } }; f.originalAvailable = false
        host.disconnect(); await settle { ended != nil }
        check(ended == 2 && f.store.current != nil, "orphan recovery failure retains durable journal for next instance")
    }
    for data in [Data("PRIVATE malformed".utf8), try! packet(1, "status"), Data(repeating: 65, count: 65537)] {
        await scenario { f in
            var replies: [RelayDesktopWireResponse] = [], ended: Int32?
            let host = RelayDesktopHost(factory: { _ in f.session() }, emit: { replies.append($0) }, ended: { ended = $0 })
            host.accept(data); await settle { ended != nil }
            check(ended == 2 && replies.isEmpty && !f.store.locked && f.opens == 0, "invalid protocol fails before initialization or effects")
        }
    }
    await scenario { f in
        let record = desktopFixtureRecord(phase: "active", attempted: ["http", "https"])
        try NetworkConfiguration.safeWrite(JSONEncoder().encode(record), to: f.store.stateURL("legacy"))
        f.defaults = ["http": RelayDesktopInspection.edge, "https": RelayDesktopInspection.edge]
        var replies: [RelayDesktopWireResponse] = [], ended: Int32?
        let host = RelayDesktopHost(factory: { _ in f.session() }, emit: { replies.append($0) }, ended: { ended = $0 })
        host.accept(try packet(1, "initialize", context: f.context)); host.accept(try packet(2, "start"))
        await settle { replies.contains { $0.id == 2 } }
        check(replies.last?.snapshot.requiresRecoveryConsent == true, "host exposes separate recovery consent for existing record")
        host.accept(try packet(3, "cancel")); await settle { replies.contains { $0.id == 3 } }
        host.accept(try packet(4, "close")); await settle { replies.contains { $0.id == 4 } }
        check(ended == nil && f.setters.isEmpty && replies.last?.closing == false, "cancel and close cannot restore existing record")
        host.accept(try packet(5, "restore")); await settle { replies.contains { $0.id == 5 } }
        host.accept(try packet(6, "close")); await settle { ended != nil }
        check(ended == 0 && f.defaults["http"] == f.original, "separately authorized restore completes pending session")
    }
    print(failures.isEmpty ? "PASS: \(count) persistent host protocol checks; injected session/OS only, no real default, browser or network effects." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
