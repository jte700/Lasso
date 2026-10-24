// Icons for the file types macOS draws as near-identical white pages at list
// size: PDF, CSV, text, code, CAD, images, and Google's files on a Mac
// without Google Drive. Google's files look like Google's own icons; the rest
// show their type on a label in a colour of its own, so a list tells them
// apart at a glance. Microsoft Office, iWork, web pages and archives keep
// their apps' own icons, which already do.

import Cocoa

enum RanchTypeIcon {
    enum Mark: Equatable {
        /// Google's files: the page in the brand colour with a white sign.
        case sheet, document, slides
        /// Everything else: a white page with the type on a coloured label.
        case label(String)
    }

    struct Style: Equatable {
        let mark: Mark
        let color: NSColor
    }

    private static let google: [String: Style] = [
        "gsheet": Style(mark: .sheet, color: rgb(0x0F9D58)),
        "gdoc": Style(mark: .document, color: rgb(0x4285F4)),
        "gslides": Style(mark: .slides, color: rgb(0xF4B400)),
    ]
    /// Label colours, by kind of file.
    private static let labelled: [(color: NSColor, extensions: [String])] = [
        (rgb(0xD93025), ["pdf"]),
        (rgb(0x188038), ["csv", "tsv"]),
        (rgb(0x8E8E93), ["txt", "rtf", "log"]),
        (rgb(0x46566B), ["md", "markdown"]),
        (rgb(0x8E44AD), ["json", "yaml", "yml", "xml", "toml"]),
        (rgb(0x5856D6), ["js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "swift", "java", "kt", "c", "h", "cpp", "hpp",
                         "cs", "go", "rs", "rb", "php", "sh", "sql", "css", "scss"]),
        (rgb(0xE8710A), ["step", "stp", "iges", "igs", "stl", "obj", "ply", "3mf", "usd", "usda", "usdc", "usdz",
                         "f3d", "sldprt", "dxf", "dwg", "ifc"]),
        (rgb(0xD6336C), ["png", "jpg", "jpeg", "gif", "heic", "tif", "tiff", "webp", "bmp", "svg"]),
    ]
    /// Where the extension itself would read badly on a small label.
    private static let shortLabels = ["jpeg": "JPG", "markdown": "MD", "sldprt": "SLD", "tiff": "TIF"]
    private static let longestLabel = 5
    private static var images: [String: NSImage] = [:]

    /// How a type is drawn here, or nil when macOS's own icon tells it apart.
    static func style(for fileExtension: String) -> Style? {
        let key = fileExtension.lowercased()
        if let style = google[key] { return style }
        guard let group = labelled.first(where: { $0.extensions.contains(key) }) else { return nil }
        let label = shortLabels[key] ?? String(key.uppercased().prefix(longestLabel))
        return Style(mark: .label(label), color: group.color)
    }

    /// The icon at `size` points, made once per type and size.
    static func image(for fileExtension: String, size: CGFloat) -> NSImage? {
        guard let style = style(for: fileExtension) else { return nil }
        let key = "\(fileExtension.lowercased())@\(size)"
        if let cached = images[key] { return cached }
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            draw(style, in: rect)
            return true
        }
        images[key] = image
        return image
    }

    // MARK: Drawing

    private static func draw(_ style: Style, in rect: NSRect) {
        let side = rect.width
        let page = NSRect(x: rect.midX - side * 0.38, y: rect.minY + side * 0.03, width: side * 0.76, height: side * 0.94)
        let fold = page.width * 0.3
        let outline = pagePath(page, fold: fold, radius: side * 0.06)
        let corner = NSBezierPath()
        corner.move(to: NSPoint(x: page.maxX - fold, y: page.maxY))
        corner.line(to: NSPoint(x: page.maxX - fold, y: page.maxY - fold + side * 0.04))
        corner.appendArc(withCenter: NSPoint(x: page.maxX - fold + side * 0.04, y: page.maxY - fold + side * 0.04),
                         radius: side * 0.04, startAngle: 180, endAngle: 270)
        corner.line(to: NSPoint(x: page.maxX, y: page.maxY - fold))
        corner.close()
        switch style.mark {
        case .label(let text):
            NSColor.white.setFill()
            outline.fill()
            NSColor.black.withAlphaComponent(0.18).setStroke()
            outline.lineWidth = max(0.5, side * 0.02)
            outline.stroke()
            NSColor(white: 0.86, alpha: 1).setFill()
            corner.fill()
            drawLabel(text, color: style.color, page: page, side: side)
        case .sheet, .document, .slides:
            style.color.setFill()
            outline.fill()
            (style.color.shadow(withLevel: 0.3) ?? style.color).setFill()
            corner.fill()
            drawSign(style.mark, color: style.color, page: page, side: side)
        }
    }

    /// A page with its top-right corner folded down.
    private static func pagePath(_ page: NSRect, fold: CGFloat, radius: CGFloat) -> NSBezierPath {
        let path = NSBezierPath()
        path.move(to: NSPoint(x: page.minX + radius, y: page.minY))
        path.appendArc(from: NSPoint(x: page.maxX, y: page.minY), to: NSPoint(x: page.maxX, y: page.maxY), radius: radius)
        path.line(to: NSPoint(x: page.maxX, y: page.maxY - fold))
        path.line(to: NSPoint(x: page.maxX - fold, y: page.maxY))
        path.appendArc(from: NSPoint(x: page.minX, y: page.maxY), to: NSPoint(x: page.minX, y: page.minY), radius: radius)
        path.appendArc(from: NSPoint(x: page.minX, y: page.minY), to: NSPoint(x: page.maxX, y: page.minY), radius: radius)
        path.close()
        return path
    }

    /// The type in white on a band across the lower half, as large as fits.
    private static func drawLabel(_ text: String, color: NSColor, page: NSRect, side: CGFloat) {
        let band = NSRect(x: page.minX - side * 0.04, y: page.minY + page.height * 0.14,
                          width: page.width + side * 0.08, height: page.height * 0.4)
        color.setFill()
        NSBezierPath(roundedRect: band, xRadius: side * 0.05, yRadius: side * 0.05).fill()
        var font = NSFont.systemFont(ofSize: band.height * 0.72, weight: .heavy)
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        var size = (text as NSString).size(withAttributes: attributes)
        let room = band.width - side * 0.06
        if size.width > room {
            font = NSFont.systemFont(ofSize: font.pointSize * room / size.width, weight: .heavy)
            attributes[.font] = font
            size = (text as NSString).size(withAttributes: attributes)
        }
        let baseline = band.midY - (font.capHeight / 2)
        (text as NSString).draw(at: NSPoint(x: band.midX - size.width / 2, y: baseline + font.descender),
                                withAttributes: attributes)
    }

    /// Google's signs: a table for Sheets, lines for Docs, a slide for Slides.
    private static func drawSign(_ mark: Mark, color: NSColor, page: NSRect, side: CGFloat) {
        let area = NSRect(x: page.minX + page.width * 0.22, y: page.minY + page.height * 0.2,
                          width: page.width * 0.56, height: page.height * 0.42)
        NSColor.white.setFill()
        switch mark {
        case .sheet:
            NSBezierPath(roundedRect: area, xRadius: side * 0.02, yRadius: side * 0.02).fill()
            color.setFill()
            let line = max(0.6, side * 0.035)
            NSRect(x: area.minX + area.width * 0.38, y: area.minY, width: line, height: area.height).fill()
            for row in 1...2 {
                NSRect(x: area.minX, y: area.minY + area.height * CGFloat(row) / 3 - line / 2, width: area.width, height: line).fill()
            }
        case .document:
            let line = max(0.8, side * 0.05)
            for row in 0..<4 {
                let width = row == 0 ? area.width * 0.6 : area.width
                NSRect(x: area.minX, y: area.maxY - line - CGFloat(row) * area.height / 3.4, width: width, height: line).fill()
            }
        case .slides:
            let slide = area.insetBy(dx: 0, dy: area.height * 0.12)
            NSBezierPath(roundedRect: slide, xRadius: side * 0.025, yRadius: side * 0.025).fill()
            color.setFill()
            let border = max(0.8, side * 0.05)
            NSRect(x: slide.minX + border, y: slide.minY + border, width: slide.width - border * 2,
                   height: slide.height - border * 2).fill()
        case .label:
            break
        }
    }

    private static func rgb(_ hex: Int) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
