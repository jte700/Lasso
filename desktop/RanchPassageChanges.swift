// The passages the shown version of a text or PDF file changed, as The
// Ranch's text and PDF viewers tint them, each with a note saying what it was
// and when, shown on hover or when the passage is selected.

import Foundation

/// A passage the latest version of a file changed, with what it was.
struct RanchPassageChange: Decodable, Equatable {
    let kind: String
    let pageNumber: Int?
    let start: Int?
    let end: Int?
    let lineStart: Int?
    let lineEnd: Int?
    let before: String?
    let after: String?
    let changedAt: String?

    /// The longest earlier wording the note quotes in full.
    static let quotedLength = 160

    /// "was “The pump was replaced on Tuesday.” · Nov 10, 3:04 PM"; `date` writes the time of the change.
    func note(date: (String?) -> String) -> String {
        let earlier = before ?? ""
        let quoted = earlier.count > Self.quotedLength ? String(earlier.prefix(Self.quotedLength - 1)) + "\u{2026}" : earlier
        let when = date(changedAt)
        return (quoted.isEmpty ? "was empty" : "was \u{201C}\(quoted)\u{201D}") + (when.isEmpty ? "" : " \u{00B7} \(when)")
    }

    /// Where the passage is in a text file's `text`: at its recorded offsets
    /// while they still hold its words (Markdown markers aside), otherwise
    /// where its words are written once; nil when neither finds it.
    func range(in text: String) -> NSRange? {
        guard let after, !after.isEmpty else { return nil }
        let string = text as NSString
        if let start, let end, start >= 0, start < end, end <= string.length {
            let recorded = NSRange(location: start, length: end - start)
            if Self.words(string.substring(with: recorded)) == Self.words(after) { return recorded }
        }
        return PassageWordDiff.onlyPlace(of: after, in: text, within: NSRange(location: 0, length: string.length))
    }

    private static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }
}

/// What /api/ranch/passages answers: the version shown and the passages it changed.
struct RanchPassageChanges: Decodable {
    let version: String?
    let changes: [RanchPassageChange]
}
