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
            // vim, dialogs and search fields. Among a line's words the keyboard
            // tap takes Escape back to the list, and the card stays open.
            isOpen: { [weak self] in self?.panel?.isVisible == true && self?.view.wordChoice == nil },
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
        dismiss()
        self.projectIds = updated
        workspaceRevision = revision
        linkedSources.keep(projectIds: updated)
        if isEnabled, !updated.isEmpty { scheduleRefresh() }
    }

    /// Pause retrieval immediately while the directory selection is changing.
    func suspendWorkspace() {
        dismiss()
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
    /// The query the visible rows answer; `context` may already hold newer typing.
    var displayedPrediction: (context: CaretContext, source: LinkedSourceMemory.Source?)?
    var generation = 0
    var feedbackDismissed = false
    private var sawEvent = false
    /// The tap exists but no key has arrived for a while. With Input
    /// Monitoring also missing, that means macOS is withholding keystrokes.
    private(set) var isAwaitingInput = false
    var isInserting = false {
        didSet {
            // The field reports the link or undo just written a moment later.
            if !isInserting { markOwnWrite() }
            publishKeyRouting()
        }
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
    /// The field text the card last answered, so an answer can tell whether typing has moved on since.
    var answeredText: String?
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
    /// Changes whenever the tracked editor changes or tracking stops, so a
    /// caret read for an earlier editor is never applied.
    var hostGeneration = 0
    var hostTimer: Timer?
    var hostObservers: [NSObjectProtocol] = []
    var contextReads = CoalescingGate()
    /// Answers normally come back within a key or two; a list that waits
    /// longer than this while the writer types on is for words behind them.
    static let unansweredListTime: TimeInterval = 0.5
    var typedOverList = UnansweredTyping(limit: unansweredListTime)
    var unansweredListTimer: Timer?
    var rereadsLeft = 0
    var hostReads = CoalescingGate()
    /// The generation a box or message is being measured for, until it shows.
    var measuringFor: Int?
    #if BROWSER_GEOMETRY_TEST
    var regressionPrediction = false
    var regressionAccepted: [String: Any]?
    #endif

    // Dictation writes without keys, so its words are followed through the
    // field's own change reports instead of the keyboard tap.
    private let dictation = DictationWatch()
    /// When a key the editor turns into text was last typed. The field's
    /// report of that change is the keyboard's, already followed.
    private var lastTypedAt = Date.distantPast
    /// Lasso's own edits change the field too; changes until then are its own.
    private var ownWriteUntil = Date.distantPast
    private var dictationDebounce: Timer?
    /// Reads the focused field while a microphone is live, for hosts such as
    /// Chrome's web editors that do not always report their changes.
    private var dictationPoll: Timer?
    private var dictationReads = CoalescingGate()
    private static let dictationPollTime: TimeInterval = 0.2
    /// The focused field as last read, so a change report that left its text
    /// as it was asks for nothing.
    var lastRead: (element: AXUIElement, text: String, caret: Int)?
    /// Elements whose changes were not the focused field's, until focus moves.
    private var unrelatedElements: [AXUIElement] = []
    /// The card last on screen, kept a moment after it closes: dictation can
    /// briefly write a different word ("tap") before settling on "tab".
    var spokenCard: SpokenCard?
    private var spokenTimer: Timer?
    /// When a spoken "tab" was taken as the key, to log how long writing took.
    var spokenHeardAt: Date?
    private static let keyEchoTime: TimeInterval = 0.6
    private static let ownWriteTime: TimeInterval = 0.6
    /// Web editors report one edit several times in a row; their reports are read once.
    private static let dictationSettleTime: TimeInterval = 0.05
    /// Dictation may still revise the word it just wrote ("tab" → "Tab.").
    /// The field is read again before writing, so this only needs to be long
    /// enough for the revision that comes straight after the word.
    private static let spokenSettleTime: TimeInterval = 0.1
    private static let spokenCardLifetime: TimeInterval = 6

    /// A card as the writer saw it: the text it answered and what Tab would insert.
    struct SpokenCard {
        let context: CaretContext
        let suggestion: AssistSuggestion
        let seen: Date
    }

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
            onFirstKey: { [weak self] in self?.firstKeyArrived() },
            onDictationShortcut: { [weak self] in self?.dictation.shortcutPressed() })
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
        dictation.onValueChange = { [weak self] element in self?.fieldValueChanged(element) }
        dictation.onFocusChange = { [weak self] in self?.unrelatedElements.removeAll() }
        dictation.onListeningChange = { [weak self] in self?.listeningChanged() }
        dictation.start()
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
        dismiss()
        dictation.stop()
        dictationDebounce?.invalidate()
        dictationDebounce = nil
        dictationPoll?.invalidate()
        dictationPoll = nil
        lastRead = nil
        unrelatedElements = []
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
            highlightsLine: view.mode == .suggestions && currentSuggestion?.offersWords == true,
            choosingWords: view.mode == .suggestions && view.wordChoice != nil,
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
            if debounce != nil || request != nil || popupHost != nil || measuringFor == generation { dismiss() }
            spokenCard = nil
            // Escape in the app ends Dictation too.
            dictation.endSession()
        case .hide:
            dismiss()
        case .followTyping(let trackCaret):
            lastTypedAt = Date()
            followTextChange(trackCaret: trackCaret)
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
            // fn+Left and fn+Right keep their meaning among a line's words.
            view.wordChoice = nil
            stepBack()
        case .focusIn:
            view.wordChoice = nil
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
        case .openWords(let movingStart):
            openWords(movingStart: movingStart)
        case .moveInWords(let forward, let selecting, let toEnd):
            view.wordChoice?.move(forward ? .forward : .backward, selecting: selecting, toEnd: toEnd)
        case .closeWords:
            view.wordChoice = nil
        }
        publishKeyRouting()
    }

    /// New text in the field, typed or dictated: suggestions follow it.
    private func followTextChange(trackCaret: Bool) {
        view.wordChoice = nil
        // Typing on ends a move, so a card the move left empty closes as usual.
        linkedSources.endMove()
        focusLanding = nil
        // What was typed is now the last change, which the host's own undo takes back.
        undoableInsertion = nil
        if trackCaret { self.trackCaret() }
        awaitAnswerForTyping()
        scheduleRefresh()
    }

    // MARK: Dictation

    /// The frontmost app changed a value while a microphone is live. Typing
    /// is followed by the keyboard tap, and Lasso's own edits by the edit
    /// itself; anything else may be dictation, once the field is read.
    private func fieldValueChanged(_ element: AXUIElement) {
        guard mayFollowDictation, !unrelatedElements.contains(where: { CFEqual($0, element) }) else { return }
        dictationDebounce?.invalidate()
        dictationDebounce = Timer.scheduledTimer(withTimeInterval: Self.dictationSettleTime, repeats: false) { [weak self] _ in
            self?.dictationDebounce = nil
            self?.readDictatedText(reportedBy: element)
        }
    }

    /// Nothing typed for a moment, nothing Lasso is writing, and no Lasso
    /// surface that takes the keys.
    private var mayFollowDictation: Bool {
        let now = Date()
        return isEnabled && serverURL != nil && !projectIds.isEmpty && !isInserting
            && !ShareComposerController.shared.isVisible && !SourceChooserController.shared.isVisible
            && view.mode != .confirmShare
            && now.timeIntervalSince(lastTypedAt) > Self.keyEchoTime && now >= ownWriteUntil
    }

    /// While a microphone is live the focused field is also read on a timer:
    /// not every host reports a change dictation makes.
    private func listeningChanged() {
        guard isEnabled, dictation.isListening else {
            dictationPoll?.invalidate()
            dictationPoll = nil
            return
        }
        guard dictationPoll == nil else { return }
        let timer = Timer(timeInterval: Self.dictationPollTime, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard self.dictation.isListening else { self.listeningChanged(); return }
            if self.mayFollowDictation { self.readDictatedText(reportedBy: nil) }
        }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        dictationPoll = timer
    }

    /// Reads the focused field and follows it only if its text moved on.
    /// `element` is what reported a change, or nil for a timed read.
    private func readDictatedText(reportedBy element: AXUIElement?) {
        guard dictationReads.begin() else { return }
        let typedAt = lastTypedAt
        AccessibilityWork.queue.async { [weak self] in
            let context = AccessibilityReader.focusedContext()
            DispatchQueue.main.async {
                guard let self else { return }
                let again = self.dictationReads.end()
                defer { if again { self.readDictatedText(reportedBy: element) } }
                // A key typed meanwhile is the keyboard tap's to follow.
                guard self.isEnabled, typedAt == self.lastTypedAt, Date() >= self.ownWriteUntil else { return }
                guard let context else {
                    if element != nil { dictationLog.debug("read: no focused text field") }
                    return
                }
                let sameField = self.lastRead.map { CFEqual($0.element, context.element) } ?? false
                if sameField, let last = self.lastRead, last.text == context.text, last.caret == context.absoluteCaret {
                    // The field is as it was: something else in the app changed.
                    if let element, !CFEqual(context.element, element), self.unrelatedElements.count < 32 {
                        self.unrelatedElements.append(element)
                    }
                    return
                }
                // A timed read of a field not read before is where it starts:
                // its text may be older than the microphone. A change report
                // while dictating is followed even then, since dictation may
                // write a whole phrase in one change.
                guard sameField || element != nil else {
                    dictationLog.debug("read: new field, noted")
                    self.lastRead = (context.element, context.text, context.absoluteCaret)
                    return
                }
                dictationLog.debug("read: dictated text, \(element == nil ? "timed" : "reported", privacy: .public)")
                self.dictation.wordsArrived()
                // "tab" is taken as the key from this reading, without a second one.
                self.lastRead = (context.element, context.text, context.absoluteCaret)
                if self.acceptsSpokenTab(in: context) { return }
                self.followTextChange(trackCaret: true)
                self.publishKeyRouting()
            }
        }
    }

    /// The words in the field are dictation's: a microphone is live and
    /// nothing has been typed for a moment.
    var isDictating: Bool {
        dictation.isListening && Date().timeIntervalSince(lastTypedAt) > Self.keyEchoTime
    }

    /// The field without its last `length` UTF-16 units, as a card asked
    /// without them saw it.
    static func trimmed(_ context: CaretContext, by length: Int) -> CaretContext {
        let units = Array(context.text.utf16)
        guard length > 0, length <= units.count else { return context }
        return CaretContext(text: String(decoding: units.dropLast(length), as: UTF16.self),
                            cursor: units.count - length, windowStart: context.windowStart,
                            absoluteCaret: context.absoluteCaret >= 0 ? context.absoluteCaret - length : -1,
                            selectionLength: context.selectionLength, caretRect: context.caretRect,
                            element: context.element, diagnosis: context.diagnosis)
    }

    /// The edit that writes `suggestion` into the field as it is now. A card
    /// asked without the mark dictation put at a pause ("Other revenue.") is
    /// written before the mark, which stays after it.
    func fieldPlan(for suggestion: AssistSuggestion, in context: CaretContext) -> CompletionPlan? {
        if case .success(let plan) = planInsertion(for: suggestion, in: context) { return plan }
        let units = Array(context.text.utf16)
        let pause = SpokenAccept.pauseMarkLength(units)
        let answered = Self.trimmed(context, by: pause)
        guard pause > 0, case .success(let planned) = planInsertion(for: suggestion, in: answered) else { return nil }
        return SpokenAccept.plan(planned, card: Self.snapshot(answered), current: Self.snapshot(context),
                                 spokenLength: pause, keeping: String(decoding: units.suffix(pause), as: UTF16.self))
    }

    /// The card on screen, as Tab would accept it now.
    private var shownCard: SpokenCard? {
        guard panel?.isVisible == true, view.mode == .suggestions, let shown = displayedPrediction,
              let suggestion = acceptedSuggestion else { return nil }
        return SpokenCard(context: shown.context, suggestion: suggestion, seen: Date())
    }

    private static func snapshot(_ context: CaretContext) -> CompletionSnapshot {
        CompletionSnapshot(documentStart: max(0, context.windowStart), text: Array(context.text.utf16))
    }

    /// Saying "tab" while dictating: the field holds the text the card answered
    /// followed by the word. Once dictation has settled on it, one edit
    /// replaces the word with what Tab inserts as plain text. True when that
    /// is under way, so the word is not looked up as text.
    func acceptsSpokenTab(in current: CaretContext) -> Bool {
        guard isDictating, view.mode == .suggestions else { return false }
        let units = Array(current.text.utf16)
        guard SpokenAccept.commandLength(units) != nil else {
            if let heard = SpokenAccept.nearMiss(units) { dictationLog.debug("spoken tab: heard \(heard, privacy: .public) instead") }
            return false
        }
        // Why a "tab" said at the end of the field was not taken as the key,
        // without what else was written.
        func declined(_ reason: StaticString) -> Bool {
            dictationLog.debug("spoken tab: \(reason, privacy: .public)")
            return false
        }
        guard let card = shownCard ?? spokenCard else { return declined("no card shown or kept") }
        guard Date().timeIntervalSince(card.seen) < Self.spokenCardLifetime else { return declined("card closed too long ago") }
        guard CFEqual(card.context.element, current.element), card.context.diagnosis == current.diagnosis else {
            return declined("card was for another field")
        }
        let cardSnapshot = Self.snapshot(card.context), currentSnapshot = Self.snapshot(current)
        guard let spoken = SpokenAccept.spokenLength(card: cardSnapshot, current: currentSnapshot) else {
            return declined("the words before it are not the card's")
        }
        guard case .success(let planned) = planInsertion(for: card.suggestion, in: card.context),
              let plan = SpokenAccept.plan(planned, card: cardSnapshot, current: currentSnapshot,
                                           spokenLength: spoken) else { return declined("the card's words changed") }
        dictationLog.debug("spoken tab: accepting")
        spokenHeardAt = Date()
        // Nothing asked about the text before the word may replace the card meanwhile.
        generation += 1
        let token = generation
        request?.cancel()
        request = nil
        spokenTimer?.invalidate()
        spokenTimer = Timer.scheduledTimer(withTimeInterval: Self.spokenSettleTime, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.spokenTimer = nil
            // Typing, Escape or a newer word since make this out of date.
            guard token == self.generation, self.isEnabled else {
                dictationLog.debug("spoken tab: newer words came first")
                self.spokenHeardAt = nil
                return
            }
            self.spokenCard = nil
            self.context = current
            self.undoableInsertion = nil
            // The write reads the field once more and stops if dictation
            // revised it meanwhile, so no separate read is needed first.
            self.writePlain(card.suggestion, plan: plan, context: current, fresh: current)
        }
        return true
    }

    /// Lasso is writing to the field, whose reports of it are not dictation.
    func markOwnWrite() {
        ownWriteUntil = Date().addingTimeInterval(Self.ownWriteTime)
    }

    /// The card, as the writer last saw it, is no longer theirs to accept by voice.
    func dismiss() {
        hide()
        spokenCard = nil
    }

    /// ⇧fn+Right or ⇧fn+Left on a highlighted line: its words, every one
    /// selected, for Tab to insert only some of them.
    func openWords(movingStart: Bool) {
        guard view.mode == .suggestions, let suggestion = currentSuggestion, suggestion.offersWords,
              let words = AssistWordChoice(text: suggestion.insertText, movingStart: movingStart) else { return }
        // An answer still coming for the words typed before must not replace the line.
        generation += 1
        debounce?.invalidate()
        debounce = nil
        request?.cancel()
        request = nil
        view.wordChoice = words
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
        dismiss()
    }

    /// Typing over a shown list starts the wait for an answer to the newer text.
    func awaitAnswerForTyping() {
        guard panel?.isVisible == true, view.mode == .suggestions, !view.suggestions.isEmpty,
              let deadline = typedOverList.typed(at: Date()) else { return }
        unansweredListTimer?.invalidate()
        unansweredListTimer = Timer.scheduledTimer(withTimeInterval: max(0, deadline.timeIntervalSinceNow),
                                                   repeats: false) { [weak self] _ in self?.closeUnansweredList() }
    }

    /// Takes the old list off screen but lets the read and request in flight
    /// go on, so the answer for the text now at the caret still opens the card.
    private func closeUnansweredList() {
        unansweredListTimer = nil
        typedOverList.answered()
        guard view.mode == .suggestions, panel?.isVisible == true else { return }
        panel?.orderOut(nil)
        publishKeyRouting()
    }

    /// A list was shown for the text as it is, or the card closed.
    func endUnansweredWait() {
        unansweredListTimer?.invalidate()
        unansweredListTimer = nil
        typedOverList.answered()
    }

    func hide() {
        // A card that closes on its own, because the next words found nothing
        // or dictation wrote a word it then corrected, can still be accepted by
        // saying "tab" a moment later. Dismissing it forgets it.
        if let shown = shownCard { spokenCard = shown }
        if spokenTimer != nil { spokenHeardAt = nil }
        spokenTimer?.invalidate()
        spokenTimer = nil
        endUnansweredWait()
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
        displayedPrediction = nil
        view.selected = 0
        view.mode = .suggestions
        view.title = "dependency"
        view.preview = nil
        view.previewError = nil
        view.isPreviewLoading = false
        view.sourceScoped = false
        view.returnFocusName = nil
        view.stepBackName = nil
        view.wordChoice = nil
        focusedSource = nil
        focusLanding = nil
        linkedSources.endMove()
        pendingShare = nil
        panel?.orderOut(nil)
        publishKeyRouting()
    }
}
