import Foundation
import Security
import Darwin

enum RelayGuardContract {
    // Relay owns its future extension identity. Never inspect or manage the old
    // assistant's filter as if it were an installed Relay component.
    static let applicationID = "local.relay.network.preview"
    static let extensionID = "local.relay.network.preview.guard"
}
struct RelayGuardComponent: Encodable {
    let presence: String
    let identity: String
    let signature: String
    let installEntitlement: Bool
    let networkEntitlement: Bool
    let sandboxEntitlement: Bool
}
struct RelayGuardReadinessReport: Encodable {
    let version = 1
    let readOnly = true
    let buildMode = "offline"
    let liveOperationsAvailable = false
    let protectionVerified = false
    let systemExtension = "notQueried"
    let filterConfiguration = "notQueried"
    let runtimeEnforcement = "notVerified"
    let signingMetadataScope = "currentArchitecture"
    let signatureValidationScope = "allArchitecturesNoNetwork"
    let application: RelayGuardComponent
    let extensionComponent: RelayGuardComponent
    let sameSigningTeam: String
    let sameVersion: String
    let bundleMetadataMatches: Bool
    let warnings = ["当前为离线构建，没有安装、启用、停用过滤器或启动 Claude 的真实保护入口。",
        "只读取当前 Relay 包内的组件与签名；不查询其他助手的扩展，不调用过滤管理或扩展激活接口。",
        "签名完整性核对全部切片并禁止联网；身份、Team、版本和权限元数据只对应本机架构，不代表其他架构、公证或系统授权通过。",
        "系统扩展与过滤配置未查询；不能据此判断系统中没有其他过滤器，也不能确认 Claude 禁止直连已经生效。"]
}
struct RelayGuardBundleObservation {
    var presence = "unconfirmed"
    var bundleIdentifier: String?
    var signingIdentifier: String?
    var signature = "unconfirmed"
    var team: String?
    var version: String?
    var installEntitlement = false
    var networkEntitlement = false
    var sandboxEntitlement = false
}
struct RelayGuardInspectionEnvironment {
    var observe: (URL) -> RelayGuardBundleObservation
    static let live = RelayGuardInspectionEnvironment(observe: RelayGuardReadiness.observe)
}

enum RelayGuardReadiness {
    /// Resolve only the fixed packaged helper layout. Standalone development
    /// binaries never guess an App, traverse arbitrary roots or search /Applications.
    static func applicationRoot(_ executable: URL) -> URL? {
        guard executable.isFileURL, executable.lastPathComponent == "RelayNative",
              !executable.path.utf8.contains(0),
              executable.deletingLastPathComponent().lastPathComponent == "relay" else { return nil }
        let resources = executable.deletingLastPathComponent().deletingLastPathComponent()
        let contents = resources.deletingLastPathComponent(), root = contents.deletingLastPathComponent()
        guard resources.lastPathComponent == "Resources", contents.lastPathComponent == "Contents", root.pathExtension == "app" else { return nil }
        return root
    }
    // The fixed bundle path needs directory type and access only. Foundation's
    // full file attributes query extended attributes on every ancestor.
    static func bundleDirectoryPresence(_ url: URL) -> String {
        let path = url.path
        guard url.isFileURL, path.first == "/", !path.utf8.contains(0) else { return "unconfirmed" }
        let components = path.split(separator: "/")
        guard !components.isEmpty, !components.contains(where: { $0 == "." || $0 == ".." }) else {
            return "unconfirmed"
        }
        var parent = "/"
        for component in components {
            let current = parent == "/" ? parent + component : parent + "/" + component
            var info = stat()
            if lstat(current, &info) != 0 {
                return errno == ENOENT && access(parent, R_OK | X_OK) == 0 ? "missing" : "unconfirmed"
            }
            guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else { return "unconfirmed" }
            parent = current
        }
        return access(parent, R_OK | X_OK) == 0 ? "present" : "unconfirmed"
    }
    static func observe(_ url: URL) -> RelayGuardBundleObservation {
        var result = RelayGuardBundleObservation()
        let directoryPresence = bundleDirectoryPresence(url)
        guard directoryPresence == "present" else {
            result.presence = directoryPresence
            return result
        }
        guard let bundle = Bundle(url: url), let executable = bundle.executableURL,
              FileManager.default.isExecutableFile(atPath: executable.path) else { return result }
        result.presence = "present"
        result.bundleIdentifier = bundle.bundleIdentifier
        result.version = bundle.infoDictionary?["CFBundleVersion"] as? String
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(), &code) == errSecSuccess, let code else { return result }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate).union(.noNetworkAccess)
        let validity = SecStaticCodeCheckValidity(code, flags, nil)
        var copied: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &copied) == errSecSuccess,
              let info = copied as? [String: Any] else { return result }
        let adhoc = ((info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0) & SecCodeSignatureFlags.adhoc.rawValue != 0
        result.signature = validity == errSecSuccess ? (adhoc ? "adHoc" : "staticValid") : "invalid"
        result.signingIdentifier = info[kSecCodeInfoIdentifier as String] as? String
        result.team = info[kSecCodeInfoTeamIdentifier as String] as? String
        let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
        // Accept actual plist booleans only, not integers or truthy strings.
        func boolean(_ key: String) -> Bool {
            guard let value = entitlements[key] as CFTypeRef?, CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
            return (value as? Bool) == true
        }
        result.installEntitlement = boolean("com.apple.developer.system-extension.install")
        result.sandboxEntitlement = boolean("com.apple.security.app-sandbox")
        result.networkEntitlement = (entitlements["com.apple.developer.networking.networkextension"] as? [String])?.contains("content-filter-provider-systemextension") == true
        return result
    }
    static func inspect(executable: URL, environment: RelayGuardInspectionEnvironment = .live) -> RelayGuardReadinessReport {
        let root = applicationRoot(executable)
        let app = root.map(environment.observe) ?? RelayGuardBundleObservation(presence: "notBundled")
        // If the root cannot be read, do not manufacture an extension path
        // observation through an unconfirmed container.
        let ext = root != nil && app.presence == "present"
            ? environment.observe(root!.appendingPathComponent("Contents/Library/SystemExtensions/" + RelayGuardContract.extensionID + ".systemextension"))
            : RelayGuardBundleObservation(presence: root == nil ? "notBundled" : "unconfirmed")
        func component(_ observed: RelayGuardBundleObservation, id: String) -> RelayGuardComponent {
            guard observed.presence == "present" else {
                return RelayGuardComponent(presence: observed.presence, identity: "unconfirmed", signature: "unconfirmed",
                    installEntitlement: false, networkEntitlement: false, sandboxEntitlement: false)
            }
            let identity = observed.bundleIdentifier == nil || observed.signingIdentifier == nil ? "unconfirmed"
                : observed.bundleIdentifier == id && observed.signingIdentifier == id ? "matches" : "mismatch"
            return RelayGuardComponent(presence: "present", identity: identity, signature: observed.signature,
                installEntitlement: observed.installEntitlement, networkEntitlement: observed.networkEntitlement,
                sandboxEntitlement: observed.sandboxEntitlement)
        }
        let application = component(app, id: RelayGuardContract.applicationID)
        let extensionComponent = component(ext, id: RelayGuardContract.extensionID)
        func confirmed(_ value: String?) -> String? {
            guard let value, !value.isEmpty, value.utf8.count <= 255,
                  value.unicodeScalars.allSatisfy({ $0.isASCII && !CharacterSet.controlCharacters.contains($0) }) else { return nil }
            return value
        }
        let team: String, version: String
        if application.signature == "staticValid", extensionComponent.signature == "staticValid",
           let a = confirmed(app.team), let b = confirmed(ext.team) { team = a == b ? "matches" : "mismatch" }
        else { team = "unconfirmed" }
        if application.presence == "present", extensionComponent.presence == "present",
           let a = confirmed(app.version), let b = confirmed(ext.version) { version = a == b ? "matches" : "mismatch" }
        else { version = "unconfirmed" }
        let matches = [application, extensionComponent].allSatisfy { $0.presence == "present" && $0.identity == "matches" && $0.signature == "staticValid" && $0.networkEntitlement }
            && application.installEntitlement && extensionComponent.sandboxEntitlement && team == "matches" && version == "matches"
        return RelayGuardReadinessReport(application: application, extensionComponent: extensionComponent,
            sameSigningTeam: team, sameVersion: version, bundleMetadataMatches: matches)
    }
}
