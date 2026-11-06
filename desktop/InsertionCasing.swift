//  The case an accepted suggestion is written in.
//
//  Source labels are stored as their files have them: "Office Supplies" in
//  title case, and a statement's section headings in capitals throughout
//  ("OPERATING EXPENSES"). Dropped into the middle of a sentence after a
//  lower-case word, neither reads right, so plainly capitalised words are
//  lowered, and a heading in capitals is written as words. Acronyms ("NASA",
//  "US GAAP", "EBITDA"), mixed-case words and anything containing digits keep
//  their form. The start of a sentence keeps its capital.

import Foundation

enum InsertionCasing {
    /// `typed` is the text the insertion replaces; `before` is everything before it.
    static func match(_ insertion: String, replacing typed: String, after before: String) -> String {
        // A value or a passage added after the words is the source's text as it is.
        guard !typed.isEmpty else { return insertion }
        // Capitals the writer typed themselves are kept.
        let typedLetters = typed.filter(\.isLetter)
        let heading = isHeadingInCapitals(insertion)
            && !(typedLetters.count > 1 && typedLetters.allSatisfy { !$0.isLowercase })
        let label = heading ? titleCased(insertion) : insertion
        guard !typed.isEmpty, typed == typed.lowercased() else { return label }
        let preceding = before.trimmingCharacters(in: .whitespacesAndNewlines)
        // Start of a sentence keeps its capital.
        guard let last = preceding.last, !".!?:".contains(last) else { return label }
        if heading {
            return insertion.split(separator: " ", omittingEmptySubsequences: false)
                .map { $0.contains(where: \.isNumber) ? String($0) : $0.lowercased() }
                .joined(separator: " ")
        }
        return label.split(separator: " ", omittingEmptySubsequences: false)
            .map(lowerIfPlainTitleCase)
            .joined(separator: " ")
    }

    /// Capitals throughout, in words too long to be an acronym: one of seven
    /// letters or more, or two words or more with one of five or more.
    static func isHeadingInCapitals(_ text: String) -> Bool {
        let letters = text.filter(\.isLetter)
        guard letters.count > 1, letters.allSatisfy({ !$0.isLowercase }) else { return false }
        let lengths = text.split(whereSeparator: { $0.isWhitespace })
            .map { $0.filter(\.isLetter).count }.filter { $0 > 0 }
        return lengths.contains { $0 >= 7 } || (lengths.count > 1 && lengths.contains { $0 >= 5 })
    }

    /// Each word with its first letter capital and the rest lower case.
    /// Words containing digits keep their form.
    private static func titleCased(_ text: String) -> String {
        text.split(separator: " ", omittingEmptySubsequences: false).map { word -> String in
            guard !word.contains(where: \.isNumber) else { return String(word) }
            var cased = "", started = false
            for character in word {
                cased += !started && character.isLetter ? character.uppercased() : character.lowercased()
                if character.isLetter { started = true }
            }
            return cased
        }.joined(separator: " ")
    }

    private static func lowerIfPlainTitleCase(_ word: Substring) -> String {
        guard let first = word.first, first.isUppercase else { return String(word) }
        let rest = word.dropFirst()
        guard word.count > 1,
              rest.allSatisfy({ $0.isLowercase || $0 == "'" || $0 == "-" }) else { return String(word) }
        return first.lowercased() + rest
    }
}
