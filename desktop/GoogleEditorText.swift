//  Google Docs and Slides in a browser.
//
//  Both draw their text on a canvas and take typing in a hidden field (inside
//  the `docs-texteventtarget-iframe`). That field holds the document's text,
//  with the caret, only while the editor's braille support is on (Tools >
//  Accessibility); otherwise it holds a zero-width space or two. Its frame is
//  a one-point strip at the top of the page, so the caret is found on screen
//  instead (ScreenCaret). Sheets' cell editor is an ordinary field and needs
//  none of this.

import Cocoa
import ApplicationServices

enum GoogleEditorText {
    static let textTargetClass = "docs-texteventtarget-iframe"
    /// Present in the menu bar while screen reader support is on.
    static let screenReaderMenuID = "docs-screenreader-menu"
    static let zeroWidthSpace: Character = "\u{200B}"
    /// What has focus instead of the field while screen reader support is on
    /// and braille support is off.
    static let descendantID = "docs-texteventtarget-descendant"
    /// The iframe's group is the next level or two above its document.
    private static let targetDepth = 3
    /// The page's web area is a few levels above the iframe.
    private static let pageDepth = 8
    private static let menuSearchVisits = 4000

    enum Readiness: Equatable {
        case readable
        /// Braille support is off: Lasso can switch it on.
        case needsBraille
    }

    /// What the hidden field's value says about braille support. An empty
    /// value is an empty text box when screen reader support is on, and a
    /// field with nothing in it at all when it is off.
    static func readiness(value: String, screenReaderOn: () -> Bool) -> Readiness {
        if !value.isEmpty, value.allSatisfy({ $0 == zeroWidthSpace }) { return .needsBraille }
        if value.isEmpty, !screenReaderOn() { return .needsBraille }
        return .readable
    }

    /// True for the hidden field Docs and Slides type into.
    static func isTextTarget(_ element: AXUIElement) -> Bool {
        role(element) == kAXTextAreaRole as String && isInsideTextTarget(element)
    }

    /// True when Docs or Slides has focus but its text cannot be read until
    /// braille support is on.
    static func needsBraille(_ element: AXUIElement) -> Bool {
        if attribute(element, "AXDOMIdentifier") as? String == descendantID { return isInsideTextTarget(element) }
        return isTextTarget(element) && readiness(of: element) == .needsBraille
    }

    private static func isInsideTextTarget(_ element: AXUIElement) -> Bool {
        // The field is the body of its own iframe, so an app's native text
        // area is turned away after one more question.
        guard let frameDocument = parent(element), role(frameDocument) == "AXWebArea" else { return false }
        var current = parent(frameDocument)
        for _ in 0..<targetDepth {
            guard let node = current else { return false }
            if classes(node).contains(textTargetClass) { return true }
            current = parent(node)
        }
        return false
    }

    /// The editor's page: the outermost web area above the hidden field.
    static func pageFrame(of element: AXUIElement) -> CGRect? {
        var current = parent(element)
        var page: AXUIElement?
        for _ in 0..<pageDepth {
            guard let node = current else { break }
            if role(node) == "AXWebArea" { page = node }
            current = parent(node)
        }
        return page.flatMap(frame)
    }

    static func readiness(of element: AXUIElement) -> Readiness {
        let value = attribute(element, kAXValueAttribute as String) as? String ?? ""
        return readiness(value: value, screenReaderOn: { hasScreenReaderMenu(above: element) })
    }

    /// Looks for the Accessibility menu in the editor's own page.
    private static func hasScreenReaderMenu(above element: AXUIElement) -> Bool {
        var root = element
        var current = parent(element)
        for _ in 0..<pageDepth {
            guard let node = current else { break }
            if role(node) == "AXWebArea" { root = node }
            current = parent(node)
        }
        return FocusedTextElement.search(
            from: root, children: { attribute($0, kAXChildrenAttribute as String) as? [AXUIElement] ?? [] },
            isFocusedText: { attribute($0, "AXDOMIdentifier") as? String == screenReaderMenuID },
            maxVisits: menuSearchVisits) != nil
    }

    private static func role(_ element: AXUIElement) -> String? {
        attribute(element, kAXRoleAttribute as String) as? String
    }

    private static func classes(_ element: AXUIElement) -> [String] {
        attribute(element, "AXDOMClassList") as? [String] ?? []
    }

    private static func parent(_ element: AXUIElement) -> AXUIElement? {
        guard let value = attribute(element, kAXParentAttribute as String),
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func frame(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute as String),
              let size = attribute(element, kAXSizeAttribute as String) else { return nil }
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
              AXValueGetValue(size as! AXValue, .cgSize, &extent),
              extent.width > 1, extent.height > 1 else { return nil }
        return CGRect(origin: origin, size: extent)
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(element, 0.4)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
}

/// Switches braille support on with the editors' own shortcut, ⌘⌥H. The
/// shortcut toggles, so it is pressed only while the field reads as off, at
/// most once per process in a while, and a few times per process at all: an
/// editor that ignores it (another language's shortcut, say) is left alone.
final class GoogleEditorBraille {
    static let shared = GoogleEditorBraille()
    static let retryAfter: TimeInterval = 20
    static let maximumPresses = 2
    /// The H key.
    private static let hKey: CGKeyCode = 4

    private let press: (pid_t) -> Void
    private let now: () -> Date
    private let lock = NSLock()
    private var presses: [pid_t: (count: Int, last: Date)] = [:]

    init(press: @escaping (pid_t) -> Void = GoogleEditorBraille.pressShortcut,
         now: @escaping () -> Date = Date.init) {
        self.press = press
        self.now = now
    }

    /// Presses the shortcut when allowed; true when it did, so the caller
    /// reads the field again once the editor has filled it.
    @discardableResult
    func switchOn(pid: pid_t) -> Bool {
        let current = now()
        lock.lock()
        let previous = presses[pid]
        if let previous, previous.count >= Self.maximumPresses
            || current.timeIntervalSince(previous.last) < Self.retryAfter {
            lock.unlock()
            return false
        }
        presses[pid] = ((previous?.count ?? 0) + 1, current)
        lock.unlock()
        press(pid)
        return true
    }

    func forget(pid: pid_t) {
        lock.lock()
        presses.removeValue(forKey: pid)
        lock.unlock()
    }

    static func pressShortcut(pid: pid_t) {
        let source = CGEventSource(stateID: .privateState)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: hKey, keyDown: down) else { continue }
            event.flags = [.maskCommand, .maskAlternate]
            event.postToPid(pid)
        }
    }
}
