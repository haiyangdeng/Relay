import Darwin
import EndpointSecurity
import Foundation

/// Projection while the monitor still owns the retained ES message.
/// No argv/env/script contents, paths or payloads are retained. Full kernel
/// tokens stay only in the bounded execution-reservation protocol.
struct RelayGuardESObservation {
    enum Kind: UInt32 { case exec = 1, fork = 2, exit = 3 }
    enum Phase { case authorization, notification }
    let kind: Kind
    let phase: Phase
    let rawEventType: UInt32
    let executionAllowed: Bool?
    let executionCandidate: Bool
    let hasObservedInheritedSocket: Bool
    let messageVersion: UInt32
    let sequence: UInt64
    let globalSequence: UInt64
    let timestamp: UInt64
    let deadlineMach: UInt64
    let actor: RelayGuardProcessGeneration
    let target: RelayGuardProcessGeneration?
    let actorSubject: RelayGuardSubject
    let targetSubject: RelayGuardSubject
    let actorTerminalOrigin: Bool
    let targetTerminalOrigin: Bool
    let actorToken: Data
    let targetToken: Data?

    static func project(_ pointer: UnsafePointer<es_message_t>,
                        hasTerminalOrigin: (RelayGuardProcessGeneration) -> Bool = { _ in false },
                        observedTerminalOrigin: Bool = false,
                        verifyNativeTarget: (UnsafePointer<es_message_t>) -> Bool = { _ in false }) -> Self? {
        let message = pointer.pointee
        guard message.version >= 4,
              let actor = RelayGuardProcessGeneration(message.process.pointee.audit_token) else { return nil }
        let kind: Kind
        let phase: Phase
        let executionAllowed: Bool?
        let targetProcess: UnsafePointer<es_process_t>?
        switch message.event_type {
        case ES_EVENT_TYPE_AUTH_EXEC:
            guard message.action_type == ES_ACTION_TYPE_AUTH else { return nil }
            kind = .exec; phase = .authorization; executionAllowed = nil
            targetProcess = UnsafePointer(message.event.exec.target)
        case ES_EVENT_TYPE_NOTIFY_EXEC:
            guard message.action_type == ES_ACTION_TYPE_NOTIFY,
                  message.action.notify.result_type == ES_RESULT_TYPE_AUTH else { return nil }
            kind = .exec; phase = .notification
            executionAllowed = message.action.notify.result.auth == ES_AUTH_RESULT_ALLOW
            targetProcess = UnsafePointer(message.event.exec.target)
        case ES_EVENT_TYPE_NOTIFY_FORK:
            guard message.action_type == ES_ACTION_TYPE_NOTIFY else { return nil }
            kind = .fork; phase = .notification; executionAllowed = nil
            targetProcess = UnsafePointer(message.event.fork.child)
        case ES_EVENT_TYPE_NOTIFY_EXIT:
            guard message.action_type == ES_ACTION_TYPE_NOTIFY else { return nil }
            kind = .exit; phase = .notification; executionAllowed = nil; targetProcess = nil
        default: return nil
        }
        func identity(_ process: UnsafePointer<es_process_t>) -> (subject: RelayGuardSubject, terminal: Bool) {
            var token = process.pointee.audit_token
            return withUnsafeBytes(of: &token) {
                RelayGuardAuditIdentity.resolveForLineage(Data($0))
            }
        }
        let actorIdentity = identity(message.process)
        // An AUTH target is a future execution. Dynamic guest lookup is not
        // evidence that its shadow image is already the visible PID-table guest.
        let targetIdentity = phase == .notification && executionAllowed != false ? targetProcess.map(identity) : nil
        let actorTerminalOrigin = observedTerminalOrigin || actorIdentity.terminal || hasTerminalOrigin(actor)
            || hasAuthenticatedTerminalRelationship(message.process)
        var targetSubject = targetIdentity?.subject ?? .unresolved
        if phase == .authorization, actorTerminalOrigin, verifyNativeTarget(pointer) {
            targetSubject = .nativeCLI
        }
        if kind == .exec, executionAllowed != false, actorTerminalOrigin,
           RelayGuardOfficialScript.matches(message.event.exec.script.map { UnsafePointer($0) }) {
            targetSubject = .officialScriptCLI
        }
        return Self(kind: kind, phase: phase, rawEventType: message.event_type.rawValue,
            executionAllowed: executionAllowed, executionCandidate: boundedExecutionCandidate(pointer) != nil,
            hasObservedInheritedSocket: phase == .authorization && observedSocketInExecSnapshot(pointer),
            messageVersion: message.version,
            sequence: message.seq_num, globalSequence: message.global_seq_num, timestamp: message.mach_time,
            deadlineMach: phase == .authorization ? message.deadline : 0,
            actor: actor, target: targetProcess.flatMap { RelayGuardProcessGeneration($0.pointee.audit_token) },
            actorSubject: actorIdentity.subject, targetSubject: targetSubject,
            actorTerminalOrigin: actorTerminalOrigin, targetTerminalOrigin: targetIdentity?.terminal ?? false,
            actorToken: tokenBytes(message.process.pointee.audit_token),
            targetToken: targetProcess.map { tokenBytes($0.pointee.audit_token) })
    }

    /// Inspect only the descriptor descriptions supplied by the retained AUTH
    /// event. A missing socket in this subset does not establish its absence.
    private static func observedSocketInExecSnapshot(_ message: UnsafePointer<es_message_t>) -> Bool {
        guard let eventOffset = MemoryLayout<es_message_t>.offset(of: \.event) else { return false }
        // A C union member begins at the union address. Keep the accessor's
        // input within the original retained message, as with &msg->event.exec.
        let exec = UnsafeRawPointer(message).advanced(by: eventOffset).assumingMemoryBound(to: es_event_exec_t.self)
        let count = es_exec_fd_count(exec)
        for index in 0..<count {
            if es_exec_fd(exec, index).pointee.fdtype == UInt32(PROX_FDTYPE_SOCKET) { return true }
        }
        return false
    }

    static func tokenBytes(_ value: audit_token_t) -> Data {
        var token = value
        return withUnsafeBytes(of: &token) { Data($0) }
    }

    enum ExecutionCandidate: Equatable { case claude, codexNative }

    /// A bounded metadata hint only. The execution image is verified after
    /// the monitor decides that the source requires a handoff.
    static func boundedExecutionCandidate(_ pointer: UnsafePointer<es_message_t>) -> ExecutionCandidate? {
        let message = pointer.pointee
        guard message.version >= 4, message.event_type == ES_EVENT_TYPE_AUTH_EXEC,
              message.action_type == ES_ACTION_TYPE_AUTH else { return nil }
        let target = message.event.exec.target.pointee
        let identifier = boundedString(target.signing_id, maximum: 256)
        let team = boundedString(target.team_id, maximum: 32)
        if RelayGuardIdentityClassifier.isNativeCLI(identifier: identifier, team: team) {
            return identifier == RelayGuardIdentityClassifier.codexCLISigningID ? .codexNative : .claude
        }
        guard let script = message.event.exec.script?.pointee,
              script.stat.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              script.stat.st_size == 13_468_528, !script.path_truncated,
              let path = boundedString(script.path, maximum: 16_384), path.hasPrefix("/"),
              !path.contains("//") else { return nil }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains("."), !components.contains("..") else { return nil }
        return path.hasSuffix("/node_modules/@anthropic-ai/claude-code/cli.js") ? .claude : nil
    }

    private static func boundedString(_ token: es_string_token_t, maximum: Int) -> String? {
        guard token.length > 0, token.length <= maximum, let data = token.data else { return nil }
        let bytes = UnsafeBufferPointer(start: data, count: token.length)
        guard !bytes.contains(0) else { return nil }
        return String(bytes: bytes.map { UInt8(bitPattern: $0) }, encoding: .utf8)
    }

    static func hasAuthenticatedTerminalOrigin(_ process: UnsafePointer<es_process_t>) -> Bool {
        let actor = process.pointee
        if boundedString(actor.signing_id, maximum: 256) == "com.apple.Terminal",
           RelayGuardAuditIdentity.resolveForLineage(tokenBytes(actor.audit_token)).terminal { return true }
        return hasAuthenticatedTerminalRelationship(process)
    }

    /// A late-attached shell can retain a kernel relationship to the still-live
    /// Terminal even when its original fork was not observed. This grants only
    /// neutral origin; a separately authenticated CLI candidate is still needed.
    private static func hasAuthenticatedTerminalRelationship(_ process: UnsafePointer<es_process_t>) -> Bool {
        let snapshot = process.pointee
        var actorToken = snapshot.audit_token
        var seen = Set([withUnsafeBytes(of: &actorToken) { Data($0) }])
        for var token in [snapshot.responsible_audit_token, snapshot.parent_audit_token] {
            guard RelayGuardProcessGeneration(token) != nil else { continue }
            let bytes = withUnsafeBytes(of: &token) { Data($0) }
            // The exact actor token has already been inspected above. Parent
            // and responsible may also be the same full kernel token.
            guard seen.insert(bytes).inserted else { continue }
            if RelayGuardAuditIdentity.resolveForLineage(bytes).terminal { return true }
        }
        // Exited, stale or unverifiable references provide no positive origin.
        return false
    }
}

extension RelayGuardKnownLineage {
    func prepareExecution(_ message: UnsafePointer<es_message_t>, expiresMach: UInt64,
                          observedTerminalOrigin: Bool,
                          verifyNativeTarget: (UnsafePointer<es_message_t>) -> Bool) -> RelayGuardExecutionPreparation {
        guard let observation = RelayGuardESObservation.project(message,
                hasTerminalOrigin: { self.hasTerminalOrigin($0) }, observedTerminalOrigin: observedTerminalOrigin,
                verifyNativeTarget: verifyNativeTarget),
              observation.phase == .authorization else {
            return .init(ticket: nil, requiresHandoff: true, change: failed(.unsupportedMessage))
        }
        return prepareExecution(observation, expiresMach: expiresMach)
    }

    func finishExecution(_ message: UnsafePointer<es_message_t>) -> RelayGuardLineageChange {
        consumeMessage(message)
    }

    func consumeMessage(_ message: UnsafePointer<es_message_t>) -> RelayGuardLineageChange {
        guard let observation = RelayGuardESObservation.project(message, hasTerminalOrigin: { self.hasTerminalOrigin($0) }) else {
            return failed(.unsupportedMessage)
        }
        return consume(observation)
    }
}
