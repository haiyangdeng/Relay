import Foundation
import Darwin

/// No path/PID arguments or input JSON. Only the fixed fd3 regular-file fixture
/// is readable; the branch cannot open utun, run a core or perform network IO.
func runRelayTunDescriptorFixtureChild() -> Int32 {
    let environment = ProcessInfo.processInfo.environment
    guard let nonce = environment["RELAY_TUN_DESCRIPTOR_NONCE"],
          nonce.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
          environment["RELAY_TUN_DESCRIPTOR_UID"] == String(getuid()),
          environment["RELAY_TUN_DESCRIPTOR_GID"] == String(getgid()),
          ["0", "1"].contains(environment["RELAY_TUN_DESCRIPTOR_EXIT"] ?? ""),
          getuid() != 0, getuid() == geteuid(), getgid() == getegid() else { return 20 }
    var info = stat()
    guard fstat(3, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          info.st_uid == getuid(), info.st_mode & 0o7777 == 0o600,
          info.st_nlink == 1, info.st_size > 0, info.st_size <= 4096 else { return 21 }
    if environment["RELAY_TUN_DESCRIPTOR_EXIT"] == "1" { Darwin.close(3); return 23 }
    let otherFDs = (4...255).filter { fcntl(Int32($0), F_GETFD) >= 0 }
    // Parent opens a separate writer before spawning, then closes every input
    // reference and only afterward releases this file-based gate. No extra FD
    // is explicitly inherited for synchronization.
    let deadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000
    var gate: UInt8 = 0
    repeat {
        guard pread(3, &gate, 1, 0) == 1 else { return 24 }
        if gate == Character("1").asciiValue! { break }
        usleep(1000)
    } while DispatchTime.now().uptimeNanoseconds < deadline
    guard gate == Character("1").asciiValue! else { return 25 }
    let expected = Data(("1relay-inert-tun-fd:" + nonce).utf8)
    var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
    let count = pread(3, &bytes, bytes.count, 0)
    let matched = count == expected.count && Data(bytes) == expected
    let closed = Darwin.close(3) == 0 && fcntl(3, F_GETFD) < 0 && errno == EBADF
    let report: [String: Any] = ["uid": getuid(), "euid": geteuid(), "gid": getgid(), "egid": getegid(),
        "fd3ReadMatched": matched, "fd3Closed": closed, "otherFDs": otherFDs,
        "probeLimit": 255, "liveTunUsed": false, "networkOperationsPerformed": false]
    guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]),
          let output = String(data: data, encoding: .utf8), data.count <= 4096 else { return 26 }
    print(output)
    return matched && closed && otherFDs.isEmpty ? 0 : 27
}

func runRelayTunDescriptorSelfTests() -> Int32 {
    var rows: [[String: Any]] = []
    func check(_ passed: Bool, _ name: String) { rows.append(["name": name, "passed": passed]) }
    func rejects(_ name: String, _ body: () throws -> Void) { do { try body(); check(false, name) } catch { check(true, name) } }
    func descriptors() -> Set<Int32> { Set((0...255).map(Int32.init).filter { fcntl($0, F_GETFD) >= 0 }) }
    func reaped(_ pid: pid_t) -> Bool {
        var status: Int32 = 0
        return waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD
    }
    func fixture(_ body: (String, inout Int32, Int32) throws -> Void) throws {
        let home = URL(fileURLWithPath: "/private/tmp/relay-tun-fd-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: home) }
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(), path = home.appendingPathComponent("inert.data")
        try NetworkConfiguration.safeWrite(Data(("0relay-inert-tun-fd:" + nonce).utf8), to: path, mode: 0o600)
        var input = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        let writer = Darwin.open(path.path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        defer { if input >= 0 { Darwin.close(input) }; if writer >= 0 { Darwin.close(writer) } }
        guard input >= 0, writer >= 0 else { throw AssistantError("私有惰性夹具不可用。") }
        try body(nonce, &input, writer)
    }
    do {
        guard getuid() != 0, getuid() == geteuid(), getgid() == getegid() else { throw AssistantError("惰性验证要求普通用户身份。") }
        for name in ["utun0", "utun42", "utun100000", "utun4294967294"] {
            check(RelayTunDescriptor.validInterfaceName(name), "actual interface name fits SDK unit width: " + name)
        }
        for name in ["utun", "utun4294967295", "utun01", "utun000000000001", "utun123456789012", "utun0\n", "utun+1", "utun一"] {
            check(!RelayTunDescriptor.validInterfaceName(name), "ambiguous or out-of-width actual interface name is refused: " + name)
        }
        try fixture { _, input, _ in
            let baseline = descriptors()
            rejects("ordinary file is never accepted as a live TUN descriptor") { _ = try RelayTunDescriptor.validateLive(input, expectedInterface: "utun42") }
            let receipt = try RelayTunAcquiredReceipt(installationRevision: String(repeating: "a", count: 64), clientUID: getuid(),
                evidenceSHA256: String(repeating: "b", count: 64), runtimeConfigurationSHA256: String(repeating: "c", count: 64),
                planID: "8403621c-dafa-42e5-b5ba-bf10e07e7776", sessionID: "7eb77791-4444-4b08-890d-6e39db0d663a",
                deviceID: "ca363b3f-aecc-4b75-a8fb-1a2b19af583e", interfaceName: "utun42", interfaceIndex: 91,
                controlID: 17, controlUnit: 43, socketDevice: "0", socketInode: "0")
            rejects("a valid receipt cannot turn an ordinary file into a TUN") { _ = try RelayTunDescriptor.validateLive(input, receipt: receipt) }
            rejects("invalid FD is never admitted") { _ = try RelayTunDescriptor.validateLive(-1, expectedInterface: "utun42") }
            rejects("an unallocated or arbitrary interface name is refused") { _ = try RelayTunDescriptor.validateLive(input, expectedInterface: "en0") }
            check(descriptors() == baseline, "rejected live validation closes only its private duplicates")
            var pair = [Int32](repeating: -1, count: 2)
            guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { throw AssistantError("本地惰性套接字夹具不可用。") }
            defer { for fd in pair { Darwin.close(fd) } }
            rejects("unrelated local socket is never treated as a utun control socket") { _ = try RelayTunDescriptor.validateLive(pair[0], expectedInterface: "utun42") }
            rejects("a full receipt cannot admit an unrelated socket") { _ = try RelayTunDescriptor.validateLive(pair[0], receipt: receipt) }
            check(descriptors() == baseline.union(Set(pair)), "receipt refusal releases only its new duplicate and preserves original descriptors")
        }
        let baseline = descriptors()
        try fixture { nonce, input, writer in
            // Deliberately clear CLOEXEC on high-numbered parent descriptors:
            // only CLOEXEC_DEFAULT plus explicit actions should isolate these.
            let sentinel = fcntl(writer, F_DUPFD, 128)
            guard sentinel >= 128, fcntl(sentinel, F_SETFD, 0) == 0 else { throw AssistantError("惰性继承夹具不可用。") }
            defer { Darwin.close(sentinel) }
            var parentClosed = false
            let result = try RelayTunDescriptor.inertFixture(input, nonce: nonce) { _ in
                let original = input
                guard Darwin.close(input) == 0 else { throw AssistantError("父FD副本未关闭。") }
                input = -1
                parentClosed = fcntl(original, F_GETFD) == -1 && errno == EBADF
                var gate = Character("1").asciiValue!
                guard pwrite(writer, &gate, 1, 0) == 1 else { throw AssistantError("惰性读取门禁不可用。") }
            }
            let report = try JSONSerialization.jsonObject(with: result.output) as? [String: Any]
            check(result.waitStatus == 0, "own fixed inert child exits successfully")
            check(parentClosed && report?["fd3ReadMatched"] as? Bool == true, "child fd3 remains readable after all parent input references close")
            check(report?["uid"] as? UInt32 == getuid() && report?["euid"] as? UInt32 == getuid() && getuid() != 0, "child real and effective UID stay unprivileged")
            check(report?["gid"] as? UInt32 == getgid() && report?["egid"] as? UInt32 == getgid(), "child real and effective GID stay unchanged")
            check((report?["otherFDs"] as? [Int])?.isEmpty == true, "CLOEXEC_DEFAULT prevents unrelated open descriptors and temporary copies from surviving exec")
            check(report?["fd3Closed"] as? Bool == true, "child explicitly closes its inherited descriptor")
            check(report?["liveTunUsed"] as? Bool == false && report?["networkOperationsPerformed"] as? Bool == false, "fixture reports no live TUN or external network operation")
            check(fcntl(sentinel, F_GETFD) >= 0 && fcntl(writer, F_GETFD) >= 0, "child actions preserve unrelated parent descriptors")
            check(reaped(result.pid), "successful child has already been reaped")
        }
        check(descriptors() == baseline, "success releases parent mapping and receipt descriptors")
        try fixture { nonce, input, _ in
            let before = descriptors()
            rejects("actual failed spawn does not leak a descriptor or leave an adopted child") { _ = try RelayTunDescriptor.inertFixture(input, nonce: nonce, failSpawn: true) }
            check(descriptors() == before, "spawn failure releases all temporary descriptors")
            let early = try RelayTunDescriptor.inertFixture(input, nonce: nonce, exitEarly: true)
            check(early.waitStatus == 23 << 8 && early.output.isEmpty && reaped(early.pid), "early child exit is preserved and reaped without pretending readiness")
            check(descriptors() == before, "early exit releases parent-side descriptors")
            var aborted: pid_t = 0
            rejects("an error after spawn cleans up only the call's inert child") {
                _ = try RelayTunDescriptor.inertFixture(input, nonce: nonce) { pid in
                    aborted = pid
                    throw AssistantError("intentional inert callback failure")
                }
            }
            check(aborted > 0 && reaped(aborted), "failed parent operation leaves no live or unreaped inert child")
            check(descriptors() == before, "parent failure releases mapping and receipt descriptors")
        }
        check(descriptors() == baseline, "all fixture descriptors are closed after completion")
    } catch { check(false, "unexpected inert descriptor fixture error: \(error)") }
    let passed = rows.filter { $0["passed"] as? Bool == true }.count
    let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
        "backend": "ordinary-user posix_spawn to the fixed native inert regular-file branch",
        "actualTunAccepted": false, "helperInstalled": false, "actualNetworkConfigurationChanged": false]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), let output = String(data: data, encoding: .utf8) { print(output) }
    return passed == rows.count ? 0 : 1
}
