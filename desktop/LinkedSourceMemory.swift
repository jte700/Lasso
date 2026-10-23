//  What the suggestion card is focused on in the field being typed in.
//
//  Tab accepts a source, and each request names it so the server offers its
//  values while its sentence goes on. A value is as deep as a source goes:
//  once one is tabbed, the server offers the next words from every work
//  directory again. fn+Left moves out to every work
//  directory; fn+Right moves back in to the last focus or, on a card
//  already focused, into the selected row.
//
//  Each change of focus is kept as a step, and the focus is worked out again
//  from the steps and the text each request sends. Deleting text accepted with
//  Tab therefore undoes that step and the moves made on it, whatever the host
//  app: the card steps back to the focus before it, or to every directory.

import Foundation

struct LinkedSourceMemory {
    struct Source: Equatable {
        let projectId: String
        let objectId: String
        let snapshotId: String
        /// The inserted text, or the row's label for a focus chosen with fn+Right.
        let text: String
    }

    /// One change of the card's focus in this field.
    private enum Step: Equatable {
        /// Tab inserted the source; the anchor finds its text again.
        case accepted(Source, TextAnchor)
        /// fn+Right chose this focus.
        case chosen(Source)
        /// fn+Left moved out to every directory from this focus.
        case movedOut(Source?)
        /// The source whose values the server actually showed on the card.
        case displayed(Source)
    }

    /// Where an accepted text is in the window last sent.
    private enum Place: Equatable {
        case at(Range<Int>)
        case deleted
        /// Out of a window that no longer reaches it, which is not a deletion.
        case unseen
    }

    private struct Focus {
        var pending: [(source: Source, range: Range<Int>)] = []
        var chosen: Source?
        var recent: Source?
        var displayed: Source?
    }

    private static let acceptedLimit = 8
    private static let stepLimit = 32
    /// Characters of the text before an accepted phrase that show it was
    /// deleted rather than scrolled out of the window.
    private static let precedingEvidence = 12

    /// This field's steps, oldest first.
    private var steps: [Step] = []
    /// The text before the caret that the last request sent, in UTF-16 units.
    private var window: [UInt16] = []
    /// Whether that text starts at the beginning of the field.
    private var windowReachesStart = true
    /// The latest focus in earlier fields, where fn+Right returns until this field has one.
    private var earlier: Source?
    /// fn+Left or fn+Right was pressed and the writer has not typed since.
    private var moving = false

    /// Sources accepted with Tab in this field, newest last, including any
    /// whose text was deleted since.
    var sources: [Source] {
        steps.compactMap { step in
            if case .accepted(let source, _) = step { return source }
            return nil
        }
    }

    /// A focus chosen with fn+Right. The server keeps it until fn+Left.
    var chosen: Source? { focus.chosen }

    /// Where fn+Right returns from every directory: the latest focus in any field.
    var recent: Source? { focus.recent }

    /// Tab inserted `source` at `range` of `document`, the text before the caret afterwards.
    mutating func record(_ source: Source, in document: [UInt16], at range: Range<Int>, reachesStart: Bool = true) {
        let anchor = TextAnchor.make(in: document, range: range)
            ?? TextAnchor(text: source.text, prefixContext: "", suffixContext: "", approximateOffset: 0)
        window = document
        windowReachesStart = reachesStart
        steps.append(.accepted(source, anchor))
        if sources.count > Self.acceptedLimit, let oldest = steps.firstIndex(where: {
            if case .accepted = $0 { return true }
            return false
        }) {
            steps.removeSubrange(...oldest)
        }
        trim()
        moving = false
    }

    /// The text before the caret that the next request sends. `reachesStart`
    /// is false when earlier text of the field lies outside it.
    mutating func observe(_ text: String, reachesStart: Bool) {
        window = Array(text.utf16)
        windowReachesStart = reachesStart
    }

    /// Remember the card's parent source separately from an accepted value.
    /// Keeping this in the step history preserves delete-to-undo navigation.
    mutating func noteFocus(_ source: Source) {
        if case .displayed(let previous) = steps.last, previous == source { return }
        steps.append(.displayed(source))
        trim()
    }

    /// A new field starts with nothing focused.
    mutating func forget() {
        earlier = focus.recent
        steps.removeAll()
        window = []
        windowReachesStart = true
        moving = false
    }

    mutating func keep(projectIds: [String]) {
        let kept = Set(projectIds)
        steps = steps.compactMap { step in
            switch step {
            case .accepted(let source, _), .chosen(let source), .displayed(let source):
                return kept.contains(source.projectId) ? step : nil
            case .movedOut(let source):
                return .movedOut(source.flatMap { kept.contains($0.projectId) ? $0 : nil })
            }
        }
        if let earlier, !kept.contains(earlier.projectId) { self.earlier = nil }
    }

    /// fn+Left: every directory answers the next words. The source the card
    /// was focused on is where fn+Right comes back to.
    mutating func moveOut(from focused: Source?) {
        steps.append(.movedOut(focused))
        trim()
        moving = true
    }

    /// fn+Right from every directory returns to the latest focus; on a
    /// focused card it moves into the selected row, unless that row is the focus.
    func canMoveIn(focusedOn current: Source?, selected: Source?) -> Bool {
        target(focusedOn: current, selected: selected) != nil
    }

    mutating func moveIn(focusedOn current: Source?, selected: Source?) {
        guard let target = target(focusedOn: current, selected: selected) else { return }
        steps.append(.chosen(target))
        trim()
        moving = true
    }

    /// The writer typed on, so a card emptied by a move closes as usual again.
    mutating func endMove() {
        moving = false
    }

    /// Right after a move the card stays even with nothing to offer, as long
    /// as fn+Left or fn+Right can undo the move from it.
    func keepsEmptyCard(focusedOn current: Source?) -> Bool {
        moving && (current != nil || canMoveIn(focusedOn: nil, selected: nil))
    }

    private func target(focusedOn current: Source?, selected: Source?) -> Source? {
        guard let current else { return recent }
        guard let selected, selected.objectId != current.objectId else { return nil }
        return selected
    }

    /// The fields a prediction request adds for the card's focus in the
    /// text last observed.
    var requestFields: [String: Any] {
        let focus = focus
        if let chosen = focus.chosen {
            return ["focusSource": ["projectId": chosen.projectId, "sourceObjectId": chosen.objectId,
                                    "sourceSnapshotId": chosen.snapshotId]]
        }
        // Offsets are in the text being sent, so they match what the server is given.
        let pending = focus.pending.map { source, range -> [String: Any] in
            ["projectId": source.projectId, "blockIndex": 0, "start": range.lowerBound, "end": range.upperBound,
             "sourceObjectId": source.objectId, "sourceSnapshotId": source.snapshotId]
        }
        return pending.isEmpty ? [:] : ["pendingDependencies": pending]
    }

    /// The steps replayed against the window. An accepted text that was
    /// deleted takes the moves made on it along, up to the next accepted
    /// text still present.
    private var focus: Focus {
        var focus = Focus(recent: earlier)
        var undone = false
        var claimed = Set<Int>()
        for step in steps {
            switch step {
            case .accepted(let source, let anchor):
                switch place(of: anchor) {
                case .deleted:
                    undone = true
                    continue
                case .at(let range):
                    // Two accepted phrases found at one place: the later one's own text is gone.
                    guard claimed.insert(range.lowerBound).inserted else {
                        undone = true
                        continue
                    }
                    focus.pending.append((source, range))
                case .unseen:
                    break
                }
                undone = false
                focus.chosen = nil
                focus.recent = focus.displayed ?? source
            case .displayed(let source) where !undone:
                focus.recent = source
                focus.displayed = source
            case .chosen(let source) where !undone:
                focus.chosen = source
                focus.recent = source
                focus.displayed = source
            case .movedOut(let source) where !undone:
                focus.pending.removeAll()
                focus.chosen = nil
                if let source { focus.recent = source }
            default:
                break
            }
        }
        return focus
    }

    private func place(of anchor: TextAnchor) -> Place {
        switch TextAnchorResolver.resolve(anchor, in: window) {
        case .resolved(let range):
            return .at(range)
        case .unresolved(.ambiguous):
            // Repeats its context cannot tell apart: the latest is the one being written about.
            let needle = Array(anchor.text.utf16)
            guard let start = TextAnchorResolver.indices(of: needle, in: window).last else { return .deleted }
            return .at(start..<(start + needle.count))
        case .unresolved(.textMissing):
            let preceding = Array(anchor.prefixContext.utf16.suffix(Self.precedingEvidence))
            let precededInWindow = !preceding.isEmpty && !TextAnchorResolver.indices(of: preceding, in: window).isEmpty
            return windowReachesStart || precededInWindow ? .deleted : .unseen
        }
    }

    private mutating func trim() {
        if steps.count > Self.stepLimit { steps.removeFirst(steps.count - Self.stepLimit) }
    }
}
