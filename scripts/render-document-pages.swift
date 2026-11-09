import Foundation
import AppKit
import PDFKit
import QuickLookThumbnailing

// A Word document or a deck as PDF pages to draw on, made without opening
// Word, PowerPoint or Keynote.
//
//   render-document-pages docx <input.docx> <output.pdf>
//   render-document-pages slides <output.pdf> <slide-1.pptx|jpg> <slide-2.pptx|jpg> ...
//   render-document-pages slide-images <output-folder> <slide-1.pptx> <slide-2.pptx> ...
//   render-document-pages pdf-docx <input.pdf> <output.docx> <picture-folder> <marker>
//
// A Word document is laid out on its own paper and margins with AppKit's
// reader. Each slide arrives as a deck of its own, which Quick Look draws as
// it draws the first slide of any deck, or as the picture slide-images drew
// of it before: slide-images draws its slides at once and writes each as a
// JPEG named after its deck (slide-3.pptx becomes slide-3.jpg) in the folder.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(2)
}

let maxPages = 1000
let letter = CGSize(width: 612, height: 792)
let defaultMargin: CGFloat = 72
/// Slides are pages this wide, in points, at their own shape.
let slideWidth: CGFloat = 960
let slidePixels: CGFloat = 1920
let slideTimeout: TimeInterval = 20
/// Quick Look frames a slide's picture with a band on two sides; no more than this much is trimmed.
let maxBand: CGFloat = 0.06
let jpegQuality = 0.85

func pdfContext(_ data: NSMutableData) -> CGContext {
    var box = CGRect(origin: .zero, size: letter)
    guard let consumer = CGDataConsumer(data: data as CFMutableData),
          let context = CGContext(consumer: consumer, mediaBox: &box, [kCGPDFContextCreator as String: "Lasso"] as CFDictionary) else {
        fail("The pages could not be started.")
    }
    return context
}

func write(_ data: NSMutableData, to path: String) {
    guard (data as Data).count > 0, (try? (data as Data).write(to: URL(fileURLWithPath: path))) != nil else {
        fail("The pages could not be saved.")
    }
}

// MARK: Word

func wordPages(input: String, output: String) {
    var attributes: NSDictionary? = nil
    guard let text = try? NSAttributedString(url: URL(fileURLWithPath: input),
                                             options: [.documentType: NSAttributedString.DocumentType.officeOpenXML],
                                             documentAttributes: &attributes) else {
        fail("The Word document could not be read.")
    }
    let documentAttributes = attributes as? [NSAttributedString.DocumentAttributeKey: Any] ?? [:]
    let paper = (documentAttributes[.paperSize] as? NSSize).flatMap { $0.width > 100 && $0.height > 100 ? $0 : nil } ?? letter
    func margin(_ key: NSAttributedString.DocumentAttributeKey) -> CGFloat {
        let value = (documentAttributes[key] as? NSNumber).map { CGFloat($0.doubleValue) } ?? defaultMargin
        return min(max(0, value), paper.width / 3)
    }
    let left = margin(.leftMargin), right = margin(.rightMargin), top = margin(.topMargin), bottom = margin(.bottomMargin)
    let storage = NSTextStorage(attributedString: text)
    let layout = NSLayoutManager()
    storage.addLayoutManager(layout)
    var containers: [NSTextContainer] = []
    repeat {
        let container = NSTextContainer(size: CGSize(width: paper.width - left - right, height: paper.height - top - bottom))
        layout.addTextContainer(container)
        containers.append(container)
    } while NSMaxRange(layout.glyphRange(for: containers.last!)) < layout.numberOfGlyphs && containers.count < maxPages

    let data = NSMutableData()
    let context = pdfContext(data)
    var box = CGRect(origin: .zero, size: paper)
    for container in containers {
        context.beginPage(mediaBox: &box)
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(box)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        context.translateBy(x: 0, y: paper.height)
        context.scaleBy(x: 1, y: -1)
        let range = layout.glyphRange(for: container)
        layout.drawBackground(forGlyphRange: range, at: CGPoint(x: left, y: top))
        layout.drawGlyphs(forGlyphRange: range, at: CGPoint(x: left, y: top))
        NSGraphicsContext.restoreGraphicsState()
        context.endPage()
    }
    context.closePDF()
    write(data, to: output)
}

// MARK: Slides

func thumbnail(of path: String) -> CGImage? {
    let request = QLThumbnailGenerator.Request(fileAt: URL(fileURLWithPath: path),
                                               size: CGSize(width: slidePixels, height: slidePixels),
                                               scale: 1, representationTypes: .thumbnail)
    var image: CGImage?
    let done = DispatchSemaphore(value: 0)
    QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, _ in
        image = representation?.cgImage
        done.signal()
    }
    return done.wait(timeout: .now() + slideTimeout) == .timedOut ? nil : image
}

/// The slide without the band Quick Look draws along its right and bottom edges.
func trimmed(_ image: CGImage) -> CGImage {
    let width = image.width, height = image.height
    guard width > 8, height > 8,
          let bitmap = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                 space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let pixels = bitmap.data?.assumingMemoryBound(to: UInt8.self) else { return image }
    bitmap.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    // Rows run top down in the bitmap's memory.
    func pixel(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let offset = (y * width + x) * 4
        return (Int(pixels[offset]), Int(pixels[offset + 1]), Int(pixels[offset + 2]))
    }
    let band = pixel(width - 1, height - 1)
    func matches(_ value: (Int, Int, Int)) -> Bool {
        abs(value.0 - band.0) <= 6 && abs(value.1 - band.1) <= 6 && abs(value.2 - band.2) <= 6
    }
    var right = width
    while right > Int(CGFloat(width) * (1 - maxBand)), (0..<height).allSatisfy({ matches(pixel(right - 1, $0)) }) { right -= 1 }
    var bottom = height
    while bottom > Int(CGFloat(height) * (1 - maxBand)), (0..<right).allSatisfy({ matches(pixel($0, bottom - 1)) }) { bottom -= 1 }
    // A band as wide as the most trimmed is the slide itself, not a frame.
    if right == width && bottom == height { return image }
    if right <= Int(CGFloat(width) * (1 - maxBand)) || bottom <= Int(CGFloat(height) * (1 - maxBand)) { return image }
    return image.cropping(to: CGRect(x: 0, y: 0, width: right, height: bottom)) ?? image
}

func jpegData(_ image: CGImage) -> Data? {
    NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: jpegQuality])
}

/// The picture as JPEG, which a PDF keeps compressed; drawn as it is, a long deck would be hundreds of megabytes.
func compressed(_ image: CGImage) -> CGImage {
    guard let jpeg = jpegData(image), let provider = CGDataProvider(data: jpeg as CFData),
          let decoded = CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else {
        return image
    }
    return decoded
}

/// A slide drawn earlier by slide-images, kept compressed as it was written.
func drawnSlide(at path: String) -> CGImage? {
    guard let provider = CGDataProvider(url: URL(fileURLWithPath: path) as CFURL) else { return nil }
    return CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
}

func slideImage(of path: String) -> CGImage? {
    path.lowercased().hasSuffix(".jpg") ? drawnSlide(at: path) : thumbnail(of: path).map(trimmed).map(compressed)
}

func slideImages(folder: String, slides: [String]) {
    guard !slides.isEmpty, slides.count <= maxPages else { fail("The presentation has no slides to show.") }
    let lock = NSLock()
    var drawn = 0
    // Quick Look draws several slides at once, each in its own request.
    DispatchQueue.concurrentPerform(iterations: slides.count) { index in
        let name = URL(fileURLWithPath: slides[index]).deletingPathExtension().lastPathComponent + ".jpg"
        guard let image = thumbnail(of: slides[index]).map(trimmed), let jpeg = jpegData(image),
              (try? jpeg.write(to: URL(fileURLWithPath: folder).appendingPathComponent(name))) != nil else { return }
        lock.lock()
        drawn += 1
        lock.unlock()
    }
    guard drawn > 0 else { fail("Quick Look couldn\u{2019}t draw the slides.") }
}

func slidePages(output: String, slides: [String]) {
    guard !slides.isEmpty, slides.count <= maxPages else { fail("The presentation has no slides to show.") }
    let data = NSMutableData()
    let context = pdfContext(data)
    var shape = CGSize(width: 16, height: 9)
    var drawn = 0
    for (index, path) in slides.enumerated() {
        let image = slideImage(of: path)
        if let image { shape = CGSize(width: image.width, height: image.height) }
        var box = CGRect(x: 0, y: 0, width: slideWidth, height: (slideWidth * shape.height / shape.width).rounded())
        context.beginPage(mediaBox: &box)
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(box)
        if let image {
            context.interpolationQuality = .high
            context.draw(image, in: box)
            drawn += 1
        } else {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
            let note = NSAttributedString(string: "Slide \(index + 1) couldn\u{2019}t be drawn.", attributes: [
                .font: NSFont.systemFont(ofSize: 22), .foregroundColor: NSColor(white: 0.45, alpha: 1)])
            let size = note.size()
            note.draw(at: CGPoint(x: (box.width - size.width) / 2, y: (box.height - size.height) / 2))
            NSGraphicsContext.restoreGraphicsState()
        }
        context.endPage()
    }
    context.closePDF()
    guard drawn > 0 else { fail("Quick Look couldn\u{2019}t draw the slides.") }
    write(data, to: output)
}

// MARK: PDF to Word

/// A page with no text is drawn at this many pixels a point, and no more than this many pixels long.
let picturePixelsPerPoint: CGFloat = 2
let maxPicturePixels: CGFloat = 2400

/// The page as a reader sees it, turned as the PDF says, in points.
func shownSize(_ page: PDFPage) -> CGSize {
    let box = page.bounds(for: .cropBox).size
    return page.rotation % 180 == 0 ? box : CGSize(width: box.height, height: box.width)
}

func pagePicture(_ page: PDFPage) -> Data? {
    let size = shownSize(page)
    let scale = min(picturePixelsPerPoint, maxPicturePixels / max(size.width, size.height, 1))
    let width = Int((size.width * scale).rounded()), height = Int((size.height * scale).rounded())
    guard width > 0, height > 0,
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .cropBox, to: context)
    return context.makeImage().flatMap(jpegData)
}

/// A PDF as a Word document, a page to a page: each page's text as PDFKit
/// reads it, with its fonts, sizes and colours. A page with no text, such as a
/// scan or a copy Lasso drew as pixels, is written to the folder as
/// page-<n>.jpg and stands in the text as the marker and its number, for the
/// caller to put the picture in its place: Cocoa's Word writer leaves pictures
/// out. The folder's pictures.json gives the paper and each picture's size.
func pdfWord(input: String, output: String, folder: String, marker: String) {
    guard let document = PDFDocument(url: URL(fileURLWithPath: input)), !document.isLocked,
          document.pageCount > 0, let first = document.page(at: 0) else { fail("The PDF could not be read.") }
    guard document.pageCount <= maxPages else { fail("The PDF has too many pages to convert.") }
    let text = NSMutableAttributedString()
    var pictures: [[String: Any]] = []
    for index in 0..<document.pageCount {
        guard let page = document.page(at: index) else { continue }
        if index > 0 { text.append(NSAttributedString(string: "\u{0C}")) }
        if let words = page.attributedString, !words.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            text.append(words)
            if !words.string.hasSuffix("\n") { text.append(NSAttributedString(string: "\n")) }
            continue
        }
        let name = "page-\(index + 1).jpg"
        guard let jpeg = pagePicture(page),
              (try? jpeg.write(to: URL(fileURLWithPath: folder).appendingPathComponent(name))) != nil else {
            fail("Page \(index + 1) could not be drawn.")
        }
        let size = shownSize(page)
        pictures.append(["page": index + 1, "file": name, "width": size.width, "height": size.height])
        text.append(NSAttributedString(string: "\(marker)\(index + 1)\n"))
    }
    let paper = shownSize(first)
    let attributes: [NSAttributedString.DocumentAttributeKey: Any] = [
        .documentType: NSAttributedString.DocumentType.officeOpenXML, .paperSize: paper,
        .leftMargin: defaultMargin, .rightMargin: defaultMargin, .topMargin: defaultMargin, .bottomMargin: defaultMargin]
    let manifest: [String: Any] = ["paper": ["width": paper.width, "height": paper.height], "margin": defaultMargin, "pictures": pictures]
    guard let word = try? text.data(from: NSRange(location: 0, length: text.length), documentAttributes: attributes),
          (try? word.write(to: URL(fileURLWithPath: output))) != nil,
          let listing = try? JSONSerialization.data(withJSONObject: manifest),
          (try? listing.write(to: URL(fileURLWithPath: folder).appendingPathComponent("pictures.json"))) != nil else {
        fail("The Word document could not be saved.")
    }
}

let args = CommandLine.arguments
switch (args.count > 1 ? args[1] : "") {
case "docx" where args.count == 4: wordPages(input: args[2], output: args[3])
case "pdf-docx" where args.count == 6: pdfWord(input: args[2], output: args[3], folder: args[4], marker: args[5])
case "slides" where args.count >= 4: slidePages(output: args[2], slides: Array(args[3...]))
case "slide-images" where args.count >= 4: slideImages(folder: args[2], slides: Array(args[3...]))
default: fail("Usage: render-document-pages docx <input> <output> | slides <output> <slide>... | slide-images <folder> <slide>... | pdf-docx <input> <output> <folder> <marker>")
}
