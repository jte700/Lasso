//  Reading the caret inside web content.
//
//  Native text views answer AXValue / AXSelectedTextRange / AXBoundsForRange.
//  Web content largely does not: a Gmail compose box is a contenteditable, which
//  exposes no value and no character ranges. Browsers instead publish the
//  "text marker" attributes that screen readers use, which give both the text
//  before the caret and the caret's screen rectangle.
//
//  Markers are opaque CFTypes; they are only ever passed straight back to the
//  Accessibility API, never inspected.

import Cocoa
import ApplicationServices

enum WebTextReader {
    // Undocumented but long-stable attribute names, shared by WebKit and Blink.
    private static let selectedRange = "AXSelectedTextMarkerRange"
    private static let startMarker = "AXStartTextMarker"
    private static let stringForRange = "AXStringForTextMarkerRange"
    private static let rangeForMarkers = "AXTextMarkerRangeForUnorderedTextMarkers"
    private static let startOfRange = "AXStartTextMarkerForTextMarkerRange"

    struct Reading {
        let textBeforeCaret: String?
        let textWindowStart: Int?
        let caretRect: CGRect?
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func parameterized(_ element: AXUIElement, _ name: String, _ parameter: CFTypeRef) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            element, name as CFString, parameter, &value) == .success else { return nil }
        return value
    }

    /// Walks up to the enclosing web area, which is where browsers answer
    /// document-level marker questions.
    private static func webArea(from element: AXUIElement) -> AXUIElement? {
        var current = element
        for _ in 0..<25 {
            if let role = attribute(current, kAXRoleAttribute as String) as? String, role == "AXWebArea" {
                return current
            }
            guard let parent = attribute(current, kAXParentAttribute as String),
                  CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
            current = parent as! AXUIElement
        }
        return nil
    }

    /// The selection lives on the focused node in Blink and on the web area in
    /// some WebKit builds, so both are tried.
    private static func selection(for element: AXUIElement) -> (AXUIElement, AXUIElement?, CFTypeRef)? {
        let area = webArea(from: element)
        // The application element answers in some Chromium builds even when the
        // focused node does not.
        var application: AXUIElement?
        var pid: pid_t = 0
        if AXUIElementGetPid(element, &pid) == .success { application = AXUIElementCreateApplication(pid) }
        for holder in [element, area, application].compactMap({ $0 }) {
            if let selection = attribute(holder, selectedRange) { return (holder, area ?? holder, selection) }
        }
        return nil
    }

    private static func rect(from holder: AXUIElement, selection: CFTypeRef) -> CGRect? {
        guard let bounds = parameterized(holder, boundsForRange, selection),
              CFGetTypeID(bounds) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(bounds as! AXValue, .cgRect, &rect),
              rect.origin.x.isFinite, rect.origin.y.isFinite,
              rect.height > 0, rect.height < 400 else { return nil }
        return rect
    }

    /// Caret rectangle only. Cheap enough to run on every keystroke, which is
    /// what keeps the box pinned to the caret while typing.
    static func caretRect(from element: AXUIElement) -> CGRect? {
        guard let (holder, _, selected) = selection(for: element) else { return nil }
        return rect(from: holder, selection: selected)
    }

    // Chromium exposes these on the platform document, which lets an arbitrary
    // character index be turned into a marker — and therefore into geometry for
    // text committed long before now, not just the live selection.
    private static let markerForIndex = "AXTextMarkerForIndex"
    private static let boundsForRange = "AXBoundsForTextMarkerRange"

    /// The web area, which is the index space `documentText` reports in. Both
    /// text and geometry must be asked of the same element or the offsets refer
    /// to different things.
    static func documentElement(from element: AXUIElement) -> AXUIElement? {
        if let area = webArea(from: element) { return area }
        guard let (holder, area, _) = selection(for: element) else { return nil }
        return area ?? holder
    }

    /// Screen rectangles for a character range of the document, one per line.
    ///
    /// index → marker → marker range → bounds. This is the path that makes a
    /// committed phrase measurable in a browser without any page-side helper.
    static func rects(forRange range: Range<Int>, from element: AXUIElement) -> [CGRect] {
        guard let document = documentElement(from: element), !range.isEmpty else { return [] }

        func marker(at index: Int) -> CFTypeRef? {
            parameterized(document, markerForIndex, NSNumber(value: index) as CFTypeRef)
        }
        func bounds(_ from: Int, _ to: Int) -> CGRect? {
            guard let start = marker(at: from), let end = marker(at: to) else { return nil }
            guard let markerRange = parameterized(
                document, rangeForMarkers, [start, end] as CFArray) else { return nil }
            guard let value = parameterized(document, boundsForRange, markerRange),
                  CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
            var rect = CGRect.zero
            guard AXValueGetValue(value as! AXValue, .cgRect, &rect),
                  rect.origin.x.isFinite, rect.origin.y.isFinite,
                  rect.height > 0, rect.height < 400 else { return nil }
            return rect
        }

        guard let whole = bounds(range.lowerBound, range.upperBound) else { return [] }

        // A wrapped phrase needs one rectangle per line. Measuring each
        // character is only worth it when the phrase is short and actually wraps.
        guard range.count <= 160 else { return [whole] }
        var perCharacter: [CGRect] = []
        for index in range {
            if let rect = bounds(index, index + 1) { perCharacter.append(rect) }
        }
        guard perCharacter.count > 1 else { return [whole] }
        let lines = Set(perCharacter.map { Int(($0.midY / max(1, $0.height)).rounded()) })
        guard lines.count > 1 else { return [whole] }
        return perCharacter
    }

    /// The whole document text, for hosts that expose it only through markers.
    static func documentText(from element: AXUIElement, limit: Int = 20_000) -> String? {
        guard let (holder, area, _) = selection(for: element) else { return nil }
        let source = area ?? holder
        guard let start = attribute(source, startMarker),
              let end = attribute(source, "AXEndTextMarker") else { return nil }
        let pair = [start, end] as CFArray
        guard let range = parameterized(holder, rangeForMarkers, pair),
              let string = parameterized(holder, stringForRange, range) as? String else { return nil }
        return String(string.prefix(limit))
    }

    /// Returns whatever the browser is willing to answer: the text just before
    /// the caret, the caret rectangle, or both.
    static func read(from element: AXUIElement, limit: Int = 1200) -> Reading? {
        guard let (holder, area, selection) = selection(for: element) else { return nil }
        let caretRect = rect(from: holder, selection: selection)

        // Text from the start of the document up to the caret.
        var text: String?
        var windowStart: Int?
        if let caretMarker = parameterized(holder, startOfRange, selection),
           let documentStart = attribute(area ?? holder, startMarker) {
            let pair = [documentStart, caretMarker] as CFArray
            if let range = parameterized(holder, rangeForMarkers, pair),
               let string = parameterized(holder, stringForRange, range) as? String {
                let units = Array(string.utf16)
                let start = max(0, units.count - limit)
                text = String(decoding: units[start...], as: UTF16.self)
                windowStart = start
            }
        }

        guard text != nil || caretRect != nil else { return nil }
        return Reading(textBeforeCaret: text, textWindowStart: windowStart, caretRect: caretRect)
    }
}
