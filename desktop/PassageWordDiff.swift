// Which words of a cited passage are new since its previous version, so the
// card's text preview can mark them, numbers and dates more strongly than
// other words. A passage longer than the comparison allows marks nothing.

import Foundation

enum PassageWordDiff {
    struct Change: Equatable {
        /// The word's place in the passage, in UTF-16 units.
        let range: NSRange
        /// A number or a date, which a reader checks first.
        let emphasized: Bool
    }

    /// Passages with more words than this on either side are not compared.
    static let maxWords = 600

    /// The words of `after` that are not kept from `before`, in order.
    static func changes(from before: String, to after: String) -> [Change] {
        let old = words(before)
        let new = words(after)
        guard !new.isEmpty, old.count <= maxWords, new.count <= maxWords else { return [] }
        let kept = keptIndices(old.map(\.text), new.map(\.text))
        return new.enumerated().compactMap { index, word in
            kept.contains(index) ? nil : Change(range: word.range, emphasized: isNumberOrDate(word.text))
        }
    }

    /// Where `passage` is written in `text` within `span`, with any spacing or
    /// line breaks between its words; nil when it is not there or is there more than once.
    static func onlyPlace(of passage: String, in text: String, within span: NSRange) -> NSRange? {
        let parts = passage.split(whereSeparator: \.isWhitespace).map { NSRegularExpression.escapedPattern(for: String($0)) }
        guard !parts.isEmpty, let pattern = try? NSRegularExpression(pattern: parts.joined(separator: "\\s+")) else { return nil }
        let found = pattern.matches(in: text, range: span)
        return found.count == 1 ? found[0].range : nil
    }

    /// The words of a passage new since `before`, where the passage is written
    /// once in `text` within `span`, as ranges of `text`; none when it is not.
    static func changes(from before: String, to after: String, writtenIn text: String, within span: NSRange) -> [Change] {
        guard let place = onlyPlace(of: after, in: text, within: span) else { return [] }
        let shown = (text as NSString).substring(with: place)
        return changes(from: before, to: shown).map {
            Change(range: NSRange(location: place.location + $0.range.location, length: $0.range.length), emphasized: $0.emphasized)
        }
    }

    private struct Word { let text: String; let range: NSRange }

    private static func words(_ text: String) -> [Word] {
        let string = text as NSString
        var found: [Word] = []
        let pattern = try? NSRegularExpression(pattern: "\\S+")
        pattern?.enumerateMatches(in: text, range: NSRange(location: 0, length: string.length)) { match, _, _ in
            guard let range = match?.range else { return }
            let trimmed = trimmingPunctuation(string.substring(with: range), range: range, in: string)
            if trimmed.range.length > 0 { found.append(trimmed) }
        }
        return found
    }

    /// A word without the punctuation around it, so "19,250." matches "19,250".
    private static func trimmingPunctuation(_ word: String, range: NSRange, in string: NSString) -> Word {
        var start = range.location
        var end = range.location + range.length
        let punctuation = CharacterSet.punctuationCharacters.subtracting(CharacterSet(charactersIn: "%$€£"))
        while start < end, let scalar = UnicodeScalar(string.character(at: start)), punctuation.contains(scalar) { start += 1 }
        while end > start, let scalar = UnicodeScalar(string.character(at: end - 1)), punctuation.contains(scalar) { end -= 1 }
        let kept = NSRange(location: start, length: end - start)
        return Word(text: string.substring(with: kept), range: kept)
    }

    /// The indices of `new` kept in a longest common sequence of words with `old`.
    private static func keptIndices(_ old: [String], _ new: [String]) -> Set<Int> {
        let n = old.count, m = new.count
        var table = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                table[i][j] = old[i] == new[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var kept = Set<Int>()
        var i = 0, j = 0
        while i < n && j < m {
            if old[i] == new[j] { kept.insert(j); i += 1; j += 1 }
            else if table[i + 1][j] >= table[i][j + 1] { i += 1 }
            else { j += 1 }
        }
        return kept
    }

    private static func isNumberOrDate(_ word: String) -> Bool {
        word.rangeOfCharacter(from: .decimalDigits) != nil
    }
}
