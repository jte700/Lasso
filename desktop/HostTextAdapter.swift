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
    /// Surfaces whose text was read from the element rather than the document.
    private var elementSpace: Set<String> = []

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
        // Native controls report text and geometry in the element's own index
        // space; web content reports both in the document's. Whichever answers
        // must answer for geometry too, so the choice is recorded.
        if let value = attribute(context.element, kAXValueAttribute as String) as? String {
            elementSpace.insert(context.documentContext)
            return value
        }
        elementSpace.remove(context.documentContext)
        return WebTextReader.documentText(from: context.element)
    }

    func rects(for range: Range<Int>, in context: HostContext) -> [CGRect] {
        // AXValue defines element index space. Chrome's Gmail AXTextArea exposes
        // that text but refuses AXBoundsForRange, so direct geometry is followed
        // by a calibrated TextKit layout using the live caret rectangle.
        if let text = attribute(context.element, kAXValueAttribute as String) as? String {
            elementSpace.insert(context.documentContext)
            if let whole = boundsForRange(context.element, range),
               HostGeometryConverter.isUsable(whole) {
                let fragments = splitByLine(context.element, range: range, whole: whole)
                return fragments.isEmpty ? [whole] : fragments
            }
            let inferred = inferredRects(for: range, text: text, in: context.element)
            if !inferred.isEmpty { return inferred }
            return []
        }
        elementSpace.remove(context.documentContext)

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

    /// Chrome exposes Gmail's compose body as AXValue but not as measurable
    /// character ranges. Recreate its text layout and calibrate it against the
    /// browser's real live-caret rectangle; return nothing if any evidence is absent.
    func inferredRects(for range: Range<Int>, text: String, in element: AXUIElement) -> [CGRect] {
        let units = Array(text.utf16)
        guard !range.isEmpty, range.lowerBound >= 0, range.upperBound <= units.count else { return [] }
        guard let frame = elementFrame(element), frame.width > 8, frame.height > 0 else { return [] }
        guard let selection = selectedTextRange(element),
              selection.location >= 0, selection.location + selection.length <= units.count else { return [] }
        let caret = selection.location + selection.length
        guard let actualCaret = WebTextReader.caretRect(from: element),
              actualCaret.origin.x.isFinite, actualCaret.origin.y.isFinite,
              actualCaret.height > 0 else { return [] }

        let attributed = attributedText(text, from: element)
        return layoutRects(
            attributedText: attributed, range: range, elementFrame: frame,
            caret: caret, actualCaret: actualCaret)
    }

    private func attributedText(_ text: String, from element: AXUIElement) -> NSAttributedString {
        let length = Array(text.utf16).count
        var cfRange = CFRange(location: 0, length: length)
        if let axRange = AXValueCreate(.cfRange, &cfRange) {
            var value: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(
                    element, "AXAttributedStringForRange" as CFString, axRange, &value) == .success,
               let attributed = value as? NSAttributedString, attributed.length == length {
                return attributed
            }
        }
        return NSAttributedString(string: text)
    }

    private func selectedTextRange(_ element: AXUIElement) -> NSRange? {
        guard let value = attribute(element, kAXSelectedTextRangeAttribute as String),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
        return NSRange(location: range.location, length: range.length)
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

    /// Lays out the AX text in the element's width, then translates that local
    /// layout by the difference between its predicted caret and Chrome's actual
    /// caret. This captures CSS padding and scrolling without touching the DOM.
    func layoutRects(
        attributedText: NSAttributedString, range: Range<Int>, elementFrame: CGRect,
        caret: Int, actualCaret: CGRect
    ) -> [CGRect] {
        guard attributedText.length > 0 else { return [] }

        let prepared = NSMutableAttributedString(attributedString: attributedText)
        var hasFont = false
        prepared.enumerateAttribute(.font, in: NSRange(location: 0, length: prepared.length)) {
            value, _, stop in
            if value is NSFont { hasFont = true; stop.pointee = true }
        }
        if !hasFont {
            let size = min(24, max(11, actualCaret.height * 0.78))
            prepared.addAttribute(.font, value: NSFont.systemFont(ofSize: size),
                                  range: NSRange(location: 0, length: prepared.length))
        }

        let storage = NSTextStorage(attributedString: prepared)
        let layout = NSLayoutManager()
        layout.usesFontLeading = true
        let container = NSTextContainer(size: NSSize(
            width: max(1, elementFrame.width),
            height: 1_000_000))
        container.lineFragmentPadding = 0
        container.lineBreakMode = .byWordWrapping
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)

        func localRect(for characters: NSRange) -> CGRect? {
            let glyphs = layout.glyphRange(forCharacterRange: characters, actualCharacterRange: nil)
            guard glyphs.length > 0 else { return nil }
            return layout.boundingRect(forGlyphRange: glyphs, in: container)
        }

        let predictedCaret: CGRect?
        if caret < prepared.length {
            predictedCaret = localRect(for: NSRange(location: caret, length: 1)).map {
                CGRect(x: $0.minX, y: $0.minY, width: 1, height: $0.height)
            }
        } else if caret > 0 {
            predictedCaret = localRect(for: NSRange(location: caret - 1, length: 1)).map {
                CGRect(x: $0.maxX, y: $0.minY, width: 1, height: $0.height)
            }
        } else { return [] }
        guard let predictedCaret else { return [] }

        let dx = actualCaret.minX - (elementFrame.minX + predictedCaret.minX)
        let dy = actualCaret.minY - (elementFrame.minY + predictedCaret.minY)
        guard dx.isFinite, dy.isFinite,
              abs(dx) <= max(120, elementFrame.width * 0.25) else { return [] }

        let targetGlyphs = layout.glyphRange(
            forCharacterRange: NSRange(location: range.lowerBound, length: range.count),
            actualCharacterRange: nil)
        guard targetGlyphs.length > 0 else { return [] }
        var fragments: [CGRect] = []
        layout.enumerateLineFragments(forGlyphRange: targetGlyphs) { _, _, _, lineRange, _ in
            let overlap = NSIntersectionRange(targetGlyphs, lineRange)
            guard overlap.length > 0 else { return }
            let local = layout.boundingRect(forGlyphRange: overlap, in: container)
            guard local.width > 0, local.height > 0, local.height < 100 else { return }
            // TextKit's line box can be a few pixels taller than Chrome's CSS
            // caret. Anchor every line to the live caret baseline and use its
            // measured height so the translucent wash hugs the host text.
            let screen = CGRect(
                x: local.minX + elementFrame.minX + dx,
                y: actualCaret.minY + (local.minY - predictedCaret.minY),
                width: local.width,
                height: actualCaret.height
            )
            if elementFrame.insetBy(dx: -4, dy: -4).intersects(screen) {
                fragments.append(screen)
            }
        }
        return fragments
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
