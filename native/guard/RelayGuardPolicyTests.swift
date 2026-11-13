import Foundation

/// Pure fixtures: no process inspection, sockets, system changes, or live grant.
func runRelayGuardPolicySelfTests() -> Int32 {
    var checks = 0
    var failures: [String] = []
    func check(_ value: Bool, _ name: String) {
        checks += 1
        if !value { failures.append(name) }
    }
    let identities: [(String, RelayGuardSubject)] = [
        (RelayGuardIdentityClassifier.desktopSigningID, .desktop),
        (RelayGuardIdentityClassifier.desktopHelperSigningID, .desktopHelper),
        (RelayGuardIdentityClassifier.nativeCLISigningID, .nativeCLI)
    ]
    for (identifier, expected) in identities {
        check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: RelayGuardIdentityClassifier.teamID, valid: true)) == expected, "exact official identity " + identifier)
        for team in [nil, "", "OTHERTEAM", " " + RelayGuardIdentityClassifier.teamID] as [String?] {
            check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: team, valid: true)) == .unverifiedProtected, "known identity rejects team " + identifier)
        }
        for valid in [false, nil] as [Bool?] {
            check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: RelayGuardIdentityClassifier.teamID, valid: valid)) == .unverifiedProtected, "known identity requires validity " + identifier)
        }
    }
    for identifier in ["com.anthropic.claudefordesktop.helper.GPU", "com.anthropic.claudefordesktop.unknown", "com.anthropic.claude-code.helper"] {
        check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: RelayGuardIdentityClassifier.teamID, valid: true)) == .unverifiedProtected, "unapproved protected identifier " + identifier)
    }
    let unlistedCodexHelper = RelayGuardIdentityClassifier.codexDesktopSigningID + ".helper.future"
    let codexTeam = RelayGuardIdentityClassifier.codexTeamID
    for valid in [true, false, nil] as [Bool?] {
        check(RelayGuardIdentityClassifier.classify(.init(identifier: unlistedCodexHelper, team: codexTeam, valid: valid)) == .unverifiedProtected,
              "unlisted Codex helper cannot gain trust from its publisher alone")
    }
    check(RelayGuardIdentityClassifier.classify(.init(identifier: unlistedCodexHelper, team: "OTHERTEAM", valid: true)) == .other,
          "another verified publisher with a similar helper identifier stays outside the Codex policy")
    for identifier in ["com.openai.chat", "com.openai.codex-companion.helper"] {
        check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: codexTeam, valid: true)) == .other,
              "another product of the same publisher stays outside the Codex policy")
    }
    for identifier in [nil, "", " ", "\n"] as [String?] {
        check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: RelayGuardIdentityClassifier.teamID, valid: true)) == .unresolved, "missing identity stays unresolved")
    }
    for identifier in ["org.nodejs.node", "com.microsoft.VSCode", "com.anthropic.claudefordesktop-impostor", "com.anthropic.claude-code-impostor"] {
        check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: "OTHERTEAM", valid: true)) == .other, "verified separate identity " + identifier)
        check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: "OTHERTEAM", valid: false)) == .unresolved, "invalid other is not verified " + identifier)
        check(RelayGuardIdentityClassifier.classify(.init(identifier: identifier, team: nil, valid: true)) == .unresolved, "unattributed other stays unresolved " + identifier)
    }
    check(RelayGuardIdentityClassifier.combine([]) == .unresolved, "empty token set stays unresolved")
    check(RelayGuardIdentityClassifier.combine([.other]) == .other, "verified other only")
    check(RelayGuardIdentityClassifier.combine([.other, .unresolved]) == .unresolved, "other cannot hide unresolved token")
    check(RelayGuardIdentityClassifier.combine([.unresolved, .other]) == .unresolved, "combination order does not hide unresolved token")
    for subject in [RelayGuardSubject.desktop, .desktopHelper, .nativeCLI] {
        check(RelayGuardIdentityClassifier.combine([.other, subject]) == subject, "other cannot erase protected subject")
        check(RelayGuardIdentityClassifier.combine([.unresolved, subject]) == subject, "verified token establishes protected scope")
        check(RelayGuardIdentityClassifier.combine([subject, .unverifiedProtected]) == .unverifiedProtected, "invalid token dominates valid subject")
    }
    let ownedIPv4 = RelayGuardPolicy(approvedProxyEndpoints: [
        .init(host: "127.0.0.1", port: 17890), .init(host: "127.0.0.1", port: 17891)
    ])
    for port in [17890, 17891] {
        check(ownedIPv4.decide(flow(.officialScriptCLI, "127.0.0.1", port)) == .allow,
              "official script can use a bound IPv4 dedicated TCP port")
        check(ownedIPv4.decide(flow(.officialScriptCLI, "::ffff:127.0.0.1", port)) == .allow,
              "mapped IPv4 input is the same bound listener")
        check(ownedIPv4.decide(flow(.officialScriptCLI, "::1", port)) == .drop,
              "a literal IPv6 listener is not approved by an IPv4 proof")
        check(ownedIPv4.decide(flow(.officialScriptCLI, "127.0.0.1", port, tcp: false)) == .drop,
              "the exact dedicated port does not approve UDP")
        check(ownedIPv4.decide(flow(.officialScriptCLI, "127.0.0.1", port, outbound: false)) == .drop,
              "the exact dedicated port does not approve inbound flow")
    }

    func flow(_ subject: RelayGuardSubject = .desktop, _ host: String? = "127.0.0.1", _ port: Int? = 17891, tcp: Bool = true, outbound: Bool = true) -> RelayGuardFlow {
        .init(subject: subject, outbound: outbound, tcp: tcp, host: host, port: port)
    }
    let empty = RelayGuardPolicy()
    let fixture = RelayGuardPolicy(approvedProxyEndpoints: [
        .init(host: "127.0.0.1", port: 17891), .init(host: "::1", port: 17890)
    ])
    for subject in [RelayGuardSubject.desktop, .desktopHelper, .nativeCLI] {
        check(empty.decide(flow(subject)) == .drop, "default empty approval blocks protected client")
        check(fixture.decide(flow(subject)) == .allow, "explicit isolated HTTP endpoint")
        check(fixture.decide(flow(subject, "::1", 17890)) == .allow, "explicit isolated SOCKS endpoint")
        check(fixture.decide(flow(subject, "127.0.0.1", 17890)) == .drop, "port approval is address specific")
        check(fixture.decide(flow(subject, "::1", 17891)) == .drop, "address approval is port specific")
    }
    for host in ["::ffff:127.0.0.1", "::FFFF:7F00:1", "0:0:0:0:0:ffff:7f00:1"] {
        check(fixture.decide(flow(.desktop, host)) == .allow, "standard IPv4 mapped loopback " + host)
    }
    check(fixture.decide(flow(.desktop, "0:0:0:0:0:0:0:1", 17890)) == .allow, "equivalent IPv6 loopback")
    for host in ["127.0.0.2", "127.1", "127.000.0.1", "localhost", "localhost.", "127.0.0.1.example.com", "127.0.0.1 ", "127.0.0.1\0.example.com", "[::1]", "::1%lo0", "::1\0.example.com", "0.0.0.0", "::", "::ffff:127.000.0.1", "::ffff:127.0.0.2", "::ffff:8.8.8.8", "fe80::1", "fc00::1", "10.0.0.1", "192.168.0.54", "172.16.0.1", "8.8.8.8", "2606:4700::1111"] {
        check(fixture.decide(flow(.desktop, host)) == .drop, "strict host rejection " + host)
        let maliciousApproval = RelayGuardPolicy(approvedProxyEndpoints: [.init(host: host, port: 17891)])
        check(maliciousApproval.decide(flow(.nativeCLI, host)) == .drop, "approval cannot authorize direct endpoint " + host)
    }
    for port in [0, -1, 80, 443, 7890, 17991, 65535, 65536] {
        let maliciousApproval = RelayGuardPolicy(approvedProxyEndpoints: [.init(host: "127.0.0.1", port: port)])
        check(maliciousApproval.decide(flow(.nativeCLI, "127.0.0.1", port)) == .drop, "approval cannot authorize another local port")
    }
    check(fixture.decide(flow(.desktop, nil)) == .drop, "missing host")
    check(fixture.decide(flow(.desktop, "127.0.0.1", nil)) == .drop, "missing port")
    check(fixture.decide(flow(.desktop, tcp: false)) == .drop, "local UDP blocked")
    check(fixture.decide(flow(.desktop, "1.1.1.1", 443, tcp: false)) == .drop, "public QUIC blocked")
    for subject in [RelayGuardSubject.desktop, .desktopHelper, .nativeCLI, .unverifiedProtected, .unresolved] {
        check(fixture.decide(flow(subject, outbound: false)) == .drop, "no inbound bypass for " + subject.rawValue)
    }
    for subject in [RelayGuardSubject.unverifiedProtected, .unresolved] {
        check(fixture.decide(flow(subject)) == .drop, "approval cannot replace process identity")
        check(fixture.decide(flow(subject, "8.8.8.8", 443)) == .drop, "unknown and invalid identities cannot direct connect")
    }
    check(fixture.decide(flow(.other, "192.168.0.1", 443)) == .allow, "verified other outbound remains outside subject policy")
    check(fixture.decide(flow(.other, nil, nil, tcp: false)) == .allow, "verified other UDP remains outside subject policy")
    check(fixture.decide(flow(.other, "127.0.0.1", 8080, outbound: false)) == .allow, "verified other inbound remains outside subject policy")
    check(empty.decide(flow(.desktop, "127.0.0.1", 17890)) == .drop, "known port alone does not establish ownership")
    let result = failures.isEmpty
        ? "PASS: \(checks) isolated guard policy checks; no live identity, endpoint ownership, or system protection established."
        : "FAIL: " + failures.joined(separator: ", ")
    print(result)
    return failures.isEmpty ? 0 : 1
}
