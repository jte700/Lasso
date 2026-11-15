// The pill buttons Lasso draws on its cards and in the passage picker: the
// main action a white capsule with a soft shadow, in light and dark alike,
// the others a faint grey capsule, each with its symbol before its title.

import Cocoa

enum AssistPill {
    /// How much a button asks to be pressed.
    enum Style { case prominent, secondary }
    static let height: CGFloat = 30
    private static let symbolSize: CGFloat = 13
    private static let symbolGap: CGFloat = 7

    static func font(_ style: Style) -> NSFont {
        NSFont.systemFont(ofSize: 12, weight: style == .prominent ? .semibold : .medium)
    }

    /// How wide a pill must be to hold its symbol and title with room either side.
    static func width(_ title: String, style: Style, padding: CGFloat = 18) -> CGFloat {
        ceil((title as NSString).size(withAttributes: [.font: font(style)]).width) + symbolSize + symbolGap + padding * 2
    }

    /// A capsule button, as macOS draws its pill buttons, centred in `rect`.
    /// `glyph`, when given, is a key's own mark ("⇥") drawn in the rounded face in place of the symbol.
    static func draw(_ title: String, symbol: String, in rect: NSRect, style: Style, glyph: String? = nil) {
        let pill = NSRect(x: rect.minX, y: rect.midY - height / 2, width: rect.width, height: height)
        let path = NSBezierPath(roundedRect: pill, xRadius: height / 2, yRadius: height / 2)
        let increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        let titleColor: NSColor
        let symbolColor: NSColor
        switch style {
        case .prominent:
            // White in light and dark alike, lifted off the glass by a soft shadow.
            NSGraphicsContext.current?.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
            shadow.shadowBlurRadius = 3
            shadow.shadowOffset = NSSize(width: 0, height: -1)
            shadow.set()
            NSColor.white.setFill()
            path.fill()
            NSGraphicsContext.current?.restoreGraphicsState()
            NSColor.black.withAlphaComponent(increaseContrast ? 0.35 : 0.08).setStroke()
            path.lineWidth = 0.5
            path.stroke()
            titleColor = NSColor(white: 0.1, alpha: 1)
            symbolColor = titleColor
        case .secondary:
            NSColor.labelColor.withAlphaComponent(increaseContrast ? 0.16 : 0.08).setFill()
            path.fill()
            if increaseContrast {
                NSColor.separatorColor.setStroke()
                path.lineWidth = 0.5
                path.stroke()
            }
            titleColor = .labelColor
            symbolColor = .secondaryLabelColor
        }

        let font = font(style)
        let titleWidth = ceil((title as NSString).size(withAttributes: [.font: font]).width)
        let groupWidth = symbolSize + symbolGap + titleWidth
        let groupX = pill.midX - groupWidth / 2
        if let glyph {
            // The key's mark as macOS menus show it, in the rounded face so its ends are soft.
            let base = NSFont.systemFont(ofSize: 14, weight: .semibold)
            let rounded = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: 14) } ?? base
            let mark = NSAttributedString(string: glyph, attributes: [.font: rounded, .foregroundColor: symbolColor])
            let size = mark.size()
            mark.draw(at: NSPoint(x: groupX + (symbolSize - size.width) / 2, y: pill.midY - size.height / 2 - 0.5))
        } else if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
                .applying(NSImage.SymbolConfiguration(paletteColors: [symbolColor]))) {
            image.isTemplate = false
            image.draw(in: NSRect(x: groupX, y: pill.midY - symbolSize / 2, width: symbolSize, height: symbolSize),
                       from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        NSAttributedString(string: title, attributes: [.font: font, .foregroundColor: titleColor, .paragraphStyle: paragraph])
            .draw(with: NSRect(x: groupX + symbolSize + symbolGap, y: pill.midY - 8.5,
                               width: titleWidth + 2, height: 17),
                  options: [.usesLineFragmentOrigin])
    }
}
