// What the sheet picker inserts. One cell goes in as its value, as Tab
// inserts one. More go in as Excel copies them: HTML, RTF and tab-separated
// text on the clipboard together, so each app takes the richest it reads (a
// table in Word, Pages, Mail and Notes, cells in place in Numbers, Excel and
// Sheets, tabbed lines anywhere else). The cells keep where they sit in the
// sheet, with the rows and columns between highlights left out.

import Foundation

struct SheetPick: Equatable {
    /// The text a plain field takes: one value, or tab-separated lines.
    let plain: String
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
            return SheetPick(plain: plain, html: html([[value]], headed: false, citation: cited),
                             rtf: rtf([[value]], citation: cited), single: true, citation: citation)
        }
        let table = grid(document, highlights, headers: headers)
        let lines = table.cells.map { $0.joined(separator: "\t") } + (cited.map { [$0] } ?? [])
        return SheetPick(plain: lines.joined(separator: "\n"), html: html(table.cells, headed: table.headed, citation: cited),
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
    static func grid(_ document: SheetDocument, _ highlights: [SheetRange], headers: Bool) -> (cells: [[String]], headed: Bool) {
        let covered = { (row: Int, column: Int) in highlights.contains { $0.contains(row: row, column: column) } }
        let rows = document.rows.map(\.number).filter { row in highlights.contains { (($0.top)...($0.bottom)).contains(row) } }
        let columns = Array(Set(highlights.flatMap { Array($0.left...$0.right) })).sorted()
        var cells = rows.map { row in columns.map { covered(row, $0) ? document.cell(row: row, column: $0) : "" } }
        let addsHeader = headers && document.headerRow.map { !rows.contains($0) } == true
        if addsHeader, let header = document.headerRow {
            cells.insert(columns.map { document.cell(row: header, column: $0) }, at: 0)
        }
        return (cells, addsHeader)
    }

    // MARK: Formats

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
