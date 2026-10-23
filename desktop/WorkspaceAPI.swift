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

    static func fixDirectoryPath(_ id: String) -> String {
        "api/workspace/directories/" + id + "/fix"
    }

    static func fixDirectoryBody() -> [String: Any] {
        ["actor": actor]
    }

    /// `operation` is "index" or "decision".
    static func drivePath(_ id: String, _ operation: String) -> String {
        "api/drives/" + id + "/" + operation
    }

    /// Paths are relative to the drive; "." is the whole drive.
    static func driveIndexBody(_ paths: [String]) -> [String: Any] {
        ["paths": paths, "actor": actor]
    }

    /// Directories that are on come first, each group keeping the server's order.
    static func switchedOnFirst<Directory>(_ directories: [Directory], isOn: (Directory) -> Bool) -> [Directory] {
        directories.filter(isOn) + directories.filter { !isOn($0) }
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

extension WorkspaceAPI {
    /// The workspace state, including folders chosen but not recorded yet, so
    /// the menu can show them with their progress from the start.
    static func stateURL(base: URL) -> URL? {
        guard var components = URLComponents(url: base.appendingPathComponent("api/workspace"),
                                              resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [URLQueryItem(name: "pending", value: "1")]
        return components.url
    }
}

/// How far the server has got reading a work directory, as it reports it
/// while the folder is added, brought up to date or re-read. The folder's own
/// row shows it in place of its switch.
struct DirectoryProgress: Equatable {
    let percent: Int
    let phase: String
    let kind: String

    init?(_ value: Any?) {
        guard let progress = value as? [String: Any],
              let percent = (progress["percent"] as? NSNumber)?.intValue else { return nil }
        self.init(percent: percent, phase: progress["phase"] as? String ?? "",
                  kind: progress["kind"] as? String ?? "")
    }

    init(percent: Int, phase: String, kind: String) {
        self.percent = min(max(percent, 0), 100)
        self.phase = phase
        self.kind = kind
    }

    /// What the folder is doing, for its tooltip and VoiceOver.
    var activity: String {
        switch phase {
        case "waiting": return "Waiting to start"
        case "listing": return "Finding files"
        case "reading": return "Reading files"
        case "indexing": return kind == "rereading" ? "Re-reading files" : "Indexing files"
        case "saving": return "Saving the index"
        case "warming": return "Preparing suggestions"
        default: return "Indexing files"
        }
    }
}

/// What a work directory's issue badge says, as the server describes it. A fix
/// label is present only when the problem is Lasso's own to repair.
struct DirectoryIssue: Equatable {
    let message: String
    let fixLabel: String?

    init?(_ value: Any?) {
        guard let issue = value as? [String: Any],
              let message = issue["message"] as? String, !message.isEmpty else { return nil }
        self.message = message
        fixLabel = (issue["fix"] as? [String: Any])?["label"] as? String
    }
}
