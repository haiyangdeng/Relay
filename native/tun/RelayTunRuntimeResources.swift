import Foundation
import CryptoKit

/// Independent resource authority model. No files, sockets, processes or
/// lifecycle actions are opened here. A future positive capability supplies
/// fixed-inbox/fixed-Core-path IO; it must not adopt renderer paths or PIDs.
enum RelayTunRuntimeResources {
    static let capability = "runtime-resources-v1"
    static let maximumBytes = 128 * 1024 * 1024
    static let maximumTotalBytes = 256 * 1024 * 1024
    static let defaultLeaseSeconds = 30
    static let maximumLeaseSeconds = 120
    private static let maximumSequence: UInt64 = 9_007_199_254_740_991
    enum Failure: Error { case invalid, stale, revoked, expired, unavailable, entered }

    static func hash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value)?.uuidString.lowercased() == value
    }
    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    enum Kind: String, CaseIterable {
        case geosite = "geosite-dat", geoip = "geoip-dat", country = "country-mmdb", asn = "asn-mmdb"
        var basename: String {
            switch self {
            case .geosite: return "GeoSite.dat"
            case .geoip: return "GeoIP.dat"
            case .country: return "Country.mmdb"
            case .asn: return "ASN.mmdb"
            }
        }
    }
    /// Private fd/path identity, constructed by a NOFOLLOW bounded reader.
    /// The expected UID is the ordinary session owner, not a root fallback.
    struct FileIdentity: Equatable {
        let device: UInt64, inode: UInt64, ownerUID: UInt32, mode: UInt32, links: UInt64, bytes: Int
        let modifiedNS: UInt64, changedNS: UInt64
        init(device: UInt64, inode: UInt64, ownerUID: UInt32, mode: UInt32, links: UInt64,
             bytes: Int, modifiedNS: UInt64, changedNS: UInt64) throws {
            guard inode > 0, ownerUID > 0, mode == 0o100600, links == 1,
                  bytes > 0, bytes <= maximumBytes else { throw Failure.invalid }
            self.device = device; self.inode = inode; self.ownerUID = ownerUID; self.mode = mode
            self.links = links; self.bytes = bytes; self.modifiedNS = modifiedNS; self.changedNS = changedNS
        }
    }
    struct Resource: Equatable {
        let kind: Kind, sha256: String, identity: FileIdentity, active: Bool
        var bytes: Int { identity.bytes }
        init(kind: Kind, sha256: String, identity: FileIdentity, active: Bool) throws {
            guard hash(sha256) else { throw Failure.invalid }
            self.kind = kind; self.sha256 = sha256; self.identity = identity; self.active = active
        }
    }
    /// Core heads are opaque. Native verifies exact parent/sequence and typed
    /// postimages, never recreates a Go JSON encoding to derive this digest.
    struct Ledger: Equatable {
        let bootId: String, generationSHA256: String, sequence: UInt64, resources: [Kind: Resource]
        init(bootId: String, generationSHA256: String, sequence: UInt64, resources: [Resource]) throws {
            guard uuid(bootId), hash(generationSHA256), sequence <= maximumSequence,
                  Set(resources.map { $0.kind }).count == resources.count else { throw Failure.invalid }
            self.bootId = bootId; self.generationSHA256 = generationSHA256; self.sequence = sequence
            self.resources = Dictionary(uniqueKeysWithValues: resources.map { ($0.kind, $0) })
        }
    }
    struct Owner: Equatable {
        let heldGeneration: UInt64, configurationRevision: String, coreBootId: String, ordinaryUID: UInt32
        init(heldGeneration: UInt64, configurationRevision: String, coreBootId: String, ordinaryUID: UInt32) throws {
            guard heldGeneration > 0, hash(configurationRevision), uuid(coreBootId), ordinaryUID > 0 else { throw Failure.invalid }
            self.heldGeneration = heldGeneration; self.configurationRevision = configurationRevision
            self.coreBootId = coreBootId; self.ordinaryUID = ordinaryUID
        }
    }
    struct Selection {
        let kind: Kind, configurationRevision: String, expectedGenerationSHA256: String
        let oldSHA256: String, newSHA256: String, blobId: String, selector: String, bytes: Int
        init(kind: Kind, configurationRevision: String, expectedGenerationSHA256: String,
             oldSHA256: String, newSHA256: String, blobId: String, selector: String, bytes: Int) throws {
            guard [configurationRevision, expectedGenerationSHA256, oldSHA256, newSHA256].allSatisfy(hash),
                  uuid(blobId), bytes > 0, bytes <= maximumBytes, !selector.isEmpty, selector.utf8.count <= 256,
                  selector == selector.trimmingCharacters(in: .whitespacesAndNewlines), !selector.contains(","),
                  selector.unicodeScalars.allSatisfy({ $0.value >= 32 && !(127...159).contains($0.value) }) else { throw Failure.invalid }
            self.kind = kind; self.configurationRevision = configurationRevision
            self.expectedGenerationSHA256 = expectedGenerationSHA256; self.oldSHA256 = oldSHA256
            self.newSHA256 = newSHA256; self.blobId = blobId; self.selector = selector; self.bytes = bytes
        }
    }
    struct Blob {
        let id: String, kind: Kind, sha256: String, identity: FileIdentity
        /// Exact already-verified bytes travel with this one logical work;
        /// the driver must not consult a mutable global "current blob" slot.
        let data: Data
        init(id: String, kind: Kind, data: Data, identity: FileIdentity) throws {
            guard uuid(id), data.count == identity.bytes else { throw Failure.invalid }
            self.id = id; self.kind = kind; sha256 = digest(data); self.identity = identity; self.data = data
        }
    }
    /// Only the driver sees this Core nonce; no public result contains it.
    struct Prepared {
        let nonce: String, bootId: String, kind: Kind, oldSHA256: String, newSHA256: String
        let previousGenerationSHA256: String, sequence: UInt64, bytes: Int, remainingMilliseconds: Int
    }
    struct Receipt {
        let bootId: String, kind: Kind, oldSHA256: String, newSHA256: String, bytes: Int
        let previousGenerationSHA256: String, generationSHA256: String, sequence: UInt64, retainedOriginal: Bool
    }
    struct Publication {
        let receipt: Receipt
        /// Re-read Core state plus independently pinned fixed-target file
        /// identities and complete SHA checks, not just the POST response.
        let readback: Ledger
    }
    enum Cancellation { case cancelled, uncertain }

    fileprivate final class Scope {
        private let lock = NSLock(); private var live = true
        func revoke() { lock.lock(); live = false; lock.unlock() }
        var isLive: Bool { lock.lock(); defer { lock.unlock() }; return live }
    }
    final class Access {
        private let lock = NSLock(), scope: Scope, owner: Owner, clock: () -> UInt64
        private let currentOwner: () throws -> Owner
        private var limit: UInt64, writable = false, revoked = false, entered = false, finished = false
        fileprivate init(deadline: UInt64, owner: Owner, scope: Scope, clock: @escaping () -> UInt64,
                         currentOwner: @escaping () throws -> Owner) {
            limit = deadline; self.owner = owner; self.scope = scope; self.clock = clock; self.currentOwner = currentOwner
        }
        var deadline: UInt64 { lock.lock(); defer { lock.unlock() }; return limit }
        private func validate(enter: Bool) throws {
            // The callback may re-enter cancel/close. Never invoke it while
            // holding a model lock, then finish with pure latch/time checks.
            guard try currentOwner() == owner else { throw Failure.revoked }
            lock.lock(); defer { lock.unlock() }
            guard !revoked, !finished, scope.isLive else { throw Failure.revoked }
            guard clock() < limit else { throw Failure.expired }
            if enter { guard writable, !entered else { throw Failure.entered }; entered = true }
        }
        func check() throws { try validate(enter: false) }
        /// Final synchronous owner/authority check immediately before the
        /// actual Core commit request write, after every IO/observer callback.
        func enterWrite() throws { try validate(enter: true) }
        fileprivate func shorten(milliseconds: Int) throws {
            guard milliseconds > 0, milliseconds <= maximumLeaseSeconds * 1000 else { throw Failure.invalid }
            let time = clock(), duration = UInt64(milliseconds) * 1_000_000
            guard time <= UInt64.max - duration else { throw Failure.expired }
            lock.lock(); limit = min(limit, time + duration); lock.unlock()
            try check()
        }
        fileprivate func cancel() { lock.lock(); revoked = true; lock.unlock() }
        fileprivate func allowWrite() { lock.lock(); writable = true; lock.unlock() }
        fileprivate func finish() { lock.lock(); finished = true; lock.unlock() }
        var didEnter: Bool { lock.lock(); defer { lock.unlock() }; return entered }
    }
    struct Driver {
        let currentOwner: () throws -> Owner
        let readBlob: (Selection, Access, @escaping (Result<Blob, Error>) -> Void) -> Void
        /// Stage only under fixed Inbox/blob UUID/kind basename. This phase
        /// cannot publish an active resource or use Access.enterWrite.
        let prepareCore: (Selection, Blob, Access, @escaping (Result<Prepared, Error>) -> Void) -> Void
        /// The writer calls enterWrite adjacent to the real request attempt.
        /// It must then get the Core receipt and independent full readback.
        let commitCore: (Prepared, Access, @escaping (Result<Publication, Error>) -> Void) -> Void
        /// Neutralize only this private prepared nonce on the same held peer.
        /// No new authority, retry, rollback or active mutation is permitted.
        let cancelPrepared: (Prepared, Owner, UInt64, @escaping (Result<Cancellation, Error>) -> Void) -> Void
    }
    enum Status: String { case updated, unchanged, busy, stale, expired, cancelled, cancelling, uncertain, unavailable, unsupported }
    struct Reply { let status: Status; var pending = false; var ledger: Ledger? }
    struct Isolation {
        let operationId: Int, selection: Selection, previous: Ledger
        /// Observation only. Never automatically adopted after scope loss.
        let observedPublication: Publication?
    }
    final class Controller {
        private enum Phase { case blob, prepare, commit, terminal }
        private final class Work {
            let id: Int, selection: Selection, previous: Ledger, owner: Owner, access: Access, reply: (Reply) -> Void
            var phase = Phase.blob, cancelled = false
            var prepared: Prepared?, cleanupStarted = false, cleanupFailed = false, cleanupUncertain = false
            init(id: Int, selection: Selection, previous: Ledger, owner: Owner, access: Access, reply: @escaping (Reply) -> Void) {
                self.id = id; self.selection = selection; self.previous = previous
                self.owner = owner; self.access = access; self.reply = reply
            }
        }
        private let lock = NSLock(), scope = Scope(), driver: Driver, clock: () -> UInt64, duration: UInt64
        private let staticAssetBytes: Int
        private var current: Ledger, work: Work?, lastID = 0, closed = false
        private var startingID: Int?, startingCancelled = false, isolated: Isolation?
        init(ledger: Ledger, staticAssetBytes: Int, driver: Driver, leaseSeconds: Int = defaultLeaseSeconds,
             clock: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) throws {
            guard (1...maximumLeaseSeconds).contains(leaseSeconds), staticAssetBytes >= 0,
                  staticAssetBytes <= maximumTotalBytes,
                  staticAssetBytes + ledger.resources.values.reduce(0, { $0 + $1.bytes }) <= maximumTotalBytes else { throw Failure.invalid }
            self.staticAssetBytes = staticAssetBytes
            current = ledger; self.driver = driver; self.clock = clock; duration = UInt64(leaseSeconds) * 1_000_000_000
        }
        deinit { scope.revoke(); work?.access.cancel() }
        var isBusy: Bool { lock.lock(); defer { lock.unlock() }; return work != nil || startingID != nil }
        var knownLedger: Ledger { lock.lock(); defer { lock.unlock() }; return current }
        var isolation: Isolation? { lock.lock(); defer { lock.unlock() }; return isolated }
        var isIsolated: Bool { lock.lock(); defer { lock.unlock() }; return isolated != nil }
        func close() {
            scope.revoke(); lock.lock(); closed = true; startingCancelled = true
            work?.cancelled = true; work?.access.cancel(); lock.unlock()
        }
        func cancel(operationId: Int) -> Reply {
            lock.lock(); defer { lock.unlock() }
            if startingID == operationId { startingCancelled = true; return .init(status: .cancelling, pending: true) }
            guard let work, work.id == operationId else { return .init(status: .stale, pending: work != nil || startingID != nil) }
            work.cancelled = true; work.access.cancel()
            return .init(status: work.access.didEnter ? .uncertain : .cancelling, pending: true)
        }
        /// Human Native consent happens BEFORE this call and its bounded
        /// monotonic budget. That consent is never persisted in this model.
        func replace(id: Int, selection: Selection, reply: @escaping (Reply) -> Void) {
            lock.lock()
            guard id > lastID, id > 0, id <= Int(Int32.max), !closed else { lock.unlock(); reply(.init(status: .unavailable)); return }
            lastID = id
            guard work == nil, startingID == nil else { lock.unlock(); reply(.init(status: .busy, pending: true)); return }
            guard isolated == nil else { lock.unlock(); reply(.init(status: .uncertain)); return }
            startingID = id; startingCancelled = false
            let previous = current; lock.unlock()
            let start = clock()
            guard start <= UInt64.max - duration else { finishStarting(id: id, reply: reply, status: .expired); return }
            let owner: Owner
            do { owner = try driver.currentOwner() }
            catch { finishStarting(id: id, reply: reply, status: .unavailable); return }
            let access = Access(deadline: start + duration, owner: owner, scope: scope, clock: clock, currentOwner: driver.currentOwner)
            let candidate = Work(id: id, selection: selection, previous: previous, owner: owner, access: access, reply: reply)
            lock.lock()
            guard !closed, !startingCancelled, startingID == id, work == nil, isolated == nil, current == previous else {
                lock.unlock(); finishStarting(id: id, reply: reply, status: .stale); return
            }
            startingID = nil
            work = candidate; lock.unlock()
            do {
                try access.check()
                guard owner.configurationRevision == selection.configurationRevision, owner.coreBootId == previous.bootId,
                      previous.generationSHA256 == selection.expectedGenerationSHA256,
                      previous.resources.values.allSatisfy({ $0.identity.ownerUID == owner.ordinaryUID }) else { throw Failure.stale }
                guard previous.sequence < maximumSequence else { finish(candidate, status: .unsupported); return }
                guard let resource = previous.resources[selection.kind] else { finish(candidate, status: .unsupported); return }
                guard resource.active else { finish(candidate, status: .unsupported); return }
                guard resource.sha256 == selection.oldSHA256, resource.identity.ownerUID == owner.ordinaryUID else { throw Failure.stale }
                guard staticAssetBytes + previous.resources.values.reduce(0, { $0 + $1.bytes }) - resource.bytes + selection.bytes <= maximumTotalBytes else {
                    finish(candidate, status: .unsupported); return
                }
                if selection.newSHA256 == resource.sha256 {
                    guard selection.bytes == resource.bytes else { throw Failure.stale }
                    finish(candidate, status: .unchanged); return
                }
                driver.readBlob(selection, access) { [self, candidate] result in blob(candidate, result: result) }
            } catch { fail(candidate, error: error) }
        }
        private func finishStarting(id: Int, reply: (Reply) -> Void, status: Status) {
            lock.lock()
            guard startingID == id else { lock.unlock(); return }
            let answer = Reply(status: closed || startingCancelled ? .cancelled : status)
            startingID = nil; lock.unlock(); reply(answer)
        }
        private func claim(_ candidate: Work, phase: Phase, next: Phase) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard work === candidate, candidate.phase == phase else { return false }
            candidate.phase = next; return true
        }
        private func blob(_ candidate: Work, result: Result<Blob, Error>) {
            guard claim(candidate, phase: .blob, next: .prepare) else { return }
            do {
                try candidate.access.check()
                let value = try result.get(), selection = candidate.selection
                guard value.id == selection.blobId, value.kind == selection.kind, value.sha256 == selection.newSHA256,
                      value.identity.bytes == selection.bytes, value.identity.ownerUID == candidate.owner.ordinaryUID else { throw Failure.stale }
                try candidate.access.check()
                driver.prepareCore(selection, value, candidate.access) { [self, candidate] result in prepared(candidate, result: result) }
            } catch { fail(candidate, error: error) }
        }
        private func prepared(_ candidate: Work, result: Result<Prepared, Error>) {
            guard claim(candidate, phase: .prepare, next: .commit) else { return }
            do {
                let value = try result.get(), selection = candidate.selection
                guard hash(value.nonce), value.bootId == candidate.owner.coreBootId, value.kind == selection.kind,
                      value.oldSHA256 == selection.oldSHA256, value.newSHA256 == selection.newSHA256,
                      value.previousGenerationSHA256 == candidate.previous.generationSHA256,
                      value.sequence == candidate.previous.sequence, value.bytes == selection.bytes else { throw Failure.stale }
                // Preserve the exact private ticket even if cancel/owner loss
                // happened while Core prepare was returning. Revoke that
                // ticket before publishing a terminal prewrite result.
                lock.lock(); candidate.prepared = value; lock.unlock()
                try candidate.access.check()
                try candidate.access.shorten(milliseconds: value.remainingMilliseconds)
                candidate.access.allowWrite()
                driver.commitCore(value, candidate.access) { [self, candidate] result in publication(candidate, result: result) }
            } catch { fail(candidate, error: error) }
        }
        private func publication(_ candidate: Work, result: Result<Publication, Error>) {
            guard claim(candidate, phase: .commit, next: .terminal) else { return }
            do {
                try candidate.access.check()
                let value = try result.get(), receipt = value.receipt, selection = candidate.selection, previous = candidate.previous
                guard candidate.access.didEnter, receipt.bootId == previous.bootId, receipt.kind == selection.kind,
                      receipt.oldSHA256 == selection.oldSHA256, receipt.newSHA256 == selection.newSHA256,
                      receipt.bytes == selection.bytes, receipt.retainedOriginal,
                      receipt.previousGenerationSHA256 == previous.generationSHA256,
                      receipt.sequence == previous.sequence + 1, receipt.sequence <= maximumSequence,
                      hash(receipt.generationSHA256), receipt.generationSHA256 != previous.generationSHA256,
                      value.readback.bootId == previous.bootId, value.readback.generationSHA256 == receipt.generationSHA256,
                      value.readback.sequence == receipt.sequence, Set(value.readback.resources.keys) == Set(previous.resources.keys),
                      staticAssetBytes + value.readback.resources.values.reduce(0, { $0 + $1.bytes }) <= maximumTotalBytes,
                      let after = value.readback.resources[selection.kind], let old = previous.resources[selection.kind],
                      after.active, after.sha256 == selection.newSHA256, after.bytes == selection.bytes,
                      after.identity.ownerUID == candidate.owner.ordinaryUID,
                      after.identity.device == old.identity.device, after.identity.inode != old.identity.inode,
                      previous.resources.allSatisfy({ $0.key == selection.kind || value.readback.resources[$0.key] == $0.value }) else { throw Failure.stale }
                finish(candidate, status: .updated, publication: value)
            } catch { fail(candidate, error: error, observed: try? result.get()) }
        }
        private func fail(_ candidate: Work, error: Error, observed: Publication? = nil) {
            let status: Status
            switch error as? Failure {
            case .expired?: status = .expired
            case .revoked?: status = .stale
            case .stale?: status = .stale
            default: status = .unavailable
            }
            finish(candidate, status: status, observed: observed)
        }
        private func finish(_ candidate: Work, status requested: Status, publication: Publication? = nil,
                            observed: Publication? = nil) {
            lock.lock()
            guard work === candidate else { lock.unlock(); return }
            if !candidate.access.didEnter, let prepared = candidate.prepared, !candidate.cleanupStarted {
                candidate.cleanupStarted = true; lock.unlock()
                driver.cancelPrepared(prepared, candidate.owner, candidate.access.deadline) { [self, candidate] result in
                    lock.lock()
                    guard work === candidate, candidate.prepared != nil else { lock.unlock(); return }
                    candidate.prepared = nil
                    if case .failure = result { candidate.cleanupFailed = true }
                    if case .success(.uncertain) = result { candidate.cleanupUncertain = true }
                    lock.unlock(); finish(candidate, status: requested, publication: publication, observed: observed)
                }
                return
            }
            lock.unlock()
            let valid: Bool
            do { try candidate.access.check(); valid = true } catch { valid = false }
            lock.lock()
            guard work === candidate else { lock.unlock(); return }
            let entered = candidate.access.didEnter
            var status = requested
            if candidate.cleanupUncertain { status = .uncertain }
            else if candidate.cleanupFailed { status = .unavailable }
            else if closed || candidate.cancelled { status = entered ? .uncertain : .cancelled }
            else if clock() >= candidate.access.deadline { status = entered ? .uncertain : .expired }
            else if !valid { status = entered ? .uncertain : .stale }
            else if entered && (requested != .updated || publication == nil) { status = .uncertain }
            if status == .updated, let publication { current = publication.readback }
            if status == .uncertain {
                isolated = .init(operationId: candidate.id, selection: candidate.selection, previous: candidate.previous,
                                  observedPublication: publication ?? observed)
            }
            candidate.access.finish(); work = nil
            let answer = Reply(status: status, ledger: status == .updated || status == .unchanged ? current : nil)
            lock.unlock(); candidate.reply(answer)
        }
    }
}
