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
        .overlay {
            if !store.hasLoaded {
                if let error = store.loadError {
                    RanchEmptyState(symbol: "exclamationmark.icloud", title: "The Library Isn\u{2019}t Available", message: error)
                } else {
                    ProgressView("Gathering your sources\u{2026}").frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }
}

extension View {
    /// The column's name and a line about it, in the window's toolbar as Mail and Finder show theirs.
    func ranchColumn(_ title: String, _ subtitle: String) -> some View {
        navigationTitle(title).navigationSubtitle(subtitle)
    }
}

/// The kind filter and file order, as toolbar menus above a list of files.
struct RanchFileMenus: View {
    @ObservedObject var store: RanchStore

    var body: some View {
        Menu {
            Picker("Show", selection: $store.kindFilter) {
                ForEach(RanchKindFilter.allCases) { Label($0.title, systemImage: $0.symbol).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            Label("Show", systemImage: store.kindFilter == .all ? "line.3.horizontal.decrease.circle"
                  : "line.3.horizontal.decrease.circle.fill")
        }
        .help("Show: \(store.kindFilter.title)")
        Menu {
            Picker("Sort Files By", selection: $store.itemOrder) {
                ForEach(RanchOrder.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            Label("Sort Files By", systemImage: "arrow.up.arrow.down")
        }
        .help("Sort Files By: \(store.itemOrder.title)")
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
            if store.overview.truncated {
                Text("Your library is very large; The Ranch lists the first \(store.overview.sources.count.formatted()) files.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 6)
            }
            if total == 0 && store.hasLoaded {
                RanchEmptyState(symbol: emptySymbol, title: emptyTitle, message: emptyMessage)
            } else {
                List(selection: $store.selectedSourceID) {
                    ForEach(groups, id: \.0.id) { directory, sources in
                        if directoryId == nil {
                            if !sources.isEmpty {
                                Section {
                                    rows(sources, flagged: flagged)
                                } header: {
                                    Label(directory.name, systemImage: directory.sidebarSymbol)
                                }
                            }
                        } else {
                            rows(sources, flagged: flagged)
                        }
                    }
                }
                .listStyle(.inset)
                // Double-clicking opens the file in the app that edits it, as in Finder.
                .contextMenu(forSelectionType: String.self) { ids in
                    if let id = ids.first, let source = store.source(id) { RanchSourceMenu(store: store, source: source) }
                } primaryAction: { ids in
                    guard let id = ids.first, let source = store.source(id), let url = store.localURL(for: source) else { return }
                    RanchEditors.primary(for: url)?.open(url)
                }
            }
        }
        .ranchColumn(directoryId.flatMap { store.directory($0)?.name } ?? "All Sources",
                     subtitle(directories: directories, total: total))
        .toolbar { ToolbarItemGroup { RanchFileMenus(store: store) } }
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
            RanchSourceRow(source: source, url: nil, order: store.itemOrder, flagged: flagged.contains(source.id))
                .tag(source.id)
                // Drag a file out to Mail, Finder or any app that takes files.
                .onDrag { store.localURL(for: source).flatMap { NSItemProvider(contentsOf: $0) } ?? NSItemProvider() }
        }
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
        HStack(spacing: 9) {
            RanchFileIcon(url: url, fileExtension: source.fileExtension, size: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(source.name).lineLimit(1).truncationMode(.middle)
                Text(caption).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 4)
            if flagged {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).imageScale(.small)
                    .help("Needs review")
            }
            if source.activeShares > 0 {
                Image(systemName: "link").foregroundStyle(.secondary).imageScale(.small)
                    .help(source.activeShares == 1 ? "Shared with a working link" : "Shared with \(source.activeShares) working links")
            }
            if source.activity > 0 { RanchActivityDot(activity: source.activity) }
        }
        .padding(.vertical, 2)
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
        VStack(spacing: 0) {
            if entries.isEmpty && store.hasLoaded {
                RanchEmptyState(symbol: "clock", title: "No Changes",
                                message: "Edits, new files and removals from the last two weeks appear here.")
            } else {
                List(selection: $selection) {
                    ForEach(days.keys.sorted(by: >), id: \.self) { day in
                        Section(RanchFormat.dayTitle(day)) {
                            ForEach(days[day] ?? []) { entry in
                                RanchChangeRow(entry: entry, directory: store.directoryName(entry.directoryId)).tag(entry.id)
                            }
                        }
                    }
                }
                .listStyle(.inset)
                if store.overview.historyTruncated {
                    Text("Only the latest changes are listed. Every file keeps its full history in Lasso.")
                        .font(.caption).foregroundStyle(.secondary).padding(8)
                }
            }
        }
        .ranchColumn("Recent Changes", "Last 2 weeks \u{00B7} \(entries.count) change\(entries.count == 1 ? "" : "s")")
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

struct RanchChangeRow: View {
    let entry: RanchHistoryEntry
    let directory: String

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: symbol).foregroundStyle(tint).frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).lineLimit(1).truncationMode(.middle)
                Text(caption).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 4)
            Text(RanchFormat.clock(entry.at)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }
        .padding(.vertical, 2)
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
        default: return "\(entry.change.capitalized) \u{00B7} \(directory)"
        }
    }

    private var symbol: String {
        switch entry.change {
        case "added": return "plus.circle"
        case "removed": return "minus.circle"
        case "renamed", "moved": return "arrow.right.circle"
        case "directory-added": return "folder.badge.plus"
        case "many": return "doc.on.doc"
        default: return "pencil.circle"
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
            Picker("Links", selection: $store.linkTab) {
                ForEach(RanchStore.LinkTab.allCases) { tab in
                    Text(tabTitle(tab, links)).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()
            if store.linkTab == .outgoing {
                outgoing(links.outgoing)
            } else {
                received(links.received)
            }
        }
        .ranchColumn("Links", "\(store.activeLinkCount) active \u{00B7} \(links.received.count) received")
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
            List(selection: $selection) {
                ForEach(links) { link in
                    RanchOutgoingRow(link: link, directory: store.directoryName(link.directoryId),
                                     copy: { store.copy(link.url) }, stop: { store.stopSharing(link) })
                        .tag(link.id)
                        .contextMenu {
                            Button("Copy Link") { store.copy(link.url) }
                            if link.status == "active" { Button("Stop Sharing") { store.stopSharing(link) } }
                        }
                }
            }
            .listStyle(.inset)
        }
    }

    @ViewBuilder
    private func received(_ links: [RanchReceivedLink]) -> some View {
        if links.isEmpty {
            RanchEmptyState(symbol: "tray.and.arrow.down", title: "No Received Links",
                            message: "Share links people send you appear here when they arrive in an indexed folder, a note, or mail from a connected app.")
        } else {
            List(selection: $selection) {
                ForEach(links) { link in
                    RanchReceivedRow(link: link, directory: store.directoryName(link.directoryId), copy: { store.copy(link.url) })
                        .tag(link.id)
                        .contextMenu {
                            Button("Copy Link") { store.copy(link.url) }
                            if let url = URL(string: link.url) { Button("Open Link") { NSWorkspace.shared.open(url) } }
                        }
                }
            }
            .listStyle(.inset)
        }
    }
}

struct RanchOutgoingRow: View {
    let link: RanchOutgoingLink
    let directory: String
    let copy: () -> Void
    let stop: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            RanchFileIcon(url: nil, fileExtension: ((link.path ?? "") as NSString).pathExtension, size: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(link.name ?? link.path ?? "Shared source").lineLimit(1).truncationMode(.middle)
                Text(caption).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 4)
            Text(statusTitle).font(.caption.weight(.medium))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Capsule().fill(statusColor.opacity(0.15)))
                .foregroundStyle(statusColor)
            Button(action: copy) { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless).help("Copy Link")
            if link.status == "active" {
                Button(action: stop) { Image(systemName: "xmark.circle") }.buttonStyle(.borderless).help("Stop Sharing")
            }
        }
        .padding(.vertical, 2)
    }

    private var caption: String {
        let scope = ["INDEXED": "Cited part", "REDACTED": "Redacted"][link.scope] ?? "Whole document"
        return [link.locator, scope, directory].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    private var statusTitle: String {
        switch link.status {
        case "active": return link.expiresAt.map { "Expires \(RanchFormat.ago($0))" } ?? "Active"
        case "expired": return "Expired"
        default: return "Stopped"
        }
    }

    private var statusColor: Color { link.status == "active" ? (link.drifted ? .orange : .green) : .secondary }
}

struct RanchReceivedRow: View {
    let link: RanchReceivedLink
    let directory: String
    let copy: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "tray.and.arrow.down").foregroundStyle(Color.accentColor).frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(URL(string: link.url)?.host ?? link.url).lineLimit(1)
                Text("In \((link.path as NSString).lastPathComponent) \u{00B7} \(directory) \u{00B7} \(RanchFormat.ago(link.receivedAt))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 4)
            Button(action: copy) { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless).help("Copy Link")
        }
        .padding(.vertical, 2)
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
            if items.isEmpty && store.hasLoaded {
                RanchEmptyState(symbol: "checkmark.seal", title: "Nothing Needs Review",
                                message: "Changed links, missing sources and files Lasso couldn\u{2019}t fully read show up here.")
            } else {
                List(selection: $selection) {
                    ForEach(Self.sections, id: \.kind) { section in
                        let matching = items.filter { $0.kind == section.kind }
                        if !matching.isEmpty {
                            Section(section.title) {
                                ForEach(matching) { item in
                                    RanchReviewRow(item: item, symbol: section.symbol,
                                                   directory: store.directoryName(item.directoryId)).tag(item.id)
                                }
                            }
                        }
                    }
                }
                .listStyle(.inset)
            }
        }
        .ranchColumn("Needs Review",
                     items.isEmpty ? "Everything looks fine" : "\(items.count) source\(items.count == 1 ? "" : "s") with a possible problem")
        .onChange(of: selection) { id in
            store.selectedSourceID = items.first { $0.id == id }?.fileId
        }
    }
}

struct RanchReviewRow: View {
    let item: RanchReviewItem
    let symbol: String
    let directory: String

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: symbol).foregroundStyle(.orange).frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.path.map { ($0 as NSString).lastPathComponent } ?? directory).lineLimit(1).truncationMode(.middle)
                Text(item.detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                if !item.documents.isEmpty {
                    Text("In " + item.documents.map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))
                        .font(.caption).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.tail)
                }
            }
        }
        .padding(.vertical, 3)
    }
}
