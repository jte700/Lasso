import Foundation
import AppKit
import PDFKit
import CoreGraphics
import CoreImage

// A new PDF containing only rasterized permitted pixels. No original PDF page,
// text layer, annotations, attachments or document metadata enters the output.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(2)
}

struct Region: Decodable {
    let page: Int
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let effect: String?
}
struct Request: Decodable {
    let mode: String
    let regions: [Region]
    let text: String?
    let page: Int?
}

let blurContext = CIContext(options: [.cacheIntermediates: false])

// A soft texture made only from synthetic marks. Blurring the source itself
// would still disclose its shapes and colours, so those pixels never enter it.
// Keep this appearance in sync with SharePDFMaskAnnotation.blurImage.
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

let args = CommandLine.arguments
guard args.count == 4,
      let input = PDFDocument(url: URL(fileURLWithPath: args[1])), !input.isLocked,
      let json = try? Data(contentsOf: URL(fileURLWithPath: args[2])),
      let request = try? JSONDecoder().decode(Request.self, from: json),
      ["REDACTED", "INDEXED"].contains(request.mode), input.pageCount > 0,
      input.pageCount <= 1000 else { fail("The PDF could not be prepared for sharing.") }

var regions = request.regions
if request.mode == "INDEXED", regions.isEmpty {
    let text = (request.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, text.utf16.count <= 100_000 else { fail("Select text or an area from the PDF before sharing.") }
    // Match only existing selectable PDF text, tolerating wrapped whitespace.
    let tokens = text.split(whereSeparator: { $0.isWhitespace }).map { NSRegularExpression.escapedPattern(for: String($0)) }
    guard let regex = try? NSRegularExpression(pattern: tokens.joined(separator: "\\s+"), options: [.caseInsensitive]) else {
        fail("The selected PDF excerpt could not be located.")
    }
    let pageIndices = request.page.map { [$0 - 1] } ?? Array(0..<input.pageCount)
    for index in pageIndices where index >= 0 && index < input.pageCount {
        guard let page = input.page(at: index) else { continue }
        let value = page.string ?? ""
        guard let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
              let selection = page.selection(for: match.range) else { continue }
        let crop = page.bounds(for: .cropBox)
        for line in selection.selectionsByLine() {
            let rect = line.bounds(for: page).intersection(crop)
            guard !rect.isNull, rect.width > 0, rect.height > 0 else { continue }
            regions.append(Region(page: index + 1, x: (rect.minX - crop.minX) / crop.width,
                y: (crop.maxY - rect.maxY) / crop.height, width: rect.width / crop.width,
                height: rect.height / crop.height, effect: nil))
        }
        break
    }
}
guard !regions.isEmpty, regions.count <= 512,
      regions.allSatisfy({ r in r.page > 0 && r.page <= input.pageCount
          && [r.x, r.y, r.width, r.height].allSatisfy({ $0.isFinite })
          && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0
          && r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001 }) else {
    fail("The PDF selection could not be located in this version.")
}

let output = PDFDocument()
let pages = request.mode == "INDEXED" ? Array(Set(regions.map(\.page))).sorted() : Array(1...input.pageCount)
for number in pages {
    guard let source = input.page(at: number - 1), let original = source.pageRef else { fail("A PDF page is unavailable.") }
    let crop = source.bounds(for: .cropBox)
    guard crop.width > 0, crop.height > 0, crop.width <= 100_000, crop.height <= 100_000 else { fail("Unsupported PDF page dimensions.") }
    let selected = regions.filter { $0.page == number }
    func rect(_ region: Region) -> CGRect {
        CGRect(x: region.x * crop.width, y: (1 - region.y - region.height) * crop.height,
            width: region.width * crop.width, height: region.height * crop.height)
    }
    let bounds: CGRect
    if request.mode == "INDEXED" {
        bounds = selected.map(rect).reduce(CGRect.null, { $0.union($1) })
    } else { bounds = CGRect(origin: .zero, size: crop.size) }
    let scale = min(2, 3200 / max(bounds.width, bounds.height))
    let width = max(1, Int(ceil(bounds.width * scale))), height = max(1, Int(ceil(bounds.height * scale)))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fail("The PDF page could not be rendered.")
    }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    context.saveGState()
    if request.mode == "INDEXED" {
        context.addRects(selected.map(rect))
        context.clip()
    }
    context.translateBy(x: -crop.minX, y: -crop.minY)
    context.drawPDFPage(original)
    context.restoreGState()
    if request.mode == "REDACTED" {
        for region in selected {
            // Expanding to full raster pixels prevents antialiased edge remnants.
            let area = rect(region).insetBy(dx: -1 / scale, dy: -1 / scale)
            context.setFillColor(CGColor(gray: region.effect == "BLANK" ? 0.08 : 1, alpha: 1))
            context.fill(area)
            if region.effect != "BLANK", let image = blurImage(size: area.size) {
                context.draw(image, in: area)
            }
        }
    }
    guard let image = context.makeImage(), let page = PDFPage(image: NSImage(cgImage: image, size: bounds.size)) else {
        fail("The safe PDF page could not be created.")
    }
    page.setBounds(CGRect(origin: .zero, size: bounds.size), for: .mediaBox)
    page.setBounds(CGRect(origin: .zero, size: bounds.size), for: .cropBox)
    page.rotation = source.rotation
    output.insert(page, at: output.pageCount)
}
output.documentAttributes = [PDFDocumentAttribute.creatorAttribute: "Lasso"]
guard output.write(to: URL(fileURLWithPath: args[3])) else { fail("The safe PDF could not be saved.") }
