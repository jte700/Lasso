// A picture of the cells the sheet picker inserts: a small, clean table in
// the sheet's own words, light whatever the system's appearance (it goes
// into documents and messages), with the header row shaded, numbers set
// right, and the source written underneath when asked for. Drawn at Retina
// resolution.

import Cocoa

enum SheetPicture {
    static let scale: CGFloat = 2
    static let rowHeight: CGFloat = 24
    private static let cellPadding: CGFloat = 8
    private static let minColumnWidth: CGFloat = 36
    private static let maxColumnWidth: CGFloat = 320
    private static let captionGap: CGFloat = 6
    private static let captionHeight: CGFloat = 16
    private static let cellFont = NSFont.systemFont(ofSize: 13)
    private static let headingFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
    private static let captionFont = NSFont.systemFont(ofSize: 11)
    private static let paper = NSColor.white
    private static let ink = NSColor(white: 0.1, alpha: 1)
    private static let headingFill = NSColor(white: 0.93, alpha: 1)
    private static let rule = NSColor(white: 0.8, alpha: 1)
    private static let captionInk = NSColor(white: 0.42, alpha: 1)

    struct Layout: Equatable {
        let columnWidths: [CGFloat]
        let tableSize: NSSize
        /// The whole picture, the caption included.
        let size: NSSize
    }

    /// Each column as wide as its widest cell, within limits, and room under the table for the caption.
    static func layout(_ cells: [[String]], headed: Bool, caption: String?) -> Layout {
        let count = cells.map(\.count).max() ?? 0
        let widths = (0..<count).map { column -> CGFloat in
            let widest = cells.enumerated().map { index, row -> CGFloat in
                guard row.indices.contains(column) else { return 0 }
                let font = headed && index == 0 ? headingFont : cellFont
                return (row[column] as NSString).size(withAttributes: [.font: font]).width
            }.max() ?? 0
            return min(max(minColumnWidth, ceil(widest) + cellPadding * 2), maxColumnWidth)
        }
        let table = NSSize(width: widths.reduce(0, +), height: CGFloat(cells.count) * rowHeight)
        guard let caption, !caption.isEmpty else { return Layout(columnWidths: widths, tableSize: table, size: table) }
        let captionWidth = ceil((caption as NSString).size(withAttributes: [.font: captionFont]).width)
        return Layout(columnWidths: widths, tableSize: table,
                      size: NSSize(width: max(table.width, captionWidth), height: table.height + captionGap + captionHeight))
    }

    /// The picture, or nil when there is nothing to draw.
    static func render(_ cells: [[String]], headed: Bool, caption: String?) -> NSBitmapImageRep? {
        let layout = layout(cells, headed: headed, caption: caption)
        guard layout.tableSize.width > 0, layout.tableSize.height > 0,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(layout.size.width * scale),
                                         pixelsHigh: Int(layout.size.height * scale), bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let bitmap = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        rep.size = layout.size
        let context = bitmap.cgContext
        // Drawn top-down, as the rows read.
        context.translateBy(x: 0, y: CGFloat(rep.pixelsHigh))
        context.scaleBy(x: scale, y: -scale)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        draw(cells, headed: headed, caption: caption, layout: layout)
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    private static func draw(_ cells: [[String]], headed: Bool, caption: String?, layout: Layout) {
        paper.setFill()
        NSRect(origin: .zero, size: layout.size).fill()
        if headed {
            headingFill.setFill()
            NSRect(x: 0, y: 0, width: layout.tableSize.width, height: rowHeight).fill()
        }
        var x: CGFloat = 0
        for (column, width) in layout.columnWidths.enumerated() {
            for (index, row) in cells.enumerated() where row.indices.contains(column) && !row[column].isEmpty {
                let heading = headed && index == 0
                let frame = NSRect(x: x, y: CGFloat(index) * rowHeight, width: width, height: rowHeight)
                text(row[column], in: frame.insetBy(dx: cellPadding, dy: 0), font: heading ? headingFont : cellFont,
                     color: ink, right: !heading && SheetCells.isNumber(row[column]))
            }
            x += width
        }
        drawRules(layout)
        if let caption, !caption.isEmpty {
            text(caption, in: NSRect(x: 0, y: layout.tableSize.height + captionGap, width: layout.size.width, height: captionHeight),
                 font: captionFont, color: captionInk, right: false)
        }
    }

    /// The grid's lines, with the outline drawn inside the picture's edge.
    private static func drawRules(_ layout: Layout) {
        rule.setStroke()
        let lines = NSBezierPath()
        lines.lineWidth = 1 / scale
        let table = NSRect(origin: .zero, size: layout.tableSize).insetBy(dx: 0.25, dy: 0.25)
        lines.appendRect(table)
        var x: CGFloat = 0
        for width in layout.columnWidths.dropLast() {
            x += width
            lines.move(to: NSPoint(x: x, y: 0))
            lines.line(to: NSPoint(x: x, y: layout.tableSize.height))
        }
        var y = rowHeight
        while y < layout.tableSize.height - 0.5 {
            lines.move(to: NSPoint(x: 0, y: y))
            lines.line(to: NSPoint(x: layout.tableSize.width, y: y))
            y += rowHeight
        }
        lines.stroke()
    }

    private static func text(_ value: String, in frame: NSRect, font: NSFont, color: NSColor, right: Bool) {
        let style = NSMutableParagraphStyle()
        style.alignment = right ? .right : .left
        style.lineBreakMode = .byTruncatingTail
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: style]
        let height = (value as NSString).size(withAttributes: attributes).height
        let box = NSRect(x: frame.minX, y: frame.midY - height / 2, width: frame.width, height: height)
        (value as NSString).draw(with: box, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
    }
}
