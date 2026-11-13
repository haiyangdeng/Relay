import Foundation

func runRelayBrowserProcessSelfTests() -> Int32 {
    var count = 0, failures: [String] = []
    func check(_ condition: Bool, _ name: String) { count += 1; if !condition { failures.append(name) } }
    let profile = URL(fileURLWithPath: "/fixture/Relay/Private Browser")
    func process(_ pid: Int32 = 100, _ parent: Int32 = 1, _ name: String = "Google Chrome", _ args: [String] = ["chrome"]) -> RelayBrowserProcess {
        RelayBrowserProcess(pid: pid, parent: parent, name: name, arguments: args)
    }
    func observe(_ processes: [RelayBrowserProcess], _ lock: String = "none") -> String {
        RelayBrowserProcesses.status(profile, environment: RelayBrowserProcessEnvironment(snapshot: { processes }, lock: { _ in lock }))
    }
    check(observe([]) == "closed", "no browser in two complete scans")
    check(observe([], "stale") == "closed", "stale lock alone is not running")
    check(observe([], "running") == "running", "active lock blocks writes")
    check(observe([], "unknown") == "unconfirmed", "unreadable lock never means closed")
    check(observe([process()]) == "closed", "ordinary default Chrome does not block dedicated profile")
    check(observe([process(100, 1, "Google Chrome", ["chrome", "--user-data-dir=" + profile.path])]) == "running", "equals form and spaces")
    check(observe([process(100, 1, "Google Chrome", ["chrome", "--user-data-dir", profile.path])]) == "running", "separate argument form")
    check(observe([process(100, 1, "Google Chrome", ["chrome", "--user-data-dir", "/fixture/other"])]) == "closed", "other absolute profile")
    check(observe([process(100, 1, "Google Chrome", ["chrome", "--user-data-dir=relative"])]) == "unconfirmed", "relative profile not guessed")
    check(observe([process(100, 1, "Google Chrome", ["chrome", "--user-data-dir"])]) == "unconfirmed", "truncated profile switch")
    check(observe([process(101, 100, "Google Chrome Helper", ["helper", "--type=renderer"]), process()]) == "closed", "helper linked to default Chrome")
    check(observe([process(101, 1, "Google Chrome Helper", ["helper", "--type=renderer"])]) == "unconfirmed", "orphan helper blocks unsafe assumption")
    check(observe([process(101, 102, "Google Chrome Helper"), process(102, 101, "Google Chrome Helper")]) == "unconfirmed", "parent cycle bounded")
    check(observe([process(), process()]) == "unconfirmed", "duplicate PID rejected")
    var calls = 0
    let changed = RelayBrowserProcesses.status(profile, environment: RelayBrowserProcessEnvironment(snapshot: {
        calls += 1; return calls == 1 ? [] : [process()]
    }, lock: { _ in "none" }))
    check(changed == "unconfirmed", "changed process set requires retry")
    let denied = RelayBrowserProcesses.status(profile, environment: RelayBrowserProcessEnvironment(snapshot: { throw AssistantError("fixture denied") }, lock: { _ in "none" }))
    check(denied == "unconfirmed", "OS permission error not treated as no process")
    var lockCalls = 0
    let starts = RelayBrowserProcesses.status(profile, environment: RelayBrowserProcessEnvironment(snapshot: { [] }, lock: { _ in
        lockCalls += 1; return lockCalls == 1 ? "none" : "running"
    }))
    check(starts == "running", "new active lock after scan blocks write")
    do {
        var argc = Int32(3)
        var bytes = withUnsafeBytes(of: &argc) { Array($0) }
        bytes += Array("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".utf8) + [0, 0, 0]
        bytes += Array("chrome\0--user-data-dir\0/fixture/Profile With Space\0SECRET_ENV=not returned\0".utf8)
        let args = try RelayBrowserProcesses.arguments(bytes)
        check(args == ["chrome", "--user-data-dir", "/fixture/Profile With Space"], "binary argv parser excludes environment and retains spaces")
        for invalid in [Array(bytes.prefix(3)), Array(bytes.dropLast(50)), [UInt8](repeating: 0, count: 10)] {
            do { _ = try RelayBrowserProcesses.arguments(invalid); check(false, "bad argv refused") }
            catch { check(true, "bad argv refused") }
        }
    } catch { failures.append("valid argv fixture failed") }
    let ownArgs = try? RelayBrowserProcesses.arguments(of: getpid())
    check(ownArgs == CommandLine.arguments, "live kernel argument limit accepts current process argv")
    print(failures.isEmpty ? "PASS: \(count) browser process checks; fixtures and own-process argv only." : "FAIL: " + failures.joined(separator: ", "))
    return failures.isEmpty ? 0 : 1
}
