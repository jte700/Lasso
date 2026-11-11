// Workbooks in The Ranch: the cells Lasso reads, in a plain grid with the
// app's column letters and row numbers, one sheet at a time. Quick Look's
// rendering of the file's own layout is a click away. A cell a link cites is
// shaded and scrolled to.

import Cocoa
import SwiftUI

struct RanchSheetViewer: View {
    let workbook: RanchWorkbook
    /// The cell a review item points at, if any.
    let place: RanchCellPlace?
    /// Shows another version of the file, chosen from the version menu.
    var onVersion: ((String) -> Void)? = nil
    @State private var sheetIndex = 0

    var body: some View {
        let index = workbook.sheets.indices.contains(sheetIndex) ? sheetIndex : 0
        let sheet = workbook.sheets[index]
        VStack(spacing: 0) {
            if let versions = workbook.versions, versions.count > 1, let onVersion {
                versionMenu(versions, onVersion: onVersion)
                RanchHairline()
            }
            RanchSheetGrid(sheet: sheet, highlight: place?.sheet == index ? place : nil,
                           changed: workbook.changedCells(onSheet: index))
            if workbook.sheets.count > 1 || sheet.truncated {
                RanchHairline()
                HStack(spacing: 2) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 2) {
                            ForEach(Array(workbook.sheets.enumerated()), id: \.offset) { offset, sheet in
                                tab(sheet.name, chosen: offset == index) { sheetIndex = offset }
                            }
                        }
                        .padding(.horizontal, 8)
                    }
                    if sheet.truncated {
                        Text("Showing the first \(sheet.rows.count.formatted()) rows and \(sheet.columns) columns")
                            .font(RanchTheme.captionFont).foregroundStyle(RanchTheme.tertiaryInk)
                            .lineLimit(1).fixedSize().padding(.trailing, 12)
                    }
                }
                .frame(height: 34)
            }
        }
        .onAppear { if let place { sheetIndex = place.sheet } }
        .onChange(of: place) { place in if let place { sheetIndex = place.sheet } }
    }

    private func tab(_ name: String, chosen: Bool, choose: @escaping () -> Void) -> some View {
        Button(action: choose) {
            Text(name)
                .font(RanchTheme.controlFont)
                .foregroundStyle(chosen ? RanchTheme.ink : RanchTheme.secondaryInk)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(chosen ? RanchTheme.selection : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

extension RanchSheetViewer {
    /// The time a change or version was saved, as the menu and hover text write it.
    static func changeTime(_ iso: String?) -> String {
        guard let iso, let date = ISO8601DateFormatter.withFractions.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        else { return "" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    /// The file's versions, newest first; closed until chosen from.
    func versionMenu(_ versions: [RanchFileVersion], onVersion: @escaping (String) -> Void) -> some View {
        let shown = workbook.version ?? versions.first?.snapshotId
        let title = versions.first?.snapshotId == shown ? "Latest version"
            : Self.changeTime(versions.first { $0.snapshotId == shown }?.at)
        return HStack {
            Spacer()
            RanchPillMenu(title: title.isEmpty ? "Version" : title, symbol: "clock.arrow.circlepath",
                          help: "Show an earlier version of this file") {
                ForEach(Array(versions.enumerated()), id: \.element.id) { offset, version in
                    let kept = version.available != false
                    Button((offset == 0 ? "Latest \u{00B7} " : "") + Self.changeTime(version.at)
                           + (kept ? "" : " \u{00B7} copy not kept")) { onVersion(version.snapshotId) }
                        .disabled(!kept)
                }
            }
        }
        .padding(.horizontal, 10).frame(height: 34)
    }
}

private extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// One sheet's cells in a table: lettered columns, numbered rows, numbers set
/// right as spreadsheets set them.
struct RanchSheetGrid: NSViewRepresentable {
    let sheet: RanchSheet
    let highlight: RanchCellPlace?
    /// Cells the shown version changed, tinted, with what they were on hover.
    var changed: [RanchCellKey: RanchCellChange] = [:]

    private static let rowNumberColumn = NSUserInterfaceItemIdentifier("row")

    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        var sheet: RanchSheet?
        var highlight: RanchCellPlace?
        var changed: [RanchCellKey: RanchCellChange] = [:]
        private static let font = NSFont.systemFont(ofSize: 12)
        private static let boldFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
        private static let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)

        func numberOfRows(in tableView: NSTableView) -> Int { sheet?.rows.count ?? 0 }

        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard let sheet, let tableColumn else { return nil }
            let identifier = tableColumn.identifier
            let field = (tableView.makeView(withIdentifier: identifier, owner: self) as? NSTextField) ?? {
                let field = NSTextField(labelWithString: "")
                field.identifier = identifier
                field.lineBreakMode = .byTruncatingTail
                field.cell?.truncatesLastVisibleLine = true
                field.isSelectable = true
                return field
            }()
            if identifier == RanchSheetGrid.rowNumberColumn {
                field.stringValue = "\(sheet.rowNumbers[safe: row] ?? row + 1)"
                field.font = Self.numberFont
                field.alignment = .center
                field.textColor = .tertiaryLabelColor
                field.drawsBackground = false
                return field
            }
            let column = Int(identifier.rawValue) ?? 0
            let value = sheet.rows[safe: row]?[safe: column] ?? ""
            let cited = highlight.map { $0.row == row && ($0.column == nil || $0.column == column) } ?? false
            field.stringValue = value
            field.font = cited ? Self.boldFont : Self.isNumber(value) ? Self.numberFont : Self.font
            field.alignment = Self.isNumber(value) ? .right : .left
            field.textColor = .labelColor
            let change = changed[RanchCellKey(row: row, column: column)]
            field.drawsBackground = cited || change != nil
            field.backgroundColor = cited ? NSColor.controlAccentColor.withAlphaComponent(0.18)
                : change != nil ? NSColor.systemOrange.withAlphaComponent(0.16) : .clear
            field.toolTip = change.map { $0.hoverText(date: RanchSheetViewer.changeTime) } ?? (value.count > 24 ? value : nil)
            return field
        }

        /// Numbers, money, percentages and dates as numbers, which line up on the right.
        static func isNumber(_ value: String) -> Bool {
            let trimmed = value.trimmingCharacters(in: .whitespaces)
            guard let first = trimmed.unicodeScalars.first, !trimmed.isEmpty, trimmed.count < 40 else { return false }
            guard CharacterSet.decimalDigits.contains(first) || "-+$€£¥(.".unicodeScalars.contains(first) else { return false }
            return trimmed.range(of: #"^[-+(]?[$€£¥]?[\d,.\s]+%?\)?$|^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$"#, options: .regularExpression) != nil
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let table = NSTableView()
        table.style = .plain
        table.rowHeight = 22
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.gridStyleMask = [.solidHorizontalGridLineMask, .solidVerticalGridLineMask]
        table.gridColor = NSColor.separatorColor.withAlphaComponent(0.6)
        table.selectionHighlightStyle = .none
        table.allowsColumnReordering = false
        table.columnAutoresizingStyle = .noColumnAutoresizing
        table.backgroundColor = .textBackgroundColor
        table.usesAlternatingRowBackgroundColors = false
        table.dataSource = context.coordinator
        table.delegate = context.coordinator
        table.setAccessibilityLabel("Sheet cells")
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let table = scroll.documentView as? NSTableView else { return }
        let coordinator = context.coordinator
        let changedSheet = coordinator.sheet != sheet
        let changedHighlight = coordinator.highlight != highlight || coordinator.changed != changed
        guard changedSheet || changedHighlight else { return }
        coordinator.sheet = sheet
        coordinator.highlight = highlight
        coordinator.changed = changed
        if changedSheet { columns(of: table) }
        table.reloadData()
        if let highlight {
            reveal(highlight, in: table)
        } else if changedSheet, table.numberOfRows > 0 {
            // To the first row and column, below the column letters.
            table.scrollRowToVisible(0)
            table.scrollColumnToVisible(0)
        }
    }

    /// A column per sheet column, as wide as its longer values, after the row numbers.
    private func columns(of table: NSTableView) {
        table.tableColumns.forEach(table.removeTableColumn)
        let numbers = NSTableColumn(identifier: Self.rowNumberColumn)
        numbers.title = ""
        numbers.width = 44
        numbers.minWidth = 36
        numbers.resizingMask = []
        table.addTableColumn(numbers)
        let sample = sheet.rows.prefix(300)
        let font: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12)]
        for index in 0..<sheet.columns {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("\(index)"))
            column.title = RanchSheetColumns.letter(index)
            column.headerCell.alignment = .center
            // Wide enough for the column's longest value, within reason; longer ones end in "…".
            let longest = sample.compactMap { $0[safe: index] }.max { $0.count < $1.count } ?? ""
            column.width = min(220, max(56, ceil((longest as NSString).size(withAttributes: font).width) + 18))
            column.minWidth = 28
            column.resizingMask = .userResizingMask
            table.addTableColumn(column)
        }
    }

    /// Scrolls the cited cell into view, a few rows clear of the edge, moving
    /// sideways only as far as it must so the row's labels stay in sight.
    private func reveal(_ place: RanchCellPlace, in table: NSTableView) {
        guard table.numberOfRows > place.row else { return }
        DispatchQueue.main.async {
            let column = place.column.map { $0 + 1 } ?? 1
            let cell = column < table.numberOfColumns ? table.frameOfCell(atColumn: column, row: place.row)
                : table.rect(ofRow: place.row)
            table.scrollToVisible(cell.insetBy(dx: -8, dy: -110))
        }
    }
}
