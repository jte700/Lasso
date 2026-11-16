// The colour picker under a folder row: Lasso's colours in one white capsule,
// then a slot for a colour of the user's own, then a glossy black +. The chosen
// colour is stretched into a pill that names it, with a × that closes the picker.
//
// Pointing at a colour widens it into a short capsule and pushes the others
// along. Pressing one presses it in. Choosing one shrinks the old pill back to
// a dot while the new one stretches, and its name comes in letter by letter
// out of a blur. Opening grows the row on a spring while the capsule washes
// in; closing washes it out and the row shrinks back.
//
// The + turns into × and the capsule grows down into a card for making a
// colour (DirectoryColorCard.swift). The colour being made takes the slot as a
// pill with its hex, and changes as the card's controls move. Done keeps it;
// the × puts the card away and goes back to the colour the folder had. Pieces,
// sizes and motion tokens are in DirectoryColorPaletteParts.swift.

import Cocoa
import QuartzCore

final class DirectoryColorPaletteRow: NSView {
    private let content = PaletteFlippedView()
    private let track = PaletteTrack()
    /// Lasso's six colours, then the slot for a colour of one's own.
    private(set) var swatches: [PaletteSwatch] = []
    let closeButton = PaletteCloseButton()
    let plusButton = PalettePlusButton()
    let card = PaletteCardView()
    private let onPick: (DirectoryToggleColor) -> Void
    /// The close button was pressed.
    var onClose: (() -> Void)?
    /// How many points of room under its row the picker takes now; the row grows to it.
    var onRoom: ((CGFloat) -> Void)?
    /// Closing has finished; the row can let the picker go.
    var onClosed: (() -> Void)?
    /// Keeps the panel open while the screen's eyedropper is out; call what it returns to let go.
    var holdOpen: (() -> () -> Void)?
    private(set) var selected: DirectoryToggleColor
    /// A new picker is closed until `open()`.
    private(set) var isOpen = false
    private var enabled = true
    private var hovered: Int?
    /// The colour of one's own the slot offers when nothing is being made.
    private(set) var slotColor: DirectoryToggleColor?
    /// While the card is open: the colour being made, and what to go back to if it is not kept.
    private(set) var draft: PaletteHSB?
    private var beforeDraft: (selected: DirectoryToggleColor, slot: DirectoryToggleColor?)?
    private var sampler: NSColorSampler?

    /// The six colours, the slot, then the +.
    private var widths: [IslandSpring] = []
    private var presses: [IslandSpring] = []
    private var letterFades: [[IslandTween]] = []
    /// Letters coming in clear out of a blur; letters going simply fade.
    private var arriving: [Bool] = []
    private var closeFade = IslandTween.resting(1)
    private var closePress = IslandSpring(1, stiffness: PaletteMotion.press.stiffness, damping: PaletteMotion.press.damping)
    private var donePress = IslandSpring(1, stiffness: PaletteMotion.press.stiffness, damping: PaletteMotion.press.damping)
    private var reveal = IslandSpring(0, stiffness: PaletteMotion.reveal.stiffness, damping: PaletteMotion.reveal.damping)
    private var wash = IslandTween.resting(0)
    private var cardOpen = IslandSpring(0, stiffness: PaletteMotion.card.stiffness, damping: PaletteMotion.card.damping)
    private var cardWash = IslandTween.resting(0)
    private var turn = IslandSpring(0, stiffness: PaletteMotion.turn.stiffness, damping: PaletteMotion.turn.damping)
    private var reportedRoom: CGFloat?

    /// Tests drive the clock and the frames by hand, and choose Reduce Motion.
    var clock: () -> CFTimeInterval = CACurrentMediaTime
    var drivesItself = true
    var animatesOffscreen = false
    var reducesMotion: () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private var lastFrame: CFTimeInterval?
    private var frameTimer: Timer?
    private var displayLinkObject: AnyObject?

    static var height: CGFloat { PaletteMetric.rowHeight }
    var slotIndex: Int { swatches.count - 1 }
    private var plusIndex: Int { swatches.count }

    /// `custom` is the last colour of their own the user made, offered in the slot
    /// when the folder's own colour is one of Lasso's.
    init(selected: DirectoryToggleColor, custom: DirectoryToggleColor? = nil,
         onPick: @escaping (DirectoryToggleColor) -> Void) {
        self.selected = selected
        self.onPick = onPick
        slotColor = selected.isCustom ? selected : custom.flatMap { $0.isCustom ? $0 : nil }
        super.init(frame: NSRect(x: 0, y: 0, width: 260, height: PaletteMetric.rowHeight))
        wantsLayer = true
        layer?.masksToBounds = true
        setAccessibilityElement(false)
        content.wantsLayer = true
        content.layerUsesCoreImageFilters = true
        content.frame = NSRect(x: 0, y: 0, width: bounds.width, height: PaletteMetric.rowHeight)
        content.autoresizingMask = [.width, .height]
        addSubview(content)
        content.addSubview(track)
        let entries = DirectoryToggleColor.allCases + [slotColor ?? selected]
        for (index, color) in entries.enumerated() {
            let swatch = PaletteSwatch(color: color)
            swatch.onPick = { [weak self, weak swatch] in
                guard let self, let swatch else { return }
                self.choose(swatch.tint)
            }
            swatch.onPress = { [weak self] down in self?.press(index, down: down) }
            swatches.append(swatch)
            track.addSubview(swatch)
            widths.append(IslandSpring(0, stiffness: PaletteMotion.width.stiffness, damping: PaletteMotion.width.damping))
            presses.append(IslandSpring(1, stiffness: PaletteMotion.press.stiffness, damping: PaletteMotion.press.damping))
            letterFades.append(swatch.letters.map { _ in .resting(0) })
            arriving.append(false)
        }
        widths.append(IslandSpring(Double(PaletteMetric.swatch), stiffness: PaletteMotion.width.stiffness,
                                   damping: PaletteMotion.width.damping))
        presses.append(IslandSpring(1, stiffness: PaletteMotion.press.stiffness, damping: PaletteMotion.press.damping))
        if let chosen = selectedIndex {
            letterFades[chosen] = swatches[chosen].letters.map { _ in .resting(1) }
        }
        markSelected()
        closeButton.onClick = { [weak self] in self?.onClose?() }
        closeButton.onPress = { [weak self] down in
            guard let self else { return }
            self.closePress.t = down ? PaletteMotion.pressedScale : 1
            self.startLoop()
        }
        track.addSubview(closeButton)
        plusButton.onClick = { [weak self] in
            guard let self else { return }
            if self.draft == nil { self.startDraft() } else { self.finishDraft(keep: false) }
        }
        plusButton.onPress = { [weak self] down in
            guard let self else { return }
            self.press(self.plusIndex, down: down)
        }
        track.addSubview(plusButton)
        card.onChange = { [weak self] value in self?.editDraft(value) }
        card.onSample = { [weak self] in self?.sampleScreen() }
        card.doneButton.onClick = { [weak self] in self?.finishDraft(keep: true) }
        card.doneButton.onPress = { [weak self] down in
            guard let self else { return }
            self.donePress.t = down ? PaletteMotion.pressedScale : 1
            self.startLoop()
        }
        card.isHidden = true
        track.addSubview(card, positioned: .below, relativeTo: swatches.first)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
        retarget()
        settle()
        applyColors()
        render()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { frameTimer?.invalidate() }

    override var isFlipped: Bool { true }

    /// A click between colours or beside the capsule does nothing, rather than
    /// reaching the row and switching its folder.
    override func mouseDown(with event: NSEvent) {}

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(newSize.width - frame.width) >= 0.5
        super.setFrameSize(newSize)
        if widthChanged {
            retarget()
            render()
        }
    }

    // MARK: Opening, closing and choosing

    /// Grows the row and washes the capsule in, from wherever a closing left it.
    /// Off screen it is simply open.
    func open() {
        isOpen = true
        let now = clock()
        reveal.t = 1
        reveal.tune(stiffness: PaletteMotion.reveal.stiffness, damping: PaletteMotion.reveal.damping,
                    reduceMotion: reducesMotion())
        wash = IslandTween(from: wash.value(at: now), to: 1, start: now, duration: PaletteMotion.washInSeconds)
        refreshHover()
        animate()
    }

    /// Washes the capsule out and shrinks the row, then says it has closed. A colour
    /// still being made is not kept.
    func close() {
        if draft != nil { finishDraft(keep: false) }
        isOpen = false
        let now = clock()
        reveal.t = 0
        reveal.tune(stiffness: PaletteMotion.reveal.stiffness * PaletteMotion.closingStiffness,
                    damping: PaletteMotion.reveal.damping, reduceMotion: reducesMotion())
        wash = IslandTween(from: wash.value(at: now), to: 0, start: now, duration: PaletteMotion.washOutSeconds)
        hovered = nil
        retarget()
        animate()
    }

    func update(selected color: DirectoryToggleColor, isEnabled: Bool) {
        if enabled != isEnabled {
            enabled = isEnabled
            for swatch in swatches { swatch.isEnabled = isEnabled }
            for button in [closeButton, plusButton, card.doneButton] as [NSButton] { button.isEnabled = isEnabled }
            if !isEnabled {
                hovered = nil
                if draft != nil { finishDraft(keep: false) }
            }
            applyColors()
            retarget()
        }
        if let before = beforeDraft {
            // The panel rebuilds its rows while a colour is being made; only a real change ends it.
            if color != before.selected {
                finishDraft(keep: false)
                select(color)
            }
        } else if color != selected {
            select(color)
        }
        animate()
    }

    private func choose(_ color: DirectoryToggleColor) {
        guard enabled else { return }
        if draft != nil {
            guard color != selected else { return }
            // Another colour puts the card away without keeping the one being made.
            putCardAway()
            restoreSlot(beforeDraft?.slot)
            beforeDraft = nil
        }
        select(color)
        animate()
        onPick(color)
    }

    private var slotPresent: Bool { draft != nil || slotColor != nil }

    private var selectedIndex: Int? {
        if let index = DirectoryToggleColor.allCases.firstIndex(of: selected) { return index }
        return slotPresent && swatches[slotIndex].tint == selected ? slotIndex : nil
    }

    private func markSelected() {
        let chosen = selectedIndex
        for (index, swatch) in swatches.enumerated() { swatch.selected = index == chosen }
    }

    private func select(_ color: DirectoryToggleColor) {
        guard color != selected else { return }
        if color.isCustom, draft == nil, slotColor != color {
            // A colour of one's own chosen elsewhere takes the slot.
            slotColor = color
            swatches[slotIndex].recolor(color)
            paint(slotIndex)
        }
        selected = color
        markSelected()
        let now = clock()
        let reduce = reducesMotion()
        let chosen = selectedIndex
        for index in swatches.indices where index != chosen && letterFades[index].contains(where: { $0.to > 0 }) {
            arriving[index] = false
            letterFades[index] = letterFades[index].map {
                IslandTween(from: $0.value(at: now), to: 0, start: now, duration: PaletteMotion.nameOutSeconds)
            }
        }
        if let chosen {
            arriving[chosen] = !reduce
            letterFades[chosen] = letterFades[chosen].indices.map { letter in
                IslandTween(from: 0, to: 1, start: now, delay: PaletteMotion.letterStart(letter, reduceMotion: reduce),
                            duration: PaletteMotion.letterSeconds, curve: reduce ? .ease : .land)
            }
            closeButton.ink = ink(for: swatches[chosen].tint)
        }
        closeFade = draft == nil
            ? IslandTween(from: 0, to: 1, start: now, delay: reduce ? 0 : PaletteMotion.closeDelay,
                          duration: PaletteMotion.closeSeconds)
            : .resting(0)
        retarget()
    }

    // MARK: Making a colour

    /// The + was pressed: the chosen colour is copied into the slot as a pill with its
    /// hex, and the capsule grows into the card to change it.
    private func startDraft() {
        guard enabled, draft == nil else { return }
        let start = PaletteHSB(selected)
        beforeDraft = (selected, slotColor)
        draft = start
        let made = start.color
        swatches[slotIndex].recolor(made)
        fitLetters(slotIndex)
        paint(slotIndex)
        // A slot already chosen keeps its name; otherwise it stretches and types its hex in.
        if made == selected {
            markSelected()
            closeFade = .resting(0)
            retarget()
        } else {
            select(made)
        }
        card.show(start)
        let now = clock()
        let reduce = reducesMotion()
        cardOpen.t = 1
        cardOpen.tune(stiffness: PaletteMotion.card.stiffness, damping: PaletteMotion.card.damping, reduceMotion: reduce)
        cardWash = IslandTween(from: cardWash.value(at: now), to: 1, start: now,
                               delay: reduce ? 0 : PaletteMotion.cardInDelay, duration: PaletteMotion.cardInSeconds)
        turn.t = 1
        turn.tune(stiffness: PaletteMotion.turn.stiffness, damping: PaletteMotion.turn.damping, reduceMotion: reduce)
        plusButton.setOpen(true)
        animate()
    }

    /// The card's controls moved: the pill being made follows them.
    private func editDraft(_ value: PaletteHSB) {
        guard draft != nil else { return }
        draft = value
        let made = value.color
        swatches[slotIndex].recolor(made)
        fitLetters(slotIndex)
        paint(slotIndex)
        selected = made
        markSelected()
        retarget()
        animate()
    }

    /// Done keeps the colour being made; the × does not. A colour that is one of
    /// Lasso's own is chosen as that colour.
    private func finishDraft(keep: Bool) {
        guard let value = draft, let before = beforeDraft else { return }
        putCardAway()
        beforeDraft = nil
        if keep, value.color.matchingPreset == nil {
            let made = value.color
            slotColor = made
            selected = made
            markSelected()
            let now = clock()
            closeFade = IslandTween(from: 0, to: 1, start: now,
                                    delay: reducesMotion() ? 0 : PaletteMotion.closeDelay, duration: PaletteMotion.closeSeconds)
            retarget()
            animate()
            onPick(made)
            return
        }
        restoreSlot(before.slot)
        let target = keep ? value.color.matchingPreset ?? before.selected : before.selected
        if target == selected {
            markSelected()
            closeFade = IslandTween(from: 0, to: 1, start: clock(), delay: reducesMotion() ? 0 : PaletteMotion.closeDelay,
                                    duration: PaletteMotion.closeSeconds)
            retarget()
        } else {
            select(target)
        }
        animate()
        if keep { onPick(target) }
    }

    private func putCardAway() {
        draft = nil
        let now = clock()
        let reduce = reducesMotion()
        cardOpen.t = 0
        cardOpen.tune(stiffness: PaletteMotion.card.stiffness * PaletteMotion.closingStiffness,
                      damping: PaletteMotion.card.damping, reduceMotion: reduce)
        cardWash = IslandTween(from: cardWash.value(at: now), to: 0, start: now, duration: PaletteMotion.cardOutSeconds)
        turn.t = 0
        turn.tune(stiffness: PaletteMotion.turn.stiffness, damping: PaletteMotion.turn.damping, reduceMotion: reduce)
        plusButton.setOpen(false)
    }

    /// The slot goes back to the colour it offered before, or shrinks away if it had none.
    private func restoreSlot(_ color: DirectoryToggleColor?) {
        slotColor = color
        guard let color else { return }
        swatches[slotIndex].recolor(color)
        fitLetters(slotIndex)
        paint(slotIndex)
    }

    /// The slot's name was set out again; its letters keep the fade they had.
    private func fitLetters(_ index: Int) {
        let count = swatches[index].letters.count
        guard letterFades[index].count != count else { return }
        let shown = letterFades[index].first?.to ?? 0
        letterFades[index] = (0..<count).map { _ in .resting(shown) }
    }

    /// The screen's eyedropper; the panel stays open while it is out.
    private func sampleScreen() {
        guard draft != nil, sampler == nil else { return }
        let release = holdOpen?()
        let sampler = NSColorSampler()
        self.sampler = sampler
        sampler.show { [weak self] picked in
            release?()
            guard let self else { return }
            self.sampler = nil
            guard let picked, self.draft != nil, let rgb = picked.usingColorSpace(.sRGB) else { return }
            let value = PaletteHSB(red: Double(rgb.redComponent), green: Double(rgb.greenComponent),
                                   blue: Double(rgb.blueComponent))
            self.card.show(value)
            self.editDraft(value)
        }
    }

    private func press(_ index: Int, down: Bool) {
        guard enabled else { return }
        presses[index].t = down ? PaletteMotion.pressedScale : 1
        presses[index].tune(stiffness: PaletteMotion.press.stiffness, damping: PaletteMotion.press.damping,
                            reduceMotion: reducesMotion())
        startLoop()
    }

    private func pillWidth(_ index: Int) -> CGFloat { PaletteLayout.pillWidth(nameWidth: swatches[index].nameWidth) }

    /// The widest the capsule, and the card, may be in this row.
    private var maxTrackWidth: CGFloat {
        max(PaletteMetric.trackHeight * 4, bounds.width - PaletteMetric.trackX - PaletteMetric.trailingRoom)
    }

    /// Points every item's width at where it should be now.
    private func retarget() {
        let reduce = reducesMotion()
        let chosen = selectedIndex
        var targets: [CGFloat] = swatches.indices.map { index in
            if index == slotIndex, !slotPresent { return 0 }
            return index == chosen ? pillWidth(index) : PaletteMetric.swatch
        }
        targets.append(PaletteMetric.swatch)
        if let hovered, hovered != chosen, targets[hovered] > 0 {
            targets[hovered] = PaletteLayout.width(selected: false, hovered: true, pill: 0, reduceMotion: reduce,
                                                   hoverRoom: maxTrackWidth - PaletteLayout.trackWidth(widths: targets))
        }
        for index in targets.indices {
            widths[index].t = Double(targets[index])
            widths[index].tune(stiffness: PaletteMotion.width.stiffness, damping: PaletteMotion.width.damping,
                               reduceMotion: reduce)
        }
    }

    /// Where the colours are headed, for judging what the pointer is on.
    private var targetFrames: [CGRect] {
        Array(PaletteLayout.frames(widths: widths.map { CGFloat($0.t) }, origin: trackOrigin).prefix(swatches.count))
    }

    private var trackOrigin: CGPoint {
        CGPoint(x: PaletteMetric.trackX, y: ((PaletteMetric.rowHeight - PaletteMetric.trackHeight) / 2).rounded())
    }

    /// The width each colour, then the +, is heading for, for tests.
    var targetWidths: [CGFloat] { widths.map { CGFloat($0.t) } }
    /// The width each colour, then the +, is drawn at now.
    var shownWidths: [CGFloat] { widths.map { CGFloat($0.x) } }
    var shownRoom: CGFloat { reportedRoom ?? 0 }
    var cardOpenness: CGFloat { CGFloat(cardOpen.x) }
    var closeOpacity: CGFloat { CGFloat(closeButton.alphaValue) }
    var plusTurn: CGFloat { CGFloat(turn.x) }
    var trackFrame: NSRect { track.frame }
    func letterOpacities(_ color: DirectoryToggleColor) -> [Float] {
        swatches.first { $0.tint == color }?.letters.map(\.opacity) ?? []
    }

    // MARK: Pointer

    override func mouseMoved(with event: NSEvent) { pointer(at: convert(event.locationInWindow, from: nil)) }
    override func mouseEntered(with event: NSEvent) { pointer(at: convert(event.locationInWindow, from: nil)) }
    override func mouseExited(with event: NSEvent) { pointer(at: nil) }

    /// The palette can open under a still pointer, which sends no event. Read where it is.
    func refreshHover() {
        guard let window, window.isVisible else { pointer(at: nil); return }
        pointer(at: convert(window.mouseLocationOutsideOfEventStream, from: nil))
    }

    /// Points at a place in the palette, or nowhere.
    func pointer(at point: CGPoint?) {
        let next = enabled && isOpen ? point.flatMap { PaletteLayout.hovered(at: $0, frames: targetFrames) } : nil
        guard next != hovered else { return }
        hovered = next
        retarget()
        animate()
    }

    // MARK: Colours

    private func ink(for color: DirectoryToggleColor) -> NSColor {
        PaletteLayout.darkText(on: color.color) ? NSColor.black.withAlphaComponent(0.78) : NSColor.white.withAlphaComponent(0.96)
    }

    private func paint(_ index: Int) {
        let swatch = swatches[index]
        let dark = paletteIsDark(self)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        swatch.face.backgroundColor = swatch.tint.color.cgColor
        swatch.face.borderColor = NSColor.black.withAlphaComponent(dark ? 0.2 : 0.1).cgColor
        swatch.face.opacity = enabled ? 1 : 0.45
        let ink = ink(for: swatch.tint).cgColor
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        for letter in swatch.letters {
            letter.foregroundColor = ink
            if letter.contentsScale != scale { letter.contentsScale = scale }
        }
        CATransaction.commit()
        if index == selectedIndex { closeButton.ink = self.ink(for: swatch.tint) }
    }

    private func applyColors() {
        for index in swatches.indices { paint(index) }
        plusButton.alphaValue = enabled ? 1 : 0.45
        plusButton.applyColors()
        track.needsDisplay = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColors()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        applyColors()
    }

    /// Choosing a colour makes the panel rebuild, which takes every row out of its
    /// window and puts it back. A picker that has been on screen keeps its motion
    /// through that, rather than jumping to where it was going.
    private var hasBeenInWindow = false

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyColors()
        guard window != nil else {
            stopLoop()
            return
        }
        hasBeenInWindow = true
        if canAnimate, !isAtRest(at: clock()) {
            render()
            startLoop()
        } else {
            settle()
            render()
            finishIfClosed()
        }
        refreshHover()
    }

    // MARK: Frames

    private var canAnimate: Bool { animatesOffscreen || window?.isVisible == true }

    /// Moves now if it can be seen; waits while the panel has it out for a rebuild;
    /// otherwise lands where it was going.
    private func animate() {
        if canAnimate {
            render()
            startLoop()
        } else if window == nil, hasBeenInWindow {
            render()
        } else {
            settle()
            render()
            finishIfClosed()
        }
    }

    private func startLoop() {
        guard drivesItself, canAnimate, frameTimer == nil, displayLinkObject == nil, !isAtRest(at: clock()) else { return }
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

    /// One frame: springs stepped in slices, then everything drawn where they are.
    func tick() {
        let now = clock()
        guard canAnimate else {
            settle()
            render()
            stopLoop()
            finishIfClosed()
            return
        }
        let dt = min(max(now - (lastFrame ?? now - 1.0 / 60), 0), 1.0 / 30)
        lastFrame = now
        let slice = dt / Double(PaletteMotion.substeps)
        for _ in 0..<PaletteMotion.substeps {
            for index in widths.indices {
                widths[index].step(slice)
                presses[index].step(slice)
            }
            closePress.step(slice)
            donePress.step(slice)
            reveal.step(slice)
            cardOpen.step(slice)
            turn.step(slice)
        }
        if isAtRest(at: now) {
            settle()
            render()
            stopLoop()
            finishIfClosed()
        } else {
            render()
        }
    }

    func isAtRest(at now: CFTimeInterval) -> Bool {
        widths.allSatisfy { $0.isSettled(within: 0.05) }
            && presses.allSatisfy { $0.isSettled(within: 0.001) }
            && closePress.isSettled(within: 0.001) && donePress.isSettled(within: 0.001)
            && reveal.isSettled(within: 0.002) && cardOpen.isSettled(within: 0.002) && turn.isSettled(within: 0.002)
            && wash.isDone(at: now) && cardWash.isDone(at: now) && closeFade.isDone(at: now)
            && letterFades.allSatisfy { $0.allSatisfy { $0.isDone(at: now) } }
    }

    private func settle() {
        for index in widths.indices {
            widths[index].snap()
            presses[index].snap()
        }
        for index in letterFades.indices { letterFades[index] = letterFades[index].map { .resting($0.to) } }
        closePress.snap()
        donePress.snap()
        reveal.snap()
        cardOpen.snap()
        turn.snap()
        wash = .resting(wash.to)
        cardWash = .resting(cardWash.to)
        closeFade = .resting(closeFade.to)
    }

    private func finishIfClosed() {
        guard !isOpen, reveal.x <= 0.001 else { return }
        onClosed?()
    }

    private func render() {
        let now = clock()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let shown = widths.map { CGFloat(max($0.x, 0)) }
        let origin = trackOrigin
        // The colours sit in the capsule, which grows into the card and is as tall as
        // the room the row has made for it.
        let frames = PaletteLayout.frames(widths: shown, origin: .zero)
        let toolbar = PaletteLayout.trackWidth(widths: shown)
        let openness = CGFloat(max(0, cardOpen.x))
        let cardWidth = max(maxTrackWidth, toolbar)
        let cardHeight = PaletteCardLayout.height(width: cardWidth)
        let surfaceWidth = toolbar + (cardWidth - toolbar) * min(1, openness)
        let surfaceHeight = PaletteMetric.trackHeight + cardHeight * openness
        let room = CGFloat(max(0, reveal.x)) * (surfaceHeight + 2 * origin.y)
        let height = max(0, min(surfaceHeight, room - 2 * origin.y))
        track.frame = NSRect(x: origin.x, y: origin.y, width: surfaceWidth, height: height)
        track.layer?.cornerRadius = min(PaletteMetric.trackHeight, height) / 2
        for (index, swatch) in swatches.enumerated() {
            let face = frames[index]
            let reach = face.insetBy(dx: -PaletteMetric.gap / 2, dy: -PaletteMetric.inset)
            if swatch.frame != reach { swatch.frame = reach }
            swatch.isHidden = face.width < 1
            swatch.place(face: face.offsetBy(dx: -reach.minX, dy: -reach.minY), scale: CGFloat(presses[index].x))
            for (letter, layer) in swatch.letters.enumerated() {
                let opacity = letter < letterFades[index].count ? letterFades[index][letter].value(at: now) : 1
                layer.opacity = Float(opacity)
                layer.isHidden = opacity < 0.002
                paletteBlur(layer, radius: arriving[index] ? PaletteMotion.letterBlur * (1 - opacity) : 0)
            }
        }
        let plus = frames[plusIndex].insetBy(dx: -PaletteMetric.gap / 2, dy: -PaletteMetric.inset)
        if plusButton.frame != plus { plusButton.frame = plus }
        plusButton.place(scale: CGFloat(presses[plusIndex].x), turn: CGFloat(turn.x))
        card.doneButton.place(scale: CGFloat(donePress.x))
        CATransaction.commit()
        if let chosen = selectedIndex {
            let pill = frames[chosen]
            let size = PaletteMetric.close
            let place = NSRect(x: pill.maxX - PaletteMetric.closeTrailing - size, y: pill.midY - size / 2,
                               width: size, height: size)
            if closeButton.frame != place { closeButton.frame = place }
            // The × is written in the pill's own ink, which a colour being made can change.
            let wanted = ink(for: swatches[chosen].tint)
            if closeButton.ink != wanted { closeButton.ink = wanted }
            let stretched = (pill.width - PaletteMetric.hoverWidth) / max(1, pillWidth(chosen) - PaletteMetric.hoverWidth)
            let opacity = closeFade.value(at: now) * Double(min(1, max(0, stretched)))
            closeButton.alphaValue = CGFloat(opacity)
            closeButton.isHidden = opacity < 0.002
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            closeButton.press(scale: CGFloat(closePress.x))
            CATransaction.commit()
        } else {
            closeButton.isHidden = true
        }
        let cardFrame = NSRect(x: 0, y: PaletteMetric.trackHeight, width: cardWidth, height: cardHeight)
        if card.frame != cardFrame { card.frame = cardFrame }
        let cardShown = cardWash.value(at: now)
        card.alphaValue = CGFloat(cardShown)
        card.isHidden = cardShown < 0.002 && openness < 0.002
        paletteBlur(card, radius: PaletteMotion.cardBlur * (1 - cardShown))
        let washed = wash.value(at: now)
        content.alphaValue = CGFloat(washed)
        paletteBlur(content, radius: PaletteMotion.washBlur * (1 - washed))
        if reportedRoom != room {
            reportedRoom = room
            onRoom?(room)
        }
    }
}
