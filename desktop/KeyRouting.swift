//  The keyboard tap, kept off the main thread.
//
//  A session event tap holds every keystroke in every app until its callback
//  returns. The callback therefore runs on its own thread and only reads a
//  snapshot the main thread publishes; it never waits for the main thread,
//  where Accessibility reads of a slow host could otherwise stall all typing
//  until macOS disables the tap. Anything the key should do inside Lasso is
//  handed to the main thread afterwards.

import Cocoa

/// What the main thread last showed, which is all a keystroke is routed on.
struct KeyRoutingState: Equatable {
    enum Popup: Equatable { case hidden, suggestions, confirmShare, message }

    var isInserting = false
    /// A Lasso surface that Escape closes is open.
    var transientOpen = false
    var sourceChooserVisible = false
    /// The share options are open, in the suggestion popup or the source inspector.
    var shareComposerOpen = false
    /// The source inspector shows a source its Share Link can share.
    var inspectorCanShare = false
    var popup: Popup = .hidden
    /// The card lists something to accept. One kept empty after a move only
    /// answers fn+Left and fn+Right.
    var offersChoices = true
    /// The highlighted row is a line whose words ⇧fn+Left and ⇧fn+Right open.
    var highlightsLine = false
    /// The card shows a line's words, which take the arrows.
    var choosingWords = false
    /// Lasso's last Tab or inserted link is the last change in the field, so
    /// ⌘Z takes it back.
    var canUndoInsertion = false
}

/// Work a keystroke asks of the main thread.
enum KeyAction: Equatable {
    case dismissTransient
    case escapePassed
    case hide
    case followTyping(trackCaret: Bool)
    case activate
    case acceptPlain
    case acceptShared
    case resolveConfirmation
    case move(Int)
    case shareConfirm
    case shareScope(Int)
    case inspectorShare
    case focusOut
    case focusIn
    case shareUndo
    case shareRedo
    case undoInsertion
    /// ⇧fn+Left or ⇧fn+Right on a highlighted line: its words, every one
    /// selected, with the selection's start or end to move.
    case openWords(movingStart: Bool)
    /// An arrow among a line's words.
    case moveInWords(forward: Bool, selecting: Bool, toEnd: Bool)
    /// Escape among a line's words goes back to the card's list.
    case closeWords
}

enum KeyDecision: Equatable {
    case pass(KeyAction?)
    case swallow(KeyAction)
}

enum KeyRouter {
    private static let tab: Int64 = 48, returnKey: Int64 = 36, enter: Int64 = 76, escape: Int64 = 53
    private static let z: Int64 = 6
    private static let left: Int64 = 123, right: Int64 = 124, down: Int64 = 125, up: Int64 = 126
    /// What macOS sends for fn+← and fn+→ (and a full keyboard's own Home and End keys).
    private static let home: Int64 = 115, end: Int64 = 119

    static func decide(keyCode: Int64, flags: CGEventFlags, synthetic: Bool,
                       state: KeyRoutingState) -> KeyDecision {
        // Our own synthesized keys are not the user typing.
        if synthetic || state.isInserting { return .pass(nil) }
        let commandLike = !flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty
        let choosingWords = state.choosingWords && state.popup == .suggestions
            && !state.sourceChooserVisible && !state.shareComposerOpen
        // Escape among a line's words goes back to the list; a second closes the card.
        if choosingWords, keyCode == escape, !commandLike { return .swallow(.closeWords) }
        if keyCode == escape, !commandLike, state.transientOpen { return .swallow(.dismissTransient) }
        // Native search controls own their keystrokes while the picker is open.
        if state.sourceChooserVisible { return .pass(nil) }
        // The share options take their keys from whichever app has focus.
        if state.shareComposerOpen { return shareDecision(keyCode, flags: flags, commandLike: commandLike) }
        // ⌘Z right after a Tab or an inserted link takes it back, whether or
        // not the host's own undo would. Lasso hands it on if it cannot.
        if state.canUndoInsertion, keyCode == z, flags.contains(.maskCommand),
           flags.intersection([.maskShift, .maskControl, .maskAlternate]).isEmpty {
            return .swallow(.undoInsertion)
        }
        // Escape with nothing open belongs to the host, and must not schedule
        // a new prediction that would reopen the just-dismissed menu.
        if keyCode == escape { return .pass(.escapePassed) }

        // Shift+Tab leaves the field, Control+Tab switches tabs, and modified
        // arrows move or select text. Only the bare keys belong to the box.
        let chord = !flags.intersection([.maskShift, .maskCommand, .maskControl, .maskAlternate]).isEmpty
        if choosingWords, let decision = wordsDecision(keyCode, flags: flags) { return decision }
        // ⇧fn+Left and ⇧fn+Right open a highlighted line's words. On any other
        // row they still select to the start or end in the host.
        if state.popup == .suggestions, state.offersChoices, state.highlightsLine, !choosingWords,
           keyCode == home || keyCode == end, flags.contains(.maskShift),
           flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty {
            return .swallow(.openWords(movingStart: keyCode == home))
        }
        // fn+Right narrows the card's focus a level and fn+Left steps back
        // one. While the card is up they never reach the host, so at the top
        // or the bottom they do nothing rather than move the caret.
        if state.popup == .suggestions, !chord {
            if keyCode == home { return .swallow(.focusOut) }
            if keyCode == end { return .swallow(.focusIn) }
        }
        if (state.popup == .suggestions && state.offersChoices) || state.popup == .confirmShare {
            switch keyCode {
            case tab where chord, down where chord, up where chord:
                return .pass(.hide)
            case tab:
                return .swallow(.activate)
            case returnKey, enter:
                if flags.contains(.maskCommand) {
                    return .swallow(flags.contains(.maskShift) ? .acceptShared : .acceptPlain)
                }
                if state.popup == .confirmShare { return .swallow(.resolveConfirmation) }
            case up:
                return .swallow(.move(-1))
            case down:
                return .swallow(.move(1))
            default:
                break
            }
        }
        // Tab is the inspector's Share Link, wherever the person was typing.
        if state.inspectorCanShare, keyCode == tab, !chord { return .swallow(.inspectorShare) }
        // Other modifier chords are shortcuts, not typing.
        if flags.contains(.maskCommand) || flags.contains(.maskControl) { return .pass(.hide) }
        // The debounce only fires once typing pauses, so an open box is moved
        // on every key instead; otherwise it lags behind continuous typing.
        return .pass(.followTyping(trackCaret: state.popup != .hidden))
    }

    /// Among a line's words the arrows are a text field's, a word at a time,
    /// with or without Option: ⇧ selects, and ⌘ (or ⇧fn) goes to the start or
    /// end. fn+Left and fn+Right keep their meaning on the card, and Control
    /// arrows belong to macOS.
    private static func wordsDecision(_ keyCode: Int64, flags: CGEventFlags) -> KeyDecision? {
        guard !flags.contains(.maskControl) else { return nil }
        let selecting = flags.contains(.maskShift)
        switch keyCode {
        case left, right:
            return .swallow(.moveInWords(forward: keyCode == right, selecting: selecting,
                                         toEnd: flags.contains(.maskCommand)))
        case home where selecting, end where selecting:
            return .swallow(.moveInWords(forward: keyCode == end, selecting: true, toEnd: true))
        default:
            return nil
        }
    }

    private static func shareDecision(_ keyCode: Int64, flags: CGEventFlags, commandLike: Bool) -> KeyDecision {
        // ⌘Z and ⇧⌘Z step through the masks, marks or chosen excerpt, never
        // the document behind them.
        if keyCode == z, flags.contains(.maskCommand), flags.intersection([.maskControl, .maskAlternate]).isEmpty {
            return .swallow(flags.contains(.maskShift) ? .shareRedo : .shareUndo)
        }
        guard !commandLike else { return .pass(nil) }
        switch keyCode {
        case tab where flags.contains(.maskShift): return .pass(nil)
        case tab, returnKey, enter: return .swallow(.shareConfirm)
        case left, up: return .swallow(.shareScope(-1))
        case right, down: return .swallow(.shareScope(1))
        default: return .pass(nil)
        }
    }
}

/// The routing snapshot, written on the main thread and read on the tap's.
final class KeyRoutingStateBox {
    private let lock = NSLock()
    private var state = KeyRoutingState()

    var value: KeyRoutingState {
        get { lock.lock(); defer { lock.unlock() }; return state }
        set { lock.lock(); state = newValue; lock.unlock() }
    }
}

/// Owns the CGEvent tap and the thread its run loop runs on. Started once and
/// stopped once; enabling suggestions again creates a new tap.
final class KeyEventTap {
    let state = KeyRoutingStateBox()
    /// Runs on the main thread for every key that asks something of Lasso.
    private let perform: (KeyAction) -> Void
    /// Runs on the main thread once, when the first key arrives.
    private let onFirstKey: () -> Void
    /// Runs on the main thread when a key that starts Dictation is pressed.
    private let onDictationShortcut: () -> Void
    /// Set before the tap thread starts and never replaced, so the callback
    /// can read it without a lock.
    private var port: CFMachPort?
    private var source: CFRunLoopSource?
    private var runLoop: CFRunLoop?
    /// Touched only on the tap thread.
    private var sawKey = false
    private var dictationShortcut = DictationShortcut()

    init(perform: @escaping (KeyAction) -> Void, onFirstKey: @escaping () -> Void,
         onDictationShortcut: @escaping () -> Void = {}) {
        self.perform = perform
        self.onFirstKey = onFirstKey
        self.onDictationShortcut = onDictationShortcut
    }

    /// False when macOS refused the tap, which means Input Monitoring is missing.
    func start() -> Bool {
        guard port == nil else { return false }
        // Modifier changes only show whether one was pressed twice, for Dictation.
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue) | CGEventMask(1 << CGEventType.flagsChanged.rawValue)
        guard let created = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                return Unmanaged<KeyEventTap>.fromOpaque(refcon).takeUnretainedValue().handle(type, event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        port = created
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        self.source = source
        let ready = DispatchSemaphore(value: 0)
        // The thread keeps the tap alive until its run loop returns, so a key
        // still being routed while the tap stops never outlives its owner.
        let thread = Thread { [self] in
            let loop = CFRunLoopGetCurrent()
            runLoop = loop
            CFRunLoopAddSource(loop, source, .defaultMode)
            CGEvent.tapEnable(tap: created, enable: true)
            ready.signal()
            // Returns once the source is removed or the loop is stopped.
            CFRunLoopRun()
        }
        thread.name = "Lasso keyboard tap"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
        return true
    }

    func stop() {
        if let port { CGEvent.tapEnable(tap: port, enable: false) }
        if let runLoop, let source {
            CFRunLoopRemoveSource(runLoop, source, .defaultMode)
            CFRunLoopStop(runLoop)
        }
        if let port { CFMachPortInvalidate(port) }
    }

    /// Runs on the tap thread. Reads the snapshot and returns at once.
    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let port { CGEvent.tapEnable(tap: port, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let synthetic = event.getIntegerValueField(.eventSourceUserData) == SyntheticKeyboard.marker
        if type == .flagsChanged {
            let seconds = TimeInterval(event.timestamp) / 1_000_000_000
            if !synthetic, dictationShortcut.flagsChanged(event.flags, at: seconds) {
                DispatchQueue.main.async(execute: onDictationShortcut)
            }
            return Unmanaged.passUnretained(event)
        }
        guard type == .keyDown else { return Unmanaged.passUnretained(event) }
        if !sawKey {
            sawKey = true
            DispatchQueue.main.async(execute: onFirstKey)
        }
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if !synthetic, dictationShortcut.keyDown(keyCode, flags: event.flags) {
            DispatchQueue.main.async(execute: onDictationShortcut)
        }
        let decision = KeyRouter.decide(
            keyCode: keyCode, flags: event.flags, synthetic: synthetic, state: state.value)
        switch decision {
        case .pass(let action):
            if let action { DispatchQueue.main.async { [perform] in perform(action) } }
            return Unmanaged.passUnretained(event)
        case .swallow(let action):
            DispatchQueue.main.async { [perform] in perform(action) }
            return nil
        }
    }
}
