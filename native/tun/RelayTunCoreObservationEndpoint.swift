import Foundation

/// Binding is derived from the held host itself, never independently paired
/// with a caller-selected receipt. runtimeConfigurationSHA256 identifies the
/// held host's exact launch bytes with fresh child/FD/readiness observations;
/// it does not attest every field of the core's mutable in-memory state.
final class RelayTunCoreObservationEndpoint: NSObject, RelayTunCoreObservationChannel {
    private let host: RelayTunCoreHost
    init(host: RelayTunCoreHost) { self.host = host }
    func query(_ request: NSData, withReply reply: @escaping (NSData) -> Void) {
        guard request.length > 0, request.length <= RelayTunCoreObservation.maximumBytes else { reply(NSData()); return }
        do {
            let data = Data(bytes: request.bytes, count: request.length)
            let (receipt, operation, nonce) = try RelayTunCoreObservation.decodeRequest(data)
            let binding = host.observationBinding
            guard receipt == binding.receipt else { throw RelayTunCoreObservation.Failure.binding }
            let result: RelayTunCoreObservation.Result?
            let available: Bool
            switch operation {
            case .runtime:
                do {
                    if let digest = try host.runtime() { result = .runtime(digest); available = true }
                    else { result = nil; available = false }
                } catch { result = nil; available = false }
            case .released: result = .released(host.released(for: binding)); available = true
            }
            reply(try RelayTunCoreObservation.response(receipt: receipt, operation: operation, nonce: nonce,
                result: result, available: available) as NSData)
        } catch { reply(NSData()) }
    }
}

