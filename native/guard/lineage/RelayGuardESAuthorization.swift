import Darwin
import Dispatch
import EndpointSecurity
import Foundation

/// One retained AUTH_EXEC and one response. An independent timer reserves
/// time before the kernel deadline while identity inspection or XPC is busy.
/// Kernel scheduling or loss of the ES component is not a closed-failure proof.
final class RelayGuardESAuthorization: @unchecked Sendable {
    struct Receipt: Sendable {
        let allowed: Bool
        let accepted: Bool
    }
    let id: UUID
    let message: UnsafePointer<es_message_t>
    let expiresMach: UInt64
    private let lock = NSLock()
    private var receipt: Receipt?
    private var timer: DispatchSourceTimer?
    private let respond: @Sendable (UnsafePointer<es_message_t>, Bool, UInt64) -> Receipt
    private let finished: @Sendable (Receipt) -> Void

    init(_ message: UnsafePointer<es_message_t>, id: UUID,
         respond: @escaping @Sendable (UnsafePointer<es_message_t>, Bool, UInt64) -> Receipt,
         finished: @escaping @Sendable (Receipt) -> Void) {
        self.message = message
        self.id = id
        self.respond = respond
        self.finished = finished
        expiresMach = Self.softDeadline(message.pointee.deadline)
        es_retain_message(message)
    }
    deinit { timer?.cancel(); es_release_message(message) }

    var result: Receipt? { lock.lock(); defer { lock.unlock() }; return receipt }

    func arm() {
        let delay = Self.nanoseconds(until: expiresMach)
        let scheduled = DispatchSource.makeTimerSource(queue: .global(qos: .userInteractive))
        scheduled.setEventHandler { [weak self] in _ = self?.finish(allow: false) }
        lock.lock()
        guard receipt == nil, timer == nil else { lock.unlock(); scheduled.cancel(); scheduled.resume(); return }
        timer = scheduled
        scheduled.schedule(deadline: .now() + .nanoseconds(Int(delay)), leeway: .milliseconds(1))
        scheduled.resume()
        lock.unlock()
    }

    @discardableResult
    func finish(allow: Bool) -> Receipt? {
        lock.lock()
        guard receipt == nil else { lock.unlock(); return nil }
        let permitted = allow && mach_absolute_time() < expiresMach
        // The responder shares the owning monitor's client-lifetime lock with
        // disposal. A late continuation cannot use a deleted ES client handle.
        let value = respond(message, permitted, expiresMach)
        receipt = value
        let scheduled = timer
        timer = nil
        lock.unlock()
        scheduled?.cancel()
        finished(value)
        return value
    }

    private static func softDeadline(_ kernelDeadline: UInt64) -> UInt64 {
        var timebase = mach_timebase_info_data_t()
        let now = mach_absolute_time()
        guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.numer > 0,
              timebase.denom > 0, kernelDeadline > now else { return now }
        let ticksPerNanosecond = Double(timebase.denom) / Double(timebase.numer)
        let reserve = UInt64((250_000_000 * ticksPerNanosecond).rounded(.up))
        let limit = UInt64((2_000_000_000 * ticksPerNanosecond).rounded(.down))
        guard kernelDeadline > reserve, kernelDeadline - reserve > now,
              now <= UInt64.max - limit else { return now }
        return min(kernelDeadline - reserve, now + limit)
    }
    private static func nanoseconds(until deadline: UInt64) -> UInt64 {
        var timebase = mach_timebase_info_data_t()
        let now = mach_absolute_time()
        guard deadline > now, mach_timebase_info(&timebase) == KERN_SUCCESS,
              timebase.numer > 0, timebase.denom > 0 else { return 0 }
        let value = Double(deadline - now) * Double(timebase.numer) / Double(timebase.denom)
        return UInt64(min(2_000_000_000, max(0, value.rounded(.down))))
    }
}
