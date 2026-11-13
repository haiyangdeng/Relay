import Foundation
import Darwin

func runRelayGuardIdentitySelfTests() -> Int32 {
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    let token = Data(repeating: 0, count: MemoryLayout<audit_token_t>.size)
    var reads = 0
    var observation: RelayGuardSigningObservation? = .init(identifier: RelayGuardIdentityClassifier.desktopSigningID,
        team: RelayGuardIdentityClassifier.teamID, valid: true)
    let environment = RelayGuardAuditIdentityEnvironment(read: { received in
        reads += 1
        check(received == token, "reader receives only the supplied fixture token")
        return observation
    })
    func resolve() -> RelayGuardSubject { RelayGuardAuditIdentity.resolve(token, environment: environment) }
    check(RelayGuardAuditIdentity.resolve(nil, environment: environment) == .unresolved, "absent token is unresolved")
    for length in [0, 1, token.count - 1, token.count + 1, 4096] {
        check(RelayGuardAuditIdentity.resolve(Data(repeating: 0, count: length), environment: environment) == .unresolved,
            "invalid token size is unresolved")
    }
    check(reads == 0, "malformed tokens never reach a signature reader")
    check(resolve() == .desktop, "verified desktop observation classified")
    observation = .init(identifier: RelayGuardIdentityClassifier.desktopHelperSigningID,
        team: RelayGuardIdentityClassifier.teamID, valid: true)
    check(resolve() == .desktopHelper, "verified helper observation classified")
    observation = .init(identifier: RelayGuardIdentityClassifier.nativeCLISigningID,
        team: RelayGuardIdentityClassifier.teamID, valid: true)
    check(resolve() == .nativeCLI, "verified native CLI observation classified")
    observation = .init(identifier: RelayGuardIdentityClassifier.nativeCLISigningID,
        team: RelayGuardIdentityClassifier.teamID, valid: false)
    check(resolve() == .unverifiedProtected, "known identity with invalid dynamic signature is not trusted")
    observation = .init(identifier: RelayGuardIdentityClassifier.desktopSigningID,
        team: "OTHERTEAM", valid: true)
    check(resolve() == .unverifiedProtected, "valid signature from another team cannot impersonate desktop")
    observation = .init(identifier: nil, team: nil, valid: nil)
    check(resolve() == .unresolved, "missing metadata cannot establish identity")
    observation = nil
    check(resolve() == .unresolved, "signature reader failure is unresolved")
    observation = .init(identifier: "node", team: "HX7739G8FX", valid: true)
    check(resolve() == .other, "ordinary verified Node is not misidentified as Claude CLI")
    check(reads == 8, "all valid-size fixture calls use only the injected reader")
    print(failures.isEmpty ? "PASS: \(count) audit identity checks; injected signing observations only, no process or network inspection." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
