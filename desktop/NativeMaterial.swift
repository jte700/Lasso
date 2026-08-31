// Semantic AppKit materials shared by the main window and floating surfaces.
// macOS 26 receives the system Liquid Glass implementation. Older systems use
// the equivalent semantic vibrancy material instead of a hard-coded blur.

import Cocoa

enum NativeMaterial {
    static func materialContainer(
        content: NSView,
        material: NSVisualEffectView.Material,
        blendingMode: NSVisualEffectView.BlendingMode = .behindWindow,
        cornerRadius: CGFloat = 0
    ) -> NSView {
        let effect = NSVisualEffectView(frame: content.frame)
        effect.material = material
        effect.blendingMode = blendingMode
        effect.state = .followsWindowActiveState
        effect.wantsLayer = true
        effect.layer?.cornerRadius = cornerRadius
        effect.layer?.masksToBounds = cornerRadius > 0
        embed(content, in: effect)
        return effect
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
