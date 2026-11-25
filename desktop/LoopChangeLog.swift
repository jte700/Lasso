// Recent Changes as an audit log: one row per change with when, who, what
// kind of change and which file, and a chevron. Clicking a row opens it in
// place to the change's detail (LoopChangeDiffView.swift), what a diff would
// show; clicking it again closes it. ↑ and ↓ move between rows, → opens the
// chosen one and ← closes it; a double-click opens the file in its app.

import Cocoa
import SwiftUI

/// Which of the log's columns fit the page, and how wide each is.
struct LoopChangeColumns {
    static let chevron: CGFloat = 34
    static let time: CGFloat = 138
    static let by: CGFloat = 178
    static let change: CGFloat = 138
    static let detail: CGFloat = 220

    /// Who made the change, once there is room for it beside the file.
    let by: Bool
    /// What changed, in a few words.
    let detail: Bool

    init(width: CGFloat) {
        by = width >= 720
        detail = width >= 980
    }
}

struct LoopChangeLog: View {
    @ObservedObject var store: LoopStore
    let entries: [LoopHistoryEntry]
    let width: CGFloat
    let compact: Bool
    let since: Date
    @Binding var chosen: String?
    @Binding var expanded: String?
    var menu: (LoopHistoryEntry) -> AnyView = { _ in AnyView(EmptyView()) }
    @FocusState private var focused: Bool

    var body: some View {
        let fits = LoopChangeColumns(width: width)
        LazyVStack(spacing: 0) {
            header(fits)
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                LoopChangeRow(store: store, entry: entry, fits: fits, compact: compact,
                               chosen: chosen == entry.id, expanded: expanded == entry.id) { double in
                    focused = true
                    click(entry, double: double)
                }
                .contextMenu { menu(entry) }
                .loopRise(index, since: since)
            }
        }
        .loopPanel()
        .modifier(LoopListKeysModifier(focused: $focused) { direction in move(direction) })
    }

    private func header(_ fits: LoopChangeColumns) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: LoopChangeColumns.chevron)
            Text("Time").frame(width: LoopChangeColumns.time, alignment: .leading)
            if fits.by { Text("By").frame(width: LoopChangeColumns.by, alignment: .leading) }
            Text("Change").frame(width: LoopChangeColumns.change, alignment: .leading)
            Text("Source").frame(maxWidth: .infinity, alignment: .leading)
            if fits.detail { Text("What changed").frame(width: LoopChangeColumns.detail, alignment: .leading) }
        }
        .font(LoopLook.font(12.5))
        .foregroundStyle(LoopLook.ink3)
        .lineLimit(1)
        .padding(.horizontal, 20)
        .frame(height: 42)
    }

    private func click(_ entry: LoopHistoryEntry, double: Bool) {
        chosen = entry.id
        if double {
            // The first click opened the row; the second opens the file as well.
            if let source = store.source(entry.fileId), let url = store.localURL(for: source) {
                LoopEditors.primary(for: url)?.open(url)
            }
            return
        }
        withAnimation(LoopLook.spring) { expanded = expanded == entry.id ? nil : entry.id }
    }

    /// ↑ and ↓ choose the row above or below, and an open row follows; → opens it, ← closes it.
    private func move(_ direction: MoveCommandDirection) {
        guard !entries.isEmpty else { return }
        let current = chosen.flatMap { id in entries.firstIndex { $0.id == id } }
        switch direction {
        case .up, .down:
            let next = direction == .up ? current.map { max(0, $0 - 1) } ?? entries.count - 1
                : current.map { min(entries.count - 1, $0 + 1) } ?? 0
            chosen = entries[next].id
            if expanded != nil { withAnimation(LoopLook.spring) { expanded = entries[next].id } }
        case .right:
            guard let current else { return }
            withAnimation(LoopLook.spring) { expanded = entries[current].id }
        case .left:
            withAnimation(LoopLook.spring) { expanded = nil }
        @unknown default:
            break
        }
    }

    // MARK: What a row says

    static func status(_ entry: LoopHistoryEntry) -> LoopListStatus {
        switch entry.change {
        case "added": return LoopListStatus(title: "Added", dot: LoopLook.lime)
        case "removed": return LoopListStatus(title: "Removed", dot: LoopLook.terracotta)
        case "renamed": return LoopListStatus(title: "Renamed", dot: LoopLook.rope)
        case "moved": return LoopListStatus(title: "Moved", dot: LoopLook.rope)
        case "directory-added": return LoopListStatus(title: "Directory added", dot: LoopLook.lime)
        case "many": return LoopListStatus(title: "Many at once", dot: LoopLook.rope)
        default: return LoopListStatus(title: "Edited", dot: LoopLook.sky)
        }
    }

    static func detail(_ entry: LoopHistoryEntry, directory: String) -> String? {
        switch entry.change {
        case "directory-added", "many":
            let count = entry.fileCount ?? 0
            return count == 1 ? "1 file" : "\(count.formatted()) files"
        case "renamed", "moved":
            return entry.previousPath.map { "From \(($0 as NSString).lastPathComponent)" }
        default:
            return entry.textChanges.map(LoopChangeWords.textSummary) ?? entry.valueCaption(directory: directory)
        }
    }

    private static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter
    }()

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter
    }()

    /// "Nov 3, 10:24", as an audit log dates its rows, in the Mac's own day and clock.
    static func stamp(_ date: Date?) -> String {
        guard let date else { return "Unknown" }
        return "\(day.string(from: date)), \(time.string(from: date))"
    }
}

private struct LoopChangeRow: View {
    @ObservedObject var store: LoopStore
    let entry: LoopHistoryEntry
    let fits: LoopChangeColumns
    let compact: Bool
    let chosen: Bool
    let expanded: Bool
    let click: (Bool) -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            line
            if expanded {
                LoopChangeDiffView(store: store, entry: entry)
                    .padding(.leading, 20 + LoopChangeColumns.chevron)
                    .padding(.trailing, 20)
                    .padding(.top, 4)
                    .padding(.bottom, 24)
                    .transition(.opacity.combined(with: .offset(y: -6)))
            }
        }
        .background(expanded || chosen ? LoopLook.raise : hovering ? LoopLook.rgb(0xF6F4EC, 0.035) : Color.clear)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
        .id(entry.id)
    }

    private var line: some View {
        let directory = store.directoryName(entry.directoryId)
        let detail = LoopChangeLog.detail(entry, directory: directory)
        return HStack(spacing: 0) {
            LoopLucideIcon(icon: .chevronRight, size: 15, color: hovering || expanded ? LoopLook.ink : LoopLook.ink3)
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .frame(width: LoopChangeColumns.chevron, alignment: .leading)
            Text(LoopChangeLog.stamp(entry.at))
                .font(LoopLook.font(13.5)).monospacedDigit().foregroundStyle(LoopLook.ink2).lineLimit(1)
                .help(LoopFormat.ago(entry.at).capitalizedFirst)
                .frame(width: LoopChangeColumns.time, alignment: .leading)
            if fits.by {
                LoopChangeActor(who: LoopChangeWords.who(entry.actor, source: entry.source), compact: compact)
                    .padding(.trailing, 10)
                    .frame(width: LoopChangeColumns.by, alignment: .leading)
            }
            LoopListStatusLabel(status: LoopChangeLog.status(entry))
                .padding(.trailing, 8)
                .frame(width: LoopChangeColumns.change, alignment: .leading)
            source(directory: directory)
                .padding(.trailing, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            if fits.detail {
                Text(detail ?? "\u{2014}").font(LoopLook.font(13.5)).monospacedDigit()
                    .foregroundStyle(entry.valueChanges != nil || entry.textChanges != nil ? LoopLook.ink : LoopLook.ink3)
                    .lineLimit(1).truncationMode(.middle)
                    .frame(width: LoopChangeColumns.detail, alignment: .leading)
            }
        }
        .padding(.horizontal, 20)
        .frame(height: compact ? 44 : 60)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { click((NSApp.currentEvent?.clickCount ?? 1) >= 2) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(expanded ? "Open" : "Closed")
        .accessibilityAction { click(false) }
    }

    private func source(directory: String) -> some View {
        let name = entry.path.map { ($0 as NSString).lastPathComponent } ?? directory
        let folder = entry.path.map { ($0 as NSString).deletingLastPathComponent } ?? ""
        return HStack(spacing: 12) {
            if let path = entry.path {
                LoopFileIcon(url: nil, fileExtension: (path as NSString).pathExtension.lowercased(), size: compact ? 20 : 26)
            } else {
                LoopLucideIcon(icon: .folder, size: compact ? 17 : 21, color: store.directory(entry.directoryId)?.color ?? LoopLook.ink2)
                    .frame(width: compact ? 20 : 26, height: compact ? 20 : 26)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(LoopLook.font(14.5, .medium)).foregroundStyle(LoopLook.ink)
                    .lineLimit(1).truncationMode(.middle)
                if !compact {
                    HStack(spacing: 6) {
                        Circle().fill(store.directory(entry.directoryId)?.color ?? LoopLook.ink3).frame(width: 6, height: 6)
                        Text(folder.isEmpty ? directory : "\(directory) \u{00B7} \(folder)")
                            .font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
            }
        }
    }
}

/// Who made a change: a soft orb for a person, a mark in a ring for an agent,
/// the disk or Lasso, and the name beside it.
struct LoopChangeActor: View {
    let who: LoopChangeWords.Who
    var compact = false

    var body: some View {
        HStack(spacing: 10) {
            mark.frame(width: compact ? 20 : 24, height: compact ? 20 : 24)
            Text(who.title).font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink).lineLimit(1).truncationMode(.tail)
        }
    }

    @ViewBuilder private var mark: some View {
        switch who {
        case .person(let name):
            let (light, deep) = Self.orb(for: name)
            Circle()
                .fill(LinearGradient(colors: [light, deep], startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay(Circle().fill(RadialGradient(colors: [Color.white.opacity(0.45), .clear],
                                                      center: .init(x: 0.32, y: 0.28), startRadius: 0, endRadius: 9)))
        case .agent:
            ring("sparkles")
        case .disk:
            ring("internaldrive")
        case .lasso:
            ring(MascotMark.symbolName)
        }
    }

    private func ring(_ symbol: String) -> some View {
        LassoSymbol(name: symbol, size: compact ? 9 : 10.5, weight: .medium).foregroundStyle(LoopLook.ink2)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(Circle().strokeBorder(LoopLook.line, lineWidth: 1))
    }

    /// Two of the site's colours per person, chosen by their name so they keep them.
    private static let orbs: [(Color, Color)] = [
        (LoopLook.skySoft, LoopLook.rgb(0x5C7FE0)), (LoopLook.ropeSoft, LoopLook.terracotta),
        (LoopLook.rgb(0xD9B8F0), LoopLook.rgb(0x8A5BC9)), (LoopLook.sageSoft, LoopLook.forest),
        (LoopLook.cream, LoopLook.rope), (LoopLook.terracottaSoft, LoopLook.rgb(0x9C4A68)),
    ]

    static func orb(for name: String) -> (Color, Color) {
        let sum = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return orbs[sum % orbs.count]
    }
}

/// "3 new changes": floats at the top of Recent Changes while changes that
/// arrived wait to be listed, so the list holds still while it is read.
struct LoopNewChangesPill: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "arrow.up").font(.system(size: 11.5, weight: .semibold))
                Text(LoopChangeFeed.pillTitle(count)).font(LoopLook.font(13, .medium)).monospacedDigit()
            }
        }
        .buttonStyle(LoopNewChangesPillStyle())
        .help("List the changes that arrived since this list was read")
        .accessibilityLabel("\(LoopChangeFeed.pillTitle(count)). Show them.")
    }
}

private struct LoopNewChangesPillStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        LoopHover { hovering in
            configuration.label
                .foregroundStyle(LoopLook.onSky)
                .padding(.horizontal, 16)
                .frame(height: 34)
                .background(Capsule().fill(hovering ? LoopLook.skySoft : LoopLook.sky))
                .shadow(color: .black.opacity(0.45), radius: 14, y: 6)
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
                .contentShape(Capsule())
        }
    }
}
