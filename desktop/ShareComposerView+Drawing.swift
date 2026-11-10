// The composer's chrome, header, scope cards, preview frame, footer and the drawing helpers they share.

import Cocoa

extension ShareComposerView {
    override func draw(_ dirtyRect: NSRect) {
        showsScrollablePreview = false
        showsPDFPreview = false
        showsSlideMenu = false
        sheetTabTargets.removeAll()
        drawingLayout = nil
        shownModel = nil
        NSGraphicsContext.current?.cgContext.clear(bounds)
        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(roundedRect: bounds, xRadius: ShareComposerSurface.cornerRadius,
                     yRadius: ShareComposerSurface.cornerRadius).addClip()
        drawChrome()
        drawHeader()
        drawScopes()
        drawPreview()
        drawFooter()
        NSGraphicsContext.current?.restoreGraphicsState()
        previewScroll.isHidden = !showsScrollablePreview
        pdfView.isHidden = !showsPDFPreview
        slideNavigator?.bar.isHidden = !showsSlideMenu
        if !showsScrollablePreview { targets.removeAll() }
    }

    private func drawChrome() {
        let body = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 14, yRadius: 14)
        NSColor.windowBackgroundColor.withAlphaComponent(NativeMaterial.surfaceOpacity(classic: 0.94)).setFill()
        body.fill()
        // Liquid Glass draws its own edge.
        if !NativeMaterial.usesGlass {
            NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
            body.lineWidth = 0.65
            body.stroke()
        }

        NSColor.separatorColor.withAlphaComponent(0.09).setStroke()
        line(from: NSPoint(x: 0, y: bounds.height - footerHeight),
             to: NSPoint(x: bounds.width, y: bounds.height - footerHeight))
    }

    private func drawHeader() {
        drawText(filename, in: NSRect(x: 18, y: 13, width: bounds.width - 65, height: 19),
                 font: .systemFont(ofSize: 13, weight: .semibold), color: .labelColor)
        drawSymbol("xmark", in: NSRect(x: bounds.width - 30, y: 16, width: 11, height: 11), fraction: 1,
                   color: .secondaryLabelColor)
    }

    private func drawScopes() {
        let entries: [(ShareAccessScope, String, String)] = scopes.map { scope in
            switch scope {
            case .document: return (scope, isPresentation ? "Entire presentation" : "Entire document",
                                    isPresentation ? "Every slide, and the original file" : "Include the original file")
            case .indexed: return (scope, isPresentation ? "Cited slide only" : "Cited part only",
                                   isCADModel ? "The part, its feature marked"
                                   : isPresentation ? "A picture of this slide" : "Share the matched context")
            case .redacted: return (scope, "Select & redact", "Hide source content")
            case .marked: return (scope, "Mark up", "Pen, marker and highlighter")
            }
        }
        // A segmented control, as System Settings draws one across a pane, with
        // what the chosen scope shares written under it.
        drawSegmentedControl(entries.enumerated().map { ($0.element.1, scope == $0.element.0, scopeRect($0.offset)) },
                             fontSize: 12.5)
        if let chosen = entries.first(where: { $0.0 == scope }), let first = entries.indices.first {
            let control = scopeRect(first).union(scopeRect(entries.count - 1))
            drawText(chosen.2, in: NSRect(x: control.minX, y: control.maxY + 6, width: control.width, height: 15),
                     font: .systemFont(ofSize: 11), color: .secondaryLabelColor, alignment: .center)
        }
    }

    private func drawPreview() {
        // Resolved while drawing, so the frame follows light and dark appearance.
        previewScroll.layer?.borderColor = NSColor.separatorColor.cgColor
        let x: CGFloat = 16
        let isPDF = isPDFSource
        drawText(scope == .indexed ? "Recipient preview"
                 : scope == .marked ? (isPresentation ? "Slides to mark up" : "Pages to mark up") : "Complete document",
                 in: NSRect(x: x + 2, y: 108, width: 170, height: 16),
                 font: .systemFont(ofSize: 11, weight: .semibold), color: .secondaryLabelColor)

        if scope == .marked {
            drawMarkupPalette()
        } else if scope == .redacted {
            drawSegmentedControl([("Blur", effect == .blur, blurEffectRect), ("Redact", effect == .blank, redactEffectRect)])
        } else if offersNearbyRows {
            drawNearbyRowsSwitch()
        } else {
            let badge = scope == .document ? "Original available" : "Original protected"
            drawPill(badge, in: NSRect(x: bounds.width - 125, y: 105, width: 109, height: 20))
        }
        if isPDF && scope == .redacted {
            drawButton("Select text", in: pdfTextModeRect, prominent: pdfSelectionMode == .text, enabled: !isCopying, showsShortcut: false)
            drawButton("Mark area", in: pdfAreaModeRect, prominent: pdfSelectionMode == .area, enabled: !isCopying, showsShortcut: false)
        }

        let card = previewCard
        NSColor.controlBackgroundColor.withAlphaComponent(0.65).setFill()
        NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).fill()
        NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
        NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).stroke()

        drawText(label, in: NSRect(x: card.minX + 13, y: card.minY + 12,
                                  width: card.width - 26, height: 17),
                 font: .systemFont(ofSize: 12.5, weight: .semibold), color: .labelColor)
        let drawing = fullDocument?.model != nil
        let subtitle = scope == .marked ? "Draw with the pen, marker or highlighter. The eraser takes a mark away."
            : scope == .redacted ? (drawing || isPDF ? "Drag over text or mark an area. Click a mask to remove it." : "Drag across cells or sections to blur or redact.") : scope == .indexed
            ? (citedPart.map(\.selectedLabel) ?? (preview?.location.isEmpty == false ? preview!.location : filename))
            : "Complete \(filename)"
        drawText(subtitle, in: NSRect(x: card.minX + 13, y: card.minY + 31,
                                     width: card.width - 26, height: 15),
                 font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor)

        let content = NSRect(x: card.minX + 13, y: card.minY + 55,
                             width: card.width - 26, height: card.height - 68)
        if scope == .marked {
            drawMarkupContent(in: content)
        } else if isPDF {
            drawPDFContent(in: content)
        } else if let slideDecks {
            // The recipient gets the cited slide alone, or every slide.
            let cited = scope == .indexed ? slideDecks.cited : nil
            drawSlides(cited ?? slideDecks.all, opening: preview?.slideNumber ?? 1, marking: false, in: content)
        } else if scope != .indexed {
            if isDocumentLoading {
                drawCentered("Loading complete document…", in: content)
            } else if let fullDocument {
                drawFullDocument(fullDocument, in: content)
            } else {
                drawCentered("Complete document preview unavailable", in: content)
            }
        } else if isCADModel, let citedPart {
            drawRotatable(citedPart, in: content)
        } else if isPresentation, let preview, !preview.textBlocks.isEmpty {
            // While the slide's picture is on its way, or if it cannot be drawn, its words stand in.
            AssistMarkdown.draw(preview.textBlocks, in: content, accent: highlightColor, baseSize: 11.5)
        } else if isLoading {
            drawCentered("Loading source preview…", in: content)
        } else if let preview, !preview.rows.isEmpty {
            drawTable(publishedTable ?? preview, in: content)
        } else if let preview, preview.model != nil {
            let context = [preview.valueText, preview.context].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
            drawTextBlocks(context, in: NSRect(x: content.minX, y: content.minY, width: content.width, height: max(50, content.height - 48)))
            drawText("Choose Entire document or Select & redact to include the drawing.",
                     in: NSRect(x: content.minX + 4, y: content.maxY - 38, width: content.width - 8, height: 34),
                     font: .systemFont(ofSize: 10), color: .secondaryLabelColor, wrap: true)
        } else if let preview {
            // The indexed scope publishes the object's recorded excerpt, so
            // that is what the recipient preview shows.
            let excerpt = preview.valueText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            drawTextBlocks(excerpt.isEmpty ? preview.context : excerpt, in: content)
        } else {
            drawCentered("Preview unavailable", in: content)
        }

    }

    func drawCentered(_ value: String, in rect: NSRect) {
        drawText(value, in: NSRect(x: rect.minX + 8, y: rect.midY - 20,
                                   width: max(0, rect.width - 16), height: 44),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor, alignment: .center, wrap: true)
    }

    var blurEffectRect: NSRect { NSRect(x: bounds.width - 136, y: 103, width: 60, height: 24) }
    var redactEffectRect: NSRect { NSRect(x: bounds.width - 76, y: 103, width: 60, height: 24) }

    var pdfTextModeRect: NSRect { NSRect(x: 200, y: 103, width: 78, height: 24) }
    var pdfAreaModeRect: NSRect { NSRect(x: 284, y: 103, width: 78, height: 24) }

    private func drawFooter() {
        let centerY = bounds.height - footerHeight / 2
        let detail: String
        switch scope {
        case .document: detail = "Recipients can download the pinned original."
        case .indexed: detail = isCADModel ? "Only the cited part is published, not the model file."
            : isPresentation ? "Only a picture of this slide is published." : "Only indexed context is published."
        case .redacted: detail = masks.isEmpty ? "Select at least one area to redact." : "\(masks.count) area\(masks.count == 1 ? "" : "s") removed from the shared view."
        case .marked: detail = markup.marks.isEmpty ? "Draw on the pages to mark them up."
            : "A copy with \(markup.marks.count) mark\(markup.marks.count == 1 ? "" : "s") is shared, not the original."
        }
        drawSymbol("lock.shield", in: NSRect(x: 18, y: centerY - 8, width: 16, height: 16), fraction: 0.8,
                   color: .secondaryLabelColor)
        let availability = localOnly ? "Only on this Mac. Email recipients need hosted sharing." : detail
        let message = notice ?? availability
        let font = NSFont.systemFont(ofSize: 11)
        let textWidth = max(0, cancelButtonRect.minX - 56)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
        let height = min(30, ceil((message as NSString).boundingRect(
            with: NSSize(width: textWidth, height: 30), options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes).height))
        let noteHeight: CGFloat = 14
        let top = centerY - (height + 2 + noteHeight) / 2
        drawText(message, in: NSRect(x: 42, y: top, width: textWidth, height: height),
                 font: font, color: notice == nil ? .secondaryLabelColor : .systemRed, wrap: true)
        drawText(Self.linkLifetimeNote, in: NSRect(x: 42, y: top + height + 2, width: textWidth, height: noteHeight),
                 font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor)

        drawButton(copyState == .copied ? "Done" : "Cancel", in: cancelButtonRect, prominent: false, enabled: true)
        let enabled = canSubmit
        let title = copyState == .copied ? "Link copied" : isCopying ? "Copying…" : actionTitle
        drawButton(title, in: actionButtonRect, prominent: true, enabled: enabled,
                   confirmed: copyState == .copied, showsShortcut: !isCopying)
    }

    /// The raised segment of a segmented control: white in light, a lifted grey in dark.
    private static let segmentKnob = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(white: 0.39, alpha: 1) : .white
    }

    /// Adjacent segments in one track, like NSSegmentedControl: a capsule on
    /// macOS 26, a rounded rectangle before it.
    func drawSegmentedControl(_ segments: [(title: String, selected: Bool, rect: NSRect)], fontSize: CGFloat = 11) {
        guard let first = segments.first?.rect else { return }
        let track = segments.dropFirst().reduce(first) { $0.union($1.rect) }
        let trackRadius = NativeMaterial.usesGlass ? track.height / 2 : 7
        let inset: CGFloat = 2
        let knobRadius = max(0, trackRadius - inset)
        let increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        NSColor.labelColor.withAlphaComponent(increaseContrast ? 0.14 : 0.07).setFill()
        let trackPath = NSBezierPath(roundedRect: track, xRadius: trackRadius, yRadius: trackRadius)
        trackPath.fill()
        if increaseContrast {
            NSColor.separatorColor.setStroke()
            trackPath.lineWidth = 0.5
            trackPath.stroke()
        }
        let font = NSFont.systemFont(ofSize: fontSize, weight: .medium)
        let textHeight = ceil(font.ascender - font.descender)
        for (index, segment) in segments.enumerated() {
            if segment.selected {
                let knob = segment.rect.insetBy(dx: inset, dy: inset)
                let knobPath = NSBezierPath(roundedRect: knob, xRadius: knobRadius, yRadius: knobRadius)
                NSGraphicsContext.saveGraphicsState()
                let shadow = NSShadow()
                shadow.shadowColor = NSColor.black.withAlphaComponent(0.2)
                shadow.shadowBlurRadius = 2
                shadow.shadowOffset = NSSize(width: 0, height: -0.5)
                shadow.set()
                Self.segmentKnob.setFill()
                knobPath.fill()
                NSGraphicsContext.restoreGraphicsState()
                NSColor.black.withAlphaComponent(increaseContrast ? 0.3 : 0.06).setStroke()
                knobPath.lineWidth = 0.5
                knobPath.stroke()
            } else if index > 0, !segments[index - 1].selected {
                // A divider only between two unchosen segments, as AppKit draws it.
                NSColor.separatorColor.setStroke()
                line(from: NSPoint(x: segment.rect.minX, y: segment.rect.minY + 7),
                     to: NSPoint(x: segment.rect.minX, y: segment.rect.maxY - 7))
            }
            drawText(segment.title, in: NSRect(x: segment.rect.minX + 6, y: segment.rect.midY - textHeight / 2,
                                               width: segment.rect.width - 12, height: textHeight),
                     font: font, color: .labelColor, alignment: .center)
        }
    }

    private func drawPill(_ title: String, in rect: NSRect) {
        NSColor.labelColor.withAlphaComponent(0.05).setFill()
        NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
        drawText(title, in: NSRect(x: rect.minX + 6, y: rect.minY + 4,
                                  width: rect.width - 12, height: 13),
                 font: .systemFont(ofSize: 10, weight: .medium), color: .secondaryLabelColor,
                 alignment: .center)
    }

    private func drawButton(_ title: String, in rect: NSRect, prominent: Bool, enabled: Bool,
                            confirmed: Bool = false, showsShortcut: Bool = true) {
        // Capsules, as the suggestion card's buttons: the main action is a white
        // pill lifted off the glass, the other sits back in a soft grey one.
        let height = min(rect.height, 32)
        let pill = NSRect(x: rect.minX, y: rect.midY - height / 2, width: rect.width, height: height)
        let path = NSBezierPath(roundedRect: pill, xRadius: height / 2, yRadius: height / 2)
        let increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        let color: NSColor
        if prominent {
            NSGraphicsContext.saveGraphicsState()
            if enabled {
                let shadow = NSShadow()
                shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
                shadow.shadowBlurRadius = 3
                shadow.shadowOffset = NSSize(width: 0, height: -1)
                shadow.set()
            }
            NSColor.white.withAlphaComponent(enabled ? 1 : 0.45).setFill()
            path.fill()
            NSGraphicsContext.restoreGraphicsState()
            NSColor.black.withAlphaComponent(increaseContrast ? 0.35 : 0.08).setStroke()
            path.lineWidth = 0.5
            path.stroke()
            color = NSColor(white: 0.1, alpha: enabled ? 1 : 0.4)
        } else {
            NSColor.labelColor.withAlphaComponent(increaseContrast ? 0.16 : 0.08).setFill()
            path.fill()
            if increaseContrast {
                NSColor.separatorColor.setStroke()
                path.lineWidth = 0.5
                path.stroke()
            }
            color = enabled ? .labelColor : .disabledControlTextColor
        }
        let font = NSFont.systemFont(ofSize: 12, weight: prominent ? .semibold : .medium)
        let titleSize = (title as NSString).size(withAttributes: [.font: font])
        let hasSymbol = prominent && showsShortcut
        let groupWidth = titleSize.width + (hasSymbol ? 22 : 0)
        let titleX = rect.midX - groupWidth / 2
        drawText(title, in: NSRect(x: titleX, y: rect.midY - titleSize.height / 2,
                                  width: titleSize.width + 1, height: titleSize.height), font: font, color: color)
        if hasSymbol {
            drawText(confirmed ? "✓" : "⇥", in: NSRect(x: titleX + titleSize.width + 10, y: rect.midY - titleSize.height / 2,
                                    width: 13, height: titleSize.height), font: font, color: color.withAlphaComponent(0.8))
        }
    }

    func drawSymbol(_ name: String, in rect: NSRect, fraction: CGFloat, color: NSColor? = nil) {
        guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil),
              let image = symbol.withSymbolConfiguration(.init(paletteColors: [color ?? .secondaryLabelColor])) else { return }
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: fraction,
                   respectFlipped: true, hints: nil)
    }

    func line(from: NSPoint, to: NSPoint) {
        let path = NSBezierPath()
        path.lineWidth = 0.5
        path.move(to: from)
        path.line(to: to)
        path.stroke()
    }

    /// Draws an SF Symbol centered in `rect`, in the given color.
    func drawSymbol(_ name: String, in rect: NSRect, color: NSColor) {
        let configuration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
            .applying(.init(paletteColors: [color]))
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration) else { return }
        let size = image.size
        image.draw(in: NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2,
                              width: size.width, height: size.height),
                   from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    func drawText(_ value: String, in rect: NSRect, font: NSFont, color: NSColor,
                          alignment: NSTextAlignment = .left, wrap: Bool = false) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = wrap ? .byWordWrapping : .byTruncatingTail
        NSAttributedString(string: value, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
        ]).draw(with: rect, options: [.usesLineFragmentOrigin, .usesFontLeading])
    }
}

extension ShareComposerView {
    /// Where the "Nearby rows" switch sits: the heading line's right end, in place of the scope's badge.
    var nearbyRowsRect: NSRect { NSRect(x: bounds.width - 150, y: 103, width: 134, height: 24) }

    /// A cited cell or row can bring the rows around it; a column or a passage cannot.
    var offersNearbyRows: Bool { scope == .indexed && nearbyExcerpt?.rows.isEmpty == false }

    /// The table "Cited part only" publishes as the switch stands, when the server sent one.
    var publishedTable: AssistDocumentPreview? {
        let table = offersNearbyRows && includesNearbyRows ? nearbyExcerpt : sharedExcerpt
        return table.flatMap { $0.rows.isEmpty ? nil : $0 }
    }

    /// A small grey switch, like the rest of the composer's chrome, with its title before it.
    func drawNearbyRowsSwitch() {
        let rect = nearbyRowsRect
        drawText("Nearby rows", in: NSRect(x: rect.minX, y: rect.minY + 4, width: rect.width - 38, height: 16),
                 font: .systemFont(ofSize: 11, weight: .medium), color: .secondaryLabelColor, alignment: .right)
        let track = NSRect(x: rect.maxX - 30, y: rect.minY + 4, width: 28, height: 16)
        NSColor.labelColor.withAlphaComponent(includesNearbyRows ? 0.55 : 0.14).setFill()
        NSBezierPath(roundedRect: track, xRadius: 8, yRadius: 8).fill()
        let knob = NSRect(x: includesNearbyRows ? track.maxX - 15 : track.minX + 1, y: track.minY + 1, width: 14, height: 14)
        NSColor.white.setFill()
        NSBezierPath(ovalIn: knob).fill()
    }
}
