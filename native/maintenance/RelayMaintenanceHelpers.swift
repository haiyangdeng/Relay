import CryptoKit
import Darwin
import Foundation
import Security

extension RelayMaintenanceGate {
    private enum HelperRole: String { case native = "RelayNative", browser = "RelayBrowser", coreOwner = "RelayCoreOwner" }
    private struct HelperResource {
        let role: HelperRole
        let sha256: String
        let requirement: SecRequirement
    }
    private static func helperResource(_ role: HelperRole) throws -> HelperResource {
        let path = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/relay/" + role.rawValue)
        try NetworkConfiguration.checkPlainPath(path)
        let fd = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw RelayMaintenanceFailure.helperPending }
        defer { Darwin.close(fd) }
        var before = stat(), after = stat(), linked = stat()
        guard fstat(fd, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              [0, getuid()].contains(before.st_uid), before.st_mode & 0o7022 == 0,
              before.st_mode & 0o111 != 0, before.st_nlink == 1, before.st_size > 0, before.st_size <= 128 * 1024 * 1024 else { throw RelayMaintenanceFailure.helperPending }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 16384)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            guard count >= 0 else { throw RelayMaintenanceFailure.helperPending }
            if count == 0 { break }; bytes.append(buffer, count: count)
            guard bytes.count <= 128 * 1024 * 1024 else { throw RelayMaintenanceFailure.helperPending }
        }
        guard fstat(fd, &after) == 0, lstat(path.path, &linked) == 0,
              RelayMaintenanceDirectory.same(before, after), RelayMaintenanceDirectory.same(before, linked), bytes.count == before.st_size else { throw RelayMaintenanceFailure.helperPending }
        var code: SecStaticCode?, details: CFDictionary?
        guard SecStaticCodeCreateWithPath(path as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess), nil) == errSecSuccess,
              SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &details) == errSecSuccess,
              let info = details as? [String: Any], let unique = info[kSecCodeInfoUnique as String] as? Data, unique.count == 20,
              let identifier = info[kSecCodeInfoIdentifier as String] as? String, !identifier.isEmpty else { throw RelayMaintenanceFailure.helperPending }
        // Bare helpers have no separately frozen identifier in build-native.zsh.
        // Derive their actual identity from current signed App-sealed bytes,
        // never from a Relay name, renderer string or invented Team/SID.
        let cdhash = unique.map { String(format: "%02x", $0) }.joined()
        return HelperResource(role: role, sha256: RelayMaintenanceDirectory.hash(bytes),
            requirement: try codeRequirement("cdhash H\"" + cdhash + "\""))
    }
    private static func fixedHelper(_ path: String, roots: [URL]) -> (HelperRole, String?)? {
        for root in roots {
            let prefix = root.appendingPathComponent("NativeRuntime").path + "/"
            if path.hasPrefix(prefix) {
                let parts = path.dropFirst(prefix.count).split(separator: "/").map(String.init)
                // Unknown contents within this fixed own executable area hold.
                let hash = parts.count == 2 && parts[1] == "RelayNative" && Self.hash(parts[0]) ? parts[0] : nil
                return (.native, hash)
            }
        }
        for role in [HelperRole.native, .browser, .coreOwner] {
            let suffix = "/Contents/Resources/relay/" + role.rawValue
            if path.hasSuffix(suffix) {
                let app = URL(fileURLWithPath: String(path.dropLast(suffix.count)))
                if app == Bundle.main.bundleURL || Bundle(url: app)?.bundleIdentifier == RelayGuardContract.applicationID { return (role, nil) }
            }
        }
        return nil
    }
    private static func helperArguments(_ pid: pid_t) throws -> [String] {
        // Existing parser extracts argc only; environment/stdin is never logged,
        // persisted or treated as authority. A closed command alone cannot
        // distinguish preferences save/read or system-proxy apply/inspect.
        return try RelayBrowserProcesses.arguments(of: pid)
    }
    @MainActor static func shortHelpersIdle(roots: [URL]) throws {
        do {
            try ownIdentity()
            let resources = try [helperResource(.native), helperResource(.browser)]
            let minimum = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), nil, 0)
            guard minimum > 0, minimum < 4_000_000 else { throw RelayMaintenanceFailure.helperPending }
            var pids = [pid_t](repeating: 0, count: Int(minimum) / 4 + 512)
            let capacity = Int32(pids.count * 4)
            let size = pids.withUnsafeMutableBytes { proc_listpids(UInt32(PROC_UID_ONLY), getuid(), $0.baseAddress, capacity) }
            guard size > 0, size < capacity, size % 4 == 0 else { throw RelayMaintenanceFailure.helperPending }
            for pid in Set(pids.prefix(Int(size) / 4)) where pid > 0 && pid != getpid() {
                let before: proc_bsdinfo
                do { before = try process(pid) }
                catch {
                    if errno == ESRCH { continue }
                    throw RelayMaintenanceFailure.helperPending
                }
                guard before.pbi_uid == getuid(), before.pbi_ruid == getuid() else { continue }
                var pathBytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
                guard proc_pidpath(pid, &pathBytes, UInt32(pathBytes.count)) > 0 else {
                    // An unreadable live process is not proof that it is an
                    // unrelated app. Only positively gone PID can be ignored.
                    do { _ = try process(pid) }
                    catch { if errno == ESRCH { continue } }
                    throw RelayMaintenanceFailure.helperPending
                }
                let path = String(cString: pathBytes)
                guard !path.isEmpty else { throw RelayMaintenanceFailure.helperPending }
                let fixed = fixedHelper(path, roots: roots)
                var code: SecCode?
                let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
                if SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) != errSecSuccess { code = nil }
                let matched = code.flatMap { code in resources.first { SecCodeCheckValidity(code, .noNetworkAccess, $0.requirement) == errSecSuccess } }
                guard fixed != nil || matched != nil else { continue }
                let runtimeCopy = roots.contains { path.hasPrefix($0.appendingPathComponent("NativeRuntime").path + "/") }
                guard before.pbi_uid == getuid(), before.pbi_ruid == getuid(), let matched,
                      fixed == nil || fixed?.0 == matched.role,
                      !runtimeCopy || fixed?.1 == matched.sha256 else { throw RelayMaintenanceFailure.helperPending }
                let args = try helperArguments(pid)
                let after = try process(pid)
                var endPath = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
                guard before.pbi_start_tvsec == after.pbi_start_tvsec, before.pbi_start_tvusec == after.pbi_start_tvusec,
                      proc_pidpath(pid, &endPath, UInt32(endPath.count)) > 0, String(cString: endPath) == path,
                      let code, SecCodeCheckValidity(code, .noNetworkAccess, matched.requirement) == errSecSuccess else { throw RelayMaintenanceFailure.helperPending }
                // Only these exact current-resource commands are proven static
                // readonly in RelayNative.main. All Browser/other Native actions,
                // old resources, pending authorization and unknown state hold.
                if matched.role == .native, args.count == 2, ["--guard-status", "--guard-host-resource-inspect"].contains(args[1]) { continue }
                throw RelayMaintenanceFailure.helperPending
            }
            try ownIdentity()
        } catch { throw RelayMaintenanceFailure.helperPending }
    }
}
