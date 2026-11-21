import Foundation

/// Escape closes the card for the word being typed, not for the whole app or
/// the rest of the sentence. Suggestions come back as soon as the writer
/// moves on to a new word, starts a new line, deletes the dismissed word,
/// empties the field, clicks elsewhere, or writes in another field.
/// A dismissed backslash writer prompt holds through its sentence.
struct EscapeQuiet {
    /// The text before the caret up to where the dismissed word (or sentence) starts.
    private var before: String?
    /// The dismissed word, or the first word of a dismissed writer-prompt sentence.
    private var word = ""
    /// True only when Escape dismissed a backslash writer prompt across its sentence.
    private var throughSentence = false

    var isHolding: Bool { before != nil }

    /// Escape was pressed with `text` before the caret.
    mutating func escaped(at text: String, throughSentence: Bool = false) {
        self.throughSentence = throughSentence
        if throughSentence {
            let start = Self.sentenceStart(in: text)
            before = String(text[..<start])
            word = String(text[start...].drop(while: \.isWhitespace).prefix(while: { !$0.isWhitespace }))
        } else {
            let start = Self.wordStart(in: text)
            before = String(text[..<start])
            word = String(text[start...])
        }
    }

    mutating func clear() {
        before = nil
        word = ""
        throughSentence = false
    }

    /// Whether the card stays closed for `text`, ending the hold once typing
    /// moves past the dismissed word (or sentence, for a writer prompt).
    mutating func holds(for text: String) -> Bool {
        guard let before else { return false }
        guard text.hasPrefix(before) else {
            clear()
            return false
        }
        let written = String(text.dropFirst(before.count))
        if throughSentence {
            guard !Self.startsNewSentence(written), keepsFirstWord(written) else {
                clear()
                return false
            }
            return true
        }
        if written.contains(where: \.isNewline) {
            clear()
            return false
        }
        if word.isEmpty {
            // Escaped right after whitespace: hold only while no new word begins.
            guard written.allSatisfy(\.isWhitespace) else {
                clear()
                return false
            }
            return true
        }
        guard !written.isEmpty else {
            clear()
            return false
        }
        let current = String(written.prefix(while: { !$0.isWhitespace }))
        let afterWord = written.dropFirst(current.count)
        // Starting another word after a space ends the hold immediately.
        guard afterWord.allSatisfy(\.isWhitespace),
              !current.isEmpty,
              current.hasPrefix(word) || word.hasPrefix(current) else {
            clear()
            return false
        }
        return true
    }

    /// The sentence still starts with the escaped one's first word, or with
    /// part of it while that word is being corrected.
    private func keepsFirstWord(_ written: String) -> Bool {
        guard !word.isEmpty else { return false }
        let opening = String(written.drop(while: \.isWhitespace))
        guard !opening.isEmpty else { return false }
        return opening.hasPrefix(word) || word.hasPrefix(opening)
    }

    /// Where the word at the end of `text` begins: right after the last whitespace.
    static func wordStart(in text: String) -> String.Index {
        var index = text.endIndex
        while index > text.startIndex {
            let previous = text.index(before: index)
            if text[previous].isWhitespace { break }
            index = previous
        }
        return index
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
