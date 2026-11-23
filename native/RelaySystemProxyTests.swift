import Foundation

func runRelaySystemProxySelfTests() -> Int32 {
    typealias Proxy = RelaySystemProxy
    var rows: [[String: Any]] = []
    func check(_ passed: Bool, _ name: String) { rows.append(["name": name, "passed": passed]) }
    func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
    let fm = FileManager.default, home = URL(fileURLWithPath: "/private/tmp/relay-system-proxy-" + UUID().uuidString.lowercased(), isDirectory: true)
    do {
        rows += try relaySystemProxyBackendSelfTestRows()
        rows += relaySystemProxyHelperBridgeSelfTestRows()
        try fm.createDirectory(at: home, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: home) }
        let context = RelayStateContext(home: home.path, stateRoot: home.appendingPathComponent("Library/Application Support/Relay-Preview").path), root = URL(fileURLWithPath: context.stateRoot).appendingPathComponent("SystemProxy")
        func data(_ values: [String: Any]) throws -> Data { try PropertyListSerialization.data(fromPropertyList: values, format: .binary, options: 0) }
        let original = Proxy.Snapshot(location: "Location-A", services: [
            Proxy.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: try data(["HTTPEnable": 1, "HTTPProxy": "old.invalid", "HTTPPort": 8080, "ProxyAutoConfigEnable": 1, "ProxyAutoConfigURLString": "https://old.invalid/pac", "ExceptionsList": ["intranet.invalid"], "PrivateUnknown": ["credential": "PRIVATE", "bytes": Data([1,2,3])]])),
            Proxy.Service(id: "B", name: "Ethernet", enabled: true, configuration: nil),
            Proxy.Service(id: "C", name: "Disabled", enabled: false, configuration: try data(["HTTPEnable": 0]))
        ])
        let algorithmTarget = Proxy.Snapshot(location: original.location, services: [Proxy.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: try data(["HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": 18191]))] + Array(original.services.dropFirst()))
        check(try Proxy.changedServiceIDs(original, algorithmTarget) == ["A"], "live staging only touches services with changed proxy values")
        check(try Proxy.changedServiceIDs(original, original).isEmpty, "identical proxy snapshots never stage untouched services")
        let emptyProtocol = Proxy.Snapshot(location: original.location, services: [original.services[0], Proxy.Service(id: "B", name: "Ethernet", enabled: true, configuration: try data([:]))] + Array(original.services.dropFirst(2)))
        check(try Proxy.changedServiceIDs(original, emptyProtocol) == ["B"], "nil and empty protocol values remain distinct during staging and restoration")
        rejects("staging refuses a different network service identity") { _ = try Proxy.changedServiceIDs(original, Proxy.Snapshot(location: "Other", services: original.services)) }
        for scenario in ["success", "stageFailure", "commitFailure", "commitLostAck", "applyFailure", "rollbackFailure", "externalAfterApplyFailure"] {
            var disk = original, cached = original, commits = 0, applies = 0, stages = 0
            let session = Proxy.LockedSession(synchronize: { cached = disk }, read: { cached }, stage: { value in
                stages += 1; cached = value
                if scenario == "stageFailure" { throw Proxy.SystemFailure(stage: "protocol_stage", code: 1003) }
            }, commit: {
                commits += 1
                if scenario == "commitFailure" || (scenario == "rollbackFailure" && commits == 2) { return false }
                disk = cached
                return scenario != "commitLostAck"
            }, apply: {
                applies += 1
                if scenario == "externalAfterApplyFailure" { disk = Proxy.Snapshot(location: "External", services: disk.services); return false }
                return !["applyFailure", "rollbackFailure"].contains(scenario) || applies > 1
            }, diagnostic: { stage in stage == "apply" && applies == 0 ? "diagnostic before failed operation" : "fixture \(stage) status 1003" })
            let changed = try Proxy.changeLocked(original, algorithmTarget, session: session)
            switch scenario {
            case "success": check(changed.status == "applied" && disk == algorithmTarget && commits == 1 && applies == 1, "actual transaction algorithm commits and applies once")
            case "stageFailure": check(changed.status == "unchanged" && disk == original && commits == 0 && changed.warnings == ["系统代理阶段 protocol_stage 失败，状态码 1003。"], "partial staging is discarded and reports only a bounded stage and status")
            case "commitFailure": check(changed.status == "unchanged" && disk == original && applies == 0 && changed.warnings == ["fixture commit status 1003"], "failed commit retains bounded diagnostics without applying or retrying")
            case "commitLostAck": check(changed.status == "uncertain" && disk == algorithmTarget && commits == 1 && applies == 0, "commit acknowledgement loss is uncertain without automatic rollback")
            case "applyFailure": check(changed.status == "rolledBack" && disk == original && commits == 2 && applies == 2 && changed.warnings == ["fixture apply status 1003"], "failed apply captures status after failure then restores the exact owned candidate under one lock")
            case "rollbackFailure": check(changed.status == "uncertain" && changed.snapshot == algorithmTarget && disk == algorithmTarget && commits == 2, "failed rollback resynchronizes persistent state before reporting uncertainty")
            default: check(changed.status == "uncertain" && disk.location == "External" && stages == 1, "external changes after failed apply are not overwritten by rollback")
            }
        }
        var current = original, writes = 0, behavior = "apply", inspectCount = 0
        var otherConfigurations: [[String: Any]] = []
        var proxyConfigurationsReadable = true
        let environment = Proxy.Environment(read: { inspectCount += 1; return current }, change: { expected, target in
            writes += 1
            guard current == expected else { throw AssistantError("fixture revision changed") }
            switch behavior {
            case "apply": current = target; return Proxy.ChangeResult(status: "applied", snapshot: current)
            case "unchanged": return Proxy.ChangeResult(status: "unchanged", snapshot: current)
            case "notSubmitted": return Proxy.ChangeResult(status: "notSubmitted", snapshot: current)
            case "otherSnapshot": return Proxy.ChangeResult(status: "notSubmitted", snapshot: target)
            case "rolledBack": return Proxy.ChangeResult(status: "rolledBack", snapshot: current)
            case "authDenied": throw Proxy.SystemFailure(stage: "authorization_create", code: -60005)
            case "lostAck": current = target; throw AssistantError("fixture acknowledgement lost")
            default: throw AssistantError("fixture unknown failure")
            }
        }, isLive: false, readProxyConfigurations: {
            guard proxyConfigurationsReadable else { throw AssistantError("fixture proxy read failed") }
            return try current.services.map { try Proxy.dictionary($0.configuration) } + otherConfigurations
        })
        func input(_ action: String, _ settings: Proxy.Settings? = nil, _ revision: String? = nil) -> Proxy.Input { Proxy.Input(context: context, action: action, settings: settings, expectedRevision: revision) }
        func run(_ action: String, _ settings: Proxy.Settings? = nil, _ revision: String? = nil) throws -> Proxy.Report { try Proxy.perform(input(action, settings, revision), environment: environment) }
        let manual = Proxy.Settings(mode: "manual", host: "127.0.0.1", port: 18191, socks: false, bypass: ["localhost", "10.0.0.0/8", "*.company.local"], excludeSimple: true, serviceIDs: ["A"], pacURL: nil)
        current = Proxy.Snapshot(location: original.location, services: [
            Proxy.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: try data(["ProxyAutoDiscoveryEnable": 1]))
        ])
        let discovery = try run("inspect")
        check(discovery.services.first?.discovery == true && discovery.services.first?.pac == false && writes == 0,
              "inspect reports automatic discovery independently of PAC for startup ownership checks")
        current = original
        let initial = try run("inspect")
        check(initial.status == "inactive" && !fm.fileExists(atPath: context.stateRoot) && writes == 0, "inert read creates no directories or network writes")
        let plan = try run("prepare", manual)
        check(plan.canApply && plan.services.count == 3 && !fm.fileExists(atPath: context.stateRoot), "prepare validates selected network services without mutation")
        let applied = try run("apply", manual, plan.revision)
        check(applied.status == "applied" && applied.canRestore && applied.recordID != nil && writes == 1, "confirmed manual change persists restoration evidence")
        let value = try Proxy.dictionary(current.services[0].configuration)
        check((value["HTTPEnable"] as? Int) == 1 && value["HTTPSProxy"] as? String == "127.0.0.1" && value["HTTPSPort"] as? Int == 18191 && value["SOCKSEnable"] as? Int == 0 && value["ProxyAutoConfigEnable"] as? Int == 0, "manual HTTP and HTTPS disable competing PAC/discovery and optional SOCKS")
        check(NSDictionary(dictionary: value["PrivateUnknown"] as? [String: Any] ?? [:]).isEqual(to: try Proxy.dictionary(original.services[0].configuration)["PrivateUnknown"] as? [String: Any] ?? [:]), "unknown proxy keys and opaque credential data survive modification")
        check(current.services[1] == original.services[1] && current.services[2] == original.services[2], "unselected and disabled services stay unchanged")
        check(value["ExceptionsList"] as? [String] == manual.bypass && value["ExcludeSimpleHostnames"] as? Int == 1, "internal bypass list and simple hostname option are explicit")
        let id = applied.recordID!, record = root.appendingPathComponent(id + "/record.json"), active = root.appendingPathComponent("active.json")
        let fileMode = try fm.attributesOfItem(atPath: record.path)[.posixPermissions] as? NSNumber, directoryMode = try fm.attributesOfItem(atPath: record.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber
        check(fileMode?.intValue == 0o600 && directoryMode?.intValue == 0o700, "recovery record is private and directory isolated")
        rejects("old preparation cannot be replayed") { _ = try run("apply", manual, plan.revision) }
        let manualTarget = current, activeBytes = try Data(contentsOf: active), writesBeforeQuit = writes
        let external = try data(["HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": 7890])
        current = Proxy.Snapshot(location: "Location-B", services: [
            Proxy.Service(id: "B", name: "Ethernet", enabled: true, configuration: external)
        ])
        let quit = try run("inspect"), retainedBytes = try Data(contentsOf: active)
        check(quit.status == "conflict" && quit.canRetireDetached && quit.quitProxyPorts == [7890] && !quit.canRestore && quit.recordID == id && writes == writesBeforeQuit && retainedBytes == activeBytes, "idle quit can preserve an externally selected proxy and the original recovery evidence")
        otherConfigurations = [["HTTPEnable": 1, "HTTPProxy": "localhost", "HTTPPort": 18191]]
        check((try run("inspect")).quitProxyPorts == nil, "proxy references in a different configured service or location block quit")
        otherConfigurations = [["__SCOPED__": ["en8": ["HTTPEnable": 1, "HTTPProxy": "localhost", "HTTPPort": 18191]]]]
        check((try run("inspect")).quitProxyPorts == nil, "scoped effective proxy references block quit")
        otherConfigurations = [["ProxyAutoConfigEnable": 1, "ProxyAutoConfigURLString": "https://outside.invalid/pac"]]
        check((try run("inspect")).quitProxyPorts == nil, "automatic scripts can hide references and block quit")
        otherConfigurations = []
        proxyConfigurationsReadable = false
        check((try run("inspect")).quitProxyPorts == nil, "an incomplete proxy read cannot admit quit")
        proxyConfigurationsReadable = true
        var changedExceptions = try Proxy.dictionary(manualTarget.services[0].configuration)
        changedExceptions["ExceptionsList"] = ["external.invalid"]
        current = Proxy.Snapshot(location: manualTarget.location, services: [
            Proxy.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: try data(changedExceptions))
        ] + Array(manualTarget.services.dropFirst()))
        check((try run("inspect")).quitProxyPorts == nil, "an external bypass edit alone cannot release a referenced proxy")
        current = manualTarget
        let pac = Proxy.Settings(mode: "pac", host: "127.0.0.1", port: 18191, socks: false, bypass: manual.bypass, excludeSimple: true, serviceIDs: ["A", "B"], pacURL: "http://127.0.0.1:18192/00000000-0000-0000-0000-000000000001.pac")
        let pacPlan = try run("prepare", pac), switched = try run("apply", pac, pacPlan.revision)
        let pacValue = try Proxy.dictionary(current.services[0].configuration)
        check(switched.status == "applied" && switched.recordID != id && pacValue["ProxyAutoConfigEnable"] as? Int == 1 && pacValue["HTTPEnable"] as? Int == 0 && pacValue["HTTPSEnable"] as? Int == 0 && pacValue["ProxyAutoDiscoveryEnable"] as? Int == 0, "PAC transition retains original chain and disables stale manual/discovery modes")
        let restorePlan = try run("prepareRestore"), restored = try run("restore", nil, restorePlan.revision)
        check(restored.status == "restored" && current == original && !fm.fileExists(atPath: active.path), "restoration after mode changes returns the first complete original including nil protocol values")
        check(fm.fileExists(atPath: record.path), "completed recovery evidence is retained")
        for scenario in ["unrelated", "unrelated-removed", "partial", "renamed-disabled", "owned-conflict", "missing-owned"] {
            current = original
            let scopedPlan = try run("prepare", pac)
            _ = try run("apply", pac, scopedPlan.revision)
            let appliedSnapshot = current
            var services = current.services
            if scenario == "unrelated" {
                services[2] = Proxy.Service(id: "C", name: "Changed external service", enabled: true, configuration: external)
                services.append(Proxy.Service(id: "D", name: "New service", enabled: true, configuration: external))
            } else if scenario == "unrelated-removed" {
                services.removeLast()
            } else if scenario == "partial" {
                services[0] = original.services[0]
            } else if scenario == "renamed-disabled" {
                services[0] = Proxy.Service(id: "A", name: "Renamed Wi-Fi", enabled: false, configuration: services[0].configuration)
            } else if scenario == "owned-conflict" {
                services[0] = Proxy.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: external)
            } else { services.removeFirst() }
            current = Proxy.Snapshot(location: original.location, services: services)
            let observed = current, writesBefore = writes, scopedRestore = try run("prepareRestore")
            if ["owned-conflict", "missing-owned"].contains(scenario) {
                check(!scopedRestore.canRestore, "restore refuses \(scenario)")
                rejects("no write for \(scenario)") { _ = try run("restore", nil, scopedRestore.revision) }
                check(writes == writesBefore && current == observed, "preserve conflicting state for \(scenario)")
                current = appliedSnapshot
                let retry = try run("prepareRestore")
                _ = try run("restore", nil, retry.revision)
            } else {
                let result = try run("restore", nil, scopedRestore.revision)
                check(scopedRestore.canRestore && result.status == "restored", "service-scoped restore completes for \(scenario)")
                check(current.services.filter { !["A", "B"].contains($0.id) } == observed.services.filter { !["A", "B"].contains($0.id) }, "restore preserves unrelated services for \(scenario)")
                check(current.services[0].name == observed.services[0].name && current.services[0].enabled == observed.services[0].enabled && current.services[0].configuration == original.services[0].configuration && current.services[1].configuration == nil, "restore preserves metadata and exact original proxy values for \(scenario)")
            }
        }
        current = original
        behavior = "unchanged"
        let cancelledPlan = try run("prepare", manual), cancelled = try run("apply", manual, cancelledPlan.revision)
        check(cancelled.status == "rolledBack" && current == original && !fm.fileExists(atPath: active.path), "unchanged submission releases only its own active pointer after verification")
        behavior = "rolledBack"
        let rollbackPlan = try run("prepare", manual), rollback = try run("apply", manual, rollbackPlan.revision)
        check(rollback.status == "rolledBack" && current == original, "verified backend rollback is distinguished from uncertainty")
        behavior = "notSubmitted"
        let coldPlan = try run("prepare", manual)
        let cold = try run("apply", manual, coldPlan.revision)
        check(cold.status == "rolledBack" && cold.recordID == nil && !fm.fileExists(atPath: active.path),
              "confirmed no-write releases a new pointer only after reading original OS state")
        behavior = "apply"
        let ownedPlan = try run("prepare", manual), owned = try run("apply", manual, ownedPlan.revision)
        behavior = "notSubmitted"
        let beforeStop = current, stopPlan = try run("prepareRestore")
        let coldStop = try run("restore", nil, stopPlan.revision), afterStop = try run("inspect")
        check(coldStop.status == "rolledBack" && afterStop.status == "active" && afterStop.recordID == owned.recordID &&
              afterStop.canRestore && current == beforeStop,
              "confirmed no-write during restore preserves the active owner's exact prior phase and pointer")
        behavior = "apply"
        let retire = try run("prepareRestore")
        _ = try run("restore", nil, retire.revision)
        behavior = "otherSnapshot"
        let mismatched = try run("prepare", manual), conflicting = try run("apply", manual, mismatched.revision)
        check(conflicting.status == "uncertain" && conflicting.recordID != nil && fm.fileExists(atPath: active.path),
              "a mismatched no-write snapshot keeps the recovery journal")
        let resolve = try run("prepareRestore")
        _ = try run("restore", nil, resolve.revision)
        behavior = "authDenied"
        let deniedPlan = try run("prepare", manual), denied = try run("apply", manual, deniedPlan.revision)
        check(denied.status == "uncertain" && denied.warnings.contains("系统代理阶段 authorization_create 失败，状态码 -60005。") && current == original, "authorization failure reports bounded stage and OS status without claiming application")
        let deniedRestore = try run("prepareRestore")
        check((try run("restore", nil, deniedRestore.revision)).status == "restored" && current == original, "unchanged authorization failure journal is explicitly retired after exact snapshot check")
        behavior = "lostAck"
        let lostPlan = try run("prepare", manual), lost = try run("apply", manual, lostPlan.revision)
        check(lost.status == "uncertain" && lost.canRestore && fm.fileExists(atPath: active.path), "lost acknowledgement preserves original evidence and candidate for manual recovery")
        check(!(try run("prepare", manual)).canApply, "uncertain transaction cannot be silently replaced")
        var externalValue = try Proxy.dictionary(current.services[0].configuration); externalValue["HTTPPort"] = 19999
        let candidate = current
        current = Proxy.Snapshot(location: current.location, services: [Proxy.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: try data(externalValue))] + Array(current.services.dropFirst()))
        let conflict = try run("prepareRestore"), beforeWrites = writes
        check((try run("inspect")).quitProxyPorts == nil, "uncertain transactions never admit external quit")
        check(conflict.status == "conflict" && !conflict.canRestore, "external modification is reported as a conflict")
        rejects("restore never overwrites a stranger's new proxy") { _ = try run("restore", nil, conflict.revision) }
        let externalPort = try Proxy.dictionary(current.services[0].configuration)["HTTPPort"] as? Int
        check(writes == beforeWrites && externalPort == 19999, "conflicting original and external proxy evidence remain intact")
        current = candidate; behavior = "apply"
        let recovery = try run("prepareRestore")
        check((try run("restore", nil, recovery.revision)).status == "restored" && current == original, "explicit recovery works after resolving conflict to the exact owned candidate")
        let detachPlan = try run("prepare", manual), detachApplied = try run("apply", manual, detachPlan.revision)
        let detachHistory = root.appendingPathComponent(detachApplied.recordID!)
        let detachRecord = try Data(contentsOf: detachHistory.appendingPathComponent("record.json"))
        let detachPhase = try Data(contentsOf: detachHistory.appendingPathComponent("phase.json"))
        let stillActive = try run("inspect")
        check(!stillActive.canRetireDetached, "inspect does not admit retirement for an active proxy change")
        rejects("active system proxy record cannot be retired") { _ = try run("retireDetached", nil, stillActive.revision) }
        current = Proxy.Snapshot(location: "Location-B", services: [
            Proxy.Service(id: "B", name: "Ethernet", enabled: true, configuration: external)
        ])
        let detached = try run("inspect"), externalSnapshot = current, writesBeforeRetire = writes
        rejects("retire requires the current inspection revision") { _ = try run("retireDetached", nil, detachApplied.revision) }
        rejects("retire refuses a missing revision") { _ = try run("retireDetached") }
        otherConfigurations = [["__SCOPED__": ["en8": ["HTTPEnable": 1, "HTTPProxy": "localhost", "HTTPPort": 18191]]]]
        let scoped = try run("inspect")
        check(scoped.currentLoopbackProxyPorts == [7890, 18191], "a conflicting service retains the scoped local session listener")
        check(scoped.revision == detached.revision && !scoped.canRetireDetached, "inspect withdraws retirement eligibility when a scoped reference appears")
        rejects("retire rereads scoped references even when the current location revision is unchanged") {
            _ = try run("retireDetached", nil, detached.revision)
        }
        otherConfigurations = []
        let retired = try run("retireDetached", nil, detached.revision)
        let recordAfterRetire = try Data(contentsOf: detachHistory.appendingPathComponent("record.json"))
        let phaseAfterRetire = try Data(contentsOf: detachHistory.appendingPathComponent("phase.json"))
        check(retired.status == "inactive" && !retired.canRetireDetached && retired.recordID == nil && current == externalSnapshot && writes == writesBeforeRetire && !fm.fileExists(atPath: active.path) && recordAfterRetire == detachRecord && phaseAfterRetire == detachPhase, "retire clears only the active pointer and keeps external proxy and history")
        rejects("retire cannot be replayed after clearing the pointer") { _ = try run("retireDetached", nil, detached.revision) }
        current = manualTarget
        let noopPlan = try run("prepare", manual), noopApplied = try run("apply", manual, noopPlan.revision)
        let noopInspection = try run("inspect"), writesBeforeNoopRetire = writes
        check(noopInspection.status == "active" && noopInspection.canRetireDetached && noopInspection.quitProxyPorts == nil, "inspect reports no-op retirement separately from the quit conflict proof")
        let noopRetired = try run("retireDetached", nil, noopInspection.revision)
        check(noopApplied.status == "applied" && noopRetired.status == "inactive" && writes == writesBeforeNoopRetire && !fm.fileExists(atPath: active.path), "settled no-op transaction needs no system restore before retirement")
        let noRecordPorts = try run("inspect")
        check(noRecordPorts.recordID == nil && noRecordPorts.currentProxyPorts == [18191], "manual proxy references remain observable without a recovery record")
        otherConfigurations = [["ProxyAutoConfigEnable": 1, "ProxyAutoConfigURLString": "http://127.0.0.1:19000/proxy.pac"]]
        let mixedPAC = try run("inspect")
        check(mixedPAC.currentProxyPorts == [18191, 19000] && mixedPAC.currentPacURLHashes == [NetworkConfiguration.digest(Data("http://127.0.0.1:19000/proxy.pac".utf8))], "an unrelated PAC cannot hide a known manual core endpoint")
        otherConfigurations = [["ProxyAutoConfigEnable": 1, "ProxyAutoConfigURLString": "http://localhost:18192/alias.pac"]]
        let aliasedPAC = try run("inspect")
        check(aliasedPAC.currentProxyPorts == [18191, 18192] && aliasedPAC.currentLoopbackProxyPorts == [18191, 18192], "PAC loopback hostname aliases retain their explicit listener port")
        otherConfigurations = [
            ["HTTPEnable": 1, "HTTPProxy": "remote.invalid", "HTTPPort": 17890],
            ["__SCOPED__": ["en8": ["SOCKSEnable": 1, "SOCKSProxy": "::1", "SOCKSPort": 17891]]],
            ["ProxyAutoConfigEnable": 1, "ProxyAutoConfigURLString": "http://remote.invalid:18192/other.pac"]
        ]
        let scopedEndpoints = try run("inspect")
        check(scopedEndpoints.currentProxyPorts == [17890, 17891, 18191, 18192] && scopedEndpoints.currentLoopbackProxyPorts == [17891, 18191], "an external manual or PAC URL on a matching port cannot claim a local TUN listener")
        otherConfigurations = []
        let originalManual = Proxy.Snapshot(location: original.location, services: [
            Proxy.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: external)
        ] + Array(original.services.dropFirst()))
        current = originalManual
        let returnedPlan = try run("prepare", manual)
        _ = try run("apply", manual, returnedPlan.revision)
        current = originalManual
        let returnedOriginal = try run("inspect"), writesBeforeReturnedRetire = writes
        check(returnedOriginal.status == "pending" && returnedOriginal.canRestore && returnedOriginal.canRetireDetached && returnedOriginal.quitProxyPorts == nil, "inspect recognizes a settled proxy already returned to the original manual values")
        let returnedRetired = try run("retireDetached", nil, returnedOriginal.revision)
        check(returnedRetired.status == "inactive" && current == originalManual && writes == writesBeforeReturnedRetire, "returning to the original proxy permits history-only retirement")
        struct LifecycleRecord: Decodable {
            let id: String
            let parent: String?
            let original: Proxy.Snapshot
            let before: Proxy.Snapshot
        }
        for scenario in ["external-7890", "external-off"] {
            current = original
            let firstPlan = try run("prepare", manual)
            let firstApply = try run("apply", manual, firstPlan.revision)
            check(firstApply.status == "applied", "\(scenario) lifecycle first apply succeeds")
            let oldHistory = root.appendingPathComponent(firstApply.recordID!)
            let oldRecordBytes = try Data(contentsOf: oldHistory.appendingPathComponent("record.json"))
            let oldPhaseBytes = try Data(contentsOf: oldHistory.appendingPathComponent("phase.json"))
            var externalValues: [String: Any] = [
                "HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0,
                "ProxyAutoConfigEnable": 0, "ProxyAutoDiscoveryEnable": 0,
                "ExceptionsList": ["external.local"], "ExternalOpaque": Data([4, 5, 6])
            ]
            if scenario == "external-7890" {
                for prefix in ["HTTP", "HTTPS", "SOCKS"] {
                    externalValues[prefix + "Enable"] = 1
                    externalValues[prefix + "Proxy"] = "127.0.0.1"
                    externalValues[prefix + "Port"] = 7890
                }
            }
            // The off variant removes endpoint keys rather than replaying the
            // first original or target; both variants are independent edits.
            current = Proxy.Snapshot(location: original.location, services: [
                Proxy.Service(id: "A", name: "Wi-Fi", enabled: true, configuration: try data(externalValues))
            ] + Array(original.services.dropFirst()))
            let externalBaseline = current, beforeRetirementWrites = writes
            let observed = try run("inspect")
            check(observed.status == "conflict" && !observed.canRestore && observed.canRetireDetached && observed.recordID == firstApply.recordID, "\(scenario) lifecycle proves detached conflict")
            check(observed.currentProxyPorts == (scenario == "external-7890" ? [7890] : []), "\(scenario) lifecycle observes only the external proxy references")
            let retired = try run("retireDetached", nil, observed.revision)
            check(retired.status == "inactive" && retired.recordID == nil && current == externalBaseline && writes == beforeRetirementWrites, "\(scenario) lifecycle retirement performs zero system writes")
            check(try !fm.fileExists(atPath: active.path) && Data(contentsOf: oldHistory.appendingPathComponent("record.json")) == oldRecordBytes && Data(contentsOf: oldHistory.appendingPathComponent("phase.json")) == oldPhaseBytes, "\(scenario) lifecycle retirement preserves both history files")
            let nextPlan = try run("prepare", manual)
            check(nextPlan.canApply && nextPlan.recordID == nil && nextPlan.revision == retired.revision && current == externalBaseline && writes == beforeRetirementWrites, "\(scenario) lifecycle fresh prepare permits explicit reapply without mutation")
            let reapplied = try run("apply", manual, nextPlan.revision)
            check(reapplied.status == "applied" && reapplied.canRestore && reapplied.recordID != firstApply.recordID && writes == beforeRetirementWrites + 1, "\(scenario) lifecycle reapply creates one new transaction")
            let newHistory = root.appendingPathComponent(reapplied.recordID!)
            let newRecord = try JSONDecoder().decode(LifecycleRecord.self, from: Data(contentsOf: newHistory.appendingPathComponent("record.json")))
            check(try newRecord.id == reapplied.recordID && newRecord.parent == nil && Proxy.changedServiceIDs(newRecord.original, externalBaseline).isEmpty && Proxy.changedServiceIDs(newRecord.before, externalBaseline).isEmpty, "\(scenario) lifecycle new original and before are the exact external baseline")
            let restorePlan = try run("prepareRestore")
            let restored = try run("restore", nil, restorePlan.revision)
            check(restored.status == "restored" && restored.recordID == nil && current == externalBaseline && writes == beforeRetirementWrites + 2 && !fm.fileExists(atPath: active.path), "\(scenario) lifecycle restore returns the external baseline exactly")
            check(try Data(contentsOf: oldHistory.appendingPathComponent("record.json")) == oldRecordBytes && Data(contentsOf: oldHistory.appendingPathComponent("phase.json")) == oldPhaseBytes && fm.fileExists(atPath: newHistory.appendingPathComponent("record.json").path), "\(scenario) lifecycle retains old and new history after restore")
        }
        current = original
        let copiedPlan = try run("prepare", pac)
        _ = try run("apply", pac, copiedPlan.revision)
        otherConfigurations = [["__SCOPED__": ["external": ["ProxyAutoConfigEnable": 1, "ProxyAutoConfigURLString": pac.pacURL!]]]]
        let copiedRestore = try run("prepareRestore")
        _ = try run("restore", nil, copiedRestore.revision)
        let copiedInspection = try run("inspect")
        check(copiedInspection.recordID == nil && copiedInspection.currentPacURLHashes?.contains(NetworkConfiguration.digest(Data(pac.pacURL!.utf8))) == true, "PAC copied to another scope stays detectable after scoped restoration clears the record")
        otherConfigurations = []
        current = original
        let stalePlan = try run("prepare", manual)
        current = Proxy.Snapshot(location: "Location-B", services: original.services)
        rejects("location changes invalidate pending submission") { _ = try run("apply", manual, stalePlan.revision) }
        current = original
        let bad = Proxy.Settings(mode: "pac", host: "127.0.0.1", port: 18191, socks: false, bypass: [], excludeSimple: false, serviceIDs: ["A"], pacURL: "https://remote.invalid/arbitrary.pac")
        rejects("remote or arbitrary PAC source is refused by native admission") { _ = try run("prepare", bad) }
        let fakeLive = Proxy.Environment(read: { throw AssistantError("must not inspect live") }, change: { _, _ in throw AssistantError("must not write live") }, isLive: true)
        rejects("fake HOME cannot redirect the live system transaction") { _ = try Proxy.perform(input("apply", manual, stalePlan.revision), environment: fakeLive) }
        try NetworkConfiguration.safeWrite(Data("unknown keep".utf8), to: active)
        rejects("unknown own recovery record is preserved rather than reset") { _ = try run("inspect") }
        check(try Data(contentsOf: active) == Data("unknown keep".utf8), "unknown journal bytes are unchanged")
        check(!String(data: try JSONEncoder().encode(initial), encoding: .utf8)!.contains("PRIVATE"), "public report omits original credential values")
    } catch { check(false, "unexpected fixture error: \(error)") }
    let passed = rows.filter { $0["passed"] as? Bool == true }.count
    let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows, "actualSystemConfigurationChanged": false, "backend": "injected native snapshot/change with real private journal IO", "actualHostProxyAccepted": false]
    if let bytes = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), let output = String(data: bytes, encoding: .utf8) { print(output) }
    return passed == rows.count ? 0 : 1
}
