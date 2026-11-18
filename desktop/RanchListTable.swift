// The list every page of The Ranch shows its things in, sources, changes,
// links or review items alike: a header with how many there are, a toggle
// for tighter rows, Table and Cards, and the time the library was read; then
// the things themselves as a table or as cards. Pulled down, the list alone
// moves and the library is read again (RanchPullRefresh.swift).

import Cocoa
import SwiftUI

/// How a thing stands, beside its dot.
struct RanchListStatus {
    let title: String
    let dot: Color
    /// Drawn quietly, as for a file not used yet.
    var dim = false
}

/// One thing in a list, said the same way whatever the page lists.
struct RanchListItem: Identifiable {
    let id: String
    /// The type icon's file extension; nil draws a folder.
    var fileExtension: String?
    var title: String
    var caption: String
    /// A word in a pill, such as the file's kind.
    var kind: String?
    var directory: (name: String, color: Color)?
    var status: RanchListStatus
    /// What the fourth column says, such as how much a file is used.
    var detail: String?
    /// A bar under or beside the detail, 0 to 1; nil for none.
    var meter: Double?
    var detailStrong = false
    var when: String
    /// A copy button beside the detail, for links.
    var copy: (() -> Void)? = nil
    /// The file on this Mac, for dragging out.
    var localURL: URL? = nil
    /// Opens the share dialog for it, from a button at the end of its row.
    var share: (() -> Void)? = nil
}

/// The names of the columns after Source and Directory.
struct RanchListColumns {
    var kind = "Kind"
    var status = "Status"
    var detail = "Usage"
    var when = "Last edited"
    var showsDirectory = true
    /// Whether rows end with a Share button.
    var share = false
}

enum RanchListLayout: String {
    case table, cards
}

/// The header over a list: its name, a line about it, the row toggle, Table
/// and Cards, anything the page adds, and when the library was read.
struct RanchListHeader<Accessory: View>: View {
    let title: String
    let caption: String
    @Binding var layout: RanchListLayout
    @Binding var compact: Bool
    let pull: RanchPull
    let read: Date?
    /// Called as the layout changes, so the rows rise into their new places.
    var relaid: () -> Void = {}
    /// Whether the list offers Table and Cards; a log is always a table.
    var layouts = true
    @ViewBuilder var accessory: Accessory

    var body: some View {
        HStack(spacing: 12) {
            Text(title).font(RanchLook.font(16, .medium)).foregroundStyle(RanchLook.ink).lineLimit(1)
            Text(caption).font(RanchLook.font(13.5)).foregroundStyle(RanchLook.ink3).lineLimit(1)
            Button { withAnimation(RanchLook.spring) { compact.toggle() } } label: {
                Image(systemName: compact ? "arrow.up.and.line.horizontal.and.arrow.down" : "arrow.down.and.line.horizontal.and.arrow.up")
            }
            .buttonStyle(RanchRoundButtonStyle(size: 34))
            .help(compact ? "Give the rows more room" : "Fit more rows")
            .opacity(layout == .table ? 1 : 0)
            .disabled(layout != .table)
            if layouts {
                RanchSegments(selection: Binding(get: { layout }, set: { next in
                    guard next != layout else { return }
                    relaid()
                    layout = next
                }), options: [
                    .init(value: .table, title: "Table", symbol: "list.bullet"),
                    .init(value: .cards, title: "Cards", symbol: "square.grid.2x2.fill"),
                ])
            }
            accessory
            Spacer(minLength: 8)
            RanchPullStatus(pull: pull, read: read)
        }
        .padding(.top, 30)
        .padding(.bottom, 14)
    }
}

extension RanchListHeader where Accessory == EmptyView {
    init(title: String, caption: String, layout: Binding<RanchListLayout>, compact: Binding<Bool>, pull: RanchPull,
         read: Date?, relaid: @escaping () -> Void = {}) {
        self.init(title: title, caption: caption, layout: layout, compact: compact, pull: pull, read: read,
                  relaid: relaid) { EmptyView() }
    }
}

/// A list that can be pulled down: the list moves, and the drop and spinner
/// wait behind its top. Only scrolls over the list itself pull it.
struct RanchPullList<Content: View>: View {
    let pull: RanchPull
    @ViewBuilder var content: Content

    var body: some View {
        ZStack(alignment: .top) {
            RanchPullStage(pull: pull)
            RanchPullOffset(pull: pull) { content }
        }
        .background(RanchPullArea(pull: pull))
    }
}

/// The things as a table or as cards, or what to say when there are none.
struct RanchList: View {
    let items: [RanchListItem]
    let columns: RanchListColumns
    let layout: RanchListLayout
    let width: CGFloat
    let compact: Bool
    let since: Date
    let chosen: String?
    let empty: (symbol: String, title: String, message: String)
    /// What a click does; true for a double-click.
    let choose: (RanchListItem, Bool) -> Void
    var menu: (RanchListItem) -> AnyView = { _ in AnyView(EmptyView()) }

    var body: some View {
        if items.isEmpty {
            RanchEmptyState(symbol: empty.symbol, title: empty.title, message: empty.message)
                .frame(height: 220)
                .ranchPanel()
        } else if layout == .table {
            RanchListTable(items: items, columns: columns, width: width, compact: compact, since: since,
                           chosen: chosen, choose: choose, menu: menu)
                .id("table")
        } else {
            RanchListGrid(items: items, columns: columns, since: since, chosen: chosen, choose: choose, menu: menu)
                .id("cards")
        }
    }
}

// MARK: Table

struct RanchListTable: View {
    let items: [RanchListItem]
    let columns: RanchListColumns
    let width: CGFloat
    let compact: Bool
    let since: Date
    let chosen: String?
    let choose: (RanchListItem, Bool) -> Void
    let menu: (RanchListItem) -> AnyView
    @FocusState private var focused: Bool

    var body: some View {
        let fits = RanchTableColumns(width: width, showsDirectory: columns.showsDirectory)
        LazyVStack(spacing: 0) {
            header(fits)
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                RanchListTableRow(item: item, fits: fits, shareColumn: columns.share, compact: compact,
                                  chosen: chosen == item.id) { double in
                    focused = true
                    choose(item, double)
                }
                .contextMenu { menu(item) }
                .ranchRise(index, since: since)
            }
        }
        .ranchPanel()
        .modifier(RanchListKeysModifier(focused: $focused) { direction in move(direction) })
    }

    private func header(_ fits: RanchTableColumns) -> some View {
        HStack(spacing: 0) {
            Text("Source").frame(maxWidth: .infinity, alignment: .leading)
            if fits.kind { Text(columns.kind).frame(width: RanchTableColumns.kindWidth, alignment: .leading) }
            if fits.directory { Text("Directory").frame(width: RanchTableColumns.directoryWidth, alignment: .leading) }
            Text(columns.status).frame(width: RanchTableColumns.statusWidth, alignment: .leading)
            if fits.usage { Text(columns.detail).frame(width: RanchTableColumns.usageWidth, alignment: .leading) }
            Text(columns.when).frame(width: RanchTableColumns.whenWidth, alignment: .leading)
            if columns.share { Color.clear.frame(width: RanchListShareButton.width) }
        }
        .font(RanchLook.font(12.5))
        .foregroundStyle(RanchLook.ink3)
        .lineLimit(1)
        .padding(.horizontal, 20)
        .frame(height: 42)
    }

    /// ↑ and ↓ choose the thing above or below, once a row has been clicked.
    private func move(_ direction: MoveCommandDirection) {
        guard direction == .up || direction == .down, !items.isEmpty else { return }
        let current = chosen.flatMap { id in items.firstIndex { $0.id == id } }
        let next: Int
        if direction == .up {
            next = current.map { max(0, $0 - 1) } ?? items.count - 1
        } else {
            next = current.map { min(items.count - 1, $0 + 1) } ?? 0
        }
        choose(items[next], false)
    }
}

struct RanchListKeysModifier: ViewModifier {
    var focused: FocusState<Bool>.Binding
    let move: (MoveCommandDirection) -> Void

    func body(content: Content) -> some View {
        if #available(macOS 14, *) {
            content.focusable().focusEffectDisabled().focused(focused).onMoveCommand(perform: move)
        } else {
            content.focusable().focused(focused).onMoveCommand(perform: move)
        }
    }
}

/// A thing's icon: its file type's, or a folder.
private struct RanchListIcon: View {
    let item: RanchListItem
    let size: CGFloat

    var body: some View {
        if let fileExtension = item.fileExtension {
            RanchFileIcon(url: nil, fileExtension: fileExtension, size: size)
        } else {
            RanchLucideIcon(icon: .folder, size: size * 0.8, color: item.directory?.color ?? RanchLook.ink2)
                .frame(width: size, height: size)
        }
    }
}

private struct RanchListTableRow: View {
    let item: RanchListItem
    let fits: RanchTableColumns
    let shareColumn: Bool
    let compact: Bool
    let chosen: Bool
    let click: (Bool) -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 13) {
                RanchListIcon(item: item, size: compact ? 22 : 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(RanchLook.font(14.5, .medium)).foregroundStyle(RanchLook.ink)
                        .lineLimit(1).truncationMode(.middle)
                    if !compact {
                        Text(item.caption).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            if fits.kind {
                Group {
                    if let kind = item.kind { RanchPill(text: kind) } else { Text("\u{2014}").foregroundStyle(RanchLook.ink3) }
                }
                .frame(width: RanchTableColumns.kindWidth, alignment: .leading)
            }
            if fits.directory {
                HStack(spacing: 8) {
                    Circle().fill(item.directory?.color ?? RanchLook.ink3).frame(width: 7, height: 7)
                    Text(item.directory?.name ?? "Removed").font(RanchLook.font(13.5)).foregroundStyle(RanchLook.ink)
                        .lineLimit(1).truncationMode(.tail)
                }
                .padding(.trailing, 10)
                .frame(width: RanchTableColumns.directoryWidth, alignment: .leading)
            }
            RanchListStatusLabel(status: item.status)
                .padding(.trailing, 8)
                .frame(width: RanchTableColumns.statusWidth, alignment: .leading)
            if fits.usage {
                RanchListDetail(item: item)
                    .padding(.trailing, 8)
                    .frame(width: RanchTableColumns.usageWidth, alignment: .leading)
            }
            Text(item.when).font(RanchLook.font(13.5)).foregroundStyle(RanchLook.ink2).lineLimit(1)
                .frame(width: RanchTableColumns.whenWidth, alignment: .leading)
            if shareColumn {
                Group {
                    if let share = item.share { RanchListShareButton(action: share) } else { Color.clear }
                }
                .frame(width: RanchListShareButton.width)
            }
        }
        .padding(.horizontal, 20)
        .frame(height: compact ? 42 : 58)
        .background(chosen ? RanchLook.raise : hovering ? RanchLook.rgb(0xF6F4EC, 0.035) : Color.clear)
        .overlay(alignment: .top) { RanchLook.line2.frame(height: 1) }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { click((NSApp.currentEvent?.clickCount ?? 1) >= 2) }
        .id(item.id)
        .modifier(RanchListDrag(url: item.localURL))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { click(false) }
    }
}

/// A file can be dragged out to Mail, Finder or any app that takes files.
private struct RanchListDrag: ViewModifier {
    let url: URL?

    func body(content: Content) -> some View {
        if let url {
            content.onDrag { NSItemProvider(contentsOf: url) ?? NSItemProvider() }
        } else {
            content
        }
    }
}

struct RanchListStatusLabel: View {
    let status: RanchListStatus

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(status.dot).frame(width: 7, height: 7)
            Text(status.title).font(RanchLook.font(13.5)).foregroundStyle(status.dim ? RanchLook.ink3 : RanchLook.ink)
                .lineLimit(1).truncationMode(.tail)
        }
    }
}

/// The fourth column: a bar and its words, or words alone, with a copy button where there is one.
private struct RanchListDetail: View {
    let item: RanchListItem

    var body: some View {
        HStack(spacing: 11) {
            if let meter = item.meter {
                RanchUsageBar(fraction: meter).frame(width: 42)
            }
            Text(item.detail ?? "\u{2014}").font(RanchLook.font(13.5)).monospacedDigit()
                .foregroundStyle(item.detailStrong ? RanchLook.ink : RanchLook.ink3)
                .lineLimit(1).truncationMode(.middle)
            if let copy = item.copy {
                RanchCopyButton(copy: copy)
            }
        }
    }
}

/// The Share button at the end of a source's row: the way into the share dialog.
struct RanchListShareButton: View {
    static let width: CGFloat = 40
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            RanchHover { hovering in
                RanchLucideIcon(icon: .share, size: 15, color: hovering ? RanchLook.ink : RanchLook.ink2)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(hovering ? RanchLook.rgb(0xF6F4EC, 0.1) : Color.clear))
                    .contentShape(Circle())
            }
        }
        .buttonStyle(.plain)
        .help("Share\u{2026}")
        .accessibilityLabel("Share")
    }
}

// MARK: Cards

struct RanchListGrid: View {
    let items: [RanchListItem]
    let columns: RanchListColumns
    let since: Date
    let chosen: String?
    let choose: (RanchListItem, Bool) -> Void
    let menu: (RanchListItem) -> AnyView

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 270, maximum: 440), spacing: 12)], spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                RanchListCard(item: item, columns: columns, chosen: chosen == item.id, menu: menu(item)) { choose(item, $0) }
                    .contextMenu { menu(item) }
                    .ranchRise(index, since: since)
            }
        }
    }
}

private struct RanchListCard: View {
    let item: RanchListItem
    let columns: RanchListColumns
    let chosen: Bool
    let menu: AnyView
    let click: (Bool) -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 13) {
                RanchListIcon(item: item, size: 28)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(RanchLook.rgb(0xF6F4EC, 0.07)))
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).font(RanchLook.font(16, .medium)).foregroundStyle(RanchLook.ink)
                        .lineLimit(1).truncationMode(.middle)
                    Text(item.caption).font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3)
                        .lineLimit(1).truncationMode(.middle)
                }
                .padding(.top, 3)
                Spacer(minLength: 4)
                if let share = item.share { RanchListShareButton(action: share) }
                Menu { menu } label: {
                    Image(systemName: "ellipsis").font(.system(size: 14, weight: .bold)).foregroundStyle(RanchLook.ink3)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .modifier(RanchPlainMenuStyle())
                .menuIndicator(.hidden)
                .fixedSize()
                .help("More")
            }
            HStack(spacing: 10) {
                if let kind = item.kind { RanchPill(text: kind) }
                RanchListStatusLabel(status: item.status)
            }
            .padding(.top, 14)
            RanchLook.line2.frame(height: 1).padding(.vertical, 16)
            HStack(alignment: .top, spacing: 12) {
                field("Directory", item.directory?.name ?? "Removed")
                field(columns.when, item.when)
            }
            HStack(spacing: 8) {
                Text(columns.detail).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
                Spacer(minLength: 8)
                Text(item.detail ?? "\u{2014}").font(RanchLook.font(13.5)).monospacedDigit()
                    .foregroundStyle(item.detailStrong ? RanchLook.ink : RanchLook.ink3)
                    .lineLimit(1).truncationMode(.middle)
                if let copy = item.copy { RanchCopyButton(copy: copy) }
            }
            .padding(.top, 16)
            if let meter = item.meter {
                RanchUsageBar(fraction: meter, height: 5).padding(.top, 9)
            }
        }
        .padding(18)
        .ranchPanel(chosen ? RanchLook.raise : hovering ? RanchLook.rgb(0x1A1A18) : RanchLook.panel)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { click((NSApp.currentEvent?.clickCount ?? 1) >= 2) }
        .id(item.id)
        .modifier(RanchListDrag(url: item.localURL))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { click(false) }
    }

    private func field(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
            Text(value).font(RanchLook.font(14.5)).foregroundStyle(RanchLook.ink).lineLimit(1).truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: The page around a list

/// The window's top row over the page: where it is, with its icon, and the
/// bell. Like the rest of the window around the page, it sits on the window's
/// material, and dragging it moves the window.
struct RanchTitleRow: View {
    @ObservedObject var store: RanchStore
    /// Room on the left for the window's buttons, when no sidebar sits under them.
    var leading: CGFloat = 0

    var body: some View {
        HStack(spacing: 10) {
            icon
            HStack(spacing: 8) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    if index > 0 { Text("/").foregroundStyle(RanchTheme.tertiaryInk) }
                    if let action = step.action {
                        Button(step.title, action: action).buttonStyle(RanchTitleCrumbStyle())
                    } else {
                        Text(step.title).foregroundStyle(RanchTheme.ink).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            .font(RanchLook.font(15, .medium))
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            RanchBell(count: store.reviewCount) { store.section = .review }
                .scaleEffect(0.84)
        }
        .padding(.leading, leading + 14)
        .padding(.trailing, 10)
        .frame(height: RanchTheme.titlebarHeight)
        .background(RanchWindowDragArea())
    }

    @ViewBuilder private var icon: some View {
        switch store.section ?? .sources {
        case .sources: RanchLucideIcon(icon: .layers, color: RanchTheme.secondaryInk)
        case .changes: RanchLucideIcon(icon: .history, color: RanchTheme.secondaryInk)
        case .links: RanchLucideIcon(icon: .link, color: RanchTheme.secondaryInk)
        case .review: RanchLucideIcon(icon: .triangleAlert, color: RanchTheme.secondaryInk)
        case .network: RanchLucideIcon(icon: .network, color: RanchTheme.secondaryInk)
        case .directory(let id): RanchLucideIcon(icon: .folder, color: store.directory(id)?.color ?? RanchTheme.secondaryInk)
        }
    }

    private var steps: [RanchBreadcrumb.Step] {
        switch store.section ?? .sources {
        case .sources: return [.init(title: "Sources")]
        case .changes: return [.init(title: "Recent Changes")]
        case .links: return [.init(title: "Links")]
        case .review: return [.init(title: "Needs Review")]
        case .network: return [.init(title: "Network")]
        case .directory(let id):
            return [.init(title: "Sources") { store.section = .sources }, .init(title: store.directoryName(id))]
        }
    }
}

private struct RanchTitleCrumbStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label.foregroundStyle(hovering ? RanchTheme.ink : RanchTheme.tertiaryInk)
        }
    }
}

/// Under a page's content, how far it is scrolled, so a pull starts only from its top.
struct RanchScrollTopProbe: View {
    let pull: RanchPull
    let space: String

    var body: some View {
        Color.clear.frame(height: 0)
            .background(GeometryReader { place in
                Color.clear.preference(key: RanchPullTopKey.self, value: place.frame(in: .named(space)).minY)
            })
    }
}
