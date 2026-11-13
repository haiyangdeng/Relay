import Darwin
import Foundation

/// Kernel process-execution identity. An exec changes the version even when
/// the PID is unchanged; credentials and executable names are not this key.
struct RelayGuardProcessGeneration: Hashable, Sendable {
    let pid: Int32
    let version: UInt32

    init?(pid: Int32, version: UInt32) {
        guard pid > 0 else { return nil }
        self.pid = pid
        self.version = version
    }

    init?(_ token: audit_token_t) {
        let pid = RelayGuardAuditPID(token)
        guard pid > 0 else { return nil }
        self.pid = pid
        version = RelayGuardAuditVersion(token)
    }

    init?(token data: Data?) {
        guard let data, data.count == MemoryLayout<audit_token_t>.size else { return nil }
        var token = audit_token_t()
        _ = withUnsafeMutableBytes(of: &token) { destination in
            data.copyBytes(to: destination)
        }
        self.init(token)
    }
}

struct RelayGuardLineageTag {
    let epoch: UUID
    let revision: UInt64
    let process: RelayGuardProcessGeneration
    let subject: RelayGuardSubject
    let tagVersion: UInt64
}

enum RelayGuardLineageLoss: String, Hashable, Sendable {
    case lateAttach, unsupportedMessage, eventGap, invalidTransition, capacity, disconnected, queueOverflow
}

struct RelayGuardLineageChange: Sendable {
    let changed: Set<RelayGuardProcessGeneration>
    let invalidateAll: Bool
    let executionSettlements: [RelayGuardExecutionSettlement]

    init(changed: Set<RelayGuardProcessGeneration>, invalidateAll: Bool,
         executionSettlements: [RelayGuardExecutionSettlement] = []) {
        self.changed = changed
        self.invalidateAll = invalidateAll
        self.executionSettlements = executionSettlements
    }
}

struct RelayGuardExecutionSettlement: Sendable {
    let ticket: RelayGuardExecutionTicket
    let outcome: RelayGuardExecutionOutcome
}

struct RelayGuardExecutionPreparation: Sendable {
    let ticket: RelayGuardExecutionTicket?
    let requiresHandoff: Bool
    let change: RelayGuardLineageChange
}

/// Unknown is evidence about attribution, not an allow/drop network verdict.
/// In particular, a generic interpreter never becomes protected by its name.
enum RelayGuardLineageLookup {
    case protected(RelayGuardLineageTag)
    case unknown(Set<RelayGuardLineageLoss>)
}
