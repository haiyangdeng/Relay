import Foundation
import Darwin

// True parent capability, using Foundation's owned Process/wait lifecycle and
// the existing fixed TUN TCP observer. Disk identities are observation only.
final class CoreOwnerChild: @unchecked Sendable {
    let process: Process
    private let condition = NSCondition()
    private let terminationSignal = DispatchSemaphore(value: 0)
    private var ended = false, status: Int32?
    private var tail = Data(), streamsClosed = false
    private let output = Pipe(), error = Pipe()
    let executable: String
    init(executable: String, directory: String, parser: Bool) throws {
        self.executable = executable; process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.currentDirectoryURL = URL(fileURLWithPath: directory)
        process.arguments = parser ? ["-t", "-d", directory, "-f", directory + "/config.yaml"] :
            ["-d", directory, "-f", directory + "/config.yaml", "-ext-ctl-unix", directory + "/api.sock"]
        process.environment = ["PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": directory, "TMPDIR": directory]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output; process.standardError = error
        let drain: @Sendable (FileHandle) -> Void = { [weak self] handle in
            guard let self else { return }
            self.condition.lock(); defer { self.condition.unlock() }
            guard !self.streamsClosed else { return }
            let bytes = handle.availableData
            guard !bytes.isEmpty else { return }
            self.tail.append(bytes)
            if self.tail.count > 131072 { self.tail.removeFirst(self.tail.count - 131072) }
        }
        output.fileHandleForReading.readabilityHandler = drain
        error.fileHandleForReading.readabilityHandler = drain
        process.terminationHandler = { [weak self] process in
            guard let self else { return }
            self.condition.lock(); self.status = process.terminationStatus; self.ended = true; self.condition.broadcast(); self.condition.unlock(); self.terminationSignal.signal()
        }
    }
    func launch() throws { try process.run() }
    var pid: pid_t { process.processIdentifier }
    var exited: Bool { condition.lock(); defer { condition.unlock() }; return ended }
    func wait(_ seconds: TimeInterval) -> Bool {
        if exited { return true }
        _ = terminationSignal.wait(timeout: .now() + seconds)
        return exited
    }
    func parserResult() throws {
        guard wait(10) else {
            if process.isRunning { process.terminate() }
            guard wait(3) else { throw CoreOwnerFailure.uncertain }
            throw CoreOwnerFailure.resource
        }
        condition.lock(); let value = status; condition.unlock()
        guard value == 0 else { throw CoreOwnerFailure.resource }
    }
    func stop() throws {
        if exited { return }
        guard process.isRunning else { guard wait(3) else { throw CoreOwnerFailure.uncertain }; return }
        process.terminate() // only this exact Process capability; never PID from storage
        guard wait(3) else { throw CoreOwnerFailure.uncertain }
    }
    func closeStreams() {
        condition.lock(); defer { condition.unlock() }
        guard !streamsClosed else { return }; streamsClosed = true
        output.fileHandleForReading.readabilityHandler = nil
        error.fileHandleForReading.readabilityHandler = nil
        try? output.fileHandleForReading.close(); try? error.fileHandleForReading.close()
    }
    deinit { closeStreams() }
}

enum CoreOwnerCore {
    static func resource(selfIdentity: CoreOwnerProcessIdentity) throws -> (String, String) {
        // The reused listener decoder is Darwin24-only. This guard precedes
        // reserve directory creation; dead-record recovery needs no decoder.
        var system = utsname(); guard uname(&system) == 0 else { throw CoreOwnerFailure.unavailable }
        let capacity = MemoryLayout.size(ofValue: system.release)
        let release = withUnsafePointer(to: &system.release) { $0.withMemoryRebound(to: CChar.self, capacity: capacity) { String(cString: $0) } }
        guard release.hasPrefix("24.") else { throw CoreOwnerFailure.unavailable }
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x64"
        #endif
        guard let pin = RelayCoreOwnerRelease.pins[architecture] else { throw CoreOwnerFailure.resource }
        let executable = URL(fileURLWithPath: selfIdentity.executable).deletingLastPathComponent().path + "/core/darwin-" + architecture + "/mihomo"
        let identity = try CoreOwnerIdentity.stamp(executable, executable: true)
        let bytes = try CoreOwnerFiles.read(executable, maximum: 134217728, privateFile: false)
        guard bytes.count == pin.1, coreOwnerHash(bytes) == pin.0,
              try CoreOwnerIdentity.stamp(executable, executable: true) == identity else { throw CoreOwnerFailure.resource }
        return (executable, pin.0)
    }
    static func configuration(_ raw: String, runtime: CoreOwnerRuntime) throws -> Data {
        let bytes = Data(raw.utf8)
        let config = try coreOwnerObject(bytes, limit: 2 * 1024 * 1024)
        func number(_ key: String) -> Int? { RelayTunStrictJSON.integer(config[key]) }
        guard number("port") == runtime.httpPort, config["bind-address"] as? String == "127.0.0.1",
              coreOwnerBoolean(config["allow-lan"]) == false, config["mode"] as? String == runtime.mode,
              ["socks-port", "mixed-port", "redir-port", "tproxy-port"].allSatisfy({ number($0) == nil || number($0) == 0 }),
              config["external-controller"] == nil || config["external-controller"] as? String == "",
              config["external-controller-unix"] == nil,
              config["external-controller-pipe"] == nil,
              config["external-controller-tls"] == nil || config["external-controller-tls"] as? String == "",
              config["external-ui"] == nil || config["external-ui"] as? String == "",
              config["external-ui-url"] == nil || config["external-ui-url"] as? String == "",
              config["listeners"] == nil || (config["listeners"] as? [Any])?.isEmpty == true,
              config["script"] == nil, coreOwnerBoolean((config["ntp"] as? [String: Any])?["enable"]) == false,
              config["secret"] == nil || config["secret"] as? String == "",
              coreOwnerBoolean(config["geo-auto-update"]) == false,
              coreOwnerBoolean((config["dns"] as? [String: Any])?["enable"]) == false,
              coreOwnerBoolean((config["tun"] as? [String: Any])?["enable"]) == false,
              config["rule-providers"] == nil || (config["rule-providers"] as? [String: Any])?.isEmpty == true,
              config["proxy-providers"] == nil || (config["proxy-providers"] as? [String: Any])?.isEmpty == true,
              let groups = config["proxy-groups"] as? [[String: Any]], groups.count <= 80,
              !groups.contains(where: { $0["type"] as? String == "smart" }),
              let proxies = config["proxies"] as? [[String: Any]], proxies.count <= 10000,
              let rules = config["rules"] as? [String], rules.count <= 10000,
              rules.allSatisfy({ !$0.uppercased().hasPrefix("GEO") && !$0.uppercased().hasPrefix("RULE-SET,") }) else { throw CoreOwnerFailure.refused }
        return bytes
    }
    static func read(_ endpoint: String, journal: CoreOwnerJournal) throws -> [String: Any] {
        guard ["version", "configs"].contains(endpoint), let core = journal.core else { throw CoreOwnerFailure.identity }
        try CoreOwnerIdentity.verify(core)
        let socketInfo = try CoreOwnerFiles.metadata(journal.runtime.socket)
        guard socketInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
              socketInfo.st_uid == getuid(), socketInfo.st_nlink == 1 else { throw CoreOwnerFailure.identity }
        let fd = try CoreOwnerIO.connect(journal.runtime.socket); defer { Darwin.close(fd) }
        var peer: pid_t = 0, size = socklen_t(MemoryLayout<pid_t>.size), uid: uid_t = 0, gid: gid_t = 0
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer, &size) == 0, peer == core.pid else { throw CoreOwnerFailure.identity }
        let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        try CoreOwnerIO.write(Data("GET /\(endpoint) HTTP/1.0\r\nHost: relay-owned\r\nConnection: close\r\n\r\n".utf8), to: fd, deadline: deadline)
        var response = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            try CoreOwnerIO.wait(fd, events: Int16(POLLIN), deadline: deadline)
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            if count == 0 { break }
            guard count > 0, response.count + count <= 1048576 else { throw CoreOwnerFailure.invalid }
            response.append(contentsOf: buffer.prefix(count))
        }
        guard let boundary = response.range(of: Data([13, 10, 13, 10])), boundary.lowerBound <= 32768,
              let headers = String(data: response[..<boundary.lowerBound], encoding: .ascii),
              headers.hasPrefix("HTTP/1.1 200 ") || headers.hasPrefix("HTTP/1.0 200 "),
              !headers.lowercased().contains("transfer-encoding:") else { throw CoreOwnerFailure.invalid }
        let body = Data(response[boundary.upperBound...])
        let lengths = headers.components(separatedBy: "\r\n").filter({ $0.lowercased().hasPrefix("content-length:") })
        guard lengths.count <= 1, lengths.isEmpty || Int(lengths[0].dropFirst(15).trimmingCharacters(in: .whitespaces)) == body.count else { throw CoreOwnerFailure.invalid }
        try CoreOwnerIdentity.verify(core)
        return try coreOwnerObject(body, limit: 1048576)
    }
    static func verify(_ journal: CoreOwnerJournal, child: CoreOwnerChild?) throws {
        guard let core = journal.core, let child, !child.exited, child.pid == core.pid,
              journal.runtime.configurationSHA256 == coreOwnerHash(try CoreOwnerFiles.read(journal.runtime.directory + "/config.yaml", maximum: 2 * 1024 * 1024)) else { throw CoreOwnerFailure.identity }
        try CoreOwnerIdentity.verify(core)
        try RelayTunTCPListener.verifyLive(pid: core.pid, uid: getuid(), ports: [journal.runtime.httpPort], deadline: DispatchTime.now().uptimeNanoseconds + 250000000)
        let version = try read("version", journal: journal), config = try read("configs", journal: journal)
        guard version["version"] as? String == RelayCoreOwnerRelease.coreVersion,
              RelayTunStrictJSON.integer(config["port"]) == journal.runtime.httpPort,
              config["mode"] as? String == journal.runtime.mode,
              coreOwnerBoolean((config["tun"] as? [String: Any])?["enable"]) == false else { throw CoreOwnerFailure.identity }
        // Fixed GET/configs serializes General/Inbound, not DNS. DNS-off proof
        // is the exact immutable launch bytes above; no v1 reload API exists.
        try CoreOwnerIdentity.verify(core)
    }
}
