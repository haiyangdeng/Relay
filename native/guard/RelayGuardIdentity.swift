import Foundation
import Security
import Darwin

struct RelayGuardAuditIdentityEnvironment {
    // Test observations are injected here; the production path always obtains
    // signing metadata and dynamic validity from the exact audit-token guest.
    var read: (Data) -> RelayGuardSigningObservation?
    static var live: RelayGuardAuditIdentityEnvironment { .init(read: RelayGuardAuditIdentity.read) }
}

enum RelayGuardAuditIdentity {
    static func resolve(_ token: Data?, environment: RelayGuardAuditIdentityEnvironment = .live,
                        includeUnscopedCLI: Bool = true) -> RelayGuardSubject {
        guard let token, token.count == MemoryLayout<audit_token_t>.size,
              let observation = environment.read(token) else { return .unresolved }
        if !includeUnscopedCLI, isCLIFamily(observation) { return .other }
        return RelayGuardIdentityClassifier.classify(observation)
    }

    /// ES admits only authenticated native CLI roots. Desktop identity and its
    /// existing conservative taint continue through the normal classifier.
    static func resolveForLineage(_ token: Data?) -> (subject: RelayGuardSubject, terminal: Bool) {
        guard let token, let identity = readIdentity(token, identifyTerminal: true) else { return (.unresolved, false) }
        let subject = RelayGuardIdentityClassifier.classify(identity.observation)
        if isCLIFamily(identity.observation), subject != .nativeCLI { return (.other, identity.terminal) }
        return (subject, identity.terminal)
    }

    private static func isCLIFamily(_ observation: RelayGuardSigningObservation) -> Bool {
        guard let identifier = observation.identifier else { return false }
        let expected = RelayGuardIdentityClassifier.nativeCLISigningID
        return identifier == expected || identifier.hasPrefix(expected + ".")
            || RelayGuardIdentityClassifier.isNativeCLI(identifier: identifier, team: observation.team)
    }

    /// Read-only process inspection. No PID, command-line, pathname or raw token
    /// is returned or logged, and signature validation never uses the network.
    static func read(_ token: Data) -> RelayGuardSigningObservation? {
        readIdentity(token, identifyTerminal: false)?.observation
    }

    private static func readIdentity(_ token: Data, identifyTerminal: Bool) -> (observation: RelayGuardSigningObservation, terminal: Bool)? {
        guard token.count == MemoryLayout<audit_token_t>.size else { return nil }
        var code: SecCode?
        let attributes = [kSecGuestAttributeAudit as String: token] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
              let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
              let staticCode else { return nil }
        var copied: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess,
              let values = copied as? [String: Any] else { return nil }
        let identifier = values[kSecCodeInfoIdentifier as String] as? String
        let team = values[kSecCodeInfoTeamIdentifier as String] as? String
        let flags = SecCSFlags.noNetworkAccess
        var valid = SecCodeCheckValidity(code, flags, nil) == errSecSuccess
        if let team, team == RelayGuardIdentityClassifier.teamID || team == RelayGuardIdentityClassifier.codexTeamID {
            var requirement: SecRequirement?
            let expression = "anchor apple generic and certificate leaf[subject.OU] = \"" + team + "\""
            guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
                  let requirement else { return nil }
            // Strings alone never establish the protected signing identity.
            valid = valid && SecCodeCheckValidity(code, flags, requirement) == errSecSuccess
        }
        var terminal = false
        if identifyTerminal, identifier == "com.apple.Terminal", valid {
            var requirement: SecRequirement?
            let expression = "anchor apple and identifier \"com.apple.Terminal\""
            if SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
               let requirement {
                terminal = SecCodeCheckValidity(code, flags, requirement) == errSecSuccess
            }
        }
        return (RelayGuardSigningObservation(identifier: identifier, team: team, valid: valid), terminal)
    }
}
