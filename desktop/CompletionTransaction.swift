//  Accepting a completion, as a checked text edit.
//
//  A completion may only rewrite the characters the user already typed towards
//  it. The replaceable length is therefore derived from the insertion itself —
//  the longest run immediately before the caret that already spells its
//  beginning — and can never exceed the insertion's own length. A completion
//  can never delete more text than it adds, whatever range a suggestion claims.
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

    /// How many characters immediately before the caret already spell the start
    /// of `insertText`, compared case-insensitively.
    ///
    /// "…office sup" + "office supplies" → 10   (rewrites "office sup")
    /// "The value is 61" + "612"          → 2    (rewrites "61")
    /// "the cost is " + "400"             → 0    (pure insertion)
    static func replaceableLength(typedBeforeCaret typed: [UInt16], insertText: [UInt16]) -> Int {
        // Never more than the insertion itself, and never more than was typed.
        let limit = min(typed.count, insertText.count)
        guard limit > 0 else { return 0 }
        for length in stride(from: limit, through: 1, by: -1) {
            var matches = true
            for offset in 0..<length {
                let typedUnit = typed[typed.count - length + offset]
                let insertUnit = insertText[offset]
                if !equalIgnoringCase(typedUnit, insertUnit) { matches = false; break }
            }
            if matches { return length }
        }
        return 0
    }

    private static func equalIgnoringCase(_ left: UInt16, _ right: UInt16) -> Bool {
        if left == right { return true }
        let lower: (UInt16) -> UInt16 = { unit in
            (unit >= 65 && unit <= 90) ? unit + 32 : unit
        }
        return lower(left) == lower(right)
    }

    /// Builds the smallest edit that turns the typed prefix into the insertion.
    static func plan(document: [UInt16], caret: Int, insertText: String) -> Result<CompletionPlan, CompletionFailure> {
        guard caret >= 0, caret <= document.count else { return .failure(.rangeOutOfBounds) }
        let insertUnits = Array(insertText.utf16)
        let typed = Array(document[0..<caret])
        let length = replaceableLength(typedBeforeCaret: typed, insertText: insertUnits)
        let range = (caret - length)..<caret
        let expected = String(decoding: document[range], as: UTF16.self)
        return .success(CompletionPlan(range: range, expectedPrefix: expected, insertText: insertText))
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
        guard Array(after.text[finalSnapshotRange]) == insertUnits else {
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
