//  The native highlight overlay.
//
//  Lasso owns this visual layer entirely: the host application's document is
//  never touched. A borderless, transparent, non-activating panel floats above
//  the focused window and draws each linked phrase as a pill: the page's own
//  colour with a wash of the source's, the words drawn again in that colour
//  and the source type's icon at its corner. Where the host's letters cannot be
//  matched, the pill is only a tint and they show through. Mouse events pass
//  straight through, so the user keeps typing and selecting in the host.
//
//  Motion: a phrase just inserted fades in in the host's ink, then turns to its
//  source's colour as its icon springs in. A phrase whose source changes rolls
//  its old words up and out with a blur while the new ones rise in and the pill
//  springs to their width. Phrases hide while the text under them may be
//  moving, as typing above them or scrolling, and fade back once it settles.

import Cocoa
import CoreText
import QuartzCore

// MARK: - Appearance

/// Styling is chosen by dependency state, never hardcoded at the call site.
enum DependencyStyle {
    /// Source identity colors avoid warning red/amber, which remain reserved
    /// for stale, changed, and missing dependencies.
    private static let sourceColors: [NSColor] = [
        NSColor(srgbRed: 0.12, green: 0.48, blue: 0.94, alpha: 1),
        NSColor(srgbRed: 0.48, green: 0.32, blue: 0.88, alpha: 1),
        NSColor(srgbRed: 0.00, green: 0.55, blue: 0.58, alpha: 1),
        NSColor(srgbRed: 0.78, green: 0.25, blue: 0.58, alpha: 1),
        NSColor(srgbRed: 0.12, green: 0.60, blue: 0.32, alpha: 1),
        NSColor(srgbRed: 0.26, green: 0.36, blue: 0.84, alpha: 1),
        NSColor(srgbRed: 0.00, green: 0.52, blue: 0.74, alpha: 1),
        NSColor(srgbRed: 0.60, green: 0.30, blue: 0.72, alpha: 1),
    ]
    static var sourceColorCount: Int { sourceColors.count }

    static func stroke(for state: DependencyVisualState, sourceSlot: Int,
                       directoryColor: DirectoryToggleColor? = nil, hovered: Bool) -> NSColor {
        let base: NSColor
        switch state {
        case .healthy:
            let index = (sourceSlot % sourceColors.count + sourceColors.count) % sourceColors.count
            base = directoryColor?.color ?? sourceColors[index]
        case .changed:    base = NSColor(srgbRed: 0.87, green: 0.66, blue: 0.29, alpha: 1)
        case .stale:      base = NSColor(srgbRed: 0.85, green: 0.72, blue: 0.35, alpha: 1)
        case .missing:    base = NSColor(srgbRed: 0.85, green: 0.40, blue: 0.38, alpha: 1)
        case .unresolved: base = .clear
        }
        return base.withAlphaComponent(hovered ? 1.0 : 0.90)
    }

    static func wash(for state: DependencyVisualState, sourceSlot: Int,
                     directoryColor: DirectoryToggleColor? = nil, hovered: Bool) -> NSColor {
        guard hovered else {
            return stroke(for: state, sourceSlot: sourceSlot,
                          directoryColor: directoryColor, hovered: false).withAlphaComponent(0.08)
        }
        return stroke(for: state, sourceSlot: sourceSlot,
                      directoryColor: directoryColor, hovered: true).withAlphaComponent(0.16)
    }

    static func isDashed(_ state: DependencyVisualState) -> Bool {
        state == .stale || state == .missing
    }
}

// MARK: - What is drawn

/// One linked phrase as the overlay shows it.
struct OverlayChip: Equatable {
    let id: String
    let text: String
    /// The host's words, one screen rectangle per line.
    let fragments: [CGRect]
    /// The words drawn again line by line, or nil to leave the host's letters showing.
    let lines: [ChipLine]?
    let state: DependencyVisualState
    /// The source's colour.
    let tint: NSColor
    let page: NSColor
    /// The host's own text colour, which a new phrase's words start in.
    let ink: NSColor
    let words: NSColor
    /// The source's file, for its type's icon.
    let sourcePath: String
    /// Whitespace either side, which the pill may reach into without covering a letter.
    let roomBefore: Bool
    let roomAfter: Bool
    /// Which end of the pill the type icon sits at, above the phrase's own low
    /// letters, or nil when both ends are tall and the icon is left to the menu.
    let badgeSide: ChipBadgeSide?
    /// Inserted a moment ago, so it turns from the host's ink to its colour.
    let isNew: Bool

    var bounds: CGRect { fragments.dropFirst().reduce(fragments.first ?? .zero) { $0.union($1) } }

    var fontSize: CGFloat {
        lines?.first?.font.pointSize ?? (fragments.first.map { $0.height / ReferenceChipLayout.lineHeightRatio } ?? 13)
    }

    /// How far a pill reaches into the space beside its words: two fifths of
    /// the space, so the rest stays as the gap to the next word's letters.
    var margin: CGFloat {
        let space = lines?.first.map { ReferenceChipLayout.width(" ", $0.font) * $0.stretch } ?? fontSize * 0.26
        return min(2.5, max(0.5, space * 0.4))
    }

    /// The pill behind one line: the line's words with a little room either
    /// side where there is whitespace, as tall as the font's own line.
    func pill(_ index: Int) -> CGRect {
        let rect = fragments[index]
        let room = margin
        let before: CGFloat = index > 0 || roomBefore ? room : 0
        let after: CGFloat = index < fragments.count - 1 || roomAfter ? room : 0
        var pill = CGRect(x: rect.minX - before, y: rect.minY, width: rect.width + before + after, height: rect.height)
        if let line = lines?[safe: index] {
            let height = min(rect.height, line.textHeight + 4)
            let middle = line.baseline + (line.font.ascender + line.font.descender) / 2
            pill = CGRect(x: pill.minX, y: middle - height / 2, width: pill.width, height: height)
        }
        return pill
    }

    static func badgeSize(fontSize: CGFloat) -> CGFloat { min(max((fontSize * 0.64).rounded(), 9), 13) }

    /// The type icon's square, tucked into a top corner of the pill and never
    /// past its ends, so it covers none of the host's letters beside the
    /// phrase. It sits just above the phrase's own lowercase letters at that
    /// end. Nil where both ends are tall: any place left would cover the
    /// host's text, so the type is left to the phrase's menu.
    var badge: CGRect? {
        guard let badgeSide, let line = badgeSide == .before ? lines?.first : lines?.last else { return nil }
        let side = Self.badgeSize(fontSize: fontSize)
        let pill = self.pill(badgeSide == .before ? 0 : fragments.count - 1)
        let x = badgeSide == .before ? pill.minX + 1 : pill.maxX - side - 1
        return CGRect(x: x, y: line.baseline + line.font.xHeight + 1.5, width: side, height: side)
    }

    /// Soft corners, about a third of the font's size, never a capsule.
    func cornerRadius(_ pill: CGRect) -> CGFloat { min(fontSize * 0.3, pill.height * 0.3) }
}

// MARK: - Drawing

final class OverlayView: NSView {
    /// A phrase on screen and where each of its motions stands.
    private final class Presence {
        var chip: OverlayChip
        /// The words it had before its source changed, rolling out.
        var previous: OverlayChip?
        var opacity = IslandTween.resting(0)
        /// 0 in the host's ink, 1 in the source's colour.
        var tinted = IslandTween.resting(1)
        var hover = IslandTween.resting(0)
        var badge = IslandTween.resting(1)
        var rollOut = IslandTween.resting(0)
        var rollIn = IslandTween.resting(1)
        /// 0 at the old words' pill, 1 at the new.
        var morph = IslandTween.resting(1)
        var changing = false
        var changeStarted: CFTimeInterval = 0
        var leaving = false

        init(_ chip: OverlayChip) { self.chip = chip }

        func isDone(at now: CFTimeInterval) -> Bool {
            [opacity, tinted, hover, badge, rollOut, rollIn, morph].allSatisfy { $0.isDone(at: now) }
        }
    }

    private var presences: [String: Presence] = [:]
    private var order: [String] = []
    /// Screen-space frame of the panel that owns this view.
    var panelFrame: CGRect = .zero
    var hoveredId: String? { didSet { if hoveredId != oldValue { updateHover() } } }
    /// The phrase whose menu is open, drawn as if hovered.
    var activeId: String? { didSet { if activeId != oldValue { updateHover() } } }
    private var frameTimer: Timer?
    private var displayLinkObject: AnyObject?
    private var clock: () -> CFTimeInterval = CACurrentMediaTime
    private static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    override var isFlipped: Bool { false }

    /// Everything drawn now or still moving, in screen coordinates, so the
    /// panel can cover it.
    var paintedBounds: CGRect? {
        let rects = presences.values.flatMap { presence -> [CGRect] in
            [presence.chip, presence.previous].compactMap { $0 }.flatMap { chip in
                chip.fragments.indices.map { chip.pill($0) } + [chip.badge].compactMap { $0 }
            }
        }
        guard let first = rects.first else { return nil }
        return rects.dropFirst().reduce(first) { $0.union($1) }
    }

    var hasContent: Bool { presences.values.contains { !$0.leaving } }

    // MARK: Changes

    /// Shows these phrases. Phrases in `quiet` are hidden for now, because the
    /// text under them may be moving.
    func show(_ chips: [OverlayChip], quiet: Set<String> = []) {
        let now = clock()
        let ids = Set(chips.map(\.id))
        for (id, presence) in presences where !ids.contains(id) && !presence.leaving {
            presence.leaving = true
            presence.opacity = IslandTween(from: presence.opacity.value(at: now), to: 0, start: now, duration: 0.12)
        }
        for chip in chips {
            let hidden = quiet.contains(chip.id)
            guard let presence = presences[chip.id] else {
                let presence = Presence(chip)
                appear(presence, hidden: hidden, at: now)
                presences[chip.id] = presence
                continue
            }
            if presence.leaving { presence.leaving = false }
            if presence.chip.text != chip.text || presence.chip.sourcePath != chip.sourcePath {
                rollIn(presence, to: chip, at: now)
            } else if presence.changing, now - presence.changeStarted > 2.5 {
                // The change never came: the words roll back.
                cancelChange(chip.id)
            }
            presence.chip = chip
            let target: Double = hidden ? 0 : 1
            if presence.opacity.to != target {
                presence.opacity = IslandTween(from: presence.opacity.value(at: now), to: target, start: now,
                                               duration: hidden ? 0.08 : 0.2)
            }
        }
        order = chips.map(\.id) + order.filter { !ids.contains($0) && presences[$0] != nil }
        needsDisplay = true
        startLoopIfNeeded()
    }

    /// Hides phrases at once, before the text under them moves.
    func quiet(_ ids: Set<String>) {
        let now = clock()
        var changed = false
        for id in ids {
            guard let presence = presences[id], presence.opacity.to != 0 else { continue }
            presence.opacity = IslandTween(from: presence.opacity.value(at: now), to: 0, start: now, duration: 0.06)
            changed = true
        }
        if changed { needsDisplay = true; startLoopIfNeeded() }
    }

    /// The writer chose another source: the words roll up and out while the
    /// host is written, and the new ones rise in when they arrive.
    func beginChange(_ id: String) {
        guard let presence = presences[id] else { return }
        let now = clock()
        presence.changing = true
        presence.changeStarted = now
        presence.previous = presence.chip
        presence.morph = .resting(0)
        presence.rollIn = .resting(0)
        presence.rollOut = IslandTween(from: 0, to: 1, start: now, duration: Self.reduceMotion ? 0.12 : 0.22, curve: .ease)
        needsDisplay = true
        startLoopIfNeeded()
    }

    /// The change did not land: the old words come back.
    func cancelChange(_ id: String) {
        guard let presence = presences[id], presence.changing else { return }
        let now = clock()
        presence.changing = false
        presence.previous = nil
        presence.morph = .resting(1)
        presence.rollOut = .resting(0)
        presence.rollIn = IslandTween(from: 0, to: 1, start: now, duration: 0.28, curve: .land)
        needsDisplay = true
        startLoopIfNeeded()
    }

    private func appear(_ presence: Presence, hidden: Bool, at now: CFTimeInterval) {
        let reduce = Self.reduceMotion
        presence.opacity = IslandTween(from: 0, to: hidden ? 0 : 1, start: now, duration: presence.chip.isNew ? 0.16 : 0.2)
        if presence.chip.isNew {
            // Inserted in the host's ink: the words turn, then the icon arrives.
            presence.tinted = IslandTween(from: 0, to: 1, start: now, delay: 0.1, duration: reduce ? 0.2 : 0.5, curve: .ease)
            presence.badge = IslandTween(from: 0, to: 1, start: now, delay: reduce ? 0.1 : 0.28,
                                         duration: reduce ? 0.15 : 0.42, curve: reduce ? .ease : .overshoot)
        }
        if presence.chip.id == hoveredId || presence.chip.id == activeId { presence.hover = .resting(1) }
    }

    private func rollIn(_ presence: Presence, to chip: OverlayChip, at now: CFTimeInterval) {
        let reduce = Self.reduceMotion
        if !presence.changing {
            presence.previous = presence.chip
            presence.rollOut = IslandTween(from: 0, to: 1, start: now, duration: reduce ? 0.12 : 0.22, curve: .ease)
        }
        presence.changing = false
        let wait = max(0, presence.rollOut.isDone(at: now) ? 0 : 0.06)
        presence.rollIn = IslandTween(from: 0, to: 1, start: now, delay: wait, duration: reduce ? 0.15 : 0.36, curve: .land)
        presence.morph = IslandTween(from: 0, to: 1, start: now, duration: reduce ? 0.15 : 0.42, curve: .land)
        if ReferenceSourceType.fileExtension(chip.sourcePath) != ReferenceSourceType.fileExtension(presence.chip.sourcePath) {
            presence.badge = IslandTween(from: 0.2, to: 1, start: now, delay: 0.08, duration: reduce ? 0.15 : 0.4,
                                         curve: reduce ? .ease : .overshoot)
        }
    }

    private func updateHover() {
        let now = clock()
        for (id, presence) in presences {
            let target: Double = id == hoveredId || id == activeId ? 1 : 0
            guard presence.hover.to != target else { continue }
            presence.hover = IslandTween(from: presence.hover.value(at: now), to: target, start: now,
                                         duration: target > 0 ? 0.14 : 0.22)
        }
        needsDisplay = true
        startLoopIfNeeded()
    }

    // MARK: Frames

    private func startLoopIfNeeded() {
        guard frameTimer == nil, displayLinkObject == nil else { return }
        if #available(macOS 14.0, *) {
            let link = displayLink(target: self, selector: #selector(frameFired))
            link.add(to: .main, forMode: .common)
            displayLinkObject = link
        } else {
            let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.frameFired() }
            RunLoop.main.add(timer, forMode: .common)
            frameTimer = timer
        }
    }

    @objc private func frameFired() {
        let now = clock()
        for (id, presence) in presences where presence.leaving && presence.opacity.isDone(at: now) {
            presences[id] = nil
        }
        for presence in presences.values where !presence.changing && presence.previous != nil
            && presence.rollOut.isDone(at: now) && presence.morph.isDone(at: now) {
            presence.previous = nil
        }
        needsDisplay = true
        if presences.values.allSatisfy({ $0.isDone(at: now) && !$0.changing }) { stopLoop() }
    }

    private func stopLoop() {
        frameTimer?.invalidate()
        frameTimer = nil
        if #available(macOS 14.0, *) { (displayLinkObject as? CADisplayLink)?.invalidate() }
        displayLinkObject = nil
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stopLoop() }
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let now = clock()
        for id in order {
            guard let presence = presences[id], presence.chip.state.isDrawn else { continue }
            let opacity = presence.opacity.value(at: now)
            guard opacity > 0.002 else { continue }
            context.saveGState()
            context.setAlpha(CGFloat(opacity))
            draw(presence, at: now, in: context)
            context.restoreGState()
        }
    }

    private func local(_ rect: CGRect) -> CGRect { HostGeometryConverter.toPanelLocal(rect, panelFrame: panelFrame) }

    private func draw(_ presence: Presence, at now: CFTimeInterval, in context: CGContext) {
        let chip = presence.chip
        let hover = CGFloat(presence.hover.value(at: now))
        let morph = CGFloat(presence.morph.value(at: now))
        let previous = presence.previous
        let reduce = Self.reduceMotion
        // One line to one line: the pill springs from the old words' width to
        // the new. Otherwise the new pills stand and the words cross.
        let morphs = previous.map { $0.fragments.count == 1 && chip.fragments.count == 1 } ?? false

        var pills: [CGRect] = chip.fragments.indices.map { chip.pill($0) }
        if morphs, let previous {
            pills = [Self.mix(previous.pill(0), pills[0], morph)]
        }
        let wash = ReferenceChipPalette.wash(page: chip.page, hover: hover)
        let redraws = chip.lines != nil || previous?.lines != nil
        for pill in pills {
            let shape = CGPath(roundedRect: local(pill), cornerWidth: chip.cornerRadius(pill),
                               cornerHeight: chip.cornerRadius(pill), transform: nil)
            context.addPath(shape)
            if redraws {
                context.setFillColor(ReferenceChipPalette.fill(tint: chip.tint, page: chip.page, wash: wash).cgColor)
            } else {
                // The host's letters show through a tint, a little stronger
                // since they keep the host's own colour.
                context.setFillColor(chip.tint.withAlphaComponent(wash * 1.6).cgColor)
            }
            context.fillPath()
            // No outline: the wash alone is the pill. A source that changed
            // or went missing keeps a dashed edge, so it still stands out.
            guard DependencyStyle.isDashed(chip.state) else { continue }
            let radius = chip.cornerRadius(pill)
            context.addPath(CGPath(roundedRect: local(pill).insetBy(dx: 0.5, dy: 0.5),
                                   cornerWidth: radius - 0.5, cornerHeight: radius - 0.5, transform: nil))
            context.setStrokeColor(chip.tint.withAlphaComponent(0.45).cgColor)
            context.setLineWidth(1)
            context.setLineDash(phase: 0, lengths: [3, 2])
            context.strokePath()
            context.setLineDash(phase: 0, lengths: [])
        }

        // Words: the old rolling up and out, the new rising in, kept inside the pills.
        context.saveGState()
        for pill in pills { context.addRect(local(pill).insetBy(dx: 0, dy: -1)) }
        context.clip()
        let tinted = CGFloat(presence.tinted.value(at: now))
        if let previous, let lines = previous.lines {
            let out = CGFloat(presence.rollOut.value(at: now))
            if out < 1 {
                let rise = reduce ? 0 : previous.fontSize * 0.55 * out
                let shift = morphs ? pills[0].minX - previous.pill(0).minX : 0
                drawWords(lines, color: previous.words, alpha: 1 - out, blur: reduce ? 0 : 3 * out,
                          offset: CGPoint(x: shift, y: rise), in: context)
            }
        }
        if let lines = chip.lines {
            let rising = CGFloat(presence.rollIn.value(at: now))
            if rising > 0 {
                let color = Self.mix(chip.ink, chip.words, tinted)
                let drop = reduce ? 0 : chip.fontSize * 0.55 * (1 - rising)
                let shift = morphs ? pills[0].minX - chip.pill(0).minX : 0
                drawWords(lines, color: color, alpha: rising, blur: reduce ? 0 : 3 * (1 - rising),
                          offset: CGPoint(x: shift, y: -drop), in: context)
            }
        }
        context.restoreGState()

        drawBadge(presence, last: pills[pills.count - 1], hover: hover, at: now, in: context)
    }

    private func drawWords(_ lines: [ChipLine], color: NSColor, alpha: CGFloat, blur: CGFloat,
                           offset: CGPoint, in context: CGContext) {
        guard alpha > 0.002 else { return }
        for line in lines {
            let origin = CGPoint(x: line.rect.minX + offset.x, y: line.baseline + offset.y)
            if blur < 0.05 {
                context.saveGState()
                context.setAlpha(alpha)
                Self.drawLine(line, color: color, at: CGPoint(x: origin.x - panelFrame.minX, y: origin.y - panelFrame.minY),
                              in: context)
                context.restoreGState()
            } else if let image = ChipWordImages.blurred(line, color: color, radius: blur,
                                                         scale: window?.backingScaleFactor ?? 2) {
                let rect = CGRect(x: origin.x - image.pad - panelFrame.minX,
                                  y: origin.y - image.baselineFromBottom - panelFrame.minY,
                                  width: image.size.width, height: image.size.height)
                context.saveGState()
                context.setAlpha(alpha)
                context.draw(image.image, in: rect)
                context.restoreGState()
            }
        }
    }

    /// One line at its baseline, stretched to the host's width.
    static func drawLine(_ line: ChipLine, color: NSColor, at origin: CGPoint, in context: CGContext) {
        let attributed = NSAttributedString(string: line.text, attributes: [
            .font: line.font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.cgColor,
        ])
        let ctLine = CTLineCreateWithAttributedString(attributed)
        context.saveGState()
        context.translateBy(x: origin.x, y: origin.y)
        context.scaleBy(x: line.stretch, y: 1)
        context.textMatrix = .identity
        context.textPosition = .zero
        CTLineDraw(ctLine, context)
        context.restoreGState()
    }

    private func drawBadge(_ presence: Presence, last: CGRect, hover: CGFloat, at now: CFTimeInterval,
                           in context: CGContext) {
        let chip = presence.chip
        guard var badge = chip.badge else { return }
        let scale = CGFloat(presence.badge.value(at: now)) * (1 + 0.1 * hover)
        guard scale > 0.02 else { return }
        // It rides the end of the pill as the pill springs to new words.
        if chip.badgeSide == .after { badge.origin.x += last.maxX - chip.pill(chip.fragments.count - 1).maxX }
        let center = CGPoint(x: badge.midX, y: badge.midY)
        let side = badge.width * scale
        let frame = local(CGRect(x: center.x - side / 2, y: center.y - side / 2, width: side, height: side))
        let icon = ReferenceSourceType.tile(forPath: chip.sourcePath, size: badge.width)
        NSGraphicsContext.saveGraphicsState()
        icon.draw(in: frame, from: .zero, operation: .sourceOver, fraction: min(1, scale), respectFlipped: true, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
    }

    private static func mix(_ from: CGRect, _ to: CGRect, _ t: CGFloat) -> CGRect {
        CGRect(x: from.minX + (to.minX - from.minX) * t, y: from.minY + (to.minY - from.minY) * t,
               width: from.width + (to.width - from.width) * t, height: from.height + (to.height - from.height) * t)
    }

    private static func mix(_ from: NSColor, _ to: NSColor, _ t: CGFloat) -> NSColor {
        guard t < 0.999 else { return to }
        guard t > 0.001 else { return from }
        let a = from.usingColorSpace(.sRGB) ?? from, b = to.usingColorSpace(.sRGB) ?? to
        return a.blended(withFraction: t, of: b) ?? to
    }
}

/// Which side of a phrase its type icon rides.
enum ChipBadgeSide: Equatable {
    case after, before

    /// Characters that stay below the height of lowercase letters, so an icon
    /// raised above them covers nothing.
    private static let low = Set("acemnorsuvwxz,.;:!?\u{2026}-\u{2013}\u{2014}\u{00B7} \u{00A0}".utf16)

    /// The phrase's own end when the letters under the icon there are low,
    /// otherwise its start when those are, otherwise neither. Only words
    /// Lasso draws again are known letter by letter.
    static func choose(lines: [ChipLine]?) -> ChipBadgeSide? {
        guard let lines, let first = lines.first, let last = lines.last else { return nil }
        let side = OverlayChip.badgeSize(fontSize: first.font.pointSize) + 1.5
        if clear(last, from: last.rect.maxX - side, to: last.rect.maxX) { return .after }
        if clear(first, from: first.rect.minX, to: first.rect.minX + side) { return .before }
        return nil
    }

    /// Whether every character drawn between `from` and `to` on screen is low.
    private static func clear(_ line: ChipLine, from: CGFloat, to: CGFloat) -> Bool {
        let drawn = CTLineCreateWithAttributedString(NSAttributedString(string: line.text, attributes: [.font: line.font]))
        let units = Array(line.text.utf16)
        for index in units.indices {
            let start = line.rect.minX + CTLineGetOffsetForStringIndex(drawn, index, nil) * line.stretch
            let end = line.rect.minX + CTLineGetOffsetForStringIndex(drawn, index + 1, nil) * line.stretch
            guard end > from, start < to else { continue }
            if !low.contains(units[index]) { return false }
        }
        return true
    }
}

extension IslandCurve {
    /// Past the end and back, for an icon arriving.
    static let overshoot = IslandCurve(x1: 0.34, y1: 1.56, x2: 0.64, y2: 1)
}

/// A line of words drawn into a picture and blurred, for the moment it rolls.
enum ChipWordImages {
    struct Picture {
        let image: CGImage
        let size: CGSize
        /// The blur's margin each side, in points.
        let pad: CGFloat
        let baselineFromBottom: CGFloat
    }

    private static let context = CIContext(options: [.cacheIntermediates: false])

    static func blurred(_ line: ChipLine, color: NSColor, radius: CGFloat, scale: CGFloat) -> Picture? {
        let pad = ceil(radius * 3) + 2
        let width = ceil(ReferenceChipLayout.width(line.text, line.font) * line.stretch) + pad * 2
        let height = ceil(line.font.ascender - line.font.descender) + pad * 2
        let pixels = (w: Int(width * scale), h: Int(height * scale))
        guard pixels.w > 0, pixels.h > 0,
              let bitmap = CGContext(data: nil, width: pixels.w, height: pixels.h, bitsPerComponent: 8, bytesPerRow: 0,
                                     space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        bitmap.scaleBy(x: scale, y: scale)
        let baseline = pad - line.font.descender
        OverlayView.drawLine(line, color: color, at: CGPoint(x: pad, y: baseline), in: bitmap)
        guard let sharp = bitmap.makeImage() else { return nil }
        let input = CIImage(cgImage: sharp)
        guard let filter = CIFilter(name: "CIGaussianBlur") else { return nil }
        filter.setValue(input, forKey: kCIInputImageKey)
        filter.setValue(radius * scale, forKey: kCIInputRadiusKey)
        guard let output = filter.outputImage?.cropped(to: input.extent),
              let image = context.createCGImage(output, from: input.extent) else { return nil }
        return Picture(image: image, size: CGSize(width: width, height: height), pad: pad, baselineFromBottom: baseline)
    }
}

// MARK: - Window

/// A panel that never takes focus and only intercepts the mouse over a
/// dependency, so the host application keeps behaving normally everywhere else.
final class OverlayPanel: NSPanel {
    var hitTest: ((NSPoint) -> Bool)?

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    convenience init(view: NSView) {
        self.init(contentRect: .zero,
                  styleMask: [.borderless, .nonactivatingPanel],
                  backing: .buffered,
                  defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        ignoresMouseEvents = true
        contentView = view
    }
}
