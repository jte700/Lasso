// Marking up a document's pages or a deck's slides with a pen, marker or eraser.

import Cocoa
import PDFKit

extension ShareComposerView {
    private static let markHands: [(hand: ShareMarkupSession.Hand, title: String, width: CGFloat)] = [
        (.tool(.pen), ShareMarkTool.pen.title, 50), (.tool(.marker), ShareMarkTool.marker.title, 64),
        (.tool(.highlighter), ShareMarkTool.highlighter.title, 86), (.eraser, "Eraser", 62),
    ]
    private static let markColorSpacing: CGFloat = 24

    private var markHandRects: [(hand: ShareMarkupSession.Hand, title: String, rect: NSRect)] {
        var x = pdfTextModeRect.minX
        return Self.markHands.map { item in
            defer { x += item.width }
            return (item.hand, item.title, NSRect(x: x, y: pdfTextModeRect.minY, width: item.width, height: pdfTextModeRect.height))
        }
    }

    private func markColorRect(_ index: Int) -> NSRect {
        let count = CGFloat(ShareMarkColor.allCases.count)
        return NSRect(x: bounds.width - 16 - (count - CGFloat(index)) * Self.markColorSpacing + 2, y: 105, width: 20, height: 20)
    }

    /// How near the eraser must come to a stroke, in page space, so it feels the same at any zoom.
    private var eraserReach: CGFloat { 5 / max(0.05, pdfView.scaleFactor) }

    /// The tools, then the colours of the one in hand.
    func drawMarkupPalette() {
        drawSegmentedControl(markHandRects.map { ($0.title, markup.hand == $0.hand, $0.rect) })
        let chosen = markup.color
        for (index, option) in ShareMarkColor.allCases.enumerated() {
            let rect = markColorRect(index)
            // The eraser has no colour; choosing one picks the pen back up.
            let dot = NSBezierPath(ovalIn: rect.insetBy(dx: 3, dy: 3))
            option.color.withAlphaComponent(chosen == nil ? 0.35 : 1).setFill()
            dot.fill()
            // Black stays visible on a dark panel.
            NSColor.labelColor.withAlphaComponent(0.25).setStroke()
            dot.lineWidth = 0.75
            dot.stroke()
            if chosen == option {
                NSColor.labelColor.withAlphaComponent(0.55).setStroke()
                let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 0.75, dy: 0.75))
                ring.lineWidth = 1.5
                ring.stroke()
            }
        }
    }

    func choosePaletteItem(at point: NSPoint) -> Bool {
        if let item = markHandRects.first(where: { $0.rect.contains(point) }) {
            markup.hand = item.hand
        } else if let index = ShareMarkColor.allCases.indices.first(where: { markColorRect($0).contains(point) }) {
            markup.choose(ShareMarkColor.allCases[index])
        } else {
            return false
        }
        needsDisplay = true
        return true
    }

    func drawMarkupContent(in rect: NSRect) {
        // A PDF's redaction masks belong to Select & redact, not to the marked copy.
        if isPDFSource { syncPDFMasks() }
        guard let document = markupDocument else {
            let waiting = isPDFSource ? isDocumentLoading || isPDFLoading : markupPagesError == nil
            drawCentered(waiting ? (isPresentation ? "Drawing the slides\u{2026}" : "Laying out the pages\u{2026}")
                         : markupPagesError ?? "The pages could not be loaded. Reopen this source to try again.", in: rect)
            return
        }
        pdfView.selectionMode = isCopying ? .read : .draw
        pdfView.marks = markup.marks
        if let all = slideDecks?.all, !isPDFSource {
            drawSlides(all, opening: preview?.slideNumber ?? 1, marking: true, in: rect)
            return
        }
        drawFullPDF(document, page: isPDFSource ? fullDocument?.pdf?.pageNumber ?? 1 : preview?.slideNumber ?? 1, in: rect)
    }

    /// A deck's slides under their slide menu, opened at slide `number`.
    func drawSlides(_ slides: SlideDeckDocument, opening number: Int, marking: Bool, in rect: NSRect) {
        if slideNavigator?.deck !== slides {
            slideNavigator?.bar.removeFromSuperview()
            let navigator = SlideDeckNavigator(deck: slides, view: pdfView, current: slides.numbers.contains(number) ? number : slides.numbers[0])
            addSubview(navigator.bar)
            slideNavigator = navigator
        }
        showsSlideMenu = true
        slideNavigator?.bar.frame = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: SlideMenuBar.height)
        if !marking {
            pdfView.marks = []
            pdfView.selectionMode = .read
        }
        let below = SlideMenuBar.height + 6
        let opening = pdfView.document !== slides.document
        drawFullPDF(slides.document, page: (slides.numbers.firstIndex(of: number) ?? 0) + 1,
                    in: NSRect(x: rect.minX, y: rect.minY + below, width: rect.width, height: max(0, rect.height - below)))
        // A whole slide fits in view; a deck just shown opens on the cited slide at that size.
        slideNavigator?.fitSlides()
        if opening, let current = slideNavigator?.bar.current { slideNavigator?.go(to: current) }
    }

    func beginMark(page: PDFPage, at point: NSPoint) {
        guard scope == .marked, !isCopying, let document = markupDocument else { return }
        let index = document.index(for: page)
        guard index != NSNotFound else { return }
        // A slide's picture arriving mid-stroke waits until the stroke ends.
        slideDecks?.all.holdsPages = true
        let started = markup.begin(page: index + 1, at: point, crop: page.bounds(for: .cropBox),
                                   reach: eraserReach)
        notice = started ? nil : "This copy holds as many marks as it can. The eraser takes one away."
        showMarks()
    }

    func moveMark(page: PDFPage, to point: NSPoint) {
        guard scope == .marked, let document = markupDocument else { return }
        let index = document.index(for: page)
        guard index != NSNotFound else { return }
        let count = markup.marks.count
        markup.move(to: point, page: index + 1, crop: page.bounds(for: .cropBox), reach: eraserReach)
        pdfView.marks = markup.marks
        if markup.marks.count != count { needsDisplay = true }
    }

    func endMark() {
        slideDecks?.all.holdsPages = false
        guard scope == .marked else { return }
        markup.end()
        showMarks()
    }

    func showMarks() {
        pdfView.marks = markup.marks
        needsDisplay = true
    }
}
