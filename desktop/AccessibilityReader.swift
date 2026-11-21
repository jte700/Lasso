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

    private static func focusedElement() -> (element: AXUIElement?, pid: pid_t?, primed: Bool) {
        // Ask the frontmost application directly; the system-wide element is a
        // fallback because some apps answer only one of the two.
        var primed = false
        if let front = NSWorkspace.shared.frontmostApplication {
            let pid = front.processIdentifier
            // Lasso's own windows are never read: see `AccessibilityWork.mayRead`.
            guard AccessibilityWork.mayRead(pid: pid) else { return (nil, nil, false) }
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.4)
            // Electron and Chromium publish their tree only once a client asks.
            let mode = HostAccessibilityMode.shared.prime(pid: pid, application: application)
            primed = mode == "accessibility mode: manual" || mode == "accessibility mode: enhanced"
            if let focused = attribute(application, kAXFocusedUIElementAttribute as String),
               CFGetTypeID(focused) == AXUIElementGetTypeID() {
                return (FocusedTextElement.resolve(focused as! AXUIElement), pid, primed)
            }
        }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.4)
        if let focused = attribute(system, kAXFocusedUIElementAttribute as String),
           CFGetTypeID(focused) == AXUIElementGetTypeID() {
            var pid: pid_t = 0
            AXUIElementGetPid(focused as! AXUIElement, &pid)
            guard AccessibilityWork.mayRead(pid: pid) else { return (nil, nil, primed) }
            return (FocusedTextElement.resolve(focused as! AXUIElement), pid, primed)
        }
        return (nil, nil, primed)
    }

    /// True when the field is intentionally skipped (passwords, search/lookup),
    /// so returning nil there must not trigger Chromium accessibility re-priming.
    private static func isExcludedField(_ field: AXUIElement) -> Bool {
        let role = attribute(field, kAXRoleAttribute as String) as? String ?? "?"
        let subrole = attribute(field, kAXSubroleAttribute as String) as? String
        if excludedRoles.contains(role) || HostTextSafety.isSecure(role: role, subrole: subrole) { return true }
        return HostTextSafety.isLookup(role: role, subrole: subrole,
                                       identifier: attribute(field, kAXIdentifierAttribute as String) as? String)
    }

    /// `extending` widens the window by that many characters, so an
    /// insertion longer than the usual window reads back whole, with the
    /// text before it.
    static func focusedContext(allowSelection: Bool = false, extending extra: Int = 0) -> CaretContext? {
        focusedContextWithPrimeStatus(allowSelection: allowSelection, extending: extra).context
    }

    /// Reads the focused context and reports whether Chromium accessibility
    /// was just activated or recovered, so the caller can re-read once Blink
    /// finishes building its tree.
    static func focusedContextWithPrimeStatus(allowSelection: Bool = false,
                                              extending extra: Int = 0) -> (context: CaretContext?, primedAccessibility: Bool) {
        let found = focusedElement()
        if let element = found.element,
           let read = context(of: element, allowSelection: allowSelection, extending: extra) {
            return (read, found.primed)
        }
        if let element = found.element, isExcludedField(element) {
            return (nil, false)
        }
        if found.primed {
            return (nil, true)
        }
        var primed = false
        if let front = NSWorkspace.shared.frontmostApplication {
            let pid = front.processIdentifier
            if AccessibilityWork.mayRead(pid: pid) {
                let application = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(application, 0.4)
                if HostAccessibilityMode.shared.reprimeIfUnreadable(pid: pid, application: application) {
                    primed = true
                }
            }
        }
        return (nil, primed)
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
        if HostTextSafety.isLookup(role: role, subrole: subrole,
                                   identifier: attribute(field, kAXIdentifierAttribute as String) as? String) {
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

        // At offset 0 in an app without AXValue (such as Word or Pages when a
        // leading word is selected), there are zero characters before the caret.
        if window == nil, caret == 0 {
            var hasRangeSupport = attribute(field, kAXNumberOfCharactersAttribute as String) != nil
            if !hasRangeSupport, selection.length > 0 {
                var selectedSpan = selection
                if let axSpan = AXValueCreate(.cfRange, &selectedSpan) {
                    var text: CFTypeRef?
                    hasRangeSupport = AXUIElementCopyParameterizedAttributeValue(
                        field, kAXStringForRangeParameterizedAttribute as CFString, axSpan, &text) == .success
                        && text is String
                }
            }
            if hasRangeSupport {
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
        // Measure the text, then settle for the field's first line so tall
        // web editors still have a valid caret height under 400 pt.
        if rect == nil, let frame = fieldFrame(field) {
            rect = (caret >= 0 ? measuredCaretRect(field, caret: caret, field: frame) : nil) ?? CaretLine.line(frame)
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

    /// The rectangle of the character at `index`, in Accessibility
    /// coordinates: where a prompt about to be erased began, which is where
    /// the answer will be. Nil where the field does not say. Accessibility queue only.
    static func characterRect(in element: AXUIElement, at index: Int) -> CGRect? {
        guard index >= 0 else { return nil }
        var range = CFRange(location: index, length: 1)
        guard let axRange = AXValueCreate(.cfRange, &range) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute as CFString,
                                                         axRange, &value) == .success,
              let box = value, CFGetTypeID(box) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(box as! AXValue, .cgRect, &rect), HostGeometryConverter.isUsable(rect),
              rect.height <= CaretLine.tallestLine else { return nil }
        return rect
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
        // An empty field's caret is on its first line.
        guard caret > 0 else { return CaretLine.line(CGRect(x: field.minX, y: field.minY, width: 1, height: field.height)) }
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
        if let frame = fieldFrame(field) {
            return (caret >= 0 ? measuredCaretRect(field, caret: caret, field: frame) : nil) ?? CaretLine.line(frame)
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
            guard let bundle else { return false }
            if CompletionTransaction.prefersKeyboardInsertion(bundleIdentifier: bundle) { return true }
            guard let record = records[bundle], record.count == 2 else { return false }
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

    private static func writeByKeyboard(_ text: String, verbatim: Bool, in element: AXUIElement,
                                        completion: ((Bool) -> Void)?) {
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
        AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.12) {
            RichTextInserter.verifyEventually(attempts: 6, interval: 0.08,
                                              verify: { landed(text, in: element) }) { completion?($0) }
        }
    }

    private static func deletePrefixAndWrite(expectedPrefix: String, before: CompletionSnapshot, caret: Int,
                                             hasSelectedPrefix: Bool, hadMarkedText: Bool,
                                             text: String, verbatim: Bool, in element: AXUIElement,
                                             completion: ((Bool) -> Void)?) {
        // A live selection already covers the partial word.
        let deleteCount = hasSelectedPrefix ? 0 : expectedPrefix.count
        guard deleteCount > 0 else {
            let needsClear = !hasSelectedPrefix && caret >= 0
                && AccessibilitySelectableText(element: element).hasMarkedText
                && (verbatim || !SyntheticKeyboard.canType(text) || text.first?.isWhitespace == true)
            if needsClear {
                guard HostSelection.selectForWrite(caret..<caret, caret: caret, in: element) else {
                    completion?(false)
                    return
                }
                AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.025) {
                    writeByKeyboard(text, verbatim: verbatim, in: element, completion: completion)
                }
                return
            }
            writeByKeyboard(text, verbatim: verbatim, in: element, completion: completion)
            return
        }

        SyntheticKeyboard.deleteBackwards(deleteCount)
        let initialSettle = 0.035 + min(0.08, Double(deleteCount) * 0.003)
        guard caret >= 0, before.documentStart >= 0 else {
            AccessibilityWork.queue.asyncAfter(deadline: .now() + initialSettle) {
                writeByKeyboard(text, verbatim: verbatim, in: element, completion: completion)
            }
            return
        }

        func waitForDeletion(attemptsLeft: Int, retriedDelete: Bool, lastRemaining: String?) {
            guard let after = focusedContext(), CFEqual(after.element, element) else {
                if attemptsLeft > 1 {
                    AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.035) {
                        waitForDeletion(attemptsLeft: attemptsLeft - 1, retriedDelete: retriedDelete,
                                        lastRemaining: lastRemaining)
                    }
                    return
                }
                completion?(false)
                return
            }
            let snapshot = CompletionSnapshot(documentStart: after.windowStart, text: Array(after.text.utf16))
            switch CompletionTransaction.checkPrefixDeletion(before: before, after: snapshot,
                                                             expectedPrefix: expectedPrefix) {
            case .complete:
                writeByKeyboard(text, verbatim: verbatim, in: element, completion: completion)
            case .changed:
                completion?(false)
            case .incomplete(let remaining):
                let canRetryRemaining = lastRemaining == remaining && !retriedDelete && !remaining.isEmpty
                    && (remaining.count < deleteCount || (deleteCount == 1 && hadMarkedText && markedTextRange(of: element) == nil))
                if canRetryRemaining {
                    // An initial Backspace only dismissed an inline prediction; remove the remaining prefix once.
                    SyntheticKeyboard.deleteBackwards(remaining.count)
                    let retrySettle = 0.035 + min(0.06, Double(remaining.count) * 0.003)
                    AccessibilityWork.queue.asyncAfter(deadline: .now() + retrySettle) {
                        waitForDeletion(attemptsLeft: 3, retriedDelete: true, lastRemaining: nil)
                    }
                    return
                }
                if attemptsLeft > 1 {
                    AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.035) {
                        waitForDeletion(attemptsLeft: attemptsLeft - 1, retriedDelete: retriedDelete,
                                        lastRemaining: remaining)
                    }
                    return
                }
                completion?(false)
            }
        }

        AccessibilityWork.queue.asyncAfter(deadline: .now() + initialSettle) {
            waitForDeletion(attemptsLeft: 5, retriedDelete: false, lastRemaining: nil)
        }
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
        let originalMarkedRange = markedTextRange(of: element)
        let bundle = bundleIdentifier(of: element)

        guard caret >= 0, caret - length >= 0, !IgnoredTextWrites.contains(bundle) else {
            deletePrefixAndWrite(expectedPrefix: expectedPrefix, before: before, caret: caret,
                                 hasSelectedPrefix: false, hadMarkedText: originalMarkedRange != nil,
                                 text: text, verbatim: verbatim, in: element, completion: completion)
            return
        }

        let editRange = (caret - length)..<caret
        let attemptedSelection = length > 0
        var ready = HostSelection.selectForWrite(editRange, caret: caret, in: element)
        if ready, length > 0,
           let actual = selectedText(of: element, caret: editRange.lowerBound, length: length),
           !CompletionTransaction.equivalentHostText(Array(actual.utf16), Array(expectedPrefix.utf16)) {
            ready = false
        }
        let valueBeforeWrite = attribute(element, kAXValueAttribute as String) as? String
        let markedBeforeWrite = markedTextRange(of: element)
        if ready,
           !CompletionTransaction.canReuseHostValue(beforeValue: originalValue, afterValue: valueBeforeWrite,
                                                    caret: caret, wroteText: false,
                                                    markedRange: originalMarkedRange,
                                                    afterMarkedRange: markedBeforeWrite) {
            ready = false
        }
        var wroteText = false
        if ready {
            wroteText = AXUIElementSetAttributeValue(
                element, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success
        }

        func collapseUncollapsedSelectionIfApplied(done: @escaping (Bool) -> Void) {
            let currentValue = attribute(element, kAXValueAttribute as String) as? String
            let currentSelection = AccessibilitySelectableText(element: element).selection
            guard CompletionTransaction.appliedWithUncollapsedSelection(
                beforeValue: valueBeforeWrite, afterValue: currentValue,
                editRange: editRange, insertText: text, selection: currentSelection) else {
                done(false); return
            }
            let finalCaret = editRange.lowerBound + text.utf16.count
            _ = AccessibilitySelectableText(element: element).setSelection(finalCaret..<finalCaret)
            AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.03) {
                done(landed(text, in: element))
            }
        }

        func finishAfterAXWrite() {
            if wroteText { IgnoredTextWrites.remember(bundle) }
            guard let current = focusedContext(allowSelection: true), CFEqual(current.element, element) else {
                completion?(false); return
            }
            let hasSelectedPrefix = attemptedSelection && length > 0 && current.selectionLength == length
            guard CompletionTransaction.canRetry(before: before,
                    current: CompletionSnapshot(documentStart: current.windowStart, text: Array(current.text.utf16)),
                    selectionLength: current.selectionLength, expectedPrefix: expectedPrefix,
                    selectedPrefix: hasSelectedPrefix) else { completion?(false); return }
            let currentValue = attribute(element, kAXValueAttribute as String) as? String
            let currentMarkedRange = markedTextRange(of: element)
            let baselineValue = wroteText ? valueBeforeWrite : originalValue
            let baselineMarked = wroteText ? markedBeforeWrite : originalMarkedRange
            guard CompletionTransaction.canReuseHostValue(
                    beforeValue: baselineValue, afterValue: currentValue,
                    caret: caret, wroteText: wroteText,
                    markedRange: baselineMarked, afterMarkedRange: currentMarkedRange) else {
                completion?(false); return
            }
            if hasSelectedPrefix {
                guard let actual = selectedText(of: element, caret: current.absoluteCaret,
                                                length: current.selectionLength),
                      CompletionTransaction.equivalentHostText(Array(actual.utf16), Array(expectedPrefix.utf16)) else {
                    completion?(false); return
                }
            }
            deletePrefixAndWrite(expectedPrefix: expectedPrefix, before: before, caret: caret,
                                 hasSelectedPrefix: hasSelectedPrefix, hadMarkedText: originalMarkedRange != nil,
                                 text: text, verbatim: verbatim, in: element, completion: completion)
        }

        // Let the application apply the change before judging it.
        AccessibilityWork.queue.asyncAfter(deadline: .now() + (wroteText ? 0.12 : 0.05)) {
            if wroteText {
                if landed(text, in: element) {
                    IgnoredTextWrites.forget(bundle)
                    completion?(true)
                    return
                }
                collapseUncollapsedSelectionIfApplied { collapsed in
                    if collapsed {
                        IgnoredTextWrites.forget(bundle)
                        completion?(true)
                        return
                    }
                    let currentValue = attribute(element, kAXValueAttribute as String) as? String
                    let unchanged: Bool = {
                        guard let valueBeforeWrite, let currentValue else { return false }
                        return CompletionTransaction.equivalentHostText(
                            Array(valueBeforeWrite.utf16), Array(currentValue.utf16))
                    }()
                    if unchanged {
                        finishAfterAXWrite()
                        return
                    }
                    RichTextInserter.verifyEventually(attempts: 3, interval: 0.05,
                                                      verify: { landed(text, in: element) }) { ok in
                        if ok {
                            IgnoredTextWrites.forget(bundle)
                            completion?(true)
                            return
                        }
                        collapseUncollapsedSelectionIfApplied { collapsedLate in
                            if collapsedLate {
                                IgnoredTextWrites.forget(bundle)
                                completion?(true)
                                return
                            }
                            finishAfterAXWrite()
                        }
                    }
                }
                return
            }
            finishAfterAXWrite()
        }
    }

    /// Deletes the `length` UTF-16 units before the caret, a backslash prompt
    /// an AI writer is about to answer: by Accessibility, or by Backspace
    /// where the host ignores that. `completion` is given the field as it
    /// reads afterwards, or nil when it does not show exactly that deletion.
    /// Accessibility queue only, where `completion` is called too.
    static func erase(length: Int, at caret: Int, in element: AXUIElement, expected: CaretContext,
                      completion: @escaping (CaretContext?) -> Void) {
        let before = Array(expected.text.utf16)
        guard length > 0, before.count >= length, let initial = focusedContext(), CFEqual(initial.element, element),
              initial.windowStart == expected.windowStart, initial.absoluteCaret == caret,
              CompletionTransaction.equivalentHostText(Array(initial.text.utf16), before) else {
            completion(nil); return
        }
        let kept = Array(before.dropLast(length))
        let erasedText = String(decoding: before.suffix(length), as: UTF16.self)
        // The window reaches further back once the text before the caret is
        // shorter, so what was kept is compared at its end.
        func erased() -> CaretContext? {
            guard let after = context(of: element) else { return nil }
            let now = Array(after.text.utf16)
            if kept.isEmpty {
                // The prompt was all that was read: a field it began is now empty before the caret.
                guard expected.windowStart > 0 || now.isEmpty else { return nil }
            } else {
                guard now.count >= kept.count,
                      CompletionTransaction.equivalentHostText(Array(now.suffix(kept.count)), kept) else { return nil }
            }
            // Nothing was deleted if the prompt still ends the text.
            if now.count >= before.count,
               CompletionTransaction.equivalentHostText(Array(now.suffix(before.count)), before) { return nil }
            return after
        }
        let bundle = bundleIdentifier(of: element)
        let tryAX = caret >= 0 && caret - length >= 0 && !IgnoredTextWrites.contains(bundle)
        var wrote = false
        if tryAX, HostSelection.selectForWrite((caret - length)..<caret, caret: caret, in: element) {
            wrote = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, "" as CFTypeRef) == .success
        }
        let finishErase = {
            if wrote, let after = erased() {
                IgnoredTextWrites.forget(bundle)
                completion(after)
                return
            }
            // An app that answered the write and changed nothing is typed into from now on.
            if wrote { IgnoredTextWrites.remember(bundle) }
            guard let current = focusedContext(allowSelection: true), CFEqual(current.element, element) else {
                completion(nil); return
            }
            if current.selectionLength > 0 {
                // Lasso's own selection of the prompt is still live: one Backspace deletes it.
                guard let actual = selectedText(of: element, caret: current.absoluteCaret, length: current.selectionLength),
                      CompletionTransaction.equivalentHostText(Array(actual.utf16), Array(erasedText.utf16)) else {
                    completion(nil); return
                }
                SyntheticKeyboard.deleteBackwards(1)
            } else {
                guard CompletionTransaction.equivalentHostText(Array(current.text.utf16), before) else {
                    completion(nil); return
                }
                SyntheticKeyboard.deleteBackwards(erasedText.count)
            }
            // A Backspace for each character takes a moment to arrive in the host.
            let wait = 0.14 + min(0.6, Double(erasedText.count) * 0.004)
            AccessibilityWork.queue.asyncAfter(deadline: .now() + wait) { completion(erased()) }
        }
        if tryAX {
            AccessibilityWork.queue.asyncAfter(deadline: .now() + (wrote ? 0.12 : 0.05), execute: finishErase)
        } else {
            finishErase()
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
        let tryAX = !IgnoredTextWrites.contains(bundle)
        let selected = tryAX
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
        let finishRevert = {
            if wrote, reverted() { completion(true); return }
            // Type it only over the untouched insertion, never over a late write.
            guard let current = focusedContext(allowSelection: true, extending: plan.range.count),
                  CFEqual(current.element, element),
                  CompletionTransaction.canRetry(before: before,
                    current: CompletionSnapshot(documentStart: current.windowStart, text: Array(current.text.utf16)),
                    selectionLength: current.selectionLength, expectedPrefix: plan.expectedPrefix,
                    selectedPrefix: current.selectionLength > 0) else { completion(false); return }
            let deleteCount = current.selectionLength > 0 ? 1 : plan.expectedPrefix.count
            SyntheticKeyboard.deleteBackwards(deleteCount)
            let settle: TimeInterval = deleteCount > 0 ? 0.04 + min(0.16, Double(deleteCount) * 0.004) : 0
            AccessibilityWork.queue.asyncAfter(deadline: .now() + settle) {
                if !plan.insertText.isEmpty {
                    if SyntheticKeyboard.canType(plan.insertText) {
                        SyntheticKeyboard.type(plan.insertText)
                    } else {
                        RichTextInserter.pastePlainText(plan.insertText)
                    }
                }
                AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.12) {
                    RichTextInserter.verifyEventually(attempts: 4, interval: 0.06, verify: reverted, completion: completion)
                }
            }
        }
        if tryAX {
            AccessibilityWork.queue.asyncAfter(deadline: .now() + (wrote ? 0.12 : 0.05), execute: finishRevert)
        } else {
            finishRevert()
        }
    }

    private static func markedTextRange(of element: AXUIElement) -> Range<Int>? {
        guard let value = attribute(element, "AXTextInputMarkedRange"),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range),
              range.location >= 0, range.length > 0 else { return nil }
        return range.location..<(range.location + range.length)
    }

    private static func selectedText(of element: AXUIElement, caret: Int, length: Int) -> String? {
        let direct = attribute(element, kAXSelectedTextAttribute as String) as? String
        if let direct, length == 0 || !direct.isEmpty {
            return direct
        }
        var rangeText: String?
        var valueSlice: String?
        if caret >= 0, length > 0 {
            var span = CFRange(location: caret, length: length)
            if let axSpan = AXValueCreate(.cfRange, &span) {
                var value: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(
                    element, kAXStringForRangeParameterizedAttribute as CFString, axSpan, &value) == .success,
                   let string = value as? String {
                    rangeText = string
                }
            }
            if rangeText?.isEmpty != false,
               let full = attribute(element, kAXValueAttribute as String) as? String {
                let units = Array(full.utf16)
                if caret + length <= units.count {
                    valueSlice = String(decoding: units[caret..<(caret + length)], as: UTF16.self)
                }
            }
        }
        return CompletionTransaction.resolvedSelectedText(
            direct: direct, rangeText: rangeText, valueSlice: valueSlice, expectedLength: length)
    }

    static func canPaste(in element: AXUIElement, before: CompletionSnapshot, caret: Int,
                         expectedPrefix: String, selected: Bool) -> Bool {
        guard let current = focusedContext(allowSelection: true), CFEqual(current.element, element),
              CompletionTransaction.canRetry(before: before,
                current: CompletionSnapshot(documentStart: current.windowStart, text: Array(current.text.utf16)),
                selectionLength: current.selectionLength, expectedPrefix: expectedPrefix,
                selectedPrefix: selected) else { return false }
        if selected {
            guard let actual = selectedText(of: element, caret: current.absoluteCaret, length: current.selectionLength) else {
                return false
            }
            return CompletionTransaction.equivalentHostText(Array(actual.utf16), Array(expectedPrefix.utf16))
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
