// The Loop's main page, for every source or one directory's: where it is, a
// title and a line about what it holds, choices, an overview in cards, and the
// files themselves as a table or as cards, with the search bar floating over
// them at the foot of the page (LoopMorphingSearch.swift). Choosing a file
// brings it in from the right. Pulled down at its top, it reads the library
// again (LoopPullRefresh.swift).

import Cocoa
import SwiftUI

struct LoopSourcesPage: View {
    @ObservedObject var store: LoopStore
    let actions: LoopActions
    let directoryId: String?
    var search: FocusState<Bool>.Binding
    @State private var use = LoopUseFilter.all
    @AppStorage("LoopSourcesLayout") private var layoutName = LoopListLayout.table.rawValue
    @AppStorage("LoopSourcesCompact") private var compact = false
    /// When the list was last laid out afresh, so its rows rise in turn.
    @State private var laidOut = Date()
    // Held, not watched: the pull redraws only its own parts, at 120 frames a second while it moves.
    @State private var pull = LoopPull()
    @StateObject private var shortcut = LoopSearchShortcut()
    /// Counts asks to put the cursor in the search bar: F, ⌘F and the sidebar's Search row.
    @State private var searchFocus = 0

    private var directory: LoopDirectory? { store.directory(directoryId) }

    var body: some View {
        let listed = store.listedSources(in: directoryId)
        let shown = use == .all ? listed : listed.filter(use.keeps)
        let flagged = Set(store.overview.review.compactMap(\.fileId))
        GeometryReader { geometry in
            ZStack(alignment: .trailing) {
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            LoopScrollTopProbe(pull: pull, space: Self.scrollSpace)
                            heading(listed)
                            controls
                            LoopOverviewCards(store: store, directoryId: directoryId, width: geometry.size.width - 56)
                                .padding(.top, 22)
                            LoopListHeader(title: listTitle, caption: listCaption(shown.count), layout: layoutChoice,
                                            compact: $compact, pull: pull,
                                            read: store.loadError == nil ? store.overview.generatedAt : nil,
                                            relaid: { laidOut = Date() })
                            // Pulled down, the list of sources alone moves and the library is read again.
                            LoopPullList(pull: pull) {
                                list(shown, flagged: flagged, width: geometry.size.width - 56)
                            }
                            if store.overview.truncated {
                                Text("Your library is very large; The Loop lists the first \(store.overview.sources.count.formatted()) files.")
                                    .font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                                    .padding(.top, 12)
                            }
                        }
                        .padding(.horizontal, 28)
                        // Room for the last rows to scroll up clear of the search bar.
                        .padding(.bottom, 28 + LoopChipMotion.height + 16)
                    }
                    .coordinateSpace(name: Self.scrollSpace)
                    .onPreferenceChange(LoopPullTopKey.self) { top in pull.atTop = top >= -0.5 }
                }
                LoopSearchBar(chips: $store.searchChips, recents: $store.searchRecents,
                               suggestions: store.searchTerms(in: directoryId), placeholder: searchPrompt,
                               focusRequest: searchFocus,
                               width: min(LoopChipMotion.maxWidth, max(240, geometry.size.width - 32)),
                               listRoom: min(320, geometry.size.height * 0.45))
                    .padding(.bottom, 16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .zIndex(2)
                LoopFileDrawer(store: store, actions: actions, width: geometry.size.width)
                    .zIndex(3)
            }
        }
        .background(LoopLook.page)
        .onChange(of: directoryId) { _ in laidOut = Date() }
        .onChange(of: store.selectedSourceID) { id in pull.blocked = id != nil }
        .onChange(of: store.searchRequest) { _ in openSearch() }
        .onChange(of: store.searchChips) { _ in laidOut = Date() }
        .onAppear {
            // The sidebar's field narrows the other pages; here the bar's chips do.
            store.searchText = ""
            shortcut.attach { openSearch() }
            pull.blocked = store.selectedSourceID != nil
            pull.onRefresh = { store.reload() }
            // Rows that arrived with the refresh rise into place, as the new message does in the original.
            pull.onLanded = { laidOut = Date() }
            pull.attach()
        }
        .onDisappear {
            pull.detach()
            shortcut.detach()
        }
    }

    private static let scrollSpace = "loop-sources-scroll"

    private var searchPrompt: String { directoryId == nil ? "Search sources" : "Search this directory" }

    private func openSearch() {
        guard store.selectedSourceID == nil, store.sharing == nil else { return }
        searchFocus += 1
    }

    // MARK: Top

    private func heading(_ listed: [LoopSource]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(directory?.name ?? "Sources")
                .font(LoopLook.font(40, .medium)).loopTracking(-0.035, size: 40)
                .foregroundStyle(LoopLook.ink)
                .lineLimit(1).truncationMode(.middle)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle(listed))
                .font(LoopLook.font(15)).foregroundStyle(LoopLook.ink2)
                .lineLimit(1).truncationMode(.tail)
            if let directory { about(directory) }
        }
        .padding(.top, 26)
    }

    /// Where a directory is and when Lasso took it on, and what is wrong with it if anything is.
    @ViewBuilder
    private func about(_ directory: LoopDirectory) -> some View {
        Text(place(directory))
            .font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3)
            .lineLimit(1).truncationMode(.middle)
            .textSelection(.enabled)
        if let issue = directory.issue {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(LoopTheme.warning)
                Text(issue).font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button("Try Again") { store.retryDirectory(directory.id) }
                    .buttonStyle(LoopPageButtonStyle(height: 30))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(LoopTheme.warning.opacity(0.13)))
            .padding(.top, 6)
        }
    }

    private func place(_ directory: LoopDirectory) -> String {
        var parts = [directory.isApp ? "Connected app" : (directory.rootPath as NSString).abbreviatingWithTildeInPath]
        if !directory.active {
            parts.append("Paused: suggestions are off for this directory")
        } else if directory.offline {
            parts.append("Offline")
        }
        if let added = directory.addedAt { parts.append("Added \(LoopFormat.ago(added))") }
        if let used = directory.lastUsedAt { parts.append("Last used \(LoopFormat.ago(used))") }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// "2,847 files across 4 directories · 6 kinds".
    private func subtitle(_ listed: [LoopSource]) -> String {
        guard store.hasLoaded else { return store.loadError == nil ? "Reading your library\u{2026}" : "Waiting for Lasso\u{2019}s library\u{2026}" }
        let count = listed.count
        var parts = [count == 1 ? "1 file" : "\(count.formatted()) files"]
        if directoryId == nil {
            let directories = store.orderedDirectories.count
            if directories == 0 {
                parts[0] = "No directories yet"
            } else {
                parts[0] += directories == 1 ? " in 1 directory" : " across \(directories) directories"
            }
        }
        let kinds = Set(listed.map(\.kind)).count
        if kinds > 1 { parts.append("\(kinds) kinds") }
        // When it was read is said by the line beside the bell, which also refreshes it.
        if store.loadError != nil { parts.append("showing the last copy") }
        return parts.joined(separator: " \u{00B7} ")
    }

    // MARK: Choices

    private var controls: some View {
        HStack(spacing: 10) {
            LoopSegments(selection: $use, options: [
                .init(value: .all, title: directoryId == nil ? "All sources" : "All files"),
                .init(value: .used, title: "In use"),
                .init(value: .shared, title: "Shared"),
            ])
            filterMenu
            Spacer(minLength: 8)
            if let directory, !directory.isApp, directory.available, !directory.offline {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory.rootPath)])
                } label: {
                    Image(systemName: "folder")
                }
                .buttonStyle(LoopRoundButtonStyle())
                .help("Show in Finder")
                .accessibilityLabel("Show in Finder")
            }
            Button(action: actions.addDirectories) {
                Label("Add directory", systemImage: "plus.circle.fill")
            }
            .buttonStyle(LoopPageButtonStyle(filled: true))
            .help("Choose folders for Lasso to read; their files appear here")
        }
        .padding(.top, 22)
        .onChange(of: use) { _ in laidOut = Date() }
    }

    /// Which kinds show and what order they are in, from one menu.
    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $store.kindFilter) {
                ForEach(LoopKindFilter.allCases) { Label($0.title, systemImage: $0.symbol).tag($0) }
            }
            .pickerStyle(.inline)
            Picker("Sort By", selection: $store.itemOrder) {
                ForEach(LoopOrder.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            LoopHover { hovering in
                HStack(spacing: 7) {
                    Image(systemName: "line.3.horizontal.decrease").font(.system(size: 11.5, weight: .bold))
                    Text(store.kindFilter == .all ? "Filter" : store.kindFilter.title).lineLimit(1)
                }
                .font(LoopLook.font(13, .medium))
                .foregroundStyle(LoopLook.ink)
                .padding(.horizontal, 15)
                .frame(height: 36)
                .background(Capsule().fill(hovering ? LoopLook.raise : LoopLook.panel))
                .overlay(Capsule().strokeBorder(store.kindFilter == .all ? LoopLook.line2 : LoopLook.sky.opacity(0.55), lineWidth: 1))
                .contentShape(Capsule())
            }
        }
        .modifier(LoopPlainMenuStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Show: \(store.kindFilter.title) \u{00B7} Sorted by \(store.itemOrder.title)")
    }

    // MARK: The files

    private var listTitle: String {
        use == .all ? (directoryId == nil ? "All sources" : "All files") : use == .used ? "In use" : "Shared"
    }

    private func listCaption(_ count: Int) -> String {
        "\(count == 1 ? "1 file" : "\(count.formatted()) files") \u{00B7} sorted by \(store.itemOrder.title.lowercased())"
    }

    private var layoutChoice: Binding<LoopListLayout> {
        Binding(get: { LoopListLayout(rawValue: layoutName) ?? .table }, set: { layoutName = $0.rawValue })
    }

    private func list(_ sources: [LoopSource], flagged: Set<String>, width: CGFloat) -> some View {
        LoopList(items: sources.map { LoopListItem(source: $0, store: store, flagged: flagged.contains($0.id)) },
                  columns: LoopListColumns(detail: "Usage", when: store.itemOrder.columnTitle, showsDirectory: directoryId == nil,
                                            share: true),
                  layout: LoopListLayout(rawValue: layoutName) ?? .table, width: width, compact: compact, since: laidOut,
                  chosen: store.selectedSourceID, empty: (emptySymbol, emptyTitle, emptyMessage),
                  choose: { item, double in
                      store.selectedSourceID = item.id
                      if double, let url = item.localURL { LoopEditors.primary(for: url)?.open(url) }
                  },
                  menu: { item in
                      guard let source = store.source(item.id) else { return AnyView(EmptyView()) }
                      return AnyView(LoopSourceMenu(store: store, source: source))
                  })
    }

    private var narrowed: Bool {
        !store.searchText.isEmpty || !store.searchChips.isEmpty || store.kindFilter != .all || use != .all
    }

    private var emptySymbol: String {
        if !store.hasLoaded { return "hourglass" }
        return !store.searchText.isEmpty || !store.searchChips.isEmpty ? "magnifyingglass"
            : narrowed ? "line.3.horizontal.decrease" : "folder"
    }

    private var emptyTitle: String {
        if !store.hasLoaded { return "Gathering Your Sources" }
        return narrowed ? "No Matches" : "No Files Yet"
    }

    private var emptyMessage: String {
        if !store.hasLoaded { return store.loadError ?? "The Loop is reading Lasso\u{2019}s library." }
        if !store.searchText.isEmpty { return "No file names match \u{201C}\(store.searchText)\u{201D}." }
        if !store.searchChips.isEmpty {
            let filters = ListFormatter.localizedString(byJoining: store.searchChips.map { "\u{201C}\($0)\u{201D}" })
            return "No file here has \(filters) in its name, folder, directory or kind. Remove a filter from the search bar to see more."
        }
        if use == .used { return "Nothing here has been used yet. A file counts once you Tab it into your writing, open it or share it." }
        if use == .shared { return "Nothing here is shared with a working link." }
        if store.kindFilter != .all { return "There are no \(store.kindFilter.title.lowercased()) here. Choose All Kinds from Filter to see every file." }
        return "Add a directory and its files appear here once Lasso has read them."
    }
}

/// The chosen file, brought in over the right of the page; the rest dims and a
/// click on it, or Escape, sends the file away again.
struct LoopFileDrawer: View {
    @ObservedObject var store: LoopStore
    let actions: LoopActions
    /// The page's width; the drawer takes a little over half of it.
    let width: CGFloat

    var body: some View {
        let open = store.source(store.selectedSourceID) != nil || store.reviewFocus != nil || store.selectionNote != nil
        ZStack(alignment: .trailing) {
            if open {
                Color.black.opacity(0.45)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: close)
                    .transition(.opacity)
                    .accessibilityLabel("Close the file")
                    .accessibilityAddTraits(.isButton)
                LoopDetail(store: store, actions: actions)
                    .frame(width: max(420, min(width - 72, width * 0.56)))
                    .background(LoopLook.page)
                    .overlay(alignment: .leading) { LoopHairline(vertical: true) }
                    .overlay(alignment: .topLeading) {
                        Button(action: close) { Image(systemName: "xmark") }
                            .buttonStyle(LoopRoundButtonStyle(size: 30))
                            .keyboardShortcut(.cancelAction)
                            .help("Close (Esc)")
                            .offset(x: -42, y: 11)
                    }
                    .shadow(color: .black.opacity(0.5), radius: 30, x: -8)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        .animation(LoopLook.spring, value: open)
    }

    private func close() {
        store.reviewFocus = nil
        store.selectionNote = nil
        store.selectedSourceID = nil
    }
}
