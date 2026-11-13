import Darwin
import Foundation

/// A foreground launch uses the current project, a fresh config directory and
/// a narrow inherited environment. The existing user's Claude files are not
/// used as writable session storage. The proxy credential never enters a file.
final class RelayTerminalCLISession {
    private let root: String
    private let directory: Int32
    private let supportDirectory: Int32
    private let temporary: String
    private let config: String
    private let support: String
    private let home: String
    let work: String
    private let tty: String
    private let workDevice: dev_t
    private let workInode: ino_t
    private let protectedConfiguration: [String]

    init(application: String) throws {
        guard let entry = getpwuid(getuid()), let rawHome = String(validatingCString: entry.pointee.pw_dir) else {
            throw RelayTerminalCLIResources.Failure.workspace
        }
        let home = try RelayTerminalCLIResources.physical(rawHome)
        let work = try RelayTerminalCLIResources.physical(FileManager.default.currentDirectoryPath)
        let homeConfig = home + "/.claude"
        // Permit a writable project, never a catch-all home/system root or
        // a project inside the existing Claude configuration tree.
        guard work.hasPrefix(home + "/"), work != homeConfig,
              !work.hasPrefix(homeConfig + "/"), !work.hasPrefix(application + "/"),
              work != application else { throw RelayTerminalCLIResources.Failure.workspace }
        var locations = [homeConfig, home + "/.claude.json", work + "/.claude", work + "/.mcp.json"]
        if let custom = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !custom.isEmpty {
            let path = URL(fileURLWithPath: custom, relativeTo: URL(fileURLWithPath: work, isDirectory: true)).standardizedFileURL.path
            guard path != home, path != work, !work.hasPrefix(path + "/"), path != "/" else {
                throw RelayTerminalCLIResources.Failure.workspace
            }
            locations.append(path)
        }
        var info = stat()
        guard lstat(work, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFDIR,
              info.st_mode & 0o022 == 0 else { throw RelayTerminalCLIResources.Failure.workspace }
        var ttyPath = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard ttyname_r(STDIN_FILENO, &ttyPath, ttyPath.count) == 0,
              let tty = ttyPath.withUnsafeBufferPointer({ String(validatingCString: $0.baseAddress!) }),
              tty.range(of: "^/dev/ttys[0-9]+$", options: .regularExpression) != nil else {
            throw RelayTerminalCLIResources.Failure.terminal
        }
        var name = Array("/private/tmp/relay-terminal.XXXXXXXX".utf8CString)
        guard name.withUnsafeMutableBufferPointer({ mkdtemp($0.baseAddress!) != nil }) else {
            throw RelayTerminalCLIResources.Failure.workspace
        }
        let root = name.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
        let fd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY)
        guard fd >= 3 else { _ = rmdir(root); throw RelayTerminalCLIResources.Failure.workspace }
        guard mkdirat(fd, "tmp", 0o700) == 0, mkdirat(fd, "config", 0o700) == 0,
              mkdirat(fd, "support", 0o700) == 0 else {
            _ = unlinkat(fd, "tmp", AT_REMOVEDIR)
            _ = unlinkat(fd, "config", AT_REMOVEDIR)
            _ = unlinkat(fd, "support", AT_REMOVEDIR)
            close(fd); _ = rmdir(root)
            throw RelayTerminalCLIResources.Failure.workspace
        }
        let supportFD = openat(fd, "support", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW_ANY)
        guard supportFD >= 3 else {
            _ = unlinkat(fd, "support", AT_REMOVEDIR)
            _ = unlinkat(fd, "tmp", AT_REMOVEDIR)
            _ = unlinkat(fd, "config", AT_REMOVEDIR)
            close(fd); _ = rmdir(root)
            throw RelayTerminalCLIResources.Failure.workspace
        }
        self.root = root
        directory = fd
        supportDirectory = supportFD
        temporary = root + "/tmp"
        config = root + "/config"
        support = root + "/support"
        self.home = home
        self.work = work
        self.tty = tty
        workDevice = info.st_dev
        workInode = info.st_ino
        protectedConfiguration = Array(Set(locations)).sorted()
    }

    deinit {
        _ = unlinkat(supportDirectory, "proxy-ca.pem", 0)
        _ = unlinkat(supportDirectory, ".curlrc", 0)
        close(supportDirectory)
        _ = unlinkat(directory, "support", AT_REMOVEDIR)
        _ = unlinkat(directory, "tmp", AT_REMOVEDIR)
        _ = unlinkat(directory, "config", AT_REMOVEDIR)
        close(directory)
        // Only empty directories are removed. Never recursively remove
        // entries writable by a running or surviving tool process.
        _ = rmdir(root)
    }

    func verifyExistingConfiguration() throws {
        var workInfo = stat()
        guard lstat(work, &workInfo) == 0, workInfo.st_mode & S_IFMT == S_IFDIR,
              workInfo.st_dev == workDevice, workInfo.st_ino == workInode else {
            throw RelayTerminalCLIResources.Failure.workspace
        }
        // SBPL's path rule cannot distinguish two pre-existing hard links to
        // the same inode. Inspect metadata only, bounded to existing Claude
        // configuration locations. Never follow a link or read file contents.
        var remaining = 16_384
        func directory(_ path: String, absent: Bool = false) throws -> Bool {
            remaining -= 1
            guard remaining >= 0 else { throw RelayTerminalCLIResources.Failure.workspace }
            var info = stat()
            if lstat(path, &info) != 0 {
                if absent && errno == ENOENT { return false }
                throw RelayTerminalCLIResources.Failure.workspace
            }
            if absent, try RelayTerminalCLIResources.physical(path) != path {
                throw RelayTerminalCLIResources.Failure.workspace
            }
            if info.st_mode & S_IFMT == S_IFDIR { return true }
            guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else {
                throw RelayTerminalCLIResources.Failure.workspace
            }
            return false
        }
        for path in protectedConfiguration {
            guard try directory(path, absent: true) else { continue }
            var failed = false
            guard let entries = FileManager.default.enumerator(at: URL(fileURLWithPath: path),
                includingPropertiesForKeys: [], options: [], errorHandler: { _, _ in failed = true; return false }) else {
                throw RelayTerminalCLIResources.Failure.workspace
            }
            for case let entry as URL in entries {
                guard entries.level <= 32 else { throw RelayTerminalCLIResources.Failure.workspace }
                _ = try directory(entry.path)
            }
            guard !failed else { throw RelayTerminalCLIResources.Failure.workspace }
        }
    }

    func prepare(proxyURL: String, caPEM: String, application: String, node: String,
                 inherited: [String: String]) throws -> (profile: String, environment: [String: String]) {
        guard proxyURL.range(of: "^https://relay:[0-9a-f]{64}@127\\.0\\.0\\.1:[0-9]{1,5}$", options: .regularExpression) != nil,
              let port = URLComponents(string: proxyURL)?.port, (1024...65535).contains(port),
              caPEM.utf8.count <= 8192, caPEM.hasPrefix("-----BEGIN CERTIFICATE-----\n"),
              caPEM.trimmingCharacters(in: .newlines).hasSuffix("-----END CERTIFICATE-----"),
              !caPEM.utf8.contains(0) else { throw RelayTerminalCLIResources.Failure.resources }
        let ca = support + "/proxy-ca.pem"
        try store("proxy-ca.pem", contents: caPEM)
        try store(".curlrc", contents: "proxy-cacert = " + (try quote(ca)) + "\n")

        let protected = [application] + protectedConfiguration
        let writeRoots = try [work, temporary, config].map { "(subpath \(try quote($0)))" }.joined(separator: " ")
        let deny = try protected.map { "(subpath \(try quote($0)))" }.joined(separator: " ")
        let anchors = try [work, root, temporary, config].map { "(literal \(try quote($0)))" }.joined(separator: " ")
        // Terminal I/O rules are adapted from SRT 27fce0d macos-sandbox-utils.
        // Exact existing TTY only. No permission to create another PTY or
        // connect to Unix/Mach delegates, listen, send UDP or resolve DNS.
        let terminal = "(literal \(try quote(tty))) (literal \"/dev/tty\") (literal \"/dev/null\")"
        let profile = [
            "(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)",
            "(allow process-info* (target same-sandbox))", "(allow signal (target same-sandbox))",
            "(allow file-read*)", "(allow sysctl-read)",
            "(allow file-write* \(writeRoots))",
            "(allow file-ioctl file-write-data \(terminal))",
            "(deny file-write* \(deny) \(anchors))",
            #"(deny file-write* (regex #"/[.]claude(/|$)") (regex #"/[.]claude[.]json$") (regex #"/[.]mcp[.]json$"))"#,
            "(deny file-link)",
            "(deny process-exec (literal \"/usr/bin/sudo\") (literal \"/usr/bin/su\"))",
            "(allow network-outbound (remote tcp4 \"localhost:\(port)\"))"
        ].joined(separator: "\n")

        let passThrough: Set<String> = ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE",
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
        var environment = inherited.filter { passThrough.contains($0.key) && $0.value.utf8.count <= 8192 }
        environment.merge([
            "HOME": home, "CLAUDE_CONFIG_DIR": config, "TMPDIR": temporary,
            "PATH": URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin",
            "TERM_PROGRAM": "Apple_Terminal",
            "HTTP_PROXY": proxyURL, "HTTPS_PROXY": proxyURL, "ALL_PROXY": proxyURL,
            "http_proxy": proxyURL, "https_proxy": proxyURL, "all_proxy": proxyURL,
            "NO_PROXY": "", "no_proxy": "",
            "NODE_EXTRA_CA_CERTS": ca, "NODE_OPTIONS": "--use-env-proxy",
            "CURL_HOME": support, "GIT_CONFIG_COUNT": "2",
            "GIT_CONFIG_KEY_0": "http.proxy", "GIT_CONFIG_VALUE_0": proxyURL,
            "GIT_CONFIG_KEY_1": "http.proxySSLCAInfo", "GIT_CONFIG_VALUE_1": ca, "GIT_PROXY_SSL_CAINFO": ca
        ]) { _, fixed in fixed }
        return (profile, environment)
    }

    private func quote(_ value: String) throws -> String {
        guard value.hasPrefix("/"), value.utf8.count < 4096,
              value.utf8.allSatisfy({ $0 >= 32 && $0 != 127 }) else {
            throw RelayTerminalCLIResources.Failure.workspace
        }
        return "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    private func store(_ path: String, contents: String) throws {
        let fd = openat(supportDirectory, path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW_ANY, 0o400)
        guard fd >= 3 else { throw RelayTerminalCLIResources.Failure.workspace }
        defer { close(fd) }
        let bytes = Array(contents.utf8)
        try bytes.withUnsafeBytes { buffer in
            var sent = 0
            while sent < bytes.count {
                let count = write(fd, buffer.baseAddress?.advanced(by: sent), bytes.count - sent)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw RelayTerminalCLIResources.Failure.workspace }
                sent += count
            }
        }
    }
}
