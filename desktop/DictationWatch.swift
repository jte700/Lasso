//  Dictation, seen from the field it writes into.
//
//  macOS Dictation, Voice Control and other dictation tools put words into
//  the focused field without pressing keys, so the keyboard tap that makes
//  suggestions follow typing never sees them. For a while after a Dictation
//  shortcut (macOS Dictation does not report the microphone as running),
//  and while a microphone is live for other tools and a few seconds after,
//  the frontmost app is asked to report changes to its values, and the
//  assistant reads the focused field when one arrives and on a timer.
//
//  Lasso never records or listens. It reads only CoreAudio's report of
//  whether an input device is running for some app, which needs no
//  microphone access, and recognising speech is left to the dictation tool.

import Cocoa
import CoreAudio
import ApplicationServices
import os

/// What the dictation path did, never what was said. Shown only while
/// streamed: `log stream --level debug --predicate 'subsystem == "com.jte700.lasso"'`.
let dictationLog = Logger(subsystem: "com.jte700.lasso", category: "dictation")

/// The keys that start macOS Dictation, seen by the keyboard tap: the 🎤
/// key, or the shortcuts Keyboard settings offers, a modifier pressed twice
/// (🌐 fn, Control or Command). macOS Dictation records without the input
/// device reporting itself as running, so this is how Lasso knows to look.
/// Pressing one again, as when ending Dictation, starts the watch again,
/// which keeps it for the words Dictation writes as it stops.
struct DictationShortcut {
    /// The 🎤 key, which macOS sends as key code 176. Where the top row types
    /// F-keys, the key types F5 and fn+F5 is the 🎤 key, sent as 176 too.
    static let keys: Set<Int64> = [176]
    static let doubleTapTime: TimeInterval = 0.5

    private var down: CGEventFlags.RawValue?
    private var lastTap: (modifier: CGEventFlags.RawValue, at: TimeInterval)?
    private var previous: CGEventFlags = []

    private static let tapped: [CGEventFlags] = [.maskSecondaryFn, .maskControl, .maskCommand]
    private static let modifiers: CGEventFlags = [.maskSecondaryFn, .maskControl, .maskCommand, .maskShift, .maskAlternate]

    /// A key went down. True when it is the 🎤 key; any key also breaks a modifier tap.
    mutating func keyDown(_ keyCode: Int64, flags: CGEventFlags) -> Bool {
        down = nil
        lastTap = nil
        return Self.keys.contains(keyCode) && flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
    }

    /// The modifiers changed. True on the second quick tap of one of them, alone.
    mutating func flagsChanged(_ flags: CGEventFlags, at time: TimeInterval) -> Bool {
        let held = flags.intersection(Self.modifiers)
        defer { previous = held }
        if previous.isEmpty, let single = Self.tapped.first(where: { held == $0 }) {
            down = single.rawValue
            return false
        }
        guard held.isEmpty, let released = down else {
            // A second modifier joined it: a chord, not a tap.
            if !held.isEmpty { down = nil; lastTap = nil }
            return false
        }
        down = nil
        if let last = lastTap, last.modifier == released, time - last.at <= Self.doubleTapTime {
            lastTap = nil
            return true
        }
        lastTap = (released, time)
        return false
    }
}

/// Whether any input device is running, for any app. Main thread only.
final class MicrophoneActivity {
    private(set) var isLive = false
    /// When a live microphone last stopped.
    private(set) var stoppedAt = Date.distantPast
    var onChange: (() -> Void)?

    private var inputs: [AudioObjectID] = []
    private var started = false
    // CoreAudio removes a listener only when handed the same block it was
    // added with, so each is made once.
    private lazy var devicesChanged: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.watchInputs() }
    private lazy var runningChanged: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.update() }

    private static let system = AudioObjectID(kAudioObjectSystemObject)

    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    func start() {
        guard !started else { return }
        started = true
        var devices = Self.address(kAudioHardwarePropertyDevices)
        AudioObjectAddPropertyListenerBlock(Self.system, &devices, .main, devicesChanged)
        watchInputs()
    }

    func stop() {
        guard started else { return }
        started = false
        var devices = Self.address(kAudioHardwarePropertyDevices)
        AudioObjectRemovePropertyListenerBlock(Self.system, &devices, .main, devicesChanged)
        var running = Self.address(kAudioDevicePropertyDeviceIsRunningSomewhere)
        for device in inputs { AudioObjectRemovePropertyListenerBlock(device, &running, .main, runningChanged) }
        inputs = []
        isLive = false
    }

    /// Follows microphones as they are plugged in and taken away.
    private func watchInputs() {
        guard started else { return }
        let current = Self.inputDevices()
        var running = Self.address(kAudioDevicePropertyDeviceIsRunningSomewhere)
        for device in inputs where !current.contains(device) {
            AudioObjectRemovePropertyListenerBlock(device, &running, .main, runningChanged)
        }
        for device in current where !inputs.contains(device) {
            AudioObjectAddPropertyListenerBlock(device, &running, .main, runningChanged)
        }
        inputs = current
        update()
    }

    private func update() {
        guard started else { return }
        let live = inputs.contains(where: Self.isRunning)
        guard live != isLive else { return }
        if !live { stoppedAt = Date() }
        isLive = live
        dictationLog.debug("microphone \(live ? "live" : "stopped", privacy: .public) (\(self.inputs.count) inputs)")
        onChange?()
    }

    private static func inputDevices() -> [AudioObjectID] {
        var address = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices) == noErr else { return [] }
        return devices.filter { device in
            var streams = Self.address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput)
            var streamSize: UInt32 = 0
            return AudioObjectGetPropertyDataSize(device, &streams, 0, nil, &streamSize) == noErr && streamSize > 0
        }
    }

    private static func isRunning(_ device: AudioObjectID) -> Bool {
        var address = address(kAudioDevicePropertyDeviceIsRunningSomewhere)
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &running) == noErr && running != 0
    }
}

/// Reports value changes in the frontmost app while dictation may be writing.
/// Its public side is used on the main thread; the Accessibility observer is
/// made and changed on `AccessibilityWork.queue`, and delivers on the main
/// run loop.
final class DictationWatch {
    /// Something in the frontmost app changed its value. Main thread.
    var onValueChange: ((AXUIElement) -> Void)?
    /// Focus moved to another element or app. Main thread.
    var onFocusChange: (() -> Void)?
    /// `isListening` changed. Main thread.
    var onListeningChange: (() -> Void)?

    /// Long enough for tools that write once recording stops.
    static let afterRecording: TimeInterval = 4
    /// How long a Dictation shortcut keeps the watch, and how much longer
    /// each dictated change keeps it after that.
    static let shortcutSession: TimeInterval = 30
    static let afterDictatedWords: TimeInterval = 15

    private let microphone = MicrophoneActivity()
    private var running = false
    private var activation: NSObjectProtocol?
    private var detachTimer: Timer?
    /// Until when a Dictation shortcut keeps the watch.
    private var sessionUntil = Date.distantPast

    // Accessibility queue only.
    private var observer: AXObserver?
    private var observedPID: pid_t?
    private var observedApplication: AXUIElement?
    private var observedFocus: AXUIElement?

    /// Dictation may be writing: a Dictation shortcut was pressed a moment
    /// ago, or a microphone is live or stopped only a moment ago.
    var isListening: Bool {
        let now = Date()
        return running && (microphone.isLive || now < sessionUntil
            || now.timeIntervalSince(microphone.stoppedAt) < Self.afterRecording)
    }

    /// A Dictation shortcut was pressed.
    func shortcutPressed() {
        guard running else { return }
        sessionUntil = max(sessionUntil, Date().addingTimeInterval(Self.shortcutSession))
        dictationLog.debug("dictation shortcut")
        listeningStateChanged()
    }

    /// Dictated words arrived, so dictation is still going.
    func wordsArrived() {
        guard running, Date() < sessionUntil else { return }
        sessionUntil = max(sessionUntil, Date().addingTimeInterval(Self.afterDictatedWords))
    }

    /// Escape ends Dictation.
    func endSession() {
        guard running, sessionUntil > Date() else { return }
        sessionUntil = .distantPast
        listeningStateChanged()
    }

    func start() {
        guard !running else { return }
        running = true
        microphone.onChange = { [weak self] in self?.microphoneChanged() }
        microphone.start()
        activation = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self, self.isListening else { return }
                self.onFocusChange?()
                self.attachToFrontmost()
            }
        microphoneChanged()
    }

    func stop() {
        guard running else { return }
        running = false
        microphone.onChange = nil
        microphone.stop()
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        detachTimer?.invalidate()
        detachTimer = nil
        sessionUntil = .distantPast
        AccessibilityWork.queue.async { [self] in detach() }
    }

    private func microphoneChanged() {
        listeningStateChanged()
    }

    /// Watches the frontmost app while listening, and checks again when the
    /// listening would end.
    private func listeningStateChanged() {
        guard running else { return }
        detachTimer?.invalidate()
        detachTimer = nil
        onListeningChange?()
        guard isListening else {
            AccessibilityWork.queue.async { [self] in detach() }
            return
        }
        attachToFrontmost()
        // A live microphone says itself when it stops.
        if microphone.isLive { return }
        let ends = max(sessionUntil, microphone.stoppedAt.addingTimeInterval(Self.afterRecording))
        detachTimer = Timer.scheduledTimer(withTimeInterval: max(0.1, ends.timeIntervalSinceNow), repeats: false) { [weak self] _ in
            self?.detachTimer = nil
            self?.listeningStateChanged()
        }
    }

    private func attachToFrontmost() {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        let pid = app.processIdentifier
        AccessibilityWork.queue.async { [weak self] in self?.attach(pid: pid) }
    }

    /// Delivered on the main run loop.
    private func observed(_ element: AXUIElement, _ notification: String) {
        guard isListening else { return }
        dictationLog.debug("reported \(notification, privacy: .public)")
        if notification == kAXFocusedUIElementChangedNotification as String {
            onFocusChange?()
            AccessibilityWork.queue.async { [weak self] in self?.observeFocusedElement() }
            return
        }
        onValueChange?(element)
    }

    // MARK: Accessibility queue

    private func attach(pid: pid_t) {
        guard observedPID != pid else { return }
        detach()
        var created: AXObserver?
        guard AXObserverCreate(pid, { _, element, notification, refcon in
            guard let refcon else { return }
            Unmanaged<DictationWatch>.fromOpaque(refcon).takeUnretainedValue()
                .observed(element, notification as String)
        }, &created) == .success, let created else { return }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.4)
        // Electron and Chromium publish their tree, and its changes, only once asked.
        _ = HostAccessibilityMode.shared.prime(pid: pid, application: application)
        observer = created
        observedPID = pid
        observedApplication = application
        // Most apps report a change to any of their elements to an observer
        // of the app itself; the focused field is watched too for those that don't.
        let added = [kAXValueChangedNotification, kAXFocusedUIElementChangedNotification].map { name in
            AXObserverAddNotification(created, application, name as CFString, owner).rawValue
        }
        dictationLog.debug("watching pid \(pid, privacy: .public): app notifications \(added, privacy: .public)")
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        observeFocusedElement()
    }

    private func observeFocusedElement() {
        guard let observer, let application = observedApplication else { return }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return }
        let focused = value as! AXUIElement
        if let observedFocus, CFEqual(observedFocus, focused) { return }
        if let observedFocus {
            AXObserverRemoveNotification(observer, observedFocus, kAXValueChangedNotification as CFString)
        }
        observedFocus = focused
        let added = AXObserverAddNotification(observer, focused, kAXValueChangedNotification as CFString, owner)
        dictationLog.debug("watching focused element: \(added.rawValue, privacy: .public)")
    }

    private func detach() {
        if let observer {
            if let application = observedApplication {
                for name in [kAXValueChangedNotification, kAXFocusedUIElementChangedNotification] {
                    AXObserverRemoveNotification(observer, application, name as CFString)
                }
            }
            if let observedFocus {
                AXObserverRemoveNotification(observer, observedFocus, kAXValueChangedNotification as CFString)
            }
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        observedPID = nil
        observedApplication = nil
        observedFocus = nil
    }

    /// The watch lives as long as the assistant that owns it, for the whole run.
    private var owner: UnsafeMutableRawPointer { Unmanaged.passUnretained(self).toOpaque() }
}
