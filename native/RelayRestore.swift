import Foundation

struct RelayRestoreInput: Decodable {
    let context: RelayStateContext
    let selection: RelayRecoverySelection
    let expectedRevision: String
    let allowLegacy: Bool
}
struct RelayRestoreResult: Encodable {
    let status = "restored"
    let warnings = ["所选备份的目标已恢复；没有重载代理、重启网络、关闭浏览器或修改系统默认浏览器。",
        "客户端是否需要重新启动由用户决定；本次没有自动重启任何应用。"]
}
enum RelayRestore {
    static func execute(_ input: RelayRestoreInput, browserObservation: ((URL) -> String)? = nil,
                        beforeEntry: ((Int) throws -> Void)? = nil) throws -> RelayRestoreResult {
        try input.selection.validate()
        guard input.expectedRevision.count == 64, input.expectedRevision.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw AssistantError("恢复预检版本无效。")
        }
        let paths = try RelayPreferenceStore(input.context)
        let root = input.selection.source == "relay" ? paths.root : paths.legacyRoot
        let profile = input.selection.source == "relay" ? paths.root.appendingPathComponent("Private Browser") :
            paths.home.appendingPathComponent("Library/Application Support/Claude Private Browser")
        let directory = root.appendingPathComponent("Backups").appendingPathComponent(input.selection.id)
        let inspectInput = RelayRecoveryPreflightInput(context: input.context, selection: input.selection)
        let observe = browserObservation ?? { RelayBrowserProcesses.status($0) }
        func eligible(_ report: RelayRecoveryPreflight) -> Bool {
            !report.targets.isEmpty && !["unreadable", "restored", "rolledBack"].contains(report.phase) &&
            report.issues.allSatisfy { input.allowLegacy && ["legacyConfirmationRequired", "targetModeUnknown"].contains($0) } &&
            ["closed", "notApplicable"].contains(report.browser)
        }
        // Refuse invalid or outdated proofs before creating either lock directory.
        let initial = try RelayRecoveryInspector.inspect(inspectInput, browserObservation: observe)
        guard initial.revision == input.expectedRevision, eligible(initial) else { throw AssistantError("预检已改变或仍有阻止项，未执行恢复。") }
        let backend = NetworkConfiguration(home: paths.home,
            diagnosticPaths: (paths.home.appendingPathComponent("Library/Application Support/mihomo-party"), profile),
            supportRoot: root, stateLock: RelayStateLock(root: paths.root))
        var targets: [(URL, RelayRecoveryInspector.FileObservation?)] = []
        var touchesBrowser = false
        func restore() throws {
        try backend.restore(directory, allowLegacy: input.allowLegacy, lockedPreflight: { manifest, originals in
            let report = try RelayRecoveryInspector.inspect(inspectInput, browserObservation: observe)
            guard report.revision == input.expectedRevision, eligible(report),
                  let current = try RelayRecoveryInspector.read(directory.appendingPathComponent("manifest.json"), limit: 1048576) else {
                throw AssistantError("配置在确认后改变，未执行恢复。")
            }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            let decoded = try JSONDecoder().decode(BackupManifest.self, from: current.data)
            guard try encoder.encode(decoded) == encoder.encode(manifest) else { throw AssistantError("清单在预检后改变。") }
            for (index, entry) in manifest.entries.enumerated() {
                let saved = entry.originalExists ? try RelayRecoveryInspector.read(directory.appendingPathComponent(entry.backupName))?.data : nil
                guard saved == originals[index] else { throw AssistantError("原始备份在预检后改变。") }
                targets.append((URL(fileURLWithPath: entry.path), try RelayRecoveryInspector.read(URL(fileURLWithPath: entry.path))))
            }
            touchesBrowser = report.targets.contains { $0.target.hasPrefix("browser") }
        }, beforeRestoreEntry: { index in
            try beforeEntry?(index)
            guard index < targets.count else { throw AssistantError("恢复目标编号无效。") }
            if touchesBrowser && observe(profile) != "closed" { throw AssistantError("浏览器在恢复期间启动或状态无法确认。") }
            let (url, expected) = targets[index]
            let actual = try RelayRecoveryInspector.read(url)
            guard actual?.data == expected?.data, actual?.mode == expected?.mode else {
                throw AssistantError("目标在恢复期间发生后续更改，未覆盖该目标。")
            }
        })
        }
        if input.selection.source == "relay" && initial.targets.contains(where: { $0.target.hasPrefix("browser") }) {
            try RelayBrowserLauncher.launchLock(paths.root).withLock { try restore() }
        } else { try restore() }
        return RelayRestoreResult()
    }
}
