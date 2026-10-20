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
