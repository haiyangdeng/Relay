// Ordinary-UID private copies only. The pinned Core is read and its static
// signature is checked; this runner never executes it or changes networking.
import Foundation
import Darwin

@main private enum ProviderProbeWorkspaceTests {
    typealias P = RelayTunRuntimeRuleProviderProbe
    private enum Bad: Error { case assertion, fixture }
    static func main() {
        guard getuid() > 0, getuid() == geteuid(), getgid() == getegid(), CommandLine.arguments.count == 2 else { exit(77) }
        _ = umask(0o077)
        var rows = [[String: Any]]()
        func expect(_ value: @autoclosure () throws -> Bool) throws { guard try value() else { throw Bad.assertion } }
        func rejects(_ body: () throws -> Void) throws { do { try body() } catch { return }; throw Bad.assertion }
        func info(_ path: String) throws -> stat { var value = stat(); guard lstat(path, &value) == 0 else { throw Bad.fixture }; return value }
        func read(_ path: String) throws -> Data { try Data(contentsOf: URL(fileURLWithPath: path)) }
        let configuration = Data("{\"mode\":\"rule\",\"port\":0}".utf8)
        let asset = "relay-files/" + String(repeating: "a", count: 64) + ".yaml", body = Data("payload:\n - example.invalid\n".utf8)
        let projection = P.Projection(configuration: configuration, assets: [asset: body, "GeoSite.dat": Data([1, 2, 3])],
            configurationSHA256: P.Model.Shared.digest(configuration), sourceConfigurationSHA256: String(repeating: "b", count: 64),
            geoGenerationSHA256: String(repeating: "c", count: 64), coreSHA256: P.corePin.sha256, bodySHA256: P.Model.Shared.digest(body),
            bindings: [], declaredRuleCount: 1, expectedRuleCounts: [:], secret: "private-fixture-secret")
        var core = Data()
        do {
            core = try read(CommandLine.arguments[1])
            guard core.count == P.corePin.bytes, P.Model.Shared.digest(core) == P.corePin.sha256 else { throw Bad.fixture }
        } catch { print("{\"checks\":1,\"passed\":0,\"error\":\"pinned private Core fixture invalid\"}"); exit(1) }
        func test(_ name: String, badCore: Bool = false, _ body: (P.Workspace) throws -> Void) {
            var workspace: P.Workspace?, root: stat?, failure: Error?, cleanup: Error?
            do {
                let w = try RelayTunRuleProviderProbeWorkspace.testWorkspace(projection: projection, core: badCore ? Data([1]) : core)
                workspace = w; root = try info(w.directory); try body(w)
            } catch { failure = error }
            if let workspace, let root, FileManager.default.fileExists(atPath: workspace.directory) {
                do {
                    let current = try info(workspace.directory)
                    guard current.st_dev == root.st_dev, current.st_ino == root.st_ino, current.st_uid == getuid(), current.st_mode == mode_t(S_IFDIR) | 0o700 else { throw Bad.fixture }
                    // Synthetic failure fixtures are owned by this test. Never
                    // used by production cleanup or an unrecognized root.
                    try FileManager.default.removeItem(atPath: workspace.directory)
                } catch { cleanup = error }
            }
            var row: [String: Any] = ["name": name, "passed": failure == nil && cleanup == nil]
            if let failure { row["error"] = String(describing: failure) }; if let cleanup { row["cleanupError"] = String(describing: cleanup) }
            rows.append(row)
        }
        test("owned empty root capability can clean before prepare") { w in
            try expect(FileManager.default.contentsOfDirectory(atPath: w.directory).isEmpty)
            try rejects { try w.verify() }; try w.cleanup(); try w.cleanup()
            try expect(!FileManager.default.fileExists(atPath: w.directory))
        }
        test("wrong Core bytes fail before any file creation and empty cleanup succeeds", badCore: true) { w in
            try rejects { try w.prepare() }; try expect(FileManager.default.contentsOfDirectory(atPath: w.directory).isEmpty)
            try w.cleanup(); try expect(!FileManager.default.fileExists(atPath: w.directory))
        }
        test("exact signed Core copy and all complete projection assets are independently pinned") { w in
            try w.prepare(); try w.verify()
            try expect(read(w.directory + "/config.yaml") == configuration && read(w.directory + "/" + asset) == body)
            try expect(info(w.directory + "/mihomo-probe").st_mode == mode_t(S_IFREG) | 0o500 &&
                       info(w.directory + "/config.yaml").st_mode == mode_t(S_IFREG) | 0o600 &&
                       info(w.directory + "/relay-files").st_mode == mode_t(S_IFDIR) | 0o700)
            try expect(read(w.directory + "/mihomo-probe") == core)
            try rejects { try w.prepare() }; try w.cleanup(); try w.cleanup()
            try expect(!FileManager.default.fileExists(atPath: w.directory))
        }
        test("foreign file before prepare is never adopted or recursively removed") { w in
            try Data([7]).write(to: URL(fileURLWithPath: w.directory + "/foreign"), options: .withoutOverwriting)
            try rejects { try w.prepare() }; try rejects { try w.cleanup() }
            try expect(read(w.directory + "/foreign") == Data([7]))
        }
        test("foreign nested name blocks cleanup before any registered file unlink") { w in
            try w.prepare()
            try Data([7]).write(to: URL(fileURLWithPath: w.directory + "/relay-files/foreign"), options: .withoutOverwriting)
            try rejects { try w.verify() }; try rejects { try w.cleanup() }
            try expect(read(w.directory + "/config.yaml") == configuration && read(w.directory + "/" + asset) == body &&
                       FileManager.default.fileExists(atPath: w.directory + "/mihomo-probe"))
        }
        test("pre-spawn runtime name receives no ownership from its spelling") { w in
            try w.prepare()
            try Data([7]).write(to: URL(fileURLWithPath: w.directory + "/api.sock"), options: .withoutOverwriting)
            try rejects { try w.verify() }; try rejects { try w.cleanup() }
            try expect(FileManager.default.fileExists(atPath: w.directory + "/mihomo-probe"))
            guard unlink(w.directory + "/api.sock") == 0 else { throw Bad.fixture }
            try w.cleanup(); try expect(!FileManager.default.fileExists(atPath: w.directory))
        }
        test("pre-created empty cache is a pinned inode and replacement is never adopted") { w in
            try w.prepare()
            let path = w.directory + "/cache.db", original = try info(w.directory + "/cache.db")
            try expect(original.st_mode == mode_t(S_IFREG) | 0o600 && original.st_size == 0)
            guard unlink(path) == 0 else { throw Bad.fixture }
            try Data().write(to: URL(fileURLWithPath: path), options: .withoutOverwriting); chmod(path, 0o600)
            try expect(info(path).st_ino != original.st_ino)
            try rejects { try w.verify() }; try rejects { try w.cleanup() }
            try expect(FileManager.default.fileExists(atPath: w.directory + "/mihomo-probe") && FileManager.default.fileExists(atPath: path))
        }
        test("pre-spawn writes to the registered cache are not attributed to a child") { w in
            try w.prepare(); try Data([1]).write(to: URL(fileURLWithPath: w.directory + "/cache.db"))
            try rejects { try w.verify() }; try rejects { try w.cleanup() }
            try expect(read(w.directory + "/cache.db") == Data([1]) && FileManager.default.fileExists(atPath: w.directory + "/mihomo-probe"))
        }
        test("same-inode asset mutation blocks verify and all cleanup") { w in
            try w.prepare(); try Data([9, 9, 9]).write(to: URL(fileURLWithPath: w.directory + "/GeoSite.dat"))
            try rejects { try w.verify() }; try rejects { try w.cleanup() }
            try expect(FileManager.default.fileExists(atPath: w.directory + "/mihomo-probe") && read(w.directory + "/config.yaml") == configuration)
        }
        test("asset symlink replacement preserves target and rejects registry cleanup") { w in
            try w.prepare(); guard unlink(w.directory + "/" + asset) == 0,
                symlink("../config.yaml", w.directory + "/" + asset) == 0 else { throw Bad.fixture }
            try rejects { try w.verify() }; try rejects { try w.cleanup() }
            try expect(read(w.directory + "/config.yaml") == configuration && FileManager.default.fileExists(atPath: w.directory + "/mihomo-probe"))
        }
        let passed = rows.filter { $0["passed"] as? Bool == true }.count
        let report: [String: Any] = ["checks": rows.count, "passed": passed, "rows": rows,
            "coreStarted": false, "helperConnected": false, "actualNetworkConfigurationChanged": false]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) { print(String(decoding: data, as: UTF8.self)) }
        exit(passed == rows.count ? 0 : 1)
    }
}
