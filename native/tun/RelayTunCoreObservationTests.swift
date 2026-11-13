import Foundation
import Darwin

private typealias Observation = RelayTunCoreObservation
private typealias Host = RelayTunCoreHost
private enum Injected: Error { case failed }
private final class Fixture {
    let configuration = Data("PRIVATE checked launch fixture".utf8)
    let binding: Host.Binding
    var reads = 0, starts = 0, stops = 0, closes = 0
    var state: RelayTunCoreProbePlan.ChildState = .running
    var closed = false, failReadiness = false
    init() throws {
        let receipt = try RelayTunAcquiredReceipt(installationRevision: String(repeating: "a", count: 64), clientUID: getuid(),
            evidenceSHA256: String(repeating: "b", count: 64), runtimeConfigurationSHA256: RelayTunHelperTrust.digest(configuration),
            planID: "11111111-1111-4111-8111-111111111111", sessionID: "22222222-2222-4222-8222-222222222222",
            deviceID: "33333333-3333-4333-8333-333333333333", interfaceName: "utun42", interfaceIndex: 91,
            controlID: 17, controlUnit: 43, socketDevice: "7", socketInode: "18446744073709551615")
        binding = try .init(receipt: receipt, coreSHA256: RelayTunInstallationPaths.fixedCorePins["arm64"]!.0)
    }
    func host() throws -> Host {
        try Host(binding: binding, configuration: configuration, driver: .init(ordinaryUID: Host.productionOrdinaryUID,
            verifyResource: { _ in }, admit: { _ in .init(verify: { self.binding.receipt }, launch: { bound, bytes, register in
                guard bound == self.binding, bytes == self.configuration else { throw Injected.failed }
                self.starts += 1
                register(.init(poll: { self.state }, stop: {
                    self.stops += 1; self.state = .exited(0); return .init(waitStatus: 0, forced: false)
                }, readiness: {
                    self.reads += 1; if self.failReadiness { throw Injected.failed }
                    return .init(binding: self.binding, runtimeConfigurationSHA256: self.binding.receipt.runtimeConfigurationSHA256,
                                 coreVersion: RelayTunCoreProbePlan.version, inheritedDescriptor: 3)
                }))
            }, spawnAbsent: { self.starts == 0 }, close: { self.closes += 1; self.closed = true }, closed: { self.closed }) }))
    }
    func changedReceipt(_ key: String) throws -> RelayTunAcquiredReceipt {
        var object = try Observation.receiptObject(binding.receipt)
        switch key {
        case "clientUID": object[key] = getuid() + 1
        case "interfaceIndex", "controlID": object[key] = 92
        case "interfaceName": object[key] = "utun43"; object["controlUnit"] = 44
        case "socketDevice": object[key] = "8"
        case "socketInode": object[key] = "0"
        case "installationRevision", "evidenceSHA256", "runtimeConfigurationSHA256": object[key] = String(repeating: "c", count: 64)
        default: object[key] = "44444444-4444-4444-8444-444444444444"
        }
        return try Observation.receipt(object)
    }
}
private final class ResultBox {
    private let lock = NSLock()
    private var stored: String?
    func set(_ value: String?) { lock.lock(); stored = value; lock.unlock() }
    func get() -> String? { lock.lock(); defer { lock.unlock() }; return stored }
}

@main struct RelayTunCoreObservationTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), getgid() == getegid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ value: Bool, _ name: String) { rows.append(["name": name, "passed": value]) }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); check(false, name) } catch { check(true, name) }
        }
        func observer(_ endpoint: RelayTunCoreObservationEndpoint) throws -> RelayTunCoreObserver {
            var counter: UInt64 = 0
            return try .init(nonce: {
                counter += 1; return String(repeating: "0", count: 48) + String(format: "%016llx", counter)
            }, query: endpoint.query)
        }
        func data(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
        do {
            let initialRecovery = Host.recoveryCount, f = try Fixture(), host = try f.host()
            let endpoint = RelayTunCoreObservationEndpoint(host: host), client = try observer(endpoint)
            check(host.observationBinding == f.binding, "endpoint derives exact immutable binding from its held host")
            check(client.runtime(f.binding.receipt) == nil && !client.released(f.binding.receipt), "idle observations never invent readiness or release")
            _ = try host.start()
            check(client.runtime(f.binding.receipt) == f.binding.receipt.runtimeConfigurationSHA256,
                  "runtime callback reports held launch digest only after fresh host observations")
            check(f.reads == 2 && f.starts == 1 && f.stops == 0 && f.closes == 0,
                  "runtime query freshly reads held child and never spawns, stops or closes")
            check(!client.released(f.binding.receipt), "a live host cannot claim core/FD release")
            host.suspend(); check(client.runtime(f.binding.receipt) == nil, "revoked host cannot provide runtime readiness")
            _ = try host.release(); check(client.released(f.binding.receipt), "release callback requires exact host's terminal proof")
            check(f.stops == 1 && f.closes == 1, "observation calls perform no extra lifecycle operation")

            let f2 = try Fixture(), h2 = try f2.host(); _ = try h2.start()
            let ep2 = RelayTunCoreObservationEndpoint(host: h2)
            for key in ["installationRevision", "clientUID", "planID", "sessionID", "deviceID", "evidenceSHA256", "runtimeConfigurationSHA256",
                        "interfaceName", "interfaceIndex", "controlID", "socketDevice", "socketInode"] {
                let changed = try f2.changedReceipt(key), before = f2.reads, wrong = try observer(ep2)
                check(wrong.runtime(changed) == nil && !wrong.released(changed), "full receipt mismatch fails closed: " + key)
                check(f2.reads == before, "receipt mismatch never reaches host observation: " + key)
            }
            let nonce = String(repeating: "d", count: 64)
            let request = try Observation.request(receipt: f2.binding.receipt, operation: .runtime, nonce: nonce)
            var raw = try RelayTunStrictJSON.object(request)
            check(Set(raw.keys) == ["version", "operation", "nonce", "receipt"] && !String(decoding: request, as: UTF8.self).contains("PRIVATE"),
                  "query exports only nonce, operation and receipt without configuration, path or PID")
            let malformed: [Data] = [Data(), Data([0xff]), Data("[]".utf8),
                Data(String(decoding: request, as: UTF8.self).replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"version\":1").utf8),
                Data(String(decoding: request, as: UTF8.self).replacingOccurrences(of: "\"nonce\":", with: "\"nonce\":\"\(nonce)\",\"\\u006eonce\":").utf8),
                Data(repeating: 32, count: Observation.maximumBytes + 1)]
            for bytes in malformed {
                var reply = Data([1]); ep2.query(bytes as NSData, withReply: { reply = Data(referencing: $0) })
                check(reply.isEmpty, "endpoint rejects malformed, duplicate, UTF8 or oversized requests without a claim")
            }
            for key in ["version", "operation", "nonce", "receipt"] {
                var changed = raw; changed.removeValue(forKey: key)
                var reply = Data([1]); ep2.query(try data(changed) as NSData, withReply: { reply = Data(referencing: $0) })
                check(reply.isEmpty, "request cannot omit required field: " + key)
            }
            raw["pid"] = 1
            var extraReply = Data([1]); ep2.query(try data(raw) as NSData, withReply: { extraReply = Data(referencing: $0) })
            check(extraReply.isEmpty, "endpoint refuses extra caller-selected process fields")
            for operation in [Observation.Operation.runtime, .released] {
                let good = try Observation.response(receipt: f2.binding.receipt, operation: operation, nonce: nonce,
                    result: operation == .runtime ? .runtime(f2.binding.receipt.runtimeConfigurationSHA256) : .released(true), available: true)
                for key in ["version", "operation", "nonce", "receipt", "status", operation == .runtime ? "runtimeConfigurationSHA256" : "released"] {
                    var changed = try RelayTunStrictJSON.object(good)
                    switch key {
                    case "version": changed[key] = true
                    case "operation": changed[key] = operation == .runtime ? "released" : "runtime"
                    case "nonce": changed[key] = String(repeating: "e", count: 64)
                    case "receipt": changed[key] = try Observation.receiptObject(f2.changedReceipt("sessionID"))
                    case "status": changed[key] = "unknown"
                    case "released": changed[key] = 1
                    default: changed[key] = String(repeating: "e", count: 64)
                    }
                    rejects("response binds exact \(operation.rawValue) field: " + key) {
                        _ = try Observation.decodeResponse(data(changed), receipt: f2.binding.receipt, operation: operation, nonce: nonce)
                    }
                }
                let duplicate = Data(String(decoding: good, as: UTF8.self).replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"\\u0076ersion\":1").utf8)
                rejects("response rejects escaped duplicate keys for " + operation.rawValue) {
                    _ = try Observation.decodeResponse(duplicate, receipt: f2.binding.receipt, operation: operation, nonce: nonce)
                }
                var unavailable = try RelayTunStrictJSON.object(good); unavailable["status"] = "unavailable"
                rejects("unavailable cannot carry positive proof for " + operation.rawValue) {
                    _ = try Observation.decodeResponse(data(unavailable), receipt: f2.binding.receipt, operation: operation, nonce: nonce)
                }
            }
            do {
                var captured: [Data] = []
                let unique = try RelayTunCoreObserver(query: { input, reply in
                    captured.append(Data(bytes: input.bytes, count: input.length)); ep2.query(input, withReply: reply)
                })
                check(unique.runtime(f2.binding.receipt) != nil && unique.runtime(f2.binding.receipt) != nil, "fresh secure nonces support separate observations")
                let first = try Observation.decodeRequest(captured[0]), second = try Observation.decodeRequest(captured[1])
                check(first.2 != second.2 && first.2.count == 64 && second.2.count == 64, "each request uses new 256-bit nonce")
            }
            do {
                var calls = 0
                let repeated = try RelayTunCoreObserver(nonce: { nonce }, query: { input, reply in calls += 1; ep2.query(input, withReply: reply) })
                check(repeated.runtime(f2.binding.receipt) != nil && repeated.runtime(f2.binding.receipt) == nil && calls == 1,
                      "locally repeated nonce is refused before another transport call")
            }
            do {
                var replay: NSData?
                let replayer = try RelayTunCoreObserver(query: { input, reply in
                    if let replay { reply(replay) } else { ep2.query(input, withReply: { replay = $0; reply($0) }) }
                })
                check(replayer.runtime(f2.binding.receipt) != nil && replayer.runtime(f2.binding.receipt) == nil, "valid old response cannot satisfy fresh nonce")
                let duplicate = try RelayTunCoreObserver(query: { input, reply in ep2.query(input, withReply: { reply($0); reply($0) }) })
                check(duplicate.runtime(f2.binding.receipt) == nil && !duplicate.released(f2.binding.receipt), "duplicate completion before invocation returns invalidates observer")
                let mutable = try RelayTunCoreObserver(query: { input, reply in ep2.query(input, withReply: {
                    let data = NSMutableData(data: Data(referencing: $0)); reply(data); data.length = 0
                }) })
                check(mutable.runtime(f2.binding.receipt) != nil, "callback bytes are copied before mutable sender storage changes")
            }
            do {
                // Reproduce the original placement: local trust work ran inside
                // the transport closure and consumed the remote response limit.
                let finished = DispatchSemaphore(value: 0)
                var sends = 0
                let misplacedTrust = try RelayTunCoreObserver(query: { input, reply in
                    Thread.sleep(forTimeInterval: 1.1)
                    sends += 1; endpoint.query(input, withReply: reply); finished.signal()
                })
                check(!misplacedTrust.released(f.binding.receipt),
                      "controlled local verification inside transport consumes the original one-second response deadline")
                check(finished.wait(timeout: .now() + 2) == .success,
                      "late valid release proof finishes after the controlled local verification delay")
                check(!misplacedTrust.released(f.binding.receipt) && sends == 1,
                      "the old placement permanently invalidates the observer despite a valid released host")
            }
            do {
                var verifications = 0, sends = 0
                let verified = try RelayTunCoreObserver(verifyLocalTrust: {
                    verifications += 1; Thread.sleep(forTimeInterval: 1.1)
                }, query: { input, reply in
                    sends += 1; endpoint.query(input, withReply: reply)
                })
                check(verified.released(f.binding.receipt) && verifications == 1 && sends == 1,
                      "complete local verification may exceed the remote deadline before a timely release response")
                check(verified.released(f.binding.receipt) && verifications == 2 && sends == 2,
                      "each subsequent observation revalidates local trust instead of caching its identity")
                var deniedVerifications = 0, deniedSends = 0
                let denied = try RelayTunCoreObserver(verifyLocalTrust: {
                    deniedVerifications += 1; throw Injected.failed
                }, query: { _, _ in deniedSends += 1 })
                check(!denied.released(f.binding.receipt) && deniedVerifications == 1 && deniedSends == 0,
                      "failed local identity verification sends no remote query and cannot claim release")
                check(!denied.released(f.binding.receipt) && deniedVerifications == 1 && deniedSends == 0,
                      "local identity failure still invalidates the observer without an automatic retry")
            }
            do {
                let gate = DispatchSemaphore(value: 0), returned = DispatchSemaphore(value: 0)
                let blocked = try RelayTunCoreObserver(timeoutMilliseconds: 20, query: { input, reply in
                    ep2.query(input, withReply: reply); _ = gate.wait(timeout: .now() + 2); returned.signal()
                })
                let start = DispatchTime.now().uptimeNanoseconds
                check(blocked.runtime(f2.binding.receipt) == nil && DispatchTime.now().uptimeNanoseconds - start < 500_000_000,
                      "blocking invocation cannot exceed deadline even after early callback")
                gate.signal(); check(returned.wait(timeout: .now() + 1) == .success, "blocked injected invocation exits without leaked worker")
                check(blocked.runtime(f2.binding.receipt) == nil, "timed-out transport cannot be reused automatically")
            }
            do {
                let completed = DispatchSemaphore(value: 0)
                let asynchronous = try RelayTunCoreObserver(query: { input, reply in
                    DispatchQueue.global().async {
                        ep2.query(input, withReply: reply); completed.signal()
                    }
                })
                check(asynchronous.runtime(f2.binding.receipt) == f2.binding.receipt.runtimeConfigurationSHA256,
                      "callback arriving after transport invocation returns can provide fresh bound observation")
                check(completed.wait(timeout: .now() + 1) == .success, "asynchronous injected callback finishes")
                let late = try RelayTunCoreObserver(timeoutMilliseconds: 5, query: { input, reply in
                    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(30)) {
                        ep2.query(input, withReply: reply); completed.signal()
                    }
                })
                check(late.runtime(f2.binding.receipt) == nil, "late response cannot satisfy expired deadline")
                check(completed.wait(timeout: .now() + 1) == .success, "late injected callback is safely delivered after retirement")
                check(late.runtime(f2.binding.receipt) == nil && !late.released(f2.binding.receipt),
                      "late callback cannot resurrect a retired observation or its transport")
            }
            for bytes in [Data(), Data([0xff]), Data("[]".utf8), Data(repeating: 32, count: Observation.maximumBytes + 1)] {
                let malformed = try RelayTunCoreObserver(query: { _, reply in reply(bytes as NSData) })
                check(malformed.runtime(f2.binding.receipt) == nil && !malformed.released(f2.binding.receipt),
                      "empty, invalid UTF8, wrong-shape or oversized callback never becomes positive proof")
            }
            do {
                let sent = DispatchSemaphore(value: 0), gate = DispatchSemaphore(value: 0), returned = DispatchSemaphore(value: 0)
                let concurrent = try RelayTunCoreObserver(query: { input, reply in
                    sent.signal(); _ = gate.wait(timeout: .now() + 2); ep2.query(input, withReply: reply)
                })
                let result = ResultBox()
                DispatchQueue.global().async { result.set(concurrent.runtime(f2.binding.receipt)); returned.signal() }
                check(sent.wait(timeout: .now() + 1) == .success, "overlap fixture holds one bounded observation")
                check(!concurrent.released(f2.binding.receipt), "overlapping query cannot invent release or enter transport")
                gate.signal(); check(returned.wait(timeout: .now() + 1) == .success && result.get() == f2.binding.receipt.runtimeConfigurationSHA256,
                                     "busy refusal does not invalidate pending legitimate observation")
            }
            do {
                let noReply = try RelayTunCoreObserver(timeoutMilliseconds: 5, query: { _, _ in })
                check(noReply.runtime(f2.binding.receipt) == nil && !noReply.released(f2.binding.receipt), "missing callback remains unknown and never released")
                for value in [0, -1, 5001] { rejects("deadline bounds reject \(value)") { _ = try RelayTunCoreObserver(timeoutMilliseconds: value, query: { _, _ in }) } }
                let invalidNonce = try RelayTunCoreObserver(nonce: { "bad" }, query: { _, _ in check(false, "invalid nonce reached transport") })
                check(invalidNonce.runtime(f2.binding.receipt) == nil, "invalid generated nonce fails before transport")
            }
            f2.failReadiness = true
            let uncertain = try observer(ep2)
            check(uncertain.runtime(f2.binding.receipt) == nil && !uncertain.released(f2.binding.receipt), "failed fresh runtime observation cannot become positive state")
            _ = try h2.release()
            check(Host.recoveryCount == initialRecovery, "all injected owners explicitly released after observation tests")
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failures = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failures == 0, "checksPassed": rows.count - failures, "checksTotal": rows.count,
            "callbackContractBuilt": true, "authenticatedXPCConnected": false, "helperMainConnected": false,
            "ordinaryUIDInjectedHostOnly": true, "actualCoreLaunched": false, "actualTunCreated": false,
            "systemConfigurationChanged": false, "checks": rows]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failures > 0 { exit(1) }
    }
}
