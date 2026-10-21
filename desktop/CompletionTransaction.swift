//  Accepting a completion, as a checked text edit.
//
//  A detected keyword carries the exact fragment from the prediction request.
//  Replacing it requires matching that text and its caret position again.
//  Other suggestions infer only a bounded overlap with the insertion's start.
//
//  Every stage is pure so it can be tested without a host application.

import Foundation

enum CompletionFailure: String, Equatable, Error {
    case hostChanged            // focus moved to another element or document
    case prefixMismatch         // the text to replace is not what was expected
    case rangeOutOfBounds
    case outsideRangeModified   // the host changed text it was not asked to
    case insertionMissing       // the phrase is not at the expected place afterwards
}

struct CompletionPlan: Equatable {
    /// Absolute UTF-16 range in the host document that will be rewritten.
    let range: Range<Int>
    /// Exactly what that range must contain before the edit.
    let expectedPrefix: String
    /// What replaces it.
    let insertText: String
    /// Source content within insertText, excluding spacing kept around the edit.
    var sourceRange: Range<Int>? = nil

}

struct CompletionReplacement: Equatable {
    let start: Int
    let expectedText: String
    var preservedSuffix: String = ""

    /// Capture a matched fragment or an explicit insertion at the request caret.
    static func capture(start: Int?, end: Int?, in text: String,
                        expectedText: String? = nil) -> CompletionReplacement? {
        let document = Array(text.utf16)
        guard let start, let end, start >= 0, start <= end, end <= document.count,
              isScalarBoundary(start, in: document), isScalarBoundary(end, in: document) else { return nil }
        let fragment = String(decoding: document[start..<end], as: UTF16.self)
        let suffix = String(decoding: document[end...], as: UTF16.self)
        guard (start == end || !fragment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty),
              expectedText == nil || expectedText == fragment,
              suffix.unicodeScalars.allSatisfy({ CharacterSet.whitespaces.contains($0) }) else { return nil }
        return CompletionReplacement(start: start, expectedText: fragment + suffix, preservedSuffix: suffix)
    }

    static func terminalNumber(in text: String) -> CompletionReplacement? {
        let trimmed = String(text.reversed().drop(while: { $0.isWhitespace && $0 != "\n" && $0 != "\r" }).reversed())
        let expression = try! NSRegularExpression(pattern: #"(?:[$€£¥]\s*)?[+−-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d*)?%?$"#)
        guard let match = expression.firstMatch(in: trimmed, range: NSRange(location: 0, length: trimmed.utf16.count))
        else { return nil }
        return capture(start: match.range.location, end: NSMaxRange(match.range), in: text)
    }

    fileprivate static func isScalarBoundary(_ offset: Int, in document: [UInt16]) -> Bool {
        guard offset >= 0, offset <= document.count else { return false }
        return offset == 0 || offset == document.count
            || !(0xD800...0xDBFF).contains(document[offset - 1])
            || !(0xDC00...0xDFFF).contains(document[offset])
    }
}

/// A bounded view of a host document. Browser editors such as Gmail expose the
/// text before the caret as a moving window rather than as one stable AXValue,
/// so the window's absolute UTF-16 start is part of the evidence.
struct CompletionSnapshot: Equatable {
    let documentStart: Int
    let text: [UInt16]

    var documentEnd: Int { documentStart + text.count }
}

struct VerifiedCompletion: Equatable {
    /// The accepted phrase in the post-edit snapshot.
    let snapshotRange: Range<Int>
    /// The same phrase in the host document's absolute UTF-16 index space.
    let documentRange: Range<Int>
}

enum CompletionTransaction {
    /// Delayed keyboard fallback may only use the original collapsed caret or
    /// the exact prefix selection established by the accessibility write.
    static func canRetry(before: CompletionSnapshot, current: CompletionSnapshot,
                         selectionLength: Int, expectedPrefix: String, selectedPrefix: Bool) -> Bool {
        let length = expectedPrefix.utf16.count
        if !selectedPrefix {
            return selectionLength == 0 && before.documentStart == current.documentStart
                && equivalentHostText(before.text, current.text)
        }
        guard length > 0, selectionLength == length,
              current.documentEnd == before.documentEnd - length,
              length <= before.text.count else { return false }
        let overlapStart = max(before.documentStart, current.documentStart)
        guard overlapStart <= current.documentEnd else { return false }
        let old = Array(before.text[(overlapStart - before.documentStart)..<(before.text.count - length)])
        let new = Array(current.text[(overlapStart - current.documentStart)...])
        return equivalentHostText(old, new)
    }

    /// What asking the host to select the text a completion rewrites achieved.
    enum SelectionCheck: Equatable {
        /// The host reports exactly that range, with no prediction pending.
        case selected
        /// The caret has not moved: the change only dismissed a prediction.
        case retry
        /// The caret is somewhere else, for example past a prediction the
        /// host accepted. Writing now would land in the wrong place.
        case stop
    }

    /// macOS offers its own completion of a partly typed word in grey
    /// ("outsta" + "nding"), held as marked text that runs past the caret.
    /// While it shows, AppKit editors such as Notes answer a selection change
    /// by dropping the prediction and leaving the caret where it was, yet
    /// report success. Writing then would keep the typed word
    /// ("outstaoutstanding CAD"), and a write at the caret merges with the
    /// prediction ("outsta CADnding"). Only the requested range, with the
    /// prediction gone, is safe to write over.
    static func checkSelection(requested: Range<Int>, reported: Range<Int>?, caret: Int,
                               markedText: Bool) -> SelectionCheck {
        guard let reported else { return .stop }
        if reported == requested { return markedText ? .retry : .selected }
        return reported == caret..<caret ? .retry : .stop
    }

    /// Content-editable hosts commonly expose a trailing space as NBSP while
    /// it is at the caret, then turn it back into an ordinary space as soon as
    /// more text follows. Those code units are the same visible edit evidence;
    /// no other characters are treated as interchangeable.
    private static func canonicalHostUnit(_ unit: UInt16) -> UInt16 {
        switch unit {
        case 0x00A0, 0x2007, 0x202F: return 0x0020
        default: return unit
        }
    }

    static func equivalentHostText(_ left: [UInt16], _ right: [UInt16]) -> Bool {
        guard left.count == right.count else { return false }
        return zip(left, right).allSatisfy {
            canonicalHostUnit($0.0) == canonicalHostUnit($0.1)
        }
    }

    /// A host write landed only when the insertion is immediately before the
    /// current caret. Merely finding the same short value elsewhere in the
    /// surrounding window is not evidence ("40" must not match an older "400").
    static func insertionIsAtCaret(_ insertion: String, in textBeforeCaret: String) -> Bool {
        let needle = Array(insertion.utf16)
        let haystack = Array(textBeforeCaret.utf16)
        guard !needle.isEmpty, haystack.count >= needle.count else { return false }
        return equivalentHostText(Array(haystack.suffix(needle.count)), needle)
    }

    /// How many characters immediately before the caret the completion may
    /// rewrite, compared case-insensitively.
    ///
    /// "…office sup" + "office supplies"       → 10  (rewrites "office sup")
    /// "The value is 61" + "612"                → 2   (rewrites "61")
    /// "…through the suppl" + "office supplies" → 5   (rewrites "suppl")
    /// "the cost is " + "400"                   → 0   (pure insertion)
    ///
    /// Two things may be rewritten, and nothing else. The run before the caret
    /// that already spells the start of the insertion, which is the ordinary
    /// case of finishing a phrase. Or, failing that, the single word being
    /// typed, when that word begins a word of the insertion — someone typing
    /// "suppl" towards "Office supplies" means to replace it, not to be left
    /// with "supploffice supplies".
    ///
    /// Both are bounded by what was typed and by the insertion's own length,
    /// and the second can never reach past the current word. That is the
    /// point: a completion may only rewrite text the user typed towards it,
    /// which is what stops a suggestion deleting a sentence it has no
    /// relation to.
    static func replaceableLength(typedBeforeCaret typed: [UInt16], insertText: [UInt16]) -> Int {
        // Never more than the insertion itself, and never more than was typed.
        let limit = min(typed.count, insertText.count)
        if limit > 0 {
            for length in stride(from: limit, through: 1, by: -1) {
                var matches = true
                for offset in 0..<length {
                    let typedUnit = typed[typed.count - length + offset]
                    let insertUnit = insertText[offset]
                    if !equalIgnoringCase(typedUnit, insertUnit) { matches = false; break }
                }
                if matches { return length }
            }
        }
        let word = trailingWordLength(typed)
        if word > 0, word <= insertText.count,
           beginsAWordOf(insertText, Array(typed.suffix(word))) {
            return word
        }
        return 0
    }

    private static func isWordBreak(_ unit: UInt16) -> Bool {
        canonicalHostUnit(unit) == 32 || unit == 10 || unit == 13 || unit == 9
            || unit == 0x2028 || unit == 0x2029
    }

    /// The run of characters being typed right now: back to the nearest space
    /// or line break, and no further.
    private static func trailingWordLength(_ typed: [UInt16]) -> Int {
        var start = typed.count
        while start > 0, !isWordBreak(typed[start - 1]) { start -= 1 }
        return typed.count - start
    }

    /// Whether the typed word starts one of the insertion's words.
    private static func beginsAWordOf(_ insertText: [UInt16], _ typedWord: [UInt16]) -> Bool {
        guard !typedWord.isEmpty else { return false }
        var start = 0
        for index in 0...insertText.count {
            if index < insertText.count, !isWordBreak(insertText[index]) { continue }
            if index - start >= typedWord.count {
                var matches = true
                for offset in 0..<typedWord.count {
                    if !equalIgnoringCase(insertText[start + offset], typedWord[offset]) {
                        matches = false
                        break
                    }
                }
                if matches { return true }
            }
            start = index + 1
        }
        return false
    }

    private static func equalIgnoringCase(_ left: UInt16, _ right: UInt16) -> Bool {
        if left == right { return true }
        let lower: (UInt16) -> UInt16 = { unit in
            (unit >= 65 && unit <= 90) ? unit + 32 : unit
        }
        return lower(left) == lower(right)
    }

    /// Prefer the verified keyword; otherwise infer the insertion's prefix overlap.
    static func plan(document: [UInt16], caret: Int, insertText: String,
                     replacement: CompletionReplacement? = nil,
                     separateInsertion: Bool = false) -> Result<CompletionPlan, CompletionFailure> {
        guard caret >= 0, caret <= document.count else { return .failure(.rangeOutOfBounds) }
        if let replacement {
            let expected = Array(replacement.expectedText.utf16)
            guard replacement.start >= 0, replacement.start <= caret,
                  CompletionReplacement.isScalarBoundary(replacement.start, in: document),
                  CompletionReplacement.isScalarBoundary(caret, in: document) else {
                return .failure(.rangeOutOfBounds)
            }
            guard expected.count == caret - replacement.start,
                  Array(document[replacement.start..<caret]) == expected else { return .failure(.prefixMismatch) }
            let joiner = expected.isEmpty && separateInsertion
                ? insertionSeparator(before: String(decoding: document[..<caret], as: UTF16.self), text: insertText) : ""
            return .success(CompletionPlan(range: replacement.start..<caret,
                expectedPrefix: replacement.expectedText, insertText: joiner + insertText + replacement.preservedSuffix,
                sourceRange: joiner.utf16.count..<(joiner.utf16.count + insertText.utf16.count)))
        }
        let insertUnits = Array(insertText.utf16)
        let typed = Array(document[0..<caret])
        let length = replaceableLength(typedBeforeCaret: typed, insertText: insertUnits)
        let range = (caret - length)..<caret
        let expected = String(decoding: document[range], as: UTF16.self)
        return .success(CompletionPlan(range: range, expectedPrefix: expected, insertText: insertText))
    }

    private static func insertionSeparator(before: String, text: String) -> String {
        guard let last = before.last, let first = text.first,
              !last.isWhitespace, !first.isWhitespace,
              !"([{“\"".contains(last), !",.;:!?)]}".contains(first) else { return "" }
        return " "
    }

    /// Confirms the plan is still valid immediately before the edit is applied.
    ///
    /// Both facts matter: the range must still hold what was expected, and the
    /// caret must still sit at its end. Text alone is not enough — after typing
    /// "per dish" the range still reads "office sup" while the caret has moved
    /// on, and applying the plan there would corrupt the sentence.
    static func validate(_ plan: CompletionPlan, against document: [UInt16],
                         caret: Int? = nil) -> CompletionFailure? {
        guard plan.range.lowerBound >= 0, plan.range.upperBound <= document.count else {
            return .rangeOutOfBounds
        }
        if let caret, caret != plan.range.upperBound { return .prefixMismatch }
        let actual = String(decoding: document[plan.range], as: UTF16.self)
        return actual == plan.expectedPrefix ? nil : .prefixMismatch
    }

    /// The document the plan should produce. Used by tests and by verification.
    static func apply(_ plan: CompletionPlan, to document: [UInt16]) -> [UInt16] {
        var result = Array(document[0..<plan.range.lowerBound])
        result.append(contentsOf: Array(plan.insertText.utf16))
        result.append(contentsOf: Array(document[plan.range.upperBound...]))
        return result
    }

    /// Checks the host actually made the intended edit and nothing else, then
    /// returns the exact range the inserted phrase now occupies.
    static func verify(before: [UInt16], after: [UInt16],
                       plan: CompletionPlan) -> Result<Range<Int>, CompletionFailure> {
        let insertUnits = Array(plan.insertText.utf16)
        let start = plan.range.lowerBound
        let finalRange = start..<(start + insertUnits.count)

        // Everything before the edit must be untouched. Checked first, so a host
        // that mangled the surrounding text is reported as such rather than as a
        // missing insertion.
        guard start <= after.count, Array(before[0..<start]) == Array(after[0..<start]) else {
            return .failure(.outsideRangeModified)
        }
        guard finalRange.upperBound <= after.count else { return .failure(.insertionMissing) }
        // Everything after it must be untouched.
        let beforeSuffix = Array(before[plan.range.upperBound...])
        let afterSuffix = Array(after[finalRange.upperBound...])
        guard beforeSuffix == afterSuffix else { return .failure(.outsideRangeModified) }
        // And the phrase must be where it was meant to land.
        guard Array(after[finalRange]) == insertUnits else { return .failure(.insertionMissing) }

        return .success(finalRange)
    }

    /// Verifies an edit when the host returns moving windows around the caret.
    ///
    /// In a long Gmail draft, inserting ten characters can move the beginning
    /// of the 1,200-character accessibility window ten characters forward.
    /// Comparing the arrays directly would call that an unrelated edit. Absolute
    /// offsets let us compare their overlapping evidence instead, while still
    /// refusing a moved caret, a missing insertion, or altered surrounding text.
    static func verify(before: CompletionSnapshot, after: CompletionSnapshot,
                       plan: CompletionPlan) -> Result<VerifiedCompletion, CompletionFailure> {
        if let failure = validate(plan, against: before.text, caret: before.text.count) {
            return .failure(failure)
        }
        guard before.documentStart >= 0, after.documentStart >= 0 else {
            return .failure(.rangeOutOfBounds)
        }

        let insertUnits = Array(plan.insertText.utf16)
        let delta = insertUnits.count - plan.range.count
        let editStart = before.documentStart + plan.range.lowerBound
        let finalDocumentRange = editStart..<(editStart + insertUnits.count)

        // Both snapshots end at the caret. Its absolute position must move by
        // exactly the edit delta and nothing else.
        guard after.documentEnd == before.documentEnd + delta else {
            return .failure(.outsideRangeModified)
        }

        let localStart = finalDocumentRange.lowerBound - after.documentStart
        let localEnd = finalDocumentRange.upperBound - after.documentStart
        guard localStart >= 0, localEnd <= after.text.count else {
            return .failure(.rangeOutOfBounds)
        }
        let finalSnapshotRange = localStart..<localEnd
        guard equivalentHostText(Array(after.text[finalSnapshotRange]), insertUnits) else {
            return .failure(.insertionMissing)
        }

        // Compare every pre-edit character visible in both moving windows. The
        // completion plan always ends at the caret, so this is the untouched
        // prefix. Keeping the overlap calculation explicit means normal window
        // trimming cannot be mistaken for an unrelated document edit.
        let overlapStart = max(before.documentStart, after.documentStart)
        let overlapEnd = min(editStart, min(before.documentEnd, after.documentEnd))
        if overlapStart < overlapEnd {
            let oldRange = (overlapStart - before.documentStart)..<(overlapEnd - before.documentStart)
            let newRange = (overlapStart - after.documentStart)..<(overlapEnd - after.documentStart)
            guard equivalentHostText(Array(before.text[oldRange]), Array(after.text[newRange])) else {
                return .failure(.outsideRangeModified)
            }
        }

        return .success(VerifiedCompletion(snapshotRange: finalSnapshotRange,
                                           documentRange: finalDocumentRange))
    }
}
