// What the sheet picker inserts. One cell goes in as its value, as Tab
// inserts one. More go in as Excel copies them: HTML, RTF and tab-separated
// text on the clipboard together, so each app takes the richest it reads (a
// table in Word, Pages, Mail and Notes, cells in place in Numbers, Excel and
// Sheets). A plain text field gets the cells lined up between bars, with a
// line under the header row, which Markdown also reads as a table. The cells
// keep where they sit in the sheet, with the rows and columns between
// highlights left out.

import Foundation

struct SheetPick: Equatable {
    /// The text a plain field takes: one value, or the cells lined up between bars.
    let plain: String
    /// The cells tab-separated, for spreadsheets; the value alone for one cell.
    let tsv: String
    let html: String
    let rtf: Data?
    /// One cell: inserted at the caret as a suggestion is.
    let single: Bool
    /// The source, cited with the pick or not.
    let citation: String
    /// The suggestion's own cell is among those highlighted, so the pick
    /// takes the place of the typed words it was found by.
    var includesCited = false
}

enum SheetClipboard {
    /// What `highlights` insert from `document`, or nil when nothing is highlighted.
    static func pick(_ document: SheetDocument, highlights: [SheetRange], headers: Bool, citing: Bool) -> SheetPick? {
        guard !highlights.isEmpty else { return nil }
        let citation = self.citation(document, highlights)
        let cited = citing ? citation : nil
        if highlights.count == 1, let only = highlights.first, only.top == only.bottom, only.left == only.right {
            let value = document.cell(row: only.top, column: only.left)
            let plain = [value, cited].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            return SheetPick(plain: plain, tsv: value, html: html([[value]], headed: false, citation: cited),
                             rtf: rtf([[value]], citation: cited), single: true, citation: citation)
        }
        let table = grid(document, highlights, headers: headers)
        let lines = [textTable(table.cells, headed: table.headed)] + (cited.map { [$0] } ?? [])
        return SheetPick(plain: lines.joined(separator: "\n"), tsv: table.cells.map { $0.joined(separator: "\t") }.joined(separator: "\n"),
                         html: html(table.cells, headed: table.headed, citation: cited),
                         rtf: rtf(table.cells, citation: cited), single: false, citation: citation)
    }

    /// Cells pasted as a table start on a line of their own.
    static func block(_ plain: String, after before: String) -> String {
        before.isEmpty || before.hasSuffix("\n") ? plain : "\n" + plain
    }

    /// "(Pumps.xlsx, 'Trial Balance'!B2, C5:C7)": each highlight in the order
    /// it was made. A CSV has no sheet to name.
    static func citation(_ document: SheetDocument, _ highlights: [SheetRange]) -> String {
        let places = highlights.map(\.a1)
        guard let sheet = document.sheet, !places.isEmpty else { return "(\(([document.name] + places).joined(separator: ", ")))" }
        let quoted = sheet.range(of: "^[A-Za-z_][A-Za-z0-9_.]*$", options: .regularExpression) == nil
            ? "'\(sheet.replacingOccurrences(of: "'", with: "''"))'" : sheet
        let first = "\(quoted)!\(places[0])"
        return "(\(([document.name, first] + places.dropFirst()).joined(separator: ", ")))"
    }

    /// The highlighted cells laid out as in the sheet, in the rows and columns
    /// they touch; a cell no highlight covers is empty. With `headers`, the
    /// header row comes first unless a highlight already takes it in.
    /// `headed` says the first row is the header row, added or highlighted.
    static func grid(_ document: SheetDocument, _ highlights: [SheetRange], headers: Bool) -> (cells: [[String]], headed: Bool) {
        let covered = { (row: Int, column: Int) in highlights.contains { $0.contains(row: row, column: column) } }
        let rows = document.rows.map(\.number).filter { row in highlights.contains { (($0.top)...($0.bottom)).contains(row) } }
        let columns = Array(Set(highlights.flatMap { Array($0.left...$0.right) })).sorted()
        var cells = rows.map { row in columns.map { covered(row, $0) ? document.cell(row: row, column: $0) : "" } }
        let addsHeader = headers && document.headerRow.map { !rows.contains($0) } == true
        if addsHeader, let header = document.headerRow {
            cells.insert(columns.map { document.cell(row: header, column: $0) }, at: 0)
        }
        return (cells, addsHeader || rows.first == document.headerRow)
    }

    // MARK: Formats

    /// The cells lined up between bars, numbers set right, with a line of
    /// dashes under the header row: "| Invoice   | Due Date   |".
    static func textTable(_ cells: [[String]], headed: Bool) -> String {
        let rows = cells.map { $0.map { $0.replacingOccurrences(of: "|", with: "\\|") } }
        let count = rows.map(\.count).max() ?? 0
        // Markdown needs at least three dashes under each header.
        let widths = (0..<count).map { column in
            max(headed ? 3 : 1, rows.map { $0.indices.contains(column) ? $0[column].count : 0 }.max() ?? 0)
        }
        let line = { (row: [String], index: Int) -> String in
            let items = widths.indices.map { column -> String in
                let value = row.indices.contains(column) ? row[column] : ""
                let pad = String(repeating: " ", count: widths[column] - value.count)
                let right = !(headed && index == 0) && value.range(of: numeric, options: .regularExpression) != nil
                return right ? pad + value : value + pad
            }
            return "| " + items.joined(separator: " | ") + " |"
        }
        var lines = rows.enumerated().map { line($1, $0) }
        if headed, !lines.isEmpty {
            lines.insert("| " + widths.map { String(repeating: "-", count: $0) }.joined(separator: " | ") + " |", at: 1)
        }
        return lines.joined(separator: "\n")
    }

    private static let numeric = "^[-+(]?[$€£¥]?\\s*\\d[\\d,.\\s]*%?\\)?$"

    static func html(_ cells: [[String]], headed: Bool, citation: String?) -> String {
        let rows = cells.enumerated().map { index, row -> String in
            let tag = headed && index == 0 ? "th" : "td"
            let items = row.map { cell -> String in
                let right = tag == "td" && cell.range(of: numeric, options: .regularExpression) != nil
                return "<\(tag)\(right ? " style=\"text-align:right\"" : "")>\(escapeHtml(cell))</\(tag)>"
            }
            return "<tr>\(items.joined())</tr>"
        }
        let table = "<table border=\"1\" cellspacing=\"0\" cellpadding=\"4\" style=\"border-collapse:collapse\">\(rows.joined())</table>"
        return "<meta charset=\"utf-8\">\(table)\(citation.map { "<p>\(escapeHtml($0))</p>" } ?? "")"
    }

    /// Each column 1.25 inches wide, in twips.
    private static let rtfColumnWidth = 1_800

    static func rtf(_ cells: [[String]], citation: String?) -> Data? {
        let width = cells.map(\.count).max() ?? 0
        let edges = (1...max(1, width)).map { "\\cellx\($0 * rtfColumnWidth)" }.joined()
        let rows = cells.map { row in
            "\\trowd\\trgaph100\(edges)" + row.map { "\\pard\\intbl \(escapeRtf($0))\\cell" }.joined() + "\\row"
        }
        let note = citation.map { "\\pard \(escapeRtf($0))\\par" } ?? ""
        return Data("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs22 \(rows.joined(separator: "\n"))\n\(note)}".utf8)
    }

    static func escapeHtml(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    /// RTF's own characters escaped, and anything past ASCII as \uN? for
    /// each of its UTF-16 units, so an emoji is written as its surrogate pair.
    static func escapeRtf(_ value: String) -> String {
        value.unicodeScalars.map { scalar -> String in
            switch scalar {
            case "\\", "{", "}": return "\\\(scalar)"
            case "\n": return "\\line "
            case _ where scalar.value < 128: return String(scalar)
            default:
                return String(scalar).utf16.map { "\\u\(Int16(bitPattern: $0))?" }.joined()
            }
        }.joined()
    }
}
