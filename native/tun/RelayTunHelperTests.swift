import Foundation
import Security
import Darwin

/// This runner compiles with fake-FS trust injection. It never creates a Mach
/// listener/client, invokes loadLive(), opens root paths or creates a TUN.
@main struct RelayTunHelperTests {
    static func main() {
        var rows: [[String: Any]] = []
        func check(_ pass: Bool, _ name: String) { rows.append(["passed": pass, "name": name]) }
        func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
        func bytes(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
        let code: [String: Any] = ["sha256": String(repeating: "a", count: 64), "size": 4096, "cdhashes": ["arm64": String(repeating: "a", count: 40), "x86_64": String(repeating: "b", count: 40)]]
        do {
            let daemonData = try PropertyListSerialization.data(fromPropertyList: RelayTunInstallationPaths.launchDaemonConfiguration, format: .xml, options: 0)
            let manifest: [String: Any] = ["version": 2, "role": "network-executor-v1", "service": RelayTunInstallationPaths.service, "clientUID": 501, "helper": code, "client": code, "uninstaller": code, "launchDaemonSHA256": RelayTunHelperTrust.digest(daemonData), "cores": ["arm64": ["sha256": "f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9", "size": 56810034], "x86_64": ["sha256": "291f5923c3dd3b8df36eaeccdd59eaf873ee021693cde65eb696f8b86ac99652", "size": 60945968]]]
            let encoded = try bytes(manifest), trust = try RelayTunHelperTrust.testInstallation(manifest: encoded)
            check(trust.clientUID == 501 && trust.revision == RelayTunHelperTrust.digest(encoded), "fake root metadata and exact manifest bind authorized UID and revision")
            check(trust.uninstaller.sha256 == code["sha256"] as? String && trust.launchDaemonSHA256 == RelayTunHelperTrust.digest(daemonData), "uninstaller role and exact launch configuration are pinned by the same installation")
            let removal = RelayTunRemovalPlan(trust: trust)
            check(Set(removal.pins.keys) == Set(RelayTunInstallationPaths.files), "removal plan contains only the seven fixed candidate files")
            let intent = try removal.intentData(), resumed = try RelayTunRemovalPlan.parseIntent(intent, expectedManifestSHA256: trust.revision)
            check(resumed.clientUID == trust.clientUID && resumed.pins == removal.pins, "strict root intent preserves only the original candidate UID and fixed removal pins")
            let formattedIntent = try JSONSerialization.data(withJSONObject: RelayTunStrictJSON.object(intent), options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            check(try RelayTunRemovalPlan.parseIntent(formattedIntent, expectedManifestSHA256: trust.revision).pins == removal.pins, "predeployed Python-style intent and Swift intent compare by strictly parsed typed pins")
            rejects("removal intent cannot authorize a different installation revision") { _ = try RelayTunRemovalPlan.parseIntent(intent, expectedManifestSHA256: String(repeating: "f", count: 64)) }
            var hostileIntent = try RelayTunStrictJSON.object(intent); var hostilePins = removal.pins; hostilePins["/Library/keep-other-app"] = String(repeating: "a", count: 64); hostileIntent["pins"] = hostilePins
            rejects("removal intent cannot contain an arbitrary root path") { _ = try RelayTunRemovalPlan.parseIntent(bytes(hostileIntent), expectedManifestSHA256: trust.revision) }
            let ownJob = "system/\(RelayTunInstallationPaths.service) = {\npath = \(RelayTunInstallationPaths.launchDaemon)\nprogram = \(RelayTunInstallationPaths.helper)\narguments = {\n\(RelayTunInstallationPaths.helper)\n--serve\n}\n}"
            check(RelayTunLoadedJob.matches(Data(ownJob.utf8)), "closed job parser accepts only the fixed daemon program and serve argument")
            check(!RelayTunLoadedJob.matches(Data(ownJob.replacingOccurrences(of: "program = " + RelayTunInstallationPaths.helper, with: "program = /bin/sh").utf8)), "same-label foreign program is refused before bootout")
            check(!RelayTunLoadedJob.matches(Data(ownJob.replacingOccurrences(of: "--serve", with: "--serve\n--unknown").utf8)), "same-label extra arguments are refused before bootout")
            check(try !RelayTunReceiptInventory.containsCandidate(status: 0, data: Data()), "successful empty receipt inventory means original absence")
            check(try !RelayTunReceiptInventory.containsCandidate(status: 0, data: Data("com.apple.fixture\nlocal.other.package\n".utf8)), "successful unrelated receipt inventory means original absence")
            check(try RelayTunReceiptInventory.containsCandidate(status: 0, data: Data(("com.apple.fixture\n" + RelayTunInstallationPaths.receiptID + "\nlocal.other.package\n").utf8)), "only an exact receipt line triggers candidate receipt validation")
            check(try !RelayTunReceiptInventory.containsCandidate(status: 0, data: Data((RelayTunInstallationPaths.receiptID + ".extra\nx" + RelayTunInstallationPaths.receiptID + "\nlocalXrelayXnetworkXtunXfeasibility\n").utf8)), "similar receipt IDs cannot match the fixed candidate receipt")
            rejects("failed empty receipt inventory cannot mean absence") { _ = try RelayTunReceiptInventory.containsCandidate(status: 1, data: Data()) }
            rejects("failed receipt inventory with partial output cannot authorize cleanup") { _ = try RelayTunReceiptInventory.containsCandidate(status: 2, data: Data("com.apple.fixture\n".utf8)) }
            rejects("duplicate exact candidate receipts are refused") { _ = try RelayTunReceiptInventory.containsCandidate(status: 0, data: Data((RelayTunInstallationPaths.receiptID + "\n" + RelayTunInstallationPaths.receiptID + "\n").utf8)) }
            rejects("invalid receipt inventory encoding is refused") { _ = try RelayTunReceiptInventory.containsCandidate(status: 0, data: Data([0xff])) }
            rejects("NUL in receipt inventory is refused") { _ = try RelayTunReceiptInventory.containsCandidate(status: 0, data: Data("com.apple.fixture\0\n".utf8)) }
            var extraChildren = RelayTunRemovalPlan.expectedChildren; extraChildren[RelayTunInstallationPaths.container]!.insert("keep-existing-app")
            rejects("unknown installation children prevent removal planning") { try RelayTunRemovalPlan.checkChildren(extraChildren) }
            try RelayTunRemovalPlan.checkChildren([RelayTunInstallationPaths.root: []], allowMissing: true)
            check(true, "resume permits only missing known files and directories")
            for failure in ["none", "preflight", "bootout", "changedAfterBootout", "delete", "forget", "finalPresence", "selfDelete", "resume", "prePayloadFailure"] {
                let resuming = ["resume", "prePayloadFailure"].contains(failure)
                var events: [String] = [], loaded = !resuming, receipt = failure != "prePayloadFailure", remaining = resuming ? Set([RelayTunInstallationPaths.uninstaller]) : Set(RelayTunInstallationPaths.files), directories = resuming ? Set<String>() : Set(RelayTunInstallationPaths.ownedDirectories), verifies = 0, intentPresent = true
                let environment = RelayTunRemovalPlan.Environment(verify: {
                    verifies += 1; events.append("verify")
                    if failure == "preflight" || (failure == "changedAfterBootout" && verifies == 2) { throw RelayTunHelperFailure.changedResource }
                }, jobPresent: { loaded }, bootout: {
                    events.append("bootout"); if failure == "bootout" { throw RelayTunHelperFailure.unsafeInstallation }; loaded = false
                }, receiptPresent: { receipt }, removeFile: { path, pin in
                    events.append("delete"); guard removal.pins[path] == pin, failure != "delete", !(failure == "selfDelete" && path == RelayTunInstallationPaths.uninstaller) else { throw RelayTunHelperFailure.changedResource }; remaining.remove(path)
                }, removeDirectory: { path in directories.remove(path) }, forgetReceipt: {
                    events.append("forget"); if failure == "forget" { throw RelayTunHelperFailure.unsafeInstallation }; receipt = false
                }, otherPathsAbsent: { remaining.isSubset(of: [RelayTunInstallationPaths.uninstaller]) && directories.isEmpty }, removeIntent: { intentPresent = false }, restoreIntent: { intentPresent = true }, allPathsAbsent: { remaining.isEmpty && directories.isEmpty && !intentPresent && failure != "finalPresence" })
                var completed = false
                do { try removal.execute(environment); completed = true } catch { }
                if ["none", "resume", "prePayloadFailure"].contains(failure) { check(completed && !loaded && !receipt && remaining.isEmpty && directories.isEmpty && verifies == 2 && (failure != "prePayloadFailure" || (!events.contains("bootout") && !events.contains("forget"))), "isolated \(failure) removal clears only exact files/directories/job/receipt before success") }
                else if ["preflight", "bootout", "changedAfterBootout"].contains(failure) { check(!completed && !events.contains("delete") && !events.contains("forget"), "removal rejects \(failure) before deleting any file or forgetting a receipt") }
                else { check(!completed && (failure != "delete" || !events.contains("forget")) && (failure != "selfDelete" || intentPresent), "removal does not claim restored absence and retains retry intent after \(failure)") }
            }
            var missingUninstaller = manifest; missingUninstaller.removeValue(forKey: "uninstaller")
            rejects("installation without a pinned uninstaller is rejected") { _ = try RelayTunHelperTrust.testInstallation(manifest: bytes(missingUninstaller)) }
            var wrongRole = manifest; wrongRole["role"] = "authentication-only"
            rejects("network candidate refuses an old authentication-only role") { _ = try RelayTunHelperTrust.testInstallation(manifest: bytes(wrongRole)) }
            var changedDaemon = RelayTunInstallationPaths.launchDaemonConfiguration; changedDaemon["ProgramArguments"] = ["/bin/sh"]
            var changedDaemonManifest = manifest; changedDaemonManifest["launchDaemonSHA256"] = RelayTunHelperTrust.digest(try PropertyListSerialization.data(fromPropertyList: changedDaemon, format: .xml, options: 0))
            rejects("even a matching daemon digest cannot replace the fixed program") { _ = try RelayTunHelperTrust.testInstallation(manifest: bytes(changedDaemonManifest), daemonOverride: changedDaemon) }
            changedDaemon = RelayTunInstallationPaths.launchDaemonConfiguration; changedDaemon["KeepAlive"] = true
            changedDaemonManifest = manifest; changedDaemonManifest["launchDaemonSHA256"] = RelayTunHelperTrust.digest(try PropertyListSerialization.data(fromPropertyList: changedDaemon, format: .xml, options: 0))
            rejects("network candidate cannot enable a persistent keep-alive role") { _ = try RelayTunHelperTrust.testInstallation(manifest: bytes(changedDaemonManifest), daemonOverride: changedDaemon) }
            var requirement: SecRequirement?
            check(SecRequirementCreateWithString(trust.client.requirement as CFString, [], &requirement) == errSecSuccess, "only fixed hex cdhashes form a valid Security requirement")
            rejects("user-owned installation is rejected in explicit fake FS") { _ = try RelayTunHelperTrust.testInstallation(manifest: encoded, owner: 501) }
            rejects("writable or symlink parent is rejected in explicit fake FS") { _ = try RelayTunHelperTrust.testInstallation(manifest: encoded, safeParents: false) }
            rejects("unstable resource identity is rejected") { _ = try RelayTunHelperTrust.testInstallation(manifest: encoded, stable: false) }
            rejects("hard-linked resource is rejected") { _ = try RelayTunHelperTrust.testInstallation(manifest: encoded, links: 2) }
            rejects("changed resource digest is rejected") { _ = try RelayTunHelperTrust.testInstallation(manifest: encoded, changedFile: true) }
            rejects("invalid code signature is rejected") { _ = try RelayTunHelperTrust.testInstallation(manifest: encoded, signatureValid: false) }
            for (key, value) in [("extra", "keep" as Any), ("clientUID", 0), ("clientUID", true), ("clientUID", 501.5), ("service", "party.mihomo.helper")] {
                var changed = manifest; changed[key] = value
                rejects("manifest rejects \(key)=\(value)") { _ = try RelayTunHelperTrust.testInstallation(manifest: bytes(changed)) }
            }
            var codeChanged = code; codeChanged["path"] = "/tmp/other"
            var changed = manifest; changed["helper"] = codeChanged
            rejects("manifest cannot select an arbitrary executable") { _ = try RelayTunHelperTrust.testInstallation(manifest: bytes(changed)) }
            codeChanged = code; codeChanged["cdhashes"] = ["arm64": "\" or true", "x86_64": String(repeating: "b", count: 40)]; changed = manifest; changed["client"] = codeChanged
            rejects("code signing requirement injection is rejected") { _ = try RelayTunHelperTrust.testInstallation(manifest: bytes(changed)) }
            for raw in ["{\"a\":1,\"a\":2}", "{\"a\":1,\"\\u0061\":2}", "{\"x\":{\"a\":1,\"a\":2}}", "{}{}", "{\"a\":NaN}", "{\"a\":1,}", "[1]", String(repeating: "[", count: 20) + "0" + String(repeating: "]", count: 20)] {
                rejects("strict JSON rejects malformed/duplicate/deep input \(rows.count)") { _ = try RelayTunStrictJSON.object(Data(raw.utf8)) }
            }
            check(try RelayTunStrictJSON.object(Data("{\"a\":{\"a\":1},\"b\":[true,null,\"x\\\"y\"]}".utf8)).count == 2, "repeated names in different objects and escaped strings remain valid")
            let nonce = String(repeating: "1", count: 64)
            let statusBytes = try bytes(["version": 1, "operation": "status", "nonce": nonce]), status = try RelayTunWireRequest.parse(statusBytes)
            let unavailable = try RelayTunWireResponse.make(status, trust: trust, result: .unavailable, runningAsRoot: true)
            check(unavailable.authenticated && !unavailable.executorAvailable && !unavailable.ready && !unavailable.active && !unavailable.protectionVerified && unavailable.status == .unavailable, "authenticated status explicitly reports no executor and no ready/protection")
            let statusReply = try JSONEncoder().encode(unavailable)
            check(try RelayTunWireResponse.parse(statusReply, request: status, trust: trust, hasDescriptor: false).nonce == nonce, "client validates nonce, installation and true root status without connecting")
            rejects("status cannot smuggle any file descriptor") { _ = try RelayTunWireResponse.parse(statusReply, request: status, trust: trust, hasDescriptor: true) }
            for field in ["path", "pid", "fd", "command", "authorized", "clientUID"] {
                var request: [String: Any] = ["version": 1, "operation": "status", "nonce": nonce]; request[field] = "untrusted"
                rejects("request cannot claim \(field)") { _ = try RelayTunWireRequest.parse(bytes(request)) }
            }
            rejects("short nonce is rejected") { _ = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "status", "nonce": "abc"])) }
            rejects("duplicate nonce keys are rejected") { _ = try RelayTunWireRequest.parse(Data(("{\"version\":1,\"operation\":\"status\",\"nonce\":\"" + nonce + "\",\"nonce\":\"" + nonce + "\"}").utf8)) }
            rejects("oversized request is rejected before JSON decode") { _ = try RelayTunWireRequest.parse(Data(repeating: 32, count: 16385)) }
            let prepare = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "prepare", "nonce": nonce, "networkSHA256": String(repeating: "e", count: 64), "protectionSHA256": String(repeating: "f", count: 64), "configurationSHA256": String(repeating: "c", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64), "bundleSHA256": String(repeating: "d", count: 64), "projection": "0122ff"]))
            check(prepare.runtimeConfigurationSHA256 == String(repeating: "a", count: 64), "preparation binds the generated FD runtime configuration digest")
            check(prepare.projection == Data([0x01, 0x22, 0xff]), "preparation carries its complete typed projection inline as bounded hex")
            rejects("preparation without generated runtime binding is refused") { _ = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "prepare", "nonce": nonce, "networkSHA256": String(repeating: "e", count: 64), "protectionSHA256": String(repeating: "f", count: 64), "configurationSHA256": String(repeating: "c", count: 64), "bundleSHA256": String(repeating: "d", count: 64), "projection": "0122ff"])) }
            rejects("preparation without its inline projection is refused") { _ = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "prepare", "nonce": nonce, "networkSHA256": String(repeating: "e", count: 64), "protectionSHA256": String(repeating: "f", count: 64), "configurationSHA256": String(repeating: "c", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64), "bundleSHA256": String(repeating: "d", count: 64)])) }
            rejects("projection hex must be even, lowercase and within the typed bound") { _ = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "prepare", "nonce": nonce, "networkSHA256": String(repeating: "e", count: 64), "protectionSHA256": String(repeating: "f", count: 64), "configurationSHA256": String(repeating: "c", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64), "bundleSHA256": String(repeating: "d", count: 64), "projection": "0X2"])) }
            rejects("an oversized projection is refused before semantic decode") { _ = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "prepare", "nonce": nonce, "networkSHA256": String(repeating: "e", count: 64), "protectionSHA256": String(repeating: "f", count: 64), "configurationSHA256": String(repeating: "c", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64), "bundleSHA256": String(repeating: "d", count: 64), "projection": String(repeating: "00", count: 16385)])) }
            check(try RelayTunWireResponse.make(prepare, trust: trust, result: .unavailable, runningAsRoot: true).status == .unavailable, "prepare also remains unavailable without an executor")
            for field in ["networkSHA256", "protectionSHA256"] {
                var object: [String: Any] = ["version": 1, "operation": "prepare", "nonce": nonce,
                    "configurationSHA256": String(repeating: "c", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64),
                    "bundleSHA256": String(repeating: "d", count: 64), "projection": "0122ff",
                    "networkSHA256": String(repeating: "e", count: 64), "protectionSHA256": String(repeating: "f", count: 64)]
                object.removeValue(forKey: field)
                rejects("prepare must carry confirmed baseline field " + field) { _ = try RelayTunWireRequest.parse(bytes(object)) }
            }
            let revokeID = UUID().uuidString.lowercased()
            let revoke = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "revoke", "nonce": nonce, "sessionID": revokeID]))
            let revoked = try RelayTunWireResponse.make(revoke, trust: trust,
                result: .init(state: .revoked, sessionID: revokeID, evidenceSHA256: nil, descriptor: nil), runningAsRoot: true)
            check(revoked.status == .revoked && !revoked.active && !revoked.ready && !revoked.protectionVerified,
                  "revoke acknowledges only withdrawn activation, not network restoration")
            rejects("revoke never accepts an unbound session") { _ = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "revoke", "nonce": nonce])) }
            rejects("revoke cannot smuggle a delivery descriptor") { _ = try RelayTunWireResponse.parse(JSONEncoder().encode(revoked), request: revoke, trust: trust, hasDescriptor: true) }
            let acquire = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "acquire", "nonce": nonce, "evidenceSHA256": String(repeating: "e", count: 64)]))
            rejects("acquire cannot claim network activation") { _ = try RelayTunWireResponse.make(acquire, trust: trust, result: .init(state: .active, sessionID: UUID().uuidString.lowercased(), evidenceSHA256: nil, descriptor: nil), runningAsRoot: true) }
            let sessionID = UUID().uuidString.lowercased()
            let activation = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "activate", "nonce": nonce, "sessionID": sessionID, "evidenceSHA256": String(repeating: "e", count: 64), "runtimeConfigurationSHA256": String(repeating: "a", count: 64)]))
            rejects("activation without a runtime digest is refused") { _ = try RelayTunWireRequest.parse(bytes(["version": 1, "operation": "activate", "nonce": nonce, "sessionID": sessionID, "evidenceSHA256": String(repeating: "e", count: 64)])) }
            check(try RelayTunWireResponse.make(activation, trust: trust, result: .unavailable, runningAsRoot: true).status == .unavailable, "activation is a separate explicitly unavailable phase")
            rejects("acquired state requires a descriptor but no route activation") { _ = try RelayTunWireResponse.make(acquire, trust: trust, result: .init(state: .acquired, sessionID: sessionID, evidenceSHA256: nil, descriptor: nil), runningAsRoot: true) }
            var acquiredObject = try RelayTunStrictJSON.object(statusReply)
            acquiredObject["operation"] = "acquire"; acquiredObject["status"] = "acquired"; acquiredObject["sessionID"] = sessionID; acquiredObject["executorAvailable"] = true
            rejects("an acquired FD without exact receipt and evidence is refused") { _ = try RelayTunWireResponse.parse(bytes(acquiredObject), request: acquire, trust: trust, hasDescriptor: true) }
            let receipt = try RelayTunAcquiredReceipt(installationRevision: trust.revision, clientUID: trust.clientUID,
                evidenceSHA256: String(repeating: "e", count: 64), runtimeConfigurationSHA256: String(repeating: "a", count: 64),
                planID: "8403621c-dafa-42e5-b5ba-bf10e07e7776", sessionID: sessionID, deviceID: "ca363b3f-aecc-4b75-a8fb-1a2b19af583e",
                interfaceName: "utun42", interfaceIndex: 91, controlID: 17, controlUnit: 43, socketDevice: "0", socketInode: "0")
            let receiptObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt)) as! [String: Any]
            acquiredObject["acquisition"] = receiptObject; acquiredObject["evidenceSHA256"] = receipt.evidenceSHA256
            check(try !RelayTunWireResponse.parse(bytes(acquiredObject), request: acquire, trust: trust, hasDescriptor: true).active, "typed acquired FD reply is distinct from active network state")
            let acquiredJSON = String(decoding: try bytes(acquiredObject), as: UTF8.self)
            let duplicateReceipt = acquiredJSON.replacingOccurrences(of: "\"interfaceIndex\":91", with: "\"interfaceIndex\":91,\"interfaceIndex\":92")
            rejects("duplicate receipt fields are rejected before nested Codable decoding") { _ = try RelayTunWireResponse.parse(Data(duplicateReceipt.utf8), request: acquire, trust: trust, hasDescriptor: true) }
            for (field, value) in [("installationRevision", String(repeating: "f", count: 64) as Any), ("clientUID", 502), ("sessionID", "7eb77791-4444-4b08-890d-6e39db0d663a"), ("evidenceSHA256", String(repeating: "f", count: 64)), ("extra", "untrusted")] {
                var altered = receiptObject; altered[field] = value
                var object = acquiredObject; object["acquisition"] = altered
                rejects("acquired receipt cannot replace \(field) binding") { _ = try RelayTunWireResponse.parse(bytes(object), request: acquire, trust: trust, hasDescriptor: true) }
            }
            var mismatched = acquiredObject; mismatched["evidenceSHA256"] = String(repeating: "f", count: 64)
            rejects("response evidence must match both request and receipt") { _ = try RelayTunWireResponse.parse(bytes(mismatched), request: acquire, trust: trust, hasDescriptor: true) }
            var unexpectedReceipt = try RelayTunStrictJSON.object(statusReply); unexpectedReceipt["acquisition"] = receiptObject
            rejects("non-acquired response cannot carry acquisition metadata") { _ = try RelayTunWireResponse.parse(bytes(unexpectedReceipt), request: status, trust: trust, hasDescriptor: false) }
            unexpectedReceipt["acquisition"] = NSNull()
            rejects("explicit null cannot masquerade as an omitted acquisition receipt") { _ = try RelayTunWireResponse.parse(bytes(unexpectedReceipt), request: status, trust: trust, hasDescriptor: false) }
            rejects("activation never transfers an additional descriptor") {
                var object = acquiredObject; object["operation"] = "activate"; object["status"] = "active"; object["active"] = true
                _ = try RelayTunWireResponse.parse(bytes(object), request: activation, trust: trust, hasDescriptor: true)
            }
            rejects("prepared metadata cannot be returned to status") { _ = try RelayTunWireResponse.make(status, trust: trust, result: .init(state: .prepared, sessionID: nil, evidenceSHA256: String(repeating: "e", count: 64), descriptor: nil), runningAsRoot: true) }
            var replyObject = try RelayTunStrictJSON.object(statusReply); replyObject["ready"] = true
            rejects("a pure preparation can never claim ready") { _ = try RelayTunWireResponse.parse(bytes(replyObject), request: status, trust: trust, hasDescriptor: false) }
            replyObject = try RelayTunStrictJSON.object(statusReply); replyObject["runningAsRoot"] = false
            rejects("non-root status cannot authenticate helper privileges") { _ = try RelayTunWireResponse.parse(bytes(replyObject), request: status, trust: trust, hasDescriptor: false) }
            let window = RelayTunNonceWindow(); try window.consume(nonce, now: 100)
            rejects("nonce replay on the same connection is rejected") { try window.consume(nonce, now: 100) }
            rejects("monotonic clock reversal invalidates request") { try window.consume(String(repeating: "2", count: 64), now: 99) }
            try window.consume(nonce, now: 161); check(true, "expired replay entries are pruned after bounded lifetime")
            let bounded = RelayTunNonceWindow()
            for index in 0..<128 { try bounded.consume(String(format: "%064x", index), now: 1) }
            rejects("nonce storage never grows beyond 128 entries") { try bounded.consume(String(repeating: "f", count: 64), now: 1) }
        } catch { check(false, "unexpected isolated test failure") }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows, "actualMachConnection": false, "actualRootFileReads": false, "actualSystemConfigurationChanged": false, "helperExecutorImplemented": true]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text) }
        exit(passed == rows.count ? 0 : 1)
    }
}
