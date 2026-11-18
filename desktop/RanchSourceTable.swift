// How a source is said in a list (RanchListTable.swift): its kind, folder,
// status, use and the date the chosen order goes by.

import Cocoa
import SwiftUI

extension RanchOrder {
    /// The date the order goes by, as a column's name and a file's value in it.
    var columnTitle: String {
        switch self {
        case .lastEdited: return "Last edited"
        case .recentlyUsed: return "Last used"
        case .oldest, .newest: return "Created"
        }
    }

    func when(_ source: RanchSource) -> String {
        switch self {
        case .lastEdited: return RanchFormat.ago(source.modifiedAt).capitalizedFirst
        case .recentlyUsed: return source.lastUsedAt.map { RanchFormat.ago($0).capitalizedFirst } ?? "\u{2014}"
        case .oldest, .newest: return RanchFormat.ago(source.createdAt ?? source.modifiedAt).capitalizedFirst
        }
    }
}

extension String {
    /// "just now" as "Just now".
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

extension RanchListItem {
    init(source: RanchSource, store: RanchStore, flagged: Bool) {
        let status = RanchSourceStatus(source, flagged: flagged)
        let directory = store.directory(source.directoryId)
        self.init(id: source.id, fileExtension: source.fileExtension, title: source.name,
                  caption: source.folder.isEmpty ? "Top of the directory" : source.folder,
                  kind: RanchKindFilter.label(for: source.kind),
                  directory: directory.map { (name: $0.name, color: $0.color) },
                  status: RanchListStatus(title: status.title, dot: status.dot, dim: status == .unused),
                  detail: source.usesText, meter: source.activity, detailStrong: source.counts.total > 0,
                  when: store.itemOrder.when(source), localURL: store.localURL(for: source),
                  share: source.canShareLink ? { [weak store] in store?.sharing = source } : nil)
    }
}
