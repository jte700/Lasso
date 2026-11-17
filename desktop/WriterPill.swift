// The pill by the caret for a backslash prompt. While the prompt is typed it
// names the writer and the key that hands it over. Once Tab is pressed it
// says what the writer is doing, as a moving line after Kokonut UI's AI Text
// Loading (ThinkingMotion.swift), until the first words are written; if the
// writer cannot answer it says why for a few seconds. Like the ⌥Tab switcher
// it takes no focus and no clicks: keys reach Lasso through KeyRouting.swift.

import Cocoa
import SwiftUI

final class WriterPillModel: ObservableObject {
    enum Phase: Equatable {
        /// A prompt ends at the caret: Tab hands it to the writer.
        case ready
        /// The writer is working out its answer; the thinking line says what it is doing.
        case thinking
        /// It could not answer: why.
        case failed(String)
    }

    @Published var agent = WriterAgent.chatGPT
    @Published var phase: Phase = .ready
    /// The thinking line, when it began, and the line it replaced while that leaves.
    @Published var line = ThinkingLines.first
    @Published var lineStarted = Date()
    @Published var previous: (line: String, started: Date, ended: Date)?
}

/// One line's letters at one moment: rising in, waving, or leaving.
struct ThinkingLetters: View {
    let text: String
    /// Seconds since the line began.
    let elapsed: TimeInterval
    /// Seconds since it was replaced, or nil while it is the line shown.
    var leaving: TimeInterval? = nil
    let font: NSFont
    let reduceMotion: Bool

    var body: some View {
        let scale = ThinkingMotion.scale(forFontSize: font.pointSize)
        let exit = leaving.map { ThinkingMotion.leaving(elapsed: $0, scale: scale, reduceMotion: reduceMotion) }
        HStack(spacing: 0) {
            ForEach(Array(text.enumerated()), id: \.offset) { index, character in
                let rise = ThinkingMotion.entering(letter: index, elapsed: elapsed, scale: scale, reduceMotion: reduceMotion)
                let wave = ThinkingMotion.wave(letter: index, time: elapsed, reduceMotion: reduceMotion)
                Text(String(character))
                    .font(Font(font))
                    .foregroundStyle(.primary)
                    .opacity(rise.opacity * wave)
                    .offset(y: rise.offset)
                    .blur(radius: rise.blur)
            }
        }
        .fixedSize()
        .opacity(exit?.opacity ?? 1)
        .offset(y: exit?.offset ?? 0)
        .blur(radius: exit?.blur ?? 0)
    }
}

/// The thinking line as it moves: the line shown, and the one it replaced on its way out.
private struct ThinkingLine: View {
    @ObservedObject var model: WriterPillModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    static let font = NSFont.systemFont(ofSize: 13, weight: .semibold)

    var body: some View {
        TimelineView(.animation) { timeline in
            let now = timeline.date
            ZStack(alignment: .leading) {
                if let previous = model.previous, now.timeIntervalSince(previous.ended) < ThinkingMotion.exitTime {
                    ThinkingLetters(text: previous.line, elapsed: now.timeIntervalSince(previous.started),
                                    leaving: now.timeIntervalSince(previous.ended), font: Self.font, reduceMotion: reduceMotion)
                }
                ThinkingLetters(text: model.line, elapsed: now.timeIntervalSince(model.lineStarted), font: Self.font,
                                reduceMotion: reduceMotion)
            }
        }
    }
}

struct WriterPillView: View {
    @ObservedObject var model: WriterPillModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let height: CGFloat = 36
    static let maximumTextWidth: CGFloat = 340

    var body: some View {
        HStack(spacing: 8) {
            leading
            if model.phase == .thinking {
                ThinkingLine(model: model)
            } else {
                Text(text)
                    .font(.system(size: 13, weight: isFailure ? .regular : .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: Self.maximumTextWidth, alignment: .leading)
                    .contentTransition(.opacity)
            }
            if let key { keycap(key) }
        }
        .padding(.leading, 12)
        .padding(.trailing, key == nil ? 14 : 8)
        .padding(.vertical, 6)
        .frame(minHeight: Self.height)
        .modifier(WriterPillSurface())
        .fixedSize()
        .animation(.easeOut(duration: 0.18), value: model.phase)
        // The pill springs to each new line's width as its letters rise in.
        .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.86), value: model.line)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }

    private var isFailure: Bool {
        if case .failed = model.phase { return true }
        return false
    }

    private var text: String {
        switch model.phase {
        case .ready: return "Write with \(model.agent.title)"
        case .thinking: return model.line
        case .failed(let why): return why
        }
    }

    /// The key that acts on the pill now.
    private var key: String? {
        switch model.phase {
        case .ready: return "⇥"
        case .thinking: return "esc"
        case .failed: return nil
        }
    }

    @ViewBuilder private var leading: some View {
        switch model.phase {
        case .ready, .thinking:
            Image(systemName: model.agent.symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 16)
        case .failed:
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 16)
        }
    }

    private func keycap(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .frame(height: 22)
            .background(Capsule().fill(Color.primary.opacity(0.08)))
    }
}

/// Liquid Glass on macOS 26, as the switcher has; the popover material with a hairline edge before it.
private struct WriterPillSurface: ViewModifier {
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: WriterPillView.height / 2, style: .continuous) }

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *), NativeMaterial.usesGlass {
            content.glassEffect(.regular, in: shape)
        } else {
            content
                .background(RanchVisualEffect(material: .popover).clipShape(shape))
                .overlay(shape.strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        }
    }
}

/// The panel the pill floats in, placed by the caret as the switcher is.
final class WriterPillController {
    static let shared = WriterPillController()

    /// Room for the pill's shadow on every side.
    static let margin: CGFloat = 14
    static var panelSize: NSSize {
        NSSize(width: 12 + 16 + 8 + WriterPillView.maximumTextWidth + 8 + 44 + 8 + 2 * margin, height: 56 + 2 * margin)
    }

    private let model = WriterPillModel()
    private var panel: NSPanel?
    private var hideTimer: Timer?
    private var shadowRefresh: DispatchWorkItem?
    private(set) var isShown = false
    /// The caret the pill was last placed by, kept for a phase that changes with no new reading.
    private var lastCaret: CGRect?
    private var lines = ThinkingLines(at: 0)
    private var lineTimer: Timer?

    var phase: WriterPillModel.Phase { model.phase }

    /// The writer has the prompt: the pill turns to "Thinking…", by `caret`.
    func think(agent: WriterAgent, at caret: CGRect?) {
        let now = Date()
        lines = ThinkingLines(at: now.timeIntervalSinceReferenceDate)
        var plain = Transaction()
        plain.disablesAnimations = true
        withTransaction(plain) {
            model.line = lines.shown
            model.lineStarted = now
            model.previous = nil
        }
        show(.thinking, agent: agent, at: caret)
        lineTimer?.invalidate()
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.advanceLine() }
        RunLoop.main.add(timer, forMode: .common)
        lineTimer = timer
    }

    /// The writer began a lookup the server reported, which the thinking line says in its turn.
    func lookup(status: String, detail: String) {
        guard model.phase == .thinking,
              lines.lookup(ThinkingLines.line(status: status, detail: detail), at: Date().timeIntervalSinceReferenceDate) else { return }
        showLine()
    }

    /// Places the pill by `caret` again, as it is: the caret moved back to where the erased prompt began.
    func move(to caret: CGRect?) {
        guard isShown, let caret else { return }
        let phase = model.phase
        show(phase, agent: model.agent, at: caret)
    }

    private func advanceLine() {
        guard model.phase == .thinking else { stopLines(); return }
        if lines.advance(at: Date().timeIntervalSinceReferenceDate) { showLine() }
    }

    private func showLine() {
        let now = Date()
        model.previous = (model.line, model.lineStarted, now)
        model.line = lines.shown
        model.lineStarted = now
        refreshShadow()
    }

    private func stopLines() {
        lineTimer?.invalidate()
        lineTimer = nil
    }

    /// Shows `phase` for `agent` by the caret, an Accessibility rectangle; with no caret given it stays where it was.
    func show(_ phase: WriterPillModel.Phase, agent: WriterAgent, at caret: CGRect?) {
        hideTimer?.invalidate()
        hideTimer = nil
        if phase != .thinking { stopLines() }
        model.agent = agent
        model.phase = phase
        if let caret { lastCaret = caret }
        let panel = existingPanel()
        let anchor = Self.anchor(for: lastCaret)
        let screen = NSScreen.screens.first { $0.frame.intersects(anchor.insetBy(dx: -1, dy: -1)) } ?? NSScreen.main
        panel.setFrame(ScopeSwitcherPlacement.frame(caret: anchor, size: Self.panelSize, margin: Self.margin,
                                                    visible: screen?.visibleFrame), display: true)
        if !isShown {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                panel.animator().alphaValue = 1
            }
        }
        isShown = true
        refreshShadow()
    }

    /// Says why the writer could not answer, by `caret` (where the pill last was without one), then goes away on its own.
    func fail(_ why: String, agent: WriterAgent, at caret: CGRect?, seconds: TimeInterval = 5) {
        show(.failed(why), agent: agent, at: caret)
        hideTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in self?.hide() }
    }

    func hide() {
        hideTimer?.invalidate()
        hideTimer = nil
        stopLines()
        guard isShown else { return }
        isShown = false
        lastCaret = nil
        shadowRefresh?.cancel()
        guard let panel else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.1
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard self?.isShown == false else { return }
            panel.orderOut(nil)
        })
    }

    /// The caret in AppKit coordinates, or the pointer when there is no caret to read.
    private static func anchor(for caret: CGRect?) -> CGRect {
        guard let caret else {
            let mouse = NSEvent.mouseLocation
            return CGRect(x: mouse.x, y: mouse.y - 18, width: 1, height: 18)
        }
        let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
        // A field's frame given for the caret stands for its first line, not its bottom edge.
        let flipped = HostGeometryConverter.toAppKit(CaretLine.line(caret), primaryHeight: primary?.frame.maxY ?? 0)
        return CGRect(x: flipped.minX, y: flipped.minY, width: max(1, flipped.width), height: max(1, flipped.height))
    }

    /// The window shadow follows the pill's outline, which changes width with its words.
    private func refreshShadow() {
        shadowRefresh?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.panel?.invalidateShadow() }
        shadowRefresh = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
        panel?.invalidateShadow()
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let size = Self.panelSize
        let created = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        created.level = .popUpMenu
        created.isOpaque = false
        created.backgroundColor = .clear
        created.hasShadow = true
        created.hidesOnDeactivate = false
        created.ignoresMouseEvents = true
        created.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        let pill = WriterPillView(model: model)
            .padding(Self.margin)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
        let hosting = NSHostingView(rootView: AnyView(pill))
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.autoresizingMask = [.width, .height]
        created.contentView = hosting
        panel = created
        return created
    }
}
