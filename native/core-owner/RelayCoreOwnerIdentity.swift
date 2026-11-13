import Foundation
import Darwin
import Security

// Adapts the existing Guard/TUN PID-generation + exact resource proof. No stored
// PID becomes a child handle, and code-signing checks forbid network access.
enum CoreOwnerIdentity {
    static func stamp(_ path: String, executable: Bool = false) throws -> String {
        let value = try CoreOwnerFiles.metadata(path)
        guard value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              value.st_nlink == 1, value.st_mode & 0o7022 == 0,
              [getuid(), 0].contains(value.st_uid), !executable || value.st_mode & 0o111 != 0 else { throw CoreOwnerFailure.resource }
        try CoreOwnerFiles.pathChain(path, file: true)
        return "\(value.st_dev):\(value.st_ino):\(value.st_size):\(value.st_mtimespec.tv_sec):\(value.st_mtimespec.tv_nsec):\(value.st_ctimespec.tv_sec):\(value.st_ctimespec.tv_nsec)"
    }
    static func process(_ pid: pid_t) throws -> proc_bsdinfo {
        var value = proc_bsdinfo()
        guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              value.pbi_uid == getuid(), value.pbi_ruid == getuid(), value.pbi_start_tvsec > 0 else { throw CoreOwnerFailure.identity }
        return value
    }
    static func path(_ pid: pid_t) throws -> String {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { throw CoreOwnerFailure.identity }
        return String(cString: buffer)
    }
    static func signed(_ pid: pid_t, identifier: String) throws {
        try RelayCoreOwnerRelease.require()
        guard let team = RelayCoreOwnerRelease.publisherTeamID else { throw CoreOwnerFailure.unavailable }
        let before = try process(pid)
        var code: SecCode?, requirement: SecRequirement?
        let expression = "anchor apple generic and identifier \"" + identifier + "\" and certificate leaf[subject.OU] = \"" + team + "\""
        guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
              let requirement,
              SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: pid] as CFDictionary, [], &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, .noNetworkAccess, requirement) == errSecSuccess else { throw CoreOwnerFailure.identity }
        let after = try process(pid)
        guard before.pbi_start_tvsec == after.pbi_start_tvsec, before.pbi_start_tvusec == after.pbi_start_tvusec else { throw CoreOwnerFailure.identity }
    }
    static func capture(_ pid: pid_t, identifier: String? = nil) throws -> CoreOwnerProcessIdentity {
        let before = try process(pid), executable = try path(pid), identity = try stamp(executable, executable: true)
        if let identifier { try signed(pid, identifier: identifier) }
        let bytes = try CoreOwnerFiles.read(executable, maximum: 512 * 1024 * 1024, privateFile: false)
        guard try stamp(executable, executable: true) == identity else { throw CoreOwnerFailure.resource }
        let after = try process(pid)
        guard before.pbi_start_tvsec == after.pbi_start_tvsec, before.pbi_start_tvusec == after.pbi_start_tvusec,
              try path(pid) == executable else { throw CoreOwnerFailure.identity }
        return .init(pid: pid, uid: getuid(), bornSeconds: String(before.pbi_start_tvsec), bornMicroseconds: String(before.pbi_start_tvusec),
                     executable: executable, resourceSHA256: coreOwnerHash(bytes), fileIdentity: identity)
    }
    static func verify(_ identity: CoreOwnerProcessIdentity, identifier: String? = nil) throws {
        let info = try process(identity.pid)
        guard identity.uid == getuid(), String(info.pbi_start_tvsec) == identity.bornSeconds,
              String(info.pbi_start_tvusec) == identity.bornMicroseconds,
              try path(identity.pid) == identity.executable,
              try stamp(identity.executable, executable: true) == identity.fileIdentity else { throw CoreOwnerFailure.identity }
        if let identifier { try signed(identity.pid, identifier: identifier) }
        let after = try process(identity.pid)
        guard after.pbi_start_tvsec == info.pbi_start_tvsec, after.pbi_start_tvusec == info.pbi_start_tvusec else { throw CoreOwnerFailure.identity }
    }
    static func mainParent(_ helperPID: pid_t) throws -> CoreOwnerProcessIdentity {
        let before = try process(helperPID), parent = pid_t(before.pbi_ppid)
        let result = try capture(parent, identifier: RelayCoreOwnerRelease.applicationID)
        let helperPath = try path(helperPID)
        let marker = "/Contents/MacOS/"
        guard let range = result.executable.range(of: marker, options: .backwards),
              !result.executable[range.upperBound...].isEmpty,
              !result.executable[range.upperBound...].contains("/"),
              helperPath == String(result.executable[..<range.lowerBound]) + "/Contents/Resources/relay/RelayCoreOwner" else { throw CoreOwnerFailure.resource }
        let after = try process(helperPID)
        guard after.pbi_ppid == before.pbi_ppid, after.pbi_start_tvsec == before.pbi_start_tvsec,
              after.pbi_start_tvusec == before.pbi_start_tvusec else { throw CoreOwnerFailure.identity }
        return result
    }
    static func peer(_ descriptor: Int32, selfIdentity: CoreOwnerProcessIdentity) throws -> CoreOwnerProcessIdentity {
        var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0
        var size = socklen_t(MemoryLayout<pid_t>.size)
        guard getpeereid(descriptor, &uid, &gid) == 0, uid == getuid(),
              getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0,
              size == MemoryLayout<pid_t>.size else { throw CoreOwnerFailure.identity }
        let peer = try capture(pid, identifier: RelayCoreOwnerRelease.helperID)
        guard peer.executable == selfIdentity.executable, peer.resourceSHA256 == selfIdentity.resourceSHA256,
              peer.fileIdentity == selfIdentity.fileIdentity else { throw CoreOwnerFailure.identity }
        return peer
    }
    static func positivelyAbsent(_ value: CoreOwnerProcessIdentity) -> Bool {
        // PID reuse is not absence. An unreadable generation always holds.
        return Darwin.kill(value.pid, 0) != 0 && errno == ESRCH
    }
}
