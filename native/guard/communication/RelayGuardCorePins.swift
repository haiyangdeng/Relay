import Foundation

// Generated from the existing fixed bundled-Core manifest by the guard source
// preparer. The guard build verifies these inputs; it does not adopt an update,
// arbitrary executable path or renderer-provided digest as trusted Core code.
enum RelayGuardCorePins {
    struct Pin { let sha256: String; let size: Int }
    private static let pins: [String: Pin] = [
        "darwin-arm64/mihomo": Pin(sha256: "f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9", size: 56810034),
        "darwin-x64/mihomo": Pin(sha256: "291f5923c3dd3b8df36eaeccdd59eaf873ee021693cde65eb696f8b86ac99652", size: 60945968)
    ]
    static func resources(root: URL) -> [String: Pin] {
        Dictionary(uniqueKeysWithValues: pins.map { (root.appendingPathComponent("core/" + $0.key).path, $0.value) })
    }
    static func accepts(executable: String, sha256: String) -> Bool {
        guard executable.hasPrefix("/"), !executable.contains("\0") else { return false }
        return pins.contains { executable.hasSuffix(".app/Contents/Resources/relay/core/" + $0.key) && sha256 == $0.value.sha256 }
    }
}
