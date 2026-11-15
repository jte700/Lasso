// The passage picker's document as the server sends it, the citation for
// what is highlighted in it, and how inserting the highlight joins what was
// typed. Plain Foundation, so the unit checks run it without windows.

import Foundation

/// Where part of the document is in its file: a word's time, a slide, a page, a section or a line.
struct PassagePlace {
    let range: NSRange
    let kind: String
    let time: Double?
    let number: Int?
    let title: String?
}

/// The typed words a passage was found by ("the fire"), counted back from the caret.
struct PassageTrigger: Equatable {
    /// UTF-16 units from the words' start to the caret.
    let fromEnd: Int
    let length: Int
    let text: String

    /// Where the words are in `before`, the text up to the caret, if they are still there as typed.
    func range(in before: String) -> Range<Int>? {
        let whole = before as NSString
        let start = whole.length - fromEnd
        guard start >= 0, length > 0, start + length <= whole.length,
              whole.substring(with: NSRange(location: start, length: length)) == text else { return nil }
        return start..<(start + length)
    }
}

struct PassageDocument {
    /// The file's name with its extension, which citations name it by.
    let name: String
    /// "video", "slides", "pdf", "word" or "text".
    let kind: String
    let text: String
    /// Labels shown but never inserted: a slide's or page's name, a sentence's time, a bullet.
    let decorations: [NSRange]
    let headings: [NSRange]
    let places: [PassagePlace]
    /// A video's and a PDF's line breaks are only layout, so they are inserted as spaces.
    let joinsLines: Bool
    /// The passage the suggestion cited, highlighted when the picker opens.
    let selection: NSRange?
    /// Why there is nothing to pick from, when there is not.
    let unavailable: String?
    let truncated: Bool
    /// Where a video is on this Mac, which its player plays.
    var localPath: String? = nil
    /// The typed words the opening highlight was found by.
    var trigger: PassageTrigger? = nil

    static func parse(_ data: Data) -> PassageDocument? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let document = root["document"] as? [String: Any] else { return nil }
        let text = document["text"] as? String ?? ""
        let length = (text as NSString).length
        func range(_ json: Any?) -> NSRange? {
            guard let json = json as? [String: Any], let start = json["start"] as? Int, let end = json["end"] as? Int,
                  start >= 0, end >= start, end <= length else { return nil }
            return NSRange(location: start, length: end - start)
        }
        let places = (document["places"] as? [[String: Any]] ?? []).compactMap { place -> PassagePlace? in
            guard let span = range(place) else { return nil }
            return PassagePlace(range: span, kind: place["kind"] as? String ?? "",
                                time: (place["time"] as? NSNumber)?.doubleValue,
                                number: place["number"] as? Int, title: place["title"] as? String)
        }
        var parsed = PassageDocument(
            name: document["name"] as? String ?? "",
            kind: document["kind"] as? String ?? "text",
            text: text,
            decorations: (document["decorations"] as? [Any] ?? []).compactMap(range),
            headings: (document["headings"] as? [Any] ?? []).compactMap(range),
            places: places,
            joinsLines: document["lineBreaks"] as? String == "space",
            selection: range(document["selection"]).flatMap { $0.length > 0 ? $0 : nil },
            unavailable: document["unavailable"] as? String,
            truncated: document["truncated"] as? Bool == true)
        parsed.localPath = (document["localPath"] as? String).flatMap { $0.hasPrefix("/") ? $0 : nil }
        if let trigger = (document["selection"] as? [String: Any])?["trigger"] as? [String: Any],
           let fromEnd = trigger["fromEnd"] as? Int, let length = trigger["length"] as? Int, let text = trigger["text"] as? String {
            parsed.trigger = PassageTrigger(fromEnd: fromEnd, length: length, text: text)
        }
        return parsed
    }

    /// The places of one kind that hold `index`, such as the slide a word is on.
    func place(at index: Int, kind: String) -> PassagePlace? {
        places.first { $0.kind == kind && NSLocationInRange(index, $0.range) }
            ?? places.last { $0.kind == kind && $0.range.location <= index }
    }

    /// The text of `range` the server sent, which a PDF's own text is searched for.
    func substring(_ range: NSRange) -> String {
        let whole = text as NSString
        return whole.substring(with: NSIntersectionRange(range, NSRange(location: 0, length: whole.length)))
    }

    /// The highlighted words as they are inserted: exactly as written, less
    /// the document's own labels, with a video's or PDF's line breaks as spaces.
    func insertedText(_ selected: NSRange) -> String {
        let whole = text as NSString
        let range = NSIntersectionRange(selected, NSRange(location: 0, length: whole.length))
        guard range.length > 0 else { return "" }
        var kept = ""
        var cursor = range.location
        for label in decorations.sorted(by: { $0.location < $1.location }) {
            let cut = NSIntersectionRange(label, range)
            guard cut.length > 0, cut.location >= cursor else { continue }
            kept += whole.substring(with: NSRange(location: cursor, length: cut.location - cursor))
            cursor = NSMaxRange(cut)
        }
        kept += whole.substring(with: NSRange(location: cursor, length: NSMaxRange(range) - cursor))
        let lines = kept.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let joined = joinsLines ? lines.filter { !$0.isEmpty }.joined(separator: " ") : lines.joined(separator: "\n")
        return joined.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The places the highlight covers, in the order they come.
    func places(in selected: NSRange) -> [PassagePlace] {
        places.filter { NSIntersectionRange($0.range, selected).length > 0 }
    }

    /// Seconds into a video where the highlight starts, which its link starts the player at.
    func time(of selected: NSRange) -> Double? {
        kind == "video" ? places(in: selected).first?.time : nil
    }

    /// What the highlight is cited as: the file, then where in it.
    /// "(Site Standup.mov, 0:04)", "(Review.pptx, slide 2)", "(Agreement.pdf, pages 3–4)",
    /// "(README.md, lines 12–14)", "(Spec.docx, Results)", or "(Spec.docx)" with no heading above.
    func citation(for selected: NSRange) -> String? {
        let covered = places(in: selected)
        guard !name.isEmpty else { return nil }
        let place: String?
        switch kind {
        case "video":
            place = covered.first?.time.map(Self.timestamp)
        case "slides":
            place = Self.numbered("slide", covered.compactMap(\.number))
        case "pdf":
            place = Self.numbered("page", covered.compactMap(\.number))
        case "text":
            place = Self.numbered("line", covered.compactMap(\.number), listed: false)
        case "word":
            place = covered.first?.title
        default:
            place = nil
        }
        return "(\(name)\(place.map { ", \($0)" } ?? ""))"
    }

    /// "slide 2", "slides 2–3" or "slides 2, 5"; lines are always a span ("lines 12–14").
    static func numbered(_ noun: String, _ numbers: [Int], listed: Bool = true) -> String? {
        let distinct = Array(Set(numbers)).sorted()
        guard let first = distinct.first, let last = distinct.last else { return nil }
        if first == last { return "\(noun) \(first)" }
        let consecutive = last - first == distinct.count - 1
        return consecutive || !listed ? "\(noun)s \(first)\u{2013}\(last)"
            : "\(noun)s \(distinct.map(String.init).joined(separator: ", "))"
    }

    /// A time as a player shows it: 0:04, 12:40, 1:02:03.
    static func timestamp(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        let hours = whole / 3600, minutes = (whole % 3600) / 60, rest = whole % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }
}

/// How inserting a highlight joins the text before the caret.
enum PassageInsertion {
    struct Plan: Equatable {
        /// What is typed in place of `replaceStart..<replaceEnd`.
        let text: String
        /// UTF-16 offsets into the text before the caret.
        let replaceStart: Int
        let replaceEnd: Int
    }

    /// The most typed words compared with the highlight's first words.
    private static let maxTypedWords = 12
    private static let word = try! NSRegularExpression(pattern: #"[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*"#)
    private static let openingMarks: Set<Character> = ["\"", "\u{201C}", "\u{201E}", "'", "\u{2018}", "(", "[", "{"]

    /// The highlight, quoted when it is something said, with its citation
    /// when asked for. When it begins with the words typed last ("the fire"
    /// before "The fire inspection…"), it is typed in their place, so they are
    /// not written twice. A highlight the writer chose instead of the opening
    /// one takes the place of `replacing`, the typed words the suggestion was
    /// found by. Otherwise it goes after what was typed.
    static func plan(body: String, citation: String?, quoted: Bool, before: String,
                     replacing trigger: PassageTrigger? = nil) -> Plan? {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let quote = quoted && citation != nil
        let core = quote ? "\"\(trimmed)\"" : trimmed
        let inserted = citation.map { "\(core) \($0)" } ?? core
        let caret = (before as NSString).length
        if var overlap = typedOverlap(body: trimmed, before: before) ?? trigger?.range(in: before) {
            // A quote the writer opened before the words is the one this quote begins with.
            if quote, overlap.lowerBound > 0,
               let mark = (before as NSString).substring(with: NSRange(location: overlap.lowerBound - 1, length: 1)).first,
               openingMarks.contains(mark), mark != "(", mark != "[", mark != "{" {
                overlap = (overlap.lowerBound - 1)..<overlap.upperBound
            }
            return Plan(text: inserted, replaceStart: overlap.lowerBound, replaceEnd: overlap.upperBound)
        }
        let last = before.last
        let spaced = last == nil || last!.isWhitespace || openingMarks.contains(last!) ? inserted : " \(inserted)"
        return Plan(text: spaced, replaceStart: caret, replaceEnd: caret)
    }

    /// The typed words at the caret that the highlight begins with, as a
    /// UTF-16 range of `before`; the last may be unfinished ("insp").
    private static func typedOverlap(body: String, before: String) -> Range<Int>? {
        let typed = words(in: before)
        guard let last = typed.last else { return nil }
        let tail = (before as NSString).substring(from: NSMaxRange(last.range))
        guard tail.allSatisfy(\.isWhitespace) else { return nil }
        let unfinished = tail.isEmpty
        let leading = words(in: body)
        for count in stride(from: min(maxTypedWords, typed.count, leading.count), through: 1, by: -1) {
            let run = Array(typed.suffix(count))
            let matches = run.indices.allSatisfy { index in
                let typedKey = run[index].key, sourceKey = leading[index].key
                return sameWord(sourceKey, typedKey) || (unfinished && index == run.count - 1 && sourceKey.hasPrefix(typedKey))
            }
            if matches { return run[0].range.location..<NSMaxRange(run[run.count - 1].range) }
        }
        return nil
    }

    /// Endings a written word takes, and what each leaves behind. The same as ENDINGS in src/sharing/passage-selection.js.
    private static let endings: [(ending: String, kept: String)] = [("ies", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", ""), ("d", "")]
    /// The shortest stem two forms of a word are matched by, so short words ("new", "news") stay apart.
    private static let minimumStem = 4

    /// A word without its ending and a final "e": "shipments" and "shipment", "stored" and "storing" share one.
    static func stem(_ key: String) -> String {
        var word = key
        if let (ending, kept) = endings.first(where: { word.hasSuffix($0.ending) && word.count - $0.ending.count + $0.kept.count >= minimumStem }) {
            word = String(word.dropLast(ending.count)) + kept
        }
        return word.count > minimumStem && word.hasSuffix("e") ? String(word.dropLast()) : word
    }

    /// Whether a typed word is the highlight's word, or another form of it.
    static func sameWord(_ written: String, _ typed: String) -> Bool {
        written == typed || (written.count >= minimumStem && typed.count >= minimumStem && stem(written) == stem(typed))
    }

    private static func words(in text: String) -> [(range: NSRange, key: String)] {
        let whole = text as NSString
        return word.matches(in: text, range: NSRange(location: 0, length: whole.length)).map { match in
            let key = whole.substring(with: match.range).lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
                .filter { $0.isLetter || $0.isNumber }
            return (match.range, key)
        }
    }
}

extension PassageDocument {
    /// The files whose passages are picked from their document, as the server's passageKind reads them.
    static let pickedExtensions: Set<String> = ["mov", "mp4", "m4v", "pptx", "pdf", "docx", "md", "markdown", "txt", "text", "rst", "log"]
    /// A sentence or passage of a file, as opposed to a value, a cell, a name or the whole file.
    static let passageComponents: Set<String> = ["TEXT_EXCERPT", "PDF_EXCERPT", "VIDEO_SEGMENT"]

    /// Whether Tab on a suggestion of this source opens the passage picker.
    static func opensPicker(candidate: [String: Any]) -> Bool {
        guard candidate["id"] is String, let path = candidate["path"] as? String,
              pickedExtensions.contains((path as NSString).pathExtension.lowercased()),
              let component = (candidate["metadata"] as? [String: Any])?["componentType"] as? String,
              candidate["anchor"] is [String: Any] else { return false }
        return passageComponents.contains(component)
    }
}
