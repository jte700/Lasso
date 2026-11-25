// The pieces every view in The Loop draws with: its colours and type, which
// come from the website rework's dark look (LoopLook.swift), rows as soft
// cards on the page, and capsule controls.

import Cocoa
import SwiftUI

enum LoopTheme {
    // MARK: Colours

    /// Behind the sidebar's rows: clear, so its panel shows.
    static let sidebar = Color.clear
    /// The list and file columns, and the window behind them.
    static let surface = LoopLook.page
    static let nsSurface = LoopLook.nsPage
    /// A row at rest, and the ground under models and drawings.
    static let card = LoopLook.rgb(0xF6F4EC, 0.05)
    static let cardHover = LoopLook.rgb(0xF6F4EC, 0.085)
    /// The chosen row: a lighter panel, as the sidebar's chosen view is.
    static let selection = LoopLook.rgb(0xF6F4EC, 0.15)
    static let hairline = LoopLook.line
    /// Fields and menus where glass is not used.
    static let control = LoopLook.raise
    static let controlEdge = LoopLook.line
    /// The groove a segmented control's choices sit in.
    static let track = LoopLook.track
    static let ink = LoopLook.ink
    static let secondaryInk = LoopLook.ink2
    static let tertiaryInk = LoopLook.ink3
    /// The one strong button, filled with the page's ink, and what is written on it.
    static let strong = LoopLook.ink
    static let onStrong = LoopLook.onInk
    /// Notes that float over a view, such as what the pointer is on.
    static let tooltip = LoopLook.lift
    static let onTooltip = LoopLook.ink
    static let onTooltipSecondary = LoopLook.ink2
    static let warning = LoopLook.rgb(0xE08A5F)

    // MARK: Type

    static let brandFont = LoopLook.font(19, .semibold)
    static let titleFont = LoopLook.font(14.5, .semibold)
    static let bodyFont = LoopLook.font(13.5)
    static let captionFont = LoopLook.font(12)
    static let controlFont = LoopLook.font(12.5, .medium)
    static let sectionFont = LoopLook.font(12, .semibold)

    /// The column headers' height: the window's buttons sit halfway down the sidebar's.
    static let headerHeight: CGFloat = 52
    /// The title bar band at the top of the sidebar, where the window's buttons are.
    static var titlebarHeight: CGFloat { LoopGlass.isAvailable ? 52 : 38 }
}

// MARK: Window chrome

/// Dragging an empty part of a header moves the window, as its title bar
/// would, and double-clicking zooms it.
struct LoopWindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { TitlebarDragView() }
    func updateNSView(_ view: NSView, context: Context) {}
}

/// A column's name and a line about it, with its controls on the right.
struct LoopColumnHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var trailing: Trailing
    /// Set on the leftmost column while the sidebar is hidden.
    @Environment(\.loopShowSidebar) private var showSidebar

    var body: some View {
        HStack(spacing: 10) {
            if let showSidebar {
                // Clear of the window's own buttons.
                Spacer().frame(width: LoopGlass.isAvailable ? LoopGlass.windowButtonsWidth : 62)
                Button(action: showSidebar) { Image(systemName: "sidebar.left") }
                    .buttonStyle(LoopIconButtonStyle())
                    .help("Show Sidebar (\u{2303}\u{2318}S)")
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(LoopTheme.titleFont).foregroundStyle(LoopTheme.ink).lineLimit(1)
                Text(subtitle).font(LoopTheme.captionFont).foregroundStyle(LoopTheme.secondaryInk)
                    .lineLimit(1).truncationMode(.tail)
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            trailing.environment(\.loopToolbar, true)
        }
        .padding(.horizontal, 16)
        .frame(height: LoopTheme.headerHeight)
        .background(LoopWindowDragArea())
        .overlay(alignment: .bottom) { LoopHairline() }
    }
}

extension LoopColumnHeader where Trailing == EmptyView {
    init(title: String, subtitle: String) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

/// The row of menus and choices under a column's header.
struct LoopFilterBar<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 6) {
            content
            Spacer(minLength: 0)
        }
        .environment(\.loopToolbar, true)
        .padding(.horizontal, 12)
        .frame(height: 42)
        .overlay(alignment: .bottom) { LoopHairline() }
    }
}

struct LoopHairline: View {
    var vertical = false
    var body: some View {
        LoopTheme.hairline.frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

/// A hairline between two columns that drags to resize the one on its left.
struct LoopColumnDivider: View {
    @Binding var width: Double
    let range: ClosedRange<Double>
    /// Off beside the floating glass sidebar, whose own edge parts the columns.
    var showsLine = true
    @State private var start: Double?

    var body: some View {
        LoopHairline(vertical: true)
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

struct LoopShowSidebarKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    /// Shows the hidden sidebar; nil while it shows, or outside the leftmost column.
    var loopShowSidebar: (() -> Void)? {
        get { self[LoopShowSidebarKey.self] }
        set { self[LoopShowSidebarKey.self] = newValue }
    }
}

// MARK: Controls

/// A capsule button: glass in a column header on macOS 26, bordered elsewhere;
/// prominent, the window's one accent-coloured button.
struct LoopPillButtonStyle: PrimitiveButtonStyle {
    var prominent = false
    var height: CGFloat = 28

    func makeBody(configuration: Configuration) -> some View {
        Button(configuration)
            .labelStyle(LoopPillLabelStyle())
            .modifier(LoopNativeButton(prominent: prominent))
            .controlSize(height > 30 ? .large : .regular)
    }
}

/// The capsule a menu's label sits on: glass on macOS 26, a bordered pill before.
struct LoopPillShape: View {
    var prominent = false
    var hovering = false

    var body: some View {
        if #available(macOS 26.0, *) {
            Capsule().fill(Color.clear)
                .glassEffect(prominent ? .regular.tint(LoopLook.ink) : .regular, in: Capsule())
        } else {
            let shape = Capsule()
            if prominent {
                shape.fill(LoopTheme.strong).opacity(hovering ? 0.88 : 1)
            } else {
                shape.fill(hovering ? LoopTheme.cardHover : LoopTheme.control)
                    .overlay(shape.strokeBorder(LoopTheme.controlEdge, lineWidth: 1))
            }
        }
    }
}

/// Icon and title close together.
struct LoopPillLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

/// A square icon for header actions: a glass circle in a column header on
/// macOS 26, otherwise borderless and greyed in on hover.
struct LoopIconButtonStyle: PrimitiveButtonStyle {
    var size: CGFloat = 28

    func makeBody(configuration: Configuration) -> some View {
        LoopIconButton(configuration: configuration, size: size)
    }
}

private struct LoopIconButton: View {
    let configuration: PrimitiveButtonStyleConfiguration
    let size: CGFloat
    @Environment(\.loopToolbar) private var toolbar

    var body: some View {
        if #available(macOS 26.0, *), toolbar {
            Button(configuration)
                .labelStyle(.iconOnly)
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
        } else {
            Button(configuration).buttonStyle(LoopBorderlessIconStyle(size: size))
        }
    }
}

private struct LoopBorderlessIconStyle: ButtonStyle {
    let size: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        LoopIconBody(configuration: configuration, size: size)
    }
}

private struct LoopIconBody: View {
    let configuration: ButtonStyleConfiguration
    let size: CGFloat
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 13.5, weight: .regular))
            .foregroundStyle(hovering && isEnabled ? LoopTheme.ink : LoopTheme.secondaryInk)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(configuration.isPressed ? LoopTheme.cardHover : hovering && isEnabled ? LoopTheme.card : .clear))
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// A capsule that opens a menu: its icon, what is chosen, and a chevron.
struct LoopPillMenu<Items: View>: View {
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
                if let symbol { Image(systemName: symbol).imageScale(.small).foregroundStyle(LoopTheme.secondaryInk) }
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(LoopTheme.secondaryInk)
            }
            .font(LoopTheme.controlFont)
            .foregroundStyle(LoopTheme.ink)
            .padding(.horizontal, 11)
            .frame(height: 28)
            .loopControlBackground(hovering: hovering)
            .contentShape(Capsule())
        }
        .modifier(LoopPlainMenuStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .onHover { hovering = $0 }
        .help(help)
    }
}

/// A menu drawn by its own label. A plain SwiftUI label needs macOS 14;
/// macOS 13 keeps the borderless pop-up, made small.
struct LoopPlainMenuStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 14, *) {
            content.menuStyle(.button).buttonStyle(.plain)
        } else {
            content.menuStyle(.borderlessButton).controlSize(.small)
        }
    }
}

/// Choices side by side: the system's segmented control.
struct LoopSegmented<Value: Hashable>: View {
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
struct LoopSearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let prompt: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(LoopTheme.secondaryInk)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(LoopTheme.bodyFont)
                .foregroundStyle(LoopTheme.ink)
                .focused(focused)
                .onExitCommand { text = ""; focused.wrappedValue = false }
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(LoopTheme.tertiaryInk)
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
        let ring = focused.wrappedValue ? LoopLook.sky.opacity(0.6) : Color.clear
        if #available(macOS 26.0, *) {
            Capsule().fill(LoopTheme.card)
                .overlay(Capsule().strokeBorder(ring, lineWidth: 1.5))
        } else {
            let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
            shape.fill(LoopTheme.card)
                .overlay(shape.strokeBorder(focused.wrappedValue ? ring : LoopTheme.controlEdge,
                                            lineWidth: focused.wrappedValue ? 1.5 : 0.5))
        }
    }
}

// MARK: Lists

/// A column's list of rows, one chosen at a time: click to choose, ↑ and ↓
/// to move, and the chosen row scrolled into view.
struct LoopCardList<ID: Hashable, Content: View>: View {
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
            .environment(\.loopFocusList, { focused = true })
            .modifier(LoopListKeys(focused: $focused) { direction in
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
private struct LoopListKeys: ViewModifier {
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

struct LoopFocusListKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

extension EnvironmentValues {
    /// Gives the list around a row the keyboard, so ↑ and ↓ move from it.
    var loopFocusList: () -> Void {
        get { self[LoopFocusListKey.self] }
        set { self[LoopFocusListKey.self] = newValue }
    }
}

struct LoopRowChosenKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True inside a row that is chosen or under the pointer; a sidebar row writes brighter then.
    var loopRowChosen: Bool {
        get { self[LoopRowChosenKey.self] }
        set { self[LoopRowChosenKey.self] = newValue }
    }
}

/// One row of a `LoopCardList`: a soft card in a column's list, or a
/// borderless row in the sidebar, lighter while chosen.
struct LoopCard<ID: Hashable, Content: View>: View {
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
    @Environment(\.loopFocusList) private var focusList
    @State private var hovering = false

    var body: some View {
        let chosen = highlighted ?? (selection == id)
        content
            .environment(\.loopRowChosen, chosen || hovering)
            .padding(.horizontal, style == .card ? 11 : 10)
            .padding(.vertical, style == .card ? 8 : 0)
            .frame(maxWidth: .infinity, minHeight: style == .card ? nil : 36, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: style == .card ? 12 : LoopLook.rowRadius, style: .continuous)
                .fill(chosen ? (quiet ? LoopTheme.cardHover : LoopTheme.selection) : hovering ? LoopTheme.cardHover
                      : style == .card ? LoopTheme.card : .clear))
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
struct LoopSectionHeader<Trailing: View>: View {
    let title: String
    var symbol: String? = nil
    var tint: Color? = nil
    var background = LoopTheme.surface
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(tint ?? LoopTheme.tertiaryInk)
            }
            Text(title).font(LoopTheme.sectionFont).foregroundStyle(LoopTheme.secondaryInk).lineLimit(1)
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

extension LoopSectionHeader where Trailing == EmptyView {
    init(title: String, symbol: String? = nil, tint: Color? = nil, background: Color = LoopTheme.surface) {
        self.init(title: title, symbol: symbol, tint: tint, background: background) { EmptyView() }
    }
}

/// A file's two lines in a list: its name, and a line about it.
struct LoopRowText: View {
    let title: String
    let caption: String
    var captionLines = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(LoopTheme.bodyFont).foregroundStyle(LoopTheme.ink).lineLimit(1).truncationMode(.middle)
            Text(caption).font(LoopTheme.captionFont).foregroundStyle(LoopTheme.secondaryInk)
                .lineLimit(captionLines).truncationMode(captionLines == 1 ? .middle : .tail)
        }
    }
}

/// A count at the end of a row.
struct LoopCount: View {
    let value: Int
    var tint: Color? = nil

    var body: some View {
        if value > 0 {
            Text(value.formatted())
                .font(LoopLook.font(11, .medium)).monospacedDigit()
                .foregroundStyle(tint ?? LoopTheme.secondaryInk)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill((tint ?? LoopLook.ink).opacity(tint == nil ? 0.08 : 0.16)))
        }
    }
}

extension View {
    /// A dark note floating over a view, such as the file under the pointer.
    /// What it holds is written in `LoopTheme.onTooltip` colours.
    func loopTooltip() -> some View {
        self
            .foregroundStyle(LoopTheme.onTooltip)
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(LoopTheme.tooltip))
            .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
    }
}
