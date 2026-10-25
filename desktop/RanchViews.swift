// The Ranch window: a sidebar of library views and directories, a list of
// what the chosen view holds, and the selected file on the right.

import Cocoa
import SwiftUI
import UniformTypeIdentifiers

/// What the window asks the rest of Lasso to do.
struct RanchActions {
    /// Opens the share composer for a file; the rect is where it was asked from, in screen coordinates.
    let createShareLink: (RanchShareTarget, NSRect) -> Void
    let addDirectories: () -> Void
}

enum RanchFormat {
    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEEEMMMMd")
        return formatter
    }()

    private static let medium: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    static func ago(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "Unknown" }
        return abs(now.timeIntervalSince(date)) < 60 ? "just now" : relative.localizedString(for: date, relativeTo: now)
    }

    static func clock(_ date: Date?) -> String { date.map(time.string(from:)) ?? "" }
    static func full(_ date: Date?) -> String { date.map(medium.string(from:)) ?? "Unknown" }

    /// "Today", "Yesterday", or "Monday, October 19".
    static func dayTitle(_ date: Date, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return day.string(from: date)
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

extension RanchDirectory {
    var color: Color { Color(nsColor: DirectoryColorPreferences.color(for: id)?.color ?? .controlAccentColor) }

    /// The connected app's own symbol, a drive while it is disconnected, or a folder.
    var sidebarSymbol: String {
        if isApp, let symbol, NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil { return symbol }
        if isApp { return "app" }
        return offline ? "externaldrive" : "folder"
    }
}

/// The Finder's own icon for a file, or the one for its type. Lists use the
/// type's, kept once per extension, so a long list never reads the disk to draw.
/// Types macOS draws as plain white pages get Lasso's own (`RanchTypeIcon`).
struct RanchFileIcon: View {
    let url: URL?
    let fileExtension: String
    var size: CGFloat = 16

    private static var typeIcons: [String: NSImage] = [:]

    var body: some View {
        Image(nsImage: icon).resizable().interpolation(.high).frame(width: size, height: size)
    }

    private var icon: NSImage {
        if let drawn = RanchTypeIcon.image(for: fileExtension, size: size) { return drawn }
        if let url, FileManager.default.fileExists(atPath: url.path) { return NSWorkspace.shared.icon(forFile: url.path) }
        return Self.typeIcon(fileExtension)
    }

    static func typeIcon(_ fileExtension: String) -> NSImage {
        let key = fileExtension.lowercased()
        if let cached = typeIcons[key] { return cached }
        let icon = UTType(filenameExtension: key).map(NSWorkspace.shared.icon(for:)) ?? NSWorkspace.shared.icon(for: .data)
        typeIcons[key] = icon
        return icon
    }
}

/// A dot in the network's grey-to-green, for how much a file is used.
struct RanchActivityDot: View {
    let activity: Double
    var body: some View {
        Circle().fill(Color(nsColor: RanchActivityColor.color(for: activity))).frame(width: 7, height: 7)
            .help(activity > 0 ? "Used \(Int((activity * 100).rounded()))% as much as your busiest file" : "Not used yet")
    }
}

/// An empty pane: a quiet symbol, what is missing, and how to fill it.
struct RanchEmptyState: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 19))
                .foregroundStyle(RanchTheme.secondaryInk)
                .frame(width: 48, height: 48)
                .background(Circle().fill(RanchTheme.card))
            Text(title).font(RanchTheme.titleFont).foregroundStyle(RanchTheme.ink).multilineTextAlignment(.center)
            Text(message).font(.system(size: 12)).foregroundStyle(RanchTheme.secondaryInk)
                .multilineTextAlignment(.center).frame(maxWidth: 300)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct RanchRootView: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions
    @FocusState private var searchFocused: Bool
    @AppStorage("RanchSidebarWidth") private var sidebarWidth = 260.0
    @AppStorage("RanchListWidth") private var listWidth = 360.0
    private static let shortcuts: [RanchStore.Section] = [.changes, .sources, .links, .review, .network]
    private static let sidebarWidths = 200.0...380.0
    private static let listMinimum = 280.0
    private static let listMaximum = 700.0
    /// The file column keeps at least this much when the list is widened.
    private static let detailMinimum = 300.0

    var body: some View {
        GeometryReader { geometry in
            let listRoom = listRoom(in: geometry.size.width)
            HStack(spacing: 0) {
                if !store.sidebarHidden {
                    RanchSidebar(store: store, actions: actions, search: $searchFocused, hide: toggleSidebar)
                        .frame(width: sidebarWidth)
                        .transition(.move(edge: .leading))
                    RanchColumnDivider(width: $sidebarWidth, range: Self.sidebarWidths)
                }
                // The network needs room, so it takes the whole width and shows
                // the chosen file beside it instead of in a third column.
                if store.section == .network {
                    RanchNetworkPane(store: store, actions: actions)
                        .environment(\.ranchShowSidebar, showSidebar)
                } else {
                    RanchContent(store: store)
                        .environment(\.ranchShowSidebar, showSidebar)
                        .frame(width: min(listWidth, listRoom))
                    RanchColumnDivider(width: $listWidth, range: Self.listMinimum...listRoom)
                    RanchDetail(store: store, actions: actions)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        // The columns run up under the window's buttons.
        .ignoresSafeArea(.container, edges: .top)
        .background(RanchTheme.surface)
        .frame(minWidth: 860, minHeight: 520)
        .background { shortcuts }
        .alert("Something Didn\u{2019}t Work", isPresented: Binding(get: { store.actionError != nil },
                                                                 set: { if !$0 { store.actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
    }

    /// How wide the list may be beside the sidebar, leaving the file its share.
    private func listRoom(in width: CGFloat) -> Double {
        let sidebar = store.sidebarHidden ? 0 : sidebarWidth + 1
        return max(Self.listMinimum, min(Self.listMaximum, Double(width) - sidebar - 1 - Self.detailMinimum))
    }

    private var showSidebar: (() -> Void)? { store.sidebarHidden ? toggleSidebar : nil }

    private func toggleSidebar() {
        withAnimation(.easeInOut(duration: 0.2)) { store.sidebarHidden.toggle() }
    }

    /// Command-F searches, unless code being read has the keyboard: its own
    /// find bar keeps Command-F, as in any text view.
    private func find() {
        if let text = NSApp.keyWindow?.firstResponder as? NSTextView, !text.isFieldEditor {
            let item = NSMenuItem()
            item.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
            text.performFindPanelAction(item)
            return
        }
        if store.sidebarHidden { toggleSidebar() }
        searchFocused = true
    }

    /// Command-1 to Command-5 go to the library views, as Mail's do to its
    /// mailboxes; Control-Command-S hides the sidebar, as in Finder and Mail.
    private var shortcuts: some View {
        ZStack {
            ForEach(Array(Self.shortcuts.enumerated()), id: \.offset) { index, section in
                RanchHiddenShortcut(key: KeyEquivalent(Character("\(index + 1)"))) { store.section = section }
            }
            RanchHiddenShortcut(key: "s", modifiers: [.command, .control], action: toggleSidebar)
            RanchHiddenShortcut(key: "f", action: find)
        }
    }
}

/// A keyboard shortcut with no button of its own on screen.
struct RanchHiddenShortcut: View {
    let key: KeyEquivalent
    var modifiers: EventModifiers = .command
    let action: () -> Void

    var body: some View {
        Button("", action: action)
            .keyboardShortcut(key, modifiers: modifiers)
            .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }
}

/// What the sidebar chooses: a library view or directory, a folder to open, or a file.
enum RanchSidebarItem: Hashable {
    case section(RanchStore.Section)
    case folder(String)
    case file(String)
}

/// A directory in the sidebar and what its outline shows.
private struct RanchBranch {
    let directory: RanchDirectory
    let tree: RanchTree
    let open: Bool
    let rows: [RanchTree.Row]

    var files: [String] {
        rows.compactMap { row in
            if case .file(let source, _) = row { return source.id }
            return nil
        }
    }
}

struct RanchSidebar: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions
    var search: FocusState<Bool>.Binding
    let hide: () -> Void
    /// Each level of the outline sits this much further in.
    private static let indent: CGFloat = 16

    var body: some View {
        let branches = store.orderedDirectories.map(branch)
        let shown = Set(branches.flatMap(\.files))
        // A file open in the outline is the one thing chosen; the view it is in turns grey.
        let fileShown = store.selectedSourceID.map(shown.contains) ?? false
        let selection = selection(fileShown: fileShown)
        VStack(spacing: 0) {
            // The window's own buttons sit on the left of this strip.
            HStack {
                Spacer()
                Button(action: hide) { Image(systemName: "sidebar.left") }
                    .buttonStyle(RanchIconButtonStyle(size: 26))
                    .help("Hide Sidebar (\u{2303}\u{2318}S)")
            }
            .padding(.horizontal, 8)
            .frame(height: RanchTheme.titlebarHeight)
            .background(RanchWindowDragArea())
            HStack(spacing: 9) {
                Image(nsImage: NSApp.applicationIconImage).resizable().interpolation(.high).frame(width: 26, height: 26)
                Text(Ranch.title).font(RanchTheme.brandFont).foregroundStyle(RanchTheme.ink)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .padding(.bottom, 12)
            .background(RanchWindowDragArea())
            RanchSearchField(text: $store.searchText, focused: search, prompt: "Search files")
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
            RanchCardList(selection: selection, order: { order(branches) }, pinnedHeaders: false, spacing: 1,
                          sideways: { sideways($0, from: selection.wrappedValue) }) {
                library(selection, quiet: fileShown)
                Section {
                    ForEach(branches.filter { !$0.directory.isApp }, id: \.directory.id) { branch in
                        outline(branch, selection: selection, quiet: fileShown)
                    }
                    if store.folders.isEmpty && store.hasLoaded {
                        Text("No work directories yet.").font(RanchTheme.captionFont)
                            .foregroundStyle(RanchTheme.tertiaryInk).padding(.horizontal, 20).padding(.vertical, 4)
                    }
                } header: {
                    RanchSectionHeader(title: "Directories", background: RanchTheme.sidebar) {
                        RanchOrderMenu(title: "Sort Directories By", order: $store.directoryOrder)
                    }
                }
                if !store.apps.isEmpty {
                    Section {
                        ForEach(branches.filter(\.directory.isApp), id: \.directory.id) { branch in
                            outline(branch, selection: selection, quiet: fileShown)
                        }
                    } header: {
                        RanchSectionHeader(title: "Connected Apps", background: RanchTheme.sidebar)
                    }
                }
            }
            footer
        }
        .background(RanchTheme.sidebar)
    }

    private func library(_ selection: Binding<RanchSidebarItem?>, quiet: Bool) -> some View {
        Section {
            row(.changes, selection, quiet: quiet) {
                RanchSidebarRow(title: "Recent Changes", symbol: "clock.arrow.circlepath", count: store.overview.history.count)
            }
            row(.sources, selection, quiet: quiet) {
                RanchSidebarRow(title: "All Sources", symbol: "square.stack.3d.up", count: store.overview.sources.count)
            }
            row(.links, selection, quiet: quiet) {
                RanchSidebarRow(title: "Links", symbol: "link",
                                count: store.activeLinkCount + store.overview.links.received.count)
            }
            row(.review, selection, quiet: quiet) {
                RanchSidebarRow(title: "Needs Review", symbol: "exclamationmark.triangle",
                                tint: store.reviewCount > 0 ? RanchTheme.warning : RanchTheme.secondaryInk,
                                count: store.reviewCount, countTint: store.reviewCount > 0 ? RanchTheme.warning : nil)
            }
            row(.network, selection, quiet: quiet) {
                RanchSidebarRow(title: "Network", symbol: "point.3.connected.trianglepath.dotted")
            }
        } header: {
            RanchSectionHeader(title: "Library", background: RanchTheme.sidebar)
        }
    }

    private func row<Content: View>(_ section: RanchStore.Section, _ selection: Binding<RanchSidebarItem?>, quiet: Bool,
                                    @ViewBuilder _ content: () -> Content) -> some View {
        RanchCard(id: .section(section), selection: selection, style: .sidebar,
                  highlighted: store.section == section, quiet: quiet) { content() }
    }

    // MARK: Outline

    private func branch(_ directory: RanchDirectory) -> RanchBranch {
        let tree = store.tree(in: directory.id)
        let open = !tree.isEmpty && store.isOpen(RanchTree.key(directory: directory.id))
        let rows = open ? tree.rows { store.isOpen(RanchTree.key(directory: directory.id, folder: $0)) } : []
        return RanchBranch(directory: directory, tree: tree, open: open, rows: rows)
    }

    /// A directory's row, and below it, while it is open, its folders and files.
    @ViewBuilder
    private func outline(_ branch: RanchBranch, selection: Binding<RanchSidebarItem?>, quiet: Bool) -> some View {
        let directory = branch.directory
        let key = RanchTree.key(directory: directory.id)
        RanchCard(id: .section(.directory(directory.id)), selection: selection, style: .sidebar,
                  highlighted: store.section == .directory(directory.id), quiet: quiet,
                  open: branch.tree.isEmpty ? nil : { toggle(key) }) {
            HStack(spacing: 4) {
                RanchDisclosure(open: branch.open, hidden: branch.tree.isEmpty || !store.canToggleFolders) { toggle(key) }
                RanchDirectoryRow(directory: directory)
            }
        }
        .accessibilityAction(named: branch.open ? "Collapse" : "Expand") { toggle(key) }
        ForEach(branch.rows) { row in
            outlineRow(row, in: directory, selection: selection)
        }
    }

    @ViewBuilder
    private func outlineRow(_ row: RanchTree.Row, in directory: RanchDirectory, selection: Binding<RanchSidebarItem?>) -> some View {
        switch row {
        case .folder(let path, let name, let depth):
            let key = RanchTree.key(directory: directory.id, folder: path)
            let open = store.isOpen(key)
            // Clicking a folder opens or closes it.
            RanchCard(id: .folder(key), selection: selection, style: .sidebar, highlighted: false) {
                HStack(spacing: 4) {
                    RanchDisclosure(open: open, hidden: !store.canToggleFolders) { toggle(key) }
                    HStack(spacing: 9) {
                        Image(systemName: "folder").font(.system(size: 12.5)).foregroundStyle(RanchTheme.secondaryInk)
                            .frame(width: 18)
                        Text(name).font(RanchTheme.bodyFont).foregroundStyle(RanchTheme.ink).lineLimit(1).truncationMode(.middle)
                    }
                }
                .padding(.leading, CGFloat(depth) * Self.indent)
            }
            .help(path)
            .accessibilityAction(named: open ? "Collapse" : "Expand") { toggle(key) }
        case .file(let source, let depth):
            RanchCard(id: .file(source.id), selection: selection, style: .sidebar,
                      highlighted: store.selectedSourceID == source.id, open: { edit(source) }) {
                HStack(spacing: 9) {
                    RanchFileIcon(url: nil, fileExtension: source.fileExtension, size: 16).frame(width: 18)
                    Text(source.name).font(RanchTheme.bodyFont).foregroundStyle(RanchTheme.ink).lineLimit(1).truncationMode(.middle)
                }
                // Clear of the disclosure arrows beside its folders.
                .padding(.leading, CGFloat(depth) * Self.indent + RanchDisclosure.width + 4)
            }
            .help(source.path)
            .contextMenu { RanchSourceMenu(store: store, source: source) }
            .onDrag { store.localURL(for: source).flatMap { NSItemProvider(contentsOf: $0) } ?? NSItemProvider() }
        }
    }

    /// Clicking or moving to a library view or directory shows it; a file opens
    /// beside the list; a folder opens or closes.
    private func selection(fileShown: Bool) -> Binding<RanchSidebarItem?> {
        Binding(get: {
            if fileShown, let id = store.selectedSourceID { return .file(id) }
            return store.section.map(RanchSidebarItem.section)
        }, set: { item in
            switch item {
            case .section(let section)?: store.section = section
            case .file(let id)?: store.showFromOutline(id)
            case .folder(let key)?: toggle(key)
            case nil: break
            }
        })
    }

    /// The rows ↑ and ↓ move through: views, directories and the files open
    /// under them. Folders are opened and closed, not chosen.
    private func order(_ branches: [RanchBranch]) -> [RanchSidebarItem] {
        [RanchStore.Section.changes, .sources, .links, .review, .network].map(RanchSidebarItem.section)
            + branches.flatMap { branch in
                [RanchSidebarItem.section(.directory(branch.directory.id))] + branch.files.map(RanchSidebarItem.file)
            }
    }

    /// → opens the chosen directory and ← closes it, as in Finder's list; ← on a
    /// file closes the folder it is in.
    private func sideways(_ direction: MoveCommandDirection, from item: RanchSidebarItem?) {
        guard store.canToggleFolders else { return }
        switch item {
        case .section(.directory(let id))?:
            let key = RanchTree.key(directory: id)
            if (direction == .right) != store.openFolders.contains(key) { toggle(key) }
        case .file(let id)? where direction == .left:
            store.closeFolder(around: id)
        default:
            break
        }
    }

    private func toggle(_ key: String) {
        guard store.canToggleFolders else { return }
        store.toggleFolder(key)
    }

    private func edit(_ source: RanchSource) {
        guard let url = store.localURL(for: source) else { return }
        RanchEditors.primary(for: url)?.open(url)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: actions.addDirectories) {
                Label("Add Work Directories\u{2026}", systemImage: "plus").frame(maxWidth: .infinity)
            }
            .buttonStyle(RanchPillButtonStyle(prominent: true, height: 32))
            .help("Choose folders for Lasso to read; their files appear here")
            HStack(spacing: 7) {
                Circle().fill(status.color).frame(width: 7, height: 7)
                Text(status.text).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
                    .lineLimit(1).truncationMode(.tail)
            }
            .padding(.horizontal, 4)
            .help(store.loadError ?? "The Ranch reads Lasso\u{2019}s library again every few seconds while it is open.")
        }
        .padding(12)
        .overlay(alignment: .top) { RanchHairline() }
    }

    /// Whether the window is showing the library as it is now.
    private var status: (text: String, color: Color) {
        if store.loadError != nil {
            return store.hasLoaded ? ("Couldn\u{2019}t refresh \u{00B7} showing the last copy", RanchTheme.warning)
                : ("Waiting for Lasso\u{2019}s library", RanchTheme.warning)
        }
        if !store.hasLoaded { return ("Reading your library\u{2026}", RanchTheme.tertiaryInk) }
        return ("Up to date", Color(nsColor: RanchActivityColor.color(for: 1)))
    }
}

/// The arrow that opens and closes a directory or folder in the outline.
struct RanchDisclosure: View {
    static let width: CGFloat = 12
    let open: Bool
    /// Kept in place, unseen, so rows with and without one line up.
    var hidden = false
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(RanchTheme.tertiaryInk)
                .rotationEffect(.degrees(open ? 90 : 0))
                .animation(.easeOut(duration: 0.15), value: open)
                .frame(width: Self.width, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(hidden ? 0 : 1)
        .disabled(hidden)
        .accessibilityHidden(true)
    }
}

/// A library view in the sidebar: its symbol, its name and how many it holds.
struct RanchSidebarRow: View {
    let title: String
    let symbol: String
    var tint = RanchTheme.secondaryInk
    var count = 0
    var countTint: Color? = nil

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(tint).frame(width: 18)
            Text(title).font(RanchTheme.bodyFont).foregroundStyle(RanchTheme.ink).lineLimit(1)
            Spacer(minLength: 4)
            RanchCount(value: count, tint: countTint)
        }
    }
}

/// Last Edited, Recently Used, Oldest or Newest, from a small menu.
struct RanchOrderMenu: View {
    let title: String
    @Binding var order: RanchOrder

    var body: some View {
        Menu {
            Picker(title, selection: $order) {
                ForEach(RanchOrder.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 3) {
                Text(order.title)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
            .font(.system(size: 11.5))
            .foregroundStyle(RanchTheme.secondaryInk)
            .contentShape(Rectangle())
        }
        .modifier(RanchPlainMenuStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help(title)
    }
}

struct RanchDirectoryRow: View {
    let directory: RanchDirectory

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: directory.sidebarSymbol).font(.system(size: 13)).foregroundStyle(directory.color).frame(width: 18)
            Text(directory.name).font(RanchTheme.bodyFont).foregroundStyle(RanchTheme.ink).lineLimit(1)
            if !directory.active {
                Text("Paused").font(RanchTheme.captionFont).foregroundStyle(RanchTheme.tertiaryInk)
            } else if directory.offline {
                Text("Offline").font(RanchTheme.captionFont).foregroundStyle(RanchTheme.tertiaryInk)
            }
            Spacer(minLength: 4)
            if let issue = directory.issue {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(RanchTheme.warning).help(issue)
            }
            RanchCount(value: directory.listedCount)
        }
        .help(directory.rootPath)
    }
}
