//  Reading text and exact geometry inside web content.
//
//  Native text views answer AXValue / AXSelectedTextRange / AXBoundsForRange.
//  Rich contenteditables such as Gmail expose AXValue on the editor and exact
//  character bounds on their text leaves. Other browser surfaces publish the
//  "text marker" attributes that screen readers use for document ranges and
//  the caret's screen rectangle.
//
//  Markers are opaque CFTypes; they are only ever passed straight back to the
//  Accessibility API, never inspected.

import Cocoa
import ApplicationServices

enum WebTextReader {
    /// Align browser text leaves with the editor's UTF-16 value. Contenteditable
    /// inserts paragraph separators between leaves, but those separators have
    /// no text leaf of their own. Never search ahead past other visible text:
    /// that could attach a reference to a different occurrence of the word.
    static func elementRanges(for runs: [String], in text: String) -> [Range<Int>]? {
        let units = Array(text.utf16)
        var offset = 0
        var ranges: [Range<Int>] = []
        func isLineBreak(_ unit: UInt16) -> Bool {
            unit == 10 || unit == 13 || unit == 0x2028 || unit == 0x2029
        }
        for run in runs {
            let value = Array(run.utf16)
            guard !value.isEmpty else { return nil }
            func matches() -> Bool {
                offset + value.count <= units.count && units[offset..<(offset + value.count)].elementsEqual(value)
            }
            while !matches(), offset < units.count, isLineBreak(units[offset]) { offset += 1 }
            guard matches() else { return nil }
            ranges.append(offset..<(offset + value.count))
            offset += value.count
        }
        guard units[offset...].allSatisfy(isLineBreak) else { return nil }
        return ranges
    }

    /// Chrome measures text leaves even when the containing rich editor rejects
    /// AXBoundsForRange. Read only that editor's subtree, verify its text, then
    /// ask the browser for leaf-local bounds. No live selection is involved.
    static func rects(forElementRange range: Range<Int>, text: String, from element: AXUIElement) -> [CGRect] {
        guard !range.isEmpty, range.lowerBound >= 0, range.upperBound <= text.utf16.count else { return [] }
        var leaves: [(element: AXUIElement, text: String)] = []
        var visited = 0
        func collect(_ node: AXUIElement, depth: Int) -> Bool {
            visited += 1
            guard visited <= 2_000, depth <= 40 else { return false }
            if attribute(node, kAXRoleAttribute as String) as? String == kAXStaticTextRole as String {
                guard let value = attribute(node, kAXValueAttribute as String) as? String else { return false }
                if !value.isEmpty { leaves.append((node, value)) }
                return true
            }
            for child in attribute(node, kAXChildrenAttribute as String) as? [AXUIElement] ?? [] {
                if !collect(child, depth: depth + 1) { return false }
            }
            return true
        }
        guard collect(element, depth: 0), !leaves.isEmpty,
              let ranges = elementRanges(for: leaves.map(\.text), in: text) else { return [] }

        func bounds(_ leaf: AXUIElement, _ range: NSRange) -> CGRect? {
            var cfRange = CFRange(location: range.location, length: range.length)
            guard let parameter = AXValueCreate(.cfRange, &cfRange),
                  let value = parameterized(leaf, kAXBoundsForRangeParameterizedAttribute as String, parameter),
                  CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
            var rect = CGRect.zero
            guard AXValueGetValue(value as! AXValue, .cgRect, &rect),
                  HostGeometryConverter.isUsable(rect) else { return nil }
            return rect
        }

        var fragments: [CGRect] = []
        for (leaf, documentRange) in zip(leaves, ranges) {
            let start = max(range.lowerBound, documentRange.lowerBound)
            let end = min(range.upperBound, documentRange.upperBound)
            guard start < end else { continue }
            let local = NSRange(location: start - documentRange.lowerBound, length: end - start)
            // Query composed characters separately so wrapping yields one box
            // per line, including emoji whose UTF-16 length exceeds one.
            let string = leaf.text as NSString
            var offset = local.location
            while offset < NSMaxRange(local) {
                let character = string.rangeOfComposedCharacterSequence(at: offset)
                let overlap = NSIntersectionRange(character, local)
                if let rect = bounds(leaf.element, overlap) {
                    fragments.append(rect)
                } else if !string.substring(with: overlap).unicodeScalars.allSatisfy({
                    CharacterSet.whitespacesAndNewlines.contains($0)
                }) {
                    // A wrapped/collapsed space may have no box. Missing
                    // geometry for visible text must still fail closed.
                    return []
                }
                offset = NSMaxRange(character)
            }
        }
        return DependencyGeometry.coalesce(fragments, referenceId: "").fragments
    }

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
