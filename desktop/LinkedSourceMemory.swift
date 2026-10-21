//  What the suggestion card is focused on in the field being typed in.
//
//  Tab accepts a source, and each request names it so the server offers its
//  values while its sentence goes on. fn+Right narrows the card to the
//  highlighted row when that row has values below it ("brac", then fn+Right,
//  offers Bracket's measurements) without typing it: the values replace the
//  words typed to find it. fn+Left steps back out, one level at a time, to
//  every work directory. A value has nothing below it and every directory is
//  the top, so there the keys do nothing.
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
        /// fn+Right chose this focus, on the words typed to find it, if any.
        case chosen(Source, TextAnchor?)
        /// fn+Left stepped out one level.
        case movedOut
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
        /// Where the words `chosen` was chosen on are; its values replace them.
        var chosenWords: Range<Int>?
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

    /// A new field starts with nothing focused.
    mutating func forget() {
        steps.removeAll()
        window = []
        windowReachesStart = true
        moving = false
    }

    mutating func keep(projectIds: [String]) {
        let kept = Set(projectIds)
        steps.removeAll { step in
            switch step {
            case .accepted(let source, _), .chosen(let source, _): return !kept.contains(source.projectId)
            case .movedOut: return false
            }
        }
    }

    /// fn+Left: one level out. A focus chosen with fn+Right gives way to the
    /// source accepted before it, if any; that gives way to every directory.
    mutating func moveOut() {
        steps.append(.movedOut)
        trim()
        moving = true
    }

    /// Whether fn+Right has somewhere to go: a highlighted row with values
    /// below it (the caller passes no row otherwise) that is not the focus
    /// already, or, right after fn+Left, the focus fn+Left left.
    func canMoveIn(focusedOn current: Source?, selected: Source?) -> Bool {
        target(focusedOn: current, selected: selected) != nil
    }

    /// fn+Right. `typed` holds the words typed to find the highlighted row
    /// ("brac" for Bracket), which the server then replaces with its values.
    mutating func moveIn(focusedOn current: Source?, selected: Source?, typed: TextAnchor? = nil) {
        guard let target = target(focusedOn: current, selected: selected) else { return }
        switch target {
        case .row(let source):
            steps.append(.chosen(source, typed))
            trim()
        case .back:
            steps.removeLast()
        }
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

    private enum Target {
        case row(Source)
        /// Undo the fn+Left just pressed.
        case back
    }

    private func target(focusedOn current: Source?, selected: Source?) -> Target? {
        if let selected, selected.objectId != current?.objectId { return .row(selected) }
        guard current == nil, moving, steps.last == .movedOut else { return nil }
        return .back
    }

    /// The fields a prediction request adds for the card's focus in the
    /// text last observed.
    var requestFields: [String: Any] {
        let focus = focus
        if let chosen = focus.chosen {
            var source: [String: Any] = ["projectId": chosen.projectId, "sourceObjectId": chosen.objectId,
                                         "sourceSnapshotId": chosen.snapshotId]
            if let words = focus.chosenWords {
                source["start"] = words.lowerBound
                source["end"] = words.upperBound
            }
            return ["focusSource": source]
        }
        // Offsets are in the text being sent, so they match what the server is given.
        let pending = focus.pending.map { source, range -> [String: Any] in
            ["projectId": source.projectId, "blockIndex": 0, "start": range.lowerBound, "end": range.upperBound,
             "sourceObjectId": source.objectId, "sourceSnapshotId": source.snapshotId]
        }
        return pending.isEmpty ? [:] : ["pendingDependencies": pending]
    }

    /// The steps replayed against the window. An accepted text, or the words
    /// a focus was chosen on, that was deleted takes the moves made on it
    /// along, up to the next accepted text still present.
    private var focus: Focus {
        var focus = Focus()
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
                focus.chosenWords = nil
            case .chosen(let source, let words):
                let found = words.map { place(of: $0) }
                switch found {
                case .deleted?:
                    // Typing over the words returns to the focus before fn+Right.
                    undone = true
                    continue
                case .at?:
                    // Words still in the text stand on their own, whatever was deleted before them.
                    undone = false
                default:
                    if undone { continue }
                }
                focus.chosen = source
                if case .at(let range)? = found { focus.chosenWords = range } else { focus.chosenWords = nil }
            case .movedOut where !undone:
                if focus.chosen != nil {
                    focus.chosen = nil
                    focus.chosenWords = nil
                } else {
                    focus.pending.removeAll()
                }
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
