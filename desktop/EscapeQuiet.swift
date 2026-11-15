import Foundation

/// Escape closes the card for the sentence being written, not only for the
/// key that follows. It comes back when the writer starts a new sentence or
/// line, goes back into an earlier one, deletes the sentence, or writes
/// somewhere else.
struct EscapeQuiet {
    /// The text before the caret up to where the escaped sentence starts.
    private var before: String?
    /// The escaped sentence's first word, which the sentence keeps while it is
    /// the one being written. A field emptied (a chat app sends its message)
    /// or a sentence written over it has lost it.
    private var firstWord = ""

    var isHolding: Bool { before != nil }

    /// Escape was pressed with `text` before the caret.
    mutating func escaped(at text: String) {
        let start = Self.sentenceStart(in: text)
        before = String(text[..<start])
        firstWord = String(text[start...].drop(while: \.isWhitespace).prefix(while: { !$0.isWhitespace }))
    }

    mutating func clear() { before = nil }

    /// Whether the card stays closed for `text`, which ends the quiet once it
    /// is no longer the escaped sentence.
    mutating func holds(for text: String) -> Bool {
        guard let before else { return false }
        // Text that no longer begins the same way was deleted back past the sentence, or is another field's.
        let written = text.hasPrefix(before) ? String(text.dropFirst(before.count)) : nil
        guard let written, !Self.startsNewSentence(written), keepsFirstWord(written) else {
            self.before = nil
            return false
        }
        return true
    }

    /// The sentence still starts with the escaped one's first word, or with
    /// part of it while that word is being corrected.
    private func keepsFirstWord(_ written: String) -> Bool {
        guard !firstWord.isEmpty else { return true }
        let opening = String(written.drop(while: \.isWhitespace))
        guard !opening.isEmpty else { return false }
        return opening.hasPrefix(firstWord) || firstWord.hasPrefix(opening)
    }

    /// Where the sentence at the end of `text` begins: after the last line
    /// break, or the last full stop, question or exclamation mark that a space follows.
    static func sentenceStart(in text: String) -> String.Index {
        var start = text.startIndex
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            let next = text.index(after: index)
            if character.isNewline {
                start = next
            } else if ".!?".contains(character), next < text.endIndex, text[next].isWhitespace {
                start = next
            }
            index = next
        }
        return start
    }

    private static func startsNewSentence(_ written: String) -> Bool {
        sentenceStart(in: written) != written.startIndex
    }
}
