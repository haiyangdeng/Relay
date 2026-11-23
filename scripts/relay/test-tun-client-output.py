"""Compile only ClientMain's output helper; anonymous pipes, no inspection or TUN."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "native/tun/RelayTunClientMain.swift"
HARNESS = r'''
import Foundation
import Darwin

@main struct OutputTests {
    final class Drain: @unchecked Sendable {
        var bytes = Data()
        let done = DispatchSemaphore(value: 0)
    }
    static func require(_ condition: Bool, _ label: String) {
        if !condition {
            let message = Data(("FAIL: " + label + "\n").utf8)
            _ = message.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
            exit(2)
        }
    }
    static func pipePair() -> [Int32] {
        var pair: [Int32] = [-1, -1]
        require(pipe(&pair) == 0, "anonymous pipe")
        return pair
    }
    static func fill(_ fd: Int32) -> Int {
        let flags = fcntl(fd, F_GETFL)
        require(flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0, "fill nonblocking")
        defer { _ = fcntl(fd, F_SETFL, flags) }
        let bytes = [UInt8](repeating: 65, count: 4096)
        var count = 0
        while count < 2 * 1024 * 1024 {
            let wrote = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            if wrote > 0 { count += wrote; continue }
            require(wrote == -1 && (errno == EAGAIN || errno == EWOULDBLOCK), "pipe full")
            return count
        }
        require(false, "pipe fill bounded")
        return 0
    }
    static func expectFailure(_ expected: RelayTunClientOutput.Failure, _ body: () throws -> Void) {
        do { try body(); require(false, "failure was not reported") }
        catch let failure as RelayTunClientOutput.Failure {
            require(String(describing: failure) == String(describing: expected), "correct failure")
        } catch { require(false, "unexpected error") }
    }
    static func main() throws {
        _ = Darwin.signal(SIGPIPE, SIG_IGN)
        if CommandLine.arguments.count > 1 {
            do {
                try RelayTunClientOutput.write(Data("{\"ok\":true}\n".utf8), to: STDOUT_FILENO)
            } catch { exit(1) }
            return
        }
        let frame = Data("{\"ok\":true}\n".utf8)
        do {
            let pair = pipePair()
            defer { Darwin.close(pair[0]); Darwin.close(pair[1]) }
            let flags = fcntl(pair[1], F_GETFL)
            try RelayTunClientOutput.write(frame, to: pair[1])
            var bytes = [UInt8](repeating: 0, count: frame.count)
            require(Darwin.read(pair[0], &bytes, bytes.count) == frame.count && Data(bytes) == frame,
                    "complete JSON frame and newline")
            require(fcntl(pair[1], F_GETFL) & O_NONBLOCK == flags & O_NONBLOCK,
                    "success restores blocking mode")
        }
        do {
            let pair = pipePair()
            Darwin.close(pair[0]); defer { Darwin.close(pair[1]) }
            let flags = fcntl(pair[1], F_GETFL)
            expectFailure(.unavailable) { try RelayTunClientOutput.write(frame, to: pair[1]) }
            require(fcntl(pair[1], F_GETFL) & O_NONBLOCK == flags & O_NONBLOCK,
                    "EPIPE restores blocking mode without abort")
        }
        expectFailure(.unavailable) { try RelayTunClientOutput.write(frame, to: -1) }
        expectFailure(.invalid) { try RelayTunClientOutput.write(Data(repeating: 0, count: 32769), to: -1) }
        expectFailure(.invalid) { try RelayTunClientOutput.write(frame, to: -1, timeoutMS: 0) }
        do {
            let pair = pipePair()
            defer { Darwin.close(pair[0]); Darwin.close(pair[1]) }
            _ = fill(pair[1])
            let flags = fcntl(pair[1], F_GETFL), started = DispatchTime.now().uptimeNanoseconds
            // Repeated poll interruptions must not extend the monotonic deadline.
            _ = Darwin.signal(SIGUSR1, { _ in })
            _ = Darwin.siginterrupt(SIGUSR1, 1)
            let mainThread = pthread_self(), signalsDone = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                for _ in 0..<20 { usleep(2000); pthread_kill(mainThread, SIGUSR1) }
                signalsDone.signal()
            }
            expectFailure(.expired) { try RelayTunClientOutput.write(frame, to: pair[1], timeoutMS: 60) }
            let elapsed = DispatchTime.now().uptimeNanoseconds - started
            require(elapsed >= 60_000_000 && elapsed < 500_000_000, "full pipe deadline")
            require(fcntl(pair[1], F_GETFL) & O_NONBLOCK == flags & O_NONBLOCK,
                    "timeout restores blocking mode")
            require(signalsDone.wait(timeout: .now() + 1) == .success, "interrupt sender finished")
        }
        do {
            let pair = pipePair()
            defer { Darwin.close(pair[0]); Darwin.close(pair[1]) }
            let prefix = fill(pair[1]), payload = Data(repeating: 66, count: 32768), drain = Drain()
            DispatchQueue.global().async {
                usleep(10000)
                var chunk = [UInt8](repeating: 0, count: 257)
                while drain.bytes.count < prefix + payload.count {
                    let count = Darwin.read(pair[0], &chunk, chunk.count)
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 { break }
                    drain.bytes.append(contentsOf: chunk.prefix(count))
                }
                drain.done.signal()
            }
            try RelayTunClientOutput.write(payload, to: pair[1])
            require(drain.done.wait(timeout: .now() + 1) == .success, "partial drain finished")
            require(drain.bytes == Data(repeating: 65, count: prefix) + payload,
                    "EAGAIN and partial writes preserve exact bytes")
        }
    }
}
'''


def main():
    source = SOURCE.read_text()
    marker = "@main struct RelayTunClientMain"
    assert source.count(marker) == 1
    # Compile the actual production helper, excluding every real entry point.
    helper = source.split(marker)[0]
    assert "enum RelayTunClientOutput" in helper
    assert "FileHandle.standardOutput.write" not in source
    with tempfile.TemporaryDirectory(prefix="relay-client-output-") as directory:
        root = Path(directory)
        (root / "Output.swift").write_text(helper)
        (root / "Tests.swift").write_text(HARNESS)
        executable = root / "OutputTests"
        subprocess.run(
            ["/usr/bin/xcrun", "swiftc", "-parse-as-library", str(root / "Output.swift"),
             str(root / "Tests.swift"), "-o", str(executable)],
            check=True, capture_output=True, text=True, timeout=60,
        )
        checked = subprocess.run([str(executable)], capture_output=True, timeout=5)
        assert checked.returncode == 0, checked.stderr.decode()
        normal = subprocess.run([str(executable), "stdout"], capture_output=True, timeout=5)
        assert normal.returncode == 0 and normal.stdout == b'{"ok":true}\n'
        read_end, write_end = os.pipe()
        os.close(read_end)
        try:
            broken = subprocess.run(
                [str(executable), "stdout"], stdout=write_end,
                stderr=subprocess.PIPE, timeout=5,
            )
        finally:
            os.close(write_end)
        assert broken.returncode == 1, ("closed stdout must fail without a signal", broken.returncode)
    print("PASS: output frames, EPIPE/EBADF, limits, interrupted full-pipe deadline, partial writes")


if __name__ == "__main__":
    main()
