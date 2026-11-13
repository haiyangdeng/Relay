import Foundation
import Darwin

@main struct RelayTunAppBundleTests {
    static func main() {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(), CommandLine.arguments.count == 1 else { exit(77) }
        _ = umask(0o077)
        var rows: [[String: Any]] = []
        func check(_ value: Bool, _ name: String) { rows.append(["name": name, "passed": value]) }
        func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
        func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
        func fixture(_ body: (String, [String: Any]) throws -> Void) throws {
            var pattern = Array("/private/tmp/relay-bootstrap-test-XXXXXX".utf8CString)
            guard mkdtemp(&pattern) != nil else { throw RelayTunAppBundle.Failure.invalid }
            let source = String(cString: pattern)
            defer { try? FileManager.default.removeItem(atPath: source) }
            let sourceObject: [String: Any] = ["tun": ["enable": true, "device": "utun", "stack": "gvisor", "mtu": 1500,
                "auto-route": false, "auto-detect-interface": false, "dns-hijack": [String]()],
                "port": 0, "mode": "rule", "rules": ["MATCH,REJECT"]]
            var runtime = sourceObject, tun = runtime["tun"] as! [String: Any]
            tun["file-descriptor"] = 3; runtime["tun"] = tun
            let original = try data(sourceObject), configuration = try data(runtime), asset = Data("payload:\n - DOMAIN,example.com\n".utf8)
            let path = "relay-files/" + RelayTunAppBundle.digest(asset) + ".yaml"
            let metadata: [[String: Any]] = [["path": path, "sha256": RelayTunAppBundle.digest(asset), "expectedRules": 1]]
            let pins: [[String: Any]] = [["id": "11111111-1111-4111-8111-111111111111", "namespace": "resource", "sha256": RelayTunAppBundle.digest(asset), "revision": String(repeating: "f", count: 64)]]
            let bundle = try data(["configuration": sourceObject, "assets": metadata, "pins": pins, "unresolved": [Any]()])
            mkdir(source + "/relay-files", 0o700)
            for (name, bytes) in [("config.json", configuration), ("source.json", original), ("bundle.json", bundle), (path, asset)] {
                try bytes.write(to: URL(fileURLWithPath: source + "/" + name), options: .withoutOverwriting)
                chmod(source + "/" + name, 0o600)
            }
            let projection = try RelayTunNetworkProjection(device: "utun", mtu: 1500, addresses: [], routes: [], resolver: nil)
            let bootstrap: [String: Any] = ["version": 1, "action": "bootstrap", "controlLossPolicy": "restore-owned-session", "binding": ["sessionId": "22222222-2222-4222-8222-222222222222",
                "evidenceSHA256": String(repeating: "b", count: 64), "runtimeConfigurationSHA256": RelayTunAppBundle.digest(configuration)],
                "configurationSHA256": RelayTunAppBundle.digest(original), "bundleSHA256": RelayTunAppBundle.digest(bundle),
                "configurationPath": "config.json", "directory": source, "projection": String(decoding: projection.encoded(), as: UTF8.self),
                "managedMTU": 1500, "assets": metadata, "pins": pins,
                "baseline": ["networkSHA256": String(repeating: "c", count: 64), "protectionSHA256": String(repeating: "d", count: 64)]]
            try body(source, bootstrap)
        }
        func resourceFixture(providers: Bool = false, _ body: (RelayTunAppBundle, String, [String: Any]) throws -> Void) throws {
            try fixture { source, originalBootstrap in
                var pattern = Array("/private/tmp/relay-geo-main-\(getuid())-bundle-test-XXXXXX".utf8CString)
                guard mkdtemp(&pattern) != nil else { throw RelayTunAppBundle.Failure.invalid }
                let inbox = String(cString: pattern)
                defer { try? FileManager.default.removeItem(atPath: inbox) }
                var original = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: source + "/source.json"))) as! [String: Any]
                var tun = original["tun"] as! [String: Any]; tun["device"] = "utun42"; original["tun"] = tun
                if providers {
                    let path = (originalBootstrap["assets"] as! [[String: Any]])[0]["path"] as! String
                    let row: [String: Any] = ["type": "file", "behavior": "classical", "format": "yaml", "path": path, "interval": 0]
                    original["rule-providers"] = ["Only": row, "Alias": row,
                        "Inline": ["type": "inline", "behavior": "domain", "payload": ["example.invalid"]],
                        "Empty": ["type": "inline", "behavior": "domain", "payload": [String]()]]
                }
                let config = try data(original)
                var metadata = originalBootstrap["assets"] as! [[String: Any]]
                for kind in [RelayTunRuntimeResources.Kind.geosite, .geoip] {
                    let bytes = Data(("synthetic-old-" + kind.rawValue).utf8)
                    try bytes.write(to: URL(fileURLWithPath: source + "/" + kind.basename), options: .withoutOverwriting)
                    chmod(source + "/" + kind.basename, 0o600)
                    metadata.append(["path": kind.basename, "sha256": RelayTunAppBundle.digest(bytes)])
                }
                let bundleBytes = try data(["configuration": original, "assets": metadata,
                    "pins": originalBootstrap["pins"]!, "unresolved": [Any]()])
                for (name, bytes) in [("source.json", config), ("config.json", config), ("bundle.json", bundleBytes)] {
                    try bytes.write(to: URL(fileURLWithPath: source + "/" + name)); chmod(source + "/" + name, 0o600)
                }
                var bootstrap = originalBootstrap, binding = bootstrap["binding"] as! [String: Any]
                binding["runtimeConfigurationSHA256"] = RelayTunAppBundle.digest(config); bootstrap["binding"] = binding
                bootstrap["version"] = 2; bootstrap["installationRevision"] = String(repeating: "e", count: 64)
                bootstrap["resourceInboxRoot"] = inbox; bootstrap["assets"] = metadata
                bootstrap["configurationSHA256"] = RelayTunAppBundle.digest(config); bootstrap["bundleSHA256"] = RelayTunAppBundle.digest(bundleBytes)
                bootstrap.removeValue(forKey: "projection"); bootstrap.removeValue(forKey: "managedMTU")
                rejects("old launch schema rejects new resourceInboxRoot") { _ = try RelayTunAppBundle(data(bootstrap)) }
                let bundle = try RelayTunAppBundle(data(bootstrap), resourcesEnabled: true, ruleProvidersEnabled: providers)
                var root = stat(); guard lstat(bundle.directory, &root) == 0 else { throw RelayTunAppBundle.Failure.invalid }
                defer {
                    if FileManager.default.fileExists(atPath: bundle.directory) {
                        var current = stat()
                        if lstat(bundle.directory, &current) == 0, current.st_dev == root.st_dev, current.st_ino == root.st_ino,
                           current.st_uid == getuid(), current.st_mode & 0o7777 == 0o700 {
                            do { try FileManager.default.removeItem(atPath: bundle.directory) }
                            catch { check(false, "owned synthetic bundle fixture cleanup failed") }
                        } else { check(false, "changed synthetic bundle root retained") }
                    }
                }
                try body(bundle, source, bootstrap)
            }
        }
        func state(_ source: String, sequence: UInt64 = 0, geosite: Data? = nil) throws -> RelayTunCoreReadiness.ResourceState {
            let rows = try [RelayTunRuntimeResources.Kind.geosite, .geoip].map { kind in
                let bytes = kind == .geosite && geosite != nil ? geosite! : try Data(contentsOf: URL(fileURLWithPath: source + "/" + kind.basename))
                return RelayTunCoreReadiness.ResourceState.Row(kind: kind, sha256: RelayTunAppBundle.digest(bytes), bytes: bytes.count, active: true)
            }
            return .init(bootId: "33333333-3333-4333-8333-333333333333", generationSHA256: String(repeating: sequence == 0 ? "a" : "b", count: 64), sequence: sequence, resources: rows)
        }
        func selection(_ bundle: RelayTunAppBundle, ledger: RelayTunRuntimeResources.Ledger, bytes: Data) throws -> RelayTunRuntimeResources.Selection {
            try .init(kind: .geosite, configurationRevision: bundle.binding.runtimeConfigurationSHA256,
                expectedGenerationSHA256: ledger.generationSHA256, oldSHA256: ledger.resources[.geosite]!.sha256,
                newSHA256: RelayTunAppBundle.digest(bytes), blobId: "44444444-4444-4444-8444-444444444444", selector: "fixture", bytes: bytes.count)
        }
        typealias P = RelayTunRuntimeRuleProviders
        func providerContext(_ bundle: RelayTunAppBundle, _ source: String) throws -> P.Context {
            let geo = try bundle.observeResourceState(state(source), check: {})
            return .init(owner: try .init(heldGeneration: 1, configurationRevision: bundle.binding.runtimeConfigurationSHA256,
                coreSHA256: RelayTunRuntimeRuleProviderProbe.corePin.sha256, ordinaryUID: getuid()),
                geo: try .init(generationSHA256: geo.generationSHA256, bytes: geo.resources.values.reduce(0, { $0 + $1.bytes })))
        }
        func providerMetadata(_ count: Int = 1) -> [String: Any] {
            let date = "2026-11-02T00:00:00Z"
            let row: [String: Any] = ["name": "Only", "behavior": "Classical", "format": "YamlRule", "ruleCount": count,
                "type": "Rule", "vehicleType": "File", "updatedAt": date]
            var alias = row; alias["name"] = "Alias"
            return ["providers": ["Only": row, "Alias": alias,
                "Inline": ["name": "Inline", "behavior": "Domain", "format": "", "ruleCount": 1, "type": "Rule", "vehicleType": "Inline", "updatedAt": date, "payload": ["example.invalid"]],
                "Empty": ["name": "Empty", "behavior": "Domain", "format": "", "ruleCount": 0, "type": "Rule", "vehicleType": "Inline", "updatedAt": date]]]
        }
        func replaceProvider(_ bundle: RelayTunAppBundle, context: P.Context, previous: P.Ledger, body: Data, loseACK: Bool) throws -> P.Reply {
            var pattern = Array("/private/tmp/relay-provider-bundle-blob-XXXXXX".utf8CString)
            let fd = mkstemp(&pattern); guard fd >= 0 else { throw RelayTunAppBundle.Failure.invalid }
            let path = String(cString: pattern); defer { Darwin.close(fd); unlink(path) }
            try body.write(to: URL(fileURLWithPath: path)); chmod(path, 0o600)
            var info = stat(); guard lstat(path, &info) == 0 else { throw RelayTunAppBundle.Failure.invalid }
            let blob = try P.Blob(id: UUID().uuidString.lowercased(), format: .yaml, data: body, identity: RelayTunRuntimeRuleProviderFiles.identity(info))
            let selection = try P.Selection(provider: "Only", configurationRevision: context.owner.configurationRevision,
                expectedGenerationSHA256: previous.generationSHA256, expectedGeoGenerationSHA256: context.geo.generationSHA256,
                oldSHA256: previous.resources["Only"]!.fileSHA256, newSHA256: P.Shared.digest(body), blobId: blob.id, bytes: body.count, declaredRuleCount: 1)
            guard let files = bundle.ruleProviderFiles else { throw RelayTunAppBundle.Failure.invalid }
            let driver = P.Driver(supportsSynchronousFileRead: true, currentContext: { context }, readBlob: { _, access, done in
                do { try access.check(); done(.success(blob)) } catch { done(.failure(error)) }
            }, stage: { group, candidate, access, done in
                do { done(.success(try files.stage(group: group, blob: candidate,
                    checkedRuleCounts: Dictionary(uniqueKeysWithValues: group.map { ($0.binding.name, 1) }), check: access.check))) }
                catch { done(.failure(error)) }
            }, prune: { victims, access, done in done(.success(files.prune(victims, check: access.check))) }, publish: { stage, access, done in
                do {
                    let swap = try files.swap(stage, access: access)
                    if loseACK { throw RelayTunAppBundle.Failure.resourceUncertain }
                    let updated = try previous.resources.values.map { row in
                        try P.Resource(binding: row.binding, fileSHA256: stage.sha256, identity: swap.currentIdentity, ruleCount: 1, registeredFile: true)
                    }
                    done(.success(.init(retained: swap.retained, resources: updated, acceptance: .synchronousFileRead)))
                } catch { done(.failure(error)) }
            }, cleanup: { stage, action, done in
                do { if action == .discardUnpublished { try files.discardUnpublished(stage, check: {}) }; done(.success(())) }
                catch { done(.failure(error)) }
            })
            let controller = try P.Controller(ledger: previous, staticAssetBytes: bundle.nonGeoNonProviderResourceBytes, initialGeo: context.geo, driver: driver)
            try bundle.beginRuleProviderOperation(selection: selection, previous: previous)
            var answer: P.Reply?
            controller.replace(id: 1, selection: selection) { answer = $0 }
            guard let answer else { throw RelayTunAppBundle.Failure.invalid }
            try bundle.endRuleProviderOperation(answer, isolated: controller.isolation != nil)
            return answer
        }
        do {
            try fixture { _, bootstrap in
                var missing = bootstrap; missing.removeValue(forKey: "controlLossPolicy")
                rejects("bootstrap without explicitly confirmed control-loss policy is rejected") { _ = try RelayTunAppBundle(data(missing)) }
                var wrong = bootstrap; wrong["controlLossPolicy"] = "stop-any-core"
                rejects("control-loss policy cannot broaden ownership scope") { _ = try RelayTunAppBundle(data(wrong)) }
            }
            try fixture { source, bootstrap in
                let bundle = try RelayTunAppBundle(data(bootstrap))
                let original = try Data(contentsOf: URL(fileURLWithPath: source + "/config.json"))
                check(bundle.directory != source && bundle.configuration == original, "complete source becomes a separate private exact-byte runtime")
                var info = stat()
                check(lstat(bundle.directory, &info) == 0 && info.st_uid == getuid() && info.st_mode & 0o7777 == 0o700, "runtime directory is owned and private")
                try bundle.verify()
                check(true, "source/runtime/assets/pins and both original bundle digests pass independent native checks")
                try bundle.cleanup()
                check(!FileManager.default.fileExists(atPath: bundle.directory) && FileManager.default.fileExists(atPath: source), "explicit cleanup removes only native runtime and preserves main source")
                try bundle.cleanup(); check(true, "confirmed cleanup is idempotent")
            }
            for key in ["configurationSHA256", "bundleSHA256"] {
                try fixture { _, bootstrap in
                    var changed = bootstrap; changed[key] = String(repeating: "0", count: 64)
                    rejects("wrong original digest is rejected before creating runtime: " + key) { _ = try RelayTunAppBundle(data(changed)) }
                }
            }
            for field in ["id", "namespace", "revision", "sha256"] {
                try fixture { _, bootstrap in
                    var changed = bootstrap, pins = changed["pins"] as! [[String: Any]]
                    pins[0][field] = "forged"; changed["pins"] = pins
                    rejects("bootstrap pin cannot disagree with hashed bundle: " + field) { _ = try RelayTunAppBundle(data(changed)) }
                }
            }
            for path in ["../escape", "/tmp/escape", "relay-files/../../escape", "config.yaml", "api.sock"] {
                try fixture { _, bootstrap in
                    var changed = bootstrap, assets = changed["assets"] as! [[String: Any]]
                    assets[0]["path"] = path; changed["assets"] = assets
                    rejects("unbound path injection is rejected: " + path) { _ = try RelayTunAppBundle(data(changed)) }
                }
            }
            try fixture { source, bootstrap in
                chmod(source + "/config.json", 0o644)
                rejects("main source configuration must remain 0600") { _ = try RelayTunAppBundle(data(bootstrap)) }
            }
            try fixture { source, bootstrap in
                let bundle = try RelayTunAppBundle(data(bootstrap))
                try Data("changed".utf8).write(to: URL(fileURLWithPath: source + "/source.json"))
                rejects("original source mutation invalidates retained bundle") { try bundle.verify() }
                // Restore exact initial bytes only in this private fixture so
                // its native copy can be explicitly disposed after the check.
                let object = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: source + "/bundle.json"))) as! [String: Any]
                try data(object["configuration"]!).write(to: URL(fileURLWithPath: source + "/source.json"))
                try bundle.cleanup()
            }
            try fixture { _, bootstrap in
                let bundle = try RelayTunAppBundle(data(bootstrap)), unknown = bundle.directory + "/user-unknown"
                try Data("preserve".utf8).write(to: URL(fileURLWithPath: unknown))
                rejects("unknown runtime contents prevent cleanup") { try bundle.cleanup() }
                check(FileManager.default.fileExists(atPath: unknown), "unknown file is preserved")
                unlink(unknown); try bundle.cleanup()
            }
            try fixture { _, bootstrap in
                let bundle = try RelayTunAppBundle(data(bootstrap))
                var injected = false
                bundle.afterRemovalForTest = {
                    if !injected { injected = true; throw RelayTunAppBundle.Failure.conflict }
                }
                rejects("interrupted cleanup retains exact completed-removal history") { try bundle.cleanup() }
                check(injected && FileManager.default.fileExists(atPath: bundle.directory), "partial cleanup keeps the owned directory for explicit retry")
                bundle.afterRemovalForTest = nil
                try bundle.cleanup()
                check(!FileManager.default.fileExists(atPath: bundle.directory), "explicit retry accepts only this cleanup's recorded missing entries")
            }
            try fixture { source, bootstrap in
                let bundle = try RelayTunAppBundle(data(bootstrap))
                try bundle.cleanup(); try bundle.recordControlRecovery(restored: true)
                let bytes = try Data(contentsOf: URL(fileURLWithPath: source + "/recovery.json"))
                let record = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
                check(Set(record.keys) == ["version", "sessionId", "evidenceSHA256", "runtimeConfigurationSHA256", "baseline", "status", "ownedRecoveryRetained"] &&
                    record["status"] as? String == "restored" && record["ownedRecoveryRetained"] as? Bool == false,
                    "successful control-loss record has only strict non-sensitive binding/baseline fields")
                rejects("existing terminal recovery record is never overwritten") { try bundle.recordControlRecovery(restored: false) }
                let retained = try Data(contentsOf: URL(fileURLWithPath: source + "/recovery.json"))
                check(retained == bytes, "refused recovery record replacement preserves original evidence")
            }
            try resourceFixture { bundle, source, _ in
                let old = try bundle.observeResourceState(state(source), check: {})
                let fixed = Data("payload:\n - DOMAIN,example.com\n".utf8)
                check(bundle.staticResourceBytes == fixed.count, "resource total budget counts original non-Geo assets but excludes configuration")
                let bytes = Data("new-authorized-geosite".utf8), selected = try selection(bundle, ledger: old, bytes: bytes)
                try bundle.beginResourceTransition(selected, previous: old)
                let retainedNonce = String(repeating: "f", count: 64)
                try FileManager.default.moveItem(atPath: bundle.directory + "/GeoSite.dat", toPath: bundle.directory + "/RelayGeo.retained-" + retainedNonce)
                try bytes.write(to: URL(fileURLWithPath: bundle.directory + "/GeoSite.dat"), options: .withoutOverwriting)
                chmod(bundle.directory + "/GeoSite.dat", 0o600)
                try bundle.verify(); check(true, "exact selected in-flight postimage does not trigger immutable source tamper")
                let after = try bundle.readResourcePostimage(state(source, sequence: 1, geosite: bytes), check: {})
                let receipt = RelayTunRuntimeResources.Receipt(bootId: old.bootId, kind: .geosite, oldSHA256: selected.oldSHA256,
                    newSHA256: selected.newSHA256, bytes: bytes.count, previousGenerationSHA256: old.generationSHA256,
                    generationSHA256: after.generationSHA256, sequence: 1, retainedOriginal: true)
                try bundle.resourceInbox!.registerRetained(nonce: retainedNonce, previous: old.resources[.geosite]!, applied: receipt, check: {})
                try bundle.finishResourceTransition(.init(status: .updated, ledger: after), isolated: false)
                try bundle.verify()
                check(try bundle.observeResourceState(state(source, sequence: 1, geosite: bytes), check: {}) == after,
                      "only a confirmed exact postimage replaces the active ledger")
                check(try RelayTunAppBundle.digest(Data(contentsOf: URL(fileURLWithPath: source + "/GeoSite.dat"))) == selected.oldSHA256,
                      "checked main source and original resource bytes remain immutable")
                try bundle.cleanup()
                check(!FileManager.default.fileExists(atPath: bundle.directory), "registered static active inbox retained union cleans only after complete validation")
            }
            try resourceFixture { bundle, source, _ in
                let old = try bundle.observeResourceState(state(source), check: {})
                let selected = try selection(bundle, ledger: old, bytes: Data("pending".utf8))
                try bundle.beginResourceTransition(selected, previous: old)
                try bundle.finishResourceTransition(.init(status: .uncertain), isolated: true)
                try Data("unknown-after-entry".utf8).write(to: URL(fileURLWithPath: bundle.directory + "/GeoSite.dat"))
                try bundle.verify()
                check(bundle.resourceIsolated && bundle.resourceLedger == old, "unknown selected Geo preserves old fact ledger without global inspect failure or inferred new SHA")
                rejects("unknown state cannot be silently reconciled by a read") { _ = try bundle.observeResourceState(state(source), check: {}) }
                rejects("unknown active target is preserved by production cleanup") { try bundle.cleanup() }
                let before = Set(try FileManager.default.subpathsOfDirectory(atPath: bundle.directory))
                check(try bundle.finalizeAfterRestoration() == .retainedEvidence,
                      "positively restored caller can retire known Geo uncertainty while retaining private evidence")
                check(try Set(FileManager.default.subpathsOfDirectory(atPath: bundle.directory)) == before && bundle.resourceLedger == old,
                      "retained evidence disposition neither unlinks nor adopts unknown Geo bytes")
                try Data("unrelated-tamper".utf8).write(to: URL(fileURLWithPath: bundle.directory + "/GeoIP.dat"))
                rejects("other Geo identity and SHA remain strict during selected-kind isolation") { try bundle.verify() }
                rejects("unrelated input mutation still rejects evidence retirement") { _ = try bundle.finalizeAfterRestoration() }
            }
            try resourceFixture(providers: true) { bundle, source, _ in
                let context = try providerContext(bundle, source)
                rejects("initial provider count mismatch grants no authority") { _ = try bundle.observeRuleProviders(data(providerMetadata(2)), context: context, check: {}) }
                check(bundle.ruleProviderLedger == nil && bundle.ruleProviderFiles == nil,
                      "failed initial observation creates no provider registry or ledger")
                let ledger = try bundle.observeRuleProviders(data(providerMetadata()), context: context, check: {})
                let physical = Data("payload:\n - DOMAIN,example.com\n".utf8).count
                check(ledger.sequence == 0 && ledger.resources.count == 2 && ledger.groups == [["Alias", "Only"]] && ledger.bytes == physical,
                      "mixed inline and shared file aliases bind one physical resource without fabricated inline capabilities")
                check(bundle.staticResourceBytes == physical && bundle.nonGeoNonProviderResourceBytes == 0,
                      "initial provider aggregate counts a shared physical path once")
                check(try bundle.observeRuleProviders(data(providerMetadata()), context: context, check: {}) == ledger,
                      "unchanged authenticated full table verifies the existing ledger")
                let snapshot = try bundle.captureProviderSnapshot(context: context, group: ledger.group(for: "Only"), check: {})
                check(snapshot.expectedRuleCounts == ["Alias": 1, "Only": 1, "Inline": 1, "Empty": 0] && snapshot.assets.count == 3,
                      "probe snapshot preserves full counts including non-target inline and zero-rule inline dependencies")
                let asset = snapshot.assets.first { $0.path == ledger.resources["Only"]!.binding.originalPath }!
                check(asset.identity == ledger.resources["Only"]!.identity && asset.sha256 == ledger.resources["Only"]!.fileSHA256,
                      "snapshot uses checked physical current source body and identity")
                var bad = providerMetadata(), actual = bad["providers"] as! [String: Any]
                var inline = actual["Inline"] as! [String: Any]; inline["payload"] = ["other.invalid"]; actual["Inline"] = inline; bad["providers"] = actual
                rejects("inline payload mutation cannot be adopted by an otherwise unchanged read") { _ = try bundle.observeRuleProviders(data(bad), context: context, check: {}) }
                var changed = stat(); let target = bundle.directory + "/" + asset.path
                guard lstat(target, &changed) == 0 else { throw RelayTunAppBundle.Failure.changed }
                try Data("foreign".utf8).write(to: URL(fileURLWithPath: target))
                rejects("physical target tamper blocks snapshot before any private probe") { _ = try bundle.captureProviderSnapshot(context: context, group: ledger.group(for: "Only"), check: {}) }
            }
            try resourceFixture(providers: true) { bundle, source, _ in
                let context = try providerContext(bundle, source)
                let old = try bundle.observeRuleProviders(data(providerMetadata()), context: context, check: {})
                let bytes = Data("payload:\n - DOMAIN,a-longer-new.example.invalid\n".utf8)
                let result = try replaceProvider(bundle, context: context, previous: old, body: bytes, loseACK: false)
                check(result.status == .published && bundle.ruleProviderLedger?.sequence == 1 && bundle.physicalRuleProviderBytes == bytes.count && bundle.staticResourceBytes == bytes.count,
                      "successful alias-group publication updates the shared physical budget for subsequent Geo operations")
                let observed = try bundle.observeRuleProviders(data(providerMetadata()), context: context, check: {})
                check(observed == bundle.ruleProviderLedger && observed.bytes == bytes.count,
                      "post-publication full table verifies exact new file identities without reading a new ledger into authority")
                let snapshot = try bundle.captureProviderSnapshot(context: context, group: observed.group(for: "Only"), check: {})
                check(snapshot.assets.first { $0.path == observed.resources["Only"]!.binding.originalPath }?.data == bytes,
                      "next whole-candidate snapshot uses the confirmed latest physical provider body")
                _ = try bundle.observeResourceState(state(source), check: {})
                try bundle.cleanup(); check(!FileManager.default.fileExists(atPath: bundle.directory), "confirmed provider retained union cleans without altering checked source")
            }
            try resourceFixture(providers: true) { bundle, source, _ in
                let context = try providerContext(bundle, source)
                let old = try bundle.observeRuleProviders(data(providerMetadata()), context: context, check: {})
                let bytes = Data("payload:\n - DOMAIN,longer-unknown.example.invalid\n".utf8)
                let result = try replaceProvider(bundle, context: context, previous: old, body: bytes, loseACK: true)
                check(result.status == .uncertain && bundle.ruleProviderIsolated && bundle.ruleProviderLedger == old && bundle.reservedRuleProviderBytes == bytes.count,
                      "lost acceptance preserves old ledger and reserves larger finite physical postimage")
                try bundle.verify()
                rejects("uncertain provider read cannot adopt the physically new target") { _ = try bundle.observeRuleProviders(data(providerMetadata()), context: context, check: {}) }
                try bundle.cleanup()
                check(!FileManager.default.fileExists(atPath: bundle.directory), "positively closed Core can clean a completely known uncertain provider swap without adopting it")
            }
            try resourceFixture(providers: true) { bundle, source, _ in
                let context = try providerContext(bundle, source)
                _ = try bundle.observeRuleProviders(data(providerMetadata()), context: context, check: {})
                let stageRoot = bundle.directory + "/" + RelayTunRuntimeRuleProviderFiles.stageDirectory
                try Data("foreign-not-a-socket".utf8).write(to: URL(fileURLWithPath: bundle.directory + "/api.sock"), options: .withoutOverwriting)
                chmod(bundle.directory + "/api.sock", 0o600)
                rejects("malformed Core runtime entry blocks complete cleanup before managed owner deletion") { try bundle.cleanup() }
                check(FileManager.default.fileExists(atPath: stageRoot), "global cleanup preflight preserves provider registry on malformed runtime entry")
                guard unlink(bundle.directory + "/api.sock") == 0 else { throw RelayTunAppBundle.Failure.changed }
                try bundle.cleanup()
                check(!FileManager.default.fileExists(atPath: bundle.directory), "valid mixed-provider bundle cleans complete known union after rejection repair")
            }
        } catch { rows.append(["name": "unexpected bundle fixture failure", "passed": false, "error": String(describing: error)]) }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "helperConnected": false, "coreStarted": false, "actualNetworkConfigurationChanged": false]
        if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) { print(String(decoding: bytes, as: UTF8.self)) }
        exit(passed == rows.count ? 0 : 1)
    }
}
