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

    /// Blink can omit AXLink from attributed text while exposing link nodes.
    /// Align the focused editor's leaves to its complete value and prove that
    /// every character immediately before the unchanged caret has this URL.
    static func hyperlinkBeforeCaret(_ label: String, url: URL, caret: Int,
                                     from element: AXUIElement) -> Bool {
        let length = label.utf16.count
        guard length > 0, caret >= length else { return false }
        let deadline = ProcessInfo.processInfo.systemUptime + 0.15
        func selectionMatches() -> Bool {
            guard let value = attribute(element, kAXSelectedTextRangeAttribute as String),
                  CFGetTypeID(value) == AXValueGetTypeID() else { return false }
            var range = CFRange()
            return AXValueGetValue(value as! AXValue, .cfRange, &range)
                && range.location == caret && range.length == 0
        }
        guard selectionMatches(),
              let text = attribute(element, kAXValueAttribute as String) as? String else { return false }
        let units = Array(text.utf16)
        let target = (caret - length)..<caret
        guard caret <= units.count, units[target].elementsEqual(label.utf16) else { return false }
        var leaves: [(text: String, destination: String?)] = []
        var visited = 0
        func collect(_ node: AXUIElement, inheritedURL: String?, depth: Int) -> Bool {
            visited += 1
            guard visited <= 2_000, depth <= 40, hasTime(before: deadline) else { return false }
            let role = attribute(node, kAXRoleAttribute as String) as? String
            var destination = inheritedURL
            if role == "AXLink" {
                let value = attribute(node, kAXURLAttribute as String)
                destination = (value as? URL)?.absoluteString ?? value as? String
            }
            if role == kAXStaticTextRole as String {
                guard let value = attribute(node, kAXValueAttribute as String) as? String else { return false }
                if !value.isEmpty { leaves.append((value, destination)) }
                return true
            }
            for child in attribute(node, kAXChildrenAttribute as String) as? [AXUIElement] ?? [] {
                if !collect(child, inheritedURL: destination, depth: depth + 1) { return false }
            }
            return true
        }
        guard collect(element, inheritedURL: nil, depth: 0),
              let ranges = elementRanges(for: leaves.map(\.text), in: text) else { return false }
        var covered = target.lowerBound
        for (leaf, range) in zip(leaves, ranges) {
            let start = max(target.lowerBound, range.lowerBound)
            let end = min(target.upperBound, range.upperBound)
            guard start < end else { continue }
            guard start == covered, leaf.destination == url.absoluteString else { return false }
            covered = end
        }
        return covered == target.upperBound && hasTime(before: deadline)
            && selectionMatches() && attribute(element, kAXValueAttribute as String) as? String == text
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
    private static func webArea(from element: AXUIElement, before deadline: TimeInterval? = nil) -> AXUIElement? {
        var current = element
        for _ in 0..<25 {
            if let deadline, !hasTime(before: deadline) { return nil }
            if let role = attribute(current, kAXRoleAttribute as String) as? String, role == "AXWebArea" {
                return current
            }
            if let deadline, !hasTime(before: deadline) { return nil }
            guard let parent = attribute(current, kAXParentAttribute as String),
                  CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
            current = parent as! AXUIElement
        }
        return nil
    }

    /// The selection lives on the focused node in Blink and on the web area in
    /// some WebKit builds, so both are tried. Finding the web area walks up to
    /// 25 parents, which a caret-only read skips when the node answers itself.
    private static func selection(for element: AXUIElement,
                                  needsArea: Bool = true) -> (AXUIElement, AXUIElement?, CFTypeRef)? {
        if !needsArea, let selection = attribute(element, selectedRange) { return (element, nil, selection) }
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
        guard let (holder, _, selected) = selection(for: element, needsArea: false) else { return nil }
        return rect(from: holder, selection: selected)
    }

    // Chromium exposes these on the platform document, which lets an arbitrary
    // character index be turned into a marker — and therefore into geometry for
    // text committed long before now, not just the live selection.
    private static let markerForIndex = "AXTextMarkerForIndex"
    private static let boundsForRange = "AXBoundsForTextMarkerRange"

    private static func hasTime(before deadline: TimeInterval) -> Bool {
        ProcessInfo.processInfo.systemUptime < deadline
    }

    /// A short-lived bridge between an editable element's AXValue offsets and
    /// the browser's opaque text markers. Root-document marker indices are not
    /// interchangeable with the focused element's UTF-16 offsets.
    final class ElementGeometry {
        private let holder: AXUIElement
        private let element: AXUIElement
        private let elementRange: AXTextMarkerRange
        private let start: AXTextMarker
        private let end: AXTextMarker
        private let units: [UInt16]
        private let text: NSString
        private let frame: CGRect
        private let deadline: TimeInterval
        private var markers: [Int: AXTextMarker]
        private var remainingSteps = 192
        private var valid = true

        fileprivate init(holder: AXUIElement, element: AXUIElement, elementRange: AXTextMarkerRange,
                         start: AXTextMarker, end: AXTextMarker,
                         text: String, frame: CGRect, deadline: TimeInterval) {
            self.holder = holder
            self.element = element
            self.elementRange = elementRange
            self.start = start
            self.end = end
            self.units = Array(text.utf16)
            self.text = text as NSString
            self.frame = frame
            self.deadline = deadline
            self.markers = [0: start, text.utf16.count: end]
        }

        fileprivate var hasTimeRemaining: Bool { valid && WebTextReader.hasTime(before: deadline) }

        /// A synchronous AX request can itself reach the host timeout, but no
        /// additional request is started once this refresh's 50 ms budget ends.
        private func query(_ name: String, _ parameter: CFTypeRef) -> CFTypeRef? {
            guard hasTimeRemaining else { return nil }
            return parameterized(holder, name, parameter)
        }

        /// Recheck the text before and after measuring so a host edit during an
        /// Accessibility read cannot attach the old offsets to new content.
        private func matchesSnapshot() -> Bool {
            guard hasTimeRemaining,
                  let currentValue = attribute(element, kAXValueAttribute as String) as? String,
                  currentValue.utf16.elementsEqual(units),
                  let current = query(stringForRange, elementRange) as? String,
                  current.utf16.elementsEqual(units), hasTimeRemaining else {
                valid = false
                return false
            }
            return true
        }

        private func markerRange(_ first: AXTextMarker, _ last: AXTextMarker) -> AXTextMarkerRange {
            AXTextMarkerRangeCreate(kCFAllocatorDefault, first, last)
        }

        /// Selection markers can save a long walk, but only after both sides of
        /// the marker prove the same local offset as the element's AXValue.
        fileprivate func rememberSelectionMarker(_ marker: AXTextMarker, at offset: Int) {
            guard hasTimeRemaining, offset >= 0, offset <= units.count,
                  let before = query(stringForRange, markerRange(start, marker)) as? String,
                  before.utf16.elementsEqual(units[..<offset]),
                  let after = query(stringForRange, markerRange(marker, end)) as? String,
                  after.utf16.elementsEqual(units[offset...]), hasTimeRemaining else { return }
            markers[offset] = marker
        }

        private func marker(at target: Int) -> AXTextMarker? {
            guard hasTimeRemaining, target >= 0, target <= units.count else { return nil }
            if let cached = markers[target] { return cached }
            guard let origin = markers.keys.min(by: { abs($0 - target) < abs($1 - target) }),
                  var current = markers[origin] else { return nil }
            var offset = origin
            var emptySteps = 0
            let forward = target > origin
            let movement = forward ? "AXNextTextMarkerForTextMarker" : "AXPreviousTextMarkerForTextMarker"

            while offset != target, remainingSteps > 0, hasTimeRemaining {
                remainingSteps -= 1
                guard let value = query(movement, current),
                      CFGetTypeID(value) == AXTextMarkerGetTypeID() else { return nil }
                let next = value as! AXTextMarker
                guard !CFEqual(current, next) else { return nil }
                let stepRange = forward ? markerRange(current, next) : markerRange(next, current)
                guard let step = query(stringForRange, stepRange) as? String else { return nil }
                let stepUnits = Array(step.utf16)
                let newOffset = forward ? offset + stepUnits.count : offset - stepUnits.count
                guard newOffset >= 0, newOffset <= units.count,
                      stepUnits.elementsEqual(units[min(offset, newOffset)..<max(offset, newOffset)]) else {
                    valid = false
                    return nil
                }

                if stepUnits.isEmpty {
                    // Adjacent AX nodes can represent the same text boundary.
                    // A short allowance crosses those nodes without looping.
                    emptySteps += 1
                    guard emptySteps <= 4 else { return nil }
                } else {
                    emptySteps = 0
                    markers[newOffset] = next
                }
                current = next
                offset = newOffset
                // A browser character can span several UTF-16 code units. An
                // offset inside it is not a measurable marker boundary.
                if (forward && offset > target) || (!forward && offset < target) { return nil }
            }
            return offset == target && hasTimeRemaining ? current : nil
        }

        private func bounds(for range: Range<Int>) -> CGRect? {
            guard let first = marker(at: range.lowerBound), let last = marker(at: range.upperBound) else { return nil }
            let markerRange = markerRange(first, last)
            guard let measured = query(stringForRange, markerRange) as? String,
                  measured.utf16.elementsEqual(units[range]) else {
                valid = false
                return nil
            }
            guard let value = query(boundsForRange, markerRange),
                  CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
            var rect = CGRect.zero
            guard AXValueGetValue(value as! AXValue, .cgRect, &rect),
                  HostGeometryConverter.isUsable(rect),
                  frame.insetBy(dx: -4, dy: -4).contains(rect), hasTimeRemaining else { return nil }
            return rect
        }

        /// Measured rectangles only. Unsupported or unproven offsets return no
        /// geometry so the caller can use its separately calibrated fallback.
        func rects(forRange range: Range<Int>) -> [CGRect] {
            guard !range.isEmpty, range.lowerBound >= 0, range.upperBound <= units.count,
                  matchesSnapshot() else { return [] }
            let visibleRanges = WebTextReader.visibleGeometryRanges(forRange: range, inUTF16: units)
            guard !visibleRanges.isEmpty else { return [] }

            // Whole-range bounds are cheap and accurate when the two endpoint
            // characters prove that the browser has kept the phrase on one line.
            if visibleRanges.count == 1, visibleRanges[0] == range,
               let whole = bounds(for: range) {
                let first = text.rangeOfComposedCharacterSequence(at: range.lowerBound)
                let last = text.rangeOfComposedCharacterSequence(at: range.upperBound - 1)
                guard first.location == range.lowerBound,
                      NSMaxRange(last) == range.upperBound else { return [] }
                if first == last {
                    return matchesSnapshot() ? [whole] : []
                }
                if let firstRect = bounds(for: first.location..<NSMaxRange(first)),
                   let lastRect = bounds(for: last.location..<NSMaxRange(last)),
                   HostGeometryConverter.isSingleLine(whole: whole, first: firstRect, last: lastRect) {
                    return matchesSnapshot() ? [whole] : []
                }
            }

            // Never draw a multiline bounding box or a newline glyph's wide
            // selection box. Short phrases are measured one grapheme at a time.
            guard range.count <= 160 else { return [] }
            var fragments: [CGRect] = []
            for visible in visibleRanges {
                var offset = visible.lowerBound
                while offset < visible.upperBound {
                    guard hasTimeRemaining else { return [] }
                    let character = text.rangeOfComposedCharacterSequence(at: offset)
                    guard character.location == offset, NSMaxRange(character) <= visible.upperBound,
                          let rect = bounds(for: offset..<NSMaxRange(character)) else { return [] }
                    fragments.append(rect)
                    offset = NSMaxRange(character)
                }
            }
            guard matchesSnapshot() else { return [] }
            return DependencyGeometry.coalesce(fragments, referenceId: "").fragments
        }
    }

    /// Excludes hard line breaks before geometry is measured. Offsets retain
    /// the original UTF-16 index space, including CRLF's two code units.
    static func visibleGeometryRanges(forRange range: Range<Int>, inUTF16 units: [UInt16]) -> [Range<Int>] {
        guard !range.isEmpty, range.lowerBound >= 0, range.upperBound <= units.count else { return [] }
        var ranges: [Range<Int>] = []
        var start = range.lowerBound
        for index in range where [UInt16(10), 13, 0x2028, 0x2029].contains(units[index]) {
            if start < index { ranges.append(start..<index) }
            start = index + 1
        }
        if start < range.upperBound { ranges.append(start..<range.upperBound) }
        return ranges
    }

    /// Establishes element-relative marker offsets only when the marker range's
    /// entire text is exactly the AXValue snapshot being highlighted.
    static func elementGeometry(forText text: String, from element: AXUIElement) -> ElementGeometry? {
        let deadline = ProcessInfo.processInfo.systemUptime + 0.050
        guard !text.isEmpty,
              let position = attribute(element, kAXPositionAttribute as String),
              hasTime(before: deadline),
              let size = attribute(element, kAXSizeAttribute as String),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
              AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
        let frame = CGRect(origin: origin, size: extent)
        guard frame.origin.x.isFinite, frame.origin.y.isFinite,
              frame.width.isFinite, frame.height.isFinite, frame.width > 8, frame.height > 0 else { return nil }

        // Try the focused node first. Looking up the enclosing web area and
        // proving optional selection offsets share the same elapsed-time budget.
        for attempt in 0..<2 {
            guard hasTime(before: deadline) else { return nil }
            let holder: AXUIElement
            if attempt == 0 {
                holder = element
            } else {
                guard let area = webArea(from: element, before: deadline) else { return nil }
                holder = area
            }
            guard hasTime(before: deadline),
                  let value = parameterized(holder, "AXTextMarkerRangeForUIElement", element),
                  CFGetTypeID(value) == AXTextMarkerRangeGetTypeID() else { continue }
            let range = value as! AXTextMarkerRange
            guard hasTime(before: deadline),
                  let measured = parameterized(holder, stringForRange, range) as? String,
                  measured.utf16.elementsEqual(text.utf16) else { continue }
            let start = AXTextMarkerRangeCopyStartMarker(range)
            let end = AXTextMarkerRangeCopyEndMarker(range)
            guard CFGetTypeID(start) == AXTextMarkerGetTypeID(),
                  CFGetTypeID(end) == AXTextMarkerGetTypeID() else { continue }
            let geometry = ElementGeometry(holder: holder, element: element, elementRange: range,
                                           start: start, end: end, text: text, frame: frame, deadline: deadline)

            if geometry.hasTimeRemaining,
               let localValue = attribute(element, kAXSelectedTextRangeAttribute as String),
               CFGetTypeID(localValue) == AXValueGetTypeID() {
                var local = CFRange()
                if AXValueGetValue(localValue as! AXValue, .cfRange, &local),
                   local.location >= 0, local.length >= 0,
                   local.location <= text.utf16.count,
                   local.length <= text.utf16.count - local.location {
                    for selectionHolder in [element, holder] {
                        guard geometry.hasTimeRemaining else { break }
                        guard let selected = attribute(selectionHolder, selectedRange),
                              CFGetTypeID(selected) == AXTextMarkerRangeGetTypeID() else { continue }
                        let selectedRange = selected as! AXTextMarkerRange
                        let first = AXTextMarkerRangeCopyStartMarker(selectedRange)
                        let last = AXTextMarkerRangeCopyEndMarker(selectedRange)
                        if CFGetTypeID(first) == AXTextMarkerGetTypeID(),
                           CFGetTypeID(last) == AXTextMarkerGetTypeID() {
                            // Selection ranges can be backwards. Each candidate
                            // is accepted only where its prefix/suffix prove it.
                            let selectedMarkers = CFEqual(first, last) ? [first] : [first, last]
                            for marker in selectedMarkers {
                                guard geometry.hasTimeRemaining else { break }
                                geometry.rememberSelectionMarker(marker, at: local.location)
                                if local.length > 0 {
                                    geometry.rememberSelectionMarker(marker, at: local.location + local.length)
                                }
                            }
                        }
                        break
                    }
                }
            }
            return geometry.hasTimeRemaining ? geometry : nil
        }
        return nil
    }

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
        if range.count <= 1 { return [whole] }
        if let first = bounds(range.lowerBound, range.lowerBound + 1),
           let last = bounds(range.upperBound - 1, range.upperBound),
           HostGeometryConverter.isSingleLine(whole: whole, first: first, last: last) {
            return [whole]
        }
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
    static func documentText(from element: AXUIElement) -> String? {
        guard let (holder, area, _) = selection(for: element) else { return nil }
        let source = area ?? holder
        guard let start = attribute(source, startMarker),
              let end = attribute(source, "AXEndTextMarker") else { return nil }
        let pair = [start, end] as CFArray
        guard let range = parameterized(holder, rangeForMarkers, pair),
              let string = parameterized(holder, stringForRange, range) as? String else { return nil }
        // The host already returned the entire text. Truncating it here makes
        // references beyond the cutoff look deleted to the anchor resolver.
        return string
    }

    /// Returns attributes only for the proven text immediately before a
    /// collapsed caret. Marker navigation avoids mixing editable-field offsets
    /// with the browser's document offsets when verifying a pasted hyperlink.
    static func attributedTextBeforeCaret(expectedText: String,
                                          from element: AXUIElement) -> NSAttributedString? {
        let expected = Array(expectedText.utf16)
        guard !expected.isEmpty else { return nil }
        let deadline = ProcessInfo.processInfo.systemUptime + 0.15
        guard let (selectionHolder, area, selected) = selection(for: element),
              hasTime(before: deadline),
              CFGetTypeID(selected) == AXTextMarkerRangeGetTypeID() else { return nil }
        let selectedMarkers = selected as! AXTextMarkerRange
        let caret = AXTextMarkerRangeCopyStartMarker(selectedMarkers)
        let selectedEnd = AXTextMarkerRangeCopyEndMarker(selectedMarkers)
        guard CFEqual(caret, selectedEnd) else { return nil }

        var holders = [selectionHolder]
        if let area, !CFEqual(area, selectionHolder) { holders.append(area) }
        var remainingSteps = 192
        for holder in holders {
            func query(_ name: String, _ parameter: CFTypeRef) -> CFTypeRef? {
                guard hasTime(before: deadline) else { return nil }
                return parameterized(holder, name, parameter)
            }
            var first = caret
            var offset = expected.count
            var emptySteps = 0
            while offset > 0, remainingSteps > 0, hasTime(before: deadline) {
                remainingSteps -= 1
                guard let value = query("AXPreviousTextMarkerForTextMarker", first),
                      CFGetTypeID(value) == AXTextMarkerGetTypeID() else { break }
                let previous = value as! AXTextMarker
                guard !CFEqual(previous, first) else { break }
                let stepRange = AXTextMarkerRangeCreate(kCFAllocatorDefault, previous, first)
                guard let step = query(stringForRange, stepRange) as? String else { break }
                let units = Array(step.utf16)
                guard units.count <= offset,
                      units.elementsEqual(expected[(offset - units.count)..<offset]) else { break }
                if units.isEmpty {
                    emptySteps += 1
                    guard emptySteps <= 4 else { break }
                } else {
                    emptySteps = 0
                }
                offset -= units.count
                first = previous
            }
            guard offset == 0 else { continue }
            let range = AXTextMarkerRangeCreate(kCFAllocatorDefault, first, caret)
            guard let text = query(stringForRange, range) as? String,
                  text.utf16.elementsEqual(expected),
                  let attributed = query("AXAttributedStringForTextMarkerRange", range) as? NSAttributedString,
                  attributed.string.utf16.elementsEqual(expected),
                  hasTime(before: deadline),
                  let current = attribute(selectionHolder, selectedRange),
                  CFGetTypeID(current) == AXTextMarkerRangeGetTypeID(),
                  hasTime(before: deadline) else { continue }
            let currentRange = current as! AXTextMarkerRange
            guard CFEqual(AXTextMarkerRangeCopyStartMarker(currentRange), caret),
                  CFEqual(AXTextMarkerRangeCopyEndMarker(currentRange), caret) else { return nil }
            return attributed
        }
        return nil
    }

    /// True when the browser's selection markers span any text.
    static func hasNonemptySelection(from element: AXUIElement) -> Bool {
        guard let (_, _, selected) = selection(for: element, needsArea: false),
              CFGetTypeID(selected) == AXTextMarkerRangeGetTypeID() else { return false }
        let range = selected as! AXTextMarkerRange
        return !CFEqual(AXTextMarkerRangeCopyStartMarker(range), AXTextMarkerRangeCopyEndMarker(range))
    }

    /// Returns whatever the browser is willing to answer: the text just before
    /// the caret, the caret rectangle, or both. `includeText` is false when the
    /// caller already has the text and needs only the caret rectangle: the text
    /// is fetched from the start of the document, the expensive part of a read.
    static func read(from element: AXUIElement, limit: Int = 1200, includeText: Bool = true) -> Reading? {
        guard let (holder, area, selection) = selection(for: element, needsArea: includeText) else { return nil }
        let caretRect = rect(from: holder, selection: selection)

        // Text from the start of the document up to the caret.
        var text: String?
        var windowStart: Int?
        if includeText, let caretMarker = parameterized(holder, startOfRange, selection),
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
