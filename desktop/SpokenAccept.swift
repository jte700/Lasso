//  Accepting the suggestion card by saying "tab".
//
//  Dictation writes words without pressing keys, so saying "tab" writes the
//  word instead of pressing the key. When the words just dictated are the
//  text the card answers followed by "tab" (or "tab key", which macOS
//  Dictation writes as a tab character), the word is taken as the key: one
//  edit takes the spoken word back out and inserts what Tab would have
//  inserted on the card at that moment. Anything else said is text, so
//  "open a new tab" stays as written unless the card was showing for
//  "open a new" when "tab" was said.
//
//  Every stage is pure so it can be tested without a host application.

import Foundation

enum SpokenAccept {
    /// Longer than any way of writing the command alone (" Tab key.  ").
    static let maximumSpokenLength = 16

    /// How much of the card's text, from its end, must still be there before
    /// the command: enough to be sure the card answers those words. Words
    /// further back may be revised by dictation, and the card is lined up by
    /// its end, not by where the host says its text starts, which web
    /// editors report differently from one read to the next.
    static let matchedContext = 48
    /// Never fewer than this, unless the card's text is shorter.
    static let minimumContext = 12

    /// "tab" or "tab key" ending the text, in any case, as a word of its own,
    /// with the spacing and punctuation dictation puts around it; or the tab
    /// character Dictation writes for "tab key". Line breaks are text.
    private static let endingCommand = try! NSRegularExpression(
        pattern: #"[    .,;:!?]*(?<![\p{L}\p{N}_])tab(?:[  ]+key)?[    .,;:!?]*\z"#
            + #"|[  ]*\t[  ]*\z"#,
        options: [.caseInsensitive])

    /// How many UTF-16 units at the end of `text` are the spoken command.
    static func commandLength(_ text: [UInt16]) -> Int? {
        let string = String(decoding: text, as: UTF16.self)
        guard let match = endingCommand.firstMatch(in: string, range: NSRange(location: 0, length: text.count)),
              match.range.length > 0, match.range.length <= maximumSpokenLength else { return nil }
        return match.range.length
    }

    /// How many UTF-16 units at the end of `current` are the spoken command,
    /// when the words before it end as the card's text does. Both snapshots
    /// end at their caret.
    static func spokenLength(card: CompletionSnapshot, current: CompletionSnapshot) -> Int? {
        guard let longest = commandLength(current.text) else { return nil }
        let wanted = min(card.text.count, matchedContext)
        guard wanted > 0 else { return nil }
        // The command was found with all the spacing and marks before it,
        // some of which may be the card's own ("brac " then "tab").
        var length = longest
        while length > 0 {
            let before = current.text.dropLast(length)
            // A long document's window may have moved on past the card's start.
            let overlap = min(wanted, before.count)
            if overlap >= min(wanted, minimumContext),
               CompletionTransaction.equivalentHostText(Array(before.suffix(overlap)),
                                                        Array(card.text.suffix(overlap))) { return length }
            guard leadingUnits.contains(current.text[current.text.count - length]) else { return nil }
            length -= 1
        }
        return nil
    }

    /// What may come before the word in the command: spacing and the marks dictation adds.
    private static let leadingUnits = Set(" \u{00A0}\u{2007}\u{202F}.,;:!?".utf16)

    /// How the field's text changed since a card showed, for a log that must
    /// not say what either holds.
    static func change(from card: String, to current: String) -> String {
        if card == current { return "nothing" }
        func words(_ text: String) -> [String] {
            text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
        }
        let before = words(card), after = words(current)
        if before == after { return "only punctuation or capitals" }
        if after.count > before.count, Array(after.prefix(before.count)) == before {
            return "\(after.count - before.count) words added"
        }
        return "earlier words changed"
    }

    /// Words recognition writes for "tab" that are not the command, named so
    /// a log can say one was heard without saying what else was written.
    static func nearMiss(_ text: [UInt16]) -> String? {
        let string = String(decoding: text, as: UTF16.self)
        guard let match = nearMissWord.firstMatch(in: string, range: NSRange(location: 0, length: text.count)),
              let range = Range(match.range(at: 1), in: string) else { return nil }
        return string[range].lowercased()
    }

    private static let nearMissWord = try! NSRegularExpression(
        pattern: #"(?<![\p{L}\p{N}_])(tap|tabs|tad|tav|dab|tub|tag|tob|top)[  .,;:!?]*\z"#,
        options: [.caseInsensitive])

    /// Dictation punctuates when the speaker pauses ("Other revenue."), which
    /// is when they look at the card. Asked with the mark, the words would
    /// read as a finished sentence and get nothing, so the card is asked about
    /// the words before it. This is the mark's length with any spacing after
    /// it: one mark straight after a word, with nothing else following.
    static func pauseMarkLength(_ text: [UInt16]) -> Int {
        let string = String(decoding: text, as: UTF16.self)
        let range = NSRange(location: 0, length: text.count)
        guard let match = pauseMark.firstMatch(in: string, range: range) else { return 0 }
        return match.range(at: 1).length
    }

    private static let pauseMark = try! NSRegularExpression(
        pattern: #"[\p{L}\p{N}]([.,;:!?][  ]*)\z"#)

    /// The edit Tab would have made on the card's text, stretched over what
    /// was written after it, so that a single edit makes it. Over the spoken
    /// command, the word goes. Over a pause mark, the mark is `kept` after the
    /// insertion. `planned` is in the card's window; the result is in the
    /// current one, lined up by their ends, and like every plan ends at the caret.
    static func plan(_ planned: CompletionPlan, card: CompletionSnapshot,
                     current: CompletionSnapshot, spokenLength: Int, keeping kept: String = "") -> CompletionPlan? {
        guard planned.range.upperBound == card.text.count else { return nil }
        let end = current.text.count
        let start = end - spokenLength - planned.range.count
        guard spokenLength >= 0, start >= 0 else { return nil }
        let replaced = Array(current.text[start..<end])
        let expected = Array(planned.expectedPrefix.utf16)
        guard replaced.count == expected.count + spokenLength,
              CompletionTransaction.equivalentHostText(Array(replaced.prefix(expected.count)), expected) else { return nil }
        // What the host holds now, exactly, so the write checks against it.
        // The kept mark is not the source's text, so the link stops before it.
        let source = planned.sourceRange ?? (kept.isEmpty ? nil : 0..<planned.insertText.utf16.count)
        return CompletionPlan(range: start..<end, expectedPrefix: String(decoding: replaced, as: UTF16.self),
                              insertText: planned.insertText + kept, sourceRange: source)
    }
}
