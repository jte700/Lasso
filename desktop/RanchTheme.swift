// The pieces every view in The Ranch draws with: its colours and type, which
// come from the website rework's dark look (RanchLook.swift), rows as soft
// cards on the page, and capsule controls.

import Cocoa
import SwiftUI

enum RanchTheme {
    // MARK: Colours

    /// Behind the sidebar's rows: clear, so its panel shows.
    static let sidebar = Color.clear
    /// The list and file columns, and the window behind them.
    static let surface = RanchLook.page
    static let nsSurface = RanchLook.nsPage
    /// A row at rest, and the ground under models and drawings.
    static let card = RanchLook.rgb(0xF6F4EC, 0.05)
    static let cardHover = RanchLook.rgb(0xF6F4EC, 0.085)
    /// The chosen row: a lighter panel, as the sidebar's chosen view is.
    static let selection = RanchLook.rgb(0xF6F4EC, 0.15)
    static let hairline = RanchLook.line
    /// Fields and menus where glass is not used.
    static let control = RanchLook.raise
    static let controlEdge = RanchLook.line
    /// The groove a segmented control's choices sit in.
    static let track = RanchLook.track
    static let ink = RanchLook.ink
    static let secondaryInk = RanchLook.ink2
    static let tertiaryInk = RanchLook.ink3
    /// The one strong button, filled with the page's ink, and what is written on it.
    static let strong = RanchLook.ink
    static let onStrong = RanchLook.onInk
    /// Notes that float over a view, such as what the pointer is on.
    static let tooltip = RanchLook.lift
    static let onTooltip = RanchLook.ink
    static let onTooltipSecondary = RanchLook.ink2
    static let warning = RanchLook.rgb(0xE08A5F)

    // MARK: Type

    static let brandFont = RanchLook.font(19, .semibold)
    static let titleFont = RanchLook.font(14.5, .semibold)
    static let bodyFont = RanchLook.font(13.5)
    static let captionFont = RanchLook.font(12)
    static let controlFont = RanchLook.font(12.5, .medium)
    static let sectionFont = RanchLook.font(12, .semibold)

    /// The column headers' height: the window's buttons sit halfway down the sidebar's.
    static let headerHeight: CGFloat = 52
    /// The title bar band at the top of the sidebar, where the window's buttons are.
    static var titlebarHeight: CGFloat { RanchGlass.isAvailable ? 52 : 38 }
}

// MARK: Window chrome

/// Dragging an empty part of a header moves the window, as its title bar
/// would, and double-clicking zooms it.
struct RanchWindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { TitlebarDragView() }
    func updateNSView(_ view: NSView, context: Context) {}
}

/// A column's name and a line about it, with its controls on the right.
struct RanchColumnHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var trailing: Trailing
    /// Set on the leftmost column while the sidebar is hidden.
    @Environment(\.ranchShowSidebar) private var showSidebar

    var body: some View {
        HStack(spacing: 10) {
            if let showSidebar {
                // Clear of the window's own buttons.
                Spacer().frame(width: RanchGlass.isAvailable ? RanchGlass.windowButtonsWidth : 62)
                Button(action: showSidebar) { Image(systemName: "sidebar.left") }
                    .buttonStyle(RanchIconButtonStyle())
                    .help("Show Sidebar (\u{2303}\u{2318}S)")
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(RanchTheme.titleFont).foregroundStyle(RanchTheme.ink).lineLimit(1)
                Text(subtitle).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
                    .lineLimit(1).truncationMode(.tail)
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            trailing.environment(\.ranchToolbar, true)
        }
        .padding(.horizontal, 16)
        .frame(height: RanchTheme.headerHeight)
        .background(RanchWindowDragArea())
        .overlay(alignment: .bottom) { RanchHairline() }
    }
}

extension RanchColumnHeader where Trailing == EmptyView {
    init(title: String, subtitle: String) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

/// The row of menus and choices under a column's header.
struct RanchFilterBar<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 6) {
            content
            Spacer(minLength: 0)
        }
        .environment(\.ranchToolbar, true)
        .padding(.horizontal, 12)
        .frame(height: 42)
        .overlay(alignment: .bottom) { RanchHairline() }
    }
}

struct RanchHairline: View {
    var vertical = false
    var body: some View {
        RanchTheme.hairline.frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

/// A hairline between two columns that drags to resize the one on its left.
struct RanchColumnDivider: View {
    @Binding var width: Double
    let range: ClosedRange<Double>
    /// Off beside the floating glass sidebar, whose own edge parts the columns.
    var showsLine = true
    @State private var start: Double?

    var body: some View {
        RanchHairline(vertical: true)
            .opacity(showsLine ? 1 : 0)
            .overlay {
                Color.clear
                    .frame(width: 9)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { value in
                            let origin = start ?? width
                            start = origin
                            width = min(range.upperBound, max(range.lowerBound, origin + value.translation.width))
                        }
                        .onEnded { _ in start = nil })
            }
            // Its grip reaches over the column on its right.
            .zIndex(1)
            .accessibilityHidden(true)
    }
}

struct RanchShowSidebarKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    /// Shows the hidden sidebar; nil while it shows, or outside the leftmost column.
    var ranchShowSidebar: (() -> Void)? {
        get { self[RanchShowSidebarKey.self] }
        set { self[RanchShowSidebarKey.self] = newValue }
    }
}

// MARK: Controls

/// A capsule button: glass in a column header on macOS 26, bordered elsewhere;
/// prominent, the window's one accent-coloured button.
struct RanchPillButtonStyle: PrimitiveButtonStyle {
    var prominent = false
    var height: CGFloat = 28

    func makeBody(configuration: Configuration) -> some View {
        Button(configuration)
            .labelStyle(RanchPillLabelStyle())
            .modifier(RanchNativeButton(prominent: prominent))
            .controlSize(height > 30 ? .large : .regular)
    }
}

/// The capsule a menu's label sits on: glass on macOS 26, a bordered pill before.
struct RanchPillShape: View {
    var prominent = false
    var hovering = false

    var body: some View {
        if #available(macOS 26.0, *) {
            Capsule().fill(Color.clear)
                .glassEffect(prominent ? .regular.tint(RanchLook.ink) : .regular, in: Capsule())
        } else {
            let shape = Capsule()
            if prominent {
                shape.fill(RanchTheme.strong).opacity(hovering ? 0.88 : 1)
            } else {
                shape.fill(hovering ? RanchTheme.cardHover : RanchTheme.control)
                    .overlay(shape.strokeBorder(RanchTheme.controlEdge, lineWidth: 1))
            }
        }
    }
}

/// Icon and title close together.
struct RanchPillLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

/// A square icon for header actions: a glass circle in a column header on
/// macOS 26, otherwise borderless and greyed in on hover.
struct RanchIconButtonStyle: PrimitiveButtonStyle {
    var size: CGFloat = 28

    func makeBody(configuration: Configuration) -> some View {
        RanchIconButton(configuration: configuration, size: size)
    }
}

private struct RanchIconButton: View {
    let configuration: PrimitiveButtonStyleConfiguration
    let size: CGFloat
    @Environment(\.ranchToolbar) private var toolbar

    var body: some View {
        if #available(macOS 26.0, *), toolbar {
            Button(configuration)
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
        } else {
            Button(configuration).buttonStyle(RanchBorderlessIconStyle(size: size))
        }
    }
}

private struct RanchBorderlessIconStyle: ButtonStyle {
    let size: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        RanchIconBody(configuration: configuration, size: size)
    }
}

private struct RanchIconBody: View {
    let configuration: ButtonStyleConfiguration
    let size: CGFloat
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 13.5, weight: .regular))
            .foregroundStyle(hovering && isEnabled ? RanchTheme.ink : RanchTheme.secondaryInk)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(configuration.isPressed ? RanchTheme.cardHover : hovering && isEnabled ? RanchTheme.card : .clear))
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// A capsule that opens a menu: its icon, what is chosen, and a chevron.
struct RanchPillMenu<Items: View>: View {
    let title: String
    var symbol: String? = nil
    let help: String
    @ViewBuilder var items: Items
    @State private var hovering = false

    var body: some View {
        Menu {
            items
        } label: {
            HStack(spacing: 5) {
                if let symbol { Image(systemName: symbol).imageScale(.small).foregroundStyle(RanchTheme.secondaryInk) }
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(RanchTheme.secondaryInk)
            }
            .font(RanchTheme.controlFont)
            .foregroundStyle(RanchTheme.ink)
            .padding(.horizontal, 11)
            .frame(height: 28)
            .ranchControlBackground(hovering: hovering)
            .contentShape(Capsule())
        }
        .modifier(RanchPlainMenuStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .onHover { hovering = $0 }
        .help(help)
    }
}

/// A menu drawn by its own label. A plain SwiftUI label needs macOS 14;
/// macOS 13 keeps the borderless pop-up, made small.
struct RanchPlainMenuStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 14, *) {
            content.menuStyle(.button).buttonStyle(.plain)
        } else {
            content.menuStyle(.borderlessButton).controlSize(.small)
        }
    }
}

/// Choices side by side: the system's segmented control.
struct RanchSegmented<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(value: Value, title: String)]

    var body: some View {
        Picker("", selection: $selection) {
            ForEach(options, id: \.value) { option in Text(option.title).tag(option.value) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
    }
}

/// The sidebar's search field: a glass capsule on macOS 26, a rounded field before.
struct RanchSearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let prompt: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(RanchTheme.secondaryInk)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(RanchTheme.bodyFont)
                .foregroundStyle(RanchTheme.ink)
                .focused(focused)
                .onExitCommand { text = ""; focused.wrappedValue = false }
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(RanchTheme.tertiaryInk)
                }
                .buttonStyle(.plain)
                .help("Clear the search")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background { field }
        .contentShape(Rectangle())
        .onTapGesture { focused.wrappedValue = true }
    }

    @ViewBuilder private var field: some View {
        let ring = focused.wrappedValue ? RanchLook.sky.opacity(0.6) : Color.clear
        if #available(macOS 26.0, *) {
            Capsule().fill(RanchTheme.card)
                .overlay(Capsule().strokeBorder(ring, lineWidth: 1.5))
        } else {
            let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
            shape.fill(RanchTheme.card)
                .overlay(shape.strokeBorder(focused.wrappedValue ? ring : RanchTheme.controlEdge,
                                            lineWidth: focused.wrappedValue ? 1.5 : 0.5))
        }
    }
}

// MARK: Lists

/// A column's list of rows, one chosen at a time: click to choose, ↑ and ↓
/// to move, and the chosen row scrolled into view.
struct RanchCardList<ID: Hashable, Content: View>: View {
    @Binding var selection: ID?
    /// Every row's id, top to bottom, read when an arrow key is pressed.
    let order: () -> [ID]
    var pinnedHeaders = true
    var spacing: CGFloat = 4
    /// What ← and → do, such as opening and closing a folder.
    var sideways: ((MoveCommandDirection) -> Void)? = nil
    @ViewBuilder var content: Content
    @FocusState private var focused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: spacing, pinnedViews: pinnedHeaders ? [.sectionHeaders] : []) {
                    content
                }
                .padding(.top, 8)
                .padding(.bottom, 12)
            }
            .environment(\.ranchFocusList, { focused = true })
            .modifier(RanchListKeys(focused: $focused) { direction in
                let ids = order()
                guard !ids.isEmpty else { return }
                let current = selection.flatMap { ids.firstIndex(of: $0) }
                let next: Int
                switch direction {
                case .up: next = current.map { max(0, $0 - 1) } ?? ids.count - 1
                case .down: next = current.map { min(ids.count - 1, $0 + 1) } ?? 0
                default: sideways?(direction); return
                }
                selection = ids[next]
                proxy.scrollTo(ids[next])
            })
            // A row chosen elsewhere, such as a file opened from the sidebar, is scrolled to.
            .onChange(of: selection) { id in
                if let id { proxy.scrollTo(id) }
            }
        }
    }
}

/// Arrow keys reach the list once it has been clicked.
private struct RanchListKeys: ViewModifier {
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

struct RanchFocusListKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

extension EnvironmentValues {
    /// Gives the list around a row the keyboard, so ↑ and ↓ move from it.
    var ranchFocusList: () -> Void {
        get { self[RanchFocusListKey.self] }
        set { self[RanchFocusListKey.self] = newValue }
    }
}

struct RanchRowChosenKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True inside a row that is chosen or under the pointer; a sidebar row writes brighter then.
    var ranchRowChosen: Bool {
        get { self[RanchRowChosenKey.self] }
        set { self[RanchRowChosenKey.self] = newValue }
    }
}

/// One row of a `RanchCardList`: a soft card in a column's list, or a
/// borderless row in the sidebar, lighter while chosen.
struct RanchCard<ID: Hashable, Content: View>: View {
    enum Style { case card, sidebar }

    let id: ID
    @Binding var selection: ID?
    var style = Style.card
    /// Whether the row reads as chosen, when that is not simply `selection == id`.
    var highlighted: Bool? = nil
    /// Chosen, but second to a file chosen below it: grey, not lavender.
    var quiet = false
    /// What a double-click does, as Finder opens a file with one.
    var open: (() -> Void)? = nil
    @ViewBuilder var content: Content
    @Environment(\.ranchFocusList) private var focusList
    @State private var hovering = false

    var body: some View {
        let chosen = highlighted ?? (selection == id)
        content
            .environment(\.ranchRowChosen, chosen || hovering)
            .padding(.horizontal, style == .card ? 11 : 10)
            .padding(.vertical, style == .card ? 8 : 0)
            .frame(maxWidth: .infinity, minHeight: style == .card ? nil : 36, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: style == .card ? 12 : RanchLook.rowRadius, style: .continuous)
                .fill(chosen ? (quiet ? RanchTheme.cardHover : RanchTheme.selection) : hovering ? RanchTheme.cardHover
                      : style == .card ? RanchTheme.card : .clear))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture { choose(opening: (NSApp.currentEvent?.clickCount ?? 1) >= 2) }
            .padding(.horizontal, 10)
            .id(id)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { choose(opening: false) }
    }

    private func choose(opening: Bool) {
        focusList()
        selection = id
        if opening { open?() }
    }
}

/// A group's name over its rows, kept in view while they scroll under it.
struct RanchSectionHeader<Trailing: View>: View {
    let title: String
    var symbol: String? = nil
    var tint: Color? = nil
    var background = RanchTheme.surface
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(tint ?? RanchTheme.tertiaryInk)
            }
            Text(title).font(RanchTheme.sectionFont).foregroundStyle(RanchTheme.secondaryInk).lineLimit(1)
            Spacer(minLength: 4)
            trailing
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
    }
}

extension RanchSectionHeader where Trailing == EmptyView {
    init(title: String, symbol: String? = nil, tint: Color? = nil, background: Color = RanchTheme.surface) {
        self.init(title: title, symbol: symbol, tint: tint, background: background) { EmptyView() }
    }
}

/// A file's two lines in a list: its name, and a line about it.
struct RanchRowText: View {
    let title: String
    let caption: String
    var captionLines = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(RanchTheme.bodyFont).foregroundStyle(RanchTheme.ink).lineLimit(1).truncationMode(.middle)
            Text(caption).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
                .lineLimit(captionLines).truncationMode(captionLines == 1 ? .middle : .tail)
        }
    }
}

/// A count at the end of a row.
struct RanchCount: View {
    let value: Int
    var tint: Color? = nil

    var body: some View {
        if value > 0 {
            Text(value.formatted())
                .font(RanchLook.font(11, .medium)).monospacedDigit()
                .foregroundStyle(tint ?? RanchTheme.secondaryInk)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill((tint ?? RanchLook.ink).opacity(tint == nil ? 0.08 : 0.16)))
        }
    }
}

extension View {
    /// A dark note floating over a view, such as the file under the pointer.
    /// What it holds is written in `RanchTheme.onTooltip` colours.
    func ranchTooltip() -> some View {
        self
            .foregroundStyle(RanchTheme.onTooltip)
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(RanchTheme.tooltip))
            .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
    }
}
