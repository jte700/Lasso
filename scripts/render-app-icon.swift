import AppKit
import CoreGraphics

// Draws Lasso's app icon into an .iconset folder for `iconutil`.
// The artwork is the brand lasso mark (#lassoMark in website/index.html)
// catching a line of source text, on a dark macOS squircle. Every size is
// drawn from vectors so small icons stay sharp instead of being downscaled.
//
// macOS 26 masks a full-bleed square icon to its own shape, but places any
// other legacy icon, a pre-drawn squircle included, on a grey plate. Earlier
// macOS versions do not mask, so they need the squircle drawn in.
//
// Usage: render-app-icon <output.iconset> [--full-bleed]

let designSize: CGFloat = 1024
let bodyRect = CGRect(x: 100, y: 100, width: 824, height: 824)
let squircleExponent: CGFloat = 5
let markUnit: CGFloat = 22.5
let ropeWidthUnits: CGFloat = 2.5
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

enum Ink {
    static let backgroundTop: UInt32 = 0x232b25
    static let backgroundBottom: UInt32 = 0x0b0e0c
    static let ropeLight: UInt32 = 0x66ee93
    static let ropeDark: UInt32 = 0x1fae4b
    static let paper: UInt32 = 0xf5f7f2
    static let text: UInt32 = 0x101411
    static let linkedText: UInt32 = 0x1f9d55
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

/// Maps the mark's 32-unit, y-down grid into the y-up design canvas.
func mark(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    let center = CGPoint(x: 15.8, y: 16.4)
    return CGPoint(x: designSize / 2 + (x - center.x) * markUnit,
                   y: designSize / 2 - (y - center.y) * markUnit)
}

func loopCenterline() -> [CGPoint] {
    let tilt = -10 * CGFloat.pi / 180
    return (0...480).map { step in
        let theta = CGFloat(step) / 480 * 2 * .pi
        let x = 11 * cos(theta), y = 7.5 * sin(theta)
        return mark(15 + x * cos(tilt) - y * sin(tilt), 12 + x * sin(tilt) + y * cos(tilt))
    }
}

func cubic(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, _ t: CGFloat) -> CGPoint {
    let u = 1 - t
    let a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
    return CGPoint(x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y)
}

/// The free end leaves the knot in a loose S, which reads as rope rather
/// than the straight handle of a magnifying glass.
func tailCenterline() -> [CGPoint] {
    let samples = 200
    return (0...samples).map {
        cubic(mark(19.5, 18.6), mark(24.2, 20.2), mark(22.8, 26.4), mark(27.9, 28.3), CGFloat($0) / CGFloat(samples))
    }
}

func polyline(_ points: [CGPoint]) -> CGPath {
    let path = CGMutablePath()
    path.addLines(between: points)
    return path
}

/// Short diagonal strokes at even spacing give the rope its twisted lay.
func drawTwist(_ ctx: CGContext, along points: [CGPoint], width: CGFloat) {
    let spacing = width * 0.7
    let angle = 48 * CGFloat.pi / 180
    var travelled: CGFloat = 0
    var nextTick = spacing / 2
    ctx.setStrokeColor(color(Ink.ropeDark, 0.3))
    ctx.setLineWidth(width * 0.15)
    ctx.setLineCap(.round)
    for (start, end) in zip(points, points.dropFirst()) {
        let dx = end.x - start.x, dy = end.y - start.y
        let length = hypot(dx, dy)
        guard length > 0 else { continue }
        while travelled + length >= nextTick {
            let t = (nextTick - travelled) / length
            let point = CGPoint(x: start.x + dx * t, y: start.y + dy * t)
            let normal = atan2(dx, -dy) + angle
            let reach = width * 0.62
            ctx.move(to: CGPoint(x: point.x - cos(normal) * reach, y: point.y - sin(normal) * reach))
            ctx.addLine(to: CGPoint(x: point.x + cos(normal) * reach, y: point.y + sin(normal) * reach))
            nextTick += spacing
        }
        travelled += length
    }
    ctx.strokePath()
}

func drawRope(_ ctx: CGContext, _ points: [CGPoint], width: CGFloat, detailed: Bool) {
    let outline = polyline(points).copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 4)
    if detailed {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 22, color: color(0x000000, 0.5))
        ctx.addPath(outline)
        ctx.setFillColor(color(Ink.ropeDark))
        ctx.fillPath()
        ctx.restoreGState()
    }
    ctx.saveGState()
    ctx.addPath(outline)
    ctx.clip()
    ctx.drawLinearGradient(gradient([color(Ink.ropeLight), color(Ink.ropeDark)]),
                           start: CGPoint(x: 0, y: bodyRect.maxY - 120), end: CGPoint(x: 0, y: bodyRect.minY + 80),
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    if detailed { drawTwist(ctx, along: points, width: width) }
    ctx.restoreGState()
}

/// A line of source text held inside the loop: the fragment Lasso catches.
func drawFragment(_ ctx: CGContext) {
    let center = mark(15, 12)
    ctx.saveGState()
    ctx.translateBy(x: center.x, y: center.y)
    ctx.rotate(by: 10 * .pi / 180)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 18, color: color(0x000000, 0.45))
    ctx.addPath(CGPath(roundedRect: CGRect(x: -150, y: -52, width: 300, height: 104),
                       cornerWidth: 26, cornerHeight: 26, transform: nil))
    ctx.setFillColor(color(Ink.paper))
    ctx.fillPath()
    ctx.restoreGState()
    let lines: [(width: CGFloat, ink: UInt32)] = [(206, Ink.linkedText), (128, Ink.text)]
    for (index, line) in lines.enumerated() {
        let rect = CGRect(x: -114, y: 10 - CGFloat(index) * 38, width: line.width, height: 18)
        ctx.addPath(CGPath(roundedRect: rect, cornerWidth: 9, cornerHeight: 9, transform: nil))
        ctx.setFillColor(color(line.ink, 0.9))
        ctx.fillPath()
    }
    ctx.restoreGState()
}

func drawKnot(_ ctx: CGContext, width: CGFloat) {
    let knot = mark(19.3, 18.4)
    let outer = width * 1.04, inner = width * 0.66
    ctx.setFillColor(color(Ink.ropeDark))
    ctx.fillEllipse(in: CGRect(x: knot.x - outer, y: knot.y - outer, width: outer * 2, height: outer * 2))
    ctx.setFillColor(color(Ink.ropeLight))
    ctx.fillEllipse(in: CGRect(x: knot.x - inner - width * 0.12, y: knot.y - inner + width * 0.12,
                               width: inner * 2, height: inner * 2))
}

func drawIcon(_ ctx: CGContext, pixels: Int, fullBleed: Bool) {
    // Fine texture and the text fragment turn to noise at menu and list sizes.
    let detailed = pixels >= 64
    let ropeWidth = ropeWidthUnits * markUnit * (pixels <= 32 ? 1.35 : 1)
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
    ctx.drawLinearGradient(gradient([color(Ink.backgroundTop), color(Ink.backgroundBottom)]),
                           start: CGPoint(x: 0, y: bodyRect.maxY), end: CGPoint(x: 0, y: bodyRect.minY), options: [])
    let glowCenter = mark(15, 12)
    ctx.drawRadialGradient(gradient([color(Ink.ropeLight, 0.24), color(Ink.ropeLight, 0)]),
                           startCenter: glowCenter, startRadius: 0, endCenter: glowCenter, endRadius: 430, options: [])
    if detailed { drawFragment(ctx) }
    drawRope(ctx, loopCenterline(), width: ropeWidth, detailed: detailed)
    drawRope(ctx, tailCenterline(), width: ropeWidth, detailed: detailed)
    drawKnot(ctx, width: ropeWidth)
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
