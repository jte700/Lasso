// The editor and window that own a transient suggestion popup. Geometry alone
// is not an identity: another window can put a caret at the same coordinates.
import Cocoa
import ApplicationServices

struct AssistPopupHost {
    let element: AXUIElement
    let window: AXUIElement
    let processIdentifier: pid_t

    init?(element: AXUIElement) {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success,
              let window = Self.elementAttribute(element, kAXWindowAttribute as String) else { return nil }
        self.element = element
        self.window = window
        processIdentifier = pid
        AXUIElementSetMessagingTimeout(element, 0.15)
        AXUIElementSetMessagingTimeout(window, 0.15)
    }

    /// Check ownership before reading the caret, including after a network
    /// response. Closed compose boxes, minimized windows, and other apps must
    /// never inherit the old popup.
    var isCurrent: Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == processIdentifier,
              let running = NSRunningApplication(processIdentifier: processIdentifier),
              !running.isTerminated, !running.isHidden,
              Self.attribute(window, kAXRoleAttribute as String) as? String == kAXWindowRole as String,
              Self.attribute(window, kAXMinimizedAttribute as String) as? Bool != true else { return false }
        let application = AXUIElementCreateApplication(processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.15)
        guard let focused = Self.elementAttribute(application, kAXFocusedUIElementAttribute as String),
              CFEqual(focused, element),
              let focusedWindow = Self.elementAttribute(application, kAXFocusedWindowAttribute as String),
              CFEqual(focusedWindow, window) else { return false }
        return true
    }

    func visibleCaret(using read: (AXUIElement) -> CGRect?) -> CGRect? {
        guard isCurrent, let caret = read(element),
              caret.minX.isFinite, caret.minY.isFinite,
              caret.width.isFinite, caret.height > 0, caret.height < 400,
              let windowFrame = Self.frame(window), let editorFrame = Self.frame(element),
              windowFrame.intersects(caret.insetBy(dx: -1, dy: 0)),
              editorFrame.insetBy(dx: -2, dy: -2).intersects(caret.insetBy(dx: -1, dy: 0)) else { return nil }
        return caret
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
        return result
    }

    private static func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func frame(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute as String),
              let size = attribute(element, kAXSizeAttribute as String),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
              dimensions.width > 0, dimensions.height > 0 else { return nil }
        return CGRect(origin: origin, size: dimensions)
    }
}
