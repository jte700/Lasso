import Foundation

/// Payloads and error decoding shared by the native directory controls.
enum WorkspaceAPI {
    private static let actor = [
        "id": "human:desktop",
        "displayName": "Desktop",
        "actorType": "HUMAN_SELF",
    ]

    static func addDirectoriesBody(_ rootPaths: [String]) -> [String: Any] {
        ["rootPaths": rootPaths, "actor": actor]
    }

    static func toggleDirectoryBody(active: Bool) -> [String: Any] {
        ["active": active, "actor": actor]
    }

    static func removeDirectoriesBody(_ projectIds: [String]) -> [String: Any] {
        ["projectIds": projectIds, "actor": actor]
    }

    /// Folders named in a removal alert before the rest are only counted.
    private static let namedRemovalLimit = 5

    /// Each folder's name, or its path where another folder has the same name,
    /// matching how the directory list tells them apart.
    static func distinctNames(_ folders: [(name: String, path: String)]) -> [String] {
        folders.map { folder in
            folders.filter { $0.name == folder.name }.count > 1 ? folder.path : folder.name
        }
    }

    static func removalCommandTitle(count: Int) -> String {
        switch count {
        case 0: return "Remove Selected Directories"
        case 1: return "Remove 1 Directory\u{2026}"
        default: return "Remove \(count) Directories\u{2026}"
        }
    }

    /// The alert asking before folders are taken out of Lasso.
    static func removalConfirmation(names: [String]) -> (message: String, details: String) {
        if names.count == 1, let name = names.first {
            return ("Remove \u{201C}\(name)\u{201D} from Lasso?",
                    "Lasso will stop indexing this directory and will no longer suggest its contents. "
                    + "The folder and its files will remain on your Mac, and you can add it again at any time.")
        }
        let shown = names.prefix(namedRemovalLimit)
        let hidden = names.count - shown.count
        let list = hidden > 0 ? shown.joined(separator: ", ") + " and \(hidden) more"
            : shown.dropLast().joined(separator: ", ") + " and " + (shown.last ?? "")
        return ("Remove \(names.count) directories from Lasso?",
                "\(list) will no longer be indexed or suggested. "
                + "The folders and their files will remain on your Mac, and you can add them again at any time.")
    }

    static func reindexBody() -> [String: Any] {
        ["actor": actor, "reason": "requested from the menu"]
    }

    /// What a re-read recorded, in the same words as the Windows companion.
    static func reindexSummary(_ reindexed: [String: Any]) -> String {
        guard reindexed["changed"] as? Bool == true else {
            return "The current reader reads these files exactly as recorded. Nothing was changed."
        }
        let objects = reindexed["objects"] as? [String: Any] ?? [:]
        let version = (reindexed["snapshot"] as? [String: Any])?["version"] as? Int ?? 0
        let before = objects["before"] as? Int ?? 0
        let after = objects["after"] as? Int ?? 0
        let review = reindexed["dependenciesNeedingReview"] as? Int ?? 0
        var message = "Version \(version) records a new reading of the same files: "
            + "\(before) sources before, \(after) now. "
            + "Earlier versions are unchanged, so existing links and shares still resolve."
        if review > 0 {
            message += review == 1
                ? " 1 claim needs review: the new reader identifies its source differently."
                : " \(review) claims need review: the new reader identifies their sources differently."
        }
        return message
    }

    static func errorMessage(data: Data?, response: URLResponse?, error: Error?) -> String {
        if let data,
           let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let details = body["error"] as? [String: Any],
               let message = details["message"] as? String, !message.isEmpty {
                return message
            }
            if let message = body["error"] as? String, !message.isEmpty {
                return message
            }
        }
        if let error { return error.localizedDescription }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            return "The directory request failed (HTTP \(http.statusCode))."
        }
        return "The directory status could not be loaded."
    }
}

/// Directories chosen in the menu's selection mode. Every change returns a new
/// value; the anchor is the last folder clicked, where a Shift-click range starts.
struct DirectorySelection: Equatable {
    private(set) var ids: Set<String> = []
    private(set) var anchor: String?

    func toggling(_ id: String, in order: [String], extendingRange: Bool = false) -> DirectorySelection {
        if extendingRange, let anchor, let start = order.firstIndex(of: anchor),
           let end = order.firstIndex(of: id) {
            let range = order[min(start, end)...max(start, end)]
            return DirectorySelection(ids: ids.union(range), anchor: id)
        }
        let next = ids.contains(id) ? ids.subtracting([id]) : ids.union([id])
        return DirectorySelection(ids: next, anchor: id)
    }

    func selectingAll(_ order: [String]) -> DirectorySelection {
        DirectorySelection(ids: Set(order), anchor: anchor)
    }

    func containsAll(_ order: [String]) -> Bool {
        !order.isEmpty && Set(order).isSubset(of: ids)
    }

    func pruned(to order: [String]) -> DirectorySelection {
        let remaining = ids.intersection(order)
        return DirectorySelection(ids: remaining, anchor: anchor.flatMap { remaining.contains($0) ? $0 : nil })
    }

    func ordered(_ order: [String]) -> [String] {
        order.filter(ids.contains)
    }
}
