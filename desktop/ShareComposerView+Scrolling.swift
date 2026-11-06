// The scrolling table and text preview, whose cells and blocks the person redacts with the mouse.

import Cocoa
import CoreImage

extension ShareComposerView {
    func configureScrollableTable(rows: [[String]], columns: [String], rowNumbers: [String],
                                          headers: [String]?, citations: Set<String>, redactionSheet: Int?,
                                          in rect: NSRect, key: String) {
        showsScrollablePreview = true
        let scroll = previewScroll
        scroll.isHidden = false
        scroll.hasHorizontalScroller = true
        scroll.frame = rect
        scroll.tile()
        let key = "\(key):\(previewRevision):\(scope.rawValue):\(rect.width):\(rect.height)"
        if scrollLayoutKey != key {
            scrollLayoutKey = key
            targets.removeAll()
            redactionDrag = nil
            scrollRows = rows
            scrollColumns = columns
            scrollStyles = []
            scrollStyledText = []
            scrollRowNumbers = rowNumbers
            scrollHeaders = headers
            scrollCitations = citations
            scrollBlocks = []
            scrollRedactionSheet = redactionSheet
            scrollCanRedact = redactionSheet != nil
            let viewport = scroll.contentSize
            let rowHeader: CGFloat = 34
            scrollColumnWidths = columns.indices.map { index in
                var natural = (columns[index] as NSString).size(withAttributes: [.font: scrollFont]).width
                if let headers, index < headers.count {
                    natural = max(natural, (headers[index] as NSString).size(withAttributes: [.font: scrollFont]).width)
                }
                for row in rows where index < row.count {
                    // A sensible maximum width keeps paragraphs readable. Height
                    // grows to display every character instead of truncating it.
                    natural = max(natural, min(260, (row[index] as NSString).size(withAttributes: [.font: scrollFont]).width))
                }
                return min(280, max(110, natural + 18))
            }
            let naturalWidth = rowHeader + scrollColumnWidths.reduce(0, +)
            if naturalWidth < viewport.width, !scrollColumnWidths.isEmpty {
                let extra = (viewport.width - naturalWidth) / CGFloat(scrollColumnWidths.count)
                scrollColumnWidths = scrollColumnWidths.map { $0 + extra }
            }
            var headerHeight: CGFloat = 28
            if let headers {
                headerHeight = max(headerHeight, (columns.indices.map { index in
                    textHeight(index < headers.count ? headers[index] : columns[index],
                               width: scrollColumnWidths[index] - 16,
                               font: .systemFont(ofSize: 11, weight: .semibold))
                }.max() ?? 14) + 16)
            }
            scrollRowHeights = [headerHeight] + rows.map { row in
                max(30, (columns.indices.map { index in
                    textHeight(index < row.count ? row[index] : "", width: scrollColumnWidths[index] - 16)
                }.max() ?? 14) + 16)
            }
            previewCanvas.frame = NSRect(origin: .zero, size: NSSize(
                width: max(viewport.width, rowHeader + scrollColumnWidths.reduce(0, +)),
                height: max(viewport.height, scrollRowHeights.reduce(0, +))))
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        previewCanvas.needsDisplay = true
    }

    func configureScrollableText(_ blocks: [String], styles: [AssistTextBlock] = [],
                                         in rect: NSRect, canRedact: Bool, key: String, lines: Bool = false) {
        showsScrollablePreview = true
        let scroll = previewScroll
        scroll.isHidden = false
        scroll.hasHorizontalScroller = false
        scroll.frame = rect
        scroll.tile()
        let key = "\(key):\(previewRevision):\(scope.rawValue):\(rect.width):\(rect.height)"
        if scrollLayoutKey != key {
            scrollLayoutKey = key
            targets.removeAll()
            redactionDrag = nil
            scrollRows = []
            scrollColumns = []
            scrollBlocks = blocks
            scrollStyles = styles.count == blocks.count ? styles : []
            scrollStyledText = scrollStyles.map { AssistMarkdown.attributed($0, baseSize: 11) }
            scrollCanRedact = canRedact
            scrollLines = lines
            let viewport = scroll.contentSize
            scrollBlockHeights = lines
                ? blocks.map { max(22, textHeight($0, width: viewport.width - 28, font: scrollLineFont) + 8) }
                : scrollStyledText.isEmpty
                ? blocks.map { max(40, textHeight($0, width: viewport.width - 28) + 24) }
                : scrollStyledText.map { max(28, AssistMarkdown.height(of: $0, width: viewport.width - 28) + 16) }
            previewCanvas.frame = NSRect(origin: .zero, size: NSSize(
                width: viewport.width,
                height: max(viewport.height, scrollBlockHeights.reduce(0, +) + CGFloat(max(0, blocks.count - 1)) * scrollBlockGap)))
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        previewCanvas.needsDisplay = true
    }

    func drawScrollablePreview(_ dirtyRect: NSRect) {
        targets.removeAll()
        let visible = previewCanvas.visibleRect
        NSColor.textBackgroundColor.setFill()
        dirtyRect.fill()
        if !scrollColumns.isEmpty {
            let rowHeader: CGFloat = 34
            let headerHeight = scrollRowHeights.first ?? 28
            NSColor.quaternaryLabelColor.withAlphaComponent(0.08).setFill()
            NSRect(x: 0, y: 0, width: previewCanvas.bounds.width, height: headerHeight).fill()
            var x = rowHeader
            for column in scrollColumns.indices {
                let width = scrollColumnWidths[column]
                let title = scrollHeaders.flatMap { column < $0.count ? $0[column] : nil } ?? scrollColumns[column]
                drawText(title.isEmpty ? scrollColumns[column] : title,
                    in: NSRect(x: x + 8, y: 8, width: width - 16, height: headerHeight - 12),
                    font: .systemFont(ofSize: 11, weight: .semibold), color: .secondaryLabelColor, wrap: true)
                x += width
            }
            var y = headerHeight
            for (rowIndex, row) in scrollRows.enumerated() {
                let height = scrollRowHeights[rowIndex + 1]
                defer { y += height }
                guard y < visible.maxY && y + height > visible.minY else { continue }
                drawText(rowIndex < scrollRowNumbers.count ? scrollRowNumbers[rowIndex] : String(rowIndex + 1),
                    in: NSRect(x: 1, y: y + 8, width: rowHeader - 7, height: 16),
                    font: .systemFont(ofSize: 10), color: .secondaryLabelColor, alignment: .right)
                x = rowHeader
                for column in scrollColumns.indices {
                    let cellRect = NSRect(x: x, y: y, width: scrollColumnWidths[column], height: height)
                    x += scrollColumnWidths[column]
                    guard cellRect.intersects(visible) else { continue }
                    let target = ShareHitTarget(rect: cellRect, kind: "CELL", sheet: scrollRedactionSheet,
                                                row: rowIndex, column: column, block: nil)
                    if scrollCanRedact { targets.append(target) }
                    let value = column < row.count ? row[column] : ""
                    let cited = scrollCitations.contains("\(rowIndex):\(column)")
                    if scope == .redacted, scrollCanRedact, let mask = masks[target.key] {
                        drawMask(mask.effect, in: cellRect, value: value)
                    } else {
                        if cited { accentColor.withAlphaComponent(0.12).setFill(); cellRect.fill() }
                        drawText(value, in: cellRect.insetBy(dx: 8, dy: 8),
                                 font: scrollFont, color: .labelColor, wrap: true)
                    }
                    NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
                    line(from: NSPoint(x: cellRect.minX, y: cellRect.maxY),
                         to: NSPoint(x: cellRect.maxX, y: cellRect.maxY))
                }
            }
            NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
            x = rowHeader
            for width in scrollColumnWidths {
                line(from: NSPoint(x: x, y: visible.minY), to: NSPoint(x: x, y: visible.maxY))
                x += width
            }
        } else {
            var y: CGFloat = 0
            for (index, block) in scrollBlocks.enumerated() {
                let targetRect = NSRect(x: 0, y: y, width: previewCanvas.bounds.width, height: scrollBlockHeights[index])
                y += scrollBlockHeights[index] + scrollBlockGap
                guard targetRect.intersects(visible) else { continue }
                let target = ShareHitTarget(rect: targetRect, kind: "BLOCK", sheet: nil, row: nil, column: nil, block: index)
                if scrollCanRedact { targets.append(target) }
                NSColor.controlBackgroundColor.withAlphaComponent(0.25).setFill()
                NSBezierPath(roundedRect: targetRect, xRadius: 6, yRadius: 6).fill()
                let styled = index < scrollStyledText.count ? scrollStyledText[index] : nil
                if scope == .redacted, scrollCanRedact, let mask = masks[target.key] {
                    drawMask(mask.effect, in: targetRect, value: styled?.string ?? block)
                } else if let styled {
                    let content = targetRect.insetBy(dx: 14, dy: 8)
                    if scrollStyles[index].type == "rule" {
                        NSColor.separatorColor.setFill()
                        NSRect(x: content.minX, y: content.midY, width: content.width, height: 1).fill()
                    } else {
                        if scrollStyles[index].type == "quote" {
                            NSColor.tertiaryLabelColor.setFill()
                            NSRect(x: content.minX, y: content.minY, width: 2.5, height: content.height).fill()
                        }
                        styled.draw(with: content, options: [.usesLineFragmentOrigin, .usesFontLeading])
                    }
                } else if scrollLines {
                    drawText(block, in: targetRect.insetBy(dx: 14, dy: 4), font: scrollLineFont, color: .labelColor, wrap: true)
                } else {
                    drawText(block, in: targetRect.insetBy(dx: 14, dy: 12), font: scrollFont, color: .labelColor, wrap: true)
                }
            }
        }
    }

    func previewMouseDown(at point: NSPoint) {
        notice = nil
        guard !isCopying, scope == .redacted, scrollCanRedact,
              previewCanvas.visibleRect.contains(point),
              let target = targets.first(where: { $0.rect.contains(point) }) else { return }
        let anchor = target.redaction(effect: effect)
        let drag = ShareRedactionDrag(anchor: anchor, masks: masks)
        redactionDrag = drag
        beginMaskEdit()
        masks = drag.masks(through: anchor)
        needsDisplay = true
    }

    func previewMouseDragged(at point: NSPoint) { updateRedactionDrag(at: point) }
    func previewMouseUp(at point: NSPoint) {
        updateRedactionDrag(at: point)
        redactionDrag = nil
        endMaskEdit()
    }

    private func drawMask(_ effect: ShareRedactionEffect, in rect: NSRect, value: String,
                          alignment: NSTextAlignment = .left) {
        let bar = NSRect(x: rect.minX + 6, y: rect.midY - 7,
                         width: max(0, rect.width - 12), height: 14)
        if effect == .blank {
            NSColor.black.setFill()
            NSBezierPath(roundedRect: bar, xRadius: 2, yRadius: 2).fill()
            return
        }
        // Rasterize only for this local preview. Shared pages receive safe
        // synthetic masks, never the original redacted text.
        let size = NSSize(width: rect.width, height: min(rect.height, 28))
        let text = value.isEmpty ? "Redacted content" : String(value.prefix(200))
        let key = "\(size.width):\(size.height):\(alignment.rawValue):\(text)"
        var image = blurredMasks[key]
        if image == nil {
            let original = NSImage(size: size, flipped: true) { bounds in
                let paragraph = NSMutableParagraphStyle()
                paragraph.alignment = alignment
                paragraph.lineBreakMode = .byTruncatingTail
                NSAttributedString(string: text, attributes: [
                    .font: NSFont.systemFont(ofSize: 10),
                    .foregroundColor: NSColor.labelColor,
                    .paragraphStyle: paragraph,
                ]).draw(in: NSRect(x: 6, y: bounds.midY - 7,
                                  width: max(0, bounds.width - 12), height: 14))
                return true
            }
            if let data = original.tiffRepresentation, let input = CIImage(data: data),
               let output = Self.blurContext.createCGImage(
                input.clampedToExtent().applyingGaussianBlur(sigma: 3.5).cropped(to: input.extent), from: input.extent) {
                image = NSImage(cgImage: output, size: size)
                if blurredMasks.count >= 128 { blurredMasks.removeAll() }
                blurredMasks[key] = image
            }
        }
        image?.draw(in: NSRect(x: rect.minX, y: rect.midY - size.height / 2,
                              width: size.width, height: size.height), from: .zero,
                    operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}
