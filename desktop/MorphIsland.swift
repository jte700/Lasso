// The Add Work Directories control at the foot of the status panel, one shape
// that morphs between the steps of adding a folder: at rest a row like the
// panel's others, a card with a ring, the folder's name and percentage while
// Lasso reads it, then a line saying it is ready before it settles back.
//
// The shape spans the row, as the panel's highlights do. Its height is a
// spring and the contents cross-fade with a blur while it moves. Springs and
// timings are the Morph Island motion tokens; colours, type, fills and
// positions are the panel's own.

import Cocoa
import QuartzCore

/// A damped spring, written as the motion tokens write it: stiffness and damping.
struct IslandSpring {
    var x: Double
    var v: Double = 0
    var t: Double
    var k: Double
    var c: Double

    init(_ value: Double, stiffness: Double, damping: Double) {
        x = value
        t = value
        k = stiffness
        c = damping
    }

    /// Reduce Motion keeps the stiffness but damps critically, so nothing overshoots.
    mutating func tune(stiffness: Double, damping: Double, reduceMotion: Bool) {
        k = stiffness
        c = reduceMotion ? 2 * stiffness.squareRoot() : damping
    }

    mutating func step(_ dt: Double) {
        let a = -k * (x - t) - c * v
        v += a * dt
        x += v * dt
    }

    func isSettled(within tolerance: Double) -> Bool { abs(x - t) < tolerance && abs(v) < tolerance }

    mutating func snap() {
        x = t
        v = 0
    }
}

/// A CSS timing curve: the cubic Bézier through (0,0), (x1,y1), (x2,y2) and (1,1).
struct IslandCurve {
    let x1: Double, y1: Double, x2: Double, y2: Double

    static let ease = IslandCurve(x1: 0.25, y1: 0.1, x2: 0.25, y2: 1)
    /// Contents landing: quick, then a long soft finish.
    static let land = IslandCurve(x1: 0.16, y1: 1, x2: 0.3, y2: 1)

    func callAsFunction(_ progress: Double) -> Double {
        let x = min(max(progress, 0), 1)
        let cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
        let cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
        func sampleX(_ t: Double) -> Double { ((ax * t + bx) * t + cx) * t }
        var t = x
        for _ in 0..<8 {
            let error = sampleX(t) - x
            let slope = (3 * ax * t + 2 * bx) * t + cx
            if abs(error) < 1e-6 || abs(slope) < 1e-6 { break }
            t -= error / slope
        }
        if abs(sampleX(t) - x) > 1e-5 {
            var low = 0.0, high = 1.0
            t = x
            for _ in 0..<40 where abs(sampleX(t) - x) > 1e-6 {
                if sampleX(t) < x { low = t } else { high = t }
                t = (low + high) / 2
            }
        }
        return ((ay * t + by) * t + cy) * t
    }
}

/// A transition from one value to another after a delay, along a curve, as CSS writes one.
struct IslandTween {
    var from: Double
    var to: Double
    var start: CFTimeInterval = 0
    var delay: Double = 0
    var duration: Double = 0
    var curve = IslandCurve.ease

    static func resting(_ value: Double) -> IslandTween { IslandTween(from: value, to: value) }

    func value(at now: CFTimeInterval) -> Double {
        guard duration > 0 else { return to }
        let progress = (now - start - delay) / duration
        if progress <= 0 { return from }
        if progress >= 1 { return to }
        return from + (to - from) * curve(progress)
    }

    func isDone(at now: CFTimeInterval) -> Bool { duration <= 0 || now - start - delay >= duration }
}

/// One kind's contents, faded, scaled and blurred in and out as a group.
private final class IslandContent {
    let layer = CALayer()
    var opacity = IslandTween.resting(0)
    var scale = IslandTween.resting(0.9)
    var blur = IslandTween.resting(6)

    init() {
        layer.opacity = 0
        layer.isHidden = true
    }

    /// Out at once; in after a beat, so the old contents are gone before the new arrive.
    func fade(in shown: Bool, at now: CFTimeInterval) {
        let opacityNow = opacity.value(at: now), scaleNow = scale.value(at: now), blurNow = blur.value(at: now)
        if shown {
            opacity = IslandTween(from: opacityNow, to: 1, start: now, delay: 0.09, duration: 0.35, curve: .ease)
            blur = IslandTween(from: blurNow, to: 0, start: now, delay: 0.09, duration: 0.35, curve: .ease)
            scale = IslandTween(from: scaleNow, to: 1, start: now, delay: 0.09, duration: 0.6, curve: .land)
        } else {
            opacity = IslandTween(from: opacityNow, to: 0, start: now, duration: 0.14, curve: .ease)
            blur = IslandTween(from: blurNow, to: 6, start: now, duration: 0.14, curve: .ease)
            scale = IslandTween(from: scaleNow, to: 0.9, start: now, duration: 0.2, curve: .ease)
        }
    }

    func settle() {
        opacity = .resting(opacity.to)
        scale = .resting(scale.to)
        blur = .resting(blur.to)
    }

    func isDone(at now: CFTimeInterval) -> Bool {
        opacity.isDone(at: now) && scale.isDone(at: now) && blur.isDone(at: now)
    }
}

/// One line of the island's text.
private final class IslandText: CATextLayer {
    override init() {
        super.init()
        isWrapped = false
        truncationMode = .end
    }

    override init(layer: Any) { super.init(layer: layer) }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func use(_ font: NSFont) {
        self.font = font
        fontSize = font.pointSize
    }
}

/// An SF Symbol drawn in a layer, upright whichever way the layer is flipped.
private final class IslandSymbol: CALayer {
    var image: NSImage? { didSet { setNeedsDisplay() } }

    override init() {
        super.init()
        needsDisplayOnBoundsChange = true
    }

    override init(layer: Any) { super.init(layer: layer) }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(in context: CGContext) {
        guard let image, image.size.width > 0, image.size.height > 0 else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: contentsAreFlipped())
        let scale = min(bounds.width / image.size.width, bounds.height / image.size.height, 1)
        let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        image.draw(in: NSRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2,
                              width: size.width, height: size.height))
        NSGraphicsContext.restoreGraphicsState()
    }
}

/// The resting row, drawn the way the panel's command rows draw theirs. As an
/// ordinary view it gets the panel's vibrancy, so its title, icon and pointer
/// highlight come out exactly as bright as the rows around it.
private final class IslandRowFace: NSView {
    var title = "" { didSet { if title != oldValue { needsDisplay = true } } }
    var enabled = true { didSet { if enabled != oldValue { needsDisplay = true } } }
    var highlighted = false { didSet { if highlighted != oldValue { needsDisplay = true } } }
    /// Drawn smaller about the middle while it fades, and with the press.
    var scale: CGFloat = 1 { didSet { if abs(scale - oldValue) > 0.0005 { needsDisplay = true } } }
    var blur: Double = 0 { didSet { if abs(blur - oldValue) > 0.01 { applyBlur() } } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerUsesCoreImageFilters = true
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var allowsVibrancy: Bool { true }
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func applyBlur() {
        guard blur >= 0.05, let filter = CIFilter(name: "CIGaussianBlur") else {
            if !contentFilters.isEmpty { contentFilters = [] }
            return
        }
        filter.setValue(blur, forKey: kCIInputRadiusKey)
        contentFilters = [filter]
    }

    override func draw(_ dirtyRect: NSRect) {
        if abs(scale - 1) > 0.0005 {
            let transform = NSAffineTransform()
            transform.translateX(by: bounds.midX, yBy: bounds.midY)
            transform.scale(by: scale)
            transform.translateX(by: -bounds.midX, yBy: -bounds.midY)
            transform.concat()
        }
        if highlighted {
            NSColor.labelColor.withAlphaComponent(0.1).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: MorphIslandRow.Metric.rowRadius,
                         yRadius: MorphIslandRow.Metric.rowRadius).fill()
        }
        let color: NSColor = enabled ? .labelColor : .disabledControlTextColor
        let iconBox = NSRect(x: MorphIslandRow.Metric.iconX, y: (bounds.height - MorphIslandRow.Metric.icon) / 2,
                             width: MorphIslandRow.Metric.icon, height: MorphIslandRow.Metric.icon)
        if let symbol = NSImage(systemSymbolName: "folder.badge.plus", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: NSFont.menuFont(ofSize: 0).pointSize, weight: .regular)),
           symbol.size.width > 0, symbol.size.height > 0 {
            let fit = min(iconBox.width / symbol.size.width, iconBox.height / symbol.size.height, 1)
            let size = NSSize(width: symbol.size.width * fit, height: symbol.size.height * fit)
            let tinted = NSImage(size: size, flipped: false) { rect in
                symbol.draw(in: rect)
                color.set()
                rect.fill(using: .sourceAtop)
                return true
            }
            tinted.draw(in: NSRect(x: iconBox.midX - size.width / 2, y: iconBox.midY - size.height / 2,
                                   width: size.width, height: size.height))
        }
        let font = NSFont.menuFont(ofSize: 0)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let titleHeight = ceil(font.ascender - font.descender)
        let x = MorphIslandRow.Metric.titleX
        (title as NSString).draw(in: NSRect(x: x, y: (bounds.height - titleHeight) / 2,
                                            width: bounds.width - x - MorphIslandRow.Metric.trailing, height: titleHeight),
                                 withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
    }
}

final class MorphIslandRow: NSView {
    /// The Add Work Directories command: its title, action and whether it can run now.
    var actionItem: NSMenuItem? { didSet { applyItem() } }
    /// The row grew or shrank with the island; the panel lays its rows out again.
    var onSizeChange: (() -> Void)?
    /// A finished addition has been on screen long enough, or was clicked away.
    var onHoldEnded: (() -> Void)?
    private(set) var state: MorphIslandState = .idle

    /// Tests drive the clock and the frames by hand.
    var clock: () -> CFTimeInterval = CACurrentMediaTime
    var drivesItself = true
    var animatesOffscreen = false

    /// The Morph Island tokens: `--island-h`, `--island-cycle-ms` and the press.
    /// The width follows the row, as the panel's highlights do, so it has no spring.
    enum Motion {
        static let height = (stiffness: 300.0, damping: 22.0)
        /// Shrinking, the height is a little stiffer, so a closing island does not linger.
        static let shrinkingHeightStiffness = 1.3
        static let press = (stiffness: 520.0, damping: 18.0)
        /// How long a finished addition stays on screen before the button comes back.
        static let holdSeconds = 2.8
        static let substeps = 4
        /// The card's fill comes and goes with the shape, not at once.
        static let fillSeconds = 0.2
    }

    /// The panel's row measures, so at rest the control lines up with the rows around it.
    enum Metric {
        /// The highlight's inset from the row's sides, as the panel's other rows draw it.
        static let sideInset: CGFloat = 4
        static let idleHeight: CGFloat = 24
        static let addingHeight: CGFloat = 52
        static let noticeHeight: CGFloat = 36
        /// A row's highlight corners; a card's are rounder.
        static let rowRadius: CGFloat = 5
        static let cardRadius: CGFloat = 10
        /// The panel's icon column and title column, measured from the highlight's edge.
        static let iconX: CGFloat = 10
        static let titleX: CGFloat = 32
        static let icon: CGFloat = 16
        /// Numbers end where the panel's shortcuts do.
        static let trailing: CGFloat = 10
        static let ring: CGFloat = 30
        static let ringLine: CGFloat = 3.25
        static let percentWidth: CGFloat = 42
    }

    private enum Fonts {
        static let label = NSFont.systemFont(ofSize: 13, weight: .medium)
        static let detail = NSFont.systemFont(ofSize: 11)
        static let number = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
    }

    static let defaultTitle = "Add Work Directories\u{2026}"

    private let shape = CALayer()
    private let idleContent = IslandContent()
    private let addingContent = IslandContent()
    private let doneContent = IslandContent()
    private let failedContent = IslandContent()
    private var contents: [IslandContent] { [idleContent, addingContent, doneContent, failedContent] }

    private let face = IslandRowFace()
    private let ringTrack = CAShapeLayer()
    private let ringFill = CAShapeLayer()
    private let addingTitle = IslandText()
    private let addingDetail = IslandText()
    private let addingPercent = IslandText()
    private let doneIcon = IslandSymbol()
    private let doneTitle = IslandText()
    private let doneDetail = IslandText()
    private let failedIcon = IslandSymbol()
    private let failedTitle = IslandText()

    private var height = IslandSpring(Metric.idleHeight, stiffness: Motion.height.stiffness, damping: Motion.height.damping)
    /// The fill's strength: none for a resting row, the panel's wash for a card.
    private var wash = IslandTween.resting(0)
    private var washInk = NSColor.white
    private var press = IslandSpring(1, stiffness: Motion.press.stiffness, damping: Motion.press.damping)
    private(set) var shownPercent = 0.0
    private var targetPercent: Double?
    private var spin = 0.0
    private var lastFrame: CFTimeInterval?
    private var frameTimer: Timer?
    private var displayLinkObject: AnyObject?
    private var holdTimer: Timer?
    private(set) var heldSeconds = 0.0
    private var hovering = false
    private var pressing = false
    private var laidOutFlipped: Bool?
    /// Each kind's box as last laid out, so a change of flipping can lay them out again.
    private var boxSizes: [MorphIslandState.Kind: CGSize] = [:]
    /// The colours the symbols were last drawn in; they are drawn again only when these change.
    private var symbolColors: [NSColor] = []

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: Self.rowHeight(for: Metric.idleHeight)))
        wantsLayer = true
        layerUsesCoreImageFilters = true
        shape.masksToBounds = true
        layer?.addSublayer(shape)
        for content in contents { shape.addSublayer(content.layer) }
        // The resting row is a view of its own, above the shape; the shape only fills a card.
        addSubview(face)
        for ring in [ringTrack, ringFill] {
            ring.fillColor = nil
            ring.lineWidth = Metric.ringLine
            ring.lineCap = .round
            addingContent.layer.addSublayer(ring)
        }
        for text in [addingTitle, addingDetail, addingPercent] { addingContent.layer.addSublayer(text) }
        for piece in [doneIcon, doneTitle, doneDetail] as [CALayer] { doneContent.layer.addSublayer(piece) }
        for piece in [failedIcon, failedTitle] as [CALayer] { failedContent.layer.addSublayer(piece) }
        addingTitle.use(Fonts.label)
        addingDetail.use(Fonts.detail)
        addingPercent.use(Fonts.number)
        addingPercent.alignmentMode = .right
        doneTitle.use(Fonts.label)
        doneDetail.use(Fonts.number)
        doneDetail.alignmentMode = .right
        failedTitle.use(Fonts.label)
        idleContent.opacity = .resting(1)
        idleContent.scale = .resting(1)
        idleContent.blur = .resting(0)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
        NotificationCenter.default.addObserver(self, selector: #selector(systemColorsChanged),
                                               name: NSColor.systemColorsDidChangeNotification, object: nil)
        applyItem()
        updateScale()
        render()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        NotificationCenter.default.removeObserver(self)
        frameTimer?.invalidate()
        holdTimer?.invalidate()
    }

    // MARK: State

    /// Moves the island to a state. A new kind morphs the shape and cross-fades
    /// the contents; the same kind only updates its words and percentage.
    func show(_ next: MorphIslandState) {
        guard next != state else { return }
        let previous = state
        state = next
        let now = clock()
        let target = size(for: next)
        if next.kind != previous.kind {
            let grows = target.height > height.t
            let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            height.tune(stiffness: Motion.height.stiffness * (grows ? 1 : Motion.shrinkingHeightStiffness),
                        damping: Motion.height.damping, reduceMotion: reduce)
            press.v -= grows ? 1.6 : 1
            for (kind, content) in contentsByKind { content.fade(in: kind == next.kind, at: now) }
            if next.kind == .adding {
                shownPercent = 0
                targetPercent = nil
                spin = 0
            }
            if next.kind == .done || next.kind == .failed { startHold() } else { stopHold() }
            announce(next)
        }
        height.t = target.height
        if case let .adding(_, _, percent) = next, let percent {
            // A run's count never goes back, as a folder row's does not.
            targetPercent = max(targetPercent ?? 0, Double(percent))
        }
        fill(next)
        layOut(next.kind, size: target)
        hovering = hovering && isInteractive
        applyColors(animated: next.kind != previous.kind)
        toolTip = next.kind == .idle ? actionItem?.toolTip : nil
        if canAnimate {
            startLoop()
        } else {
            settle()
        }
        render()
    }

    private var contentsByKind: [(MorphIslandState.Kind, IslandContent)] {
        [(.idle, idleContent), (.adding, addingContent), (.done, doneContent), (.failed, failedContent)]
    }

    private var idleTitleText: String { actionItem?.title ?? Self.defaultTitle }

    private static func textWidth(_ text: String, _ font: NSFont) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    /// Each state's size: as wide as the row's highlight, as tall as its contents need.
    func size(for state: MorphIslandState) -> CGSize { boxSize(state.kind) }

    private func boxSize(_ kind: MorphIslandState.Kind) -> CGSize {
        let height: CGFloat
        switch kind {
        case .idle: height = Metric.idleHeight
        case .adding: height = Metric.addingHeight
        case .done, .failed: height = Metric.noticeHeight
        }
        return CGSize(width: max(bounds.width - 2 * Metric.sideInset, 40), height: height)
    }

    /// How far a height has gone from a resting row towards a card, from 0 to 1.
    private static func cardness(_ height: CGFloat) -> CGFloat {
        min(max((height - Metric.idleHeight) / (Metric.noticeHeight - Metric.idleHeight), 0), 1)
    }

    /// A resting row sits in the panel's 26 points; a card has room around it.
    static func rowHeight(for height: CGFloat) -> CGFloat {
        ceil(height + 2 * (1 + 3 * cardness(height)))
    }

    /// The words and symbols for a state.
    private func fill(_ state: MorphIslandState) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        switch state {
        case .idle:
            face.title = idleTitleText
        case let .adding(title, detail, _):
            addingTitle.string = title
            addingDetail.string = detail
        case let .done(title, detail):
            doneTitle.string = title
            doneDetail.string = detail
        case let .failed(title):
            failedTitle.string = title
        }
        CATransaction.commit()
    }

    private func applyItem() {
        fill(state)
        if state.kind == .idle {
            let target = size(for: .idle)
            height.t = target.height
            layOut(.idle, size: target)
            toolTip = actionItem?.toolTip
            if canAnimate { startLoop() } else { settle() }
        }
        hovering = hovering && isInteractive
        applyColors()
        render()
    }

    // MARK: Layout and drawing

    /// Places a kind's pieces in its own box, top down, whichever way the layers are flipped.
    private func layOut(_ kind: MorphIslandState.Kind, size: CGSize) {
        let content: IslandContent
        switch kind {
        case .idle: content = idleContent
        case .adding: content = addingContent
        case .done: content = doneContent
        case .failed: content = failedContent
        }
        let flipped = content.layer.contentsAreFlipped()
        laidOutFlipped = flipped
        boxSizes[kind] = size
        func box(_ x: CGFloat, _ top: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
            CGRect(x: x, y: flipped ? top : size.height - top - height, width: width, height: height)
        }
        func line(_ font: NSFont) -> CGFloat { ceil(font.ascender - font.descender + font.leading) }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        content.layer.bounds = CGRect(origin: .zero, size: size)
        let iconTop = (size.height - Metric.icon) / 2
        let textX = Metric.titleX
        switch kind {
        case .idle:
            // The face draws the resting row; render() places it.
            break
        case .adding:
            let ringInset = (size.height - Metric.ring) / 2
            let ring = box(ringInset - 0.5, ringInset, Metric.ring, Metric.ring)
            let radius = (Metric.ring - Metric.ringLine) / 2
            let center = CGPoint(x: Metric.ring / 2, y: Metric.ring / 2)
            // Starts at twelve o'clock and fills clockwise on screen.
            let path = CGMutablePath()
            if flipped {
                path.addArc(center: center, radius: radius, startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: false)
            } else {
                path.addArc(center: center, radius: radius, startAngle: .pi / 2, endAngle: -1.5 * .pi, clockwise: true)
            }
            // Bounds and position, not frame: the spinning arc may still be rotated.
            for layer in [ringTrack, ringFill] {
                layer.bounds = CGRect(origin: .zero, size: ring.size)
                layer.position = CGPoint(x: ring.midX, y: ring.midY)
                layer.path = path
            }
            let titleHeight = line(Fonts.label), detailHeight = line(Fonts.detail)
            let top = (size.height - titleHeight - detailHeight) / 2
            let x = ring.maxX + 10
            let percentX = size.width - Metric.trailing - Metric.percentWidth
            addingTitle.frame = box(x, top, percentX - 6 - x, titleHeight)
            addingDetail.frame = box(x, top + titleHeight, percentX - 6 - x, detailHeight)
            let numberHeight = line(Fonts.number)
            addingPercent.frame = box(percentX, (size.height - numberHeight) / 2, Metric.percentWidth, numberHeight)
        case .done:
            let labelHeight = line(Fonts.label), numberHeight = line(Fonts.number)
            let detailWidth = Self.textWidth(doneDetail.string as? String ?? "", Fonts.number) + 2
            let detailX = size.width - Metric.trailing - detailWidth
            doneIcon.frame = box(Metric.iconX, iconTop, Metric.icon, Metric.icon)
            doneTitle.frame = box(textX, (size.height - labelHeight) / 2, max(20, detailX - 12 - textX), labelHeight)
            doneDetail.frame = box(detailX, (size.height - numberHeight) / 2, detailWidth, numberHeight)
        case .failed:
            let labelHeight = line(Fonts.label)
            failedIcon.frame = box(Metric.iconX, iconTop, Metric.icon, Metric.icon)
            failedTitle.frame = box(textX, (size.height - labelHeight) / 2, size.width - textX - Metric.trailing, labelHeight)
        }
        CATransaction.commit()
    }

    /// The shape's size this frame. While the height moves fast, the width
    /// gives a little back, as if the shape kept its volume.
    private var pillSize: CGSize {
        let height = max(self.height.x, 12)
        let give = min(max(-self.height.v / 7000, -0.05), 0.05)
        return CGSize(width: boxSize(state.kind).width * (1 + give), height: height)
    }

    /// A row's corners at rest, rounding into a card's as the shape grows.
    private var cornerRadius: CGFloat {
        Metric.rowRadius + (Metric.cardRadius - Metric.rowRadius) * Self.cardness(pillSize.height)
    }

    /// Where the capsule is in the row, before the press scale.
    var pillFrame: NSRect {
        let size = pillSize
        return NSRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
    }

    private func render() {
        let now = clock()
        if let flipped = laidOutFlipped, flipped != idleContent.layer.contentsAreFlipped() {
            for (kind, size) in boxSizes { layOut(kind, size: size) }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let size = pillSize
        shape.bounds = CGRect(origin: .zero, size: size)
        shape.position = CGPoint(x: bounds.midX, y: bounds.midY)
        shape.cornerRadius = cornerRadius
        shape.backgroundColor = washInk.withAlphaComponent(wash.value(at: now)).cgColor
        shape.transform = CATransform3DMakeScale(CGFloat(press.x), CGFloat(press.x), 1)
        for content in contents {
            content.layer.position = CGPoint(x: size.width / 2, y: size.height / 2)
            let opacity = content.opacity.value(at: now)
            content.layer.opacity = Float(opacity)
            content.layer.isHidden = opacity < 0.002
            let scale = CGFloat(content.scale.value(at: now))
            content.layer.transform = CATransform3DMakeScale(scale, scale, 1)
            setBlur(content.layer, radius: content.blur.value(at: now))
        }
        // The resting row stays the row's size, centred on the shape, and fades as its contents would.
        let rest = boxSize(.idle)
        let faceFrame = NSRect(x: bounds.midX - rest.width / 2, y: bounds.midY - rest.height / 2,
                               width: rest.width, height: rest.height)
        if face.frame != faceFrame { face.frame = faceFrame }
        let faceOpacity = idleContent.opacity.value(at: now)
        face.alphaValue = CGFloat(faceOpacity)
        face.isHidden = faceOpacity < 0.002
        face.scale = CGFloat(idleContent.scale.value(at: now) * press.x)
        face.blur = idleContent.blur.value(at: now)
        if targetPercent != nil {
            ringFill.strokeEnd = CGFloat(shownPercent / 100)
            ringFill.setAffineTransform(.identity)
            addingPercent.string = "\(Int(shownPercent.rounded(.down)))%"
        } else {
            // No percentage yet: a short arc goes round.
            ringFill.strokeEnd = 0.28
            ringFill.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(spin)))
            addingPercent.string = ""
        }
        CATransaction.commit()
        fitRowHeight()
        if window?.firstResponder === self { noteFocusRingMaskChanged() }
    }

    private func setBlur(_ layer: CALayer, radius: Double) {
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

    /// The row is as tall as the island is now, or will be, with a little room around it.
    private func fitRowHeight() {
        let needed = Self.rowHeight(for: max(height.x, height.t))
        guard abs(needed - frame.height) >= 1 else { return }
        setFrameSize(NSSize(width: frame.width, height: needed))
        onSizeChange?()
    }

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(newSize.width - frame.width) >= 0.5
        super.setFrameSize(newSize)
        // The panel sets the row's width; every kind's contents follow it.
        if widthChanged {
            for kind in Array(boxSizes.keys) { layOut(kind, size: boxSize(kind)) }
            render()
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.position = CGPoint(x: bounds.midX, y: bounds.midY)
        CATransaction.commit()
    }

    /// The card's fill for the state. A resting row has none: its face draws
    /// the pointer highlight, as the panel's rows do.
    private func fillStrength(dark: Bool) -> Double {
        let lifted = isInteractive && (hovering || pressing)
        switch state.kind {
        case .idle: return 0
        case .adding: return dark ? 0.1 : 0.06
        case .done, .failed: return lifted ? (dark ? 0.15 : 0.1) : (dark ? 0.1 : 0.06)
        }
    }

    private func applyColors(animated: Bool = false) {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let enabled = actionItem?.isEnabled ?? false
        let now = clock()
        let strength = fillStrength(dark: dark)
        if strength != wash.to {
            // A change of kind fades the fill with the shape; the pointer lights a row at once.
            wash = IslandTween(from: wash.value(at: now), to: strength, start: now,
                               duration: animated ? Motion.fillSeconds : 0)
        }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            func resolved(_ color: NSColor) -> NSColor { color.usingColorSpace(.sRGB) ?? color }
            let ink = resolved(.labelColor), quiet = resolved(.secondaryLabelColor)
            let accent = resolved(.controlAccentColor), warning = resolved(.systemOrange)
            let wash: NSColor = dark ? .white : .black
            washInk = wash
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            shape.backgroundColor = wash.withAlphaComponent(self.wash.value(at: now)).cgColor
            ringTrack.strokeColor = wash.withAlphaComponent(dark ? 0.16 : 0.1).cgColor
            ringFill.strokeColor = accent.cgColor
            addingTitle.foregroundColor = ink.cgColor
            addingDetail.foregroundColor = quiet.cgColor
            addingPercent.foregroundColor = accent.cgColor
            doneTitle.foregroundColor = ink.cgColor
            doneDetail.foregroundColor = accent.cgColor
            failedTitle.foregroundColor = ink.cgColor
            CATransaction.commit()
            if symbolColors != [accent, warning] {
                symbolColors = [accent, warning]
                doneIcon.image = Self.symbol("checkmark.circle.fill", colors: [.white, accent])
                failedIcon.image = Self.symbol("exclamationmark.triangle.fill", colors: [.white, warning])
            }
        }
        face.enabled = enabled
        face.highlighted = state.kind == .idle && isInteractive && (hovering || pressing)
        if animated && wash.duration > 0 && canAnimate { startLoop() }
    }

    private static func symbol(_ name: String, colors: [NSColor]) -> NSImage? {
        let configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
            .applying(NSImage.SymbolConfiguration(paletteColors: colors))
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(configuration)
    }

    private func updateScale() {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        let layers: [CALayer] = [shape, ringTrack, ringFill, addingTitle, addingDetail, addingPercent,
                                 doneIcon, doneTitle, doneDetail, failedIcon, failedTitle]
        for layer in layers where layer.contentsScale != scale {
            layer.contentsScale = scale
            layer.setNeedsDisplay()
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColors()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateScale()
    }

    @objc private func systemColorsChanged() { applyColors() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else {
            stopLoop()
            return
        }
        updateScale()
        applyColors()
        if isAtRest(at: clock()) { render() } else { startLoop() }
    }

    // MARK: Frames

    private var canAnimate: Bool { animatesOffscreen || window?.isVisible == true }

    private func startLoop() {
        guard drivesItself, window != nil, frameTimer == nil, displayLinkObject == nil else { return }
        lastFrame = nil
        if #available(macOS 14.0, *) {
            let link = displayLink(target: self, selector: #selector(frameFired))
            link.add(to: .main, forMode: .common)
            displayLinkObject = link
        } else {
            let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
            RunLoop.main.add(timer, forMode: .common)
            frameTimer = timer
        }
    }

    @objc private func frameFired() { tick() }

    private func stopLoop() {
        frameTimer?.invalidate()
        frameTimer = nil
        if #available(macOS 14.0, *) { (displayLinkObject as? CADisplayLink)?.invalidate() }
        displayLinkObject = nil
    }

    /// One frame: springs stepped in four slices, as the original's loop does.
    func tick() {
        let now = clock()
        guard canAnimate else {
            settle()
            render()
            stopLoop()
            return
        }
        let dt = min(max(now - (lastFrame ?? now - 1.0 / 60), 0), 1.0 / 30)
        lastFrame = now
        let slice = dt / Double(Motion.substeps)
        for _ in 0..<Motion.substeps {
            height.step(slice)
            press.step(slice)
        }
        if state.kind == .adding {
            if let target = targetPercent {
                // The same pace as a folder row's count: brisk across a wide gap,
                // about thirty a second across a narrow one.
                if shownPercent < target { shownPercent = min(target, shownPercent + max(30, (target - shownPercent) * 4) * dt) }
            } else {
                spin += dt * 2 * .pi / 1.2
            }
        }
        if isAtRest(at: now) {
            height.snap()
            press.snap()
            render()
            stopLoop()
        } else {
            render()
        }
    }

    func isAtRest(at now: CFTimeInterval) -> Bool {
        let counting = state.kind == .adding && (targetPercent.map { shownPercent < $0 } ?? true)
        return height.isSettled(within: 0.05) && press.isSettled(within: 0.0005)
            && contents.allSatisfy { $0.isDone(at: now) } && wash.isDone(at: now) && !counting
    }

    /// Jumps to where the motion would end, for an island nobody can see.
    private func settle() {
        height.snap()
        wash = .resting(wash.to)
        press.t = 1
        press.snap()
        for content in contents { content.settle() }
        shownPercent = targetPercent ?? 0
    }

    // MARK: Holding a finished addition

    private func startHold() {
        stopHold()
        heldSeconds = 0
        guard drivesItself else { return }
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.hold(for: 0.1) }
        RunLoop.main.add(timer, forMode: .common)
        holdTimer = timer
    }

    private func stopHold() {
        holdTimer?.invalidate()
        holdTimer = nil
    }

    /// Only time on screen counts, so a folder that finishes while the panel
    /// is closed still says it is ready when the panel opens.
    func hold(for seconds: Double) {
        guard state.kind == .done || state.kind == .failed, canAnimate else { return }
        heldSeconds += seconds
        if heldSeconds >= Motion.holdSeconds { endHold() }
    }

    private func endHold() {
        stopHold()
        onHoldEnded?()
    }

    // MARK: Pointer, keys and VoiceOver

    private var isInteractive: Bool {
        switch state.kind {
        case .idle: return actionItem?.isEnabled ?? false
        case .done, .failed: return true
        case .adding: return false
        }
    }

    /// The button opens the folder chooser; a finished line goes away when clicked.
    func activate() {
        switch state.kind {
        case .idle:
            guard let item = actionItem, item.isEnabled, let action = item.action else { return }
            NSApp.sendAction(action, to: item.target, from: self)
        case .done, .failed:
            endHold()
        case .adding:
            break
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let superview else { return nil }
        return pillFrame.contains(convert(point, from: superview)) ? self : nil
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func pointerMoved(_ event: NSEvent) {
        let over = isInteractive && pillFrame.contains(convert(event.locationInWindow, from: nil))
        guard over != hovering else { return }
        hovering = over
        applyColors()
    }

    override func mouseEntered(with event: NSEvent) { pointerMoved(event) }
    override func mouseMoved(with event: NSEvent) { pointerMoved(event) }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        applyColors()
    }

    /// A closed panel keeps its views; read where the pointer really is.
    func refreshHover() {
        if let window, window.isVisible, isInteractive {
            hovering = pillFrame.contains(convert(window.mouseLocationOutsideOfEventStream, from: nil))
        } else {
            hovering = false
        }
        applyColors()
    }

    override func mouseDown(with event: NSEvent) {
        guard isInteractive else { return }
        pressing = true
        press.t = 0.96
        applyColors()
        startLoop()
    }

    override func mouseDragged(with event: NSEvent) {
        guard pressing else { return }
        press.t = pillFrame.contains(convert(event.locationInWindow, from: nil)) ? 0.96 : 1
        startLoop()
    }

    override func mouseUp(with event: NSEvent) {
        guard pressing else { return }
        pressing = false
        press.t = 1
        let inside = pillFrame.contains(convert(event.locationInWindow, from: nil))
        applyColors()
        startLoop()
        if inside { activate() }
    }

    override var acceptsFirstResponder: Bool { isInteractive }
    override var canBecomeKeyView: Bool { isInteractive && NSApp.isFullKeyboardAccessEnabled }

    override func keyDown(with event: NSEvent) {
        if [" ", "\r", "\u{3}"].contains(event.charactersIgnoringModifiers ?? "") { activate() } else { super.keyDown(with: event) }
    }

    override var focusRingMaskBounds: NSRect { pillFrame }

    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: pillFrame, xRadius: cornerRadius, yRadius: cornerRadius).fill()
    }

    override func isAccessibilityElement() -> Bool { true }

    override func accessibilityRole() -> NSAccessibility.Role? {
        switch state.kind {
        case .idle: return .button
        case .adding: return .progressIndicator
        case .done, .failed: return .staticText
        }
    }

    override func accessibilityLabel() -> String? {
        switch state {
        case .idle: return idleTitleText
        case let .adding(title, detail, _): return "\(title). \(detail)"
        case let .done(title, detail): return "\(title), \(detail)"
        case let .failed(title): return title
        }
    }

    override func accessibilityValue() -> Any? {
        if case let .adding(_, _, percent) = state, let percent { return NSNumber(value: percent) }
        return nil
    }

    override func accessibilityMinValue() -> Any? { state.kind == .adding ? NSNumber(value: 0) : nil }
    override func accessibilityMaxValue() -> Any? { state.kind == .adding ? NSNumber(value: 100) : nil }
    override func isAccessibilityEnabled() -> Bool { state.kind != .idle || isInteractive }

    override func accessibilityPerformPress() -> Bool {
        guard isInteractive else { return false }
        activate()
        return true
    }

    /// VoiceOver hears the outcome, as the original's live region announces it.
    private func announce(_ state: MorphIslandState) {
        guard state.kind == .done || state.kind == .failed, let text = accessibilityLabel() else { return }
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }
}
