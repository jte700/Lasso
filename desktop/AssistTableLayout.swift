import Cocoa

/// Geometry for the spreadsheet excerpt in the suggestion card: which columns
/// fit and how wide each is, which rows fit around the cited cell, and where
/// text overflows into empty cells to its right, as it does in the sheet.
/// Pure layout, so the card and its tests share it.
struct AssistTableLayout {
    /// A whole column, listed from its first row instead of around one cited
    /// cell. It scrolls, and the card says how many rows are below the ones shown.
    struct Listing: Equatable {
        /// The row scrolled to the top; the layout keeps it in range.
        var firstRow = 0
        /// Rows of the column the server left out after the last row it sent.
        var moreRows = 0
    }

    struct Cell: Equatable {
        /// Index into `visibleColumns`.
        let column: Int
        /// Visible columns this cell's text covers, counting its own.
        let span: Int
        let alignment: NSTextAlignment
    }

    static let rowHeaderWidth: CGFloat = 37
    static let cellPadding: CGFloat = 8
    static let cellFont = NSFont.systemFont(ofSize: 10)
    static let citedFont = NSFont.systemFont(ofSize: 10, weight: .medium)
    static let headingFont = NSFont.systemFont(ofSize: 11, weight: .semibold)
    static let letterFont = NSFont.systemFont(ofSize: 10)
    /// Space above a heading for its column letter, such as C.
    static let letterHeight: CGFloat = 13
    static let headerTopPadding: CGFloat = 7
    static let headerBottomPadding: CGFloat = 8
    /// The line under a listed column that counts the rows below it.
    static let moreRowsHeight: CGFloat = 22
    private static let maximumColumns = 6
    private static let minimumLabelShare: CGFloat = 0.3
    private static let maximumLabelShare: CGFloat = 0.5
    private static let minimumColumnWidth: CGFloat = 44
    private static let maximumHeadingLines = 3
    private static let maximumCitedLines = 3

    let rowHeight: CGFloat = 27
    let visibleColumns: [Int]
    let columnWidths: [CGFloat]
    /// Visible column indexes whose values are numbers, aligned right.
    let numericColumns: Set<Int>
    let headerHeight: CGFloat
    /// The rows of the excerpt that fit, around the cited row.
    let rowRange: Range<Int>
    /// Heights of the rows in `rowRange`. A cited cell too long for one line wraps.
    let rowHeights: [CGFloat]
    /// Rows of a listed column below `rowRange`, counting rows the server left
    /// out. Always 0 around a cited cell.
    let rowsBelow: Int
    /// The highest row a listed column can scroll to the top: from there its
    /// last rows fit. 0 when every row fits, or around a cited cell.
    let lastFirstRow: Int
    private let measure: (String, NSFont) -> CGFloat

    static func textWidth(_ text: String, _ font: NSFont) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    static func lineHeight(_ font: NSFont) -> CGFloat {
        ceil(font.ascender - font.descender + font.leading) + 1
    }

    init(headers: [String], rows: [AssistPreviewRow], size: CGSize, listing: Listing? = nil,
         measure: @escaping (String, NSFont) -> CGFloat = AssistTableLayout.textWidth) {
        self.measure = measure
        let columnCount = max(1, headers.count, rows.map(\.cells.count).max() ?? 0)
        let citedRow = rows.firstIndex { $0.cells.contains(where: \.cited) } ?? 0
        let citedColumn = rows.indices.contains(citedRow)
            ? rows[citedRow].cells.firstIndex(where: \.cited) ?? 0 : 0
        let natural = (0..<columnCount).map {
            Self.naturalWidth(column: $0, headers: headers, rows: rows, measure: measure)
        }
        let dataWidth = max(1, size.width - Self.rowHeaderWidth)
        let columns = Self.chooseColumns(natural: natural, cited: citedColumn, dataWidth: dataWidth)
        let widths = Self.widths(for: columns, natural: natural, dataWidth: dataWidth)
        let header = Self.headerHeight(headers: headers, columns: columns, widths: widths, measure: measure)
        let base = rowHeight
        let heights = rows.map { Self.height(of: $0, columns: columns, widths: widths, base: base, measure: measure) }
        let available = size.height - header
        let range: Range<Int>
        if let listing {
            lastFirstRow = Self.lastFirstRow(heights: heights, available: available, moreRows: listing.moreRows)
            range = Self.listedRows(heights: heights, from: min(max(0, listing.firstRow), lastFirstRow),
                                    available: available, moreRows: listing.moreRows)
            rowsBelow = heights.count - range.upperBound + max(0, listing.moreRows)
        } else {
            lastFirstRow = 0
            range = Self.fittingRows(heights: heights, around: citedRow, available: available)
            rowsBelow = 0
        }
        visibleColumns = columns
        columnWidths = widths
        numericColumns = Set(columns.indices.filter { Self.isNumericColumn(columns[$0], rows: rows) })
        headerHeight = header
        rowRange = range
        rowHeights = Array(heights[range])
    }

    /// The cells of `row` to draw, left to right. A cell whose text is wider
    /// than its column covers the empty cells to its right, like in a sheet.
    func cells(in row: AssistPreviewRow) -> [Cell] {
        var cells: [Cell] = []
        var index = 0
        while index < visibleColumns.count {
            let value = Self.value(row, visibleColumns[index])
            let numeric = Self.isNumeric(value)
            var span = 1
            if !value.isEmpty, !numeric,
               measure(value, Self.cellFont) + 2 * Self.cellPadding > columnWidths[index] {
                while index + span < visibleColumns.count,
                      Self.isEmpty(row, from: visibleColumns[index] + 1, through: visibleColumns[index + span]) {
                    span += 1
                }
            }
            cells.append(Cell(column: index, span: span, alignment: numeric ? .right : .left))
            index += span
        }
        return cells
    }

    /// Left edge of a visible column, relative to the first data column.
    func offset(of column: Int) -> CGFloat {
        columnWidths.prefix(column).reduce(0, +)
    }

    func width(of cell: Cell) -> CGFloat {
        columnWidths[cell.column..<(cell.column + cell.span)].reduce(0, +)
    }

    /// True when empty sheet rows were left out just above `rows[index]`.
    func startsAfterGap(_ rows: [AssistPreviewRow], at index: Int) -> Bool {
        guard index > 0, index < rows.count,
              let current = rows[index].rowNumber, let previous = rows[index - 1].rowNumber else { return false }
        return current - previous > 1
    }

    static func isNumeric(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed == "-" { return true }
        // Scientific notation as a sheet shows it, such as 1.23E+04.
        if trimmed.range(of: #"^[-+(]?\d+(\.\d+)?[eE][+-]\d+\)?$"#, options: .regularExpression) != nil { return true }
        let digits = trimmed.filter { !"$€£¥%(),+- ".contains($0) }
        return digits.contains(where: \.isNumber) && digits.allSatisfy { $0.isNumber || $0 == "." }
    }

    // MARK: Measuring

    private static func value(_ row: AssistPreviewRow, _ column: Int) -> String {
        row.cells.indices.contains(column) ? row.cells[column].value : ""
    }

    private static func isEmpty(_ row: AssistPreviewRow, from first: Int, through last: Int) -> Bool {
        first > last || (first...last).allSatisfy { value(row, $0).isEmpty }
    }

    /// Text alone at the end of its row, such as a note: it overflows anyway,
    /// so it does not widen its column.
    private static func overflows(_ row: AssistPreviewRow, _ column: Int) -> Bool {
        let text = value(row, column)
        return !text.isEmpty && !isNumeric(text) && isEmpty(row, from: column + 1, through: max(column + 1, row.cells.count - 1))
    }

    private static func naturalWidth(column: Int, headers: [String], rows: [AssistPreviewRow],
                                     measure: (String, NSFont) -> CGFloat) -> CGFloat {
        let values = rows.filter { !overflows($0, column) }.map { value($0, column) }
        let widest = values.map { measure($0, cellFont) }.max() ?? 0
        // Headings wrap between words, so only their longest word must fit.
        let heading = headers.indices.contains(column) ? headers[column] : ""
        let word = heading.split(separator: " ").map { measure(String($0), headingFont) }.max() ?? 0
        return max(minimumColumnWidth, max(widest, word) + 2 * cellPadding)
    }

    private static func isNumericColumn(_ column: Int, rows: [AssistPreviewRow]) -> Bool {
        let values = rows.filter { !overflows($0, column) }.map { value($0, column) }.filter { !$0.isEmpty }
        return !values.isEmpty && values.filter(isNumeric).count * 2 > values.count
    }

    private static func lineCount(_ text: String, width: CGFloat, font: NSFont,
                                  measure: (String, NSFont) -> CGFloat) -> Int {
        let space = measure(" ", font)
        var lines = 1
        var current: CGFloat = 0
        for word in text.split(separator: " ") {
            let wordWidth = measure(String(word), font)
            if current == 0 { current = wordWidth }
            else if current + space + wordWidth <= width { current += space + wordWidth }
            else { lines += 1; current = wordWidth }
        }
        return lines
    }

    // MARK: Columns

    /// The label column, the cited column, then its neighbours (right first)
    /// while they fit at their natural width.
    private static func chooseColumns(natural: [CGFloat], cited: Int, dataWidth: CGFloat) -> [Int] {
        guard natural.count > 1 else { return [0] }
        let neighbours = natural.indices.filter { $0 != 0 }.sorted {
            let left = abs($0 - cited), right = abs($1 - cited)
            return left != right ? left < right : $0 > $1
        }
        var chosen = [0]
        var used = min(natural[0], dataWidth * minimumLabelShare)
        for column in neighbours where chosen.count < maximumColumns {
            guard column == cited || used + natural[column] <= dataWidth else { break }
            chosen.append(column)
            used += natural[column]
        }
        return chosen.sorted()
    }

    private static func widths(for columns: [Int], natural: [CGFloat], dataWidth: CGFloat) -> [CGFloat] {
        guard columns.count > 1 else { return [dataWidth] }
        let others = columns.dropFirst().map { natural[$0] }
        let othersWidth = others.reduce(0, +)
        let preferred = min(natural[0], dataWidth * maximumLabelShare)
        let label = max(minimumColumnWidth, min(preferred, dataWidth - othersWidth))
        let widths = [label] + others
        let total = widths.reduce(0, +)
        if total <= dataWidth {
            // Spare room is shared in proportion, so the columns fill the table.
            return widths.map { $0 + (dataWidth - total) * $0 / total }
        }
        // A cited column wider than the room left shrinks the others to fit.
        let scale = max(0, dataWidth - label) / othersWidth
        return [label] + others.map { $0 * scale }
    }

    // MARK: Rows

    private static func headerHeight(headers: [String], columns: [Int], widths: [CGFloat],
                                     measure: (String, NSFont) -> CGFloat) -> CGFloat {
        let lines = columns.indices.map { index -> Int in
            let heading = headers.indices.contains(columns[index]) ? headers[columns[index]] : ""
            return min(maximumHeadingLines, lineCount(heading.isEmpty ? "Column" : heading,
                       width: widths[index] - 2 * cellPadding, font: headingFont, measure: measure))
        }.max() ?? 1
        return headerTopPadding + letterHeight + CGFloat(lines) * lineHeight(headingFont) + headerBottomPadding
    }

    private static func height(of row: AssistPreviewRow, columns: [Int], widths: [CGFloat], base: CGFloat,
                               measure: @escaping (String, NSFont) -> CGFloat) -> CGFloat {
        guard row.cells.contains(where: \.cited) else { return base }
        let layout = AssistTableLayout.cellsOnly(row: row, columns: columns, widths: widths, measure: measure)
        let lines = layout.compactMap { cell -> Int? in
            let column = columns[cell.column]
            guard row.cells.indices.contains(column), row.cells[column].cited else { return nil }
            let width = widths[cell.column..<(cell.column + cell.span)].reduce(0, +) - 2 * cellPadding
            return lineCount(row.cells[column].value, width: width, font: citedFont, measure: measure)
        }.max() ?? 1
        return base + CGFloat(min(maximumCitedLines, lines) - 1) * lineHeight(citedFont)
    }

    /// Cells of a row for a layout still being built.
    private static func cellsOnly(row: AssistPreviewRow, columns: [Int], widths: [CGFloat],
                                  measure: @escaping (String, NSFont) -> CGFloat) -> [Cell] {
        AssistTableLayout(columns: columns, widths: widths, measure: measure).cells(in: row)
    }

    private init(columns: [Int], widths: [CGFloat], measure: @escaping (String, NSFont) -> CGFloat) {
        self.measure = measure
        visibleColumns = columns
        columnWidths = widths
        numericColumns = []
        headerHeight = 0
        rowRange = 0..<0
        rowHeights = []
        rowsBelow = 0
        lastFirstRow = 0
    }

    /// The cited row and as many rows around it as fit, taking one above,
    /// then one below, so a cited last row still has the table above it.
    private static func fittingRows(heights: [CGFloat], around cited: Int, available: CGFloat) -> Range<Int> {
        guard heights.indices.contains(cited) else { return 0..<0 }
        var lower = cited, upper = cited + 1
        var used = heights[cited]
        var above = true
        while lower > 0 || upper < heights.count {
            let takeAbove = lower > 0 && (above || upper >= heights.count)
            let candidate = takeAbove ? lower - 1 : upper
            guard used + heights[candidate] <= available else { break }
            used += heights[candidate]
            if takeAbove { lower -= 1 } else { upper += 1 }
            above.toggle()
        }
        return lower..<upper
    }

    /// Rows from `first` down while they fit, leaving room for the count of
    /// rows below when some are left out. At least one row is shown.
    private static func listedRows(heights: [CGFloat], from first: Int, available: CGFloat,
                                   moreRows: Int) -> Range<Int> {
        guard heights.indices.contains(first) else { return 0..<0 }
        if moreRows <= 0, heights[first...].reduce(0, +) <= available { return first..<heights.count }
        var upper = first, used: CGFloat = 0
        while upper < heights.count, used + heights[upper] <= available - moreRowsHeight {
            used += heights[upper]
            upper += 1
        }
        return first..<max(upper, first + 1)
    }

    /// The first row from which the column's last rows fit, with the count
    /// line still under them when the server left rows out.
    private static func lastFirstRow(heights: [CGFloat], available: CGFloat, moreRows: Int) -> Int {
        let room = available - (moreRows > 0 ? moreRowsHeight : 0)
        var first = heights.count, used: CGFloat = 0
        while first > 0, used + heights[first - 1] <= room {
            used += heights[first - 1]
            first -= 1
        }
        return min(first, max(0, heights.count - 1))
    }
}
