//  Trackpad pinches over the source inspector.
//
//  macOS sends gestures to the active app, while clicks, drags and scrolls go
//  to the window under the pointer. The inspector never activates Lasso, so a
//  pinch over its drawing reached the app being typed in instead. While the
//  inspector is open, a session tap takes the pinches made over it and hands
//  them to the main thread. Like the keyboard tap, it runs on its own thread
//  and only reads a region the main thread publishes.

import Cocoa

enum PinchRouting {
    /// A window frame in the tap's coordinates: Quartz screen space, whose
    /// origin is the top left of the primary display.
    static func quartzRect(for frame: NSRect, primaryScreenHeight: CGFloat) -> CGRect {
        CGRect(x: frame.minX, y: primaryScreenHeight - frame.maxY, width: frame.width, height: frame.height)
    }

    /// The Control + wheel delta browsers send for a pinch: Chromium's 100 per
    /// natural-log step of scale, negative when the fingers spread to zoom in.
    static func wheelDelta(forMagnification magnification: CGFloat) -> CGFloat? {
        guard magnification > -1, magnification != 0 else { return nil }
        return -100 * log(1 + magnification)
    }
}

/// Owns the pinch tap and the thread its run loop runs on. Started when the
/// inspector opens and stopped when it closes; opening it again creates a new tap.
final class PinchEventTap {
    /// Runs on the main thread with each pinch's magnification and Quartz location.
    private let perform: (CGFloat, CGPoint) -> Void
    private let lock = NSLock()
    private var claimed: CGRect?
    /// Set before the tap thread starts and never replaced, so the callback
    /// can read it without a lock.
    private var port: CFMachPort?
    private var source: CFRunLoopSource?
    private var runLoop: CFRunLoop?

    init(perform: @escaping (CGFloat, CGPoint) -> Void) {
        self.perform = perform
    }

    /// Where pinches belong to Lasso, in Quartz screen coordinates. Nil claims none.
    var region: CGRect? {
        get { lock.lock(); defer { lock.unlock() }; return claimed }
        set { lock.lock(); claimed = newValue; lock.unlock() }
    }

    /// False when macOS refused the tap, which means Accessibility is missing.
    func start() -> Bool {
        guard port == nil else { return false }
        // Trackpad gestures reach taps as gesture events; AppKit splits them
        // into magnify, rotate and swipe.
        let mask = NSEvent.EventTypeMask.gesture.rawValue | NSEvent.EventTypeMask.magnify.rawValue
        guard let created = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                return Unmanaged<PinchEventTap>.fromOpaque(refcon).takeUnretainedValue().handle(type, event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        port = created
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        self.source = source
        let ready = DispatchSemaphore(value: 0)
        // As with the keyboard tap, the thread keeps this owner alive until
        // its run loop returns.
        let thread = Thread { [self] in
            let loop = CFRunLoopGetCurrent()
            runLoop = loop
            CFRunLoopAddSource(loop, source, .defaultMode)
            CGEvent.tapEnable(tap: created, enable: true)
            ready.signal()
            CFRunLoopRun()
        }
        thread.name = "Lasso pinch tap"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
        return true
    }

    func stop() {
        region = nil
        if let port { CGEvent.tapEnable(tap: port, enable: false) }
        if let runLoop, let source {
            CFRunLoopRemoveSource(runLoop, source, .defaultMode)
            CFRunLoopStop(runLoop)
        }
        if let port { CFMachPortInvalidate(port) }
    }

    /// Runs on the tap thread. Takes only pinches over the claimed region;
    /// swipes between spaces and every other gesture pass on untouched.
    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let port { CGEvent.tapEnable(tap: port, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let location = event.location
        guard let region, region.contains(location) else { return Unmanaged.passUnretained(event) }
        // This thread's run loop never drains autoreleased events on its own.
        let magnification: CGFloat? = autoreleasepool {
            guard let gesture = NSEvent(cgEvent: event), gesture.type == .magnify else { return nil }
            return gesture.magnification
        }
        guard let magnification else { return Unmanaged.passUnretained(event) }
        DispatchQueue.main.async { [perform] in perform(magnification, location) }
        return nil
    }
}
