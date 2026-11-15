// The sheet picker's grid: the sheet's cells as they look in Excel, with
// column letters and row numbers that stay in view while it scrolls. Each
// drag draws a new highlight, so highlights need not touch; a click on a
// letter or number takes the whole column or row. The panel never takes the
// keyboard, so drags are tracked here with `window.nextEvent`.

import Cocoa

final class SheetGridView: NSView {
    static let rowHeight: CGFloat = 22
    static let headerHeight: CGFloat = 22
    static let rowHeaderWidth: CGFloat = 46
    private static let minColumnWidth: CGFloat = 56
    private static let maxColumnWidth: CGFloat = 240
    private static let cellPadding: CGFloat = 6
    /// Rows read to size the columns; a long sheet is sized from its top.
    private static let sizingRows = 300
    /// The share of a column's filled cells that must be words for words to size it.
    private static let wordyShare = 0.25
    private static let cellFont = NSFont.systemFont(ofSize: 12)
    private static let headingFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
    private static let letterFont = NSFont.systemFont(ofSize: 11)

    private(set) var document: SheetDocument?
    private var columnWidths: [CGFloat] = []
    private var columnStarts: [CGFloat] = []
    var highlights = SheetHighlights() { didSet { needsDisplay = true } }
    /// The folder's colour, which highlights are drawn in, as the card marks its words.
    var highlightColor: NSColor = .controlAccentColor { didSet { needsDisplay = true } }
    /// A drag or click changed the highlights.
    var onHighlightsChange: ((SheetHighlights) -> Void)?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func show(_ document: SheetDocument) {
        self.document = document
        // Titles above the header row spill across columns, as in Excel, so they do not size them.
        let sized = document.rows.drop { row in document.headerRow.map { row.number < $0 } ?? false }.prefix(Self.sizingRows)
        columnWidths = document.columns.indices.map { column in
            let texts = sized.map { $0.cells.indices.contains(column) ? $0.cells[column] : "" }
            // Numbers, the header and a column of words fit whole, up to the
            // widest a column is drawn; a longer note spills into the empty cells beside it.
            let width = { (text: String, font: NSFont) in (text as NSString).size(withAttributes: [.font: font]).width }
            let words = texts.filter { !$0.isEmpty && !Self.isNumber($0) }.map { width($0, Self.cellFont) }.sorted()
            // A column of numbers with a rare note under it is sized for its numbers.
            let filled = texts.filter { !$0.isEmpty }.count
            let wordy = !words.isEmpty && Double(words.count) >= Double(filled) * Self.wordyShare
            let typical = wordy ? words.last ?? 0 : 0
            let numbers = texts.filter(Self.isNumber).map { width($0, Self.cellFont) }.max() ?? 0
            let heading = document.headerRow.map { width(document.cell(row: $0, column: column), Self.headingFont) } ?? 0
            let needed = max(typical, numbers, heading)
            return min(max(Self.minColumnWidth, ceil(needed) + Self.cellPadding * 2), Self.maxColumnWidth)
        }
        columnStarts = columnWidths.reduce(into: [Self.rowHeaderWidth]) { $0.append($0.last! + $1) }
        setFrameSize(NSSize(width: columnStarts.last ?? Self.rowHeaderWidth,
                            height: Self.headerHeight + CGFloat(document.rows.count) * Self.rowHeight))
        needsDisplay = true
    }

    // MARK: Geometry

    private func cellRect(rowIndex: Int, column: Int) -> NSRect {
        NSRect(x: columnStarts[column], y: Self.headerHeight + CGFloat(rowIndex) * Self.rowHeight,
               width: columnWidths[column], height: Self.rowHeight)
    }

    /// The rectangle a range covers, from its top-left cell to its bottom-right one.
    func rect(of range: SheetRange) -> NSRect? {
        guard let document, let top = document.index(ofRow: range.top), let bottom = document.index(ofRow: range.bottom),
              columnWidths.indices.contains(range.left), columnWidths.indices.contains(range.right) else { return nil }
        return cellRect(rowIndex: top, column: range.left).union(cellRect(rowIndex: bottom, column: range.right))
    }

    private func rowIndex(at y: CGFloat) -> Int? {
        guard let document, !document.rows.isEmpty else { return nil }
        return min(max(0, Int((y - Self.headerHeight) / Self.rowHeight)), document.rows.count - 1)
    }

    private func column(at x: CGFloat) -> Int? {
        guard !columnWidths.isEmpty else { return nil }
        let index = columnStarts.dropLast().lastIndex { $0 <= x } ?? 0
        return min(index, columnWidths.count - 1)
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        NSColor.textBackgroundColor.setFill()
        dirtyRect.fill()
        guard let document, !columnWidths.isEmpty else { return }
        let visible = visibleRect
        let first = max(0, Int((dirtyRect.minY - Self.headerHeight) / Self.rowHeight))
        let last = min(document.rows.count - 1, Int((dirtyRect.maxY - Self.headerHeight) / Self.rowHeight) + 1)
        let columns = columnWidths.indices.filter { columnStarts[$0] < dirtyRect.maxX && columnStarts[$0 + 1] > dirtyRect.minX }
        if first <= last {
            for index in first...last { drawRow(index, columns: columns, in: document) }
        }
        drawHighlights(in: document)
        drawHeaders(visible: visible, rows: first...max(first, last), columns: columns, in: document)
    }

    /// The row's grid lines, then its text over them: text that is not a
    /// number runs on across the empty cells to its right, as in the sheet.
    private func drawRow(_ index: Int, columns: [Int], in document: SheetDocument) {
        let row = document.rows[index]
        let heading = row.number == document.headerRow
        NSColor.separatorColor.setStroke()
        for column in columns {
            let grid = NSBezierPath(rect: cellRect(rowIndex: index, column: column).insetBy(dx: -0.5, dy: -0.5))
            grid.lineWidth = 0.5
            grid.stroke()
        }
        guard let firstShown = columns.first, let lastShown = columns.last else { return }
        let text = { (column: Int) in row.cells.indices.contains(column) ? row.cells[column] : "" }
        for column in 0...lastShown where !text(column).isEmpty {
            let value = text(column)
            let number = Self.isNumber(value)
            var end = column
            if !number { while end + 1 < columnWidths.count, text(end + 1).isEmpty { end += 1 } }
            guard end >= firstShown else { continue }
            let frame = cellRect(rowIndex: index, column: column).union(cellRect(rowIndex: index, column: end))
            drawText(value, in: frame, font: heading ? Self.headingFont : Self.cellFont, right: !heading && number)
        }
    }

    private func drawText(_ text: String, in frame: NSRect, font: NSFont, right: Bool, color: NSColor = .labelColor) {
        let style = NSMutableParagraphStyle()
        style.alignment = right ? .right : .left
        style.lineBreakMode = .byTruncatingTail
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: style]
        let height = (text as NSString).size(withAttributes: attributes).height
        let box = NSRect(x: frame.minX + Self.cellPadding, y: frame.midY - height / 2,
                         width: frame.width - Self.cellPadding * 2, height: height)
        (text as NSString).draw(with: box, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
    }

    /// Each highlight tinted in the folder's colour and outlined; when there
    /// are several, each is numbered in the order it was made.
    private func drawHighlights(in document: SheetDocument) {
        let numbered = highlights.ranges.count > 1
        for (order, range) in highlights.ranges.enumerated() {
            guard let frame = rect(of: range) else { continue }
            highlightColor.withAlphaComponent(0.22).setFill()
            frame.fill()
            highlightColor.setStroke()
            let outline = NSBezierPath(rect: frame.insetBy(dx: 0.75, dy: 0.75))
            outline.lineWidth = 1.5
            outline.stroke()
            guard numbered else { continue }
            // On the highlight's top-left corner, clear of the cell's text.
            let badge = NSRect(x: frame.minX - 7, y: frame.minY - 7, width: 15, height: 15)
            highlightColor.setFill()
            NSBezierPath(ovalIn: badge).fill()
            let label = "\(order + 1)" as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 9, weight: .bold), .foregroundColor: NSColor.white]
            let size = label.size(withAttributes: attributes)
            label.draw(at: NSPoint(x: badge.midX - size.width / 2, y: badge.midY - size.height / 2), withAttributes: attributes)
        }
    }

    /// The letters along the top and numbers down the side, pinned to the
    /// visible edges, with the highlighted ones shaded as Excel shades them.
    private func drawHeaders(visible: NSRect, rows: ClosedRange<Int>, columns: [Int], in document: SheetDocument) {
        let shade = NSColor.windowBackgroundColor
        let marked = highlightColor.withAlphaComponent(0.18)
        let top = NSRect(x: visible.minX, y: visible.minY, width: visible.width, height: Self.headerHeight)
        shade.setFill()
        top.fill()
        for column in columns {
            var frame = cellRect(rowIndex: 0, column: column)
            frame.origin.y = visible.minY
            if highlights.ranges.contains(where: { (($0.left)...($0.right)).contains(column) }) { marked.setFill(); frame.fill() }
            drawText(document.columns[column], in: frame, font: Self.letterFont, right: false, color: .secondaryLabelColor)
        }
        let side = NSRect(x: visible.minX, y: visible.minY, width: Self.rowHeaderWidth, height: visible.height)
        shade.setFill()
        side.fill()
        for index in rows where index < document.rows.count {
            var frame = cellRect(rowIndex: index, column: 0)
            frame.origin.x = visible.minX
            frame.size.width = Self.rowHeaderWidth
            guard frame.maxY > visible.minY + Self.headerHeight else { continue }
            let number = document.rows[index].number
            if highlights.ranges.contains(where: { (($0.top)...($0.bottom)).contains(number) }) { marked.setFill(); frame.fill() }
            drawText("\(number)", in: frame, font: Self.letterFont, right: true, color: .secondaryLabelColor)
        }
        shade.setFill()
        NSRect(x: visible.minX, y: visible.minY, width: Self.rowHeaderWidth, height: Self.headerHeight).fill()
        NSColor.separatorColor.setFill()
        NSRect(x: visible.minX, y: visible.minY + Self.headerHeight - 0.5, width: visible.width, height: 0.5).fill()
        NSRect(x: visible.minX + Self.rowHeaderWidth - 0.5, y: visible.minY, width: 0.5, height: visible.height).fill()
    }

    static func isNumber(_ text: String) -> Bool { SheetCells.isNumber(text) }

    // MARK: Highlighting

    /// A drag adds a highlight from the cell it starts on to the cell it ends
    /// on. Starting on a letter or number takes whole columns or rows.
    override func mouseDown(with event: NSEvent) {
        guard let window, let document, !document.rows.isEmpty else { return }
        let start = convert(event.locationInWindow, from: nil)
        let visible = visibleRect
        let onLetters = start.y < visible.minY + Self.headerHeight
        let onNumbers = start.x < visible.minX + Self.rowHeaderWidth
        guard let startRow = rowIndex(at: start.y), let startColumn = column(at: start.x) else { return }
        let range = { (point: NSPoint) -> SheetRange? in
            guard let row = self.rowIndex(at: point.y), let column = self.column(at: point.x) else { return nil }
            let lastRow = document.rows.count - 1, lastColumn = self.columnWidths.count - 1
            if onLetters, onNumbers { return nil }
            if onLetters {
                return SheetRange(top: document.rows[0].number, bottom: document.rows[lastRow].number, left: startColumn, right: column)
            }
            if onNumbers {
                return SheetRange(top: document.rows[startRow].number, bottom: document.rows[row].number, left: 0, right: lastColumn)
            }
            return SheetRange(top: document.rows[startRow].number, bottom: document.rows[row].number, left: startColumn, right: column)
        }
        guard let first = range(start) else { return }
        update(highlights.adding(first))
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            autoscroll(with: next)
            if let grown = range(convert(next.locationInWindow, from: nil)) { update(highlights.replacingLatest(with: grown)) }
        }
    }

    func update(_ changed: SheetHighlights) {
        guard changed != highlights else { return }
        highlights = changed
        onHighlightsChange?(changed)
    }

    /// The latest highlight scrolled into view, as arrows and the opening highlight need.
    func revealLatest(centered: Bool = false) {
        guard let range = highlights.ranges.last, let frame = rect(of: range) else { return }
        guard centered, let clip = enclosingScrollView?.contentView else {
            scrollToVisible(frame.insetBy(dx: -Self.rowHeaderWidth, dy: -Self.headerHeight * 2))
            return
        }
        // Sideways only as far as the highlight needs to be seen.
        let x = frame.maxX <= clip.bounds.width ? 0 : frame.minX - Self.rowHeaderWidth - 8
        let origin = NSPoint(x: max(0, min(x, bounds.width - clip.bounds.width)),
                             y: max(0, min(frame.midY - clip.bounds.height / 2, bounds.height - clip.bounds.height)))
        clip.scroll(to: origin)
        enclosingScrollView?.reflectScrolledClipView(clip)
    }
}
