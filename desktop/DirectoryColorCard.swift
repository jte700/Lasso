// The card the folder colour picker grows into when + is pressed, for making a
// colour of one's own: a field of saturation and brightness, a hue slider, a row
// of shades of the hue, how well the pill's letters read on the colour, the
// screen's eyedropper and Done. The picker moves and washes it in and out; the
// card only lays out its controls and says what they were set to.

import Cocoa
import QuartzCore

/// A colour as hue, saturation and brightness, each from 0 to 1. The card keeps
/// these rather than red, green and blue, so a drag through grey keeps its hue.
struct PaletteHSB: Equatable {
    var hue: Double
    var saturation: Double
    var brightness: Double

    init(hue: Double, saturation: Double, brightness: Double) {
        self.hue = min(max(hue, 0), 1)
        self.saturation = min(max(saturation, 0), 1)
        self.brightness = min(max(brightness, 0), 1)
    }

    init(red: Double, green: Double, blue: Double) {
        let high = max(red, green, blue), low = min(red, green, blue), range = high - low
        var hue = 0.0
        if range > 0 {
            if high == red { hue = (green - blue) / range }
            else if high == green { hue = 2 + (blue - red) / range }
            else { hue = 4 + (red - green) / range }
            hue /= 6
            if hue < 0 { hue += 1 }
        }
        self.init(hue: hue, saturation: high == 0 ? 0 : range / high, brightness: high)
    }

    init(_ color: DirectoryToggleColor) {
        let rgb = color.components
        self.init(red: Double(rgb.red), green: Double(rgb.green), blue: Double(rgb.blue))
    }

    var rgb: (red: Double, green: Double, blue: Double) {
        let sector = (hue >= 1 ? 0 : hue) * 6
        let index = Int(sector), fraction = sector - Double(index)
        let v = brightness, p = v * (1 - saturation), q = v * (1 - saturation * fraction)
        let t = v * (1 - saturation * (1 - fraction))
        switch index {
        case 0: return (v, t, p)
        case 1: return (q, v, p)
        case 2: return (p, v, t)
        case 3: return (p, q, v)
        case 4: return (t, p, v)
        default: return (v, p, q)
        }
    }

    var color: DirectoryToggleColor {
        let rgb = rgb
        return DirectoryToggleColor(red: CGFloat(rgb.red), green: CGFloat(rgb.green), blue: CGFloat(rgb.blue))
    }

    /// The hue at full strength, which the field and the slider's knob are drawn in.
    var pureHue: NSColor {
        let rgb = PaletteHSB(hue: hue, saturation: 1, brightness: 1).rgb
        return NSColor(srgbRed: CGFloat(rgb.red), green: CGFloat(rgb.green), blue: CGFloat(rgb.blue), alpha: 1)
    }
}

/// Nine shades of a hue, palest first. They depend on the hue alone, so picking one
/// leaves the row where it was and only moves the ring.
enum PaletteShades {
    static let levels: [(saturation: Double, brightness: Double)] = [
        (0.10, 1.0), (0.25, 1.0), (0.42, 0.97), (0.60, 0.93), (0.78, 0.88),
        (0.88, 0.74), (0.92, 0.58), (0.94, 0.43), (0.95, 0.28),
    ]

    static func shades(hue: Double) -> [PaletteHSB] {
        levels.map { PaletteHSB(hue: hue, saturation: $0.saturation, brightness: $0.brightness) }
    }

    /// The shade the colour is, if it is one.
    static func index(of hsb: PaletteHSB) -> Int? {
        levels.firstIndex { abs($0.saturation - hsb.saturation) < 0.015 && abs($0.brightness - hsb.brightness) < 0.015 }
    }
}

/// How well the pill's letters read on a colour, as the reference card shows it.
enum PaletteContrast {
    static func luminance(_ color: NSColor) -> Double {
        guard let rgb = color.usingColorSpace(.sRGB) else { return 0 }
        func linear(_ c: CGFloat) -> Double { Double(c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)) }
        return 0.2126 * linear(rgb.redComponent) + 0.7152 * linear(rgb.greenComponent) + 0.0722 * linear(rgb.blueComponent)
    }

    static func ratio(_ first: NSColor, _ second: NSColor) -> Double {
        let a = luminance(first), b = luminance(second)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// The letters the pill writes on this colour: dark on light colours, white on the rest.
    static func ink(on color: NSColor) -> NSColor { PaletteLayout.darkText(on: color) ? .black : .white }

    /// The WCAG grade for text of the pill's size.
    static func grade(_ ratio: Double) -> String {
        ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA Large" : "Low"
    }
}

/// Where the card's controls sit, below the capsule's row of colours.
enum PaletteCardLayout {
    static let side: CGFloat = 6
    static let fieldTop: CGFloat = 2
    static let fieldHeight: CGFloat = 96
    static let hueHeight: CGFloat = 8
    static let hueKnob: CGFloat = 16
    static let shadeHeight: CGFloat = 18
    static let shadeGap: CGFloat = 4
    static let footerHeight: CGFloat = 24
    static let doneWidth: CGFloat = 56
    static let spacing: CGFloat = 12
    static let bottom: CGFloat = 6

    static func field(width: CGFloat) -> CGRect {
        CGRect(x: side, y: fieldTop, width: width - 2 * side, height: fieldHeight)
    }

    static func hue(width: CGFloat) -> CGRect {
        CGRect(x: side, y: field(width: width).maxY + spacing, width: width - 2 * side, height: hueHeight)
    }

    static func shades(width: CGFloat) -> [CGRect] {
        let top = hue(width: width).maxY + spacing
        let count = CGFloat(PaletteShades.levels.count)
        let each = (width - 2 * side - (count - 1) * shadeGap) / count
        return (0..<PaletteShades.levels.count).map {
            CGRect(x: side + CGFloat($0) * (each + shadeGap), y: top, width: each, height: shadeHeight)
        }
    }

    static func footer(width: CGFloat) -> CGRect {
        CGRect(x: side, y: shades(width: width)[0].maxY + 10, width: width - 2 * side, height: footerHeight)
    }

    /// The card under the row of colours.
    static func height(width: CGFloat) -> CGFloat { footer(width: width).maxY + bottom }
}

/// The square of saturation (across) and brightness (down) for the hue.
final class PaletteField: NSView {
    private let base = CALayer()
    private let whiteness = CAGradientLayer()
    private let darkness = CAGradientLayer()
    private let knob = CALayer()
    var onChange: ((Double, Double) -> Void)?
    private(set) var saturation = 1.0
    private(set) var brightness = 1.0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
        whiteness.colors = [NSColor.white.cgColor, NSColor.white.withAlphaComponent(0).cgColor]
        whiteness.startPoint = CGPoint(x: 0, y: 0.5)
        whiteness.endPoint = CGPoint(x: 1, y: 0.5)
        darkness.colors = [NSColor.black.withAlphaComponent(0).cgColor, NSColor.black.cgColor]
        darkness.startPoint = CGPoint(x: 0.5, y: 0)
        darkness.endPoint = CGPoint(x: 0.5, y: 1)
        knob.bounds = CGRect(x: 0, y: 0, width: 13, height: 13)
        knob.cornerRadius = 6.5
        knob.borderWidth = 2
        knob.borderColor = NSColor.white.cgColor
        knob.shadowOpacity = 0.35
        knob.shadowRadius = 1.5
        knob.shadowOffset = .zero
        for piece in [base, whiteness, darkness, knob] { layer?.addSublayer(piece) }
        setAccessibilityElement(true)
        setAccessibilityRole(.slider)
        setAccessibilityLabel("Saturation and brightness")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    func show(_ hsb: PaletteHSB) {
        saturation = hsb.saturation
        brightness = hsb.brightness
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        base.backgroundColor = hsb.pureHue.cgColor
        for piece in [base, whiteness, darkness] { piece.frame = bounds }
        knob.position = CGPoint(x: bounds.width * saturation, y: bounds.height * (1 - brightness))
        CATransaction.commit()
        setAccessibilityValue("Saturation \(Int(saturation * 100)) percent, brightness \(Int(brightness * 100)) percent")
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func mouseDown(with event: NSEvent) { drag(event) }
    override func mouseDragged(with event: NSEvent) { drag(event) }

    private func drag(_ event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        onChange?(Double(min(max(point.x / max(bounds.width, 1), 0), 1)),
                  Double(1 - min(max(point.y / max(bounds.height, 1), 0), 1)))
    }
}

/// The rainbow slider that picks the hue.
final class PaletteHueSlider: NSView {
    private let track = CAGradientLayer()
    private let knob = CALayer()
    var onChange: ((Double) -> Void)?
    private(set) var hue = 0.0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        track.colors = stride(from: 0.0, through: 1.0, by: 1.0 / 6).map {
            PaletteHSB(hue: $0 >= 1 ? 0 : $0, saturation: 1, brightness: 1).pureHue.cgColor
        }
        track.startPoint = CGPoint(x: 0, y: 0.5)
        track.endPoint = CGPoint(x: 1, y: 0.5)
        track.cornerRadius = PaletteCardLayout.hueHeight / 2
        knob.bounds = CGRect(x: 0, y: 0, width: PaletteCardLayout.hueKnob, height: PaletteCardLayout.hueKnob)
        knob.cornerRadius = PaletteCardLayout.hueKnob / 2
        knob.borderWidth = 2.5
        knob.borderColor = NSColor.white.cgColor
        knob.shadowOpacity = 0.3
        knob.shadowRadius = 2
        knob.shadowOffset = CGSize(width: 0, height: 1)
        layer?.addSublayer(track)
        layer?.addSublayer(knob)
        setAccessibilityElement(true)
        setAccessibilityRole(.slider)
        setAccessibilityLabel("Hue")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    /// The knob reaches past the track, so the view is taller than the rainbow.
    func show(_ hsb: PaletteHSB) {
        hue = hsb.hue
        let inset = PaletteCardLayout.hueKnob / 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        track.frame = CGRect(x: 0, y: (bounds.height - PaletteCardLayout.hueHeight) / 2, width: bounds.width,
                             height: PaletteCardLayout.hueHeight)
        knob.backgroundColor = hsb.pureHue.cgColor
        knob.position = CGPoint(x: inset + (bounds.width - 2 * inset) * hue, y: bounds.midY)
        CATransaction.commit()
        setAccessibilityValue("\(Int((hue * 360).rounded())) degrees")
    }

    override func mouseDown(with event: NSEvent) { drag(event) }
    override func mouseDragged(with event: NSEvent) { drag(event) }

    private func drag(_ event: NSEvent) {
        let inset = PaletteCardLayout.hueKnob / 2
        let x = convert(event.locationInWindow, from: nil).x
        onChange?(Double(min(max((x - inset) / max(bounds.width - 2 * inset, 1), 0), 1)))
    }
}

/// One shade: a rounded square, ringed when it is the colour.
final class PaletteShadeButton: NSButton {
    private let face = CALayer()
    private let ring = CALayer()
    var onPick: (() -> Void)?
    var isCurrent = false { didSet { if isCurrent != oldValue { refreshRing() } } }

    init(index: Int) {
        super.init(frame: .zero)
        isBordered = false
        title = ""
        wantsLayer = true
        target = self
        action = #selector(pick)
        face.cornerRadius = 5
        face.borderWidth = 1
        face.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor
        ring.cornerRadius = 7
        ring.borderWidth = 1.5
        layer?.addSublayer(face)
        layer?.addSublayer(ring)
        setAccessibilityLabel("Shade \(index + 1) of \(PaletteShades.levels.count)")
        refreshRing()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() { refreshRing() }

    func show(_ shade: PaletteHSB) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        face.frame = bounds.insetBy(dx: 1.5, dy: 1.5)
        ring.frame = bounds.insetBy(dx: -1, dy: -1)
        face.backgroundColor = shade.color.color.cgColor
        CATransaction.commit()
    }

    private func refreshRing() {
        let dark = paletteIsDark(self)
        ring.borderColor = (dark ? NSColor.white : NSColor.black).withAlphaComponent(isCurrent ? 0.6 : 0).cgColor
        setAccessibilityValue(isCurrent ? "selected" : nil)
    }

    @objc private func pick() { onPick?() }
}

/// The glossy capsule that keeps the colour, black like the + it pairs with.
final class PaletteDoneButton: PaletteRoundButton {
    private let face = CALayer()
    private let gloss = CAGradientLayer()
    private let label = CATextLayer()

    init() {
        super.init(size: PaletteCardLayout.footerHeight)
        setFrameSize(NSSize(width: PaletteCardLayout.doneWidth, height: PaletteCardLayout.footerHeight))
        setAccessibilityLabel("Done")
        face.bounds = bounds
        face.cornerRadius = bounds.height / 2
        face.masksToBounds = true
        face.borderWidth = 1
        gloss.frame = bounds
        face.addSublayer(gloss)
        let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        label.string = "Done"
        label.font = font
        label.fontSize = font.pointSize
        label.alignmentMode = .center
        label.frame = CGRect(x: 0, y: (bounds.height - ceil(font.ascender - font.descender)) / 2 - 0.5,
                             width: bounds.width, height: ceil(font.ascender - font.descender))
        face.addSublayer(label)
        layer?.addSublayer(face)
        place(scale: 1)
        applyColors()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func place(scale: CGFloat) {
        face.position = CGPoint(x: bounds.midX, y: bounds.midY)
        face.transform = CATransform3DMakeScale(scale, scale, 1)
    }

    func applyColors() {
        let dark = paletteIsDark(self)
        let lift: CGFloat = hovering ? 0.06 : 0
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        label.contentsScale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        if dark {
            gloss.colors = [NSColor(white: 1 - lift, alpha: 1).cgColor, NSColor(white: 0.82 - lift, alpha: 1).cgColor]
            face.borderColor = NSColor.black.withAlphaComponent(0.2).cgColor
            label.foregroundColor = NSColor(white: 0.1, alpha: 1).cgColor
        } else {
            gloss.colors = [NSColor(white: 0.27 + lift, alpha: 1).cgColor, NSColor(white: 0.05 + lift, alpha: 1).cgColor]
            face.borderColor = NSColor.black.withAlphaComponent(0.6).cgColor
            label.foregroundColor = NSColor.white.cgColor
        }
        CATransaction.commit()
    }

    override func hoverChanged() { applyColors() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColors()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        applyColors()
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
    }
}

/// The card's controls. It reports what they were moved to; the picker decides
/// what that means for the colour being made.
final class PaletteCardView: NSView {
    let field = PaletteField()
    let hueSlider = PaletteHueSlider()
    private(set) var shadeButtons: [PaletteShadeButton] = []
    private let sample = CALayer()
    private let sampleText = CATextLayer()
    let ratioLabel = NSTextField(labelWithString: "")
    let gradeLabel = NSTextField(labelWithString: "")
    let eyedropper = NSButton()
    let doneButton = PaletteDoneButton()
    /// The colour was moved to here by one of the card's own controls.
    var onChange: ((PaletteHSB) -> Void)?
    var onSample: (() -> Void)?
    private(set) var hsb = PaletteHSB(hue: 0, saturation: 1, brightness: 1)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerUsesCoreImageFilters = true
        setAccessibilityElement(false)
        addSubview(field)
        addSubview(hueSlider)
        for index in PaletteShades.levels.indices {
            let shade = PaletteShadeButton(index: index)
            shade.onPick = { [weak self] in
                guard let self else { return }
                self.change(PaletteShades.shades(hue: self.hsb.hue)[index])
            }
            shadeButtons.append(shade)
            addSubview(shade)
        }
        field.onChange = { [weak self] saturation, brightness in
            guard let self else { return }
            self.change(PaletteHSB(hue: self.hsb.hue, saturation: saturation, brightness: brightness))
        }
        hueSlider.onChange = { [weak self] hue in
            guard let self else { return }
            self.change(PaletteHSB(hue: hue, saturation: self.hsb.saturation, brightness: self.hsb.brightness))
        }
        sample.cornerRadius = PaletteCardLayout.footerHeight / 2
        sample.borderWidth = 1
        sample.borderColor = NSColor.black.withAlphaComponent(0.1).cgColor
        let sampleFont = NSFont.systemFont(ofSize: 10, weight: .semibold)
        sampleText.string = "Aa"
        sampleText.font = sampleFont
        sampleText.fontSize = sampleFont.pointSize
        sampleText.alignmentMode = .center
        sample.addSublayer(sampleText)
        layer?.addSublayer(sample)
        gradeLabel.font = .systemFont(ofSize: 9, weight: .medium)
        gradeLabel.textColor = .secondaryLabelColor
        for label in [ratioLabel, gradeLabel] {
            label.setAccessibilityElement(false)
            addSubview(label)
        }
        eyedropper.isBordered = false
        eyedropper.image = NSImage(systemSymbolName: "eyedropper", accessibilityDescription: "Pick a color from the screen")?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
        eyedropper.contentTintColor = .secondaryLabelColor
        eyedropper.imagePosition = .imageOnly
        eyedropper.toolTip = "Pick a color from the screen"
        eyedropper.target = self
        eyedropper.action = #selector(sampleScreen)
        addSubview(eyedropper)
        addSubview(doneButton)
        layOut()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    override func setFrameSize(_ newSize: NSSize) {
        let changed = newSize.width != frame.width
        super.setFrameSize(newSize)
        if changed { layOut() }
    }

    private func layOut() {
        let width = bounds.width
        guard width > 2 * PaletteCardLayout.side + 40 else { return }
        field.frame = PaletteCardLayout.field(width: width)
        let hue = PaletteCardLayout.hue(width: width)
        hueSlider.frame = hue.insetBy(dx: 0, dy: -(PaletteCardLayout.hueKnob - PaletteCardLayout.hueHeight) / 2)
        for (button, frame) in zip(shadeButtons, PaletteCardLayout.shades(width: width)) { button.frame = frame }
        let footer = PaletteCardLayout.footer(width: width)
        let size = PaletteCardLayout.footerHeight
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sample.frame = CGRect(x: footer.minX, y: footer.minY, width: size, height: size)
        let font = NSFont.systemFont(ofSize: 10, weight: .semibold)
        let lineHeight = ceil(font.ascender - font.descender)
        sampleText.frame = CGRect(x: 0, y: (size - lineHeight) / 2, width: size, height: lineHeight)
        CATransaction.commit()
        ratioLabel.frame = NSRect(x: footer.minX + size + 7, y: footer.minY - 1, width: 70, height: 14)
        gradeLabel.frame = NSRect(x: footer.minX + size + 7, y: footer.minY + 12, width: 70, height: 12)
        doneButton.setFrameOrigin(NSPoint(x: footer.maxX - PaletteCardLayout.doneWidth, y: footer.minY))
        eyedropper.frame = NSRect(x: doneButton.frame.minX - 6 - size, y: footer.minY, width: size, height: size)
        show(hsb)
    }

    /// Shows a colour on every control, without reporting it.
    func show(_ value: PaletteHSB) {
        hsb = value
        field.show(value)
        hueSlider.show(value)
        let shades = PaletteShades.shades(hue: value.hue)
        let current = PaletteShades.index(of: value)
        for (index, button) in shadeButtons.enumerated() {
            button.show(shades[index])
            button.isCurrent = index == current
        }
        let color = value.color.color
        let ink = PaletteContrast.ink(on: color)
        let ratio = PaletteContrast.ratio(ink, color)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sample.backgroundColor = color.cgColor
        sampleText.foregroundColor = ink.cgColor
        sampleText.contentsScale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        CATransaction.commit()
        let mono = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        let text = NSMutableAttributedString(string: String(format: "%.1f", ratio),
                                             attributes: [.font: mono, .foregroundColor: NSColor.labelColor])
        text.append(NSAttributedString(string: ":1", attributes: [.font: mono, .foregroundColor: NSColor.tertiaryLabelColor]))
        ratioLabel.attributedStringValue = text
        gradeLabel.stringValue = PaletteContrast.grade(ratio)
        setAccessibilityLabel("Contrast \(String(format: "%.1f", ratio)) to 1")
    }

    private func change(_ value: PaletteHSB) {
        show(value)
        onChange?(value)
    }

    @objc private func sampleScreen() { onSample?() }
}
