import Foundation

/// A known positive identity never becomes an ordinary-application verdict.
/// A nil permit retains attribution while requiring the caller to deny any
/// previously protected flow. Neither case certifies complete CLI coverage.
struct RelayGuardLineageAttribution: Sendable {
    let process: RelayGuardLineageProcess
    let subject: RelayGuardSubject
    let permit: RelayGuardLineagePermit?
}

struct RelayGuardLineagePermit: Sendable {
    let process: RelayGuardLineageProcess
    let epoch: String
    let revision: UInt64
    let tagVersion: UInt64
    let subject: RelayGuardSubject
    fileprivate let generation: UInt64
}

final class RelayGuardLineageCache: @unchecked Sendable {
    private struct RunContext {
        let run: UUID
        let executionReadiness: @Sendable () -> RelayGuardExecutionLease?
        let onRevoked: @Sendable () -> Void
    }
    private struct ExecutionStage {
        let ticket: RelayGuardExecutionTicket
        let lease: RelayGuardExecutionLease
        var observedFlow = false
        var valid = true
    }
    private struct Entry {
        var subject: RelayGuardSubject?
        var tagVersion: UInt64
        var generation: UInt64
        var epoch: String?
        var revision: UInt64?
        var execution: ExecutionStage? = nil
    }
    private let lock = NSLock()
    private var entries: [RelayGuardLineageProcess: Entry] = [:]
    private var observed: RelayGuardLineageHealth?
    private var observedAt: UInt64 = 0
    private var connected = false
    private var poisonedEpoch: String?
    private var capacityLost = false
    private var executionKeys = Set<RelayGuardLineageProcess>()
    private var runContext: RunContext?
    private let capacity = 65536
    // A cached health reply is a bounded freshness lease, not an OS-atomic
    // guarantee that no event has just been lost in another process.
    private let freshness: UInt64 = 2_500_000_000

    func beginRun(_ run: UUID, executionReadiness: @escaping @Sendable () -> RelayGuardExecutionLease?,
                  onRevoked: @escaping @Sendable () -> Void) {
        lock.lock()
        runContext = .init(run: run, executionReadiness: executionReadiness, onRevoked: onRevoked)
        lock.unlock()
    }

    func retireRun(_ run: UUID) {
        lock.lock()
        guard let context = runContext, context.run == run else { lock.unlock(); return }
        runContext = nil
        revokeLocked()
        lock.unlock(); context.onRevoked()
    }

    /// Reserve enough space before asking the source about previously unseen
    /// keys, so no newly returned positive label is observed and then evicted.
    /// Requests are serialized by the owning client. Exhaustion is unavailable,
    /// never a global Node allow/drop rule or a silent cache reset.
    func canQuery(_ tokens: [Data]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let keys = Set(tokens.compactMap { RelayGuardLineageProcess(auditToken: $0) })
        guard keys.count > 0, keys.count <= 2, !capacityLost else { return false }
        if entries.count + keys.filter({ entries[$0] == nil }).count > capacity {
            capacityLost = true; connected = false; observedAt = 0; invalidateAllLocked()
            return false
        }
        return true
    }

    func prepareExecution(_ ticket: RelayGuardExecutionTicket, lease: RelayGuardExecutionLease) throws {
        lock.lock(); defer { lock.unlock() }
        guard freshLocked(), observed?.epoch == ticket.health.epoch, observed?.revision == ticket.health.revision,
              RelayGuardExecutionClock.remainingNanoseconds(until: ticket.expiresMach) != nil,
              let key = ticket.process, entries[key] == nil, entries.count < capacity else {
            throw RelayGuardLineageWireFailure.unavailable
        }
        entries[key] = Entry(subject: ticket.subject, tagVersion: ticket.tagVersion, generation: 1,
            epoch: ticket.health.epoch, revision: ticket.health.revision,
            execution: ExecutionStage(ticket: ticket, lease: lease))
        executionKeys.insert(key)
    }

    /// A prepared target has no committed ES query result yet. A kernel flow
    /// for that exact full token uses its bounded local reservation.
    func stagedAttributions(_ tokens: [Data]) -> [RelayGuardLineageAttribution?]? {
        lock.lock()
        let staged = freshLocked() && tokens.contains { token in
            guard let key = RelayGuardLineageProcess(auditToken: token), let execution = entries[key]?.execution else { return false }
            return execution.valid && execution.ticket.targetToken == token
                && RelayGuardExecutionClock.remainingNanoseconds(until: execution.ticket.expiresMach) != nil
        }
        lock.unlock()
        return staged ? tokens.map(attribution) : nil
    }

    func settleExecution(_ ticket: RelayGuardExecutionTicket, outcome: RelayGuardExecutionOutcome) {
        guard let key = ticket.process else { return }
        let currentLease = outcome == .committed ? executionLease(for: key) : nil
        lock.lock()
        guard var entry = entries[key], let execution = entry.execution,
              execution.ticket.matches(ticket) else {
            // A new authenticated owner may receive a committed result without
            // having held the old owner's provisional permit. Remember its
            // positive membership; a normal query must supply a fresh permit.
            // A lost/unknown claim cannot disappear when the NE owner changes.
            let learned = outcome != .aborted && entries[key] == nil
            if learned {
                entries[key] = Entry(subject: ticket.subject, tagVersion: ticket.tagVersion,
                    generation: 1, epoch: nil, revision: nil)
                if entries.count > capacity { capacityLost = true; connected = false }
            }
            let callback = learned ? runContext?.onRevoked : nil
            lock.unlock(); callback?(); return
        }
        executionKeys.remove(key)
        var revoked = true
        switch outcome {
        case .committed:
            entry.execution = nil
            // An old owner's or expired stage retains membership. Only the
            // active owner's valid stage may carry its permit across commit.
            let current = execution.valid && execution.lease == currentLease
                && runContext?.run.uuidString.lowercased() == execution.lease.providerRunID
                && RelayGuardExecutionClock.remainingNanoseconds(until: ticket.expiresMach) != nil
                && freshLocked() && observed?.epoch == ticket.health.epoch && observed?.revision == ticket.health.revision
            entry.epoch = current ? ticket.health.epoch : nil
            entry.revision = current ? ticket.health.revision : nil
            entries[key] = entry
            // An accepted exec can still lose its provisional flow lease.
            // Wake the Provider's active-flow revocation observer in that case.
            revoked = !current
        case .aborted:
            if !execution.observedFlow { entries.removeValue(forKey: key) }
            else { invalidateLocked(key) }
        case .uncertain:
            invalidateLocked(key)
        }
        let callback = revoked ? runContext?.onRevoked : nil
        lock.unlock(); callback?()
    }

    func expireExecutionClaims() {
        lock.lock()
        var expired = false
        for key in Array(executionKeys) {
            guard let execution = entries[key]?.execution else { executionKeys.remove(key); continue }
            if RelayGuardExecutionClock.remainingNanoseconds(until: execution.ticket.expiresMach) == nil {
                invalidateLocked(key); expired = true
            }
        }
        let callback = expired ? runContext?.onRevoked : nil
        lock.unlock(); callback?()
    }

    func apply(_ health: RelayGuardLineageHealth, changed: [RelayGuardLineageProcess] = [], invalidateAll: Bool = false) throws {
        lock.lock()
        if let old = observed, old.epoch == health.epoch, health.revision < old.revision {
            revokeLocked()
            let callback = runContext?.onRevoked
            lock.unlock(); callback?()
            throw RelayGuardLineageWireFailure.stale
        }
        let epochChanged = observed?.epoch != health.epoch
        let revisionChanged = observed?.revision != health.revision
        if let old = observed, old.epoch == health.epoch, old.available && !health.available { poisonedEpoch = health.epoch }
        if !Set(health.losses).isSubset(of: ["lateAttach"]) { poisonedEpoch = health.epoch }
        // The authenticated source promises changed contains positive members
        // only. Remember membership before a fresh query supplies its category;
        // a late negative query can never turn it into ordinary Node traffic.
        for key in changed where entries[key] == nil {
            entries[key] = Entry(subject: nil, tagVersion: 0, generation: 1, epoch: nil, revision: nil)
        }
        // One bounded callback may cross the limit by at most 256 entries.
        // Retain that entire observed-positive batch, then retire the client;
        // no later connection/update may accumulate further keys.
        if entries.count > capacity { capacityLost = true }
        let revoked = epochChanged || revisionChanged || invalidateAll || !health.available || !changed.isEmpty
        if epochChanged || revisionChanged || invalidateAll || !health.available { invalidateAllLocked() }
        else {
            for key in changed { invalidateLocked(key) }
        }
        observed = health; observedAt = DispatchTime.now().uptimeNanoseconds
        connected = health.available && poisonedEpoch != health.epoch && !capacityLost
        let callback = revoked ? runContext?.onRevoked : nil
        let exhausted = capacityLost
        lock.unlock(); callback?()
        if exhausted { throw RelayGuardLineageWireFailure.capacity }
    }

    func record(_ results: [RelayGuardLineageResult], health: RelayGuardLineageHealth, grantsCurrent: Bool) throws {
        lock.lock()
        var changed = false
        defer { let callback = changed ? runContext?.onRevoked : nil; lock.unlock(); callback?() }
        guard observed?.epoch == health.epoch, observed?.revision == health.revision else { throw RelayGuardLineageWireFailure.stale }
        for result in results {
            guard let key = RelayGuardLineageProcess(auditToken: result.auditToken) else { throw RelayGuardLineageWireFailure.invalid }
            guard let tag = result.tag else {
                // A missing tag cannot erase a label learned earlier, even
                // after an ES restart or a query on a new connection.
                invalidateLocked(key)
                changed = entries[key] != nil || changed
                continue
            }
            guard tag.process == key, entries[key] != nil || entries.count < capacity else { throw RelayGuardLineageWireFailure.capacity }
            let previous = entries[key]
            if let previous, previous.epoch == health.epoch, tag.tagVersion < previous.tagVersion {
                invalidateLocked(key); throw RelayGuardLineageWireFailure.stale
            }
            let subject = previous?.subject.map { RelayGuardIdentityClassifier.combine([$0, tag.subject]) } ?? tag.subject
            guard previous?.generation != UInt64.max else { throw RelayGuardLineageWireFailure.capacity }
            let same = previous?.epoch == health.epoch && previous?.revision == health.revision
                && previous?.tagVersion == tag.tagVersion && previous?.subject == subject
            let generation = same ? (previous?.generation ?? 1) : (previous?.generation ?? 0) + 1
            changed = changed || (previous != nil && !same)
            let permitCurrent = connected && (grantsCurrent || same)
            entries[key] = Entry(subject: subject, tagVersion: tag.tagVersion, generation: generation,
                                 epoch: permitCurrent ? health.epoch : nil, revision: permitCurrent ? health.revision : nil)
            executionKeys.remove(key)
        }
    }

    func attribution(_ token: Data) -> RelayGuardLineageAttribution? {
        guard let key = RelayGuardLineageProcess(auditToken: token) else { return nil }
        let currentLease = executionLease(for: key)
        lock.lock(); defer { lock.unlock() }
        guard var entry = entries[key] else { return nil }
        var executionCurrent = true
        if var execution = entry.execution {
            executionCurrent = execution.valid && execution.ticket.targetToken == token
                && execution.lease == currentLease
                && RelayGuardExecutionClock.remainingNanoseconds(until: execution.ticket.expiresMach) != nil
            // Any real kernel flow for this generation prevents an abort
            // from erasing membership, including a changed credential token.
            execution.observedFlow = true; entry.execution = execution; entries[key] = entry
        }
        let permit: RelayGuardLineagePermit?
        if executionCurrent, freshLocked(), let subject = entry.subject, let epoch = entry.epoch, let revision = entry.revision,
           epoch == observed?.epoch, revision == observed?.revision {
            permit = .init(process: key, epoch: epoch, revision: revision, tagVersion: entry.tagVersion,
                           subject: subject, generation: entry.generation)
        } else { permit = nil }
        return .init(process: key, subject: entry.subject ?? .unresolved, permit: permit)
    }

    func current(_ permit: RelayGuardLineagePermit) -> Bool {
        let currentLease = executionLease(for: permit.process)
        lock.lock(); defer { lock.unlock() }
        guard freshLocked(), observed?.epoch == permit.epoch, observed?.revision == permit.revision,
              let entry = entries[permit.process] else { return false }
        if let execution = entry.execution,
           !execution.valid || execution.lease != currentLease
            || RelayGuardExecutionClock.remainingNanoseconds(until: execution.ticket.expiresMach) == nil { return false }
        return entry.epoch == permit.epoch && entry.revision == permit.revision && entry.tagVersion == permit.tagVersion
            && entry.generation == permit.generation && entry.subject == permit.subject
    }

    var health: RelayGuardLineageHealth? { lock.lock(); defer { lock.unlock() }; return freshLocked() ? observed : nil }
    var available: Bool { lock.lock(); defer { lock.unlock() }; return freshLocked() }
    var exhausted: Bool { lock.lock(); defer { lock.unlock() }; return capacityLost }

    private func freshLocked() -> Bool {
        let now = DispatchTime.now().uptimeNanoseconds
        return connected && observed?.available == true && now >= observedAt && now - observedAt < freshness
    }
    private func executionLease(for key: RelayGuardLineageProcess) -> RelayGuardExecutionLease? {
        lock.lock()
        let callback = entries[key]?.execution == nil ? nil : runContext?.executionReadiness
        lock.unlock()
        // The Provider's snapshot can invoke its own revocation observer. Do
        // not hold the lineage cache lock while checking that external lease.
        return callback?()
    }
    private func invalidateLocked(_ key: RelayGuardLineageProcess) {
        guard var entry = entries[key] else { return }
        entry.epoch = nil; entry.revision = nil
        if var execution = entry.execution { execution.valid = false; entry.execution = execution }
        executionKeys.remove(key)
        if entry.generation < UInt64.max { entry.generation += 1 }
        entries[key] = entry
    }
    private func invalidateAllLocked() { for key in Array(entries.keys) { invalidateLocked(key) } }
    private func revokeLocked() {
        connected = false; observedAt = 0
        invalidateAllLocked()
    }
}
