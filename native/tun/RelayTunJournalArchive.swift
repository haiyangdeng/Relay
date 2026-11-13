import Foundation
import CoreFoundation
import Darwin

/// Retires only an exact terminal plan. Complete append-only chains are moved,
/// never deleted or reused. An exclusive manifest makes partial two-directory
/// moves retryable without adopting an unknown directory or overwriting data.
enum RelayTunJournalArchive {
    typealias Plan = RelayTunNetworkTransaction.Plan
    private typealias Effects = RelayTunNetworkEffects
    enum Failure: Error { case permission, invalid, conflict, unsafe, uncertain }
    static let recoveryPath = "/Library/Application Support/RelayTunRecovery"
    private static let rootPath = "/Library/Application Support/Relay/Tun"
    private static func production() throws -> Store {
        guard getuid() == 0, geteuid() == 0, getgid() == 0, getegid() == 0 else { throw Failure.permission }
        return Store(root: rootPath, recovery: recoveryPath, owner: 0, group: 0, rootMode: 0o755)
    }
    struct Terminal {
        let plan: Plan
        let sessionID: String
        let clientUID: UInt32
        let revision: String
        let receipt: RelayTunAcquiredReceipt?
        let phase: String
        let evidenceSHA256: String
    }
    static func retire(plan: Plan, sessionID: String, evidenceSHA256: String, receipt: RelayTunAcquiredReceipt?, clientUID: UInt32, revision: String) throws {
        try production().retire(plan, sessionID: sessionID, evidenceSHA256: evidenceSHA256, receipt: receipt, clientUID: clientUID, revision: revision)
    }
    static func loadTerminal(sessionID: String, clientUID: UInt32, revision: String) throws -> Terminal? {
        try production().loadTerminal(sessionID: sessionID, clientUID: clientUID, revision: revision)
    }
    static func verifyPreserved() throws -> Bool { try production().verifyPreserved() }
    static func verifyLiveEmpty() throws { try production().verifyLiveEmpty(remove: false) }
    static func removeEmptyLiveRoots() throws { try production().verifyLiveEmpty(remove: true) }
    #if RELAY_TUN_JOURNAL_ARCHIVE_TESTS
    static func isolated(root: String, rootMode: mode_t = 0o700, recoveryParent: String? = nil) throws -> Store {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
        let prefix = app + "/.relay-build/tun-journal-archive-fixtures/"
        guard getuid() > 0, geteuid() == getuid(), getgid() == getegid(), root.hasPrefix(prefix),
              Effects.uuid(String(root.dropFirst(prefix.count))), [mode_t(0o700), mode_t(0o755)].contains(rootMode) else { throw Failure.permission }
        let parent = recoveryParent ?? root
        guard parent == root || parent == root + "/GroupParent" else { throw Failure.permission }
        return Store(root: root, recovery: parent + "/Recovery", owner: getuid(), group: getgid(), rootMode: rootMode)
    }
    #endif
    final class Store {
        #if RELAY_TUN_JOURNAL_ARCHIVE_TESTS
        var afterMove: ((String) throws -> Void)?
        #endif
        private let root: String, recovery: String
        private let owner: uid_t, group: gid_t
        private let rootMode: mode_t
        fileprivate init(root: String, recovery: String, owner: uid_t, group: gid_t, rootMode: mode_t) { self.root = root; self.recovery = recovery; self.owner = owner; self.group = group; self.rootMode = rootMode }
        private func gate() throws {
            guard getuid() == owner, geteuid() == owner, getgid() == group, getegid() == group else { throw Failure.permission }
        }
        private func same(_ a: stat, _ b: stat) -> Bool {
            a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_mode == b.st_mode
        }
        private func fileSame(_ a: stat, _ b: stat) -> Bool {
            same(a, b) && a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
                a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
                a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
        }
        private func directory(_ path: String, create: Bool = false) throws -> Int32? {
            try gate()
            let parts = path.split(separator: "/").map(String.init)
            guard path.hasPrefix("/"), !parts.contains("."), !parts.contains(".."), !path.contains("\0") else { throw Failure.invalid }
            var current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard current >= 0 else { throw Failure.unsafe }
            do {
                for (index, part) in parts.enumerated() {
                    var before = stat(); guard fstat(current, &before) == 0, [uid_t(0), owner].contains(before.st_uid), before.st_mode & 0o6022 == 0 else { throw Failure.unsafe }
                    let last = index == parts.count - 1
                    var child = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    var createdIdentity: stat?
                    if child < 0 && errno == ENOENT {
                        if !create { Darwin.close(current); return nil }
                        guard last else { throw Failure.unsafe }
                        guard mkdirat(current, part, 0o700) == 0, fsync(current) == 0 else { throw Failure.uncertain }
                        var created = stat()
                        guard fstatat(current, part, &created, AT_SYMLINK_NOFOLLOW) == 0,
                              created.st_uid == owner, created.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                              created.st_mode & 0o0022 == 0 else { throw Failure.uncertain }
                        createdIdentity = created
                        child = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    }
                    guard child >= 0 else { throw Failure.unsafe }
                    var held = stat(), linked = stat()
                    let valid = fstat(child, &held) == 0 && fstatat(current, part, &linked, AT_SYMLINK_NOFOLLOW) == 0 && same(held, linked)
                    guard valid, [uid_t(0), owner].contains(held.st_uid), held.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                          held.st_mode & 0o0022 == 0 else { Darwin.close(child); throw Failure.unsafe }
                    if let createdIdentity {
                        // Darwin inherits the parent's group even without setgid.
                        // Only a directory created by this call may be corrected.
                        let original = held
                        let expectedMode: mode_t = path == root ? rootMode : 0o700
                        guard same(createdIdentity, held), held.st_uid == owner,
                              fchown(child, owner, group) == 0, fchmod(child, expectedMode) == 0,
                              fsync(child) == 0, fsync(current) == 0,
                              fstat(child, &held) == 0, fstatat(current, part, &linked, AT_SYMLINK_NOFOLLOW) == 0,
                              original.st_dev == held.st_dev, original.st_ino == held.st_ino, same(held, linked) else {
                            Darwin.close(child); throw Failure.uncertain
                        }
                    }
                    guard held.st_mode & 0o6022 == 0,
                          !last || (held.st_uid == owner && held.st_gid == group && held.st_mode & 0o7777 == (path == root ? rootMode : 0o700)) else { Darwin.close(child); throw Failure.unsafe }
                    Darwin.close(current); current = child
                }
                return current
            } catch { Darwin.close(current); throw error }
        }
        private func names(_ fd: Int32, limit: Int = 4096) throws -> [String] {
            let copy = fcntl(fd, F_DUPFD_CLOEXEC, 10); guard copy >= 0 else { throw Failure.unsafe }
            guard let stream = fdopendir(copy) else { Darwin.close(copy); throw Failure.unsafe }; defer { closedir(stream) }; rewinddir(stream)
            var result: [String] = []
            while true {
                errno = 0; guard let entry = readdir(stream) else { guard errno == 0 else { throw Failure.unsafe }; break }
                let name = withUnsafePointer(to: &entry.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) } }
                if name == "." || name == ".." { continue }
                guard result.count < limit, name.utf8.count <= 100 else { throw Failure.unsafe }; result.append(name)
            }
            return result.sorted()
        }
        private func read(_ name: String, fd: Int32, limit: Int) throws -> Data {
            let file = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard file >= 0 else { throw Failure.unsafe }; defer { Darwin.close(file) }
            var before = stat(), after = stat(), linked = stat()
            guard fstat(file, &before) == 0, before.st_uid == owner, before.st_gid == group, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  before.st_mode & 0o7777 == 0o600, before.st_nlink == 1, before.st_size > 0, before.st_size <= limit else { throw Failure.unsafe }
            var data = Data(), buffer = [UInt8](repeating: 0, count: 8192)
            while true {
                let count = Darwin.read(file, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }; guard count >= 0 else { throw Failure.unsafe }
                if count == 0 { break }; guard data.count + count <= limit else { throw Failure.unsafe }; data.append(contentsOf: buffer.prefix(count))
            }
            guard fstat(file, &after) == 0, fileSame(before, after), data.count == before.st_size,
                  fstatat(fd, name, &linked, AT_SYMLINK_NOFOLLOW) == 0, fileSame(after, linked) else { throw Failure.conflict }
            return data
        }
        private func canonical(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) }
        private func network(_ path: String, plan: Plan) throws -> (RelayTunNetworkJournal.Snapshot, String) {
            guard let fd = try directory(path) else { throw Failure.conflict }; defer { Darwin.close(fd) }
            let entries = try names(fd, limit: 800), expected = (0..<entries.count).map { String(format: "%010d.record", $0) }
            guard !entries.isEmpty, entries == expected else { throw Failure.conflict }
            var previous: RelayTunNetworkJournal.Snapshot?, previousRecord: String?, previousSnapshot: String?
            for (index, name) in entries.enumerated() {
                let bytes = try read(name, fd: fd, limit: RelayTunNetworkEffects.maximumBytes + 4096)
                let object = try Effects.object(RelayTunStrictJSON.object(bytes, limit: bytes.count), keys: ["version", "role", "index", "previousRecordSHA256", "previousSnapshotSHA256", "snapshot"])
                let snapshotBytes = try canonical(object["snapshot"]!), snapshot = try RelayTunNetworkJournal.Snapshot.decode(snapshotBytes)
                guard RelayTunStrictJSON.integer(object["version"]) == 1, object["role"] as? String == "network-journal-record",
                      RelayTunStrictJSON.integer(object["index"]) == index, snapshot.sequence == index,
                      (object["previousRecordSHA256"] as? String) == previousRecord,
                      (object["previousSnapshotSHA256"] as? String) == previousSnapshot,
                      previousRecord != nil || object["previousRecordSHA256"] is NSNull,
                      previousSnapshot != nil || object["previousSnapshotSHA256"] is NSNull,
                      try canonical(object) == bytes, snapshot.follows(previous) else { throw Failure.conflict }
                previous = snapshot; previousRecord = RelayTunHelperTrust.digest(bytes); previousSnapshot = RelayTunHelperTrust.digest(snapshotBytes)
            }
            guard let last = previous, last.binding.planID == plan.id,
                  last.binding.configurationSHA256 == plan.configurationSHA256, last.binding.runtimeConfigurationSHA256 == plan.runtimeConfigurationSHA256,
                  last.binding.effectsSHA256 == plan.effectsSHA256, last.binding.createdAt == plan.createdAt, last.binding.expiresAt == plan.expiresAt,
                  last.binding.networkSHA256 == plan.baseline.networkSHA256, last.binding.protectionSHA256 == plan.baseline.protectionSHA256,
                  last.binding.routeRemovalPolicy == plan.routeRemovalPolicy, ["restored", "closed_external_change", "acquisition_aborted"].contains(last.phase.rawValue),
                  last.pendingIDs.isEmpty, last.observation?.deviceAbsent == true, try names(fd, limit: 800) == entries else { throw Failure.conflict }
            return (last, previousRecord!)
        }
        private func device(_ path: String, plan: Plan, deviceID: String?) throws -> String {
            guard let fd = try directory(path) else { throw Failure.conflict }; defer { Darwin.close(fd) }
            let entries = try names(fd, limit: 512); guard !entries.isEmpty else { throw Failure.conflict }
            var previous: String?, finalEvent: [String: Any]?, exactDeviceID = deviceID
            for (index, name) in entries.enumerated() {
                let bytes = try read(name, fd: fd, limit: 263168), hash = RelayTunHelperTrust.digest(bytes)
                guard name == String(format: "%08d", index) + "-" + hash + ".json" else { throw Failure.conflict }
                let object = try Effects.object(RelayTunStrictJSON.object(bytes, limit: bytes.count), keys: ["version", "role", "previousRecordSHA256", "record"])
                let record = try Effects.object(object["record"], keys: ["version", "role", "planID", "configurationSHA256", "runtimeConfigurationSHA256", "effectsSHA256", "createdAt", "expiresAt", "sequence", "event"])
                let event = try Effects.object(record["event"], keys: ["id", "operation", "phase", "before", "desired", "observed", "ownsHandle"])
                guard try canonical(object) == bytes, RelayTunStrictJSON.integer(object["version"]) == 1, object["role"] as? String == "tun-device-journal-record",
                      (object["previousRecordSHA256"] as? String) == previous, previous != nil || object["previousRecordSHA256"] is NSNull,
                      RelayTunStrictJSON.integer(record["version"]) == 1, record["role"] as? String == "tun-device-event",
                      record["planID"] as? String == plan.id, record["configurationSHA256"] as? String == plan.configurationSHA256,
                      record["runtimeConfigurationSHA256"] as? String == plan.runtimeConfigurationSHA256, record["effectsSHA256"] as? String == plan.effectsSHA256,
                      record["createdAt"] as? String == String(plan.createdAt), record["expiresAt"] as? String == String(plan.expiresAt),
                      RelayTunStrictJSON.integer(record["sequence"]) == index, let observedID = event["id"] as? String, Effects.uuid(observedID),
                      exactDeviceID == nil || observedID == exactDeviceID,
                      let operation = event["operation"] as? [String: Any], let kind = operation["kind"] as? String,
                      ["create", "mtu", "address", "duplicate", "close", "verifyAbsent"].contains(kind),
                      ["intent", "confirmed", "uncertain"].contains(event["phase"] as? String ?? ""),
                      let own = event["ownsHandle"] as? NSNumber, CFGetTypeID(own) == CFBooleanGetTypeID() else { throw Failure.conflict }
                if index == 0 { guard kind == "create", event["phase"] as? String == "intent", !own.boolValue else { throw Failure.conflict } }
                exactDeviceID = observedID; previous = hash; finalEvent = event
            }
            guard let event = finalEvent, let operation = event["operation"] as? [String: Any], Set(operation.keys) == ["kind"], operation["kind"] as? String == "verifyAbsent",
                  event["phase"] as? String == "confirmed", (event["ownsHandle"] as? NSNumber)?.boolValue == false,
                  try names(fd, limit: 512) == entries else { throw Failure.conflict }
            return previous!
        }
        private func location(_ kind: String, id: String) throws -> (String, Bool) {
            let active = root + "/" + kind + "/" + id, archived = recovery + "/" + id + "/" + kind
            let a = try directory(active), b = try directory(archived)
            defer { if let a { Darwin.close(a) }; if let b { Darwin.close(b) } }
            guard (a == nil) != (b == nil) else { throw Failure.conflict }; return a == nil ? (archived, false) : (active, true)
        }
        private func manifest(binding: RelayTunNetworkJournal.Binding, sessionID: String, evidenceSHA256: String, receipt: RelayTunAcquiredReceipt?, phase: String, networkTip: String?, deviceTip: String?) throws -> Data {
            guard Effects.uuid(sessionID), Effects.digest(evidenceSHA256) else { throw Failure.invalid }
            var object: [String: Any] = ["version": 1, "role": "terminal-tun-audit", "binding": binding.json, "sessionID": sessionID,
                "acquisition": phase == "unacquired" ? "none" : receipt == nil ? "aborted" : "acquired",
                "receipt": NSNull(), "evidenceSHA256": evidenceSHA256, "networkTipSHA256": networkTip.map { $0 as Any } ?? NSNull(),
                "deviceTipSHA256": deviceTip.map { $0 as Any } ?? NSNull(), "terminalPhase": phase]
            if let receipt {
                try receipt.validate()
                guard receipt.planID == binding.planID, receipt.sessionID == sessionID, receipt.clientUID == binding.clientUID,
                      receipt.installationRevision == binding.installationRevision, receipt.runtimeConfigurationSHA256 == binding.runtimeConfigurationSHA256,
                      receipt.evidenceSHA256 == evidenceSHA256 else { throw Failure.invalid }
                object["receipt"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt))
            }
            return try canonical(object)
        }
        private func writeManifest(_ bytes: Data, fd: Int32) throws {
            let file = openat(fd, "retirement.json", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard file >= 0 else { throw Failure.conflict }; defer { Darwin.close(file) }
            var info = stat()
            guard fchmod(file, 0o600) == 0, fstat(file, &info) == 0, info.st_uid == owner, info.st_gid == group,
                  info.st_nlink == 1, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw Failure.unsafe }
            try bytes.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count { let count = Darwin.write(file, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if count < 0 && errno == EINTR { continue }; guard count > 0 else { throw Failure.uncertain }; offset += count }
            }
            guard fsync(file) == 0, fsync(fd) == 0 else { throw Failure.uncertain }
        }
        func retire(_ plan: Plan, sessionID: String, evidenceSHA256: String, receipt: RelayTunAcquiredReceipt?, clientUID: UInt32, revision: String) throws {
            try gate(); guard Effects.uuid(plan.id) else { throw Failure.invalid }
            let binding = try RelayTunNetworkJournal.Binding(installationRevision: revision, clientUID: clientUID, plan: plan)
            let n: (String, Bool)?, d: (String, Bool)?, expected: Data
            let activeNetwork = try directory(root + "/NetworkJournal/" + plan.id), archivedNetwork = try directory(recovery + "/" + plan.id + "/NetworkJournal")
            let hasNetwork = activeNetwork != nil || archivedNetwork != nil
            if let activeNetwork { Darwin.close(activeNetwork) }; if let archivedNetwork { Darwin.close(archivedNetwork) }
            if !hasNetwork {
                guard receipt == nil else { throw Failure.conflict }
                for path in [root + "/DeviceJournal/" + plan.id, recovery + "/" + plan.id + "/DeviceJournal"] {
                    if let fd = try directory(path) { Darwin.close(fd); throw Failure.conflict }
                }
                n = nil; d = nil
                expected = try manifest(binding: binding, sessionID: sessionID, evidenceSHA256: evidenceSHA256, receipt: nil, phase: "unacquired", networkTip: nil, deviceTip: nil)
            } else {
                let net = try location("NetworkJournal", id: plan.id)
                let (snapshot, tip) = try network(net.0, plan: plan)
                guard snapshot.binding == binding,
                      (receipt != nil && snapshot.phase.rawValue != "acquisition_aborted") ||
                      (receipt == nil && snapshot.phase.rawValue == "acquisition_aborted") else { throw Failure.conflict }
                if let receipt { guard snapshot.realizedEffects?.device.id == receipt.deviceID else { throw Failure.conflict } }
                let activeDevice = try directory(root + "/DeviceJournal/" + plan.id), archivedDevice = try directory(recovery + "/" + plan.id + "/DeviceJournal")
                let hasDevice = activeDevice != nil || archivedDevice != nil
                if let activeDevice { Darwin.close(activeDevice) }; if let archivedDevice { Darwin.close(archivedDevice) }
                guard hasDevice || (receipt == nil && snapshot.phase.rawValue == "acquisition_aborted") else { throw Failure.conflict }
                let dev = hasDevice ? try location("DeviceJournal", id: plan.id) : nil
                n = net; d = dev
                expected = try manifest(binding: binding, sessionID: sessionID, evidenceSHA256: evidenceSHA256, receipt: receipt, phase: snapshot.phase.rawValue,
                    networkTip: tip, deviceTip: dev.map { try device($0.0, plan: plan, deviceID: receipt?.deviceID) })
            }
            guard let archive = try directory(recovery, create: true) else { throw Failure.uncertain }; defer { Darwin.close(archive) }
            let destination = recovery + "/" + plan.id
            let existing = try directory(destination)
            let target: Int32
            if let existing { target = existing }
            else { guard let created = try directory(destination, create: true) else { throw Failure.uncertain }; target = created }
            defer { Darwin.close(target) }
            let entries = try names(target, limit: 3)
            if existing == nil { guard entries.isEmpty else { throw Failure.conflict }; try writeManifest(expected, fd: target) }
            else { guard entries.contains("retirement.json"), Set(entries).isSubset(of: ["retirement.json", "NetworkJournal", "DeviceJournal"]),
                         try read("retirement.json", fd: target, limit: 8192) == expected else { throw Failure.conflict } }
            for (kind, maybeSource) in [("NetworkJournal", n), ("DeviceJournal", d)] {
                guard let source = maybeSource, source.1 else { continue }
                guard let parent = try directory(root + "/" + kind) else { throw Failure.conflict }; defer { Darwin.close(parent) }
                guard renameatx_np(parent, plan.id, target, kind, UInt32(RENAME_EXCL)) == 0,
                      fsync(parent) == 0, fsync(target) == 0 else { throw Failure.uncertain }
                #if RELAY_TUN_JOURNAL_ARCHIVE_TESTS
                try afterMove?(kind)
                #endif
            }
            _ = try terminal(plan.id)
            guard fsync(target) == 0, fsync(archive) == 0 else { throw Failure.uncertain }
        }
        func verifyLiveEmpty(remove: Bool = false) throws {
            try gate()
            for kind in ["NetworkJournal", "DeviceJournal"] {
                let path = root + "/" + kind
                guard let fd = try directory(path) else { continue }; defer { Darwin.close(fd) }
                guard try names(fd).isEmpty else { throw Failure.conflict }
                if remove {
                    guard rmdir(path) == 0, let parent = try directory(root) else { throw Failure.uncertain }
                    defer { Darwin.close(parent) }; guard fsync(parent) == 0 else { throw Failure.uncertain }
                }
            }
        }
        func verifyPreserved() throws -> Bool {
            try gate(); guard let archive = try directory(recovery) else { return false }; defer { Darwin.close(archive) }
            let ids = try names(archive)
            for id in ids {
                _ = try terminal(id)
            }
            guard try names(archive) == ids else { throw Failure.conflict }; return !ids.isEmpty
        }
        private func terminal(_ id: String) throws -> Terminal {
                guard Effects.uuid(id), let fd = try directory(recovery + "/" + id) else { throw Failure.conflict }; defer { Darwin.close(fd) }
                let entries = try names(fd, limit: 3)
                let bytes = try read("retirement.json", fd: fd, limit: 8192), object = try Effects.object(RelayTunStrictJSON.object(bytes), keys: ["version", "role", "binding", "sessionID", "evidenceSHA256", "acquisition", "receipt", "networkTipSHA256", "deviceTipSHA256", "terminalPhase"])
                guard RelayTunStrictJSON.integer(object["version"]) == 1, object["role"] as? String == "terminal-tun-audit", try canonical(object) == bytes else { throw Failure.invalid }
                let binding = try RelayTunNetworkJournal.Binding.parse(object["binding"])
                guard binding.planID == id, let sessionID = object["sessionID"] as? String, Effects.uuid(sessionID), let phase = object["terminalPhase"] as? String,
                      let evidence = object["evidenceSHA256"] as? String, Effects.digest(evidence) else { throw Failure.conflict }
                let plan = Plan(id: id, configurationSHA256: binding.configurationSHA256, runtimeConfigurationSHA256: binding.runtimeConfigurationSHA256,
                    effectsSHA256: binding.effectsSHA256, baseline: .init(networkSHA256: binding.networkSHA256, protectionSHA256: binding.protectionSHA256),
                    createdAt: binding.createdAt, expiresAt: binding.expiresAt, routeRemovalPolicy: binding.routeRemovalPolicy)
                let receipt = try object["receipt"] is NSNull ? nil : JSONDecoder().decode(RelayTunAcquiredReceipt.self, from: canonical(object["receipt"]!))
                if phase == "unacquired" {
                    guard receipt == nil, entries == ["retirement.json"],
                          try manifest(binding: binding, sessionID: sessionID, evidenceSHA256: evidence, receipt: nil, phase: phase, networkTip: nil, deviceTip: nil) == bytes else { throw Failure.conflict }
                } else {
                    let hasDevice = !(object["deviceTipSHA256"] is NSNull)
                    guard entries == (hasDevice ? ["DeviceJournal", "NetworkJournal", "retirement.json"] : ["NetworkJournal", "retirement.json"]),
                          hasDevice || (phase == "acquisition_aborted" && receipt == nil) else { throw Failure.conflict }
                    let (last, tip) = try network(recovery + "/" + id + "/NetworkJournal", plan: plan)
                    guard last.binding == binding, (receipt != nil && phase != "acquisition_aborted") || (receipt == nil && phase == "acquisition_aborted"),
                          try manifest(binding: binding, sessionID: sessionID, evidenceSHA256: evidence, receipt: receipt, phase: last.phase.rawValue, networkTip: tip,
                            deviceTip: hasDevice ? device(recovery + "/" + id + "/DeviceJournal", plan: plan, deviceID: receipt?.deviceID) : nil) == bytes else { throw Failure.conflict }
                }
                for kind in ["NetworkJournal", "DeviceJournal"] {
                    if let active = try directory(root + "/" + kind + "/" + id) { Darwin.close(active); throw Failure.conflict }
                }
                return Terminal(plan: plan, sessionID: sessionID, clientUID: binding.clientUID, revision: binding.installationRevision, receipt: receipt, phase: phase, evidenceSHA256: evidence)
        }
        func loadTerminal(sessionID: String, clientUID: UInt32, revision: String) throws -> Terminal? {
            try gate(); guard Effects.uuid(sessionID), clientUID > 0, Effects.digest(revision) else { throw Failure.invalid }
            guard let fd = try directory(recovery) else { return nil }; defer { Darwin.close(fd) }
            var found: Terminal?
            for id in try names(fd) {
                let value = try terminal(id)
                if value.sessionID == sessionID, value.clientUID == clientUID, value.revision == revision {
                    guard found == nil else { throw Failure.conflict }; found = value
                }
            }
            return found
        }
    }
}
