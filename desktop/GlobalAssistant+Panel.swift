// The suggestion panel: showing it, following the caret, and its brief messages.

import Cocoa

extension GlobalAssistant {
    // MARK: Panel

    /// Deterministic render used only when LASSO_OVERLAY_FIXTURE=1. Keeping the
    /// fixture beside the production view makes visual QA exercise the exact
    /// same AppKit drawing, material, and sizing path users receive.
    func showDesignFixture() {
        view.mode = .suggestions
        view.selected = 0
        view.sourceScoped = true
        view.suggestions = [
            AssistSuggestion(insertText: "Office supplies", label: "Office supplies",
                             detail: "$400", path: "/Accounting/Income-Statement.xlsx",
                             location: "Accounting!B21", replacement: nil,
                             objectId: "fixture-1", versionId: "v1", snapshotId: "s1",
                             usageObjectId: nil, projectId: "fixture", rankingReason: nil),
            AssistSuggestion(insertText: "Office supplies budget", label: "Office supplies budget",
                             detail: "$420", path: "/Expenses/Budget-Plan.xlsx",
                             location: "Expenses!B18", replacement: nil,
                             objectId: "fixture-2", versionId: "v1", snapshotId: "s1",
                             usageObjectId: nil, projectId: "fixture", rankingReason: nil),
            AssistSuggestion(insertText: "Office supplies actual", label: "Office supplies actual",
                             detail: "$375", path: "/History/Historical-Expenses.xlsx",
                             location: "Sheet1!C9", replacement: nil,
                             objectId: "fixture-3", versionId: "v1", snapshotId: "s1",
                             usageObjectId: nil, projectId: "fixture", rankingReason: nil),
            AssistSuggestion(insertText: "Supplies account", label: "Supplies account",
                             detail: "6110", path: "/Accounting/Chart-of-Accounts.pdf",
                             location: "p. 6", replacement: nil,
                             objectId: "fixture-4", versionId: "v1", snapshotId: "s1",
                             usageObjectId: nil, projectId: "fixture", rankingReason: nil),
        ]
        view.preview = AssistDocumentPreview(
            filename: "Income-Statement.xlsx",
            path: "/Accounting/Income-Statement.xlsx",
            location: "Accounting!B21",
            context: "Office supplies",
            valueText: "$400",
            objectType: "SPREADSHEET_CELL",
            snapshotVersion: 1,
            columns: ["A", "B", "D", "F"],
            headers: ["", "Current Period", "Prior Period", "Increase (Decrease)"],
            rows: [
                AssistPreviewRow(rowNumber: 18, cells: [
                    AssistPreviewCell(value: "Payroll Taxes", cited: false),
                    AssistPreviewCell(value: "225", cited: false), AssistPreviewCell(value: "215", cited: false), AssistPreviewCell(value: "10", cited: false)]),
                AssistPreviewRow(rowNumber: 19, cells: [
                    AssistPreviewCell(value: "Depreciation-Direct", cited: false),
                    AssistPreviewCell(value: "612", cited: false), AssistPreviewCell(value: "612", cited: false), AssistPreviewCell(value: "0", cited: false)]),
                AssistPreviewRow(rowNumber: 20, cells: [
                    AssistPreviewCell(value: "Office Supplies", cited: false),
                    AssistPreviewCell(value: "400", cited: true), AssistPreviewCell(value: "310", cited: false), AssistPreviewCell(value: "90", cited: false)]),
                AssistPreviewRow(rowNumber: 21, cells: [
                    AssistPreviewCell(value: "Utilities", cited: false),
                    AssistPreviewCell(value: "180", cited: false)]),
                AssistPreviewRow(rowNumber: 22, cells: [
                    AssistPreviewCell(value: "", cited: false),
                    AssistPreviewCell(value: "", cited: false)]),
            ])
        view.isPreviewLoading = false
        view.pointerAtTop = true
        view.pointerX = 84

        let panel = existingPanel()
        let size = view.boxSize
        view.needsDisplay = true
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrame(NSRect(x: visible.midX - size.width / 2,
                              y: visible.midY - size.height / 2,
                              width: size.width, height: size.height), display: true)
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Shows suggestions for the host whose caret was last measured. Never
    /// reads the host itself.
    func show(_ suggestions: [AssistSuggestion]) {
        feedbackDismissed = false
        guard view.mode == .suggestions else { return }
        guard context != nil, popupHost != nil, popupCaret != nil else { hide(); return }
        let panel = existingPanel()
        view.suggestions = suggestions
        view.selected = min(view.selected, max(0, suggestions.count - 1))
        loadPreviewForSelection()
        refreshPanelGeometry()
        panel.orderFrontRegardless()
        publishKeyRouting()
    }

    func showMeasuringHost(_ suggestions: [AssistSuggestion]) {
        guard let context else { hide(); return }
        measureHost(for: context) { [weak self] in self?.show(suggestions) }
    }

    /// Measures the editor's caret off the main thread, then presents on the
    /// main thread unless anything newer happened meanwhile.
    private func measureHost(for context: CaretContext, then present: @escaping () -> Void) {
        let token = generation
        let previous = popupHost
        measuringFor = token
        AccessibilityWork.queue.async { [weak self] in
            let host = Self.popupHost(for: context.element, reusing: previous)
            let surroundings = host?.visibleSurroundings(caret: AccessibilityReader.caretRect(of:),
                                                         text: AccessibilityReader.visibleTextFrame(of:))
            DispatchQueue.main.async {
                guard let self else { return }
                if self.measuringFor == token { self.measuringFor = nil }
                guard token == self.generation else { return }
                guard let host, let surroundings else { self.hide(); return }
                self.adoptHost(host, surroundings: surroundings)
                present()
            }
        }
    }

    /// Moves an already-visible box to follow the caret.
    /// Follows the caret between refreshes, throttled so fast typing does not
    /// flood the Accessibility API.
    func trackCaret() {
        guard popupHost != nil else { return }
        let stamp = Date()
        guard stamp.timeIntervalSince(lastTrack) > 0.03 else { return }
        lastTrack = stamp
        updateHostPosition()
    }

    /// Follows an editor whose caret was measured with the text around it.
    func adoptHost(_ host: AssistPopupHost, surroundings: HostSurroundings) {
        adoptHost(host, caret: surroundings.caret)
        popupSurroundings = surroundings
        textMeasuredAt = surroundings.caret
    }

    /// Follows an editor measured off the main thread. Until the text around
    /// a moved caret is measured, the card keeps clear of where it was.
    func adoptHost(_ host: AssistPopupHost, caret: CGRect) {
        let sameHost = popupHost.map { CFEqual($0.element, host.element) } ?? false
        if !sameHost { hostGeneration += 1 }
        popupHost = host
        popupCaret = caret
        popupSurroundings = sameHost ? popupSurroundings.map { HostSurroundings(caret: caret, window: $0.window, text: $0.text) } : nil
        if hostTimer == nil {
            let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.updateHostPosition() }
            timer.tolerance = 0.02
            // Keep following while the user drags or resizes a host window.
            RunLoop.main.add(timer, forMode: .common)
            hostTimer = timer
            let center = NSWorkspace.shared.notificationCenter
            for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                         NSWorkspace.didHideApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
                hostObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.updateHostPosition()
                })
            }
        }
    }

    /// Reads the caret off the main thread. While a slow host is still
    /// answering, later ticks wait for it instead of queueing behind it.
    private func updateHostPosition() {
        guard let host = popupHost, hostReads.begin() else { return }
        let token = hostGeneration
        let last = popupSurroundings
        let measuredAt = textMeasuredAt
        AccessibilityWork.queue.async { [weak self] in
            // The text in view is measured again only once the caret has moved.
            let surroundings = host.visibleSurroundings(caret: AccessibilityReader.caretRect(of:),
                                                        text: AccessibilityReader.visibleTextFrame(of:),
                                                        reuse: { caret in caret == measuredAt && last != nil ? .some(last?.text) : nil })
            DispatchQueue.main.async {
                guard let self else { return }
                let again = self.hostReads.end()
                if token == self.hostGeneration { self.followHost(to: surroundings) }
                if again { self.updateHostPosition() }
            }
        }
    }

    private func followHost(to surroundings: HostSurroundings?) {
        guard let surroundings else { hide(); return }
        textMeasuredAt = surroundings.caret
        guard surroundings != popupSurroundings else { return }
        popupCaret = surroundings.caret
        popupSurroundings = surroundings
        reposition(near: surroundings.caret)
    }

    func stopTrackingHost() {
        hostGeneration += 1
        hostReads.dropPending()
        hostTimer?.invalidate()
        hostTimer = nil
        let center = NSWorkspace.shared.notificationCenter
        hostObservers.forEach { center.removeObserver($0) }
        hostObservers.removeAll()
        popupHost = nil
        popupCaret = nil
        popupSurroundings = nil
        textMeasuredAt = nil
    }

    func reposition(near caret: CGRect?) {
        guard let panel, panel.isVisible else { return }
        let size = ShareComposerController.shared.isPresented(in: panel)
            ? ShareComposerController.shared.canvasSize : view.boxSize
        let mainFrame = anchoredFrame(for: caret, size: size)
        guard panel.frame != mainFrame else { return }
        panel.setFrame(mainFrame, display: true)
    }

    /// The display showing most of the caret. A caret on the last line of a
    /// display can end just past its edge, which must not send the box to the
    /// primary display.
    private func screen(showing caret: NSRect) -> NSScreen? {
        func area(_ rect: NSRect) -> CGFloat { rect.isNull ? 0 : rect.width * rect.height }
        func overlap(_ screen: NSScreen) -> CGFloat { area(screen.frame.intersection(caret)) }
        if let best = NSScreen.screens.max(by: { overlap($0) < overlap($1) }), overlap(best) > 0 { return best }
        let center = NSPoint(x: caret.midX, y: caret.midY)
        func distance(_ screen: NSScreen) -> CGFloat {
            hypot(screen.frame.midX - center.x, screen.frame.midY - center.y)
        }
        return NSScreen.screens.min(by: { distance($0) < distance($1) })
    }

    /// Accessibility reports rectangles with the origin at the top-left of the
    /// primary display; AppKit windows use a bottom-left origin. The card goes
    /// where it covers the least of the text in the host's window, outside the
    /// window when there is room (see CaretCardPlacement).
    private func anchoredFrame(for caret: CGRect?, size: NSSize) -> NSRect {
        guard let caret else {
            let mouse = NSEvent.mouseLocation
            let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main
            var x = mouse.x - CaretCardPlacement.preferredPointerX
            var y = mouse.y - size.height - 4
            if let visible = screen?.visibleFrame {
                x = min(max(visible.minX, x), visible.maxX - size.width)
                y = min(max(visible.minY, y), visible.maxY - size.height)
            }
            view.pointerAtTop = true
            view.pointerX = min(max(mouse.x - x, CaretCardPlacement.pointerInset),
                                size.width - CaretCardPlacement.pointerInset)
            view.superview?.layoutSubtreeIfNeeded()
            return NSRect(x: x, y: y, width: size.width, height: size.height)
        }

        let primary = NSScreen.screens.first(where: { $0.frame.origin == .zero })
            ?? NSScreen.screens.first
        let flipped = HostGeometryConverter.toAppKit(caret, primaryHeight: primary?.frame.maxY ?? 0)
        let caretOnScreen = NSRect(x: flipped.minX, y: flipped.minY,
                                   width: max(1, flipped.width), height: max(1, flipped.height))
        let screen = self.screen(showing: caretOnScreen) ?? primary ?? NSScreen.main
        let surroundings = popupSurroundings?.caret == caret ? popupSurroundings : nil
        let appKit = { (rect: CGRect?) in rect.map { HostGeometryConverter.toAppKit($0, primaryHeight: primary?.frame.maxY ?? 0) } }
        let placement = CaretCardPlacement.clear(of: appKit(surroundings?.window), text: appKit(surroundings?.text),
                                                 caret: flipped, size: size, visible: screen?.visibleFrame)

        view.pointerAtTop = placement.pointerAtTop
        view.pointerX = placement.pointerX
        view.superview?.layoutSubtreeIfNeeded()
        return placement.frame
    }

    func existingPanel() -> NSPanel {
        if let panel { return panel }
        let size = view.boxSize
        let created = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        created.level = .popUpMenu
        created.isOpaque = false
        created.hasShadow = true
        created.backgroundColor = .clear
        created.ignoresMouseEvents = false
        // Only hide() takes the card down. AppKit hiding it when Lasso stops
        // being active left Tab still routed to a card no one could see.
        created.hidesOnDeactivate = false
        created.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        view.frame = NSRect(origin: .zero, size: size)
        // The selected row decides whether fn+Right has a row to move into.
        view.onSelectRow = { [weak self] index in self?.selectRow(index); self?.publishKeyRouting() }
        view.onInsert = { [weak self] in self?.activateSelection() }
        view.onLocalLink = { [weak self] in self?.acceptPlain() }
        view.onShare = { [weak self] in self?.acceptShared() }
        view.onOpenSource = { [weak self] in self?.openCurrentSource() }
        view.onAllSources = { [weak self] in self?.chooseSource(allDocuments: true) }
        view.onStepBack = { [weak self] in self?.stepBack(); self?.publishKeyRouting() }
        view.onDismiss = { [weak self] in self?.hide() }
        created.contentView = AssistBubbleContainer(content: view)
        panel = created
        return created
    }

    // MARK: Feedback

    /// Brief, non-modal confirmation drawn in the same terminal box, once the
    /// editor's caret has been measured. Supersedes any pending suggestion.
    func flash(_ lines: [String], seconds: TimeInterval = 2.2) {
        guard !feedbackDismissed else { return }
        guard let context else { hide(); return }
        generation += 1
        measureHost(for: context) { [weak self] in self?.showMessage(lines, seconds: seconds) }
    }

    private func showMessage(_ lines: [String], seconds: TimeInterval) {
        guard !feedbackDismissed else { return }
        let panel = existingPanel()
        view.mode = .message
        messageShownAt = Date()
        view.title = "lasso"
        view.messageLines = lines
        refreshPanelGeometry()
        panel.orderFrontRegardless()
        flashTimer?.invalidate()
        flashTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.hide()
        }
        publishKeyRouting()
    }

    /// Only the panel is sized; the card follows it. Sizing the card as well
    /// applied every change twice: a message was left blank and the next
    /// suggestions came back shifted up and stretched past the panel's edge.
    func refreshPanelGeometry() {
        let panel = existingPanel()
        view.needsDisplay = true
        let mainFrame = anchoredFrame(for: popupCaret ?? context?.caretRect, size: view.boxSize)
        panel.setFrame(mainFrame, display: true)
    }
}
