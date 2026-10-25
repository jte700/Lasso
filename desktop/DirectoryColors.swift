import Cocoa

enum DirectoryToggleColor: String, CaseIterable {
    case blue, teal, green, orange, pink, purple

    var title: String { rawValue.capitalized }

    var color: NSColor {
        let rgb: (CGFloat, CGFloat, CGFloat)
        switch self {
        case .blue: rgb = (0.09, 0.49, 1.0)
        case .teal: rgb = (0.14, 0.72, 0.72)
        case .green: rgb = (0.20, 0.76, 0.39)
        case .orange: rgb = (1.0, 0.59, 0.18)
        case .pink: rgb = (0.94, 0.34, 0.61)
        case .purple: rgb = (0.66, 0.39, 0.94)
        }
        return NSColor(srgbRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1)
    }

    /// A dot of the colour, kept in colour in a menu.
    func swatch(size: CGFloat = 12) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5)).fill()
            return true
        }
        image.isTemplate = false
        return image
    }
}

extension Notification.Name {
    static let directoryColorsDidChange = Notification.Name("LassoDirectoryColorsDidChange")
}

/// The menu and source references resolve the same live preference by owner.
enum DirectoryColorPreferences {
    private static let key = "DirectoryToggleColors"
    private static let defaultKey = "DefaultDirectoryColor"

    static func color(for projectId: String?, defaults: UserDefaults = .standard) -> DirectoryToggleColor? {
        guard let projectId, !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let colors = defaults.dictionary(forKey: key) as? [String: String] ?? [:]
        return colors[projectId].flatMap(DirectoryToggleColor.init(rawValue:)) ?? defaultColor(defaults)
    }

    /// The colour of every folder not given its own, chosen in Settings.
    static func defaultColor(_ defaults: UserDefaults = .standard) -> DirectoryToggleColor {
        defaults.string(forKey: defaultKey).flatMap(DirectoryToggleColor.init(rawValue:)) ?? .blue
    }

    static func setDefault(_ color: DirectoryToggleColor, defaults: UserDefaults = .standard) {
        guard defaultColor(defaults) != color else { return }
        defaults.set(color.rawValue, forKey: defaultKey)
        NotificationCenter.default.post(name: .directoryColorsDidChange, object: nil)
    }

    static func set(_ color: DirectoryToggleColor, for projectId: String, defaults: UserDefaults = .standard) {
        guard !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var colors = defaults.dictionary(forKey: key) as? [String: String] ?? [:]
        guard colors[projectId] != color.rawValue else { return }
        colors[projectId] = color.rawValue
        defaults.set(colors, forKey: key)
        NotificationCenter.default.post(name: .directoryColorsDidChange, object: nil)
    }
}
