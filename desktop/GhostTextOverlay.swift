// Ghost text over the field: the rest of the highlighted suggestion written
// dim right after the caret, in the field's own font and colour, with a Tab key
// beside it (GhostSuggestion.swift has the motion). It is drawn over the field,
// never typed into it, and shows only where nothing follows the caret on its
// line, so it never covers the field's own text. When Tab writes the words,
// the ghost letters brighten and hop over them, backed in the page's colour as
// the source pills are, then step aside for the field's own letters; where
// Lasso cannot match the field's font it leaves at once instead. Typing,
// a click, a scroll or another app coming forward takes it away.

import Cocoa
import CoreText

/// What the field says about the caret's line, read on the Accessibility queue.
struct GhostFieldRead {
    /// Where the host drew the letters typed just before the caret, in Accessibility coordinates.
    var tail: CGRect?
    var style: HostTextStyle?
    /// Text after the caret on its line, or a line that could not be read: the ghost would cover it.
    var textFollows = true
    var field: CGRect?

    static func read(_ element: AXUIElement, caret: Int, tailLength: Int) -> GhostFieldRead {
        func parameterized(_ name: String, _ location: Int, _ length: Int) -> CFTypeRef? {
            guard location >= 0, length >= 0 else { return nil }
            var range = CFRange(location: location, length: length)
            guard let axRange = AXValueCreate(.cfRange, &range) else { return nil }
            var value: CFTypeRef?
            guard AXUIElementCopyParameterizedAttributeValue(element, name as CFString, axRange, &value) == .success else { return nil }
            return value
        }
        func attribute(_ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
            return value
        }
        func axValue<T>(_ value: CFTypeRef?, _ type: AXValueType, _ empty: T) -> T? {
            guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
            var result = empty
            return AXValueGetValue(value as! AXValue, type, &result) ? result : nil
        }

        var read = GhostFieldRead()
        if tailLength > 0, let rect = axValue(parameterized(kAXBoundsForRangeParameterizedAttribute as String,
                                                            caret - tailLength, tailLength), .cgRect, CGRect.zero),
           HostGeometryConverter.isUsable(rect) {
            read.tail = rect
        }
        read.style = (parameterized("AXAttributedStringForRange", max(0, caret - 1), 1) as? NSAttributedString)
            .map(HostTextStyle.read)
        // Up to the end of the caret's line. A field that refuses a range past
        // its end has nothing after the caret; one that refuses it for another
        // reason cannot say, and gets no ghost.
        var after = parameterized(kAXStringForRangeParameterizedAttribute as String, caret, 40) as? String
            ?? parameterized(kAXStringForRangeParameterizedAttribute as String, caret, 1) as? String
        if after == nil {
            if let count = (attribute(kAXNumberOfCharactersAttribute as String) as? NSNumber)?.intValue, count == caret {
                after = ""
            } else if let value = attribute(kAXValueAttribute as String) as? String, caret <= value.utf16.count {
                let units = Array(value.utf16)
                after = String(decoding: units[caret..<min(units.count, caret + 40)], as: UTF16.self)
            }
        }
        if let after { read.textFollows = after.prefix { !$0.isNewline }.contains { !$0.isWhitespace } }
        if let origin = axValue(attribute(kAXPositionAttribute as String), .cgPoint, CGPoint.zero),
           let size = axValue(attribute(kAXSizeAttribute as String), .cgSize, CGSize.zero),
           size.width > 0, size.height > 0 {
            read.field = CGRect(origin: origin, size: size)
        }
        return read
    }
}

/// Where the ghost goes on screen, in AppKit coordinates, and how it is drawn.
struct GhostPlacement {
    /// The ghost as it fits on the line, perhaps cut with an ellipsis.
    let text: String
    let font: NSFont
    /// The horizontal stretch that matches the host's letter widths.
    let stretch: CGFloat
    /// The first letter's left edge, on the baseline.
    let origin: CGPoint
    /// Each letter, and how far along the line it starts.
    let letters: [(line: CTLine, offset: CGFloat)]
    let textBox: CGRect
    let keyRect: CGRect
    let keyFont: NSFont
    /// Backs the hop in the page's colour, over the words Tab wrote; nil when
    /// the font could not be matched, so the ghost leaves at once instead.
    let cover: CGRect?
    let ink: NSColor
    let page: NSColor
    let dark: Bool
    let frame: CGRect

    /// How much of the field's ink the resting ghost is drawn with, as the
    /// component's dim grey sits against its text.
    static let ghostInk: CGFloat = 0.5
    /// Room around the letters and key for the hop and the key's overshoot.
    static let margin: CGFloat = 8

    static func place(_ text: String, read: GhostFieldRead, caret: CGRect, tailText: String,
                      primaryHeight: CGFloat, screenRight: CGFloat) -> GhostPlacement? {
        guard !read.textFollows else { return nil }
        let caretOnScreen = HostGeometryConverter.toAppKit(caret, primaryHeight: primaryHeight)
        var font: NSFont
        var stretch: CGFloat = 1
        var baseline: CGFloat
        var matched = false
        if let tail = read.tail, tail.height <= max(caret.height, 1) * 1.6,
           let line = ReferenceChipLayout.lines(text: tailText,
                                                fragments: [HostGeometryConverter.toAppKit(tail, primaryHeight: primaryHeight)],
                                                style: read.style)?.first {
            font = line.font
            stretch = line.stretch
            baseline = line.baseline
            matched = true
        } else {
            let size = min(72, max(8, read.style?.fontSize ?? caretOnScreen.height / ReferenceChipLayout.lineHeightRatio))
            font = read.style?.font(size: size) ?? NSFont.systemFont(ofSize: size)
            baseline = caretOnScreen.midY - (font.ascender + font.descender) / 2
        }
        let x = caretOnScreen.minX
        let textHeight = font.ascender - font.descender
        let keyHeight = min(22, max(14, (textHeight * 0.92).rounded()))
        let keyFont = NSFont.systemFont(ofSize: keyHeight * 0.56, weight: .medium)
        let keyWidth = max(keyHeight * 1.15, ReferenceChipLayout.width("⇥", keyFont) + keyHeight * 0.7).rounded()
        let gap = min(8, max(4, font.pointSize * 0.4))
        let right = read.field.map { HostGeometryConverter.toAppKit($0, primaryHeight: primaryHeight).maxX } ?? screenRight
        let available = min(right, screenRight) - x - gap - keyWidth - margin
        guard available > 0,
              let shown = GhostLayout.fit(text, width: available, measure: { ReferenceChipLayout.width($0, font) * stretch })
        else { return nil }

        let attributes: [NSAttributedString.Key: Any] = [
            .font: font, NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
        ]
        let whole = CTLineCreateWithAttributedString(NSAttributedString(string: shown, attributes: attributes))
        var letters: [(line: CTLine, offset: CGFloat)] = []
        var index = shown.startIndex
        while index < shown.endIndex {
            let next = shown.index(after: index)
            let start = shown.utf16.distance(from: shown.utf16.startIndex, to: index)
            let offset = CTLineGetOffsetForStringIndex(whole, start, nil) * stretch
            letters.append((CTLineCreateWithAttributedString(NSAttributedString(string: String(shown[index..<next]),
                                                                                 attributes: attributes)), offset))
            index = next
        }
        let textWidth = ReferenceChipLayout.width(shown, font) * stretch
        let textBox = CGRect(x: x, y: baseline + font.descender, width: textWidth, height: textHeight)
        let keyRect = CGRect(x: (x + textWidth + gap).rounded(), y: (textBox.midY - keyHeight / 2).rounded(),
                             width: keyWidth, height: keyHeight)
        let dark = ReferenceChipPalette.isDark(read.style)
        return GhostPlacement(
            text: shown, font: font, stretch: stretch, origin: CGPoint(x: x, y: baseline), letters: letters,
            textBox: textBox, keyRect: keyRect, keyFont: keyFont,
            cover: matched ? textBox.insetBy(dx: -1, dy: -1) : nil,
            ink: ReferenceChipPalette.ink(read.style, dark: dark), page: ReferenceChipPalette.page(read.style, dark: dark),
            dark: dark, frame: textBox.union(keyRect).insetBy(dx: -margin, dy: -margin).integral)
    }
}

/// Draws the ghost's letters and Tab key where they are in their motion.
final class GhostTextView: NSView {
    var placement: GhostPlacement?
    var ghost: GhostLetters?

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// A rectangle on screen in this view's flipped coordinates.
    private func local(_ rect: CGRect, in frame: CGRect) -> CGRect {
        CGRect(x: rect.minX - frame.minX, y: frame.maxY - rect.maxY, width: rect.width, height: rect.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let placement, let ghost, let context = NSGraphicsContext.current?.cgContext else { return }
        let frame = placement.frame
        // While Tab's words are written, the page's colour keeps the field's
        // own letters out of the hop.
        if ghost.isAccepted, let cover = placement.cover {
            context.setFillColor(placement.page.cgColor)
            context.fill(local(cover, in: frame))
        }
        let ink = placement.ink.usingColorSpace(.sRGB) ?? placement.ink
        let baseline = frame.maxY - placement.origin.y
        context.textMatrix = .identity
        for (index, letter) in placement.letters.enumerated() {
            let opacity = ghost.opacity(at: index)
            guard opacity > 0 else { continue }
            let shade = GhostPlacement.ghostInk + (1 - GhostPlacement.ghostInk) * CGFloat(ghost.brightness(at: index))
            context.setFillColor(ink.withAlphaComponent(ink.alphaComponent * shade * CGFloat(opacity)).cgColor)
            context.saveGState()
            context.translateBy(x: placement.origin.x - frame.minX + letter.offset,
                                y: baseline - CGFloat(ghost.lift(at: index)))
            context.scaleBy(x: placement.stretch, y: -1)
            context.textPosition = .zero
            CTLineDraw(letter.line, context)
            context.restoreGState()
        }

        let face = ghost.keyFace
        guard face.opacity > 0 else { return }
        let key = local(placement.keyRect, in: frame)
        context.saveGState()
        context.setAlpha(CGFloat(face.opacity))
        context.beginTransparencyLayer(auxiliaryInfo: nil)
        context.translateBy(x: key.midX, y: key.midY)
        context.scaleBy(x: CGFloat(face.scale), y: CGFloat(face.scale))
        context.translateBy(x: -key.midX, y: -key.midY)
        // The key in the light or dark of the page under it, not of Lasso's own windows.
        NSAppearance(named: placement.dark ? .darkAqua : .aqua)?.performAsCurrentDrawingAppearance {
            AssistKeycap.draw("⇥", in: key, font: placement.keyFont)
        }
        context.endTransparencyLayer()
        context.restoreGState()
    }
}

/// Calls `frame` once a display refresh with the seconds since the last one,
/// until it answers that nothing is moving.
final class GhostFrames: NSObject {
    private var link: AnyObject?
    private var timer: Timer?
    private var lastFrame: CFTimeInterval?
    private var frame: ((Double) -> Bool)?

    func run(in view: NSView, frame: @escaping (Double) -> Bool) {
        self.frame = frame
        guard link == nil, timer == nil else { return }
        lastFrame = nil
        if #available(macOS 14.0, *) {
            let link = view.displayLink(target: self, selector: #selector(fired))
            link.add(to: .main, forMode: .common)
            self.link = link
        } else {
            let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.fired() }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if #available(macOS 14.0, *) { (link as? CADisplayLink)?.invalidate() }
        link = nil
        frame = nil
    }

    @objc private func fired() {
        let now = CACurrentMediaTime()
        let dt = now - (lastFrame ?? now - 1.0 / 60)
        lastFrame = now
        if frame?(dt) != true { stop() }
    }
}

final class GhostTextOverlay {
    static let shared = GhostTextOverlay()

    private var panel: NSPanel?
    private let view = GhostTextView()
    private let frames = GhostFrames()
    private var generation = 0
    /// What the ghost was offered for: a later offer of the same is left alone.
    private var offered: (element: AXUIElement, caret: Int, text: String, caretRect: CGRect)?
    private var monitors: [Any] = []
    private var activationObserver: NSObjectProtocol?
    private var onLanded: (() -> Void)?

    var isShown: Bool { panel?.isVisible == true && view.ghost != nil }
    var isAccepting: Bool { isShown && view.ghost?.isAccepted == true }

    /// Writes `text`, the rest of the highlighted suggestion, after the caret
    /// at `caret` (UTF-16, in the field) drawn at `caretRect` (Accessibility
    /// coordinates). `typed` is what the field holds up to the caret.
    func offer(_ text: String, element: AXUIElement, caret: Int, caretRect: CGRect, typed: String) {
        // Tab's hop plays out; what comes next is offered once it lands.
        guard !isAccepting else { return }
        // Already shown, or being measured: withdrawing forgets the offer.
        if let offered, CFEqual(offered.element, element), offered.caret == caret, offered.text == text,
           offered.caretRect == caretRect {
            return
        }
        offered = (element, caret, text, caretRect)
        generation += 1
        let token = generation
        // Measured on the letters typed just before the caret, back to the start of their line.
        let line = typed.split(separator: "\n", omittingEmptySubsequences: false).last.map(String.init) ?? typed
        let tailText = String(line.suffix(16))
        let tailLength = tailText.contains(where: { !$0.isWhitespace }) ? tailText.utf16.count : 0
        AccessibilityWork.queue.async { [weak self] in
            let read = GhostFieldRead.read(element, caret: caret, tailLength: tailLength)
            DispatchQueue.main.async {
                guard let self, token == self.generation else { return }
                let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
                let caretOnScreen = HostGeometryConverter.toAppKit(caretRect, primaryHeight: primary?.frame.maxY ?? 0)
                let screen = NSScreen.screens.first { $0.frame.insetBy(dx: -1, dy: -1).contains(CGPoint(x: caretOnScreen.minX, y: caretOnScreen.midY)) }
                guard let placement = GhostPlacement.place(text, read: read, caret: caretRect, tailText: tailText,
                                                           primaryHeight: primary?.frame.maxY ?? 0,
                                                           screenRight: (screen ?? primary)?.visibleFrame.maxX ?? .greatestFiniteMagnitude)
                else { self.withdraw(); return }
                self.present(placement)
            }
        }
    }

    private func present(_ placement: GhostPlacement) {
        let panel = existingPanel()
        let showing = isShown
        // The same words moved with their field keep their motion; new words fade in.
        if !(showing && view.ghost?.text == placement.text) {
            view.ghost = GhostLetters(text: placement.text, keyPops: !showing,
                                      reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        }
        view.placement = placement
        panel.setFrame(placement.frame, display: false)
        view.frame = NSRect(origin: .zero, size: placement.frame.size)
        view.needsDisplay = true
        panel.orderFrontRegardless()
        watch()
        animate()
    }

    /// Tab is writing `remainder` after the caret. Where the ghost showed
    /// those words in a font that matches the field's, they brighten and hop
    /// over them; otherwise the ghost leaves for the field's own letters.
    func accept(writing remainder: String, onLanded: @escaping () -> Void) {
        guard isShown, var ghost = view.ghost, let placement = view.placement, !ghost.isAccepted else { return }
        let shown = placement.text.hasSuffix("\u{2026}") ? String(placement.text.dropLast()) : placement.text
        guard placement.cover != nil, remainder.hasPrefix(shown) else { withdraw(); return }
        ghost.accept()
        view.ghost = ghost
        self.onLanded = onLanded
        animate()
    }

    /// The card closed. A hop under way plays out; otherwise the ghost goes with the card.
    func cardClosed() {
        guard !isAccepting else { return }
        withdraw()
    }

    /// Takes the ghost away at once.
    func withdraw() {
        generation += 1
        offered = nil
        frames.stop()
        stopWatching()
        onLanded = nil
        view.ghost = nil
        view.placement = nil
        panel?.orderOut(nil)
    }

    private func animate() {
        guard view.ghost?.isMoving == true else { return }
        frames.run(in: view) { [weak self] dt in self?.frame(dt) ?? false }
    }

    private func frame(_ dt: Double) -> Bool {
        guard var ghost = view.ghost else { return false }
        ghost.advance(by: dt)
        view.ghost = ghost
        view.needsDisplay = true
        guard !ghost.hasLanded else {
            let landed = onLanded
            withdraw()
            landed?()
            return false
        }
        return ghost.isMoving
    }

    /// Typing, a click, a scroll or another app may move the field's text, so
    /// the ghost goes. The card's own keys leave it: Tab, Escape, ↑↓, fn's
    /// arrows and ⌘↩. Lasso's own typing, as it writes a suggestion, does too.
    private func watch() {
        guard monitors.isEmpty else { return }
        if let keys = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            guard let self, !Self.leavesGhost(event) else { return }
            self.withdraw()
        }) {
            monitors.append(keys)
        }
        if let pointer = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel, .leftMouseDown, .rightMouseDown],
                                                           handler: { [weak self] _ in self?.withdraw() }) {
            monitors.append(pointer)
        }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                self?.withdraw()
            }
    }

    static func leavesGhost(_ event: NSEvent) -> Bool {
        if event.cgEvent?.getIntegerValueField(.eventSourceUserData) == SyntheticKeyboard.marker { return true }
        switch Int(event.keyCode) {
        case 48, 53, 125, 126, 115, 116, 119, 121: return true      // Tab, Escape, ↓ ↑, fn's arrows
        case 36, 76: return event.modifierFlags.contains(.command)  // ⌘↩, ⇧⌘↩
        default: return false
        }
    }

    private func stopWatching() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let created = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 200, height: 40),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // Over the field, as the linked-word pills are; the card stays above it.
        created.level = .floating
        created.isOpaque = false
        created.backgroundColor = .clear
        created.hasShadow = false
        created.hidesOnDeactivate = false
        created.ignoresMouseEvents = true
        created.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        created.contentView = view
        panel = created
        return created
    }
}
