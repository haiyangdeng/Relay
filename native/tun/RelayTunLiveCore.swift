import Foundation
import Darwin

/// Composition for an authenticated acquisition already held by the ordinary
/// user. Construction is inert. The session must register/retain this owner
/// before calling its host.start(), including when preparation subsequently
/// fails. No JSON entry, executable selection or historic PID is accepted.
/// Directory/config/assets are staged privately by the owning session; its
/// verifyBundle closure must recheck the original complete checked snapshot.
final class RelayTunLiveCore {
    enum Failure: Error { case invalid, binding, revoked, state, unverified }
    let binding: RelayTunCoreHost.Binding
    private let delivered: FileHandle
    private let configuration: Data
    private let directory: String
    private let verifyBundle: () throws -> Void
    private let authorization: () -> Bool
    private let readiness: RelayTunCoreReadiness
    private var admitted: RelayTunDescriptor.LiveDescriptor?
    private var child: RelayTunOwnedChild?
    private var sourceClosed = false
    private var sourceCloseAttempted = false
    private var liveReadiness: RelayTunCoreReadiness.Live?
    private var firstRead = true
    private(set) var startReadinessFailure: String?
    private var hostCreated = false
    private let hostLock = NSLock()
    private let revocationLock = NSLock()
    private var revoked = false
    private func authorized() -> Bool {
        revocationLock.lock(); let active = !revoked; revocationLock.unlock()
        return active && authorization()
    }
    private func revoke() { revocationLock.lock(); revoked = true; revocationLock.unlock() }
    private static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unsupported"
        #endif
    }
    init(receipt: RelayTunAcquiredReceipt, delivered: FileHandle, configuration: Data,
         directory: String, managedMTU: Int, authorization: @escaping () -> Bool,
         verifyBundle: @escaping () throws -> Void) throws {
        guard let pin = RelayTunInstallationPaths.fixedCorePins[Self.architecture] else { throw Failure.invalid }
        let binding = try RelayTunCoreHost.Binding(receipt: receipt, coreSHA256: pin.0)
        readiness = try .init(binding: binding, configuration: configuration, managedMTU: managedMTU)
        self.binding = binding; self.delivered = delivered; self.configuration = configuration
        self.directory = directory; self.authorization = authorization; self.verifyBundle = verifyBundle
    }
    private func verifyResource(_ expected: RelayTunCoreHost.Binding) throws {
        guard expected == binding, RelayTunCoreHost.productionOrdinaryUID() == binding.receipt.clientUID else { throw Failure.binding }
        guard authorized() else { throw Failure.revoked }
        let trust = try RelayTunInstallationTrust.load()
        guard trust.revision == binding.receipt.installationRevision, trust.clientUID == binding.receipt.clientUID,
              trust.coreSHA256[Self.architecture] == binding.coreSHA256 else { throw Failure.binding }
    }
    private func closeSource() throws -> Bool {
        if sourceClosed { return true }
        guard !sourceCloseAttempted else { throw Failure.unverified }
        sourceCloseAttempted = true
        try delivered.close(); sourceClosed = true
        return true
    }
    private func verifyLaunch() throws {
        guard authorized() else { throw Failure.revoked }
        try verifyResource(binding)
        try verifyBundle()
        guard authorized(), let admitted else { throw Failure.revoked }
        try RelayTunDescriptor.verifyLive(admitted, receipt: binding.receipt)
        let original = try RelayTunDescriptor.validateLive(delivered.fileDescriptor, receipt: binding.receipt)
        try original.close()
    }
    private func observe(_ child: RelayTunOwnedChild) throws -> RelayTunCoreHost.RuntimeObservation? {
        if liveReadiness == nil {
            liveReadiness = try readiness.live(directory: directory, verifyPeer: { try child.verifyPeer(socket: $0) })
        }
        guard let source = liveReadiness else { throw Failure.state }
        let deadline = DispatchTime.now().uptimeNanoseconds + (firstRead ? 5_000_000_000 : 0)
        repeat {
            startReadinessFailure = nil
            do {
                let observation = try readiness.observe(read: { try source.read($0) }, verify: {
                    try self.verifyLaunch(); try source.verifySource()
                    guard case .running = try child.observe() else { throw Failure.unverified }
                })
                firstRead = false
                startReadinessFailure = nil
                return observation
            } catch let error as RelayTunCoreReadiness.Failure {
                // Failure is a fixed enum; no configuration, paths or raw OS
                // error descriptions enter the diagnostic channel.
                startReadinessFailure = error.diagnosticCode
                // Only readiness reads may wait for the just-spawned socket.
                // No mutation/spawn is repeated, and revoked/resource/identity
                // failures are never converted into a ready observation.
                guard error.allowsStartupRetry else { throw error }
                guard firstRead, authorized(),
                      case .running = try child.observe(), DispatchTime.now().uptimeNanoseconds < deadline else { throw error }
                usleep(10000)
            }
        } while true
    }
    func makeHost() throws -> RelayTunCoreHost {
        hostLock.lock(); defer { hostLock.unlock() }
        guard !hostCreated else { throw Failure.state }
        hostCreated = true
        return try RelayTunCoreHost(binding: binding, configuration: configuration,
            driver: .init(ordinaryUID: RelayTunCoreHost.productionOrdinaryUID,
                verifyResource: { try self.verifyResource($0) },
                admit: { expected in
                    guard expected == self.binding, self.admitted == nil, self.authorized() else { throw Failure.state }
                    self.admitted = try RelayTunDescriptor.validateLive(self.delivered.fileDescriptor, receipt: self.binding.receipt)
                    return .init(verify: {
                        guard let held = self.admitted else { throw Failure.state }
                        try RelayTunDescriptor.verifyLive(held, receipt: self.binding.receipt)
                        return self.binding.receipt
                    }, launch: { bound, bytes, register in
                        guard bound == self.binding, bytes == self.configuration, self.child == nil,
                              let held = self.admitted, let executable = RelayTunInstallationPaths.cores[Self.architecture] else { throw Failure.binding }
                        _ = try RelayTunOwnedChild.spawn(descriptor: held,
                            launch: .init(executable: executable, directory: self.directory),
                            verify: { try self.verifyLaunch() }, register: { owned in
                                self.child = owned
                                register(.owned(owned, readiness: { try self.observe(owned) }))
                            })
                    }, spawnAbsent: { self.child == nil }, close: {
                        guard let held = self.admitted else { throw Failure.state }
                        try held.close()
                        guard try self.closeSource() else { throw Failure.unverified }
                    }, closed: {
                        self.sourceClosed && self.admitted?.closureVerified == true
                    })
                }, releaseUnadmitted: {
                    guard self.admitted == nil, self.child == nil else { throw Failure.state }
                    return try self.closeSource()
                }, revoke: { self.revoke() }))
    }
}
