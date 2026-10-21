//  Lasso Launcher: starts Lasso at login, and again with ⌘L after it quits.
//
//  build.sh compiles this on its own into a small background app inside
//  Lasso.app/Contents/Library/LoginItems, so it keeps running when Lasso
//  quits. It holds ⌘L only while Lasso is not running; the rest of the time
//  ⌘L reaches other apps as usual.

import Cocoa
import Carbon.HIToolbox

final class Launcher: NSObject, NSApplicationDelegate {
    /// Lasso.app, four levels up from Contents/Library/LoginItems/<this>.app.
    private let lassoURL = Bundle.main.bundleURL
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    private var lassoIdentifier: String?
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var runningApps: NSKeyValueObservation?
    private static let hotKeyID = EventHotKeyID(signature: OSType(0x4C53_534F), id: 1) // 'LSSO'

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let identifier = Bundle(url: lassoURL)?.bundleIdentifier else {
            NSLog("Lasso Launcher found no Lasso at %@", lassoURL.path)
            NSApp.terminate(nil)
            return
        }
        // One launcher is enough; a second would start Lasso twice on ⌘L.
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && !$0.isTerminated }
        guard others.isEmpty else {
            NSApp.terminate(nil)
            return
        }
        lassoIdentifier = identifier
        installHandler()
        // NSWorkspace posts no launch or quit notifications for an app without
        // a Dock icon, such as Lasso; the list of running apps still changes.
        runningApps = NSWorkspace.shared.observe(\.runningApplications) { [weak self] _, _ in
            DispatchQueue.main.async { self?.update() }
        }
        // At login only the launcher starts; Lasso is on unless the user quits it.
        if !isLassoRunning { launchLasso() }
        update()
    }

    private var isLassoRunning: Bool {
        guard let lassoIdentifier else { return false }
        return NSRunningApplication.runningApplications(withBundleIdentifier: lassoIdentifier)
            .contains { !$0.isTerminated }
    }

    /// Holds ⌘L while Lasso is off and lets it go as soon as Lasso runs.
    private func update() {
        if isLassoRunning {
            if let hotKey { UnregisterEventHotKey(hotKey) }
            hotKey = nil
        } else if hotKey == nil {
            var registered: EventHotKeyRef?
            let status = RegisterEventHotKey(UInt32(kVK_ANSI_L), UInt32(cmdKey), Self.hotKeyID,
                                             GetApplicationEventTarget(), 0, &registered)
            if status == noErr { hotKey = registered } else { NSLog("Lasso Launcher could not hold ⌘L (%d)", status) }
        }
    }

    private func installHandler() {
        var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return OSStatus(eventNotHandledErr) }
            let launcher = Unmanaged<Launcher>.fromOpaque(context).takeUnretainedValue()
            DispatchQueue.main.async { launcher.launchLasso() }
            return noErr
        }, 1, &pressed, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    private func launchLasso() {
        guard !isLassoRunning else { return }
        // Lasso was deleted or moved away from this launcher.
        guard FileManager.default.fileExists(atPath: lassoURL.path) else {
            NSApp.terminate(nil)
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: lassoURL, configuration: configuration) { _, error in
            if let error { NSLog("Lasso Launcher could not start Lasso: %@", error.localizedDescription) }
        }
    }
}

let application = NSApplication.shared
// Held for the lifetime of run(), which only returns on quit.
let launcher = Launcher()
application.delegate = launcher
application.run()
