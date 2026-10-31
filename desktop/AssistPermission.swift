import Cocoa
import ApplicationServices

enum AssistPermission {
    static var hasAccessibility: Bool { AXIsProcessTrusted() }

    /// True when this build is not trusted even though a previous build was.
    /// Ad-hoc signatures make the designated requirement a cdhash, so every
    /// rebuild invalidates the stored approval while the row stays visible.
    static var isListedButUntrusted: Bool {
        !AXIsProcessTrusted() && UserDefaults.standard.bool(forKey: "AssistWasTrusted")
    }

    static func rememberTrusted() {
        if AXIsProcessTrusted() { UserDefaults.standard.set(true, forKey: "AssistWasTrusted") }
    }

    static func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    }

    static var hasInputMonitoring: Bool {
        IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
    }

    @discardableResult
    static func requestInputMonitoring() -> Bool {
        IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    }

    /// macOS prompts only while Input Monitoring is undetermined. Once it was
    /// denied, the request does nothing, so Settings is the only way forward.
    static func askForInputMonitoring() {
        if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeUnknown {
            requestInputMonitoring()
        } else {
            openSettings("Privacy_ListenEvent")
        }
    }

    static func openSettings(_ anchor: String) {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
        NSWorkspace.shared.open(url)
    }
}
