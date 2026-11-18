//  Keeps local dependency highlights attached to the right words.
//
//  Relevant input and Accessibility events refresh the focused surface, with
//  a slow fallback for hosts that omit change notifications. The host is read
//  on the Accessibility queue; the store and overlay change on the main
//  thread. Unchanged anchor matches, measured geometry and overlay frames are
//  reused. Uncertain references are marked unresolved and simply not drawn;
//  nothing is ever highlighted on a guess.

import Cocoa
import ApplicationServices

final class DependencyHighlighter {
    static let shared = DependencyHighlighter()

    var serverURL: URL? {
        didSet {
            if serverURL != nil { migrateStoredSourcePaths() }
        }
    }
    var onInspect: ((DependencyReference, CGRect) -> Void)?

    private let reader = HighlightReader()
    private let store: DependencyReferenceStore
    private let view = OverlayView()
    private lazy var panel = OverlayPanel(view: view)
    private var currentContext: HostContext?
    private var geometries: [DependencyGeometry] = []
    private var scheduled = false
    private var monitors: [Any] = []
    private var settleTimer: Timer?
    private var isStarted = false
    private var systemSleeping = false
    private var displaySleeping = false
    private var lastRefresh = Date.distantPast
    /// Text goes missing briefly during an undo or a re-render, and a second
    /// editor in the same window shares this document's identity. A reference
    /// is deleted only when its text stays missing from the editor where it
    /// last resolved.
    private var lastResolvedElement: [String: AXUIElement] = [:]
    private var missingSince: [String: Date] = [:]
    private static let deletionGrace: TimeInterval = 2
    private var reads = CoalescingGate()
    /// Changes whenever the overlay is hidden, so a read that began before
    /// then is not drawn afterwards.
    private var readGeneration = 0
    /// The reader holds an observer and document text that should be let go
    /// once no relevant host is in front.
    private var readerHoldsHost = false
    private var migratingObjectIds = Set<String>()
    /// The phrases last drawn, and which of them are hidden while the text
    /// under them may be moving.
    private var shownChips: [OverlayChip] = []
    private var shownQuiet = Set<String>()
    private var quieted = Set<String>()
    private var quietUntil = Date.distantPast
    private var settleWork: DispatchWorkItem?
    /// Where the host's caret was at the last read, in AppKit coordinates.
    private var lastCaret: CGRect?
    /// How long phrases stay hidden after the last keystroke or scroll that may move them.
    private static let quietTime: TimeInterval = 0.35

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lasso", isDirectory: true)
        store = DependencyReferenceStore(url: support.appendingPathComponent("references.json"))
    }

    // MARK: Lifecycle

    func start() {
        guard !isStarted else { return }
        isStarted = true
        let centre = NSWorkspace.shared.notificationCenter
        monitors.append(centre.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                self?.scheduleRefresh()
            })
        monitors.append(centre.addObserver(
            forName: NSWorkspace.didDeactivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                self?.hide()
            })
        monitors.append(NotificationCenter.default.addObserver(
            forName: .directoryColorsDidChange, object: nil, queue: .main) { [weak self] _ in
                self?.scheduleRefresh()
            })

        // Hover and click handling for dependency regions only. Global monitors
        // observe without consuming, so the host application keeps every event.
        let hover = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] _ in
            self?.handleHover(NSEvent.mouseLocation)
        })
        if let hover { monitors.append(hover) }
        let click = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown], handler: { [weak self] _ in
            self?.handleClick(NSEvent.mouseLocation)
        })
        if let click { monitors.append(click) }
        if let changes = NSEvent.addGlobalMonitorForEvents(
            matching: [.keyDown, .scrollWheel, .leftMouseDown, .leftMouseDragged, .leftMouseUp],
            handler: { [weak self] _ in self?.scheduleRefresh() }) { monitors.append(changes) }
        if let moving = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .scrollWheel], handler: { [weak self] event in
            self?.quietMovingText(event)
        }) { monitors.append(moving) }

        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification] {
            monitors.append(centre.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                if name == NSWorkspace.willSleepNotification { self?.systemSleeping = true }
                else { self?.displaySleeping = true }
                self?.updatePolling()
                self?.hide()
            })
        }
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
            monitors.append(centre.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                if name == NSWorkspace.didWakeNotification { self?.systemSleeping = false }
                else { self?.displaySleeping = false }
                self?.scheduleRefresh()
            })
        }
        scheduleRefresh()
    }

    private var hasRelevantHost: Bool {
        guard !systemSleeping, !displaySleeping,
              let front = NSWorkspace.shared.frontmostApplication,
              AccessibilityWork.mayRead(pid: front.processIdentifier),
              let bundle = front.bundleIdentifier else { return false }
        return store.hasReferences(bundleIdentifier: bundle)
    }

    private func updatePolling() {
        guard hasRelevantHost else {
            settleTimer?.invalidate()
            settleTimer = nil
            releaseReader()
            return
        }
        guard settleTimer == nil else { return }
        // Hosts do not consistently notify programmatic scroll/layout changes.
        // Preserve that fallback, but never poll apps with no saved references.
        let timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.scheduleRefresh()
        }
        timer.tolerance = 0.4
        settleTimer = timer
    }

    private func releaseReader() {
        guard readerHoldsHost else { return }
        readerHoldsHost = false
        AccessibilityWork.queue.async { [reader] in reader.release() }
    }

    /// Stage B. Records a reference from an already-verified range: the caller
    /// has proved these characters are the accepted phrase, so no searching or
    /// guessing happens here.
    /// `element` is the editor the insertion was verified in. The reference is
    /// stored only if that editor still has focus when the host is read.
    /// Returns the reference's id, so taking the insertion back can unlink it.
    /// `alternatives` are the sources the card offered at that moment, which
    /// Change Source offers again.
    @discardableResult
    func recordVerifiedInsertion(objectId: String, versionId: String?, snapshotId: String? = nil,
                                 projectId: String? = nil, label: String,
                                 valueText: String?, sourcePath: String, sourceLocation: String,
                                 document: [UInt16], range: Range<Int>, documentOffset: Int = 0,
                                 element: AXUIElement, videoTime: Double? = nil,
                                 shareToken: String? = nil, alternatives: [ReferenceAlternative]? = nil) -> String? {
        guard let anchor = TextAnchor.make(in: document, range: range,
                                           documentOffset: documentOffset) else { return nil }
        let id = "ref_" + UUID().uuidString.prefix(8)
        AccessibilityWork.queue.async { [reader] in
            let context = reader.focusedContext()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard let context, CFEqual(context.element, element) else { return }
                self.storeVerifiedInsertion(
                    id: id, objectId: objectId, versionId: versionId, snapshotId: snapshotId,
                    projectId: projectId, label: label,
                    valueText: valueText, sourcePath: sourcePath, sourceLocation: sourceLocation,
                    anchor: anchor, context: context, videoTime: videoTime, shareToken: shareToken,
                    alternatives: alternatives)
            }
        }
        return id
    }

    private func storeVerifiedInsertion(id: String, objectId: String, versionId: String?, snapshotId: String?,
                                        projectId: String?, label: String,
                                        valueText: String?, sourcePath: String, sourceLocation: String,
                                        anchor: TextAnchor, context: HostContext, videoTime: Double? = nil,
                                        shareToken: String? = nil, alternatives: [ReferenceAlternative]? = nil) {
        let colorSlot = sourceColorSlot(path: sourcePath, objectId: objectId,
                                       projectId: projectId, in: context)
        let reference = DependencyReference(
            id: id,
            objectId: objectId, versionId: versionId, snapshotId: snapshotId, projectId: projectId,
            hostBundleIdentifier: context.bundleIdentifier,
            hostApplication: context.applicationName,
            documentContext: context.documentContext,
            anchor: anchor, state: .healthy,
            label: label, valueText: valueText,
            sourcePath: sourcePath, sourceLocation: sourceLocation,
            sourceColorSlot: colorSlot, videoTime: videoTime, shareToken: shareToken,
            alternatives: alternatives, createdAt: Date(), updatedAt: Date())
        store.add(reference)
        scheduleRefresh()
    }

    func unlink(id: String) {
        store.remove(id: id)
        lastResolvedElement[id] = nil
        missingSince[id] = nil
        scheduleRefresh()
    }

    func reference(id: String) -> DependencyReference? { store.reference(id: id) }

    /// Older builds did not store a work-directory owner and sometimes stored
    /// a human breadcrumb in sourcePath. Resolve ownership through the object
    /// API so files with identical relative paths cannot borrow another
    /// directory's color. Known owners already carry the canonical file path.
    private func migrateStoredSourcePaths() {
        guard let serverURL else { return }
        let legacyObjectIds = Set(store.references.filter {
            $0.projectId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
        }.map(\.objectId))
        for objectId in legacyObjectIds {
            guard migratingObjectIds.insert(objectId).inserted else { continue }
            let url = serverURL
                .appendingPathComponent("api/dependency-objects")
                .appendingPathComponent(objectId)
            URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
                let root = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                let object = root?["object"] as? [String: Any]
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.migratingObjectIds.remove(objectId)
                    guard self.serverURL == serverURL,
                          (response as? HTTPURLResponse)?.statusCode == 200,
                          let object,
                          let projectId = object["projectId"] as? String,
                          !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    let path = (object["path"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    let references = self.store.references.filter {
                        $0.objectId == objectId
                            && $0.projectId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
                    }
                    self.store.batchUpdates {
                        for reference in references {
                            self.store.update(id: reference.id) {
                                $0.projectId = projectId
                                if let path, !path.isEmpty, $0.sourcePath != path {
                                    $0.sourcePath = path
                                    $0.sourceColorSlot = nil
                                }
                            }
                            self.normalizeSourceColorSlots(
                                documentContext: reference.documentContext,
                                bundleIdentifier: reference.hostBundleIdentifier)
                        }
                    }
                    self.scheduleRefresh()
                }
            }.resume()
        }
    }


    private func sourceKey(path: String, objectId: String, projectId: String?) -> String {
        let fileKey = AssistSourceIdentity.key(path: path, objectId: objectId)
        guard let projectId, !projectId.isEmpty else { return fileKey }
        return "project:\(projectId)|\(fileKey)"
    }

    /// FNV-1a is deterministic across launches; Swift's Hashable seed is not.
    private func stableSourceColorSlot(_ key: String) -> Int {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in key.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return Int(hash % UInt64(DependencyStyle.sourceColorCount))
    }

    private func sourceColorSlot(path: String, objectId: String, projectId: String?, in context: HostContext) -> Int {
        let key = sourceKey(path: path, objectId: objectId, projectId: projectId)
        let existing = store.references(forContext: context.documentContext,
                                        bundleIdentifier: context.bundleIdentifier)
        if let sameSource = existing.first(where: {
            sourceKey(path: $0.sourcePath, objectId: $0.objectId, projectId: $0.projectId) == key
        }) {
            return sameSource.sourceColorSlot ?? stableSourceColorSlot(key)
        }
        let occupied = Set(existing.map {
            $0.sourceColorSlot ?? stableSourceColorSlot(
                sourceKey(path: $0.sourcePath, objectId: $0.objectId, projectId: $0.projectId))
        })
        return (0..<DependencyStyle.sourceColorCount).first(where: { !occupied.contains($0) })
            ?? stableSourceColorSlot(key)
    }

    private func normalizeSourceColorSlots(documentContext: String, bundleIdentifier: String) {
        let references = store.references(forContext: documentContext,
                                          bundleIdentifier: bundleIdentifier)
        let keyed = references.map {
            (key: sourceKey(path: $0.sourcePath, objectId: $0.objectId, projectId: $0.projectId),
             preferred: $0.sourceColorSlot)
        }
        let assignments = AssistSourceIdentity.colorAssignments(
            keyed, paletteCount: DependencyStyle.sourceColorCount,
            fallback: stableSourceColorSlot)
        for reference in references {
            let key = sourceKey(path: reference.sourcePath, objectId: reference.objectId,
                                projectId: reference.projectId)
            guard let slot = assignments[key], reference.sourceColorSlot != slot else { continue }
            store.update(id: reference.id) { $0.sourceColorSlot = slot }
        }
    }

    private func normalizeSourceColorSlots(in context: HostContext) {
        normalizeSourceColorSlots(documentContext: context.documentContext,
                                  bundleIdentifier: context.bundleIdentifier)
    }

    // MARK: Refresh

    /// An Accessibility notification from the observed host, on the main run loop.
    fileprivate func observedChange() {
        scheduleRefresh()
    }

    private func scheduleRefresh() {
        updatePolling()
        guard hasRelevantHost else { hide(); releaseReader(); return }
        guard !scheduled else { return }
        scheduled = true
        let delay = max(0.04, 0.25 - Date().timeIntervalSince(lastRefresh))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.scheduled = false
            self?.refresh()
        }
    }

    private func refresh() {
        guard hasRelevantHost, AXIsProcessTrusted(),
              let bundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else { hide(); return }
        // One read at a time; requests meanwhile become a single follow-up.
        guard reads.begin() else { return }
        lastRefresh = Date()
        readerHoldsHost = true
        let candidates = store.references.filter { $0.hostBundleIdentifier == bundle }
        let resolvedIn = lastResolvedElement
        let token = readGeneration
        let owner = Unmanaged.passUnretained(self).toOpaque()
        AccessibilityWork.queue.async { [reader] in
            let reading = reader.read(candidates: candidates, resolvedIn: resolvedIn, owner: owner)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let again = self.reads.end()
                if token == self.readGeneration { self.apply(reading) }
                if again { self.scheduleRefresh() }
            }
        }
    }

    private func apply(_ reading: HighlightReader.Reading?) {
        guard hasRelevantHost, let reading else { hide(); return }
        let context = reading.context
        store.batchUpdates { normalizeSourceColorSlots(in: context) }

        // Only this document's references, never another window's.
        let references = store.references(forContext: context.documentContext,
                                          bundleIdentifier: context.bundleIdentifier)
        guard !references.isEmpty, reading.hasDocument else { hide(); return }

        var found: [DependencyGeometry] = []
        var chips: [OverlayChip] = []

        store.batchUpdates {
            for reference in references {
                guard let match = reading.matches[reference.id] else { continue }
                switch match {
                case .unresolved(let reason):
                    // The phrase is gone or cannot be told apart: never draw a guess.
                    if reason == .textMissing {
                        // Another editor that still exists keeps its own copy;
                        // one that was closed no longer holds the text anywhere.
                        if let resolvedIn = lastResolvedElement[reference.id], !CFEqual(resolvedIn, context.element) {
                            if reading.stillOpenElsewhere.contains(reference.id) { continue }
                            lastResolvedElement[reference.id] = nil
                        }
                        let since = missingSince[reference.id] ?? Date()
                        missingSince[reference.id] = since
                        guard Date().timeIntervalSince(since) >= Self.deletionGrace else { continue }
                        store.remove(id: reference.id)   // no ghost highlights
                        lastResolvedElement[reference.id] = nil
                        missingSince[reference.id] = nil
                    } else if reference.state != .unresolved {
                        store.update(id: reference.id) { $0.state = .unresolved }
                    }
                case .resolved:
                    lastResolvedElement[reference.id] = context.element
                    missingSince[reference.id] = nil
                    if reference.state == .unresolved {
                        store.update(id: reference.id) { $0.state = .healthy }
                    }
                    let state = reference.state == .unresolved ? DependencyVisualState.healthy : reference.state
                    let slot = reference.sourceColorSlot
                        ?? stableSourceColorSlot(sourceKey(path: reference.sourcePath, objectId: reference.objectId,
                                                           projectId: reference.projectId))
                    let directoryColor = DirectoryColorPreferences.color(for: reference.projectId)
                    guard let rects = reading.rects[reference.id], !rects.isEmpty else { continue }
                    let converted = rects.map {
                        HostGeometryConverter.toAppKit($0, primaryHeight: Self.primaryHeight())
                    }
                    let geometry = DependencyGeometry.coalesce(converted, referenceId: reference.id)
                    guard !geometry.fragments.isEmpty else { continue }
                    found.append(geometry)
                    chips.append(Self.chip(for: reference, geometry: geometry, state: state, slot: slot,
                                           directoryColor: directoryColor, style: reading.styles[reference.id],
                                           room: reading.room[reference.id]))
                }
            }
        }

        updatePolling()
        lastCaret = reading.caret.map { HostGeometryConverter.toAppKit($0, primaryHeight: Self.primaryHeight()) }
        guard !found.isEmpty else { hide(); return }
        let quiet = currentQuiet()
        let unchanged = currentContext == context && geometries == found && shownChips == chips
            && shownQuiet == quiet && panel.isVisible
        currentContext = context
        guard !unchanged else { return }
        geometries = found
        shownChips = chips
        shownQuiet = quiet
        view.show(chips, quiet: quiet)
        reframe()
        panel.orderFrontRegardless()
    }

    /// The panel covers what is drawn and what is still moving, with room for
    /// each icon and the pills' edges.
    private func reframe() {
        let union = view.paintedBounds ?? geometries.dropFirst().reduce(geometries.first?.bounds ?? .zero) { $0.union($1.bounds) }
        let frame = union.insetBy(dx: -10, dy: -10).integral
        if panel.frame != frame { panel.setFrame(frame, display: false) }
        view.panelFrame = panel.frame
        view.frame = NSRect(origin: .zero, size: panel.frame.size)
        view.needsDisplay = true
    }

    private func hide() {
        readGeneration += 1
        guard !geometries.isEmpty || panel.isVisible else { return }
        geometries = []
        shownChips = []
        shownQuiet = []
        view.show([])
        view.hoveredId = nil
        panel.orderOut(nil)
    }

    /// One phrase as the overlay draws it: its words in the host's font where
    /// they can be matched, its pill in the colours of the page under it.
    private static func chip(for reference: DependencyReference, geometry: DependencyGeometry,
                             state: DependencyVisualState, slot: Int, directoryColor: DirectoryToggleColor?,
                             style: HostTextStyle?, room: HighlightReader.Room?) -> OverlayChip {
        let tint = DependencyStyle.stroke(for: state, sourceSlot: slot, directoryColor: directoryColor, hovered: true)
        let dark = ReferenceChipPalette.isDark(style)
        // Lines in reading order, top first.
        let fragments = geometry.fragments.sorted {
            abs($0.midY - $1.midY) > 1 ? $0.midY > $1.midY : $0.minX < $1.minX
        }
        let lines = ReferenceChipLayout.lines(text: reference.anchor.text, fragments: fragments, style: style)
        return OverlayChip(
            id: reference.id, text: reference.anchor.text, fragments: fragments, lines: lines,
            state: state, tint: tint, page: ReferenceChipPalette.page(style, dark: dark),
            ink: ReferenceChipPalette.ink(style, dark: dark), words: ReferenceChipPalette.words(tint: tint, dark: dark),
            sourcePath: reference.sourcePath, roomBefore: room?.before ?? false, roomAfter: room?.after ?? false,
            badgeSide: ChipBadgeSide.choose(lines: lines), isNew: Date().timeIntervalSince(reference.createdAt) < 3)
    }

    // MARK: Text on the move

    /// Hides the phrases a keystroke or scroll may move before the host has
    /// drawn them anew, so a pill never sits over the wrong letters. Typing
    /// moves only what comes after the caret; a scroll moves everything.
    private func quietMovingText(_ event: NSEvent) {
        guard panel.isVisible, !geometries.isEmpty else { return }
        let ids: Set<String>
        if event.type == .scrollWheel {
            guard event.scrollingDeltaY != 0 || event.scrollingDeltaX != 0 else { return }
            ids = Set(geometries.map(\.referenceId))
        } else {
            guard Self.mayEditText(event) else { return }
            ids = Set(geometries.filter { $0.mayMove(typingAt: lastCaret) }.map(\.referenceId))
        }
        guard !ids.isEmpty else { return }
        quieted.formUnion(ids)
        quietUntil = Date().addingTimeInterval(Self.quietTime)
        view.quiet(ids)
        scheduleSettle()
    }

    /// Keys that only move the caret or close something leave the text where it is.
    static func mayEditText(_ event: NSEvent) -> Bool {
        let navigation: Set<UInt16> = [53, 115, 116, 119, 121, 123, 124, 125, 126]
        guard !navigation.contains(event.keyCode) else { return false }
        guard event.modifierFlags.contains(.command) else { return true }
        // Paste, cut and undo change text; other shortcuts do not.
        return ["v", "x", "z"].contains(event.charactersIgnoringModifiers?.lowercased() ?? "")
    }

    private func currentQuiet() -> Set<String> {
        guard Date() < quietUntil else {
            quieted = []
            return []
        }
        scheduleSettle()
        return quieted
    }

    /// One more read once the text has stopped moving, to bring the phrases back.
    private func scheduleSettle() {
        settleWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.scheduleRefresh() }
        settleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.02, quietUntil.timeIntervalSinceNow + 0.02), execute: work)
    }

    private static func primaryHeight() -> CGFloat {
        HostGeometryConverter.primaryHeight(NSScreen.screens.map { $0.frame })
    }

    // MARK: Interaction

    private func handleHover(_ point: NSPoint) {
        guard panel.isVisible else { return }
        let hovered = geometries.first { $0.contains(point) }?.referenceId
        guard hovered != view.hoveredId else { return }
        view.hoveredId = hovered
    }

    /// A click on a phrase opens its menu under the line clicked; a click on
    /// the same phrase again, or anywhere else, closes it.
    private func handleClick(_ point: NSPoint) {
        let menu = ReferenceMenuController.shared
        let hit = panel.isVisible ? geometries.first(where: { $0.contains(point) }) : nil
        if menu.isShown {
            let same = hit?.referenceId == menu.referenceId
            menu.hide()
            if same || hit == nil { return }
        }
        guard let hit, let reference = store.reference(id: hit.referenceId) else { return }
        let line = hit.fragments.first { $0.insetBy(dx: -1, dy: -2).contains(point) } ?? hit.bounds
        let id = reference.id
        view.activeId = id
        // Words already accepted are not asked about again: the card makes way
        // for the menu and stays away while it is open.
        GlobalAssistant.shared.dismiss()
        menu.show(reference, below: line, onInspect: { [weak self] in
            guard let self, let current = self.store.reference(id: id) else { return }
            self.onInspect?(current, self.geometries.first { $0.referenceId == id }?.bounds ?? hit.bounds)
        }, onChoose: { [weak self] alternative in
            self?.changeSource(of: id, to: alternative)
        }, onClose: { [weak self] in
            if self?.view.activeId == id { self?.view.activeId = nil }
        })
    }

    // MARK: Change Source

    /// Writes the chosen source's words over the phrase in the host, then moves
    /// the link to that source. The words roll over as soon as it is chosen.
    func changeSource(of id: String, to alternative: ReferenceAlternative) {
        guard let reference = store.reference(id: id), let element = lastResolvedElement[id] else {
            GlobalAssistant.shared.flash(["The words couldn\u{2019}t be found here.", "Nothing was changed."])
            return
        }
        let current = reference.currentAlternativeIndex.flatMap { reference.alternatives?[$0] }
        view.beginChange(id)
        GlobalAssistant.shared.markOwnWrite()
        let anchor = reference.anchor
        AccessibilityWork.queue.async {
            ReferenceSwap.write(anchor, in: element, words: { shown, before in
                ReferenceSwap.words(for: alternative, current: current, shown: shown, before: before)
            }) { written in
                DispatchQueue.main.async { [weak self] in self?.finishChange(id, to: alternative, written: written) }
            }
        }
    }

    private func finishChange(_ id: String, to alternative: ReferenceAlternative, written: ReferenceSwap.Written?) {
        GlobalAssistant.shared.markOwnWrite()
        guard let written, let anchor = TextAnchor.make(in: written.document, range: written.range) else {
            view.cancelChange(id)
            GlobalAssistant.shared.flash(["Lasso couldn\u{2019}t change the words here.", "Their source stays as it was."])
            return
        }
        // ⌘Z now belongs to the host: the insertion it would take back is gone.
        if GlobalAssistant.shared.undoableInsertion?.referenceId == id { GlobalAssistant.shared.undoableInsertion = nil }
        store.update(id: id) {
            $0.anchor = anchor
            $0.objectId = alternative.objectId
            $0.versionId = alternative.versionId
            $0.snapshotId = alternative.snapshotId
            $0.projectId = alternative.projectId
            $0.label = alternative.label
            $0.valueText = alternative.detail
            $0.sourcePath = alternative.path
            $0.sourceLocation = alternative.location
            $0.videoTime = alternative.videoTime
            $0.state = .healthy
            $0.sourceColorSlot = nil
        }
        missingSince[id] = nil
        if let serverURL {
            RecommendationUsageClient.record(serverURL: serverURL, projectId: alternative.projectId,
                                             objectId: alternative.usageObjectId ?? alternative.objectId,
                                             path: alternative.path, kind: "accept")
        }
        // Draw the new words as soon as the host has them.
        lastRefresh = .distantPast
        scheduleRefresh()
    }
}

/// The Accessibility side of highlighting: reading the focused editor, its
/// text and the geometry of each reference, and watching it for changes.
/// Used only on `AccessibilityWork.queue`.
final class HighlightReader {
    struct Reading {
        let context: HostContext
        /// False when the editor has no references here or exposes no text.
        let hasDocument: Bool
        let matches: [String: AnchorResolution]
        /// Accessibility coordinates, for resolved references that measured.
        let rects: [String: [CGRect]]
        /// References missing here whose last editor still exists elsewhere.
        let stillOpenElsewhere: Set<String>
        /// The font and colours each resolved phrase is drawn in, where the host says.
        var styles: [String: HostTextStyle] = [:]
        /// Whitespace either side of each resolved phrase.
        var room: [String: Room] = [:]
        /// The caret, in Accessibility coordinates.
        var caret: CGRect? = nil
    }

    /// Whether the characters either side of a phrase are whitespace or the
    /// text's ends, which its pill may reach into.
    struct Room: Equatable {
        let before: Bool
        let after: Bool

        static func around(_ range: Range<Int>, in document: [UInt16]) -> Room {
            func open(_ index: Int) -> Bool {
                guard document.indices.contains(index) else { return true }
                return [9, 10, 13, 32, 160, 0x2028, 0x2029].contains(document[index])
            }
            return Room(before: open(range.lowerBound - 1), after: open(range.upperBound))
        }
    }

    private let adapter = AccessibilityTextAdapter()
    private let resolutions = TextAnchorResolutionCache()
    private var geometry = HighlightGeometryCache()
    private var observer: AXObserver?
    private var observedPID: pid_t?
    private var observedElements: [AXUIElement] = []
    /// Each phrase's font, read once per phrase and editor.
    private var styles: [String: (text: String, style: HostTextStyle?)] = [:]
    private var stylesElement: AXUIElement?

    func focusedContext() -> HostContext? {
        adapter.beginRefresh()
        return adapter.focusedContext()
    }

    func read(candidates: [DependencyReference], resolvedIn: [String: AXUIElement],
              owner: UnsafeMutableRawPointer) -> Reading? {
        guard let context = focusedContext() else { return nil }
        observe(context, owner: owner)
        let references = candidates.filter { $0.documentContext == context.documentContext }
        guard !references.isEmpty, let document = adapter.documentText(context) else {
            return Reading(context: context, hasDocument: false, matches: [:], rects: [:], stillOpenElsewhere: [])
        }
        let matches = resolutions.resolve(references, in: document)
        let snapshot = adapter.geometrySnapshot(context, text: document)
        let units = Array(document.utf16)
        if stylesElement.map({ !CFEqual($0, context.element) }) ?? true {
            styles = [:]
            stylesElement = context.element
        }
        var rects: [String: [CGRect]] = [:]
        var stillOpenElsewhere = Set<String>()
        var textStyles: [String: HostTextStyle] = [:]
        var room: [String: Room] = [:]
        for reference in references {
            switch matches[reference.id] {
            case .resolved(let range)?:
                rects[reference.id] = geometry.rects(for: range, in: snapshot) { [adapter] range in
                    adapter.measuredRects(for: range, in: context)
                }
                if let known = styles[reference.id], known.text == reference.anchor.text {
                    textStyles[reference.id] = known.style
                } else {
                    let style = adapter.textStyle(for: range, in: context)
                    styles[reference.id] = (reference.anchor.text, style)
                    textStyles[reference.id] = style
                }
                room[reference.id] = Room.around(range, in: units)
            case .unresolved(.textMissing)?:
                if let other = resolvedIn[reference.id], !CFEqual(other, context.element), Self.exists(other) {
                    stillOpenElsewhere.insert(reference.id)
                }
            default:
                break
            }
        }
        return Reading(context: context, hasDocument: true, matches: matches, rects: rects,
                       stillOpenElsewhere: stillOpenElsewhere, styles: textStyles, room: room, caret: snapshot.caret)
    }

    /// Stops watching the host and lets go of its text and geometry.
    func release() {
        detachObserver()
        resolutions.clear()
        geometry.clear()
        styles = [:]
        stylesElement = nil
    }

    private static func exists(_ element: AXUIElement) -> Bool {
        var role: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success
    }

    private func detachObserver() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        observedPID = nil
        observedElements = []
    }

    /// Notifications are delivered on the main run loop, to `owner`.
    private func observe(_ context: HostContext, owner: UnsafeMutableRawPointer) {
        var pid: pid_t = 0
        guard AXUIElementGetPid(context.element, &pid) == .success else { return }
        if observedPID != pid {
            detachObserver()
            var created: AXObserver?
            guard AXObserverCreate(pid, { _, _, _, refcon in
                guard let refcon else { return }
                Unmanaged<DependencyHighlighter>.fromOpaque(refcon).takeUnretainedValue().observedChange()
            }, &created) == .success, let created else { return }
            observer = created
            observedPID = pid
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        }
        guard let observer else { return }
        if observedElements.contains(where: { CFEqual($0, context.element) }) { return }
        let notifications = [kAXValueChangedNotification, kAXSelectedTextChangedNotification,
                             kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification,
                             kAXMovedNotification, kAXResizedNotification, "AXLayoutChanged"]
        for element in observedElements {
            for name in notifications { AXObserverRemoveNotification(observer, element, name as CFString) }
        }
        let application = AXUIElementCreateApplication(pid)
        var window: CFTypeRef?
        AXUIElementCopyAttributeValue(context.element, kAXWindowAttribute as CFString, &window)
        observedElements = [application, context.element]
        if let window, CFGetTypeID(window) == AXUIElementGetTypeID() { observedElements.append(window as! AXUIElement) }
        for element in observedElements {
            for name in notifications {
                AXObserverAddNotification(observer, element, name as CFString, owner)
            }
        }
    }
}
