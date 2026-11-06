//  Some of a line's words, chosen on the suggestion card before Tab.
//
//  ⇧fn→ or ⇧fn← on a highlighted line (a sentence, a passage or a line of
//  code) opens it with every word selected, as a text field is after ⌘A.
//  ⇧fn→ leaves the end of the selection to move and ⇧fn← its start, so the
//  first ⇧← or ⇧→ takes a word off that side. From there the keys are a text
//  field's, a word at a time: ← and → move the caret, ⇧← and ⇧→ select, and
//  ⇧⌘← and ⇧⌘→ select to the start or end. Words from the middle are chosen
//  the way a text field's are: move to the first, then select to the last.
//  Tab inserts the words selected.

import Foundation

struct AssistWordChoice: Equatable {
    enum Direction: Equatable { case backward, forward }

    /// The line's words open only from a line long enough to want some of.
    static let minimumWords = 4

    let text: String
    /// Each word's UTF-16 range in `text`: a run of characters between spaces,
    /// with the punctuation written against it.
    let words: [Range<Int>]
    /// Word boundaries: 0 is before the first word, `words.count` after the last.
    private(set) var anchor: Int
    private(set) var caret: Int

    /// Whether `text` is a line whose words can be chosen: one line, and long enough.
    static func offers(_ text: String) -> Bool {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !line.contains(where: \.isNewline) && words(in: line).count >= minimumWords
    }

    /// Every word selected. `movingStart` leaves the start of the selection to
    /// move, as ⇧fn← does; otherwise its end moves.
    init?(text: String, movingStart: Bool = false) {
        guard Self.offers(text) else { return nil }
        self.text = text
        words = Self.words(in: text)
        anchor = movingStart ? words.count : 0
        caret = movingStart ? 0 : words.count
    }

    static func words(in text: String) -> [Range<Int>] {
        var found: [Range<Int>] = []
        var start: Int?
        for (offset, unit) in text.utf16.enumerated() {
            // A surrogate half is part of a character, never a space.
            let space = Unicode.Scalar(unit).map { CharacterSet.whitespacesAndNewlines.contains($0) } ?? false
            if space, let first = start {
                found.append(first..<offset)
                start = nil
            } else if !space, start == nil {
                start = offset
            }
        }
        if let first = start { found.append(first..<text.utf16.count) }
        return found
    }

    /// The selected words, by index.
    var selection: Range<Int> { min(anchor, caret)..<max(anchor, caret) }
    var isWhole: Bool { selection == 0..<words.count }

    /// An arrow: a word at a time, or with ⌘ to the start or end. Without ⇧ a
    /// selection first collapses to the side the arrow points to.
    mutating func move(_ direction: Direction, selecting: Bool, toEnd: Bool = false) {
        let forward = direction == .forward
        if toEnd {
            caret = forward ? words.count : 0
        } else if !selecting, !selection.isEmpty {
            caret = forward ? selection.upperBound : selection.lowerBound
        } else {
            caret = forward ? min(words.count, caret + 1) : max(0, caret - 1)
        }
        if !selecting { anchor = caret }
    }

    /// A click or drag from one word to another selects both and every word between.
    mutating func select(from first: Int, to last: Int) {
        let first = min(max(0, first), words.count - 1), last = min(max(0, last), words.count - 1)
        anchor = first <= last ? first : first + 1
        caret = first <= last ? last + 1 : last
    }

    /// Where the selected words are in `text`, or nil when none are. A cut
    /// that stops before the line's end leaves off the comma, semicolon or
    /// colon that led on to the words after it.
    var chosenRange: Range<Int>? {
        guard !selection.isEmpty else { return nil }
        let units = Array(text.utf16)
        let last = words[selection.upperBound - 1]
        var end = last.upperBound
        if selection.upperBound < words.count {
            while end - 1 > last.lowerBound, ",;:".utf16.contains(units[end - 1]) { end -= 1 }
        }
        return words[selection.lowerBound].lowerBound..<end
    }

    /// What Tab inserts. Every word inserts the line exactly as it was
    /// offered, with the space a sentence's continuation starts with.
    var chosenText: String? {
        guard let range = chosenRange else { return nil }
        if isWhole { return text }
        let units = Array(text.utf16)
        // From the first word on, whatever the line starts with stays.
        let start = selection.lowerBound == 0 ? 0 : range.lowerBound
        return String(decoding: units[start..<range.upperBound], as: UTF16.self)
    }

    /// The chosen words start after the line's first, so they are set apart
    /// from the typed text like any other insertion.
    var startsMidLine: Bool { selection.lowerBound > 0 }

    /// The UTF-16 offset in `text` the caret is drawn at.
    var caretOffset: Int {
        caret < words.count ? words[caret].lowerBound : (words.last?.upperBound ?? 0)
    }
}
