// A file's changes in a review, drawn the way its kind reads best, each with
// a + to comment on any line, cell or passage, and the conversations pinned
// there:
//   text and code   numbered lines, added ones tinted lime and removed ones
//                   terracotta; code in a code face, prose in Figtree
//   workbooks, CSV  a small grid of the rows around each change, with the
//                   sheet's column letters and row numbers; a changed cell
//                   shows what it was above what it is, a recalculated formula
//                   cell is marked ƒ, added and removed rows are tinted
//   Word, PDF, deck the passages and values that changed, before above after

import SwiftUI

/// The conversations at one place, the composer when it is open there, and
/// the AI writer at work when it was asked there.
struct RanchReviewPinned: View {
    @ObservedObject var model: RanchReviewModel
    let store: RanchStore
    let file: RanchReviewFileView
    let threads: [RanchReviewThread]
    let place: RanchReviewPlace?
    @Binding var composing: RanchReviewPlace?
    let send: (RanchReviewPlace, String, String?) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(threads) { thread in
                RanchReviewThreadView(model: model, store: store, file: file, thread: thread)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            if let place, model.asking.contains(place.key) {
                RanchReviewWorking(words: file.writable ? "ChatGPT is making the change\u{2026}" : "ChatGPT is writing a suggestion\u{2026}")
                    .background(RanchLook.panel)
            }
            if let place, composing == place {
                RanchReviewComposer(place: place, code: file.code, canSuggest: place.anchor["kind"] as? String != "file",
                                    send: { send(place, $0, $1) },
                                    cancel: { withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { composing = nil } })
                    .background(RanchLook.panel)
                    .overlay(alignment: .top) { RanchLook.line2.frame(height: 1) }
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

/// The + that opens a comment at a line or cell: pale on hover, sky while writing there.
struct RanchReviewPlus: View {
    let active: Bool
    var size: CGFloat = 18
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus").font(.system(size: size * 0.55, weight: .bold))
                .foregroundStyle(active ? RanchLook.onSky : RanchLook.sky)
                .frame(width: size, height: size)
                .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(active ? RanchLook.sky : RanchLook.sky.opacity(0.22)))
        }
        .buttonStyle(.plain)
        .help("Comment here, or start with \\ to ask ChatGPT")
        .transition(.scale(scale: 0.6).combined(with: .opacity))
    }
}

// MARK: Lines

struct RanchReviewLinesBody: View {
    @ObservedObject var model: RanchReviewModel
    let store: RanchStore
    let file: RanchReviewFileView
    let lines: RanchReviewFileView.Lines
    @Binding var composing: RanchReviewPlace?
    let send: (RanchReviewPlace, String, String?) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(lines.hunks.enumerated()), id: \.offset) { _, hunk in
                header(hunk)
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                    let place = self.place(line)
                    RanchReviewLineRow(line: line, code: file.code,
                                       flashed: line.after.map { model.flashed == RanchReviewModel.flashKey(file.path, line: $0) } ?? false,
                                       composing: place != nil && composing == place,
                                       comment: place.map { place in { withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { composing = place } } })
                    if let after = line.after {
                        RanchReviewPinned(model: model, store: store, file: file,
                                          threads: file.threads.filter { $0.position?.line == after }, place: place,
                                          composing: $composing, send: send)
                    }
                }
            }
            if lines.truncated {
                Text("Only the start of these changes is shown.").font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
                    .padding(.horizontal, 32).frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            }
        }
    }

    private func place(_ line: RanchReviewFileView.Line) -> RanchReviewPlace? {
        guard let after = line.after else { return nil }
        return RanchReviewPlace(path: file.path, anchor: ["kind": "line", "line": after, "text": line.text], label: "Line \(after)", current: line.text)
    }

    /// "@@ -1,7 +1,8 @@" for code, as a diff writes it; "Lines 1–8" for prose.
    private func header(_ hunk: RanchReviewFileView.Hunk) -> some View {
        let before = hunk.lines.compactMap(\.before)
        let after = hunk.lines.compactMap(\.after)
        let text: String
        if file.code {
            text = "@@ -\(before.first ?? 0),\(before.count) +\(after.first ?? 0),\(after.count) @@"
        } else if let first = after.first, let last = after.last {
            text = first == last ? "Line \(first)" : "Lines \(first)\u{2013}\(last)"
        } else {
            text = "Removed lines"
        }
        return Text(text)
            .font(file.code ? .system(size: 12, design: .monospaced) : RanchLook.font(12.5))
            .foregroundStyle(RanchLook.ink3)
            .padding(.horizontal, 28).frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
            .background(RanchLook.raise.opacity(0.55))
    }
}

struct RanchReviewLineRow: View {
    let line: RanchReviewFileView.Line
    let code: Bool
    let flashed: Bool
    let composing: Bool
    let comment: (() -> Void)?

    var body: some View {
        RanchHover { hovering in
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                HStack(spacing: 4) {
                    Text(line.after.map(String.init) ?? line.before.map(String.init) ?? "")
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(RanchLook.ink3)
                        .frame(width: 44, alignment: .trailing)
                    ZStack {
                        if let comment, hovering || composing { RanchReviewPlus(active: composing, action: comment) }
                    }
                    .frame(width: 22)
                    .animation(.spring(response: 0.25, dampingFraction: 0.8), value: hovering)
                }
                .frame(width: 84, alignment: .trailing)
                Text(line.kind == "add" ? "+" : line.kind == "remove" ? "\u{2212}" : " ")
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(line.kind == "add" ? RanchLook.lime : line.kind == "remove" ? RanchLook.terracottaSoft : RanchLook.ink3)
                    .frame(width: 20)
                Text(line.text.isEmpty ? " " : line.text)
                    .font(code ? .system(size: 13, design: .monospaced) : RanchLook.font(14))
                    .foregroundStyle(line.kind == "remove" ? RanchLook.ink2 : RanchLook.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.trailing, 24)
            }
            .padding(.vertical, code ? 3 : 4)
            .frame(minHeight: code ? 25 : 28)
            .background(background)
            .animation(.easeOut(duration: 0.2), value: composing)
        }
    }

    private var background: Color {
        if flashed { return RanchLook.lime.opacity(0.32) }
        if composing { return RanchLook.sky.opacity(0.14) }
        switch line.kind {
        case "add": return RanchLook.lime.opacity(0.075)
        case "remove": return RanchLook.terracotta.opacity(0.12)
        default: return .clear
        }
    }
}

// MARK: Sheets

struct RanchReviewSheetBody: View {
    @ObservedObject var model: RanchReviewModel
    let store: RanchStore
    let file: RanchReviewFileView
    let grid: RanchReviewFileView.Grid
    @Binding var composing: RanchReviewPlace?
    let send: (RanchReviewPlace, String, String?) -> Void
    @State private var width: CGFloat = 900

    private static let gutter: CGFloat = 52

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(grid.sheets.enumerated()), id: \.offset) { _, sheet in
                if !grid.csv {
                    HStack(spacing: 8) {
                        Image(systemName: "tablecells").font(.system(size: 11.5)).foregroundStyle(RanchLook.ink3)
                        Text(sheet.name).font(RanchLook.font(12.5, .medium)).foregroundStyle(RanchLook.ink2)
                    }
                    .padding(.horizontal, 28).frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
                    .background(RanchLook.raise.opacity(0.55))
                }
                ForEach(Array(sheet.hunks.enumerated()), id: \.offset) { index, hunk in
                    if index > 0 { gap }
                    let widths = columnWidths(hunk)
                    letters(hunk, widths)
                    if let heading = hunk.heading {
                        RanchReviewSheetRow(file: file, sheet: sheet.name, csv: grid.csv, number: heading.number, kind: "heading",
                                            cells: heading.cells.map { RanchReviewFileView.Cell(value: $0) }, columns: hunk.columns,
                                            widths: widths, model: model, composing: $composing)
                        gap
                    }
                    ForEach(Array(hunk.rows.enumerated()), id: \.offset) { _, row in
                        RanchReviewSheetRow(file: file, sheet: sheet.name, csv: grid.csv, number: row.number, kind: row.kind,
                                            cells: row.cells, columns: hunk.columns, widths: widths, model: model, composing: $composing)
                        let here = file.threads.filter { $0.position?.row == row.number && (grid.csv || $0.position?.sheet == sheet.name) }
                        let open = composing.flatMap { place in
                            (place.anchor["row"] as? Int) == row.number && (grid.csv || (place.anchor["sheet"] as? String) == sheet.name) ? place : nil
                        }
                        RanchReviewPinned(model: model, store: store, file: file, threads: here, place: open ?? askedPlace(sheet.name, row.number),
                                          composing: $composing, send: send)
                    }
                }
            }
            if grid.truncated {
                Text("Only the first of these changes are shown.").font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
                    .padding(.horizontal, 32).frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            }
        }
        .background(GeometryReader { proxy in Color.clear.preference(key: RanchReviewWidthKey.self, value: proxy.size.width) })
        .onPreferenceChange(RanchReviewWidthKey.self) { width = $0 }
    }

    /// A place in this row the AI writer is at work on, so its line shows under the row.
    private func askedPlace(_ sheet: String, _ row: Int) -> RanchReviewPlace? {
        let prefix = "\(file.path)|cell|"
        for key in model.asking where key.hasPrefix(prefix) {
            let parts = key.dropFirst(prefix.count).split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            guard parts.count >= 3, parts[1] == "\(row)", let column = Int(parts[2]) else { continue }
            return place(sheet: grid.csv ? file.path : sheet, row: row, column: column, value: nil)
        }
        return nil
    }

    func place(sheet: String, row: Int, column: Int, value: String?) -> RanchReviewPlace {
        RanchReviewSheetRow.place(file: file, sheet: sheet, csv: grid.csv, row: row, column: column, value: value)
    }

    /// The label column takes what the others leave, and the others share the rest.
    private func columnWidths(_ hunk: RanchReviewFileView.SheetHunk) -> [CGFloat] {
        let count = max(1, hunk.columns.count)
        let room = max(320, width - Self.gutter - 32)
        let first = count == 1 ? room : max(150, min(260, room * 0.28))
        let rest = count == 1 ? 0 : max(72, min(160, (room - first) / CGFloat(count - 1)))
        return hunk.columns.enumerated().map { index, _ in index == 0 ? first : rest }
    }

    private func letters(_ hunk: RanchReviewFileView.SheetHunk, _ widths: [CGFloat]) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: Self.gutter)
            ForEach(Array(hunk.columns.enumerated()), id: \.offset) { index, column in
                let skipped = index > 0 && column.index != hunk.columns[index - 1].index + 1
                Text(skipped ? "\u{22EF} \(column.letter)" : column.letter).font(RanchLook.font(11.5, .medium)).foregroundStyle(RanchLook.ink3)
                    .frame(width: widths[index], height: 26)
                    .overlay(Rectangle().strokeBorder(RanchLook.line2, lineWidth: 0.5))
            }
            Spacer(minLength: 0)
        }
        .background(RanchLook.raise.opacity(0.35))
    }

    private var gap: some View {
        Text("\u{22EF}").font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3)
            .padding(.leading, 20).frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
    }
}

struct RanchReviewWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 900
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct RanchReviewSheetRow: View {
    let file: RanchReviewFileView
    let sheet: String
    let csv: Bool
    let number: Int
    /// same, modified, added, removed, or heading for the sheet's column names.
    let kind: String
    let cells: [RanchReviewFileView.Cell]
    let columns: [RanchReviewFileView.Column]
    let widths: [CGFloat]
    @ObservedObject var model: RanchReviewModel
    @Binding var composing: RanchReviewPlace?

    static func place(file: RanchReviewFileView, sheet: String, csv: Bool, row: Int, column: Int, value: String?) -> RanchReviewPlace {
        var anchor: [String: Any] = ["kind": "cell", "sheet": sheet, "row": row, "column": column]
        if let value { anchor["value"] = value }
        let letter = RanchReviewSheetRow.letter(column)
        return RanchReviewPlace(path: file.path, anchor: anchor, label: csv ? "\(letter)\(row)" : "\(sheet)!\(letter)\(row)", current: value)
    }

    static func letter(_ index: Int) -> String {
        var letters = ""
        var number = index + 1
        while number > 0 {
            letters = String(UnicodeScalar(UInt8(65 + (number - 1) % 26))) + letters
            number = (number - 1) / 26
        }
        return letters
    }

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 3) {
                if kind == "added" || kind == "removed" {
                    Text(kind == "added" ? "+" : "\u{2212}").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(kind == "added" ? RanchLook.lime : RanchLook.terracottaSoft)
                }
                Text("\(number)").font(RanchLook.font(11.5, .medium)).foregroundStyle(RanchLook.ink3)
            }
            .frame(width: 52, alignment: .trailing).padding(.trailing, 0)
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                let column = columns[index].index
                let place = Self.place(file: file, sheet: csv ? file.path : sheet, csv: csv, row: number, column: column, value: cell.value)
                RanchReviewCellView(cell: cell, width: widths[index], rowKind: kind, label: index == 0,
                                    flashed: model.flashed == RanchReviewModel.flashKey(file.path, sheet: csv ? file.path : sheet, row: number, column: column),
                                    composing: composing == place,
                                    comment: kind == "removed" || kind == "heading" ? nil : {
                                        withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { composing = place }
                                    })
            }
            Spacer(minLength: 0)
        }
        .background(kind == "added" ? RanchLook.lime.opacity(0.06) : kind == "removed" ? RanchLook.terracotta.opacity(0.09)
                    : kind == "heading" ? RanchLook.raise.opacity(0.25) : .clear)
    }
}

struct RanchReviewCellView: View {
    let cell: RanchReviewFileView.Cell
    let width: CGFloat
    let rowKind: String
    /// The sheet's label column, read as words.
    let label: Bool
    let flashed: Bool
    let composing: Bool
    let comment: (() -> Void)?

    private var changed: Bool { cell.changed == true }
    private var recalculated: Bool { cell.recalculated == true }
    private var numeric: Bool { !label && Double(cell.value.replacingOccurrences(of: ",", with: "")) != nil }

    var body: some View {
        RanchHover { hovering in
            ZStack(alignment: .topTrailing) {
                VStack(alignment: numeric ? .trailing : .leading, spacing: 1) {
                    if changed {
                        Text(cell.before?.isEmpty == false ? cell.before! : "empty")
                            .font(RanchLook.font(11.5)).foregroundStyle(RanchLook.ink3)
                            .strikethrough(cell.before?.isEmpty == false, color: RanchLook.terracottaSoft)
                    }
                    Text(cell.value.isEmpty && changed ? "empty" : cell.value)
                        .font(RanchLook.font(rowKind == "heading" ? 12.5 : 13.5, rowKind == "heading" ? .medium : .regular))
                        .foregroundStyle(rowKind == "removed" || rowKind == "heading" ? RanchLook.ink2 : RanchLook.ink)
                        .strikethrough(rowKind == "removed", color: RanchLook.terracottaSoft)
                }
                .lineLimit(1).truncationMode(.tail)
                .padding(.horizontal, 9)
                .frame(width: width, alignment: numeric ? .trailing : .leading)
                .frame(maxHeight: .infinity)
                if recalculated {
                    Text("\u{0192}").font(RanchLook.font(10.5, .medium)).foregroundStyle(RanchLook.sky.opacity(0.8))
                        .padding(4).frame(maxWidth: .infinity, alignment: .topLeading)
                        .help("A formula: its value changed because the cells it works from did")
                }
                if let comment, hovering || composing {
                    RanchReviewPlus(active: composing, size: 16, action: comment).padding(4)
                }
            }
            .frame(width: width, height: changed ? 44 : 32)
            .background(background)
            .overlay(Rectangle().strokeBorder(composing ? RanchLook.sky : RanchLook.line2, lineWidth: composing ? 1.5 : 0.5))
            .animation(.spring(response: 0.25, dampingFraction: 0.8), value: hovering)
        }
    }

    private var background: Color {
        if flashed { return RanchLook.lime.opacity(0.34) }
        if composing { return RanchLook.sky.opacity(0.12) }
        if changed && recalculated { return RanchLook.sky.opacity(0.07) }
        if changed { return RanchLook.lime.opacity(0.13) }
        return .clear
    }
}

// MARK: Passages and values

struct RanchReviewValuesBody: View {
    @ObservedObject var model: RanchReviewModel
    let store: RanchStore
    let file: RanchReviewFileView
    let values: [RanchReviewFileView.Value]
    @Binding var composing: RanchReviewPlace?
    let send: (RanchReviewPlace, String, String?) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                let place = RanchReviewPlace(path: file.path, anchor: anchor(value), label: [value.place, value.label].compactMap { $0 }.joined(separator: " \u{00B7} "),
                                             current: value.after)
                RanchReviewValueRow(value: value, composing: composing == place) {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { composing = place }
                }
                RanchReviewPinned(model: model, store: store, file: file,
                                  threads: file.threads.filter { $0.position?.place == value.place && $0.position?.label == value.label },
                                  place: place, composing: $composing, send: send)
            }
            if file.valueCount > values.count {
                Text("And \((file.valueCount - values.count).formatted()) more.").font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
                    .padding(.horizontal, 32).frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            }
        }
    }

    private func anchor(_ value: RanchReviewFileView.Value) -> [String: Any] {
        var anchor: [String: Any] = ["kind": "value"]
        if let place = value.place { anchor["place"] = place }
        if let label = value.label { anchor["label"] = label }
        if let after = value.after { anchor["value"] = after }
        return anchor
    }
}

struct RanchReviewValueRow: View {
    let value: RanchReviewFileView.Value
    let composing: Bool
    let comment: () -> Void

    var body: some View {
        RanchHover { hovering in
            HStack(alignment: .top, spacing: 0) {
                ZStack {
                    if value.after != nil && (hovering || composing) { RanchReviewPlus(active: composing, action: comment) }
                }
                .frame(width: 52, alignment: .center).padding(.top, 2)
                .animation(.spring(response: 0.25, dampingFraction: 0.8), value: hovering)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        if let place = value.place { Text(place).font(RanchLook.font(12.5, .medium)).foregroundStyle(RanchLook.ink2) }
                        // A passage is labelled by its own words, which the lines below already show.
                        if let label = value.label, label != value.after, label != value.before {
                            Text(label).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3).lineLimit(1)
                        }
                        if value.recalculated == true { Text("Recalculated").font(RanchLook.font(12)).foregroundStyle(RanchLook.sky.opacity(0.8)) }
                    }
                    if let before = value.before { passage(before, mark: "\u{2212}", tint: RanchLook.terracotta.opacity(0.13), sign: RanchLook.terracottaSoft) }
                    if let after = value.after { passage(after, mark: "+", tint: RanchLook.lime.opacity(0.09), sign: RanchLook.lime) }
                }
                .padding(.trailing, 28)
            }
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(composing ? RanchLook.sky.opacity(0.08) : .clear)
            .overlay(alignment: .top) { RanchLook.line2.frame(height: 1) }
        }
    }

    private func passage(_ text: String, mark: String, tint: Color, sign: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(mark).foregroundStyle(sign).frame(width: 10)
            Text(text).foregroundStyle(RanchLook.ink).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(RanchLook.font(14))
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tint))
    }
}
