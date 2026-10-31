import Cocoa
import ApplicationServices

/// Reads and writes run on `AccessibilityWork.queue`, including those made
/// while inserting an accepted suggestion.
enum AccessibilityReader {
    private static let excludedRoles: Set<String> = ["AXSecureTextField"]
    private static let maxContext = 1200

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func focusedElement() -> (AXUIElement, pid_t)? {
        // Ask the frontmost application directly; the system-wide element is a
        // fallback because some apps answer only one of the two.
        if let front = NSWorkspace.shared.frontmostApplication {
            let pid = front.processIdentifier
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.4)
            // Electron and Chromium publish their tree only once a client asks.
            _ = HostAccessibilityMode.shared.prime(pid: pid, application: application)
            if let focused = attribute(application, kAXFocusedUIElementAttribute as String),
               CFGetTypeID(focused) == AXUIElementGetTypeID() {
                return (focused as! AXUIElement, pid)
            }
        }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.4)
        if let focused = attribute(system, kAXFocusedUIElementAttribute as String),
           CFGetTypeID(focused) == AXUIElementGetTypeID() {
            var pid: pid_t = 0
            AXUIElementGetPid(focused as! AXUIElement, &pid)
            return (focused as! AXUIElement, pid)
        }
        return nil
    }

    /// `extending` widens the window by that many characters, so an
    /// insertion longer than the usual window reads back whole, with the
    /// text before it.
    static func focusedContext(allowSelection: Bool = false, extending extra: Int = 0) -> CaretContext? {
        guard let (field, _) = focusedElement() else {
            return nil
        }
        return context(of: field, allowSelection: allowSelection, extending: extra)
    }

    /// Read a known editor directly, whichever app is frontmost. Checks made
    /// after an edit use this so switching apps does not hide what landed.
    static func context(of field: AXUIElement, allowSelection: Bool = false,
                        extending extra: Int = 0) -> CaretContext? {
        let reach = maxContext + max(0, extra)
        var pid: pid_t = 0
        AXUIElementGetPid(field, &pid)
        AXUIElementSetMessagingTimeout(field, 0.4)

        let role = attribute(field, kAXRoleAttribute as String) as? String ?? "?"
        let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "?"
        let subrole = attribute(field, kAXSubroleAttribute as String) as? String
        if excludedRoles.contains(role) || HostTextSafety.isSecure(role: role, subrole: subrole) {
            return nil
        }

        // Caret offset. Without it there is nothing to complete.
        var caret = -1
        var selection = CFRange(location: 0, length: 0)
        if let rangeValue = attribute(field, kAXSelectedTextRangeAttribute as String),
           CFGetTypeID(rangeValue) == AXValueGetTypeID() {
            var parsed = CFRange()
            if AXValueGetValue(rangeValue as! AXValue, .cfRange, &parsed) {
                selection = parsed
                caret = parsed.location
            }
        }

        guard allowSelection || selection.length == 0 else { return nil }
        if caret < 0, WebTextReader.hasNonemptySelection(from: field) { return nil }

        var window: String?
        var windowStart = -1

        // Preferred: ask for just the span before the caret. Works in apps that
        // never expose a whole AXValue (Word, Pages, large documents).
        if caret >= 0 {
            let start = max(0, caret - reach)
            var span = CFRange(location: start, length: caret - start)
            if span.length > 0, let axSpan = AXValueCreate(.cfRange, &span) {
                var text: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(
                    field, kAXStringForRangeParameterizedAttribute as CFString, axSpan, &text) == .success,
                   let string = text as? String, !string.isEmpty {
                    window = string
                    windowStart = start
                }
            }
        }

        // Fallback: the element's whole value, sliced around the caret.
        if window == nil, let full = attribute(field, kAXValueAttribute as String) as? String {
            let utf16 = Array(full.utf16)
            let position = caret >= 0 ? min(caret, utf16.count) : utf16.count
            let start = max(0, position - reach)
            if start < position {
                window = String(decoding: utf16[start..<position], as: UTF16.self)
                windowStart = start
            } else if position == 0 {
                window = ""
                windowStart = 0
            }
        }

        // Character ranges only work where the app answered with them. Web
        // content is addressed by markers instead, which carry no integer
        // offsets, so edits there fall back to synthesized keys.
        var rect = caret >= 0 ? caretRect(for: field, caret: caret, selection: selection) : nil
        var addressable = caret >= 0 && window != nil

        // Markers answer for web content, and often give a caret rectangle even
        // where the character-range path already produced text. Text is only
        // fetched through markers when the range path had none.
        if window == nil || rect == nil {
            if let reading = WebTextReader.read(from: field, limit: reach, includeText: window == nil) {
                if window == nil, let markerText = reading.textBeforeCaret {
                    window = markerText
                    windowStart = reading.textWindowStart ?? -1
                    addressable = false
                }
                if rect == nil, let markerRect = reading.caretRect { rect = markerRect }
            }
        }
        // Measure the text, then settle for the field's own frame.
        if rect == nil, caret >= 0, let frame = fieldFrame(field) {
            rect = measuredCaretRect(field, caret: caret, field: frame) ?? frame
        }

        guard let text = window else { return nil }

        let textLength = Array(text.utf16).count
        return CaretContext(text: text, cursor: textLength,
                            windowStart: windowStart,
                            absoluteCaret: addressable ? caret : -1, selectionLength: selection.length,
                            caretRect: rect, element: field, diagnosis: "\(app)/\(role)")
    }

    /// Screen rectangle of the insertion point, in Accessibility's top-left
    /// coordinate space. Falls back to the focused element's own frame so the
    /// box still lands on the text rather than the pointer.
    private static func caretRect(for element: AXUIElement, caret: Int, selection: CFRange) -> CGRect? {
        func bounds(_ location: Int, _ length: Int) -> CGRect? {
            guard location >= 0 else { return nil }
            var range = CFRange(location: location, length: length)
            guard let axRange = AXValueCreate(.cfRange, &range) else { return nil }
            var value: CFTypeRef?
            guard AXUIElementCopyParameterizedAttributeValue(
                    element, kAXBoundsForRangeParameterizedAttribute as CFString, axRange, &value) == .success,
                  let box = value, CFGetTypeID(box) == AXValueGetTypeID() else { return nil }
            var rect = CGRect.zero
            guard AXValueGetValue(box as! AXValue, .cgRect, &rect),
                  rect.origin.x.isFinite, rect.origin.y.isFinite,
                  rect.height > 0, rect.height < 400 else { return nil }
            return rect
        }

        // A character beside the caret, unless it is a line break.
        func neighbour(_ location: Int) -> CGRect? {
            guard location >= 0 else { return nil }
            var range = CFRange(location: location, length: 1)
            guard let axRange = AXValueCreate(.cfRange, &range) else { return nil }
            var value: CFTypeRef?
            guard AXUIElementCopyParameterizedAttributeValue(
                    element, kAXStringForRangeParameterizedAttribute as CFString, axRange, &value) == .success,
                  let character = (value as? String)?.first, !character.isNewline else { return nil }
            return bounds(location, 1)
        }

        // Notes puts a collapsed range a line above the caret; the characters
        // beside it show which line it is really on.
        if let rect = bounds(caret, 0) {
            return CaretLine.aligned(rect, before: neighbour(caret - 1), after: neighbour(caret))
        }
        if let rect = bounds(max(0, caret - 1), 1) { return rect }
        if selection.length > 0, let rect = bounds(selection.location, selection.length) { return rect }
        return nil
    }

    /// The focused field's own frame.
    private static func fieldFrame(_ element: AXUIElement) -> CGRect? {
        guard let positionValue = attribute(element, kAXPositionAttribute as String),
              let sizeValue = attribute(element, kAXSizeAttribute as String),
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
              size.height > 0, size.width > 0 else { return nil }
        return CGRect(origin: origin, size: size)
    }

    /// Single-line fields such as a browser address bar often refuse
    /// AXBoundsForRange while still handing over an attributed string. Measuring
    /// the text before the caret puts the box under the caret rather than under
    /// the field.
    private static func measuredCaretRect(_ element: AXUIElement, caret: Int, field: CGRect) -> CGRect? {
        guard caret > 0 else { return CGRect(x: field.minX, y: field.minY, width: 1, height: field.height) }
        var range = CFRange(location: 0, length: caret)
        guard let axRange = AXValueCreate(.cfRange, &range) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
                element, "AXAttributedStringForRange" as CFString, axRange, &value) == .success,
              let attributed = value as? NSAttributedString, attributed.length > 0 else { return nil }
        let width = attributed.size().width
        guard width.isFinite, width >= 0 else { return nil }
        return CGRect(x: min(field.minX + width, field.maxX - 1), y: field.minY,
                      width: 1, height: field.height)
    }

    /// Measure a known editor after its owner has been validated. Avoid a
    /// second focus lookup that could accidentally measure another window.
    static func caretRect(of field: AXUIElement) -> CGRect? {
        var selection = CFRange(location: 0, length: 0)
        var caret = -1
        if let rangeValue = attribute(field, kAXSelectedTextRangeAttribute as String),
           CFGetTypeID(rangeValue) == AXValueGetTypeID() {
            var parsed = CFRange()
            if AXValueGetValue(rangeValue as! AXValue, .cfRange, &parsed) {
                selection = parsed
                caret = parsed.location
            }
        }
        if caret >= 0, let rect = caretRect(for: field, caret: caret, selection: selection) { return rect }
        if let rect = WebTextReader.caretRect(from: field) { return rect }
        if caret >= 0, let frame = fieldFrame(field) {
            return measuredCaretRect(field, caret: caret, field: frame) ?? frame
        }
        return nil
    }

    /// Replaces `length` characters ending at the caret with `text`. A length of
    /// zero is a plain insertion.
    /// Replaces the partial word with `text`.
    ///
    /// Accessibility writes are tried first because they are instant and do not
    /// disturb the user's clipboard or key state, but several applications
    /// report success while changing nothing. The result is therefore read back
    /// and typed instead when it did not land.
    /// Apps that accept an Accessibility text write but change nothing, such
    /// as Chromium web fields. Lasso types straight away there, so the partial
    /// word is never left selected while it waits to see whether a write landed:
    /// a keystroke in that window would replace the selection.
    /// One miss can be the user typing during the check, so an app is skipped
    /// only after two misses. It is tried again after a month, and a write that
    /// lands clears its record.
    private enum IgnoredTextWrites {
        private static let key = "AccessibilityWriteFailures"
        private static let strikes = 2
        private static let retryAfter: TimeInterval = 30 * 24 * 60 * 60
        private static var records: [String: [Double]] {
            UserDefaults.standard.dictionary(forKey: key) as? [String: [Double]] ?? [:]
        }

        static func contains(_ bundle: String?) -> Bool {
            guard let bundle, let record = records[bundle], record.count == 2 else { return false }
            return Int(record[0]) >= strikes && Date().timeIntervalSince1970 - record[1] < retryAfter
        }

        static func remember(_ bundle: String?) {
            guard let bundle else { return }
            var all = records
            let now = Date().timeIntervalSince1970
            let previous = all[bundle].flatMap { $0.count == 2 && now - $0[1] < retryAfter ? $0[0] : nil } ?? 0
            all[bundle] = [previous + 1, now]
            UserDefaults.standard.set(all, forKey: key)
        }

        static func forget(_ bundle: String?) {
            guard let bundle, records[bundle] != nil else { return }
            var all = records
            all[bundle] = nil
            UserDefaults.standard.set(all, forKey: key)
        }
    }

    private static func bundleIdentifier(of element: AXUIElement) -> String? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { return nil }
        return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    }

    /// Accessibility queue only, where `completion` is called too.
    static func replace(length: Int, at caret: Int, with text: String, in element: AXUIElement,
                        expected: CaretContext, expectedPrefix: String, verbatim: Bool = false,
                        completion: ((Bool) -> Void)? = nil) {
        guard let initial = focusedContext(), CFEqual(initial.element, element),
              initial.windowStart == expected.windowStart, initial.absoluteCaret == caret,
              CompletionTransaction.equivalentHostText(Array(initial.text.utf16), Array(expected.text.utf16)) else {
            completion?(false); return
        }
        let before = CompletionSnapshot(documentStart: expected.windowStart, text: Array(expected.text.utf16))
        let originalValue = attribute(element, kAXValueAttribute as String) as? String
        var selectedRange = false
        var wroteText = false
        let bundle = bundleIdentifier(of: element)

        if caret >= 0, caret - length >= 0, !IgnoredTextWrites.contains(bundle) {
            let ready = HostSelection.selectForWrite((caret - length)..<caret, caret: caret, in: element)
            selectedRange = length > 0 && ready
            if ready {
                wroteText = AXUIElementSetAttributeValue(
                    element, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success
            }
        }

        // Let the application apply the change before judging it.
        AccessibilityWork.queue.asyncAfter(deadline: .now() + (wroteText ? 0.12 : 0.05)) {
            if wroteText, landed(text, in: element) {
                IgnoredTextWrites.forget(bundle)
                completion?(true)
                return
            }
            if wroteText { IgnoredTextWrites.remember(bundle) }
            guard let current = focusedContext(allowSelection: true), CFEqual(current.element, element),
                  CompletionTransaction.canRetry(before: before,
                    current: CompletionSnapshot(documentStart: current.windowStart, text: Array(current.text.utf16)),
                    selectionLength: current.selectionLength, expectedPrefix: expectedPrefix,
                    selectedPrefix: selectedRange) else { completion?(false); return }
            if let originalValue, attribute(element, kAXValueAttribute as String) as? String != originalValue {
                completion?(false); return
            }
            if selectedRange,
               attribute(element, kAXSelectedTextAttribute as String) as? String != expectedPrefix {
                completion?(false); return
            }
            // A live selection already covers the partial word.
            SyntheticKeyboard.deleteBackwards(selectedRange ? 0 : expectedPrefix.count)
            if verbatim || !SyntheticKeyboard.canType(text) {
                // Typed, code would meet the host's auto-indent, closing brackets
                // and smart quotes, and line breaks arrive out of order or send
                // a chat message.
                RichTextInserter.pastePlainText(text)
                AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.14) {
                    RichTextInserter.verifyEventually(verify: { landed(text, in: element) }) { completion?($0) }
                }
                return
            }
            SyntheticKeyboard.type(text)
            // Confirm the typed result rather than assuming it arrived.
            AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.14) {
                let ok = landed(text, in: element)
                completion?(ok)
            }
        }
    }

    /// Takes back an insertion that ends at the caret: selects its text and
    /// writes what it replaced, by Accessibility or, where the host ignores
    /// that, by keyboard. A link is deleted first, so the typed letters that
    /// return cannot take on its formatting. Says whether the host then shows
    /// exactly that edit. Accessibility queue only, where `completion` is called too.
    static func revert(_ plan: CompletionPlan, in element: AXUIElement, expected: CaretContext,
                       unlink: Bool, completion: @escaping (Bool) -> Void) {
        let caret = expected.absoluteCaret
        let before = CompletionSnapshot(documentStart: expected.windowStart, text: Array(expected.text.utf16))
        let bundle = bundleIdentifier(of: element)
        let selected = !IgnoredTextWrites.contains(bundle)
            && HostSelection.selectForWrite((caret - plan.range.count)..<caret, caret: caret, in: element)
        func write(_ text: String) -> Bool {
            AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success
        }
        var wrote = false
        if selected {
            wrote = unlink && !plan.insertText.isEmpty ? write("") && write(plan.insertText) : write(plan.insertText)
        }
        func reverted() -> Bool {
            guard let after = focusedContext(), CFEqual(after.element, element) else { return false }
            let snapshot = CompletionSnapshot(documentStart: after.windowStart, text: Array(after.text.utf16))
            if case .success = CompletionTransaction.verify(before: before, after: snapshot, plan: plan) { return true }
            return false
        }
        AccessibilityWork.queue.asyncAfter(deadline: .now() + (wrote ? 0.12 : 0.05)) {
            if reverted() { completion(true); return }
            // Type it only over the untouched insertion, never over a late write.
            guard let current = focusedContext(allowSelection: true, extending: plan.range.count),
                  CFEqual(current.element, element),
                  CompletionTransaction.canRetry(before: before,
                    current: CompletionSnapshot(documentStart: current.windowStart, text: Array(current.text.utf16)),
                    selectionLength: current.selectionLength, expectedPrefix: plan.expectedPrefix,
                    selectedPrefix: current.selectionLength > 0) else { completion(false); return }
            SyntheticKeyboard.deleteBackwards(current.selectionLength > 0 ? 1 : plan.expectedPrefix.count)
            if !plan.insertText.isEmpty { SyntheticKeyboard.type(plan.insertText) }
            AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.14) { completion(reverted()) }
        }
    }

    static func canPaste(in element: AXUIElement, before: CompletionSnapshot, caret: Int,
                         expectedPrefix: String, selected: Bool) -> Bool {
        guard let current = focusedContext(allowSelection: true), CFEqual(current.element, element),
              CompletionTransaction.canRetry(before: before,
                current: CompletionSnapshot(documentStart: current.windowStart, text: Array(current.text.utf16)),
                selectionLength: current.selectionLength, expectedPrefix: expectedPrefix,
                selectedPrefix: selected) else { return false }
        if selected {
            return attribute(element, kAXSelectedTextAttribute as String) as? String == expectedPrefix
        }
        return current.absoluteCaret == caret
    }

    static func hyperlinkPresent(_ label: String, url: URL, in context: CaretContext) -> Bool {
        let length = label.utf16.count
        if context.absoluteCaret >= length {
            var range = CFRange(location: context.absoluteCaret - length, length: length)
            if let axRange = AXValueCreate(.cfRange, &range) {
                var value: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(context.element,
                    "AXAttributedStringForRange" as CFString, axRange, &value) == .success,
                   let text = value as? NSAttributedString, text.string == label,
                   RichTextInserter.containsLink(text, to: url) { return true }
            }
        }
        if let text = WebTextReader.attributedTextBeforeCaret(expectedText: label, from: context.element),
           RichTextInserter.containsLink(text, to: url) { return true }
        return WebTextReader.hyperlinkBeforeCaret(label, url: url, caret: context.absoluteCaret,
                                                 from: context.element)
    }

    /// True when the text now sits immediately before the caret.
    static func landed(_ text: String, in element: AXUIElement) -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let context = focusedContext(extending: text.utf16.count), context.element == element else { return false }
        return CompletionTransaction.insertionIsAtCaret(text, in: context.text)
    }
}
