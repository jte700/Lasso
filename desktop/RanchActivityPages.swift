// Recent Changes, Links and Needs Review, each as a page with the same list
// as Sources (RanchListTable.swift): a table or cards, the row toggle, the
// time the library was read, and pull to refresh on the list. Recent Changes
// is an audit log instead (RanchChangeLog.swift), whose rows open in place to
// what changed. Choosing a link brings its file in from the right, and a
// review item opens at the place it is about.

import Cocoa
import SwiftUI

struct RanchActivityPage: View {
    enum Kind { case changes, links, review }

    @ObservedObject var store: RanchStore
    let actions: RanchActions
    let kind: Kind
    @AppStorage("RanchSourcesLayout") private var layoutName = RanchListLayout.table.rawValue
    @AppStorage("RanchSourcesCompact") private var compact = false
    @State private var laidOut = Date()
    @State private var chosen: String?
    /// The change opened in the log, showing its detail.
    @State private var expanded: String?
    /// Which changes the log lists; ones that arrive later wait behind the pill.
    @State private var feed = RanchChangeFeed()
    /// Where the list's top sits in the page's view, for the pill to float over it.
    @State private var listTop: CGFloat = 80
    // Held, not watched: the pull redraws only its own parts, at 120 frames a second while it moves.
    @State private var pull = RanchPull()

    private static let scrollSpace = "ranch-activity-scroll"
    private static let topID = "ranch-activity-top"
    /// How far below the page's top the new-changes pill sits once the list scrolls under it.
    private static let pillTop: CGFloat = 14

    var body: some View {
        let content = listContent
        GeometryReader { geometry in
            ZStack(alignment: .trailing) {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            RanchScrollTopProbe(pull: pull, space: Self.scrollSpace).id(Self.topID)
                            RanchListHeader(title: title, caption: content.caption,
                                            layout: kind == .changes ? .constant(.table) : layout, compact: $compact,
                                            pull: pull, read: store.loadError == nil ? store.overview.generatedAt : nil,
                                            relaid: { laidOut = Date() }, layouts: kind != .changes) {
                                if kind == .links { linkTabs }
                            }
                            .padding(.top, -8)
                            RanchPullList(pull: pull) {
                                if kind == .changes, !shownChanges.isEmpty {
                                    RanchChangeLog(store: store, entries: shownChanges, width: geometry.size.width - 56,
                                                   compact: compact, since: laidOut, chosen: $chosen, expanded: $expanded,
                                                   menu: { menu(id: $0.id) })
                                } else {
                                    RanchList(items: content.items, columns: content.columns,
                                              layout: RanchListLayout(rawValue: layoutName) ?? .table,
                                              width: geometry.size.width - 56, compact: compact, since: laidOut,
                                              chosen: open ? chosen : nil, empty: content.empty,
                                              choose: { item, double in choose(item, double: double) },
                                              menu: { menu(id: $0.id) })
                                }
                            }
                            .background(GeometryReader { place in
                                Color.clear.preference(key: RanchListTopKey.self, value: place.frame(in: .named(Self.scrollSpace)).minY)
                            })
                            if let notice = content.notice {
                                Text(notice).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3).padding(.top, 12)
                            }
                        }
                        .padding(.horizontal, 28)
                        .padding(.bottom, 28)
                    }
                    .coordinateSpace(name: Self.scrollSpace)
                    .onPreferenceChange(RanchPullTopKey.self) { top in pull.atTop = top >= -0.5 }
                    .onPreferenceChange(RanchListTopKey.self) { top in
                        // Kept only while it moves the pill: every change redraws the whole page,
                        // which scrolling would otherwise do on every frame.
                        let pinned = max(Self.pillTop - 4, top.rounded())
                        if pinned != listTop { listTop = pinned }
                    }
                    .overlay(alignment: .top) { newChangesPill(proxy) }
                    .animation(RanchLook.spring, value: waitingChanges.count)
                }
                RanchFileDrawer(store: store, actions: actions, width: geometry.size.width)
            }
        }
        .background(RanchLook.page)
        .onChange(of: open) { isOpen in
            pull.blocked = isOpen
            // A change stays chosen in the log while its file comes and goes beside it.
            if !isOpen, kind != .changes { chosen = nil }
        }
        .onChange(of: store.linkTab) { _ in laidOut = Date() }
        .onChange(of: store.hasLoaded) { loaded in if loaded { feed.begin(with: store.overview.history) } }
        .onAppear {
            if store.hasLoaded { feed.begin(with: store.overview.history) }
            pull.blocked = open
            // Pulled down, the log takes in what the read brings, as its pill would.
            pull.onRefresh = { store.reload(then: { takeInChanges() }) }
            pull.onLanded = {
                laidOut = Date()
                takeInChanges()
            }
            pull.attach()
        }
        .onDisappear { pull.detach() }
    }

    private var title: String {
        switch kind {
        case .changes: return "Recent Changes"
        case .links: return "Links"
        case .review: return "Needs Review"
        }
    }

    private var layout: Binding<RanchListLayout> {
        Binding(get: { RanchListLayout(rawValue: layoutName) ?? .table }, set: { layoutName = $0.rawValue })
    }

    /// Whether a file, a change's note or a review item is open over the page.
    private var open: Bool {
        store.source(store.selectedSourceID) != nil || store.reviewFocus != nil || store.selectionNote != nil
    }

    private var linkTabs: some View {
        RanchSegments(selection: $store.linkTab, options: RanchStore.LinkTab.allCases.map { tab in
            let count = tab == .outgoing ? store.overview.links.outgoing.count : store.overview.links.received.count
            return .init(value: tab, title: "\(tab == .outgoing ? "Shared by you" : "Received") \(count)")
        })
    }

    // MARK: What the list holds

    private struct Content {
        var items: [RanchListItem]
        var caption: String
        var columns: RanchListColumns
        var empty: (symbol: String, title: String, message: String)
        var notice: String? = nil
    }

    private var listContent: Content {
        switch kind {
        case .changes: return changes
        case .links: return store.linkTab == .outgoing ? sharedLinks : receivedLinks
        case .review: return review
        }
    }

    private func matches(_ text: String) -> Bool {
        let query = store.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || text.localizedCaseInsensitiveContains(query)
    }

    private func place(_ directoryId: String) -> (name: String, color: Color)? {
        store.directory(directoryId).map { (name: $0.name, color: $0.color) }
    }

    private static func folder(of path: String) -> String {
        let folder = (path as NSString).deletingLastPathComponent
        return folder.isEmpty ? "Top of the directory" : folder
    }

    /// The changes the search keeps, newest first.
    private var changeEntries: [RanchHistoryEntry] {
        store.overview.history.filter { matches($0.path ?? store.directoryName($0.directoryId)) }
    }

    /// The ones the log lists; the rest wait behind the pill until taken in.
    private var shownChanges: [RanchHistoryEntry] { feed.shown(changeEntries) }
    private var waitingChanges: [RanchHistoryEntry] { kind == .changes ? feed.waiting(changeEntries) : [] }

    @ViewBuilder private func newChangesPill(_ proxy: ScrollViewProxy) -> some View {
        let count = waitingChanges.count
        if count > 0 {
            RanchNewChangesPill(count: count) { takeInChanges(scrolling: proxy) }
                // Over the top of the list, and at the top of the page once the list scrolls under it.
                .padding(.top, max(Self.pillTop, listTop + 4))
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// Lists the changes waiting behind the pill, newest at the top, rising into place.
    private func takeInChanges(scrolling proxy: ScrollViewProxy? = nil) {
        guard kind == .changes, !feed.waiting(store.overview.history).isEmpty else { return }
        laidOut = Date()
        withAnimation(RanchLook.spring) {
            feed.takeIn(store.overview.history)
            proxy?.scrollTo(Self.topID, anchor: .top)
        }
    }

    /// The log draws its own rows; the list is only asked for its words when there are none.
    private var changes: Content {
        let count = shownChanges.count
        return Content(items: [], caption: "\(count == 1 ? "1 change" : "\(count.formatted()) changes") \u{00B7} last two weeks",
                       columns: RanchListColumns(status: "Change", detail: "What changed", when: "When"),
                       empty: ("clock", store.searchText.isEmpty ? "No Changes" : "No Matches",
                               "Edits, new files and removals from the last two weeks appear here."),
                       notice: store.overview.historyTruncated
                           ? "Only the latest changes are listed. Every file keeps its full history in Lasso." : nil)
    }

    private var sharedLinks: Content {
        let links = store.overview.links.outgoing.filter { matches($0.name ?? $0.path ?? $0.url) }
        let items = links.map { link -> RanchListItem in
            let path = link.path ?? ""
            let status: RanchListStatus
            switch link.status {
            case "active": status = link.drifted ? RanchListStatus(title: "Changed since", dot: RanchTheme.warning)
                : RanchListStatus(title: "Active", dot: RanchLook.lime)
            case "expired": status = RanchListStatus(title: "Expired", dot: RanchLook.ink3, dim: true)
            default: status = RanchListStatus(title: "Stopped", dot: RanchLook.ink3, dim: true)
            }
            let ends = link.status == "active" ? link.expiresAt.map { "Ends \(RanchFormat.ago($0))" } : nil
            return RanchListItem(
                id: link.id, fileExtension: (path as NSString).pathExtension.lowercased(),
                title: link.name ?? (path as NSString).lastPathComponent, caption: link.locator ?? Self.folder(of: path),
                kind: ["INDEXED": "Cited part", "REDACTED": "Redacted", "MARKED": "Marked up"][link.scope] ?? "Whole file",
                directory: place(link.directoryId), status: status, detail: Self.short(link.url), detailStrong: link.status == "active",
                when: ends ?? RanchFormat.ago(link.createdAt).capitalizedFirst,
                copy: { store.copy(link.url) })
        }
        let active = store.activeLinkCount
        return Content(items: items, caption: "\(active) active \u{00B7} \(links.count) shared",
                       columns: RanchListColumns(kind: "Shares", detail: "Link", when: "Ends"),
                       empty: ("link", "No Shared Links",
                               "Choose Share Link on any file, or press \u{21E7}\u{2318}\u{21A9} on a suggestion, to make one."))
    }

    private var receivedLinks: Content {
        let links = store.overview.links.received.filter { matches($0.url + $0.path) }
        let items = links.map { link in
            RanchListItem(
                id: link.id, fileExtension: (link.path as NSString).pathExtension.lowercased(),
                title: URL(string: link.url)?.host ?? link.url, caption: "In \((link.path as NSString).lastPathComponent)",
                kind: "Received", directory: place(link.directoryId),
                status: RanchListStatus(title: "Received", dot: RanchLook.sky), detail: Self.short(link.url), detailStrong: true,
                when: RanchFormat.ago(link.receivedAt).capitalizedFirst, copy: { store.copy(link.url) })
        }
        return Content(items: items, caption: "\(links.count) received",
                       columns: RanchListColumns(kind: "Kind", detail: "Link", when: "Received"),
                       empty: ("tray.and.arrow.down", "No Received Links",
                               "Share links people send you appear here when they arrive in an indexed folder, a note, or mail from a connected app."))
    }

    /// A link without its scheme, as it is read aloud.
    private static func short(_ url: String) -> String {
        url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
    }

    private static let reviewKinds: [String: String] = [
        "directory": "Directory", "changed": "Value changed", "missing": "Source missing", "unverified": "To verify",
        "drifted": "Changed since shared", "unreadable": "Not fully read",
    ]

    private var review: Content {
        let reviewItems = store.overview.review.filter { matches($0.path ?? store.directoryName($0.directoryId)) }
        let items = reviewItems.map { item -> RanchListItem in
            let directory = store.directoryName(item.directoryId)
            let documents = item.documents.map { ($0 as NSString).lastPathComponent }
            return RanchListItem(
                id: item.id, fileExtension: item.kind == "directory" ? nil : item.path.map { ($0 as NSString).pathExtension.lowercased() },
                title: item.path.map { ($0 as NSString).lastPathComponent } ?? directory, caption: item.detail,
                kind: Self.reviewKinds[item.kind] ?? "To review", directory: place(item.directoryId),
                status: RanchListStatus(title: "Needs review", dot: RanchTheme.warning),
                detail: item.valueChangeLine, detailStrong: true,
                when: documents.isEmpty ? "\u{2014}" : documents.count == 1 ? documents[0] : "\(documents[0]) and \(documents.count - 1) more",
                localURL: store.source(item.fileId).flatMap { store.localURL(for: $0) })
        }
        let count = reviewItems.count
        return Content(items: items,
                       caption: count == 0 ? "Everything looks fine" : "\(count) source\(count == 1 ? "" : "s") with a possible problem",
                       columns: RanchListColumns(kind: "Kind", detail: "Change", when: "Cited in"),
                       empty: ("checkmark.seal", "Nothing Needs Review",
                               "Changed links, missing sources and files Lasso couldn\u{2019}t fully read show up here."))
    }

    // MARK: Choosing

    private func choose(_ item: RanchListItem, double: Bool) {
        chosen = item.id
        switch kind {
        case .changes:
            // Recent Changes is a log that opens its rows in place (RanchChangeLog.swift).
            break
        case .links:
            let shared = store.overview.links.outgoing.first { $0.id == item.id }?.fileId
            let received = store.overview.links.received.first { $0.id == item.id }?.fileId
            store.selectedSourceID = shared ?? received
        case .review:
            guard let reviewItem = store.overview.review.first(where: { $0.id == item.id }) else { return }
            store.selectedSourceID = reviewItem.fileId
            store.reviewFocus = reviewItem
        }
        if double, let url = item.localURL { RanchEditors.primary(for: url)?.open(url) }
    }

    private func menu(id: String) -> AnyView {
        switch kind {
        case .links:
            if let link = store.overview.links.outgoing.first(where: { $0.id == id }) {
                return AnyView(Group {
                    Button("Copy Link") { store.copy(link.url) }
                    if link.status == "active" { Button("Stop Sharing") { store.stopSharing(link) } }
                })
            }
            if let link = store.overview.links.received.first(where: { $0.id == id }) {
                return AnyView(Group {
                    Button("Copy Link") { store.copy(link.url) }
                    if let url = URL(string: link.url) { Button("Open Link") { NSWorkspace.shared.open(url) } }
                })
            }
            return AnyView(EmptyView())
        case .changes, .review:
            let fileId = kind == .changes ? store.overview.history.first { $0.id == id }?.fileId
                : store.overview.review.first { $0.id == id }?.fileId
            guard let source = store.source(fileId) else { return AnyView(EmptyView()) }
            return AnyView(RanchSourceMenu(store: store, source: source))
        }
    }
}

/// Where a page's list starts within its scroll view.
private struct RanchListTopKey: PreferenceKey {
    static var defaultValue: CGFloat = 80
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
