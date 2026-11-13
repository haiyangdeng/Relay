import Foundation

/// Connects transaction events to the complete, typed recovery journal. It does
/// not obtain privilege or create a network effect. Realization/observation must
/// come from the trusted live adapter, never renderer JSON or status booleans.
final class RelayTunTransactionJournal {
    enum Failure: Error { case invalid, busy, conflict, uncertain }
    private typealias Transaction = RelayTunNetworkTransaction
    private typealias Journal = RelayTunNetworkJournal
    private typealias Effects = RelayTunNetworkEffects
    private let plan: Transaction.Plan
    private let binding: Journal.Binding
    private let writer: Journal.Writer
    private let realize: (Transaction.Device) throws -> Effects.EffectSet
    private let verifyRealization: (Transaction.Plan, Effects.EffectSet) throws -> Void
    private let observeRestoration: (Transaction.Device) throws -> Journal.Observation
    private let observeUnacquiredRestoration: (() throws -> Journal.Observation)?
    private var effects: Effects.EffectSet?
    private let lock = NSRecursiveLock()
    private var recording = false

    init(plan: RelayTunNetworkTransaction.Plan, installationRevision: String, clientUID: UInt32,
         storage: RelayTunNetworkJournal.Storage,
         realize: @escaping (RelayTunNetworkTransaction.Device) throws -> RelayTunNetworkEffects.EffectSet,
         verifyRealization: @escaping (RelayTunNetworkTransaction.Plan, RelayTunNetworkEffects.EffectSet) throws -> Void,
         observeRestoration: @escaping (RelayTunNetworkTransaction.Device) throws -> RelayTunNetworkJournal.Observation,
         observeUnacquiredRestoration: (() throws -> RelayTunNetworkJournal.Observation)? = nil) throws {
        self.plan = plan; binding = try .init(installationRevision: installationRevision, clientUID: clientUID, plan: plan)
        writer = Journal.Writer(binding: binding, storage: storage)
        self.realize = realize; self.verifyRealization = verifyRealization; self.observeRestoration = observeRestoration; self.observeUnacquiredRestoration = observeUnacquiredRestoration
        if let previous = try writer.open(), let realized = previous.realizedEffects {
            // Loading durable data does not adopt its old FD/interface or prove
            // an active session. A later recovery coordinator must re-observe it.
            guard realized.planID == plan.id else { throw Failure.invalid }
            try verifyRealization(plan, realized)
            effects = realized
        }
    }

    func record(_ event: RelayTunNetworkTransaction.Event) throws {
        guard lock.try() else { throw Failure.busy }
        guard !recording else { lock.unlock(); throw Failure.busy }
        recording = true; defer { recording = false; lock.unlock() }
        guard event.plan == plan, let phase = Journal.Phase(rawValue: event.phase) else { throw Failure.invalid }
        let previous = writer.lastConfirmed
        guard previous == nil || previous!.sequence < UInt32.max else { throw Failure.invalid }
        let sequence = previous.map { $0.sequence + 1 } ?? 0

        if phase == .createIntent {
            guard previous == nil, event.device == nil, event.changes.isEmpty, effects == nil else { throw Failure.invalid }
        } else if phase == .acquisitionAborted {
            guard previous?.phase == .createIntent, event.device == nil, event.changes.isEmpty, effects == nil else { throw Failure.invalid }
        } else {
            guard previous != nil, let owned = event.device else { throw Failure.invalid }
            if effects == nil {
                guard phase == .acquired else { throw Failure.invalid }
                let realized = try realize(owned)
                guard realized.planID == plan.id, realized.device.id == owned.id,
                      realized.device.interface.name == owned.interface else { throw Failure.invalid }
                // The approved projection digest differs from a realized digest
                // when an interface is allocated. This mandatory verifier must
                // establish that mapping; matching plan IDs alone is not proof.
                try verifyRealization(plan, realized)
                effects = realized
            }
            guard let effects, effects.device.id == owned.id,
                  effects.device.interface.name == owned.interface else { throw Failure.invalid }
            for change in event.changes { _ = try effects.effect(for: change) }
        }

        let observation: Journal.Observation?
        if phase == .acquisitionAborted {
            guard let observeUnacquiredRestoration else { throw Failure.invalid }
            observation = try observeUnacquiredRestoration()
        } else if phase == .restored || phase == .closedExternalChange {
            guard let owned = event.device else { throw Failure.invalid }
            observation = try observeRestoration(owned)
        } else { observation = nil }
        let snapshot = try Journal.Snapshot(binding: binding, sequence: sequence, phase: phase,
                                             realizedEffects: effects, pendingIDs: event.changes.map(\.id), observation: observation)
        switch try writer.record(snapshot) {
        case .confirmed: return
        case .conflict: throw Failure.conflict
        case .uncertain: throw Failure.uncertain
        }
    }
}
