import Foundation
import Darwin

/// Namespace/job/receipt changes below are sets and booleans. Only the fixed
/// fence implementation touches this test's private ordinary-UID directory.
enum RelayTunUninstallArchiveTests {
    private final class State {
        var remaining = Set(RelayTunInstallationPaths.files)
        var directories = Set(RelayTunInstallationPaths.ownedDirectories)
        var loaded = true, receipt = true, intent = true, failFence = true
        var events: [String] = []
    }
    static func run(root: String, check: (Bool, String) -> Void) throws {
        let revision = String(repeating: "f", count: 64), state = State()
        var pins = Dictionary(uniqueKeysWithValues: RelayTunInstallationPaths.files.map { ($0, String(repeating: "a", count: 64)) })
        pins[RelayTunInstallationPaths.manifest] = revision
        for (arch, path) in RelayTunInstallationPaths.cores { pins[path] = RelayTunInstallationPaths.fixedCorePins[arch]!.0 }
        let intent = try JSONSerialization.data(withJSONObject: ["version": 1, "role": "network-executor-v1-uninstall", "service": RelayTunInstallationPaths.service,
            "receiptID": RelayTunInstallationPaths.receiptID, "clientUID": getuid(), "pins": pins], options: [.sortedKeys])
        let plan = try RelayTunRemovalPlan.parseIntent(intent, expectedManifestSHA256: revision)
        let fence = try RelayTunUninstallFence.isolated(parent: root)
        func environment(_ retire: @escaping () throws -> Void) -> RelayTunRemovalPlan.Environment {
            .init(verify: { state.events.append("verify") }, jobPresent: { state.loaded }, bootout: {
                state.events.append("bootout"); state.loaded = false
            }, receiptPresent: { state.receipt }, removeFile: { path, pin in
                guard plan.pins[path] == pin else { throw RelayTunHelperFailure.changedResource }
                state.events.append(path == RelayTunInstallationPaths.uninstaller ? "removeUninstaller" : "removePayload")
                state.remaining.remove(path)
            }, removeDirectory: { state.directories.remove($0) }, forgetReceipt: { state.receipt = false }, otherPathsAbsent: {
                state.remaining.isSubset(of: [RelayTunInstallationPaths.uninstaller]) && state.directories.isEmpty
            }, removeIntent: { state.events.append("removeIntent"); state.intent = false }, restoreIntent: { state.intent = true }, allPathsAbsent: {
                state.remaining.isEmpty && state.directories.isEmpty && !state.intent
            }, beforeFinalRemoval: {
                guard !state.loaded, !state.receipt, state.remaining == [RelayTunInstallationPaths.uninstaller], state.intent else { throw RelayTunHelperFailure.unsafeInstallation }
                state.events.append("retireFence")
                if state.failFence { throw RelayTunUninstallFence.Failure.uncertain }
                try retire()
            })
        }
        var completed = false
        do { try fence.withRemoval(manifestSHA256: revision) { retire in try plan.execute(environment(retire)) }; completed = true } catch { }
        check(!completed && !state.loaded && !state.receipt && state.remaining == [RelayTunInstallationPaths.uninstaller] && state.intent,
              "failed fence synchronization preserves the pinned uninstaller and exact recovery intent after payload removal")
        check(try !fence.fenceAbsent(), "uncertain final namespace keeps durable fence without deleting unknown objects")
        state.failFence = false
        try fence.withRemoval(manifestSHA256: revision) { retire in try plan.execute(environment(retire)) }
        check(state.remaining.isEmpty && state.directories.isEmpty && !state.intent && !state.loaded && !state.receipt,
              "explicit retry completes the same removal after fixed payload/job absence")
        check(state.events.filter { $0 == "bootout" }.count == 1 && Array(state.events.suffix(3)) == ["retireFence", "removeIntent", "removeUninstaller"],
              "retry never repeats bootout and retires fence before destroying its pinned recovery entry")
        check(try fence.fenceAbsent(), "completed removal leaves no active fence while immutable audit history remains outside installation")
    }
}
