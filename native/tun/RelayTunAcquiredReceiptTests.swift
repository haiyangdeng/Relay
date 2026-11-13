import Foundation
import Darwin

private typealias Receipt = RelayTunAcquiredReceipt

@main struct RelayTunAcquiredReceiptTests {
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
        do {
            func fixture(name: String = "utun4", index: UInt32 = 20, unit: UInt32 = 5,
                         device: String = "0", inode: String = "0", uid: UInt32 = 501) throws -> Receipt {
                try .init(installationRevision: String(repeating: "a", count: 64), clientUID: uid,
                          evidenceSHA256: String(repeating: "b", count: 64), runtimeConfigurationSHA256: String(repeating: "c", count: 64),
                          planID: "a819f72d-7b78-45e5-933f-561bfa2e0f70", sessionID: "bd3e739f-2820-4be2-85ef-01286a8618c4",
                          deviceID: "b166222a-c6c9-473b-a09b-df5c3e631b44", interfaceName: name,
                          interfaceIndex: index, controlID: 5, controlUnit: unit, socketDevice: device, socketInode: inode)
            }
            let value = try fixture()
            try value.validate()
            check(value.version == 1 && value.interfaceName == "utun4" && value.controlUnit == 5, "valid acquired metadata retains exact device fields")
            check(value.socketDeviceValue == 0 && value.socketInodeValue == 0, "zero Darwin socket observations remain valid numeric metadata")
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let encoded = try encoder.encode(value)
            check(try JSONDecoder().decode(Receipt.self, from: encoded) == value, "strict Codable roundtrip retains every field")
            let object = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
            check(object.count == 14 && object["deviceNumber"] == nil && object["inodeNumber"] == nil,
                  "private numeric cache never extends the fourteen-key wire schema")
            func decode(_ object: [String: Any]) throws -> Receipt {
                try JSONDecoder().decode(Receipt.self, from: JSONSerialization.data(withJSONObject: object))
            }
            func changed(_ key: String, _ replacement: Any) throws -> Receipt {
                var candidate = object; candidate[key] = replacement; return try decode(candidate)
            }
            let maximum = try fixture(name: "utun4294967294", index: UInt32.max, unit: UInt32.max,
                                      device: String(UInt64.max), inode: String(UInt64.max), uid: UInt32.max)
            check(maximum.socketDeviceValue == UInt64.max && maximum.socketInodeValue == UInt64.max,
                  "complete unsigned socket range is retained without floating-point conversion")
            check(try JSONDecoder().decode(Receipt.self, from: encoder.encode(maximum)) == maximum,
                  "UInt32 and UInt64 boundary metadata roundtrips without narrowing")
            check(try fixture(name: "utun0", index: 1, unit: 1).controlUnit == 1, "allocated utun0 is distinct from the automatic request name")
            for decimal in ["0", "1", "18446744073709551615"] {
                check(try fixture(device: decimal, inode: decimal).socketDevice == decimal, "canonical decimal \(decimal) is preserved")
            }
            for field in ["installationRevision", "evidenceSHA256", "runtimeConfigurationSHA256"] {
                for invalid in ["", String(repeating: "a", count: 63), String(repeating: "a", count: 65),
                                String(repeating: "A", count: 64), String(repeating: "g", count: 64), String(repeating: "０", count: 64)] {
                    rejects("\(field) rejects invalid digest \(invalid.utf8.count)-byte shape") { _ = try changed(field, invalid) }
                }
            }
            for field in ["planID", "sessionID", "deviceID"] {
                let valid = object[field] as! String
                for invalid in ["", valid.uppercased(), valid.replacingOccurrences(of: "-", with: ""), "{" + valid + "}", valid + " ", valid + "\0"] {
                    rejects("\(field) requires a canonical lower-case UUID") { _ = try changed(field, invalid) }
                }
            }
            for name in ["", "utun", "UTUN4", "en0", "utun04", "utun-1", "utun+4", "utun4 ", "utun4\0", "utun4294967295", "utun99999999999999999999"] {
                rejects("invalid observed interface name \(name.debugDescription) cannot become acquired identity") { _ = try changed("interfaceName", name) }
            }
            rejects("unit must equal interface suffix plus one") { _ = try fixture(unit: 6) }
            rejects("zero observed index refuses") { _ = try fixture(index: 0) }
            rejects("root UID cannot be the ordinary client") { _ = try fixture(uid: 0) }
            rejects("zero controller ID refuses") { _ = try changed("controlID", 0) }
            rejects("zero allocated unit refuses") { _ = try changed("controlUnit", 0) }
            for field in ["socketDevice", "socketInode"] {
                for invalid in ["", "00", "01", "+1", "-1", " 1", "1 ", "1\n", "1\0", "1.0", "1e1", "18446744073709551616", "１２"] {
                    rejects("\(field) rejects noncanonical/overflow decimal \(invalid.debugDescription)") { _ = try changed(field, invalid) }
                }
                rejects("\(field) must be an exact decimal string rather than JSON number") { _ = try changed(field, NSNumber(value: UInt64.max)) }
            }
            for field in ["version", "clientUID", "interfaceIndex", "controlID", "controlUnit"] {
                for invalid: Any in [-1, NSNumber(value: UInt64(UInt32.max) + 1), 1.5, true, "1", NSNull()] {
                    rejects("\(field) rejects wrong numeric type or out-of-range value") { _ = try changed(field, invalid) }
                }
            }
            for version in [0, 2, UInt32.max] {
                rejects("only receipt version one is supported") { _ = try changed("version", version) }
            }
            for field in object.keys.sorted() {
                var missing = object; missing.removeValue(forKey: field)
                rejects("required field \(field) cannot be omitted") { _ = try decode(missing) }
                rejects("required field \(field) cannot be null") { _ = try changed(field, NSNull()) }
            }
            for field in ["ready", "active", "protectionVerified", "descriptor", "path", "pid", "deviceNumber"] {
                var extra = object; extra[field] = false
                rejects("unknown field \(field) cannot smuggle additional authority") { _ = try decode(extra) }
            }
            rejects("receipt root must be an object") { _ = try JSONDecoder().decode(Receipt.self, from: Data("[]".utf8)) }
            check(try fixture(device: "1") != value && fixture(inode: "1") != value,
                  "socket observations participate in exact receipt equality")
        } catch { rows.append(["name": "unexpected fixture failure", "passed": false, "error": String(describing: error)]) }
        let failures = rows.filter { ($0["passed"] as? Bool) != true }.count
        let report: [String: Any] = ["passed": failures == 0, "checksPassed": rows.count - failures, "checksTotal": rows.count,
            "actualTunCreated": false, "descriptorTransferred": false, "systemConfigurationChanged": false,
            "actualTunAccepted": false, "checks": rows]
        print(String(decoding: try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failures > 0 { exit(1) }
    }
}
