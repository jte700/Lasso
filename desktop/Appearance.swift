import Cocoa

/// Light or dark for Lasso's own menu, suggestions and windows, chosen in
/// Settings. System follows macOS. The notch stays black either way.
enum AppearancePreference: String, CaseIterable {
    case system, light, dark

    private static let key = "Appearance"

    var title: String {
        switch self {
        case .system: return "Match System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    /// nil lets every window follow macOS.
    var appearance: NSAppearance? {
        switch self {
        case .system: return nil
        case .light: return NSAppearance(named: .aqua)
        case .dark: return NSAppearance(named: .darkAqua)
        }
    }

    static func current(_ defaults: UserDefaults = .standard) -> AppearancePreference {
        defaults.string(forKey: key).flatMap(AppearancePreference.init(rawValue:)) ?? .system
    }

    static func set(_ preference: AppearancePreference, defaults: UserDefaults = .standard) {
        defaults.set(preference.rawValue, forKey: key)
        apply(defaults)
    }

    /// Open windows and panels redraw in the new appearance at once.
    static func apply(_ defaults: UserDefaults = .standard) {
        NSApp.appearance = current(defaults).appearance
    }
}
