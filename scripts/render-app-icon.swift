import AppKit
import CoreGraphics

// Draws Lasso's app icon into an .iconset folder for `iconutil`.
// The artwork is the website's mascot in white on an ink body, drawn large
// and leaning in from the lower right with his head turned part way: the
// bottom edge crops him, and his oval eyes slide toward the turn with the far
// eye narrowed. The outline is one path with every corner rounded (the site
// stacks offset copies, which leaves steps along the edge), lit from the top
// left over a soft shadow. Every size is drawn from vectors.
//
// macOS 26 masks a full-bleed square icon to its own shape, but places any
// other legacy icon, a pre-drawn squircle included, on a grey plate. Earlier
// macOS versions do not mask, so they need the squircle drawn in.
//
// Build: swiftc main.swift (a copy of this file) desktop/MascotShape.swift
// Usage: render-app-icon <output.iconset> [--full-bleed]

let designSize: CGFloat = 1024
let bodyRect = CGRect(x: 100, y: 100, width: 824, height: 824)
let squircleExponent: CGFloat = 5
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

enum Palette {
    static let ink: UInt32 = 0x0a0b0d
    static let mascot: UInt32 = 0xffffff
    static let mascotShade: UInt32 = 0xdfe5eb
    static let eyes: UInt32 = 0x15181b
}

/// Where the mascot sits: his width as a share of the icon, the shift of his
/// centre (y up), his lean in degrees (counterclockwise), and how far his
/// head is turned toward the viewer's right, 0 to 1.
enum Pose {
    static let widthShare: CGFloat = 0.98
    static let offset = CGPoint(x: 120, y: -150)
    static let lean: CGFloat = 14
    static let turn: CGFloat = 0.45
}

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

func gradient(_ colors: [CGColor]) -> CGGradient {
    CGGradient(colorsSpace: sRGB, colors: colors as CFArray, locations: nil)!
}

/// Apple's icon body is a superellipse rather than a rounded rectangle.
func squircle(in rect: CGRect) -> CGPath {
    let path = CGMutablePath()
    let steps = 720
    for step in 0...steps {
        let theta = CGFloat(step) / CGFloat(steps) * 2 * .pi
        let c = cos(theta), s = sin(theta)
        let point = CGPoint(x: rect.midX + rect.width / 2 * copysign(pow(abs(c), 2 / squircleExponent), c),
                            y: rect.midY + rect.height / 2 * copysign(pow(abs(s), 2 / squircleExponent), s))
        step == 0 ? path.move(to: point) : path.addLine(to: point)
    }
    path.closeSubpath()
    return path
}

// The mascot's paths (`Mascot`) are in desktop/MascotShape.swift, compiled
// with this file so the icon and the app's small marks share one outline.

func drawArtwork(_ ctx: CGContext) {
    // A flat, deep black ink body with no gradient.
    ctx.setFillColor(color(Palette.ink))
    ctx.fill(CGRect(x: 0, y: 0, width: designSize, height: designSize))

    // Flip the SVG's y-down space, then place, lean and size the mascot.
    let bounds = Mascot.body.boundingBox
    let scale = designSize * Pose.widthShare / bounds.width
    ctx.saveGState()
    ctx.translateBy(x: designSize / 2 + Pose.offset.x, y: designSize / 2 + Pose.offset.y)
    ctx.rotate(by: Pose.lean * .pi / 180)
    ctx.scaleBy(x: scale, y: -scale)
    ctx.translateBy(x: -bounds.midX, y: -bounds.midY)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -16), blur: 46, color: color(0x000000, 0.55))
    ctx.addPath(Mascot.body)
    ctx.setFillColor(color(Palette.mascot))
    ctx.fillPath()
    ctx.restoreGState()

    // Lit from the top left: white fading to a cool shade at the far edge.
    ctx.saveGState()
    ctx.addPath(Mascot.body)
    ctx.clip()
    ctx.drawLinearGradient(gradient([color(Palette.mascot), color(Palette.mascot), color(Palette.mascotShade)]),
                           start: CGPoint(x: bounds.minX, y: bounds.minY), end: CGPoint(x: bounds.maxX, y: bounds.maxY),
                           options: [])
    ctx.restoreGState()

    ctx.addPath(Mascot.eyes(turn: Pose.turn))
    ctx.setFillColor(color(Palette.eyes))
    ctx.fillPath()
    ctx.restoreGState()
}

func drawIcon(_ ctx: CGContext, fullBleed: Bool) {
    if fullBleed {
        // Grow the body to the whole canvas; the system supplies the shape.
        ctx.translateBy(x: designSize / 2, y: designSize / 2)
        ctx.scaleBy(x: designSize / bodyRect.width, y: designSize / bodyRect.height)
        ctx.translateBy(x: -designSize / 2, y: -designSize / 2)
    }
    let shape = fullBleed ? CGPath(rect: bodyRect, transform: nil) : squircle(in: bodyRect)

    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    ctx.translateBy(x: bodyRect.minX, y: bodyRect.minY)
    ctx.scaleBy(x: bodyRect.width / designSize, y: bodyRect.height / designSize)
    drawArtwork(ctx)
    ctx.restoreGState()
    guard !fullBleed else { return }

    // A faint rim separates the ink body from dark menus and windows.
    ctx.addPath(squircle(in: bodyRect.insetBy(dx: 1.5, dy: 1.5)))
    ctx.setStrokeColor(color(0xffffff, 0.12))
    ctx.setLineWidth(3)
    ctx.strokePath()
}

func renderPNG(pixels: Int, fullBleed: Bool, to url: URL) throws {
    guard let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                              space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw NSError(domain: "render-app-icon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot create a \(pixels)px bitmap"])
    }
    ctx.interpolationQuality = .high
    ctx.scaleBy(x: CGFloat(pixels) / designSize, y: CGFloat(pixels) / designSize)
    drawIcon(ctx, fullBleed: fullBleed)
    guard let image = ctx.makeImage(),
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw NSError(domain: "render-app-icon", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot encode \(url.lastPathComponent)"])
    }
    try png.write(to: url)
}

let arguments = Array(CommandLine.arguments.dropFirst())
let fullBleed = arguments.contains("--full-bleed")
let paths = arguments.filter { !$0.hasPrefix("--") }
guard paths.count == 1 else {
    FileHandle.standardError.write(Data("usage: render-app-icon <output.iconset> [--full-bleed]\n".utf8))
    exit(2)
}
let output = URL(fileURLWithPath: paths[0], isDirectory: true)
do {
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    for points in [16, 32, 128, 256, 512] {
        try renderPNG(pixels: points, fullBleed: fullBleed,
                      to: output.appendingPathComponent("icon_\(points)x\(points).png"))
        try renderPNG(pixels: points * 2, fullBleed: fullBleed,
                      to: output.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
    }
} catch {
    FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
    exit(1)
}
