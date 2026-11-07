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

    /// A key as a small rounded cap: a faint fill and a hairline edge, both
    /// from the label colour so they read on glass in light and dark.
    private func drawKeycap(_ key: String, in rect: NSRect) {
        let cap = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 5.5, yRadius: 5.5)
        NSColor.labelColor.withAlphaComponent(0.07).setFill()
        cap.fill()
        NSColor.labelColor.withAlphaComponent(0.22).setStroke()
        cap.lineWidth = 1
        cap.stroke()
        let font = AssistKeyHintLayout.keyFont
        let height = ceil(font.ascender - font.descender)
        drawText(key, in: NSRect(x: rect.minX, y: rect.midY - height / 2, width: rect.width, height: height),
                 font: font, color: .labelColor, alignment: .center)
    }
}
