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
    private let electronBased: (pid_t) -> Bool
    private let bundleIdentifier: (pid_t) -> String?
    private let defaults: UserDefaults
    private let now: () -> Date
    /// Minimum wait between recovery attempts for one unreadable Chromium process.
    static let reprimeCooldown: TimeInterval = 2
    /// Priming runs on the Accessibility queue and, during insertion, on the
    /// main thread. The lock is never held across an Accessibility call.
    private let lock = NSLock()
    private var primed = Set<pid_t>()
    /// Processes that accepted AXManualAccessibility on initial prime.
    private var manualAccepted = Set<pid_t>()
    private var lastReprime: [pid_t: Date] = [:]
    /// Apps whose enhanced flag Lasso turned on, so it can turn it off.
    private var enhanced: [pid_t: (application: AXUIElement, bundle: String?)] = [:]

    init(setFlag: @escaping SetFlag = HostAccessibilityMode.writeFlag,
         readFlag: @escaping ReadFlag = HostAccessibilityMode.currentFlag,
         chromiumBased: @escaping (pid_t) -> Bool = { pid in
             let app = NSRunningApplication(processIdentifier: pid)
             return HostAccessibilityMode.isChromiumBundle(
                 bundleURL: app?.bundleURL, bundleIdentifier: app?.bundleIdentifier)
         },
         electronBased: @escaping (pid_t) -> Bool = { pid in
             HostAccessibilityMode.isElectronBased(
                 bundleURL: NSRunningApplication(processIdentifier: pid)?.bundleURL)
         },
         bundleIdentifier: @escaping (pid_t) -> String? = { pid in
             NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
         },
         defaults: UserDefaults = .standard,
         now: @escaping () -> Date = Date.init) {
        self.setFlag = setFlag
        self.readFlag = readFlag
        self.chromiumBased = chromiumBased
        self.electronBased = electronBased
        self.bundleIdentifier = bundleIdentifier
        self.defaults = defaults
        self.now = now
    }

    static func needsEnhancedInterface(manualAccepted: Bool, chromiumBased: Bool) -> Bool {
        !manualAccepted && chromiumBased
    }

    /// Chromium, its browsers, Chrome app shims and Electron all need priming.
    static func isChromiumBundle(bundleURL: URL?, bundleIdentifier: String?) -> Bool {
        if let bundleIdentifier,
           bundleIdentifier == "com.google.Chrome" || bundleIdentifier.hasPrefix("com.google.Chrome.") {
            return true
        }
        return isChromiumBased(bundleURL: bundleURL)
    }

    /// Electron apps bundle Electron Framework and support AXManualAccessibility
    /// without needing VoiceOver's AXEnhancedUserInterface flag.
    static func isElectronBased(bundleURL: URL?) -> Bool {
        guard let frameworks = bundleURL?.appendingPathComponent("Contents/Frameworks", isDirectory: true) else {
            return false
        }
        return FileManager.default.fileExists(
            atPath: frameworks.appendingPathComponent("Electron Framework.framework").path)
    }

    /// Chromium, its browsers and Electron all ship Chromium's resource packs
    /// inside a framework.
    static func isChromiumBased(bundleURL: URL?) -> Bool {
        guard let frameworks = bundleURL?.appendingPathComponent("Contents/Frameworks", isDirectory: true),
              let entries = try? FileManager.default.contentsOfDirectory(
                  at: frameworks, includingPropertiesForKeys: nil) else { return false }
        let layouts = ["Resources", "Versions/Current/Resources", "Versions/A/Resources"]
        return entries.contains { framework in
            guard framework.pathExtension == "framework" else { return false }
            if layouts.contains(where: { layout in
                FileManager.default.fileExists(atPath: framework
                    .appendingPathComponent(layout)
                    .appendingPathComponent("chrome_100_percent.pak").path)
            }) { return true }
            // Also check numbered Chromium version folders when no Current symlink is present.
            let versions = framework.appendingPathComponent("Versions", isDirectory: true)
            guard let versionEntries = try? FileManager.default.contentsOfDirectory(
                at: versions, includingPropertiesForKeys: nil) else { return false }
            return versionEntries.contains { version in
                FileManager.default.fileExists(atPath: version
                    .appendingPathComponent("Resources/chrome_100_percent.pak").path)
            }
        }
    }

    /// Asks a newly focused app for its accessibility tree, once per process.
    /// Returns a line for the typing log the first time, nil afterwards.
    /// Transient failures leave the process unprimed so the next read retries.
    func prime(pid: pid_t, application: AXUIElement) -> String? {
        lock.lock()
        let first = primed.insert(pid).inserted
        lock.unlock()
        guard first else { return nil }

        let manual = setFlag(application, Self.manualAttribute, true) == .success
        if manual {
            lock.lock()
            manualAccepted.insert(pid)
            lock.unlock()
        }
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
            lock.lock()
            primed.remove(pid)
            lock.unlock()
            return "accessibility mode: enhanced refused"
        }
        remember(pid: pid, application: application, bundle: bundle)
        return "accessibility mode: enhanced"
    }

    /// Recovers a Chromium process whose accessibility tree disappeared after
    /// initial priming (for example when a window manager or Chrome itself turns
    /// AXEnhancedUserInterface off, or when a browser accepted AXManualAccessibility
    /// without keeping it active). Throttled per process; returns true when it
    /// re-sent an activation flag so the caller can schedule a follow-up read.
    @discardableResult
    func reprimeIfUnreadable(pid: pid_t, application: AXUIElement) -> Bool {
        guard chromiumBased(pid) else { return false }
        let current = now()
        lock.lock()
        if let last = lastReprime[pid], current.timeIntervalSince(last) < Self.reprimeCooldown {
            lock.unlock()
            return false
        }
        lastReprime[pid] = current
        let usedManual = manualAccepted.contains(pid)
        lock.unlock()

        if usedManual {
            let reasserted = setFlag(application, Self.manualAttribute, true) == .success
            if !electronBased(pid), !readFlag(application, Self.manualAttribute),
               !readFlag(application, Self.enhancedAttribute) {
                if setFlag(application, Self.enhancedAttribute, true) == .success {
                    lock.lock()
                    manualAccepted.remove(pid)
                    lock.unlock()
                    remember(pid: pid, application: application, bundle: bundleIdentifier(pid))
                    return true
                }
            }
            return reasserted
        }
        guard !readFlag(application, Self.enhancedAttribute) else { return false }
        guard setFlag(application, Self.enhancedAttribute, true) == .success else { return false }
        remember(pid: pid, application: application, bundle: bundleIdentifier(pid))
        return true
    }

    /// Clears priming memory for running processes of `bundleIdentifier`, so
    /// switching an app back on in Settings starts fresh.
    func forget(bundleIdentifier target: String) {
        let pids = NSRunningApplication.runningApplications(withBundleIdentifier: target).map(\.processIdentifier)
        guard !pids.isEmpty else { return }
        lock.lock()
        for pid in pids {
            primed.remove(pid)
            manualAccepted.remove(pid)
            lastReprime.removeValue(forKey: pid)
        }
        lock.unlock()
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
        manualAccepted = []
        lastReprime = [:]
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
        manualAccepted.remove(pid)
        lastReprime.removeValue(forKey: pid)
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
