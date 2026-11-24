// What the menu bar panel is shown from. On a full-screen app's Space macOS
// draws a picture of the menu bar icon, not the icon's own window, so a panel
// pointed at that window can fail to appear there. The panel points at this
// invisible window over the icon instead, which joins every Space.

import Cocoa

final class StatusPopoverAnchor {
    private lazy var window: NSPanel = {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Clicks go through to the icon below.
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        return panel
    }()

    /// The view to show the panel from, placed over the icon on the Space in
    /// front. Nil when the icon has no window or no size.
    func view(over button: NSStatusBarButton) -> NSView? {
        guard let host = button.window else { return nil }
        let icon = host.convertToScreen(button.convert(button.bounds, to: nil))
        guard let frame = Self.frame(over: icon, screens: NSScreen.screens.map(\.frame)) else { return nil }
        window.setFrame(frame, display: false)
        window.orderFrontRegardless()
        return window.contentView
    }

    func hide() { window.orderOut(nil) }

    /// Whether the window server draws a window on the Space in front. AppKit's
    /// isOnActiveSpace says no for a panel showing over a full-screen app.
    static func isOnScreen(windowNumber: Int) -> Bool {
        guard windowNumber > 0,
              let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(windowNumber))
                as? [[String: Any]] else { return false }
        return info.first?[kCGWindowIsOnscreen as String] as? Bool ?? false
    }

    /// Where the anchor goes: over the icon, or, when a full-screen app has slid
    /// the menu bar up past the top of the display, at that display's top edge.
    static func frame(over icon: CGRect, screens: [CGRect]) -> CGRect? {
        guard icon.width > 0, icon.height > 0 else { return nil }
        guard let screen = screens.first(where: { $0.minX <= icon.midX && icon.midX < $0.maxX }),
              icon.maxY > screen.maxY else { return icon }
        return CGRect(x: icon.minX, y: screen.maxY - icon.height, width: icon.width, height: icon.height)
    }
}

/// A click on the menu bar icon while the panel is open closes it on the
/// mouse-down, since the icon is outside the panel; the same click then
/// reaches the icon and must not open the panel again. Over a full-screen app
/// the mouse-down goes to the system's menu bar, not to Lasso, so the click is
/// known by its timing: it reaches the icon right after the panel closed.
struct ClosingClick {
    /// Longer than a click is held, shorter than a deliberate second click.
    static let window: TimeInterval = 0.5
    let closedAt: Date?

    func isSameClick(at now: Date) -> Bool {
        guard let closedAt else { return false }
        return now.timeIntervalSince(closedAt) < Self.window
    }
}
