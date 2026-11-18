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

struct RanchChangeDiffView: View {
    @ObservedObject var store: RanchStore
    let entry: RanchHistoryEntry
    @State private var detail: RanchChangeDetail?
    @State private var failure: String?
    @State private var task: URLSessionDataTask?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text("Change detail").font(RanchLook.font(14.5, .medium)).foregroundStyle(RanchLook.ink)
                Spacer(minLength: 8)
                buttons
            }
            if let detail {
                facts(detail)
                RanchChangeBody(detail: detail)
            } else if let failure {
                Text(failure).font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3)
            } else {
                Text("Reading the change\u{2026}").font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3)
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
            .buttonStyle(RanchPageButtonStyle(height: 30))
            .help("Show this file beside the list")
            if let url = store.localURL(for: source), let editor = RanchEditors.primary(for: url) {
                Button { _ = editor.open(url) } label: {
                    Label("Open", systemImage: "arrow.up.forward.app")
                }
                .buttonStyle(RanchPageButtonStyle(height: 30))
                .help("Open in \(editor.name)")
            }
        }
    }

    // MARK: Facts

    private func facts(_ detail: RanchChangeDetail) -> some View {
        let who = RanchChangeWords.who(detail.actor, source: detail.source)
        var rows: [(String, String)] = [
            ("When", RanchFormat.full(detail.at)),
            ("Recorded", RanchChangeWords.recorded(detail.source)),
            ("By", detail.initiatedBy.map { "\(who.title), asked by \($0.name)" } ?? who.title),
        ]
        if let version = RanchChangeWords.version(detail.version) { rows.append(("Directory version", version)) }
        if let size = RanchChangeWords.size(before: detail.file?.before?.size, after: detail.file?.after?.size) {
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
                    Text(title).font(RanchLook.font(12)).foregroundStyle(RanchLook.ink3)
                    Text(value).font(RanchLook.font(13.5)).monospacedDigit().foregroundStyle(RanchLook.ink)
                        .lineLimit(3).truncationMode(.middle)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// The panel of what changed inside the file, inset like a diff in a review.
private struct RanchChangeBody: View {
    let detail: RanchChangeDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let lines = detail.lines, !lines.hunks.isEmpty {
                caption(RanchChangeWords.lineSummary(lines), counts: (lines.added, lines.removed))
                RanchDiffLines(lines: lines, code: detail.isCode)
                if lines.truncated { note("Only the start of this change is shown. The whole file is in its history.") }
            } else if let table = detail.table, detail.listsChanges {
                caption(Self.tableSummary(table))
                RanchDiffTable(table: table)
            } else if let fields = detail.fields, !fields.isEmpty {
                caption(fields.count == 1 ? "1 field changed" : "\(fields.count.formatted()) fields changed")
                ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                    RanchDiffValueRow(kind: field.kind == "changed" ? "modified" : field.kind, place: field.path,
                                      label: nil, before: field.before, after: field.after, code: true)
                }
            } else if !detail.values.isEmpty {
                caption(Self.valueSummary(detail))
                ForEach(Array(detail.values.enumerated()), id: \.offset) { _, value in
                    RanchDiffValueRow(kind: value.kind, place: value.place, label: value.label,
                                      before: value.shownBefore, after: value.shownAfter, code: false)
                }
                if detail.valueCount > detail.values.count {
                    note("And \((detail.valueCount - detail.values.count).formatted()) more. The file\u{2019}s viewer tints every one.")
                }
            } else if !detail.files.isEmpty {
                caption(detail.fileCount == 1 ? "1 file recorded" : "\(detail.fileCount.formatted()) files recorded")
                ForEach(Array(detail.files.enumerated()), id: \.offset) { _, file in RanchDiffFileRow(file: file) }
                if detail.fileCount > detail.files.count {
                    note("And \((detail.fileCount - detail.files.count).formatted()) more.")
                }
            } else {
                Text(RanchChangeWords.nothingListed(detail))
                    .font(RanchLook.font(13.5)).foregroundStyle(RanchLook.ink2)
                    .padding(16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(RanchLook.panel))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(RanchLook.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func caption(_ text: String, counts: (added: Int, removed: Int)? = nil) -> some View {
        HStack(spacing: 10) {
            Text(text).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink2)
            Spacer(minLength: 8)
            if let counts {
                Text("+\(counts.added.formatted())").foregroundStyle(RanchLook.lime)
                Text("\u{2212}\(counts.removed.formatted())").foregroundStyle(RanchLook.terracottaSoft)
            }
            if detail.movedCount > 0 {
                Text("\(detail.movedCount.formatted()) moved without changing").foregroundStyle(RanchLook.ink3)
            }
        }
        .font(RanchLook.font(12.5, .medium)).monospacedDigit()
        .padding(.horizontal, 16)
        .frame(height: 38)
    }

    private func note(_ text: String) -> some View {
        Text(text).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { RanchLook.line2.frame(height: 1) }
    }

    private static func tableSummary(_ table: RanchChangeDetail.Table) -> String {
        let parts = [
            table.counts.cellsChanged > 0 ? (table.counts.cellsChanged == 1 ? "1 cell changed" : "\(table.counts.cellsChanged.formatted()) cells changed") : nil,
            table.counts.rowsAdded > 0 ? (table.counts.rowsAdded == 1 ? "1 row added" : "\(table.counts.rowsAdded.formatted()) rows added") : nil,
            table.counts.rowsRemoved > 0 ? (table.counts.rowsRemoved == 1 ? "1 row removed" : "\(table.counts.rowsRemoved.formatted()) rows removed") : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? "No cells changed" : parts.joined(separator: " \u{00B7} ")
    }

    private static func valueSummary(_ detail: RanchChangeDetail) -> String {
        let count = detail.valueCount
        let word = detail.values.allSatisfy { $0.kind == "added" } ? "added" : detail.values.allSatisfy { $0.kind == "removed" } ? "removed" : "changed"
        return count == 1 ? "1 value \(word)" : "\(count.formatted()) values \(word)"
    }
}

/// Changed lines in hunks, each line with its numbers before and after, its
/// sign, and its words; a gap between hunks stands for the lines left out.
private struct RanchDiffLines: View {
    let lines: RanchChangeDetail.Lines
    let code: Bool

    var body: some View {
        let widest = lines.hunks.flatMap(\.lines).flatMap { [$0.before ?? 0, $0.after ?? 0] }.max() ?? 0
        let gutter = CGFloat(String(widest).count) * 8 + 16
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.hunks.enumerated()), id: \.offset) { index, hunk in
                if index > 0 {
                    Text("\u{22EF}").font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, gutter * 2 + 8)
                        .frame(height: 26)
                        .background(RanchLook.rgb(0x000000, 0.18))
                }
                let marks = RanchChangeWords.changedWords(in: hunk.lines)
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { offset, line in
                    RanchDiffLine(line: line, marks: marks[offset] ?? [], gutter: gutter, code: code)
                }
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .top) { RanchLook.line2.frame(height: 1) }
        .textSelection(.enabled)
    }
}

private struct RanchDiffLine: View {
    let line: RanchChangeDetail.Line
    let marks: [NSRange]
    let gutter: CGFloat
    let code: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            number(line.before)
            number(line.after)
            Text(sign).font(font).foregroundStyle(signColor).frame(width: 22)
            Text(words).font(font).foregroundStyle(line.kind == "same" ? RanchLook.ink2 : RanchLook.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2.5)
        .padding(.trailing, 16)
        .background(tint)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(line.kind == "add" ? "Added" : line.kind == "remove" ? "Removed" : "Unchanged"): \(line.text)")
    }

    private var font: Font { code ? .system(size: 12.5, design: .monospaced) : RanchLook.font(13.5) }

    private func number(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "").font(RanchLook.font(12)).monospacedDigit().foregroundStyle(RanchLook.ink3)
            .frame(width: gutter, alignment: .trailing)
            .padding(.trailing, 4)
    }

    private var sign: String {
        line.kind == "add" ? "+" : line.kind == "remove" ? "\u{2212}" : ""
    }

    private var signColor: Color { line.kind == "add" ? RanchLook.lime : RanchLook.terracottaSoft }

    private var tint: Color {
        switch line.kind {
        case "add": return RanchLook.lime.opacity(0.085)
        case "remove": return RanchLook.terracotta.opacity(0.14)
        default: return .clear
        }
    }

    /// The line's words, the ones its pair changed marked; an empty line keeps its height.
    private var words: AttributedString {
        var text = AttributedString(line.text.isEmpty ? " " : line.text)
        let mark = line.kind == "add" ? RanchLook.lime.opacity(0.26) : RanchLook.terracotta.opacity(0.4)
        for range in marks {
            guard let found = Range(range, in: text) else { continue }
            text[found][AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = mark
        }
        return text
    }
}

/// A table's changed cells, then the rows it gained and lost.
private struct RanchDiffTable: View {
    let table: RanchChangeDetail.Table

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(table.cells.enumerated()), id: \.offset) { _, cell in
                RanchDiffValueRow(kind: "modified", place: RanchChangeWords.row(cell.row), label: cell.column,
                                  before: cell.before, after: cell.after, code: false)
            }
            if !table.rowsAdded.isEmpty { rows("Rows added", table.rowsAdded, total: table.counts.rowsAdded, dot: RanchLook.lime) }
            if !table.rowsRemoved.isEmpty {
                rows("Rows removed", table.rowsRemoved, total: table.counts.rowsRemoved, dot: RanchLook.terracotta)
            }
        }
    }

    private func rows(_ title: String, _ keys: [String], total: Int, dot: Color) -> some View {
        let names = keys.map(RanchChangeWords.row).joined(separator: ", ")
        let more = total > keys.count ? " and \((total - keys.count).formatted()) more" : ""
        return HStack(spacing: 10) {
            Circle().fill(dot).frame(width: 7, height: 7)
            Text(title).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3).frame(width: 110, alignment: .leading)
            Text(names + more).font(RanchLook.font(13.5)).foregroundStyle(RanchLook.ink).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .overlay(alignment: .top) { RanchLook.line2.frame(height: 1) }
    }
}

/// One value that changed: where it sits and what it is, then what it was and
/// what it is now. A short value reads on one line, struck through and then
/// new; a passage is written out twice, its changed words marked.
private struct RanchDiffValueRow: View {
    let kind: String
    let place: String?
    let label: String?
    let before: String?
    let after: String?
    let code: Bool

    private static let shortLength = 70

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                RanchListStatusLabel(status: status).frame(width: 96, alignment: .leading)
                if let place {
                    Text(place).font(RanchLook.font(12.5, .medium)).foregroundStyle(RanchLook.ink2).lineLimit(1)
                        .fixedSize()
                }
                if let label, short {
                    Text(label).font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3).lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 8)
                if short { inline }
            }
            if !short { passages }
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .overlay(alignment: .top) { RanchLook.line2.frame(height: 1) }
    }

    private var status: RanchListStatus {
        switch kind {
        case "added": return RanchListStatus(title: "Added", dot: RanchLook.lime)
        case "removed": return RanchListStatus(title: "Removed", dot: RanchLook.terracotta)
        default: return RanchListStatus(title: "Changed", dot: RanchLook.sky)
        }
    }

    private var short: Bool {
        [before, after].allSatisfy { ($0?.count ?? 0) <= Self.shortLength && !($0?.contains("\n") ?? false) }
    }

    private var font: Font { code ? .system(size: 12.5, design: .monospaced) : RanchLook.font(13.5) }

    private var inline: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let before {
                Text(before).font(font).monospacedDigit().strikethrough(after != nil, color: RanchLook.terracottaSoft)
                    .foregroundStyle(after == nil ? RanchLook.ink : RanchLook.ink2)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 5).fill(RanchLook.terracotta.opacity(0.16)))
            }
            if before != nil, after != nil {
                Text("\u{2192}").font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3)
            }
            if let after {
                Text(after).font(font).monospacedDigit().foregroundStyle(RanchLook.ink)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 5).fill(RanchLook.lime.opacity(0.12)))
            }
        }
        .lineLimit(1)
        .textSelection(.enabled)
    }

    private var passages: some View {
        let removed = RanchChangeDetail.Line(kind: "remove", text: before ?? "", before: nil, after: nil)
        let added = RanchChangeDetail.Line(kind: "add", text: after ?? "", before: nil, after: nil)
        let shown = [before == nil ? nil : removed, after == nil ? nil : added].compactMap { $0 }
        let marks = RanchChangeWords.changedWords(in: shown)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, line in
                RanchDiffLine(line: line, marks: marks[index] ?? [], gutter: 0, code: code)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .textSelection(.enabled)
    }
}

/// One file a capture recorded: what happened to it and where it is.
private struct RanchDiffFileRow: View {
    let file: RanchChangeDetail.ListedFile

    var body: some View {
        let entry = RanchHistoryEntry(id: file.path, directoryId: "", at: nil, change: file.change, path: file.path,
                                      previousPath: file.previousPath, fileId: nil, fileCount: nil)
        HStack(spacing: 12) {
            RanchListStatusLabel(status: RanchChangeLog.status(entry)).frame(width: 110, alignment: .leading)
            RanchFileIcon(url: nil, fileExtension: (file.path as NSString).pathExtension.lowercased(), size: 18)
            Text(file.path).font(RanchLook.font(13.5)).foregroundStyle(RanchLook.ink)
                .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            if let previous = file.previousPath {
                Text("from \(previous)").font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).frame(height: 38)
        .overlay(alignment: .top) { RanchLook.line2.frame(height: 1) }
    }
}
