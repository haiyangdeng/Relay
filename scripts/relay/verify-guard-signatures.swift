import Darwin
import Foundation
import Security

// Build-time readback only. The same Security.framework flags are used by
// RelayGuardHostIntegrity and RelayTerminalCLIResources at runtime.
private struct Request: Decodable {
    struct Target: Decodable {
        struct AppVersion: Decodable {
            let build: String
            let short: String
        }

        let path: String
        let identifier: String
        let architectures: [String]
        let appVersion: AppVersion?
    }

    let team: String
    let targets: [Target]
}

private struct Refused: Error {
    let reason: String
}

private func check(_ target: Request.Target, team: String) throws {
    guard target.path.hasPrefix("/"), !target.path.contains("\0"),
          target.identifier.range(of: #"^[A-Za-z0-9.-]+$"#, options: .regularExpression) != nil,
          !target.architectures.isEmpty, Set(target.architectures).count == target.architectures.count,
          target.architectures.allSatisfy({ ["arm64", "x86_64"].contains($0) }) else {
        throw Refused(reason: "Invalid signed-code target")
    }
    // Developer ID Application leaf, exact code identifier and exact Team.
    let expression = "anchor apple generic and identifier \"\(target.identifier)\" "
        + "and certificate leaf[field.1.2.840.113635.100.6.1.13] exists "
        + "and certificate leaf[subject.OU] = \"\(team)\""
    let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        .union(.noNetworkAccess)
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
          let requirement else { throw Refused(reason: "Cannot create Developer ID requirement") }
    for architecture in target.architectures {
        let attributes = [kSecCodeAttributeArchitecture as String: architecture] as CFDictionary
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPathAndAttributes(URL(fileURLWithPath: target.path) as CFURL, [], attributes, &code) == errSecSuccess,
              let code, SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else {
            throw Refused(reason: "Developer ID verification failed for \(target.identifier) (\(architecture))")
        }
        if let version = target.appVersion { try checkAppInfo(code, target: target, version: version) }
    }
}

private func checkAppInfo(_ code: SecStaticCode, target: Request.Target, version: Request.Target.AppVersion) throws {
    var copied: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess,
          let info = copied as? [String: Any],
          let plist = info[kSecCodeInfoPList as String] as? [String: Any],
          plist["CFBundleIdentifier"] as? String == target.identifier,
          plist["CFBundleVersion"] as? String == version.build,
          plist["CFBundleShortVersionString"] as? String == version.short,
          plist["CFBundleExecutable"] as? String == "Relay",
          plist["LSMinimumSystemVersion"] as? String == "13.0" else {
        throw Refused(reason: "Signed App Info identity, version or minimum OS mismatch")
    }
}

do {
    var bytes = Data()
    while bytes.count <= 65536,
          let part = try FileHandle.standardInput.read(upToCount: 65537 - bytes.count), !part.isEmpty {
        bytes.append(part)
    }
    guard !bytes.isEmpty, bytes.count <= 65536 else { throw Refused(reason: "Invalid verification input size") }
    let request = try JSONDecoder().decode(Request.self, from: bytes)
    guard request.team.range(of: #"^[A-Z0-9]{10}$"#, options: .regularExpression) != nil,
          !request.targets.isEmpty, request.targets.count <= 12 else {
        throw Refused(reason: "Invalid publisher or signed-code target count")
    }
    for target in request.targets { try check(target, team: request.team) }
} catch {
    let reason = (error as? Refused)?.reason ?? "Invalid verification input"
    FileHandle.standardError.write(Data((reason + "\n").utf8))
    exit(1)
}
