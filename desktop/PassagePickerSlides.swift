// The passage picker for a deck: the slide itself, filling the picker, where
// words are highlighted on the slide as on a PDF's page. The words are read off
// the slide's picture on this Mac and matched to the deck's text, so what is
// inserted is what the deck says. Until a picture arrives, or if it cannot be
// drawn, the deck's text stands in.

import Cocoa
import Vision

/// Reads the words on a slide's picture, line by line from the top, each with where it is.
enum PassageSlideReader {
    static func words(in picture: Data) -> [PassageSlideWord] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        guard (try? VNImageRequestHandler(data: picture).perform([request])) != nil else { return [] }
        // Vision measures from the bottom left; the picker from the top left.
        let found = (request.results ?? []).compactMap { $0.topCandidates(1).first }
            .map { (text: $0, box: flipped((try? $0.boundingBox(for: $0.string.startIndex..<$0.string.endIndex))??.boundingBox ?? .zero)) }
            .sorted { $0.box.midY < $1.box.midY }
        // Lines side by side (two columns, a label beside a value) are one row, read left to right.
        var rows: [[(text: VNRecognizedText, box: CGRect)]] = []
        for line in found {
            if let last = rows.last?.last, abs(line.box.midY - last.box.midY) < min(line.box.height, last.box.height) / 2 {
                rows[rows.count - 1].append(line)
            } else {
                rows.append([line])
            }
        }
        let lines = rows.flatMap { $0.sorted { $0.box.minX < $1.box.minX } }
        var words: [PassageSlideWord] = []
        for (number, line) in lines.enumerated() {
            let string = line.text.string
            var start = string.startIndex
            while start < string.endIndex {
                guard let wordStart = string[start...].firstIndex(where: { !$0.isWhitespace }) else { break }
                let wordEnd = string[wordStart...].firstIndex(where: \.isWhitespace) ?? string.endIndex
                if let box = try? line.text.boundingBox(for: wordStart..<wordEnd)?.boundingBox {
                    words.append(PassageSlideWord(text: String(string[wordStart..<wordEnd]), box: flipped(box), line: number))
                }
                start = wordEnd
            }
        }
        return words
    }

    private static func flipped(_ box: CGRect) -> CGRect {
        CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height)
    }
}

/// The slide's picture, fitted to the space, with the highlighted words marked on it.
/// It tracks its own drags, since its panel never takes the keyboard.
final class PassageSlideCanvas: NSView {
    var picture: NSImage? { didSet { needsDisplay = true; window?.invalidateCursorRects(for: self) } }
    var words: [PassageSlideWord] = [] { didSet { needsDisplay = true } }
    var selection: ClosedRange<Int>? { didSet { needsDisplay = true } }
    var highlight = NSColor.controlAccentColor.withAlphaComponent(0.35)
    /// A press or drag chose `selection`.
    var onChoose: ((ClosedRange<Int>?) -> Void)?
    override var isFlipped: Bool { true }

    /// Where the picture is drawn: as large as fits, centred.
    var pictureRect: NSRect {
        guard let size = picture?.size, size.width > 0, size.height > 0 else { return bounds }
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        let width = (size.width * scale).rounded(), height = (size.height * scale).rounded()
        return NSRect(x: bounds.midX - width / 2, y: bounds.midY - height / 2, width: width, height: height)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let picture else { return }
        let frame = pictureRect
        picture.draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        guard let selection, words.indices.contains(selection.lowerBound), words.indices.contains(selection.upperBound) else { return }
        // One mark per line, from its first highlighted word to its last, as text is highlighted.
        highlight.setFill()
        for line in Dictionary(grouping: words[selection], by: \.line).values {
            let box = line.map(\.box).reduce(line[0].box) { $0.union($1) }
            let rect = NSRect(x: frame.minX + box.minX * frame.width, y: frame.minY + box.minY * frame.height,
                              width: box.width * frame.width, height: box.height * frame.height).insetBy(dx: -2, dy: -2)
            NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3).fill()
        }
    }

    override func resetCursorRects() {
        if picture != nil, !words.isEmpty { addCursorRect(pictureRect, cursor: .iBeam) }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The word under, or nearest to, a point in the view.
    private func word(at point: NSPoint) -> Int? {
        let frame = pictureRect
        guard frame.width > 0, frame.height > 0 else { return nil }
        return PassageSlideWords.nearest(words, to: CGPoint(x: (point.x - frame.minX) / frame.width,
                                                            y: (point.y - frame.minY) / frame.height))
    }

    override func mouseDown(with event: NSEvent) {
        guard let window, let anchor = word(at: convert(event.locationInWindow, from: nil)) else { return }
        switch event.clickCount {
        case 3...:
            let line = words.indices.filter { words[$0].line == words[anchor].line }
            onChoose?(line.first.flatMap { first in line.last.map { first...$0 } })
            return
        default:
            onChoose?(anchor...anchor)
        }
        guard event.clickCount == 1 else { return }
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            guard let head = word(at: convert(next.locationInWindow, from: nil)) else { continue }
            onChoose?(min(anchor, head)...max(anchor, head))
        }
    }
}

final class PassageSlidesBody: NSView, PassagePickerBody {
    private static let navigationHeight: CGFloat = 38

    private let document: PassageDocument
    private let source: SlidePictureSource?
    private let canvas = PassageSlideCanvas()
    private let spinner = NSProgressIndicator()
    private let previous = PassagePickerControls.circleButton(symbol: "chevron.left", label: "Previous slide")
    private let next = PassagePickerControls.circleButton(symbol: "chevron.right", label: "Next slide")
    private let counter = NSTextField(labelWithString: "")
    /// The deck's text, shown only when a slide cannot be drawn.
    private let text: PassageTextBody
    private var showingText = false
    private let numbers: [Int]
    private var shown: Int?
    private var request: URLSessionDataTask?
    /// The passage the suggestion cited, highlighted once its slide's words are read.
    private var pendingSelection: NSRange?
    private var opening: (slide: Int, words: ClosedRange<Int>)?
    /// The highlight's fixed end and moving end, as word indices on the shown slide.
    private var anchor: Int?
    private var head: Int?
    var onSelectionChange: (() -> Void)?
    var view: NSView { self }
    override var isFlipped: Bool { true }

    init(document: PassageDocument, source: SlidePictureSource?, highlight: NSColor) {
        self.document = document
        self.source = source
        text = PassageTextBody(document: document, highlight: highlight)
        numbers = Array(Set(document.places.filter { $0.kind == "slide" }.compactMap(\.number))).sorted()
        super.init(frame: .zero)
        canvas.highlight = highlight
        canvas.wantsLayer = true
        canvas.layer?.cornerRadius = 10
        canvas.layer?.masksToBounds = true
        canvas.onChoose = { [weak self] in self?.choose($0) }
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        counter.font = .systemFont(ofSize: 12, weight: .medium)
        counter.textColor = .secondaryLabelColor
        counter.alignment = .center
        previous.target = self
        previous.action = #selector(showPrevious)
        next.target = self
        next.action = #selector(showNext)
        text.isHidden = true
        text.onSelectionChange = { [weak self] in self?.onSelectionChange?() }
        [canvas, spinner, previous, counter, next, text].forEach(addSubview)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        let slideHeight = max(0, bounds.height - Self.navigationHeight)
        canvas.frame = NSRect(x: 0, y: 0, width: bounds.width, height: slideHeight)
        text.frame = canvas.frame
        spinner.frame = NSRect(x: bounds.midX - 8, y: slideHeight / 2 - 8, width: 16, height: 16)
        let navigationY = slideHeight + 8
        previous.frame = NSRect(x: bounds.midX - 90, y: navigationY, width: 26, height: 26)
        next.frame = NSRect(x: bounds.midX + 64, y: navigationY, width: 26, height: 26)
        counter.frame = NSRect(x: bounds.midX - 60, y: navigationY + 5, width: 120, height: 16)
        window?.invalidateCursorRects(for: canvas)
    }

    func select(_ range: NSRange?) {
        pendingSelection = range
        text.select(range)
        let slide = range.flatMap { document.place(at: $0.location, kind: "slide")?.number } ?? numbers.first
        show(slide)
    }

    @objc private func showPrevious() { step(-1) }
    @objc private func showNext() { step(1) }

    private func step(_ delta: Int) {
        guard let shown, let index = numbers.firstIndex(of: shown),
              numbers.indices.contains(index + delta) else { NSSound.beep(); return }
        show(numbers[index + delta])
    }

    /// Shows slide `number`, its words to be read before they can be highlighted.
    private func show(_ number: Int?) {
        guard let number else { return }
        shown = number
        counter.stringValue = "Slide \(number) of \(numbers.last ?? number)"
        previous.isEnabled = numbers.first.map { number > $0 } ?? false
        next.isEnabled = numbers.last.map { number < $0 } ?? false
        canvas.words = []
        setSelection(nil, notify: true)
        if showingText, let place = document.places.first(where: { $0.kind == "slide" && $0.number == number }) {
            text.scrollToTop(max(0, place.range.location - 12))
        }
        loadPicture(number)
    }

    private func loadPicture(_ number: Int) {
        request?.cancel()
        guard let source else { showText(); return }
        if let cached = SlidePictureCache.picture(number, of: source) { showPicture(cached, number); return }
        canvas.picture = nil
        spinner.startAnimation(nil)
        guard let url = source.url(for: number) else { showText(); return }
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 60
        request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, _ in
            let ok = ((response as? HTTPURLResponse)?.statusCode ?? 0) == 200
            DispatchQueue.main.async {
                guard let self, self.shown == number else { return }
                self.spinner.stopAnimation(nil)
                guard ok, let data, NSImage(data: data) != nil else { self.showText(); return }
                SlidePictureCache.keep(data, number, of: source)
                self.showPicture(data, number)
            }
        }
        request?.resume()
    }

    private func showPicture(_ data: Data, _ number: Int) {
        spinner.stopAnimation(nil)
        guard let image = NSImage(data: data) else { showText(); return }
        canvas.picture = image
        DispatchQueue.global(qos: .userInitiated).async { [weak self, document] in
            let read = PassageSlideWords.aligned(PassageSlideReader.words(in: data), to: document, slide: number)
            DispatchQueue.main.async {
                guard let self, self.shown == number else { return }
                self.canvas.words = read
                self.window?.invalidateCursorRects(for: self.canvas)
                self.highlightOpening(on: number)
            }
        }
    }

    /// The passage the suggestion cited, once, on its slide.
    private func highlightOpening(on number: Int) {
        guard let wanted = pendingSelection,
              document.place(at: wanted.location, kind: "slide")?.number == number else { return }
        pendingSelection = nil
        guard let words = PassageSlideWords.covering(canvas.words, wanted) else { return }
        opening = (number, words)
        anchor = words.lowerBound
        head = words.upperBound
        setSelection(words, notify: true)
    }

    /// A slide that cannot be drawn: the deck's text, highlighted as the picture would have been.
    private func showText() {
        spinner.stopAnimation(nil)
        guard !showingText else { return }
        showingText = true
        canvas.isHidden = true
        text.isHidden = false
        onSelectionChange?()
    }

    private func choose(_ words: ClosedRange<Int>?) {
        anchor = words?.lowerBound
        head = words?.upperBound
        setSelection(words, notify: true)
    }

    private func setSelection(_ words: ClosedRange<Int>?, notify: Bool) {
        canvas.selection = words
        if notify { onSelectionChange?() }
    }

    func pick(citing: Bool) -> PassagePick? {
        guard !showingText else { return text.pick(citing: citing) }
        guard let selection = canvas.selection else { return nil }
        let body = PassageSlideWords.text(canvas.words, selection, in: document)
        guard !body.isEmpty else { return nil }
        return PassagePick(body: body, citation: citing ? citation() : nil, quoted: false, videoTime: nil)
    }

    var isOpeningSelection: Bool {
        guard !showingText else { return text.isOpeningSelection }
        guard let opening, let selection = canvas.selection else { return false }
        return opening.slide == shown && opening.words == selection
    }

    func citation() -> String? {
        guard !showingText else { return text.citation() }
        guard let selection = canvas.selection, let shown else { return nil }
        return PassageSlideWords.citation(canvas.words, selection, in: document)
            ?? "(\(document.name), \(PassageDocument.numbered("slide", [shown]) ?? "slide \(shown)"))"
    }

    /// The arrows move the highlight a word at a time, or a line with ↑ and ↓; with ⇧ they extend it.
    func moveSelection(forward: Bool, byLine: Bool, extending: Bool) {
        guard !showingText else { text.moveSelection(forward: forward, byLine: byLine, extending: extending); return }
        let words = canvas.words
        guard !words.isEmpty else { return }
        let from = head ?? (forward ? -1 : words.count)
        let to: Int
        if byLine, words.indices.contains(from) {
            let line = words[from].line + (forward ? 1 : -1)
            let x = words[from].box.midX
            to = words.indices.filter { words[$0].line == line }
                .min { abs(words[$0].box.midX - x) < abs(words[$1].box.midX - x) } ?? from
        } else {
            to = min(max(0, from + (forward ? 1 : -1)), words.count - 1)
        }
        head = to
        if !extending || anchor == nil { anchor = to }
        let start = anchor ?? to
        setSelection(min(start, to)...max(start, to), notify: true)
    }

    func stop() { request?.cancel() }
}
