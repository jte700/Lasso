import Cocoa
import ServiceManagement

/// Keeps Lasso on. A small helper app inside the bundle (LassoLauncher.swift)
/// starts Lasso when the user logs in and, after the user quits Lasso, starts
/// it again with ⌘L. There is no switch for this: quitting turns Lasso off,
/// and Suggest While Typing turns off only its suggestions.
enum LaunchHelper {
    static let shortcut = "⌘L"

    /// Where build.sh puts the helper. SMAppService finds login items there.
    static let bundlePath = "Contents/Library/LoginItems/Lasso Launcher.app"

    enum State: Equatable {
        case on
        /// The user switched the helper off in System Settings, or macOS is
        /// waiting for them to allow it.
        case needsApproval
        /// This copy has no helper, or macOS refused to register it.
        case unavailable
    }

    private static var helperURL: URL { Bundle.main.bundleURL.appendingPathComponent(bundlePath) }

    private static var service: SMAppService? {
        Bundle(url: helperURL)?.bundleIdentifier.map { SMAppService.loginItem(identifier: $0) }
    }

    static var state: State {
        switch service?.status {
        case .enabled: return .on
        case .requiresApproval: return .needsApproval
        default: return .unavailable
        }
    }

    /// What Settings says about starting Lasso.
    static func note(for state: State) -> String {
        switch state {
        case .on:
            return "Lasso starts when you log in. After you quit it, press \(shortcut) to start it again."
        case .needsApproval:
            return "macOS is not letting Lasso run in the background, so it won\u{2019}t start at login or with \(shortcut). Allow Lasso in Login Items."
        case .unavailable:
            return "This copy of Lasso can\u{2019}t start itself at login or with \(shortcut)."
        }
    }

    /// Registers the helper the first time and makes sure it is running.
    static func start() {
        guard let service else { return }
        // Lasso used to be its own login item. The helper starts it now, and
        // two launches at login would open the menu as if Lasso were reopened.
        if SMAppService.mainApp.status == .enabled {
            do { try SMAppService.mainApp.unregister() } catch {
                NSLog("Lasso could not remove its old login item: %@", error.localizedDescription)
            }
        }
        switch service.status {
        case .enabled:
            break
        case .requiresApproval:
            // The user switched the helper off in System Settings; it stays off.
            return
        default:
            // Registering also starts the helper, so nothing is left to open.
            do { try service.register() } catch {
                NSLog("Lasso could not register its launcher: %@", error.localizedDescription)
            }
            return
        }
        // Registered on an earlier run, but quit or stopped since.
        guard let identifier = Bundle(url: helperURL)?.bundleIdentifier,
              NSRunningApplication.runningApplications(withBundleIdentifier: identifier).isEmpty else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: helperURL, configuration: configuration) { _, error in
            if let error { NSLog("Lasso could not start its launcher: %@", error.localizedDescription) }
        }
    }

    static func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}
