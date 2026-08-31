//  Host capability probe.
//
//  Answers one question empirically, per application: can CoLab obtain the text
//  and the on-screen geometry of an arbitrary committed range here?
//
//  This exists so the adapter strategy is validated against real hosts instead
//  of assumed. Run it from the menu with the caret in a text field; it writes a
//  report and changes nothing.

import Cocoa
import ApplicationServices

enum HostCapabilityProbe {
    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func parameterized(_ element: AXUIElement, _ name: String,
                                      _ parameter: CFTypeRef) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            element, name as CFString, parameter, &value) == .success else { return nil }
        return value
    }

    private static func mark(_ ok: Bool) -> String { ok ? "✓" : "✗" }

    /// Probes whatever is focused and returns a human-readable report.
    static func run() -> String {
        guard AXIsProcessTrusted() else {
            return "HOST PROBE\n  ✗ Accessibility permission not granted"
        }
        guard let application = NSWorkspace.shared.frontmostApplication else {
            return "HOST PROBE\n  ✗ no frontmost application"
        }
        let name = application.localizedName ?? "?"
        var report = ["HOST PROBE  \(name)"]

        let appElement = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(appElement, 0.6)
        guard let focused = attribute(appElement, kAXFocusedUIElementAttribute as String),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            report.append("  ✗ no focused element — put the caret in a text field first")
            return report.joined(separator: "\n")
        }
        let element = focused as! AXUIElement
        let role = attribute(element, kAXRoleAttribute as String) as? String ?? "?"
        report.append("  role: \(role)")

        // 1. Text, and which index space it belongs to.
        let elementText = attribute(element, kAXValueAttribute as String) as? String
        let documentText = WebTextReader.documentText(from: element)
        let text = elementText ?? documentText
        let space = elementText != nil ? "element (AXValue)" : (documentText != nil ? "document (markers)" : "none")
        report.append("  \(mark(text != nil)) text readable · space: \(space) · \(text?.count ?? 0) chars")
        guard let text, text.count > 4 else {
            report.append("  · type a few words into the field and probe again")
            return report.joined(separator: "\n")
        }

        // 2. A committed range: the last word, not the live selection.
        let units = Array(text.utf16)
        var start = units.count
        while start > 0, units[start - 1] != 32, units[start - 1] != 10 { start -= 1 }
        let range = start..<units.count
        let phrase = String(decoding: units[range], as: UTF16.self)
        report.append("  probing committed range \(range.lowerBound)..<\(range.upperBound) “\(phrase)”")

        // 3. Geometry, by each available route.
        var cfRange = CFRange(location: range.lowerBound, length: range.count)
        var elementRects = false
        if let axRange = AXValueCreate(.cfRange, &cfRange),
           let value = parameterized(element, kAXBoundsForRangeParameterizedAttribute as String, axRange),
           CFGetTypeID(value) == AXValueGetTypeID() {
            var rect = CGRect.zero
            if AXValueGetValue(value as! AXValue, .cgRect, &rect), rect.height > 0 {
                elementRects = true
                report.append("  ✓ AXBoundsForRange on element → \(describe(rect))")
            }
        }
        if !elementRects { report.append("  ✗ AXBoundsForRange on element") }

        let markerRects = WebTextReader.rects(forRange: range, from: element)
        if markerRects.isEmpty {
            report.append("  ✗ AXTextMarkerForIndex → AXBoundsForTextMarkerRange")
        } else {
            report.append("  ✓ AXTextMarkerForIndex → AXBoundsForTextMarkerRange → "
                          + "\(markerRects.count) rect(s), first \(describe(markerRects[0]))")
        }

        var inferredRects: [CGRect] = []
        if !elementRects, markerRects.isEmpty, let elementText {
            let adapter = AccessibilityTextAdapter()
            inferredRects = adapter.inferredRects(for: range, text: elementText, in: element)
            if inferredRects.isEmpty {
                report.append("  ✗ calibrated AX attributed-text layout")
            } else {
                report.append("  ✓ calibrated AX attributed-text layout → "
                              + "\(inferredRects.count) rect(s), first \(describe(inferredRects[0]))")
            }
        }

        // 4. The verdict the architecture decision rests on.
        let usable = elementRects || !markerRects.isEmpty || !inferredRects.isEmpty
        let verdict = usable
            ? "✓ VERDICT: persistent highlighting supported here"
            : "✗ VERDICT: no committed-range geometry — this host needs a browser content bridge"
        report.append("  " + verdict)
        return report.joined(separator: "\n")
    }

    private static func describe(_ rect: CGRect) -> String {
        "\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))×\(Int(rect.height))"
    }
}
