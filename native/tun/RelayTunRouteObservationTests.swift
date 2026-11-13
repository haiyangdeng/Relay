import Foundation
import Darwin

private typealias Observation = RelayTunRouteObservation
private typealias Projection = RelayTunRouteProjection
private typealias Effects = RelayTunNetworkEffects
private enum Injected: Error { case read, lookup }

@main struct RelayTunRouteObservationTests {
    static func main() {
        guard getuid() > 0, geteuid() == getuid(), CommandLine.arguments.count == 1 else { exit(77) }
        var rows: [[String: Any]] = []
        func check(_ condition: @autoclosure () throws -> Bool, _ name: String) {
            do { rows.append(["name": name, "passed": try condition()]) }
            catch { rows.append(["name": name, "passed": false, "error": String(describing: error)]) }
        }
        func rejects(_ name: String, _ body: () throws -> Void) {
            do { try body(); rows.append(["name": name, "passed": false]) }
            catch { rows.append(["name": name, "passed": true]) }
        }
        func header(_ bytes: Data) -> rt_msghdr {
            var value = rt_msghdr()
            withUnsafeMutableBytes(of: &value) { $0.copyBytes(from: bytes.prefix($0.count)) }
            return value
        }
        func replacingHeader(_ bytes: Data, _ change: (inout rt_msghdr) -> Void) -> Data {
            var value = header(bytes), output = bytes
            change(&value)
            withUnsafeBytes(of: value) { output.replaceSubrange(0..<$0.count, with: $0) }
            return output
        }
        func addressOffset(_ bytes: Data, _ slot: Int) -> Int {
            let value = header(bytes)
            var offset = MemoryLayout<rt_msghdr>.size
            for index in 0..<slot where value.rtm_addrs & (1 << index) != 0 {
                let size = Int(bytes[offset])
                offset += size == 0 ? 4 : (size + 3) & ~3
            }
            return offset
        }
        func stream(_ frames: [Data]) -> Data { frames.reduce(into: Data()) { $0.append($1) } }
        func replacingAddress(_ bytes: Data, slot: Int, with address: Data) -> Data {
            let offset = addressOffset(bytes, slot), oldSize = Int(bytes[offset])
            let oldSpan = oldSize == 0 ? 4 : (oldSize + 3) & ~3
            let newSpan = address.isEmpty ? 4 : (address.count + 3) & ~3
            var replacement = address
            replacement.append(Data(repeating: 0, count: newSpan - replacement.count))
            var output = bytes
            output.replaceSubrange(offset..<(offset + oldSpan), with: replacement)
            let size = UInt16(output.count)
            return replacingHeader(output) { $0.rtm_msglen = size }
        }
        func radixMask(_ bytes: Data, prefix: UInt32, family: Effects.Address.Family) -> Data {
            let offset = family == .ipv4 ? 4 : 8, length = offset + (Int(prefix) + 7) / 8
            var mask = Data(repeating: 0xff, count: length)
            mask[0] = UInt8(length)
            if prefix % 8 != 0 { mask[length - 1] = UInt8(truncatingIfNeeded: 0xff << (8 - Int(prefix % 8))) }
            return replacingAddress(bytes, slot: Int(RTAX_NETMASK), with: mask)
        }
        func zone(_ bytes: Data, embedded: UInt16 = 0, explicit: UInt32 = 0, outgoingIndex: UInt16? = nil) -> Data {
            let offset = addressOffset(bytes, Int(RTAX_DST))
            var output = bytes, nativeScope = explicit
            output[offset + 8 + 2] = UInt8(embedded >> 8)
            output[offset + 8 + 3] = UInt8(embedded & 0xff)
            withUnsafeBytes(of: &nativeScope) { output.replaceSubrange((offset + 24)..<(offset + 28), with: $0) }
            if let outgoingIndex { output = replacingHeader(output) { $0.rtm_index = outgoingIndex } }
            return output
        }
        func repeated(_ frame: Data, count: Int) -> Data {
            var output = Data(capacity: frame.count * count)
            for _ in 0..<count { output.append(frame) }
            return output
        }
        do {
            let interface = try Effects.Interface(name: "utun42", index: 91)
            func route(_ address: String = "198.18.0.0", prefix: UInt32 = 30,
                       family: Effects.Address.Family = .ipv4, scoped: Bool = false) throws -> Effects.Route {
                try .init(destination: .init(address: .init(family: family, value: address), length: prefix),
                          gateway: nil, interface: interface, scopeIndex: scoped ? interface.index : 0,
                          flags: 0x801 | (prefix == (family == .ipv4 ? 32 : 128) ? 4 : 0) | (scoped ? 0x01000000 : 0), hopCount: 7)
            }
            func frame(_ route: Effects.Route) throws -> Data {
                try Projection.request(route, operation: .get, pid: 0, sequence: 0, interfaceType: 249)
            }
            let ordinary = try route(), other = try route("192.0.2.0", prefix: 24)
            let ordinaryFrame = try frame(ordinary), otherFrame = try frame(other)
            var reads: [Effects.Address.Family] = [], lookups: [UInt32] = []
            let present = Observation(read: { family in reads.append(family); return ordinaryFrame },
                resolveInterface: { index in lookups.append(index); return interface })
            switch try present.observe(destination: ordinary.destination, scopeIndex: 0) {
            case .present(let value, let evidence):
                check(value.route == ordinary && value.operation == .get, "matching candidate projects its exact typed route")
                check(evidence.frames == 1 && evidence.bytes == ordinaryFrame.count && evidence.snapshotSHA256 == RelayTunHelperTrust.digest(ordinaryFrame),
                      "presence binds evidence to the complete injected dump")
                check(!evidence.actualTunAccepted, "route observation cannot claim TUN acceptance")
            case .absent: check(false, "matching candidate must be present")
            }
            check(reads == [.ipv4] && lookups == [91], "reader receives the requested family and resolver receives the exact candidate index")

            let kernelMTUFrame = replacingHeader(ordinaryFrame) { $0.rtm_rmx.rmx_mtu = 1500 }
            let kernelMTU = Observation(read: { _ in kernelMTUFrame }, resolveInterface: { _ in interface })
            switch try kernelMTU.observe(destination: ordinary.destination, scopeIndex: 0) {
            case .present(let value, let evidence):
                check(value.route == ordinary && value.kernelMTU == 1500,
                      "kernel-selected MTU is retained for the adapter to validate against its held device")
                check(evidence.snapshotSHA256 == RelayTunHelperTrust.digest(kernelMTUFrame) && !evidence.actualTunAccepted,
                      "MTU-bearing observation preserves exact evidence without claiming ownership or TUN acceptance")
            case .absent: check(false, "kernel metadata cannot hide an occupying route")
            }

            for bytes in [Data(), otherFrame] {
                var absentLookups = 0
                let absent = Observation(read: { _ in bytes }, resolveInterface: { _ in absentLookups += 1; return interface })
                switch try absent.observe(destination: ordinary.destination, scopeIndex: 0) {
                case .absent(let evidence):
                    check(evidence.frames == (bytes.isEmpty ? 0 : 1) && evidence.bytes == bytes.count && evidence.snapshotSHA256 == RelayTunHelperTrust.digest(bytes),
                          "complete \(bytes.isEmpty ? "empty" : "unrelated") snapshot supplies trustworthy absence evidence")
                case .present: check(false, "unrelated or empty snapshot cannot supply a candidate")
                }
                check(absentLookups == 0, "absence does not resolve or adopt an interface")
            }

            let unsupportedFrames = [
                replacingHeader(otherFrame) { $0.rtm_rmx.rmx_locks = UInt32(RTV_MTU) },
                replacingHeader(otherFrame) { $0.rtm_flags |= 0x400 },
                replacingHeader(otherFrame) { $0.rtm_flags = Int32(bitPattern: UInt32(bitPattern: $0.rtm_flags) | 0x80000000) },
                replacingHeader(otherFrame) { $0.rtm_index = 0 }
            ]
            for (index, unsupported) in unsupportedFrames.enumerated() {
                let bytes = stream([ordinaryFrame, unsupported])
                let observer = Observation(read: { _ in bytes }, resolveInterface: { _ in interface })
                switch try observer.observe(destination: ordinary.destination, scopeIndex: 0) {
                case .present(let value, let evidence):
                    check(value.route == ordinary && evidence.frames == 2 && evidence.bytes == bytes.count,
                          "unrelated unsupported value \(index) remains in the fully inspected snapshot")
                case .absent: check(false, "unrelated unsupported values cannot hide the matching candidate")
                }
                var failedLookups = 0
                let candidate = Observation(read: { _ in unsupported }, resolveInterface: { _ in failedLookups += 1; return interface })
                rejects("unsupported candidate \(index) refuses rather than reporting absent") {
                    _ = try candidate.observe(destination: other.destination, scopeIndex: 0)
                }
                check(failedLookups == 0, "unsupported candidate \(index) refuses before interface resolution")
            }

            let compactOther = radixMask(otherFrame, prefix: other.destination.length, family: .ipv4)
            let compactSnapshot = Observation(read: { _ in stream([ordinaryFrame, compactOther]) }, resolveInterface: { _ in interface })
            switch try compactSnapshot.observe(destination: ordinary.destination, scopeIndex: 0) {
            case .present(let value, let evidence): check(value.route == ordinary && evidence.frames == 2, "real radix FF-header compact mask retains an unrelated key")
            case .absent: check(false, "compact unrelated mask must not hide an earlier candidate")
            }
            let compactCandidate = Observation(read: { _ in compactOther }, resolveInterface: { _ in interface })
            switch try compactCandidate.observe(destination: other.destination, scopeIndex: 0) {
            case .present(let value, _): check(value.route == other, "real radix compact-mask candidate retains the complete typed route")
            case .absent: check(false, "compact-mask occupying candidate cannot become absent")
            }
            let compactMTUFrame = replacingHeader(compactOther) { $0.rtm_rmx.rmx_mtu = 1500 }
            let compactMTU = Observation(read: { _ in compactMTUFrame }, resolveInterface: { _ in interface })
            switch try compactMTU.observe(destination: other.destination, scopeIndex: 0) {
            case .present(let value, _):
                check(value.route == other && value.kernelMTU == 1500,
                      "compact-mask kernel snapshot retains its route and MTU metadata")
            case .absent: check(false, "compact-mask kernel metadata cannot become absence")
            }
            let unsupportedCompact = replacingHeader(compactOther) { $0.rtm_rmx.rmx_locks = UInt32(RTV_MTU) }
            let compactUnknown = Observation(read: { _ in unsupportedCompact }, resolveInterface: { _ in interface })
            rejects("compact-mask candidate with unsupported value stays unknown rather than disappearing") {
                _ = try compactUnknown.observe(destination: other.destination, scopeIndex: 0)
            }
            var mixedRadix = compactOther
            mixedRadix[addressOffset(mixedRadix, Int(RTAX_NETMASK)) + 2] = 0
            let mixedMask = Observation(read: { _ in stream([ordinaryFrame, mixedRadix]) }, resolveInterface: { _ in interface })
            rejects("mixed radix header cannot prove a complete trustworthy key scan") {
                _ = try mixedMask.observe(destination: ordinary.destination, scopeIndex: 0)
            }

            let host = try route("203.0.113.8", prefix: 32), hostFrame = try frame(host)
            let networkHostFrame = replacingHeader(hostFrame) { $0.rtm_flags &= ~Int32(4) }
            for duplicate in [stream([ordinaryFrame, ordinaryFrame]), stream([hostFrame, networkHostFrame])] {
                var duplicateLookups = 0
                let observer = Observation(read: { _ in duplicate }, resolveInterface: { _ in duplicateLookups += 1; return interface })
                rejects("duplicate destination key including HOST/full-prefix variant refuses as ambiguous") {
                    _ = try observer.observe(destination: duplicate == stream([ordinaryFrame, ordinaryFrame]) ? ordinary.destination : host.destination, scopeIndex: 0)
                }
                check(duplicateLookups == 0, "ambiguous candidates are not projected or resolved")
            }

            let scoped = try route(scoped: true), scopedFrame = try frame(scoped)
            let scopes = Observation(read: { _ in stream([ordinaryFrame, scopedFrame]) }, resolveInterface: { _ in interface })
            for (scope, expected) in [(UInt32(0), ordinary), (UInt32(91), scoped)] {
                switch try scopes.observe(destination: ordinary.destination, scopeIndex: scope) {
                case .present(let value, let evidence): check(value.route == expected && evidence.frames == 2, "scope \(scope) selects only its own lookup key")
                case .absent: check(false, "exact scope candidate must be present")
                }
            }
            switch try scopes.observe(destination: ordinary.destination, scopeIndex: 92) {
            case .absent: check(true, "a different explicit interface scope remains absent")
            case .present: check(false, "another scope cannot satisfy the query")
            }

            let ipv6 = try route("fd00::", prefix: 64, family: .ipv6), ipv6Frame = try frame(ipv6)
            let families = Observation(read: { family in family == .ipv4 ? ordinaryFrame : ipv6Frame }, resolveInterface: { _ in interface })
            switch try families.observe(destination: ipv6.destination, scopeIndex: 0) {
            case .present(let value, _): check(value.route == ipv6, "IPv6 query uses an independent IPv6 dump and projection")
            case .absent: check(false, "IPv6 candidate must be present")
            }
            let wrongFamily = Observation(read: { _ in ipv6Frame }, resolveInterface: { _ in interface })
            rejects("a family-filtered reader returning another family cannot prove absence") {
                _ = try wrongFamily.observe(destination: ordinary.destination, scopeIndex: 0)
            }

            let linkLocal = try route("fe80::", prefix: 64, family: .ipv6)
            let linkFrame = radixMask(try frame(linkLocal), prefix: 64, family: .ipv6)
            let zoneFrames = [
                zone(linkFrame, embedded: 91),
                zone(linkFrame, embedded: 91, outgoingIndex: 1),
                zone(linkFrame, explicit: 91),
                zone(linkFrame, embedded: 91, explicit: 91),
                zone(linkFrame, explicit: 65536)
            ]
            for (index, zoned) in zoneFrames.enumerated() {
                var zoneLookups = 0
                let unrelated = Observation(read: { _ in zoned }, resolveInterface: { _ in zoneLookups += 1; return interface })
                switch try unrelated.observe(destination: ipv6.destination, scopeIndex: 0) {
                case .absent(let evidence): check(evidence.frames == 1, "unrelated IPv6 zoned key \(index) permits a complete global lookup")
                case .present: check(false, "unrelated zoned link-local cannot become a global candidate")
                }
                rejects("colliding canonical zoned candidate \(index) remains unknown rather than absent") {
                    _ = try unrelated.observe(destination: linkLocal.destination, scopeIndex: 0)
                }
                check(zoneLookups == 0, "unrepresented zoned candidate \(index) refuses before interface adoption")
            }
            let mixedZones = [zone(linkFrame, embedded: 91, explicit: 92), zone(ipv6Frame, explicit: 91)]
            for (index, mixed) in mixedZones.enumerated() {
                var mixedLookups = 0
                let observer = Observation(read: { _ in stream([ipv6Frame, mixed]) }, resolveInterface: { _ in mixedLookups += 1; return interface })
                rejects("inconsistent or unsupported zone key \(index) invalidates the complete snapshot") {
                    _ = try observer.observe(destination: ipv6.destination, scopeIndex: 0)
                }
                check(mixedLookups == 0, "malformed zone key \(index) prevents earlier-candidate callbacks")
            }

            var badMask = otherFrame
            badMask[addressOffset(badMask, Int(RTAX_NETMASK)) + 4] = 0x7f
            var badDestination = otherFrame
            badDestination[addressOffset(badDestination, Int(RTAX_DST)) + 4 + 3] = 1
            let badFrames = [
                Data(), Data([0]), Data(otherFrame.dropLast()), badMask, badDestination,
                replacingHeader(otherFrame) { $0.rtm_version = 0 },
                replacingHeader(otherFrame) { $0.rtm_errno = ESRCH },
                replacingHeader(otherFrame) { $0.rtm_type = 2 },
                replacingHeader(otherFrame) { $0.rtm_addrs |= 0x100 },
                replacingHeader(otherFrame) { $0.rtm_flags |= 0x01000000; $0.rtm_index = 0 }
            ]
            for (index, bad) in badFrames.enumerated() where !bad.isEmpty {
                var malformedLookups = 0
                let bytes = stream([ordinaryFrame, bad])
                let observer = Observation(read: { _ in bytes }, resolveInterface: { _ in malformedLookups += 1; return interface })
                rejects("later malformed or untrustworthy-key frame \(index) invalidates an earlier candidate") {
                    _ = try observer.observe(destination: ordinary.destination, scopeIndex: 0)
                }
                check(malformedLookups == 0, "later invalid frame \(index) prevents every resolver callback")
            }

            let failedRead = Observation(read: { _ in throw Injected.read }, resolveInterface: { _ in interface })
            rejects("reader errors remain errors rather than empty snapshots") { _ = try failedRead.observe(destination: ordinary.destination, scopeIndex: 0) }
            var prefixedSnapshot = Data([0])
            prefixedSnapshot.append(ordinaryFrame)
            let nonzeroSnapshot = prefixedSnapshot[1..<prefixedSnapshot.count]
            var sliceLookups = 0
            let slicedReader = Observation(read: { _ in nonzeroSnapshot }, resolveInterface: { _ in sliceLookups += 1; return interface })
            check(nonzeroSnapshot.startIndex != 0 && nonzeroSnapshot.count == ordinaryFrame.count, "slice fixture contains a complete frame with nonzero Data indices")
            rejects("nonzero-index Data refuses before unsafe offset-based framing") {
                _ = try slicedReader.observe(destination: ordinary.destination, scopeIndex: 0)
            }
            check(sliceLookups == 0, "nonzero-index slice refusal never resolves an interface")
            let failedLookup = Observation(read: { _ in ordinaryFrame }, resolveInterface: { _ in throw Injected.lookup })
            rejects("interface lookup failure does not become absence") { _ = try failedLookup.observe(destination: ordinary.destination, scopeIndex: 0) }
            let changedLookup = Observation(read: { _ in ordinaryFrame }, resolveInterface: { _ in try .init(name: "utun43", index: 91) })
            rejects("an externally changed interface binding does not become present or absent") { _ = try changedLookup.observe(destination: ordinary.destination, scopeIndex: 0) }

            var invalidReads = 0
            let invalidQuery = Observation(read: { _ in invalidReads += 1; return Data() }, resolveInterface: { _ in interface })
            let unaligned = try Effects.Prefix(address: .init(family: .ipv4, value: "198.18.0.1"), length: 30)
            let zonedQuery = try Effects.Prefix(address: .init(family: .ipv6, value: "fe80:1::"), length: 64)
            rejects("unaligned destination query refuses before reading") { _ = try invalidQuery.observe(destination: unaligned, scopeIndex: 0) }
            rejects("unrepresentable scope query refuses before reading") { _ = try invalidQuery.observe(destination: ordinary.destination, scopeIndex: 65536) }
            rejects("embedded-zone query cannot claim absence from an empty snapshot") { _ = try invalidQuery.observe(destination: zonedQuery, scopeIndex: 0) }
            check(invalidReads == 0, "invalid queries have no read or interface callback")

            // Key-only records can be smaller than complete typed routes. This
            // exercises the independent frame budget below the byte budget.
            let gatewayOffset = addressOffset(otherFrame, Int(RTAX_GATEWAY))
            let gatewayLength = (Int(otherFrame[gatewayOffset]) + 3) & ~3
            var keyOnly = otherFrame
            keyOnly.removeSubrange(gatewayOffset..<(gatewayOffset + gatewayLength))
            keyOnly = replacingHeader(keyOnly) { $0.rtm_addrs &= ~Int32(RTA_GATEWAY); $0.rtm_msglen = UInt16(keyOnly.count) }
            let tooMany = repeated(keyOnly, count: Observation.maximumFrames + 1)
            check(tooMany.count <= Observation.maximumBytes, "frame-limit fixture does not accidentally hit the byte limit first")
            var budgetLookups = 0
            let excessiveFrames = Observation(read: { _ in tooMany }, resolveInterface: { _ in budgetLookups += 1; return interface })
            rejects("one frame above the complete-snapshot budget refuses") { _ = try excessiveFrames.observe(destination: ordinary.destination, scopeIndex: 0) }
            let excessiveBytes = Observation(read: { _ in Data(repeating: 0, count: Observation.maximumBytes + 1) }, resolveInterface: { _ in budgetLookups += 1; return interface })
            rejects("one byte above the snapshot budget refuses before framing") { _ = try excessiveBytes.observe(destination: ordinary.destination, scopeIndex: 0) }
            check(budgetLookups == 0, "snapshot budget failures never resolve a candidate")

            // A bounded, nonprojected gateway value makes each trusted key
            // frame exactly 128 bytes: 32768 frames then reach both limits.
            var boundaryFrame = keyOnly
            let insertion = addressOffset(boundaryFrame, Int(RTAX_NETMASK))
            boundaryFrame.insert(contentsOf: [4, 0, 0, 0], at: insertion)
            boundaryFrame = replacingHeader(boundaryFrame) { $0.rtm_addrs |= Int32(RTA_GATEWAY); $0.rtm_msglen = UInt16(boundaryFrame.count) }
            let boundary = repeated(boundaryFrame, count: Observation.maximumFrames)
            check(boundary.count == Observation.maximumBytes, "boundary fixture reaches the exact byte and frame limits")
            let atLimit = Observation(read: { _ in boundary }, resolveInterface: { _ in budgetLookups += 1; return interface })
            switch try atLimit.observe(destination: ordinary.destination, scopeIndex: 0) {
            case .absent(let evidence): check(evidence.frames == Observation.maximumFrames && evidence.bytes == Observation.maximumBytes,
                                            "complete trustworthy snapshot at both exact limits is accepted")
            case .present: check(false, "unrelated boundary frames cannot supply a candidate")
            }
            check(budgetLookups == 0, "bounded absence requires no interface lookup")
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failed = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failed == 0, "checksPassed": rows.count - failed, "checksTotal": rows.count,
            "actualTunCreated": false, "routingSocketOpened": false, "liveRouteDumpRead": false,
            "systemConfigurationChanged": false, "actualTunAccepted": false, "checks": rows]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failed > 0 { exit(1) }
    }
}
