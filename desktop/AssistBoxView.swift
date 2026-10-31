// The suggestion card: its panel material, state, layout and the scrolling suggestion list.
// Drawing is in AssistBoxView+Drawing.swift, the document preview in AssistBoxView+Preview.swift
// and mouse input in AssistBoxView+Input.swift.

import Cocoa

/// Material backing for the reference popover shape. The blur is split into a
/// rounded body and a small caret pointer so the panel remains genuinely
/// translucent instead of painting an opaque triangle over the host app.
final class AssistBubbleContainer: NSView {
    private let bodyEffect: NSView
    private let pointerEffect = NSVisualEffectView()
    private let overlay: AssistBoxView

    init(content: AssistBoxView) {
        overlay = content
        bodyEffect = NativeMaterial.glassContainer(content: NSView(frame: content.frame),
                                                    cornerRadius: content.bubbleCornerRadius)
        super.init(frame: content.frame)
        wantsLayer = true

        addSubview(bodyEffect)
        for effect in [pointerEffect] {
            effect.material = .popover
            effect.blendingMode = .behindWindow
            effect.state = .active
            effect.wantsLayer = true
            addSubview(effect)
        }
        bodyEffect.layer?.cornerRadius = content.bubbleCornerRadius
        bodyEffect.layer?.masksToBounds = true

        // The card always fills the panel. Callers size the panel, never the card.
        content.frame = bounds
        content.autoresizingMask = [.width, .height]
        addSubview(content)
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        let pointerHeight = overlay.pointerHeight
        let bodyHeight = max(0, bounds.height - pointerHeight)
        bodyEffect.frame = overlay.pointerAtTop
            ? NSRect(x: 0, y: 0, width: bounds.width, height: bodyHeight)
            : NSRect(x: 0, y: pointerHeight, width: bounds.width, height: bodyHeight)

        let width = overlay.pointerWidth
        pointerEffect.frame = NSRect(
            x: min(max(overlay.pointerX - width / 2, 0), max(0, bounds.width - width)),
            y: overlay.pointerAtTop ? bodyHeight : 0,
            width: width,
            height: pointerHeight)
        let mask = CAShapeLayer()
        let path = CGMutablePath()
        if overlay.pointerAtTop {
            path.move(to: CGPoint(x: 0, y: 0))
            path.addLine(to: CGPoint(x: width, y: 0))
            path.addLine(to: CGPoint(x: width / 2, y: pointerHeight))
        } else {
            path.move(to: CGPoint(x: 0, y: pointerHeight))
            path.addLine(to: CGPoint(x: width, y: pointerHeight))
            path.addLine(to: CGPoint(x: width / 2, y: 0))
        }
        path.closeSubpath()
        mask.path = path
        pointerEffect.layer?.mask = mask
    }
}

/// Compact, caret-anchored project suggestions in the density and hierarchy of
/// a native Spotlight or password-manager result panel.
final class AssistBoxView: NSView {
    enum Mode { case suggestions, confirmShare, message }
    var mode: Mode = .suggestions {
        didSet {
            guard mode != oldValue else { return }
            needsLayout = true
            if mode == .suggestions { revealSelectedSuggestion(animated: false) }
            updatePreviewContent()
        }
    }
    var suggestions: [AssistSuggestion] = [] {
        didSet {
            sizeSuggestionRows()
            // A shorter list cannot stay scrolled past its end.
            listOffset = min(max(0, listOffset), listGeometry.maximumOffset)
            revealSelectedSuggestion(animated: false)
        }
    }
    var selected: Int = 0 {
        didSet {
            // The highlight is drawn in the rows' own view, which a glide only
            // paints where it brings rows into view.
            suggestionRows.needsDisplay = true
            revealSelectedSuggestion(animated: true)
        }
    }
    let visibleSuggestionCount = 4
    /// Where the list is scrolled to, or gliding to.
    private var listOffset: CGFloat = 0
    /// How long the list takes to glide to a highlighted row out of view.
    private static let listGlideDuration: TimeInterval = 0.22
    /// The rows scroll under the header, beside a slim scroller.
    let suggestionList = AssistSuggestionScrollView()
    let suggestionRows = AssistDrawnView()
    var title: String = "Dependency"
    var confirmChoices: [String] = []
    var messageLines: [String] = []
    var sourceScoped = false
    /// The latest focus, named in the header when fn+Right can take an
    /// unfocused card back into it and no highlighted row has values below it.
    var returnFocusName: String?
    /// The focus fn+Left steps a focused card back to, named in its header;
    /// nil when it steps back to every directory.
    var stepBackName: String?
    var preview: AssistDocumentPreview? {
        didSet {
            modelView = AssistModelView(); modelDrag = nil; tableGeometryCache = nil
            previewGeneration += 1
            updatePreviewContent()
        }
    }
    var isPreviewLoading = false {
        didSet { if isPreviewLoading != oldValue { updatePreviewContent() } }
    }
    var previewError: String?
    /// How a rotatable model preview is turned and zoomed; each new preview starts as sent.
    var modelView = AssistModelView()
    var modelDrag: (start: NSPoint, view: AssistModelView)?
    /// A table preview's layout with every row sent, for the place it was worked out for.
    var tableGeometryCache: (rect: NSRect, geometry: TableGeometry)?
    /// A text, table or PDF preview the person scrolls, over the preview's
    /// place in the card; nil for previews the card draws itself.
    var previewContent: NSView?
    var previewGeneration = 0
    var shownPreviewGeneration: Int?
    /// The matched words the preview in view marks; new ones redraw it.
    var shownMatchedWords: [String] = []
    var onSelectRow: ((Int) -> Void)?
    var onInsert: (() -> Void)?
    var onLocalLink: (() -> Void)?
    var onShare: (() -> Void)?
    var onOpenSource: (() -> Void)?
    var onAllSources: (() -> Void)?
    var onStepBack: (() -> Void)?
    var onDismiss: (() -> Void)?
    let closeButton = NSButton()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Dismiss suggestions")
        closeButton.bezelStyle = .circular
        closeButton.isBordered = false
        closeButton.imagePosition = .imageOnly
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.toolTip = "Dismiss suggestions (Esc)"
        closeButton.setAccessibilityLabel("Dismiss suggestions")
        closeButton.target = self
        closeButton.action = #selector(dismissSuggestions)
        addSubview(closeButton)

        suggestionRows.drawContent = { [unowned self] dirty in self.drawSuggestionRows(in: dirty) }
        suggestionRows.onClick = { [unowned self] point in
            let index = Int(point.y / self.suggestionHeight)
            if self.mode == .suggestions, point.y >= 0, self.suggestions.indices.contains(index) { self.onSelectRow?(index) }
        }
        suggestionList.documentView = suggestionRows
        addSubview(suggestionList)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        closeButton.frame = NSRect(x: bounds.width - 34, y: bodyTop + 6, width: 24, height: 24)
        suggestionList.isHidden = mode != .suggestions
        let listFrame = NSRect(x: 0, y: bodyTop + navigationHeight, width: leftWidth, height: listHeight)
        if suggestionList.frame != listFrame {
            suggestionList.frame = listFrame
            sizeSuggestionRows()
        }
        placePreviewContent()
    }

    /// The suggestion and table rows draw with the rest of the card. The card
    /// is layer-backed, so `needsDisplay` reads false straight after it is
    /// set: the request is passed on as it is made, not read back.
    override var needsDisplay: Bool {
        get { super.needsDisplay }
        set {
            super.needsDisplay = newValue
            guard newValue else { return }
            suggestionRows.needsDisplay = true
            (previewContent as? AssistTableRowsView)?.rows.needsDisplay = true
        }
    }

    @objc private func dismissSuggestions() { onDismiss?() }

    private let panelWidth: CGFloat = 760
    let leftWidth: CGFloat = 366
    let headerHeight: CGFloat = 31
    let suggestionHeight: CGFloat = 72
    var suggestionRowHeight: CGFloat { suggestionHeight }
    let choiceHeight: CGFloat = 34
    let messageHeight: CGFloat = 22
    private let footerHeight: CGFloat = 55
    let pointerHeight: CGFloat = 12
    fileprivate let pointerWidth: CGFloat = 21
    let bubbleCornerRadius: CGFloat = 18
    // The host tracker reassigns these ten times a second while the box is
    // open. Only a real change may relayout and redraw the panel.
    var pointerX: CGFloat = 84 {
        didSet {
            guard pointerX != oldValue else { return }
            superview?.needsLayout = true; needsDisplay = true
        }
    }
    var pointerAtTop = true {
        didSet {
            guard pointerAtTop != oldValue else { return }
            superview?.needsLayout = true; needsLayout = true; needsDisplay = true
        }
    }
    private let suggestionBodyHeight: CGFloat = 384
    let navigationHeight: CGFloat = 32
    /// Left edges of the footer slots; a click belongs to the slot it falls in.
    let footerSlots: [CGFloat] = [18, 108, 237]

    private var bodyRows: Int {
        switch mode {
        case .suggestions: return max(1, suggestions.count)
        case .confirmShare: return max(1, confirmChoices.count)
        case .message: return max(1, messageLines.count)
        }
    }

    private var rowHeight: CGFloat {
        switch mode {
        case .suggestions: return suggestionHeight
        case .confirmShare: return choiceHeight
        case .message: return messageHeight
        }
    }

    private var bodyHeight: CGFloat {
        if mode == .suggestions { return suggestionBodyHeight }
        let footer = mode == .message ? CGFloat(8) : footerHeight
        return headerHeight + rowHeight * CGFloat(bodyRows) + footer
    }

    var bodyTop: CGFloat { pointerAtTop ? pointerHeight : 0 }
    var bodyRect: NSRect {
        NSRect(x: 0, y: bodyTop, width: bounds.width, height: bodyHeight)
    }
    var footerY: CGFloat { bodyTop + bodyHeight - footerHeight }

    /// The list's height between the header and the footer: four rows.
    private var listHeight: CGFloat { suggestionBodyHeight - navigationHeight - footerHeight }
    /// Space under the last row, so its highlight clears the footer line.
    let listBottomPadding: CGFloat = 9
    /// Space between the rows and the list's scroller, while it shows.
    let scrollerGap: CGFloat = 8

    private var listGeometry: AssistSuggestionListGeometry {
        AssistSuggestionListGeometry(rowCount: suggestions.count, rowHeight: suggestionHeight,
                                     surfaceTop: 13, surfaceHeight: 63, bottomPadding: listBottomPadding,
                                     visibleHeight: listHeight)
    }

    /// The rows wholly in view once the list stops where it is going.
    var visibleSuggestionRange: Range<Int> { listGeometry.rowsInView(at: listOffset) }

    private func sizeSuggestionRows() {
        let height = listGeometry.contentHeight
        suggestionRows.setFrameSize(NSSize(width: suggestionList.contentSize.width, height: height))
        // The scroller shows or hides with the list's length, which changes the width the rows have.
        suggestionList.tile()
        suggestionRows.setFrameSize(NSSize(width: suggestionList.contentSize.width, height: height))
        suggestionRows.needsDisplay = true
    }

    /// Scrolls the highlighted row into view, gliding when `animated`.
    private func revealSelectedSuggestion(animated: Bool) {
        guard mode == .suggestions else { return }
        let selection = min(max(0, selected), max(0, suggestions.count - 1))
        scrollList(to: listGeometry.offset(revealing: selection, from: listOffset), animated: animated)
    }

    private func scrollList(to offset: CGFloat, animated: Bool) {
        let changed = offset != listOffset
        listOffset = offset
        let origin = NSPoint(x: 0, y: offset)
        // Already gliding there.
        if animated && !changed { return }
        guard suggestionList.contentView.bounds.origin != origin || suggestionList.isGliding else { return }
        // One move glides. A move during a glide, as a held arrow key makes,
        // goes at once so the list keeps up with the highlight; so does a
        // hidden list, or one being measured.
        let glides = animated && !suggestionList.isGliding && window?.isVisible == true
            && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        suggestionList.scroll(to: origin, glideDuration: glides ? Self.listGlideDuration : nil)
    }

    var boxSize: NSSize {
        let width = mode == .suggestions ? panelWidth : leftWidth
        return NSSize(width: width, height: bodyHeight + pointerHeight)
    }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
