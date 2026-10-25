// The Ranch's look: flat, warm off-white surfaces split by hairlines, rows
// as soft cards, and pill-shaped controls, in light and dark. Every view in
// the window draws with these colours and pieces rather than system chrome.

import Cocoa
import SwiftUI

enum RanchTheme {
    // MARK: Colours

    /// The sidebar, a shade under the columns beside it.
    static let sidebar = color(0xF6F6F4, 0x1A1A19)
    /// The list and file columns, and the window behind them.
    static let surface = color(0xFCFCFB, 0x1F1F1E)
    static let nsSurface = nsColor(0xFCFCFB, 0x1F1F1E)
    /// A row at rest, and the ground under models and drawings.
    static let card = color(0xF2F2F0, 0x292928)
    static let cardHover = color(0xEBEBE8, 0x30302F)
    /// The chosen row: a soft lavender, never the accent's solid blue.
    static let selection = color(0xE4E6F1, 0x31354A)
    static let hairline = color(0xE5E5E2, 0x323231)
    /// Buttons, menus and the search field.
    static let control = color(0xFFFFFF, 0x2A2A29)
    static let controlEdge = color(0xDEDEDB, 0x3B3B3A)
    /// The groove a segmented control's choices sit in.
    static let track = color(0xEEEEEC, 0x262625)
    static let ink = color(0x1D1D1F, 0xF2F2F0)
    static let secondaryInk = color(0x6E6E73, 0xA1A1A5)
    static let tertiaryInk = color(0xA3A3A7, 0x6D6D71)
    /// The one strong button, and what is written on it.
    static let strong = color(0x1D1D1F, 0xF2F2F0)
    static let onStrong = color(0xFFFFFF, 0x1D1D1F)
    /// Notes that float over a view, such as what the pointer is on.
    static let tooltip = color(0x1D1D1F, 0x3A3A3C)
    static let onTooltip = Color.white
    static let onTooltipSecondary = Color.white.opacity(0.62)
    static let warning = color(0xD9730D, 0xF0913A)

    // MARK: Type

    static let brandFont = Font.system(size: 17, weight: .semibold)
    static let titleFont = Font.system(size: 14, weight: .semibold)
    static let bodyFont = Font.system(size: 13)
    static let captionFont = Font.system(size: 11.5)
    static let controlFont = Font.system(size: 12, weight: .medium)
    static let sectionFont = Font.system(size: 11.5, weight: .semibold)

    /// The column headers' height: the window's buttons sit halfway down the sidebar's.
    static let headerHeight: CGFloat = 52
    /// The title bar band at the top of the sidebar, where the window's buttons are.
    static let titlebarHeight: CGFloat = 32

    private static func color(_ light: Int, _ dark: Int) -> Color { Color(nsColor: nsColor(light, dark)) }

    private static func nsColor(_ light: Int, _ dark: Int) -> NSColor {
        NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
    }
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
                Spacer().frame(width: 62)
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
            trailing
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
    @State private var start: Double?

    var body: some View {
        RanchHairline(vertical: true)
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

/// A white pill with a hairline edge, or, prominent, the window's one black button.
struct RanchPillButtonStyle: ButtonStyle {
    var prominent = false
    var height: CGFloat = 28

    func makeBody(configuration: Configuration) -> some View {
        RanchPillBody(configuration: configuration, prominent: prominent, height: height)
    }
}

private struct RanchPillBody: View {
    let configuration: ButtonStyleConfiguration
    let prominent: Bool
    let height: CGFloat
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        configuration.label
            .font(RanchTheme.controlFont)
            .labelStyle(RanchPillLabelStyle())
            .foregroundStyle(prominent ? RanchTheme.onStrong : RanchTheme.ink)
            .padding(.horizontal, 11)
            .frame(height: height)
            .background(RanchPillShape(prominent: prominent, hovering: hovering || configuration.isPressed))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .onHover { hovering = $0 }
    }
}

/// The pill a button or menu sits on.
struct RanchPillShape: View {
    var prominent = false
    var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        if prominent {
            shape.fill(RanchTheme.strong).opacity(hovering ? 0.88 : 1)
        } else {
            shape.fill(hovering ? RanchTheme.card : RanchTheme.control)
                .overlay(shape.strokeBorder(RanchTheme.controlEdge, lineWidth: 1))
                .shadow(color: .black.opacity(0.03), radius: 1, y: 1)
        }
    }
}

/// Icon and title close together, as the pills in the reference read.
struct RanchPillLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

/// A borderless square icon that greys in on hover, for header actions.
struct RanchIconButtonStyle: ButtonStyle {
    var size: CGFloat = 28

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

/// A pill that opens a menu: its icon, what is chosen, and a chevron.
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
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(RanchPillShape(hovering: hovering))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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

/// Choices side by side in a groove, the chosen one raised in white.
struct RanchSegmented<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(value: Value, title: String)]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.value) { option in
                let chosen = option.value == selection
                Button { selection = option.value } label: {
                    Text(option.title)
                        .font(RanchTheme.controlFont)
                        .foregroundStyle(chosen ? RanchTheme.ink : RanchTheme.secondaryInk)
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background {
                            if chosen {
                                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(RanchTheme.control)
                                    .shadow(color: .black.opacity(0.08), radius: 1.5, y: 1)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(chosen ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(RanchTheme.track))
    }
}

/// The sidebar's search field: a rounded white box with a magnifier.
struct RanchSearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let prompt: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(RanchTheme.tertiaryInk)
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
        .background {
            let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
            shape.fill(RanchTheme.control)
                .overlay(shape.strokeBorder(focused.wrappedValue ? Color.accentColor.opacity(0.55) : RanchTheme.controlEdge,
                                            lineWidth: focused.wrappedValue ? 1.5 : 1))
        }
        .contentShape(Rectangle())
        .onTapGesture { focused.wrappedValue = true }
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

/// One row of a `RanchCardList`: a soft card in a column's list, or a
/// borderless row in the sidebar, lavender while chosen.
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
            .padding(.horizontal, style == .card ? 11 : 8)
            .padding(.vertical, style == .card ? 8 : 0)
            .frame(maxWidth: .infinity, minHeight: style == .card ? nil : 30, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: style == .card ? 10 : 7, style: .continuous)
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
                .font(.system(size: 11, weight: .medium)).monospacedDigit()
                .foregroundStyle(tint ?? RanchTheme.tertiaryInk)
                .padding(.horizontal, tint == nil ? 0 : 6)
                .padding(.vertical, tint == nil ? 0 : 1)
                .background { if let tint { Capsule().fill(tint.opacity(0.14)) } }
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
