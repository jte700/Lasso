// The sheet picker's sheet, read from `/api/dependency-objects/:id/sheet`, and
// the highlights drawn on it. Highlights are kept in the order they were
// made; they need not touch, and ⌘Z takes back the latest.

import Foundation

/// A block of cells: rows by their sheet numbers, columns from 0 (A).
struct SheetRange: Equatable {
    let top: Int, bottom: Int, left: Int, right: Int

    /// Corners given either way round make the same range.
    init(top: Int, bottom: Int, left: Int, right: Int) {
        self.top = min(top, bottom)
        self.bottom = max(top, bottom)
        self.left = min(left, right)
        self.right = max(left, right)
    }

    func contains(row: Int, column: Int) -> Bool {
        (top...bottom).contains(row) && (left...right).contains(column)
    }

    /// As Excel names it: "B3", or "A2:C5".
    var a1: String {
        let start = "\(SheetRange.letters(left))\(top)"
        return top == bottom && left == right ? start : "\(start):\(SheetRange.letters(right))\(bottom)"
    }

    static func letters(_ column: Int) -> String {
        var label = ""
        var n = column
        while n >= 0 {
            label = String(UnicodeScalar(UInt8(65 + n % 26))) + label
            n = n / 26 - 1
        }
        return label
    }
}

struct SheetRow: Equatable {
    let number: Int
    let cells: [String]
}

struct SheetDocument {
    let name: String
    /// The worksheet's name; nil for a CSV.
    let sheet: String?
    let sheets: [String]
    let columns: [String]
    let rows: [SheetRow]
    let headerRow: Int?
    /// The cited cell, row or column, highlighted when the picker opens.
    let selection: SheetRange?
    let truncated: Bool
    var unavailable: String? = nil

    static func parse(_ data: Data) -> SheetDocument? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let document = root["document"] as? [String: Any],
              let name = document["name"] as? String else { return nil }
        let rows = (document["rows"] as? [[String: Any]] ?? []).compactMap { row -> SheetRow? in
            guard let number = row["number"] as? Int else { return nil }
            return SheetRow(number: number, cells: (row["cells"] as? [Any] ?? []).map { "\($0)" })
        }
        let selection = (document["selection"] as? [String: Any]).flatMap { range -> SheetRange? in
            guard let top = range["top"] as? Int, let bottom = range["bottom"] as? Int,
                  let left = range["left"] as? Int, let right = range["right"] as? Int else { return nil }
            return SheetRange(top: top, bottom: bottom, left: left, right: right)
        }
        return SheetDocument(name: name, sheet: document["sheet"] as? String, sheets: document["sheets"] as? [String] ?? [],
                             columns: document["columns"] as? [String] ?? [], rows: rows,
                             headerRow: document["headerRow"] as? Int, selection: selection,
                             truncated: document["truncated"] as? Bool ?? false,
                             unavailable: document["unavailable"] as? String)
    }

    /// The position of the row with this sheet number among the rows shown.
    func index(ofRow number: Int) -> Int? {
        rows.firstIndex { $0.number == number }
    }

    /// A cell as the sheet shows it; empty where the sheet has nothing.
    func cell(row number: Int, column: Int) -> String {
        guard let index = index(ofRow: number), rows[index].cells.indices.contains(column) else { return "" }
        return rows[index].cells[column]
    }
}

/// The highlights on a sheet, in the order they were made, with the ones
/// ⌘Z took back kept for ⇧⌘Z until a new one is made.
struct SheetHighlights: Equatable {
    private(set) var ranges: [SheetRange] = []
    private var undone: [SheetRange] = []

    var isEmpty: Bool { ranges.isEmpty }

    func adding(_ range: SheetRange) -> SheetHighlights {
        SheetHighlights(ranges: ranges + [range], undone: [])
    }

    /// The same highlights with the latest one changed, as a drag grows it.
    func replacingLatest(with range: SheetRange) -> SheetHighlights {
        guard !ranges.isEmpty else { return adding(range) }
        return SheetHighlights(ranges: Array(ranges.dropLast()) + [range], undone: undone)
    }

    func undoing() -> SheetHighlights {
        guard let latest = ranges.last else { return self }
        return SheetHighlights(ranges: Array(ranges.dropLast()), undone: undone + [latest])
    }

    func redoing() -> SheetHighlights {
        guard let latest = undone.last else { return self }
        return SheetHighlights(ranges: ranges + [latest], undone: Array(undone.dropLast()))
    }

    /// An arrow moves the latest highlight a cell, to the next row the sheet
    /// has; with ⇧ it widens or narrows it from its far corner instead.
    func moving(columns: Int, rows: Int, extending: Bool, in document: SheetDocument) -> SheetHighlights {
        guard let latest = ranges.last, !document.rows.isEmpty else { return self }
        let lastColumn = max(0, document.columns.count - 1)
        let column = { (value: Int) in min(max(0, value + columns), lastColumn) }
        let row = { (number: Int) -> Int in
            guard let index = document.index(ofRow: number) else { return number }
            return document.rows[min(max(0, index + rows), document.rows.count - 1)].number
        }
        if extending {
            return replacingLatest(with: SheetRange(top: latest.top, bottom: row(latest.bottom),
                                                    left: latest.left, right: column(latest.right)))
        }
        let top = row(latest.top), left = column(latest.left)
        return replacingLatest(with: SheetRange(top: top, bottom: top, left: left, right: left))
    }
}

enum SheetCells {
    private static let numeric = try? NSRegularExpression(pattern: "^[-+(]?[$€£¥]?\\s*\\d[\\d,.\\s]*%?\\)?$")

    /// A number as a sheet shows it ("$18,400", "(1,200)", "12%", or an
    /// accounting zero's "-"), which is set right; not a date or a name.
    static func isNumber(_ text: String) -> Bool {
        text == "-" || numeric?.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}
