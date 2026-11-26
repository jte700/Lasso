// ⌥Tab held down: the switcher's pill grows into a list of the switched-on
// folders and apps, All first, so one can be picked at a glance instead of
// rolling through them. ↑ and ↓ move the highlight, Return or a click keeps
// the folder, Escape leaves the choice as it was. Past ten folders it lists
// the five used most (SourceScope.listIndexes) and says so at its foot.

import Cocoa
import SwiftUI

/// One row of the list: an entry, by its index in the scope's entries.
struct ScopeListRow: Equatable, Identifiable {
    let index: Int
    let entry: SourceScopeEntry
    /// Suggestions come from this one now.
    let isChosen: Bool

    var id: Int { index }
}

/// What the list shows: its rows, the one highlighted, and a note when it leaves folders out.
struct ScopeList: Equatable {
    let rows: [ScopeListRow]
    /// The highlighted row, as a position in `rows`.
    var highlighted: Int
    let note: String?

    /// The highlight `steps` rows on, going round past either end.
    func moved(by steps: Int) -> ScopeList {
        guard !rows.isEmpty else { return self }
        var next = self
        next.highlighted = ((highlighted + steps) % rows.count + rows.count) % rows.count
        return next
    }

    /// The note a list of the five used most carries.
    static func trimmedNote(shown: Int, of total: Int) -> String {
        "The \(shown) used most of \(total). Tap \u{2325}Tab to roll through all."
    }
}

struct ScopeListView: View {
    let list: ScopeList
    /// A row clicked, by its position.
    let pick: (Int) -> Void
    /// The pointer over a row, by its position.
    let hover: (Int) -> Void

    static let width: CGFloat = 310
    static let rowHeight: CGFloat = 30
    static let headerHeight: CGFloat = 30
    static let noteHeight: CGFloat = 30
    static let inset: CGFloat = 6
    static let cornerRadius: CGFloat = 16

    /// The list's height for `rows` rows, with or without its note.
    static func height(rows: Int, hasNote: Bool) -> CGFloat {
        headerHeight + CGFloat(rows) * rowHeight + inset * 2 + (hasNote ? noteHeight : 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(ScopeSwitcherRow.folders.label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .frame(height: Self.headerHeight, alignment: .bottomLeading)
            ForEach(Array(list.rows.enumerated()), id: \.element.id) { position, row in
                ScopeListRowView(row: row, highlighted: position == list.highlighted)
                    .contentShape(Rectangle())
                    .onTapGesture { pick(position) }
                    .onHover { inside in if inside { hover(position) } }
            }
            if let note = list.note {
                Text(note)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .padding(.horizontal, 12)
                    .frame(height: Self.noteHeight, alignment: .leading)
            }
        }
        .padding(Self.inset)
        .frame(width: Self.width, height: Self.height(rows: list.rows.count, hasNote: list.note != nil), alignment: .topLeading)
        .modifier(ScopeSwitcherSurface(shape: RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)))
        .animation(.spring(response: 0.22, dampingFraction: 0.86), value: list.highlighted)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ScopeSwitcherRow.folders.label)
    }
}

private struct ScopeListRowView: View {
    let row: ScopeListRow
    let highlighted: Bool

    var body: some View {
        HStack(spacing: ScopeSwitcherView.symbolGap) {
            ScopeEntryLabel(entry: row.entry)
            Spacer(minLength: 8)
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .opacity(row.isChosen ? 1 : 0)
                .frame(width: 14)
        }
        .padding(.horizontal, 10)
        .frame(height: ScopeListView.rowHeight)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.primary.opacity(highlighted ? 0.1 : 0)))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(highlighted ? .isSelected : [])
    }
}

/// The panel's content: the pill, or the list it grows into while ⌥Tab is held.
struct ScopeSwitcherRoot: View {
    @ObservedObject var model: ScopeSwitcherModel
    let margin: CGFloat
    let pick: (Int) -> Void
    let hover: (Int) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let list = model.list {
                ScopeListView(list: list, pick: pick, hover: hover)
                    .transition(grow)
            } else {
                ScopeSwitcherView(model: model)
                    .transition(.opacity)
            }
        }
        .padding(margin)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.82),
                   value: model.list == nil)
    }

    /// The list grows out of the pill's corner by the caret.
    private var grow: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.92, anchor: .topLeading))
    }
}

/// Clicks reach the list on the first press, though the panel never becomes key.
final class ScopeSwitcherHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
