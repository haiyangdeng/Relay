import AppKit
import CryptoKit
import Darwin
import Foundation
import Security

// Uses the existing signed-Main contract. A null publisher is unavailable,
// never substituted by a renderer readiness flag or a guessed Team identifier.
enum RelayMaintenanceGate {
    static func ownIdentity() throws {
        guard getuid() > 0, geteuid() == getuid(), let team = RelayGuardManagementRelease.publisherTeamID,
              team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil,
              Bundle.main.bundleIdentifier == RelayGuardContract.applicationID,
              Bundle.main.bundleURL.pathExtension == "app" else { throw RelayMaintenanceFailure.publisher }
        let expression = "anchor apple generic and identifier \"" + RelayGuardContract.applicationID + "\" and certificate leaf[subject.OU] = \"" + team + "\""
        let requirement = try codeRequirement(expression)
        var running: SecCode?, envelope: SecStaticCode?
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode).union(.noNetworkAccess)
        guard SecCodeCopySelf([], &running) == errSecSuccess, let running,
              SecCodeCheckValidity(running, .noNetworkAccess, requirement) == errSecSuccess,
              SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &envelope) == errSecSuccess, let envelope,
              SecStaticCodeCheckValidity(envelope, flags, requirement) == errSecSuccess else { throw RelayMaintenanceFailure.identity }
    }
    static func codeRequirement(_ text: String) throws -> SecRequirement {
        var result: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &result) == errSecSuccess, let result else { throw RelayMaintenanceFailure.identity }
        return result
    }
    static func process(_ pid: pid_t) throws -> proc_bsdinfo {
        var info = proc_bsdinfo()
        guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { throw RelayMaintenanceFailure.identity }
        return info
    }
    static func descendant(_ pid: pid_t) -> Bool {
        var current = pid, seen = Set<pid_t>()
        for _ in 0..<32 {
            if current == getpid() { return true }
            guard seen.insert(current).inserted, let info = try? process(current), info.pbi_ppid > 1 else { return false }
            current = pid_t(info.pbi_ppid)
        }
        return false
    }
    @MainActor static func noOtherOwnMain() throws {
        try ownIdentity()
        guard let team = RelayGuardManagementRelease.publisherTeamID else { throw RelayMaintenanceFailure.publisher }
        let known = Dictionary(NSWorkspace.shared.runningApplications.compactMap { app -> (pid_t, String)? in
            guard !app.isTerminated, let id = app.bundleIdentifier,
                  id == RelayGuardContract.applicationID || id.hasPrefix(RelayGuardContract.applicationID + ".helper") else { return nil }
            return (app.processIdentifier, id)
        }, uniquingKeysWith: { first, _ in first })
        // Reuse RelayBrowserProcesses' bounded UID-only proc inventory as well
        // as LaunchServices. Orphan/non-GUI Helpers need not be in NSWorkspace.
        let minimum = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), nil, 0)
        guard minimum > 0, minimum < 4_000_000 else { throw RelayMaintenanceFailure.identity }
        var pids = [pid_t](repeating: 0, count: Int(minimum) / 4 + 512)
        let capacity = Int32(pids.count * 4)
        let size = pids.withUnsafeMutableBytes { proc_listpids(UInt32(PROC_UID_ONLY), getuid(), $0.baseAddress, capacity) }
        guard size > 0, size < capacity, size % 4 == 0 else { throw RelayMaintenanceFailure.identity }
        for pid in Set(pids.prefix(Int(size) / 4)).union(known.keys) where pid > 0 && pid != getpid() {
            guard let before = try? process(pid) else {
                if errno == ESRCH { continue }; throw RelayMaintenanceFailure.identity
            }
            guard before.pbi_uid == getuid(), before.pbi_ruid == getuid() else { continue }
            var code: SecCode?, details: CFDictionary?
            let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
            let observed = SecCodeCopyGuestWithAttributes(nil, attributes, [], &code)
            if observed == errSecSuccess, let code {
                var staticCode: SecStaticCode?
                if SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode {
                    _ = SecCodeCopySigningInformation(staticCode, [], &details)
                }
            }
            let identifier = (details as? [String: Any])?[kSecCodeInfoIdentifier as String] as? String
            var pathBytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
            let path = proc_pidpath(pid, &pathBytes, UInt32(pathBytes.count)) > 0 ? String(cString: pathBytes) : ""
            let helperNames = ["Relay Helper", "Relay Helper (GPU)", "Relay Helper (Renderer)", "Relay Helper (Plugin)"]
            let helperPath = helperNames.contains { name in
                let suffix = "/Contents/Frameworks/" + name + ".app/Contents/MacOS/" + name
                guard path.hasSuffix(suffix) else { return false }
                let owner = URL(fileURLWithPath: String(path.dropLast(suffix.count)))
                return owner == Bundle.main.bundleURL || Bundle(url: owner)?.bundleIdentifier == RelayGuardContract.applicationID
            }
            let relevant = identifier.map { $0 == RelayGuardContract.applicationID || $0.hasPrefix(RelayGuardContract.applicationID + ".helper") } == true
            // Select profile-writing Main/Chromium Helpers by namespace or
            // actual owning bundle. A name prefix is neither identity nor scope:
            // RelayNative/RelayBrowser, a separate Guard component and unrelated
            // same-name apps are not automatically Main candidates.
            guard relevant || known[pid] != nil || helperPath else { continue }
            guard relevant, let identifier, let code else { throw RelayMaintenanceFailure.identity }
            let requirement = try codeRequirement("anchor apple generic and identifier \"" + identifier + "\" and certificate leaf[subject.OU] = \"" + team + "\"")
            guard SecCodeCheckValidity(code, .noNetworkAccess, requirement) == errSecSuccess else { throw RelayMaintenanceFailure.identity }
            let after = try process(pid)
            guard before.pbi_start_tvsec == after.pbi_start_tvsec, before.pbi_start_tvusec == after.pbi_start_tvusec else { throw RelayMaintenanceFailure.changed }
            if identifier != RelayGuardContract.applicationID, descendant(pid) { continue }
            throw RelayMaintenanceFailure.busy
        }
    }
    static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func hash(_ value: Any?) -> Bool {
        guard let text = value as? String else { return false }
        return text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
    static func semver(_ value: Any?) -> Bool {
        guard let text = value as? String, text.utf8.count <= 128 else { return false }
        // Conservative canonical node-semver subset used by the release owner:
        // no v/= prefix, leading-zero core, numeric prerelease leading zeros or
        // build spelling that canonical valid(raw) would normalize away.
        let parts = text.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let core = parts[0].split(separator: ".", omittingEmptySubsequences: false)
        guard core.count == 3, core.allSatisfy({ item in
            guard item == "0" || (item.first != "0" && !item.isEmpty), item.utf8.allSatisfy({ (48...57).contains($0) }),
                  let number = UInt64(item), number <= 9_007_199_254_740_991 else { return false }; return true
        }) else { return false }
        if parts.count == 1 { return true }
        return parts[1].split(separator: ".", omittingEmptySubsequences: false).allSatisfy { item in
            guard !item.isEmpty, item.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 }) else { return false }
            return !item.utf8.allSatisfy({ (48...57).contains($0) }) || item == "0" || item.first != "0"
        }
    }
    static func userFile(_ path: URL, limit: Int) throws -> Data? {
        try NetworkConfiguration.checkPlainPath(path)
        var metadata = stat()
        if lstat(path.path, &metadata) != 0 { guard errno == ENOENT else { throw RelayMaintenanceFailure.unsafe }; return nil }
        let home = try RelayBrowserContract.realHome().path
        let prefix = home + "/"
        guard path.path.hasPrefix(prefix) else { throw RelayMaintenanceFailure.invalid }
        let components = path.deletingLastPathComponent().path.dropFirst(prefix.count).split(separator: "/").map(String.init)
        let directory = try RelayMaintenanceDirectory(home: home, components: components)
        return try directory.read(path.lastPathComponent, limit: limit)
    }
    static func uiResetIdle(root: URL) throws {
        guard let bytes = try userFile(root.appendingPathComponent("Transactions/UIReset/maintenance.json"), limit: 16384) else { return }
        let whitespace: Set<UInt8> = [9, 10, 13, 32]
        if Data(bytes.drop(while: { whitespace.contains($0) }).reversed().drop(while: { whitespace.contains($0) }).reversed()) == Data("null".utf8) { return }
        let item = try RelayTunStrictJSON.object(bytes, limit: 16384)
        guard Set(item.keys) == ["id", "phase", "beforeRevision", "beforeSHA256", "afterRevision"],
              let id = item["id"] as? String, uuid(id), let phase = item["phase"] as? String, ["reset", "restored"].contains(phase),
              let revision = item["beforeRevision"] as? String, revision.isEmpty || hash(revision), hash(item["beforeSHA256"]), hash(item["afterRevision"]),
              let original = try userFile(root.appendingPathComponent("Maintenance/UI-Reset/" + id + "/before.json"), limit: 16384),
              RelayMaintenanceDirectory.hash(original) == item["beforeSHA256"] as? String else { throw RelayMaintenanceFailure.pending }
    }
    static func installationIdle(root: URL) throws {
        let directory = root.appendingPathComponent("Transactions/AppUpdate")
        let path = directory.appendingPathComponent("app-update-installation.json")
        guard let bytes = try userFile(path, limit: 16384) else { return }
        let item = try RelayTunStrictJSON.object(bytes, limit: 16384)
        guard Set(item.keys) == ["version", "operationId", "candidateId", "previousVersion", "targetVersion", "targetSHA256", "trustRevision", "phase", "updatedAt"],
              RelayTunStrictJSON.integer(item["version"]) == 1,
              let operation = item["operationId"] as? String, uuid(operation), let candidate = item["candidateId"] as? String, uuid(candidate),
              semver(item["previousVersion"]), semver(item["targetVersion"]), hash(item["targetSHA256"]), hash(item["trustRevision"]),
              let time = RelayTunStrictJSON.integer(item["updatedAt"]), time > 0, time <= 9_007_199_254_740_991,
              let phase = item["phase"] as? String, ["installed", "dismissed"].contains(phase) else { throw RelayMaintenanceFailure.pending }
    }
}
