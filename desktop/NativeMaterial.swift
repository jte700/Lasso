// Semantic AppKit materials shared by the main window and floating surfaces.
// macOS 26 receives the system Liquid Glass implementation. Older systems use
// the equivalent semantic vibrancy material instead of a hard-coded blur.

import Cocoa

enum NativeMaterial {
    /// Whether surfaces draw as Liquid Glass: macOS 26, unless Reduce Transparency is on.
    static var usesGlass: Bool {
        guard #available(macOS 26.0, *) else { return false }
        return !NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }

    /// A wash light enough for the glass to show, and still steady under text.
    static let glassSurfaceOpacity: CGFloat = 0.1

    /// How opaque a surface drawn over the material may be. Glass reads as
    /// glass only when what sits on it is nearly clear; the earlier material
    /// keeps the stronger wash it was designed with. Reduce Transparency makes
    /// both solid. A surface that must stay steadier under text, such as a
    /// table, passes its own `glass` opacity.
    static func surfaceOpacity(classic: CGFloat, glass: CGFloat = glassSurfaceOpacity) -> CGFloat {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency { return 1 }
        return usesGlass ? glass : classic
    }

    static func glassContainer(
        content: NSView,
        cornerRadius: CGFloat,
        tint: NSColor? = nil
    ) -> NSView {
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: content.frame)
            glass.style = .regular
            glass.cornerRadius = cornerRadius
            glass.tintColor = tint
            content.frame = glass.bounds
            content.autoresizingMask = [.width, .height]
            glass.contentView = content
            return glass
        }
        let effect = NSVisualEffectView(frame: content.frame)
        effect.material = .popover
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = cornerRadius
        effect.layer?.masksToBounds = true
        embed(content, in: effect)
        return effect
    }

    private static func embed(_ content: NSView, in container: NSView) {
        content.frame = container.bounds
        content.autoresizingMask = [.width, .height]
        container.addSubview(content)
    }
}
