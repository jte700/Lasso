// A picker shown in the suggestion card's own panel, which never takes the
// keyboard, so the writer's app keeps its caret. It grows down from the
// card's top edge, kept on the screen, and gives the card back when it closes.

import Cocoa

final class CardPanelTakeover {
    private(set) weak var panel: NSPanel?
    private var previousContent: NSView?
    private var previousFrame: NSRect?
    /// The gap kept between the picker and the screen's edges.
    private static let screenInset: CGFloat = 8

    /// Shows `view`, `size` at most, on the card's Liquid Glass surface.
    func present(_ view: NSView, size preferred: NSSize, in panel: NSPanel) {
        self.panel = panel
        previousContent = panel.contentView
        previousFrame = panel.frame
        let inset = Self.screenInset
        let screen = (panel.screen ?? NSScreen.main)?.visibleFrame
        var size = preferred
        if let screen {
            size.width = min(max(size.width, panel.frame.width), screen.width - inset * 2)
            size.height = min(size.height, screen.height - inset * 2)
        }
        view.frame = NSRect(origin: .zero, size: size)
        panel.contentView = ShareComposerSurface(content: view)
        var origin = NSPoint(x: panel.frame.minX, y: panel.frame.maxY - size.height)
        if let screen {
            origin.x = min(max(screen.minX + inset, origin.x), screen.maxX - size.width - inset)
            origin.y = min(max(screen.minY + inset, origin.y), screen.maxY - size.height - inset)
        }
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.invalidateShadow()
        panel.orderFrontRegardless()
    }

    /// The card comes back as it was.
    func restore() {
        if let panel {
            panel.contentView = previousContent
            if let previousFrame { panel.setFrame(previousFrame, display: true) }
            panel.contentView?.layoutSubtreeIfNeeded()
            panel.invalidateShadow()
        }
        panel = nil
        previousContent = nil
        previousFrame = nil
    }

    /// A drag on a picker's title bar moves its window, kept on the screen.
    /// The panel never takes the keyboard, so it is moved here rather than by
    /// the system's window dragging.
    static func drag(_ window: NSWindow) {
        let grabbed = NSEvent.mouseLocation
        let origin = window.frame.origin
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            let pointer = NSEvent.mouseLocation
            var frame = window.frame
            frame.origin = NSPoint(x: origin.x + pointer.x - grabbed.x, y: origin.y + pointer.y - grabbed.y)
            if let visible = (NSScreen.screens.first { $0.frame.contains(pointer) } ?? window.screen)?.visibleFrame {
                frame.origin.x = min(max(visible.minX - frame.width + 80, frame.origin.x), visible.maxX - 80)
                frame.origin.y = min(max(visible.minY, frame.origin.y), visible.maxY - frame.height)
            }
            window.setFrameOrigin(frame.origin)
            if next.type == .leftMouseUp { break }
        }
    }
}
