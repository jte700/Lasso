import AppKit
import CoreGraphics

// Draws Lasso's app icon into an .iconset folder for `iconutil`.
// The artwork is a lariat in brand green on a graphite body: a flat,
// spinning loop with the rope falling from its honda in a loose S. Every
// size is drawn from vectors so small icons stay sharp instead of being
// downscaled, and the smallest sizes get a heavier rope and a taller loop.
//
// macOS 26 masks a full-bleed square icon to its own shape, but places any
// other legacy icon, a pre-drawn squircle included, on a grey plate. Earlier
// macOS versions do not mask, so they need the squircle drawn in.
//
// Usage: render-app-icon <output.iconset> [--full-bleed]

let designSize: CGFloat = 1024
let bodyRect = CGRect(x: 100, y: 100, width: 824, height: 824)
let squircleExponent: CGFloat = 5
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

enum Ink {
    static let backgroundTop: UInt32 = 0x2f3532
    static let backgroundBottom: UInt32 = 0x0f1211
    static let ropeLight: UInt32 = 0x74eb9e
    static let ropeDark: UInt32 = 0x1fae4b
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

func cubic(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, _ t: CGFloat) -> CGPoint {
    let u = 1 - t
    let a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
    return CGPoint(x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y)
}

func roundStroke(_ points: [CGPoint], closed: Bool, width: CGFloat) -> CGPath {
    let path = CGMutablePath()
    path.addLines(between: points)
    if closed { path.closeSubpath() }
    return path.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 4)
}

/// How heavy the lariat is drawn at each pixel size. A rope thin enough to
/// look elegant at 512px disappears at 16px, and the loop's eye closes up
/// unless the loop grows taller as the rope thickens.
struct Weight {
    let rope: CGFloat, knot: CGFloat, loopHeight: CGFloat, shadow: Bool

    init(pixels: Int) {
        switch pixels {
        case ..<24: (rope, knot, loopHeight, shadow) = (124, 74, 176, false)
        case ..<48: (rope, knot, loopHeight, shadow) = (96, 64, 152, false)
        case ..<96: (rope, knot, loopHeight, shadow) = (76, 56, 134, true)
        default: (rope, knot, loopHeight, shadow) = (62, 50, 124, true)
        }
    }
}

/// The lariat in body space: a 1024 square, y up, that maps onto the icon body.
struct Lariat {
    let weight: Weight
    let center = CGPoint(x: 470, y: 672), radiusX: CGFloat = 300, tilt: CGFloat = 5 * .pi / 180
    let hondaAngle: CGFloat = -50 * .pi / 180

    func loopPoint(_ theta: CGFloat) -> CGPoint {
        let x = radiusX * cos(theta), y = weight.loopHeight * sin(theta)
        return CGPoint(x: center.x + x * cos(tilt) - y * sin(tilt), y: center.y + x * sin(tilt) + y * cos(tilt))
    }

    var loop: [CGPoint] { (0...720).map { loopPoint(CGFloat($0) / 720 * 2 * .pi) } }
    var honda: CGPoint { loopPoint(hondaAngle) }

    /// The rope drops from the honda, swings out to the right and falls back.
    var tail: [CGPoint] {
        let h = honda
        return (0...300).map {
            cubic(h, CGPoint(x: h.x - 46, y: h.y - 150), CGPoint(x: h.x + 132, y: h.y - 236),
                  CGPoint(x: h.x + 84, y: h.y - 408), CGFloat($0) / 300)
        }
    }

    /// Centred on its own bounds, so every weight sits in the same place.
    var outline: CGPath {
        let knot = CGRect(x: honda.x - weight.knot, y: honda.y - weight.knot, width: weight.knot * 2, height: weight.knot * 2)
        let mark = roundStroke(loop, closed: true, width: weight.rope)
            .union(roundStroke(tail, closed: false, width: weight.rope))
            .union(CGPath(ellipseIn: knot, transform: nil))
        let bounds = mark.boundingBox
        var shift = CGAffineTransform(translationX: designSize / 2 - bounds.midX, y: designSize / 2 - bounds.midY)
        return mark.copy(using: &shift)!
    }
}

func drawArtwork(_ ctx: CGContext, weight: Weight) {
    ctx.drawLinearGradient(gradient([color(Ink.backgroundTop), color(Ink.backgroundBottom)]),
                           start: CGPoint(x: 0, y: designSize), end: .zero, options: [])
    // A faint light from above keeps the graphite from reading as flat black.
    let light = CGPoint(x: designSize / 2, y: designSize)
    ctx.drawRadialGradient(gradient([color(0xffffff, 0.07), color(0xffffff, 0)]),
                           startCenter: light, startRadius: 0, endCenter: light, endRadius: 820, options: [])

    let outline = Lariat(weight: weight).outline
    ctx.saveGState()
    if weight.shadow {
        ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 30, color: color(0x000000, 0.5))
    }
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    ctx.addPath(outline)
    ctx.clip()
    let box = outline.boundingBox
    ctx.drawLinearGradient(gradient([color(Ink.ropeLight), color(Ink.ropeDark)]),
                           start: CGPoint(x: 0, y: box.maxY), end: CGPoint(x: 0, y: box.minY), options: [])
    ctx.endTransparencyLayer()
    ctx.restoreGState()
}

func drawIcon(_ ctx: CGContext, pixels: Int, fullBleed: Bool) {
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
    drawArtwork(ctx, weight: Weight(pixels: pixels))
    ctx.restoreGState()
    guard !fullBleed else { return }

    // A faint rim separates the dark body from dark menus and windows.
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
    drawIcon(ctx, pixels: pixels, fullBleed: fullBleed)
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
