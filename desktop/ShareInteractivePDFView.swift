// The PDF the share composer selects, redacts and marks up, with the masks and strokes drawn over its pages.

import Cocoa
import PDFKit
import CoreImage

final class SharePDFMaskAnnotation: PDFAnnotation {
    let maskKey: String
    let effect: ShareRedactionEffect
    private static let blurContext = CIContext(options: [.cacheIntermediates: false])
    private lazy var blurredImage = Self.blurImage(size: bounds.size)

    init(bounds: NSRect, key: String, effect: ShareRedactionEffect) {
        maskKey = key
        self.effect = effect
        super.init(bounds: bounds, forType: .square, withProperties: nil)
        isReadOnly = true
        let fill = effect == .blank ? NSColor.black : NSColor.white
        color = fill
        interiorColor = fill
        border = PDFBorder()
        border?.lineWidth = 0
        shouldDisplay = true
        shouldPrint = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(with box: PDFDisplayBox, in context: CGContext) {
        drawMask(in: bounds, context: context)
    }

    func drawMask(in rect: NSRect, context: CGContext) {
        context.saveGState()
        context.clip(to: rect)
        context.setFillColor(CGColor(gray: effect == .blank ? 0.08 : 1, alpha: 1))
        context.fill(rect)
        if effect == .blur, let image = blurredImage {
            context.draw(image, in: rect)
        }
        context.restoreGState()
    }

    // Match the exported PDF's synthetic blur. Generate it once in page space
    // so zooming the PDF changes only its scale, never the mask's appearance.
    private static func blurImage(size: CGSize) -> CGImage? {
        let scale = min(2, 1024 / max(size.width, size.height))
        let width = max(1, Int(ceil(size.width * scale)))
        let height = max(1, Int(ceil(size.height * scale)))
        guard let bitmap = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        bitmap.setFillColor(CGColor(gray: 1, alpha: 1))
        bitmap.fill(CGRect(x: 0, y: 0, width: width, height: height))
        bitmap.scaleBy(x: scale, y: scale)
        let rows = max(1, Int(ceil(size.height / 17)))
        let lineHeight = size.height / CGFloat(rows)
        let strokeHeight = min(6, max(2, lineHeight * 0.4))
        let wordWidths: [CGFloat] = [1.2, 0.7, 1.65, 1, 0.85, 1.4]
        bitmap.setFillColor(CGColor(gray: 0.38, alpha: 1))
        for row in 0..<rows {
            var x: CGFloat = 3 + CGFloat(row % 2) * 2
            var word = row
            let end = size.width - 3 - CGFloat(row % 3) * min(size.width * 0.08, 18)
            while x < end {
                let markWidth = min(wordWidths[word % wordWidths.count] * lineHeight, end - x)
                bitmap.fill(CGRect(x: x, y: CGFloat(row) * lineHeight + (lineHeight - strokeHeight) / 2,
                    width: markWidth, height: strokeHeight))
                x += markWidth + max(3, lineHeight * 0.3)
                word += 1
            }
        }
        guard let source = bitmap.makeImage() else { return nil }
        let input = CIImage(cgImage: source)
        let radius = max(2, min(4, lineHeight * 0.24)) * scale
        return blurContext.createCGImage(input.clampedToExtent().applyingGaussianBlur(sigma: radius)
            .cropped(to: input.extent), from: input.extent)
    }
}

private final class SharePDFMaskOverlay: NSView {
    weak var pdfView: ShareInteractivePDFView?
    override var isFlipped: Bool { pdfView?.isFlipped ?? false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        pdfView?.drawMaskOverlay(in: context)
    }
}

final class ShareInteractivePDFView: PDFView {
    private var scrollObserver: NSObjectProtocol?
    private lazy var maskOverlay: SharePDFMaskOverlay = {
        let overlay = SharePDFMaskOverlay(frame: bounds)
        overlay.pdfView = self
        overlay.autoresizingMask = [.width, .height]
        addSubview(overlay, positioned: .above, relativeTo: nil)
        scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self, let view = notification.object as? NSView, view.isDescendant(of: self) else { return }
            self.maskOverlay.needsDisplay = true
        }
        return overlay
    }()

    deinit { if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) } }

    func refreshMasks() {
        maskOverlay.frame = bounds
        maskOverlay.needsDisplay = true
    }

    fileprivate func drawMaskOverlay(in context: CGContext) {
        context.saveGState()
        if let clip = documentView?.enclosingScrollView?.contentView {
            context.clip(to: convert(clip.bounds, from: clip))
        }
        for page in visiblePages {
            for annotation in page.annotations.compactMap({ $0 as? SharePDFMaskAnnotation }) {
                annotation.drawMask(in: convert(annotation.bounds, from: page), context: context)
            }
        }
        if let draft, let page = start?.page {
            let rect = convert(draft.bounds, from: page)
            context.setFillColor(NSColor.systemBlue.withAlphaComponent(0.18).cgColor)
            context.fill(rect)
            context.setStrokeColor(NSColor.systemBlue.cgColor)
            context.stroke(rect, width: 1)
        }
        drawMarks(in: context)
        context.restoreGState()
    }

    /// The marked copy's strokes, and the one being drawn, on the pages in view.
    private func drawMarks(in context: CGContext) {
        guard let document, !marks.isEmpty || draftMark != nil else { return }
        for page in visiblePages {
            let number = document.index(for: page) + 1
            let crop = page.bounds(for: .cropBox)
            for mark in marks + [draftMark].compactMap({ $0 }) where mark.page == number {
                mark.draw(in: context, crop: crop, scale: scaleFactor) { convert($0, from: page) }
            }
        }
    }

    enum SelectionMode { case read, text, area, draw }
    var selectionMode: SelectionMode = .read
    var onTextSelection: ((PDFSelection) -> Void)?
    var onAreaSelection: ((PDFPage, NSRect) -> Void)?
    var onMaskClick: ((PDFPage, NSPoint) -> Bool)?
    /// While drawing: where a stroke starts and moves on its page, in page space, and when it ends.
    var onMarkBegin: ((PDFPage, NSPoint) -> Void)?
    var onMarkMove: ((PDFPage, NSPoint) -> Void)?
    var onMarkEnd: (() -> Void)?
    var marks: [ShareMarkStroke] = [] {
        didSet { if marks != oldValue { refreshMasks() } }
    }
    var draftMark: ShareMarkStroke? {
        didSet { if draftMark != oldValue { refreshMasks() } }
    }
    private var start: (page: PDFPage, point: NSPoint, viewPoint: NSPoint)?
    private var draft: PDFAnnotation?

    func cancelInteraction() {
        if let draft, let page = start?.page { page.removeAnnotation(draft); annotationsChanged(on: page) }
        draft = nil
        start = nil
        draftMark = nil
        clearSelection()
        refreshMasks()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func scrollWheel(with event: NSEvent) {
        if let scroll = documentView?.enclosingScrollView { scroll.scrollWheel(with: event) }
        else { super.scrollWheel(with: event) }
        refreshMasks()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        guard selectionMode != .read, let hit else { return hit }
        var candidate: NSView? = hit
        while let view = candidate, view !== self {
            if view is NSScroller { return hit }
            candidate = view.superview
        }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        guard selectionMode != .read else { super.mouseDown(with: event); return }
        let point = convert(event.locationInWindow, from: nil)
        guard let page = page(for: point, nearest: false) else { return }
        let pagePoint = convert(point, to: page)
        if selectionMode == .draw {
            start = (page, pagePoint, point)
            onMarkBegin?(page, pagePoint)
            return
        }
        if onMaskClick?(page, pagePoint) == true { return }
        clearSelection()
        start = (page, pagePoint, point)
        if selectionMode == .text, event.clickCount >= 2 {
            let selection = event.clickCount >= 3 ? page.selectionForLine(at: pagePoint) : page.selectionForWord(at: pagePoint)
            setCurrentSelection(selection, animate: false)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        if selectionMode == .draw {
            // The stroke stays on the page it began on; the page holds still under the pen.
            onMarkMove?(start.page, convert(convert(event.locationInWindow, from: nil), to: start.page))
            return
        }
        _ = documentView?.autoscroll(with: event)
        let point = convert(event.locationInWindow, from: nil)
        if selectionMode == .text, let endPage = page(for: point, nearest: true), let document {
            setCurrentSelection(document.selection(from: start.page, at: start.point,
                                                   to: endPage, at: convert(point, to: endPage)), animate: false)
        } else if selectionMode == .area {
            let end = convert(point, to: start.page)
            let area = NSRect(x: min(start.point.x, end.x), y: min(start.point.y, end.y),
                              width: abs(end.x - start.point.x), height: abs(end.y - start.point.y))
                .intersection(start.page.bounds(for: .cropBox))
            if let draft { start.page.removeAnnotation(draft) }
            let annotation = PDFAnnotation(bounds: area, forType: .square, withProperties: nil)
            annotation.color = .systemBlue
            annotation.interiorColor = NSColor.systemBlue.withAlphaComponent(0.18)
            start.page.addAnnotation(annotation)
            annotationsChanged(on: start.page)
            draft = annotation
            refreshMasks()
            needsDisplay = true
        }
    }

    override func mouseUp(with event: NSEvent) {
        guard let start else { return }
        self.start = nil
        if selectionMode == .draw {
            onMarkMove?(start.page, convert(convert(event.locationInWindow, from: nil), to: start.page))
            onMarkEnd?()
            return
        }
        if let draft {
            let rect = draft.bounds
            start.page.removeAnnotation(draft)
            annotationsChanged(on: start.page)
            self.draft = nil
            refreshMasks()
            let visible = convert(rect, from: start.page)
            if visible.width >= 3, visible.height >= 3 { onAreaSelection?(start.page, rect) }
        } else if selectionMode == .text, let selection = currentSelection,
                  selection.string?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            onTextSelection?(selection)
        }
    }
}
