// The dictation pill's place in the assistant: it shows from a Dictation
// shortcut or dictated words (DictationPillSession), sits by the caret, grows
// into the card when one comes and shrinks back out of it when it closes.
// The meter that draws its waves runs only while the pill would show.

import Cocoa

extension GlobalAssistant {
    /// Where Lasso would suggest: suggestions on, a folder switched on, and an
    /// app Lasso is not quiet in.
    private var dictationPillAllowed: Bool {
        guard isEnabled, serverURL != nil, !projectIds.isEmpty else { return false }
        guard let app = Self.frontmostBundleID else { return true }
        return SuggestionApps.shared.allows(app)
    }

    private var dictationPillOn: Bool { dictationPillAllowed && dictationPill.isOn(at: Date()) }

    func startVoiceMeter() {
        voiceMeter.onLevels = { levels in DictationPillController.shared.hear(levels) }
        voiceMeter.onCaptureChange = { [weak self] running in
            self?.dictation.ownInputChanged(running: running)
            DictationPillController.shared.hearsVoice = running
        }
    }

    /// A Dictation shortcut: dictation starts, or stops while the pill shows.
    func dictationShortcutPressed() {
        dictation.shortcutPressed()
        dictationPill.shortcutPressed(at: Date())
        updateDictationPill()
    }

    /// Dictated words were read from the field; `caret` is where they end.
    func dictatedWordsArrived(caret: CGRect?) {
        dictationPill.wordsArrived(at: Date())
        updateDictationPill(caret: caret)
    }

    /// Escape, or another app coming forward: dictation is over.
    func stopDictationPill() {
        guard dictationPill.since != nil else { return }
        dictationPill.stop(at: Date())
        updateDictationPill()
    }

    /// Shows, moves or takes down the pill for dictation as it is now.
    /// `caret` is one just read, in Accessibility coordinates.
    func updateDictationPill(caret: CGRect? = nil) {
        let controller = DictationPillController.shared
        dictationPillTimer?.invalidate()
        dictationPillTimer = nil
        guard dictationPillOn else {
            voiceMeter.stop()
            controller.hide()
            return
        }
        if let ends = dictationPill.endsAt {
            let timer = Timer(timeInterval: max(0.05, ends.timeIntervalSinceNow), repeats: false) { [weak self] _ in
                self?.dictationPillTimer = nil
                self?.updateDictationPill()
            }
            RunLoop.main.add(timer, forMode: .common)
            dictationPillTimer = timer
        }
        voiceMeter.start()
        if panel?.isVisible == true {
            controller.cardIsUp()
            return
        }
        if let anchor = Self.pillAnchor(caret) {
            controller.show(caret: anchor.caret, cardSize: view.suggestionsBoxSize, visible: anchor.visible)
        } else if !controller.showsPill {
            // Read afresh: the caret read last may be from before the field changed.
            readCaretForDictationPill()
        }
    }

    /// The caret last read, if it is in the app in front.
    private var frontmostCaret: CGRect? {
        guard let context, let caret = context.caretRect else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(context.element, &pid) == .success,
              pid == NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
        return caret
    }

    private func readCaretForDictationPill() {
        guard !dictationPillReading else { return }
        dictationPillReading = true
        AccessibilityWork.queue.async {
            let read = AccessibilityReader.focusedContext()?.caretRect
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.dictationPillReading = false
                // Without a caret there is nowhere to put the pill; dictated words read later bring one.
                guard let caret = read ?? self.frontmostCaret, self.dictationPillOn else { return }
                self.updateDictationPill(caret: caret)
            }
        }
    }

    /// An Accessibility caret on the screen it is on, in AppKit coordinates.
    static func pillAnchor(_ caret: CGRect?) -> (caret: CGRect, visible: CGRect?)? {
        guard let caret, HostGeometryConverter.isUsable(caret) else { return nil }
        let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
        let flipped = HostGeometryConverter.toAppKit(caret, primaryHeight: primary?.frame.maxY ?? 0)
        let rect = CGRect(x: flipped.minX, y: flipped.minY, width: max(1, flipped.width), height: max(1, flipped.height))
        let screen = NSScreen.screens.first { $0.frame.intersects(rect.insetBy(dx: -1, dy: -1)) } ?? NSScreen.main
        return (rect, screen?.visibleFrame)
    }

    // MARK: The card

    /// Brings the card on screen. While the pill shows, the pill grows into
    /// it and the card fades in on its glass.
    func presentCard(_ panel: NSPanel) {
        // A close waiting to shrink into the pill is called off: the card is staying.
        dictationCardClosings += 1
        let controller = DictationPillController.shared
        let grows = dictationPillOn && controller.expand(into: panel, geometry: AssistBubbleContainer.geometry(of: view))
        if !grows {
            if dictationPillOn { controller.cardIsUp() }
            if !controller.isFadingIn(panel) { panel.alphaValue = 1 }
        }
        panel.orderFrontRegardless()
    }

    /// The card as it was when it began to close, for the pill to shrink out of.
    struct ClosingCard {
        let frame: CGRect
        let geometry: AssistBubbleGeometry
        let caret: CGRect?
    }

    /// Read before the card closes: once it has, its caret is forgotten.
    func closingCard() -> ClosingCard? {
        guard let panel, panel.isVisible, DictationPillController.shared.state == .card,
              !PassagePickerController.shared.isPresented(in: panel),
              !ShareComposerController.shared.isPresented(in: panel) else { return nil }
        return ClosingCard(frame: panel.frame, geometry: AssistBubbleContainer.geometry(of: view),
                           caret: popupCaret ?? frontmostCaret)
    }

    /// The card closed. Unless it shows again straight away, as a card that
    /// closes for a message does, the pill comes back out of it.
    func cardClosed(_ card: ClosingCard?) {
        guard let card else { return }
        dictationCardClosings += 1
        let closing = dictationCardClosings
        DispatchQueue.main.async { [weak self] in
            guard let self, closing == self.dictationCardClosings, self.panel?.isVisible != true else { return }
            let controller = DictationPillController.shared
            guard self.dictationPillOn, let anchor = Self.pillAnchor(card.caret) else {
                controller.cardGone()
                self.updateDictationPill()
                return
            }
            controller.collapse(from: card.frame, geometry: card.geometry, caret: anchor.caret,
                                cardSize: self.view.suggestionsBoxSize, visible: anchor.visible)
        }
    }
}
