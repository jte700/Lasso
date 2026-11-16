//  Changing a linked phrase's source: the phrase's words in the host are
//  written over with the chosen source's, then the editor is read back to
//  prove that only they changed. Like an insertion, it goes through
//  Accessibility first and the keyboard only where the host ignores that,
//  and nothing is recorded unless the host shows exactly that one edit.

import Cocoa
import ApplicationServices

enum ReferenceSwap {
    struct Written {
        /// The editor's text afterwards, and where the new words sit in it.
        let document: [UInt16]
        let range: Range<Int>
        let text: String
    }

    /// The chosen source's words, cased as the words now there were. A phrase
    /// the card lowered because it was typed in lower case mid-sentence passes
    /// that on; one inserted as its source spells it stays that way.
    static func words(for alternative: ReferenceAlternative, current: ReferenceAlternative?,
                      shown: String, before: String) -> String {
        guard !alternative.verbatim else { return alternative.text }
        let lowered = current.map { $0.text != shown && $0.text.lowercased() == shown.lowercased() } ?? false
        return InsertionCasing.match(alternative.text, replacing: lowered ? "a" : "", after: before)
    }

    /// The editor's text once only `range` holds `text`.
    static func expected(_ document: [UInt16], replacing range: Range<Int>, with text: String) -> [UInt16] {
        Array(document[..<range.lowerBound]) + Array(text.utf16) + Array(document[range.upperBound...])
    }

    /// Accessibility queue only, where `completion` is called too. Nil when the
    /// phrase cannot be found once and for certain, the editor has no plain
    /// value to check against, or the host shows anything but the one change.
    static func write(_ anchor: TextAnchor, in element: AXUIElement,
                      words: @escaping (_ shown: String, _ before: String) -> String,
                      completion: @escaping (Written?) -> Void) {
        guard let original = value(of: element) else { completion(nil); return }
        let document = Array(original.utf16)
        guard case .resolved(let range) = TextAnchorResolver.resolve(anchor, in: document) else {
            completion(nil); return
        }
        let shown = String(decoding: document[range], as: UTF16.self)
        let text = words(shown, String(decoding: document[..<range.lowerBound], as: UTF16.self))
        guard !text.isEmpty else { completion(nil); return }
        let target = expected(document, replacing: range, with: text)
        let written = Written(document: target, range: range.lowerBound..<(range.lowerBound + text.utf16.count), text: text)
        guard text != shown else { completion(written); return }

        let selection = AccessibilitySelectableText(element: element)
        guard HostSelection.selectForWrite(range, caret: range.upperBound, in: selection) else { completion(nil); return }
        let wrote = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success
        AccessibilityWork.queue.asyncAfter(deadline: .now() + (wrote ? 0.12 : 0.04)) {
            let after = value(of: element).map { Array($0.utf16) }
            if after == target { completion(written); return }
            // The host ignored the write: type over the selection, if it is
            // still exactly the phrase and nothing else has changed.
            guard after == document, selection.selection == range else { completion(nil); return }
            if SyntheticKeyboard.canType(text) {
                SyntheticKeyboard.type(text)
            } else {
                RichTextInserter.pastePlainText(text)
            }
            AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.2) {
                completion(value(of: element).map { Array($0.utf16) } == target ? written : nil)
            }
        }
    }

    private static func value(of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success else { return nil }
        return value as? String
    }
}
