import Foundation
import Darwin

func runRelayGuardReadinessSelfTests() -> Int32 {
    var failures: [String] = [], count = 0
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    let executable = URL(fileURLWithPath: "/fixture/Relay.app/Contents/Resources/relay/RelayNative")
    var paths: [URL] = []
    let standalone = RelayGuardReadiness.inspect(executable: URL(fileURLWithPath: "/fixture/RelayNative"), environment: .init(observe: {
        paths.append($0); return .init()
    }))
    check(paths.isEmpty && standalone.application.presence == "notBundled" && standalone.extensionComponent.presence == "notBundled", "standalone helper never searches installed apps")
    check(standalone.readOnly && standalone.buildMode == "offline" && !standalone.liveOperationsAvailable && !standalone.protectionVerified, "offline gate cannot claim protection")
    check(standalone.systemExtension == "notQueried" && standalone.filterConfiguration == "notQueried" && standalone.runtimeEnforcement == "notVerified", "unknown system state never reported disabled")
    for raw in ["/fixture/App.app/Contents/Resources/other/RelayNative", "/fixture/App.app/Contents/Resources/relay/OTHER", "/fixture/not-app/Contents/Resources/relay/RelayNative"] {
        check(RelayGuardReadiness.applicationRoot(URL(fileURLWithPath: raw)) == nil, "invalid helper layout refused")
    }
    var app = RelayGuardBundleObservation(presence: "present", bundleIdentifier: RelayGuardContract.applicationID,
        signingIdentifier: RelayGuardContract.applicationID, signature: "staticValid", team: "FIXTURETEAM", version: "3", installEntitlement: true, networkEntitlement: true)
    var ext = RelayGuardBundleObservation(presence: "present", bundleIdentifier: RelayGuardContract.extensionID,
        signingIdentifier: RelayGuardContract.extensionID, signature: "staticValid", team: "FIXTURETEAM", version: "3", networkEntitlement: true, sandboxEntitlement: true)
    let environment = RelayGuardInspectionEnvironment(observe: {
        paths.append($0)
        return $0.pathExtension == "app" ? app : ext
    })
    func report() -> RelayGuardReadinessReport { RelayGuardReadiness.inspect(executable: executable, environment: environment) }
    let matching = report()
    check(matching.bundleMetadataMatches && !matching.liveOperationsAvailable && !matching.protectionVerified, "matching packaged metadata never enables live build")
    check(paths.count == 2 && paths[1].path == "/fixture/Relay.app/Contents/Library/SystemExtensions/local.relay.network.preview.guard.systemextension", "only Relay's fixed extension identity inspected")
    // Independent fixture matches the actual reviewed package descriptor.
    // Do not derive this ID/path from RelayGuardContract: that hid the mismatch.
    let packagedID = "local.relay.network.preview.guard"
    let packagedPath = "/fixture/Relay.app/Contents/Library/SystemExtensions/" + packagedID + ".systemextension"
    var packagedPaths: [String] = []
    let packagedEnvironment = RelayGuardInspectionEnvironment(observe: { url in
        packagedPaths.append(url.path)
        if url.path == "/fixture/Relay.app" { return app }
        guard url.path == packagedPath else { return .init(presence: "missing") }
        return RelayGuardBundleObservation(presence: "present", bundleIdentifier: packagedID,
            signingIdentifier: packagedID, signature: "staticValid", team: "FIXTURETEAM", version: "3",
            networkEntitlement: true, sandboxEntitlement: true)
    })
    let packagedReport = RelayGuardReadiness.inspect(executable: executable, environment: packagedEnvironment)
    check(RelayGuardContract.extensionID == packagedID, "readiness identity matches the actual package contract")
    check(packagedPaths == ["/fixture/Relay.app", packagedPath], "only the real packaged extension path is inspected")
    check(packagedReport.bundleMetadataMatches && !packagedReport.liveOperationsAvailable && !packagedReport.protectionVerified,
        "real packaged metadata may match but never enables offline protection")
    ext.bundleIdentifier = "local.relay.network.guard"; ext.signingIdentifier = "local.relay.network.guard"
    check(!report().bundleMetadataMatches && report().extensionComponent.identity == "mismatch",
        "old unadmitted extension identity is not accepted as the current package")
    ext.bundleIdentifier = RelayGuardContract.extensionID; ext.signingIdentifier = RelayGuardContract.extensionID
    check(matching.signingMetadataScope == "currentArchitecture" && matching.signatureValidationScope == "allArchitecturesNoNetwork", "explicit architecture and network limits")
    for signature in ["adHoc", "invalid", "unconfirmed"] {
        ext.signature = signature
        check(!report().bundleMetadataMatches && report().sameSigningTeam == "unconfirmed", "non-production signature not ready: " + signature)
    }
    ext.signature = "staticValid"; ext.team = "OTHERTEAM"
    check(report().sameSigningTeam == "mismatch" && !report().bundleMetadataMatches, "different signing teams")
    ext.team = nil
    check(report().sameSigningTeam == "unconfirmed", "missing team is not a match")
    ext.team = app.team; ext.version = "4"
    check(report().sameVersion == "mismatch" && !report().bundleMetadataMatches, "version mismatch")
    ext.version = ""
    check(report().sameVersion == "unconfirmed", "empty version unknown")
    ext.version = app.version; ext.signingIdentifier = "local.ai.network-assistant.guard"
    check(report().extensionComponent.identity == "mismatch" && !report().bundleMetadataMatches, "legacy guard cannot impersonate Relay extension")
    ext.signingIdentifier = RelayGuardContract.extensionID; ext.bundleIdentifier = "PRIVATE identifier"
    check(report().extensionComponent.identity == "mismatch", "bundle and signing identifiers both required")
    check(!(try! RelayReadOnly.encode(report())).contains("PRIVATE"), "raw identifiers not returned")
    ext.bundleIdentifier = RelayGuardContract.extensionID; ext.sandboxEntitlement = false
    check(!report().bundleMetadataMatches, "extension sandbox required for metadata match")
    ext.sandboxEntitlement = true; app.installEntitlement = false
    check(!report().bundleMetadataMatches, "app installer entitlement required")
    app.installEntitlement = true; app.networkEntitlement = false
    check(!report().bundleMetadataMatches, "app network entitlement required")
    app.networkEntitlement = true; ext.networkEntitlement = false
    check(!report().bundleMetadataMatches, "extension network entitlement required")
    ext.presence = "missing"
    check(report().extensionComponent.signature == "unconfirmed" && report().sameVersion == "unconfirmed" && !report().bundleMetadataMatches, "absent extension cannot retain signature or version evidence")
    paths = []; app.presence = "unconfirmed"
    let unknown = report()
    check(paths.count == 1 && unknown.extensionComponent.presence == "unconfirmed", "unreadable root does not probe a descendant")
    check(unknown.application.identity == "unconfirmed" && !unknown.application.installEntitlement, "unreadable component loses optimistic fields")

    let files = FileManager.default
    if let temp = realpath(files.temporaryDirectory.path, nil) {
        defer { free(temp) }
        let root = URL(fileURLWithPath: String(cString: temp), isDirectory: true)
            .appendingPathComponent("relay-guard-readiness-" + UUID().uuidString, isDirectory: true)
        let bundle = root.appendingPathComponent("Real.app", isDirectory: true)
        let alias = root.appendingPathComponent("Link.app")
        let dangling = root.appendingPathComponent("MissingLink.app")
        let regular = root.appendingPathComponent("file")
        let missing = root.appendingPathComponent("Missing.app")
        do {
            try files.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? files.removeItem(at: root) }
            try files.createDirectory(at: bundle, withIntermediateDirectories: false)
            try files.createSymbolicLink(at: alias, withDestinationURL: bundle)
            try files.createSymbolicLink(at: dangling, withDestinationURL: missing)
            try Data().write(to: regular)
            check(RelayGuardReadiness.bundleDirectoryPresence(bundle) == "present", "plain bundle directory observed")
            check(RelayGuardReadiness.observe(missing.appendingPathComponent("Nested")).presence == "missing", "missing bundle below plain parents")
            check(RelayGuardReadiness.observe(alias).presence == "unconfirmed", "bundle symlink refused")
            check(RelayGuardReadiness.observe(dangling).presence == "unconfirmed", "dangling bundle symlink is not absence")
            check(RelayGuardReadiness.observe(alias.appendingPathComponent("Nested")).presence == "unconfirmed", "symlink ancestor refused")
            check(RelayGuardReadiness.observe(regular.appendingPathComponent("Nested")).presence == "unconfirmed", "regular file ancestor refused")
            if geteuid() != 0 {
                try files.setAttributes([.posixPermissions: 0o000], ofItemAtPath: bundle.path)
                defer { try? files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: bundle.path) }
                check(RelayGuardReadiness.observe(bundle.appendingPathComponent("Nested")).presence == "unconfirmed", "inaccessible ancestor is not absence")
            }
        } catch { check(false, "plain bundle-path fixture setup") }
    } else { check(false, "plain bundle-path fixture root") }
    print(failures.isEmpty ? "PASS: \(count) guard build-readiness checks; injected signatures and local path metadata only." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
