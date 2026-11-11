// The middle column of The Ranch: what the chosen library view or directory
// holds. Selecting a row shows its file on the right.

import Cocoa
import SwiftUI

struct RanchContent: View {
    @ObservedObject var store: RanchStore

    var body: some View {
        Group {
            switch store.section ?? .sources {
            case .changes: RanchChangesList(store: store)
            case .sources: RanchSourcesList(store: store, directoryId: nil)
            case .directory(let id): RanchSourcesList(store: store, directoryId: id)
            case .links: RanchLinksList(store: store)
            case .review: RanchReviewList(store: store)
            case .network: RanchNetworkView(store: store)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(RanchTheme.surface)
        .overlay {
            if !store.hasLoaded {
                if let error = store.loadError {
                    RanchEmptyState(symbol: "exclamationmark.icloud", title: "The Library Isn\u{2019}t Available", message: error)
                        .background(RanchTheme.surface)
                } else {
                    VStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Gathering your sources\u{2026}").font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }
}

/// A line under a column's header about what it leaves out.
struct RanchNotice: View {
    let text: String

    var body: some View {
        Text(text)
            .font(RanchTheme.captionFont)
            .foregroundStyle(RanchTheme.secondaryInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) { RanchHairline() }
    }
}

/// The kind filter and file order, as pill menus above a list of files.
struct RanchFileMenus: View {
    @ObservedObject var store: RanchStore

    var body: some View {
        RanchPillMenu(title: store.kindFilter.title,
                      symbol: store.kindFilter == .all ? "line.3.horizontal.decrease" : store.kindFilter.symbol,
                      help: "Show: \(store.kindFilter.title)") {
            Picker("Show", selection: $store.kindFilter) {
                ForEach(RanchKindFilter.allCases) { Label($0.title, systemImage: $0.symbol).tag($0) }
            }
            .pickerStyle(.inline)
        }
        RanchPillMenu(title: store.itemOrder.title, symbol: "arrow.up.arrow.down",
                      help: "Sort Files By: \(store.itemOrder.title)") {
            Picker("Sort Files By", selection: $store.itemOrder) {
                ForEach(RanchOrder.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.inline)
        }
    }
}

// MARK: Sources

struct RanchSourcesList: View {
    @ObservedObject var store: RanchStore
    let directoryId: String?

    var body: some View {
        let directories = directoryId.map { id in store.directory(id).map { [$0] } ?? [] } ?? store.orderedDirectories
        let groups = directories.map { ($0, store.sources(in: $0.id)) }
        let total = groups.reduce(0) { $0 + $1.1.count }
        let flagged = Set(store.overview.review.compactMap(\.fileId))
        VStack(spacing: 0) {
            RanchColumnHeader(title: directoryId.flatMap { store.directory($0)?.name } ?? "All Sources",
                              subtitle: subtitle(directories: directories, total: total))
            RanchFilterBar { RanchFileMenus(store: store) }
            if store.overview.truncated {
                RanchNotice(text: "Your library is very large; The Ranch lists the first \(store.overview.sources.count.formatted()) files.")
            }
            if total == 0 && store.hasLoaded {
                RanchEmptyState(symbol: emptySymbol, title: emptyTitle, message: emptyMessage)
            } else {
                RanchCardList(selection: $store.selectedSourceID, order: { groups.flatMap { $0.1.map(\.id) } }) {
                    ForEach(groups, id: \.0.id) { directory, sources in
                        if directoryId == nil {
                            if !sources.isEmpty {
                                Section {
                                    rows(sources, flagged: flagged)
                                } header: {
                                    RanchSectionHeader(title: directory.name, symbol: directory.sidebarSymbol, tint: directory.color) {
                                        RanchCount(value: sources.count)
                                    }
                                }
                            }
                        } else {
                            rows(sources, flagged: flagged)
                        }
                    }
                }
            }
        }
    }

    private var emptySymbol: String {
        !store.searchText.isEmpty ? "magnifyingglass" : store.kindFilter != .all ? store.kindFilter.symbol : "folder"
    }

    private var emptyTitle: String {
        !store.searchText.isEmpty || store.kindFilter != .all ? "No Matches" : "No Files"
    }

    private var emptyMessage: String {
        if !store.searchText.isEmpty { return "No file names match \u{201C}\(store.searchText)\u{201D}." }
        if store.kindFilter != .all { return "There are no \(store.kindFilter.title.lowercased()) here. Choose All Kinds to see every file." }
        return "Files in this directory appear here once Lasso has read them."
    }

    @ViewBuilder
    private func rows(_ sources: [RanchSource], flagged: Set<String>) -> some View {
        ForEach(sources) { source in
            // Double-clicking opens the file in the app that edits it, as in Finder.
            RanchCard(id: source.id, selection: $store.selectedSourceID, open: { edit(source) }) {
                RanchSourceRow(source: source, url: nil, order: store.itemOrder, flagged: flagged.contains(source.id))
            }
            .contextMenu { RanchSourceMenu(store: store, source: source) }
            // Drag a file out to Mail, Finder or any app that takes files.
            .onDrag { store.localURL(for: source).flatMap { NSItemProvider(contentsOf: $0) } ?? NSItemProvider() }
        }
    }

    private func edit(_ source: RanchSource) {
        guard let url = store.localURL(for: source) else { return }
        RanchEditors.primary(for: url)?.open(url)
    }

    private func subtitle(directories: [RanchDirectory], total: Int) -> String {
        let files = "\(total.formatted()) \(store.kindFilter == .all ? "file" : store.kindFilter.title.lowercased())"
            + (store.kindFilter == .all && total != 1 ? "s" : "")
        let place = directoryId == nil ? " in \(directories.count) directories" : ""
        return "\(files)\(place) \u{00B7} \(store.itemOrder.title)"
    }
}

struct RanchSourceRow: View {
    let source: RanchSource
    let url: URL?
    let order: RanchOrder
    let flagged: Bool

    var body: some View {
        HStack(spacing: 10) {
            RanchFileIcon(url: url, fileExtension: source.fileExtension, size: 24)
            RanchRowText(title: source.name, caption: caption)
            Spacer(minLength: 4)
            if flagged {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(RanchTheme.warning).imageScale(.small)
                    .help("Needs review")
            }
            if source.activeShares > 0 {
                Image(systemName: "link").foregroundStyle(RanchTheme.secondaryInk).imageScale(.small)
                    .help(source.activeShares == 1 ? "Shared with a working link" : "Shared with \(source.activeShares) working links")
            }
            if source.activity > 0 { RanchActivityDot(activity: source.activity) }
        }
    }

    /// The date the chosen order sorts by, beside the folder the file is in.
    private var caption: String {
        let when: String
        switch order {
        case .lastEdited: when = "Edited \(RanchFormat.ago(source.modifiedAt))"
        case .recentlyUsed: when = source.lastUsedAt.map { "Used \(RanchFormat.ago($0))" } ?? "Not used yet"
        case .oldest, .newest: when = "Created \(RanchFormat.ago(source.createdAt ?? source.modifiedAt))"
        }
        return source.folder.isEmpty ? when : "\(source.folder) \u{00B7} \(when)"
    }
}

/// The right-click menu of a file, wherever it is listed.
struct RanchSourceMenu: View {
    @ObservedObject var store: RanchStore
    let source: RanchSource

    var body: some View {
        if let url = store.localURL(for: source) {
            let choice = RanchEditorChoice(url: url)
            if let editor = choice.primary {
                Button("Edit in \(editor.name)") { editor.open(url) }
            }
            if !choice.others.isEmpty {
                Menu("Open With") {
                    ForEach(choice.others) { app in Button(app.name) { app.open(url) } }
                }
            }
            Divider()
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            Button("Copy Path") { store.copy(url.path) }
        } else {
            Text("Not on this Mac right now")
        }
    }
}

// MARK: Recent changes

struct RanchChangesList: View {
    @ObservedObject var store: RanchStore
    @State private var selection: String?

    var body: some View {
        let entries = store.overview.history.filter { entry in
            store.searchText.isEmpty || (entry.path ?? store.directoryName(entry.directoryId))
                .localizedCaseInsensitiveContains(store.searchText)
        }
        let days = Dictionary(grouping: entries) { Calendar.current.startOfDay(for: $0.at ?? .distantPast) }
        let order = days.keys.sorted(by: >)
        VStack(spacing: 0) {
            RanchColumnHeader(title: "Recent Changes",
                              subtitle: "Last 2 weeks \u{00B7} \(entries.count) change\(entries.count == 1 ? "" : "s")")
            if entries.isEmpty && store.hasLoaded {
                RanchEmptyState(symbol: "clock", title: "No Changes",
                                message: "Edits, new files and removals from the last two weeks appear here.")
            } else {
                RanchCardList(selection: $selection, order: { order.flatMap { (days[$0] ?? []).map(\.id) } }) {
                    ForEach(order, id: \.self) { day in
                        Section {
                            ForEach(days[day] ?? []) { entry in
                                RanchCard(id: entry.id, selection: $selection) {
                                    RanchChangeRow(entry: entry, directory: store.directoryName(entry.directoryId))
                                }
                            }
                        } header: {
                            RanchSectionHeader(title: RanchFormat.dayTitle(day))
                        }
                    }
                }
                if store.overview.historyTruncated {
                    RanchNotice(text: "Only the latest changes are listed. Every file keeps its full history in Lasso.")
                        .overlay(alignment: .top) { RanchHairline() }
                }
            }
        }
        .onChange(of: selection) { id in
            let entry = store.overview.history.first { $0.id == id }
            store.selectedSourceID = entry?.fileId
            if let entry, entry.fileId == nil { store.selectionNote = note(for: entry) }
        }
    }
}

extension RanchChangesList {
    /// A change with no file left to show still says what happened.
    func note(for entry: RanchHistoryEntry) -> (title: String, message: String) {
        let directory = store.directoryName(entry.directoryId)
        let when = RanchFormat.full(entry.at)
        guard let path = entry.path else {
            if entry.change == "many" {
                return (directory, "\(entry.fileCount ?? 0) files changed together in \(directory) on \(when), as a sync or a batch export does. Choose the directory to see them.")
            }
            return (directory, "Added to The Ranch on \(when), with \(entry.fileCount ?? 0) files. Choose a file in it to look through it.")
        }
        let name = (path as NSString).lastPathComponent
        return (name, "\(name) was \(entry.change) in \(directory) on \(when). It is no longer in the directory; Lasso keeps its history.")
    }
}

/// A symbol in a soft circle of its own colour, at the start of a row.
struct RanchRowBadge: View {
    let symbol: String
    let tint: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 11.5, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 26, height: 26)
            .background(Circle().fill(tint.opacity(0.13)))
    }
}

struct RanchChangeRow: View {
    let entry: RanchHistoryEntry
    let directory: String

    var body: some View {
        HStack(spacing: 10) {
            RanchRowBadge(symbol: symbol, tint: tint)
            RanchRowText(title: title, caption: caption)
            Spacer(minLength: 4)
            Text(RanchFormat.clock(entry.at)).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.tertiaryInk).monospacedDigit()
        }
    }

    private var title: String {
        guard let path = entry.path else { return directory }
        return (path as NSString).lastPathComponent
    }

    private var caption: String {
        switch entry.change {
        case "directory-added":
            let count = entry.fileCount ?? 0
            return "Added to The Ranch \u{00B7} \(count) file\(count == 1 ? "" : "s")"
        case "many": return "\(entry.fileCount ?? 0) files changed at once"
        case "renamed", "moved":
            let before = entry.previousPath.map { ($0 as NSString).lastPathComponent } ?? "another name"
            return "\(entry.change == "moved" ? "Moved" : "Renamed") from \(before) \u{00B7} \(directory)"
        default: return entry.valueCaption(directory: directory) ?? "\(entry.change.capitalized) \u{00B7} \(directory)"
        }
    }

    private var symbol: String {
        switch entry.change {
        case "added": return "plus"
        case "removed": return "minus"
        case "renamed", "moved": return "arrow.right"
        case "directory-added": return "folder.badge.plus"
        case "many": return "doc.on.doc"
        default: return "pencil"
        }
    }

    private var tint: Color {
        switch entry.change {
        case "added", "directory-added": return .green
        case "removed": return .red
        default: return .accentColor
        }
    }
}

// MARK: Links

struct RanchLinksList: View {
    @ObservedObject var store: RanchStore
    @State private var selection: String?

    var body: some View {
        let links = store.overview.links
        VStack(spacing: 0) {
            RanchColumnHeader(title: "Links", subtitle: "\(store.activeLinkCount) active \u{00B7} \(links.received.count) received")
            RanchFilterBar {
                RanchSegmented(selection: $store.linkTab,
                               options: RanchStore.LinkTab.allCases.map { ($0, tabTitle($0, links)) })
            }
            if store.linkTab == .outgoing {
                outgoing(links.outgoing)
            } else {
                received(links.received)
            }
        }
        .onChange(of: selection) { id in select(id, links) }
    }

    private func tabTitle(_ tab: RanchStore.LinkTab, _ links: RanchLinks) -> String {
        let count = tab == .outgoing ? links.outgoing.count : links.received.count
        return "\(tab.title) (\(count))"
    }

    private func select(_ id: String?, _ links: RanchLinks) {
        let shared: String? = links.outgoing.first { $0.id == id }?.fileId
        let received: String? = links.received.first { $0.id == id }?.fileId
        store.selectedSourceID = shared ?? received
    }

    @ViewBuilder
    private func outgoing(_ links: [RanchOutgoingLink]) -> some View {
        if links.isEmpty {
            RanchEmptyState(symbol: "link", title: "No Shared Links",
                            message: "Choose Share Link on any file, or press \u{21E7}\u{2318}\u{21A9} on a suggestion, to make one. Links stop working after 48 hours.")
        } else {
            RanchCardList(selection: $selection, order: { links.map(\.id) }) {
                ForEach(links) { link in
                    RanchCard(id: link.id, selection: $selection) {
                        RanchOutgoingRow(link: link, directory: store.directoryName(link.directoryId),
                                         copy: { store.copy(link.url) }, stop: { store.stopSharing(link) })
                    }
                    .contextMenu {
                        Button("Copy Link") { store.copy(link.url) }
                        if link.status == "active" { Button("Stop Sharing") { store.stopSharing(link) } }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func received(_ links: [RanchReceivedLink]) -> some View {
        if links.isEmpty {
            RanchEmptyState(symbol: "tray.and.arrow.down", title: "No Received Links",
                            message: "Share links people send you appear here when they arrive in an indexed folder, a note, or mail from a connected app.")
        } else {
            RanchCardList(selection: $selection, order: { links.map(\.id) }) {
                ForEach(links) { link in
                    RanchCard(id: link.id, selection: $selection) {
                        RanchReceivedRow(link: link, directory: store.directoryName(link.directoryId), copy: { store.copy(link.url) })
                    }
                    .contextMenu {
                        Button("Copy Link") { store.copy(link.url) }
                        if let url = URL(string: link.url) { Button("Open Link") { NSWorkspace.shared.open(url) } }
                    }
                }
            }
        }
    }
}

struct RanchOutgoingRow: View {
    let link: RanchOutgoingLink
    let directory: String
    let copy: () -> Void
    let stop: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            RanchFileIcon(url: nil, fileExtension: ((link.path ?? "") as NSString).pathExtension, size: 24)
            RanchRowText(title: link.name ?? link.path ?? "Shared source", caption: caption)
            Spacer(minLength: 4)
            Text(statusTitle).font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Capsule().fill(statusColor.opacity(0.13)))
                .foregroundStyle(statusColor)
                .lineLimit(1)
            RanchCopyButton(copy: copy)
            if link.status == "active" {
                Button(action: stop) { Image(systemName: "xmark.circle") }
                    .buttonStyle(RanchIconButtonStyle(size: 24)).help("Stop Sharing")
            }
        }
    }

    private var caption: String {
        let scope = ["INDEXED": "Cited part", "REDACTED": "Redacted", "MARKED": "Marked up"][link.scope] ?? "Whole document"
        return [link.locator, scope, directory].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    private var statusTitle: String {
        switch link.status {
        case "active": return link.expiresAt.map { "Expires \(RanchFormat.ago($0))" } ?? "Active"
        case "expired": return "Expired"
        default: return "Stopped"
        }
    }

    private var statusColor: Color {
        link.status == "active" ? (link.drifted ? RanchTheme.warning : .green) : RanchTheme.secondaryInk
    }
}

struct RanchReceivedRow: View {
    let link: RanchReceivedLink
    let directory: String
    let copy: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            RanchRowBadge(symbol: "tray.and.arrow.down", tint: .accentColor)
            RanchRowText(title: URL(string: link.url)?.host ?? link.url,
                         caption: "In \((link.path as NSString).lastPathComponent) \u{00B7} \(directory) \u{00B7} \(RanchFormat.ago(link.receivedAt))")
            Spacer(minLength: 4)
            RanchCopyButton(copy: copy)
        }
    }
}

/// Copies a link, and shows a tick for a moment so the copy is seen to land.
struct RanchCopyButton: View {
    let copy: () -> Void
    @State private var copied = false
    private static let tickDuration: TimeInterval = 1.5

    var body: some View {
        Button {
            copy()
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.tickDuration) { copied = false }
        } label: {
            if copied {
                Image(systemName: "checkmark").foregroundStyle(.green)
            } else {
                Image(systemName: "doc.on.doc")
            }
        }
        .buttonStyle(RanchIconButtonStyle(size: 24))
        .help(copied ? "Copied" : "Copy Link")
        .accessibilityLabel(copied ? "Copied" : "Copy Link")
    }
}

// MARK: Needs review

struct RanchReviewList: View {
    @ObservedObject var store: RanchStore
    @State private var selection: String?

    private static let sections: [(kind: String, title: String, symbol: String)] = [
        ("directory", "Directories", "folder.badge.questionmark"),
        ("changed", "Linked values changed", "arrow.triangle.2.circlepath"),
        ("missing", "Linked sources missing", "questionmark.folder"),
        ("unverified", "Links to verify", "checkmark.shield"),
        ("drifted", "Changed since you shared them", "link.badge.plus"),
        ("unreadable", "Couldn\u{2019}t be fully read", "doc.badge.ellipsis"),
    ]

    var body: some View {
        let items = store.overview.review
        VStack(spacing: 0) {
            RanchColumnHeader(title: "Needs Review",
                              subtitle: items.isEmpty ? "Everything looks fine"
                                  : "\(items.count) source\(items.count == 1 ? "" : "s") with a possible problem")
            if items.isEmpty && store.hasLoaded {
                RanchEmptyState(symbol: "checkmark.seal", title: "Nothing Needs Review",
                                message: "Changed links, missing sources and files Lasso couldn\u{2019}t fully read show up here.")
            } else {
                RanchCardList(selection: $selection,
                              order: { Self.sections.flatMap { section in items.filter { $0.kind == section.kind }.map(\.id) } }) {
                    ForEach(Self.sections, id: \.kind) { section in
                        let matching = items.filter { $0.kind == section.kind }
                        if !matching.isEmpty {
                            Section {
                                ForEach(matching) { item in
                                    RanchCard(id: item.id, selection: $selection) {
                                        RanchReviewRow(item: item, symbol: section.symbol,
                                                       directory: store.directoryName(item.directoryId))
                                    }
                                }
                            } header: {
                                RanchSectionHeader(title: section.title) { RanchCount(value: matching.count) }
                            }
                        }
                    }
                }
            }
        }
        // The file opens at the place the item is about, with ways to resolve it.
        .onChange(of: selection) { id in
            let item = items.first { $0.id == id }
            store.selectedSourceID = item?.fileId
            store.reviewFocus = item
        }
    }
}

struct RanchReviewRow: View {
    let item: RanchReviewItem
    let symbol: String
    let directory: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RanchRowBadge(symbol: symbol, tint: RanchTheme.warning)
            VStack(alignment: .leading, spacing: 3) {
                RanchRowText(title: item.path.map { ($0 as NSString).lastPathComponent } ?? directory,
                             caption: item.detail, captionLines: 3)
                if let change = item.valueChangeLine {
                    Text(change).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
                        .lineLimit(1).truncationMode(.tail).monospacedDigit()
                }
                if !item.documents.isEmpty {
                    Text("In " + item.documents.map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))
                        .font(RanchTheme.captionFont).foregroundStyle(RanchTheme.tertiaryInk).lineLimit(1).truncationMode(.tail)
                }
            }
        }
    }
}
