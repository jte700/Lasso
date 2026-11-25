// The rows of The Loop's sidebar, drawn as a file tree after BeUI's motion
// file tree: rows in muted ink that brighten under the pointer, one pill that
// glides from row to row after the pointer, chevrons and folder icons that
// turn on springs, guide lines down each open folder, and rows that drop into
// place when a folder opens while the rows below slide to make room.

import Cocoa
import SwiftUI

enum LoopTreeStyle {
    static let rowHeight: CGFloat = 30
    /// Each level of the tree sits this much further in.
    static let indent: CGFloat = 18
    /// Room before a top-level row's chevron.
    static let lead: CGFloat = 8
    /// The chevron's and the icon's square.
    static let slot: CGFloat = 16
    static let gap: CGFloat = 8
    /// The chosen row: a darker well in the window's material.
    static let fill = Color.black.opacity(0.28)
    /// A chosen row second to a file chosen below it.
    static let quietFill = Color.black.opacity(0.14)
    /// The pill under the pointer.
    static let hoverFill = Color.white.opacity(0.06)
    /// Words at rest, a little quieter than chosen ones.
    static let restInk = LoopLook.rgb(0xF6F4EC, 0.8)
    /// Content trading places: a chevron turning, a folder opening.
    static let swap = Animation.spring(response: 0.22, dampingFraction: 0.94)
    /// Rows sliding to make room, and the pill gliding between rows.
    static let layout = Animation.spring(response: 0.26, dampingFraction: 1)
    /// A row dropping into place, and a guide line drawing down.
    static let enter = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.22)
    static let draw = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.3)
    /// Rows shown this soon after a folder opened drop in; others are simply there.
    static let freshness: TimeInterval = 0.45

    /// Where the guide line for a level runs: under that level's chevron.
    static func guide(_ level: Int) -> CGFloat { lead + slot / 2 + CGFloat(level) * indent }
}

/// Which row the pointer is on, shared by every row so one pill can glide between them.
final class LoopTreeHover: ObservableObject {
    @Published private(set) var row: AnyHashable?

    func enter(_ id: AnyHashable) {
        withAnimation(LoopTreeStyle.layout) { row = id }
    }

    /// Waits a moment first: moving to the next row, the pointer leaves one
    /// row before it enters the other, and the pill should glide, not blink.
    func leave(_ id: AnyHashable) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in
            guard let self, self.row == id else { return }
            withAnimation(.easeOut(duration: 0.18)) { self.row = nil }
        }
    }
}

struct LoopTreeContext {
    let hover: LoopTreeHover
    let space: Namespace.ID
}

struct LoopTreeContextKey: EnvironmentKey {
    static let defaultValue: LoopTreeContext? = nil
}

extension EnvironmentValues {
    /// The sidebar's shared hover pill; nil outside a tree.
    var loopTree: LoopTreeContext? {
        get { self[LoopTreeContextKey.self] }
        set { self[LoopTreeContextKey.self] = newValue }
    }
}

/// One row of the tree: a chevron for what opens, an icon, a name and what
/// sits at its end. A click chooses it; `turn` opens or closes it.
struct LoopTreeRow<ID: Hashable, Icon: View, Trailing: View>: View {
    let id: ID
    let title: String
    var depth = 0
    /// Whether it is open, for a row with something under it; nil otherwise.
    var open: Bool? = nil
    /// Whether the row keeps a place for a chevron, so it lines up with the tree; views and actions do not.
    var chevron = true
    var chosen = false
    /// Chosen, but second to a file chosen below it.
    var quiet = false
    /// When rows were last shown or hidden under a folder, and where this one sits among them.
    var entered = Date.distantPast
    var position = 0
    /// What a click does; true for a double-click.
    let click: (Bool) -> Void
    /// Opens or closes it, from its chevron; nil where it cannot be turned now.
    var turn: (() -> Void)? = nil
    /// The icon, told whether the row is lit (chosen or under the pointer).
    @ViewBuilder var icon: (Bool) -> Icon
    @ViewBuilder var trailing: Trailing
    @Environment(\.loopTree) private var tree
    @Environment(\.loopFocusList) private var focusList
    @State private var hovering = false

    var body: some View {
        let lit = (chosen && !quiet) || hovering
        HStack(spacing: LoopTreeStyle.gap) {
            if chevron { LoopTreeChevron(open: open ?? false, hidden: open == nil, turn: turn) }
            icon(lit).frame(width: LoopTreeStyle.slot, height: LoopTreeStyle.slot)
                .padding(.trailing, chevron ? 0 : 2)
            Text(title)
                .font(LoopLook.font(13.5, chosen && !quiet ? .medium : .regular))
                .foregroundStyle(lit ? LoopTheme.ink : LoopTreeStyle.restInk)
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            trailing
        }
        .animation(.easeOut(duration: 0.15), value: lit)
        .padding(.leading, LoopTreeStyle.lead + CGFloat(depth) * LoopTreeStyle.indent)
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity, minHeight: LoopTreeStyle.rowHeight, maxHeight: LoopTreeStyle.rowHeight)
        .background { ground }
        .contentShape(Rectangle())
        .onHover { inside in
            hovering = inside
            guard let tree else { return }
            if inside { tree.hover.enter(AnyHashable(id)) } else { tree.hover.leave(AnyHashable(id)) }
        }
        .onTapGesture {
            focusList()
            click((NSApp.currentEvent?.clickCount ?? 1) >= 2)
        }
        .modifier(LoopTreeEnter(entered: entered, position: position))
        .padding(.horizontal, 10)
        .id(id)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { click(false) }
        .modifier(LoopTreeTurnAction(open: open, turn: turn))
    }

    /// Under the row: the chosen fill, the pill when the pointer is here, and
    /// a guide line for each folder it is inside.
    private var ground: some View {
        ZStack(alignment: .leading) {
            if chosen {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(quiet ? LoopTreeStyle.quietFill : LoopTreeStyle.fill)
            }
            if let tree {
                LoopTreePill(hover: tree.hover, id: AnyHashable(id), space: tree.space)
            }
            if depth > 0 {
                LoopTreeGuides(depth: depth, entered: entered)
            }
        }
    }
}

/// The pill under the pointer's row. Only the row it is on draws it, so it
/// glides from row to row as one.
private struct LoopTreePill: View {
    @ObservedObject var hover: LoopTreeHover
    let id: AnyHashable
    let space: Namespace.ID

    var body: some View {
        if hover.row == id {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(LoopTreeStyle.hoverFill)
                .matchedGeometryEffect(id: "loop-tree-pill", in: space)
                .transition(.opacity)
        }
    }
}

/// The lines down the left of a row, one under each folder it is inside,
/// which join from row to row into one line per open folder.
private struct LoopTreeGuides: View {
    let depth: Int
    @State private var drawn: Bool
    private let entered: Date

    init(depth: Int, entered: Date) {
        self.depth = depth
        self.entered = entered
        _drawn = State(initialValue: !LoopTreeEnter.isFresh(entered))
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(0..<depth, id: \.self) { level in
                LoopLook.line
                    .frame(width: 1)
                    .offset(x: LoopTreeStyle.guide(level) - 0.5)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .scaleEffect(x: 1, y: drawn ? 1 : 0, anchor: .top)
        .opacity(drawn ? 1 : 0)
        .allowsHitTesting(false)
        .onAppear {
            guard !drawn else { return }
            withAnimation(LoopTreeStyle.draw) { drawn = true }
        }
    }
}

/// A row shown as its folder opens drops a few points into place, each a
/// moment after the one above it.
struct LoopTreeEnter: ViewModifier {
    let position: Int
    @State private var shown: Bool

    init(entered: Date, position: Int) {
        self.position = position
        _shown = State(initialValue: !Self.isFresh(entered))
    }

    static func isFresh(_ entered: Date) -> Bool {
        Date().timeIntervalSince(entered) < LoopTreeStyle.freshness
            && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : -6)
            .onAppear {
                guard !shown else { return }
                withAnimation(LoopTreeStyle.enter.delay(min(Double(position) * 0.025, 0.1))) { shown = true }
            }
    }
}

/// The arrow before a row that opens: it turns a quarter as its folder opens.
struct LoopTreeChevron: View {
    let open: Bool
    /// Kept in place, unseen, so rows with and without one line up.
    let hidden: Bool
    let turn: (() -> Void)?

    var body: some View {
        Button { turn?() } label: {
            LoopLucideIcon(icon: .chevronRight, size: 14, color: LoopTheme.tertiaryInk)
                .rotationEffect(.degrees(open ? 90 : 0))
                .animation(LoopTreeStyle.swap, value: open)
                .frame(width: LoopTreeStyle.slot, height: LoopTreeStyle.slot)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Without a turn of its own, a click on it is a click on the row.
        .allowsHitTesting(!hidden && turn != nil)
        .opacity(hidden ? 0 : 1)
        .accessibilityHidden(true)
    }
}

/// A folder that opens as its row does, Lucide's shut folder giving way to
/// its open one, the one turning and shrinking away as the other turns in.
struct LoopTreeFolderIcon: View {
    let open: Bool
    let tint: Color

    var body: some View {
        ZStack {
            LoopLucideIcon(icon: open ? .folderOpen : .folder, color: tint)
                .id(open)
                .transition(.asymmetric(
                    insertion: .modifier(active: LoopTreeSwap(angle: -8, scale: 0.75, opacity: 0), identity: .resting),
                    removal: .modifier(active: LoopTreeSwap(angle: 8, scale: 0.75, opacity: 0), identity: .resting)))
        }
        .animation(LoopTreeStyle.swap, value: open)
    }
}

private struct LoopTreeSwap: ViewModifier {
    let angle: Double
    let scale: CGFloat
    let opacity: Double

    static let resting = LoopTreeSwap(angle: 0, scale: 1, opacity: 1)

    func body(content: Content) -> some View {
        content.rotationEffect(.degrees(angle)).scaleEffect(scale).opacity(opacity)
    }
}

/// VoiceOver's Expand and Collapse, for a row that opens.
private struct LoopTreeTurnAction: ViewModifier {
    let open: Bool?
    let turn: (() -> Void)?

    func body(content: Content) -> some View {
        if let open, let turn {
            content.accessibilityAction(named: open ? "Collapse" : "Expand", turn)
        } else {
            content
        }
    }
}
