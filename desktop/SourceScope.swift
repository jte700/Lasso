// Where suggestions come from, chosen with ⌥Tab: every switched-on folder and
// connected app ("All"), or one of them alone until All is chosen again. The
// menu's switches are not touched; this only narrows what the card asks for.

import Foundation
import CoreGraphics

/// One choice in the ⌥Tab switcher.
struct SourceScopeEntry: Equatable {
    /// The folder's project id, which is also its colour's key; nil for All.
    let projectId: String?
    let title: String
    /// The SF Symbol drawn beside the title, as the Lasso menu draws it.
    let symbol: String

    static let all = SourceScopeEntry(projectId: nil, title: "All", symbol: MascotMark.symbolName)
}

struct SourceScope: Equatable {
    /// All first, then the switched-on folders and apps in the menu's order.
    private(set) var entries: [SourceScopeEntry] = [.all]
    /// The folder suggestions come from alone; nil for All.
    private(set) var chosenProjectId: String?

    var chosen: SourceScopeEntry { entries.first { $0.projectId == chosenProjectId } ?? .all }
    var chosenIndex: Int { entries.firstIndex { $0.projectId == chosenProjectId } ?? 0 }

    /// The folders switched on now. A chosen one that is no longer switched
    /// on, or no longer there, goes back to All. Returns whether it did.
    @discardableResult
    mutating func update(_ folders: [SourceScopeEntry]) -> Bool {
        var seen = Set<String>()
        entries = [.all] + folders.filter { entry in
            guard let id = entry.projectId else { return false }
            return seen.insert(id).inserted
        }
        guard let chosenProjectId, !entries.contains(where: { $0.projectId == chosenProjectId }) else { return false }
        self.chosenProjectId = nil
        return true
    }

    /// Chooses the entry at `index`. Returns whether the choice changed.
    @discardableResult
    mutating func choose(at index: Int) -> Bool {
        guard entries.indices.contains(index) else { return false }
        let id = entries[index].projectId
        guard id != chosenProjectId else { return false }
        chosenProjectId = id
        return true
    }

    /// The entry `steps` away from `index`, going round past the last back to All.
    func index(from index: Int, by steps: Int) -> Int {
        let count = entries.count
        guard count > 0 else { return 0 }
        return ((index + steps) % count + count) % count
    }
}

/// Where the switcher pill goes: just below the caret line, its left edge a
/// little before the caret, above the line where there is no room below. In
/// AppKit coordinates, with `visible` the screen's visible frame.
enum ScopeSwitcherPlacement {
    static let gap: CGFloat = 6
    /// How far left of the caret the pill starts, so its first words sit near it.
    static let leadIn: CGFloat = 18

    /// `size` is the panel's; its pill sits `margin` inside each edge, the room left for its shadow.
    static func frame(caret: CGRect, size: CGSize, margin: CGFloat = 0, visible: CGRect?) -> CGRect {
        var x = caret.minX - leadIn - margin
        var y = caret.minY - gap - size.height + margin
        if let visible {
            if y + margin < visible.minY { y = caret.maxY + gap - margin }
            x = min(max(visible.minX - margin, x), visible.maxX - size.width + margin)
            y = min(max(visible.minY - margin, y), visible.maxY - size.height + margin)
        }
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }
}
