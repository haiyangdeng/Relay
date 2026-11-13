import Darwin
import Foundation

extension RelayMaintenanceFailure {
    var explanation: String {
        if self == .ownedRuntimePending {
            return "探测、Sub-Store 或受限 CLI 子进程目录仍存在或归属未知。请先通过其原入口核实并收尾原记录；无法证实全部后代退出时保留目录，不停止其他应用或连接。"
        }
        if self == .helperPending {
            return "Relay 原生助手仍在运行或其身份/动作未确认。请通过原操作核实其结束后再检查；没有停止助手、其他应用或连接。"
        }
        return rawValue
    }
}

extension RelayMaintenanceGate {
    // Additional to the owning TS readonly journal inspectors. A C07/C08 Core
    // writes outside Core/.session and may outlive a crashed Main. Presence is
    // never promoted to idle from a PID, name, missing owner or terminal string.
    // Only the owning lifecycle/recovery may remove/archive those directories;
    // this gate never adopts a process, runs a child, signals, mutates or deletes.
    static func ownedWorkspacesIdle(root: URL) throws {
        do {
            let home = try RelayBrowserContract.realHome()
            guard root.path.hasPrefix(home.path + "/") else { throw RelayMaintenanceFailure.unsafe }
            func directory(_ suffix: [String]) throws -> RelayMaintenanceDirectory? {
                let path = suffix.reduce(root) { $0.appendingPathComponent($1) }
                guard try RelayCoreRecovery.directory(path, home: home) != nil else { return nil }
                let parts = path.path.dropFirst(home.path.count + 1).split(separator: "/").map(String.init)
                return try RelayMaintenanceDirectory(home: home.path, components: parts)
            }
            for suffix in [["Diagnostics", "Probe"], ["ScopedCLI"]] {
                if let workspace = try directory(suffix) {
                    // Includes empty p-* / CLI workspace, missing/corrupt owner,
                    // preparing pid=null, parser/start gap and possible writers.
                    // Scoped CLI parent close cannot prove that every detached
                    // descendant has stopped writing its inherited private HOME.
                    guard try workspace.list().isEmpty else { throw RelayMaintenanceFailure.ownedRuntimePending }
                    try workspace.verify()
                }
            }
            for parent in ["CoreOwner", "SubStore"] {
                if let substore = try directory([parent]) {
                var value = stat()
                if fstatat(substore.fd, ".session", &value, AT_SYMLINK_NOFOLLOW) == 0 {
                    throw RelayMaintenanceFailure.ownedRuntimePending
                }
                guard errno == ENOENT else { throw RelayMaintenanceFailure.ownedRuntimePending }
                try substore.verify()
                }
            }
        } catch { throw RelayMaintenanceFailure.ownedRuntimePending }
    }
}
