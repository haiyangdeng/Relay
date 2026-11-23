import Foundation
import Darwin

@main
struct RelayUninstallSupervisor {
    static func main() {
        do {
            if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] { try RelayUninstallTests.run(); return }
            if Array(CommandLine.arguments.dropFirst()) == ["--user-stop-browser"] {
                guard getuid() >= 501, getuid() == geteuid(), getgid() == getegid(), CommandLine.arguments[0] == RelayRemoval.executable else { throw RelayRemoval.fail("Browser cleanup requires the bound ordinary user") }
                let installation = try RelayRemovalInstallation()
                let intent = try RelayRemoval.json(RelayRemoval.root + "/intent.json")
                guard installation.uid == getuid(), intent["generation"] as? String == installation.generation,
                      intent["clientUID"] as? UInt32 == installation.uid, intent["phase"] as? String == "requested",
                      !RelayRemoval.present(RelayRemoval.app) else { throw RelayRemoval.fail("Browser cleanup intent mismatch") }
                try RelayUninstallPrivateBrowser.run(installation)
                return
            }
            if Array(CommandLine.arguments.dropFirst()) == ["--verify-installed-identity"] {
                try verifyInstalledIdentity(); return
            }
            guard getuid() == 0, geteuid() == 0, CommandLine.arguments[0] == RelayRemoval.executable else { throw RelayRemoval.fail("Only the installed administrator entry is accepted") }
            let args = Array(CommandLine.arguments.dropFirst())
            if args.count == 5, args[0] == "--register", args[1] == "--uid", args[3] == "--home", let uid = UInt32(args[2]) {
                try register(uid: uid, home: args[4]); return
            }
            let installation = try RelayRemovalInstallation()
            if args == ["--verify-ready"] {
                let ready = try RelayRemoval.json(RelayRemoval.root + "/ready.json")
                guard ready["generation"] as? String == installation.generation, let pid = ready["pid"] as? Int32,
                      pid > 1, kill(pid, 0) == 0, processPath(pid) == RelayRemoval.executable else { throw RelayRemoval.fail("Uninstall monitor has not acquired the App") }
                return
            }
            guard args.isEmpty else { throw RelayRemoval.fail("Unsupported supervisor arguments") }
            try RelayRemovalMonitor(installation).start()
            dispatchMain()
        } catch { fputs("Relay automatic removal: \(error.localizedDescription)\n", stderr); exit(1) }
    }
    // Installer invokes its own packaged verifier before installing any files.
    // This entry has no input path, creates no state and cannot start cleanup.
    static func verifyInstalledIdentity() throws {
        let app = RelayRemoval.app
        let error = RelayRemoval.fail("The current App does not match its installation")
        guard !RelayRemoval.present(RelayRemoval.root + "/intent.json"),
              !RelayRemoval.present(RelayRemoval.root + "/finalization.json") else { throw error }
        let installation = try RelayRemovalInstallation()
        try RelayRemoval.directory(app)
        guard let before = RelayRemoval.info(app), installation.matches(before),
              let digest = installation.record["appExecutableSHA256"] as? String,
              RelayRemoval.hash(try Data(contentsOf: URL(fileURLWithPath: app + "/Contents/MacOS/Relay"))) == digest,
              let daemon = installation.record["daemonSHA256"] as? String,
              RelayRemoval.hash(try RelayRemoval.file(RelayRemoval.daemon)) == daemon else { throw error }
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: app + "/Contents/Info.plist")), format: nil) as? [String: Any]
        guard plist?["CFBundleIdentifier"] as? String == "local.relay.network.preview",
              plist?["CFBundleExecutable"] as? String == "Relay" else { throw error }
        _ = try RelayRemoval.requireRun("/usr/bin/codesign", ["--verify", "--all-architectures", "--deep", "--strict", app])
        guard let after = RelayRemoval.info(app), installation.matches(after),
              NSDictionary(dictionary: try RelayRemoval.json(RelayRemoval.root + "/installation.json")).isEqual(to: installation.record),
              !RelayRemoval.present(RelayRemoval.root + "/intent.json"),
              !RelayRemoval.present(RelayRemoval.root + "/finalization.json") else { throw error }
    }
    static func processPath(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }; return String(cString: buffer)
    }
    static func register(uid: UInt32, home: String) throws {
        guard uid >= 501, let user = getpwuid(uid), let userHome = user.pointee.pw_dir,
              home == String(cString: userHome), let h = RelayRemoval.info(home), h.st_uid == uid,
              h.st_mode & S_IFMT == S_IFDIR, h.st_mode & 0o6002 == 0 else { throw RelayRemoval.fail("Cannot bind the desktop user") }
        try RelayRemoval.directory(RelayRemoval.root)
        guard !RelayRemoval.present(RelayRemoval.root + "/installation.json"),
              !RelayRemoval.present(RelayRemoval.root + "/intent.json"),
              let app = RelayRemoval.info(RelayRemoval.app), app.st_mode & S_IFMT == S_IFDIR,
              app.st_uid == 0, app.st_mode & 0o6022 == 0 else { throw RelayRemoval.fail("Cannot bind the installed App") }
        let plist = RelayRemoval.app + "/Contents/Info.plist"
        guard let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: plist)), format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == "local.relay.network.preview", info["CFBundleExecutable"] as? String == "Relay" else { throw RelayRemoval.fail("Unexpected application identity") }
        _ = try RelayRemoval.requireRun("/usr/bin/codesign", ["--verify", "--deep", "--strict", RelayRemoval.app])
        let bookmark = try RelayRemovalAppIdentity.bookmark(URL(fileURLWithPath: RelayRemoval.app))
        let bound = try RelayRemovalAppIdentity(bookmark: bookmark, registeredInode: UInt64(app.st_ino))
        guard bound.matches(app), let linked = RelayRemoval.info(RelayRemoval.app), bound.matches(linked) else { throw RelayRemoval.fail("Installed App changed during registration") }
        try RelayRemoval.save([
            "version": 1, "generation": UUID().uuidString, "clientUID": uid, "home": home,
            "appPath": RelayRemoval.app, "appDevice": UInt64(app.st_dev), "appInode": UInt64(app.st_ino),
            "appBookmark": bookmark.base64EncodedString(),
            "appExecutableSHA256": RelayRemoval.hash(try Data(contentsOf: URL(fileURLWithPath: RelayRemoval.app + "/Contents/MacOS/Relay"))),
            "nativeSHA256": RelayRemoval.hash(try RelayRemoval.file(RelayRemoval.native, mode: 0o755)),
            "supervisorSHA256": RelayRemoval.hash(try RelayRemoval.file(RelayRemoval.executable, mode: 0o755)),
            "daemonSHA256": RelayRemoval.hash(try RelayRemoval.file(RelayRemoval.daemon))
        ], "installation.json")
    }
}

final class RelayRemovalMonitor {
    private let installation: RelayRemovalInstallation
    private let queue = DispatchQueue(label: "local.relay.network.uninstall")
    private var fd: Int32 = -1
    private var vnode: DispatchSourceFileSystemObject?
    private var timer: DispatchSourceTimer?
    private var descriptorDeleted = false
    private var firstFact: Date?
    private var lastFailure = ""
    init(_ installation: RelayRemovalInstallation) { self.installation = installation }
    func start() throws {
        if RelayRemoval.present(RelayRemoval.root + "/finalization.json") {
            // Terminal checkpoint is self-contained after user Native is removed.
        } else if RelayRemoval.present(RelayRemoval.root + "/intent.json") {
            // The root-owned durable intent proves deletion even if Trash was emptied.
            _ = try phase()
        } else {
            guard let identity = installation.identity else { throw RelayRemoval.fail("Cannot acquire the registered App; no deletion inferred") }
            fd = fcntl(identity.descriptor, F_DUPFD_CLOEXEC, 0)
            guard fd >= 0 else { throw RelayRemoval.fail("Cannot observe the registered App") }
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.rename, .delete, .revoke], queue: queue)
            source.setEventHandler { [self] in
                if vnode?.data.contains(.delete) == true { descriptorDeleted = true }
                tick()
            }
            vnode = source; source.resume()
        }
        if !RelayRemoval.present(RelayRemoval.root + "/finalization.json") {
            try RelayRemoval.save(["generation": installation.generation, "pid": getpid()], "ready.json")
        }
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now(), repeating: 2, leeway: .milliseconds(200))
        source.setEventHandler { [self] in tick() }; source.resume(); timer = source
    }
    private func phase() throws -> String {
        let intent = try RelayRemoval.json(RelayRemoval.root + "/intent.json")
        guard intent["version"] as? Int == 1, intent["generation"] as? String == installation.generation,
              intent["clientUID"] as? UInt32 == installation.uid, let phase = intent["phase"] as? String,
              ["requested", "user-cleaned", "components-cleaned"].contains(phase) else { throw RelayRemoval.fail("Invalid durable removal intent") }; return phase
    }
    private func mark(_ phase: String, legacyPending: Bool = false) throws {
        var value: [String: Any] = ["version": 1, "generation": installation.generation, "clientUID": installation.uid, "phase": phase]
        if RelayRemoval.present(RelayRemoval.root + "/intent.json") {
            value["observedAppPath"] = try RelayRemoval.json(RelayRemoval.root + "/intent.json")["observedAppPath"]
        } else if fd >= 0 { value["observedAppPath"] = RelayRemoval.trackedPath(fd) }
        if legacyPending { value["legacyLoginPending"] = true }
        try RelayRemoval.save(value, "intent.json")
    }
    private func tick() {
        do {
            if RelayRemoval.present(RelayRemoval.root + "/finalization.json") {
                guard !RelayRemoval.present(RelayRemoval.app) else { return }
                try finish(); return
            }
            if !RelayRemoval.present(RelayRemoval.root + "/intent.json") {
                var s = stat()
                guard fd >= 0 else { throw RelayRemoval.fail("App descriptor unavailable") }
                let result = fstat(fd, &s)
                // APFS can return ENOENT after rmdir even for the open directory.
                // Only the kernel DELETE event on our still-held verified vnode
                // makes that an actual deletion, never a failed pathname lookup.
                let deleted = result != 0 && errno == ENOENT && descriptorDeleted
                guard deleted || (result == 0 && installation.matches(s)) else { throw RelayRemoval.fail("App identity unavailable; retaining cleanup state") }
                let occupied = RelayRemoval.present(RelayRemoval.app)
                let fact = RelayRemoval.removalFact(currentPath: RelayRemoval.trackedPath(fd), links: deleted ? 1 : s.st_nlink, descriptorDeleted: deleted, originalOccupied: occupied, home: installation.home, uid: installation.uid)
                guard fact else { firstFact = nil; return }
                if firstFact == nil { firstFact = Date(); return }
                guard Date().timeIntervalSince(firstFact!) >= 1 else { return }
                try mark("requested")
            }
            try cleanup()
            lastFailure = ""
        } catch {
            let message = error.localizedDescription
            if message != lastFailure { fputs("Relay automatic removal retry: \(message)\n", stderr); lastFailure = message }
        }
    }
    private func appRunning() throws -> Bool {
        // Match only this installation's Main and Electron helpers. No signals,
        // substring kill, or stale on-disk PID is used for lifecycle control.
        let output = try RelayRemoval.requireRun("/bin/ps", ["-axo", "uid=,comm="])
        let intent = try RelayRemoval.json(RelayRemoval.root + "/intent.json")
        let observed = intent["observedAppPath"] as? String
        let moved = fd >= 0 ? RelayRemoval.trackedPath(fd) : nil
        let roots = [RelayRemoval.app, observed, moved].compactMap { $0 }
        for line in String(decoding: output, as: UTF8.self).split(separator: "\n") {
            let fields = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" })
            guard fields.count == 2, UInt32(fields[0]) == installation.uid else { continue }
            let path = String(fields[1]).trimmingCharacters(in: .whitespaces)
            guard path.hasSuffix("/Contents/MacOS/Relay") || path.contains("/Contents/Frameworks/Relay Helper"),
                  let boundary = path.range(of: "/Contents/") else { continue }
            let bundle = String(path[..<boundary.lowerBound])
            if roots.contains(bundle) || RelayRemoval.info(bundle).map(installation.matches) == true { return true }
        }
        return false
    }
    private var preparedLoginItem = false
    private var retryLegacyAfter: Date?
    private func prepareLegacyLoginItem() throws {
        if preparedLoginItem { return }
        let intent = try RelayRemoval.json(RelayRemoval.root + "/intent.json")
        let candidate = fd >= 0 ? RelayRemoval.trackedPath(fd) : intent["observedAppPath"] as? String
        if let inventory = try? RelayRemoval.run("/usr/bin/sfltool", ["dumpbtm"], timeout: 15,
                maximumOutputBytes: 16 * 1024 * 1024, requireCompleteOutput: true),
           inventory.0 == 0, RelayUninstallRegistration.legacyLoginAbsent(inventory.1, uid: installation.uid, movedPath: candidate ?? RelayRemoval.app) {
            preparedLoginItem = true
            return
        }
        guard let path = candidate, RelayRemoval.info(path).map(installation.matches) == true else {
            // Fresh installs do not create a mainApp login item. A surviving
            // old registration can only be unregistered by that signed App;
            // immediately emptied old bundles cannot be re-executed.
            guard intent["legacyLoginPending"] as? Bool != true else {
                throw RelayRemoval.fail("Pending legacy registration could not be verified after moving the signed App")
            }
            preparedLoginItem = true; return
        }
        let executable = path + "/Contents/MacOS/Relay"
        guard let pin = installation.record["appExecutableSHA256"] as? String,
              RelayRemoval.hash(try Data(contentsOf: URL(fileURLWithPath: executable))) == pin else { throw RelayRemoval.fail("Moved App executable changed") }
        _ = try RelayRemoval.requireRun("/bin/launchctl", ["asuser", String(installation.uid), "/usr/bin/sudo", "-n", "-H", "-u", "#\(installation.uid)",
            executable, "--relay-uninstall-prepare"], timeout: 30)
        preparedLoginItem = true
    }
    private func cleanup() throws {
        let current = try phase()
        // An installed replacement must never have its configuration deleted.
        if RelayRemoval.present(RelayRemoval.app) { throw RelayRemoval.fail("An App is present at the installation path") }
        if current == "requested", let retry = retryLegacyAfter, Date() < retry { return }
        if current == "requested", try appRunning() { return } // Main drains its owned children.
        let managedLease = try RelayRemovalComponents.acquireManagedLease()
        defer { if managedLease >= 0 { close(managedLease) } }
        let retireNetwork = {
            try RelayRemovalComponents.loginItem(self.installation)
            try RelayRemovalComponents.managed(self.installation, heldLease: managedLease)
            try RelayRemovalComponents.systemProxy(self.installation)
        }
        try RelayRemovalLifecycle.run(phase: current, prepareLegacyLogin: prepareLegacyLoginItem, retireNetworkOnLoginFailure: {
            try retireNetwork()
            try mark("requested", legacyPending: true)
            retryLegacyAfter = Date().addingTimeInterval(60)
        }, restoreUser: {
            _ = try RelayRemoval.requireRun("/bin/launchctl", ["asuser", String(installation.uid), "/usr/bin/sudo", "-n", "-H", "-u", "#\(installation.uid)", RelayRemoval.executable, "--user-stop-browser"], timeout: 45)
            guard let user = getpwuid(installation.uid), let namePointer = user.pointee.pw_name else { throw RelayRemoval.fail("Bound user unavailable") }
            let name = String(cString: namePointer)
            let output = try RelayRemoval.requireRun("/bin/launchctl", ["asuser", String(installation.uid), "/usr/bin/sudo", "-n", "-H", "-u", "#\(installation.uid)", "/usr/bin/env", "-i",
                "HOME=\(installation.home)", "USER=\(name)", "LOGNAME=\(name)", "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
                RelayRemoval.native, "--automatic-uninstall-user"], timeout: 180)
            guard let report = try JSONSerialization.jsonObject(with: output) as? [String: Any], report["version"] as? Int == 1,
                  report["status"] as? String == "cleaned" else { throw RelayRemoval.fail("User integration restoration is not complete") }
        }, removeRegistrations: {
            try RelayUninstallRegistration.run(installation)
        }, removeComponents: {
            try retireNetwork()
            try RelayRemovalComponents.forgetReceipts()
        }, checkpoint: { try mark($0) }, finish: {
            try RelayRemoval.save(installation.record, "finalization.json")
            try finish()
        })
    }
    private func finish() throws {
        let allowed: Set<String> = ["RelayUninstallSupervisor", "RelayNative", "installation.json", "intent.json", "ready.json", "managed-plan.json", "finalization.json"]
        let names = try FileManager.default.contentsOfDirectory(atPath: RelayRemoval.root)
        guard Set(names).isSubset(of: allowed) else { throw RelayRemoval.fail("Unexpected lifecycle files retained") }
        for name in names { _ = try RelayRemoval.file(RelayRemoval.root + "/" + name, mode: name == "RelayNative" || name == "RelayUninstallSupervisor" ? 0o755 : 0o644) }
        guard let daemonHash = installation.record["daemonSHA256"] as? String,
              try (!RelayRemoval.present(RelayRemoval.daemon) || RelayRemoval.hash(RelayRemoval.file(RelayRemoval.daemon)) == daemonHash) else { throw RelayRemoval.fail("Lifecycle service identity changed") }
        for name in ["ready.json", "managed-plan.json", "intent.json", "installation.json", "RelayNative"] {
            try RelayRemoval.remove(RelayRemoval.root + "/" + name, mode: name.hasPrefix("Relay") ? 0o755 : 0o644)
        }
        try RelayRemoval.remove(RelayRemoval.daemon, digest: daemonHash)
        // All fallible component operations have completed. Keep the executable
        // and independent checkpoint until the final two unlinks, so any earlier
        // failure restarts through the terminal checkpoint rather than redoing
        // user restoration or depending on a deleted Native/manifest.
        try RelayRemoval.remove(RelayRemoval.executable, mode: 0o755, digest: installation.record["supervisorSHA256"] as? String)
        try RelayRemoval.remove(RelayRemoval.root + "/finalization.json")
        _ = rmdir(RelayRemoval.root)
        _ = rmdir("/Library/Application Support/Relay") // Only if empty; never remove another component.
        // Last action: launchd may terminate our entire process group at bootout.
        // All files and receipts are already gone; no child is expected to survive.
        let strings: [String] = ["/bin/launchctl", "bootout", "system/" + RelayRemoval.label]
        let args: [UnsafeMutablePointer<CChar>?] = strings.map { strdup($0) } + [nil]
        args.withUnsafeBufferPointer { _ = execv("/bin/launchctl", $0.baseAddress!) }
        throw RelayRemoval.fail("Cannot unregister lifecycle service")
    }
}
