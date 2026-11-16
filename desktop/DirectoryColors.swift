import Cocoa

/// A folder's highlight colour: one of Lasso's six, or a colour of the user's own,
/// kept as its hex. The raw value is what preferences store: a preset's name
/// ("blue") or a hex ("#3C7A28"), so colours saved before custom ones existed
/// still read back as they were.
struct DirectoryToggleColor: Hashable {
    let rawValue: String

    static let blue = DirectoryToggleColor(preset: "blue")
    static let teal = DirectoryToggleColor(preset: "teal")
    static let green = DirectoryToggleColor(preset: "green")
    static let orange = DirectoryToggleColor(preset: "orange")
    static let pink = DirectoryToggleColor(preset: "pink")
    static let purple = DirectoryToggleColor(preset: "purple")

    /// Lasso's own colours, in the order the picker shows them.
    static let allCases: [DirectoryToggleColor] = [.blue, .teal, .green, .orange, .pink, .purple]

    private static let presetComponents: [String: (CGFloat, CGFloat, CGFloat)] = [
        "blue": (0.09, 0.49, 1.0),
        "teal": (0.14, 0.72, 0.72),
        "green": (0.20, 0.76, 0.39),
        "orange": (1.0, 0.59, 0.18),
        "pink": (0.94, 0.34, 0.61),
        "purple": (0.66, 0.39, 0.94),
    ]

    private init(preset name: String) { rawValue = name }

    /// A preset's name or a six-digit hex with its #; anything else is not a colour.
    init?(rawValue: String) {
        if Self.presetComponents[rawValue] != nil {
            self.rawValue = rawValue
        } else if let rgb = Self.components(hex: rawValue) {
            self.rawValue = Self.hex(rgb)
        } else {
            return nil
        }
    }

    /// A colour of one's own from its sRGB components, from 0 to 1.
    init(red: CGFloat, green: CGFloat, blue: CGFloat) {
        rawValue = Self.hex((red, green, blue))
    }

    var isCustom: Bool { Self.presetComponents[rawValue] == nil }

    /// A preset's name, or a custom colour's hex.
    var title: String { isCustom ? rawValue : rawValue.capitalized }

    /// The hex of any colour, presets included.
    var hex: String { isCustom ? rawValue : Self.hex(components) }

    var components: (red: CGFloat, green: CGFloat, blue: CGFloat) {
        let rgb = Self.presetComponents[rawValue] ?? Self.components(hex: rawValue) ?? (0, 0, 0)
        return (rgb.0, rgb.1, rgb.2)
    }

    var color: NSColor {
        let rgb = components
        return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
    }

    /// The preset with this exact hex, so a custom colour that matches one is that preset.
    var matchingPreset: DirectoryToggleColor? {
        Self.allCases.first { $0.hex == hex }
    }

    /// The presets, then the colours of one's own in use, for a menu of choices.
    static func choices(including extra: DirectoryToggleColor?...) -> [DirectoryToggleColor] {
        var list = allCases
        for color in extra.compactMap({ $0 }) where !list.contains(color) { list.append(color) }
        return list
    }

    /// A dot of the colour, kept in colour in a menu.
    func swatch(size: CGFloat = 12) -> NSImage {
        let fill = color
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            fill.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5)).fill()
            return true
        }
        image.isTemplate = false
        return image
    }

    private static func components(hex: String) -> (CGFloat, CGFloat, CGFloat)? {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return (CGFloat((value >> 16) & 0xFF) / 255, CGFloat((value >> 8) & 0xFF) / 255, CGFloat(value & 0xFF) / 255)
    }

    private static func hex(_ rgb: (CGFloat, CGFloat, CGFloat)) -> String {
        func byte(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(rgb.0), byte(rgb.1), byte(rgb.2))
    }
}

extension Notification.Name {
    static let directoryColorsDidChange = Notification.Name("LassoDirectoryColorsDidChange")
}

/// The menu and source references resolve the same live preference by owner.
enum DirectoryColorPreferences {
    private static let key = "DirectoryToggleColors"
    private static let defaultKey = "DefaultDirectoryColor"
    private static let customKey = "LastCustomDirectoryColor"

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

    /// The colour a folder was given itself, or nil when it shows the default.
    static func ownColor(for projectId: String, defaults: UserDefaults = .standard) -> DirectoryToggleColor? {
        let colors = defaults.dictionary(forKey: key) as? [String: String] ?? [:]
        return colors[projectId].flatMap(DirectoryToggleColor.init(rawValue:))
    }

    /// Nil puts the folder back on the default colour.
    static func set(_ color: DirectoryToggleColor?, for projectId: String, defaults: UserDefaults = .standard) {
        guard !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var colors = defaults.dictionary(forKey: key) as? [String: String] ?? [:]
        guard colors[projectId] != color?.rawValue else { return }
        colors[projectId] = color?.rawValue
        defaults.set(colors, forKey: key)
        NotificationCenter.default.post(name: .directoryColorsDidChange, object: nil)
    }

    /// The last colour of their own the user made, offered in every folder's picker.
    static func lastCustom(_ defaults: UserDefaults = .standard) -> DirectoryToggleColor? {
        defaults.string(forKey: customKey).flatMap(DirectoryToggleColor.init(rawValue:)).flatMap { $0.isCustom ? $0 : nil }
    }

    static func rememberCustom(_ color: DirectoryToggleColor, defaults: UserDefaults = .standard) {
        guard color.isCustom, lastCustom(defaults) != color else { return }
        defaults.set(color.rawValue, forKey: customKey)
    }
}
