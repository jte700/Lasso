//  Where a source from a connected app opens: its own page in that app (a Google
//  Doc in Docs, a Dropbox file on dropbox.com), not Lasso's copy on this Mac,
//  whose edits would never reach the app. The server lists the links by the
//  copy's path; they are read again whenever a connection finishes a sync.

import Foundation

enum ConnectedSourceLinks {
    private static var links: [String: URL] = [:]
    private static var loadedSignature: String?

    private static func key(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    }

    /// The web page a file from a connected app opens at, or nil for any other file. Main thread only.
    static func webURL(for fileURL: URL) -> URL? {
        guard fileURL.isFileURL else { return nil }
        return links[key(fileURL.path)]
    }

    /// Reads the links again when `signature` (each connection's last sync) changed. Main thread only.
    static func refresh(serverURL: URL?, signature: String) {
        guard let serverURL, signature != loadedSignature else { return }
        loadedSignature = signature
        let url = serverURL.appendingPathComponent("api/connections/links")
        URLSession.shared.dataTask(with: url) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let listed = object["links"] as? [String: String] else {
                DispatchQueue.main.async { if loadedSignature == signature { loadedSignature = nil } }
                return
            }
            var parsed: [String: URL] = [:]
            for (path, link) in listed {
                guard let web = URL(string: link), web.scheme?.lowercased() == "https" else { continue }
                parsed[key(path)] = web
            }
            // An older answer arriving after a newer request is dropped.
            DispatchQueue.main.async { if loadedSignature == signature { links = parsed } }
        }.resume()
    }
}
