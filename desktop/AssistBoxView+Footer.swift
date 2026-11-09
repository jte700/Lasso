// The card's footer: its keys drawn as keycaps beside what each does
// ("⇥ Insert", "↑ ↓ Choose", "esc Dismiss"), left to right as far as they fit.

import Cocoa

/// A key, or keys that do the same thing, and what pressing it does.
struct AssistKeyHint {
    /// One keycap each: "↑" and "↓" are two keys, "⌘↩" is one chord.
    let keys: [String]
    let title: String
    let command: AssistBoxView.FooterCommand?
}

/// Where hints sit along the footer. A hint that does not fit is left out,
/// along with every hint after it, so the first ones always show whole.
struct AssistKeyHintLayout {
    static let keycapHeight: CGFloat = 20
    static let keycapMinimumWidth: CGFloat = 22
    static let keycapPadding: CGFloat = 7
    static let keycapGap: CGFloat = 4
    static let titleGap: CGFloat = 7
    static let hintGap: CGFloat = 16
    static let keyFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)
    static let titleFont = NSFont.systemFont(ofSize: 12)

    struct Placed {
        let hint: AssistKeyHint
        let keycaps: [NSRect]
        let title: NSRect
        var span: ClosedRange<CGFloat> { (keycaps.first?.minX ?? title.minX)...title.maxX }
    }

    let placed: [Placed]

    init(_ hints: [AssistKeyHint], from start: CGFloat, to end: CGFloat, centeredOn midY: CGFloat,
         measure: (String, NSFont) -> CGFloat = AssistTableLayout.textWidth) {
        var placed: [Placed] = []
        var x = start
        for hint in hints {
            var keycaps: [NSRect] = []
            var cursor = x
            for key in hint.keys {
                let width = max(Self.keycapMinimumWidth, ceil(measure(key, Self.keyFont)) + 2 * Self.keycapPadding)
                keycaps.append(NSRect(x: cursor, y: midY - Self.keycapHeight / 2, width: width, height: Self.keycapHeight))
                cursor += width + Self.keycapGap
            }
            let titleX = (keycaps.last?.maxX ?? x) + Self.titleGap
            let titleWidth = ceil(measure(hint.title, Self.titleFont)) + 1
            guard titleX + titleWidth <= end else { break }
            placed.append(Placed(hint: hint, keycaps: keycaps,
                                 title: NSRect(x: titleX, y: midY - 8, width: titleWidth, height: 17)))
            x = titleX + titleWidth + Self.hintGap
        }
        self.placed = placed
    }

    /// The hint drawn at `x`, counting the gap after it, so a click between two hints belongs to the first.
    func hint(at x: CGFloat) -> AssistKeyHint? {
        placed.last { x >= $0.span.lowerBound - Self.hintGap / 2 }?.hint
    }
}

extension AssistBoxView {
    enum FooterCommand { case tab, insertText, share, dismiss }

    /// What Tab does first, then the keys that move through the list and
    /// close it. With plain-text insertion Tab and ⌘↩ do the same thing, so
    /// ⌘↩ is not shown twice; ⇧⌘↩ comes last, beside the Share link button
    /// that does the same, and is the first left out when room runs short.
    var footerHints: [AssistKeyHint] {
        let suggestion = suggestions.indices.contains(selected) ? suggestions[selected] : nil
        let shareable = suggestion?.isShareable == true
        let mode = shareable ? InsertionMode.current : .plain
        // Typed words a suggestion takes the place of are still an insertion: it always reads Insert.
        let tabTitle = mode == .share ? "Share…" : mode == .ask ? "Text or link…" : "Insert"
        var hints = [AssistKeyHint(keys: ["⇥"], title: tabTitle, command: .tab)]
        if mode != .plain {
            hints.append(AssistKeyHint(keys: ["⌘↩"], title: "Insert", command: .insertText))
        }
        hints.append(AssistKeyHint(keys: ["↑", "↓"], title: "Choose", command: nil))
        hints.append(AssistKeyHint(keys: ["esc"], title: "Dismiss", command: .dismiss))
        if shareable && mode != .share {
            hints.append(AssistKeyHint(keys: ["⇧⌘↩"], title: "Share…", command: .share))
        }
        return hints
    }

    /// The keys of the share question: move, choose and cancel.
    var choiceHints: [AssistKeyHint] {
        [AssistKeyHint(keys: ["↑", "↓"], title: "Move", command: nil),
         AssistKeyHint(keys: ["↩"], title: "Choose", command: nil),
         AssistKeyHint(keys: ["esc"], title: "Cancel", command: nil)]
    }

    /// The footer's hints laid out across the list's column, level with the
    /// preview's buttons beside them.
    func footerHintLayout(_ hints: [AssistKeyHint]) -> AssistKeyHintLayout {
        AssistKeyHintLayout(hints, from: 18, to: leftWidth - 14, centeredOn: footerY + 23.5)
    }

    func footerCommand(at x: CGFloat) -> FooterCommand? {
        footerHintLayout(footerHints).hint(at: x)?.command
    }

    func drawKeyHints(_ hints: [AssistKeyHint]) {
        for placed in footerHintLayout(hints).placed {
            for (key, frame) in zip(placed.hint.keys, placed.keycaps) { drawKeycap(key, in: frame) }
            drawText(placed.hint.title, in: placed.title, font: AssistKeyHintLayout.titleFont,
                     color: .secondaryLabelColor)
        }
    }

    /// A Mac keyboard key's face, edge and the lip along its bottom, in light and dark.
    private static let keycapFace = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(white: 0.34, alpha: 1) : .white
    }
    private static let keycapLip = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(white: 0.17, alpha: 1)
            : NSColor(white: 0.74, alpha: 1)
    }
    private static let keycapEdge = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor.black.withAlphaComponent(0.45)
            : NSColor.black.withAlphaComponent(0.12)
    }

    /// A key drawn as a Mac keyboard key: a raised face over a darker lip
    /// along its bottom edge, a hairline outline and a faint shadow.
    private func drawKeycap(_ key: String, in rect: NSRect) {
        let radius: CGFloat = 5
        let lip: CGFloat = 1.5
        let body = rect.insetBy(dx: 0.5, dy: 0.5)
        let bodyPath = NSBezierPath(roundedRect: body, xRadius: radius, yRadius: radius)

        // The lip, with the cap's shadow beneath it.
        NSGraphicsContext.current?.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.16)
        shadow.shadowBlurRadius = 1.5
        shadow.shadowOffset = NSSize(width: 0, height: -0.5)
        shadow.set()
        Self.keycapLip.setFill()
        bodyPath.fill()
        NSGraphicsContext.current?.restoreGraphicsState()

        // The face sits above the lip; the view is flipped, so the lip shows at maxY.
        let face = NSRect(x: body.minX, y: body.minY, width: body.width, height: body.height - lip)
        Self.keycapFace.setFill()
        NSBezierPath(roundedRect: face, xRadius: radius, yRadius: radius).fill()

        let increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        (increaseContrast ? NSColor.labelColor.withAlphaComponent(0.5) : Self.keycapEdge).setStroke()
        bodyPath.lineWidth = 0.5
        bodyPath.stroke()

        let font = AssistKeyHintLayout.keyFont
        let height = ceil(font.ascender - font.descender)
        drawText(key, in: NSRect(x: face.minX, y: face.midY - height / 2, width: face.width, height: height),
                 font: font, color: .labelColor, alignment: .center)
    }
}
