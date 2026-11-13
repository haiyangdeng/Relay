import CryptoKit
import Darwin
import Dispatch
import EndpointSecurity
import Foundation

/// A positive witness for one directly executed, authenticated npm script.
/// It describes the ES script vnode at this observation. It does not bind a
/// later interpreter read, preload, import or evaluated source to these bytes.
enum RelayGuardOfficialScript {
    private static let expectedSize: off_t = 13_468_528
    private static let expectedSHA256 = "d490cc3e923832683cd899cce6375cb9b3ce734bc72321d0bfea43470d5799be"

    static func matches(_ script: UnsafePointer<es_file_t>?) -> Bool {
        guard let script else { return false }
        let file = script.pointee
        guard !file.path_truncated, file.path.length > 0, file.path.length <= 16_384,
              let path = file.path.data, isCandidate(file.stat) else { return false }

        // Keep the kernel's exact filesystem bytes. Do not decode or normalize
        // them, or read beyond the token's declared length for a terminator.
        var terminatedPath = Array(UnsafeBufferPointer(start: path, count: file.path.length))
        guard terminatedPath.first == CChar(47), !terminatedPath.contains(0) else { return false }
        terminatedPath.append(0)

        // Adapted from Santa d59f6b134323a940686c1b3135c5990ea93efd3d,
        // SNTFileInfo's ES-stat / single-FD / bounded-pread hash chain. This
        // observer additionally rejects every symlink component and timestamp
        // changes. A pre-open stat alone cannot close a parent-symlink race.
        let deadline = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
        var pathBefore = stat()
        let inspected = terminatedPath.withUnsafeBufferPointer {
            Darwin.lstat($0.baseAddress!, &pathBefore)
        }
        guard inspected == 0, sameFile(file.stat, pathBefore),
              DispatchTime.now().uptimeNanoseconds < deadline else { return false }
        let descriptor = terminatedPath.withUnsafeBufferPointer {
            Darwin.open($0.baseAddress!, O_RDONLY | O_CLOEXEC | O_NOFOLLOW_ANY | O_NONBLOCK)
        }
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }

        var before = stat()
        guard fstat(descriptor, &before) == 0, sameFile(file.stat, before) else { return false }

        var hash = SHA256()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        var offset: off_t = 0
        var interruptedReads = 0
        while offset < expectedSize {
            guard DispatchTime.now().uptimeNanoseconds < deadline else { return false }
            let requested = min(buffer.count, Int(expectedSize - offset))
            let count = buffer.withUnsafeMutableBytes {
                Darwin.pread(descriptor, $0.baseAddress!, requested, offset)
            }
            if count == -1 && errno == EINTR {
                interruptedReads += 1
                guard interruptedReads <= 8 else { return false }
                continue
            }
            guard count > 0, count <= requested else { return false }
            hash.update(data: Data(buffer.prefix(count)))
            offset += off_t(count)
        }

        var extra: UInt8 = 0
        guard DispatchTime.now().uptimeNanoseconds < deadline,
              Darwin.pread(descriptor, &extra, 1, expectedSize) == 0 else { return false }
        var after = stat()
        guard fstat(descriptor, &after) == 0, sameFile(before, after),
              DispatchTime.now().uptimeNanoseconds < deadline else { return false }
        return hash.finalize().map { String(format: "%02x", $0) }.joined() == expectedSHA256
    }

    private static func isCandidate(_ value: stat) -> Bool {
        value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && value.st_size == expectedSize
    }

    private static func sameFile(_ expected: stat, _ actual: stat) -> Bool {
        isCandidate(expected) && isCandidate(actual)
            && expected.st_dev == actual.st_dev && expected.st_ino == actual.st_ino
            && expected.st_size == actual.st_size && expected.st_mode == actual.st_mode
            && expected.st_uid == actual.st_uid && expected.st_gid == actual.st_gid
            && expected.st_nlink == actual.st_nlink
            && expected.st_mtimespec.tv_sec == actual.st_mtimespec.tv_sec
            && expected.st_mtimespec.tv_nsec == actual.st_mtimespec.tv_nsec
            && expected.st_ctimespec.tv_sec == actual.st_ctimespec.tv_sec
            && expected.st_ctimespec.tv_nsec == actual.st_ctimespec.tv_nsec
    }
}
