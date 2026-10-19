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
    /// The share options are drawn inside the suggestion popup.
    var shareComposerInPopup = false
    var popup: Popup = .hidden
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
}

enum KeyDecision: Equatable {
    case pass(KeyAction?)
    case swallow(KeyAction)
}

enum KeyRouter {
    private static let tab: Int64 = 48, returnKey: Int64 = 36, enter: Int64 = 76, escape: Int64 = 53
    private static let left: Int64 = 123, right: Int64 = 124, down: Int64 = 125, up: Int64 = 126

    static func decide(keyCode: Int64, flags: CGEventFlags, synthetic: Bool,
                       state: KeyRoutingState) -> KeyDecision {
        // Our own synthesized keys are not the user typing.
        if synthetic || state.isInserting { return .pass(nil) }
        let commandLike = !flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty
        if keyCode == escape, !commandLike, state.transientOpen { return .swallow(.dismissTransient) }
        // Native search controls own their keystrokes while the picker is open.
        if state.sourceChooserVisible { return .pass(nil) }
        if state.shareComposerInPopup { return shareDecision(keyCode, flags: flags, commandLike: commandLike) }
        // Escape with nothing open belongs to the host, and must not schedule
        // a new prediction that would reopen the just-dismissed menu.
        if keyCode == escape { return .pass(.escapePassed) }

        // Shift+Tab leaves the field, Control+Tab switches tabs, and modified
        // arrows move or select text. Only the bare keys belong to the box.
        let chord = !flags.intersection([.maskShift, .maskCommand, .maskControl, .maskAlternate]).isEmpty
        if state.popup == .suggestions || state.popup == .confirmShare {
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
        // Other modifier chords are shortcuts, not typing.
        if flags.contains(.maskCommand) || flags.contains(.maskControl) { return .pass(.hide) }
        // The debounce only fires once typing pauses, so an open box is moved
        // on every key instead; otherwise it lags behind continuous typing.
        return .pass(.followTyping(trackCaret: state.popup != .hidden))
    }

    private static func shareDecision(_ keyCode: Int64, flags: CGEventFlags, commandLike: Bool) -> KeyDecision {
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

enum KeyEventLatency {
    /// Longer than any real wait; a value past it means another clock.
    private static let plausibleMilliseconds = 10_000.0

    /// Milliseconds between a key event's creation and now, both on the
    /// uptime clock in nanoseconds. Nil when the event carries no usable time.
    static func milliseconds(eventTimestamp: UInt64, now: UInt64) -> Double? {
        guard eventTimestamp > 0, now >= eventTimestamp else { return nil }
        let elapsed = Double(now - eventTimestamp) / 1_000_000
        return elapsed <= plausibleMilliseconds ? elapsed : nil
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
    /// Runs on the main thread with the delay of a key that reached the tap late.
    private let onLateKey: (Double) -> Void
    /// Set before the tap thread starts and never replaced, so the callback
    /// can read it without a lock.
    private var port: CFMachPort?
    private var source: CFRunLoopSource?
    private var runLoop: CFRunLoop?
    /// Touched only on the tap thread.
    private var sawKey = false
    private static let lateKeyMilliseconds = 50.0

    init(perform: @escaping (KeyAction) -> Void, onFirstKey: @escaping () -> Void,
         onLateKey: @escaping (Double) -> Void) {
        self.perform = perform
        self.onFirstKey = onFirstKey
        self.onLateKey = onLateKey
    }

    /// False when macOS refused the tap, which means Input Monitoring is missing.
    func start() -> Bool {
        guard port == nil else { return false }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
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
        guard type == .keyDown else { return Unmanaged.passUnretained(event) }
        if !sawKey {
            sawKey = true
            DispatchQueue.main.async(execute: onFirstKey)
        }
        if let late = KeyEventLatency.milliseconds(eventTimestamp: event.timestamp,
                                                   now: clock_gettime_nsec_np(CLOCK_UPTIME_RAW)),
           late >= Self.lateKeyMilliseconds {
            DispatchQueue.main.async { [onLateKey] in onLateKey(late) }
        }
        let decision = KeyRouter.decide(
            keyCode: event.getIntegerValueField(.keyboardEventKeycode), flags: event.flags,
            synthetic: event.getIntegerValueField(.eventSourceUserData) == SyntheticKeyboard.marker,
            state: state.value)
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
