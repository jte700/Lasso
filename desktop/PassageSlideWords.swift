// Words on a slide's picture, as the passage picker highlights them: where
// each one is on the picture, and which words of the deck's own text it is,
// so a highlight made on the slide inserts and cites exactly what the deck says.
// Plain Foundation, so the unit checks run it without windows.

import Foundation
import CoreGraphics

/// One word read off a slide's picture.
struct PassageSlideWord: Equatable {
    let text: String
    /// Where it is on the picture, from the top left, each value a share (0...1) of the width or height.
    let box: CGRect
    /// The line of the slide it is on, counted from the top.
    let line: Int
    /// The same word in the deck's text, when it was found there.
    var source: NSRange? = nil
}

enum PassageSlideWords {
    /// How many of the deck's words a misread or extra word may skip before matching gives up on it.
    private static let lookahead = 8

    /// `words` matched in order to the words of slide `slide` in `document`.
    /// A word between two matched words, with as many deck words between those, takes its place among them.
    static func aligned(_ words: [PassageSlideWord], to document: PassageDocument, slide: Int) -> [PassageSlideWord] {
        let deckWords = Self.deckWords(of: document, slide: slide)
        var result = words.map { word -> PassageSlideWord in var copy = word; copy.source = nil; return copy }
        var matchedAt = [Int?](repeating: nil, count: words.count)
        var cursor = 0
        for index in result.indices {
            let wanted = normalized(result[index].text)
            guard !wanted.isEmpty else { continue }
            let window = cursor..<min(deckWords.count, cursor + lookahead)
            if let found = window.first(where: { deckWords[$0].key == wanted }) {
                matchedAt[index] = found
                result[index].source = deckWords[found].range
                cursor = found + 1
            }
        }
        // A word read wrongly between two matches is the deck word between them.
        var previous: (word: Int, deck: Int)?
        for index in result.indices {
            guard let deck = matchedAt[index] else { continue }
            if let previous, index - previous.word > 1, deck - previous.deck == index - previous.word {
                for gap in 1..<(index - previous.word) { result[previous.word + gap].source = deckWords[previous.deck + gap].range }
            }
            previous = (index, deck)
        }
        return result
    }

    /// What words `range` insert: the deck's own text from the first to the last, or as read when the deck lacks them.
    static func text(_ words: [PassageSlideWord], _ range: ClosedRange<Int>, in document: PassageDocument) -> String {
        guard words.indices.contains(range.lowerBound), words.indices.contains(range.upperBound) else { return "" }
        if let source = sourceRange(words, range) { return document.insertedText(source) }
        return words[range].map(\.text).joined(separator: " ")
    }

    /// Where words `range` are in the deck's text, when both ends were found there.
    static func sourceRange(_ words: [PassageSlideWord], _ range: ClosedRange<Int>) -> NSRange? {
        guard words.indices.contains(range.lowerBound), words.indices.contains(range.upperBound),
              let first = words[range.lowerBound].source, let last = words[range.upperBound].source,
              NSMaxRange(last) >= first.location else { return nil }
        return NSRange(location: first.location, length: NSMaxRange(last) - first.location)
    }

    static func citation(_ words: [PassageSlideWord], _ range: ClosedRange<Int>, in document: PassageDocument) -> String? {
        sourceRange(words, range).flatMap(document.citation(for:))
    }

    /// The words that are the deck's text `selection`, first to last.
    static func covering(_ words: [PassageSlideWord], _ selection: NSRange) -> ClosedRange<Int>? {
        let inside = words.indices.filter { index in
            words[index].source.map { NSIntersectionRange($0, selection).length > 0 } ?? false
        }
        guard let first = inside.first, let last = inside.last else { return nil }
        return first...last
    }

    /// The word a press at `point` (from the top left, 0...1) lands on: the one under it,
    /// or on the nearest line, the word nearest along it.
    static func nearest(_ words: [PassageSlideWord], to point: CGPoint) -> Int? {
        if let hit = words.indices.first(where: { words[$0].box.contains(point) }) { return hit }
        func distance(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat {
            value < low ? low - value : value > high ? value - high : 0
        }
        let lineDistance = Dictionary(grouping: words.indices, by: { words[$0].line }).mapValues { indices in
            indices.map { distance(point.y, words[$0].box.minY, words[$0].box.maxY) }.min() ?? .infinity
        }
        guard let line = lineDistance.min(by: { $0.value < $1.value })?.key else { return nil }
        return words.indices.filter { words[$0].line == line }
            .min { distance(point.x, words[$0].box.minX, words[$0].box.maxX) < distance(point.x, words[$1].box.minX, words[$1].box.maxX) }
    }

    /// The deck's words on slide `slide`, its labels and bullets left out, each with where it is.
    private static func deckWords(of document: PassageDocument, slide: Int) -> [(key: String, range: NSRange)] {
        guard let place = document.places.first(where: { $0.kind == "slide" && $0.number == slide }) else { return [] }
        let whole = document.text as NSString
        var found: [(key: String, range: NSRange)] = []
        guard let pattern = try? NSRegularExpression(pattern: "\\S+") else { return [] }
        for match in pattern.matches(in: document.text, range: place.range) {
            if document.decorations.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) { continue }
            let key = normalized(whole.substring(with: match.range))
            if !key.isEmpty { found.append((key, match.range)) }
        }
        return found
    }

    /// A word as it is compared: its letters and digits, in lower case.
    static func normalized(_ word: String) -> String {
        String(word.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
    }
}
