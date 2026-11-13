import Foundation
import Darwin

@main struct RelayTunFixedCoreTests {
    enum Failure: Error { case fixture, deadline }
    static func main() {
        guard CommandLine.arguments.count == 2, getuid() > 0, getuid() == geteuid(), getgid() == getegid() else { exit(77) }
        _ = umask(0o077)
        var pattern = Array("/private/tmp/relay-fixed-core-XXXXXX".utf8CString)
        guard mkdtemp(&pattern) != nil else { exit(78) }
        let directory = String(cString: pattern)
        var rows = [[String: Any]](), held: RelayTunOwnedChild?, lockFD: Int32 = -1, contender: Int32 = -1
        var cleanExit = false
        func check(_ name: String, _ condition: @autoclosure () throws -> Bool) throws {
            let passed = try condition(); rows.append(["name": name, "passed": passed])
            if !passed { throw Failure.fixture }
        }
        do {
            let configuration = try RelayTunOwnedChild.fixedCoreFixtureConfiguration()
            try configuration.write(to: URL(fileURLWithPath: directory + "/config.yaml"), options: .withoutOverwriting)
            lockFD = open(directory + "/busy.lock", O_CREAT | O_EXCL | O_RDONLY | O_CLOEXEC, 0o600)
            guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw Failure.fixture }
            let child = try RelayTunOwnedChild.fixedCoreFixture(executable: CommandLine.arguments[1], directory: directory,
                installationLock: lockFD, register: { held = $0 })
            try check("real fixed core registered before production identity guard", held === child)
            var peerChecks = 0
            let reader = try RelayTunCoreReadiness.Live(directory: directory, configuration: configuration,
                authorization: "relay-offline-fixture", verifyPeer: { socket in try child.verifyPeer(socket: socket); peerChecks += 1 })
            let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
            var version: Data?, configs: Data?
            while version == nil || configs == nil {
                do {
                    version = try child.whileRunning { try reader.read("version") }
                    configs = try child.whileRunning { try reader.read("configs") }
                } catch let error as RelayTunCoreReadiness.Failure {
                    guard error.allowsStartupRetry,
                          try child.observe() == .running,
                          DispatchTime.now().uptimeNanoseconds < deadline else { throw error }
                    usleep(10000)
                }
            }
            let versionValue = try RelayTunStrictJSON.object(version!, limit: 65536)
            let actual = try RelayTunStrictJSON.object(configs!, limit: 65536)
            try check("actual upstream version response matches fixed build", versionValue["version"] as? String == RelayTunCoreProbePlan.version)
            try check("both real HTTP responses authenticated the exact held Unix peer", peerChecks >= 2)
            try check("all reported IP proxy listeners remain disabled", ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"].allSatisfy { RelayTunStrictJSON.integer(actual[$0]) == 0 })
            try check("real core reports TUN disabled", (actual["tun"] as? [String: Any])?["enable"] as? Bool == false)
            try check("actual mode and IPv6 match isolated source", actual["mode"] as? String == "rule" && actual["ipv6"] as? Bool == false)
            contender = open(directory + "/busy.lock", O_RDONLY | O_CLOEXEC)
            guard contender >= 0, Darwin.close(lockFD) == 0 else { throw Failure.fixture }; lockFD = -1
            try check("real Go core retains installation lock after parent closes its handle", flock(contender, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK)
            let stopped = try child.stop()
            try check("real fixed core exits gracefully through production owned stop", stopped.waitStatus == 0 && !stopped.forced)
            try check("held core is positively reaped", try child.observe() == .exited(0))
            cleanExit = true
            try check("installation lock is released after real core exit", flock(contender, LOCK_EX | LOCK_NB) == 0)
            let again = try child.stop()
            try check("repeated owned stop returns the cached terminal result", again.waitStatus == 0 && !again.forced)
            var readAfterExit = false
            do {
                _ = try child.whileRunning { readAfterExit = true; return true }
                throw Failure.fixture
            } catch RelayTunOwnedChild.Failure.unknown { }
            try check("no control read executes after the owned core exits", !readAfterExit)
        } catch { rows.append(["name": "fixed-core integration", "passed": false, "error": String(describing: error)]) }
        if !cleanExit, let held {
            do {
                let stopped = try held.stop()
                rows.append(["name": "failed-probe owned child cleanup", "passed": try held.observe() == .exited(stopped.waitStatus), "forced": stopped.forced])
                cleanExit = true
            } catch { rows.append(["name": "failed-probe cleanup", "passed": false, "error": String(describing: error)]) }
        }
        if lockFD >= 0 { Darwin.close(lockFD) }
        if contender >= 0 { Darwin.close(contender) }
        if held == nil || cleanExit { try? FileManager.default.removeItem(atPath: directory) }
        let passed = rows.allSatisfy { $0["passed"] as? Bool == true }
        let result: [String: Any] = ["scope": "ordinary-uid fixed Mihomo production owner and Unix reader",
            "passed": passed, "checks": rows, "tunStarted": false, "systemDNSChanged": false,
            "privilegedCoreTested": false, "coreStarted": held != nil, "coreReaped": cleanExit,
            "networkAcceptancePassed": false, "preservedFailureDirectory": !cleanExit && held != nil ? directory : ""]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text) }
        exit(passed ? 0 : 1)
    }
}
