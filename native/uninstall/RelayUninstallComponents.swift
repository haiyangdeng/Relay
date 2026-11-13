import Foundation
import Darwin

// Direct adaptation of build-tun-managed-candidate.py's pinned v1/v2 remover.
// Keep the installed lifetime flock, exact file inventory and admission-first
// ordering; implement in the shipped binary so removal needs no Python/CLT.
enum RelayRemovalComponents {
    static let tun = "/Library/Application Support/Relay/TunManaged"
    static let proxy = "/Library/Application Support/Relay/SystemProxy"
    static func acquireManagedLease() throws -> Int32 {
        if !RelayRemoval.present(tun) { return -1 }
        if !RelayRemoval.present(tun + "/busy.lock"), RelayRemoval.present(RelayRemoval.root + "/managed-plan.json") { return -1 }
        guard try RelayRemoval.file(tun + "/busy.lock") == Data("Relay core-managed TUN v1\n".utf8) else { throw RelayRemoval.fail("Invalid managed lifetime lock") }
        let fd = open(tun + "/busy.lock", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw RelayRemoval.fail("Managed lifetime lock unavailable") }
        var held = stat(), linked = stat()
        guard flock(fd, LOCK_EX | LOCK_NB) == 0, fstat(fd, &held) == 0, lstat(tun + "/busy.lock", &linked) == 0,
              RelayRemoval.same(held, linked) else { close(fd); throw RelayRemoval.fail("Relay managed core has not stopped") }
        return fd
    }
    static func managed(_ installation: RelayRemovalInstallation, heldLease: Int32) throws {
        let checkpoint = RelayRemoval.root + "/managed-plan.json"
        if !RelayRemoval.present(tun) { return }
        try RelayRemoval.directory(tun)
        let recovering = RelayRemoval.present(checkpoint)
        let m: [String: Any]
        let manifestData: Data
        if recovering {
            let plan = try RelayRemoval.json(checkpoint)
            guard plan["generation"] as? String == installation.generation,
                  let bytes = plan["manifest"] as? String, let data = Data(base64Encoded: bytes),
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw RelayRemoval.fail("Invalid managed removal checkpoint") }
            m = value; manifestData = data
        } else {
            manifestData = try RelayRemoval.file(tun + "/installation.json")
            guard let value = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any] else { throw RelayRemoval.fail("Invalid managed installation") }; m = value
        }
        guard (m["version"] as? Int == 1 && m["role"] as? String == "core-managed-v1") ||
              (m["version"] as? Int == 2 && m["role"] as? String == "core-managed-v2"),
              m["clientUID"] as? UInt32 == installation.uid,
              let client = m["client"] as? [String: Any], let clientHash = client["sha256"] as? String,
              let cores = m["cores"] as? [String: [String: Any]], let arm = cores["arm64"]?["sha256"] as? String,
              let intel = cores["x86_64"]?["sha256"] as? String, let remover = m["uninstallerSHA256"] as? String else { throw RelayRemoval.fail("Managed installation identity mismatch") }
        let lockData = Data("Relay core-managed TUN v1\n".utf8)
        let expected: [String: (String, mode_t)] = [
            "installation.json": (RelayRemoval.hash(manifestData), 0o644),
            "RelayTunClient": (clientHash, 0o755), "Core/darwin-arm64/mihomo": (arm, 0o4755),
            "Core/darwin-x64/mihomo": (intel, 0o4755), "uninstall.py": (remover, 0o755),
            "busy.lock": (RelayRemoval.hash(lockData), 0o644)
        ]
        let dirs = ["Core/darwin-arm64", "Core/darwin-x64", "Core"]
        var found = Set<String>()
        func walk(_ relative: String) throws {
            let path = relative.isEmpty ? tun : tun + "/" + relative
            try RelayRemoval.directory(path)
            for name in try FileManager.default.contentsOfDirectory(atPath: path) {
                let child = relative.isEmpty ? name : relative + "/" + name
                guard expected[child] != nil || dirs.contains(child) else { throw RelayRemoval.fail("Unknown managed component retained") }
                found.insert(child)
                if dirs.contains(child) { try walk(child) }
            }
        }
        try walk("")
        if !recovering && found != Set(expected.keys).union(dirs) { throw RelayRemoval.fail("Incomplete managed installation") }
        for (name, pin) in expected where found.contains(name) {
            guard RelayRemoval.hash(try RelayRemoval.file(tun + "/" + name, mode: pin.1)) == pin.0 else { throw RelayRemoval.fail("Changed managed component retained") }
        }
        if found.contains("busy.lock") {
            var held = stat(), linked = stat()
            guard heldLease >= 0, fstat(heldLease, &held) == 0, lstat(tun + "/busy.lock", &linked) == 0,
                  RelayRemoval.same(held, linked) else { throw RelayRemoval.fail("Managed lifetime lock changed") }
        } else if !recovering || found.contains("installation.json") || found.contains("RelayTunClient") || found.contains("Core/darwin-arm64/mihomo") || found.contains("Core/darwin-x64/mihomo") {
            throw RelayRemoval.fail("Managed lifetime proof missing")
        }
        if !recovering { try RelayRemoval.save(["generation": installation.generation, "manifest": manifestData.base64EncodedString()], "managed-plan.json") }
        // Holding the lifetime lock proves both managed child and launcher are gone.
        for name in ["installation.json", "RelayTunClient", "Core/darwin-arm64/mihomo", "Core/darwin-x64/mihomo", "uninstall.py", "busy.lock"] {
            let pin = expected[name]!
            try RelayRemoval.remove(tun + "/" + name, mode: pin.1, digest: pin.0)
        }
        for name in dirs where RelayRemoval.present(tun + "/" + name) {
            try RelayRemoval.directory(tun + "/" + name)
            guard rmdir(tun + "/" + name) == 0 else { throw RelayRemoval.fail("Managed directory is not empty") }
        }
        guard rmdir(tun) == 0 else { throw RelayRemoval.fail("Managed directory removal failed") }
    }
    static func systemProxy(_ installation: RelayRemovalInstallation) throws {
        if !RelayRemoval.present(proxy) {
            guard !RelayRemoval.present("/Library/PrivilegedHelperTools/local.relay.network.system-proxy"),
                  !RelayRemoval.present("/Library/LaunchDaemons/local.relay.network.system-proxy.plist") else { throw RelayRemoval.fail("Incomplete proxy installation retained") }
            return
        }
        let pending = proxy + "/installation.pending.json"
        let path = RelayRemoval.present(pending) ? pending : proxy + "/installation.json"
        let data = try RelayRemoval.file(path, mode: path == pending ? 0o600 : 0o644)
        guard let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              manifest["version"] as? Int == 1, manifest["role"] as? String == "system-proxy-v1",
              manifest["clientUID"] as? UInt32 == installation.uid, let pin = manifest["uninstallerSHA256"] as? String,
              RelayRemoval.hash(try RelayRemoval.file(proxy + "/uninstall", mode: 0o755)) == pin else { throw RelayRemoval.fail("Proxy uninstaller identity mismatch") }
        _ = try RelayRemoval.requireRun(proxy + "/uninstall", [], timeout: 90)
        guard !RelayRemoval.present(proxy) else { throw RelayRemoval.fail("Proxy component remains") }
    }
    static func loginItem(_ installation: RelayRemovalInstallation) throws {
        let target = "gui/\(installation.uid)/local.relay.network.login"
        let found = try RelayRemoval.run("/bin/launchctl", ["print", target])
        if found.0 == 0 {
            _ = try RelayRemoval.requireRun("/bin/launchctl", ["bootout", target])
            guard try RelayRemoval.run("/bin/launchctl", ["print", target]).0 == 113 else { throw RelayRemoval.fail("Relay login job remains") }
        } else if found.0 != 113 { throw RelayRemoval.fail("Login job inventory unavailable") }
    }
    static func forgetReceipts() throws {
        let bytes = try RelayRemoval.requireRun("/usr/sbin/pkgutil", ["--pkgs"])
        let inventory = Set(String(decoding: bytes, as: UTF8.self).split(separator: "\n").map(String.init))
        for receipt in RelayRemoval.receipts where inventory.contains(receipt) {
            _ = try RelayRemoval.requireRun("/usr/sbin/pkgutil", ["--forget", receipt])
        }
        let remaining = Set(String(decoding: try RelayRemoval.requireRun("/usr/sbin/pkgutil", ["--pkgs"]), as: UTF8.self).split(separator: "\n").map(String.init))
        guard remaining.isDisjoint(with: RelayRemoval.receipts) else { throw RelayRemoval.fail("Relay package receipt remains") }
    }
}
