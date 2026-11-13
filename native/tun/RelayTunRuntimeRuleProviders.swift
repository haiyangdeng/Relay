import Foundation

/// Private authority model for the positively admitted held session capability.
/// File publication (including a failed attempted swap) is the write boundary:
/// the upstream watcher may apply it before a later PUT. No lifecycle or IO here.
enum RelayTunRuntimeRuleProviders {
    typealias Shared = RelayTunRuntimeResources
    typealias FileIdentity = Shared.FileIdentity
    static let maximumBytes = Shared.maximumBytes
    static let maximumTotalBytes = Shared.maximumTotalBytes
    static let maximumDeclaredRules = 2_000_000
    static let maximumRetainedFiles = 4
    static let maximumRetainedBytes = maximumTotalBytes
    static let maximumSequence: UInt64 = 9_007_199_254_740_991
    enum Failure: Error { case invalid, stale, revoked, expired, entered, unavailable, registryUncertain }
    enum Behavior: String { case domain, ipcidr, classical }
    enum Format: String {
        case yaml, text, mrs
        var byteLimit: Int { self == .mrs ? maximumBytes : 8 * 1024 * 1024 }
    }
    struct Binding: Equatable {
        let name: String, originalPath: String, behavior: Behavior, format: Format
        init(name: String, originalPath: String, behavior: Behavior, format: Format) throws {
            let suffix = "." + format.rawValue, prefix = "relay-files/"
            guard !name.isEmpty, name.utf8.count <= 256,
                  name == name.trimmingCharacters(in: .whitespacesAndNewlines), !name.contains(","),
                  name.unicodeScalars.allSatisfy({ $0.value >= 32 && !(127...159).contains($0.value) }),
                  originalPath.hasPrefix(prefix), originalPath.hasSuffix(suffix),
                  Shared.hash(String(originalPath.dropFirst(prefix.count).dropLast(suffix.count))),
                  !(format == .mrs && behavior == .classical) else { throw Failure.invalid }
            self.name = name; self.originalPath = originalPath; self.behavior = behavior; self.format = format
        }
    }
    struct Resource: Equatable {
        let binding: Binding, fileSHA256: String, identity: FileIdentity, ruleCount: Int, registeredFile: Bool
        var bytes: Int { identity.bytes }
        init(binding: Binding, fileSHA256: String, identity: FileIdentity, ruleCount: Int, registeredFile: Bool) throws {
            guard Shared.hash(fileSHA256), ruleCount >= 0, UInt64(ruleCount) <= maximumSequence else { throw Failure.invalid }
            self.binding = binding; self.fileSHA256 = fileSHA256; self.identity = identity
            self.ruleCount = ruleCount; self.registeredFile = registeredFile
        }
    }
    struct Ledger: Equatable {
        let generationSHA256: String, sequence: UInt64, resources: [String: Resource]
        var bytes: Int {
            var seen = Set<String>()
            return resources.values.reduce(0) { count, row in
                seen.insert(row.binding.originalPath).inserted ? count + row.bytes : count
            }
        }
        var groups: [[String]] {
            Dictionary(grouping: resources.values, by: { $0.binding.originalPath }).values
                .map { $0.map { $0.binding.name }.sorted() }.sorted { $0[0] < $1[0] }
        }
        func group(for name: String) -> [Resource] {
            guard let path = resources[name]?.binding.originalPath else { return [] }
            return resources.values.filter { $0.binding.originalPath == path }.sorted { $0.binding.name < $1.binding.name }
        }
        init(generationSHA256: String, sequence: UInt64, resources: [Resource]) throws {
            guard Shared.hash(generationSHA256), sequence <= maximumSequence, resources.count <= 200,
                  Set(resources.map { $0.binding.name }).count == resources.count else { throw Failure.invalid }
            var paths = [String: Resource](), inodes = [String: String](), total = 0
            for row in resources {
                let path = row.binding.originalPath, inode = "\(row.identity.device):\(row.identity.inode)"
                // Fresh initial authority originates in the immutable checked
                // asset named by its original SHA, never an adopted runtime file.
                guard sequence != 0 || String(path.dropFirst("relay-files/".count).prefix(64)) == row.fileSHA256 else { throw Failure.invalid }
                if let prior = paths[path] {
                    guard row.fileSHA256 == prior.fileSHA256, row.identity == prior.identity,
                          row.binding.format == prior.binding.format else { throw Failure.invalid }
                } else {
                    guard inodes[inode] == nil else { throw Failure.invalid }
                    paths[path] = row; inodes[inode] = path; total += row.bytes
                    guard total <= maximumTotalBytes else { throw Failure.invalid }
                }
            }
            self.generationSHA256 = generationSHA256; self.sequence = sequence
            self.resources = Dictionary(uniqueKeysWithValues: resources.map { ($0.binding.name, $0) })
        }
    }
    /// This identity comes from the held Native session, never a caller PID.
    struct Owner: Equatable {
        let heldGeneration: UInt64, configurationRevision: String, coreSHA256: String, ordinaryUID: UInt32
        init(heldGeneration: UInt64, configurationRevision: String, coreSHA256: String, ordinaryUID: UInt32) throws {
            guard heldGeneration > 0, Shared.hash(configurationRevision), Shared.hash(coreSHA256), ordinaryUID > 0 else { throw Failure.invalid }
            self.heldGeneration = heldGeneration; self.configurationRevision = configurationRevision
            self.coreSHA256 = coreSHA256; self.ordinaryUID = ordinaryUID
        }
    }
    struct GeoBudget: Equatable {
        let generationSHA256: String, bytes: Int
        init(generationSHA256: String, bytes: Int) throws {
            guard Shared.hash(generationSHA256), bytes >= 0, bytes <= maximumTotalBytes else { throw Failure.invalid }
            self.generationSHA256 = generationSHA256; self.bytes = bytes
        }
    }
    struct Context: Equatable { let owner: Owner, geo: GeoBudget }
    struct Selection {
        let provider: String, configurationRevision: String, expectedGenerationSHA256: String, expectedGeoGenerationSHA256: String
        let oldSHA256: String, newSHA256: String, blobId: String, bytes: Int, declaredRuleCount: Int
        init(provider: String, configurationRevision: String, expectedGenerationSHA256: String,
             expectedGeoGenerationSHA256: String, oldSHA256: String, newSHA256: String,
             blobId: String, bytes: Int, declaredRuleCount: Int) throws {
            guard !provider.isEmpty, provider.utf8.count <= 256,
                  [configurationRevision, expectedGenerationSHA256, expectedGeoGenerationSHA256, oldSHA256, newSHA256].allSatisfy(Shared.hash),
                  Shared.uuid(blobId), bytes > 0, bytes <= maximumBytes, (1...maximumDeclaredRules).contains(declaredRuleCount) else { throw Failure.invalid }
            self.provider = provider; self.configurationRevision = configurationRevision
            self.expectedGenerationSHA256 = expectedGenerationSHA256; self.expectedGeoGenerationSHA256 = expectedGeoGenerationSHA256
            self.oldSHA256 = oldSHA256; self.newSHA256 = newSHA256; self.blobId = blobId
            self.bytes = bytes; self.declaredRuleCount = declaredRuleCount
        }
    }
    struct Blob {
        let id: String, format: Format, data: Data, identity: FileIdentity
        init(id: String, format: Format, data: Data, identity: FileIdentity) throws {
            guard Shared.uuid(id), data.count == identity.bytes, data.count <= format.byteLimit else { throw Failure.invalid }
            self.id = id; self.format = format; self.data = data; self.identity = identity
        }
    }
    /// An exclusive private stage/retained registry ticket, not a pathname.
    struct Stage: Equatable {
        let ticket: String, bindings: [Binding], sha256: String, identity: FileIdentity
        /// Private result of the complete same-Core candidate probe, one count
        /// for each logical alias. Never populated from a request/header count.
        let checkedRuleCounts: [String: Int]
    }
    struct Retained: Equatable { let ticket: String, originalPath: String, sha256: String, identity: FileIdentity }
    struct Pruned {
        /// Exact confirmed removed prefix. A partial result preserves every
        /// other record and isolates the lane; no blind cleanup retry.
        let removed: [Retained], complete: Bool
    }
    enum Acceptance { case metadataOnly, synchronousFileRead }
    struct Publication {
        let retained: Retained, resources: [Resource], acceptance: Acceptance
        // No Core-loaded-body SHA is asserted by this API. A future admitted
        // fixed-Core driver must prove synchronous file reread, not infer it
        // from 204, same count, watcher metadata or an untrusted HTTP header.
    }
    enum Cleanup { case discardUnpublished, keepPublishedAndRetained }
    struct Driver {
        let supportsSynchronousFileRead: Bool
        let currentContext: () throws -> Context
        let readBlob: (Selection, Access, @escaping (Result<Blob, Error>) -> Void) -> Void
        let stage: ([Resource], Blob, Access, @escaping (Result<Stage, Error>) -> Void) -> Void
        let prune: ([Retained], Access, @escaping (Result<Pruned, Error>) -> Void) -> Void
        let publish: (Stage, Access, @escaping (Result<Publication, Error>) -> Void) -> Void
        /// The callback must drain actual work. Unpublished stages may be
        /// removed only by exact ticket/identity; retained old files are never
        /// deleted here, including after uncertainty. No prefix adoption.
        let cleanup: (Stage, Cleanup, @escaping (Result<Void, Error>) -> Void) -> Void
    }
    fileprivate final class Scope {
        private let lock = NSLock(); private var active = true
        func revoke() { lock.lock(); active = false; lock.unlock() }
        var live: Bool { lock.lock(); defer { lock.unlock() }; return active }
    }
    final class Access {
        private let lock = NSLock(), scope: Scope, context: Context, current: () throws -> Context
        private let clock: () -> UInt64
        let deadline: UInt64
        private var revoked = false, finished = false, writable = false, entered = false
        fileprivate init(deadline: UInt64, scope: Scope, context: Context, current: @escaping () throws -> Context, clock: @escaping () -> UInt64) {
            self.deadline = deadline; self.scope = scope; self.context = context; self.current = current; self.clock = clock
        }
        final class PublishFence {
            fileprivate let owner: ObjectIdentifier
            fileprivate init(_ access: Access) { owner = ObjectIdentifier(access) }
        }
        private func pureCheck(enter: Bool) throws {
            let time = clock()
            lock.lock(); defer { lock.unlock() }
            guard !revoked, !finished, scope.live else { throw Failure.revoked }
            guard time < deadline else { throw Failure.expired }
            if enter { guard writable, !entered else { throw Failure.entered }; entered = true }
        }
        func check() throws {
            // Owner observers may re-enter cancel/close and run outside locks.
            guard try current() == context else { throw Failure.stale }
            try pureCheck(enter: false)
        }
        /// Last effectful owner callback. The Files driver then verifies only
        /// pinned FS facts before consuming this unforgeable single-use fence.
        func preparePublishFence() throws -> PublishFence { try check(); return PublishFence(self) }
        /// Reuse the final pure gate for subsequent authenticated PUT reads;
        /// it never marks a second publication and never invokes an observer.
        func validateFence(_ fence: PublishFence) throws {
            guard fence.owner == ObjectIdentifier(self) else { throw Failure.invalid }
            try pureCheck(enter: false)
        }
        /// No observer/IO here. Call adjacent to FIRST actual swap syscall.
        func enterPublish(_ fence: PublishFence) throws {
            guard fence.owner == ObjectIdentifier(self) else { throw Failure.invalid }
            try pureCheck(enter: true)
        }
        func enterPublish() throws { try enterPublish(preparePublishFence()) }
        fileprivate func allow() { lock.lock(); writable = true; lock.unlock() }
        fileprivate func cancel() { lock.lock(); revoked = true; lock.unlock() }
        fileprivate func finish() { lock.lock(); finished = true; lock.unlock() }
        var didEnter: Bool { lock.lock(); defer { lock.unlock() }; return entered }
    }
    enum Status: String { case published, unchanged, busy, stale, expired, cancelled, uncertain, unsupported, unavailable }
    struct Reply { let status: Status; var pending = false; var ledger: Ledger? }
    struct Isolation { let operationId: Int, previous: Ledger, selection: Selection, observed: Publication? }
    final class Controller {
        private enum Phase { case blob, stage, prune, publish, terminal }
        private final class Work {
            let id: Int, selection: Selection, previous: Ledger, context: Context, access: Access, reply: (Reply) -> Void
            var phase = Phase.blob, stage: Stage?, cancelled = false, cleanupStarted = false, cleanupFailed = false
            init(id: Int, selection: Selection, previous: Ledger, context: Context, access: Access, reply: @escaping (Reply) -> Void) {
                self.id = id; self.selection = selection; self.previous = previous; self.context = context; self.access = access; self.reply = reply
            }
        }
        private let lock = NSLock(), scope = Scope(), driver: Driver, clock: () -> UInt64, duration: UInt64, staticAssetBytes: Int
        private var current: Ledger, work: Work?, starting: Int?, startingCancelled = false, closed = false, lastID = 0
        private var isolated: Isolation?, retained = [String: Retained](), retainedOrder = [String]()
        init(ledger: Ledger, staticAssetBytes: Int, initialGeo: GeoBudget, driver: Driver, leaseSeconds: Int = 30,
             clock: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) throws {
            guard (1...120).contains(leaseSeconds), staticAssetBytes >= 0, staticAssetBytes <= maximumTotalBytes,
                  ledger.bytes + staticAssetBytes + initialGeo.bytes <= maximumTotalBytes else { throw Failure.invalid }
            current = ledger; self.staticAssetBytes = staticAssetBytes; self.driver = driver; self.clock = clock
            duration = UInt64(leaseSeconds) * 1_000_000_000
        }
        deinit { scope.revoke(); work?.access.cancel() }
        var isBusy: Bool { lock.lock(); defer { lock.unlock() }; return work != nil || starting != nil }
        var knownLedger: Ledger { lock.lock(); defer { lock.unlock() }; return current }
        var isolation: Isolation? { lock.lock(); defer { lock.unlock() }; return isolated }
        var retainedRecords: [String: Retained] { lock.lock(); defer { lock.unlock() }; return retained }
        /// Uncertain publication retains both possible layouts. Other asset
        /// lanes must reserve max(old,new) or reject writes until explicit
        /// reconciliation; observation alone never advances this ledger.
        var reservedProviderBytes: Int {
            lock.lock(); defer { lock.unlock() }
            guard let isolated, let row = isolated.previous.resources[isolated.selection.provider] else { return current.bytes }
            return current.bytes - row.bytes + max(row.bytes, isolated.selection.bytes)
        }
        func close() { scope.revoke(); lock.lock(); closed = true; startingCancelled = true; work?.cancelled = true; work?.access.cancel(); lock.unlock() }
        func cancel(operationId: Int) -> Reply {
            lock.lock(); defer { lock.unlock() }
            if starting == operationId { startingCancelled = true; return .init(status: .cancelled, pending: true) }
            guard let work, work.id == operationId else { return .init(status: .stale, pending: work != nil || starting != nil) }
            work.cancelled = true; work.access.cancel()
            return .init(status: work.access.didEnter ? .uncertain : .cancelled, pending: true)
        }
        /// Native consent precedes this method and is not a durable grant.
        func replace(id: Int, selection: Selection, maximumDeadline: UInt64? = nil, reply: @escaping (Reply) -> Void) {
            lock.lock()
            guard id > 0, id <= Int(Int32.max), id > lastID, !closed else { lock.unlock(); reply(.init(status: .unavailable)); return }
            lastID = id
            guard work == nil, starting == nil else { lock.unlock(); reply(.init(status: .busy, pending: true)); return }
            guard isolated == nil else { lock.unlock(); reply(.init(status: .uncertain)); return }
            starting = id; startingCancelled = false; let previous = current; lock.unlock()
            let now = clock()
            guard now <= UInt64.max - duration else { finishStarting(id, reply, .expired); return }
            let deadline = min(now + duration, maximumDeadline ?? UInt64.max)
            guard now < deadline else { finishStarting(id, reply, .expired); return }
            let context: Context
            do { context = try driver.currentContext() } catch { finishStarting(id, reply, .unavailable); return }
            let access = Access(deadline: deadline, scope: scope, context: context, current: driver.currentContext, clock: clock)
            let candidate = Work(id: id, selection: selection, previous: previous, context: context, access: access, reply: reply)
            lock.lock()
            guard starting == id, !startingCancelled, !closed, current == previous else { lock.unlock(); finishStarting(id, reply, .cancelled); return }
            starting = nil; work = candidate; lock.unlock()
            do {
                try access.check()
                guard context.owner.configurationRevision == selection.configurationRevision,
                      context.geo.generationSHA256 == selection.expectedGeoGenerationSHA256,
                      previous.generationSHA256 == selection.expectedGenerationSHA256,
                      let row = previous.resources[selection.provider], row.fileSHA256 == selection.oldSHA256,
                      previous.resources.values.allSatisfy({ $0.identity.ownerUID == context.owner.ordinaryUID }) else { throw Failure.stale }
                guard driver.supportsSynchronousFileRead, row.registeredFile, previous.sequence < maximumSequence,
                      previous.group(for: selection.provider).allSatisfy({ $0.registeredFile }) else {
                    finish(candidate, .unsupported); return
                }
                guard selection.bytes <= row.binding.format.byteLimit,
                      staticAssetBytes + context.geo.bytes + previous.bytes - row.bytes + selection.bytes <= maximumTotalBytes else { finish(candidate, .unsupported); return }
                if row.fileSHA256 == selection.newSHA256 {
                    guard row.bytes == selection.bytes, previous.group(for: selection.provider).allSatisfy({ $0.ruleCount == selection.declaredRuleCount }) else { throw Failure.stale }
                    finish(candidate, .unchanged); return
                }
                driver.readBlob(selection, access) { [self, candidate] result in blob(candidate, result) }
            } catch { fail(candidate, error) }
        }
        private func finishStarting(_ id: Int, _ reply: (Reply) -> Void, _ status: Status) {
            lock.lock(); guard starting == id else { lock.unlock(); return }
            starting = nil; let answer = Reply(status: closed || startingCancelled ? .cancelled : status)
            lock.unlock(); reply(answer)
        }
        private func claim(_ w: Work, _ phase: Phase, _ next: Phase) -> Bool {
            lock.lock(); defer { lock.unlock() }; guard work === w, w.phase == phase else { return false }; w.phase = next; return true
        }
        private func blob(_ w: Work, _ result: Result<Blob, Error>) {
            guard claim(w, .blob, .stage) else { return }
            do {
                try w.access.check(); let blob = try result.get(), s = w.selection
                guard blob.id == s.blobId, blob.data.count == s.bytes, Shared.digest(blob.data) == s.newSHA256,
                      blob.identity.ownerUID == w.context.owner.ordinaryUID,
                      let binding = w.previous.resources[s.provider]?.binding, blob.format == binding.format else { throw Failure.stale }
                try w.access.check()
                driver.stage(w.previous.group(for: s.provider), blob, w.access) { [self, w] result in staged(w, result) }
            } catch { fail(w, error) }
        }
        private func staged(_ w: Work, _ result: Result<Stage, Error>) {
            guard claim(w, .stage, .prune) else { return }
            do {
                let value = try result.get(), s = w.selection
                let group = w.previous.group(for: s.provider), names = Set(group.map { $0.binding.name })
                guard Shared.uuid(value.ticket), let old = group.first, value.bindings == group.map({ $0.binding }),
                      Set(value.checkedRuleCounts.keys) == names,
                      value.checkedRuleCounts.values.allSatisfy({ $0 == s.declaredRuleCount }),
                      value.sha256 == s.newSHA256, value.identity.bytes == s.bytes,
                      value.identity.ownerUID == w.context.owner.ordinaryUID,
                      value.identity.device == old.identity.device, value.identity.inode != old.identity.inode else {
                    // An unrecognized stage is not safe to delete or adopt.
                    lock.lock(); w.cleanupFailed = true; lock.unlock(); throw Failure.stale
                }
                lock.lock()
                let unused = retained[value.ticket] == nil
                if unused { w.stage = value } else { w.cleanupFailed = true }
                lock.unlock()
                // A reused ticket might name a retained prior inode. Never
                // pass that unrecognized stage to a destructive cleanup.
                guard unused else { throw Failure.stale }
                try w.access.check(); pruneThenPublish(w, value)
            } catch { fail(w, error) }
        }
        private func pruneThenPublish(_ w: Work, _ stage: Stage) {
            lock.lock()
            guard work === w, w.phase == .prune else { lock.unlock(); return }
            var count = retained.count + 1, bytes = retained.values.reduce(0) { $0 + $1.identity.bytes } + w.previous.resources[w.selection.provider]!.bytes
            var victims = [Retained]()
            for ticket in retainedOrder where count > maximumRetainedFiles || bytes > maximumRetainedBytes {
                guard let value = retained[ticket] else { continue }
                victims.append(value); count -= 1; bytes -= value.identity.bytes
            }
            lock.unlock()
            guard count <= maximumRetainedFiles, bytes <= maximumRetainedBytes else { fail(w, Failure.unavailable); return }
            if victims.isEmpty { beginPublish(w, stage); return }
            driver.prune(victims, w.access) { [self, w] result in
                guard claim(w, .prune, .publish) else { return }
                var pruneConfirmed = false
                do {
                    let value = try result.get()
                    guard value.removed == Array(victims.prefix(value.removed.count)), value.removed.count <= victims.count,
                          value.complete == (value.removed.count == victims.count) else { throw Failure.stale }
                    lock.lock(); for item in value.removed { retained.removeValue(forKey: item.ticket); retainedOrder.removeAll { $0 == item.ticket } }; lock.unlock()
                    guard value.complete else { throw Failure.unavailable }
                    pruneConfirmed = true
                    try w.access.check(); w.access.allow()
                    driver.publish(stage, w.access) { [self, w] result in publication(w, result) }
                } catch {
                    // Missing/partial prune ACK is itself a private registry
                    // uncertainty. Preserve unconfirmed records and stop lane.
                    if !pruneConfirmed { lock.lock(); w.cleanupFailed = true; lock.unlock() }; fail(w, error)
                }
            }
        }
        private func beginPublish(_ w: Work, _ stage: Stage) {
            guard claim(w, .prune, .publish) else { return }
            do {
                try w.access.check(); w.access.allow()
                driver.publish(stage, w.access) { [self, w] result in publication(w, result) }
            } catch { fail(w, error) }
        }
        private func publication(_ w: Work, _ result: Result<Publication, Error>) {
            guard claim(w, .publish, .terminal) else { return }
            do {
                try w.access.check(); let value = try result.get(), s = w.selection, old = w.previous.resources[s.provider]!
                let next = try Ledger(generationSHA256: Shared.digest(Data((w.previous.generationSHA256 + "\0" + String(w.previous.sequence + 1) + "\0" + w.stage!.ticket + "\0" + s.provider + "\0" + s.newSHA256).utf8)),
                                      sequence: w.previous.sequence + 1, resources: value.resources)
                let group = w.previous.group(for: s.provider), names = Set(group.map { $0.binding.name }), stage = w.stage!
                guard w.access.didEnter, value.acceptance == .synchronousFileRead, value.retained.ticket == stage.ticket,
                      value.retained.originalPath == old.binding.originalPath,
                      value.retained.sha256 == old.fileSHA256, value.retained.identity.device == old.identity.device,
                      value.retained.identity.inode == old.identity.inode, value.retained.identity.ownerUID == old.identity.ownerUID,
                      value.retained.identity.mode == old.identity.mode, value.retained.identity.links == old.identity.links,
                      value.retained.identity.bytes == old.bytes, value.retained.identity.modifiedNS == old.identity.modifiedNS,
                      Set(next.resources.keys) == Set(w.previous.resources.keys),
                      group.allSatisfy({ before in
                          guard let row = next.resources[before.binding.name] else { return false }
                          return row.binding == before.binding && row.registeredFile && row.fileSHA256 == s.newSHA256 && row.bytes == s.bytes &&
                              row.ruleCount == stage.checkedRuleCounts[before.binding.name] && row.identity.ownerUID == w.context.owner.ordinaryUID &&
                              row.identity.device == before.identity.device && row.identity.inode == stage.identity.inode &&
                              row.identity.modifiedNS == stage.identity.modifiedNS && row.identity.inode != before.identity.inode
                      }),
                      w.previous.resources.allSatisfy({ names.contains($0.key) || next.resources[$0.key] == $0.value }),
                      staticAssetBytes + w.context.geo.bytes + next.bytes <= maximumTotalBytes else { throw Failure.stale }
                finish(w, .published, value, next)
            } catch { fail(w, error, try? result.get()) }
        }
        private func fail(_ w: Work, _ error: Error, _ observed: Publication? = nil) {
            let status: Status
            if case Failure.registryUncertain = error { lock.lock(); w.cleanupFailed = true; lock.unlock() }
            switch error as? Failure { case .expired?: status = .expired; case .revoked?, .stale?: status = .stale; default: status = .unavailable }
            finish(w, status, observed)
        }
        private func finish(_ w: Work, _ requested: Status, _ observed: Publication? = nil, _ next: Ledger? = nil) {
            lock.lock(); guard work === w else { lock.unlock(); return }
            if let stage = w.stage, !w.cleanupStarted {
                w.cleanupStarted = true; let disposition: Cleanup = w.access.didEnter ? .keepPublishedAndRetained : .discardUnpublished; lock.unlock()
                driver.cleanup(stage, disposition) { [self, w] result in
                    lock.lock(); guard work === w else { lock.unlock(); return }; if case .failure = result { w.cleanupFailed = true }; lock.unlock()
                    finish(w, requested, observed, next)
                }; return
            }
            lock.unlock()
            let valid: Bool
            do { try w.access.check(); valid = true } catch { valid = false }
            let time = clock()
            lock.lock(); guard work === w else { lock.unlock(); return }
            let entered = w.access.didEnter
            var status = requested
            if w.cleanupFailed { status = entered ? .uncertain : .unavailable }
            else if closed || w.cancelled { status = entered ? .uncertain : .cancelled }
            else if time >= w.access.deadline { status = entered ? .uncertain : .expired }
            else if !valid { status = entered ? .uncertain : .stale }
            else if entered && (requested != .published || next == nil) { status = .uncertain }
            if status == .published, let next, let observed { current = next; retained[observed.retained.ticket] = observed.retained; retainedOrder.append(observed.retained.ticket) }
            if status == .uncertain || w.cleanupFailed { isolated = .init(operationId: w.id, previous: w.previous, selection: w.selection, observed: observed) }
            w.access.finish(); work = nil
            let answer = Reply(status: status, ledger: status == .published || status == .unchanged ? current : nil)
            lock.unlock(); w.reply(answer)
        }
    }
}
