// The Ranch's sidebar, part of the window rather than a pane of its own: it
// sits straight on the window's material. Search, the library's views, the directories and connected
// apps as a file tree (RanchTreeRow.swift), and at the foot whether the
// library is up to date and Settings.

import Cocoa
import SwiftUI

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
    /// The row the pointer is on, for the pill that glides between rows.
    @StateObject private var hover = RanchTreeHover()
    @Namespace private var treeSpace
    /// When a folder last opened or closed, so the rows it shows drop into place.
    @State private var turned = Date.distantPast

    var body: some View {
        let branches = store.orderedDirectories.map(branch)
        let shown = Set(branches.flatMap(\.files))
        // A file open in the outline is the one thing chosen; the view it is in turns grey.
        let fileShown = store.selectedSourceID.map(shown.contains) ?? false
        let selection = selection(fileShown: fileShown)
        VStack(spacing: 0) {
            // The window's own buttons, and the one that hides the sidebar, sit in this strip.
            Color.clear.frame(height: RanchTheme.titlebarHeight).background(RanchWindowDragArea())
            // No space between rows, so each folder's guide line runs unbroken.
            RanchCardList(selection: selection, order: { order(branches) }, pinnedHeaders: false, spacing: 0,
                          sideways: { sideways($0, from: selection.wrappedValue) }) {
                searchRow
                library(selection, quiet: fileShown)
                RanchSidebarRule()
                Section {
                    ForEach(branches.filter { !$0.directory.isApp }, id: \.directory.id) { branch in
                        outline(branch, selection: selection, fileShown: fileShown)
                    }
                    if store.folders.isEmpty && store.hasLoaded {
                        Text("No work directories yet.").font(RanchTheme.captionFont)
                            .foregroundStyle(RanchTheme.tertiaryInk).padding(.horizontal, 20).padding(.vertical, 4)
                    }
                } header: {
                    RanchSidebarHeading(title: "Directories") {
                        RanchOrderMenu(title: "Sort Directories By", order: $store.directoryOrder)
                    }
                }
                if !store.apps.isEmpty {
                    Section {
                        ForEach(branches.filter(\.directory.isApp), id: \.directory.id) { branch in
                            outline(branch, selection: selection, fileShown: fileShown)
                        }
                    } header: {
                        RanchSidebarHeading(title: "Connected apps") { EmptyView() }
                    }
                }
            }
            footer
        }
        .environment(\.ranchTree, RanchTreeContext(hover: hover, space: treeSpace))
    }

    private var showsSources: Bool {
        switch store.section ?? .sources {
        case .sources, .directory: return true
        default: return false
        }
    }

    /// Search, as a row: on the sources pages it goes to the page's own field;
    /// elsewhere the row is the field.
    @ViewBuilder private var searchRow: some View {
        if showsSources {
            RanchTreeRow(id: "search", title: "Search", chevron: false, click: { _ in store.searchRequest += 1 }) { lit in
                RanchLucideIcon(icon: .search, color: lit ? RanchTheme.ink : RanchTreeStyle.restInk)
            } trailing: {
                EmptyView()
            }
        } else {
            HStack(spacing: RanchTreeStyle.gap) {
                RanchLucideIcon(icon: .search, color: RanchTreeStyle.restInk)
                    .padding(.trailing, 2)
                TextField("", text: $store.searchText, prompt: Text("Search").foregroundColor(RanchTreeStyle.restInk))
                    .textFieldStyle(.plain)
                    .font(RanchLook.font(13.5))
                    .foregroundStyle(RanchTheme.ink)
                    .focused(search)
                    .onExitCommand { store.searchText = ""; search.wrappedValue = false }
                if !store.searchText.isEmpty {
                    Button { store.searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(RanchTheme.tertiaryInk)
                    }
                    .buttonStyle(.plain)
                    .help("Clear the search")
                }
            }
            .padding(.horizontal, RanchTreeStyle.lead)
            .frame(height: RanchTreeStyle.rowHeight)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(search.wrappedValue ? RanchTreeStyle.quietFill : .clear))
            .padding(.horizontal, 10)
        }
    }

    private func library(_ selection: Binding<RanchSidebarItem?>, quiet: Bool) -> some View {
        Section {
            view(.sources, "Sources", icon: .layers, selection, quiet: quiet) {
                RanchSidebarCount(value: store.overview.sources.count)
            }
            view(.changes, "Recent Changes", icon: .history, selection, quiet: quiet) {
                RanchSidebarCount(value: store.overview.history.count)
            }
            view(.reviews, "Review Changes", icon: .fileDiff, selection, quiet: quiet) {
                RanchReviewSidebarCount(model: store.reviews)
            }
            view(.links, "Links", icon: .link, selection, quiet: quiet) {
                RanchSidebarCount(value: store.activeLinkCount + store.overview.links.received.count)
            }
            view(.review, "Needs Review", icon: .triangleAlert, selection, quiet: quiet) {
                RanchSidebarCount(value: store.reviewCount, tint: store.reviewCount > 0 ? RanchTheme.warning : nil)
            }
            view(.network, "Network", icon: .network, selection, quiet: quiet) {
                EmptyView()
            }
        }
    }

    /// A library view: its symbol, its name and how many it holds.
    private func view<Trailing: View>(_ section: RanchStore.Section, _ title: String, icon: RanchLucide,
                                      _ selection: Binding<RanchSidebarItem?>, quiet: Bool, tint: Color? = nil,
                                      @ViewBuilder trailing: () -> Trailing) -> some View {
        RanchTreeRow(id: RanchSidebarItem.section(section), title: title, chevron: false, chosen: store.section == section,
                     quiet: quiet, click: { _ in choose(section) }) { lit in
            RanchLucideIcon(icon: icon, color: tint ?? (lit ? RanchTheme.ink : RanchTreeStyle.restInk))
        } trailing: {
            trailing()
        }
    }

    /// Shows a view or directory, and puts away a file chosen in the tree.
    private func choose(_ section: RanchStore.Section) {
        store.section = section
        store.selectedSourceID = nil
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
    private func outline(_ branch: RanchBranch, selection: Binding<RanchSidebarItem?>, fileShown: Bool) -> some View {
        let directory = branch.directory
        let key = RanchTree.key(directory: directory.id)
        let chosen = store.section == .directory(directory.id)
        RanchTreeRow(id: RanchSidebarItem.section(.directory(directory.id)), title: directory.name,
                     open: branch.tree.isEmpty ? nil : branch.open, chosen: chosen, quiet: chosen && fileShown,
                     click: { _ in
                         // A first click shows the directory and opens it; another closes it, as in the tree.
                         if chosen && !fileShown {
                             toggle(key)
                         } else {
                             choose(.directory(directory.id))
                             if !branch.open && !branch.tree.isEmpty { toggle(key) }
                         }
                     },
                     turn: store.canToggleFolders && !branch.tree.isEmpty ? { toggle(key) } : nil) { _ in
            if directory.isApp {
                Image(systemName: directory.sidebarSymbol).font(.system(size: 13.5)).foregroundStyle(directory.color)
            } else {
                RanchTreeFolderIcon(open: branch.open, tint: directory.color)
            }
        } trailing: {
            directoryNotes(directory)
        }
        .help(directory.rootPath)
        .contextMenu { RanchDirectoryMenu(store: store, directory: directory) }
        ForEach(Array(branch.rows.enumerated()), id: \.element.id) { index, row in
            outlineRow(row, in: directory, position: index)
        }
    }

    /// What is worth knowing about a directory at a glance, at the end of its row.
    private func directoryNotes(_ directory: RanchDirectory) -> some View {
        HStack(spacing: 6) {
            if store.isPinned(directory.id) {
                Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(RanchTheme.tertiaryInk)
                    .rotationEffect(.degrees(45)).help("Pinned to the top").accessibilityLabel("Pinned")
            }
            if !directory.active {
                Text("Paused").font(RanchTheme.captionFont).foregroundStyle(RanchTheme.tertiaryInk)
            } else if directory.offline {
                Text("Offline").font(RanchTheme.captionFont).foregroundStyle(RanchTheme.tertiaryInk)
            }
            if let issue = directory.issue {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(RanchTheme.warning).help(issue)
            }
            RanchSidebarCount(value: directory.listedCount)
        }
    }

    @ViewBuilder
    private func outlineRow(_ row: RanchTree.Row, in directory: RanchDirectory, position: Int) -> some View {
        switch row {
        case .folder(let path, let name, let depth):
            let key = RanchTree.key(directory: directory.id, folder: path)
            let open = store.isOpen(key)
            // Clicking a folder opens or closes it.
            RanchTreeRow(id: RanchSidebarItem.folder(key), title: name, depth: depth + 1, open: open,
                         entered: turned, position: position, click: { _ in toggle(key) },
                         turn: store.canToggleFolders ? { toggle(key) } : nil) { lit in
                RanchTreeFolderIcon(open: open, tint: lit ? RanchTheme.ink : RanchTheme.secondaryInk)
            } trailing: {
                EmptyView()
            }
            .help(path)
        case .file(let source, let depth):
            RanchTreeRow(id: RanchSidebarItem.file(source.id), title: source.name, depth: depth + 1,
                         chosen: store.selectedSourceID == source.id, entered: turned, position: position,
                         click: { double in
                             if double { edit(source) } else { store.showFromOutline(source.id) }
                         }) { _ in
                RanchFileIcon(url: nil, fileExtension: source.fileExtension, size: 16)
            } trailing: {
                EmptyView()
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
        [RanchStore.Section.sources, .changes, .reviews, .links, .review, .network].map(RanchSidebarItem.section)
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

    /// Opens or closes a folder: the rows below slide to make room, and those it shows drop in.
    private func toggle(_ key: String) {
        guard store.canToggleFolders else { return }
        turned = Date()
        withAnimation(RanchTreeStyle.layout) { store.toggleFolder(key) }
    }

    private func edit(_ source: RanchSource) {
        guard let url = store.localURL(for: source) else { return }
        RanchEditors.primary(for: url)?.open(url)
    }

    /// Whether the library is up to date, and Settings, in one row at the foot.
    private var footer: some View {
        HStack(spacing: 9) {
            Circle().fill(status.color).frame(width: 7, height: 7)
            Text(status.text).font(RanchLook.font(13)).foregroundStyle(RanchTreeStyle.restInk)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            Button(action: actions.openSettings) {
                RanchLucideIcon(icon: .settings, color: RanchTreeStyle.restInk)
            }
            .buttonStyle(RanchSidebarIconStyle())
            .help("Open Lasso\u{2019}s Settings")
            .accessibilityLabel("Settings")
        }
        .padding(.leading, 22)
        .padding(.trailing, 14)
        .frame(height: 46)
        .padding(.bottom, 6)
        .help(store.loadError ?? "The Ranch reads Lasso\u{2019}s library again every few seconds while it is open.")
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

/// A group's name in the sidebar, quiet, with a control on the right.
struct RanchSidebarHeading<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(RanchLook.font(12.5, .medium)).foregroundStyle(RanchTheme.tertiaryInk).lineLimit(1)
            Spacer(minLength: 4)
            trailing
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The thin line between the views and the directories.
struct RanchSidebarRule: View {
    var body: some View {
        Color.white.opacity(0.08).frame(height: 1)
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
    }
}

/// A count at the end of a sidebar row, in plain figures.
/// How many changed files wait in the folders' reviews.
struct RanchReviewSidebarCount: View {
    @ObservedObject var model: RanchReviewModel

    var body: some View { RanchSidebarCount(value: model.waiting) }
}

struct RanchSidebarCount: View {
    let value: Int
    var tint: Color? = nil

    var body: some View {
        if value > 0 {
            Text(value.formatted())
                .font(RanchLook.font(12.5, tint == nil ? .regular : .medium)).monospacedDigit()
                .foregroundStyle(tint ?? RanchTheme.tertiaryInk)
        }
    }
}

/// A small icon button in the sidebar, lit under the pointer.
struct RanchSidebarIconStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(hovering ? RanchTreeStyle.hoverFill : .clear))
                .opacity(configuration.isPressed ? 0.7 : 1)
                .contentShape(Rectangle())
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

/// A directory's right-click menu in the sidebar: pin it to the top, give it
/// a colour, which the menu bar panel and its sources share, or find it.
struct RanchDirectoryMenu: View {
    @ObservedObject var store: RanchStore
    let directory: RanchDirectory

    var body: some View {
        Button(store.isPinned(directory.id) ? "Unpin" : "Pin to Top") { store.togglePin(directory.id) }
        Menu("Colour") {
            Picker("Colour", selection: color) {
                ForEach(DirectoryToggleColor.choices(including: color.wrappedValue, DirectoryColorPreferences.lastCustom()),
                        id: \.self) { option in
                    Label { Text(option.title) } icon: { Image(nsImage: option.swatch()) }.tag(option)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        }
        if !directory.isApp && !directory.offline {
            Divider()
            Button("Show in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory.rootPath)])
            }
        }
    }

    private var color: Binding<DirectoryToggleColor> {
        Binding(get: { DirectoryColorPreferences.color(for: directory.id) ?? DirectoryColorPreferences.defaultColor() },
                set: { store.setColor($0, for: directory.id) })
    }
}
