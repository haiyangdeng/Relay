import AppKit
import Foundation
import Security
import Darwin

/// Adapts RelayBrowserProcesses' KERN_PROCARGS2/profile/parent matching. The
/// extra signing and process-generation checks are needed only for this new
/// graceful termination action. Normal Chrome profiles are never selected.
enum RelayUninstallPrivateBrowser {
    static let executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    static let resolver = "--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE *.localhost"
    static let webRTC = "--webrtc-ip-handling-policy=disable_non_proxied_udp"
    struct Actor: Equatable {
        let pid: Int32, parent: Int32, uid: UInt32
        let seconds: UInt64, microseconds: UInt64
        let name: String, executable: String, arguments: [String]
    }
    struct Environment {
        let snapshot: () throws -> [Actor]
        let authorized: () throws -> Void
        let authenticate: (Actor) throws -> Void
        let terminate: (Actor) throws -> Bool
        let forceTerminate: (Actor) throws -> Bool
        let pause: () -> Void
        var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    }
    private static func failure(_ text: String) -> NSError { RelayRemoval.fail("Private browser: " + text) }
    static func profile(_ home: String) -> String { home + "/Library/Application Support/Relay-Preview/Private Browser" }
    static func owned(_ actors: [Actor], profile: String, uid: UInt32) throws -> (mains: [Actor], ids: Set<Int32>) {
        let map = Dictionary(actors.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        guard map.count == actors.count else { throw failure("duplicate process snapshot") }
        func binding(_ actor: Actor, seen: Set<Int32>) throws -> Bool {
            guard actor.uid == uid, actor.pid > 1, actor.seconds > 0, actor.microseconds < 1_000_000,
                  !seen.contains(actor.pid), seen.count < 16 else { throw failure("process identity unavailable") }
            var profiles: [String] = []
            for (index, value) in actor.arguments.enumerated() {
                if value.hasPrefix("--user-data-dir=") { profiles.append(String(value.dropFirst(16))) }
                else if value == "--user-data-dir" {
                    guard index + 1 < actor.arguments.count else { throw failure("incomplete profile switch") }
                    profiles.append(actor.arguments[index + 1])
                }
            }
            if !profiles.isEmpty {
                guard profiles.count == 1, profiles[0].hasPrefix("/"), !profiles[0].contains("\0") else { throw failure("ambiguous profile") }
                // Do not resolve a different user's Chrome profile into Relay's
                // namespace or treat a prefix/suffix lookalike as our profile.
                return profiles[0] == profile
            }
            if actor.name.contains("Helper") || actor.arguments.contains(where: { $0.hasPrefix("--type=") }) {
                guard let parent = map[actor.parent] else { throw failure("orphan browser helper") }
                return try binding(parent, seen: seen.union([actor.pid]))
            }
            return false
        }
        let selected = try actors.filter { try binding($0, seen: []) }
        let mains = selected.filter { !$0.name.contains("Helper") && !$0.arguments.contains(where: { $0.hasPrefix("--type=") }) }
        guard mains.count <= 1 else { throw failure("multiple private browser leaders") }
        for main in mains {
            let proxies = main.arguments.filter { $0.hasPrefix("--proxy-server=") }
            guard main.name == "Google Chrome", main.executable == executable, proxies.count == 1,
                  let value = proxies.first, let url = URL(string: String(value.dropFirst("--proxy-server=".count))),
                  url.scheme == "http", url.host == "127.0.0.1", url.user == nil, url.password == nil,
                  url.path.isEmpty, url.query == nil, url.fragment == nil, url.port.map({ (1024...65535).contains($0) }) == true,
                  main.arguments.filter({ $0.hasPrefix("--host-resolver-rules") }) == [resolver],
                  main.arguments.filter({ $0.hasPrefix("--webrtc-ip-handling-policy") }) == [webRTC],
                  !main.arguments.contains(where: { ($0.hasPrefix("--proxy") && !$0.hasPrefix("--proxy-server=")) || $0.hasPrefix("--no-proxy") }) else {
                throw failure("Relay private browser launch arguments do not match")
            }
        }
        return (mains, Set(selected.map(\.pid)))
    }
    /// At most 15 seconds. Uninstall discards this dedicated profile, so a
    /// beforeunload dialog may not retain it indefinitely. Force is allowed only
    /// after a fresh, complete proof of the same originally selected instance.
    static func stop(home: String, uid: UInt32, environment: Environment) throws {
        let started = environment.now()
        try environment.authorized()
        let expected = profile(home), initial = try owned(environment.snapshot(), profile: expected, uid: uid)
        if !initial.ids.isEmpty && initial.mains.isEmpty { throw failure("private helpers remain without a trusted leader") }
        for actor in initial.mains {
            try environment.authenticate(actor)
            let fresh = try environment.snapshot()
            guard fresh.first(where: { $0.pid == actor.pid }) == actor,
                  try owned(fresh, profile: expected, uid: uid).mains == [actor] else { throw failure("process changed before graceful quit") }
            try environment.authorized()
            _ = try environment.terminate(actor)
        }
        var forced = false
        for _ in 0..<150 {
            guard environment.now() - started < 15 else { break }
            try environment.authorized()
            let observed = try owned(environment.snapshot(), profile: expected, uid: uid)
            if observed.ids.isEmpty {
                environment.pause()
                guard try owned(environment.snapshot(), profile: expected, uid: uid).ids.isEmpty else { throw failure("private browser restarted during shutdown") }
                return
            }
            if !forced && environment.now() - started >= 7 {
                guard initial.mains.count == 1, observed.mains == initial.mains else { throw failure("private browser identity changed before forced quit") }
                let actor = initial.mains[0]
                try environment.authenticate(actor)
                guard try owned(environment.snapshot(), profile: expected, uid: uid).mains == [actor] else { throw failure("private browser restarted before forced quit") }
                try environment.authorized()
                _ = try environment.forceTerminate(actor)
                forced = true
            }
            environment.pause()
        }
        throw failure("private browser quit has not completed")
    }
    private static func arguments(_ bytes: [UInt8]) throws -> [String] {
        guard bytes.count >= 5 else { throw failure("process arguments unavailable") }
        let count = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard (1...4096).contains(count) else { throw failure("invalid process argument count") }
        var offset = 4
        func string() throws -> String {
            guard offset < bytes.count, let end = bytes[offset...].firstIndex(of: 0),
                  let result = String(bytes: bytes[offset..<end], encoding: .utf8) else { throw failure("truncated process arguments") }
            offset = end + 1; return result
        }
        guard !(try string()).isEmpty else { throw failure("missing process executable") }
        while offset < bytes.count && bytes[offset] == 0 { offset += 1 }
        return try (0..<count).map { _ in try string() }
    }
    private static func arguments(_ pid: Int32) throws -> [String] {
        var limitQuery = [CTL_KERN, KERN_ARGMAX], limit: CInt = 0, size = MemoryLayout<CInt>.size
        guard sysctl(&limitQuery, 2, &limit, &size, nil, 0) == 0, size == MemoryLayout<CInt>.size,
              (1...2_097_152).contains(limit) else { throw failure("process argument bound unavailable") }
        let capacity = Int(limit) + MemoryLayout<CInt>.size
        var query = [CTL_KERN, KERN_PROCARGS2, pid], bytes = [UInt8](repeating: 0, count: capacity), length = capacity
        guard sysctl(&query, 3, &bytes, &length, nil, 0) == 0, length > 4, length < capacity else { throw failure("process arguments unavailable") }
        return try arguments(Array(bytes.prefix(length)))
    }
    private static func capture(_ pid: Int32, name: String, uid: UInt32) throws -> Actor {
        var first = proc_bsdinfo(), last = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &first, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              first.pbi_uid == uid, first.pbi_ruid == uid, first.pbi_start_tvsec > 0 else { throw failure("process owner unavailable") }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { throw failure("process executable unavailable") }
        let executable = String(cString: path), args = try arguments(pid)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &last, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              first.pbi_uid == last.pbi_uid, first.pbi_ruid == last.pbi_ruid, first.pbi_ppid == last.pbi_ppid,
              first.pbi_start_tvsec == last.pbi_start_tvsec, first.pbi_start_tvusec == last.pbi_start_tvusec,
              proc_pidpath(pid, &path, UInt32(path.count)) > 0, String(cString: path) == executable else { throw failure("process changed during inspection") }
        return Actor(pid: pid, parent: Int32(first.pbi_ppid), uid: uid, seconds: first.pbi_start_tvsec,
            microseconds: first.pbi_start_tvusec, name: name, executable: executable, arguments: args)
    }
    private static func snapshot(_ uid: UInt32) throws -> [Actor] {
        let minimum = proc_listpids(UInt32(PROC_UID_ONLY), uid, nil, 0)
        guard minimum > 0, minimum < 4_000_000 else { throw failure("process list unavailable") }
        var pids = [Int32](repeating: 0, count: Int(minimum) / 4 + 512)
        let capacity = Int32(pids.count * 4)
        let size = pids.withUnsafeMutableBytes { proc_listpids(UInt32(PROC_UID_ONLY), uid, $0.baseAddress, capacity) }
        guard size > 0, size < capacity, size % 4 == 0 else { throw failure("incomplete process list") }
        var result: [Actor] = []
        for pid in pids.prefix(Int(size) / 4) where pid > 1 {
            var name = [CChar](repeating: 0, count: 1024)
            if proc_name(pid, &name, UInt32(name.count)) <= 0 { if errno == ESRCH { continue }; throw failure("process name unavailable") }
            let value = String(cString: name)
            guard value.hasPrefix("Google Chrome") else { continue }
            do { result.append(try capture(pid, name: value, uid: uid)) }
            catch { if Darwin.kill(pid, 0) != 0 && errno == ESRCH { continue }; throw error }
        }
        return result.sorted { $0.pid < $1.pid }
    }
    private static func authenticate(_ actor: Actor) throws {
        guard try capture(actor.pid, name: actor.name, uid: actor.uid) == actor else { throw failure("process generation changed") }
        var code: SecCode?, requirement: SecRequirement?
        let expression = "anchor apple generic and identifier \"com.google.Chrome\" and certificate leaf[subject.OU] = \"EQHXZ8M8AV\""
        guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: actor.pid] as CFDictionary, [], &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, .noNetworkAccess, requirement) == errSecSuccess,
              try capture(actor.pid, name: actor.name, uid: actor.uid) == actor else { throw failure("Chrome code identity unavailable") }
    }
    static func run(_ installation: RelayRemovalInstallation) throws {
        guard getuid() > 0, getuid() == geteuid(), getuid() == installation.uid, getgid() == getegid() else { throw failure("bound user required") }
        func authorized() throws {
            let current = try RelayRemoval.json(RelayRemoval.root + "/installation.json"), intent = try RelayRemoval.json(RelayRemoval.root + "/intent.json")
            guard NSDictionary(dictionary: current).isEqual(to: installation.record),
                  intent["version"] as? Int == 1, intent["generation"] as? String == installation.generation,
                  intent["clientUID"] as? UInt32 == installation.uid, intent["phase"] as? String == "requested",
                  !RelayRemoval.present(RelayRemoval.app) else { throw failure("uninstall intent changed") }
            // An existing profile path must remain in the exact owned namespace.
            let path = profile(installation.home)
            if let physical = realpath(path, nil) {
                defer { free(physical) }
                guard String(cString: physical) == path else { throw failure("private profile path changed") }
            } else if errno != ENOENT { throw failure("private profile unavailable") }
        }
        func requestQuit(_ actor: Actor, force: Bool) throws -> Bool {
            guard let application = NSRunningApplication(processIdentifier: actor.pid), application.bundleIdentifier == "com.google.Chrome",
                  application.executableURL?.path == executable, !application.isTerminated else { throw failure("Chrome application handle unavailable") }
            try authorized(); try authenticate(actor)
            return force ? application.forceTerminate() : application.terminate()
        }
        try stop(home: installation.home, uid: installation.uid, environment: Environment(snapshot: { try snapshot(installation.uid) },
            authorized: authorized, authenticate: authenticate, terminate: { try requestQuit($0, force: false) },
            forceTerminate: { try requestQuit($0, force: true) }, pause: { Thread.sleep(forTimeInterval: 0.1) }))
    }

    static func tests() throws -> Int {
        let home = "/Users/fixture", uid: UInt32 = 501, expected = profile(home)
        let args = [executable, "--user-data-dir=" + expected, "--proxy-server=http://127.0.0.1:17890", resolver, webRTC]
        func actor(_ pid: Int32 = 100, _ values: [String]? = nil, seconds: UInt64 = 1, path: String = executable, name: String = "Google Chrome", parent: Int32 = 1) -> Actor {
            Actor(pid: pid, parent: parent, uid: uid, seconds: seconds, microseconds: 0, name: name, executable: path, arguments: values ?? args)
        }
        var count = 0
        func check(_ condition: Bool, _ name: String) throws { guard condition else { throw failure("fixture " + name) }; count += 1 }
        func rejects(_ name: String, _ operation: () throws -> Void) throws { do { try operation() } catch { count += 1; return }; throw failure("fixture unexpectedly accepted " + name) }
        let other = actor(200, [executable]), privateActor = actor()
        try check(try owned([other], profile: expected, uid: uid).ids.isEmpty, "default Chrome excluded")
        try check(try owned([actor(100, [executable, "--user-data-dir=" + expected + "-copy"])], profile: expected, uid: uid).ids.isEmpty, "profile prefix collision excluded")
        try rejects("duplicate profiles") { _ = try owned([actor(100, args + ["--user-data-dir=/other"])], profile: expected, uid: uid) }
        try rejects("foreign executable") { _ = try owned([actor(path: "/tmp/Google Chrome")], profile: expected, uid: uid) }
        try rejects("proxy override") { _ = try owned([actor(100, args + ["--no-proxy-server"])], profile: expected, uid: uid) }
        var current = [privateActor, other], terminated: [Int32] = []
        try stop(home: home, uid: uid, environment: Environment(snapshot: { current }, authorized: {}, authenticate: { _ in },
            terminate: { item in terminated.append(item.pid); current.removeAll { $0.pid == item.pid }; return true }, forceTerminate: { _ in false }, pause: {}))
        try check(terminated == [100] && current == [other], "only dedicated leader receives graceful quit")
        var snapshots = 0
        try rejects("PID reuse") {
            try stop(home: home, uid: uid, environment: Environment(snapshot: { snapshots += 1; return [snapshots == 1 ? privateActor : actor(seconds: 2)] },
                authorized: {}, authenticate: { _ in }, terminate: { _ in terminated.append(999); return true }, forceTerminate: { _ in false }, pause: {}))
        }
        try check(terminated == [100], "reused PID never receives quit")
        try rejects("signature mismatch") {
            try stop(home: home, uid: uid, environment: Environment(snapshot: { [privateActor] }, authorized: {}, authenticate: { _ in throw failure("fixture signature") }, terminate: { _ in terminated.append(998); return true }, forceTerminate: { _ in false }, pause: {}))
        }
        try check(terminated == [100], "unverified signature never receives quit")
        try rejects("quit refused") {
            try stop(home: home, uid: uid, environment: Environment(snapshot: { [privateActor] }, authorized: {}, authenticate: { _ in }, terminate: { _ in false }, forceTerminate: { _ in false }, pause: {}))
        }
        var pauses = 0
        try rejects("quit timeout") {
            try stop(home: home, uid: uid, environment: Environment(snapshot: { [privateActor] }, authorized: {}, authenticate: { _ in }, terminate: { _ in true }, forceTerminate: { _ in false }, pause: { pauses += 1 }))
        }
        try check(pauses == 150, "graceful wait is bounded")
        let helper = actor(101, ["helper", "--type=renderer"], name: "Google Chrome Helper", parent: 100)
        try check(try owned([privateActor, helper, other], profile: expected, uid: uid).ids == [100, 101], "private helper is tracked through parent")
        try rejects("orphan helper") { _ = try owned([helper, other], profile: expected, uid: uid) }
        var authorizationChecks = 0
        try rejects("intent withdrawn") {
            try stop(home: home, uid: uid, environment: Environment(snapshot: { [privateActor] }, authorized: {
                authorizationChecks += 1; if authorizationChecks > 1 { throw failure("fixture intent") }
            }, authenticate: { _ in }, terminate: { _ in terminated.append(997); return true }, forceTerminate: { _ in false }, pause: {}))
        }
        try check(terminated == [100], "changed intent never reaches quit")
        current = [privateActor, other]
        var forced: [Int32] = [], virtualTime: TimeInterval = 0
        try stop(home: home, uid: uid, environment: Environment(snapshot: { current }, authorized: {}, authenticate: { _ in },
            terminate: { _ in true }, forceTerminate: { item in forced.append(item.pid); current.removeAll { $0.pid == item.pid }; return true },
            pause: { virtualTime += 0.1 }, now: { virtualTime }))
        try check(forced == [100] && current == [other] && virtualTime < 15, "beforeunload only forces the reverified dedicated instance")
        virtualTime = 0; forced = []
        try rejects("generation changed during graceful wait") {
            try stop(home: home, uid: uid, environment: Environment(snapshot: { [virtualTime < 6 ? privateActor : actor(seconds: 2)] },
                authorized: {}, authenticate: { _ in }, terminate: { _ in true }, forceTerminate: { item in forced.append(item.pid); return true },
                pause: { virtualTime += 0.1 }, now: { virtualTime }))
        }
        try check(forced.isEmpty, "changed generation never receives forced quit")
        return count
    }
}
