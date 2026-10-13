import Foundation
import PDFKit

// This helper extracts existing selectable text only. A scan must be OCR'd before
// it can provide trustworthy dimensions; it is never guessed from line geometry.
func finish(_ object: [String: Any], exitCode: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
    }
    exit(exitCode)
}

let arguments = CommandLine.arguments
if arguments.count < 2 { finish(["error": "Missing PDF path"], exitCode: 2) }
guard let document = PDFDocument(url: URL(fileURLWithPath: arguments[1])) else {
    finish(["error": "PDFKit could not open this PDF"], exitCode: 2)
}
if document.isLocked { finish(["error": "This PDF is locked and requires a password"], exitCode: 2) }
let pageLimit = min(100, max(1, Int(arguments.count > 2 ? arguments[2] : "80") ?? 80))
let wordPattern = try! NSRegularExpression(pattern: "\\S+")
var pages: [[String: Any]] = []
var warnings: [String] = []
var remainingCharacters = 1_500_000
for index in 0..<min(document.pageCount, pageLimit) {
    guard let page = document.page(at: index) else { continue }
    let crop = page.bounds(for: .cropBox)
    guard crop.width > 0, crop.height > 0 else { continue }
    let rotation = ((page.rotation % 360) + 360) % 360
    let rotated = rotation == 90 || rotation == 270
    let string = (page.string ?? "") as NSString
    let length = min(string.length, 150_000, remainingCharacters)
    if length < string.length { warnings.append("Text on page \(index + 1) exceeded the extraction limit.") }
    remainingCharacters -= length
    let text = string.substring(with: NSRange(location: 0, length: length))
    var words: [[String: Any]] = []
    let matches = wordPattern.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length))
    for match in matches.prefix(25_000) {
        guard let selection = page.selection(for: match.range) else { continue }
        let rect = selection.bounds(for: page).intersection(crop)
        if rect.isNull || rect.width <= 0 || rect.height <= 0 { continue }
        let corners = [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.maxY)]
        let transformed = corners.map { point -> CGPoint in
            let x = (point.x - crop.minX) / crop.width
            let y = (point.y - crop.minY) / crop.height
            switch rotation {
            case 90: return CGPoint(x: y, y: x)
            case 180: return CGPoint(x: 1 - x, y: y)
            case 270: return CGPoint(x: 1 - y, y: 1 - x)
            default: return CGPoint(x: x, y: 1 - y)
            }
        }
        let left = min(transformed[0].x, transformed[1].x)
        let top = min(transformed[0].y, transformed[1].y)
        let width = abs(transformed[1].x - transformed[0].x)
        let height = abs(transformed[1].y - transformed[0].y)
        func rounded(_ value: CGFloat) -> Double { (Double(value) * 1_000_000).rounded() / 1_000_000 }
        words.append([
            "text": (text as NSString).substring(with: match.range),
            "bbox": ["x": rounded(left), "y": rounded(top), "width": rounded(width), "height": rounded(height)]
        ])
    }
    if matches.count > 25_000 { warnings.append("Words on page \(index + 1) exceeded the extraction limit.") }
    pages.append([
        "pageNumber": index + 1, "width": Double(rotated ? crop.height : crop.width),
        "height": Double(rotated ? crop.width : crop.height), "rotation": rotation,
        "text": text, "words": words
    ])
    if remainingCharacters <= 0 {
        warnings.append("Document text exceeded the extraction limit.")
        break
    }
}
if document.pageCount > pageLimit { warnings.append("Only the first \(pageLimit) of \(document.pageCount) pages were indexed.") }
finish(["pageCount": document.pageCount, "pages": pages, "warnings": warnings])
