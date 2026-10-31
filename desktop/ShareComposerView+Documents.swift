// The whole-document previews: text, tables, drawings and 3D models, and PDFs with their excerpt and masks.

import Cocoa
import PDFKit
import CoreImage

extension ShareComposerView {
    func drawFullDocument(_ document: ShareFullDocument, in rect: NSRect) {
        if let model = document.model, model.orbit != nil, scope != .redacted {
            drawRotatable(model, in: rect)
        } else if let model = document.model {
            AssistModelRenderer.draw(model, in: rect)
            drawingLayout = ShareDrawingLayout(model: model, in: rect)
            if scope == .redacted, let layout = drawingLayout {
                NSGraphicsContext.current?.saveGraphicsState()
                NSBezierPath(rect: layout.frame).addClip()
                for mask in masks.values where mask.kind == "DRAWING" {
                    if let area = layout.rect(for: mask) { drawDrawingMask(mask.effect, in: area) }
                }
                NSGraphicsContext.current?.restoreGraphicsState()
            }
        } else if document.kind == "table", !document.sheets.isEmpty {
            sheetIndex = min(max(0, sheetIndex), document.sheets.count - 1)
            drawFullTable(document.sheets[sheetIndex], sheetCount: document.sheets.count, in: rect)
        } else if document.kind == "text", !document.blocks.isEmpty {
            drawFullText(document.blocks, styles: document.styles, lines: document.lineLayout, in: rect)
        } else {
            drawCentered(document.unavailableReason ?? "This document has no previewable content", in: rect)
        }
    }

    func drawRotatable(_ model: AssistModelPreview, in rect: NSRect) {
        AssistModelRenderer.draw(model, in: rect, view: model.orbit == nil ? nil : modelView)
        if model.orbit != nil { shownModel = (model, rect) }
    }

    /// The model under `point`, if it can be turned there.
    func rotatableModel(at point: NSPoint) -> AssistModelPreview? {
        guard !isCopying, let shownModel, shownModel.rect.contains(point) else { return nil }
        return shownModel.model
    }

    func zoomModel(by factor: CGFloat, at point: NSPoint) -> Bool {
        guard let model = rotatableModel(at: point), let rect = shownModel?.rect else { return false }
        modelView = modelView.zoomed(by: factor, within: AssistModelRenderer.zoomRange(for: model, in: rect))
        needsDisplay = true
        return true
    }

    func drawPDFContent(in rect: NSRect) {
        pdfView.marks = []
        syncPDFMasks()
        if scope == .indexed && !isChoosingPDFExcerpt {
            if let reviewedPDFDocument {
                pdfView.selectionMode = .read
                drawFullPDF(reviewedPDFDocument, page: 1, in: rect)
            } else {
                drawCentered(isPDFExcerptLoading ? "Preparing selected excerpt…" : pdfExcerptError ?? "Select an excerpt to review.", in: rect)
            }
            return
        }
        guard let document = loadedPDFDocument else {
            drawCentered(isDocumentLoading || isPDFLoading ? "Loading PDF pages…" : "PDF pages could not be loaded. Reopen this source to try again.", in: rect)
            return
        }
        pdfView.selectionMode = scope == .document || isCopying ? .read : pdfSelectionMode
        drawFullPDF(document, page: fullDocument?.pdf?.pageNumber ?? 1, in: rect)
    }

    func drawFullPDF(_ document: PDFDocument, page: Int, in rect: NSRect) {
        showsPDFPreview = true
        pdfView.frame = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: max(0, rect.height - 20))
        if pdfView.document !== document {
            if pdfView.document === loadedPDFDocument { pdfSourceDestination = pdfView.currentDestination }
            pdfView.cancelInteraction()
            pdfView.document = document
            pdfView.autoScales = true
            if document === loadedPDFDocument, let destination = pdfSourceDestination {
                pdfView.go(to: destination)
            } else if let selected = document.page(at: min(max(0, page - 1), document.pageCount - 1)) {
                pdfView.go(to: selected)
            }
        }
        let slides = isPresentation && document === markupDocument || slideNavigator?.deck.document === document
        let detail = slides && scope == .indexed ? "Only this slide is shared, without notes or comments"
            : slides && scope == .document ? "Every slide · Scroll or choose one from the slide menu"
            : scope == .indexed ? (isChoosingPDFExcerpt ? "Select text or mark an area · Scroll for more pages" : "Selected excerpt · Original page layout")
            : scope == .redacted ? "\(masks.count) area\(masks.count == 1 ? "" : "s") hidden · Scroll for more pages"
            : scope == .marked ? "\(markup.marks.count) mark\(markup.marks.count == 1 ? "" : "s") · Scroll for more \(isPresentation ? "slides" : "pages")"
            : "Original PDF layout · Scroll to read"
        let unit = slides ? "slide" : "page"
        drawText("\(document.pageCount) \(unit)\(document.pageCount == 1 ? "" : "s") · \(detail)",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - 15, width: rect.width - 4, height: 14),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
    }

    func initializePDFExcerpt() {
        guard !initializedPDFExcerpt, let document = loadedPDFDocument,
              let preview = preview?.pdf, !preview.selectedText.isEmpty else { return }
        let pages = [min(preview.pageNumber - 1, document.pageCount - 1)]
            + (0..<document.pageCount).filter { $0 != preview.pageNumber - 1 }
        let direct = document.findString(preview.selectedText, withOptions: [.caseInsensitive])
        if let selection = direct.first(where: { $0.pages.contains { document.index(for: $0) == pages[0] } }) ?? direct.first {
            initializedPDFExcerpt = true
            selectPDFText(selection, asExcerpt: true)
            return
        }
        let pattern = preview.selectedText.split(whereSeparator: { $0.isWhitespace })
            .map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: "\\s+")
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return }
        for index in pages {
            guard let page = document.page(at: index), let text = page.string,
                  let match = expression.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)),
                  let selection = page.selection(for: match.range) else { continue }
            initializedPDFExcerpt = true
            selectPDFText(selection, asExcerpt: true)
            return
        }
    }

    func selectPDFText(_ selection: PDFSelection, asExcerpt: Bool = false) {
        guard let document = loadedPDFDocument else { return }
        var regions: [SharePDFRegion] = []
        for line in selection.selectionsByLine() {
            for page in line.pages {
                if let region = SharePDFRegion(page: document.index(for: page) + 1,
                    rect: line.bounds(for: page).insetBy(dx: -0.7, dy: -0.7), crop: page.bounds(for: .cropBox)),
                   !regions.contains(region) { regions.append(region) }
            }
        }
        applyPDFSelection(text: selection.string ?? "", regions: regions, asExcerpt: asExcerpt)
    }

    func selectPDFArea(page: PDFPage, rect: NSRect) {
        guard let document = loadedPDFDocument,
              let region = SharePDFRegion(page: document.index(for: page) + 1, rect: rect, crop: page.bounds(for: .cropBox)) else { return }
        applyPDFSelection(text: page.selection(for: rect)?.string ?? "", regions: [region])
    }

    private func applyPDFSelection(text: String, regions: [SharePDFRegion], asExcerpt: Bool = false) {
        guard !isCopying, !regions.isEmpty else { return }
        guard regions.count <= 512 else {
            notice = "Select a shorter excerpt with up to 512 lines or areas."
            needsDisplay = true
            return
        }
        if scope == .indexed || asExcerpt {
            let excerpt = SharePDFExcerpt(text: text, regions: regions)
            // The cited passage found as the source opens is where ⌘Z stops.
            if !asExcerpt { excerptHistory.record(from: pdfExcerpt, to: excerpt) }
            initializedPDFExcerpt = true
            showExcerpt(excerpt)
        } else if scope == .redacted {
            guard masks.count + regions.count <= 512 else {
                notice = "Use up to 512 areas. Click an existing mask to remove it."
                needsDisplay = true
                return
            }
            beginMaskEdit()
            for region in regions {
                let mask = region.redaction(effect: effect)
                masks[mask.locationKey] = mask
            }
            endMaskEdit()
            pdfView.clearSelection()
        }
        notice = nil
        needsDisplay = true
    }

    func removePDFMask(page: PDFPage, point: NSPoint) -> Bool {
        guard scope == .redacted, !isCopying,
              let annotation = page.annotations.compactMap({ $0 as? SharePDFMaskAnnotation }).first(where: { $0.bounds.contains(point) }) else { return false }
        beginMaskEdit()
        masks.removeValue(forKey: annotation.maskKey)
        endMaskEdit()
        needsDisplay = true
        return true
    }

    func syncPDFMasks() {
        guard let document = loadedPDFDocument else { return }
        let key = "\(ObjectIdentifier(document)):\(scope.rawValue):"
            + masks.values.sorted { $0.locationKey < $1.locationKey }.map { "\($0.locationKey):\($0.effect.rawValue)" }.joined(separator: "|")
        guard key != pdfMaskLayoutKey else { return }
        pdfMaskLayoutKey = key
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            for annotation in page.annotations where annotation is SharePDFMaskAnnotation { page.removeAnnotation(annotation) }
            guard scope == .redacted else { pdfView.annotationsChanged(on: page); continue }
            let crop = page.bounds(for: .cropBox)
            for mask in masks.values where mask.kind == "PDF" && mask.page == index + 1 {
                guard let x = mask.x, let y = mask.y, let width = mask.width, let height = mask.height else { continue }
                let rect = NSRect(x: crop.minX + CGFloat(x) * crop.width, y: crop.maxY - CGFloat(y + height) * crop.height,
                                  width: CGFloat(width) * crop.width, height: CGFloat(height) * crop.height)
                page.addAnnotation(SharePDFMaskAnnotation(bounds: rect, key: mask.locationKey, effect: mask.effect))
            }
            pdfView.annotationsChanged(on: page)
        }
        pdfView.needsDisplay = true
        pdfView.refreshMasks()
    }

    private func drawDrawingMask(_ effect: ShareRedactionEffect, in rect: NSRect) {
        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(rect: rect).addClip()
        if effect == .blank {
            NSColor.black.setFill()
            rect.fill()
        } else {
            // Synthetic blurred marks match the published preview. No source
            // pixels or text are carried in a recipient's blurred region.
            NSColor(calibratedWhite: 0.84, alpha: 1).setFill()
            rect.fill()
            let image = NSImage(size: NSSize(width: 80, height: 50), flipped: true) { _ in
                NSColor(calibratedWhite: 0.45, alpha: 1).setFill()
                for index in 0..<4 {
                    NSRect(x: 8 + CGFloat(index % 2) * 7, y: 6 + CGFloat(index) * 11,
                           width: index % 2 == 0 ? 62 : 46, height: 5).fill()
                }
                return true
            }
            if let data = image.tiffRepresentation, let input = CIImage(data: data),
               let output = Self.blurContext.createCGImage(input.applyingGaussianBlur(sigma: 4).cropped(to: input.extent), from: input.extent) {
                NSImage(cgImage: output, size: image.size).draw(in: rect, from: .zero,
                    operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        }
        NSGraphicsContext.current?.restoreGraphicsState()
        sourceColor.withAlphaComponent(0.8).setStroke()
        let border = NSBezierPath(rect: rect)
        border.lineWidth = 1
        border.stroke()
    }

    private func drawFullTable(_ sheet: ShareFullSheet, sheetCount: Int, in rect: NSRect) {
        let tabHeight: CGFloat = sheetCount > 1 ? 27 : 0
        if sheetCount > 1, let document = fullDocument {
            drawSheetTabs(document.sheets, in: NSRect(
                x: rect.minX, y: rect.minY, width: rect.width, height: tabHeight))
        }
        let columns = max(1, sheet.rows.map(\.count).max() ?? 1)
        configureScrollableTable(rows: sheet.rows,
            columns: (0..<columns).map(spreadsheetColumn),
            rowNumbers: sheet.rows.indices.map { String($0 + 1) },
            headers: nil, citations: [], redactionSheet: sheetIndex,
            in: NSRect(x: rect.minX, y: rect.minY + tabHeight,
                       width: rect.width, height: max(30, rect.height - tabHeight - 21)),
            key: "full:\(sheetIndex)")
        drawText("\(sheet.rows.count) rows · \(columns) columns · Scroll to review every cell",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - 16, width: rect.width - 4, height: 14),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
    }

    private func drawSheetTabs(_ sheets: [ShareFullSheet], in rect: NSRect) {
        let arrowWidth: CGFloat = sheets.count > 4 ? 18 : 0
        let visibleCount = min(4, sheets.count)
        let start = min(max(0, sheetIndex - 1), max(0, sheets.count - visibleCount))
        let available = rect.width - arrowWidth * 2
        let width = available / CGFloat(visibleCount)

        if arrowWidth > 0 {
            let previous = NSRect(x: rect.minX, y: rect.minY, width: arrowWidth, height: rect.height)
            let next = NSRect(x: rect.maxX - arrowWidth, y: rect.minY, width: arrowWidth, height: rect.height)
            drawSymbol("chevron.left", in: previous, color: sourceInkColor)
            drawSymbol("chevron.right", in: next, color: sourceInkColor)
            sheetTabTargets.append((previous, max(0, sheetIndex - 1)))
            sheetTabTargets.append((next, min(sheets.count - 1, sheetIndex + 1)))
        }

        for position in 0..<visibleCount {
            let index = start + position
            let tab = NSRect(x: rect.minX + arrowWidth + CGFloat(position) * width,
                             y: rect.minY, width: width, height: rect.height - 3)
            if index == sheetIndex {
                sourceColor.withAlphaComponent(0.12).setFill()
                NSBezierPath(roundedRect: tab, xRadius: 5, yRadius: 5).fill()
            }
            drawText(sheets[index].name, in: tab.insetBy(dx: 5, dy: 5),
                     font: .systemFont(ofSize: 10, weight: index == sheetIndex ? .semibold : .regular),
                     color: index == sheetIndex ? sourceInkColor : .secondaryLabelColor,
                     alignment: .center)
            sheetTabTargets.append((tab, index))
        }
    }

    private func drawFullText(_ blocks: [String], styles: [AssistTextBlock], lines: Bool, in rect: NSRect) {
        configureScrollableText(blocks, styles: styles,
            in: NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: max(30, rect.height - 21)),
            canRedact: true, key: "full-text", lines: lines)
        drawText("\(blocks.count) \(lines ? "lines" : "sections") · Scroll to read the complete document",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - 16, width: rect.width - 4, height: 14),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
    }

    func spreadsheetColumn(_ index: Int) -> String {
        var result = ""
        var value = index
        repeat {
            result = String(UnicodeScalar(65 + value % 26)!) + result
            value = value / 26 - 1
        } while value >= 0
        return result
    }

    func drawTable(_ preview: AssistDocumentPreview, in rect: NSRect) {
        let columnCount = max(1, max(preview.headers.count,
            preview.rows.map { $0.cells.count }.max() ?? 1))
        let columns = (0..<columnCount).map { index in
            index < preview.columns.count ? preview.columns[index] : spreadsheetColumn(index)
        }
        var citations = Set<String>()
        for (rowIndex, row) in preview.rows.enumerated() {
            for (columnIndex, cell) in row.cells.enumerated() where cell.cited {
                citations.insert("\(rowIndex):\(columnIndex)")
            }
        }
        configureScrollableTable(rows: preview.rows.map { $0.cells.map(\.value) },
            columns: columns, rowNumbers: preview.rows.map { $0.rowNumber.map(String.init) ?? "" },
            headers: preview.headers, citations: citations, redactionSheet: nil,
            in: NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: max(30, rect.height - 21)),
            key: "indexed-table")
        drawText("\(preview.rows.count) context rows · \(columnCount) columns · Scroll to review every cell",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - 16, width: rect.width - 4, height: 14),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
    }

    func drawTextBlocks(_ value: String, in rect: NSRect) {
        let text = value.isEmpty ? "Indexed source context" : value
        configureScrollableText([text],
                                styles: isMarkdownSource ? [AssistTextBlock(type: "paragraph", text: text)] : [],
                                in: rect, canRedact: false, key: "indexed-text")
    }

    private var isMarkdownSource: Bool {
        ["md", "mdx", "qmd", "rmd"].contains((filename as NSString).pathExtension.lowercased())
    }

    func textHeight(_ text: String, width: CGFloat, font: NSFont? = nil) -> CGFloat {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let measured = (text.isEmpty ? " " : text) as NSString
        return ceil(measured.boundingRect(with: NSSize(width: max(1, width), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font ?? scrollFont, .paragraphStyle: paragraph]).height) + 2
    }
}
