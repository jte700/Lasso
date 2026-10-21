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
    /// insertion, and says whether the write may go ahead. Without a pending
    /// prediction this is a single selection write, and none at all for a
    /// plain insertion.
    static func selectForWrite(_ range: Range<Int>, caret: Int, in host: SelectableHostText) -> Bool {
        guard host.hasMarkedText else { return range.isEmpty || host.setSelection(range) }
        for _ in 0..<predictionAttempts {
            // Asking for the caret the host already reports changes nothing,
            // which would leave the prediction in place. Step off it first.
            if range.isEmpty { _ = host.setSelection(max(0, caret - 1)..<max(0, caret - 1)) }
            guard host.setSelection(range) else { return false }
            switch CompletionTransaction.checkSelection(requested: range, reported: host.selection,
                                                        caret: caret, markedText: host.hasMarkedText) {
            case .selected: return true
            case .retry: continue
            case .stop: return false
            }
        }
        return false
    }

    static func selectForWrite(_ range: Range<Int>, caret: Int, in element: AXUIElement) -> Bool {
        selectForWrite(range, caret: caret, in: AccessibilitySelectableText(element: element))
    }
}
