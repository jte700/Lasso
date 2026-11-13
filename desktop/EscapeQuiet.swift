import Foundation

/// Escape closes the card for the sentence being written, not only for the
/// key that follows. It comes back when the writer starts a new sentence or
/// line, goes back into an earlier one, or writes somewhere else.
struct EscapeQuiet {
    /// The text before the caret up to where the escaped sentence starts.
    private var before: String?

    var isHolding: Bool { before != nil }

    /// Escape was pressed with `text` before the caret.
    mutating func escaped(at text: String) {
        before = String(text[..<Self.sentenceStart(in: text)])
    }

    mutating func clear() { before = nil }

    /// Whether the card stays closed for `text`, which ends the quiet once it
    /// is no longer the escaped sentence.
    mutating func holds(for text: String) -> Bool {
        guard let before else { return false }
        // Text that no longer begins the same way was deleted back past the sentence, or is another field's.
        guard text.hasPrefix(before), !Self.startsNewSentence(String(text.dropFirst(before.count))) else {
            self.before = nil
            return false
        }
        return true
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
