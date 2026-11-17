// A switch whose knob stretches toward where it is going, lands with a small
// bounce and rounds back up while the track fills with its colour. The
// motion is in SwitchMotion.swift; this draws it. NSButton supplies the
// state, keyboard and accessibility actions.

import Cocoa
import QuartzCore

class SpringSwitch: NSButton {
    /// The track's colour when on.
    var onColor: NSColor = .controlAccentColor { didSet { needsDisplay = true } }
    private let trackSize: NSSize
    private let motion: SwitchMotion
    private var frameTimer: Timer?
    private var displayLinkObject: AnyObject?

    /// A motion key lets a switch rebuilt with every refresh carry on the
    /// movement the one it replaced began.
    init(frameSize: NSSize, trackSize: NSSize, motionKey: String? = nil) {
        self.trackSize = trackSize
        motion = motionKey.map(SwitchMotion.kept(for:)) ?? SwitchMotion()
        super.init(frame: NSRect(origin: .zero, size: frameSize))
        setButtonType(.switch)
        allowsMixedState = false
        isBordered = false
        title = ""
        setAccessibilityRole(.checkBox)
        setAccessibilitySubrole(.switch)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { stopLoop() }

    /// The switch keeps its size; there is no title to fit.
    override func sizeToFit() {}

    override var intrinsicContentSize: NSSize { frame.size }

    override var state: NSControl.StateValue {
        didSet { needsDisplay = true }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stopLoop() } else if motion.isMoving { startLoop() }
    }

    /// A click changes the state without telling the view, so the drawing
    /// is where a new state is first seen.
    private func followState() {
        let on = state == .on
        guard motion.isOn != on else { return }
        let animated = window?.isVisible == true && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        motion.set(on: on, animated: animated)
        if motion.isMoving { startLoop() }
    }

    override func draw(_ dirtyRect: NSRect) {
        followState()
        let track = NSRect(x: (bounds.width - trackSize.width) / 2, y: (bounds.height - trackSize.height) / 2,
                           width: trackSize.width, height: trackSize.height)
        let progress = CGFloat(motion.progress)
        let opacity: CGFloat = isEnabled ? 1 : 0.45
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let offColor = dark ? NSColor(white: 1, alpha: 0.16) : NSColor(white: 0, alpha: 0.1)
        let fill = Self.mix(offColor, onColor, progress)
        fill.withAlphaComponent(fill.alphaComponent * opacity).setFill()
        let trackPath = NSBezierPath(roundedRect: track, xRadius: track.height / 2, yRadius: track.height / 2)
        trackPath.fill()

        // A round white knob with a soft shadow and hairline edge, kept
        // inside the track when it bounces past the end.
        let inset: CGFloat = 1
        let diameter = track.height - inset * 2
        let shape = motion.knob(diameter: Double(diameter), travel: Double(track.width - inset * 2 - diameter))
        let knob = NSRect(x: track.minX + inset + CGFloat(shape.x), y: track.minY + inset,
                          width: CGFloat(shape.width), height: diameter)
        let knobPath = NSBezierPath(roundedRect: knob, xRadius: diameter / 2, yRadius: diameter / 2)
        NSGraphicsContext.saveGraphicsState()
        trackPath.addClip()
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.25 * opacity)
        shadow.shadowBlurRadius = 1.5
        shadow.shadowOffset = NSSize(width: 0, height: -0.5)
        shadow.set()
        let knobAlpha = dark ? 0.85 + 0.15 * progress : 1
        NSColor.white.withAlphaComponent(knobAlpha * opacity).setFill()
        knobPath.fill()
        NSGraphicsContext.restoreGraphicsState()
        NSColor.black.withAlphaComponent(0.08 * opacity).setStroke()
        let edge = NSBezierPath(roundedRect: knob.insetBy(dx: 0.25, dy: 0.25),
                                xRadius: diameter / 2 - 0.25, yRadius: diameter / 2 - 0.25)
        edge.lineWidth = 0.5
        edge.stroke()
        NSGraphicsContext.restoreGraphicsState()

        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            let ring = NSBezierPath(roundedRect: track.insetBy(dx: -2.5, dy: -2.5),
                                    xRadius: track.height / 2 + 2.5, yRadius: track.height / 2 + 2.5)
            ring.lineWidth = 2.5
            ring.stroke()
        }
    }

    /// The two colours blended a share of the way, alpha included.
    private static func mix(_ a: NSColor, _ b: NSColor, _ share: CGFloat) -> NSColor {
        guard let a = a.usingColorSpace(.sRGB), let b = b.usingColorSpace(.sRGB) else { return share < 0.5 ? a : b }
        let blend = { (x: CGFloat, y: CGFloat) in x + (y - x) * share }
        return NSColor(srgbRed: blend(a.redComponent, b.redComponent), green: blend(a.greenComponent, b.greenComponent),
                       blue: blend(a.blueComponent, b.blueComponent), alpha: blend(a.alphaComponent, b.alphaComponent))
    }

    // MARK: Frames

    fileprivate func frameFired() {
        motion.advance(to: CACurrentMediaTime())
        needsDisplay = true
        if !motion.isMoving { stopLoop() }
    }

    private func startLoop() {
        guard frameTimer == nil, displayLinkObject == nil, window != nil else { return }
        motion.advance(to: CACurrentMediaTime())
        if #available(macOS 14.0, *) {
            let link = displayLink(target: SpringSwitchFrames(self), selector: #selector(SpringSwitchFrames.frameFired))
            link.add(to: .main, forMode: .common)
            displayLinkObject = link
        } else {
            let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.frameFired() }
            RunLoop.main.add(timer, forMode: .common)
            frameTimer = timer
        }
    }

    private func stopLoop() {
        frameTimer?.invalidate()
        frameTimer = nil
        if #available(macOS 14.0, *) { (displayLinkObject as? CADisplayLink)?.invalidate() }
        displayLinkObject = nil
    }
}

/// Holds its switch weakly, so the display link does not keep it alive.
private final class SpringSwitchFrames: NSObject {
    weak var target: SpringSwitch?
    init(_ target: SpringSwitch) { self.target = target }
    @objc func frameFired() { target?.frameFired() }
}
