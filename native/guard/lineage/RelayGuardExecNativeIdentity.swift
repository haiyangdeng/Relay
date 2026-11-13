import Darwin
import Dispatch
import EndpointSecurity
import Foundation
import Security

/// Authenticates a proposed native CLI image without treating its future audit
/// token as an already running guest. The caller owns the AUTH response timer.
enum RelayGuardExecNativeIdentity {
    static func matches(_ pointer: UnsafePointer<es_message_t>) -> Bool {
        let message = pointer.pointee
        guard message.action_type == ES_ACTION_TYPE_AUTH, message.event_type == ES_EVENT_TYPE_AUTH_EXEC else { return false }
        let target = message.event.exec.target.pointee
        guard let identity = RelayGuardIdentityClassifier.nativeCLIIdentities.first(where: {
            token(target.signing_id, equals: $0.identifier) && token(target.team_id, equals: $0.team)
        }) else { return false }
        var kernelHash = target.cdhash
        let expectedHash = withUnsafeBytes(of: &kernelHash) { Data($0) }
        guard expectedHash.count == 20, expectedHash.contains(where: { $0 != 0 }) else { return false }

        let budgetEnd = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
        func timely() -> Bool {
            DispatchTime.now().uptimeNanoseconds < budgetEnd && mach_absolute_time() < message.deadline
        }
        guard timely() else { return false }
        let file = target.executable.pointee
        guard !file.path_truncated, file.path.length > 0, file.path.length <= 16_384,
              let path = file.path.data, isCandidate(file.stat) else { return false }
        let raw = UnsafeBufferPointer(start: path, count: file.path.length).map { UInt8(bitPattern: $0) }
        guard raw.first == 47, !raw.contains(0) else { return false }
        // Security documents ambiguous bundle interpretation for /../ or //.
        // Preserve filesystem bytes and decline such aliases instead of fixing
        // or resolving a kernel path into a different pathname.
        let components = raw.dropFirst().split(separator: 47, omittingEmptySubsequences: false)
        guard components.allSatisfy({ !$0.isEmpty && !($0.count == 1 && $0.first == 46)
            && !($0.count == 2 && $0.first == 46 && $0.last == 46) }) else { return false }
        var terminatedPath = raw.map { CChar(bitPattern: $0) }
        terminatedPath.append(0)

        var linkedBefore = stat()
        let inspected = terminatedPath.withUnsafeBufferPointer { Darwin.lstat($0.baseAddress!, &linkedBefore) }
        guard inspected == 0, sameFile(file.stat, linkedBefore), timely() else { return false }
        let descriptor = terminatedPath.withUnsafeBufferPointer {
            Darwin.open($0.baseAddress!, O_RDONLY | O_CLOEXEC | O_NOFOLLOW_ANY | O_NONBLOCK)
        }
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0, sameFile(file.stat, before), timely() else { return false }

        let url = raw.withUnsafeBufferPointer {
            CFURLCreateFromFileSystemRepresentation(nil, $0.baseAddress!, $0.count, false)
        }
        guard let url else { return false }
        var roundTrip = [UInt8](repeating: 0, count: raw.count + 1)
        guard CFURLGetFileSystemRepresentation(url, false, &roundTrip, roundTrip.count),
              roundTrip == raw + [0] else { return false }
        var attributes: [String: Any] = [:]
        if message.version >= 6 {
            let cpu = message.event.exec.image_cputype
            guard cpu > 0 else { return false }
            attributes[kSecCodeAttributeArchitecture as String] = NSNumber(value: cpu)
            attributes[kSecCodeAttributeSubarchitecture as String] = NSNumber(value: message.event.exec.image_cpusubtype)
        }
        let expression = "anchor apple generic and identifier \"" + identity.identifier
            + "\" and certificate leaf[subject.OU] = \"" + identity.team + "\""
        var requirement: SecRequirement?
        guard timely(), SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return false }
        var code: SecStaticCode?
        guard timely(), SecStaticCodeCreateWithPathAndAttributes(url, [], attributes as CFDictionary, &code) == errSecSuccess,
              let code, timely() else { return false }
        // Reuse the project's strict native resource validation. All images
        // must satisfy the exact publisher requirement, with no trust network.
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess)
        guard SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess, timely() else { return false }
        var copied: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess,
              let info = copied as? [String: Any],
              info[kSecCodeInfoIdentifier as String] as? String == identity.identifier,
              info[kSecCodeInfoTeamIdentifier as String] as? String == identity.team,
              let hash = info[kSecCodeInfoUnique as String] as? Data, hash == expectedHash, timely() else { return false }

        var after = stat()
        var linkedAfter = stat()
        let inspectedAfter = terminatedPath.withUnsafeBufferPointer { Darwin.lstat($0.baseAddress!, &linkedAfter) }
        guard inspectedAfter == 0, fstat(descriptor, &after) == 0,
              sameFile(before, after), sameFile(after, linkedAfter), timely() else { return false }
        return true
    }

    private static func token(_ value: es_string_token_t, equals expected: String) -> Bool {
        guard value.length == expected.utf8.count, let bytes = value.data else { return false }
        return UnsafeBufferPointer(start: bytes, count: value.length).map { UInt8(bitPattern: $0) } == Array(expected.utf8)
    }

    private static func isCandidate(_ value: stat) -> Bool {
        value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && value.st_size > 0 && value.st_size <= 1_073_741_824
    }

    private static func sameFile(_ expected: stat, _ actual: stat) -> Bool {
        isCandidate(expected) && isCandidate(actual)
            && expected.st_dev == actual.st_dev && expected.st_ino == actual.st_ino
            && expected.st_size == actual.st_size && expected.st_mode == actual.st_mode
            && expected.st_uid == actual.st_uid && expected.st_gid == actual.st_gid
            && expected.st_nlink == actual.st_nlink
            && expected.st_mtimespec.tv_sec == actual.st_mtimespec.tv_sec
            && expected.st_mtimespec.tv_nsec == actual.st_mtimespec.tv_nsec
            && expected.st_ctimespec.tv_sec == actual.st_ctimespec.tv_sec
            && expected.st_ctimespec.tv_nsec == actual.st_ctimespec.tv_nsec
    }
}
