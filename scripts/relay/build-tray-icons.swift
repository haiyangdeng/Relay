import AppKit

// Rasterize the existing editable Relay vector; never recolor bitmap artwork.
let project = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let base = try String(contentsOf: project.appendingPathComponent("resources/relay-tray.svg"), encoding: .utf8)
let variants = [("template", "#ffffff", "#ffffff", "0.5"),
                ("blue", "#ffffff", "#1685ff", "1"), ("green", "#ffffff", "#29b96f", "1"), ("red", "#ffffff", "#f34e5b", "1"),
                ("blue-dark", "#15171c", "#1685ff", "1"), ("green-dark", "#15171c", "#29b96f", "1"), ("red-dark", "#15171c", "#f34e5b", "1")]
func artwork(_ body: String, _ dot: String, _ opacity: String, pixels: Int = 54) throws -> NSImage {
    // Give AppKit the actual raster size; the source remains an editable
    // compound vector path rather than a small cached SVG mask bitmap.
    let svg = base.replacingOccurrences(of: "width=\"72\" height=\"72\"", with: "width=\"\(pixels)\" height=\"\(pixels)\"")
        .replacingOccurrences(of: "id=\"mascot\" fill=\"#ffffff\"", with: "id=\"mascot\" fill=\"\(body)\"")
        .replacingOccurrences(of: "r=\"2.5\" fill=\"#ffffff\" opacity=\"0.5\"", with: "r=\"2.5\" fill=\"\(dot)\" opacity=\"\(opacity)\"")
    guard let image = NSImage(data: Data(svg.utf8)) else { throw CocoaError(.fileReadCorruptFile) }
    return image
}
func canvas(_ width: Int, _ height: Int, draw: () throws -> Void) throws -> Data {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { throw CocoaError(.coderInvalidValue) }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    try draw()
    guard let bytes = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    return bytes
}
for (name, body, dot, opacity) in variants {
    let image = try artwork(body, dot, opacity)
    let png = try canvas(54, 54) { image.draw(in: NSRect(x: 0, y: 0, width: 54, height: 54)) }
    try png.write(to: project.appendingPathComponent("resources/relay-tray-\(name).png"))
}
// Optional offline review sheet. It never opens the native tray or an App.
if CommandLine.arguments.count == 2 {
    let preview = try canvas(720, 300) {
        NSColor(calibratedWhite: 0.10, alpha: 1).setFill(); NSRect(x: 0, y: 150, width: 720, height: 150).fill()
        NSColor(calibratedWhite: 0.95, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: 720, height: 150).fill()
        for (index, variant) in variants.prefix(4).enumerated() {
            let x = CGFloat(40 + index * 175)
            for dark in [false, true] {
                let y: CGFloat = dark ? 192 : 42
                let foreground = dark ? "#ffffff" : "#15171c"
                let dot = index == 0 ? foreground : variant.2
                let image = try artwork(foreground, dot, variant.3, pixels: 64)
                let actualSize = try artwork(foreground, dot, variant.3, pixels: 18)
                image.draw(in: NSRect(x: x, y: y, width: 64, height: 64))
                actualSize.draw(in: NSRect(x: x + 88, y: y + 22, width: 18, height: 18))
                ("\(variant.0) · 18 pt" as NSString).draw(at: NSPoint(x: x, y: y - 24), withAttributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: dark ? NSColor.white : NSColor.black])
            }
        }
    }
    try preview.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
}
