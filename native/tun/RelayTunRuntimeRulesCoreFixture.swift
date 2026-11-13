import Foundation
import Darwin

// Standalone ordinary-UID integration target. Absent from every shipping list.
// The Node fixture holds the only Core child; this target performs no lifecycle
// operation and accepts only that fixture's private directory and exact peer.
@main struct RelayTunRuntimeRulesCoreFixture {
    private typealias Rules = RelayTunRuntimeRules
    private enum Failure: Error { case invalid, peer, response }
    static func main() {
        do {
            let args = CommandLine.arguments
            guard getuid() > 0, geteuid() == getuid(), getgid() == getegid(), args.count == 4,
                  args[1].hasPrefix("/private/tmp/relay-proxy-"), let pid = Int32(args[2]), pid > 1,
                  args[3] == "true" || args[3] == "false" else { throw Failure.invalid }
            let configuration = try Data(contentsOf: URL(fileURLWithPath: args[1] + "/config.yaml")),
                raw = try RelayTunStrictJSON.object(configuration, limit: 2 * 1024 * 1024),
                revision = RelayTunHelperTrust.digest(configuration),
                owner = try Rules.Owner(generation: 1, configurationRevision: revision),
                binding = try Rules.Binding(["sessionId": "11111111-1111-4111-8111-111111111111",
                    "evidenceSHA256": String(repeating: "e", count: 64), "runtimeConfigurationSHA256": revision])
            var peerChecks = 0
            let live = try RelayTunCoreReadiness.Live(directory: args[1], configuration: configuration,
                authorization: raw["secret"] as? String, verifyPeer: { fd in
                    var uid: uid_t = 0, gid: gid_t = 0, actual: pid_t = 0, effective: pid_t = 0
                    var size = socklen_t(MemoryLayout<pid_t>.size), effectiveSize = size
                    guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(), gid == getgid(),
                          getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &actual, &size) == 0, actual == pid,
                          getsockopt(fd, SOL_LOCAL, LOCAL_PEEREPID, &effective, &effectiveSize) == 0,
                          effective == pid else { throw Failure.peer }
                    peerChecks += 1
                })
            let controller = Rules.Controller(binding: binding, driver: .init(currentOwner: { owner },
                read: { access, done in
                    do { done(.success(try live.readRules(access))) } catch { done(.failure(error)) }
                }, apply: { mutation, access, done in
                    do { done(.success(try live.patchRule(mutation, access: access, verifyContext: {}))) }
                    catch { done(.failure(error)) }
                }))
            func perform(_ id: Int, _ operation: Rules.Operation) throws -> Rules.Reply {
                var value: Rules.Reply?
                controller.perform(.init(id: id, binding: binding, operation: operation)) { value = $0 }
                guard let value else { throw Failure.response }; return value
            }
            let before = try perform(1, .read), disabled = args[3] == "true"
            guard before.status == .snapshot, let snapshot = before.snapshot,
                  snapshot.rows.count == 2, snapshot.rows[0].type == "Domain",
                  snapshot.rows[0].payload == "fixture.invalid", snapshot.rows[0].disabled == !disabled else { throw Failure.response }
            let prepared = try perform(2, .prepare(configurationRevision: revision, rulesSHA256: snapshot.sha256,
                index: 0, disabled: disabled))
            guard prepared.status == .prepared, let nonce = prepared.prepared?["nonce"] as? String else { throw Failure.response }
            let changed = try perform(3, .commit(nonce: nonce))
            guard changed.status == .changed, changed.snapshot?.rows[0].disabled == disabled else { throw Failure.response }
            let result: [String: Any] = ["before": before.json, "after": changed.json, "peerChecks": peerChecks,
                "peerPID": pid, "configurationSHA256": revision, "actualTUN": false]
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("Native/Core rule fixture failed: \(error)\n".utf8)); exit(1)
        }
    }
}
