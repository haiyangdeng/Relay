import Foundation
import Darwin

/// Only this installation's two possible bundle locations. Reading the user's
/// Bundle table never discovers additional cleanup targets by bundle ID.
enum RelayUninstallRegistration {
    static let tool = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    static let maximumOutputBytes = 64 * 1024 * 1024
    struct Target: Equatable {
        let path: String
        let identifier: String
    }
    struct Entry: Equatable {
        let path: String
        let identifier: String?
    }
    static let bundles = [
        ("/Contents/Resources/relay/RelayBrowser.app", "local.relay.browser"),
        ("/Contents/Frameworks/Relay Helper.app", "local.relay.network.preview.helper"),
        ("/Contents/Frameworks/Relay Helper (GPU).app", "local.relay.network.preview.helper.GPU"),
        ("/Contents/Frameworks/Relay Helper (Renderer).app", "local.relay.network.preview.helper.Renderer"),
        ("/Contents/Frameworks/Relay Helper (Plugin).app", "local.relay.network.preview.helper.Plugin"),
        ("", "local.relay.network.preview")
    ]
    // sfltool is Apple's read-only BTM inventory. A negative result is usable
    // only for a complete, recognized dump of both the shared and bound user
    // databases. Unknown formats fall back to the signed application's own API.
    static func legacyLoginAbsent(_ data: Data, uid: UInt32, movedPath: String) -> Bool {
        guard let text = String(data: data, encoding: .utf8), text.hasSuffix("\n") else { return false }
        var sections: [Int: [String]] = [:], section: Int?
        for line in text.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("Records for UID ") {
                let header = trimmed.dropFirst("Records for UID ".count).components(separatedBy: " : ")
                guard header.count == 2, let id = Int(header[0]), UUID(uuidString: header[1]) != nil,
                      sections[id] == nil else { return false }
                section = id; sections[id] = []
            } else if let section { sections[section]!.append(line) }
            else if !trimmed.isEmpty && !trimmed.allSatisfy({ $0 == "=" }) { return false }
        }
        let roots = [RelayRemoval.app, movedPath]
        for id in [-2, Int(uid)] {
            guard let lines = sections[id], lines.contains(" ServiceManagement migrated: true"),
                  lines.contains(" LaunchServices registered: true") || (id == -2 && lines.contains(" LaunchServices registered: false")),
                  let items = lines.firstIndex(of: " Items:") else { return false }
            var records: [[String]] = []
            for line in lines.dropFirst(items + 1) {
                let field = line.trimmingCharacters(in: .whitespaces)
                if field.isEmpty || field.allSatisfy({ $0 == "=" }) { continue }
                if line.hasPrefix(" #") {
                    guard field == "#\(records.count + 1):" else { return false }
                    records.append([])
                } else {
                    guard line.hasPrefix("  "), !records.isEmpty, field.contains(":") else { return false }
                    records[records.count - 1].append(field)
                }
            }
            // macOS 15 prints an Items header followed only by blank lines for an
            // empty database. Unexpected text after the header was rejected above.
            for record in records {
                func value(_ key: String) -> String? {
                    let matches = record.filter { $0.hasPrefix(key + ":") }
                    guard matches.count == 1 else { return nil }
                    return matches[0].dropFirst(key.count + 1).trimmingCharacters(in: .whitespaces)
                }
                guard let kind = value("Type"), let identifier = value("Identifier"), !identifier.isEmpty,
                      let uuid = value("UUID"), UUID(uuidString: uuid) != nil, let url = value("URL"),
                      let disposition = value("Disposition"), disposition.hasPrefix("[") else { return false }
                // BTM groups executables under developer/app parent records.
                // A child identifier printed under a developer is not a login.
                if ["developer (0x20)", "legacy daemon (0x10010)", "legacy agent (0x10008)",
                    "daemon (0x10)", "agent (0x8)"].contains(kind) { continue }
                guard ["app (0x2)", "login item (0x4)", "legacy login item (0x10004)"].contains(kind)
                else { return false }
                let appID = "local.relay.network.preview"
                let identifiesRelay = identifier == appID || identifier.hasSuffix("." + appID)
                guard let location = URL(string: url), location.isFileURL else { return false }
                let path = location.standardizedFileURL.path
                if identifiesRelay || roots.contains(path) {
                    // An explicitly disabled parent container can remain in BTM
                    // after migration. Its child login items have their own rows.
                    if kind == "app (0x2)", disposition.hasPrefix("[disabled,"),
                       record.contains("Embedded Item Identifiers:") { continue }
                    return false
                }
            }
        }
        return true
    }
    private static func fail() -> NSError { RelayRemoval.fail("Bound application registration cleanup was not confirmed") }
    static func targets(home: String, uid: UInt32, observed: String?) throws -> [Target] {
        guard uid >= 501, home.hasPrefix("/"), URL(fileURLWithPath: home).standardizedFileURL.path == home else { throw fail() }
        var roots = [RelayRemoval.app]
        if let observed, observed != RelayRemoval.app {
            guard observed.utf8.count < Int(MAXPATHLEN), !observed.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  URL(fileURLWithPath: observed).standardizedFileURL.path == observed,
                  observed.hasSuffix(".app"), RelayRemoval.trashPath(observed, home: home, uid: uid) else { throw fail() }
            roots.append(observed)
        }
        return roots.flatMap { root in bundles.map { Target(path: root + $0.0, identifier: $0.1) } }
    }
    /// The capture must also report a successful, non-overflowed process. A
    /// missing identifier is a valid LS row and never counts as path absence.
    static func entries(_ bytes: Data) throws -> [Entry] {
        guard bytes.count <= maximumOutputBytes, let text = String(data: bytes, encoding: .utf8),
              text.hasSuffix("\n"), !text.contains("\0") else { throw fail() }
        var blocks: [[String]] = [[]]
        for line in text.components(separatedBy: "\n") {
            let trim = line.trimmingCharacters(in: .whitespaces)
            if !trim.isEmpty && trim.allSatisfy({ $0 == "-" }) { blocks.append([]) }
            else { blocks[blocks.count - 1].append(line) }
        }
        var result: [Entry] = []
        for block in blocks {
            func fields(_ name: String) -> [String] {
                block.compactMap { line in
                    let line = line.trimmingCharacters(in: .whitespaces)
                    guard line.hasPrefix(name + ":") else { return nil }
                    return String(line.dropFirst(name.count + 1)).trimmingCharacters(in: .whitespaces)
                }
            }
            let headers = fields("bundle id")
            guard !headers.isEmpty else { continue }
            let paths = fields("path"), identifiers = fields("identifier")
            guard headers.count == 1, !headers[0].isEmpty, paths.count == 1, identifiers.count <= 1 else { throw fail() }
            let path = paths[0].replacingOccurrences(of: " \\(0x[0-9a-f]+\\)$", with: "", options: .regularExpression)
            guard path.hasPrefix("/"), !path.contains("\0") else { throw fail() }
            let identifier = identifiers.first.flatMap { $0.isEmpty ? nil : $0 }
            result.append(Entry(path: path, identifier: identifier))
        }
        guard !result.isEmpty else { throw fail() }
        return result
    }
    static func cleanup(targets: [Target], authorize: () throws -> Void,
                        execute: ([String]) throws -> (Int32, Data)) throws {
        func read() throws -> [Entry] {
            try authorize()
            let response = try execute(["-dump", "Bundle"])
            guard response.0 == 0 else { throw fail() }
            let rows = try entries(response.1)
            try authorize()
            return rows
        }
        let rows = try read()
        for target in targets {
            let matching = rows.filter { $0.path == target.path }
            if matching.isEmpty { continue }
            // An explicit foreign identity is not our installation. A row
            // without an ID remains within its already bound exact pathname.
            guard matching.allSatisfy({ $0.identifier == nil || $0.identifier == target.identifier }) else { throw fail() }
            try authorize()
            let response = try execute(["-u", target.path])
            guard response.0 == 0 || response.0 == 1 else { throw fail() }
        }
        let remaining = try read()
        guard !remaining.contains(where: { row in targets.contains(where: { $0.path == row.path }) }) else { throw fail() }
    }
    static func userArguments(uid: UInt32, home: String, name: String, arguments: [String]) -> [String] {
        ["asuser", String(uid), "/usr/bin/sudo", "-n", "-H", "-u", "#\(uid)", "/usr/bin/env", "-i",
         "HOME=\(home)", "USER=\(name)", "LOGNAME=\(name)", "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
         "LANG=C", "LC_ALL=C", tool] + arguments
    }
    static func authorizeLocation(observed: String?, device: UInt64?, inode: UInt64,
                                  occupied: Bool, present: (String) -> Bool,
                                  info: (String) -> stat?) throws {
        guard !occupied else { throw fail() }
        if let observed, observed != RelayRemoval.app, present(observed) {
            guard let state = info(observed), state.st_mode & S_IFMT == S_IFDIR,
                  UInt64(state.st_dev) == device, UInt64(state.st_ino) == inode else { throw fail() }
        }
    }
    static func run(_ installation: RelayRemovalInstallation) throws {
        let intent = try RelayRemoval.json(RelayRemoval.root + "/intent.json")
        guard intent["version"] as? Int == 1, intent["generation"] as? String == installation.generation,
              intent["clientUID"] as? UInt32 == installation.uid, intent["phase"] as? String == "requested",
              intent["observedAppPath"] == nil || intent["observedAppPath"] is String else { throw fail() }
        let observed = intent["observedAppPath"] as? String
        let selected = try targets(home: installation.home, uid: installation.uid, observed: observed)
        func authorize() throws {
            guard let user = getpwuid(installation.uid), let home = user.pointee.pw_dir,
                  String(cString: home) == installation.home else { throw fail() }
            let current = try RelayRemoval.json(RelayRemoval.root + "/installation.json")
            guard NSDictionary(dictionary: current).isEqual(to: installation.record),
                  NSDictionary(dictionary: try RelayRemoval.json(RelayRemoval.root + "/intent.json")).isEqual(to: intent) else { throw fail() }
            try authorizeLocation(observed: observed, device: installation.identity?.device, inode: installation.inode,
                occupied: RelayRemoval.present(RelayRemoval.app), present: RelayRemoval.present, info: RelayRemoval.info)
            // Absent observed locations are accepted only from this unchanged
            // root-owned same-generation intent, recorded from the bound vnode.
        }
        try authorize()
        guard let user = getpwuid(installation.uid), let pointer = user.pointee.pw_name else { throw fail() }
        let name = String(cString: pointer)
        try cleanup(targets: selected, authorize: authorize, execute: { arguments in
            try RelayRemoval.run("/bin/launchctl", userArguments(uid: installation.uid, home: installation.home, name: name, arguments: arguments),
                timeout: 60, maximumOutputBytes: maximumOutputBytes, requireCompleteOutput: true)
        })
    }
}
