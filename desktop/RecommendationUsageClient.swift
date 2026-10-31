import Foundation

/// Records successful, intentional source interactions. The session is stable
/// for this native process; previews and suggestion impressions never call it.
enum RecommendationUsageClient {
    private static let sessionId = UUID().uuidString

    static func record(serverURL: URL, projectId: String, objectId: String?, path: String? = nil,
                       kind: String) {
        var body: [String: Any] = ["kind": kind, "sessionId": sessionId]
        if let objectId, !objectId.isEmpty {
            body["objectId"] = objectId
        } else if let path, !path.isEmpty {
            body["path"] = path
        } else { return }
        var request = URLRequest(url: serverURL
            .appendingPathComponent("api/projects")
            .appendingPathComponent(projectId)
            .appendingPathComponent("recommendation-usage"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 3
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { _, _, _ in }.resume()
    }

    /// Persisted highlights keep their source identity across directory toggles.
    static func resolveProject(serverURL: URL, objectId: String, completion: @escaping (String?) -> Void) {
        var request = URLRequest(url: serverURL.appendingPathComponent("api/dependency-objects")
            .appendingPathComponent(objectId))
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let object = root["object"] as? [String: Any],
                  let projectId = object["projectId"] as? String else { completion(nil); return }
            completion(projectId)
        }.resume()
    }

    static func recordResolvedOpen(serverURL: URL, objectId: String) {
        resolveProject(serverURL: serverURL, objectId: objectId) { projectId in
            guard let projectId else { return }
            record(serverURL: serverURL, projectId: projectId, objectId: objectId, kind: "open")
        }
    }
}
