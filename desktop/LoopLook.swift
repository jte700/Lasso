// The Loop's look, shared with the website rework: a near-black page, warm
// white type in Figtree set medium with tight tracking, soft rounded panels
// and the mascot's own colours. The window is dark whatever the Mac is set to.

import Cocoa
import CoreText
import SwiftUI

enum LoopLook {
    // MARK: Colours, as the website names them

    static let page = rgb(0x0B0B0A)
    static let panel = rgb(0x151513)
    static let raise = rgb(0x1F1F1C)
    static let lift = rgb(0x2A2A26)
    static let ink = rgb(0xF6F4EC)
    static let ink2 = rgb(0xF6F4EC, 0.64)
    static let ink3 = rgb(0xF6F4EC, 0.42)
    static let line = rgb(0xF6F4EC, 0.11)
    static let line2 = rgb(0xF6F4EC, 0.065)
    static let track = rgb(0xF6F4EC, 0.1)
    /// What is written on a button filled with `ink`.
    static let onInk = rgb(0x0B0B0A)

    // The mascot's palette.
    static let sky = rgb(0x8EC5F4)
    static let onSky = rgb(0x0B1A28)
    static let lime = rgb(0xD4F75C)
    static let rope = rgb(0xD7BD85)
    static let sage = rgb(0x91A984)
    static let terracotta = rgb(0xC96749)
    static let forest = rgb(0x2F4322)
    static let cream = rgb(0xF1EACB)
    /// The same colours let down with white, for large fills that carry dark type.
    static let skySoft = rgb(0xB9D6F2)
    static let ropeSoft = rgb(0xE2D2AC)
    static let sageSoft = rgb(0xB4C7A8)
    static let terracottaSoft = rgb(0xE5B19C)

    static let nsPage = NSColor(srgbRed: 0x0B / 255, green: 0x0B / 255, blue: 0x0A / 255, alpha: 1)

    static func rgb(_ hex: Int, _ alpha: Double = 1) -> Color {
        Color(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }

    // MARK: Shape and motion

    static let cardRadius: CGFloat = 18
    static let rowRadius: CGFloat = 11
    /// The website's spring: quick off the mark, long to settle.
    static let spring = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.6)

    // MARK: Type

    enum Weight {
        case regular, medium, semibold, bold

        var face: String {
            switch self {
            case .regular: return "Regular"
            case .medium: return "Medium"
            case .semibold: return "SemiBold"
            case .bold: return "Bold"
            }
        }

        var value: CGFloat {
            switch self {
            case .regular: return 400
            case .medium: return 500
            case .semibold: return 600
            case .bold: return 700
            }
        }

        var system: NSFont.Weight {
            switch self {
            case .regular: return .regular
            case .medium: return .medium
            case .semibold: return .semibold
            case .bold: return .bold
            }
        }
    }

    /// Figtree, the website's typeface, when the app carries it; the system's otherwise.
    static func font(_ size: CGFloat, _ weight: Weight = .regular) -> Font { Font(nsFont(size, weight) as CTFont) }

    static func nsFont(_ size: CGFloat, _ weight: Weight = .regular) -> NSFont {
        guard has(family) else { return .systemFont(ofSize: size, weight: weight.system) }
        return face(family, size, weight)
    }

    /// The one typeface The Loop draws its words in, as the website does.
    static let family = "Figtree"
    /// 'wght', as variable fonts number their axes.
    private static let weightAxis = 0x7767_6874
    private static var found: [String: Bool] = [:]
    private static var variable: [String: Bool] = [:]

    /// Whether Figtree can be drawn: found among the app's fonts, or installed on this Mac.
    static var hasFigtree: Bool { has(family) }
    static var figtreeIsVariable: Bool { has(family) && variable[family] == true }

    /// Whether a family can be drawn, once the app's own fonts are registered.
    static func has(_ name: String) -> Bool {
        _ = bundled
        if let known = found[name] { return known }
        let present = NSFontManager.shared.availableFontFamilies.contains(name)
        found[name] = present
        if present {
            let font = CTFontCreateWithName(name as CFString, 12, nil)
            variable[name] = (CTFontCopyVariationAxes(font) as? [Any])?.isEmpty == false
        }
        return present
    }

    /// One weight of a family: a variable font is asked for a place on its
    /// weight axis; separate files per weight answer to their own names.
    private static func face(_ name: String, _ size: CGFloat, _ weight: Weight) -> NSFont {
        if variable[name] != true,
           let named = NSFont(name: name.replacingOccurrences(of: " ", with: "") + "-" + weight.face, size: size) {
            return named
        }
        let attributes: [CFString: Any] = [kCTFontFamilyNameAttribute: name,
                                           kCTFontVariationAttribute: [weightAxis: weight.value]]
        return CTFontCreateWithFontDescriptor(CTFontDescriptorCreateWithAttributes(attributes as CFDictionary), size, nil)
    }

    /// The app's own fonts, registered once for this app alone; nothing is installed on the Mac.
    private static let bundled: Bool = {
        if let folder = Bundle.main.resourceURL?.appendingPathComponent("Fonts", isDirectory: true) { registerFiles(in: folder) }
        return true
    }()

    /// Registers the fonts in a folder, as a scratch runner does with desktop/Fonts.
    @discardableResult
    static func register(fontsIn folder: URL) -> Bool {
        _ = bundled
        registerFiles(in: folder)
        found.removeAll()
        variable.removeAll()
        return has(family)
    }

    private static func registerFiles(in folder: URL) {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        for file in files where ["ttf", "otf"].contains(file.pathExtension.lowercased()) {
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
    }
}

extension Text {
    /// Tracking as the website sets it, in ems: tight on headings, barely there on body text.
    func loopTracking(_ em: CGFloat, size: CGFloat) -> Text { tracking(em * size) }
}

extension View {
    /// The window's dark look, for views that draw with the system's colours.
    func loopDark() -> some View { environment(\.colorScheme, .dark) }
}
