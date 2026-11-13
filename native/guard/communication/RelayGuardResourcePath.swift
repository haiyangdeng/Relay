import Darwin
import Foundation

// Minimal adaptation of native/RelayTunDescriptor.checkPlainPath. No privileged
// executor or filesystem mutation is linked into the Filter extension.
enum RelayGuardResourcePath {
    static func check(_ url: URL) throws {
        guard url.isFileURL, url.path.hasPrefix("/"), !url.path.utf8.contains(0) else { throw RelayGuardBindingFailure.resource }
        var cursor = url
        while cursor.path != "/" {
            var info = stat()
            guard lstat(cursor.path, &info) == 0, info.st_mode & mode_t(S_IFMT) != mode_t(S_IFLNK) else {
                throw RelayGuardBindingFailure.resource
            }
            cursor.deleteLastPathComponent()
        }
    }
}
