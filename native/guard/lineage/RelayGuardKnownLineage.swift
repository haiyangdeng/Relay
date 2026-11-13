import Darwin
import EndpointSecurity
import Foundation

/// Actual fork/exec edges carry neutral Terminal provenance. Verified CLI
/// candidates become protected only after that provenance reaches their node.
/// This does not certify a complete initial system snapshot or a JS catalog.
final class RelayGuardKnownLineage: @unchecked Sendable {
    private struct Node {
        var subjects = Set<RelayGuardSubject>()
        var cliCandidates = Set<RelayGuardSubject>()
        var terminalOrigin = false
        var successors = Set<RelayGuardProcessGeneration>()
        var predecessors = Set<RelayGuardProcessGeneration>()
        var tagVersion: UInt64 = 0
        var executionTicket: RelayGuardExecutionTicket?
        var retiredAt: UInt64?
        var retirementQueued = false
    }

    private struct Retirement {
        let key: RelayGuardProcessGeneration
        let timestamp: UInt64
    }

    private struct ExecutionReservation {
        let ticket: RelayGuardExecutionTicket
        let subjects: Set<RelayGuardSubject>
        let terminalOrigin: Bool
        var allowed = false
        var uncertain = false
    }

    private let lock = NSLock()
    private let epoch = UUID()
    private var revision: UInt64 = 1
    private var nextTagVersion: UInt64 = 1
    private var losses: Set<RelayGuardLineageLoss> = [.lateAttach]
    private var nodes: [RelayGuardProcessGeneration: Node] = [:]
    private var globalSequence: UInt64?
    private var sequences: [UInt32: UInt64] = [:]
    private var executions: [RelayGuardProcessGeneration: ExecutionReservation] = [:]
    private var retirements: [Retirement] = []
    private var latestTimestamp: UInt64 = 0
    private let graceTicks: UInt64 = {
        var timebase = mach_timebase_info_data_t()
        guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.numer > 0 else { return UInt64.max }
        return 5_000_000_000 * UInt64(timebase.denom) / UInt64(timebase.numer)
    }()
    // No silent eviction can turn a formerly protected execution into "other".
    // Exhaustion records loss and requires a separately verified new epoch.
    private let capacity = 65536

    var completeScopeReady: Bool { false }

    func state() -> (epoch: String, revision: UInt64, knownAvailable: Bool, losses: [String]) {
        lock.lock(); defer { lock.unlock() }
        return (epoch.uuidString.lowercased(), revision, losses == [.lateAttach], losses.map(\.rawValue).sorted())
    }

    func failed(_ reason: RelayGuardLineageLoss) -> RelayGuardLineageChange {
        lock.lock(); defer { lock.unlock() }
        lose(reason)
        return .init(changed: [], invalidateAll: true)
    }

    func consume(_ event: RelayGuardESObservation) -> RelayGuardLineageChange {
        lock.lock(); defer { lock.unlock() }
        let before = revision
        var changed = Set<RelayGuardProcessGeneration>()
        var settlements: [RelayGuardExecutionSettlement] = []
        func result() -> RelayGuardLineageChange {
            .init(changed: changed, invalidateAll: before != revision, executionSettlements: settlements)
        }
        observeSequence(version: event.messageVersion, type: event.rawEventType,
            sequence: event.sequence, global: event.globalSequence, timestamp: event.timestamp)
        guard event.messageVersion >= 4, event.phase == .notification else {
            lose(.unsupportedMessage); return result()
        }
        if event.kind == .exec, event.executionAllowed != true {
            if let target = event.target, let reservation = executions[target] {
                guard matches(event, reservation) else {
                    lose(.invalidTransition); return result()
                }
                removeExecution(target)
                settlements.append(.init(ticket: reservation.ticket, outcome: .aborted))
            }
            // A denied replacement did not end the actor's old execution.
            return result()
        }
        guard ensure(event.actor) else { return result() }
        mark(event.actor, subject: event.actorSubject, terminalOrigin: event.actorTerminalOrigin, changed: &changed)
        switch event.kind {
        case .fork, .exec:
            guard let target = event.target, target != event.actor,
                  (event.kind == .exec ? target.pid == event.actor.pid : target.pid != event.actor.pid) else {
                lose(.invalidTransition); return result()
            }
            if event.kind == .exec, let reservation = executions[target] {
                guard matches(event, reservation) else {
                    lose(.invalidTransition); return result()
                }
                removeExecution(target)
                guard ensure(target) else {
                    executions[target] = reservation
                    settlements.append(.init(ticket: reservation.ticket, outcome: .uncertain))
                    return result()
                }
                let inherited = nodes[event.actor]?.subjects ?? []
                var combined = reservation.subjects.union(inherited)
                // New explicit negative target evidence dominates a previously
                // prepared identity. A merely unresolved dynamic read does not.
                if event.targetSubject == .unverifiedProtected { combined.insert(.unverifiedProtected) }
                let healthy = reservation.allowed && !reservation.uncertain
                    && reservation.ticket.health.revision == revision && losses == [.lateAttach]
                    && RelayGuardIdentityClassifier.combine(Array(combined)) == reservation.ticket.subject
                if !healthy { lose(.invalidTransition) }
                // A real NOTIFY_ALLOW confirms the execution edge. Its reserved
                // tag version is retained; uncertain authorization stays tainted.
                nodes[target]?.subjects.formUnion(combined)
                nodes[target]?.terminalOrigin = reservation.terminalOrigin || event.targetTerminalOrigin
                nodes[target]?.tagVersion = reservation.ticket.tagVersion
                nodes[target]?.executionTicket = reservation.ticket
                changed.insert(target)
                nodes[event.actor]?.successors.insert(target)
                nodes[target]?.predecessors.insert(event.actor)
                propagate(from: event.actor, changed: &changed)
                retire(event.actor, at: event.timestamp)
                settlements.append(.init(ticket: reservation.ticket, outcome: healthy ? .committed : .uncertain))
                return result()
            }
            guard ensure(target) else { return result() }
            if event.kind == .exec && (nodes[event.actor]?.subjects.isEmpty == false
                || (event.actorTerminalOrigin && [.nativeCLI, .officialScriptCLI].contains(event.targetSubject))) {
                // Late discovery may retain a positive identity, but it cannot
                // repair the missing pre-execution ACK for this occurrence.
                lose(.invalidTransition)
            }
            mark(target, subject: event.targetSubject, terminalOrigin: event.targetTerminalOrigin, changed: &changed)
            // Keep graph structure and label propagation in the same lock hold.
            // A later parent/root observation can fill an earlier missing edge.
            nodes[event.actor]?.successors.insert(target)
            nodes[target]?.predecessors.insert(event.actor)
            propagate(from: event.actor, changed: &changed)
            // Successful NOTIFY_EXEC ends the actor's old execution version.
            // The live new version remains its successor and prevents removal.
            if event.kind == .exec { retire(event.actor, at: event.timestamp) }
        case .exit:
            retire(event.actor, at: event.timestamp)
        }
        return result()
    }

    func executionAdmission(_ pointer: UnsafePointer<es_message_t>) -> (requiresHandoff: Bool, terminalOrigin: Bool) {
        let message = pointer.pointee
        guard message.version >= 4, message.event_type == ES_EVENT_TYPE_AUTH_EXEC,
              message.action_type == ES_ACTION_TYPE_AUTH,
              let actor = RelayGuardProcessGeneration(message.process.pointee.audit_token) else { return (false, false) }
        lock.lock()
        let claimed = claimedActor(actor), terminal = nodes[actor]?.terminalOrigin == true
        lock.unlock()
        if claimed { return (true, terminal) }
        guard let candidate = RelayGuardESObservation.boundedExecutionCandidate(pointer) else { return (false, false) }
        if candidate == .codexNative {
            // Independent Codex launches take the ordinary response path. Only
            // authenticated Terminal origin enters the deadline/DENY handoff.
            let origin = terminal || RelayGuardESObservation.hasAuthenticatedTerminalOrigin(message.process)
            return (origin, origin)
        }
        return (true, false)
    }

    /// Exactly one of this method or prepareExecution consumes each AUTH
    /// envelope. A deadline DENY before preparation uses unclaimed:false.
    func observeAuthorization(_ pointer: UnsafePointer<es_message_t>, unclaimed: Bool) -> RelayGuardLineageChange {
        let message = pointer.pointee
        lock.lock(); defer { lock.unlock() }
        let before = revision
        guard message.version >= 4, message.event_type == ES_EVENT_TYPE_AUTH_EXEC,
              message.action_type == ES_ACTION_TYPE_AUTH,
              let actor = RelayGuardProcessGeneration(message.process.pointee.audit_token) else {
            lose(.unsupportedMessage)
            return .init(changed: [], invalidateAll: before != revision)
        }
        observeSequence(version: message.version, type: message.event_type.rawValue,
            sequence: message.seq_num, global: message.global_seq_num, timestamp: message.mach_time)
        // A callback that fast-allowed before a queued preceding label became
        // visible cannot be retroactively described as a protected handoff.
        if unclaimed {
            let candidate = RelayGuardESObservation.boundedExecutionCandidate(pointer)
            let scopedCandidate = candidate == .claude || (candidate == .codexNative && nodes[actor]?.terminalOrigin == true)
            if claimedActor(actor) || scopedCandidate { lose(.invalidTransition) }
        }
        return .init(changed: [], invalidateAll: before != revision)
    }

    func prepareExecution(_ event: RelayGuardESObservation, expiresMach: UInt64) -> RelayGuardExecutionPreparation {
        lock.lock(); defer { lock.unlock() }
        let before = revision
        func result(_ ticket: RelayGuardExecutionTicket?, required: Bool) -> RelayGuardExecutionPreparation {
            .init(ticket: ticket, requiresHandoff: required,
                change: .init(changed: [], invalidateAll: before != revision))
        }
        observeSequence(version: event.messageVersion, type: event.rawEventType,
            sequence: event.sequence, global: event.globalSequence, timestamp: event.timestamp)
        guard event.phase == .authorization, event.kind == .exec,
              let target = event.target, let targetToken = event.targetToken,
              RelayGuardProcessGeneration(token: event.actorToken) == event.actor,
              RelayGuardProcessGeneration(token: targetToken) == target,
              target.pid == event.actor.pid, target.version != event.actor.version else {
            lose(.invalidTransition); return result(nil, required: true)
        }
        let origin = event.actorTerminalOrigin || nodes[event.actor]?.terminalOrigin == true
            || executions[event.actor]?.terminalOrigin == true
        var subjects = nodes[event.actor]?.subjects ?? []
        if let pendingActor = executions[event.actor] {
            // A speculative actor is never an ordinary unclaimed execution.
            guard pendingActor.allowed, !pendingActor.uncertain else { return result(nil, required: true) }
            subjects.formUnion(pendingActor.subjects)
        }
        for subject in [event.actorSubject, event.targetSubject] {
            switch subject {
            case .nativeCLI, .officialScriptCLI:
                if origin { subjects.insert(subject) }
            case .desktop, .desktopHelper, .unverifiedProtected: subjects.insert(subject)
            case .unresolved, .other: break
            }
        }
        guard !subjects.isEmpty else { return result(nil, required: origin && event.executionCandidate) }
        // The public post-exec FD list is only a subset. A witnessed socket
        // cannot be reattributed to the new execution by the handoff.
        guard !event.hasObservedInheritedSocket else { return result(nil, required: true) }
        guard losses == [.lateAttach], executions.count < 1024,
              expiresMach <= event.deadlineMach,
              RelayGuardExecutionClock.remainingNanoseconds(until: expiresMach) != nil,
              executions[target] == nil, nodes[target] == nil,
              nextTagVersion < 9_007_199_254_740_991, ensure(event.actor),
              nodes.count + executions.count < capacity else {
            if executions.count >= 1024 || nodes.count + executions.count >= capacity { lose(.capacity) }
            return result(nil, required: true)
        }
        let health = RelayGuardLineageHealth(epoch: epoch.uuidString.lowercased(), revision: revision,
            monitoring: true, knownRootsAvailable: true, globalCoverageReady: false,
            losses: losses.map(\.rawValue).sorted())
        let ticket = RelayGuardExecutionTicket(claimID: UUID().uuidString.lowercased(),
            actorToken: event.actorToken, targetToken: targetToken,
            subject: RelayGuardIdentityClassifier.combine(Array(subjects)), health: health,
            tagVersion: nextTagVersion, authSequence: event.sequence,
            authGlobalSequence: event.globalSequence, expiresMach: expiresMach)
        nextTagVersion += 1
        executions[target] = .init(ticket: ticket, subjects: subjects, terminalOrigin: origin || event.targetTerminalOrigin)
        return result(ticket, required: true)
    }

    func currentExecution(_ ticket: RelayGuardExecutionTicket) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return currentExecutionLocked(ticket)
    }

    func markExecutionAllowed(_ ticket: RelayGuardExecutionTicket) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let target = RelayGuardProcessGeneration(token: ticket.targetToken),
              var reservation = executions[target],
              reservation.ticket.matches(ticket), !reservation.allowed else { return false }
        reservation.allowed = true
        executions[target] = reservation
        return true
    }

    func abortExecution(_ ticket: RelayGuardExecutionTicket,
                        outcome: RelayGuardExecutionOutcome = .aborted) -> RelayGuardLineageChange {
        lock.lock(); defer { lock.unlock() }
        guard let target = RelayGuardProcessGeneration(token: ticket.targetToken),
              var reservation = executions[target], reservation.ticket.matches(ticket) else {
            return .init(changed: [], invalidateAll: false)
        }
        let actual: RelayGuardExecutionOutcome
        if outcome == .aborted && !reservation.allowed {
            removeExecution(target)
            actual = .aborted
        } else {
            reservation.uncertain = true
            executions[target] = reservation
            actual = .uncertain
        }
        return .init(changed: [], invalidateAll: false,
            executionSettlements: [.init(ticket: ticket, outcome: actual)])
    }

    private func currentExecutionLocked(_ ticket: RelayGuardExecutionTicket) -> Bool {
        guard ticket.health.epoch == epoch.uuidString.lowercased(), ticket.health.revision == revision,
              losses == [.lateAttach], let target = RelayGuardProcessGeneration(token: ticket.targetToken) else { return false }
        if let reservation = executions[target] {
            return reservation.ticket.matches(ticket) && !reservation.uncertain
                && RelayGuardExecutionClock.remainingNanoseconds(until: ticket.expiresMach) != nil
        }
        guard let node = nodes[target], node.tagVersion == ticket.tagVersion, !node.subjects.isEmpty,
              node.executionTicket?.matches(ticket) == true else { return false }
        return RelayGuardIdentityClassifier.combine(Array(node.subjects)) == ticket.subject
    }

    private func claimedActor(_ actor: RelayGuardProcessGeneration) -> Bool {
        nodes[actor]?.subjects.isEmpty == false || executions[actor] != nil
    }

    private func removeExecution(_ target: RelayGuardProcessGeneration) {
        guard let reservation = executions.removeValue(forKey: target),
              let actor = RelayGuardProcessGeneration(token: reservation.ticket.actorToken) else { return }
        enqueueRetirement(actor)
    }

    private func matches(_ event: RelayGuardESObservation, _ reservation: ExecutionReservation) -> Bool {
        event.actorToken == reservation.ticket.actorToken && event.targetToken == reservation.ticket.targetToken
    }

    private func observeSequence(version: UInt32, type: UInt32, sequence: UInt64, global: UInt64, timestamp: UInt64) {
        guard version >= 4 else { lose(.unsupportedMessage); return }
        latestTimestamp = max(latestTimestamp, timestamp)
        reapRetired()
        if let previous = globalSequence, previous == UInt64.max || global != previous + 1 { lose(.eventGap) }
        if let previous = sequences[type], previous == UInt64.max || sequence != previous + 1 { lose(.eventGap) }
        globalSequence = max(globalSequence ?? global, global)
        sequences[type] = max(sequences[type] ?? sequence, sequence)
    }

    func lookup(_ token: Data?) -> RelayGuardLineageLookup {
        lock.lock(); defer { lock.unlock() }
        return lookupLocked(token)
    }

    func hasTerminalOrigin(_ generation: RelayGuardProcessGeneration) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return nodes[generation]?.terminalOrigin == true
    }

    func snapshot(_ tokens: [Data]) -> (epoch: String, revision: UInt64, available: Bool,
                                      losses: [String], tags: [RelayGuardLineageTag?]) {
        lock.lock(); defer { lock.unlock() }
        return (epoch.uuidString.lowercased(), revision, losses == [.lateAttach], losses.map(\.rawValue).sorted(),
            tokens.map { token in
                if case let .protected(tag) = lookupLocked(token) { return tag }
                return nil
            })
    }

    func membershipSnapshot() -> (epoch: String, revision: UInt64, available: Bool,
                                  losses: [String], members: Set<RelayGuardProcessGeneration>) {
        lock.lock()
        let nodes = self.nodes, executions = self.executions
        let epoch = self.epoch, revision = self.revision, losses = self.losses
        lock.unlock()
        // Reservations are positive-only, even when an old Provider ACK was
        // sent but ES has yet to record the authorization outcome.
        var members = Set(executions.keys)
        for (key, node) in nodes where !node.subjects.isEmpty { members.insert(key) }
        return (epoch.uuidString.lowercased(), revision, losses == [.lateAttach], losses.map(\.rawValue).sorted(), members)
    }

    private func lookupLocked(_ token: Data?) -> RelayGuardLineageLookup {
        guard let key = RelayGuardProcessGeneration(token: token),
              let node = nodes[key], !node.subjects.isEmpty else { return .unknown(losses) }
        return .protected(.init(epoch: epoch, revision: revision, process: key,
            subject: RelayGuardIdentityClassifier.combine(Array(node.subjects)), tagVersion: node.tagVersion))
    }

    func current(_ tag: RelayGuardLineageTag) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard losses == [.lateAttach], tag.epoch == epoch, tag.revision == revision,
              let node = nodes[tag.process], !node.subjects.isEmpty,
              tag.tagVersion == node.tagVersion else { return false }
        return RelayGuardIdentityClassifier.combine(Array(node.subjects)) == tag.subject
    }

    private func ensure(_ key: RelayGuardProcessGeneration) -> Bool {
        if nodes[key] != nil { return true }
        guard nodes.count + executions.count < capacity else { lose(.capacity); return false }
        nodes[key] = Node()
        return true
    }

    private func mark(_ key: RelayGuardProcessGeneration, subject: RelayGuardSubject, terminalOrigin: Bool,
                      changed: inout Set<RelayGuardProcessGeneration>) {
        guard let node = nodes[key] else { return }
        var updated = false
        if terminalOrigin && !node.terminalOrigin {
            nodes[key]?.terminalOrigin = true
            updated = true
        }
        switch subject {
        case .nativeCLI, .officialScriptCLI:
            if !node.cliCandidates.contains(subject) {
                nodes[key]?.cliCandidates.insert(subject)
                updated = true
            }
        case .desktop, .desktopHelper, .unverifiedProtected:
            if !node.subjects.contains(subject) {
                guard bump(key, changed: &changed) else { return }
                nodes[key]?.subjects.insert(subject)
                updated = true
            }
        case .other, .unresolved: break
        }
        if updated { propagate(from: key, changed: &changed) }
    }

    private func propagate(from root: RelayGuardProcessGeneration,
                           changed: inout Set<RelayGuardProcessGeneration>) {
        var queue = [root]
        var offset = 0
        while offset < queue.count {
            let key = queue[offset]; offset += 1
            guard var node = nodes[key] else { continue }
            if node.terminalOrigin {
                let combined = node.subjects.union(node.cliCandidates)
                if combined != node.subjects {
                    guard bump(key, changed: &changed) else { continue }
                    nodes[key]?.subjects = combined
                    node.subjects = combined
                }
            }
            for child in node.successors {
                guard let old = nodes[child] else { continue }
                let combined = old.subjects.union(node.subjects)
                let inheritsOrigin = node.terminalOrigin && !old.terminalOrigin
                if inheritsOrigin { nodes[child]?.terminalOrigin = true }
                if combined != old.subjects {
                    guard bump(child, changed: &changed) else { continue }
                    nodes[child]?.subjects = combined
                }
                if inheritsOrigin || combined != old.subjects { queue.append(child) }
            }
        }
    }

    private func bump(_ key: RelayGuardProcessGeneration,
                      changed: inout Set<RelayGuardProcessGeneration>) -> Bool {
        guard nextTagVersion < 9_007_199_254_740_991 else { lose(.capacity); return false }
        nodes[key]?.tagVersion = nextTagVersion; nextTagVersion += 1
        changed.insert(key)
        return true
    }

    private func lose(_ reason: RelayGuardLineageLoss) {
        if losses.insert(reason).inserted, revision < 9_007_199_254_740_991 { revision += 1 }
    }

    private func retire(_ key: RelayGuardProcessGeneration, at timestamp: UInt64) {
        guard nodes[key] != nil else { return }
        if nodes[key]?.retiredAt == nil { nodes[key]?.retiredAt = timestamp }
        enqueueRetirement(key)
    }

    private func enqueueRetirement(_ key: RelayGuardProcessGeneration) {
        guard let node = nodes[key], node.subjects.isEmpty, !node.retirementQueued,
              let timestamp = node.retiredAt else { return }
        nodes[key]?.retirementQueued = true
        retirements.append(.init(key: key, timestamp: timestamp))
        var index = retirements.count - 1
        while index > 0 {
            let parent = (index - 1) / 2
            guard retirements[index].timestamp < retirements[parent].timestamp else { break }
            retirements.swapAt(index, parent); index = parent
        }
    }

    private func popRetirement() -> Retirement? {
        guard !retirements.isEmpty else { return nil }
        if retirements.count == 1 { return retirements.removeLast() }
        let first = retirements[0]
        let replacement = retirements.removeLast()
        retirements[0] = replacement
        var index = 0
        while index * 2 + 1 < retirements.count {
            let left = index * 2 + 1, right = left + 1
            let child = right < retirements.count && retirements[right].timestamp < retirements[left].timestamp ? right : left
            guard retirements[child].timestamp < retirements[index].timestamp else { break }
            retirements.swapAt(index, child); index = child
        }
        return first
    }

    private func reapRetired() {
        guard latestTimestamp > graceTicks else { return }
        let cutoff = latestTimestamp - graceTicks
        var budget = 256
        while budget > 0, let next = retirements.first, next.timestamp < cutoff {
            budget -= 1
            guard let candidate = popRetirement(), var node = nodes[candidate.key] else { continue }
            node.retirementQueued = false; nodes[candidate.key] = node
            // Neutral Terminal origins and unscoped candidates remain eligible
            // for leaf retirement. Positive membership is never forgotten.
            // Keep ordinary ancestors
            // while any live or not-yet-propagated successor can still need it.
            guard node.subjects.isEmpty, node.successors.isEmpty,
                  !executions.values.contains(where: {
                      RelayGuardProcessGeneration(token: $0.ticket.actorToken) == candidate.key
                  }),
                  node.retiredAt == candidate.timestamp else { continue }
            nodes.removeValue(forKey: candidate.key)
            for parent in node.predecessors {
                nodes[parent]?.successors.remove(candidate.key)
                enqueueRetirement(parent)
            }
        }
    }
}
