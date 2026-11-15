import Foundation
import AppKit
import CoreGraphics
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// A new PNG of a picture with its redacted areas covered. Only the drawn
// pixels are written: none of the original file's metadata (camera, place,
// comments) enters the output, and no source pixel is left under a mask.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(2)
}

/// An area from the picture's top left, each value a share (0...1) of its width or height.
struct Region: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let effect: String?
}
struct Request: Decodable {
    let regions: [Region]
}

/// The longest side a shared copy keeps, so a hosted link stays small enough to upload.
let maxSide: CGFloat = 2400
let maxRegions = 64

let blurContext = CIContext(options: [.cacheIntermediates: false])

// A soft texture made only from synthetic marks. Blurring the picture itself
// would still disclose its shapes and colours, so those pixels never enter it.
// Keep this appearance in sync with blurImage in render-shared-pdf.swift.
func blurImage(size: CGSize) -> CGImage? {
    let scale = min(2, 1024 / max(size.width, size.height))
    let width = max(1, Int(ceil(size.width * scale)))
    let height = max(1, Int(ceil(size.height * scale)))
    guard let bitmap = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    bitmap.setFillColor(CGColor(gray: 1, alpha: 1))
    bitmap.fill(CGRect(x: 0, y: 0, width: width, height: height))
    bitmap.scaleBy(x: scale, y: scale)
    let rows = max(1, Int(ceil(size.height / 17)))
    let lineHeight = size.height / CGFloat(rows)
    let strokeHeight = min(6, max(2, lineHeight * 0.4))
    let wordWidths: [CGFloat] = [1.2, 0.7, 1.65, 1, 0.85, 1.4]
    bitmap.setFillColor(CGColor(gray: 0.38, alpha: 1))
    for row in 0..<rows {
        var x: CGFloat = 3 + CGFloat(row % 2) * 2
        var word = row
        let end = size.width - 3 - CGFloat(row % 3) * min(size.width * 0.08, 18)
        while x < end {
            let markWidth = min(wordWidths[word % wordWidths.count] * lineHeight, end - x)
            bitmap.fill(CGRect(x: x, y: CGFloat(row) * lineHeight + (lineHeight - strokeHeight) / 2,
                width: markWidth, height: strokeHeight))
            x += markWidth + max(3, lineHeight * 0.3)
            word += 1
        }
    }
    guard let source = bitmap.makeImage() else { return nil }
    let input = CIImage(cgImage: source)
    let radius = max(2, min(4, lineHeight * 0.24)) * scale
    return blurContext.createCGImage(input.clampedToExtent().applyingGaussianBlur(sigma: radius)
        .cropped(to: input.extent), from: input.extent)
}

/// The picture's size in pixels, upright as NSImage shows it (which the composer's masks are drawn on).
func pixelSize(of image: NSImage) -> CGSize {
    var largest: CGSize?
    for representation in image.representations where representation.pixelsWide > 0 && representation.pixelsHigh > 0 {
        let candidate = CGSize(width: CGFloat(representation.pixelsWide), height: CGFloat(representation.pixelsHigh))
        if largest.map({ $0.width * $0.height < candidate.width * candidate.height }) ?? true { largest = candidate }
    }
    // A vector picture (SVG, PDF) has no pixels of its own; it is drawn at twice its point size.
    let size = largest ?? CGSize(width: image.size.width * 2, height: image.size.height * 2)
    let scale = min(1, maxSide / max(size.width, size.height, 1))
    return CGSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
}

let args = CommandLine.arguments
guard args.count == 4,
      let image = NSImage(contentsOf: URL(fileURLWithPath: args[1])), image.isValid,
      let json = try? Data(contentsOf: URL(fileURLWithPath: args[2])),
      let request = try? JSONDecoder().decode(Request.self, from: json) else {
    fail("The picture or its redactions could not be read.")
}
let regions = request.regions.filter { region in
    [region.x, region.y, region.width, region.height].allSatisfy(\.isFinite)
        && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
        && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001
}
guard !regions.isEmpty, regions.count == request.regions.count, regions.count <= maxRegions else {
    fail("The redactions are not areas of the picture.")
}

let size = pixelSize(of: image)
let width = Int(size.width), height = Int(size.height)
guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fail("The shared picture could not be drawn.")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
image.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()

for region in regions {
    // From the top left into Core Graphics' bottom-left pixels, widened to whole pixels so no edge is left.
    let area = CGRect(x: region.x * Double(width), y: (1 - region.y - region.height) * Double(height),
                      width: region.width * Double(width), height: region.height * Double(height))
        .integral.insetBy(dx: -1, dy: -1)
        .intersection(CGRect(x: 0, y: 0, width: width, height: height))
    context.setBlendMode(.copy)
    context.setFillColor(CGColor(gray: region.effect == "BLANK" ? 0.08 : 1, alpha: 1))
    context.fill(area)
    context.setBlendMode(.normal)
    if region.effect != "BLANK", let texture = blurImage(size: area.size) {
        context.draw(texture, in: area)
    }
}

guard let output = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL,
                                                        UTType.png.identifier as CFString, 1, nil) else {
    fail("The shared picture could not be saved.")
}
CGImageDestinationAddImage(destination, output, nil)
guard CGImageDestinationFinalize(destination) else { fail("The shared picture could not be saved.") }
