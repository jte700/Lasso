// The passage picker for a PDF: the PDF itself, its pages as they print,
// where the words are highlighted on the page. Until the file arrives, or if
// it cannot be shown, the PDF's text stands in.

import Cocoa
import PDFKit

/// Selects by mouse in a panel that never takes the keyboard, where PDFView's
/// own drag does not: a drag selects across pages, a double click a word and
/// a triple click a line. The selection is drawn in the accent colour.
final class PassagePDFView: PDFView {
    var onSelectionChange: (() -> Void)?
    /// The folder's colour, as the card marks its words.
    var highlight = NSColor.controlAccentColor.withAlphaComponent(0.35)

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window, let document, let start = pagePoint(event) else { return }
        let first: PDFSelection?
        switch event.clickCount {
        case 3...: first = start.page.selectionForLine(at: start.point)
        case 2: first = start.page.selectionForWord(at: start.point)
        default: first = nil
        }
        choose(first)
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            autoscroll(with: next)
            guard let end = pagePoint(next) else { continue }
            let dragged = document.selection(from: start.page, at: start.point, to: end.page, at: end.point)
            if let first, let dragged { dragged.add(first) }
            choose(dragged ?? first)
        }
    }

    private func pagePoint(_ event: NSEvent) -> (page: PDFPage, point: NSPoint)? {
        let point = convert(event.locationInWindow, from: nil)
        guard let page = page(for: point, nearest: true) else { return nil }
        return (page, convert(point, to: page))
    }

    /// Makes `selection` the highlight, drawn in the accent colour.
    func choose(_ selection: PDFSelection?) {
        selection?.color = highlight
        setCurrentSelection(selection, animate: false)
        highlightedSelections = selection.map { [$0] }
        onSelectionChange?()
    }
}

final class PassagePDFBody: NSView, PassagePickerBody {
    private let document: PassageDocument
    private let pdfView = PassagePDFView()
    /// The PDF's text, shown until the file is open, and kept if it never opens.
    private let fallback: PassageTextBody
    private var showingPDF = false
    private var request: URLSessionDataTask?
    private var pendingSelection: NSRange?
    /// What the PDF opened highlighted, to tell a highlight the writer chose from it.
    private var openingText: String?
    var onSelectionChange: (() -> Void)?
    var view: NSView { self }
    override var isFlipped: Bool { true }

    init(document: PassageDocument, fileURL: URL?, highlight: NSColor) {
        self.document = document
        fallback = PassageTextBody(document: document, highlight: highlight)
        super.init(frame: .zero)
        pdfView.highlight = highlight
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displaysPageBreaks = true
        pdfView.backgroundColor = NSColor.underPageBackgroundColor
        pdfView.wantsLayer = true
        pdfView.layer?.cornerRadius = 10
        pdfView.layer?.masksToBounds = true
        pdfView.isHidden = true
        pdfView.onSelectionChange = { [weak self] in self?.onSelectionChange?() }
        fallback.onSelectionChange = { [weak self] in self?.onSelectionChange?() }
        addSubview(fallback)
        addSubview(pdfView)
        if let fileURL { load(fileURL) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        pdfView.frame = bounds
        fallback.frame = bounds
    }

    private func load(_ url: URL) {
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 30
        request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, _ in
            let ok = ((response as? HTTPURLResponse)?.statusCode ?? 0) == 200
            let pdf = ok ? data.flatMap(PDFDocument.init(data:)) : nil
            DispatchQueue.main.async {
                guard let self, let pdf, !pdf.isLocked, pdf.pageCount > 0 else { return }
                self.open(pdf)
            }
        }
        request?.resume()
    }

    /// Shows the PDF in place of its text, highlighted where the text was.
    func open(_ pdf: PDFDocument) {
        let carried = showingPDF ? nil : fallback.selectedRange
        pdfView.document = pdf
        pdfView.isHidden = false
        fallback.isHidden = true
        showingPDF = true
        layoutSubtreeIfNeeded()
        let wanted = carried.flatMap { $0.length > 0 ? $0 : nil } ?? pendingSelection
        if let wanted, let selection = pdfSelection(for: wanted, in: pdf) {
            openingText = selection.string
            pdfView.choose(selection)
            pdfView.go(to: selection)
            pdfView.scrollSelectionToVisible(nil)
        } else {
            onSelectionChange?()
        }
    }

    func select(_ range: NSRange?) {
        pendingSelection = range
        fallback.select(range)
    }

    /// The server's text of `range` found on its page of the PDF, whatever the spacing between its words.
    private func pdfSelection(for range: NSRange, in pdf: PDFDocument) -> PDFSelection? {
        let needle = document.substring(range).trimmingCharacters(in: .whitespacesAndNewlines)
        let words = needle.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(60).map { NSRegularExpression.escapedPattern(for: String($0)) }
        guard !words.isEmpty, let pattern = try? NSRegularExpression(pattern: words.joined(separator: "[^\\p{L}\\p{N}]+"),
                                                                    options: [.caseInsensitive]) else { return nil }
        let cited = document.place(at: range.location, kind: "page")?.number
        let order = (0..<pdf.pageCount).sorted { (($0 + 1) == cited ? 0 : 1) < (($1 + 1) == cited ? 0 : 1) }
        for index in order {
            guard let page = pdf.page(at: index), let text = page.string else { continue }
            let whole = text as NSString
            if let match = pattern.firstMatch(in: text, range: NSRange(location: 0, length: whole.length)) {
                // The passage's closing punctuation ("released.") is part of it when the page has it too.
                let closing = needle.reversed().prefix { !$0.isLetter && !$0.isNumber && !$0.isWhitespace }.count
                let end = NSMaxRange(match.range)
                let more = closing > 0 && end + closing <= whole.length
                    && whole.substring(with: NSRange(location: end, length: closing)) == String(needle.suffix(closing)) ? closing : 0
                return page.selection(for: NSRange(location: match.range.location, length: match.range.length + more))
            }
        }
        return nil
    }

    var isOpeningSelection: Bool {
        guard showingPDF else { return fallback.isOpeningSelection }
        return openingText != nil && pdfView.currentSelection?.string == openingText
    }

    func pick(citing: Bool) -> PassagePick? {
        guard showingPDF else { return fallback.pick(citing: citing) }
        guard let selection = pdfView.currentSelection, let raw = selection.string else { return nil }
        let body = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !body.isEmpty else { return nil }
        return PassagePick(body: body, citation: citing ? citation() : nil, quoted: false, videoTime: nil)
    }

    func citation() -> String? {
        guard showingPDF else { return fallback.citation() }
        guard let selection = pdfView.currentSelection, let pdf = pdfView.document,
              selection.string?.isEmpty == false else { return nil }
        let pages = selection.pages.map { pdf.index(for: $0) + 1 }
        return "(\(document.name)\(PassageDocument.numbered("page", pages).map { ", \($0)" } ?? ""))"
    }

    func moveSelection(forward: Bool, byLine: Bool, extending: Bool) {
        guard showingPDF else { fallback.moveSelection(forward: forward, byLine: byLine, extending: extending); return }
        if byLine || !extending {
            forward ? pdfView.scrollLineDown(nil) : pdfView.scrollLineUp(nil)
            return
        }
        guard let selection = pdfView.currentSelection?.copy() as? PDFSelection else { return }
        // A word at a time: on to the next space, or back past the last one.
        let step = forward ? 1 : -1
        var moved = 0
        repeat {
            selection.extend(atEnd: step)
            moved += 1
        } while moved < 40 && !(selection.string?.last?.isWhitespace ?? true)
        if !forward, let text = selection.string, text.hasSuffix(" ") { selection.extend(atEnd: -1) }
        pdfView.choose(selection)
    }

    func stop() { request?.cancel() }
}
