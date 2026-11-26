//  The logos of the cloud drives Lasso connects to, drawn in their own colours,
//  so Google Drive, OneDrive, Dropbox and iCloud Drive read as those services and never as
//  folders. Each is drawn from simple shapes in a unit square; a symbol name of
//  the form "logo:<provider>" stands for one wherever Lasso draws a symbol.

import AppKit
import SwiftUI

enum ConnectorLogo {
    static let prefix = "logo:"

    /// The providers that have a logo of their own.
    static let providers: Set<String> = ["google-drive", "onedrive", "dropbox", "icloud"]

    /// The symbol name that stands for a provider's logo, or nil when it has none.
    static func symbolName(for provider: String?) -> String? {
        guard let provider, providers.contains(provider) else { return nil }
        return prefix + provider
    }

    /// The provider a "logo:" symbol name stands for.
    static func provider(inSymbol name: String) -> String? {
        guard name.hasPrefix(prefix) else { return nil }
        let provider = String(name.dropFirst(prefix.count))
        return providers.contains(provider) ? provider : nil
    }

    private static var cache: [String: NSImage] = [:]

    /// The logo at `size` points square, kept in its colours (never a template).
    static func image(for provider: String, size: CGFloat = 16) -> NSImage? {
        guard providers.contains(provider) else { return nil }
        let key = "\(provider)@\(size)"
        if let cached = cache[key] { return cached }
        let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
            draw(provider, in: rect)
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = name(of: provider)
        cache[key] = image
        return image
    }

    /// A symbol name's image for an AppKit menu: the logo, or the SF Symbol.
    static func menuImage(symbol: String, size: CGFloat = 16) -> NSImage? {
        if let provider = provider(inSymbol: symbol) { return image(for: provider, size: size) }
        return NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
    }

    private static func name(of provider: String) -> String {
        switch provider {
        case "google-drive": return "Google Drive"
        case "onedrive": return "OneDrive"
        case "icloud": return "iCloud Drive"
        default: return "Dropbox"
        }
    }

    // MARK: Drawing

    private static func color(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// A closed shape through points given in the unit square.
    private static func polygon(_ points: [(CGFloat, CGFloat)], in rect: NSRect) -> NSBezierPath {
        let path = NSBezierPath()
        for (index, point) in points.enumerated() {
            let place = NSPoint(x: rect.minX + point.0 * rect.width, y: rect.minY + point.1 * rect.height)
            if index == 0 { path.move(to: place) } else { path.line(to: place) }
        }
        path.close()
        return path
    }

    private static func draw(_ provider: String, in rect: NSRect) {
        switch provider {
        case "google-drive": drawDrive(in: rect)
        case "onedrive": drawOneDrive(in: rect)
        case "icloud": drawICloud(in: rect)
        default: drawDropbox(in: rect)
        }
    }

    /// Three bands that meet in a triangle: green on the left, yellow on the right, blue along the foot.
    private static func drawDrive(in rect: NSRect) {
        color(0x00AC47).setFill()
        polygon([(0.333, 0.10), (0.5, 0.39), (0.167, 0.92), (0.0, 0.64)], in: rect).fill()
        color(0x2684FC).setFill()
        polygon([(0.167, 0.92), (0.833, 0.92), (1.0, 0.64), (0.333, 0.64)], in: rect).fill()
        color(0xFFBA00).setFill()
        polygon([(0.333, 0.10), (0.667, 0.10), (1.0, 0.64), (0.667, 0.64)], in: rect).fill()
    }

    /// A blue cloud.
    private static func drawOneDrive(in rect: NSRect) {
        let scale = rect.width
        let circle = { (x: CGFloat, y: CGFloat, radius: CGFloat) -> NSBezierPath in
            NSBezierPath(ovalIn: NSRect(x: rect.minX + (x - radius) * scale, y: rect.minY + (y - radius) * scale,
                                        width: radius * 2 * scale, height: radius * 2 * scale))
        }
        color(0x0364B8).setFill()
        circle(0.58, 0.45, 0.27).fill()
        circle(0.28, 0.60, 0.18).fill()
        color(0x1490DF).setFill()
        circle(0.80, 0.62, 0.17).fill()
        NSBezierPath(roundedRect: NSRect(x: rect.minX + 0.28 * scale, y: rect.minY + 0.52 * scale,
                                         width: 0.52 * scale, height: 0.27 * scale),
                     xRadius: 0.05 * scale, yRadius: 0.05 * scale).fill()
        circle(0.58, 0.47, 0.22).fill()
    }

    /// One cloud, sky blue at the top deepening to blue at its foot.
    private static func drawICloud(in rect: NSRect) {
        let scale = rect.width
        let cloud = NSBezierPath()
        for (x, y, radius) in [(0.31, 0.58, 0.17), (0.52, 0.45, 0.25), (0.73, 0.58, 0.17)] as [(CGFloat, CGFloat, CGFloat)] {
            cloud.append(NSBezierPath(ovalIn: NSRect(x: rect.minX + (x - radius) * scale, y: rect.minY + (y - radius) * scale,
                                                     width: radius * 2 * scale, height: radius * 2 * scale)))
        }
        cloud.append(NSBezierPath(rect: NSRect(x: rect.minX + 0.31 * scale, y: rect.minY + 0.55 * scale,
                                               width: 0.42 * scale, height: 0.20 * scale)))
        NSGradient(starting: color(0x5AC8FA), ending: color(0x0A84FF))?.draw(in: cloud, angle: 90)
    }

    /// Five blue diamonds: two pairs above, one at the foot.
    private static func drawDropbox(in rect: NSRect) {
        color(0x0061FE).setFill()
        let diamond = { (x: CGFloat, y: CGFloat) -> NSBezierPath in
            polygon([(x, y - 0.13), (x + 0.21, y), (x, y + 0.13), (x - 0.21, y)], in: rect)
        }
        for (x, y) in [(0.27, 0.22), (0.73, 0.22), (0.27, 0.50), (0.73, 0.50)] { diamond(x, y).fill() }
        polygon([(0.5, 0.66), (0.71, 0.79), (0.5, 0.92), (0.29, 0.79)], in: rect).fill()
    }
}

/// A cloud drive's logo in SwiftUI, for the views that draw symbols by name.
struct ConnectorLogoView: View {
    let provider: String
    let size: CGFloat

    var body: some View {
        if let image = ConnectorLogo.image(for: provider, size: size) {
            Image(nsImage: image).resizable().interpolation(.high).frame(width: size, height: size)
        }
    }
}
