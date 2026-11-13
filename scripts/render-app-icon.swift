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

extension CGPath {
    func transformed(_ transform: CGAffineTransform) -> CGPath {
        var t = transform
        return copy(using: &t)!
    }
}

/// Rounds concave corners (grow, then shrink) and convex ones (shrink, then grow).
func rounded(_ path: CGPath, radius r: CGFloat) -> CGPath {
    func band(_ p: CGPath) -> CGPath { p.copy(strokingWithWidth: 2 * r, lineCap: .round, lineJoin: .round, miterLimit: 1) }
    func grow(_ p: CGPath) -> CGPath { p.union(band(p)) }
    func shrink(_ p: CGPath) -> CGPath { p.subtracting(band(p)) }
    return grow(shrink(shrink(grow(path))))
}

/// The mascot in the SVG's own space: a 100 square, y down.
enum Mascot {
    /// The SVG's slight shear, shared by the body and the eyes.
    static func shear(_ tx: CGFloat, _ ty: CGFloat) -> CGAffineTransform {
        CGAffineTransform(a: 0.9553, b: -0.0587, c: 0, d: 0.9801, tx: tx, ty: ty)
    }

    /// The outline: hat crown, brim tips raised at the sides, and the face.
    static let outline: CGPath = {
        typealias Curve = (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)
        func add(_ p: CGMutablePath, _ curves: [Curve]) {
            curves.forEach { p.addCurve(to: CGPoint(x: $0.4, y: $0.5), control1: CGPoint(x: $0.0, y: $0.1),
                                        control2: CGPoint(x: $0.2, y: $0.3)) }
        }
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 33, y: 18))
        add(p, [(37, 15, 42, 22, 50, 22), (58, 22, 63, 15, 67, 18), (71, 21, 72, 29, 74, 34),
                (78, 36, 82, 33, 85, 31), (89, 28, 92, 32, 90, 37), (87, 43, 80, 46, 75, 47)])
        p.addLine(to: CGPoint(x: 75, y: 65))
        add(p, [(75, 78, 65, 86, 50, 86), (35, 86, 25, 78, 25, 65)])
        p.addLine(to: CGPoint(x: 25, y: 47))
        add(p, [(20, 46, 13, 43, 10, 37), (8, 32, 11, 28, 15, 31), (18, 33, 22, 36, 26, 34), (28, 29, 29, 21, 33, 18)])
        p.closeSubpath()
        return p
    }()

    static let body = rounded(outline.transformed(shear(1.2, 3.0)), radius: 2.2)

    /// Oval eyes for a head turned part way: both slide toward the turn, sit
    /// a little closer, and the far eye narrows as it wraps round the head.
    static func eyes(turn: CGFloat) -> CGPath {
        let spacing = 17 * (1 - abs(turn) * 0.18)
        let mid = CGPoint(x: 50 + turn * 7, y: 58.6)
        let path = CGMutablePath()
        for side in [-1, 1] as [CGFloat] {
            let far = side * turn < 0
            let width = 6.6 * (far ? 1 - abs(turn) * 0.38 : 1 + abs(turn) * 0.06)
            let height = 15.6 * (far ? 1 - abs(turn) * 0.08 : 1)
            let x = mid.x + side * spacing / 2
            path.addRoundedRect(in: CGRect(x: x - width / 2, y: mid.y - height / 2, width: width, height: height),
                                cornerWidth: width / 2, cornerHeight: width / 2)
        }
        return path.transformed(shear(1.16, 2.93))
    }
}

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
