// The document preview on the card's right: text, table, PDF, slides and 3D model.

import Cocoa

extension AssistBoxView {
    var documentPreviewRect: NSRect {
        // A spreadsheet excerpt uses the room down to the matched-cell line,
        // so the rows around a cited cell are shown, not only the cell.
        let isTable = preview.map { $0.model == nil && $0.pdf == nil && !$0.rows.isEmpty } ?? false
        let previewTop = bodyTop + 72
        return NSRect(x: leftWidth + 18, y: previewTop,
                      width: bounds.width - leftWidth - 36,
                      height: isTable ? max(184, footerY - 30 - previewTop)
                         : preview?.model == nil && preview?.pdf == nil
                         && preview?.textBlocks.isEmpty != false ? 184 : 222)
    }

    /// The shown STEP model under `point`, if it can be turned there.
    func rotatableModel(at point: NSPoint) -> AssistModelPreview? {
        guard mode == .suggestions, !isPreviewLoading, preview?.pdfPage == nil,
              let model = preview?.model, model.orbit != nil, documentPreviewRect.contains(point) else { return nil }
        return model
    }

    /// Where a table preview's parts go: its header, fixed at the top of the
    /// table, and every row sent below it, which scroll as the suggestion
    /// list does. The columns leave room for the scroller when the rows scroll.
    struct TableGeometry {
        let layout: AssistTableLayout
        let table: NSRect
        let rows: NSRect
        let contentHeight: CGFloat
        /// How far down the rows open: where the card showed them before they
        /// scrolled, around the cited cell or from a column's first row.
        let openingOffset: CGFloat
    }

    private func tableGeometry(_ preview: AssistDocumentPreview, in rect: NSRect) -> TableGeometry {
        if let cached = tableGeometryCache, cached.rect == rect { return cached.geometry }
        func layout(width: CGFloat, height: CGFloat) -> AssistTableLayout {
            AssistTableLayout(headers: preview.headers, rows: preview.rows, size: CGSize(width: width, height: height),
                              listing: preview.moreRows.map { .init(firstRow: 0, moreRows: $0) })
        }
        func rowsHeight(_ all: AssistTableLayout) -> CGFloat {
            all.rowHeights.reduce(0, +) + (all.rowsBelow > 0 ? AssistTableLayout.moreRowsHeight : 0)
        }
        // With room for every row, the layout lays all of them out.
        var width = rect.width
        var all = layout(width: width, height: .greatestFiniteMagnitude)
        if all.headerHeight + rowsHeight(all) > rect.height {
            width -= AssistListScroller.width
            all = layout(width: width, height: .greatestFiniteMagnitude)
        }
        let height = rowsHeight(all)
        let table = NSRect(x: rect.minX, y: rect.minY, width: rect.width,
                           height: min(rect.height, all.headerHeight + height))
        let rows = NSRect(x: table.minX, y: table.minY + all.headerHeight,
                          width: table.width, height: max(0, table.height - all.headerHeight))
        let fitting = layout(width: width, height: rect.height).rowRange.lowerBound
        let opening = all.rowHeights.prefix(fitting).reduce(0, +)
        let geometry = TableGeometry(layout: all, table: table, rows: rows, contentHeight: height,
                                     openingOffset: min(opening, max(0, height - rows.height)))
        tableGeometryCache = (rect, geometry)
        return geometry
    }

    private var showsTable: Bool {
        guard let preview else { return false }
        return preview.model == nil && preview.pdfPage == nil && !preview.rows.isEmpty
    }

    /// The row at the top of a table preview's rows, as far as they are scrolled.
    var tableFirstRow: Int {
        guard let preview, showsTable, let table = previewContent as? AssistTableRowsView else { return 0 }
        let offset = table.contentView.bounds.origin.y
        var top: CGFloat = 0
        for (index, height) in tableGeometry(preview, in: documentPreviewRect).layout.rowHeights.enumerated() {
            if top + height > offset + 0.5 { return index }
            top += height
        }
        return max(0, preview.rows.count - 1)
    }

    /// Puts the preview's scroll view in its place: a table's rows under its
    /// header, anything else over the whole preview.
    func placePreviewContent() {
        guard let previewContent else { return }
        guard let table = previewContent as? AssistTableRowsView, let preview, showsTable else {
            previewContent.frame = documentPreviewRect
            return
        }
        let geometry = tableGeometry(preview, in: documentPreviewRect)
        table.frame = geometry.rows
        table.verticalLineScroll = geometry.layout.rowHeight
        table.fit(contentHeight: geometry.contentHeight, opening: geometry.openingOffset)
    }

    /// Puts a scrollable view over the preview's place for a text, code,
    /// Markdown, Word, slide or PDF source, once it has loaded. The card
    /// draws tables and models itself.
    func updatePreviewContent() {
        let wanted = mode == .suggestions && !isPreviewLoading ? preview : nil
        let generation = wanted == nil ? nil : previewGeneration
        let words = selectedSuggestion?.matchedWords ?? []
        guard generation != shownPreviewGeneration || words != shownMatchedWords else { return }
        previewContent?.removeFromSuperview()
        previewContent = nil
        shownPreviewGeneration = generation
        shownMatchedWords = words
        guard let wanted, let content = makePreviewContent(for: wanted) else { return }
        addSubview(content)
        previewContent = content
        placePreviewContent()
    }

    private var selectedSuggestion: AssistSuggestion? {
        suggestions.indices.contains(selected) ? suggestions[selected] : nil
    }

    private func makePreviewContent(for preview: AssistDocumentPreview) -> NSView? {
        let words = selectedSuggestion?.matchedWords ?? []
        let accent = DirectoryColorPreferences.color(for: selectedSuggestion?.projectId)?.color ?? .controlAccentColor
        if let page = preview.pdfPage { return AssistPDFPreviewView.showing(page, marking: words) }
        if let slides = preview.slides {
            return AssistSlidePreviewView(slides: slides, current: preview.slideNumber ?? slides.numbers.first ?? 1,
                                          marking: words, in: selectedSuggestion?.previewText, accent: accent)
        }
        if showsTable {
            let table = AssistTableRowsView()
            table.rows.drawContent = { [unowned self] dirty in self.drawTableRows(in: dirty) }
            return table
        }
        guard preview.model == nil, preview.rows.isEmpty, !preview.textBlocks.isEmpty else { return nil }
        return AssistTextPreviewView(blocks: preview.textBlocks, accent: accent, wraps: !preview.isCode, marking: words)
    }

    func zoomModel(by factor: CGFloat, at point: NSPoint) -> Bool {
        guard let model = rotatableModel(at: point) else { return false }
        modelView = modelView.zoomed(by: factor, within: AssistModelRenderer.zoomRange(for: model, in: documentPreviewRect))
        needsDisplay = true
        return true
    }

    func drawDocumentPreview(footerY: CGFloat) {
        let rightX = leftWidth
        let rightWidth = bounds.width - rightX

        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(roundedRect: bodyRect,
                     xRadius: bubbleCornerRadius, yRadius: bubbleCornerRadius).addClip()
        NSColor.controlBackgroundColor.withAlphaComponent(0.32).setFill()
        NSRect(x: rightX, y: bodyRect.minY,
               width: rightWidth, height: bodyRect.height).fill()
        NSGraphicsContext.current?.restoreGraphicsState()

        NSColor.separatorColor.withAlphaComponent(0.08).setStroke()
        let divider = NSBezierPath()
        divider.lineWidth = 0.5
        divider.move(to: NSPoint(x: rightX, y: bodyRect.minY + 8))
        divider.line(to: NSPoint(x: rightX, y: bodyRect.maxY - 8))
        divider.stroke()

        let fallback = selected < suggestions.count ? suggestions[selected] : nil
        let path = preview?.path ?? fallback?.path ?? ""
        let filename = preview?.filename ?? (path as NSString).lastPathComponent
        drawSourceIcon(for: path,
                       in: NSRect(x: rightX + 19, y: bodyTop + 19, width: 32, height: 32))

        drawText(filename.isEmpty ? "Document preview" : filename,
                 in: NSRect(x: rightX + 63, y: bodyTop + 21,
                            width: rightWidth - 121, height: 18),
                 font: NSFont.systemFont(ofSize: 12.5, weight: .semibold), color: .labelColor)

        let location = preview?.pdfPage.map { "Page \($0.pageNumber)" }
            ?? [preview?.location, fallback?.location].compactMap { $0 }
                .first { !$0.isEmpty && $0 != "—" } ?? ""
        let sheet = location.components(separatedBy: "!").first ?? ""
        let parent = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
        let subtitle = !sheet.isEmpty ? sheet
            : (!parent.isEmpty ? parent : (preview?.objectType ?? "Indexed source"))
        drawText(subtitle,
                 in: NSRect(x: rightX + 63, y: bodyTop + 40,
                            width: rightWidth - 121, height: 15),
                 font: NSFont.systemFont(ofSize: 10), color: .secondaryLabelColor)

        let previewRect = documentPreviewRect
        if isPreviewLoading {
            drawText("Loading document preview…",
                     in: NSRect(x: previewRect.minX, y: previewRect.midY - 8,
                               width: previewRect.width, height: 17),
                     font: NSFont.systemFont(ofSize: 10), color: .secondaryLabelColor,
                     alignment: .center)
        } else if let pdfPage = preview?.pdfPage {
            drawPDFPreview(pdfPage, in: previewRect)
        } else if let model = preview?.model {
            AssistModelRenderer.draw(model, in: previewRect, view: model.orbit == nil ? nil : modelView)
        } else if let preview, !preview.rows.isEmpty {
            drawTablePreview(preview, in: previewRect)
        } else if let preview, let slides = preview.slides {
            drawSlidePreview(slides, current: preview.slideNumber, in: previewRect)
        } else if let preview, !preview.textBlocks.isEmpty {
            drawTextPreview(preview, in: previewRect)
        } else {
            NSColor.controlBackgroundColor.withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: previewRect, xRadius: 8, yRadius: 8).fill()
            NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
            NSBezierPath(roundedRect: previewRect, xRadius: 8, yRadius: 8).stroke()
            drawText("Document preview",
                     in: NSRect(x: previewRect.minX + 13, y: previewRect.minY + 13,
                               width: previewRect.width - 26, height: 16),
                     font: NSFont.systemFont(ofSize: 11, weight: .semibold), color: .labelColor)
            let excerpt = previewError ?? preview?.unavailableReason ?? (preview?.context.isEmpty == false
                ? preview!.context
                : "Select a source-backed result to preview its exact document context.")
            drawMultilineText(excerpt,
                              in: NSRect(x: previewRect.minX + 13, y: previewRect.minY + 38,
                                        width: previewRect.width - 26, height: previewRect.height - 51),
                              font: NSFont.systemFont(ofSize: 10), color: .secondaryLabelColor)
        }

        if !location.isEmpty {
            let extensionName = (path as NSString).pathExtension.lowercased()
            let prefix = ["xls", "xlsx", "csv", "tsv"].contains(extensionName)
                ? "Matched cell:  " : "Matched location:  "
            drawText(prefix + location,
                     in: NSRect(x: rightX + 18, y: footerY - 22,
                               width: rightWidth - 36, height: 16),
                     font: NSFont.systemFont(ofSize: 10.5), color: .secondaryLabelColor)
        }

        NSColor.separatorColor.withAlphaComponent(0.09).setStroke()
        let footerLine = NSBezierPath()
        footerLine.lineWidth = 0.5
        footerLine.move(to: NSPoint(x: rightX + 8, y: footerY))
        footerLine.line(to: NSPoint(x: bounds.width - 8, y: footerY))
        footerLine.stroke()

        let gap: CGFloat = 8
        // Code has no share link, so Open file takes the whole row.
        let shareable = selectedSuggestionIsShareable
        let buttonWidth = shareable ? (rightWidth - 36 - gap) / 2 : rightWidth - 36
        drawActionButton("Open file", symbol: "arrow.up.right.square",
                         in: NSRect(x: rightX + 18, y: footerY + 6,
                                   width: buttonWidth, height: 35))
        if shareable {
            drawActionButton("Share link…", symbol: "link",
                             in: NSRect(x: rightX + 18 + buttonWidth + gap, y: footerY + 6,
                                       width: buttonWidth, height: 35))
        }
    }

    /// False for a suggestion from code, which is never shared with a link.
    var selectedSuggestionIsShareable: Bool {
        !suggestions.indices.contains(selected) || suggestions[selected].shareable
    }

    private func drawPDFPreview(_ page: AssistPDFPageImage, in rect: NSRect) {
        let outline = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
        NSColor.controlBackgroundColor.withAlphaComponent(0.3).setFill()
        outline.fill()
        // The PDF view over it shows the document itself.
        guard previewContent == nil else {
            NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
            outline.stroke()
            return
        }
        NSGraphicsContext.current?.saveGraphicsState()
        outline.addClip()
        let available = rect.insetBy(dx: 6, dy: 6)
        let size = page.image.size
        let scale = min(available.width / size.width, available.height / size.height)
        let target = NSRect(x: available.midX - size.width * scale / 2,
                            y: available.midY - size.height * scale / 2,
                            width: size.width * scale, height: size.height * scale)
        NSColor.white.setFill()
        target.fill()
        page.image.draw(in: target, from: .zero, operation: .sourceOver,
                        fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
        NSGraphicsContext.current?.restoreGraphicsState()
        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        outline.stroke()
    }

    /// A deck's slides scroll in the view over this; drawn alone, as a test
    /// renders the card, the cited slide's page stands in for them.
    private func drawSlidePreview(_ slides: SlideDeckDocument, current: Int?, in rect: NSRect) {
        guard previewContent == nil else { return }
        let available = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height - SlideMenuBar.height - 6)
        guard let page = slides.page(for: current ?? slides.numbers.first ?? 1) else { return }
        let box = page.bounds(for: .cropBox)
        let scale = min(available.width / box.width, available.height / box.height)
        let target = NSRect(x: available.midX - box.width * scale / 2, y: available.minY,
                            width: box.width * scale, height: box.height * scale)
        page.thumbnail(of: NSSize(width: target.width * 2, height: target.height * 2), for: .cropBox)
            .draw(in: target, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    /// Markdown renders as formatted text; other text sources show their lines.
    /// Either way the cited passage is highlighted in the source's colour.
    private func drawTextPreview(_ preview: AssistDocumentPreview, in rect: NSRect) {
        let projectId = suggestions.indices.contains(selected) ? suggestions[selected].projectId : nil
        let sourceColor = DirectoryColorPreferences.color(for: projectId)?.color ?? .controlAccentColor
        let outline = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
        NSColor.textBackgroundColor.withAlphaComponent(0.65).setFill()
        outline.fill()
        // The scrolling text view over it shows the text.
        if previewContent == nil { AssistMarkdown.draw(preview.textBlocks, in: rect, accent: sourceColor) }
        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        outline.stroke()
    }

    /// Draws a table's header with its column letters above each heading,
    /// laid out by AssistTableLayout. Its rows scroll below it in a view of
    /// their own (drawTableRows).
    private func drawTablePreview(_ preview: AssistDocumentPreview, in rect: NSRect) {
        let geometry = tableGeometry(preview, in: rect)
        let roundedTable = NSBezierPath(roundedRect: geometry.table, xRadius: 8, yRadius: 8)
        NSColor.textBackgroundColor.withAlphaComponent(0.65).setFill()
        roundedTable.fill()
        NSGraphicsContext.current?.saveGraphicsState()
        roundedTable.addClip()
        drawTableHeader(preview, layout: geometry.layout, in: geometry.table)
        NSGraphicsContext.current?.restoreGraphicsState()
        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        roundedTable.lineWidth = 0.65
        roundedTable.stroke()
    }

    /// Every row sent, in the scrolling rows view's coordinates: numbers as
    /// the sheet shows them, notes overflowing into empty cells, the cited
    /// cell outlined. A listed column ends with how many of its rows the
    /// server left out.
    private func drawTableRows(in dirtyRect: NSRect) {
        guard let preview, showsTable, let table = previewContent as? AssistTableRowsView else { return }
        let projectId = suggestions.indices.contains(selected) ? suggestions[selected].projectId : nil
        let sourceColor = DirectoryColorPreferences.color(for: projectId)?.color ?? .systemGreen
        let layout = tableGeometry(preview, in: documentPreviewRect).layout
        let width = table.rows.bounds.width
        var y: CGFloat = 0
        var citedOutlines: [NSRect] = []
        for (index, row) in preview.rows.enumerated() where index < layout.rowHeights.count {
            let height = layout.rowHeights[index]
            if y < dirtyRect.maxY, y + height > dirtyRect.minY {
                citedOutlines += drawTableRow(row, layout: layout, in: NSRect(x: 0, y: y, width: width, height: height),
                                              afterGap: layout.startsAfterGap(preview.rows, at: index),
                                              sourceColor: sourceColor)
            }
            y += height
        }
        if layout.rowsBelow > 0 {
            drawRowsBelow(layout.rowsBelow,
                          in: NSRect(x: 0, y: y, width: width, height: AssistTableLayout.moreRowsHeight))
        }
        for outline in citedOutlines {
            sourceColor.withAlphaComponent(0.65).setStroke()
            let path = NSBezierPath(rect: outline.insetBy(dx: 0.5, dy: 0.5))
            path.lineWidth = 0.8
            path.stroke()
        }
    }

    private func drawTableHeader(_ preview: AssistDocumentPreview, layout: AssistTableLayout, in table: NSRect) {
        NSColor.controlBackgroundColor.withAlphaComponent(0.10).setFill()
        NSRect(x: table.minX, y: table.minY, width: table.width, height: layout.headerHeight).fill()
        let padding = AssistTableLayout.cellPadding
        for (index, column) in layout.visibleColumns.enumerated() {
            let letter = column < preview.columns.count ? preview.columns[column] : spreadsheetColumn(column)
            let heading = column < preview.headers.count ? preview.headers[column] : ""
            let alignment: NSTextAlignment = layout.numericColumns.contains(index) ? .right : .left
            let x = table.minX + AssistTableLayout.rowHeaderWidth + layout.offset(of: index)
            let width = layout.columnWidths[index] - 2 * padding
            let top = table.minY + AssistTableLayout.headerTopPadding
            drawText(letter, in: NSRect(x: x + padding, y: top, width: width, height: AssistTableLayout.letterHeight),
                     font: AssistTableLayout.letterFont, color: .tertiaryLabelColor, alignment: alignment)
            let headingTop = top + AssistTableLayout.letterHeight
            drawMultilineText(heading.isEmpty ? "Column \(letter)" : heading,
                              in: NSRect(x: x + padding, y: headingTop, width: width,
                                         height: table.minY + layout.headerHeight - headingTop - 4),
                              font: AssistTableLayout.headingFont, color: .labelColor, alignment: alignment,
                              lineSpacing: 0)
            if index > 0 { drawGridLine(x: x, from: table.minY, to: table.minY + layout.headerHeight) }
        }
    }

    private func drawRowsBelow(_ count: Int, in rect: NSRect) {
        NSColor.separatorColor.withAlphaComponent(0.11).setStroke()
        let line = NSBezierPath()
        line.lineWidth = 0.5
        line.move(to: NSPoint(x: rect.minX, y: rect.minY))
        line.line(to: NSPoint(x: rect.maxX, y: rect.minY))
        line.stroke()
        let rows = count == 1 ? "1 more row" : "\(count) more rows"
        drawText("\(rows) in the file",
                 in: NSRect(x: rect.minX + 8, y: rect.minY + 4, width: rect.width - 16, height: 14),
                 font: NSFont.systemFont(ofSize: 10), color: .secondaryLabelColor, alignment: .center)
    }

    /// Draws one row and returns the outline of its cited cell, if any.
    private func drawTableRow(_ row: AssistPreviewRow, layout: AssistTableLayout, in rect: NSRect,
                              afterGap: Bool, sourceColor: NSColor) -> [NSRect] {
        let padding = AssistTableLayout.cellPadding
        let dataX = rect.minX + AssistTableLayout.rowHeaderWidth
        let cells = layout.cells(in: row)
        let cited = cells.filter { row.cells.indices.contains(layout.visibleColumns[$0.column])
            && row.cells[layout.visibleColumns[$0.column]].cited }
        drawText(row.rowNumber.map(String.init) ?? "\u{2014}",
                 in: NSRect(x: rect.minX, y: rect.minY + 7, width: AssistTableLayout.rowHeaderWidth - 8, height: 14),
                 font: NSFont.systemFont(ofSize: 11), color: cited.isEmpty ? .secondaryLabelColor : sourceColor,
                 alignment: .right)
        if let first = cells.first, !cited.isEmpty {
            sourceColor.withAlphaComponent(0.075).setFill()
            NSRect(x: dataX, y: rect.minY, width: layout.width(of: first), height: rect.height).fill()
        }
        var outlines: [NSRect] = []
        for cell in cells {
            let column = layout.visibleColumns[cell.column]
            let value = row.cells.indices.contains(column) ? row.cells[column] : AssistPreviewCell(value: "", cited: false)
            let cellRect = NSRect(x: dataX + layout.offset(of: cell.column), y: rect.minY,
                                  width: layout.width(of: cell), height: rect.height)
            let font = value.cited ? AssistTableLayout.citedFont : AssistTableLayout.cellFont
            let textRect = NSRect(x: cellRect.minX + padding, y: cellRect.minY + 7,
                                  width: cellRect.width - 2 * padding, height: cellRect.height - 12)
            if value.cited {
                sourceColor.withAlphaComponent(0.025).setFill()
                cellRect.fill()
                outlines.append(cellRect)
            }
            if value.cited && rect.height > layout.rowHeight {
                drawMultilineText(value.value, in: textRect, font: font, color: .labelColor,
                                  alignment: cell.alignment, lineSpacing: 0)
            } else {
                drawText(value.value, in: NSRect(x: textRect.minX, y: textRect.minY, width: textRect.width, height: 14),
                         font: font, color: .labelColor, alignment: cell.alignment)
            }
            if cell.column > 0 { drawGridLine(x: cellRect.minX, from: rect.minY, to: rect.maxY) }
        }
        let line = NSBezierPath()
        line.lineWidth = afterGap ? 1 : 0.5
        // Dashes mark empty sheet rows left out between two shown rows.
        if afterGap { line.setLineDash([3, 2], count: 2, phase: 0) }
        NSColor.separatorColor.withAlphaComponent(afterGap ? 0.3 : 0.11).setStroke()
        line.move(to: NSPoint(x: rect.minX, y: rect.minY))
        line.line(to: NSPoint(x: rect.maxX, y: rect.minY))
        line.stroke()
        drawGridLine(x: dataX, from: rect.minY, to: rect.maxY)
        return outlines
    }

    private func drawGridLine(x: CGFloat, from top: CGFloat, to bottom: CGFloat) {
        NSColor.separatorColor.withAlphaComponent(0.11).setStroke()
        let line = NSBezierPath()
        line.lineWidth = 0.5
        line.move(to: NSPoint(x: x, y: top))
        line.line(to: NSPoint(x: x, y: bottom))
        line.stroke()
    }

    private func spreadsheetColumn(_ index: Int) -> String {
        var current = index
        var label = ""
        repeat {
            label = String(UnicodeScalar(65 + current % 26)!) + label
            current = current / 26 - 1
        } while current >= 0
        return label
    }
}
