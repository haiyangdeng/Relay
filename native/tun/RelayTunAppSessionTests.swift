import Foundation
import Darwin

private enum Injected: Error { case unavailable }
private final class SessionFixture {
    let lock = NSLock()
    var outputs: [[String: Any]] = []
    var events: [String] = []
    var host: RelayTunCoreHost?
    weak var session: RelayTunAppSession?
    var constructFails = false, prepareFails = false, activationBlocks = false, revokeFails = false, baselineConflicts = false
    var releaseFailures = 0, reconnects = 0
    var releaseUncertain = false
    var releaseSessionIDs: [String] = []
    var runtimeDirectory: String?
    var fileDescriptor: Int32 = -1
    let activationEntered = DispatchSemaphore(value: 0), activationRevoked = DispatchSemaphore(value: 0)
    let revision = String(repeating: "a", count: 64), evidence = String(repeating: "e", count: 64)
    let sessionID = "33333333-3333-4333-8333-333333333333"
    var receipt: RelayTunAcquiredReceipt!
    var configuration: Data!
    var baseline: RelayTunNetworkTransaction.Baseline!
    func response(_ operation: String, status: RelayTunExecutorResult.State, acquisition: RelayTunAcquiredReceipt? = nil) -> RelayTunWireResponse {
        .init(version: 1, nonce: String(repeating: "a", count: 64), operation: .init(rawValue: operation)!, status: status,
            helperRevision: revision, clientUID: getuid(), authenticated: true, rootOwned: true, runningAsRoot: true,
            executorAvailable: true, ready: false, active: status == .active, protectionVerified: false,
            sessionID: sessionID, evidenceSHA256: evidence, acquisition: acquisition)
    }
    func exchange(_ operation: String, _ fields: [String: Any]) throws -> (RelayTunWireResponse, FileHandle?) {
        lock.lock(); events.append(operation); lock.unlock()
        switch operation {
        case "prepare":
            if prepareFails { throw Injected.unavailable }
            return (response(operation, status: .prepared), nil)
        case "acquire":
            let fd = open("/dev/null", O_RDONLY | O_CLOEXEC)
            guard fd >= 0 else { throw Injected.unavailable }; fileDescriptor = fd
            return (response(operation, status: .acquired, acquisition: receipt), FileHandle(fileDescriptor: fd, closeOnDealloc: true))
        case "activate":
            if activationBlocks {
                activationEntered.signal()
                guard activationRevoked.wait(timeout: .now() + 2) == .success else { throw Injected.unavailable }
            }
            return (response(operation, status: .active), nil)
        case "revoke":
            if revokeFails { throw Injected.unavailable }
            activationRevoked.signal(); return (response(operation, status: .revoked), nil)
        case "release":
            let requestedSession = fields["sessionID"] as? String ?? ""
            releaseSessionIDs.append(requestedSession)
            guard requestedSession == sessionID else { throw Injected.unavailable }
            if releaseFailures > 0 { releaseFailures -= 1; throw Injected.unavailable }
            if releaseUncertain { return (response(operation, status: .uncertain), nil) }
            if fileDescriptor < 0 { return (response(operation, status: .released), nil) }
            guard let session else { throw Injected.unavailable }
            let nonce = String(repeating: "c", count: 64)
            let request = try RelayTunCoreObservation.request(receipt: receipt, operation: .released, nonce: nonce)
            var reply: NSData?
            session.query(request as NSData) { reply = $0 }
            guard let reply, try RelayTunCoreObservation.decodeResponse(reply as Data, receipt: receipt, operation: .released, nonce: nonce) == .released(true) else { throw Injected.unavailable }
            return (response(operation, status: .released), nil)
        default: throw Injected.unavailable
        }
    }
    func makeHost(_ receipt: RelayTunAcquiredReceipt, _ file: FileHandle, _ bundle: RelayTunAppBundle) throws -> RelayTunCoreHost {
        runtimeDirectory = bundle.directory
        if constructFails { throw Injected.unavailable }
        let binding = try RelayTunCoreHost.Binding(receipt: receipt, coreSHA256: RelayTunInstallationPaths.fixedCorePins["arm64"]!.0)
        var running = false, closed = false
        let host = try RelayTunCoreHost(binding: binding, configuration: bundle.configuration, driver: .init(
            ordinaryUID: { getuid() }, verifyResource: { _ in }, admit: { _ in
                .init(verify: { receipt }, launch: { _, _, register in
                    running = true
                    register(.init(poll: { running ? .running : .exited(0) }, stop: { running = false; return .init(waitStatus: 0, forced: false) },
                        readiness: { .init(binding: binding, runtimeConfigurationSHA256: receipt.runtimeConfigurationSHA256, coreVersion: "v1.19.33", inheritedDescriptor: 3) }))
                }, spawnAbsent: { !running }, close: { try file.close(); closed = true }, closed: { closed })
            }, releaseUnadmitted: { try file.close(); closed = true; return true }))
        self.host = host; return host
    }
    func emit(_ value: [String: Any]) { lock.lock(); outputs.append(value); lock.unlock() }
    func last() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return outputs.last ?? [:] }
    func driver() -> RelayTunAppSession.TestDriver {
        .init(revision: revision, exchange: exchange, reconnect: { self.reconnects += 1 }, baseline: { _ in
            self.baselineConflicts ? .init(networkSHA256: String(repeating: "0", count: 64), protectionSHA256: self.baseline.protectionSHA256) : self.baseline
        }, makeHost: makeHost, emit: emit)
    }
}

@main struct RelayTunAppSessionTests {
    static func main() {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(), CommandLine.arguments.count == 1 else { exit(77) }
        _ = umask(0o077)
        var rows: [[String: Any]] = []
        var recoveryDiagnosticCodes = Set<String>()
        func check(_ value: Bool, _ name: String) { rows.append(["name": name, "passed": value]) }
        func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
        func rulesLine(_ fd: Int32) throws -> [String: Any] {
            let deadline = RelayTunRuntimeRules.now + 2_000_000_000
            var bytes = Data()
            while RelayTunRuntimeRules.now < deadline {
                var item = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                guard poll(&item, 1, 10) >= 0 else { throw Injected.unavailable }
                if item.revents & Int16(POLLIN | POLLHUP) == 0 { continue }
                var byte: UInt8 = 0; guard Darwin.read(fd, &byte, 1) == 1 else { throw Injected.unavailable }
                if byte == 10 { return try RelayTunStrictJSON.object(bytes, limit: 8192) }
                bytes.append(byte); guard bytes.count <= 8192 else { throw Injected.unavailable }
            }
            throw Injected.unavailable
        }
        func rulesSend(_ fd: Int32, binding: [String: Any], id: Int, action: String, extra: [String: Any] = [:]) throws {
            var frame = binding; frame["version"] = 1; frame["id"] = id; frame["action"] = action
            for (key, value) in extra { frame[key] = value }
            var bytes = try data(frame); bytes.append(10)
            try bytes.withUnsafeBytes { raw in
                guard Darwin.write(fd, raw.baseAddress!, raw.count) == raw.count else { throw Injected.unavailable }
            }
        }
        func fixture(managed: Bool = false, resources: Bool = false, extra: [String: Any] = [:], _ body: (String, [String: Any]) throws -> Void) throws {
            var pattern = Array("/private/tmp/relay-bootstrap-test-XXXXXX".utf8CString)
            guard mkdtemp(&pattern) != nil else { throw RelayTunAppBundle.Failure.invalid }
            let source = String(cString: pattern)
            defer { try? FileManager.default.removeItem(atPath: source) }
            var sourceObject: [String: Any] = ["tun": ["enable": true, "device": "utun", "stack": "gvisor", "mtu": 1500,
                "auto-route": false, "auto-detect-interface": false, "dns-hijack": [String]()],
                "port": 0, "mode": "rule", "rules": ["MATCH,REJECT"]]
            sourceObject.merge(extra) { _, value in value }
            var runtime = sourceObject, tun = runtime["tun"] as! [String: Any]
            if managed {
                if tun["device"] as? String == "utun" { tun["device"] = "utun\(10000 + UInt32("bbbbbbbb", radix: 16)! % 22768)" }
            }
            else { tun["file-descriptor"] = 3 }
            runtime["tun"] = tun
            let original = try data(sourceObject), configuration = try data(runtime), asset = Data("payload:\n - DOMAIN,example.com\n".utf8)
            let path = "relay-files/" + RelayTunAppBundle.digest(asset) + ".yaml"
            var metadata: [[String: Any]] = [["path": path, "sha256": RelayTunAppBundle.digest(asset), "expectedRules": 1]]
            let oldGeo = Data("synthetic old geo".utf8)
            if resources { metadata.append(["path": "GeoSite.dat", "sha256": RelayTunAppBundle.digest(oldGeo)]) }
            let pins: [[String: Any]] = [["id": "11111111-1111-4111-8111-111111111111", "namespace": "resource", "sha256": RelayTunAppBundle.digest(asset), "revision": String(repeating: "f", count: 64)]]
            let bundle = try data(["configuration": sourceObject, "assets": metadata, "pins": pins, "unresolved": [Any]()])
            mkdir(source + "/relay-files", 0o700)
            for (name, bytes) in [("config.json", configuration), ("source.json", original), ("bundle.json", bundle), (path, asset)] {
                try bytes.write(to: URL(fileURLWithPath: source + "/" + name), options: .withoutOverwriting)
                chmod(source + "/" + name, 0o600)
            }
            if resources {
                try oldGeo.write(to: URL(fileURLWithPath: source + "/GeoSite.dat"), options: .withoutOverwriting)
                chmod(source + "/GeoSite.dat", 0o600)
            }
            let projection = try RelayTunNetworkProjection(device: "utun", mtu: 1500, addresses: [], routes: [], resolver: nil)
            var bootstrap: [String: Any] = ["version": 1, "action": "bootstrap", "controlLossPolicy": "restore-owned-session", "binding": ["sessionId": "22222222-2222-4222-8222-222222222222",
                "evidenceSHA256": String(repeating: "b", count: 64), "runtimeConfigurationSHA256": RelayTunAppBundle.digest(configuration)],
                "configurationSHA256": RelayTunAppBundle.digest(original), "bundleSHA256": RelayTunAppBundle.digest(bundle),
                "configurationPath": "config.json", "directory": source, "projection": String(decoding: projection.encoded(), as: UTF8.self),
                "managedMTU": 1500, "assets": metadata, "pins": pins,
                "baseline": ["networkSHA256": String(repeating: "c", count: 64), "protectionSHA256": String(repeating: "d", count: 64)]]
            if managed {
                bootstrap["version"] = 2; bootstrap["installationRevision"] = String(repeating: "a", count: 64)
                bootstrap.removeValue(forKey: "projection"); bootstrap.removeValue(forKey: "managedMTU")
            }
            var resourceRoot: String?
            if resources {
                var pattern = Array("/private/tmp/relay-geo-main-\(getuid())-session-tests-XXXXXX".utf8CString)
                guard mkdtemp(&pattern) != nil else { throw Injected.unavailable }
                resourceRoot = String(cString: pattern); bootstrap["resourceInboxRoot"] = resourceRoot!
            }
            defer { if let resourceRoot { try? FileManager.default.removeItem(atPath: resourceRoot) } }
            try body(source, bootstrap)
        }
        do {
            for scenario in ["prepare-fails", "host-construction-fails", "successful", "revoke-pending-activate", "revoke-fails", "dispose-conflict", "release-reconnect-retry", "core-baseline-conflict"] {
                try fixture { source, bootstrap in
                    let f = SessionFixture()
                    f.prepareFails = scenario == "prepare-fails"; f.constructFails = scenario == "host-construction-fails"
                    f.activationBlocks = scenario == "revoke-pending-activate"
                    f.revokeFails = scenario == "revoke-fails"
                    f.configuration = try Data(contentsOf: URL(fileURLWithPath: source + "/config.json"))
                    f.baseline = .init(networkSHA256: String(repeating: "c", count: 64), protectionSHA256: String(repeating: "d", count: 64))
                    f.receipt = try RelayTunAcquiredReceipt(installationRevision: f.revision, clientUID: getuid(), evidenceSHA256: f.evidence,
                        runtimeConfigurationSHA256: RelayTunAppBundle.digest(f.configuration), planID: "44444444-4444-4444-8444-444444444444",
                        sessionID: f.sessionID, deviceID: "55555555-5555-4555-8555-555555555555", interfaceName: "utun4294967294",
                        interfaceIndex: 99999, controlID: 17, controlUnit: 4294967295, socketDevice: "0", socketInode: "0")
                    let session = try RelayTunAppSession(bootstrap: data(bootstrap), testDriver: f.driver())
                    f.session = session
                    var id = 0
                    let binding = bootstrap["binding"] as! [String: Any]
                    func send(_ action: String, wait: Bool = true) throws -> [String: Any] {
                        id += 1
                        var frame = binding
                        frame["version"] = 1; frame["id"] = id; frame["action"] = action
                        try session.accept(JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys, .withoutEscapingSlashes]))
                        if wait { session.waitForDisposal() }
                        return f.last()
                    }
                    func phase(_ output: [String: Any]) -> String? { (output["observation"] as? [String: Any])?["phase"] as? String }
                    let initial = try send("initialize")
                    check(phase(initial) == (f.prepareFails ? "unknown" : "idle"), scenario + ": initialization uses actual control dispatch")
                    if !f.prepareFails {
                        let acquired = try send("acquire")
                        check(phase(acquired) == (f.constructFails ? "unknown" : "acquired"), scenario + ": acquisition retains delivery before host postcheck")
                        if scenario == "core-baseline-conflict" {
                            f.baselineConflicts = true
                            check(phase(try send("startCore")) == "unknown" && session.coreStartFailure == "session.baseline",
                                  "actual startCore dispatch identifies baseline rejection without exposing raw errors")
                            check(f.host?.status.phase == .idle, "baseline rejection occurs before any host start")
                            f.baselineConflicts = false
                        } else if !f.constructFails {
                            check(phase(try send("startCore")) == "coreReady", scenario + ": exact held host reaches coreReady")
                            check(phase(try send("inspect")) == "coreReady", scenario + ": pre-activation recheck preserves coreReady")
                            if f.activationBlocks {
                                _ = try send("activate", wait: false)
                                guard f.activationEntered.wait(timeout: .now() + 2) == .success else { throw Injected.unavailable }
                                _ = try send("revokeActivation", wait: false)
                                session.waitForDisposal()
                                f.lock.lock(); let outputs = f.outputs; f.lock.unlock()
                                check(outputs.contains { $0["revoked"] as? Bool == true } && outputs.contains { ($0["observation"] as? [String: Any])?["phase"] as? String == "unknown" }, "independent revoke overtakes pending activation and prevents active publication")
                            } else {
                                check(phase(try send("activate")) == "active", "explicit activate publishes only exact helper acknowledgement")
                                check(phase(try send("inspect")) == "active", "active inspect uses fresh host readiness")
                                if f.revokeFails {
                                    let revoked = try send("revokeActivation")
                                    check(revoked["revoked"] as? Bool == false && revoked["sessionId"] as? String == binding["sessionId"] as? String,
                                          "failed helper revoke uses bound controlled failure and preserves later recovery commands")
                                }
                            }
                        }
                    }
                    if scenario == "release-reconnect-retry" {
                        check(phase(try send("release")) == "unknown" && f.reconnects == 0 && !f.events.contains("release"),
                              "release while core is running cannot reconnect or reach helper")
                    }
                    let stopped = try send("stopCore"), snapshot = stopped["observation"] as? [String: Any]
                    check(phase(stopped) == "coreStopped" && ["none", "stopped"].contains(snapshot?["core"] as? String ?? ""), scenario + ": stop failure recovery never emits forbidden unknown-core coreStopped")
                    if f.fileDescriptor >= 0 {
                        check(fcntl(f.fileDescriptor, F_GETFD) == -1 && errno == EBADF, scenario + ": explicit stop closes delivered client FD")
                    }
                    if scenario == "release-reconnect-retry" {
                        f.releaseFailures = 3
                        check(phase(try send("release")) == "unknown" && f.reconnects == 1,
                              "failed release performs only one reconnect per request")
                        check(phase(try send("stopCore")) == "coreStopped", "a new stop reconfirms the held core is released")
                    }
                    check(phase(try send("release")) == "released", scenario + ": helper recovery remains reachable after controlled failure")
                    if scenario == "release-reconnect-retry" {
                        check(f.reconnects == 2, "a later explicit stop may reconnect the same session after the first reconnect fails")
                        check(f.releaseSessionIDs.count == 4 && f.releaseSessionIDs.allSatisfy { $0 == f.sessionID },
                              "each initial and reconnected release retains the prepared helper session ID")
                    }
                    check(phase(try send("verifyRestored")) == "restored", scenario + ": independent restoration check completes")
                    if scenario == "dispose-conflict", let directory = f.runtimeDirectory {
                        let unknown = directory + "/user-unknown"
                        try Data("preserve".utf8).write(to: URL(fileURLWithPath: unknown))
                        let refused = try send("dispose")
                        check(refused["closed"] as? Bool == false && !session.canExit, "failed disposal keeps a bound control channel and permits a new explicit attempt")
                        check(FileManager.default.fileExists(atPath: unknown), "failed disposal preserves unknown runtime data")
                        unlink(unknown)
                    }
                    let disposed = try send("dispose")
                    check(disposed["closed"] as? Bool == true && session.canExit, scenario + ": explicit disposal finishes client lifetime")
                    check(FileManager.default.fileExists(atPath: source), scenario + ": main-owned source is preserved until its own cleanup")
                }
            }
            for scenario in ["idle", "active", "pending-activate", "external-conflict", "release-reconnect", "release-unavailable", "release-uncertain"] {
                try fixture { source, bootstrap in
                    let f = SessionFixture()
                    f.activationBlocks = scenario == "pending-activate"
                    f.releaseFailures = scenario == "release-unavailable" ? 2 : (scenario == "release-reconnect" ? 1 : 0)
                    f.releaseUncertain = scenario == "release-uncertain"
                    f.configuration = try Data(contentsOf: URL(fileURLWithPath: source + "/config.json"))
                    f.baseline = .init(networkSHA256: String(repeating: "c", count: 64), protectionSHA256: String(repeating: "d", count: 64))
                    f.receipt = try RelayTunAcquiredReceipt(installationRevision: f.revision, clientUID: getuid(), evidenceSHA256: f.evidence,
                        runtimeConfigurationSHA256: RelayTunAppBundle.digest(f.configuration), planID: "44444444-4444-4444-8444-444444444444",
                        sessionID: f.sessionID, deviceID: "55555555-5555-4555-8555-555555555555", interfaceName: "utun4294967294",
                        interfaceIndex: 99999, controlID: 17, controlUnit: 4294967295, socketDevice: "0", socketInode: "0")
                    let session = try RelayTunAppSession(bootstrap: data(bootstrap), testDriver: f.driver())
                    f.session = session
                    let binding = bootstrap["binding"] as! [String: Any]
                    var id = 0
                    func send(_ action: String, wait: Bool = true) throws {
                        id += 1; var frame = binding
                        frame["version"] = 1; frame["id"] = id; frame["action"] = action
                        try session.accept(JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys]))
                        if wait { session.waitForDisposal() }
                    }
                    try send("initialize")
                    if scenario != "idle" {
                        try send("acquire"); try send("startCore")
                        try send("activate", wait: !f.activationBlocks)
                        if f.activationBlocks {
                            guard f.activationEntered.wait(timeout: .now() + 2) == .success else { throw Injected.unavailable }
                        }
                    }
                    f.baselineConflicts = scenario == "external-conflict"
                    session.inputEnded(); session.waitForDisposal()
                    let bytes = try Data(contentsOf: URL(fileURLWithPath: source + "/recovery.json"))
                    let record = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
                    let successful = !["external-conflict", "release-unavailable", "release-uncertain"].contains(scenario)
                    check(session.canExit == successful && record["status"] as? String == (successful ? "restored" : "uncertain"),
                          "control loss from " + scenario + " reports only verified recovery")
                    check(record["ownedRecoveryRetained"] as? Bool == !successful && record["sessionId"] as? String == binding["sessionId"] as? String,
                          "control-loss recovery record binds the outer session and retained ownership")
                    if scenario.hasPrefix("release-") {
                        let expectedAttempts = scenario == "release-uncertain" ? 1 : 2
                        check(f.releaseSessionIDs == Array(repeating: f.sessionID, count: expectedAttempts) && f.reconnects == expectedAttempts - 1,
                              scenario + ": control loss keeps the exact helper session and permits at most one transport reconnect")
                        check(f.events.filter { $0 == "acquire" }.count == 1 && f.events.filter { $0 == "activate" }.count == 1,
                              scenario + ": recovery never creates or activates another session")
                    }
                    if f.fileDescriptor >= 0 {
                        check(fcntl(f.fileDescriptor, F_GETFD) == -1 && errno == EBADF, "control-loss rollback explicitly closes only the delivered client FD")
                    }
                    if let directory = f.runtimeDirectory {
                        check(FileManager.default.fileExists(atPath: directory) == !successful,
                              "control loss keeps private runtime only when restoration is unverified")
                        // This is an inert fixture with no real child/network;
                        // remove retained synthetic files after checking them.
                        if !successful { try FileManager.default.removeItem(atPath: directory) }
                    }
                    var duplicate = binding; duplicate["version"] = 1; duplicate["id"] = 100; duplicate["action"] = "acquire"
                    do { try session.accept(data(duplicate)); check(false, "lost control cannot reacquire a device") }
                    catch { check(true, "lost control cannot reacquire a device") }
                }
            }
            let controllerFields = ["external-controller", "external-controller-tls", "external-controller-unix", "external-controller-pipe"]
            var refusedConfigurations = controllerFields.map { [$0: "0.0.0.0:9090"] as [String: Any] }
            refusedConfigurations += [["ntp": ["enable": true, "write-to-system": true]], ["ntp": ["write-to-system": NSNull()]]]
            for extra in refusedConfigurations {
                try fixture(managed: true, extra: extra) { _, bootstrap in
                    do {
                        _ = try RelayTunAppBundle(data(bootstrap))
                        check(false, "native managed admission refuses privileged controller/clock options before runtime creation")
                    } catch {
                        check(true, "native managed admission refuses privileged controller/clock options before runtime creation")
                    }
                }
            }
            try fixture(managed: true, extra: ["external-controller": "", "external-controller-tls": "", "external-controller-unix": "", "external-controller-pipe": "", "ntp": ["write-to-system": false]]) { _, bootstrap in
                let bundle = try RelayTunAppBundle(data(bootstrap))
                try bundle.cleanup()
                check(true, "native managed admission retains disabled controllers and process-local NTP")
            }
            for device in ["utun0", "utun32767", "utun32768", "utun652683", "utun4294967294", "utun-1", "utun01"] {
                try fixture(managed: true, extra: ["tun": ["enable": true, "device": device, "stack": "gvisor", "mtu": 1500,
                    "auto-route": false, "auto-detect-interface": false, "dns-hijack": [String]()]]) { _, bootstrap in
                    let admitted = ["utun0", "utun32767"].contains(device)
                    do {
                        let bundle = try RelayTunAppBundle(data(bootstrap)); try bundle.cleanup()
                        check(admitted, "native managed admission enforces fixed-upstream device range and canonical name: " + device)
                    } catch {
                        check(!admitted, "native managed admission enforces fixed-upstream device range and canonical name: " + device)
                    }
                }
            }
            try fixture(managed: true) { _, bootstrap in
                let f = SessionFixture()
                f.baseline = .init(networkSHA256: String(repeating: "c", count: 64), protectionSHA256: String(repeating: "d", count: 64))
                var driver = f.driver()
                driver.runtimeCaptureIdentity = { (revision: f.revision, clientSHA256: String(repeating: "c", count: 64)) }
                var owner: RelayTunAppSession? = try .init(bootstrap: data(bootstrap), testDriver: driver, coreManaged: true)
                weak var weakOwner = owner
                var request = [Int32](repeating: 0, count: 2), response = request
                guard pipe(&request) == 0, pipe(&response) == 0 else { throw Injected.unavailable }
                guard fcntl(request[1], F_SETNOSIGPIPE, 1) == 0 else { throw Injected.unavailable }
                defer { Darwin.close(request[1]); Darwin.close(response[0]) }
                var channel = RelayTunRuntimeCapture.Channel(input: request[0], output: response[1])
                guard channel != nil else { throw Injected.unavailable }
                weak var weakChannel = channel
                try owner!.startRuntimeCapture(channel!)
                channel = nil
                func line() throws -> [String: Any] {
                    let deadline = RelayTunRuntimeCapture.now + 2_000_000_000
                    var bytes = Data()
                    while RelayTunRuntimeCapture.now < deadline {
                        var item = pollfd(fd: response[0], events: Int16(POLLIN), revents: 0)
                        guard poll(&item, 1, 10) >= 0 else { throw Injected.unavailable }
                        if item.revents & Int16(POLLIN) == 0 { continue }
                        var byte: UInt8 = 0
                        guard Darwin.read(response[0], &byte, 1) == 1 else { throw Injected.unavailable }
                        if byte == 10 { return try RelayTunStrictJSON.object(bytes, limit: 8192) }
                        bytes.append(byte); guard bytes.count <= 8192 else { throw Injected.unavailable }
                    }
                    throw Injected.unavailable
                }
                let hello = try line()
                check(weakChannel != nil && hello["capability"] as? String == "runtime-capture-v1",
                      "ARC: actual AppSession retains read Channel after launcher drops its last reference")
                var frame = bootstrap["binding"] as! [String: Any]
                frame["version"] = 1; frame["id"] = 1; frame["action"] = "capture"
                var bytes = try data(frame); bytes.append(10)
                try bytes.withUnsafeBytes { raw in
                    guard Darwin.write(request[1], raw.baseAddress!, raw.count) == raw.count else { throw Injected.unavailable }
                }
                let reply = try line()
                check(reply["status"] as? String == "unavailable" && weakOwner != nil,
                      "ARC: retained real read Channel still answers bound requests without starting Core")
                // Keep Channel alive externally to prove its weak callbacks
                // do not retain the session in the opposite direction.
                var retainedChannel = weakChannel
                owner = nil
                let deadline = RelayTunRuntimeCapture.now + 500_000_000
                while weakOwner != nil && RelayTunRuntimeCapture.now < deadline { usleep(1000) }
                check(weakOwner == nil && retainedChannel != nil,
                      "ARC: live Channel callbacks do not strongly retain or cycle the session")
                retainedChannel = nil
                let channelDeadline = RelayTunRuntimeCapture.now + 500_000_000
                while weakChannel != nil && RelayTunRuntimeCapture.now < channelDeadline { usleep(1000) }
                check(weakChannel == nil && f.events.isEmpty,
                      "ARC: releasing both owners closes only read capability with no helper/recovery operations")
            }
            try fixture(managed: true) { _, bootstrap in
                let f = SessionFixture(); var driver = f.driver()
                driver.runtimeCaptureIdentity = { (revision: f.revision, clientSHA256: String(repeating: "c", count: 64)) }
                var owner: RelayTunAppSession? = try .init(bootstrap: data(bootstrap), testDriver: driver, coreManaged: true)
                weak var weakOwner = owner
                var request = [Int32](repeating: 0, count: 2), response = request
                guard pipe(&request) == 0, pipe(&response) == 0, fcntl(request[1], F_SETNOSIGPIPE, 1) == 0 else { throw Injected.unavailable }
                defer { Darwin.close(request[1]); Darwin.close(response[0]) }
                try owner!.startRuntimeRules(input: request[0], output: response[1])
                let hello = try rulesLine(response[0])
                check(hello["capability"] as? String == "runtime-rules-v1", "rules ARC: actual AppSession retains its sole Channel owner after startup returns")
                try rulesSend(request[1], binding: bootstrap["binding"] as! [String: Any], id: 1, action: "read")
                check(try rulesLine(response[0])["status"] as? String == "stale" && !owner!.canExit,
                      "rules ARC: bound idle read cannot start a core or invoke control recovery")
                owner = nil
                let deadline = RelayTunRuntimeRules.now + 1_000_000_000
                while weakOwner != nil && RelayTunRuntimeRules.now < deadline { usleep(1000) }
                check(weakOwner == nil, "rules ARC: weak Driver and enqueue callbacks do not cycle the session")
                var item = pollfd(fd: response[0], events: Int16(POLLIN), revents: 0), byte: UInt8 = 0
                let closed = poll(&item, 1, 1000) > 0 && Darwin.read(response[0], &byte, 1) == 0
                check(closed && f.events.isEmpty, "rules ARC: session release closes only rules FDs without helper or lifecycle work")
            }
            try fixture(managed: true, resources: true) { source, bootstrap in
                typealias M = RelayTunRuntimeResources
                let f = SessionFixture(), readEntered = DispatchSemaphore(value: 0), releaseRead = DispatchSemaphore(value: 0), gate = NSLock()
                let prepareEntered = DispatchSemaphore(value: 0), releasePrepare = DispatchSemaphore(value: 0)
                f.baseline = .init(networkSHA256: String(repeating: "c", count: 64), protectionSHA256: String(repeating: "d", count: 64))
                var driver = f.driver(), running = false, heldRead = false, heldPrepare = false, failAfterEntry = false
                var directory: String?, directoryIdentity: stat?, writes = 0, stops = 0, stateReads = 0, neutralized = 0, prepareSerial = 0, sequence: UInt64 = 0
                var active = try Data(contentsOf: URL(fileURLWithPath: source + "/GeoSite.dat"))
                let boot = "55555555-5555-4555-8555-555555555555"
                func head() -> String { String(repeating: sequence == 0 ? "c" : sequence == 1 ? "d" : "f", count: 64) }
                func state() -> RelayTunCoreReadiness.ResourceState {
                    .init(bootId: boot, generationSHA256: head(), sequence: sequence,
                        resources: [.init(kind: .geosite, sha256: M.digest(active), bytes: active.count, active: true)])
                }
                driver.runtimeCaptureIdentity = { (revision: f.revision, clientSHA256: String(repeating: "c", count: 64)) }
                driver.makeManagedCore = { bundle, authorized in
                    directory = bundle.directory
                    var identity = stat(); guard lstat(bundle.directory, &identity) == 0 else { throw Injected.unavailable }; directoryIdentity = identity
                    var config = try RelayTunStrictJSON.object(bundle.configuration, limit: 2 * 1024 * 1024), tun = try RelayTunStrictJSON.object(bundle.configuration, limit: 2 * 1024 * 1024)["tun"] as! [String: Any]
                    tun["file-descriptor"] = 0; tun["recvmsgx"] = true; tun["dns-mode"] = "disabled"
                    config["tun"] = tun; config["allow-lan"] = false; config["ipv6"] = true
                    for key in ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"] { config[key] = config[key] ?? 0 }
                    let configs = try data(config)
                    let read: (String) throws -> Data = { endpoint in
                        endpoint == "version" ? try data(["version": RelayTunCoreReadiness.resourceVersion]) : configs
                    }
                    return try .init(configuration: bundle.configuration, baseline: bundle.baseline, authorized: authorized,
                        driver: .init(verify: { try bundle.verify() }, hold: {}, launch: { register in
                            running = true
                            register(.init(observe: { running ? .running : .exited(0) }, stop: {
                                running = false; stops += 1; return .init(waitStatus: 0, forced: false)
                            }, read: read, readCapture: { endpoint, _ in try read(endpoint) }, readResources: { _, check in
                                gate.lock(); let hold = heldRead; gate.unlock()
                                if hold { readEntered.signal(); guard releaseRead.wait(timeout: .now() + 3) == .success else { throw Injected.unavailable } }
                                try check(); stateReads += 1; return state()
                            }, prepareResource: { selected, access in
                                try access.check()
                                guard selected.oldSHA256 == M.digest(active), selected.expectedGenerationSHA256 == head() else { throw Injected.unavailable }
                                gate.lock(); let hold = heldPrepare; gate.unlock()
                                if hold { prepareEntered.signal(); guard releasePrepare.wait(timeout: .now() + 3) == .success else { throw Injected.unavailable } }
                                prepareSerial += 1
                                return .init(nonce: M.digest(Data("synthetic-prepare-\(prepareSerial)".utf8)), bootId: boot,
                                    kind: selected.kind, oldSHA256: selected.oldSHA256, newSHA256: selected.newSHA256,
                                    previousGenerationSHA256: head(), sequence: sequence, bytes: selected.bytes, remainingMilliseconds: 20000)
                            }, commitResource: { prepared, access in
                                try access.enterWrite()
                                let paths = try FileManager.default.contentsOfDirectory(atPath: bundle.directory + "/RelayGeoInbox")
                                guard paths.count == 1 else { throw Injected.unavailable }
                                let staged = bundle.directory + "/RelayGeoInbox/" + paths[0] + "/GeoSite.dat"
                                let next = try Data(contentsOf: URL(fileURLWithPath: staged))
                                guard M.digest(next) == prepared.newSHA256 else { throw Injected.unavailable }
                                try FileManager.default.moveItem(atPath: bundle.directory + "/GeoSite.dat", toPath: bundle.directory + "/RelayGeo.retained-" + prepared.nonce)
                                try next.write(to: URL(fileURLWithPath: bundle.directory + "/GeoSite.dat"), options: .withoutOverwriting)
                                chmod(bundle.directory + "/GeoSite.dat", 0o600)
                                active = next; sequence += 1; writes += 1
                                if failAfterEntry { throw Injected.unavailable }
                                return .init(bootId: boot, kind: prepared.kind, oldSHA256: prepared.oldSHA256,
                                    newSHA256: prepared.newSHA256, bytes: next.count, previousGenerationSHA256: prepared.previousGenerationSHA256,
                                    generationSHA256: head(), sequence: sequence, retainedOriginal: true)
                            }, cancelResource: { _, _, check in try check(); neutralized += 1; return .cancelled }))
                        }, interfacePresent: { running }, baseline: { bundle.baseline }, dispose: {}), resourcesEnabled: true)
                }
                let session = try RelayTunAppSession(bootstrap: data(bootstrap), testDriver: driver, coreManaged: true, resourcesEnabled: true)
                f.session = session
                let binding = bootstrap["binding"] as! [String: Any]
                var controlId = 0
                @MainActor func send(_ action: String) throws {
                    controlId += 1; var frame = binding; frame["version"] = 1; frame["id"] = controlId; frame["action"] = action
                    try session.accept(data(frame)); session.waitForDisposal()
                }
                var request = [Int32](repeating: -1, count: 2), response = request
                guard pipe(&request) == 0, pipe(&response) == 0, fcntl(request[1], F_SETNOSIGPIPE, 1) == 0 else { throw Injected.unavailable }
                defer { releaseRead.signal(); releasePrepare.signal(); Darwin.close(request[1]); Darwin.close(response[0]) }
                try session.startRuntimeResources(input: request[0], output: response[1])
                var early = pollfd(fd: response[0], events: Int16(POLLIN), revents: 0)
                check(poll(&early, 1, 0) == 0, "resources hello waits for actual initialize ACK instead of bootstrap")
                try send("initialize")
                let hello = try rulesLine(response[0])
                check(hello["capability"] as? String == "runtime-resources-v1" && f.last()["action"] as? String == "initialize",
                      "resources hello follows recorded initialize ACK and exposes only fixed binding")
                try send("startCore")
                gate.lock(); heldRead = true; gate.unlock()
                try rulesSend(request[1], binding: binding, id: 1, action: "read")
                guard readEntered.wait(timeout: .now() + 2) == .success else { throw Injected.unavailable }
                try rulesSend(request[1], binding: binding, id: 2, action: "cancel", extra: ["operationId": 1])
                let cancel = try rulesLine(response[0])
                try rulesSend(request[1], binding: binding, id: 3, action: "read"); let busy = try rulesLine(response[0])
                gate.lock(); heldRead = false; gate.unlock(); releaseRead.signal()
                let settled = try rulesLine(response[0])
                check(cancel["pending"] as? Bool == true && busy["status"] as? String == "busy" && settled["status"] as? String == "cancelled" && writes == 0,
                      "resource read cancellation retains pending through actual mutation-queue settlement")
                try rulesSend(request[1], binding: binding, id: 4, action: "read")
                let first = try rulesLine(response[0]), firstSnapshot = first["snapshot"] as! [String: Any]
                check(first["status"] as? String == "snapshot" && stops == 0, "resource read works with all HTTP ports zero and no PCB or helper operation")
                let root = bootstrap["resourceInboxRoot"] as! String
                func blob(_ id: String, bytes: Data) throws -> [String: Any] {
                    guard mkdir(root + "/" + id, 0o700) == 0 else { throw Injected.unavailable }
                    try bytes.write(to: URL(fileURLWithPath: root + "/" + id + "/GeoSite.dat"), options: .withoutOverwriting)
                    chmod(root + "/" + id + "/GeoSite.dat", 0o600)
                    return ["blobId": id, "kind": "geosite-dat", "sha256": M.digest(bytes), "bytes": bytes.count, "selector": "fixture"]
                }
                @MainActor func replace(_ frame: Int, ticket: [String: Any], snapshot: [String: Any]) throws -> [String: Any] {
                    let row = (snapshot["resources"] as! [[String: Any]])[0]
                    let selection: [String: Any] = ["configurationRevision": snapshot["configurationRevision"]!,
                        "expectedGenerationSHA256": snapshot["generationSHA256"]!, "kind": "geosite-dat", "oldSHA256": row["sha256"]!,
                        "newSHA256": ticket["sha256"]!, "blobId": ticket["blobId"]!, "selector": ticket["selector"]!, "bytes": ticket["bytes"]!]
                    try rulesSend(request[1], binding: binding, id: frame, action: "replace", extra: selection)
                    return try rulesLine(response[0])
                }
                let cancelledTicket = try blob("88888888-8888-4888-8888-888888888888", bytes: Data("synthetic cancelled geo".utf8))
                let oldRow = (firstSnapshot["resources"] as! [[String: Any]])[0]
                let pendingSelection: [String: Any] = ["configurationRevision": firstSnapshot["configurationRevision"]!,
                    "expectedGenerationSHA256": firstSnapshot["generationSHA256"]!, "kind": "geosite-dat", "oldSHA256": oldRow["sha256"]!,
                    "newSHA256": cancelledTicket["sha256"]!, "blobId": cancelledTicket["blobId"]!, "selector": "fixture", "bytes": cancelledTicket["bytes"]!]
                gate.lock(); heldPrepare = true; gate.unlock()
                try rulesSend(request[1], binding: binding, id: 5, action: "replace", extra: pendingSelection)
                guard prepareEntered.wait(timeout: .now() + 2) == .success else { throw Injected.unavailable }
                try rulesSend(request[1], binding: binding, id: 6, action: "cancel", extra: ["operationId": 5])
                let prepareCancel = try rulesLine(response[0])
                try rulesSend(request[1], binding: binding, id: 7, action: "read"); let prepareBusy = try rulesLine(response[0])
                gate.lock(); heldPrepare = false; gate.unlock(); releasePrepare.signal()
                let prepareTerminal = try rulesLine(response[0])
                check(prepareCancel["pending"] as? Bool == true && prepareBusy["status"] as? String == "busy" &&
                      prepareTerminal["status"] as? String == "cancelled" && neutralized == 1 && writes == 0,
                      "late known prepare cancellation neutralizes its private nonce before settling with zero publication")
                try rulesSend(request[1], binding: binding, id: 8, action: "discardBlob", extra: cancelledTicket)
                check(try rulesLine(response[0])["status"] as? String == "absent", "cancelled consumed candidate has an exact neutral absent ACK")
                let ticket = try blob("66666666-6666-4666-8666-666666666666", bytes: Data("synthetic new geo".utf8))
                let updated = try replace(9, ticket: ticket, snapshot: firstSnapshot), updatedSnapshot = updated["snapshot"] as? [String: Any]
                check(updated["status"] as? String == "updated" && updatedSnapshot?["generationSHA256"] as? String == head() && writes == 1,
                      "actual Native inbox stage and model receipt advance the fixed target ledger once")
                try rulesSend(request[1], binding: binding, id: 10, action: "discardBlob", extra: ticket)
                check(try rulesLine(response[0])["status"] as? String == "absent", "neutral full-ticket ACK confirms the consumed main UUID remains absent")
                try send("inspect")
                check((f.last()["observation"] as? [String: Any])?["phase"] as? String == "active" && stops == 0,
                      "successful Geo transition does not fail original static/source driver verification")
                failAfterEntry = true
                let unknownTicket = try blob("77777777-7777-4777-8777-777777777777", bytes: Data("synthetic uncertain geo".utf8))
                guard let updatedSnapshot else { throw Injected.unavailable }
                let unknown = try replace(11, ticket: unknownTicket, snapshot: updatedSnapshot), readsBefore = stateReads
                try rulesSend(request[1], binding: binding, id: 12, action: "read"); let isolated = try rulesLine(response[0])
                check(unknown["status"] as? String == "uncertain" && unknown["snapshot"] == nil && writes == 2,
                      "post-entry publication error is uncertain without retry or a usable snapshot")
                check(isolated["status"] as? String == "uncertain" && isolated["snapshot"] == nil && stateReads == readsBefore,
                      "explicit state read cannot silently reconcile an unknown resource generation")
                try send("inspect")
                check((f.last()["observation"] as? [String: Any])?["phase"] as? String == "active" && stops == 0,
                      "isolated selected Geo uncertainty never triggers generic inspect global recovery or Core stop")
                try send("stopCore"); try send("release"); try send("verifyRestored"); try send("dispose")
                check(f.last()["closed"] as? Bool == true && session.canExit && !running && stops == 1,
                      "unknown resource artifacts remain while exact fake-child stop and fresh baseline allow capability disposal")
                if let directory, let directoryIdentity {
                    var current = stat()
                    guard lstat(directory, &current) == 0, current.st_dev == directoryIdentity.st_dev,
                          current.st_ino == directoryIdentity.st_ino, current.st_uid == getuid(),
                          current.st_mode & 0o7777 == 0o700 else { throw Injected.unavailable }
                    try FileManager.default.removeItem(atPath: directory)
                }
                check(f.events.isEmpty, "resources fixture never calls a helper, real Core, system route or DNS capability")
            }
            for scenario in ["provider-normal", "provider-cancel", "provider-unknown", "provider-control-loss", "provider-probe-evidence"] {
                let originalBody = Data("payload:\n - DOMAIN,example.com\n".utf8)
                let originalPath = "relay-files/" + RelayTunAppBundle.digest(originalBody) + ".yaml"
                let definitions: [String: Any] = [
                    "one": ["type": "file", "path": originalPath, "behavior": "classical", "format": "yaml", "interval": 0],
                    "%41": ["type": "file", "path": originalPath, "behavior": "classical", "format": "yaml", "interval": 0],
                    "inline": ["type": "inline", "behavior": "classical", "payload": ["DOMAIN,inline.invalid"], "interval": 0]]
                try fixture(managed: true, resources: true, extra: ["rule-providers": definitions]) { source, bootstrap in
                    typealias Probe = RelayTunRuntimeRuleProviderProbe
                    let f = SessionFixture(), entered = DispatchSemaphore(value: 0), proceed = DispatchSemaphore(value: 0), gate = NSLock()
                    f.baseline = .init(networkSHA256: String(repeating: "c", count: 64), protectionSHA256: String(repeating: "d", count: 64))
                    var driver = f.driver(), running = false, stops = 0, disposals = 0, probes = 0, puts = [String](), block = false
                    var coreDirectory = "", failPUT = false, probeEvidence = ""
                    var evidenceIdentity: stat?
                    let oldGeo = try Data(contentsOf: URL(fileURLWithPath: source + "/GeoSite.dat"))
                    func metadata(_ counts: [String: Int]) throws -> Data {
                        var rows = [String: Any]()
                        for (name, count) in counts {
                            var row: [String: Any] = ["name": name, "type": "Rule", "behavior": "Classical", "format": "YamlRule", "vehicleType": "File", "ruleCount": count, "updatedAt": "2026-11-01T00:00:00Z"]
                            if name == "inline" { row["vehicleType"] = "Inline"; row["format"] = ""; row["payload"] = ["DOMAIN,inline.invalid"] }
                            rows[name] = row
                        }
                        return try JSONSerialization.data(withJSONObject: ["providers": rows], options: [.sortedKeys, .withoutEscapingSlashes])
                    }
                    driver.runtimeCaptureIdentity = { (revision: f.revision, clientSHA256: String(repeating: "c", count: 64)) }
                    driver.probeRuleProvider = { projection, _, live in
                        gate.lock(); let hold = block; gate.unlock()
                        if hold { entered.signal(); guard proceed.wait(timeout: .now() + 3) == .success else { throw Injected.unavailable } }
                        try live(); probes += 1
                        return try Probe.accepted(projection, putAccepted: Set(projection.bindings.map { $0.name }), metadata: metadata(projection.expectedRuleCounts))
                    }
                    if scenario == "provider-probe-evidence" {
                        driver.probeRuleProvider = nil
                        driver.providerProbeWorkspace = { projection in
                            var pattern = Array("/private/tmp/relay-provider-probe-\(getuid())-XXXXXX".utf8CString)
                            guard mkdtemp(&pattern) != nil else { throw Injected.unavailable }
                            probeEvidence = String(cString: pattern)
                            var identity = stat(); guard lstat(probeEvidence, &identity) == 0 else { throw Injected.unavailable }; evidenceIdentity = identity
                            try Data("unrecognized private probe evidence".utf8).write(to: URL(fileURLWithPath: probeEvidence + "/foreign"), options: .withoutOverwriting)
                            chmod(probeEvidence + "/foreign", 0o600)
                            return try .init(directory: probeEvidence, configuration: projection.configuration, coreSHA256: Probe.corePin.sha256, coreBytes: Probe.corePin.bytes,
                                prepare: { throw Injected.unavailable }, verify: {}, cleanup: { throw Injected.unavailable })
                        }
                    }
                    driver.makeManagedCore = { bundle, authorized in
                        coreDirectory = bundle.directory
                        var config = try RelayTunStrictJSON.object(bundle.configuration, limit: 2 * 1024 * 1024), tun = config["tun"] as! [String: Any]
                        tun["file-descriptor"] = 0; tun["recvmsgx"] = true; tun["dns-mode"] = "disabled"
                        config["tun"] = tun; config["allow-lan"] = false; config["ipv6"] = true
                        for key in ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"] { config[key] = config[key] ?? 0 }
                        let configs = try data(config)
                        let read: (String) throws -> Data = { $0 == "version" ? try data(["version": RelayTunCoreReadiness.resourceVersion]) : configs }
                        return try .init(configuration: bundle.configuration, baseline: bundle.baseline, authorized: authorized,
                            driver: .init(verify: { try bundle.verify() }, hold: {}, launch: { register in
                                running = true
                                register(.init(observe: { running ? .running : .exited(0) }, stop: { running = false; stops += 1; return .init(waitStatus: 0, forced: false) }, read: read,
                                    readCapture: { endpoint, _ in try read(endpoint) }, readResources: { _, live in
                                        try live(); return .init(bootId: "55555555-5555-4555-8555-555555555555", generationSHA256: String(repeating: "e", count: 64), sequence: 0,
                                            resources: [.init(kind: .geosite, sha256: RelayTunAppBundle.digest(oldGeo), bytes: oldGeo.count, active: true)])
                                    }, readRuleProviders: { _, live in try live(); return try metadata(["one": 1, "%41": 1, "inline": 1]) },
                                    updateRuleProvider: { name, _, live, before in
                                        try live(); try before(); puts.append(name)
                                        let actual = try Data(contentsOf: URL(fileURLWithPath: coreDirectory + "/" + originalPath))
                                        guard actual != originalBody else { throw Injected.unavailable }
                                        if failPUT { throw Injected.unavailable }
                                    }))
                            }, interfacePresent: { running }, baseline: { bundle.baseline }, dispose: { disposals += 1 }),
                            resourcesEnabled: true, ruleProvidersEnabled: true, ruleProvidersCoreSHA256: Probe.corePin.sha256)
                    }
                    let session = try RelayTunAppSession(bootstrap: data(bootstrap), testDriver: driver, coreManaged: true, resourcesEnabled: true, ruleProvidersEnabled: true)
                    f.session = session
                    let binding = bootstrap["binding"] as! [String: Any]
                    var controlId = 0, requestId = 0
                    @MainActor func control(_ action: String, wait: Bool = true) throws {
                        controlId += 1; var frame = binding; frame["version"] = 1; frame["id"] = controlId; frame["action"] = action
                        try session.accept(data(frame)); if wait { session.waitForDisposal() }
                    }
                    var request = [Int32](repeating: -1, count: 2), response = request
                    guard pipe(&request) == 0, pipe(&response) == 0, fcntl(request[1], F_SETNOSIGPIPE, 1) == 0 else { throw Injected.unavailable }
                    defer {
                        proceed.signal(); Darwin.close(request[1]); Darwin.close(response[0])
                        if !coreDirectory.isEmpty { try? FileManager.default.removeItem(atPath: coreDirectory) }
                        if let evidenceIdentity {
                            var current = stat()
                            if lstat(probeEvidence, &current) == 0, current.st_dev == evidenceIdentity.st_dev, current.st_ino == evidenceIdentity.st_ino,
                               current.st_uid == getuid(), current.st_mode == mode_t(S_IFDIR) | 0o700 { try? FileManager.default.removeItem(atPath: probeEvidence) }
                        }
                    }
                    try session.startRuntimeRuleProviders(input: request[0], output: response[1])
                    var early = pollfd(fd: response[0], events: Int16(POLLIN), revents: 0)
                    check(poll(&early, 1, 0) == 0, scenario + ": provider hello waits for actual initialize ACK")
                    try control("initialize"); let hello = try rulesLine(response[0]); try control("startCore")
                    check(hello["capability"] as? String == "runtime-rule-providers-v1" && running, scenario + ": positively versioned provider channel starts with owned active child")
                    requestId += 1; try rulesSend(request[1], binding: binding, id: requestId, action: "read")
                    var snapshot = try rulesLine(response[0])["snapshot"] as! [String: Any]
                    check((snapshot["providers"] as? [[String: Any]])?.count == 2 && (snapshot["groups"] as? [[String]]) == [["%41", "one"]], scenario + ": initial authority includes both physical aliases without assigning inline a file")
                    let root = bootstrap["resourceInboxRoot"] as! String
                    @MainActor func replace(_ index: Int) throws -> Int {
                        let id = String(format: "66666666-6666-4666-8666-%012d", index), body = Data("payload:\n - DOMAIN,candidate-\(index).invalid\n".utf8)
                        guard mkdir(root + "/" + id, 0o700) == 0 else { throw Injected.unavailable }
                        try body.write(to: URL(fileURLWithPath: root + "/" + id + "/" + id + ".yaml"), options: .withoutOverwriting); chmod(root + "/" + id + "/" + id + ".yaml", 0o600)
                        let old = (snapshot["providers"] as! [[String: Any]])[0]
                        let extra: [String: Any] = ["provider": "%41", "configurationRevision": snapshot["configurationRevision"]!, "expectedGenerationSHA256": snapshot["generationSHA256"]!,
                            "oldSHA256": old["fileSHA256"]!, "newSHA256": RelayTunAppBundle.digest(body), "blobId": id, "kind": "rule-yaml", "bytes": body.count, "filename": id + ".yaml", "declaredRuleCount": 1]
                        requestId += 1; try rulesSend(request[1], binding: binding, id: requestId, action: "replace", extra: extra); return requestId
                    }
                    if scenario == "provider-normal" {
                        for index in 1...6 {
                            _ = try replace(index); let receipt = try rulesLine(response[0])
                            check(receipt["status"] as? String == "updated", "persistent provider controller publication \(index) updates both aliases")
                            guard let next = receipt["snapshot"] as? [String: Any] else { throw Injected.unavailable }; snapshot = next
                        }
                        check(puts == Array(repeating: ["%41", "one"], count: 6).flatMap { $0 } && probes == 6, "every alias receives one fixed PUT per actual candidate with no retries")
                        let retained = try FileManager.default.contentsOfDirectory(atPath: coreDirectory + "/RelayRuleProviderStages")
                        check(retained.count == 4, "persistent controller retains four confirmed old files and prunes the exact FIFO prefix")
                        requestId += 1; try rulesSend(request[1], binding: binding, id: requestId, action: "read")
                        check(try rulesLine(response[0])["status"] as? String == "snapshot", "post-publication metadata read matches confirmed ledger rather than adopting a new head")
                    } else if scenario == "provider-unknown" {
                        failPUT = true; _ = try replace(1); let unknown = try rulesLine(response[0])
                        check(unknown["status"] as? String == "uncertain" && puts == ["%41"] && unknown["snapshot"] == nil, "lost first alias PUT result preserves possible active swap without retry or snapshot")
                        requestId += 1; try rulesSend(request[1], binding: binding, id: requestId, action: "read")
                        check(try rulesLine(response[0])["status"] as? String == "uncertain", "explicit read cannot reconcile an unknown provider result")
                    } else if scenario == "provider-probe-evidence" {
                        _ = try replace(1); let failed = try rulesLine(response[0])
                        check(failed["status"] as? String == "unavailable" && puts.isEmpty && probes == 0,
                            "private Probe prepare/cleanup failure cannot stage or swap any active file")
                        requestId += 1; try rulesSend(request[1], binding: binding, id: requestId, action: "read")
                        check(try rulesLine(response[0])["status"] as? String == "uncertain",
                            "private Probe registry failure isolates further publications without observation adoption")
                    } else {
                        gate.lock(); block = true; gate.unlock(); let operation = try replace(1)
                        guard entered.wait(timeout: .now() + 2) == .success else { throw Injected.unavailable }
                        if scenario == "provider-cancel" {
                            requestId += 1; try rulesSend(request[1], binding: binding, id: requestId, action: "cancel", extra: ["operationId": operation])
                            let cancelled = try rulesLine(response[0])
                            check(cancelled["pending"] as? Bool == true && puts.isEmpty && running, "cancel latches immediately while inert check still drains")
                            requestId += 1; try rulesSend(request[1], binding: binding, id: requestId, action: "read")
                            check(try rulesLine(response[0])["status"] as? String == "busy", "provider lane stays busy until worker actually settles")
                            proceed.signal(); let terminal = try rulesLine(response[0])
                            check(terminal["status"] as? String == "cancelled" && puts.isEmpty, "late cancelled inert result cannot stage or swap the active file")
                        } else {
                            session.inputEnded(); usleep(10000)
                            check(running && !session.canExit && disposals == 0, "control EOF cannot dispose Bundle while inert worker is still running")
                            proceed.signal(); session.waitForDisposal()
                            check(session.canExit && !running && stops == 1 && disposals == 1 && puts.isEmpty, "EOF drains inert worker before one stop, fresh recovery and lock release")
                        }
                    }
                    if scenario != "provider-control-loss" {
                        try control("stopCore"); try control("release"); try control("verifyRestored"); try control("dispose")
                        check(session.canExit && f.last()["closed"] as? Bool == true && stops == 1 && disposals == 1, scenario + ": owned stopped session disposes after fresh baseline")
                    }
                    if scenario == "provider-probe-evidence" {
                        check(try Data(contentsOf: URL(fileURLWithPath: probeEvidence + "/foreign")) == Data("unrecognized private probe evidence".utf8),
                            "restored session releases capability while unknown private Probe evidence remains untouched")
                    }
                    check(try Data(contentsOf: URL(fileURLWithPath: source + "/" + originalPath)) == originalBody && f.events.isEmpty,
                        scenario + ": immutable source remains unchanged and no helper or actual Core is invoked")
                }
            }
            for scenario in ["normal", "control-loss", "resource-fails", "lock-fails", "launch-fails", "post-spawn-fails", "readiness-fails", "readiness-retries", "readiness-field-fails", "readiness-child-exits", "readiness-revoked", "readiness-json-fails", "readiness-http-fails", "interface-remains", "baseline-changed", "child-still-running", "interface-recovers", "baseline-recovers", "normal-delayed-interface", "normal-delayed-baseline", "control-loss-delayed-interface", "control-loss-delayed-baseline", "protection-changed", "baseline-read-fails", "interface-read-fails", "clock-frozen", "baseline-after-deadline", "dispose-lock-fails", "restored-interface-changed", "restored-network-changed"] {
                try fixture(managed: true, extra: scenario == "normal" ? ["port": 18080] : [:]) { source, bootstrap in
                    let f = SessionFixture()
                    f.baseline = .init(networkSHA256: String(repeating: "c", count: 64), protectionSHA256: String(repeating: "d", count: 64))
                    var running = false, visible = false, permitted = true, starts = 0, stops = 0, releases = 0, reads = 0
                    var currentBaseline = f.baseline!, directory: String?
                    var recoveryReads = 0
                    var captureMode: String?, captureReadFails = false, listenerChecks = 0
                    var recoveryTime: UInt64 = 0, recoveryPauses = 0
                    var driver = f.driver()
                    driver.runtimeCaptureIdentity = { (revision: f.revision, clientSHA256: String(repeating: "c", count: 64)) }
                    let rulesLock = NSLock(), rulesEntered = DispatchSemaphore(value: 0), rulesRelease = DispatchSemaphore(value: 0)
                    var holdRules = false, rulesWrites = 0
                    var rulesTable = try RelayTunRuntimeRules.Snapshot([["index": 0, "type": "Match", "payload": "", "proxy": "REJECT", "extra": ["disabled": false]]])
                    driver.makeManagedCore = { bundle, authorized in
                        directory = bundle.directory
                        var reported = try RelayTunStrictJSON.object(bundle.configuration, limit: 2 * 1024 * 1024)
                        var tun = reported["tun"] as! [String: Any]
                        tun["file-descriptor"] = 0; tun["recvmsgx"] = true; tun["dns-mode"] = "disabled"
                        reported["tun"] = tun; reported["allow-lan"] = false; reported["ipv6"] = true
                        for port in ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"] { reported[port] = reported[port] ?? 0 }
                        let configs = try data(reported)
                        return try RelayTunManagedCore(configuration: bundle.configuration, baseline: bundle.baseline, authorized: { authorized() && permitted },
                            driver: .init(verify: {
                                if scenario == "resource-fails" { throw Injected.unavailable }
                                try bundle.verify()
                            }, hold: {
                                if scenario == "lock-fails" { throw Injected.unavailable }
                            }, launch: { register in
                                starts += 1
                                if scenario == "launch-fails" { throw Injected.unavailable }
                                running = true; visible = true
                                register(.init(observe: { running ? .running : .exited(0) }, stop: {
                                    stops += 1
                                    if scenario != "child-still-running" { running = false }
                                    if !["interface-remains", "interface-recovers"].contains(scenario) && !running { visible = false }
                                    if ["baseline-changed", "baseline-recovers", "clock-frozen", "baseline-after-deadline"].contains(scenario) {
                                        currentBaseline = .init(networkSHA256: String(repeating: "0", count: 64), protectionSHA256: currentBaseline.protectionSHA256)
                                    }
                                    if scenario == "protection-changed" {
                                        currentBaseline = .init(networkSHA256: currentBaseline.networkSHA256, protectionSHA256: String(repeating: "0", count: 64))
                                    }
                                    return .init(waitStatus: 0, forced: false)
                                }, read: { endpoint in
                                    reads += 1
                                    if scenario == "readiness-fails" { throw RelayTunCoreReadiness.Failure.resource }
                                    if scenario == "readiness-retries" && reads == 1 { throw RelayTunCoreReadiness.Failure.io(.version, .receive) }
                                    if scenario == "readiness-field-fails" { throw RelayTunCoreReadiness.Failure.field(.enable) }
                                    if scenario == "readiness-child-exits" {
                                        running = false
                                        throw RelayTunCoreReadiness.Failure.field(.enable)
                                    }
                                    if scenario == "readiness-revoked" {
                                        permitted = false
                                        throw RelayTunCoreReadiness.Failure.field(.enable)
                                    }
                                    if scenario == "readiness-json-fails" { throw RelayTunCoreReadiness.Failure.json(.configs) }
                                    if scenario == "readiness-http-fails" { throw RelayTunCoreReadiness.Failure.http(.configs) }
                                    if captureReadFails { throw Injected.unavailable }
                                    if endpoint == "configs", let captureMode {
                                        var changed = reported; changed["mode"] = captureMode; return try data(changed)
                                    }
                                    return endpoint == "version" ? try data(["version": "v1.19.33"]) : configs
                                }, verifyListeners: { ports, deadline in
                                    guard ports == [18080], RelayTunRuntimeCapture.now < deadline else { throw Injected.unavailable }
                                    listenerChecks += 1
                                }, readCapture: { endpoint, _ in
                                    reads += 1
                                    if captureReadFails { throw Injected.unavailable }
                                    if endpoint == "configs", let captureMode {
                                        var changed = reported; changed["mode"] = captureMode; return try data(changed)
                                    }
                                    return endpoint == "version" ? try data(["version": "v1.19.33"]) : configs
                                }, readRules: { access in
                                    rulesLock.lock(); let blocked = holdRules; rulesLock.unlock()
                                    if blocked { rulesEntered.signal(); guard rulesRelease.wait(timeout: .now() + 3) == .success else { throw Injected.unavailable } }
                                    try access.check(); rulesLock.lock(); defer { rulesLock.unlock() }; return rulesTable
                                }, applyRule: { mutation, access, verify in
                                    try verify(); rulesLock.lock(); let previous = rulesTable; rulesLock.unlock()
                                    guard previous.sha256 == mutation.expectedRulesSHA256 else { throw Injected.unavailable }
                                    try access.enterWrite()
                                    rulesLock.lock(); defer { rulesLock.unlock() }
                                    rulesWrites += 1; rulesTable = try previous.settingDisabled(index: mutation.index, value: mutation.disabled); return rulesTable
                                }))
                                if scenario == "post-spawn-fails" { throw Injected.unavailable }
                            }, interfacePresent: {
                                if stops > 0 && scenario == "interface-read-fails" { throw Injected.unavailable }
                                if stops > 0 && scenario.hasSuffix("delayed-interface") {
                                    recoveryReads += 1
                                    return recoveryReads < 3
                                }
                                return visible
                            }, baseline: {
                                if stops > 0 && scenario == "baseline-read-fails" { throw Injected.unavailable }
                                if stops > 0 && scenario.hasSuffix("delayed-baseline") {
                                    recoveryReads += 1
                                    if recoveryReads < 3 {
                                        return .init(networkSHA256: String(repeating: "0", count: 64), protectionSHA256: currentBaseline.protectionSHA256)
                                    }
                                }
                                return currentBaseline
                            }, dispose: {
                                if scenario == "dispose-lock-fails" { throw Injected.unavailable }
                                releases += 1
                            }), recoveryClock: .init(now: { recoveryTime }, pause: {
                                recoveryPauses += 1
                                if scenario != "clock-frozen" { recoveryTime += 50 }
                                if scenario == "baseline-after-deadline" { recoveryTime += 5_000; currentBaseline = f.baseline! }
                            }))
                    }
                    let session = try RelayTunAppSession(bootstrap: data(bootstrap), testDriver: driver, coreManaged: true)
                    f.session = session
                    let binding = bootstrap["binding"] as! [String: Any]
                    var id = 0
                    func send(_ action: String) throws {
                        id += 1; var frame = binding
                        frame["version"] = 1; frame["id"] = id; frame["action"] = action
                        try session.accept(JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys])); session.waitForDisposal()
                    }
                    try send("initialize")
                    if scenario == "normal" {
                        try send("inspectWorkDirectory")
                        check(f.last()["workDirectory"] is NSNull && starts == 0 && reads == 0,
                              "work directory proof is unavailable before the owned child starts")
                    }
                    try send("startCore")
                    let failureCodes = ["resource-fails": "managed.resource", "lock-fails": "managed.lock",
                        "launch-fails": "managed.spawn", "post-spawn-fails": "managed.spawn", "readiness-fails": "readiness.resource",
                        "readiness-field-fails": "readiness.field.tun.enable", "readiness-child-exits": "readiness.field.tun.enable",
                        "readiness-revoked": "readiness.field.tun.enable",
                        "readiness-json-fails": "readiness.json.configs", "readiness-http-fails": "readiness.http.configs"]
                    let failedStart = failureCodes[scenario] != nil
                    check(session.coreStartFailure == failureCodes[scenario], scenario + ": startup failures retain an exact allowlisted stage without private error text")
                    if ["readiness-json-fails", "readiness-http-fails", "readiness-child-exits", "readiness-revoked"].contains(scenario) {
                        check(reads == 1, scenario + ": terminal parse failure, child exit or revoked consent does not retry a control read")
                    }
                    if scenario == "readiness-retries" {
                        check(reads == 3 && starts == 1, "transient detailed IO failure retries observation without respawning")
                    }
                    if scenario == "readiness-field-fails" {
                        check(reads > 1 && reads < 1000 && starts == 1, "permanent field mismatch exhausts only the existing bounded observation window")
                    }
                    let observed = f.last()["observation"] as? [String: Any]
                    check(observed?["phase"] as? String == (failedStart ? "unknown" : "active"),
                          scenario + ": managed core starts directly into network-active phase or retains the failed owner")
                    check(f.events.isEmpty && f.fileDescriptor == -1,
                          scenario + ": managed path issues no helper RPC and receives no TUN descriptor")
                    if scenario == "normal" {
                        guard let directory else { throw Injected.unavailable }
                        let readsBeforeDirectory = reads
                        var info = stat()
                        guard lstat(directory, &info) == 0 else { throw Injected.unavailable }
                        var unboundRequest = binding
                        unboundRequest["version"] = 1; unboundRequest["id"] = id + 1
                        unboundRequest["action"] = "inspectWorkDirectory"
                        unboundRequest["sessionId"] = f.sessionID
                        do {
                            try session.accept(data(unboundRequest))
                            check(false, "work directory request rejects a different session binding")
                        } catch RelayTunAppSession.Failure.invalid {
                            check(true, "work directory request rejects a different session binding")
                        }
                        try send("inspectWorkDirectory")
                        let proof = f.last()
                        check(proof["workDirectory"] as? [String: String] == ["path": directory, "device": String(info.st_dev), "inode": String(info.st_ino)] &&
                              proof["sessionId"] as? String == binding["sessionId"] as? String &&
                              proof["evidenceSHA256"] as? String == binding["evidenceSHA256"] as? String &&
                              proof["runtimeConfigurationSHA256"] as? String == binding["runtimeConfigurationSHA256"] as? String,
                              "work directory proof binds the native-owned inode to the active session")
                        try {
                            let held = directory + "-held"
                            guard rename(directory, held) == 0 else { throw Injected.unavailable }
                            defer { _ = rename(held, directory) }
                            guard mkdir(directory, 0o700) == 0 else { throw Injected.unavailable }
                            try {
                                defer { _ = rmdir(directory) }
                                try send("inspectWorkDirectory")
                                check(f.last()["workDirectory"] is NSNull, "work directory proof refuses a replacement with matching mode and owner")
                            }()
                            guard symlink(held, directory) == 0 else { throw Injected.unavailable }
                            defer { _ = unlink(directory) }
                            try send("inspectWorkDirectory")
                            check(f.last()["workDirectory"] is NSNull, "work directory proof refuses a symlink to the original directory")
                        }()
                        permitted = false
                        try send("inspectWorkDirectory")
                        check(f.last()["workDirectory"] is NSNull, "work directory proof refuses a revoked managed owner")
                        permitted = true
                        running = false
                        try send("inspectWorkDirectory")
                        check(f.last()["workDirectory"] is NSNull, "work directory proof refuses an exited managed child")
                        running = true
                        try send("inspectWorkDirectory")
                        check(f.last()["workDirectory"] as? [String: String] == proof["workDirectory"] as? [String: String] &&
                              f.events.isEmpty && reads == readsBeforeDirectory && starts == 1 && stops == 0,
                              "work directory proof and denial use no helper, control socket read or lifecycle mutation")
                        func capture(_ deadline: UInt64 = RelayTunRuntimeCapture.now + RelayTunRuntimeCapture.duration) throws -> RelayTunRuntimeCapture.Result {
                            let done = DispatchSemaphore(value: 0); var result: RelayTunRuntimeCapture.Result?
                            session.captureRuntime(deadline: deadline) { result = $0; done.signal() }
                            guard done.wait(timeout: .now() + 4) == .success, let result else { throw Injected.unavailable }; return result
                        }
                        captureMode = "global"
                        let captured = try capture()
                        if case .captured(let snapshot) = captured {
                            check(snapshot.mode == "global" && snapshot.ports.map { $0.port } == [18080] &&
                                snapshot.originalLoadedSHA256 == binding["runtimeConfigurationSHA256"] as? String && listenerChecks == 1,
                                "read-only capture binds actual loaded bytes and observed mode without weakening startup")
                        } else { check(false, "read-only capture succeeds only for active held runtime") }
                        captureReadFails = true
                        check(try capture().status == "unavailable", "read-only failure is a fixed unavailable result")
                        captureReadFails = false; captureMode = nil
                        check(try capture(0).status == "busy", "expired queued read performs no observation")
                        try send("inspect")
                        check(stops == 0 && f.last()["observation"] as? [String: Any] != nil &&
                            (f.last()["observation"] as? [String: Any])?["phase"] as? String == "active",
                            "read failure and expiry leave original control active without stop or recovery")
                        var rulesRequest = [Int32](repeating: 0, count: 2), rulesResponse = rulesRequest
                        guard pipe(&rulesRequest) == 0, pipe(&rulesResponse) == 0,
                              fcntl(rulesRequest[1], F_SETNOSIGPIPE, 1) == 0 else { throw Injected.unavailable }
                        var rulesInput = rulesRequest[1]
                        defer { rulesRelease.signal(); if rulesInput >= 0 { Darwin.close(rulesInput) }; Darwin.close(rulesResponse[0]) }
                        try session.startRuntimeRules(input: rulesRequest[0], output: rulesResponse[1])
                        let rulesHello = try rulesLine(rulesResponse[0])
                        try rulesSend(rulesInput, binding: binding, id: 1, action: "read")
                        let ruleRead = try rulesLine(rulesResponse[0]), ruleSnapshot = ruleRead["snapshot"] as? [String: Any]
                        guard let configurationRevision = ruleSnapshot?["configurationRevision"] as? String,
                              let rulesSHA256 = ruleSnapshot?["rulesSHA256"] as? String else { throw Injected.unavailable }
                        let intent: [String: Any] = ["configurationRevision": configurationRevision, "rulesSHA256": rulesSHA256, "index": 0, "disabled": true]
                        try rulesSend(rulesInput, binding: binding, id: 2, action: "prepare", extra: intent)
                        let rulePlan = try rulesLine(rulesResponse[0])
                        guard let nonce = (rulePlan["prepared"] as? [String: Any])?["nonce"] as? String else { throw Injected.unavailable }
                        check(rulesHello["capability"] as? String == "runtime-rules-v1" && rulePlan["status"] as? String == "prepared" && rulesWrites == 0,
                              "actual AppSession private rules driver reads and prepares without mutation")
                        rulesLock.lock(); holdRules = true; rulesLock.unlock()
                        try rulesSend(rulesInput, binding: binding, id: 3, action: "commit", extra: ["nonce": nonce])
                        guard rulesEntered.wait(timeout: .now() + 2) == .success else { throw Injected.unavailable }
                        try rulesSend(rulesInput, binding: binding, id: 4, action: "cancel", extra: ["operationId": 2])
                        let ruleCancel = try rulesLine(rulesResponse[0])
                        try rulesSend(rulesInput, binding: binding, id: 5, action: "read")
                        let ruleBusy = try rulesLine(rulesResponse[0])
                        rulesLock.lock(); holdRules = false; rulesLock.unlock(); rulesRelease.signal()
                        let ruleSettled = try rulesLine(rulesResponse[0])
                        check(ruleCancel["status"] as? String == "cancelling" && ruleBusy["status"] as? String == "busy" && ruleSettled["status"] as? String == "cancelled" && rulesWrites == 0,
                              "actual AppSession blocked mutation queue still accepts pipe cancellation before any write")
                        try rulesSend(rulesInput, binding: binding, id: 6, action: "prepare", extra: intent)
                        let nextPlan = try rulesLine(rulesResponse[0])
                        guard let nextNonce = (nextPlan["prepared"] as? [String: Any])?["nonce"] as? String else { throw Injected.unavailable }
                        try rulesSend(rulesInput, binding: binding, id: 7, action: "commit", extra: ["nonce": nextNonce])
                        check(try rulesLine(rulesResponse[0])["status"] as? String == "changed" && rulesWrites == 1 && stops == 0,
                              "actual AppSession settled cancellation leaves new explicit one-bit commit usable")
                        Darwin.close(rulesInput); rulesInput = -1
                        var rulesEOF = pollfd(fd: rulesResponse[0], events: Int16(POLLIN), revents: 0), eofByte: UInt8 = 0
                        let rulesClosed = poll(&rulesEOF, 1, 1000) > 0 && Darwin.read(rulesResponse[0], &eofByte, 1) == 0
                        try send("inspect")
                        check(rulesClosed && stops == 0 && (f.last()["observation"] as? [String: Any])?["phase"] as? String == "active",
                              "actual AppSession rules EOF keeps original lifecycle/control active without stop or recovery")
                    }
                    let recovered = !["interface-remains", "baseline-changed", "child-still-running", "protection-changed", "baseline-read-fails", "interface-read-fails", "clock-frozen", "baseline-after-deadline", "dispose-lock-fails", "restored-interface-changed", "restored-network-changed"].contains(scenario)
                    if scenario == "normal" || scenario.hasPrefix("normal-delayed-") {
                        try send("stopCore")
                        if scenario == "normal" {
                            try send("inspectWorkDirectory")
                            check(f.last()["workDirectory"] is NSNull && stops == 1,
                                  "work directory proof refuses a stopped owner without interrupting restoration")
                        }
                        try send("release"); try send("verifyRestored"); try send("dispose")
                        check(session.canExit && f.last()["closed"] as? Bool == true,
                              scenario + ": one explicit stop observes restoration without repeating core shutdown")
                    } else if scenario.hasPrefix("restored-") {
                        try send("stopCore"); try send("release"); try send("verifyRestored")
                        check((f.last()["observation"] as? [String: Any])?["phase"] as? String == "restored", scenario + ": restoration first has positive evidence")
                        if scenario == "restored-interface-changed" { visible = true }
                        else { currentBaseline = .init(networkSHA256: String(repeating: "0", count: 64), protectionSHA256: currentBaseline.protectionSHA256) }
                        try send("dispose")
                        let code = scenario == "restored-interface-changed" ? "restore.interface-changed" : "restore.network-changed"
                        check(!session.canExit && f.last()["closed"] as? Bool == false && recoveryPauses == 0 && session.recoveryFailureCode == code,
                              scenario + ": a later external change rejects disposal immediately without a new observation window")
                    } else if ["interface-recovers", "baseline-recovers"].contains(scenario) {
                        try send("stopCore")
                        check((f.last()["observation"] as? [String: Any])?["phase"] as? String == "coreStopped" && stops == 1,
                              scenario + ": explicit child-stop receipt precedes failed restoration verification")
                        try send("release")
                        check(!running && !session.canExit && releases == 0 &&
                              (f.last()["observation"] as? [String: Any])?["phase"] as? String == "unknown",
                              scenario + ": stopped child alone does not release ownership after a failed baseline or device check")
                        if let directory {
                            check(FileManager.default.fileExists(atPath: directory),
                                  scenario + ": failed explicit recovery retains its runtime evidence")
                        }
                        // Deterministic external observation change; no timer,
                        // real device, DNS operation or repeated child stop.
                        visible = false; currentBaseline = f.baseline!
                        try send("inspect")
                        check((f.last()["observation"] as? [String: Any])?["phase"] as? String == "unknown" && releases == 0,
                              scenario + ": observation alone cannot promote an uncertain session to restored")
                        try send("release")
                        check((f.last()["observation"] as? [String: Any])?["phase"] as? String == "unknown" && releases == 0,
                              scenario + ": status reading cannot silently dispose an uncertain session")
                        try send("stopCore"); try send("release"); try send("verifyRestored"); try send("dispose")
                        check(session.canExit && f.last()["closed"] as? Bool == true && starts == 1 && stops == 1 && releases == 1,
                              scenario + ": explicit recovery retry completes on the same owner without restarting or signalling the child twice")
                    } else {
                        session.inputEnded(); session.waitForDisposal()
                        let record = try RelayTunStrictJSON.object(Data(contentsOf: URL(fileURLWithPath: source + "/recovery.json")), limit: 4096)
                        check(session.canExit == recovered && record["status"] as? String == (recovered ? "restored" : "uncertain"),
                              scenario + ": managed control loss requires positive child exit, device absence and original baseline")
                        if !recovered {
                            check(record["failureStage"] as? String == session.recoveryFailureCode && session.recoveryFailureCode != nil,
                                  scenario + ": control loss retains its failure stage after the parent log pipe is gone")
                            session.inputEnded(); session.waitForDisposal()
                            check(stops == 1, scenario + ": repeated EOF does not replay child shutdown")
                        }
                    }
                    if let code = session.recoveryFailureCode { recoveryDiagnosticCodes.insert(code) }
                    let beforeLaunch = ["resource-fails", "lock-fails"].contains(scenario)
                    if scenario.contains("delayed-") {
                        check(recoveryReads >= 3 && recoveryPauses == 2 && session.recoveryFailureCode == nil,
                              scenario + ": finite read-only observation completes without issuing an extra shutdown")
                    }
                    if ["interface-remains", "baseline-changed"].contains(scenario) {
                        check(recoveryPauses == 100 && session.recoveryFailureCode == (scenario == "interface-remains" ? "restore.interface-deadline" : "restore.network-deadline"),
                              scenario + ": fixed observation budget expires with a precise code and retained ownership")
                    }
                    let recoveryCodes = ["protection-changed": "restore.protection", "baseline-read-fails": "restore.baseline-read",
                        "interface-read-fails": "restore.interface-read", "clock-frozen": "restore.network-deadline",
                        "baseline-after-deadline": "restore.network-deadline", "dispose-lock-fails": "dispose.lock"]
                    if let code = recoveryCodes[scenario] {
                        let pauses = scenario == "clock-frozen" ? 100 : scenario == "baseline-after-deadline" ? 1 : 0
                        check(session.recoveryFailureCode == code && recoveryPauses == pauses,
                              scenario + ": terminal failures and exhausted deadlines do not retry or weaken the original baseline")
                    }
                    check(starts == (beforeLaunch ? 0 : 1) && stops == (beforeLaunch || scenario == "launch-fails" ? 0 : 1),
                          scenario + ": managed recovery never retries launch or signals an unowned process")
                    check(releases == (recovered ? 1 : 0),
                          scenario + ": installation ownership is released only after verified recovery")
                    if let directory {
                        check(FileManager.default.fileExists(atPath: directory) == (!recovered && scenario != "dispose-lock-fails"),
                              scenario + ": unverified recovery retains the private runtime")
                        if FileManager.default.fileExists(atPath: directory) { try FileManager.default.removeItem(atPath: directory) }
                    }
                }
            }
        } catch { rows.append(["name": "unexpected session fixture failure", "passed": false, "error": String(describing: error)]) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "recoveryDiagnosticCodes": recoveryDiagnosticCodes.sorted(),
            "backend": "actual AppSession control dispatcher with compile-time injected helper/core/baseline capabilities",
            "helperConnected": false, "coreStarted": false, "actualNetworkConfigurationChanged": false]
        if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) { print(String(decoding: bytes, as: UTF8.self)) }
        exit(passed == rows.count ? 0 : 1)
    }
}
