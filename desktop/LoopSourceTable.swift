// How a source is said in a list (LoopListTable.swift): its kind, folder,
// status, use and the date the chosen order goes by.

import Cocoa
import SwiftUI

extension LoopOrder {
    /// The date the order goes by, as a column's name and a file's value in it.
    var columnTitle: String {
        switch self {
        case .lastEdited: return "Last edited"
        case .recentlyUsed: return "Last used"
        case .oldest, .newest: return "Created"
        }
    }

    func when(_ source: LoopSource) -> String {
        switch self {
        case .lastEdited: return LoopFormat.ago(source.modifiedAt).capitalizedFirst
        case .recentlyUsed: return source.lastUsedAt.map { LoopFormat.ago($0).capitalizedFirst } ?? "\u{2014}"
        case .oldest, .newest: return LoopFormat.ago(source.createdAt ?? source.modifiedAt).capitalizedFirst
        }
    }
}

extension String {
    /// "just now" as "Just now".
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

extension LoopListItem {
    init(source: LoopSource, store: LoopStore, flagged: Bool) {
        let status = LoopSourceStatus(source, flagged: flagged)
        let directory = store.directory(source.directoryId)
        self.init(id: source.id, fileExtension: source.fileExtension, title: source.name,
                  caption: source.folder.isEmpty ? "Top of the directory" : source.folder,
                  kind: LoopKindFilter.label(for: source.kind),
                  directory: directory.map { (name: $0.name, color: $0.color) },
                  status: LoopListStatus(title: status.title, dot: status.dot, dim: status == .unused),
                  detail: source.usesText, meter: source.activity, detailStrong: source.counts.total > 0,
                  when: store.itemOrder.when(source), localURL: store.localURL(for: source),
                  share: source.canShareLink ? { [weak store] in store?.sharing = source } : nil)
    }
}
