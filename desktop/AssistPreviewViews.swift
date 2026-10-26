import Cocoa
import PDFKit

/// The suggestion card's preview of a text, code, Markdown, Word or slide
/// source: the whole excerpt the server sent, which the person scrolls and
/// selects in. It opens with the cited passage in view and the context above
/// it, and code scrolls sideways instead of wrapping.
final class AssistTextPreviewView: AssistSlimScrollView {
    /// Insets of the text, as the card drew it before it scrolled.
    private static let inset = NSSize(width: 10, height: 9)
    /// At most this share of the view is context above the cited passage.
    private static let contextShare: CGFloat = 0.35

    private let textView: AssistPreviewTextView
    private var showsCitation = true

    init(blocks: [AssistTextBlock], accent: NSColor, wraps: Bool, baseSize: CGFloat = 10.5) {
        // TextKit 1, whose line fragments the highlights are drawn behind.
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: wraps ? 0 : CGFloat.greatestFiniteMagnitude,
                                                     height: .greatestFiniteMagnitude))
        container.widthTracksTextView = wraps
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        textView = AssistPreviewTextView(frame: .zero, textContainer: container)
        super.init(vertical: true, horizontal: !wraps)

        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.drawsBackground = false
        textView.textContainerInset = Self.inset
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = !wraps
        textView.autoresizingMask = wraps ? [.width] : []
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        textView.accent = accent

        // In the scroll view before it has text, so it grows down from the top.
        documentView = textView
        let content = AssistPreviewText(blocks: blocks, baseSize: baseSize)
        storage.setAttributedString(content.text)
        textView.decorations = content.decorations
        textView.setSelectedRange(NSRange(location: 0, length: 0))
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func tile() {
        super.tile()
        textView.minSize = NSSize(width: contentSize.width, height: contentSize.height)
        if !textView.isHorizontallyResizable { textView.setFrameSize(NSSize(width: contentSize.width, height: textView.frame.height)) }
        guard showsCitation, contentSize.height > 0 else { return }
        showsCitation = false
        scrollToCitation()
    }

    /// Puts the first cited passage in view, with as much of the text before
    /// it as fits in the top third of the view, starting at a whole line.
    private func scrollToCitation() {
        guard let layout = textView.layoutManager, let container = textView.textContainer else { return }
        layout.ensureLayout(for: container)
        textView.sizeToFit()
        guard let cited = textView.citedFrame() else { return }
        var target = max(0, cited.minY - contentSize.height * Self.contextShare)
        let glyph = layout.glyphIndex(for: NSPoint(x: 0, y: max(0, target - textView.textContainerOrigin.y)), in: container)
        if glyph < layout.numberOfGlyphs {
            target = min(target, layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY)
        }
        let limit = max(0, textView.frame.height - contentSize.height)
        contentView.scroll(to: NSPoint(x: 0, y: min(max(0, target), limit)))
        reflectScrolledClipView(contentView)
    }
}

/// The text of a preview's blocks, with the ranges drawn behind it: cited
/// passages in the source's colour, code blocks, quotes and rules.
struct AssistPreviewText {
    let text: NSAttributedString
    let decorations: [AssistPreviewTextView.Decoration]

    init(blocks: [AssistTextBlock], baseSize: CGFloat) {
        let result = NSMutableAttributedString()
        var decorations: [AssistPreviewTextView.Decoration] = []
        for (index, block) in blocks.enumerated() {
            if index > 0, result.length > 0 {
                result.append(NSAttributedString(string: "\n", attributes: result.attributes(at: result.length - 1, effectiveRange: nil)))
            }
            let piece = NSMutableAttributedString(attributedString: AssistMarkdown.attributed(block, baseSize: baseSize))
            let gap = AssistMarkdown.spacing(before: block, after: index > 0 ? blocks[index - 1] : nil)
            Self.space(piece, before: gap)
            let range = NSRange(location: result.length, length: piece.length)
            result.append(piece)
            if block.cited { decorations.append(.init(kind: .cited(line: block.type == "line"), range: range)) }
            switch block.type {
            case "code": decorations.append(.init(kind: .code, range: range))
            case "quote": decorations.append(.init(kind: .quote, range: range))
            case "rule": decorations.append(.init(kind: .rule, range: range))
            default: break
            }
        }
        text = result
        self.decorations = decorations
    }

    /// Space above a block's first paragraph, as between blocks drawn one by one.
    private static func space(_ piece: NSMutableAttributedString, before gap: CGFloat) {
        guard gap > 0, piece.length > 0 else { return }
        let first = (piece.string as NSString).paragraphRange(for: NSRange(location: 0, length: 0))
        let current = piece.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle ?? .default
        guard let style = current.mutableCopy() as? NSMutableParagraphStyle else { return }
        style.paragraphSpacingBefore = gap
        piece.addAttribute(.paragraphStyle, value: style, range: first)
    }
}

/// Text that can be selected but not edited, with the cited passages and
/// Markdown blocks marked behind it as the card always drew them.
final class AssistPreviewTextView: NSTextView {
    struct Decoration {
        enum Kind { case cited(line: Bool), code, quote, rule }
        let kind: Kind
        let range: NSRange
    }

    var decorations: [Decoration] = []
    var accent: NSColor = .controlAccentColor

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The first cited passage, in this view's coordinates.
    func citedFrame() -> NSRect? {
        guard let cited = decorations.first(where: { if case .cited = $0.kind { return true } else { return false } })
        else { return nil }
        return frame(of: cited.range)
    }

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        for decoration in decorations {
            guard let frame = frame(of: decoration.range), frame.intersects(rect.insetBy(dx: -8, dy: -8)) else { continue }
            switch decoration.kind {
            case .cited(let line):
                let highlight = frame.insetBy(dx: -5, dy: line ? 0 : -2.5)
                accent.withAlphaComponent(0.14).setFill()
                NSBezierPath(roundedRect: highlight, xRadius: 4, yRadius: 4).fill()
                accent.setFill()
                NSRect(x: highlight.minX, y: highlight.minY, width: 2.5, height: highlight.height).fill()
            case .code:
                NSColor.quaternaryLabelColor.withAlphaComponent(0.18).setFill()
                NSBezierPath(roundedRect: frame.insetBy(dx: -4, dy: -3), xRadius: 4, yRadius: 4).fill()
            case .quote:
                NSColor.tertiaryLabelColor.setFill()
                NSRect(x: frame.minX, y: frame.minY, width: 2.5, height: frame.height).fill()
            case .rule:
                NSColor.separatorColor.setFill()
                NSRect(x: frame.minX, y: frame.midY, width: frame.width, height: 1).fill()
            }
        }
    }

    /// The lines a range of characters is laid out on, as wide as the text:
    /// the view's width, or a long code line's.
    private func frame(of range: NSRange) -> NSRect? {
        guard let layout = layoutManager, let container = textContainer, range.length > 0 else { return nil }
        let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var lines = NSRect.null
        layout.enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, _ in lines = lines.union(used) }
        guard !lines.isNull else { return nil }
        let origin = textContainerOrigin
        let width = max(bounds.width - 2 * textContainerInset.width, layout.usedRect(for: container).width)
        return NSRect(x: origin.x, y: lines.minY + origin.y, width: width, height: lines.height)
    }
}

/// The cited PDF page in PDFKit, which scrolls through the document and lets
/// the person select its text. It opens on the part the card shows, the
/// citation highlighted, at a scale where that part fills the width.
final class AssistPDFPreviewView: PDFView {
    private let citation: AssistPDFPageImage
    private var showsCitation = true

    /// Nil when the page came without its document. Checked before the view
    /// is made: PDFKit crashes freeing a PDFView whose init gave up early.
    static func showing(_ page: AssistPDFPageImage) -> AssistPDFPreviewView? {
        guard let document = page.document, document.pageCount > 0 else { return nil }
        return AssistPDFPreviewView(page: page, document: document)
    }

    private init(page: AssistPDFPageImage, document: PDFDocument) {
        citation = page
        super.init(frame: .zero)
        self.document = document
        displayMode = .singlePageContinuous
        displaysPageBreaks = true
        autoScales = false
        backgroundColor = .clear
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func layout() {
        super.layout()
        guard showsCitation, bounds.width > 0, let document,
              let page = document.page(at: min(max(0, citation.pageNumber - 1), document.pageCount - 1)) else { return }
        showsCitation = false
        let scroll = documentView?.enclosingScrollView
        useSlimScrollers(in: scroll)
        let box = page.bounds(for: .cropBox)
        let shown = citation.focus ?? box
        guard shown.width > 0 else { return }
        scaleFactor = (scroll?.contentSize.width ?? bounds.width) / shown.width
        go(to: PDFDestination(page: page, at: NSPoint(x: shown.minX, y: shown.maxY)))
    }

    /// The suggestion list's slim scrollers, so the PDF scrolls as the rest of the card does.
    private func useSlimScrollers(in scroll: NSScrollView?) {
        guard let scroll, !(scroll.verticalScroller is AssistListScroller) else { return }
        scroll.verticalScroller = AssistListScroller()
        scroll.horizontalScroller = AssistListScroller()
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .legacy
        scroll.tile()
    }
}

/// A table preview's rows, which scroll under its fixed header as the
/// suggestion list does. The card draws them, so they match the header.
final class AssistTableRowsView: AssistSlimScrollView {
    let rows = AssistDrawnView()
    private var opened = false

    init() {
        super.init(vertical: true)
        documentView = rows
        // The header above keeps the table's top corners; these are its bottom ones.
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Fits the rows to `contentHeight` and, once the view has a size, opens
    /// them `offset` down: around the cited cell, or at a column's first row.
    func fit(contentHeight: CGFloat, opening offset: CGFloat) {
        // The scroller shows or hides with the rows' height, which changes their width.
        rows.setFrameSize(NSSize(width: contentSize.width, height: contentHeight))
        tile()
        rows.setFrameSize(NSSize(width: contentSize.width, height: contentHeight))
        guard !opened, contentSize.height > 0 else { return }
        opened = true
        contentView.scroll(to: NSPoint(x: 0, y: offset))
        reflectScrolledClipView(contentView)
    }
}
