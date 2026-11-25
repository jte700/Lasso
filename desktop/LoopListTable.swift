// The list every page of The Loop shows its things in, sources, changes,
// links or review items alike: a header with how many there are, a toggle
// for tighter rows, Table and Cards, and the time the library was read; then
// the things themselves as a table or as cards. Pulled down, the list alone
// moves and the library is read again (LoopPullRefresh.swift).

import Cocoa
import SwiftUI

/// How a thing stands, beside its dot.
struct LoopListStatus {
    let title: String
    let dot: Color
    /// Drawn quietly, as for a file not used yet.
    var dim = false
}

/// One thing in a list, said the same way whatever the page lists.
struct LoopListItem: Identifiable {
    let id: String
    /// The type icon's file extension; nil draws a folder.
    var fileExtension: String?
    var title: String
    var caption: String
    /// A word in a pill, such as the file's kind.
    var kind: String?
    var directory: (name: String, color: Color)?
    var status: LoopListStatus
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
struct LoopListColumns {
    var kind = "Kind"
    var status = "Status"
    var detail = "Usage"
    var when = "Last edited"
    var showsDirectory = true
    /// Whether rows end with a Share button.
    var share = false
}

enum LoopListLayout: String {
    case table, cards
}

/// The header over a list: its name, a line about it, the row toggle, Table
/// and Cards, anything the page adds, and when the library was read.
struct LoopListHeader<Accessory: View>: View {
    let title: String
    let caption: String
    @Binding var layout: LoopListLayout
    @Binding var compact: Bool
    let pull: LoopPull
    let read: Date?
    /// Called as the layout changes, so the rows rise into their new places.
    var relaid: () -> Void = {}
    /// Whether the list offers Table and Cards; a log is always a table.
    var layouts = true
    @ViewBuilder var accessory: Accessory

    var body: some View {
        HStack(spacing: 12) {
            Text(title).font(LoopLook.font(16, .medium)).foregroundStyle(LoopLook.ink).lineLimit(1)
            Text(caption).font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink3).lineLimit(1)
            Button { withAnimation(LoopLook.spring) { compact.toggle() } } label: {
                Image(systemName: compact ? "arrow.up.and.line.horizontal.and.arrow.down" : "arrow.down.and.line.horizontal.and.arrow.up")
            }
            .buttonStyle(LoopRoundButtonStyle(size: 34))
            .help(compact ? "Give the rows more room" : "Fit more rows")
            .opacity(layout == .table ? 1 : 0)
            .disabled(layout != .table)
            if layouts {
                LoopSegments(selection: Binding(get: { layout }, set: { next in
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
            LoopPullStatus(pull: pull, read: read)
        }
        .padding(.top, 30)
        .padding(.bottom, 14)
    }
}

extension LoopListHeader where Accessory == EmptyView {
    init(title: String, caption: String, layout: Binding<LoopListLayout>, compact: Binding<Bool>, pull: LoopPull,
         read: Date?, relaid: @escaping () -> Void = {}) {
        self.init(title: title, caption: caption, layout: layout, compact: compact, pull: pull, read: read,
                  relaid: relaid) { EmptyView() }
    }
}

/// A list that can be pulled down: the list moves, and the drop and spinner
/// wait behind its top. Only scrolls over the list itself pull it.
struct LoopPullList<Content: View>: View {
    let pull: LoopPull
    @ViewBuilder var content: Content

    var body: some View {
        ZStack(alignment: .top) {
            LoopPullStage(pull: pull)
            LoopPullOffset(pull: pull) { content }
        }
        .background(LoopPullArea(pull: pull))
    }
}

/// The things as a table or as cards, or what to say when there are none.
struct LoopList: View {
    let items: [LoopListItem]
    let columns: LoopListColumns
    let layout: LoopListLayout
    let width: CGFloat
    let compact: Bool
    let since: Date
    let chosen: String?
    let empty: (symbol: String, title: String, message: String)
    /// What a click does; true for a double-click.
    let choose: (LoopListItem, Bool) -> Void
    var menu: (LoopListItem) -> AnyView = { _ in AnyView(EmptyView()) }

    var body: some View {
        if items.isEmpty {
            LoopEmptyState(symbol: empty.symbol, title: empty.title, message: empty.message)
                .frame(height: 220)
                .loopPanel()
        } else if layout == .table {
            LoopListTable(items: items, columns: columns, width: width, compact: compact, since: since,
                           chosen: chosen, choose: choose, menu: menu)
                .id("table")
        } else {
            LoopListGrid(items: items, columns: columns, since: since, chosen: chosen, choose: choose, menu: menu)
                .id("cards")
        }
    }
}

// MARK: Table

struct LoopListTable: View {
    let items: [LoopListItem]
    let columns: LoopListColumns
    let width: CGFloat
    let compact: Bool
    let since: Date
    let chosen: String?
    let choose: (LoopListItem, Bool) -> Void
    let menu: (LoopListItem) -> AnyView
    @FocusState private var focused: Bool

    var body: some View {
        let fits = LoopTableColumns(width: width, showsDirectory: columns.showsDirectory)
        LazyVStack(spacing: 0) {
            header(fits)
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                LoopListTableRow(item: item, fits: fits, shareColumn: columns.share, compact: compact,
                                  chosen: chosen == item.id) { double in
                    focused = true
                    choose(item, double)
                }
                .contextMenu { menu(item) }
                .loopRise(index, since: since)
            }
        }
        .loopPanel()
        .modifier(LoopListKeysModifier(focused: $focused) { direction in move(direction) })
    }

    private func header(_ fits: LoopTableColumns) -> some View {
        HStack(spacing: 0) {
            Text("Source").frame(maxWidth: .infinity, alignment: .leading)
            if fits.kind { Text(columns.kind).frame(width: LoopTableColumns.kindWidth, alignment: .leading) }
            if fits.directory { Text("Directory").frame(width: LoopTableColumns.directoryWidth, alignment: .leading) }
            Text(columns.status).frame(width: LoopTableColumns.statusWidth, alignment: .leading)
            if fits.usage { Text(columns.detail).frame(width: LoopTableColumns.usageWidth, alignment: .leading) }
            Text(columns.when).frame(width: LoopTableColumns.whenWidth, alignment: .leading)
            if columns.share { Color.clear.frame(width: LoopListShareButton.width) }
        }
        .font(LoopLook.font(12.5))
        .foregroundStyle(LoopLook.ink3)
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

struct LoopListKeysModifier: ViewModifier {
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
private struct LoopListIcon: View {
    let item: LoopListItem
    let size: CGFloat

    var body: some View {
        if let fileExtension = item.fileExtension {
            LoopFileIcon(url: nil, fileExtension: fileExtension, size: size)
        } else {
            LoopLucideIcon(icon: .folder, size: size * 0.8, color: item.directory?.color ?? LoopLook.ink2)
                .frame(width: size, height: size)
        }
    }
}

private struct LoopListTableRow: View {
    let item: LoopListItem
    let fits: LoopTableColumns
    let shareColumn: Bool
    let compact: Bool
    let chosen: Bool
    let click: (Bool) -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 13) {
                LoopListIcon(item: item, size: compact ? 22 : 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(LoopLook.font(14.5, .medium)).foregroundStyle(LoopLook.ink)
                        .lineLimit(1).truncationMode(.middle)
                    if !compact {
                        Text(item.caption).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            if fits.kind {
                Group {
                    if let kind = item.kind { LoopPill(text: kind) } else { Text("\u{2014}").foregroundStyle(LoopLook.ink3) }
                }
                .frame(width: LoopTableColumns.kindWidth, alignment: .leading)
            }
            if fits.directory {
                HStack(spacing: 8) {
                    Circle().fill(item.directory?.color ?? LoopLook.ink3).frame(width: 7, height: 7)
                    Text(item.directory?.name ?? "Removed").font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink)
                        .lineLimit(1).truncationMode(.tail)
                }
                .padding(.trailing, 10)
                .frame(width: LoopTableColumns.directoryWidth, alignment: .leading)
            }
            LoopListStatusLabel(status: item.status)
                .padding(.trailing, 8)
                .frame(width: LoopTableColumns.statusWidth, alignment: .leading)
            if fits.usage {
                LoopListDetail(item: item)
                    .padding(.trailing, 8)
                    .frame(width: LoopTableColumns.usageWidth, alignment: .leading)
            }
            Text(item.when).font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink2).lineLimit(1)
                .frame(width: LoopTableColumns.whenWidth, alignment: .leading)
            if shareColumn {
                Group {
                    if let share = item.share { LoopListShareButton(action: share) } else { Color.clear }
                }
                .frame(width: LoopListShareButton.width)
            }
        }
        .padding(.horizontal, 20)
        .frame(height: compact ? 42 : 58)
        .background(chosen ? LoopLook.raise : hovering ? LoopLook.rgb(0xF6F4EC, 0.035) : Color.clear)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { click((NSApp.currentEvent?.clickCount ?? 1) >= 2) }
        .id(item.id)
        .modifier(LoopListDrag(url: item.localURL))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { click(false) }
    }
}

/// A file can be dragged out to Mail, Finder or any app that takes files.
private struct LoopListDrag: ViewModifier {
    let url: URL?

    func body(content: Content) -> some View {
        if let url {
            content.onDrag { NSItemProvider(contentsOf: url) ?? NSItemProvider() }
        } else {
            content
        }
    }
}

struct LoopListStatusLabel: View {
    let status: LoopListStatus

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(status.dot).frame(width: 7, height: 7)
            Text(status.title).font(LoopLook.font(13.5)).foregroundStyle(status.dim ? LoopLook.ink3 : LoopLook.ink)
                .lineLimit(1).truncationMode(.tail)
        }
    }
}

/// The fourth column: a bar and its words, or words alone, with a copy button where there is one.
private struct LoopListDetail: View {
    let item: LoopListItem

    var body: some View {
        HStack(spacing: 11) {
            if let meter = item.meter {
                LoopUsageBar(fraction: meter).frame(width: 42)
            }
            Text(item.detail ?? "\u{2014}").font(LoopLook.font(13.5)).monospacedDigit()
                .foregroundStyle(item.detailStrong ? LoopLook.ink : LoopLook.ink3)
                .lineLimit(1).truncationMode(.middle)
            if let copy = item.copy {
                LoopCopyButton(copy: copy)
            }
        }
    }
}

/// The Share button at the end of a source's row: the way into the share dialog.
struct LoopListShareButton: View {
    static let width: CGFloat = 40
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            LoopHover { hovering in
                LoopLucideIcon(icon: .share, size: 15, color: hovering ? LoopLook.ink : LoopLook.ink2)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(hovering ? LoopLook.rgb(0xF6F4EC, 0.1) : Color.clear))
                    .contentShape(Circle())
            }
        }
        .buttonStyle(.plain)
        .help("Share\u{2026}")
        .accessibilityLabel("Share")
    }
}

// MARK: Cards

struct LoopListGrid: View {
    let items: [LoopListItem]
    let columns: LoopListColumns
    let since: Date
    let chosen: String?
    let choose: (LoopListItem, Bool) -> Void
    let menu: (LoopListItem) -> AnyView

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 270, maximum: 440), spacing: 12)], spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                LoopListCard(item: item, columns: columns, chosen: chosen == item.id, menu: menu(item)) { choose(item, $0) }
                    .contextMenu { menu(item) }
                    .loopRise(index, since: since)
            }
        }
    }
}

private struct LoopListCard: View {
    let item: LoopListItem
    let columns: LoopListColumns
    let chosen: Bool
    let menu: AnyView
    let click: (Bool) -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 13) {
                LoopListIcon(item: item, size: 28)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(LoopLook.rgb(0xF6F4EC, 0.07)))
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).font(LoopLook.font(16, .medium)).foregroundStyle(LoopLook.ink)
                        .lineLimit(1).truncationMode(.middle)
                    Text(item.caption).font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3)
                        .lineLimit(1).truncationMode(.middle)
                }
                .padding(.top, 3)
                Spacer(minLength: 4)
                if let share = item.share { LoopListShareButton(action: share) }
                Menu { menu } label: {
                    Image(systemName: "ellipsis").font(.system(size: 14, weight: .bold)).foregroundStyle(LoopLook.ink3)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .modifier(LoopPlainMenuStyle())
                .menuIndicator(.hidden)
                .fixedSize()
                .help("More")
            }
            HStack(spacing: 10) {
                if let kind = item.kind { LoopPill(text: kind) }
                LoopListStatusLabel(status: item.status)
            }
            .padding(.top, 14)
            LoopLook.line2.frame(height: 1).padding(.vertical, 16)
            HStack(alignment: .top, spacing: 12) {
                field("Directory", item.directory?.name ?? "Removed")
                field(columns.when, item.when)
            }
            HStack(spacing: 8) {
                Text(columns.detail).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                Spacer(minLength: 8)
                Text(item.detail ?? "\u{2014}").font(LoopLook.font(13.5)).monospacedDigit()
                    .foregroundStyle(item.detailStrong ? LoopLook.ink : LoopLook.ink3)
                    .lineLimit(1).truncationMode(.middle)
                if let copy = item.copy { LoopCopyButton(copy: copy) }
            }
            .padding(.top, 16)
            if let meter = item.meter {
                LoopUsageBar(fraction: meter, height: 5).padding(.top, 9)
            }
        }
        .padding(18)
        .loopPanel(chosen ? LoopLook.raise : hovering ? LoopLook.rgb(0x1A1A18) : LoopLook.panel)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { click((NSApp.currentEvent?.clickCount ?? 1) >= 2) }
        .id(item.id)
        .modifier(LoopListDrag(url: item.localURL))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { click(false) }
    }

    private func field(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
            Text(value).font(LoopLook.font(14.5)).foregroundStyle(LoopLook.ink).lineLimit(1).truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: The page around a list

/// The window's top row over the page: where it is, with its icon, and the
/// bell. Like the rest of the window around the page, it sits on the window's
/// material, and dragging it moves the window.
struct LoopTitleRow: View {
    @ObservedObject var store: LoopStore
    /// Room on the left for the window's buttons, when no sidebar sits under them.
    var leading: CGFloat = 0

    var body: some View {
        HStack(spacing: 10) {
            icon
            HStack(spacing: 8) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    if index > 0 { Text("/").foregroundStyle(LoopTheme.tertiaryInk) }
                    if let action = step.action {
                        Button(step.title, action: action).buttonStyle(LoopTitleCrumbStyle())
                    } else {
                        Text(step.title).foregroundStyle(LoopTheme.ink).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            .font(LoopLook.font(15, .medium))
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            LoopNotificationBell(store: store, reviews: store.reviews)
                .scaleEffect(0.84)
        }
        .padding(.leading, leading + 14)
        .padding(.trailing, 10)
        .frame(height: LoopTheme.titlebarHeight)
        .background(LoopWindowDragArea())
    }

    @ViewBuilder private var icon: some View {
        switch store.section ?? .sources {
        case .sources: LoopLucideIcon(icon: .layers, color: LoopTheme.secondaryInk)
        case .changes: LoopLucideIcon(icon: .history, color: LoopTheme.secondaryInk)
        case .links: LoopLucideIcon(icon: .link, color: LoopTheme.secondaryInk)
        case .review: LoopLucideIcon(icon: .triangleAlert, color: LoopTheme.secondaryInk)
        case .reviews: LoopLucideIcon(icon: .fileDiff, color: LoopTheme.secondaryInk)
        case .network: LoopLucideIcon(icon: .network, color: LoopTheme.secondaryInk)
        case .directory(let id): LoopLucideIcon(icon: .folder, color: store.directory(id)?.color ?? LoopTheme.secondaryInk)
        }
    }

    private var steps: [LoopBreadcrumb.Step] {
        switch store.section ?? .sources {
        case .sources: return [.init(title: "Sources")]
        case .changes: return [.init(title: "Recent Changes")]
        case .links: return [.init(title: "Links")]
        case .review: return [.init(title: "Needs Review")]
        case .reviews: return [.init(title: "Review Changes")]
        case .network: return [.init(title: "Network")]
        case .directory(let id):
            return [.init(title: "Sources") { store.section = .sources }, .init(title: store.directoryName(id))]
        }
    }
}

private struct LoopTitleCrumbStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        LoopHover { hovering in
            configuration.label.foregroundStyle(hovering ? LoopTheme.ink : LoopTheme.tertiaryInk)
        }
    }
}

/// Under a page's content, how far it is scrolled, so a pull starts only from its top.
struct LoopScrollTopProbe: View {
    let pull: LoopPull
    let space: String

    var body: some View {
        Color.clear.frame(height: 0)
            .background(GeometryReader { place in
                Color.clear.preference(key: LoopPullTopKey.self, value: place.frame(in: .named(space)).minY)
            })
    }
}
