//  Reading text and geometry out of whatever application has focus.
//
//  The protocol exists so the overlay never depends on how a particular host
//  exposes its text. The Accessibility implementation is the general one; a
//  browser bridge can be added later for hosts whose text ranges Accessibility
//  cannot measure, without the overlay changing at all.

import Cocoa
import ApplicationServices

/// Identity of the surface being written in, so highlights never appear over an
/// unrelated window or document.
struct HostContext: Equatable {
    let bundleIdentifier: String
    let applicationName: String
    /// Stable within one compose/document; changes when the user moves to another.
    let documentContext: String
    let element: AXUIElement
    let windowFrame: CGRect?

    static func == (left: HostContext, right: HostContext) -> Bool {
        left.bundleIdentifier == right.bundleIdentifier && left.documentContext == right.documentContext
    }
}

protocol HostTextAdapter {
    /// The focused text surface, or nil when nothing is being edited.
    func focusedContext() -> HostContext?
    /// The full text of that surface.
    func documentText(_ context: HostContext) -> String?
    /// Screen rectangles covering a character range; empty when the host cannot
    /// measure it. One rectangle per line for a wrapped phrase.
    func rects(for range: Range<Int>, in context: HostContext) -> [CGRect]
}

/// The general implementation, built on the same Accessibility reads the typing
/// assistant already uses.
final class AccessibilityTextAdapter: HostTextAdapter {
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    func focusedContext() -> HostContext? {
        guard let application = NSWorkspace.shared.frontmostApplication,
              let bundle = application.bundleIdentifier else { return nil }
        let applicationElement = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(applicationElement, 0.4)
        guard let focused = attribute(applicationElement, kAXFocusedUIElementAttribute as String),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        let element = focused as! AXUIElement

        // Identify the surface: a DOM identifier when the host offers one, the
        // window title otherwise. Both change when the user moves elsewhere.
        var parts: [String] = []
        if let domId = attribute(element, "AXDOMIdentifier") as? String, !domId.isEmpty { parts.append(domId) }
        if let title = attribute(applicationElement, kAXFocusedWindowAttribute as String),
           CFGetTypeID(title) == AXUIElementGetTypeID(),
           let name = attribute(title as! AXUIElement, kAXTitleAttribute as String) as? String {
            parts.append(name)
        }
        if let role = attribute(element, kAXRoleAttribute as String) as? String { parts.append(role) }

        var frame: CGRect?
        if let window = attribute(applicationElement, kAXFocusedWindowAttribute as String),
           CFGetTypeID(window) == AXUIElementGetTypeID() {
            frame = elementFrame(window as! AXUIElement)
        }

        return HostContext(
            bundleIdentifier: bundle,
            applicationName: application.localizedName ?? bundle,
            documentContext: parts.joined(separator: "|"),
            element: element,
            windowFrame: frame)
    }

    func documentText(_ context: HostContext) -> String? {
        // Text and geometry must use the same element-relative or document-relative offsets.
        if let value = attribute(context.element, kAXValueAttribute as String) as? String {
            return value
        }
        return WebTextReader.documentText(from: context.element)
    }

    func rects(for range: Range<Int>, in context: HostContext) -> [CGRect] {
        // Rich browser editors expose AXValue but reject AXBoundsForRange on
        // the editor itself. Their text descendants supply exact browser bounds.
        if let text = attribute(context.element, kAXValueAttribute as String) as? String {
            if let whole = boundsForRange(context.element, range),
               HostGeometryConverter.isUsable(whole) {
                let fragments = splitByLine(context.element, range: range, whole: whole)
                return fragments.isEmpty ? [whole] : fragments
            }
            let measured = WebTextReader.rects(forElementRange: range, text: text, from: context.element)
            guard let frame = elementFrame(context.element) else { return [] }
            return measured.compactMap { rect in
                let visible = rect.intersection(frame)
                return HostGeometryConverter.isUsable(visible) ? visible : nil
            }
        }

        // Document index space: go through markers on the web area, which is
        // the element the offsets came from.
        let viaMarkers = WebTextReader.rects(forRange: range, from: context.element)
        if !viaMarkers.isEmpty { return viaMarkers }

        // Last attempt: some editable web nodes answer directly despite not
        // publishing AXValue.
        if let whole = boundsForRange(context.element, range), HostGeometryConverter.isUsable(whole) {
            return [whole]
        }
        return []
    }

    // MARK: Geometry

    private func boundsForRange(_ element: AXUIElement, _ range: Range<Int>) -> CGRect? {
        var cfRange = CFRange(location: range.lowerBound, length: range.count)
        guard let axRange = AXValueCreate(.cfRange, &cfRange) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
                element, kAXBoundsForRangeParameterizedAttribute as CFString, axRange, &value) == .success,
              let box = value, CFGetTypeID(box) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(box as! AXValue, .cgRect, &rect) else { return nil }
        return rect
    }

    /// Walks the range a character at a time, grouping by line. Only used for
    /// short phrases, and only when the whole-range rectangle looks wrapped.
    private func splitByLine(_ element: AXUIElement, range: Range<Int>, whole: CGRect) -> [CGRect] {
        // A single-line phrase needs no further work.
        guard whole.height > 0, range.count <= 240 else { return [] }
        var perCharacter: [CGRect] = []
        for offset in range {
            if let rect = boundsForRange(element, offset..<(offset + 1)),
               HostGeometryConverter.isUsable(rect) {
                perCharacter.append(rect)
            }
        }
        guard perCharacter.count > 1 else { return [] }
        let lines = Set(perCharacter.map { Int(($0.midY / max(1, $0.height)).rounded()) })
        // Only pay for the split when the phrase actually wraps.
        guard lines.count > 1 else { return [] }
        return DependencyGeometry.coalesce(perCharacter, referenceId: "").fragments
    }

    private func elementFrame(_ element: AXUIElement) -> CGRect? {
        guard let positionValue = attribute(element, kAXPositionAttribute as String),
              let sizeValue = attribute(element, kAXSizeAttribute as String),
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }
}
