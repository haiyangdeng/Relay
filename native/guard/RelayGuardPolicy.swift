import Foundation
import Darwin

/// Pure data only. These observations must come from an independently verified
/// audit-token reader; constructing one does not establish a process identity.
struct RelayGuardSigningObservation {
    let identifier: String?
    let team: String?
    let valid: Bool?

    init(identifier: String?, team: String?, valid: Bool?) {
        self.identifier = identifier
        self.team = team
        self.valid = valid
    }
}

enum RelayGuardSubject: String {
    case desktop, desktopHelper, nativeCLI, officialScriptCLI, unverifiedProtected, unresolved, other
}

enum RelayGuardIdentityClassifier {
    static let teamID = "Q6L2SF6YDW"
    static let desktopSigningID = "com.anthropic.claudefordesktop"
    static let desktopHelperSigningID = "com.anthropic.claudefordesktop.helper"
    static let nativeCLISigningID = "com.anthropic.claude-code"
    static let codexTeamID = "2DC432GLL2"
    static let codexDesktopSigningID = "com.openai.codex"
    static let codexCLISigningID = "codex"
    static let nativeCLIIdentities = [
        (identifier: nativeCLISigningID, team: teamID),
        (identifier: codexCLISigningID, team: codexTeamID)
    ]

    static func isNativeCLI(identifier: String?, team: String?) -> Bool {
        nativeCLIIdentities.contains { $0.identifier == identifier && $0.team == team }
    }

    static func classify(_ observation: RelayGuardSigningObservation) -> RelayGuardSubject {
        guard let identifier = observation.identifier, !identifier.isEmpty else { return .unresolved }
        let expected: (subject: RelayGuardSubject, team: String)?
        switch identifier {
        case desktopSigningID: expected = (.desktop, teamID)
        case desktopHelperSigningID: expected = (.desktopHelper, teamID)
        case nativeCLISigningID: expected = (.nativeCLI, teamID)
        case codexDesktopSigningID: expected = (.desktop, codexTeamID)
        case "com.openai.codex.helper", "com.openai.codex.helper.renderer", "com.openai.codex.framework.AlertNotificationService":
            expected = (.desktopHelper, codexTeamID)
        // The executable signing identifier is a generic name. Only this
        // exact publisher pair is a Codex CLI candidate.
        case codexCLISigningID where observation.team == codexTeamID:
            expected = (.nativeCLI, codexTeamID)
        default: expected = nil
        }
        if let expected {
            return observation.team == expected.team && observation.valid == true ? expected.subject : .unverifiedProtected
        }
        // A new Helper or CLI identifier is not automatically trusted because
        // its name shares a prefix with a previously observed official binary.
        if identifier.hasPrefix(desktopSigningID + ".") || identifier.hasPrefix(nativeCLISigningID + ".") {
            return .unverifiedProtected
        }
        // Codex shares its publisher with other products. Scope unknown
        // helpers to the pinned publisher and the dotted Codex namespace.
        if observation.team == codexTeamID && identifier.hasPrefix(codexDesktopSigningID + ".") {
            return .unverifiedProtected
        }
        guard let team = observation.team,
              !team.isEmpty, team == team.trimmingCharacters(in: .whitespacesAndNewlines),
              identifier == identifier.trimmingCharacters(in: .whitespacesAndNewlines),
              observation.valid == true else { return .unresolved }
        return .other
    }

    static func combine(_ subjects: [RelayGuardSubject]) -> RelayGuardSubject {
        // Invalid protected identities dominate. A verified responsible app or
        // process then establishes the protected scope even if its peer token
        // is missing. A known other app can never erase an unresolved token.
        for subject in [RelayGuardSubject.unverifiedProtected, .desktop, .desktopHelper, .nativeCLI, .officialScriptCLI, .unresolved] {
            if subjects.contains(subject) { return subject }
        }
        return subjects.isEmpty ? .unresolved : .other
    }
}

struct RelayGuardEndpoint: Hashable {
    let host: String
    let port: Int

    init(host: String, port: Int) {
        self.host = host
        self.port = port
    }
}

struct RelayGuardFlow {
    let subject: RelayGuardSubject
    let outbound: Bool
    let tcp: Bool
    let host: String?
    let port: Int?

    init(subject: RelayGuardSubject, outbound: Bool, tcp: Bool, host: String?, port: Int?) {
        self.subject = subject
        self.outbound = outbound
        self.tcp = tcp
        self.host = host
        self.port = port
    }
}

enum RelayGuardVerdict: String {
    case allow, drop
}

/// Isolated policy input, not a live authorization or listener-ownership check.
/// No approved endpoints is the default. A claimed flow with unresolved
/// identity still fails closed. The Provider admits unrelated flows before
/// applying this policy to its protected candidates.
struct RelayGuardPolicy {
    private let approvedProxyEndpoints: Set<RelayGuardEndpoint>

    init(approvedProxyEndpoints: Set<RelayGuardEndpoint> = []) {
        self.approvedProxyEndpoints = Set(approvedProxyEndpoints.compactMap(Self.proxyEndpoint))
    }

    func decide(_ flow: RelayGuardFlow) -> RelayGuardVerdict {
        switch flow.subject {
        // Verified other programs are outside this policy in both directions.
        case .other: return .allow
        case .unresolved, .unverifiedProtected: return .drop
        case .desktop, .desktopHelper, .nativeCLI, .officialScriptCLI:
            // No implicit OAuth, LAN, or arbitrary localhost exception.
            guard flow.outbound, flow.tcp, let host = flow.host, let port = flow.port,
                  let endpoint = Self.proxyEndpoint(.init(host: host, port: port)),
                  approvedProxyEndpoints.contains(endpoint) else { return .drop }
            return .allow
        }
    }

    private static func proxyEndpoint(_ endpoint: RelayGuardEndpoint) -> RelayGuardEndpoint? {
        guard endpoint.port == 17890 || endpoint.port == 17891 else { return nil }
        if endpoint.host == "127.0.0.1" {
            return .init(host: "127.0.0.1", port: endpoint.port)
        }
        // Darwin's parser also accepts some scoped or noncanonical strings.
        // Reject those before parsing so no hostname, scope, or NUL suffix can
        // acquire a literal-listener exception through parser normalization.
        guard endpoint.host.utf8.count <= 45, endpoint.host.contains(":"),
              endpoint.host.utf8.allSatisfy({
                  (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) || $0 == 58 || $0 == 46
              }) else { return nil }
        if endpoint.host.contains("."), endpoint.host.split(separator: ":").last != "127.0.0.1" { return nil }
        var v6 = in6_addr()
        guard inet_pton(AF_INET6, endpoint.host, &v6) == 1 else { return nil }
        let bytes = withUnsafeBytes(of: &v6) { Array($0) }
        if bytes == Array(repeating: 0, count: 15) + [1] {
            return .init(host: "::1", port: endpoint.port)
        }
        if bytes == Array(repeating: 0, count: 10) + [255, 255, 127, 0, 0, 1] {
            // IPv4-mapped IPv6 denotes the same IPv4 listener, not ::1.
            return .init(host: "127.0.0.1", port: endpoint.port)
        }
        return nil
    }
}
