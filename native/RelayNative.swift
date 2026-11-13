import Foundation

private struct PreviewInput: Decodable {
    let httpPort: Int
    let node: String
    let internalExceptions: String
    let existingJSON: String
}

@main struct RelayNative {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["--automatic-uninstall-self-test"] {
            var results = [runRelayCodeSelfTests(), runRelayRestoreSelfTests(), runRelayRecoveryPreflightSelfTests()]
            results.append(await runRelayAutomaticUninstallSelfTests()); exit(results.max() ?? 1)
        }
        if args == ["--desktop-session"] { exit(await RelayDesktopProcess.run()) }
        if args == ["--desktop-self-test"] {
            var results = [runRelayDesktopReadinessSelfTests(), runRelayDesktopStoreSelfTests()]
            results.append(await runRelayDesktopSessionSelfTests())
            results.append(await runRelayDesktopHostSelfTests())
            results.append(await runRelayEdgeToolSelfTests())
            exit(results.max() ?? 1)
        }
        if args == ["--guard-self-test"] { exit(runGuardSelfTests()) }
        if args == ["--system-proxy-self-test"] { exit(runRelaySystemProxySelfTests()) }
        if args == ["--tun-descriptor-self-test"] { exit(runRelayTunDescriptorSelfTests()) }
        if args == ["--tun-descriptor-fixture"] { exit(runRelayTunDescriptorFixtureChild()) }
        if args == ["--self-test"] {
            var results = [runSelfTests(), runDesktopLoginSelfTests(), runGuardSelfTests(), runCriticalCheckSelfTests(), runDiagnosticsRegressionTests(), runGuardPlanRegressionTests(), runTransactionRegressionTests(), runRelayReadOnlySelfTests(), runRelayPreferenceSelfTests(), runRelayRecoverySelfTests(), runRelayRecoveryPreflightSelfTests(), runRelayBrowserProcessSelfTests(), runRelayRestoreSelfTests(), runRelayCodeSelfTests(), runRelayBrowserSelfTests(), runRelayDesktopReadinessSelfTests(), runRelayDesktopStoreSelfTests()]
            results.append(await runRelayDesktopSessionSelfTests())
            results.append(await runRelayDesktopHostSelfTests())
            results.append(await runRelayEdgeToolSelfTests())
            results.append(runRelayGuardReadinessSelfTests())
            results.append(runRelaySystemProxySelfTests())
            results.append(runRelayTunDescriptorSelfTests())
            exit(results.max() ?? 1)
        }
        do {
            if args == ["--automatic-uninstall-status"] {
                let report = (try? RelayAutomaticUninstall.AuthorityEnvironment.live()).map(RelayAutomaticUninstall.status) ??
                    RelayAutomaticUninstall.Status(requested: false, nativeExecutable: nil)
                print(try RelayReadOnly.encode(report)); return
            }
            if args == ["--automatic-uninstall-user"] {
                print(try RelayReadOnly.encode(await RelayAutomaticUninstall.performUser())); return
            }
            if args == ["--backup-file"] {
                var data = Data()
                while true {
                    let part = FileHandle.standardInput.readData(ofLength: 1024 * 1024)
                    if part.isEmpty { break }; data.append(part)
                    guard data.count <= 360 * 1024 * 1024 else { throw AssistantError("输入过长。") }
                }
                let input = try RelayBackupMove.decodeFile(data)
                print(try RelayReadOnly.encode(RelayBackupMove.publishFile(input)))
                return
            }
            if args == ["--backup-journal"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                let input = try RelayBackupMove.decodePublish(data)
                print(try RelayReadOnly.encode(RelayBackupMove.publish(input)))
                return
            }
            if args == ["--backup-move"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                let input = try RelayBackupMove.decode(data)
                print(try RelayReadOnly.encode(RelayBackupMove.perform(input)))
                return
            }
            if args == ["--system-proxy"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelaySystemProxy.Input.self, from: data)
                print(try RelayReadOnly.encode(RelaySystemProxy.perform(input)))
                return
            }
            if args == ["--core-preferences"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 65536 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayCorePreferences.Input.self, from: data)
                print(try RelayReadOnly.encode(RelayCorePreferences.perform(input)))
                return
            }
            if args == ["--core-record-recovery"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 65536 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayCoreRecovery.Input.self, from: data)
                print(try RelayReadOnly.encode(RelayCoreRecovery.perform(input)))
                return
            }
            if args == ["--runtime-script-v2"] {
                let context = try RelayRuntimeScript.prepareContext()
                // FileHandle writes directly to the inherited descriptor. The
                // completed write has no stdio buffer waiting for a newline.
                try FileHandle.standardOutput.write(contentsOf: RelayRuntimeScript.readyV2)
                let data = try RelayRuntimeScript.readInputV2()
                let input = try JSONDecoder().decode(RelayRuntimeScript.Input.self, from: data)
                print(try RelayRuntimeScript.evaluate(input, preparedContext: context))
                return
            }
            if args == ["--runtime-script"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 6291456 else { throw RelayRuntimeScript.Failure.invalidInput }
                let input = try JSONDecoder().decode(RelayRuntimeScript.Input.self, from: data)
                print(try RelayRuntimeScript.evaluate(input))
                return
            }
            if args == ["--guard-host-resource-inspect"] {
                print(try RelayReadOnly.encode(RelayGuardHostIntegrity.inspect(executable: URL(fileURLWithPath: CommandLine.arguments[0]))))
                return
            }
            if args == ["--guard-status"] {
                // Preserve the invocation path: Foundation's standardize can
                // turn /private/var into the /var symlink alias on macOS.
                let executable = URL(fileURLWithPath: CommandLine.arguments[0])
                print(try RelayReadOnly.encode(RelayGuardReadiness.inspect(executable: executable)))
                return
            }
            if args == ["--critical-preview"] {
                struct Sample: Encodable {
                    let sample = true
                    let observed = false
                    let readOnly = true
                    let checks = CriticalDiagnostics.rows(.preview)
                }
                print(try RelayReadOnly.encode(Sample()))
                return
            }
            if args == ["--edge-tools"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 65536 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayEdgeToolInput.self, from: data)
                if input.action == .inspect {
                    guard input.expectedRevision == nil else { throw AssistantError("检查不接受版本参数。") }
                    _ = try RelayPreferenceStore(input.context)
                    print(try RelayReadOnly.encode(RelayEdgeTools.inspect(.live)))
                } else {
                    let actual = RelayBrowserContract.context(home: try RelayBrowserContract.realHome())
                    guard input.context.home == actual.home, input.context.stateRoot == actual.stateRoot else {
                        throw AssistantError("只接受当前用户固定数据目录。")
                    }
                    print(try await RelayReadOnly.encode(RelayEdgeTools.perform(input, environment: .live)))
                }
                return
            }
            if args == ["--desktop-readiness"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let context = try JSONDecoder().decode(RelayStateContext.self, from: data)
                print(try RelayReadOnly.encode(RelayDesktopInspection.inspect(context)))
                return
            }
            if args == ["--code-prepare"] || args == ["--code-apply"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayCodeInput.self, from: data)
                if args == ["--code-prepare"] { print(try RelayReadOnly.encode(RelayCodeConfiguration.prepare(input))) }
                else { print(try RelayReadOnly.encode(RelayCodeConfiguration.apply(input))) }
                return
            }
            if args == ["--recovery-restore"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayRestoreInput.self, from: data)
                print(try RelayReadOnly.encode(RelayRestore.execute(input)))
                return
            }
            if args == ["--recovery-preflight"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayRecoveryPreflightInput.self, from: data)
                print(try RelayReadOnly.encode(RelayRecoveryInspector.inspect(input)))
                return
            }
            if args == ["--recovery-status"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let context = try JSONDecoder().decode(RelayStateContext.self, from: data)
                print(try RelayReadOnly.encode(RelayRecovery.status(context)))
                return
            }
            if args == ["--preferences"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayPreferenceInput.self, from: data)
                let store = try RelayPreferenceStore(input.context)
                let result: RelayPreferenceSnapshot
                switch input.action {
                case .read: result = try store.load()
                case .save:
                    guard let preferences = input.preferences, let revision = input.revision else { throw AssistantError("偏好保存参数不完整。") }
                    result = try store.save(preferences, expectedRevision: revision)
                }
                print(try RelayReadOnly.encode(result))
                return
            }
            if args == ["--edge-profile"] {
                let output: [String: Any] = ["profileXML": String(decoding: try NetworkConfiguration.edgeProfileData(), as: UTF8.self),
                    "installed": false,
                    "warnings": ["只生成描述文件文本，没有安装、打开系统设置或修改 Edge。",
                        "安装后影响当前用户的所有 Edge 资料；需先核对组织策略和已有描述文件。",
                        "使用固定 SOCKS 端口17890；本地回调保留直连。描述文件不代表真实 DNS/WebRTC 检测已通过。"]]
                print(String(decoding: try NetworkConfiguration.encode(output), as: UTF8.self))
                return
            }
            if args == ["--diagnose"] || args == ["--status"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayDiagnosticInput.self, from: data)
                print(try RelayReadOnly.encode(RelayReadOnly.live(input)))
                return
            }
            if args == ["--guard-plan"] {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count <= 524288 else { throw AssistantError("输入过长。") }
                let input = try JSONDecoder().decode(RelayGuardPlanInput.self, from: data)
                guard let plan = try? GuardDeploymentPlan.make(node: input.node, proxyTypes: input.proxyTypes) else {
                    throw AssistantError("无法确认目标为已知的具体代理节点，未生成部署方案。")
                }
                let output: [String: Any] = ["plan": plan,
                    "warnings": ["依据最近只读核心快照生成；导出不应用配置，也不启用保护。", "节点及链路在部署前仍须复核，需单独完成签名、授权和运行时阻断验收。"]]
                print(String(decoding: try NetworkConfiguration.encode(output), as: UTF8.self))
                return
            }
            if args == ["--simulate"] || args == ["--guard-simulate"] {
                let rows = GuardSimulation.run().map { row in
                    ["name": row.name, "expected": row.expected, "actual": row.actual, "passed": row.passed] as [String: Any]
                }
                let output: [String: Any] = ["rows": rows, "protected": false,
                    "warnings": ["只运行内存中的策略判断，没有制造断网、发送请求或启用过滤器。", "模拟通过不代表真实 Claude 流量已受保护；未知身份及系统代发请求仍须单独验收。"]]
                print(String(decoding: try NetworkConfiguration.encode(output), as: UTF8.self))
                return
            }
            guard args == ["--preview"] else { throw AssistantError("不支持的原生操作，没有修改配置。") }
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 524288 else { throw AssistantError("输入过长。") }
            let input = try JSONDecoder().decode(PreviewInput.self, from: data)
            var settings = AssistantSettings()
            settings.httpPort = input.httpPort; settings.node = input.node; settings.internalExceptions = input.internalExceptions
            try settings.validate()
            var json = try NetworkConfiguration.json(Data(input.existingJSON.utf8))
            guard json["env"] == nil || json["env"] is [String: Any] else { throw AssistantError("已有env必须为对象，未生成修改。") }
            var env = json["env"] as? [String: Any] ?? [:]
            var existing: [String] = []
            for key in ["NO_PROXY", "no_proxy"] {
                if let value = env[key] {
                    guard let string = value as? String else { throw AssistantError("已有直连例外必须为字符串。") }
                    existing.append(string)
                }
            }
            let noProxy = try NetworkConfiguration.mergedNoProxy(existing: existing, additions: input.internalExceptions)
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] { env[key] = "http://127.0.0.1:\(input.httpPort)" }
            env["NO_PROXY"] = noProxy; env["no_proxy"] = noProxy
            // Drafts preserve BROWSER. The separate, confirmed Code transaction
            // owns migration to the bundled browser entry.
            json["env"] = env
            let plan = try NetworkConfiguration().plan(settings)
            // Keep the same section extraction used by the original copy buttons.
            let snippets = plan.components(separatedBy: "```yaml\n").dropFirst().map { $0.components(separatedBy: "```")[0] }
            guard snippets.count == 3 else { throw AssistantError("方案片段结构异常，未生成结果。") }
            let output: [String: Any] = ["settingsJSON": String(decoding: try NetworkConfiguration.encode(json), as: UTF8.self),
                "noProxy": noProxy, "plan": plan,
                "rules": snippets[0], "dns": snippets[1], "listeners": snippets[2],
                "warnings": ["仅预览，未读取或写入实际配置，也未连接内核。", "节点未经运行核心确认；草稿保持BROWSER原值，实际入口需单独通过Code联合配置应用。", "过滤扩展未启用；本结果不代表禁止直连已生效。"]]
            print(String(decoding: try NetworkConfiguration.encode(output), as: UTF8.self))
        } catch {
            // Parser errors may include credentials; return only our controlled errors.
            fputs((error as? AssistantError)?.message ?? "无法完成原生操作，请检查输入格式。", stderr)
            exit(1)
        }
    }
}
