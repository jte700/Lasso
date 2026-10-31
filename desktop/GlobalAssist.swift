//  System-wide predictive provenance.
//
//  Watches typing in any application, reads the text around the caret through
//  the Accessibility API, asks the local Lasso server for source-backed
//  suggestions, and draws a native source suggestion panel next to the caret.
//  Tab inserts the suggestion into whatever app is focused.
//
//  Requires Accessibility and Input Monitoring permission. Nothing is captured
//  or stored: the focused text window is sent only to 127.0.0.1 and discarded.
//  Accepted source identities and deliberate opens are recorded locally for ranking.
//
//  GlobalAssistant is split by concern. This file holds its state, lifecycle
//  and key handling; the extensions beside it ask the server and read its
//  answer (+Prediction), load the selected row's preview and open its source
//  (+Preview), position and show the panel and its messages (+Panel), insert
//  or share what Tab accepted (+Insertion), and check it all (+Regressions).

import Cocoa
import ApplicationServices

final class GlobalAssistant {
    static let shared = GlobalAssistant()

    private init() {
        LassoTransientUI.shared.register(self, priority: 70,
            // Only a box on screen counts. A pending prediction, or a host being
            // tracked for one, is not open: claiming it would swallow Escape in
            // vim, dialogs and search fields.
            isOpen: { [weak self] in self?.panel?.isVisible == true },
            dismiss: { [weak self] in self?.dismissForEscape() })
        LassoTransientUI.shared.start()
    }

    var serverURL: URL?
    var projectIds: [String] = []
    var workspaceRevision = ""
    var isEnabled = false

    /// The menu and retrieval share the server's persisted active directory set.
    func updateWorkspace(projectIds: [String], revision: String) {
        let updated = Array(Set(projectIds)).sorted()
        guard updated != self.projectIds || revision != workspaceRevision else { return }
        hide()
        self.projectIds = updated
        workspaceRevision = revision
        linkedSources.keep(projectIds: updated)
        if isEnabled, !updated.isEmpty { scheduleRefresh() }
    }

    /// Pause retrieval immediately while the directory selection is changing.
    func suspendWorkspace() {
        hide()
        projectIds = []
    }

    private var keyTap: KeyEventTap?
    /// Publishes the routing snapshot whenever the main thread goes idle.
    private var routingObserver: CFRunLoopObserver?
    private var terminationObserver: NSObjectProtocol?
    var panel: NSPanel?
    var view = AssistBoxView()
    var debounce: Timer?
    var request: URLSessionDataTask?
    var previewRequest: URLSessionDataTask?
    var previewGeneration = 0
    var previewKey: String?
    var previewCache: [String: AssistDocumentPreview] = [:]
    var previewCacheOrder: [String] = []
    /// Bytes of whole PDFs the cache keeps, newest first, so a PDF seen again
    /// still scrolls. Older ones keep only their page image and load again.
    static let cachedPDFBudget = 64 * 1024 * 1024
    var context: CaretContext?
    var generation = 0
    var feedbackDismissed = false
    private var sawEvent = false
    /// The tap exists but no key has arrived for a while. With Input
    /// Monitoring also missing, that means macOS is withholding keystrokes.
    private(set) var isAwaitingInput = false
    var isInserting = false {
        didSet { publishKeyRouting() }
    }
    var pendingShare: AssistSuggestion?
    /// Lasso's last verified insertion, while ⌘Z can still take it back.
    var undoableInsertion: AcceptedInsertion? {
        didSet { publishKeyRouting() }
    }
    /// Sources linked in the current surface. Reported to the server so it
    /// can offer their values instead of matching the same phrase.
    var linkedSources = LinkedSourceMemory()
    /// The source the card on screen is focused on, as the server reported it.
    var focusedSource: LinkedSourceMemory.Source?
    /// The row the list a focus move asked for opens on.
    var focusLanding: FocusLanding?
    var linkedContext: String?
    var linkedElement: AXUIElement?
    var flashTimer: Timer?
    static let minimumTypedCharacters = 2
    static let minimumMessageTime: TimeInterval = 0.8
    /// The tap sees a key before the editor does. This is long enough for
    /// most editors to take it before the text is read; a read that is still
    /// early is caught when the answer arrives, and read again.
    static let typingSettleTime: TimeInterval = 0.04
    /// How many times one keystroke's suggestions are asked for again because
    /// the editor's text moved on while they were found.
    static let maximumRereads = 2
    private static let restoreWait: TimeInterval = 1
    var messageShownAt = Date.distantPast
    var lastTrack = Date.distantPast
    var popupHost: AssistPopupHost?
    var popupCaret: CGRect?
    /// The host's window and the text showing in its editor, measured with `popupCaret`.
    var popupSurroundings: HostSurroundings?
    /// The caret the text in `popupSurroundings` was measured at.
    var textMeasuredAt: CGRect?
    /// Changes whenever the tracked editor changes or tracking stops, so a
    /// caret read for an earlier editor is never applied.
    var hostGeneration = 0
    var hostTimer: Timer?
    var hostObservers: [NSObjectProtocol] = []
    var contextReads = CoalescingGate()
    var rereadsLeft = 0
    var hostReads = CoalescingGate()
    /// The generation a box or message is being measured for, until it shows.
    var measuringFor: Int?
    #if BROWSER_GEOMETRY_TEST
    var regressionPrediction = false
    var regressionAccepted: [String: Any]?
    #endif

    var onStateChange: (() -> Void)?
    var onWorkspaceChange: (() -> Void)?
    /// The source inspector, whose Share Link takes Tab while it is open.
    weak var inspector: SourceInspectorPanel?

    // MARK: Lifecycle

    /// Which permission is missing, and whether macOS is holding a stale grant
    /// from an earlier build of the app.
    struct PermissionProblem {
        let service: String          // "Accessibility" or "Input Monitoring"
        let settingsAnchor: String
        let stale: Bool
    }

    private(set) var lastProblem: PermissionProblem?

    @discardableResult
    func enable(requestPermissions: Bool = true) -> String? {
        guard !isEnabled else { return nil }
        let accessibility = AssistPermission.hasAccessibility
        let input = AssistPermission.hasInputMonitoring

        if !accessibility {
            lastProblem = PermissionProblem(service: "Accessibility",
                                            settingsAnchor: "Privacy_Accessibility",
                                            stale: AssistPermission.isListedButUntrusted)
            if requestPermissions { AssistPermission.requestAccessibility() }
            return lastProblem!.stale
                ? "macOS is not granting Lasso Accessibility access. Approval for an earlier build may no longer apply.\n\nAfter installing the current app, open Privacy & Security → Accessibility, remove the old Lasso entry with “−”, then add the current app with “+” and authorize it."
                : "Turn on Lasso under Privacy & Security → Accessibility, then enable this again."
        }
        // Input Monitoring is not always required: a keyboard tap usually works
        // with Accessibility alone. Ask for it only if the tap actually fails.
        lastProblem = nil

        let created = KeyEventTap(
            perform: { [weak self] action in self?.perform(action) },
            onFirstKey: { [weak self] in self?.firstKeyArrived() })
        guard created.start() else {
            if !input && requestPermissions { AssistPermission.requestInputMonitoring() }
            lastProblem = PermissionProblem(service: "Input Monitoring",
                                            settingsAnchor: "Privacy_ListenEvent",
                                            stale: false)
            return "The keyboard tap could not be created.\n\nTurn on Lasso under Privacy & Security → Input Monitoring. Approval for an earlier ad-hoc build may no longer apply. If needed, remove the old entry with “−” and add the current app with “+”."
        }

        keyTap = created
        observeMainThreadIdle()
        terminationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { note in
                guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                HostAccessibilityMode.shared.forget(pid: app.processIdentifier)
            }
        AssistPermission.rememberTrusted()
        isEnabled = true
        sawEvent = false
        publishKeyRouting()
        // If nothing arrives the tap exists but is not receiving; that is the
        // real signal that Input Monitoring is required.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.isEnabled, !self.sawEvent else { return }
            self.isAwaitingInput = true
            self.onStateChange?()
        }
        onStateChange?()
        return nil
    }

    func disable() {
        hide()
        keyTap?.stop()
        keyTap = nil
        if let routingObserver { CFRunLoopRemoveObserver(CFRunLoopGetMain(), routingObserver, .commonModes) }
        routingObserver = nil
        if let terminationObserver { NSWorkspace.shared.notificationCenter.removeObserver(terminationObserver) }
        terminationObserver = nil
        // Queued behind any read still running, so that read cannot prime an
        // app again afterwards. Waited for because this also runs as Lasso
        // quits, but never longer than a hung host could make quitting take.
        let restored = DispatchSemaphore(value: 0)
        AccessibilityWork.queue.async {
            HostAccessibilityMode.shared.restoreAll()
            restored.signal()
        }
        _ = restored.wait(timeout: .now() + Self.restoreWait)
        isEnabled = false
        isAwaitingInput = false
        onStateChange?()
    }

    // MARK: Event handling

    /// Keys are routed on the tap's own thread from this snapshot, so it is
    /// republished after every change the main thread makes. A run loop
    /// observer covers the surfaces this class does not own.
    private func observeMainThreadIdle() {
        guard routingObserver == nil else { return }
        let observer = CFRunLoopObserverCreateWithHandler(
            kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { [weak self] _, _ in
                self?.publishKeyRouting()
            }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        routingObserver = observer
    }

    func currentKeyRouting() -> KeyRoutingState {
        let popup: KeyRoutingState.Popup
        if panel?.isVisible != true {
            popup = .hidden
        } else {
            switch view.mode {
            case .suggestions: popup = .suggestions
            case .confirmShare: popup = .confirmShare
            case .message: popup = .message
            }
        }
        let composer = ShareComposerController.shared
        return KeyRoutingState(
            isInserting: isInserting,
            transientOpen: LassoTransientUI.shared.hasOpenSurface,
            sourceChooserVisible: SourceChooserController.shared.isVisible,
            shareComposerOpen: composer.isVisible,
            inspectorCanShare: inspector?.canShareFromKeyboard == true,
            popup: popup,
            offersChoices: !view.suggestions.isEmpty,
            canUndoInsertion: undoableInsertion != nil)
    }

    func publishKeyRouting() {
        keyTap?.state.value = currentKeyRouting()
    }

    private func firstKeyArrived() {
        sawEvent = true
        guard isAwaitingInput else { return }
        isAwaitingInput = false
        onStateChange?()
    }

    /// What a key asked of Lasso, run on the main thread after the tap has
    /// already passed or swallowed it.
    func perform(_ action: KeyAction) {
        switch action {
        case .dismissTransient:
            LassoTransientUI.shared.dismissAll()
        case .escapePassed:
            // A prediction or presentation already pending is dropped, so it
            // cannot reopen the menu the user just dismissed.
            if debounce != nil || request != nil || popupHost != nil || measuringFor == generation { hide() }
        case .hide:
            hide()
        case .followTyping(let trackCaret):
            // Typing on ends a move, so a card the move left empty closes as usual.
            linkedSources.endMove()
            focusLanding = nil
            // What was typed is now the last change, which the host's own undo takes back.
            undoableInsertion = nil
            if trackCaret { self.trackCaret() }
            scheduleRefresh()
        case .activate:
            if view.mode == .confirmShare { resolveConfirmation() } else { activateSelection() }
        case .acceptPlain:
            acceptPlain()
        case .acceptShared:
            acceptShared()
        case .resolveConfirmation:
            resolveConfirmation()
        case .move(let delta):
            move(delta)
        case .shareConfirm:
            ShareComposerController.shared.confirm()
        case .shareScope(let delta):
            ShareComposerController.shared.moveScope(delta)
        case .inspectorShare:
            inspector?.shareFromKeyboard()
        case .focusOut:
            stepBack()
        case .focusIn:
            // A value has nothing below it, so there fn+Right does nothing.
            let choice = narrowingChoice, highlighted = highlightedSource
            guard linkedSources.canMoveIn(focusedOn: focusedSource, selected: choice?.source,
                                          highlighted: highlighted) else { break }
            let narrowed = linkedSources.moveIn(focusedOn: focusedSource, selected: choice?.source,
                                                highlighted: highlighted, typed: choice?.typed)
            // Back in a level an earlier fn+Left left, the list opens on the row
            // that fn+Left stepped out of, so fn+Right goes on back into it.
            focusLanding = linkedSources.steppedOutOf.map { .row(objectId: $0.objectId) } ?? .first
            // Until the server answers, a second fn+Right starts from here, not from the old card.
            focusedSource = narrowed
            refresh()
        case .shareUndo:
            ShareComposerController.shared.undoEdit()
        case .shareRedo:
            ShareComposerController.shared.redoEdit()
        case .undoInsertion:
            undoInsertion()
        }
        publishKeyRouting()
    }

    /// fn+Left: one level back. The list it returns to opens on the row
    /// stepped out of, so fn+Right goes straight back into it.
    func stepBack() {
        guard let focused = focusedSource else { return }
        focusLanding = .row(objectId: focused.objectId)
        let beneath = linkedSources.stepBack
        linkedSources.moveOut(from: focused)
        // Until the server answers, a second fn+Left steps back from here, not from the old card.
        focusedSource = beneath
        refresh()
    }

    private func dismissForEscape() {
        feedbackDismissed = true
        hide()
    }

    func hide() {
        generation += 1
        contextReads.dropPending()
        if ShareComposerController.shared.isPresented(in: panel) { ShareComposerController.shared.hide() }
        stopTrackingHost()
        debounce?.invalidate()
        debounce = nil
        flashTimer?.invalidate()
        request?.cancel()
        request = nil
        previewRequest?.cancel()
        previewGeneration += 1
        previewKey = nil
        view.selected = 0
        view.mode = .suggestions
        view.title = "dependency"
        view.preview = nil
        view.previewError = nil
        view.isPreviewLoading = false
        view.sourceScoped = false
        view.returnFocusName = nil
        view.stepBackName = nil
        focusedSource = nil
        focusLanding = nil
        linkedSources.endMove()
        pendingShare = nil
        panel?.orderOut(nil)
        publishKeyRouting()
    }
}
