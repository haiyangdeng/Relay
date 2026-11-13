#!/usr/bin/env python3
"""Compile the real remover against a disposable namespace; never install/run a service.

The copies replace only fixed paths, expected owner UID and the parent-walk
boundary. Production sources have no test environment variable or runtime flag.
The fixture rejects unrecognised transformation counts before compiling.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile


APP = Path(__file__).resolve().parents[2]


def replace_exact(source, old, new, count):
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f"Fixture source contract changed: {old!r}: expected {count}, got {actual}")
    return source.replace(old, new)


HARNESS = r'''
import Foundation
import Darwin

final class FixtureVnodeEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var events: DispatchSource.FileSystemEvent = []
    private let arrived = DispatchSemaphore(value: 0)
    func record(_ event: DispatchSource.FileSystemEvent) {
        lock.lock(); events.formUnion(event); lock.unlock(); arrived.signal()
    }
    func wait(for event: DispatchSource.FileSystemEvent) -> Bool {
        let deadline = DispatchTime.now() + .seconds(5)
        while true {
            lock.lock(); let found = events.contains(event); lock.unlock()
            if found { return true }
            if arrived.wait(timeout: deadline) == .timedOut { return false }
        }
    }
}

@main
struct Fixture {
    static let base = __FIXTURE_ROOT__
    static var checks = 0
    static let fm = FileManager.default
    static func check(_ condition: Bool, _ message: String) throws {
        guard condition else { throw RelayRemoval.fail("Fixture: " + message) }; checks += 1
    }
    static func refuses(_ message: String, _ work: () throws -> Void) throws {
        var rejected = false
        do { try work() } catch { rejected = true }
        try check(rejected, message)
    }
    static func directory(_ path: String) throws {
        try fm.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    }
    static func write(_ path: String, _ data: Data, _ mode: mode_t = 0o644) throws {
        try directory(URL(fileURLWithPath: path).deletingLastPathComponent().path)
        try data.write(to: URL(fileURLWithPath: path))
        guard chmod(path, mode) == 0 else { throw RelayRemoval.fail("Fixture chmod") }
    }
    static func text(_ path: String, _ text: String, _ mode: mode_t = 0o644) throws {
        try write(path, Data(text.utf8), mode)
    }
    static func object(_ path: String, _ value: [String: Any]) throws {
        try write(path, JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    }
    static func remove(_ path: String) throws { if fm.fileExists(atPath: path) { try fm.removeItem(atPath: path) } }
    static func installation() throws -> RelayRemovalInstallation {
        try directory(RelayRemoval.root)
        try directory(RelayRemoval.app)
        try text(RelayRemoval.executable, "fixture-supervisor", 0o755)
        try text(RelayRemoval.native, "fixture-native", 0o755)
        let current = RelayRemoval.info(RelayRemoval.app)!
        let record: [String: Any] = [
            "version": 1, "generation": UUID().uuidString, "clientUID": getuid(),
            "home": String(cString: getpwuid(getuid())!.pointee.pw_dir), "appPath": RelayRemoval.app,
            "appDevice": UInt64(current.st_dev), "appInode": UInt64(current.st_ino),
            "nativeSHA256": RelayRemoval.hash(try RelayRemoval.file(RelayRemoval.native, mode: 0o755)),
            "supervisorSHA256": RelayRemoval.hash(try RelayRemoval.file(RelayRemoval.executable, mode: 0o755))]
        try object(RelayRemoval.root + "/installation.json", record)
        return try RelayRemovalInstallation()
    }
    static func managed(_ installation: RelayRemovalInstallation, version: Int = 2, uid: UInt32? = nil) throws -> Data {
        try remove(RelayRemovalComponents.tun)
        try remove(RelayRemoval.root + "/managed-plan.json")
        let root = RelayRemovalComponents.tun
        let files: [(String, String, mode_t)] = [
            ("RelayTunClient", "fixture-client", 0o755), ("Core/darwin-arm64/mihomo", "fixture-arm", 0o4755),
            ("Core/darwin-x64/mihomo", "fixture-intel", 0o4755), ("uninstall.py", "fixture-remover", 0o755),
            ("busy.lock", "Relay core-managed TUN v1\n", 0o644)]
        for (name, contents, mode) in files { try text(root + "/" + name, contents, mode) }
        let record: [String: Any] = ["version": version, "role": "core-managed-v\(version)", "clientUID": uid ?? installation.uid,
            "client": ["sha256": RelayRemoval.hash(Data("fixture-client".utf8))],
            "cores": ["arm64": ["sha256": RelayRemoval.hash(Data("fixture-arm".utf8))],
                      "x86_64": ["sha256": RelayRemoval.hash(Data("fixture-intel".utf8))]],
            "uninstallerSHA256": RelayRemoval.hash(Data("fixture-remover".utf8))]
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        try write(root + "/installation.json", data)
        return data
    }
    static func withLease(_ work: (Int32) throws -> Void) throws {
        let lease = try RelayRemovalComponents.acquireManagedLease()
        defer { if lease >= 0 { close(lease) } }
        try work(lease)
    }
    static func checkpoint(_ installation: RelayRemovalInstallation, _ data: Data) throws {
        try RelayRemoval.save(["generation": installation.generation, "manifest": data.base64EncodedString()], "managed-plan.json")
    }
    static func vnodeEvents() throws {
        let beforePath = base + "/event-source/Relay.app"
        let movedPath = base + "/event-trash/Relay.app"
        try directory(beforePath)
        try directory(base + "/event-trash")
        let descriptor = open(beforePath, O_EVTONLY | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { throw RelayRemoval.fail("event fixture FD unavailable") }
        let events = FixtureVnodeEvents()
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor,
            eventMask: [.rename, .delete, .revoke], queue: DispatchQueue(label: "relay.fixture.vnode"))
        source.setEventHandler { events.record(source.data) }
        source.resume()
        defer { source.cancel(); close(descriptor) }
        var original = stat()
        try check(fstat(descriptor, &original) == 0, "held App identity acquired before monitoring")
        try fm.moveItem(atPath: beforePath, toPath: movedPath)
        try check(events.wait(for: .rename), "real DispatchSource delivers same-vnode rename")
        try check(RelayRemoval.trackedPath(descriptor) == movedPath, "held FD tracks location after rename event")
        var moved = stat()
        try check(fstat(descriptor, &moved) == 0 && original.st_dev == moved.st_dev && original.st_ino == moved.st_ino,
                  "rename event retains registered inode")
        try fm.removeItem(atPath: movedPath)
        try check(events.wait(for: .delete), "real DispatchSource delivers same-vnode deletion")
        var removed = stat()
        let status = fstat(descriptor, &removed)
        let failure = status == 0 ? 0 : errno
        try check((status == 0 && removed.st_nlink == 0) || (status == -1 && failure == ENOENT),
                  "APFS deleted directory permits fstat ENOENT, not only nlink zero")
        let report: [String: Any] = ["realVnodeEventsPassed": true, "renameObserved": true, "deleteObserved": true,
            "fstatAfterDelete": status, "fstatErrno": failure, "lastTrackedPath": RelayRemoval.trackedPath(descriptor) as Any? ?? NSNull()]
        print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
    }
    static func main() throws {
        guard getuid() != 0, geteuid() != 0, base.hasPrefix(NSTemporaryDirectory()) || base.hasPrefix("/private/var/folders/") else {
            throw RelayRemoval.fail("Fixtures must run unprivileged in temporary storage")
        }
        if CommandLine.arguments.dropFirst() == ["--fd-probe"] {
            let descriptor = open(base + "/fd-source/Relay.app", O_EVTONLY | O_NOFOLLOW | O_DIRECTORY)
            guard descriptor >= 0 else { throw RelayRemoval.fail("Restricted probe could not open source") }
            defer { close(descriptor) }
            FileHandle.standardOutput.write(Data("READY\n".utf8))
            guard readLine() == "moved" else { throw RelayRemoval.fail("Restricted probe handshake failed") }
            let tracked = RelayRemoval.trackedPath(descriptor)
            let lookupError = tracked == nil ? errno : 0
            var denied = false
            do { _ = try fm.contentsOfDirectory(atPath: base + "/restricted-trash") } catch { denied = true }
            let output: [String: Any] = ["trashEnumerationDenied": denied, "trackedPath": tracked ?? NSNull(), "lookupErrno": lookupError]
            print(String(decoding: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), as: UTF8.self))
            return
        }
        try vnodeEvents()
        let installed = try installation()
        let oldMask = umask(0o077)
        try RelayRemoval.save(["probe": "persisted"], "mask-probe.json")
        umask(oldMask)
        try check(RelayRemoval.info(RelayRemoval.root + "/mask-probe.json")!.st_mode & 0o777 == 0o644, "record publish fixes restrictive installer umask")
        try check(try RelayRemoval.json(RelayRemoval.root + "/mask-probe.json")["probe"] as? String == "persisted", "published record remains readable")
        let good = RelayRemoval.root + "/good"
        let alias = RelayRemoval.root + "/alias"
        try text(good, "known")
        try fm.createSymbolicLink(atPath: alias, withDestinationPath: good)
        try refuses("symlink file rejected") { _ = try RelayRemoval.file(alias) }
        try fm.removeItem(atPath: alias)
        guard link(good, alias) == 0 else { throw RelayRemoval.fail("fixture link") }
        try refuses("hard-linked file rejected") { _ = try RelayRemoval.file(good) }
        try fm.removeItem(atPath: alias)
        try directory(RelayRemoval.root + "/actual")
        try text(RelayRemoval.root + "/actual/record", "known")
        try fm.createSymbolicLink(atPath: alias, withDestinationPath: RelayRemoval.root + "/actual")
        try refuses("symlink parent rejected") { _ = try RelayRemoval.file(alias + "/record") }
        try fm.removeItem(atPath: alias)
        guard mkfifo(alias, 0o644) == 0 else { throw RelayRemoval.fail("fixture fifo") }
        try refuses("FIFO rejected without blocking") { _ = try RelayRemoval.file(alias) }
        try fm.removeItem(atPath: alias)
        let denied = RelayRemoval.root + "/denied"
        try text(denied + "/record", "owned")
        guard chmod(denied, 0) == 0 else { throw RelayRemoval.fail("fixture access restriction") }
        defer { _ = chmod(denied, 0o755) }
        try check(RelayRemoval.present(denied + "/record"), "permission denial must not mean file absent")
        try refuses("inaccessible file cannot be counted removed") { try RelayRemoval.remove(denied + "/record") }
        guard chmod(denied, 0o755) == 0 else { throw RelayRemoval.fail("fixture access restoration") }

        for version in [1, 2] {
            _ = try managed(installed, version: version)
            try withLease { try RelayRemovalComponents.managed(installed, heldLease: $0) }
            try check(!RelayRemoval.present(RelayRemovalComponents.tun), "managed v\(version) complete removal")
            try RelayRemovalComponents.managed(installed, heldLease: -1)
            try check(RelayRemoval.present(RelayRemoval.root + "/managed-plan.json"), "managed retry checkpoint retained until lifecycle finish")
        }
        _ = try managed(installed)
        let live = open(RelayRemovalComponents.tun + "/busy.lock", O_RDONLY)
        guard live >= 0, flock(live, LOCK_SH | LOCK_NB) == 0 else { throw RelayRemoval.fail("fixture lifetime lease") }
        try refuses("live managed core blocks removal admission") { _ = try RelayRemovalComponents.acquireManagedLease() }
        close(live)
        try check(RelayRemoval.present(RelayRemovalComponents.tun + "/installation.json"), "busy component is untouched")
        try text(RelayRemovalComponents.tun + "/unknown", "unowned")
        try withLease { lease in try refuses("unknown inventory preserves installation") { try RelayRemovalComponents.managed(installed, heldLease: lease) } }
        try check(RelayRemoval.present(RelayRemovalComponents.tun + "/installation.json"), "unknown-file failure occurs before manifest unlink")
        _ = try managed(installed)
        try text(RelayRemovalComponents.tun + "/Core/darwin-arm64/mihomo", "changed", 0o4755)
        try withLease { lease in try refuses("changed privileged core is never removed") { try RelayRemovalComponents.managed(installed, heldLease: lease) } }
        try check(!RelayRemoval.present(RelayRemoval.root + "/managed-plan.json"), "tampered inventory has no accepted removal checkpoint")
        _ = try managed(installed, uid: installed.uid + 1)
        try withLease { lease in try refuses("other-user managed installation rejected") { try RelayRemovalComponents.managed(installed, heldLease: lease) } }
        let original = try managed(installed)
        try checkpoint(installed, original)
        try remove(RelayRemovalComponents.tun + "/installation.json")
        try remove(RelayRemovalComponents.tun + "/RelayTunClient")
        try withLease { try RelayRemovalComponents.managed(installed, heldLease: $0) }
        try check(!RelayRemoval.present(RelayRemovalComponents.tun), "partial managed removal resumes from pinned checkpoint")
        let missingLock = try managed(installed)
        try checkpoint(installed, missingLock)
        try remove(RelayRemovalComponents.tun + "/busy.lock")
        try refuses("missing lifetime lock cannot admit live executables") { try RelayRemovalComponents.managed(installed, heldLease: -1) }
        try check(RelayRemoval.present(RelayRemovalComponents.tun + "/RelayTunClient"), "missing-lock rejection preserves launcher")
        try remove(RelayRemovalComponents.tun)

        let proxy = RelayRemovalComponents.proxy
        try directory(proxy)
        let script = "#!/bin/sh\n/bin/rm -f " + shell(proxy + "/installation.json") + " " + shell(proxy + "/uninstall") + "\n/bin/rmdir " + shell(proxy) + "\n"
        try text(proxy + "/uninstall", script, 0o755)
        try object(proxy + "/installation.json", ["version": 1, "role": "system-proxy-v1", "clientUID": installed.uid + 1, "uninstallerSHA256": RelayRemoval.hash(Data(script.utf8))])
        try refuses("other-user proxy remover is not invoked") { try RelayRemovalComponents.systemProxy(installed) }
        try check(RelayRemoval.present(proxy + "/uninstall"), "refused proxy is retained")
        try object(proxy + "/installation.json", ["version": 1, "role": "system-proxy-v1", "clientUID": installed.uid, "uninstallerSHA256": RelayRemoval.hash(Data(script.utf8))])
        try RelayRemovalComponents.systemProxy(installed)
        try check(!RelayRemoval.present(proxy), "pinned fixed-path proxy remover runs")
        let orphan = base + "/Library/PrivilegedHelperTools/local.relay.network.system-proxy"
        try text(orphan, "orphan", 0o755)
        try refuses("orphan proxy helper is not silently counted removed") { try RelayRemovalComponents.systemProxy(installed) }
        try remove(orphan)

        try text(base + "/login-job", "enabled")
        try RelayRemovalComponents.loginItem(installed)
        try check(!RelayRemoval.present(base + "/login-job"), "only bound login job booted out")
        try text(base + "/job-error", "error")
        try refuses("unknown launchctl status preserves cleanup") { try RelayRemovalComponents.loginItem(installed) }
        try remove(base + "/job-error")
        try text(base + "/receipts", (RelayRemoval.receipts + ["other.vendor.app"]).joined(separator: "\n") + "\n")
        try RelayRemovalComponents.forgetReceipts()
        try check(try String(contentsOfFile: base + "/receipts", encoding: .utf8) == "other.vendor.app\n", "only exact Relay receipts removed")

        let held = open(RelayRemoval.app, O_EVTONLY | O_NOFOLLOW | O_DIRECTORY)
        guard held >= 0 else { throw RelayRemoval.fail("fixture App descriptor") }; defer { close(held) }
        let trash = base + "/.Trash/Relay.app"
        try directory(base + "/.Trash")
        try fm.moveItem(atPath: RelayRemoval.app, toPath: trash)
        try directory(RelayRemoval.app)
        var previous = stat(); guard fstat(held, &previous) == 0 else { throw RelayRemoval.fail("fixture stat") }
        try check(!RelayRemoval.removalFact(currentPath: RelayRemoval.trackedPath(held), links: previous.st_nlink, originalOccupied: RelayRemoval.present(RelayRemoval.app), home: base, uid: getuid()), "replacement prevents old vnode Trash cleanup")
        try check(!installed.matches(RelayRemoval.info(RelayRemoval.app)!), "replacement has a different installation identity")
        try RelayRemoval.save(installed.record, "finalization.json")
        try remove(RelayRemoval.native)
        try remove(RelayRemoval.root + "/installation.json")
        let resumed = try RelayRemovalInstallation()
        try check(resumed.generation == installed.generation, "terminal checkpoint resumes after Native and installation record removal")
        try text(RelayRemoval.executable, "changed-supervisor", 0o755)
        try refuses("terminal checkpoint still pins the supervisor") { _ = try RelayRemovalInstallation() }
        print("{\"passed\":true,\"checks\":\(checks),\"realRootUsed\":false,\"realServicesChanged\":false,\"protectedTrashTested\":false}")
    }
    static func shell(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}
'''


def main():
    if os.getuid() == 0 or os.geteuid() == 0:
        raise RuntimeError("Run fixtures as an ordinary user")
    with tempfile.TemporaryDirectory(prefix="relay-root-uninstall-fixture-") as temporary:
        root = Path(temporary).resolve()
        quoted = json.dumps(str(root))[1:-1]
        support = (APP / "native/uninstall/RelayUninstallSupport.swift").read_text()
        support = replace_exact(support, '"/Library/', '"' + quoted + '/Library/', 2)
        support = replace_exact(support, '"/Applications/', '"' + quoted + '/Applications/', 1)
        support = replace_exact(support, 'st_uid == 0', 'st_uid == ' + str(os.getuid()), 2)
        support = replace_exact(support, 'if p == "/" { break }', 'if p == ' + json.dumps(str(root)) + ' { break }', 1)
        components = (APP / "native/uninstall/RelayUninstallComponents.swift").read_text()
        components = replace_exact(components, '"/Library/', '"' + quoted + '/Library/', 4)
        components = replace_exact(components, '"/bin/launchctl"', json.dumps(str(root / "launchctl")), 3)
        components = replace_exact(components, '"/usr/sbin/pkgutil"', json.dumps(str(root / "pkgutil")), 3)
        for name, content in (("Support.swift", support), ("Components.swift", components),
                              ("Fixture.swift", HARNESS.replace("__FIXTURE_ROOT__", json.dumps(str(root))))):
            (root / name).write_text(content)
        tools = {
            "launchctl": f'''#!/bin/sh
root={shlex.quote(str(root))}
[ ! -e "$root/job-error" ] || exit 1
case "$1" in
print) [ -e "$root/login-job" ] || exit 113;;
bootout) /bin/rm "$root/login-job";;
*) exit 97;; esac
''',
            "pkgutil": f'''#!/bin/sh
root={shlex.quote(str(root))}
case "$1" in
--pkgs) /bin/cat "$root/receipts";;
--forget) /usr/bin/awk -v target="$2" '$0 != target' "$root/receipts" > "$root/new-receipts"; /bin/mv "$root/new-receipts" "$root/receipts";;
*) exit 97;; esac
''',
        }
        for name, content in tools.items():
            (root / name).write_text(content)
            (root / name).chmod(0o755)
        binary = root / "fixture"
        subprocess.run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-swift-version", "5", "-warnings-as-errors",
                        str(root / "Support.swift"), str(root / "Components.swift"), str(root / "Fixture.swift"),
                        "-framework", "Foundation", "-framework", "CryptoKit", "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
        if Path("/usr/bin/sandbox-exec").exists():
            source = root / "fd-source/Relay.app"
            source.mkdir(parents=True)
            restricted = root / "restricted-trash"
            restricted.mkdir()
            profile = '(version 1) (allow default) (deny file-read* (subpath ' + json.dumps(str(restricted)) + '))'
            process = subprocess.Popen(["/usr/bin/sandbox-exec", "-p", profile, str(binary), "--fd-probe"],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if process.stdout.readline().strip() != "READY":
                stdout, stderr = process.communicate(timeout=10)
                raise RuntimeError("MAC sandbox FD probe failed before rename: " + stdout + stderr)
            source.rename(restricted / "Relay.app")
            stdout, stderr = process.communicate("moved\n", timeout=10)
            if process.returncode != 0:
                raise RuntimeError("MAC sandbox FD probe failed: " + stdout + stderr)
            report = json.loads(stdout)
            if report["trashEnumerationDenied"] is not True:
                raise RuntimeError("MAC sandbox fixture did not actually protect its fake Trash")
            if report["trackedPath"] != str(restricted / "Relay.app"):
                raise RuntimeError("Opened FD could not follow move into a MAC-denied directory: " + stdout)
            print(json.dumps({"sandboxFDProbePassed": True, **report, "protectedUserTrashTested": False}))


if __name__ == "__main__":
    main()
