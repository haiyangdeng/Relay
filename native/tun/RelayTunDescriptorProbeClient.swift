import Foundation
import Darwin

/// Child of the separately approved device fixture, running as the build user.
/// It observes FD3 only: no packet read/write, core, Mach or system mutation.
@main struct RelayTunDescriptorProbeClient {
    private static func descriptors() -> Set<Int32> {
        Set((0...1024).map(Int32.init).filter { fcntl($0, F_GETFD) >= 0 })
    }
    private static func admit(_ receipt: RelayTunAcquiredReceipt) throws {
        let descriptor = try RelayTunDescriptor.validateLive(3, receipt: receipt)
        withExtendedLifetime(descriptor) { }
    }
    static func main() {
        guard CommandLine.arguments.dropFirst().elementsEqual(["--admit-received-device"]),
              getuid() > 0, geteuid() == getuid(), getgid() == getegid() else { exit(77) }
        var originalOpen = fcntl(3, F_GETFD) >= 0
        defer { if originalOpen { Darwin.close(3) } }
        do {
            var input = Data()
            while true {
                guard let block = try FileHandle.standardInput.read(upToCount: 4097 - input.count) else { break }
                if block.isEmpty { break }
                input.append(block)
                guard input.count <= 4096 else { throw RelayTunAcquiredReceipt.Failure.invalid }
            }
            _ = try RelayTunStrictJSON.object(input, limit: 4096)
            let receipt = try JSONDecoder().decode(RelayTunAcquiredReceipt.self, from: input)
            guard receipt.clientUID == getuid(), originalOpen else { throw RelayTunAcquiredReceipt.Failure.invalid }
            let before = descriptors()
            try admit(receipt)
            guard descriptors() == before else { throw RelayTunAcquiredReceipt.Failure.invalid }
            let closed = Darwin.close(3); originalOpen = false
            guard closed == 0, fcntl(3, F_GETFD) == -1, errno == EBADF else { throw RelayTunAcquiredReceipt.Failure.invalid }
            print("{\"version\":1,\"receiptBindingValidated\":true,\"ordinaryUID\":true,\"FDClosed\":true,\"actualTunAccepted\":false}")
        } catch {
            FileHandle.standardError.write(Data("Received descriptor was not admitted; no forwarding or network configuration was attempted.\n".utf8))
            exit(1)
        }
    }
}
