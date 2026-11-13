import Foundation
import Darwin

struct RelayBrowserProcess: Equatable {
    let pid: Int32
    let parent: Int32
    let name: String
    let arguments: [String]
}
struct RelayBrowserProcessEnvironment {
    var snapshot: () throws -> [RelayBrowserProcess]
    var lock: (URL) -> String
}

/// Read-only process observation. Never signals, quits or launches a browser.
enum RelayBrowserProcesses {
    static func reusable(_ profile: URL, httpPort: Int, snapshot: (() throws -> [RelayBrowserProcess])? = nil,
                         executable: ((Int32) -> String?)? = nil) -> Bool {
        let snapshot = snapshot ?? liveSnapshot
        let executable = executable ?? { pid in
            var buffer = [CChar](repeating: 0, count: 4096)
            return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : nil
        }
        let expected = ["--user-data-dir=" + profile.path, "--proxy-server=http://127.0.0.1:\(httpPort)",
            "--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE *.localhost",
            "--webrtc-ip-handling-policy=disable_non_proxied_udp"]
        func matches(_ processes: [RelayBrowserProcess]) -> [Int32] {
            processes.filter { process in
                process.name == "Google Chrome" &&
                executable(process.pid) == RelayBrowserContract.chrome.appendingPathComponent("Contents/MacOS/Google Chrome").path &&
                expected.allSatisfy { argument in
                    let prefix = String(argument.prefix(through: argument.firstIndex(of: "=")!))
                    return process.arguments.filter { $0.hasPrefix(prefix) || $0 == String(prefix.dropLast()) } == [argument]
                } && !process.arguments.contains {
                    ($0.hasPrefix("--proxy") && !$0.hasPrefix("--proxy-server=")) || $0.hasPrefix("--no-proxy")
                }
            }.map { $0.pid }
        }
        do {
            let first = matches(try snapshot())
            guard first.count == 1 else { return false }
            return matches(try snapshot()) == first
        } catch { return false }
    }

    static func arguments(_ bytes: [UInt8]) throws -> [String] {
        guard bytes.count >= 5 else { throw AssistantError("进程参数不可解析。") }
        let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard (1...4096).contains(argc) else { throw AssistantError("进程参数数量无效。") }
        var offset = 4
        func string() throws -> String {
            guard offset < bytes.count, let end = bytes[offset...].firstIndex(of: 0),
                  let result = String(bytes: bytes[offset..<end], encoding: .utf8) else { throw AssistantError("进程参数不完整。") }
            offset = end + 1
            return result
        }
        guard !(try string()).isEmpty else { throw AssistantError("进程路径缺失。") }
        while offset < bytes.count && bytes[offset] == 0 { offset += 1 }
        return try (0..<argc).map { _ in try string() }
    }

    static func arguments(of pid: pid_t) throws -> [String] {
        var limitQuery = [CTL_KERN, KERN_ARGMAX]
        var limit: CInt = 0
        var limitSize = MemoryLayout<CInt>.size
        guard sysctl(&limitQuery, 2, &limit, &limitSize, nil, 0) == 0,
              limitSize == MemoryLayout<CInt>.size, (1...2_097_152).contains(limit) else {
            throw AssistantError("进程参数上限不可读取。")
        }
        // XNU checks the supplied payload capacity against KERN_ARGMAX after
        // reserving one C int for argc. An oversized buffer returns EINVAL.
        let capacity = Int(limit) + MemoryLayout<CInt>.size
        var query = [CTL_KERN, KERN_PROCARGS2, pid]
        var bytes = [UInt8](repeating: 0, count: capacity), length = capacity
        guard sysctl(&query, 3, &bytes, &length, nil, 0) == 0,
              length > MemoryLayout<CInt>.size, length < capacity else {
            throw AssistantError("进程参数不可读取。")
        }
        return try arguments(Array(bytes.prefix(length)))
    }

    private static func liveSnapshot() throws -> [RelayBrowserProcess] {
        let minimum = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), nil, 0)
        guard minimum > 0, minimum < 4_000_000 else { throw AssistantError("进程列表不可读取。") }
        var pids = [Int32](repeating: 0, count: Int(minimum) / 4 + 512)
        let capacity = Int32(pids.count * 4)
        let size = pids.withUnsafeMutableBytes { proc_listpids(UInt32(PROC_UID_ONLY), getuid(), $0.baseAddress, capacity) }
        guard size > 0, size < capacity, size % 4 == 0 else { throw AssistantError("进程列表不完整。") }
        var result: [RelayBrowserProcess] = []
        for pid in pids.prefix(Int(size) / 4) where pid > 0 {
            var name = [CChar](repeating: 0, count: 1024)
            if proc_name(pid, &name, UInt32(name.count)) <= 0 {
                if errno == ESRCH { continue }
                throw AssistantError("进程身份不可确认。")
            }
            let value = String(cString: name)
            guard value.hasPrefix("Google Chrome") else { continue }
            var info = proc_bsdinfo()
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else {
                throw AssistantError("浏览器父进程不可确认。")
            }
            result.append(RelayBrowserProcess(pid: pid, parent: Int32(info.pbi_ppid), name: value,
                arguments: try arguments(of: pid)))
        }
        return result.sorted { $0.pid < $1.pid }
    }

    private static func liveLock(_ profile: URL) -> String {
        do {
            try NetworkConfiguration.checkPlainPath(profile)
            let lock = profile.appendingPathComponent("SingletonLock")
            var info = stat()
            if lstat(lock.path, &info) != 0 { return errno == ENOENT ? "none" : "unknown" }
            guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFLNK),
                  let value = try? FileManager.default.destinationOfSymbolicLink(atPath: lock.path),
                  let last = value.split(separator: "-").last, let pid = Int32(last), pid > 0 else { return "unknown" }
            if kill(pid, 0) == 0 || errno == EPERM { return "running" }
            return errno == ESRCH ? "stale" : "unknown"
        } catch { return "unknown" }
    }

    static func status(_ profile: URL, environment: RelayBrowserProcessEnvironment? = nil) -> String {
        let environment = environment ?? RelayBrowserProcessEnvironment(snapshot: liveSnapshot, lock: liveLock)
        let expected = NetworkConfiguration.canonicalPath(profile)
        func classify(_ processes: [RelayBrowserProcess]) -> String {
            let map = Dictionary(processes.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
            guard map.count == processes.count else { return "unconfirmed" }
            func target(_ process: RelayBrowserProcess, seen: Set<Int32>) -> String {
                guard !seen.contains(process.pid), seen.count < 16 else { return "unconfirmed" }
                var profiles: [String] = []
                for (index, value) in process.arguments.enumerated() {
                    if value.hasPrefix("--user-data-dir=") { profiles.append(String(value.dropFirst(16))) }
                    else if value == "--user-data-dir" {
                        guard index + 1 < process.arguments.count else { return "unconfirmed" }
                        profiles.append(process.arguments[index + 1])
                    }
                }
                if profiles.contains(where: { $0.hasPrefix("/") && NetworkConfiguration.canonicalPath(URL(fileURLWithPath: $0)) == expected }) { return "running" }
                if !profiles.isEmpty {
                    return profiles.count == 1 && profiles[0].hasPrefix("/") ? "other" : "unconfirmed"
                }
                if process.name.contains("Helper") || process.arguments.contains(where: { $0.hasPrefix("--type=") }) {
                    guard let parent = map[process.parent] else { return "unconfirmed" }
                    return target(parent, seen: seen.union([process.pid]))
                }
                // Dedicated profiles are never Chrome's default user-data directory.
                return "other"
            }
            let states = processes.map { target($0, seen: []) }
            if states.contains("running") { return "running" }
            return states.contains("unconfirmed") ? "unconfirmed" : "closed"
        }
        do {
            let firstLock = environment.lock(profile)
            if firstLock == "running" { return "running" }
            guard ["none", "stale"].contains(firstLock) else { return "unconfirmed" }
            let first = try environment.snapshot()
            let state = classify(first)
            guard state == "closed" else { return state }
            let second = try environment.snapshot()
            guard first == second else { return classify(second) == "running" ? "running" : "unconfirmed" }
            let lastLock = environment.lock(profile)
            if lastLock == "running" { return "running" }
            return ["none", "stale"].contains(lastLock) ? "closed" : "unconfirmed"
        } catch { return "unconfirmed" }
    }
}
