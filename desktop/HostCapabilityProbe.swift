//  Host capability probe.
//
//  Answers one question empirically, per application: can Lasso obtain the text
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
        let whitespace: Set<UInt16> = [9, 10, 13, 32, 160, 0x2028, 0x2029]
        var end = units.count
        while end > 0, whitespace.contains(units[end - 1]) { end -= 1 }
        var start = end
        while start > 0, !whitespace.contains(units[start - 1]) { start -= 1 }
        guard start < end else {
            report.append("  · type a word into the field and probe again")
            return report.joined(separator: "\n")
        }
        let range = start..<end
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

        let browserRects: [CGRect]
        if let elementText {
            browserRects = WebTextReader.rects(forElementRange: range, text: elementText, from: element)
            report.append("  \(mark(!browserRects.isEmpty)) browser text-leaf bounds in element index space")
        } else {
            browserRects = WebTextReader.rects(forRange: range, from: element)
            report.append("  \(mark(!browserRects.isEmpty)) text-marker bounds in document index space")
        }
        if let first = browserRects.first {
            report.append("    \(browserRects.count) rect(s), first \(describe(first))")
        }

        // Approximate caret-based layout cannot establish persistent support.
        let usable = elementRects || !browserRects.isEmpty
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
