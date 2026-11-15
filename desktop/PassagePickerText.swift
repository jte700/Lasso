// The text side of the passage picker: a text view that selects by mouse
// in a panel that never takes the keyboard, and the document laid out as its
// kind looks — a transcript, a deck's outline, a Word page, rendered
// Markdown or a plain text file — while keeping the server's text exactly,
// so what is highlighted maps back to it character for character.

import Cocoa

/// What every picker body offers the window around it.
protocol PassagePickerBody: AnyObject {
    var view: NSView { get }
    var onSelectionChange: (() -> Void)? { get set }
    /// The highlighted words, with their citation when `citing`.
    func pick(citing: Bool) -> PassagePick?
    func citation() -> String?
    func moveSelection(forward: Bool, byLine: Bool, extending: Bool)
    /// Whether the highlight is still the one the picker opened on.
    var isOpeningSelection: Bool { get }
    /// The picker is closing: a player stops.
    func stop()
}

/// Takes mouse drags while its panel never takes the keyboard, so the
/// writer's app keeps its caret. The selection shows in the folder's colour.
final class PassagePickerTextView: NSTextView {
    var onSelectionChange: (() -> Void)?
    /// The folder's colour, light enough to read the words through, as the card marks its words.
    var highlight = NSColor.controlAccentColor.withAlphaComponent(0.35)

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The panel never becomes key, where NSTextView's own drag does not
    /// select, so the drag is followed here: a drag selects characters, a
    /// double click words and a triple click lines, and ⇧ extends what is
    /// already selected. A drag past the edge scrolls.
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        let granularity: NSSelectionGranularity = event.clickCount >= 3 ? .selectByParagraph
            : event.clickCount == 2 ? .selectByWord : .selectByCharacter
        let current = selectedRange()
        let pressed = characterIndex(at: event)
        let anchor = event.modifierFlags.contains(.shift) && current.length > 0
            ? (pressed < current.location ? NSMaxRange(current) : current.location) : pressed
        select(from: anchor, to: pressed, granularity: granularity)
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            autoscroll(with: next)
            select(from: anchor, to: characterIndex(at: next), granularity: granularity)
        }
    }

    private func characterIndex(at event: NSEvent) -> Int {
        let point = convert(event.locationInWindow, from: nil)
        return min(characterIndexForInsertion(at: point), (string as NSString).length)
    }

    private func select(from anchor: Int, to index: Int, granularity: NSSelectionGranularity) {
        let span = NSRange(location: min(anchor, index), length: abs(index - anchor))
        setSelectedRange(granularity == .selectByCharacter ? span : selectionRange(forProposedRange: span, granularity: granularity))
    }

    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
        onSelectionChange?()
    }
}

/// Draws the selection in the folder's colour. A panel that is never key
/// would otherwise draw it in the grey of an inactive window, which reads as
/// disabled and in Markdown looks like a code span.
final class PassageLayoutManager: NSLayoutManager {
    private static let selectionColors: Set<String> = [
        "selectedTextBackgroundColor", "unemphasizedSelectedTextBackgroundColor",
        "secondarySelectedControlColor", "selectedContentBackgroundColor", "unemphasizedSelectedContentBackgroundColor",
    ]

    override func fillBackgroundRectArray(_ rectArray: UnsafePointer<NSRect>, count rectCount: Int,
                                          forCharacterRange charRange: NSRange, color: NSColor) {
        let selection = color.type == .catalog && Self.selectionColors.contains(color.colorNameComponent)
        let fill = selection ? (firstTextView as? PassagePickerTextView)?.highlight ?? color : color
        fill.setFill()
        super.fillBackgroundRectArray(rectArray, count: rectCount, forCharacterRange: charRange, color: fill)
    }
}

/// How a text document is laid out in the picker.
enum PassageTextLook {
    case transcript, slides, page, markdown, plain

    init(_ document: PassageDocument) {
        switch document.kind {
        case "video": self = .transcript
        case "slides": self = .slides
        case "word": self = .page
        default:
            let ext = (document.name as NSString).pathExtension.lowercased()
            self = ["md", "markdown"].contains(ext) ? .markdown : .plain
        }
    }
}

/// A document's text to highlight from, laid out as its kind looks.
final class PassageTextBody: NSView, PassagePickerBody {
    let document: PassageDocument
    let look: PassageTextLook
    let textView = PassagePickerTextView(frame: .zero)
    private let scroll = NSScrollView()
    private var openingSelection: NSRange?
    var onSelectionChange: (() -> Void)?
    var view: NSView { self }
    override var isFlipped: Bool { true }

    init(document: PassageDocument, highlight: NSColor) {
        self.document = document
        look = PassageTextLook(document)
        super.init(frame: .zero)
        textView.highlight = highlight
        textView.textContainer?.replaceLayoutManager(PassageLayoutManager())
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.selectedTextAttributes = [.backgroundColor: highlight]
        textView.onSelectionChange = { [weak self] in self?.onSelectionChange?() }
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        // A transcript or a deck's text sits on the glass. A text, Word or Markdown
        // file is read on the system's own background, white or dark, in a well of its own.
        if solid {
            wantsLayer = true
            layer?.cornerRadius = 10
            layer?.masksToBounds = true
            layer?.borderWidth = 0.5
        }
        textView.drawsBackground = false
        textView.textContainerInset = solid ? NSSize(width: 14, height: 12) : NSSize(width: 6, height: 10)
        textView.autoresizingMask = [.width]
        scroll.drawsBackground = false
        scroll.documentView = textView
        addSubview(scroll)
        textView.textStorage?.setAttributedString(PassageTextStyling.styled(document, look: look))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The document's own well, rather than glass: text, Word and Markdown files.
    private var solid: Bool { look == .page || look == .markdown || look == .plain }

    override var wantsUpdateLayer: Bool { solid }

    /// Read again when the system switches between light and dark.
    override func updateLayer() {
        guard solid else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }

    override func layout() {
        super.layout()
        scroll.frame = bounds
        textView.frame.size.width = scroll.contentSize.width
    }

    /// Highlights `range` and brings it to the middle of the view.
    func select(_ range: NSRange?) {
        layoutSubtreeIfNeeded()
        let opening = range ?? NSRange(location: 0, length: 0)
        openingSelection = opening
        textView.setSelectedRange(opening)
        scrollToMiddle(opening)
    }

    func scrollToMiddle(_ range: NSRange) {
        guard let layoutManager = textView.layoutManager, let container = textView.textContainer else { return }
        layoutManager.ensureLayout(for: container)
        let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layoutManager.boundingRect(forGlyphRange: glyphs, in: container)
        let inView = textView.convert(NSPoint(x: 0, y: rect.midY + textView.textContainerOrigin.y), to: scroll.documentView)
        let target = max(0, inView.y - scroll.contentSize.height / 2)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: target))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    /// Puts `index` at the top of the view, as turning to a slide does.
    func scrollToTop(_ index: Int) {
        guard let layoutManager = textView.layoutManager, let container = textView.textContainer else { return }
        layoutManager.ensureLayout(for: container)
        let glyphs = layoutManager.glyphRange(forCharacterRange: NSRange(location: index, length: 0), actualCharacterRange: nil)
        let rect = layoutManager.boundingRect(forGlyphRange: glyphs, in: container)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, rect.minY)))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    var selectedRange: NSRange { textView.selectedRange() }
    var isOpeningSelection: Bool { openingSelection.map { NSEqualRanges($0, textView.selectedRange()) } ?? false }

    func pick(citing: Bool) -> PassagePick? {
        guard document.unavailable == nil else { return nil }
        let selected = textView.selectedRange()
        let body = document.insertedText(selected)
        guard !body.isEmpty else { return nil }
        return PassagePick(body: body, citation: citing ? document.citation(for: selected) : nil,
                           quoted: document.kind == "video", videoTime: document.time(of: selected))
    }

    func citation() -> String? {
        pick(citing: true)?.citation
    }

    func moveSelection(forward: Bool, byLine: Bool, extending: Bool) {
        switch (forward, byLine, extending) {
        case (true, false, true): textView.moveWordRightAndModifySelection(nil)
        case (false, false, true): textView.moveWordLeftAndModifySelection(nil)
        case (true, true, true): textView.moveDownAndModifySelection(nil)
        case (false, true, true): textView.moveUpAndModifySelection(nil)
        case (true, false, false): textView.moveWordRight(nil)
        case (false, false, false): textView.moveWordLeft(nil)
        case (true, true, false): textView.moveDown(nil)
        case (false, true, false): textView.moveUp(nil)
        }
        textView.scrollRangeToVisible(textView.selectedRange())
    }

    func stop() {}
}
