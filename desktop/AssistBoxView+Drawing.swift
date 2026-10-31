// The card's chrome, suggestion rows, footer and the drawing helpers they share.

import Cocoa
import UniformTypeIdentifiers

extension AssistBoxView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        bounds.fill()
        drawBubbleChrome()

        if mode != .suggestions {
            drawText("Lasso", in: NSRect(x: 14, y: bodyTop + 11, width: 46, height: 17),
                     font: NSFont.systemFont(ofSize: 11.5, weight: .semibold), color: .labelColor)
            // The share question is the header, so the choices below it read as answers.
            let context = mode == .confirmShare || sourceScoped
                ? title.replacingOccurrences(of: "_", with: " ") : "Project sources"
            drawText(context, in: NSRect(x: 64, y: bodyTop + 11, width: leftWidth - 118, height: 17),
                     font: NSFont.systemFont(ofSize: 10.5), color: .secondaryLabelColor)
            drawSeparator(at: bodyTop + headerHeight)
        }

        var y = bodyTop + (mode == .suggestions ? 0 : headerHeight)
        switch mode {
        case .suggestions:
            let navigationFont = NSFont.systemFont(ofSize: 11, weight: .medium)
            // Clear of the row counter when it shows.
            let width = suggestions.count > visibleSuggestionCount ? leftWidth - 170 : leftWidth - 40
            // fn+Right opens the highlighted row when it has values below it.
            let narrowsInto = suggestions.indices.contains(selected) && suggestions[selected].narrowable
                ? suggestions[selected].label : nil
            if sourceScoped {
                drawLabel("‹ \(stepBackName ?? "All sources")", key: "fn ←",
                          in: NSRect(x: 20, y: bodyTop + 10, width: width, height: 16),
                          font: navigationFont, color: .controlAccentColor)
            } else if let diveName = narrowsInto ?? returnFocusName {
                drawLabel("Dive into \(diveName)", key: "fn →",
                          in: NSRect(x: 20, y: bodyTop + 10, width: width, height: 16),
                          font: navigationFont, color: .secondaryLabelColor)
            } else {
                drawText("All sources", in: NSRect(x: 20, y: bodyTop + 10, width: 130, height: 16),
                         font: navigationFont, color: .secondaryLabelColor)
            }
            if suggestions.count > visibleSuggestionCount {
                drawText("↑↓  \(selected + 1) of \(suggestions.count)",
                         in: NSRect(x: leftWidth - 150, y: bodyTop + 10, width: 130, height: 16),
                         font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor,
                         alignment: .right)
            }
            if suggestions.isEmpty {
                drawText("No matching indexed source",
                         in: NSRect(x: 22, y: bodyTop + 29,
                                   width: leftWidth - 44, height: 17),
                         font: NSFont.systemFont(ofSize: 11), color: .secondaryLabelColor)
            }

        case .confirmShare:
            for (index, choice) in confirmChoices.enumerated() {
                let row = NSRect(x: 0, y: y, width: bounds.width, height: choiceHeight)
                if index == selected { drawSelectedSurface(in: row.insetBy(dx: 5, dy: 3)) }
                drawText(choice, in: NSRect(x: 14, y: row.minY + 12,
                         width: row.width - 28, height: 17),
                         font: NSFont.systemFont(ofSize: 11.5, weight: .medium), color: .labelColor)
                y += choiceHeight
                if index < confirmChoices.count - 1 { drawInsetSeparator(at: y, from: 14) }
            }

        case .message:
            for line in messageLines {
                drawText(line, in: NSRect(x: 14, y: y + 7, width: bounds.width - 28, height: 17),
                         font: NSFont.systemFont(ofSize: 11), color: .secondaryLabelColor)
                y += messageHeight
            }
        }

        guard mode != .message else { return }
        drawSeparator(at: footerY)
        if mode == .suggestions {
            drawFooterActions()
            drawDocumentPreview(footerY: footerY)
        } else {
            drawText("↑↓  Move       ↩  Choose       Esc  Cancel",
                     in: NSRect(x: 18, y: footerY + 24, width: leftWidth - 36, height: 18),
                     font: NSFont.systemFont(ofSize: 11), color: .secondaryLabelColor)
        }
    }

    /// Every suggestion's row, in the scrolling rows view's coordinates.
    func drawSuggestionRows(in dirtyRect: NSRect) {
        guard mode == .suggestions else { return }
        // While the list has a scroller, the rows end short of it.
        let hasScroller = suggestionRows.bounds.width < leftWidth
        let right = hasScroller ? suggestionRows.bounds.width - scrollerGap : leftWidth - 10
        for (index, suggestion) in suggestions.enumerated() {
            let slotY = CGFloat(index) * suggestionHeight
            guard slotY < dirtyRect.maxY, slotY + suggestionHeight + listBottomPadding > dirtyRect.minY else { continue }
            let selection = NSRect(x: 10, y: slotY + 13,
                                   width: right - 10, height: 63)
            if index == selected {
                drawSelectedSurface(in: selection,
                    color: DirectoryColorPreferences.color(for: suggestion.projectId)?.color ?? .controlAccentColor)
            }

            drawSourceIcon(for: suggestion.path,
                           in: NSRect(x: 22, y: slotY + 26, width: 32, height: 32))

            let detailWidth: CGFloat = suggestion.detail.isEmpty ? 0 : 82
            drawText(suggestion.label,
                     in: NSRect(x: 65, y: slotY + 27,
                               width: right - 75 - detailWidth, height: 17),
                     font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
                     color: .labelColor)
            if !suggestion.detail.isEmpty {
                drawText(suggestion.detail,
                         in: NSRect(x: right - detailWidth - 10, y: slotY + 27,
                                   width: detailWidth, height: 17),
                         font: NSFont.systemFont(ofSize: 11.5, weight: .semibold),
                         color: .labelColor, alignment: .right)
            }
            let source = (suggestion.path as NSString).lastPathComponent
            let breadcrumb = [suggestion.rankingReason ?? "", source.isEmpty ? "Project workspace" : source, suggestion.location]
                .filter { !$0.isEmpty }.joined(separator: "  ·  ")
            drawText(breadcrumb,
                     in: NSRect(x: 65, y: slotY + 47,
                               width: right - 77, height: 15),
                     font: NSFont.systemFont(ofSize: 11),
                     color: .secondaryLabelColor)
            if index < suggestions.count - 1 {
                drawInsetSeparator(at: 6 + CGFloat(index + 1) * suggestionHeight, from: 26,
                                   to: hasScroller ? right : nil)
            }
        }
    }

    private func drawSelectedSurface(in rect: NSRect, color: NSColor = .controlAccentColor) {
        color.withAlphaComponent(
            NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? 0.30 : 0.16).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10).fill()
        color.withAlphaComponent(0.45).setStroke()
        let outline = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        outline.lineWidth = 0.75
        outline.stroke()
    }

    private func drawBubbleChrome() {
        // Keep the system glass visible; an opaque painted gradient defeats it.
        // A semantic content tint keeps text readable over every host document.
        // Glass still provides the edge, depth, and surrounding material.
        let opacity: CGFloat = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency ? 1 : 0.88
        NSColor.windowBackgroundColor.withAlphaComponent(opacity).setFill()
        NSBezierPath(roundedRect: bodyRect, xRadius: bubbleCornerRadius,
                     yRadius: bubbleCornerRadius).fill()
        NSColor.separatorColor.setStroke()
        let outline = NSBezierPath(roundedRect: bodyRect.insetBy(dx: 0.5, dy: 0.5),
                                   xRadius: bubbleCornerRadius, yRadius: bubbleCornerRadius)
        outline.lineWidth = 0.5
        outline.stroke()
    }

    enum FooterCommand { case tab, insertText, share }
    private struct FooterAction {
        let symbol: String
        let symbolWidth: CGFloat
        let title: String
        let command: FooterCommand
    }

    /// Only shortcuts that do something different are listed. With plain-text
    /// insertion, Tab and ⌘↩ do the same thing, so ⌘↩ is not shown twice.
    private var footerActions: [FooterAction] {
        let suggestion = suggestions.indices.contains(selected) ? suggestions[selected] : nil
        // Spaces that code's colon takes the place of are not words replaced.
        let replacesWords = suggestion?.replacement?.expectedText.trimmingCharacters(in: .whitespaces).isEmpty == false
        let insertTitle = replacesWords ? "Replace" : "Insert"
        let shareable = suggestion?.isShareable == true
        let mode = shareable ? InsertionMode.current : .plain
        let tabTitle = mode == .share ? "Share…" : mode == .ask ? "Text or link…" : insertTitle
        var actions = [FooterAction(symbol: "⇥", symbolWidth: 18, title: tabTitle, command: .tab)]
        if mode != .plain {
            actions.append(FooterAction(symbol: "⌘↩", symbolWidth: 29, title: insertTitle, command: .insertText))
        }
        if shareable && mode != .share {
            actions.append(FooterAction(symbol: "⇧⌘↩", symbolWidth: 36, title: "Share…", command: .share))
        }
        return actions
    }

    private func drawFooterActions() {
        for (action, x) in zip(footerActions, footerSlots) {
            drawShortcut(action.symbol, title: action.title, x: x, y: footerY + 18, symbolWidth: action.symbolWidth)
        }
    }

    func footerCommand(at x: CGFloat) -> FooterCommand? {
        let actions = footerActions
        let slot = footerSlots.lastIndex(where: { x >= $0 }) ?? 0
        return actions.indices.contains(slot) ? actions[slot].command : nil
    }

    private func drawShortcut(_ symbol: String, title: String, x: CGFloat, y: CGFloat,
                              symbolWidth: CGFloat) {
        drawText(symbol, in: NSRect(x: x, y: y - 1, width: symbolWidth, height: 17),
                 font: NSFont.systemFont(ofSize: 12.5),
                 color: .tertiaryLabelColor, alignment: .center)
        drawText(title, in: NSRect(x: x + symbolWidth + 6, y: y, width: 88, height: 17),
                 font: NSFont.systemFont(ofSize: 11),
                 color: .secondaryLabelColor)
    }

    func drawSourceIcon(for path: String, in rect: NSRect) {
        let type = UTType(filenameExtension: (path as NSString).pathExtension) ?? .data
        let image = NSWorkspace.shared.icon(for: type)
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1,
                   respectFlipped: true, hints: nil)
    }

    func drawActionButton(_ title: String, symbol: String, in rect: NSRect) {
        NSColor.controlBackgroundColor.withAlphaComponent(0.65).setFill()
        let path = NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7)
        path.fill()
        NSColor.separatorColor.withAlphaComponent(0.18).setStroke()
        path.lineWidth = 0.6
        path.stroke()

        let font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        let titleWidth = ceil((title as NSString).size(withAttributes: [.font: font]).width)
        let groupWidth = CGFloat(14 + 8) + titleWidth
        let groupX = rect.midX - groupWidth / 2
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [.secondaryLabelColor])) {
            image.isTemplate = false
            image.draw(in: NSRect(x: groupX, y: rect.minY + 10.5,
                                  width: 14, height: 14),
                       from: .zero, operation: .sourceOver, fraction: 0.68,
                       respectFlipped: true, hints: nil)
        }
        drawText(title,
                 in: NSRect(x: groupX + 22, y: rect.minY + 9.5,
                           width: titleWidth + 2, height: 17),
                 font: font, color: .labelColor)
    }

    func drawMultilineText(_ value: String, in rect: NSRect, font: NSFont, color: NSColor,
                                   alignment: NSTextAlignment = .left, lineSpacing: CGFloat = 3) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = lineSpacing
        NSAttributedString(string: value, attributes: [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ]).draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    private func drawSeparator(at y: CGFloat) { drawInsetSeparator(at: y, from: 0) }

    private func drawInsetSeparator(at y: CGFloat, from x: CGFloat, to end: CGFloat? = nil) {
        NSColor.separatorColor.setStroke()
        let path = NSBezierPath()
        path.lineWidth = 0.5
        path.move(to: NSPoint(x: x, y: y))
        path.line(to: NSPoint(x: end ?? (mode == .suggestions ? leftWidth : bounds.width), y: y))
        path.stroke()
    }

    func drawText(_ value: String, in rect: NSRect, font: NSFont, color: NSColor,
                          alignment: NSTextAlignment = .left) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = .byTruncatingTail
        paragraph.maximumLineHeight = rect.height
        NSAttributedString(string: value, attributes: [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ]).draw(in: rect)
    }

    /// A label followed by its key. A long label is shortened, never the key.
    private func drawLabel(_ label: String, key: String, in rect: NSRect, font: NSFont, color: NSColor) {
        let keyText = "  " + key
        let keyWidth = ceil(keyText.size(withAttributes: [.font: font]).width)
        let labelWidth = min(ceil(label.size(withAttributes: [.font: font]).width), rect.width - keyWidth)
        drawText(label, in: NSRect(x: rect.minX, y: rect.minY, width: labelWidth, height: rect.height),
                 font: font, color: color)
        drawText(keyText, in: NSRect(x: rect.minX + labelWidth, y: rect.minY, width: keyWidth, height: rect.height),
                 font: font, color: color)
    }
}
