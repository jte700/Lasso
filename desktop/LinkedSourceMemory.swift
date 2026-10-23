//  What the suggestion card is focused on in the field being typed in.
//
//  Tab accepts a source, and each request names it so the server offers its
//  values while its sentence goes on. A value is as deep as a source goes:
//  once one is tabbed, the server offers the next words from every work
//  directory again. fn+Right narrows the card one level: on a focused card
//  into the selected row, and from every directory back into the last focus.
//  fn+Left steps back one level, so the list fn+Right narrowed comes back: a
//  row chosen with fn+Right gives way to the focus it was chosen on, and a
//  source accepted with Tab to what the card showed before that Tab, until
//  every directory answers.
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
        /// fn+Right narrowed the card to this focus.
        case chosen(Source)
        /// fn+Left stepped back one level from this focus.
        case movedOut(Source?)
        /// The source whose values the server actually showed on the card, or
        /// nil for suggestions from every directory.
        case displayed(Source?)
    }

    /// Where an accepted text is in the window last sent.
    private enum Place: Equatable {
        case at(Range<Int>)
        case deleted
        /// Out of a window that no longer reaches it, which is not a deletion.
        case unseen
    }

    /// One level fn+Left can step back from, with the card's focus beneath
    /// it: what the card showed when it was chosen or accepted.
    private struct Level {
        let source: Source
        let beneath: Source?
        /// The step that made it.
        let step: Int
    }

    private struct Focus {
        /// Accepted sources in the window, each with the focuses chosen with
        /// fn+Right that its Tab replaced, which fn+Left out of it brings back.
        var pending: [(level: Level, range: Range<Int>, replaced: [Level])] = []
        /// Focuses chosen with fn+Right, innermost last. They stand in for the accepted sources.
        var chosen: [Level] = []
        var recent: Source?
        var displayed: Source?
    }

    /// The steps replayed against the window.
    private struct Replay {
        var focus: Focus
        /// Steps a deletion undid.
        var undone: Set<Int> = []
        /// The step each fn+Left stepped back out of, by the fn+Left's own step.
        var steppedOut: [Int: Int] = [:]
    }

    private static let acceptedLimit = 8
    private static let stepLimit = 64
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
    var chosen: Source? { focus.chosen.last?.source }

    /// Where fn+Left steps back to from a focused card: the focus beneath, or
    /// nil for every directory.
    var stepBack: Source? {
        let focus = focus
        if let level = focus.chosen.last { return level.beneath }
        return focus.pending.last?.level.beneath
    }

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

    /// Remember what the card showed: a source's values, or every directory
    /// for nil. It is the parent of the next value accepted, where fn+Right
    /// returns, and what fn+Left steps back to from a focus chosen on it.
    /// Keeping this in the step history preserves delete-to-undo navigation.
    mutating func noteFocus(_ source: Source?) {
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
        let removed = Set(steps.indices.filter { index in
            switch steps[index] {
            case .accepted(let source, _), .chosen(let source), .displayed(let source?):
                return !kept.contains(source.projectId)
            case .displayed, .movedOut:
                return false
            }
        })
        // An fn+Left out of a removed level goes with it, or it would step back out of another.
        let dropped = removed.union(replay.steppedOut.filter { removed.contains($0.value) }.keys)
        steps = steps.enumerated().compactMap { index, step in
            guard !dropped.contains(index) else { return nil }
            guard case .movedOut(let source?) = step, !kept.contains(source.projectId) else { return step }
            return .movedOut(nil)
        }
        if let earlier, !kept.contains(earlier.projectId) { self.earlier = nil }
    }

    /// fn+Left: one level back. A focus chosen with fn+Right gives way to the
    /// one it was chosen on, and the newest accepted source to what the card
    /// showed before its Tab. The source the card was focused on is where
    /// fn+Right comes back to.
    mutating func moveOut(from focused: Source?) {
        dropUndone()
        steps.append(.movedOut(focused))
        trim()
        moving = true
    }

    /// fn+Right narrows one level: from every directory into the latest
    /// focus, and on a focused card into the selected row, unless that row is
    /// the focus.
    func canMoveIn(focusedOn current: Source?, selected: Source?) -> Bool {
        target(focusedOn: current, selected: selected) != nil
    }

    mutating func moveIn(focusedOn current: Source?, selected: Source?) {
        guard let target = target(focusedOn: current, selected: selected) else { return }
        dropUndone()
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
        if let chosen = focus.chosen.last?.source {
            return ["focusSource": ["projectId": chosen.projectId, "sourceObjectId": chosen.objectId,
                                    "sourceSnapshotId": chosen.snapshotId]]
        }
        // Offsets are in the text being sent, so they match what the server is given.
        let pending = focus.pending.map { entry -> [String: Any] in
            let source = entry.level.source, range = entry.range
            return ["projectId": source.projectId, "blockIndex": 0, "start": range.lowerBound, "end": range.upperBound,
                    "sourceObjectId": source.objectId, "sourceSnapshotId": source.snapshotId]
        }
        return pending.isEmpty ? [:] : ["pendingDependencies": pending]
    }

    private var focus: Focus { replay.focus }

    /// The steps replayed against the window. An accepted text that was
    /// deleted takes the moves made on it along, up to the next accepted
    /// text still present. fn+Left undoes the latest level still standing.
    private var replay: Replay {
        var replay = Replay(focus: Focus(recent: earlier))
        var undone = false
        var claimed = Set<Int>()
        for (index, step) in steps.enumerated() {
            switch step {
            case .accepted(let source, let anchor):
                switch place(of: anchor) {
                case .deleted:
                    undone = true
                    replay.undone.insert(index)
                    continue
                case .at(let range):
                    // Two accepted phrases found at one place: the later one's own text is gone.
                    guard claimed.insert(range.lowerBound).inserted else {
                        undone = true
                        replay.undone.insert(index)
                        continue
                    }
                    let level = Level(source: source, beneath: replay.focus.displayed, step: index)
                    replay.focus.pending.append((level, range, replay.focus.chosen))
                case .unseen:
                    break
                }
                undone = false
                replay.focus.chosen.removeAll()
                replay.focus.recent = replay.focus.displayed ?? source
            case .displayed(let source) where !undone:
                if let source { replay.focus.recent = source }
                replay.focus.displayed = source
            case .chosen(let source) where !undone:
                replay.focus.chosen.append(Level(source: source, beneath: replay.focus.displayed, step: index))
                replay.focus.recent = source
                replay.focus.displayed = source
            case .movedOut(let source) where !undone:
                if let level = replay.focus.chosen.popLast() {
                    replay.focus.displayed = level.beneath
                    replay.steppedOut[index] = level.step
                } else if let accepted = replay.focus.pending.popLast() {
                    // Out of a Tab, the focus it replaced comes back.
                    replay.focus.chosen = accepted.replaced
                    replay.focus.displayed = accepted.level.beneath
                    replay.steppedOut[index] = accepted.level.step
                }
                if let source { replay.focus.recent = source }
            default:
                replay.undone.insert(index)
            }
        }
        return replay
    }

    /// A move made after a deletion starts from the card on screen, so the
    /// steps that deletion undid are dropped first. Otherwise the move would
    /// be undone with them.
    private mutating func dropUndone() {
        let undone = replay.undone
        guard !undone.isEmpty else { return }
        steps = steps.enumerated().filter { !undone.contains($0.offset) }.map(\.element)
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

/// The row the list a focus move asked for opens on.
enum FocusLanding: Equatable {
    /// fn+Right: the narrower list starts at its top.
    case first
    /// fn+Left: the row stepped back out of, while the list still offers it.
    case row(objectId: String)

    func index(in objectIds: [String?]) -> Int {
        guard case .row(let objectId) = self else { return 0 }
        return objectIds.firstIndex(of: objectId) ?? 0
    }
}
