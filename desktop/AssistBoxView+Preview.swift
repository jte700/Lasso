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
        if let video = preview.video {
            return AssistVideoPreviewView(video: video, blocks: preview.textBlocks, accent: accent, marking: words)
        }
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
        // On glass the preview's side is only a shade apart from the list's.
        NSColor.controlBackgroundColor.withAlphaComponent(NativeMaterial.surfaceOpacity(classic: 0.32, glass: 0.14)).setFill()
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
                                   width: buttonWidth, height: 35), style: .prominent)
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

    // MARK: A line's words

    static let wordsHintLabel = "Choose words"
    static let wordsHintKey = "⇧fn →"
    static let wordsHintFont = NSFont.systemFont(ofSize: 11, weight: .medium)
    var wordFont: NSFont { .systemFont(ofSize: 13.5) }
    var wordLineSpacing: CGFloat { 4 }

    /// Where a highlighted line's row names the keys that open its words, at
    /// the end of its breadcrumb, in the scrolling rows view's coordinates.
    func wordsHintRect(row index: Int) -> NSRect {
        let font = Self.wordsHintFont
        let width = ceil((Self.wordsHintLabel + "  " + Self.wordsHintKey).size(withAttributes: [.font: font]).width) + 1
        let slotY = CGFloat(index) * suggestionHeight
        return NSRect(x: suggestionRowsRight - 12 - width, y: slotY + 47, width: width, height: 15)
    }

    /// The line's words, below its source and above the keys that choose them.
    var wordTextRect: NSRect {
        let top = bodyTop + navigationHeight + 34
        return NSRect(x: 22, y: top, width: leftWidth - 44, height: footerY - 58 - top)
    }

    struct WordLayout {
        let storage: NSTextStorage
        let manager: NSLayoutManager
        let container: NSTextContainer
        /// Where the laid-out words start in the line, whose leading spaces are not shown.
        let offset: Int
    }

    /// The line from its first word to its last, wrapped to the card, with the
    /// words that Tab inserts in full colour.
    func wordLayout(_ words: AssistWordChoice) -> WordLayout {
        let first = words.words.first?.lowerBound ?? 0, last = words.words.last?.upperBound ?? 0
        let shown = (words.text as NSString).substring(with: NSRange(location: first, length: last - first))
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = wordLineSpacing
        let storage = NSTextStorage(string: shown, attributes: [
            .font: wordFont, .foregroundColor: NSColor.tertiaryLabelColor, .paragraphStyle: paragraph,
        ])
        if let chosen = words.chosenRange {
            storage.addAttribute(.foregroundColor, value: NSColor.labelColor,
                                 range: NSRange(location: chosen.lowerBound - first, length: chosen.count))
        }
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: wordTextRect.width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        return WordLayout(storage: storage, manager: manager, container: container, offset: first)
    }

    /// The caret between words, in the layout's own coordinates.
    func wordCaretRect(_ words: AssistWordChoice, in layout: WordLayout) -> NSRect {
        let length = layout.storage.length
        guard length > 0 else { return .zero }
        let atEnd = words.caret >= words.words.count
        let character = atEnd ? length - 1 : min(length - 1, max(0, words.caretOffset - layout.offset))
        let glyph = layout.manager.glyphIndexForCharacter(at: character)
        let box = layout.manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: layout.container)
        let line = layout.manager.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
        let x = atEnd ? box.maxX + 1 : box.minX - 2
        return NSRect(x: x, y: line.minY, width: 1.5, height: max(1, line.height - wordLineSpacing))
    }

    /// Keeps the caret in view as it moves through a line longer than the card shows.
    func revealWordCaret() {
        guard let words = wordChoice else { return }
        let layout = wordLayout(words)
        let area = wordTextRect
        let caret = wordCaretRect(words, in: layout)
        if caret.maxY - wordScroll > area.height { wordScroll = caret.maxY - area.height }
        if caret.minY < wordScroll { wordScroll = caret.minY }
        let height = layout.manager.usedRect(for: layout.container).height
        wordScroll = min(max(0, wordScroll), max(0, height - area.height))
    }

    /// The word under a point in the line, or the nearest one before it.
    func word(at point: NSPoint) -> Int? {
        guard let words = wordChoice else { return nil }
        let layout = wordLayout(words)
        let area = wordTextRect
        let inLayout = NSPoint(x: point.x - area.minX, y: min(max(point.y, area.minY), area.maxY) - area.minY + wordScroll)
        let character = layout.manager.characterIndex(for: inLayout, in: layout.container,
                                                      fractionOfDistanceBetweenInsertionPoints: nil) + layout.offset
        return words.words.lastIndex { $0.lowerBound <= character } ?? 0
    }

    func scrollWords(by event: NSEvent, at point: NSPoint) -> Bool {
        guard let words = wordChoice, wordTextRect.contains(point) else { return false }
        let layout = wordLayout(words)
        let height = layout.manager.usedRect(for: layout.container).height
        let delta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 17
        wordScroll = min(max(0, wordScroll - delta), max(0, height - wordTextRect.height))
        needsDisplay = true
        return true
    }

    /// In place of the list: where Escape goes back to, how many words are
    /// selected, the line with its selection and caret, and the keys.
    func drawWordChoice(_ words: AssistWordChoice, from suggestion: AssistSuggestion) {
        let navigationFont = NSFont.systemFont(ofSize: 11, weight: .medium)
        drawLabel("‹ Suggestions", key: "esc",
                  in: NSRect(x: 20, y: bodyTop + 10, width: leftWidth - 170, height: 16),
                  font: navigationFont, color: .controlAccentColor)
        let count = words.selection.count
        drawText(count == 0 ? "No words selected" : "\(count) of \(words.words.count) words",
                 in: NSRect(x: leftWidth - 150, y: bodyTop + 10, width: 130, height: 16),
                 font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor, alignment: .right)

        let sourceY = bodyTop + navigationHeight + 6
        drawSourceIcon(for: suggestion.path, in: NSRect(x: 22, y: sourceY, width: 18, height: 18))
        let source = (suggestion.path as NSString).lastPathComponent
        drawText([source.isEmpty ? "Project workspace" : source, suggestion.location]
                    .filter { !$0.isEmpty }.joined(separator: "  ·  "),
                 in: NSRect(x: 47, y: sourceY + 2, width: leftWidth - 69, height: 15),
                 font: .systemFont(ofSize: 11), color: .secondaryLabelColor)

        let area = wordTextRect
        let layout = wordLayout(words)
        let color = DirectoryColorPreferences.color(for: suggestion.projectId)?.color ?? .controlAccentColor
        let origin = NSPoint(x: area.minX, y: area.minY - wordScroll)
        NSGraphicsContext.current?.saveGraphicsState()
        // Highlights reach a little past the text, so the clip does too.
        area.insetBy(dx: -4, dy: -2).clip()
        if let chosen = words.chosenRange {
            let characters = NSRange(location: chosen.lowerBound - layout.offset, length: chosen.count)
            let glyphs = layout.manager.glyphRange(forCharacterRange: characters, actualCharacterRange: nil)
            color.withAlphaComponent(NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? 0.34 : 0.2).setFill()
            layout.manager.enumerateEnclosingRects(forGlyphRange: glyphs,
                                                   withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
                                                   in: layout.container) { rect, _ in
                let line = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height - self.wordLineSpacing)
                NSBezierPath(roundedRect: line.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -3, dy: -1),
                             xRadius: 4, yRadius: 4).fill()
            }
        }
        layout.manager.drawGlyphs(forGlyphRange: layout.manager.glyphRange(for: layout.container), at: origin)
        color.setFill()
        wordCaretRect(words, in: layout).offsetBy(dx: origin.x, dy: origin.y).fill()
        NSGraphicsContext.current?.restoreGraphicsState()

        let hintFont = NSFont.systemFont(ofSize: 10.5)
        drawText("← →  Move a word        ⇧← ⇧→  Select a word",
                 in: NSRect(x: 22, y: footerY - 44, width: leftWidth - 44, height: 15),
                 font: hintFont, color: .secondaryLabelColor)
        drawText("⇧⌘← ⇧⌘→  Select to the start or end, or drag",
                 in: NSRect(x: 22, y: footerY - 26, width: leftWidth - 44, height: 15),
                 font: hintFont, color: .secondaryLabelColor)
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
        NSColor.textBackgroundColor.withAlphaComponent(Self.sheetOpacity).setFill()
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
        NSColor.textBackgroundColor.withAlphaComponent(Self.sheetOpacity).setFill()
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
        let sourceColor = tableSourceColor
        let layout = tableGeometry(preview, in: documentPreviewRect).layout
        let width = table.rows.bounds.width
        let marks = citationMarks(preview, layout: layout)
        // The way into a lone cited cell, under the rows' text: along its row
        // from the number, and down its column from the letter, to the cell's edge.
        if let cell = marks.cell, cell.row < layout.rowHeights.count {
            let top = layout.rowHeights.prefix(cell.row).reduce(0, +)
            let left = AssistTableLayout.rowHeaderWidth + layout.offset(of: cell.column)
            TableCitationMarks.wash(NSRect(x: 0, y: top, width: left, height: layout.rowHeights[cell.row]), color: sourceColor)
            TableCitationMarks.wash(NSRect(x: left, y: 0, width: layout.columnWidths[cell.column], height: top), color: sourceColor)
        }
        var y: CGFloat = 0
        var citedOutlines: [NSRect] = []
        for (index, row) in preview.rows.enumerated() where index < layout.rowHeights.count {
            let height = layout.rowHeights[index]
            if y < dirtyRect.maxY, y + height > dirtyRect.minY {
                let numberMarked = marks.markedRows.contains(index)
                // Without a single cell to lead to, a cited row's number is washed on its own.
                if numberMarked && marks.cell == nil {
                    TableCitationMarks.wash(NSRect(x: 0, y: y, width: AssistTableLayout.rowHeaderWidth, height: height),
                                            color: sourceColor)
                }
                citedOutlines += drawTableRow(row, layout: layout, in: NSRect(x: 0, y: y, width: width, height: height),
                                              afterGap: layout.startsAfterGap(preview.rows, at: index),
                                              sourceColor: sourceColor, numberMarked: numberMarked)
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
        // The cited cell's column letter is marked; its wash leads down into the cell.
        let marked = citationMarks(preview, layout: layout).markedColumns
        for (index, column) in layout.visibleColumns.enumerated() {
            let letter = column < preview.columns.count ? preview.columns[column] : spreadsheetColumn(column)
            let heading = column < preview.headers.count ? preview.headers[column] : ""
            let alignment: NSTextAlignment = layout.numericColumns.contains(index) ? .right : .left
            let x = table.minX + AssistTableLayout.rowHeaderWidth + layout.offset(of: index)
            let width = layout.columnWidths[index] - 2 * padding
            let top = table.minY + AssistTableLayout.headerTopPadding
            let isMarked = marked.contains(index)
            if isMarked {
                TableCitationMarks.wash(NSRect(x: x, y: table.minY, width: layout.columnWidths[index], height: layout.headerHeight),
                                        color: tableSourceColor)
            }
            drawText(letter, in: NSRect(x: x + padding, y: top, width: width, height: AssistTableLayout.letterHeight),
                     font: isMarked ? AssistTableLayout.markedLetterFont : AssistTableLayout.letterFont,
                     color: isMarked ? tableSourceColor : .tertiaryLabelColor, alignment: alignment)
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

    /// Draws one row and returns the outline of its cited cell, if any, with
    /// its number in the source's colour when `numberMarked`.
    private func drawTableRow(_ row: AssistPreviewRow, layout: AssistTableLayout, in rect: NSRect,
                              afterGap: Bool, sourceColor: NSColor, numberMarked: Bool) -> [NSRect] {
        let padding = AssistTableLayout.cellPadding
        let dataX = rect.minX + AssistTableLayout.rowHeaderWidth
        let cells = layout.cells(in: row)
        drawText(row.rowNumber.map(String.init) ?? "\u{2014}",
                 in: NSRect(x: rect.minX, y: rect.minY + 7, width: AssistTableLayout.rowHeaderWidth - 8, height: 14),
                 font: NSFont.systemFont(ofSize: 11, weight: numberMarked ? .semibold : .regular),
                 color: numberMarked ? sourceColor : .secondaryLabelColor, alignment: .right)
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

    /// How solid a table or text preview's page is: steady under small text,
    /// and on glass a little clearer so the card still reads as glass.
    static var sheetOpacity: CGFloat { NativeMaterial.surfaceOpacity(classic: 0.65, glass: 0.5) }

    /// The colour cited cells are marked in: their directory's.
    private var tableSourceColor: NSColor {
        DirectoryColorPreferences.color(for: selectedSuggestion?.projectId)?.color ?? .systemGreen
    }

    /// The table's citation marks: the row and the column leading into a lone cited cell.
    private func citationMarks(_ preview: AssistDocumentPreview, layout: AssistTableLayout) -> TableCitationMarks {
        TableCitationMarks(rows: Array(preview.rows.prefix(layout.rowHeights.count)), visibleColumns: layout.visibleColumns)
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
