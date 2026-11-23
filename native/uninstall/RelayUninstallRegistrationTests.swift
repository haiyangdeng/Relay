import Foundation
import Darwin

enum RelayUninstallRegistrationTests {
    static func run() throws -> Int {
        var count = 0
        func check(_ good: Bool, _ label: String) throws {
            guard good else { throw RelayRemoval.fail("Registration fixture: " + label) }; count += 1
        }
        func refuses(_ label: String, _ work: () throws -> Void) throws {
            var rejected = false
            do { try work() } catch { rejected = true }
            try check(rejected, label)
        }
        typealias R = RelayUninstallRegistration
        let home = "/Users/fixture", trash = "/Users/fixture/.Trash/Relay 1.02.03 PM.app"
        func item(_ type: String, _ identifier: String, _ location: String, _ enabled: Bool = true) -> String {
            return " #1:\n                 UUID: 50DCC3EF-6AD8-5EAA-AC56-451AD340113C\n                 Type: \(type)\n          Disposition: [\(enabled ? "enabled" : "disabled"), allowed, visible, notified] (0x2)\n           Identifier: \(identifier)\n                  URL: \(location)\n"
        }
        let developer = item("developer (0x20)", "Unknown Developer", "(null)")
            + "  Embedded Item Identifiers:\n    #1: 16.local.relay.network.system-proxy\n"
        func absent(_ entry: String, _ uid: UInt32 = 501, _ migrated: Bool = true) -> Bool {
            let section = { (user: Int, content: String) in
                "========================\n Records for UID \(user) : 50DCC3EF-6AD8-5EAA-AC56-451AD340113C\n========================\n ServiceManagement migrated: \(migrated)\n LaunchServices registered: true\n Items:\n" + content
            }
            return R.legacyLoginAbsent(Data((section(-2, developer) + section(501, entry)).utf8), uid: uid, movedPath: trash)
        }
        try check(absent(""), "macOS 15 recognized empty Items table")
        let unrelatedLogin = item("login item (0x4)", "4.example.unrelated", "file:///Applications/Other.app/")
        try check(absent(unrelatedLogin), "recognized shared and bound-user inventory excludes Relay")
        try check(!absent(unrelatedLogin, 502) && !absent(unrelatedLogin, 501, false), "missing user or incomplete migration uses signed fallback")
        try check(!absent(item("legacy login item (0x10004)", "4.local.relay.network.preview", "file:///elsewhere.app")), "legacy item matched by bundle ID")
        let escaped = URL(fileURLWithPath: trash).absoluteString
        try check(!absent(item("app (0x2)", "anonymous", escaped)), "escaped renamed Trash path matched")
        try check(!absent(item("unknown kind (0x55)", "opaque", "(null)")), "unknown BTM encoding uses fallback")
        try check(!absent(unrelatedLogin.replacingOccurrences(of: "Identifier:", with: "Identifikator:")) && !absent(" unrecognized table: 0 entries"), "localized or unrecognized inventory never authorizes skip")
        try check(absent(item("app (0x2)", "2.local.relay.network.preview", escaped, false) + "  Embedded Item Identifiers:\n    #1: 16.local.relay.network.system-proxy\n"), "disabled BTM parent history is not an active login item")
        var loginEvents: [String] = []
        try refuses("failed signed fallback preserves unfinished intent") {
            try RelayRemovalLifecycle.run(phase: "requested", prepareLegacyLogin: {
                loginEvents.append("legacy"); throw RelayRemoval.fail("system refused")
            }, retireNetworkOnLoginFailure: { loginEvents.append("network components") },
            restoreUser: { loginEvents.append("restore proxy and user") }, removeRegistrations: { loginEvents.append("registration") },
            removeComponents: { loginEvents.append("other components") }, checkpoint: { loginEvents.append($0) },
            finish: { loginEvents.append("finish") })
        }
        try check(loginEvents == ["legacy", "restore proxy and user", "network components"], "network restored and stopped before retrying only unfinished login outcome")
        let fixed = try R.targets(home: home, uid: 501, observed: nil)
        try check(fixed.count == 6 && fixed.allSatisfy({ $0.path.hasPrefix(RelayRemoval.app) }), "six fixed installation bundles")
        try check(try R.targets(home: home, uid: 501, observed: RelayRemoval.app) == fixed, "direct deletion last installed path deduplicates")
        let both = try R.targets(home: home, uid: 501, observed: trash)
        try check(both.count == 12 && both.prefix(6).elementsEqual(fixed), "same-installation Trash adds exactly six")
        for path in [home + "/Documents/Relay.app", home + "/project/release/Relay.app", "/Users/other/.Trash/Relay.app", home + "/.Trash/../Relay.app", "/Volumes/Data/.Trashes/502/Relay.app", trash + "/../other.app", trash + "\n"] {
            try refuses("unbound move or user path") { _ = try R.targets(home: home, uid: 501, observed: path) }
        }
        try refuses("system UID") { _ = try R.targets(home: home, uid: 0, observed: trash) }
        var object = stat(); object.st_dev = 1; object.st_ino = 2; object.st_mode = S_IFDIR | 0o755
        try R.authorizeLocation(observed: trash, device: 1, inode: 2, occupied: false, present: { _ in true }, info: { _ in object })
        try check(true, "matching Trash vnode")
        try R.authorizeLocation(observed: trash, device: 1, inode: 2, occupied: false, present: { _ in false }, info: { _ in nil })
        try check(true, "already emptied location uses prior durable intent")
        try refuses("replacement installed App blocks") { try R.authorizeLocation(observed: trash, device: 1, inode: 2, occupied: true, present: { _ in false }, info: { _ in nil }) }
        try refuses("foreign Trash inode blocks") { try R.authorizeLocation(observed: trash, device: 1, inode: 3, occupied: false, present: { _ in true }, info: { _ in object }) }
        try refuses("permission failure is not absence") { try R.authorizeLocation(observed: trash, device: 1, inode: 2, occupied: false, present: { _ in true }, info: { _ in nil }) }
        object.st_mode = S_IFLNK | 0o755
        try refuses("Trash symlink blocks") { try R.authorizeLocation(observed: trash, device: 1, inode: 2, occupied: false, present: { _ in true }, info: { _ in object }) }
        func dump(_ rows: [(String, String?)]) -> Data {
            Data(rows.map { path, identifier in
                "----------------------------------------\nbundle id: Fixture Name (0x123)\npath: \(path) (0xabcd)\n" + (identifier.map { "identifier: \($0)\n" } ?? "")
            }.joined().utf8)
        }
        let unrelated = ("/Users/fixture/project/Relay.app", "local.relay.network.preview" as String?)
        let parsed = try R.entries(dump([(trash, nil), unrelated]))
        try check(parsed.count == 2 && parsed[0].path == trash && parsed[0].identifier == nil, "real named bundle header and missing identifier retained")
        let emptyIdentifier = try R.entries(Data("bundle id: System Name (0x1)\npath: /System/Empty.app (0xab)\nidentifier:    \n".utf8))
        try check(emptyIdentifier == [R.Entry(path: "/System/Empty.app", identifier: nil)], "empty identifier retains exact path")
        for data in [Data(), Data("bundle id: Named (0x1)\n".utf8), Data("bundle id: Name\npath: /a\npath: /b\n".utf8), Data("bundle id: Name\npath: relative\n".utf8), Data("bundle id: Name\npath: /a".utf8), Data("bundle id: Name\npath: /a\0\n".utf8), Data([0xff, 0x0a])] {
            try refuses("incomplete or malformed table rejected") { _ = try R.entries(data) }
        }
        let capture = RelayRemovalCapture(limit: 3); capture.append(Data("123".utf8)); capture.append(Data("4".utf8))
        try check(capture.data.count == 3 && capture.overflowed, "bounded capture detects overflow")
        try refuses("truncated command output rejected") { _ = try RelayRemoval.run("/usr/bin/printf", ["1234"], maximumOutputBytes: 3, requireCompleteOutput: true) }
        let legacy = try RelayRemoval.run("/usr/bin/printf", ["1234"], maximumOutputBytes: 3)
        try check(legacy.0 == 0 && legacy.1 == Data("123".utf8), "existing bounded capture behavior retained")
        let selected = [R.Target(path: trash, identifier: "local.relay.network.preview")]
        for exitCode: Int32 in [0, 1] {
            var rows: [(String, String?)] = [(trash, nil), unrelated], commands: [[String]] = []
            try R.cleanup(targets: selected, authorize: {}, execute: { args in
                commands.append(args)
                if args == ["-dump", "Bundle"] { return (0, dump(rows)) }
                try check(args == ["-u", trash], "only bound exact target mutated")
                rows.removeFirst(); return (exitCode, Data())
            })
            try check(commands.filter({ $0.first == "-u" }).count == 1 && rows.count == 1, "success or already-gone verifies path absence without touching same-ID copy")
            try check(commands.filter({ $0 == ["-dump", "Bundle"] }).count == 2, "one complete before and after read")
        }
        var absentCommands: [[String]] = []
        try R.cleanup(targets: selected, authorize: {}, execute: { args in absentCommands.append(args); return (0, dump([unrelated])) })
        try check(absentCommands.allSatisfy({ $0 == ["-dump", "Bundle"] }), "already absent performs no unregister")
        try refuses("exit one with retained path fails") {
            try R.cleanup(targets: selected, authorize: {}, execute: { args in args.first == "-dump" ? (0, dump([(trash, nil), unrelated])) : (1, Data()) })
        }
        try refuses("exit zero with retained path fails") {
            try R.cleanup(targets: selected, authorize: {}, execute: { args in args.first == "-dump" ? (0, dump([(trash, nil), unrelated])) : (0, Data()) })
        }
        var foreignMutations = 0
        try refuses("foreign identifier at target fails") {
            try R.cleanup(targets: selected, authorize: {}, execute: { args in
                if args.first == "-u" { foreignMutations += 1 }; return (0, dump([(trash, "other.app")]))
            })
        }
        try check(foreignMutations == 0, "foreign row not mutated")
        var authCalls = 0, staleMutations = 0
        try refuses("context changes before unregister block") {
            try R.cleanup(targets: selected, authorize: { authCalls += 1; if authCalls == 3 { throw RelayRemoval.fail("fixture replacement") } }, execute: { args in
                if args.first == "-u" { staleMutations += 1 }; return (0, dump([(trash, selected[0].identifier)]))
            })
        }
        try check(staleMutations == 0, "changed installation never mutated")
        let args = R.userArguments(uid: 501, home: home, name: "fixture", arguments: ["-u", trash])
        try check(Array(args.prefix(10)) == ["asuser", "501", "/usr/bin/sudo", "-n", "-H", "-u", "#501", "/usr/bin/env", "-i", "HOME=/Users/fixture"], "explicit bound GUI and ordinary user credentials")
        try check(args.contains("USER=fixture") && args.contains("LOGNAME=fixture") && args.suffix(3) == [R.tool, "-u", trash], "fixed user environment and exact tool arguments")
        var events: [String] = []
        try refuses("registration failure retains requested checkpoint") {
            try RelayRemovalLifecycle.run(phase: "requested", restoreUser: { events.append("restored") }, removeRegistrations: { events.append("registration-failed"); throw RelayRemoval.fail("fixture") }, removeComponents: { events.append("components") }, checkpoint: { events.append($0) }, finish: { events.append("finish") })
        }
        try check(events == ["restored", "registration-failed"], "restoration may have completed but no later checkpoint or component cleanup")
        return count
    }
}
