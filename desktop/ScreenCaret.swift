//  Finding a drawn caret in a picture of the screen.
//
//  Google Docs and Slides draw their caret themselves and never report where
//  it is. On screen it is a bar about two points wide and a line tall, of
//  solid ink with blank page on both sides, and it blinks. Letters have
//  softened edges, run shorter than the line, or are wider, so a bar that
//  meets every test is the caret; when more than one does, the one that
//  blinked between two pictures is.

import CoreGraphics

/// Pixels of a picture in BGRA order, top row first.
struct PixelGrid {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let bytes: [UInt8]

    /// Redraws a picture in a known pixel layout.
    init?(image: CGImage) {
        let width = image.width
        let height = image.height
        let bytesPerRow = width * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: bytesPerRow, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        self.init(width: width, height: height, bytesPerRow: bytesPerRow, bytes: bytes)
    }

    init(width: Int, height: Int, bytesPerRow: Int, bytes: [UInt8]) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.bytes = bytes
    }

    /// Ink: dark in every channel, so a blue selection outline is not.
    func isInk(_ x: Int, _ y: Int) -> Bool {
        let index = y * bytesPerRow + x * 4
        return max(bytes[index], bytes[index + 1], bytes[index + 2]) < ScreenCaret.inkLimit
    }

    /// Blank page: light in every channel.
    func isBlank(_ x: Int, _ y: Int) -> Bool {
        guard x >= 0, x < width, y >= 0, y < height else { return false }
        let index = y * bytesPerRow + x * 4
        return min(bytes[index], bytes[index + 1], bytes[index + 2]) >= ScreenCaret.blankLimit
    }
}

/// A caret-shaped bar, in the picture's pixels.
struct CaretBar: Equatable {
    let x: Int
    let width: Int
    let top: Int
    let height: Int

    func matches(_ other: CaretBar) -> Bool {
        abs(x - other.x) <= 2 && abs(top - other.top) <= 2 && abs(height - other.height) <= 3
    }
}

enum ScreenCaret {
    static let inkLimit: UInt8 = 110
    static let blankLimit: UInt8 = 170
    /// A caret is at least this tall, in points: small text's line.
    static let minimumHeight: CGFloat = 8
    static let maximumHeight: CGFloat = 300
    /// Docs and Slides draw it two points wide; letters are wider at the
    /// sizes where they are this tall.
    static let maximumWidth: CGFloat = 3.5
    /// Share of the rows beside a bar that must be blank page.
    static let blankShare = 0.6
    private static let sideSamples = 9

    /// Every caret-shaped bar in the picture, left to right.
    static func bars(in grid: PixelGrid, scale: CGFloat) -> [CaretBar] {
        let shortest = Int(minimumHeight * scale)
        let tallest = Int(maximumHeight * scale)
        let widest = max(1, Int(maximumWidth * scale))
        let runs = verticalRuns(in: grid, shortest: shortest, tallest: tallest)
        var bars: [CaretBar] = []
        var x = 0
        while x < grid.width {
            for run in runs[x] {
                var width = 1
                while x + width < grid.width,
                      runs[x + width].contains(where: { abs($0.top - run.top) <= 2 && abs($0.height - run.height) <= 3 }) {
                    width += 1
                }
                let bar = CaretBar(x: x, width: width, top: run.top, height: run.height)
                if width <= widest, standsAlone(bar, in: grid) { bars.append(bar) }
            }
            x += 1
        }
        return bars
    }

    /// The caret after it moved: a bar of the same height as the one found
    /// last time, the nearest within reach. Letters on a line are shorter
    /// than its caret.
    static func follow(_ bars: [CaretBar], from last: CaretBar, reach: Int) -> CaretBar? {
        func distance(_ bar: CaretBar) -> Int { abs(bar.x - last.x) + abs(bar.top - last.top) }
        return bars.filter { abs($0.height - last.height) <= 3 && distance($0) <= reach }.min { distance($0) < distance($1) }
    }

    /// Lines looked through above and below the last caret.
    static let followLines: CGFloat = 3

    /// Where to look for a caret that was at `last`: the page's width, a few
    /// lines above and below, so a typed letter, a wrapped line or a little
    /// scrolling is followed with one small picture instead of the page.
    static func followBand(around last: CGRect, in page: CGRect) -> CGRect {
        let reach = last.height * followLines
        let band = CGRect(x: page.minX, y: last.minY - reach, width: page.width, height: last.height + reach * 2)
        return band.intersection(page)
    }

    /// The one bar missing from some of the pictures, which were taken a
    /// fraction of a blink apart. Nil while none or several blinked.
    static func blinking(in frames: [[CaretBar]]) -> CaretBar? {
        var blinked: [CaretBar] = []
        for bar in frames.joined()
        where !frames.allSatisfy({ $0.contains(where: bar.matches) }) && !blinked.contains(where: bar.matches) {
            blinked.append(bar)
        }
        return blinked.count == 1 ? blinked[0] : nil
    }

    /// For each column, its runs of ink between the two heights.
    private static func verticalRuns(in grid: PixelGrid, shortest: Int,
                                     tallest: Int) -> [[(top: Int, height: Int)]] {
        var runs = Array(repeating: [(top: Int, height: Int)](), count: grid.width)
        var start = Array(repeating: -1, count: grid.width)
        for y in 0...grid.height {
            for x in 0..<grid.width {
                let ink = y < grid.height && grid.isInk(x, y)
                if ink {
                    if start[x] < 0 { start[x] = y }
                } else if start[x] >= 0 {
                    let height = y - start[x]
                    if height >= shortest, height <= tallest { runs[x].append((start[x], height)) }
                    start[x] = -1
                }
            }
        }
        return runs
    }

    /// Blank page on both sides and just above and below. A caret drawn at
    /// a fractional position may have one half-shaded pixel on one side;
    /// a letter's edges are softened on both.
    private static func standsAlone(_ bar: CaretBar, in grid: PixelGrid) -> Bool {
        let rows = (0..<sideSamples).map { bar.top + bar.height * ($0 + 1) / (sideSamples + 1) }
        let needed = Int((Double(sideSamples) * blankShare).rounded(.up))
        func blank(_ x: Int) -> Bool { rows.filter { grid.isBlank(x, $0) }.count >= needed }
        // Shaded lighter than ink, so a column inside a wider bar is not one.
        func fringe(_ x: Int) -> Bool { x >= 0 && x < grid.width && rows.allSatisfy { !grid.isInk(x, $0) } }
        let left = blank(bar.x - 1)
        let right = blank(bar.x + bar.width)
        let sides = (left && right)
            || (left && fringe(bar.x + bar.width) && blank(bar.x + bar.width + 1))
            || (right && fringe(bar.x - 1) && blank(bar.x - 2))
        let middle = bar.x + bar.width / 2
        return sides && grid.isBlank(middle, bar.top - 1) && grid.isBlank(middle, bar.top + bar.height)
    }
}
