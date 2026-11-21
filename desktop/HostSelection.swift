//  Selecting text in the focused host before writing over it.
//
//  macOS offers its own completion of a partly typed word in grey. While it
//  shows, AppKit editors such as Notes do not take a selection change the way
//  they report it (see `CompletionTransaction.checkSelection`), so both the
//  plain insertion and the share link select through here.

import ApplicationServices

/// The selection calls a write needs, so the handling of a pending
/// prediction can be checked against a simulated host.
protocol SelectableHostText {
    func setSelection(_ range: Range<Int>) -> Bool
    var selection: Range<Int>? { get }
    /// An inline prediction or input method composition. Hosts that do not
    /// expose it are taken to hold none.
    var hasMarkedText: Bool { get }
}

struct AccessibilitySelectableText: SelectableHostText {
    let element: AXUIElement

    func setSelection(_ range: Range<Int>) -> Bool {
        var value = CFRange(location: range.lowerBound, length: range.count)
        guard let axRange = AXValueCreate(.cfRange, &value) else { return false }
        return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange) == .success
    }

    var selection: Range<Int>? {
        guard let range = rangeAttribute(kAXSelectedTextRangeAttribute),
              range.location >= 0, range.length >= 0 else { return nil }
        return range.location..<(range.location + range.length)
    }

    var hasMarkedText: Bool { (rangeAttribute("AXTextInputMarkedRange")?.length ?? 0) > 0 }

    private func rangeAttribute(_ name: String) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
    }
}

enum HostSelection {
    /// The first selection change past a pending prediction only dismisses
    /// it; the next one normally lands.
    static let predictionAttempts = 3

    /// Selects the text a write replaces, or keeps the caret for a plain
    /// insertion, and says whether the write may go ahead. Non-empty ranges
    /// always read back the host's selection so a host that swallows the first
    /// selection write (such as Notes dismissing an inline prediction without
    /// exposing marked text) is retried instead of appending at the caret.
    static func selectForWrite(_ range: Range<Int>, caret: Int, in host: SelectableHostText,
                               pause: () -> Void = {}) -> Bool {
        if range.isEmpty && !host.hasMarkedText { return true }
        var stepOff = range.isEmpty
        for attempt in 0..<predictionAttempts {
            // Asking for the range the host already reports changes nothing,
            // which would leave the prediction in place. Step off it first.
            if stepOff {
                let anchor = range.isEmpty ? max(0, caret - 1) : range.lowerBound
                _ = host.setSelection(anchor..<anchor)
            }
            guard host.setSelection(range) else { return false }
            let reported = host.selection
            switch CompletionTransaction.checkSelection(requested: range, reported: reported,
                                                        caret: caret, markedText: host.hasMarkedText) {
            case .selected: return true
            case .retry:
                stepOff = range.isEmpty || reported == range
                if attempt + 1 < predictionAttempts { pause() }
                continue
            case .stop: return false
            }
        }
        return false
    }

    static func selectForWrite(_ range: Range<Int>, caret: Int, in element: AXUIElement) -> Bool {
        selectForWrite(range, caret: caret, in: AccessibilitySelectableText(element: element),
                       pause: { Thread.sleep(forTimeInterval: 0.020) })
    }
}
