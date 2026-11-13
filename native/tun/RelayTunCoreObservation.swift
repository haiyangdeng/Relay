import Foundation
import CoreFoundation
import Security

/// Bounded reverse observation contract. The production XPC listener installs
/// it only on the same code/UID-authenticated connection that acquires the FD.
/// The wire codec itself never establishes identity or accepts a ready claim.
@objc protocol RelayTunCoreObservationChannel {
    func query(_ request: NSData, withReply reply: @escaping (NSData) -> Void)
}

enum RelayTunCoreObservation {
    enum Failure: Error { case invalid, binding, deadline, busy, unavailable }
    enum Operation: String { case runtime, released }
    enum Result: Equatable { case runtime(String?), released(Bool) }
    static let maximumBytes = 8192
    private static let baseKeys: Set<String> = ["version", "operation", "nonce", "receipt"]
    static func nonce(_ raw: Any?) -> String? {
        guard let value = raw as? String, value.utf8.count == 64,
              value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return value
    }
    static func randomNonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure.unavailable }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
    static func receiptObject(_ receipt: RelayTunAcquiredReceipt) throws -> [String: Any] {
        try RelayTunStrictJSON.object(JSONEncoder().encode(receipt), limit: maximumBytes)
    }
    static func receipt(_ raw: Any?) throws -> RelayTunAcquiredReceipt {
        guard let object = raw as? [String: Any] else { throw Failure.invalid }
        return try JSONDecoder().decode(RelayTunAcquiredReceipt.self, from: JSONSerialization.data(withJSONObject: object))
    }
    static func request(receipt: RelayTunAcquiredReceipt, operation: Operation, nonce: String) throws -> Data {
        guard Self.nonce(nonce) != nil else { throw Failure.invalid }
        return try encode(["version": 1, "operation": operation.rawValue, "nonce": nonce, "receipt": receiptObject(receipt)])
    }
    static func decodeRequest(_ data: Data) throws -> (RelayTunAcquiredReceipt, Operation, String) {
        let object = try RelayTunStrictJSON.object(data, limit: maximumBytes)
        guard Set(object.keys) == baseKeys, RelayTunStrictJSON.integer(object["version"]) == 1,
              let operation = (object["operation"] as? String).flatMap(Operation.init(rawValue:)),
              let nonce = nonce(object["nonce"]) else { throw Failure.invalid }
        return (try receipt(object["receipt"]), operation, nonce)
    }
    static func response(receipt: RelayTunAcquiredReceipt, operation: Operation, nonce: String,
                         result: Result?, available: Bool) throws -> Data {
        var object: [String: Any] = ["version": 1, "operation": operation.rawValue, "nonce": nonce,
                                   "receipt": try receiptObject(receipt), "status": available ? "observed" : "unavailable"]
        switch operation {
        case .runtime:
            if case .runtime(let digest) = result, available, let digest { object["runtimeConfigurationSHA256"] = digest }
            else { object["runtimeConfigurationSHA256"] = NSNull() }
        case .released:
            if case .released(let released) = result, available { object["released"] = released }
            else { object["released"] = false }
        }
        return try encode(object)
    }
    static func decodeResponse(_ data: Data, receipt expected: RelayTunAcquiredReceipt,
                               operation: Operation, nonce: String) throws -> Result {
        let object = try RelayTunStrictJSON.object(data, limit: maximumBytes)
        let extra = operation == .runtime ? "runtimeConfigurationSHA256" : "released"
        guard Set(object.keys) == baseKeys.union(["status", extra]), RelayTunStrictJSON.integer(object["version"]) == 1,
              object["operation"] as? String == operation.rawValue, object["nonce"] as? String == nonce,
              try receipt(object["receipt"]) == expected,
              let status = object["status"] as? String, ["observed", "unavailable"].contains(status) else { throw Failure.binding }
        if operation == .runtime {
            if status == "unavailable" {
                guard object[extra] is NSNull else { throw Failure.invalid }; return .runtime(nil)
            }
            guard let digest = object[extra] as? String, digest == expected.runtimeConfigurationSHA256 else { throw Failure.binding }
            return .runtime(digest)
        }
        guard let number = object[extra] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID(),
              status != "unavailable" || !number.boolValue else { throw Failure.invalid }
        return .released(number.boolValue)
    }
    private static func encode(_ object: [String: Any]) throws -> Data {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard data.count <= maximumBytes else { throw Failure.invalid }; return data
    }
}

/// One observer belongs to one authenticated callback connection.
/// A failed/ambiguous exchange invalidates it; callers must obtain a new real
/// connection rather than silently retrying a blocked transport or stale nonce.
final class RelayTunCoreObserver {
    typealias Query = (NSData, @escaping (NSData) -> Void) -> Void
    private let transport: Query
    private let verifyLocalTrust: () throws -> Void
    private let nonce: () throws -> String
    private let timeoutMilliseconds: Int
    private let queue = DispatchQueue(label: "local.relay.tun.core-observation")
    private let lock = NSLock()
    private var busy = false, invalidated = false
    private var nonces = Set<String>()
    init(timeoutMilliseconds: Int = 1000, nonce: @escaping () throws -> String = RelayTunCoreObservation.randomNonce,
         verifyLocalTrust: @escaping () throws -> Void = {}, query: @escaping Query) throws {
        guard (1...5000).contains(timeoutMilliseconds) else { throw RelayTunCoreObservation.Failure.invalid }
        self.timeoutMilliseconds = timeoutMilliseconds; self.nonce = nonce; self.verifyLocalTrust = verifyLocalTrust; transport = query
    }
    private final class Attempt {
        let done = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var count = 0, returned = false, retired = false
        private var bytes: Data?
        func receive(_ data: NSData) {
            lock.lock(); defer { lock.unlock() }; guard !retired else { return }
            count += 1
            if count == 1, data.length > 0, data.length <= RelayTunCoreObservation.maximumBytes {
                bytes = Data(bytes: data.bytes, count: data.length)
            } else { bytes = nil }
            if returned { done.signal() }
        }
        func invocationReturned() {
            lock.lock(); defer { lock.unlock() }; guard !retired else { return }
            returned = true; if count > 0 { done.signal() }
        }
        func finish() throws -> Data {
            lock.lock(); defer { lock.unlock() }; retired = true
            guard returned, count == 1, let bytes else { throw RelayTunCoreObservation.Failure.invalid }; return bytes
        }
        func cancel() { lock.lock(); retired = true; bytes = nil; lock.unlock() }
    }
    func query(_ receipt: RelayTunAcquiredReceipt, operation: RelayTunCoreObservation.Operation) throws -> RelayTunCoreObservation.Result {
        lock.lock()
        guard !busy, !invalidated else { lock.unlock(); throw RelayTunCoreObservation.Failure.busy }
        busy = true; lock.unlock()
        defer { lock.lock(); busy = false; lock.unlock() }
        do {
            try receipt.validate()
            // Complete local installation/signature verification before timing
            // the remote response. It still runs for every query and can deny
            // the exchange before any callback is sent.
            try verifyLocalTrust()
            let value = try nonce()
            guard RelayTunCoreObservation.nonce(value) != nil, nonces.count < 4096, nonces.insert(value).inserted else {
                throw RelayTunCoreObservation.Failure.invalid
            }
            let bytes = try RelayTunCoreObservation.request(receipt: receipt, operation: operation, nonce: value)
            let attempt = Attempt(), transport = self.transport
            queue.async {
                transport(bytes as NSData, attempt.receive)
                attempt.invocationReturned()
            }
            guard attempt.done.wait(timeout: .now() + .milliseconds(timeoutMilliseconds)) == .success else {
                attempt.cancel(); throw RelayTunCoreObservation.Failure.deadline
            }
            return try RelayTunCoreObservation.decodeResponse(attempt.finish(), receipt: receipt, operation: operation, nonce: value)
        } catch {
            lock.lock(); invalidated = true; lock.unlock(); throw error
        }
    }
    func runtime(_ receipt: RelayTunAcquiredReceipt) -> String? {
        if case .runtime(let digest) = try? query(receipt, operation: .runtime) { return digest }; return nil
    }
    func released(_ receipt: RelayTunAcquiredReceipt) -> Bool {
        if case .released(let value) = try? query(receipt, operation: .released) { return value }; return false
    }
}
