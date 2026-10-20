//  What the suggestion card is focused on in the field being typed in.
//
//  Tab accepts a source, and each request names it so the server offers its
//  values while its sentence goes on. A value is as deep as a source goes:
//  once one is tabbed, the server offers the next words from every work
//  directory again. fn+Left moves out to every work
//  directory; fn+Right moves back in to the last focus or, on a card
//  already focused, into the selected row.

import Foundation

struct LinkedSourceMemory {
    struct Source: Equatable {
        let projectId: String
        let objectId: String
        let snapshotId: String
        /// The inserted text, found again in each window that is sent.
        let text: String
    }

    private static let limit = 8
    /// Sources accepted with Tab in this field, newest last.
    private(set) var sources: [Source] = []
    /// A focus chosen with fn+Right. The server keeps it until fn+Left.
    private(set) var chosen: Source?
    /// Where fn+Right returns from every directory: the latest focus in any field.
    private(set) var recent: Source?

    mutating func record(_ source: Source) {
        sources.append(source)
        if sources.count > Self.limit { sources.removeFirst() }
        chosen = nil
    }

    /// The card is showing this source's suggestions. A value tabbed there
    /// ends the focus on the server, so fn+Right returns to this source, not
    /// to the value.
    mutating func noteFocus(_ source: Source) {
        recent = source
    }

    /// A new field starts with nothing focused.
    mutating func forget() {
        sources.removeAll()
        chosen = nil
    }

    mutating func keep(projectIds: [String]) {
        sources.removeAll { !projectIds.contains($0.projectId) }
        if let chosen, !projectIds.contains(chosen.projectId) { self.chosen = nil }
        if let recent, !projectIds.contains(recent.projectId) { self.recent = nil }
    }

    /// fn+Left: every directory answers the next words. The source the card
    /// was focused on is where fn+Right comes back to.
    mutating func moveOut(from focused: Source?) {
        if let focused { recent = focused }
        sources.removeAll()
        chosen = nil
    }

    /// fn+Right from every directory returns to the latest focus; on a
    /// focused card it moves into the selected row, unless that row is the focus.
    func canMoveIn(focusedOn current: Source?, selected: Source?) -> Bool {
        target(focusedOn: current, selected: selected) != nil
    }

    mutating func moveIn(focusedOn current: Source?, selected: Source?) {
        guard let target = target(focusedOn: current, selected: selected) else { return }
        chosen = target
        recent = target
    }

    private func target(focusedOn current: Source?, selected: Source?) -> Source? {
        guard let current else { return recent }
        guard let selected, selected.objectId != current.objectId else { return nil }
        return selected
    }

    /// The fields a prediction request adds for the card's focus.
    func requestFields(in text: String) -> [String: Any] {
        if let chosen {
            return ["focusSource": ["projectId": chosen.projectId, "sourceObjectId": chosen.objectId,
                                    "sourceSnapshotId": chosen.snapshotId]]
        }
        let pending = pendingDependencies(in: text)
        return pending.isEmpty ? [:] : ["pendingDependencies": pending]
    }

    /// Each source located in the text being sent, as the server's pending
    /// dependencies, so its offsets match that text. A source whose text is
    /// gone is not sent.
    func pendingDependencies(in text: String) -> [[String: Any]] {
        let window = Array(text.utf16)
        return sources.compactMap { source -> [String: Any]? in
            let needle = Array(source.text.utf16)
            guard let start = TextAnchorResolver.indices(of: needle, in: window).last else { return nil }
            return [
                "projectId": source.projectId,
                "blockIndex": 0,
                "start": start,
                "end": start + needle.count,
                "sourceObjectId": source.objectId,
                "sourceSnapshotId": source.snapshotId,
            ]
        }
    }
}
