//  How a linked phrase is drawn over the host's own letters: the host's font,
//  read over Accessibility and fitted to where the host drew the words, the
//  lines a wrapped phrase runs over, and the colours of the pill behind it.
//
//  The host's document is never restyled. Lasso covers the words with a pill
//  of the page's colour and draws them again in the source's colour, only when
//  it can match them; otherwise the pill is a tint and the host's letters show.

import Cocoa
import CoreText
import UniformTypeIdentifiers

/// The font and colours the host draws a phrase in, as far as it says.
struct HostTextStyle: Equatable {
    var fontName: String? = nil
    var fontFamily: String? = nil
    var fontSize: CGFloat? = nil
    var foreground: NSColor? = nil
    var background: NSColor? = nil

    /// Reads the attributes of the phrase's first character, in the keys
    /// Accessibility uses or, from some hosts, AppKit's own.
    static func read(from attributed: NSAttributedString) -> HostTextStyle {
        guard attributed.length > 0 else { return HostTextStyle() }
        let attributes = attributed.attributes(at: 0, effectiveRange: nil)
        var style = HostTextStyle()
        if let font = attributes[NSAttributedString.Key("AXFont")] as? [String: Any] {
            style.fontName = font["AXFontName"] as? String
            style.fontFamily = font["AXFontFamily"] as? String
            style.fontSize = (font["AXFontSize"] as? NSNumber).map { CGFloat($0.doubleValue) }
        } else if let font = attributes[.font] as? NSFont {
            style.fontName = font.fontName
            style.fontFamily = font.familyName
            style.fontSize = font.pointSize
        }
        style.foreground = color(attributes[NSAttributedString.Key("AXForegroundColor")])
            ?? attributes[.foregroundColor] as? NSColor
        style.background = color(attributes[NSAttributedString.Key("AXBackgroundColor")])
            ?? attributes[.backgroundColor] as? NSColor
        return style
    }

    private static func color(_ value: Any?) -> NSColor? {
        guard let value else { return nil }
        if let color = value as? NSColor { return color }
        let object = value as CFTypeRef
        guard CFGetTypeID(object) == CGColor.typeID else { return nil }
        return NSColor(cgColor: object as! CGColor)
    }

    /// The host's font at `size`, or nil when it names none this Mac has.
    func font(size: CGFloat) -> NSFont? {
        if let fontName, let font = NSFont(name: fontName, size: size) { return font }
        if let fontFamily, let font = NSFontManager.shared.font(withFamily: fontFamily, traits: [], weight: 5, size: size) {
            return font
        }
        return nil
    }
}

/// One line of a linked phrase as Lasso draws it.
struct ChipLine: Equatable {
    /// Where the host drew these words, in screen coordinates.
    let rect: CGRect
    let text: String
    let font: NSFont
    /// The horizontal stretch that makes the words span exactly the host's width.
    let stretch: CGFloat
    /// The baseline's height on screen.
    let baseline: CGFloat

    /// The pill's height: the font's own line, never the paragraph spacing a
    /// host can report as part of it.
    var textHeight: CGFloat { ceil(font.ascender - font.descender + font.leading) }
}

enum ReferenceChipLayout {
    /// How far a redrawn line may be stretched or squeezed to the host's width.
    /// Further than that, the font is not the host's, and its letters stay.
    static let stretchLimit: ClosedRange<CGFloat> = 0.9...1.1
    /// How far the fitted size may sit from the size the host states, or from
    /// what its line height suggests when it states none.
    static let sizeLimit: ClosedRange<CGFloat> = 0.7...1.4
    /// A line box is about this many times its font's size.
    static let lineHeightRatio: CGFloat = 1.22

    /// The phrase split over the host's lines, in the host's font fitted to
    /// them, or nil when Lasso cannot match the host's letters and should
    /// leave them showing.
    static func lines(text: String, fragments: [CGRect], style: HostTextStyle?) -> [ChipLine]? {
        guard !fragments.isEmpty, !text.contains(where: \.isNewline),
              !text.trimmingCharacters(in: .whitespaces).isEmpty,
              let lineHeight = fragments.map(\.height).min(), lineHeight > 2 else { return nil }
        let fromHeight = lineHeight / lineHeightRatio
        let stated = style?.fontSize.flatMap { $0 > 2 ? $0 : nil }
        let expected = stated ?? fromHeight
        let probe = style?.font(size: expected) ?? NSFont.systemFont(ofSize: expected)
        guard let texts = fragments.count == 1 ? [text] : split(text, into: fragments.map(\.width), font: probe) else {
            return nil
        }
        let drawn = texts.map { $0.trimmingCharacters(in: .whitespaces) }
        let natural = drawn.map { width($0, probe) }.reduce(0, +)
        let host = fragments.map(\.width).reduce(0, +)
        guard natural > 0, host > 0 else { return nil }
        let size = expected * host / natural
        guard sizeLimit.contains(size / expected) else { return nil }
        let font = style?.font(size: size) ?? NSFont.systemFont(ofSize: size)
        var lines: [ChipLine] = []
        for (rect, words) in zip(fragments, drawn) {
            let measured = width(words, font)
            guard measured > 0 else { return nil }
            let stretch = rect.width / measured
            guard stretchLimit.contains(stretch) else { return nil }
            lines.append(ChipLine(rect: rect, text: words, font: font, stretch: stretch,
                                  baseline: rect.midY - (font.ascender + font.descender) / 2))
        }
        return lines
    }

    /// Splits a wrapped phrase where the host did, from how wide each of its
    /// lines is: a line ends after the last word that fits. Nil when the words
    /// cannot be shared out that way.
    static func split(_ text: String, into widths: [CGFloat], font: NSFont) -> [String]? {
        let pieces = words(text)
        guard pieces.count >= widths.count else { return nil }
        let natural = pieces.map { width($0, font) }
        let total = natural.reduce(0, +)
        let host = widths.reduce(0, +)
        guard total > 0, host > 0 else { return nil }
        // The host's widths leave out the space each wrapped line ends with.
        let scale = host / max(1, total - width(" ", font) * CGFloat(widths.count - 1))
        var lines: [String] = []
        var index = 0
        for (line, available) in widths.enumerated() {
            let remainingLines = widths.count - line - 1
            if remainingLines == 0 {
                guard index < pieces.count else { return nil }
                lines.append(pieces[index...].joined())
                break
            }
            var text = ""
            var used: CGFloat = 0
            let tolerance = max(2, available * 0.04)
            while index < pieces.count, pieces.count - index > remainingLines {
                let ink = width(pieces[index].trimmingCharacters(in: .whitespaces), font) * scale
                if !text.isEmpty, used + ink > available + tolerance { break }
                text += pieces[index]
                used += natural[index] * scale
                index += 1
            }
            guard !text.isEmpty else { return nil }
            lines.append(text)
        }
        return lines.count == widths.count ? lines : nil
    }

    /// Words, each with the spaces after it.
    static func words(_ text: String) -> [String] {
        var pieces: [String] = []
        var current = ""
        var inSpace = false
        for character in text {
            if character == " " {
                inSpace = true
                current.append(character)
            } else {
                if inSpace { pieces.append(current); current = ""; inSpace = false }
                current.append(character)
            }
        }
        if !current.isEmpty { pieces.append(current) }
        return pieces
    }

    static func width(_ text: String, _ font: NSFont) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
        return CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    }
}

/// The colours of a pill: the host's page under a wash of the source's colour,
/// and the words in that colour, dark enough to read.
enum ReferenceChipPalette {
    /// How much of the source's colour tints the pill: a pale wash with no
    /// outline, a little deeper under the pointer. A dark page needs more of
    /// it for the pill to show at all.
    static func wash(page: NSColor, hover: CGFloat) -> CGFloat {
        let dark = luminance(srgb(page) ?? page) < 0.45
        let resting: CGFloat = dark ? 0.15 : 0.07
        let hovered: CGFloat = dark ? 0.23 : 0.12
        return resting + (hovered - resting) * hover
    }

    /// Whether the host's page is dark: from the colour behind the words, then
    /// the colour they are written in, then the system's appearance.
    static func isDark(_ style: HostTextStyle?, systemDark: Bool = systemIsDark) -> Bool {
        if let page = style?.background.flatMap(srgb), page.alphaComponent > 0.5 { return luminance(page) < 0.45 }
        if let ink = style?.foreground.flatMap(srgb), ink.alphaComponent > 0.5 { return luminance(ink) > 0.55 }
        return systemDark
    }

    static var systemIsDark: Bool { UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark" }

    /// The page the pill must match to hide the host's letters.
    static func page(_ style: HostTextStyle?, dark: Bool) -> NSColor {
        if let page = style?.background.flatMap(srgb), page.alphaComponent > 0.98 { return page }
        return dark ? NSColor(srgbRed: 0.12, green: 0.12, blue: 0.13, alpha: 1) : .white
    }

    /// The host's own ink, which the redrawn words start in before turning.
    static func ink(_ style: HostTextStyle?, dark: Bool) -> NSColor {
        if let ink = style?.foreground.flatMap(srgb), ink.alphaComponent > 0.5 { return ink }
        return dark ? NSColor(white: 0.92, alpha: 1) : NSColor(white: 0.1, alpha: 1)
    }

    static func fill(tint: NSColor, page: NSColor, wash: CGFloat) -> NSColor {
        (srgb(page) ?? page).blended(withFraction: wash, of: srgb(tint) ?? tint) ?? page
    }

    /// The source's colour, a touch darker on a light page and lighter on a
    /// dark one, so the words read against the wash behind them.
    static func words(tint: NSColor, dark: Bool) -> NSColor {
        let base = srgb(tint) ?? tint
        return (dark ? base.blended(withFraction: 0.3, of: .white) : base.blended(withFraction: 0.1, of: .black)) ?? base
    }

    static func srgb(_ color: NSColor) -> NSColor? { color.usingColorSpace(.sRGB) }

    static func luminance(_ color: NSColor) -> CGFloat {
        0.2126 * color.redComponent + 0.7152 * color.greenComponent + 0.0722 * color.blueComponent
    }
}

/// What kind of file a source is, for the icon by its words and in its menu.
enum ReferenceSourceType {
    static func fileExtension(_ path: String) -> String { (path as NSString).pathExtension.lowercased() }

    /// A short name for the kind of file, as a writer would say it.
    static func name(forPath path: String) -> String {
        let ext = fileExtension(path)
        let names: [(String, [String])] = [
            ("Excel", ["xlsx", "xlsm", "xls"]), ("CSV", ["csv", "tsv"]), ("PDF", ["pdf"]),
            ("Word", ["docx", "doc"]), ("PowerPoint", ["pptx", "ppt"]), ("Keynote", ["key"]),
            ("Pages", ["pages"]), ("Numbers", ["numbers"]), ("Video", ["mp4", "mov", "m4v"]),
            ("Drawing", ["dxf", "dwg"]), ("Model", ["ifc", "step", "stp"]), ("LandXML", ["landxml"]),
            ("Markdown", ["md", "markdown"]), ("Text", ["txt", "rtf"]),
        ]
        if let name = names.first(where: { $0.1.contains(ext) })?.0 { return name }
        return ext.isEmpty ? "File" : ext.uppercased()
    }

    private static var icons: [String: NSImage] = [:]

    /// The type's icon, as The Ranch lists it: Lasso's own for types macOS draws
    /// as plain pages, the apps' own for the rest.
    static func icon(forPath path: String, size: CGFloat) -> NSImage {
        let ext = fileExtension(path)
        if let drawn = RanchTypeIcon.image(for: ext, size: size) { return drawn }
        if let cached = icons[ext] { return cached }
        let icon = UTType(filenameExtension: ext).map(NSWorkspace.shared.icon(for:)) ?? NSWorkspace.shared.icon(for: .data)
        icons[ext] = icon
        return icon
    }

    /// A kind of file's colour and sign, for the small tile beside linked words,
    /// where a document icon would be too small to read.
    static func tileStyle(forPath path: String) -> (color: NSColor, symbol: String) {
        let ext = fileExtension(path)
        func rgb(_ hex: Int) -> NSColor {
            NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                    blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
        let kinds: [(Int, String, [String])] = [
            (0x1D7A45, "tablecells.fill", ["xlsx", "xlsm", "xls", "csv", "tsv", "numbers", "gsheet"]),
            (0xD93025, "doc.richtext.fill", ["pdf"]),
            (0x2B5CD6, "doc.text.fill", ["docx", "doc", "pages", "gdoc", "rtf"]),
            (0xD35230, "rectangle.on.rectangle", ["pptx", "ppt", "key", "gslides"]),
            (0x8E44AD, "play.fill", ["mp4", "mov", "m4v"]),
            (0xE8710A, "cube.fill", ["ifc", "step", "stp", "stl", "obj", "dxf", "dwg", "landxml", "3mf", "usdz"]),
            (0x5856D6, "chevron.left.forwardslash.chevron.right",
             ["js", "mjs", "ts", "tsx", "py", "swift", "java", "kt", "c", "cpp", "go", "rs", "rb", "sh", "sql", "json"]),
            (0xD6336C, "photo.fill", ["png", "jpg", "jpeg", "gif", "heic", "tif", "tiff", "webp", "svg"]),
            (0x46566B, "text.alignleft", ["md", "markdown", "txt"]),
        ]
        let kind = kinds.first { $0.2.contains(ext) }
        return (rgb(kind?.0 ?? 0x8E8E93), kind?.1 ?? "doc.fill")
    }

    private static var tiles: [String: NSImage] = [:]

    /// The tile: the kind's sign in white on a rounded square of its colour.
    static func tile(forPath path: String, size: CGFloat) -> NSImage {
        let key = "\(fileExtension(path))@\(size)"
        if let cached = tiles[key] { return cached }
        let style = tileStyle(forPath: path)
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            style.color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: size * 0.26, yRadius: size * 0.26).fill()
            let configuration = NSImage.SymbolConfiguration(pointSize: size * 0.56, weight: .bold)
            guard let symbol = (NSImage(systemSymbolName: style.symbol, accessibilityDescription: nil)
                                ?? NSImage(systemSymbolName: "doc.fill", accessibilityDescription: nil))?
                    .withSymbolConfiguration(configuration) else { return true }
            let fit = min(rect.width * 0.66 / symbol.size.width, rect.height * 0.66 / symbol.size.height, 1)
            let box = NSSize(width: symbol.size.width * fit, height: symbol.size.height * fit)
            let white = NSImage(size: box, flipped: false) { inner in
                symbol.draw(in: inner)
                NSColor.white.set()
                inner.fill(using: .sourceAtop)
                return true
            }
            white.draw(in: NSRect(x: rect.midX - box.width / 2, y: rect.midY - box.height / 2,
                                  width: box.width, height: box.height))
            return true
        }
        tiles[key] = image
        return image
    }

    /// "Budget.xlsx · Sheet1!C14", the source as a menu names it.
    static func caption(path: String, location: String) -> String {
        let file = (path as NSString).lastPathComponent
        let place = location.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !place.isEmpty, place != file else { return file }
        return file.isEmpty ? place : "\(file) \u{00B7} \(place)"
    }
}
