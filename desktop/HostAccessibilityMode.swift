//  Asking an app to publish its accessibility tree.
//
//  Electron and Chromium build that tree only once a client asks for it.
//  AXManualAccessibility asks without side effects. AXEnhancedUserInterface
//  also works on Chromium builds that ignore the manual flag, but it tells the
//  app that VoiceOver is running: its windows then animate every move, which
//  makes them sluggish and stalls window tiling tools. It is therefore set only
//  for Chromium builds that refuse the manual flag, and turned off again when
//  suggestions stop. The apps it was set for are remembered across launches,
//  so a quit or crash before it was turned off does not leave it on for good.

import Cocoa
import ApplicationServices

final class HostAccessibilityMode {
    static let shared = HostAccessibilityMode()
    static let manualAttribute = "AXManualAccessibility"
    static let enhancedAttribute = "AXEnhancedUserInterface"

    typealias SetFlag = (AXUIElement, String, Bool) -> AXError
    typealias ReadFlag = (AXUIElement, String) -> Bool
    private static let ownedBundlesKey = "AccessibilityEnhancedBundles"

    private let setFlag: SetFlag
    private let readFlag: ReadFlag
    private let chromiumBased: (pid_t) -> Bool
    private let bundleIdentifier: (pid_t) -> String?
    private let defaults: UserDefaults
    /// Priming runs on the Accessibility queue and, during insertion, on the
    /// main thread. The lock is never held across an Accessibility call.
    private let lock = NSLock()
    private var primed = Set<pid_t>()
    /// Apps whose enhanced flag Lasso turned on, so it can turn it off.
    private var enhanced: [pid_t: (application: AXUIElement, bundle: String?)] = [:]

    init(setFlag: @escaping SetFlag = HostAccessibilityMode.writeFlag,
         readFlag: @escaping ReadFlag = HostAccessibilityMode.currentFlag,
         chromiumBased: @escaping (pid_t) -> Bool = { pid in
             HostAccessibilityMode.isChromiumBased(
                 bundleURL: NSRunningApplication(processIdentifier: pid)?.bundleURL)
         },
         bundleIdentifier: @escaping (pid_t) -> String? = { pid in
             NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
         },
         defaults: UserDefaults = .standard) {
        self.setFlag = setFlag
        self.readFlag = readFlag
        self.chromiumBased = chromiumBased
        self.bundleIdentifier = bundleIdentifier
        self.defaults = defaults
    }

    static func needsEnhancedInterface(manualAccepted: Bool, chromiumBased: Bool) -> Bool {
        !manualAccepted && chromiumBased
    }

    /// Chromium, its browsers and Electron all ship Chromium's resource packs
    /// inside a framework.
    static func isChromiumBased(bundleURL: URL?) -> Bool {
        guard let frameworks = bundleURL?.appendingPathComponent("Contents/Frameworks", isDirectory: true),
              let entries = try? FileManager.default.contentsOfDirectory(
                  at: frameworks, includingPropertiesForKeys: nil) else { return false }
        let layouts = ["Resources", "Versions/Current/Resources", "Versions/A/Resources"]
        return entries.contains { framework in
            framework.pathExtension == "framework" && layouts.contains { layout in
                FileManager.default.fileExists(atPath: framework
                    .appendingPathComponent(layout)
                    .appendingPathComponent("chrome_100_percent.pak").path)
            }
        }
    }

    /// Asks a newly focused app for its accessibility tree, once per process.
    /// Returns a line for the typing log the first time, nil afterwards.
    func prime(pid: pid_t, application: AXUIElement) -> String? {
        lock.lock()
        let first = primed.insert(pid).inserted
        lock.unlock()
        guard first else { return nil }

        let manual = setFlag(application, Self.manualAttribute, true) == .success
        guard Self.needsEnhancedInterface(manualAccepted: manual, chromiumBased: chromiumBased(pid)) else {
            return "accessibility mode: \(manual ? "manual" : "native")"
        }
        let bundle = bundleIdentifier(pid)
        if readFlag(application, Self.enhancedAttribute) {
            // Left on by a run of Lasso that ended before turning it off.
            // Otherwise VoiceOver or another tool relies on it, and it stays theirs.
            guard let bundle, ownedBundles().contains(bundle) else {
                return "accessibility mode: enhanced (already on)"
            }
            remember(pid: pid, application: application, bundle: bundle)
            return "accessibility mode: enhanced (left on by an earlier run)"
        }
        guard setFlag(application, Self.enhancedAttribute, true) == .success else {
            return "accessibility mode: enhanced refused"
        }
        remember(pid: pid, application: application, bundle: bundle)
        return "accessibility mode: enhanced"
    }

    private func ownedBundles() -> Set<String> {
        Set(defaults.stringArray(forKey: Self.ownedBundlesKey) ?? [])
    }

    private func remember(pid: pid_t, application: AXUIElement, bundle: String?) {
        lock.lock()
        enhanced[pid] = (application, bundle)
        if let bundle {
            defaults.set(Array(ownedBundles().union([bundle])).sorted(), forKey: Self.ownedBundlesKey)
        }
        lock.unlock()
    }

    private func release(bundles: [String?]) {
        let released = Set(bundles.compactMap { $0 })
        guard !released.isEmpty else { return }
        defaults.set(Array(ownedBundles().subtracting(released)).sorted(), forKey: Self.ownedBundlesKey)
    }

    /// Turns off every enhanced flag Lasso set and forgets which apps were
    /// primed, so enabling suggestions again starts over.
    @discardableResult
    func restoreAll() -> Int {
        lock.lock()
        let restoring = enhanced
        enhanced = [:]
        primed = []
        lock.unlock()
        for entry in restoring.values {
            _ = setFlag(entry.application, Self.enhancedAttribute, false)
        }
        lock.lock()
        release(bundles: restoring.values.map(\.bundle))
        lock.unlock()
        return restoring.count
    }

    /// A quit app takes its flag with it, and its process ID can be reused.
    func forget(pid: pid_t) {
        lock.lock()
        primed.remove(pid)
        if let entry = enhanced.removeValue(forKey: pid) { release(bundles: [entry.bundle]) }
        lock.unlock()
    }

    static func writeFlag(_ application: AXUIElement, _ attribute: String, _ value: Bool) -> AXError {
        AXUIElementSetAttributeValue(application, attribute as CFString, value ? kCFBooleanTrue : kCFBooleanFalse)
    }

    static func currentFlag(_ application: AXUIElement, _ attribute: String) -> Bool {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, attribute as CFString, &value) == .success else {
            return false
        }
        return (value as? Bool) == true
    }
}
