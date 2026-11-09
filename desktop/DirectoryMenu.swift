import Cocoa

/// Draws its folder's colour directly, so an enabled menu switch stays
/// colored even when its menu window is inactive, and each folder's switch
/// matches its colour dot. NSButton supplies state, keyboard and AX actions.
final class DirectoryTintSwitch: NSButton {
    var tint: DirectoryToggleColor = .blue { didSet { needsDisplay = true } }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 40, height: 24))
        setButtonType(.switch)
        allowsMixedState = false
        isBordered = false
        title = ""
        setAccessibilityRole(.checkBox)
        setAccessibilitySubrole(.switch)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        // Proportions follow the small system switch: a capsule track with a
        // round white knob that carries a soft shadow and hairline edge.
        let track = NSRect(x: (bounds.width - 30) / 2, y: (bounds.height - 17) / 2,
                           width: 30, height: 17)
        let opacity: CGFloat = isEnabled ? 1 : 0.45
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let offColor = dark ? NSColor(white: 1, alpha: 0.16) : NSColor(white: 0, alpha: 0.1)
        (state == .on ? tint.color : offColor).withAlphaComponent((state == .on ? 1 : offColor.alphaComponent) * opacity).setFill()
        NSBezierPath(roundedRect: track, xRadius: track.height / 2, yRadius: track.height / 2).fill()
        let knob = NSRect(x: state == .on ? track.maxX - 16 : track.minX + 1,
                          y: track.minY + 1, width: 15, height: 15)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.25 * opacity)
        shadow.shadowBlurRadius = 1.5
        shadow.shadowOffset = NSSize(width: 0, height: -0.5)
        shadow.set()
        NSColor.white.withAlphaComponent(dark && state != .on ? 0.85 * opacity : opacity).setFill()
        NSBezierPath(ovalIn: knob).fill()
        NSGraphicsContext.restoreGraphicsState()
        NSColor.black.withAlphaComponent(0.08 * opacity).setStroke()
        let edge = NSBezierPath(ovalIn: knob.insetBy(dx: 0.25, dy: 0.25))
        edge.lineWidth = 0.5
        edge.stroke()
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            let ring = NSBezierPath(roundedRect: track.insetBy(dx: -2.5, dy: -2.5), xRadius: 11, yRadius: 11)
            ring.lineWidth = 2.5
            ring.stroke()
        }
    }
}

final class DirectoryColorButton: NSButton {
    var tint: DirectoryToggleColor {
        didSet {
            needsDisplay = true
            refreshAccessibilityValue()
        }
    }
    var selected = false {
        didSet {
            needsDisplay = true
            refreshAccessibilityValue()
        }
    }
    var onPick: (() -> Void)?

    init(color: DirectoryToggleColor, label: String) {
        tint = color
        super.init(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
        isBordered = false
        title = ""
        setAccessibilityLabel(label)
        setAccessibilityValue(color.title)
        target = self
        action = #selector(pick)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let circle = NSRect(x: (bounds.width - 10) / 2, y: (bounds.height - 10) / 2,
                            width: 10, height: 10)
        tint.color.withAlphaComponent(isEnabled ? 1 : 0.45).setFill()
        NSBezierPath(ovalIn: circle).fill()
        if selected || window?.firstResponder === self {
            NSColor.labelColor.withAlphaComponent(0.65).setStroke()
            let ring = NSBezierPath(ovalIn: circle.insetBy(dx: -2.5, dy: -2.5))
            ring.lineWidth = 1
            ring.stroke()
        }
    }

    @objc private func pick() { onPick?() }

    private func refreshAccessibilityValue() {
        setAccessibilityValue(selected ? "\(tint.title), selected" : tint.title)
    }
}

/// The selection circle shown in place of a folder icon while choosing
/// directories to remove: empty when unselected, a filled checkmark when
/// selected. The glyph lives on its own centered layer so it can scale from
/// its middle; the button supplies click, keyboard and AX behaviour.
final class DirectorySelectionMark: NSButton {
    private static let glyphSize: CGFloat = 16
    private static let popDuration: CFTimeInterval = 0.32
    private static let hideDuration: CFTimeInterval = 0.16
    private let glyph = CALayer()
    private var showing = false
    var onToggle: (() -> Void)?
    var isSelected = false {
        didSet {
            guard isSelected != oldValue else { return }
            setAccessibilityValue(isSelected ? 1 : 0)
            refreshGlyph()
        }
    }

    init(label: String) {
        super.init(frame: NSRect(x: 0, y: 0, width: 22, height: 22))
        isBordered = false
        title = ""
        wantsLayer = true
        target = self
        action = #selector(toggle)
        setAccessibilityRole(.checkBox)
        setAccessibilityLabel(label)
        setAccessibilityValue(0)
        glyph.contentsGravity = .resizeAspect
        layer?.addSublayer(glyph)
        refreshGlyph()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isEnabled: Bool { didSet { glyph.opacity = isEnabled ? 1 : 0.45 } }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() { refreshGlyph() }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let size = Self.glyphSize
        glyph.bounds = NSRect(x: 0, y: 0, width: size, height: size)
        glyph.position = NSPoint(x: bounds.midX, y: bounds.midY)
        CATransaction.commit()
    }

    /// A white checkmark on the accent colour when selected, an empty circle
    /// otherwise, as in native list selection modes.
    private func refreshGlyph() {
        let base = NSImage.SymbolConfiguration(pointSize: Self.glyphSize, weight: .regular)
        let configuration = isSelected
            ? base.applying(.init(paletteColors: [.white, .controlAccentColor]))
            : base.applying(.init(paletteColors: [.secondaryLabelColor]))
        let image = NSImage(systemSymbolName: isSelected ? "checkmark.circle.fill" : "circle",
                            accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration)
        glyph.contentsScale = window?.backingScaleFactor ?? 2
        // Resolve dynamic colours for this view's light or dark appearance.
        effectiveAppearance.performAsCurrentDrawingAppearance {
            glyph.contents = image?.layerContents(forContentsScale: glyph.contentsScale)
        }
    }

    /// Springs the glyph in from a point, like badges entering edit mode.
    func popIn(animated: Bool) {
        showing = true
        isHidden = false
        glyph.removeAllAnimations()
        glyph.transform = CATransform3DIdentity
        glyph.opacity = isEnabled ? 1 : 0.45
        guard animated else { return }
        let scale = CASpringAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.2
        scale.toValue = 1
        scale.damping = 14
        scale.stiffness = 260
        scale.mass = 0.8
        scale.duration = Self.popDuration
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.duration = Self.popDuration / 2
        glyph.add(scale, forKey: "pop")
        glyph.add(fade, forKey: "fade")
    }

    /// Shrinks the glyph away, then hides the button.
    func popOut(animated: Bool) {
        showing = false
        guard animated, !isHidden else { isHidden = true; return }
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            // A pop in that started meanwhile keeps the badge on screen.
            guard let self, !self.showing else { return }
            self.isHidden = true
        }
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 1
        scale.toValue = 0.2
        scale.timingFunction = CAMediaTimingFunction(name: .easeIn)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = glyph.opacity
        fade.toValue = 0
        for animation in [scale, fade] {
            animation.duration = Self.hideDuration
            animation.fillMode = .forwards
            animation.isRemovedOnCompletion = false
        }
        glyph.removeAnimation(forKey: "pop")
        glyph.add(scale, forKey: "shrink")
        glyph.add(fade, forKey: "fade")
        CATransaction.commit()
    }

    @objc private func toggle() { onToggle?() }
}

/// Visible feedback while a directory request reads or re-indexes files. The
/// server replies when it finishes, so the native bar stays indeterminate.
final class NativeMenuProgressRow: NSView {
    let actionItem: NSMenuItem
    private let titleLabel: NSTextField
    /// No folder reports how far a removal has got, so its blocks sweep the track.
    let progress = DirectoryProgressBar()

    override var isFlipped: Bool { true }

    init(item: NSMenuItem) {
        actionItem = item
        titleLabel = NSTextField(labelWithString: item.title)
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 48))
        autoresizingMask = [.width]
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingMiddle
        titleLabel.frame = NSRect(x: 14, y: 1, width: 252, height: 20)
        titleLabel.autoresizingMask = [.width]
        titleLabel.toolTip = item.title
        addSubview(titleLabel)
        progress.indeterminate = true
        progress.frame = NSRect(x: 14, y: 27, width: 252, height: 9)
        progress.autoresizingMask = [.width]
        progress.setAccessibilityLabel(item.title)
        progress.setAccessibilityHelp("Lasso is updating your work directories. This indicator stays active until the operation finishes.")
        addSubview(progress)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

}

private func dispatchMenuAction(_ item: NSMenuItem) {
    guard item.isEnabled, let action = item.action else { return }
    NSApp.sendAction(action, to: item.target, from: item)
}

/// The small exclamation mark left of a folder icon when the folder has an
/// issue. Hovering it, or clicking it, asks for the card that explains it.
final class DirectoryIssueBadge: NSView {
    static let size: CGFloat = 12
    var issue: DirectoryIssue? {
        didSet {
            isHidden = issue == nil
            setAccessibilityLabel(issue.map { "Issue: " + $0.message })
        }
    }
    var onHover: ((Bool) -> Void)?
    private let image = NSImageView()

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: Self.size, height: Self.size))
        image.frame = bounds
        image.image = NSImage(systemSymbolName: "exclamationmark.circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: Self.size - 1, weight: .semibold))
        image.contentTintColor = .systemOrange
        image.setAccessibilityElement(false)
        addSubview(image)
        isHidden = true
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        // A little wider than the glyph, so a pointer passing near it still counts.
        addTrackingArea(NSTrackingArea(rect: bounds.insetBy(dx: -3, dy: -3),
            options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
    // A click explains the issue instead of switching the folder on or off.
    override func mouseDown(with event: NSEvent) { onHover?(true) }
}

/// A track of shaded blocks that fills in the system accent, after Loading
/// UI's accordion loader: a solid block leads, a dark and a light shade trail
/// it, and they spread apart as the bar moves and close up when it rests. The
/// solid block is where the work has got to; the fill settles behind the
/// slowest shade, so at rest the bar is solid up to its value. Drawn
/// directly, like the switch it stands in for, so it keeps its colour when
/// the menu's window is not key.
final class DirectoryProgressBar: NSView {
    static let track: Character = "\u{2591}"
    static let light: Character = "\u{2592}"
    static let dark: Character = "\u{2593}"
    static let solid: Character = "\u{2588}"
    /// How far behind the leading block each shade trails as the bar fills, as in the loader.
    static let lag: [Double] = [0.04, 0.08]
    /// One sweep there and back while nothing reports a percentage.
    static let sweepSeconds: Double = 2.8

    /// From 0 to 100: where the leading block is.
    var value: Double = 0 {
        didSet {
            guard value != oldValue else { return }
            if animates { startAnimating() } else { settle() }
            needsDisplay = true
        }
    }
    /// With no percentage to show, the blocks sweep the track back and forth.
    var indeterminate = false {
        didSet {
            needsDisplay = true
            if indeterminate && animates { startAnimating() }
        }
    }
    /// The shades' places, in cells: each follows the one ahead of it.
    private(set) var followers: [Double] = [0, 0]
    private var timer: Timer?
    private var elapsed: Double = 0
    private var lastFrame: CFTimeInterval = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { timer?.invalidate() }

    private var animates: Bool {
        window != nil && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    private var metrics: (height: CGFloat, font: NSFont, size: NSSize, block: NSRect)?

    /// Block glyphs fill the line, so the bar is as tall as the font's line.
    /// `block` is where the solid glyph's ink falls, from the baseline.
    private var glyphMetrics: (font: NSFont, size: NSSize, block: NSRect) {
        if let metrics, metrics.height == bounds.height { return (metrics.font, metrics.size, metrics.block) }
        let points = max(6, min(9, bounds.height * 0.82))
        let font = NSFont(name: "Menlo", size: points) ?? .monospacedSystemFont(ofSize: points, weight: .regular)
        let size = (String(Self.solid) as NSString).size(withAttributes: [.font: font])
        var character = Self.solid.utf16.first!
        var glyph: CGGlyph = 0
        CTFontGetGlyphsForCharacters(font, &character, &glyph, 1)
        let block = font.boundingRect(forCGGlyph: glyph)
        metrics = (bounds.height, font, size, block)
        return (font, size, block)
    }

    /// How many cells fit across the bar.
    var cellCount: Int { max(4, Int(bounds.width / max(1, glyphMetrics.size.width))) }

    /// The leading block's place, in cells.
    var lead: Double {
        let cells = Double(cellCount)
        if indeterminate { return Self.sweep(elapsed, cells: cells) }
        return cells * min(max(value, 0), 100) / 100
    }

    /// Where a block sweeping the track is at a time: eased there and back.
    static func sweep(_ time: Double, cells: Double) -> Double {
        let phase = (time.truncatingRemainder(dividingBy: sweepSeconds) + sweepSeconds)
            .truncatingRemainder(dividingBy: sweepSeconds) / sweepSeconds
        let half = phase < 0.5 ? phase * 2 : (1 - phase) * 2
        let eased = half < 0.5 ? 2 * half * half : 1 - pow(-2 * half + 2, 2) / 2
        return eased * max(0, cells - 1)
    }

    /**
     The glyph each cell shows. `lead` and `followers` are places in cells.
     A filling bar shows a cell solid once it is wholly reached, so 99% never
     looks done; the shades trailing a moving leader sit in the cells they
     are crossing, behind it, and at rest they are hidden in the solid fill.
     A sweeping bar has only its three blocks on the track.
     */
    static func cells(count: Int, lead: Double, followers: [Double], fills: Bool) -> [Character] {
        guard count > 0 else { return [] }
        if !fills {
            let at = { (place: Double) in min(count - 1, max(0, Int(place.rounded()))) }
            var cells = [Character](repeating: track, count: count)
            for (place, glyph) in zip(followers, [dark, light]).reversed() { cells[at(place)] = glyph }
            cells[at(lead)] = solid
            return cells
        }
        let leader = min(count, Int(max(0, lead))) - 1
        let solidCells = min(leader + 1, Int(max(0, followers.min() ?? lead)))
        var cells = [Character](repeating: track, count: count)
        for index in 0..<max(0, solidCells) { cells[index] = solid }
        for (place, glyph) in zip(followers, [dark, light]) {
            let crossing = Int(max(0, place))
            if crossing < leader && cells[crossing] == track { cells[crossing] = glyph }
        }
        if leader >= 0 { cells[leader] = solid }
        return cells
    }

    /// The glyphs on screen now, for tests and VoiceOver's sake.
    var glyphs: [Character] { Self.cells(count: cellCount, lead: lead, followers: followers, fills: !indeterminate) }

    /// Shades join the leading block at once, as with Reduce Motion.
    func settle() {
        followers = followers.map { _ in lead }
        stopAnimating()
    }

    /// One frame. Public so tests can step it without a run loop.
    func advance(by seconds: Double) {
        elapsed += seconds
        if indeterminate {
            // The loader's shades trail by a block and two at full speed and
            // bunch up where it turns; the delays that do that depend on how
            // many cells the track has.
            let cells = Double(cellCount)
            let fastest = 4 * max(1, cells - 1) / Self.sweepSeconds
            followers = [1.0, 2.0].map { Self.sweep(elapsed - $0 / fastest, cells: cells) }
        } else {
            // Each shade closes on the block ahead of it, as a delay would.
            var ahead = lead
            followers = zip(followers, Self.lag).map { place, lag in
                let caught = place + (ahead - place) * (1 - exp(-seconds / (lag * 0.75)))
                ahead = caught
                return caught
            }
            if followers.allSatisfy({ abs($0 - lead) < 0.02 }) {
                followers = followers.map { _ in lead }
                stopAnimating()
            }
        }
        needsDisplay = true
    }

    private func startAnimating() {
        guard timer == nil else { return }
        lastFrame = CACurrentMediaTime()
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            let now = CACurrentMediaTime()
            self.advance(by: min(0.1, now - self.lastFrame))
            self.lastFrame = now
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func stopAnimating() {
        timer?.invalidate()
        timer = nil
    }

    var isAnimating: Bool { timer != nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil || isHidden { stopAnimating(); return }
        if indeterminate && animates { startAnimating() }
    }

    override var isHidden: Bool {
        didSet { if isHidden { stopAnimating() } else if indeterminate && animates { startAnimating() } }
    }

    override func draw(_ dirtyRect: NSRect) {
        let glyphs = self.glyphs
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let trackColor = NSColor.labelColor.withAlphaComponent(dark ? 0.42 : 0.34)
        let (font, size, block) = glyphMetrics
        let origin = (bounds.height - size.height) / 2
        let fill = NSColor.controlAccentColor
        // Solid blocks are filled as one rectangle where their ink would be,
        // since glyphs side by side leave hairline seams; the shades are drawn
        // as glyphs, a run of one at a time at the font's own spacing.
        var start = 0
        while start < glyphs.count {
            var end = start
            while end < glyphs.count && glyphs[end] == glyphs[start] { end += 1 }
            let x = CGFloat(start) * size.width
            if glyphs[start] == Self.solid {
                fill.setFill()
                let ink = NSRect(x: x, y: origin - font.descender + block.minY,
                                 width: CGFloat(end - start) * size.width, height: block.height)
                backingAlignedRect(ink, options: .alignAllEdgesNearest).fill()
            } else {
                (String(repeating: String(glyphs[start]), count: end - start) as NSString)
                    .draw(at: NSPoint(x: x, y: origin),
                          withAttributes: [.font: font, .foregroundColor: glyphs[start] == Self.track ? trackColor : fill])
            }
            start = end
        }
    }
}

/// Counts a folder's percentage up to what the server last reported, one
/// percent after another, so a report that jumps from 12% to 40% plays as a
/// count rather than a leap. It never runs ahead of the server, and never
/// back: the bar shows only work that is done.
final class ProgressCounter {
    private(set) var shown: Double = 0
    private(set) var target: Double = 0
    private var timer: Timer?
    var onChange: ((Double) -> Void)?
    /// Called each time the count catches up with the latest report.
    var onCaughtUp: (() -> Void)?
    var isCounting: Bool { timer != nil }

    /// Percent per second: brisk across a wide gap, about thirty a second
    /// across a narrow one, so each percent is visible as it passes.
    static func speed(gap: Double) -> Double { max(30, gap * 4) }

    func move(to value: Double, animated: Bool) {
        target = min(100, max(value, target))
        guard animated else {
            stop()
            shown = target
            onChange?(shown)
            onCaughtUp?()
            return
        }
        guard shown < target else { onCaughtUp?(); return }
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.advance(by: 1.0 / 60) }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// One frame of the count. Public so tests can step it without a run loop.
    func advance(by seconds: Double) {
        let gap = target - shown
        guard gap > 0 else { stop(); onCaughtUp?(); return }
        shown = min(target, shown + Self.speed(gap: gap) * seconds)
        onChange?(shown)
        if shown >= target {
            stop()
            onCaughtUp?()
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Back to 0% for a new run: the count never moves back within one.
    func reset() {
        stop()
        shown = 0
        target = 0
        onChange?(shown)
    }

    deinit { timer?.invalidate() }
}

/// A command in a row's context menu, for rows that are not folders.
struct RowAction {
    let title: String
    var enabled = true
    var help: String?
    let perform: () -> Void
}

private final class RowActionItem: NSMenuItem {
    private let perform: () -> Void

    init(_ action: RowAction) {
        perform = action.perform
        super.init(title: action.title, action: #selector(run), keyEquivalent: "")
        target = self
        isEnabled = action.enabled
        toolTip = action.help
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func run() { perform() }
}

final class NativeMenuToggleRow: NSView {
    private var item: NSMenuItem
    private let titleLabel: NSTextField
    private var icon: NSImageView?
    private let toggle = DirectoryTintSwitch()
    private let colorButton: DirectoryColorButton
    private let onColorChange: (DirectoryToggleColor) -> Void
    private var palette: DirectoryColorPaletteRow?
    private(set) var isPaletteVisible = false
    var currentColor: DirectoryToggleColor { colorButton.tint }
    var actionItem: NSMenuItem { item }
    var onSizeChange: (() -> Void)?
    var onReveal: (() -> Void)?
    var onRemove: (() -> Void)?
    /// Replaces Show in Finder and Remove, read when the menu opens; nil is a separator.
    var contextActions: (() -> [RowAction?])?
    private let issueBadge = DirectoryIssueBadge()
    var issue: DirectoryIssue? {
        get { issueBadge.issue }
        set { issueBadge.issue = newValue }
    }
    /// Shown as the issue badge's hover card, when the issue is Lasso's to fix.
    var onFix: (() -> Void)?
    /// The pointer moved onto (true) or off (false) the issue badge.
    var onIssueHover: ((NativeMenuToggleRow, Bool) -> Void)?
    var issueAnchor: NSView { issueBadge }
    /// Selection mode: called with true when Shift extends a range.
    var onSelect: ((Bool) -> Void)?
    private let selectionMark: DirectorySelectionMark
    private(set) var isSelecting = false
    var isSelected: Bool { selectionMark.isSelected }
    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }
    private let progressBar = DirectoryProgressBar()
    private let percentLabel = NSTextField(labelWithString: "")
    let progressCounter = ProgressCounter()
    /// The server stopped reporting: the count finishes at 100% before the
    /// row gives back its switch.
    private var finishingProgress = false
    private var hideProgress: DispatchWorkItem?
    /// While the folder is read, its row shows how far that has got in place of its switch.
    var progress: DirectoryProgress? {
        didSet { applyProgress(previous: oldValue) }
    }
    var isShowingProgress: Bool { !progressBar.isHidden }
    var progressBarView: DirectoryProgressBar { progressBar }
    var percentText: String { percentLabel.stringValue }
    /// How long the full bar stays before the switch returns.
    static let progressHoldSeconds: TimeInterval = 0.45
    /// Room for "100%" to the right of the bar.
    static let percentWidth: CGFloat = 32
    private let titleX: CGFloat

    override var isFlipped: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: NSRect(x: 0, y: 0, width: bounds.width, height: 32),
            options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil))
        refreshHover()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refreshHover()
        if window != nil { hasBeenOnScreen = true }
        // A count left behind while the menu was closed finishes on screen.
        if window != nil, !progressBar.isHidden {
            progressCounter.move(to: finishingProgress ? 100 : progressCounter.target, animated: animatesProgress)
        }
    }

    override func mouseEntered(with event: NSEvent) { hovering = item.isEnabled }
    override func mouseExited(with event: NSEvent) { hovering = false }

    /// Rows are reused across popover openings and scroll under a still
    /// pointer, neither of which sends an exit event. Read where it really is.
    func refreshHover() {
        guard let window, window.isVisible, item.isEnabled else { hovering = false; return }
        let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
        hovering = NSRect(x: 0, y: 0, width: bounds.width, height: 32).intersection(visibleRect).contains(point)
    }

    override func draw(_ dirtyRect: NSRect) {
        let highlighted = isSelecting && isSelected
        guard hovering || highlighted else { return }
        (highlighted ? NSColor.controlAccentColor.withAlphaComponent(hovering ? 0.22 : 0.15)
            : NSColor.labelColor.withAlphaComponent(0.1)).setFill()
        NSBezierPath(roundedRect: NSRect(x: 4, y: 2, width: bounds.width - 8, height: 28),
                     xRadius: 5, yRadius: 5).fill()
    }

    init(item: NSMenuItem, color: DirectoryToggleColor, selecting: Bool = false, selected: Bool = false,
         onColorChange: @escaping (DirectoryToggleColor) -> Void) {
        self.item = item
        selectionMark = DirectorySelectionMark(label: "Select \(item.title)")
        colorButton = DirectoryColorButton(color: color, label: "Highlight color for \(item.title)")
        self.onColorChange = onColorChange
        titleLabel = NSTextField(labelWithString: item.title)
        let title = titleLabel
        title.font = .menuFont(ofSize: 0)
        title.textColor = item.isEnabled ? .labelColor : .disabledControlTextColor
        title.lineBreakMode = .byTruncatingMiddle
        title.setAccessibilityElement(false)
        title.sizeToFit()
        toggle.tint = color
        toggle.state = item.state
        toggle.isEnabled = item.isEnabled
        toggle.setAccessibilityLabel(item.title)
        toggle.setAccessibilityHelp(item.toolTip)
        colorButton.isEnabled = item.isEnabled
        colorButton.toolTip = "Highlight color for text inserted from this folder"

        let iconWidth: CGFloat = item.image == nil ? 0 : 22
        let width = min(480, max(260, 14 + iconWidth + title.frame.width + 18 + 24 + 8 + 40 + 12))
        titleX = 14 + iconWidth
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: 32))
        autoresizingMask = [.width]
        toolTip = item.toolTip
        setAccessibilityElement(false)
        if let image = item.image {
            let icon = NSImageView(frame: NSRect(x: 14, y: 8, width: 16, height: 16))
            self.icon = icon
            icon.image = image
            icon.contentTintColor = item.isEnabled ? .secondaryLabelColor : .disabledControlTextColor
            icon.setAccessibilityElement(false)
            addSubview(icon)
        }
        title.frame = NSRect(x: 14 + iconWidth, y: (32 - title.frame.height) / 2,
                             width: width - 14 - iconWidth - 18 - 24 - 8 - 40 - 12,
                             height: title.frame.height)
        title.autoresizingMask = [.width]
        addSubview(title)
        toggle.setFrameOrigin(NSPoint(x: width - 12 - 40, y: 4))
        toggle.autoresizingMask = [.minXMargin]
        toggle.target = self
        toggle.action = #selector(activate)
        addSubview(toggle)
        colorButton.setFrameOrigin(NSPoint(x: toggle.frame.minX - 8 - 24, y: 4))
        colorButton.autoresizingMask = [.minXMargin]
        colorButton.onPick = { [weak self] in
            guard let self, self.item.isEnabled else { return }
            self.setPaletteVisible(!self.isPaletteVisible)
        }
        addSubview(colorButton)
        // The mark takes the folder icon's place, centered on the same point.
        selectionMark.setFrameOrigin(NSPoint(x: 14 + 8 - selectionMark.frame.width / 2,
                                             y: 16 - selectionMark.frame.height / 2))
        selectionMark.toolTip = "Select to remove from Lasso. The folder and its files are not changed."
        selectionMark.isEnabled = item.isEnabled
        selectionMark.isHidden = true
        selectionMark.onToggle = { [weak self] in self?.select() }
        addSubview(selectionMark)
        // Left of the folder icon, centred on the same line.
        issueBadge.setFrameOrigin(NSPoint(x: 1, y: 16 - DirectoryIssueBadge.size / 2))
        issueBadge.onHover = { [weak self] inside in
            guard let self else { return }
            self.onIssueHover?(self, inside)
        }
        addSubview(issueBadge)
        // A bar under the name, with the count where the switch is.
        progressBar.autoresizingMask = [.width]
        progressBar.setAccessibilityLabel("Indexing \(item.title)")
        progressBar.isHidden = true
        addSubview(progressBar)
        percentLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .medium)
        percentLabel.textColor = .secondaryLabelColor
        percentLabel.alignment = .right
        percentLabel.autoresizingMask = [.minXMargin]
        percentLabel.setAccessibilityElement(false)
        percentLabel.isHidden = true
        addSubview(percentLabel)
        progressCounter.onChange = { [weak self] shown in self?.showCount(shown) }
        progressCounter.onCaughtUp = { [weak self] in self?.countCaughtUp() }
        setSelecting(selecting, selected: selected, animated: false)
    }

    /// Counting plays once a row has been on screen, and not with Reduce
    /// Motion: a row built for the next menu takes its value at once. The
    /// menu detaches its rows while it rebuilds, which is when the next report
    /// arrives, so being in a window right now is not the test.
    private var hasBeenOnScreen = false
    private var animatesProgress: Bool {
        (hasBeenOnScreen || window != nil) && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    private func applyProgress(previous: DirectoryProgress?) {
        if let progress {
            // A new run counts from 0%, also after one that reached 100%:
            // the count never moves back within a run, so it starts afresh.
            let starting = progressBar.isHidden || finishingProgress
            hideProgress?.cancel()
            hideProgress = nil
            finishingProgress = false
            if starting {
                progressCounter.reset()
                progressBar.settle()
            }
            if progressBar.isHidden { setProgressVisible(true) }
            progressCounter.move(to: Double(progress.percent), animated: animatesProgress)
            progressBar.setAccessibilityHelp(progress.activity)
            toolTip = "\(progress.activity)\u{2026}"
        } else if previous != nil && !progressBar.isHidden {
            // Done: count the rest of the way, then give the row back its switch.
            finishingProgress = true
            toolTip = item.toolTip
            progressCounter.move(to: 100, animated: animatesProgress)
        }
    }

    private func showCount(_ shown: Double) {
        let percent = Int(shown.rounded(.down))
        progressBar.value = shown
        percentLabel.stringValue = "\(percent)%"
        progressBar.setAccessibilityValue("\(percent) percent")
    }

    private func countCaughtUp() {
        guard finishingProgress, progressCounter.shown >= 100, hideProgress == nil else { return }
        let hide = DispatchWorkItem { [weak self] in
            guard let self, self.finishingProgress else { return }
            self.hideProgress = nil
            self.finishingProgress = false
            self.setProgressVisible(false)
        }
        hideProgress = hide
        if animatesProgress {
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.progressHoldSeconds, execute: hide)
        } else {
            hide.perform()
        }
    }

    /// Swaps the switch and colour circle for the percentage and bar, or back.
    private func setProgressVisible(_ visible: Bool) {
        let width = bounds.width
        progressBar.isHidden = !visible
        percentLabel.isHidden = !visible
        toggle.isHidden = visible
        colorButton.isHidden = visible
        if visible {
            setPaletteVisible(false)
            progressCounter.stop()
            showCount(progressCounter.shown)
            // The name above, and the bar under it with its percentage to its right.
            titleLabel.frame = NSRect(x: titleX, y: 2, width: max(40, width - titleX - 12),
                                      height: titleLabel.frame.height)
            percentLabel.frame = NSRect(x: width - 12 - Self.percentWidth, y: 19, width: Self.percentWidth, height: 12)
            progressBar.frame = NSRect(x: titleX, y: 21, width: max(40, width - titleX - 12 - Self.percentWidth - 6), height: 9)
        } else {
            titleLabel.frame = NSRect(x: titleX, y: (32 - titleLabel.frame.height) / 2,
                                      width: max(40, width - titleX - 18 - 24 - 8 - 40 - 12),
                                      height: titleLabel.frame.height)
        }
        refreshColors()
        needsDisplay = true
    }

    /// A folder being read cannot be switched, but it is not dimmed: it is the
    /// row the user is watching.
    private func refreshColors() {
        let lit = item.isEnabled || !progressBar.isHidden
        titleLabel.textColor = lit ? .labelColor : .disabledControlTextColor
        icon?.contentTintColor = lit ? .secondaryLabelColor : .disabledControlTextColor
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Swaps the folder icon for a selection circle, or back again.
    func setSelecting(_ selecting: Bool, selected: Bool, animated: Bool) {
        if selectionMark.isSelected != selected {
            selectionMark.isSelected = selected
            needsDisplay = true
        }
        let animated = animated && window?.isVisible == true
        guard selecting != isSelecting || !animated else { return }
        isSelecting = selecting
        needsDisplay = true
        if selecting { selectionMark.popIn(animated: animated) } else { selectionMark.popOut(animated: animated) }
        guard let icon else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = animated ? 0.18 : 0
            context.allowsImplicitAnimation = animated
            (animated ? icon.animator() : icon).alphaValue = selecting ? 0 : 1
        }
    }

    private func select() {
        guard item.isEnabled, isSelecting else { return }
        onSelect?(NSApp.currentEvent?.modifierFlags.contains(.shift) == true)
    }

    func update(item: NSMenuItem, color: DirectoryToggleColor) {
        self.item = item
        titleLabel.stringValue = item.title
        icon?.image = item.image
        refreshColors()
        toggle.tint = color
        toggle.state = item.state
        toggle.isEnabled = item.isEnabled
        toggle.setAccessibilityLabel(item.title)
        toggle.setAccessibilityHelp(item.toolTip)
        colorButton.tint = color
        colorButton.isEnabled = item.isEnabled
        colorButton.setAccessibilityLabel("Highlight color for \(item.title)")
        palette?.update(selected: color, isEnabled: item.isEnabled)
        selectionMark.isEnabled = item.isEnabled
        selectionMark.setAccessibilityLabel("Select \(item.title)")
        progressBar.setAccessibilityLabel("Indexing \(item.title)")
        toolTip = progress.map { "\($0.activity)\u{2026}" } ?? item.toolTip
        refreshHover()
    }

    func setPaletteVisible(_ visible: Bool) {
        guard visible != isPaletteVisible else { return }
        isPaletteVisible = visible
        if visible {
            let palette = DirectoryColorPaletteRow(selected: colorButton.tint) { [weak self] color in
                guard let self, self.item.isEnabled else { return }
                self.colorButton.tint = color
                self.toggle.tint = color
                self.palette?.update(selected: color, isEnabled: self.item.isEnabled)
                self.onColorChange(color)
            }
            palette.frame = NSRect(x: 0, y: 32, width: frame.width, height: 32)
            palette.autoresizingMask = [.width]
            palette.update(selected: colorButton.tint, isEnabled: item.isEnabled)
            self.palette = palette
            addSubview(palette)
        } else {
            palette?.removeFromSuperview()
            palette = nil
        }
        setFrameSize(NSSize(width: frame.width, height: visible ? 64 : 32))
        onSizeChange?()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        // While selecting, a click anywhere on the row selects it, so a stray
        // click cannot also switch the folder off or change its colour.
        if isSelecting { return hit === selectionMark ? hit : self }
        if hit === issueBadge || hit.isDescendant(of: issueBadge) { return issueBadge }
        if hit === toggle || hit.isDescendant(of: toggle)
            || hit === colorButton || hit.isDescendant(of: colorButton) { return hit }
        if let palette, hit === palette || hit.isDescendant(of: palette) { return hit }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        guard item.isEnabled else { return }
        if isSelecting { select() } else { toggle.performClick(nil) }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        menu.autoenablesItems = false
        if let actions = contextActions?() {
            for action in actions { menu.addItem(action.map(RowActionItem.init) ?? .separator()) }
            return menu
        }
        let reveal = NSMenuItem(title: "Show in Finder", action: #selector(reveal), keyEquivalent: "")
        reveal.target = self
        reveal.isEnabled = !item.title.hasSuffix(" (unavailable)")
        menu.addItem(reveal)
        menu.addItem(.separator())
        let remove = NSMenuItem(title: "Remove from Lasso", action: #selector(remove), keyEquivalent: "")
        remove.target = self
        remove.isEnabled = item.isEnabled
        remove.toolTip = "The folder and its files are not changed."
        menu.addItem(remove)
        return menu
    }

    @objc private func reveal() { onReveal?() }
    @objc private func remove() { onRemove?() }

    @objc private func activate() {
        dispatchMenuAction(item)
    }
}

final class DirectoryColorPaletteRow: NSView {
    private var buttons: [DirectoryColorButton] = []

    init(selected: DirectoryToggleColor, onPick: @escaping (DirectoryToggleColor) -> Void) {
        super.init(frame: NSRect(x: 0, y: 0, width: CGFloat(DirectoryToggleColor.allCases.count) * 28 + 16, height: 32))
        setAccessibilityElement(false)
        for (index, color) in DirectoryToggleColor.allCases.enumerated() {
            let button = DirectoryColorButton(color: color, label: "Use \(color.title)")
            button.selected = color == selected
            button.setFrameOrigin(NSPoint(x: 8 + CGFloat(index) * 28, y: 4))
            button.onPick = { [weak self] in
                self?.update(selected: color, isEnabled: true)
                onPick(color)
            }
            buttons.append(button)
            addSubview(button)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(selected: DirectoryToggleColor, isEnabled: Bool) {
        for button in buttons {
            button.selected = button.tint == selected
            button.isEnabled = isEnabled
        }
    }
}

final class NativeMenuDisclosureRow: NSView {
    private var item: NSMenuItem
    var actionItem: NSMenuItem { item }
    private let button: NSButton
    private let total: NSTextField

    init(item: NSMenuItem, expanded: Bool, count: Int) {
        self.item = item
        button = NSButton(title: item.title, target: nil, action: nil)
        total = NSTextField(labelWithString: String(count))
        super.init(frame: NSRect(x: 0, y: 0, width: 260, height: 28))
        autoresizingMask = [.width]
        button.target = self
        button.action = #selector(activate)
        button.frame = NSRect(x: 12, y: 3, width: 206, height: 22)
        button.autoresizingMask = [.width]
        button.isBordered = false
        button.alignment = .left
        button.attributedTitle = NSAttributedString(string: item.title, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.secondaryLabelColor])
        button.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right",
                               accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .bold))
        button.imagePosition = .imageLeading
        button.imageHugsTitle = true
        button.contentTintColor = .secondaryLabelColor
        button.setAccessibilityLabel("\(expanded ? "Collapse" : "Expand") \(item.title)")
        addSubview(button)
        total.font = .systemFont(ofSize: 11)
        total.textColor = .tertiaryLabelColor
        total.alignment = .right
        total.frame = NSRect(x: 224, y: 7, width: 22, height: 14)
        total.autoresizingMask = [.minXMargin]
        total.setAccessibilityElement(false)
        addSubview(total)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(item: NSMenuItem, expanded: Bool, count: Int) {
        self.item = item
        button.attributedTitle = NSAttributedString(string: item.title, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.secondaryLabelColor])
        button.isEnabled = item.isEnabled
        button.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right",
                               accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .bold))
        button.setAccessibilityLabel("\(expanded ? "Collapse" : "Expand") \(item.title)")
        total.stringValue = String(count)
    }

    override func mouseDown(with event: NSEvent) { activate() }

    @objc private func activate() {
        dispatchMenuAction(item)
    }
}
