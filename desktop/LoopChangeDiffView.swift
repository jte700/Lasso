// A Recent Changes row opened: the change's facts (when, who, how Lasso came
// to record it, the directory's versions, the file's size and path), then a
// panel with what changed inside the file, as a diff shows it. Text files show
// their changed lines with three lines around them, removed lines tinted in
// terracotta and added ones in lime, and the words a rewritten line changed
// marked more strongly. A table shows its changed cells, a JSON file its
// fields, and the files Lasso reads into values (workbooks, PDFs, Word files,
// decks, drawings) the values that changed, where each sits and what it was.

import Cocoa
import SwiftUI

struct LoopChangeDiffView: View {
    @ObservedObject var store: LoopStore
    let entry: LoopHistoryEntry
    @State private var detail: LoopChangeDetail?
    @State private var failure: String?
    @State private var task: URLSessionDataTask?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text("Change detail").font(LoopLook.font(14.5, .medium)).foregroundStyle(LoopLook.ink)
                Spacer(minLength: 8)
                buttons
            }
            if let detail {
                facts(detail)
                LoopChangeBody(detail: detail)
            } else if let failure {
                Text(failure).font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3)
            } else {
                Text("Reading the change\u{2026}").font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3)
                    .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            }
        }
        .onAppear(perform: load)
        .onDisappear { task?.cancel() }
    }

    private func load() {
        if let known = store.cachedChange(entry.id) { detail = known; return }
        task = store.changeDetail(entry.id) { result in
            switch result {
            case .success(let found): withAnimation(.easeOut(duration: 0.2)) { detail = found }
            case .failure(let error): failure = error.localizedDescription
            }
        }
    }

    @ViewBuilder private var buttons: some View {
        if let source = store.source(entry.fileId) {
            Button { store.selectedSourceID = source.id } label: {
                Label("Show File", systemImage: "sidebar.right")
            }
            .buttonStyle(LoopPageButtonStyle(height: 30))
            .help("Show this file beside the list")
            if let url = store.localURL(for: source), let editor = LoopEditors.primary(for: url) {
                Button { _ = editor.open(url) } label: {
                    Label("Open", systemImage: "arrow.up.forward.app")
                }
                .buttonStyle(LoopPageButtonStyle(height: 30))
                .help("Open in \(editor.name)")
            }
        }
    }

    // MARK: Facts

    private func facts(_ detail: LoopChangeDetail) -> some View {
        let who = LoopChangeWords.who(detail.actor, source: detail.source)
        var rows: [(String, String)] = [
            ("When", LoopFormat.full(detail.at)),
            ("Recorded", LoopChangeWords.recorded(detail.source)),
            ("By", detail.initiatedBy.map { "\(who.title), asked by \($0.name)" } ?? who.title),
        ]
        if let version = LoopChangeWords.version(detail.version) { rows.append(("Directory version", version)) }
        if let size = LoopChangeWords.size(before: detail.file?.before?.size, after: detail.file?.after?.size) {
            rows.append(("Size", size))
        }
        if let path = detail.path { rows.append(("Path", path)) }
        if let previous = detail.previousPath { rows.append(("Was", previous)) }
        if let request = detail.request { rows.append(("Asked", "\u{201C}\(request)\u{201D}")) }
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 200, maximum: 420), spacing: 22, alignment: .topLeading)],
                         alignment: .leading, spacing: 14) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                let (title, value) = row
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(LoopLook.font(12)).foregroundStyle(LoopLook.ink3)
                    Text(value).font(LoopLook.font(13.5)).monospacedDigit().foregroundStyle(LoopLook.ink)
                        .lineLimit(3).truncationMode(.middle)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// The panel of what changed inside the file, inset like a diff in a review.
private struct LoopChangeBody: View {
    let detail: LoopChangeDetail
    @State private var showsRecalculated = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let lines = detail.lines, !lines.hunks.isEmpty {
                caption(LoopChangeWords.lineSummary(lines), counts: (lines.added, lines.removed))
                LoopDiffLines(lines: lines, code: detail.isCode)
                if lines.truncated { note("Only the start of this change is shown. The whole file is in its history.") }
            } else if let table = detail.table, detail.listsChanges {
                caption(Self.tableSummary(table))
                LoopDiffTable(table: table)
            } else if let fields = detail.fields, !fields.isEmpty {
                caption(fields.count == 1 ? "1 field changed" : "\(fields.count.formatted()) fields changed")
                ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                    LoopDiffValueRow(kind: field.kind == "changed" ? "modified" : field.kind, place: field.path,
                                      label: nil, before: field.before, after: field.after, code: true)
                }
            } else if !detail.values.isEmpty {
                caption(LoopChangeWords.valueSummary(detail))
                let typed = detail.values.filter { !$0.isRecalculated }
                let recalculated = detail.values.filter(\.isRecalculated)
                // What was typed leads. The formula cells that followed it wait in
                // a fold; when nothing was typed, they are what changed.
                ForEach(Array((typed.isEmpty ? recalculated : typed).enumerated()), id: \.offset) { _, value in
                    valueRow(value)
                }
                if !typed.isEmpty, !recalculated.isEmpty {
                    LoopRecalculatedFold(title: LoopChangeWords.recalculatedFold(
                        max(detail.recalculatedCount ?? 0, recalculated.count), typed: typed.count), open: $showsRecalculated)
                    if showsRecalculated {
                        ForEach(Array(recalculated.enumerated()), id: \.offset) { _, value in valueRow(value) }
                    }
                }
                if detail.valueCount > detail.values.count {
                    note("And \((detail.valueCount - detail.values.count).formatted()) more. The file\u{2019}s viewer tints every one.")
                }
            } else if !detail.files.isEmpty {
                caption(detail.fileCount == 1 ? "1 file recorded" : "\(detail.fileCount.formatted()) files recorded")
                ForEach(Array(detail.files.enumerated()), id: \.offset) { _, file in LoopDiffFileRow(file: file) }
                if detail.fileCount > detail.files.count {
                    note("And \((detail.fileCount - detail.files.count).formatted()) more.")
                }
            } else {
                Text(LoopChangeWords.nothingListed(detail))
                    .font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink2)
                    .padding(16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(LoopLook.panel))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(LoopLook.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func caption(_ text: String, counts: (added: Int, removed: Int)? = nil) -> some View {
        HStack(spacing: 10) {
            Text(text).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2)
            Spacer(minLength: 8)
            if let counts {
                Text("+\(counts.added.formatted())").foregroundStyle(LoopLook.lime)
                Text("\u{2212}\(counts.removed.formatted())").foregroundStyle(LoopLook.terracottaSoft)
            }
            if detail.movedCount > 0 {
                Text("\(detail.movedCount.formatted()) moved without changing").foregroundStyle(LoopLook.ink3)
            }
        }
        .font(LoopLook.font(12.5, .medium)).monospacedDigit()
        .padding(.horizontal, 16)
        .frame(height: 38)
    }

    private func note(_ text: String) -> some View {
        Text(text).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
    }

    private static func tableSummary(_ table: LoopChangeDetail.Table) -> String {
        let parts = [
            table.counts.cellsChanged > 0 ? (table.counts.cellsChanged == 1 ? "1 cell changed" : "\(table.counts.cellsChanged.formatted()) cells changed") : nil,
            table.counts.rowsAdded > 0 ? (table.counts.rowsAdded == 1 ? "1 row added" : "\(table.counts.rowsAdded.formatted()) rows added") : nil,
            table.counts.rowsRemoved > 0 ? (table.counts.rowsRemoved == 1 ? "1 row removed" : "\(table.counts.rowsRemoved.formatted()) rows removed") : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? "No cells changed" : parts.joined(separator: " \u{00B7} ")
    }

    private func valueRow(_ value: LoopChangeDetail.Value) -> some View {
        LoopDiffValueRow(kind: value.kind, place: value.place, label: value.label,
                          before: value.shownBefore, after: value.shownAfter, code: false, recalculated: value.isRecalculated)
    }
}

/// The row under the values typed into that opens onto the formula cells they recalculated.
private struct LoopRecalculatedFold: View {
    let title: String
    @Binding var open: Bool

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { open.toggle() }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10.5, weight: .semibold))
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .frame(width: 12)
                Text(title).font(LoopLook.font(13))
                Spacer(minLength: 8)
            }
            .foregroundStyle(LoopLook.ink2)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
        .help(open ? "Hide the formula cells" : "Show the formula cells")
        .accessibilityLabel(title)
        .accessibilityValue(open ? "Shown" : "Hidden")
    }
}

/// Changed lines in hunks, each line with its numbers before and after, its
/// sign, and its words; a gap between hunks stands for the lines left out.
private struct LoopDiffLines: View {
    let lines: LoopChangeDetail.Lines
    let code: Bool

    var body: some View {
        let widest = lines.hunks.flatMap(\.lines).flatMap { [$0.before ?? 0, $0.after ?? 0] }.max() ?? 0
        let gutter = CGFloat(String(widest).count) * 8 + 16
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.hunks.enumerated()), id: \.offset) { index, hunk in
                if index > 0 {
                    Text("\u{22EF}").font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, gutter * 2 + 8)
                        .frame(height: 26)
                        .background(LoopLook.rgb(0x000000, 0.18))
                }
                let marks = LoopChangeWords.changedWords(in: hunk.lines)
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { offset, line in
                    LoopDiffLine(line: line, marks: marks[offset] ?? [], gutter: gutter, code: code)
                }
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
        .textSelection(.enabled)
    }
}

private struct LoopDiffLine: View {
    let line: LoopChangeDetail.Line
    let marks: [NSRange]
    let gutter: CGFloat
    let code: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            number(line.before)
            number(line.after)
            Text(sign).font(font).foregroundStyle(signColor).frame(width: 22)
            Text(words).font(font).foregroundStyle(line.kind == "same" ? LoopLook.ink2 : LoopLook.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2.5)
        .padding(.trailing, 16)
        .background(tint)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(line.kind == "add" ? "Added" : line.kind == "remove" ? "Removed" : "Unchanged"): \(line.text)")
    }

    private var font: Font { code ? .system(size: 12.5, design: .monospaced) : LoopLook.font(13.5) }

    private func number(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "").font(LoopLook.font(12)).monospacedDigit().foregroundStyle(LoopLook.ink3)
            .frame(width: gutter, alignment: .trailing)
            .padding(.trailing, 4)
    }

    private var sign: String {
        line.kind == "add" ? "+" : line.kind == "remove" ? "\u{2212}" : ""
    }

    private var signColor: Color { line.kind == "add" ? LoopLook.lime : LoopLook.terracottaSoft }

    private var tint: Color {
        switch line.kind {
        case "add": return LoopLook.lime.opacity(0.085)
        case "remove": return LoopLook.terracotta.opacity(0.14)
        default: return .clear
        }
    }

    /// The line's words, the ones its pair changed marked; an empty line keeps its height.
    private var words: AttributedString {
        var text = AttributedString(line.text.isEmpty ? " " : line.text)
        let mark = line.kind == "add" ? LoopLook.lime.opacity(0.26) : LoopLook.terracotta.opacity(0.4)
        for range in marks {
            guard let found = Range(range, in: text) else { continue }
            text[found][AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = mark
        }
        return text
    }
}

/// A table's changed cells, then the rows it gained and lost.
private struct LoopDiffTable: View {
    let table: LoopChangeDetail.Table

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(table.cells.enumerated()), id: \.offset) { _, cell in
                LoopDiffValueRow(kind: "modified", place: LoopChangeWords.row(cell.row), label: cell.column,
                                  before: cell.before, after: cell.after, code: false)
            }
            if !table.rowsAdded.isEmpty { rows("Rows added", table.rowsAdded, total: table.counts.rowsAdded, dot: LoopLook.lime) }
            if !table.rowsRemoved.isEmpty {
                rows("Rows removed", table.rowsRemoved, total: table.counts.rowsRemoved, dot: LoopLook.terracotta)
            }
        }
    }

    private func rows(_ title: String, _ keys: [String], total: Int, dot: Color) -> some View {
        let names = keys.map(LoopChangeWords.row).joined(separator: ", ")
        let more = total > keys.count ? " and \((total - keys.count).formatted()) more" : ""
        return HStack(spacing: 10) {
            Circle().fill(dot).frame(width: 7, height: 7)
            Text(title).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3).frame(width: 110, alignment: .leading)
            Text(names + more).font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
    }
}

/// One value that changed: where it sits and what it is, then what it was and
/// what it is now. A short value reads on one line, struck through and then
/// new; a passage is written out twice, its changed words marked.
private struct LoopDiffValueRow: View {
    let kind: String
    let place: String?
    let label: String?
    let before: String?
    let after: String?
    let code: Bool
    /// A formula cell that changed because its inputs did.
    var recalculated = false

    private static let shortLength = 70

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                LoopListStatusLabel(status: status).frame(width: 112, alignment: .leading)
                if let place {
                    Text(place).font(LoopLook.font(12.5, .medium)).foregroundStyle(LoopLook.ink2).lineLimit(1)
                        .fixedSize()
                }
                if let label, short {
                    Text(label).font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3).lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 8)
                if short { inline }
            }
            if !short { passages }
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
    }

    private var status: LoopListStatus {
        if recalculated { return LoopListStatus(title: "Recalculated", dot: LoopLook.ink3, dim: true) }
        switch kind {
        case "added": return LoopListStatus(title: "Added", dot: LoopLook.lime)
        case "removed": return LoopListStatus(title: "Removed", dot: LoopLook.terracotta)
        default: return LoopListStatus(title: "Changed", dot: LoopLook.sky)
        }
    }

    private var short: Bool {
        [before, after].allSatisfy { ($0?.count ?? 0) <= Self.shortLength && !($0?.contains("\n") ?? false) }
    }

    private var font: Font { code ? .system(size: 12.5, design: .monospaced) : LoopLook.font(13.5) }

    private var inline: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let before {
                Text(before).font(font).monospacedDigit().strikethrough(after != nil, color: LoopLook.terracottaSoft)
                    .foregroundStyle(after == nil ? LoopLook.ink : LoopLook.ink2)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 5).fill(LoopLook.terracotta.opacity(0.16)))
            }
            if before != nil, after != nil {
                Text("\u{2192}").font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3)
            }
            if let after {
                Text(after).font(font).monospacedDigit().foregroundStyle(LoopLook.ink)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 5).fill(LoopLook.lime.opacity(0.12)))
            }
        }
        .lineLimit(1)
        .textSelection(.enabled)
    }

    private var passages: some View {
        let removed = LoopChangeDetail.Line(kind: "remove", text: before ?? "", before: nil, after: nil)
        let added = LoopChangeDetail.Line(kind: "add", text: after ?? "", before: nil, after: nil)
        let shown = [before == nil ? nil : removed, after == nil ? nil : added].compactMap { $0 }
        let marks = LoopChangeWords.changedWords(in: shown)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, line in
                LoopDiffLine(line: line, marks: marks[index] ?? [], gutter: 0, code: code)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .textSelection(.enabled)
    }
}

/// One file a capture recorded: what happened to it and where it is.
private struct LoopDiffFileRow: View {
    let file: LoopChangeDetail.ListedFile

    var body: some View {
        let entry = LoopHistoryEntry(id: file.path, directoryId: "", at: nil, change: file.change, path: file.path,
                                      previousPath: file.previousPath, fileId: nil, fileCount: nil)
        HStack(spacing: 12) {
            LoopListStatusLabel(status: LoopChangeLog.status(entry)).frame(width: 110, alignment: .leading)
            LoopFileIcon(url: nil, fileExtension: (file.path as NSString).pathExtension.lowercased(), size: 18)
            Text(file.path).font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink)
                .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            if let previous = file.previousPath {
                Text("from \(previous)").font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).frame(height: 38)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
    }
}
