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
