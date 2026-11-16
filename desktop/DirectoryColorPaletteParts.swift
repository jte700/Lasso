// The pieces of the folder colour picker: its measures and motion, how its
// colours are laid out, and the shapes drawn for them. The picker itself, which
// moves these pieces, is in DirectoryColorPalette.swift; the card for making a
// colour of one's own is in DirectoryColorCard.swift.

import Cocoa
import QuartzCore

/// The capsule's measures, in points.
enum PaletteMetric {
    static let swatch: CGFloat = 20
    static let gap: CGFloat = 5
    static let inset: CGFloat = 4
    static let trackHeight: CGFloat = swatch + 2 * inset
    /// A colour under the pointer widens into a short capsule, when the row has room.
    static let hoverWidth: CGFloat = 27
    /// The chosen colour's pill: its name from the left, the close button at the right.
    static let labelLeading: CGFloat = 9
    static let labelToClose: CGFloat = 2
    static let close: CGFloat = 16
    static let closeTrailing: CGFloat = 2
    /// Short names still make a pill, not a slightly long dot.
    static let pillMinimum: CGFloat = 66
    /// The capsule starts under the folder's icon and stops short of the row's end.
    static let trackX: CGFloat = 8
    static let trailingRoom: CGFloat = 4
    /// The room the picker takes under its folder's row.
    static let rowHeight: CGFloat = 32
    static let font = NSFont.systemFont(ofSize: 11, weight: .semibold)
    /// A colour of one's own is named by its hex, in even-width digits as the reference writes it.
    static let hexFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
}

/// Springs and timings. The springs that grow the row and press a colour in are
/// the panel's own Morph Island tokens, so the picker moves as the add control does.
enum PaletteMotion {
    /// A colour stretching into the pill or back, and widening under the pointer.
    static let width = (stiffness: 380.0, damping: 35.0)
    static let press = MorphIslandRow.Motion.press
    static let pressedScale = 0.88
    static let reveal = MorphIslandRow.Motion.height
    static let closingStiffness = MorphIslandRow.Motion.shrinkingHeightStiffness
    /// The capsule growing into the card and back: the row's spring, damped a little
    /// more, since the card travels several times as far.
    static let card = (stiffness: 300.0, damping: 28.0)
    /// The + turns into × on the press spring, so it snaps round with a little swing.
    static let turn = MorphIslandRow.Motion.press
    /// The name comes in a letter at a time, each out of a blur.
    static let letterDelay = 0.08
    static let letterStagger = 0.025
    static let letterSeconds = 0.2
    static let letterBlur = 3.5
    /// The old name goes at once, before the new one starts.
    static let nameOutSeconds = 0.05
    /// The close button comes after the name has started.
    static let closeDelay = 0.16
    static let closeSeconds = 0.2
    /// Opening washes the capsule in; closing washes it out, quicker.
    static let washInSeconds = 0.28
    static let washOutSeconds = 0.14
    static let washBlur = 4.0
    /// The card's controls wash in once the card has started to grow.
    static let cardInDelay = 0.06
    static let cardInSeconds = 0.3
    static let cardOutSeconds = 0.12
    static let cardBlur = 6.0
    static let substeps = 4

    /// When a letter of the name starts to come in, after the colour was chosen.
    /// With Reduce Motion the name fades in whole.
    static func letterStart(_ index: Int, reduceMotion: Bool) -> Double {
        reduceMotion ? 0 : letterDelay + Double(index) * letterStagger
    }
}

enum PaletteLayout {
    /// Room for the name and the close button, and never shorter than the minimum.
    static func pillWidth(nameWidth: CGFloat) -> CGFloat {
        max(PaletteMetric.pillMinimum,
            ceil(PaletteMetric.labelLeading + nameWidth + PaletteMetric.labelToClose
                 + PaletteMetric.close + PaletteMetric.closeTrailing))
    }

    /// The width a colour heads for: the pill when chosen, a short capsule under the
    /// pointer, a dot otherwise. Pointing widens a colour only as far as the row has
    /// room, and with Reduce Motion not at all.
    static func width(selected: Bool, hovered: Bool, pill: CGFloat, reduceMotion: Bool,
                      hoverRoom: CGFloat = .greatestFiniteMagnitude) -> CGFloat {
        if selected { return pill }
        guard hovered, !reduceMotion else { return PaletteMetric.swatch }
        return PaletteMetric.swatch + max(0, min(PaletteMetric.hoverWidth - PaletteMetric.swatch, hoverRoom))
    }

    /// How much of a gap follows an item: none after one that is not there, so a
    /// colour growing in from nothing opens its gap as it grows.
    static func presence(_ width: CGFloat) -> CGFloat { min(1, max(0, width / PaletteMetric.swatch)) }

    /// Each item's shape, left to right inside a capsule whose top-left is `origin`.
    static func frames(widths: [CGFloat], origin: CGPoint) -> [CGRect] {
        var x = origin.x + PaletteMetric.inset
        return widths.map { width in
            defer { x += width + PaletteMetric.gap * presence(width) }
            return CGRect(x: x, y: origin.y + PaletteMetric.inset, width: width, height: PaletteMetric.swatch)
        }
    }

    static func trackWidth(widths: [CGFloat]) -> CGFloat {
        let gaps = widths.dropLast().reduce(0) { $0 + PaletteMetric.gap * presence($1) }
        return 2 * PaletteMetric.inset + widths.reduce(0, +) + gaps
    }

    /// The colour under the pointer, with the gaps shared between neighbours. Judged
    /// against where the colours are headed, so a colour widening under the pointer
    /// never pushes the pointer onto its neighbour and back. Items not there are skipped.
    static func hovered(at point: CGPoint, frames: [CGRect]) -> Int? {
        frames.firstIndex {
            $0.width >= 1 && $0.insetBy(dx: -PaletteMetric.gap / 2, dy: -PaletteMetric.inset).contains(point)
        }
    }

    /// Light colours carry dark letters, as a highlighter would, so every name reads.
    static func darkText(on color: NSColor) -> Bool { PaletteContrast.luminance(color) > 0.3 }
}

func paletteBlur(_ layer: CALayer, radius: Double) {
    guard radius >= 0.05 else {
        if layer.filters != nil { layer.filters = nil }
        return
    }
    if layer.filters == nil, let blur = CIFilter(name: "CIGaussianBlur") {
        blur.name = "blur"
        blur.setDefaults()
        layer.filters = [blur]
    }
    layer.setValue(radius, forKeyPath: "filters.blur.inputRadius")
}

/// Blurs a whole view, as the capsule and card do while they wash in and out.
func paletteBlur(_ view: NSView, radius: Double) {
    if radius >= 0.05, let filter = CIFilter(name: "CIGaussianBlur") {
        filter.setValue(radius, forKey: kCIInputRadiusKey)
        view.contentFilters = [filter]
    } else if !view.contentFilters.isEmpty {
        view.contentFilters = []
    }
}

func paletteIsDark(_ view: NSView) -> Bool {
    view.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
}

/// A view laid out top-down that clicks pass through where it has nothing of its own.
final class PaletteFlippedView: NSView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }
}

/// The white capsule that holds the colours, and grows into the card. Opening, it
/// grows down from a line to its full height with the colours inside it.
final class PaletteTrack: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }

    override func updateLayer() {
        let dark = paletteIsDark(self)
        layer?.backgroundColor = (dark ? NSColor.white.withAlphaComponent(0.09) : NSColor.white).cgColor
        layer?.borderColor = (dark ? NSColor.white.withAlphaComponent(0.1) : NSColor.black.withAlphaComponent(0.08)).cgColor
        layer?.borderWidth = 1
    }
}

/// One colour: a dot, or the pill with its name when chosen. The button reaches into
/// the gaps around its shape, so there is nowhere between colours to miss.
final class PaletteSwatch: NSButton {
    private(set) var tint: DirectoryToggleColor
    /// The drawn shape, pressed in about its middle.
    let face = CALayer()
    private(set) var letters: [CATextLayer] = []
    private(set) var nameWidth: CGFloat = 0
    var onPress: ((Bool) -> Void)?
    var onPick: (() -> Void)?
    /// Where the shape sits in the button.
    private(set) var faceFrame = CGRect.zero
    var selected = false {
        didSet { if selected != oldValue { refreshAccessibilityValue() } }
    }

    init(color: DirectoryToggleColor) {
        tint = color
        super.init(frame: NSRect(x: 0, y: 0, width: PaletteMetric.swatch, height: PaletteMetric.swatch))
        isBordered = false
        title = ""
        wantsLayer = true
        layerUsesCoreImageFilters = true
        target = self
        action = #selector(pick)
        face.masksToBounds = true
        face.borderWidth = 1
        layer?.addSublayer(face)
        recolor(color)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Gives the swatch another colour, with its name set out letter by letter.
    func recolor(_ color: DirectoryToggleColor) {
        let renamed = color.title != tint.title || letters.isEmpty
        tint = color
        face.backgroundColor = color.color.cgColor
        setAccessibilityLabel("Use \(color.title)")
        refreshAccessibilityValue()
        guard renamed else { return }
        let shown = letters.first.map(\.opacity) ?? 0
        let ink = letters.first?.foregroundColor
        letters.forEach { $0.removeFromSuperlayer() }
        letters = []
        let font = color.isCustom ? PaletteMetric.hexFont : PaletteMetric.font
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: color.title, attributes: [.font: font]))
        nameWidth = ceil(CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)))
        let name = color.title as NSString
        let lineHeight = ceil(font.ascender - font.descender)
        // The capitals sit in the middle of the pill.
        let top = (PaletteMetric.swatch / 2 - (font.ascender - font.capHeight / 2)).rounded()
        let pad: CGFloat = 4
        for index in 0..<name.length {
            let start = CTLineGetOffsetForStringIndex(line, index, nil)
            let end = CTLineGetOffsetForStringIndex(line, index + 1, nil)
            let letter = CATextLayer()
            letter.string = name.substring(with: NSRange(location: index, length: 1))
            letter.font = font
            letter.fontSize = font.pointSize
            letter.alignmentMode = .center
            letter.isWrapped = false
            letter.opacity = shown
            letter.foregroundColor = ink
            letter.contentsScale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
            letter.frame = CGRect(x: PaletteMetric.labelLeading + start - pad, y: top,
                                  width: end - start + 2 * pad, height: lineHeight)
            face.addSublayer(letter)
            letters.append(letter)
        }
    }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {}

    /// Places the shape in the button and presses it in by `scale`.
    func place(face frame: CGRect, scale: CGFloat) {
        let moved = frame != faceFrame
        faceFrame = frame
        face.bounds = CGRect(origin: .zero, size: frame.size)
        face.position = CGPoint(x: frame.midX, y: frame.midY)
        face.cornerRadius = frame.height / 2
        face.transform = CATransform3DMakeScale(scale, scale, 1)
        if moved, window?.firstResponder === self { noteFocusRingMaskChanged() }
    }

    override var focusRingMaskBounds: NSRect { faceFrame }

    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: faceFrame, xRadius: faceFrame.height / 2, yRadius: faceFrame.height / 2).fill()
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        onPress?(true)
        super.mouseDown(with: event)
        onPress?(false)
    }

    @objc private func pick() { onPick?() }

    private func refreshAccessibilityValue() {
        setAccessibilityValue(selected ? "\(tint.title), selected" : tint.title)
    }
}

/// A round button drawn on its own layers: pressed in on a spring, lit under the pointer.
class PaletteRoundButton: NSButton {
    var onPress: ((Bool) -> Void)?
    var onClick: (() -> Void)?
    private(set) var hovering = false { didSet { if hovering != oldValue { hoverChanged() } } }

    init(size: CGFloat) {
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        isBordered = false
        title = ""
        wantsLayer = true
        target = self
        action = #selector(click)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {}

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        onPress?(true)
        super.mouseDown(with: event)
        onPress?(false)
    }

    func hoverChanged() {}

    @objc private func click() { onClick?() }
}

/// The × at the end of the chosen colour's pill.
final class PaletteCloseButton: PaletteRoundButton {
    private let halo = CALayer()
    private let glyph = CAShapeLayer()
    var ink = NSColor.white {
        didSet {
            glyph.strokeColor = ink.withAlphaComponent(0.9).cgColor
            hoverChanged()
        }
    }

    init() {
        super.init(size: PaletteMetric.close)
        setAccessibilityLabel("Close colors")
        toolTip = "Close"
        let size = PaletteMetric.close
        halo.frame = CGRect(x: 0, y: 0, width: size, height: size)
        halo.cornerRadius = size / 2
        layer?.addSublayer(halo)
        let arm: CGFloat = 3.25
        let path = CGMutablePath()
        path.move(to: CGPoint(x: size / 2 - arm, y: size / 2 - arm))
        path.addLine(to: CGPoint(x: size / 2 + arm, y: size / 2 + arm))
        path.move(to: CGPoint(x: size / 2 + arm, y: size / 2 - arm))
        path.addLine(to: CGPoint(x: size / 2 - arm, y: size / 2 + arm))
        glyph.path = path
        glyph.frame = halo.frame
        glyph.lineWidth = 1.5
        glyph.lineCap = .round
        glyph.fillColor = nil
        glyph.strokeColor = ink.withAlphaComponent(0.9).cgColor
        layer?.addSublayer(glyph)
        hoverChanged()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func press(scale: CGFloat) {
        let transform = CATransform3DMakeScale(scale, scale, 1)
        for piece in [halo, glyph] {
            piece.position = CGPoint(x: bounds.midX, y: bounds.midY)
            piece.transform = transform
        }
    }

    override func hoverChanged() {
        halo.backgroundColor = ink.withAlphaComponent(hovering ? 0.2 : 0).cgColor
    }
}

/// The glossy black circle at the end of the capsule. Its + makes a colour of one's
/// own and turns into × while the card is open, which puts the card away again.
final class PalettePlusButton: PaletteRoundButton {
    private let face = CALayer()
    private let gloss = CAGradientLayer()
    private let glyph = CAShapeLayer()

    init() {
        super.init(size: PaletteMetric.swatch)
        let size = PaletteMetric.swatch
        face.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        face.cornerRadius = size / 2
        face.masksToBounds = true
        face.borderWidth = 1
        gloss.frame = face.bounds
        face.addSublayer(gloss)
        let arm: CGFloat = 4.5
        let path = CGMutablePath()
        path.move(to: CGPoint(x: size / 2 - arm, y: size / 2))
        path.addLine(to: CGPoint(x: size / 2 + arm, y: size / 2))
        path.move(to: CGPoint(x: size / 2, y: size / 2 - arm))
        path.addLine(to: CGPoint(x: size / 2, y: size / 2 + arm))
        glyph.path = path
        glyph.bounds = face.bounds
        glyph.lineWidth = 1.75
        glyph.lineCap = .round
        glyph.fillColor = nil
        face.addSublayer(glyph)
        layer?.addSublayer(face)
        setOpen(false)
        applyColors()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// What the button does now: make a colour, or put the card away.
    func setOpen(_ open: Bool) {
        setAccessibilityLabel(open ? "Cancel custom color" : "New custom color")
        toolTip = open ? "Cancel" : "Make a color of your own"
    }

    /// Pressed in by `scale` and turned by `turn`, from 0 for + to 1 for ×.
    func place(scale: CGFloat, turn: CGFloat) {
        face.position = CGPoint(x: bounds.midX, y: bounds.midY)
        face.transform = CATransform3DMakeScale(scale, scale, 1)
        glyph.position = CGPoint(x: face.bounds.midX, y: face.bounds.midY)
        glyph.transform = CATransform3DMakeRotation(turn * .pi / 4, 0, 0, 1)
    }

    /// Black in light mode, as in the reference; light on a dark panel, where black would vanish.
    func applyColors() {
        let dark = paletteIsDark(self)
        let lift: CGFloat = hovering ? 0.06 : 0
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if dark {
            gloss.colors = [NSColor(white: 1 - lift, alpha: 1).cgColor, NSColor(white: 0.82 - lift, alpha: 1).cgColor]
            face.borderColor = NSColor.black.withAlphaComponent(0.2).cgColor
            glyph.strokeColor = NSColor(white: 0.1, alpha: 1).cgColor
        } else {
            gloss.colors = [NSColor(white: 0.27 + lift, alpha: 1).cgColor, NSColor(white: 0.05 + lift, alpha: 1).cgColor]
            face.borderColor = NSColor.black.withAlphaComponent(0.6).cgColor
            glyph.strokeColor = NSColor.white.cgColor
        }
        CATransaction.commit()
    }

    override func hoverChanged() { applyColors() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColors()
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { NSBezierPath(ovalIn: bounds).fill() }
}
