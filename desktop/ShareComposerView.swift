// The share composer's view: its state, scopes, copy confirmation and the access it offers.

import Cocoa
import PDFKit
import CoreImage

final class ShareComposerView: NSView {
    enum CopyState { case idle, copying, copied }
    var copyState: CopyState = .idle
    var isCopying: Bool { copyState == .copying }
    var actionTitle = "Copy link"
    /// Native selection colour for the composer's own controls.
    var accentColor: NSColor { .controlAccentColor }
    /// The cited passage is marked as on the suggestion card, in the source folder's colour.
    var highlightColor: NSColor = .systemGreen {
        didSet {
            needsDisplay = true
            previewCanvas.needsDisplay = true
        }
    }
    var localOnly = true
    var scope: ShareAccessScope = .indexed {
        didSet {
            if scope != oldValue {
                pdfView.cancelInteraction()
                redactionDrag = nil
                drawingDrag = nil
                // Each scope shows its own model, which starts as sent.
                modelView = AssistModelView()
                modelDrag = nil
                targets.removeAll()
                markup.cancel()
                clearCopyConfirmation()
                if scope == .marked && markupDocument == nil && !isMarkupPagesLoading { onNeedsMarkupPages?() }
            }
        }
    }
    var preview: AssistDocumentPreview? { didSet { previewRevision += 1; targets.removeAll() } }
    /// What "Cited part only" publishes for a 3D CAD model: the cited part
    /// alone, its feature marked. Nil when the citation names no single part.
    var citedPart: AssistModelPreview?
    var fullDocument: ShareFullDocument? { didSet { previewRevision += 1; targets.removeAll() } }
    var isLoading = true
    var isDocumentLoading = true
    var isPDFLoading = false
    var loadedPDFDocument: PDFDocument?
    var onReviewPDFExcerpt: ((SharePDFExcerpt) -> Void)?
    var reviewedPDFDocument: PDFDocument?
    var isPDFExcerptLoading = false
    var pdfExcerptError: String?
    /// A deck's slides as pictures: every slide, for the whole deck and its
    /// mark-up, and the cited slide alone. Their slide menu sits above them.
    private(set) var slideDecks: (all: SlideDeckDocument, cited: SlideDeckDocument?)?
    var slideNavigator: SlideDeckNavigator?
    var showsSlideMenu = false
    /// A Word document's or deck's pages to mark up, laid out by Lasso's server; a PDF is marked on its own pages.
    var markupPages: PDFDocument?
    var isMarkupPagesLoading = false
    var markupPagesError: String?
    var onNeedsMarkupPages: (() -> Void)?
    var onCancel: (() -> Void)?
    var onCreate: ((ShareConfiguration) -> Void)?

    var label = ""
    var filename = ""
    var effect: ShareRedactionEffect = .blur
    var masks: [String: ShareRedaction] = [:] {
        didSet { if masks != oldValue { clearCopyConfirmation() } }
    }
    var history = ShareMaskHistory()
    /// Each passage or area chosen as a PDF's cited part, for ⌘Z.
    var excerptHistory = ShareEditHistory<SharePDFExcerpt?>()
    var markup = ShareMarkupSession() {
        didSet {
            pdfView.draftMark = markup.draft
            if markup.marks != oldValue.marks { clearCopyConfirmation() }
        }
    }
    /// The masks when the drag or click being made began.
    var gestureMasks: [String: ShareRedaction]?
    var targets: [ShareHitTarget] = []
    var sheetTabTargets: [(rect: NSRect, index: Int)] = []
    var sheetIndex = 0
    var previewRevision = 0
    var scrollLayoutKey = ""
    var scrollRows: [[String]] = []
    var scrollColumns: [String] = []
    var scrollRowNumbers: [String] = []
    var scrollHeaders: [String]?
    var scrollCitations = Set<String>()
    var scrollBlocks: [String] = []
    var scrollStyles: [AssistTextBlock] = []
    var scrollStyledText: [NSAttributedString] = []
    var scrollColumnWidths: [CGFloat] = []
    var scrollRowHeights: [CGFloat] = []
    var scrollBlockHeights: [CGFloat] = []
    var scrollLines = false
    var scrollBlockGap: CGFloat { scrollLines ? 2 : 8 }
    var scrollRedactionSheet: Int?
    var scrollCanRedact = false
    var showsScrollablePreview = false
    var showsPDFPreview = false
    var pdfSelectionMode: ShareInteractivePDFView.SelectionMode = .text {
        didSet { if oldValue != pdfSelectionMode { pdfView.cancelInteraction() } }
    }
    var pdfExcerpt: SharePDFExcerpt?
    var isChoosingPDFExcerpt = true
    var initializedPDFExcerpt = false
    var pdfMaskLayoutKey = ""
    var pdfSourceDestination: PDFDestination?
    lazy var pdfView: ShareInteractivePDFView = {
        let view = ShareInteractivePDFView(frame: .zero)
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displaysPageBreaks = true
        view.backgroundColor = .underPageBackgroundColor
        view.setAccessibilityLabel("PDF page preview")
        view.isHidden = true
        view.onTextSelection = { [weak self] in self?.selectPDFText($0) }
        view.onAreaSelection = { [weak self] in self?.selectPDFArea(page: $0, rect: $1) }
        view.onMaskClick = { [weak self] in self?.removePDFMask(page: $0, point: $1) ?? false }
        view.onMarkBegin = { [weak self] in self?.beginMark(page: $0, at: $1) }
        view.onMarkMove = { [weak self] in self?.moveMark(page: $0, to: $1) }
        view.onMarkEnd = { [weak self] in self?.endMark() }
        addSubview(view)
        return view
    }()
    let scrollFont = NSFont.systemFont(ofSize: 11)
    let scrollLineFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    lazy var previewCanvas: SharePreviewCanvas = {
        let canvas = SharePreviewCanvas(frame: .zero)
        canvas.composer = self
        return canvas
    }()
    lazy var previewScroll: NSScrollView = {
        let scroll = NSScrollView(frame: .zero)
        scroll.borderType = .noBorder
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 7
        scroll.layer?.masksToBounds = true
        scroll.layer?.borderWidth = 1
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = false
        scroll.scrollerStyle = .legacy
        scroll.documentView = previewCanvas
        scroll.isHidden = true
        addSubview(scroll)
        return scroll
    }()
    var redactionDrag: ShareRedactionDrag?
    var drawingLayout: ShareDrawingLayout?
    var drawingDrag: (start: NSPoint, masks: [String: ShareRedaction], effect: ShareRedactionEffect)?
    /// A STEP model turns and zooms here as it does in the card and the inspector.
    var modelView = AssistModelView()
    var modelDrag: (start: NSPoint, view: AssistModelView)?
    /// The rotatable model drawn last, and where.
    var shownModel: (model: AssistModelPreview, rect: NSRect)?
    var notice: String?

    let headerHeight: CGFloat = 42
    let footerHeight: CGFloat = 68
    // The server ends every share link 48 hours after it is created.
    static let linkLifetimeNote = "Link expires in 48 hours."
    static let blurContext = CIContext(options: [.cacheIntermediates: false])
    var blurredMasks: [String: NSImage] = [:]

    var actionButtonRect: NSRect {
        NSRect(x: bounds.width - 132, y: bounds.height - footerHeight / 2 - 18, width: 116, height: 36)
    }

    var cancelButtonRect: NSRect {
        NSRect(x: actionButtonRect.minX - 92, y: actionButtonRect.minY, width: 84, height: 36)
    }

    var isPDFSource: Bool { (filename as NSString).pathExtension.lowercased() == "pdf" || fullDocument?.kind == "pdf" }
    private var sourceKind: ShareSourceKind { ShareSourceKind(filename: filename) }
    var isCADModel: Bool { sourceKind == .cadModel }
    var isPresentation: Bool { sourceKind == .presentation }
    /// The pages a marked copy is drawn on: a deck's are its slides' pictures.
    var markupDocument: PDFDocument? {
        isPDFSource ? loadedPDFDocument : slideDecks?.all.document ?? markupPages
    }

    /// Shows a deck's slides as pictures from `source`, once the preview has named them.
    func showSlides(from source: SlidePictureSource) {
        guard slideDecks == nil, isPresentation, let deck = preview?.deck else { return }
        slideDecks = (all: SlideDeckDocument(deck: deck, source: source),
                      cited: preview?.slideNumber.map { SlideDeckDocument(deck: deck, source: source, only: [$0]) })
        needsDisplay = true
    }

    /// The scopes this source offers. A model's cited part, or a deck's cited
    /// slide, is offered while its preview loads, so the protective choice
    /// stays selected meanwhile.
    var scopes: [ShareAccessScope] {
        let cited = isPresentation ? preview?.slideNumber != nil : citedPart != nil
        return ShareAccessScope.offered(for: sourceKind, hasCitedPart: cited || isLoading,
                                        markable: ShareSourceKind.isMarkable(filename))
    }

    /// Once the preview shows the citation names no part, only what is offered stays chosen.
    func keepOfferedScope() {
        if !scopes.contains(scope) { scope = scopes[0] }
        needsDisplay = true
    }

    func moveScope(_ delta: Int) {
        let offered = scopes
        let index = offered.firstIndex(of: scope) ?? 0
        scope = offered[(index + delta + offered.count) % offered.count]
        needsDisplay = true
    }

    var canSubmit: Bool {
        guard !isCopying else { return false }
        if scope == .redacted { return !masks.isEmpty }
        if scope == .marked { return !markup.marks.isEmpty && markupDocument != nil }
        if scope == .indexed && isPDFSource {
            return pdfExcerpt != nil && reviewedPDFDocument != nil && !isPDFExcerptLoading
        }
        return true
    }

    var previewCard: NSRect {
        NSRect(x: 16, y: 132, width: bounds.width - 32,
               height: bounds.height - footerHeight - 146)
    }

    func scopeRect(_ index: Int) -> NSRect {
        let count = CGFloat(scopes.count)
        let width = (bounds.width - 32 - 6 * (count - 1)) / count
        return NSRect(x: 16 + CGFloat(index) * (width + 6), y: 47,
                      width: width, height: 48)
    }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func keyDown(with event: NSEvent) {
        guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty else {
            super.keyDown(with: event); return
        }
        switch event.keyCode {
        case 53: LassoTransientUI.shared.dismissAll()
        case 48 where event.modifierFlags.contains(.shift): super.keyDown(with: event)
        case 48, 36, 76: submit()
        case 123, 124, 125, 126:
            guard !isCopying else { return }
            moveScope([123, 126].contains(event.keyCode) ? -1 : 1)
        default: super.keyDown(with: event)
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        blurredMasks.removeAll()
        needsDisplay = true
    }

    func reset(label: String, filename: String) {
        pdfView.cancelInteraction()
        self.label = label
        self.filename = filename.isEmpty ? "Indexed source" : filename
        scope = .indexed
        localOnly = true
        copyState = .idle
        effect = .blur
        modelView = AssistModelView()
        modelDrag = nil
        masks.removeAll()
        history.clear()
        excerptHistory.clear()
        gestureMasks = nil
        markup = ShareMarkupSession()
        markupPages = nil
        isMarkupPagesLoading = false
        markupPagesError = nil
        slideNavigator?.bar.removeFromSuperview()
        slideNavigator = nil
        slideDecks = nil
        citedPart = nil
        blurredMasks.removeAll()
        redactionDrag = nil
        drawingDrag = nil
        drawingLayout = nil
        preview = nil
        fullDocument = nil
        isLoading = true
        isDocumentLoading = true
        isPDFLoading = false
        loadedPDFDocument = nil
        pdfView.document = nil
        pdfView.isHidden = true
        reviewedPDFDocument = nil
        isPDFExcerptLoading = false
        pdfExcerptError = nil
        pdfExcerpt = nil
        pdfSelectionMode = .text
        isChoosingPDFExcerpt = true
        initializedPDFExcerpt = false
        pdfMaskLayoutKey = ""
        pdfSourceDestination = nil
        sheetIndex = 0
        scrollLayoutKey = ""
        targets.removeAll()
        previewScroll.isHidden = true
        previewScroll.contentView.scroll(to: .zero)
        notice = nil
        needsDisplay = true
    }

    func beginCopy() {
        pdfView.cancelInteraction()
        markup.cancel()
        copyState = .copying
        redactionDrag = nil
        drawingDrag = nil
        endMaskEdit()
        notice = nil
        needsDisplay = true
    }

    func finishCopy(error: String? = nil) {
        copyState = error == nil ? .copied : .idle
        notice = error
        needsDisplay = true
    }

    func clearCopyConfirmation() {
        if copyState == .copied {
            copyState = .idle
            needsDisplay = true
        }
    }

    func addFixtureRedaction(sheet: Int, row: Int, column: Int, effect: ShareRedactionEffect) {
        let value = ShareRedaction(kind: "CELL", sheet: sheet, row: row,
                                   column: column, block: nil, effect: effect)
        masks["cell:\(sheet):\(row):\(column)"] = value
    }
}
