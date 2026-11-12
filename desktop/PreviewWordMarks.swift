import Cocoa
import PDFKit
import Vision

// The typed words a suggestion matched, marked where its source preview shows
// them: inside the cited passage when it can be found, wherever they appear
// otherwise. The server names the words as the source spells them ("raised"
// for a typed "raise"), so marking them is finding whole words.
enum PreviewWordMarks {
    /// The colour of a matched word: the passage's colour, stronger.
    static func wordColor(_ accent: NSColor) -> NSColor { accent.withAlphaComponent(0.42) }
    static func passageColor(_ accent: NSColor) -> NSColor { accent.withAlphaComponent(0.16) }

    /// Where each of `words` appears in `text` as a whole word, ignoring case,
    /// within `limits` when they are given.
    static func ranges(of words: [String], in text: String, within limits: [NSRange] = []) -> [NSRange] {
        let whole = NSRange(location: 0, length: (text as NSString).length)
        // "Pool" and "pool" are one word to find, marked once.
        var seen = Set<String>()
        let distinct = words.filter { seen.insert($0.lowercased()).inserted }
        return distinct.flatMap { word -> [NSRange] in
            guard let pattern = try? NSRegularExpression(
                pattern: "(?<![\\p{L}\\p{N}])" + NSRegularExpression.escapedPattern(for: word) + "(?![\\p{L}\\p{N}])",
                options: [.caseInsensitive]) else { return [] }
            return pattern.matches(in: text, range: whole).map(\.range)
        }.filter { found in limits.isEmpty || limits.contains { NSIntersectionRange($0, found).length == found.length } }
    }

    /// Highlights for `words` on a PDF page, inside `cited` when the passage
    /// was found there. The caller removes them when the preview goes.
    static func pdfMarks(on page: PDFPage, words: [String], inside cited: CGRect?, color: NSColor) -> [PDFAnnotation] {
        guard let text = page.string, !words.isEmpty else { return [] }
        return ranges(of: words, in: text).compactMap { range -> PDFAnnotation? in
            guard let bounds = page.selection(for: range)?.bounds(for: page), !bounds.isEmpty,
                  cited.map({ $0.intersects(bounds) }) ?? true else { return nil }
            return highlight(bounds, color: color, on: page)
        }
    }

    /// Underlines for the words of the cited passage new since its previous
    /// version, numbers and dates stronger, where the passage is written once
    /// on the page (and inside `cited` when known). Matched words keep their
    /// highlight, so a changed word that was also typed shows both.
    static func pdfChangeMarks(on page: PDFPage, change: (before: String, after: String), inside cited: CGRect?) -> [PDFAnnotation] {
        guard let text = page.string else { return [] }
        let whole = NSRange(location: 0, length: (text as NSString).length)
        return PassageWordDiff.changes(from: change.before, to: change.after, writtenIn: text, within: whole).compactMap { word in
            guard let bounds = page.selection(for: word.range)?.bounds(for: page), !bounds.isEmpty,
                  cited.map({ $0.intersects(bounds) }) ?? true else { return nil }
            let annotation = PDFAnnotation(bounds: bounds, forType: .underline, withProperties: nil)
            annotation.color = NSColor.systemOrange.withAlphaComponent(word.emphasized ? 0.95 : 0.6)
            let border = PDFBorder()
            border.lineWidth = word.emphasized ? 2 : 1.25
            annotation.border = border
            page.addAnnotation(annotation)
            return annotation
        }
    }

    static func highlight(_ bounds: CGRect, color: NSColor, on page: PDFPage) -> PDFAnnotation {
        let annotation = PDFAnnotation(bounds: bounds, forType: .highlight, withProperties: nil)
        annotation.color = color
        page.addAnnotation(annotation)
        return annotation
    }

    /// Where a slide picture shows the cited passage and the matched words,
    /// as rectangles in the picture's unit square, origin at the bottom left.
    /// Reads the picture's text on this Mac; call it off the main thread.
    static func recognize(_ picture: Data, passage: String?, words: [String]) -> (passage: [CGRect], words: [CGRect]) {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        guard (try? VNImageRequestHandler(data: picture).perform([request])) != nil else { return ([], []) }
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first }
        let passageWords = Set(Self.plainWords(in: passage ?? ""))
        // A line is the passage's when most of its words are the passage's.
        let cited = lines.filter { line in
            let own = Self.plainWords(in: line.string)
            return !passageWords.isEmpty && !own.isEmpty
                && Double(own.filter(passageWords.contains).count) / Double(own.count) >= 0.6
        }
        let searched = cited.isEmpty ? lines : cited
        let wordBoxes = searched.flatMap { line in
            ranges(of: words, in: line.string).compactMap { range -> CGRect? in
                guard let span = Range(range, in: line.string) else { return nil }
                return try? line.boundingBox(for: span)?.boundingBox
            }
        }
        let lineBoxes = cited.compactMap { line -> CGRect? in
            try? line.boundingBox(for: line.string.startIndex..<line.string.endIndex)?.boundingBox
        }
        return (lineBoxes, wordBoxes)
    }

    private static func plainWords(in text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 1 }
    }
}

#if BROWSER_GEOMETRY_TEST
extension PreviewWordMarks {
    /// The typed words are marked inside the cited passage of a text preview
    /// and, read off the picture, on the cited slide; the marks come off with
    /// the preview. Returns failures.
    static func runRegression() -> [String] {
        var failures: [String] = []
        func require(_ condition: Bool, _ message: String) { if !condition { failures.append(message) } }

        let text = AssistPreviewText(blocks: [
            AssistTextBlock(type: "paragraph", text: "The pool was checked before the outage."),
            AssistTextBlock(type: "paragraph", text: "Pool raised from 40 to 80 connections.", cited: true),
        ], baseSize: 10.5, marking: ["Pool", "raised"])
        let marked = text.decorations.compactMap { decoration -> String? in
            guard case .matched = decoration.kind else { return nil }
            return (text.text.string as NSString).substring(with: decoration.range)
        }
        require(marked == ["Pool", "raised"], "Only the cited passage's words are marked in text (marked \(marked))")

        let picture = slidePicture(lines: ["Fixes", "Pool raised from 40 to 80 connections", "Alert when the pool is in use"])
        let deck = AssistSlideDeck(slides: [.init(number: 1, title: "Fixes")], aspect: 16 / 9)
        let source = SlidePictureSource(serverURL: URL(string: "http://127.0.0.1:9")!, objectId: "marks-\(UUID().uuidString)", versionId: nil)
        SlidePictureCache.keep(picture, 1, of: source)
        let view = AssistSlidePreviewView(slides: SlideDeckDocument(deck: deck, source: source), current: 1,
                                          marking: ["Pool", "raised"], in: "Pool raised from 40 to 80 connections")
        let window = NSWindow(contentRect: NSRect(x: -10_000, y: 0, width: 358, height: 222), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.contentView?.addSubview(view)
        view.frame = NSRect(x: 0, y: 0, width: 358, height: 222)
        let deadline = Date().addingTimeInterval(5)
        while view.marks.isEmpty && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        let page = view.navigator.deck.page(for: 1)
        let box = page?.bounds(for: .cropBox) ?? .zero
        let words = view.marks.filter { $0.color.alphaComponent > 0.3 }
        let passage = view.marks.filter { $0.color.alphaComponent < 0.3 }
        require(passage.count == 1, "The cited line is marked once on the slide (\(passage.count))")
        require(words.count == 2, "Both typed words on the cited line are marked, not the other line's pool (\(words.count))")
        require(words.allSatisfy { $0.bounds.midY > box.height * 0.45 && $0.bounds.width < box.width * 0.3 },
                "Each word mark sits on the cited line, a word wide (\(words.map(\.bounds)))")
        view.removeFromSuperview()
        require(page?.annotations.isEmpty == true, "The marks come off with the preview")

        // The card rebuilds its preview over the same cached deck as words change.
        let shared = SlideDeckDocument(deck: deck, source: source)
        var older: AssistSlidePreviewView? = AssistSlidePreviewView(slides: shared, current: 1)
        let newer = AssistSlidePreviewView(slides: shared, current: 1)
        older = nil
        require(older == nil && shared.pageWatcher == ObjectIdentifier(newer.navigator) && shared.didReplacePage != nil,
                "A newer view over the same deck keeps its picture updates when an older one goes")
        return failures
    }

    /// A white slide picture with `lines` of text from the top, as Quick Look draws one.
    private static func slidePicture(lines: [String]) -> Data {
        let image = NSImage(size: NSSize(width: 960, height: 540), flipped: false) { box in
            NSColor.white.setFill()
            box.fill()
            for (index, line) in lines.enumerated() {
                NSAttributedString(string: line, attributes: [.font: NSFont.systemFont(ofSize: index == 0 ? 44 : 30)])
                    .draw(at: NSPoint(x: 70, y: box.height - 110 - CGFloat(index) * 80))
            }
            return true
        }
        return NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .jpeg, properties: [:])!
    }
}
#endif
