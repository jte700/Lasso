// The dictation pill: a small Liquid Glass capsule by the caret while
// dictation is on, its waves following the voice (VoiceLevelMeter.swift).
// When a suggestion comes, the pill's glass springs out into the card's
// outline and the card fades in on it; when the card closes and dictation
// goes on, the card's outline springs back into the pill. Its rules, apart
// from the drawing, are in DictationPillLayout.swift. It never takes focus,
// keys or clicks.

import Cocoa
import SwiftUI

/// What the morph panel draws, in its own top-left coordinates.
final class DictationPillModel: ObservableObject {
    @Published var outline = DictationOutline.pill(.zero, caretX: 0, pointerAtTop: false)
    /// Where the waves sit. They stay put while the outline grows away from them.
    @Published var waves = CGRect.zero
    @Published var contentOpacity: Double = 0
    /// Each bar's height in points.
    @Published var heights = [CGFloat](repeating: DictationPillView.barMinimum, count: VoiceWaveform.barCount)
    /// The waves follow the voice; without the microphone they drift on their own.
    @Published var hearsVoice = false
}

struct DictationPillView: View {
    @ObservedObject var model: DictationPillModel

    static let size = CGSize(width: 132, height: 36)
    static let barWidth: CGFloat = 3
    static let barGap: CGFloat = 2.5
    static let barMinimum: CGFloat = 3
    static let barMaximum: CGFloat = 20

    var body: some View {
        ZStack(alignment: .topLeading) {
            DictationGlass(outline: model.outline)
                .frame(width: model.outline.rect.width, height: model.outline.rect.height)
                .offset(x: model.outline.rect.minX, y: model.outline.rect.minY)
            DictationWaves(model: model)
                .frame(width: model.waves.width, height: model.waves.height)
                .offset(x: model.waves.minX, y: model.waves.minY)
                .opacity(model.contentOpacity)
                .blur(radius: (1 - model.contentOpacity) * 3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Lasso is following dictation")
    }
}

/// The lasso and the waves, as the pill shows them.
private struct DictationWaves: View {
    @ObservedObject var model: DictationPillModel

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "lasso")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
            if model.hearsVoice {
                bars(model.heights)
                    .animation(.linear(duration: 1.0 / 24), value: model.heights)
            } else {
                // Without the microphone the waves drift slowly, saying only that dictation is on.
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
                    bars(Self.drift(at: timeline.date.timeIntervalSinceReferenceDate))
                }
            }
        }
        .padding(.leading, Self.leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    static let leading: CGFloat = 14

    private func bars(_ heights: [CGFloat]) -> some View {
        HStack(alignment: .center, spacing: DictationPillView.barGap) {
            ForEach(heights.indices, id: \.self) { index in
                Capsule()
                    .fill(Color.primary.opacity(0.82))
                    .frame(width: DictationPillView.barWidth, height: heights[index])
            }
        }
        .frame(height: DictationPillView.barMaximum)
    }

    static func drift(at time: TimeInterval) -> [CGFloat] {
        (0..<VoiceWaveform.barCount).map { index in
            let swell = 0.5 + 0.5 * sin(time * 2.6 - Double(index) * 0.55)
            return DictationPillView.barMinimum + 5 * CGFloat(swell) * VoiceWaveform.taper(index)
        }
    }
}

/// Liquid Glass on macOS 26, in the outline the card's own glass has; the
/// popover material with a hairline edge before it, or with Reduce Transparency on.
private struct DictationGlass: View {
    let outline: DictationOutline

    var body: some View {
        let shape = DictationOutlineShape(outline: outline)
        if #available(macOS 26.0, *), NativeMaterial.usesGlass {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            LoopVisualEffect(material: .popover)
                .clipShape(shape)
                .overlay(shape.stroke(Color(nsColor: .separatorColor), lineWidth: 0.5))
        }
    }
}

/// The card's own outline (AssistGlassBubble.swift), which a pill holds flat.
struct DictationOutlineShape: Shape {
    let outline: DictationOutline

    func path(in rect: CGRect) -> Path {
        AssistBubbleShape(geometry: AssistBubbleGeometry(
            cornerRadius: outline.cornerRadius, pointerWidth: outline.pointerWidth,
            pointerHeight: outline.pointerHeight, pointerX: outline.pointerX,
            pointerAtTop: outline.pointerAtTop)).path(in: rect)
    }
}

/// The panel the pill floats in, and the morphs between it and the card.
final class DictationPillController {
    static let shared = DictationPillController()

    /// Room around the glass for its shadow, and for a spring's overshoot.
    static let margin: CGFloat = 18

    enum State {
        case hidden
        case pill
        /// The pill has become the card; it comes back when the card closes.
        case card
    }
    private(set) var state = State.hidden

    /// The springs: the Morph Island height token for the pill appearing,
    /// damped further for the card, so a wide card does not wobble.
    private enum Motion {
        static let appear = (stiffness: 300.0, damping: 22.0)
        static let expand = (stiffness: 420.0, damping: 36.0)
        static let collapse = (stiffness: 390.0, damping: 30.0)
        /// Following the caret: critically damped, so it glides after each
        /// word and settles without swinging past it, and quick, so the
        /// microphone macOS moves with each word is not left over it for long.
        static let follow = (stiffness: 1100.0, damping: 66.0)
        /// The card fades in once the glass is nearly its size, and the glass
        /// under it stays whole until it is in: two half-clear glasses would
        /// let the words behind show through unblurred.
        static let handOff = (delay: 0.15, duration: 0.12)
        static let glassOut = (delay: 0.27, duration: 0.08)
    }

    private let model = DictationPillModel()
    private var panel: NSPanel?
    private var hosting: NSView?

    /// Where the pill sits, or is gliding to, or would once a card closes, in AppKit coordinates.
    private var pillFrame: CGRect?
    private var caretX: CGFloat = 0
    /// The card would point up at the caret from below it.
    private var pointerAtTop = false
    /// The caret last given, when, and how far ahead of it the pill keeps.
    private var lastCaret: (caret: CGRect, cardSize: CGSize, visible: CGRect?, at: Date)?
    private var lead: CGFloat = 0
    /// After a pause in the words the pill settles back beside the microphone.
    static let leadRest: TimeInterval = 1.5

    private var waveform = VoiceWaveform()
    private var waveTimer: Timer?
    var hearsVoice = false {
        didSet {
            guard hearsVoice != oldValue else { return }
            if !hearsVoice { waveform.reset() }
            model.hearsVoice = hearsVoice
        }
    }

    private struct Morph {
        /// AppKit coordinates.
        var from: DictationOutline
        var to: DictationOutline
        var wavesFrom: CGRect
        var wavesTo: CGRect
        var spring: IslandSpring
        var content: DictationFade
        var alpha: DictationFade
        var cardAlpha: DictationFade?
        /// The morph's own time, in frames that each count at most a thirtieth
        /// of a second: a busy moment (the card's first drawing takes a tenth
        /// of a second) holds the morph still rather than skipping it.
        var clock: Double = 0
        var settled: (() -> Void)?
    }
    private var morph: Morph?
    /// The pill sliding after the caret: the panel moves, and nothing in it is drawn again.
    private struct Glide {
        var x: IslandSpring
        var y: IslandSpring
    }
    private var glide: Glide?
    /// The outline on screen now, AppKit coordinates.
    private var shown: DictationOutline?
    private var canvas = DictationMorphCanvas(frame: .zero)
    /// The card fading in over the glass.
    private weak var handOffCard: NSPanel?
    private var frameTimer: Timer?
    private var displayLinkObject: AnyObject?
    private var lastFrame: CFTimeInterval?

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    // MARK: What the assistant asks

    /// Shows the pill by `caret` (AppKit coordinates), moves it there, or,
    /// while it is the card, remembers it for when the card closes.
    func show(caret: CGRect, cardSize: CGSize, visible: CGRect?) {
        lead = state == .hidden ? 0 : DictationPillPlacement.lead(from: lastCaret?.caret, to: caret, keeping: lead)
        lastCaret = (caret, cardSize, visible, Date())
        let frame = place(by: caret, cardSize: cardSize, visible: visible)
        switch state {
        case .card:
            pillFrame = frame
        case .hidden:
            pillFrame = frame
            appear()
        case .pill:
            follow(to: frame)
        }
    }

    /// The pill's frame by `caret`, beside the microphone macOS draws under it.
    private func place(by caret: CGRect, cardSize: CGSize, visible: CGRect?) -> CGRect {
        caretX = caret.midX
        pointerAtTop = CaretCardPlacement.beside(caret: caret, size: cardSize, visible: visible).pointerAtTop
        return DictationPillPlacement.frame(caret: caret, size: DictationPillView.size, visible: visible, lead: lead)
    }

    /// Words stopped coming for a moment: the pill settles back beside the microphone.
    private func settleLead() {
        guard state == .pill, lead > 0, let last = lastCaret,
              Date().timeIntervalSince(last.at) > Self.leadRest else { return }
        lead = 0
        follow(to: place(by: last.caret, cardSize: last.cardSize, visible: last.visible))
    }

    /// The pill is on screen by the caret, not inside the card.
    var showsPill: Bool { state == .pill }

    /// The caret moved on: the pill slides there. A morph under way settles there instead.
    private func follow(to frame: CGRect) {
        pillFrame = frame
        guard state == .pill, morph == nil, let shown, panel?.isVisible == true else { return }
        if var moving = glide {
            moving.x.t = frame.minX
            moving.y.t = frame.minY
            glide = moving
            return
        }
        guard abs(shown.rect.minX - frame.minX) > 0.5 || abs(shown.rect.minY - frame.minY) > 0.5 else { return }
        let motion = Motion.follow
        var x = IslandSpring(shown.rect.minX, stiffness: motion.stiffness, damping: motion.damping)
        var y = IslandSpring(shown.rect.minY, stiffness: motion.stiffness, damping: motion.damping)
        x.t = frame.minX
        y.t = frame.minY
        glide = Glide(x: x, y: y)
        if frameTimer == nil, displayLinkObject == nil { lastFrame = nil }
        startLoop()
    }

    /// The card is about to show. While the pill is on screen it grows into
    /// the card's outline, and the card, ordered in at no opacity, fades in
    /// on it. Returns whether it does; otherwise the card shows as it always has.
    func expand(into card: NSPanel, geometry: AssistBubbleGeometry) -> Bool {
        guard state == .pill, let pillFrame, let shown, panel?.isVisible == true else { return false }
        state = .card
        stopWaves()
        let target = DictationOutline(rect: card.frame, cornerRadius: geometry.cornerRadius,
                                      pointerHeight: geometry.pointerHeight, pointerWidth: geometry.pointerWidth,
                                      pointerX: geometry.pointerX, pointerAtTop: geometry.pointerAtTop)
        card.alphaValue = 0
        handOffCard = card
        let cardIn = DictationFade(from: 0, to: 1, delay: Motion.handOff.delay, duration: Motion.handOff.duration)
        start(Morph(from: shown, to: target, wavesFrom: pillFrame, wavesTo: pillFrame,
                    spring: spring(Motion.expand),
                    content: DictationFade(from: model.contentOpacity, to: 0, delay: 0, duration: 0.1),
                    alpha: DictationFade(from: currentAlpha, to: 0, delay: Motion.glassOut.delay, duration: Motion.glassOut.duration),
                    cardAlpha: cardIn,
                    settled: { [weak self] in
                        guard let self, self.state == .card else { return }
                        self.handOffCard = nil
                        self.panel?.orderOut(nil)
                    }))
        return true
    }

    /// Whether a card is still fading in over the glass, so its opacity is not the caller's to set.
    func isFadingIn(_ card: NSPanel) -> Bool { handOffCard === card }

    /// The card is up while dictation is on but the pill was not there to grow
    /// into it: the pill waits inside the card.
    func cardIsUp() {
        guard state != .card else { return }
        let wasShowing = state == .pill
        state = .card
        stopWaves()
        if wasShowing { finishMorph(); panel?.orderOut(nil) }
    }

    /// The card closed while dictation goes on: its outline shrinks back into
    /// the pill, which settles by `caret` (AppKit coordinates).
    func collapse(from cardFrame: CGRect, geometry: AssistBubbleGeometry, caret: CGRect, cardSize: CGSize, visible: CGRect?) {
        guard state == .card else { return }
        state = .pill
        // A card closed before it had finished fading in shrinks from the glass as it is.
        let growing = morph != nil ? shown : nil
        handOffCard?.alphaValue = 1
        handOffCard = nil
        let pillFrame = place(by: caret, cardSize: cardSize, visible: visible)
        self.pillFrame = pillFrame
        pointerAtTop = geometry.pointerAtTop
        let from = growing ?? DictationOutline(rect: cardFrame, cornerRadius: geometry.cornerRadius,
                                               pointerHeight: geometry.pointerHeight, pointerWidth: geometry.pointerWidth,
                                               pointerX: geometry.pointerX, pointerAtTop: geometry.pointerAtTop)
        startWaves()
        start(Morph(from: from, to: pillOutline(pillFrame), wavesFrom: pillFrame, wavesTo: pillFrame,
                    spring: spring(Motion.collapse),
                    content: DictationFade(from: 0, to: 1, delay: 0.12, duration: 0.2),
                    alpha: .hold(1), cardAlpha: nil,
                    settled: { [weak self] in self?.rest() }))
    }

    /// The card closed while dictation is over, or the pill is not wanted there.
    func cardGone() {
        guard state == .card else { return }
        handOffCard?.alphaValue = 1
        handOffCard = nil
        finishMorph()
        panel?.orderOut(nil)
        state = .hidden
        stopWaves()
    }

    /// Dictation is over: the pill shrinks to a dot and fades. While it is the
    /// card, the card stays as it is.
    func hide() {
        switch state {
        case .hidden:
            return
        case .card:
            cardGone()
            return
        case .pill:
            break
        }
        state = .hidden
        stopWaves()
        lead = 0
        lastCaret = nil
        guard let shown, let pillFrame else { finishMorph(); panel?.orderOut(nil); return }
        start(Morph(from: shown, to: DictationOutline.seed(of: pillOutline(pillFrame)), wavesFrom: pillFrame,
                    wavesTo: pillFrame, spring: spring(Motion.collapse),
                    content: DictationFade(from: model.contentOpacity, to: 0, delay: 0, duration: 0.1),
                    alpha: DictationFade(from: currentAlpha, to: 0, delay: 0.04, duration: 0.16),
                    cardAlpha: nil,
                    settled: { [weak self] in
                        guard self?.state == .hidden else { return }
                        self?.panel?.orderOut(nil)
                    }))
    }

    /// Loudness readings from the meter.
    func hear(_ levels: [CGFloat]) {
        guard state != .hidden else { return }
        waveform.hear(levels)
    }

    // MARK: Morphs

    private func appear() {
        guard let pillFrame else { return }
        state = .pill
        waveform.reset()
        startWaves()
        let target = pillOutline(pillFrame)
        start(Morph(from: reduceMotion ? target : DictationOutline.seed(of: target), to: target,
                    wavesFrom: pillFrame, wavesTo: pillFrame, spring: spring(Motion.appear),
                    content: DictationFade(from: 0, to: 1, delay: 0.05, duration: 0.18),
                    alpha: DictationFade(from: 0, to: 1, delay: 0, duration: 0.1),
                    cardAlpha: nil,
                    settled: { [weak self] in self?.rest() }))
    }

    /// The pill at rest in a panel just its size. If the caret moved on while
    /// it settled, it slides after it.
    private func rest() {
        guard state == .pill, let target = pillFrame, let shown else { return }
        let landed = shown.rect
        place(on: DictationMorphCanvas.covering([landed], margin: Self.margin), outline: pillOutline(landed), waves: landed)
        panel?.hasShadow = true
        panel?.invalidateShadow()
        follow(to: target)
    }

    /// One frame of a glide: the panel moves with the pill, and what it draws stays as it is.
    private func stepGlide(_ dt: Double) {
        guard var moving = glide, let panel, var outline = shown else { glide = nil; return }
        let slice = dt / 4
        for _ in 0..<4 {
            moving.x.step(slice)
            moving.y.step(slice)
        }
        let settled = moving.x.isSettled(within: 0.3) && moving.y.isSettled(within: 0.3)
        if settled {
            moving.x.snap()
            moving.y.snap()
        }
        let inset = CGPoint(x: outline.rect.minX - canvas.frame.minX, y: outline.rect.minY - canvas.frame.minY)
        outline.rect.origin = CGPoint(x: moving.x.x, y: moving.y.x)
        let origin = CGPoint(x: outline.rect.minX - inset.x, y: outline.rect.minY - inset.y)
        panel.setFrameOrigin(origin)
        canvas = DictationMorphCanvas(frame: CGRect(origin: origin, size: canvas.frame.size))
        shown = outline
        glide = settled ? nil : moving
    }

    private func pillOutline(_ frame: CGRect) -> DictationOutline {
        let caret = min(max(caretX, frame.minX + frame.height / 2), frame.maxX - frame.height / 2)
        return DictationOutline.pill(frame, caretX: caret, pointerAtTop: pointerAtTop)
    }

    private func spring(_ motion: (stiffness: Double, damping: Double)) -> IslandSpring {
        var spring = IslandSpring(0, stiffness: motion.stiffness, damping: motion.damping)
        spring.tune(stiffness: motion.stiffness, damping: motion.damping, reduceMotion: reduceMotion)
        spring.t = 1
        return spring
    }

    private var currentAlpha: Double { Double(panel?.alphaValue ?? 0) }

    private func start(_ next: Morph) {
        let panel = existingPanel()
        // A morph starts from wherever a glide had got to.
        glide = nil
        morph = next
        // The panel covers the whole way, so the glass never meets its edge.
        let canvas = DictationMorphCanvas.covering([next.from.rect, next.to.rect, next.wavesFrom, next.wavesTo],
                                                   margin: Self.margin)
        panel.hasShadow = false
        place(on: canvas, outline: next.from, waves: next.wavesFrom)
        panel.alphaValue = CGFloat(next.alpha.value(at: 0))
        if !panel.isVisible { panel.orderFrontRegardless() }
        lastFrame = nil
        startLoop()
    }

    /// Moves the panel and what it draws in one step, so nothing on screen jumps.
    private func place(on canvas: DictationMorphCanvas, outline: DictationOutline, waves: CGRect) {
        let panel = existingPanel()
        let moved = canvas != self.canvas
        self.canvas = canvas
        if moved { panel.disableScreenUpdatesUntilFlush() }
        render(outline: outline, waves: waves)
        hosting?.layoutSubtreeIfNeeded()
        if moved { panel.setFrame(canvas.frame, display: true) }
    }

    private func render(outline: DictationOutline, waves: CGRect) {
        shown = outline
        var local = outline
        local.rect = canvas.local(outline.rect)
        model.outline = local
        model.waves = canvas.local(waves)
    }

    private func tick() {
        let now = CACurrentMediaTime()
        let dt = min(max(now - (lastFrame ?? now - 1.0 / 60), 0), 1.0 / 30)
        lastFrame = now
        if var current = morph {
            let slice = dt / 4
            for _ in 0..<4 { current.spring.step(slice) }
            current.clock += dt
            let elapsed = current.clock
            let fadesDone = current.content.isDone(at: elapsed) && current.alpha.isDone(at: elapsed)
                && (current.cardAlpha?.isDone(at: elapsed) ?? true)
            let settled = current.spring.isSettled(within: 0.002) && fadesDone
            if settled { current.spring.snap() }
            morph = current
            apply(current, elapsed: elapsed)
            if settled {
                morph = nil
                // What follows a morph may start another, or a glide.
                current.settled?()
            }
        } else if glide != nil {
            stepGlide(dt)
        }
        if morph == nil, glide == nil { stopLoop() }
    }

    private func apply(_ current: Morph, elapsed: Double) {
        let progress = CGFloat(current.spring.x)
        let along = min(max(progress, 0), 1)
        let waves = CGRect(x: current.wavesFrom.minX + (current.wavesTo.minX - current.wavesFrom.minX) * along,
                           y: current.wavesFrom.minY + (current.wavesTo.minY - current.wavesFrom.minY) * along,
                           width: current.wavesTo.width, height: current.wavesTo.height)
        render(outline: DictationOutline.between(current.from, current.to, progress: progress), waves: waves)
        model.contentOpacity = current.content.value(at: elapsed)
        panel?.alphaValue = CGFloat(current.alpha.value(at: elapsed))
        if let cardAlpha = current.cardAlpha { handOffCard?.alphaValue = CGFloat(cardAlpha.value(at: elapsed)) }
    }

    /// Jumps a morph under way to its end.
    private func finishMorph() {
        glide = nil
        guard var current = morph else { return }
        current.spring.snap()
        morph = nil
        stopLoop()
        apply(current, elapsed: .greatestFiniteMagnitude)
        handOffCard = nil
    }

    private func startLoop() {
        guard frameTimer == nil, displayLinkObject == nil else { return }
        if #available(macOS 14.0, *), let hosting {
            let link = hosting.displayLink(target: frames, selector: #selector(DictationPillFrames.frameFired))
            link.add(to: .main, forMode: .common)
            displayLinkObject = link
        } else {
            let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
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

    // MARK: Waves

    private func startWaves() {
        guard waveTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 24, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.waveform.advance()
            self.settleLead()
            guard self.state == .pill, self.hearsVoice else { return }
            self.model.heights = self.waveform.heights(minimum: DictationPillView.barMinimum,
                                                      maximum: DictationPillView.barMaximum)
        }
        RunLoop.main.add(timer, forMode: .common)
        waveTimer = timer
    }

    private func stopWaves() {
        // Inside the card the waves keep moving on unseen, so they are current when it closes.
        guard state == .hidden else { return }
        waveTimer?.invalidate()
        waveTimer = nil
    }

    // MARK: Panel

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let created = NSPanel(contentRect: NSRect(origin: .zero, size: DictationPillView.size),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        created.level = .popUpMenu
        created.isOpaque = false
        created.backgroundColor = .clear
        created.hasShadow = true
        created.hidesOnDeactivate = false
        created.ignoresMouseEvents = true
        created.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        let view = NSHostingView(rootView: DictationPillView(model: model))
        view.frame = NSRect(origin: .zero, size: created.frame.size)
        view.autoresizingMask = [.width, .height]
        created.contentView = view
        hosting = view
        frames.controller = self
        panel = created
        return created
    }

    /// The display link's target, an Objective-C object that calls back the controller.
    private let frames = DictationPillFrames()

    fileprivate func frameFired() { tick() }
}

/// Receives display-link frames for the controller, which is not an NSObject.
final class DictationPillFrames: NSObject {
    weak var controller: DictationPillController?
    @objc func frameFired() { controller?.frameFired() }
}
