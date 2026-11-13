import Foundation
import Darwin

private typealias Snapshot = RelayTunRouteSnapshot
private typealias Family = RelayTunNetworkEffects.Address.Family
private enum Injected: Error { case failure }

@main struct RelayTunRouteSnapshotTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ condition: @autoclosure () throws -> Bool, _ name: String) {
            do { rows.append(["name": name, "passed": try condition()]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        func rejects(_ name: String, expected: Snapshot.Failure? = nil, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": false]) }
            catch { rows.append(["name": name, "passed": expected == nil || error as? Snapshot.Failure == expected]) }
        }
        do {
            var events: [String] = []
            let normal = Snapshot.TestDriver(size: { family in events.append("size:\(family)"); return 8 }, fill: { family, buffer in
                events.append("read:\(family):\(buffer.count)"); buffer.copyBytes(from: [1, 2, 3, 4, 5, 6, 7, 8]); return 8
            })
            check(try Snapshot.testRead(family: .ipv4, driver: normal) == Data([1, 2, 3, 4, 5, 6, 7, 8]), "successful completed read preserves exact bytes")
            check(events == ["size:ipv4", "read:ipv4:8"], "sizing and read use the same explicitly selected family")
            events = []
            check(try Snapshot.testRead(family: .ipv6, driver: normal).count == 8 && events == ["size:ipv6", "read:ipv6:8"], "IPv6 remains a separate family without fallback")

            var zeroPhases = 0
            let empty = Snapshot.TestDriver(size: { _ in zeroPhases += 1; return 0 }, fill: { _, buffer in zeroPhases += 1; return buffer.count })
            check(try Snapshot.testRead(family: .ipv4, driver: empty).isEmpty && zeroPhases == 2, "zero initial size still completes a second phase before returning empty bytes")
            let shrinking = Snapshot.TestDriver(size: { _ in 8 }, fill: { _, buffer in buffer.copyBytes(from: [9, 8, 7]); return 3 })
            check(try Snapshot.testRead(family: .ipv4, driver: shrinking) == Data([9, 8, 7]), "a successfully shrinking dump returns no zero-filled tail")
            let disappeared = Snapshot.TestDriver(size: { _ in 8 }, fill: { _, _ in 0 })
            check(try Snapshot.testRead(family: .ipv4, driver: disappeared).isEmpty, "completed read may report an empty table after a nonzero sizing phase")

            var reads = 0, sizes = 0
            let growth = Snapshot.TestDriver(size: { _ in sizes += 1; return sizes == 1 ? 0 : 3 }, fill: { _, buffer in
                reads += 1
                if reads == 1 { return 3 }
                buffer.copyBytes(from: [4, 5, 6]); return 3
            })
            check(try Snapshot.testRead(family: .ipv4, driver: growth) == Data([4, 5, 6]) && sizes == 2 && reads == 2, "growth after zero sizing retries a complete two-phase read")
            reads = 0; sizes = 0
            let partial = Snapshot.TestDriver(size: { _ in sizes += 1; return 4 }, fill: { _, buffer in
                reads += 1
                if reads == 1 { buffer.copyBytes(from: [99, 99]); throw Snapshot.Failure.system(ENOMEM) }
                buffer.copyBytes(from: [1, 2, 3, 4]); return 4
            })
            check(try Snapshot.testRead(family: .ipv4, driver: partial) == Data([1, 2, 3, 4]) && sizes == 2 && reads == 2, "ENOMEM discards partial bytes and restarts sizing before success")
            var sizeAttempts = 0
            let sizingRace = Snapshot.TestDriver(size: { _ in sizeAttempts += 1; if sizeAttempts == 1 { throw Snapshot.Failure.system(ENOMEM) }; return 1 }, fill: { _, buffer in buffer.copyBytes(from: [7]); return 1 })
            check(try Snapshot.testRead(family: .ipv4, driver: sizingRace) == Data([7]) && sizeAttempts == 2, "sizing ENOMEM uses the same bounded retry policy")

            for kind in ["read-ENOMEM", "size-ENOMEM", "length-growth"] {
                var sizeCalls = 0, fillCalls = 0
                let busy = Snapshot.TestDriver(size: { _ in
                    sizeCalls += 1
                    if kind == "size-ENOMEM" { throw Snapshot.Failure.system(ENOMEM) }; return 1
                }, fill: { _, _ in
                    fillCalls += 1
                    if kind == "read-ENOMEM" { throw Snapshot.Failure.system(ENOMEM) }; return 2
                })
                rejects("\(kind) exhaustion cannot return a partial or empty table", expected: .changed) { _ = try Snapshot.testRead(family: .ipv4, driver: busy) }
                check(sizeCalls == Snapshot.maximumAttempts && fillCalls == (kind == "size-ENOMEM" ? 0 : Snapshot.maximumAttempts), "\(kind) performs at most three complete attempts")
            }
            for error in [EACCES, EINVAL, EIO, ENOENT] {
                var sizeCalls = 0, fillCalls = 0
                let failedSize = Snapshot.TestDriver(size: { _ in sizeCalls += 1; throw Snapshot.Failure.system(error) }, fill: { _, _ in fillCalls += 1; return 0 })
                rejects("sizing errno \(error) is preserved without fallback", expected: .system(error)) { _ = try Snapshot.testRead(family: .ipv4, driver: failedSize) }
                check(sizeCalls == 1 && fillCalls == 0, "sizing errno \(error) prevents allocation/read retries")
                sizeCalls = 0; fillCalls = 0
                let failedRead = Snapshot.TestDriver(size: { _ in sizeCalls += 1; return 1 }, fill: { _, buffer in fillCalls += 1; buffer.copyBytes(from: [66]); throw Snapshot.Failure.system(error) })
                rejects("read errno \(error) preserves the error after a partial write", expected: .system(error)) { _ = try Snapshot.testRead(family: .ipv4, driver: failedRead) }
                check(sizeCalls == 1 && fillCalls == 1, "read errno \(error) does not silently retry unrelated failure")
            }
            for value in [-1, Snapshot.maximumBytes + 1, Int.max] {
                var fillCalls = 0
                let oversized = Snapshot.TestDriver(size: { _ in value }, fill: { _, _ in fillCalls += 1; return 0 })
                rejects("invalid sizing count \(value) is bounded before buffer allocation", expected: value < 0 ? .invalidLength : .exhausted) { _ = try Snapshot.testRead(family: .ipv4, driver: oversized) }
                check(fillCalls == 0, "invalid sizing count \(value) never invokes a read")
                let invalidRead = Snapshot.TestDriver(size: { _ in 1 }, fill: { _, _ in value })
                rejects("invalid returned count \(value) cannot publish bytes", expected: value < 0 ? .invalidLength : .exhausted) { _ = try Snapshot.testRead(family: .ipv4, driver: invalidRead) }
            }
            let maximum = Snapshot.TestDriver(size: { _ in Snapshot.maximumBytes }, fill: { _, buffer in
                buffer.initializeMemory(as: UInt8.self, repeating: 5); return buffer.count
            })
            let bounded = try Snapshot.testRead(family: .ipv4, driver: maximum)
            check(bounded.count == Snapshot.maximumBytes && bounded.first == 5 && bounded.last == 5, "exact four MiB limit accepts one complete snapshot without clamping")
            rejects("an injected reader failure is propagated unchanged") {
                _ = try Snapshot.testRead(family: .ipv4, driver: .init(size: { _ in throw Injected.failure }, fill: { _, _ in 0 }))
            }
            check(Snapshot.maximumBytes == 4 * 1024 * 1024 && Snapshot.maximumAttempts == 3, "snapshot limits remain explicit and finite")
            check(Snapshot.liveAPICalls == 0, "all fixtures exercise injected drivers without invoking production sysctl")
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failed = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failed == 0, "checksPassed": rows.count - failed, "checksTotal": rows.count,
            "actualSysctlCalls": Snapshot.liveAPICalls, "routingSocketOpened": false, "systemConfigurationChanged": false,
            "actualTunCreated": false, "actualTunAccepted": false, "checks": rows]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failed > 0 { exit(1) }
    }
}
