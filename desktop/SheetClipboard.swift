// What the sheet picker inserts: a picture of the highlighted cells, as
// SheetPicture draws them. The cells keep where they sit in the sheet, with
// the rows and columns between highlights left out. It is pasted as PNG and
// TIFF, which documents, mail and chat apps take.

import Cocoa

struct SheetPick: Equatable {
    let png: Data
    let tiff: Data?
    /// The source, written under the picture or not.
    let citation: String
}

enum SheetClipboard {
    /// The picture `highlights` insert from `document`, or nil when nothing is highlighted.
    static func pick(_ document: SheetDocument, highlights: [SheetRange], headers: Bool, citing: Bool) -> SheetPick? {
        guard !highlights.isEmpty else { return nil }
        let citation = self.citation(document, highlights)
        let table = grid(document, highlights, headers: headers)
        guard let picture = SheetPicture.render(table.cells, headed: table.headed, caption: citing ? citation : nil),
              let png = picture.representation(using: .png, properties: [:]) else { return nil }
        return SheetPick(png: png, tiff: picture.tiffRepresentation, citation: citation)
    }

    /// Whether `highlights` contain any non-empty cell to draw.
    static func hasCells(_ document: SheetDocument, _ highlights: [SheetRange], headers: Bool) -> Bool {
        !highlights.isEmpty && !grid(document, highlights, headers: headers).cells.isEmpty
    }

    /// Clipboard representations for `pick`, with PNG first so web and native
    /// editors pick crisp compressed PNG and fall back to TIFF when needed.
    static func pasteboardFormats(for pick: SheetPick) -> [(NSPasteboard.PasteboardType, Data)] {
        var formats: [(NSPasteboard.PasteboardType, Data)] = [(.png, pick.png)]
        if let tiff = pick.tiff { formats.append((.tiff, tiff)) }
        return formats
    }

    /// The typed words the picture takes the place of: those the suggestion
    /// was matched on (when they still end `before`), or else the unfinished
    /// word at the caret ("inv" for Invoice). After a finished word, nothing
    /// typed is removed.
    static func typedTrigger(_ replacement: CompletionReplacement?, before: String) -> CompletionReplacement? {
        let text = Array(before.utf16)
        if let replacement, !replacement.typedText.isEmpty {
            let expected = Array(replacement.expectedText.utf16)
            if replacement.start >= 0, replacement.start + expected.count == text.count,
               CompletionTransaction.equivalentHostText(Array(text[replacement.start...]), expected) {
                let end = text.count - replacement.preservedSuffix.utf16.count
                if let captured = CompletionReplacement.capture(start: replacement.start, end: end, in: before) {
                    return captured
                }
            }
        }
        var start = text.count
        while start > 0, let scalar = Unicode.Scalar(text[start - 1]), !CharacterSet.whitespacesAndNewlines.contains(scalar) { start -= 1 }
        guard start < text.count else { return nil }
        return CompletionReplacement.capture(start: start, end: text.count, in: before)
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
    /// they touch; a cell no highlight covers is empty. When a header cell is
    /// highlighted it is included; with `headers` on, every highlighted column
    /// gets its header cell in the header row whether or not that header cell
    /// was highlighted, inserting the header row first when it was not already
    /// among the rows. `headed` says the first row is the header row, added or
    /// highlighted. Rows and columns with nothing in them, such as a CSV's
    /// blank last line, are left out.
    static func grid(_ document: SheetDocument, _ highlights: [SheetRange], headers: Bool) -> (cells: [[String]], headed: Bool) {
        let covered = { (row: Int, column: Int) in highlights.contains { $0.contains(row: row, column: column) } }
        let filled = { (row: Int, column: Int) in covered(row, column) && !document.cell(row: row, column: column).isEmpty }
        let touched = Array(Set(highlights.flatMap { Array($0.left...$0.right) })).sorted()
        let rows = document.rows.map(\.number).filter { row in touched.contains { filled(row, $0) } }
        let columns = touched.filter { column in rows.contains { filled($0, column) } }
        var cells = rows.map { row in
            let allHeaders = headers && row == document.headerRow
            return columns.map { (allHeaders || covered(row, $0)) ? document.cell(row: row, column: $0) : "" }
        }
        let addsHeader = headers && !columns.isEmpty && document.headerRow.map { !rows.contains($0) } == true
        if addsHeader, let header = document.headerRow {
            cells.insert(columns.map { document.cell(row: header, column: $0) }, at: 0)
        }
        return (cells, addsHeader || rows.first == document.headerRow)
    }
}
