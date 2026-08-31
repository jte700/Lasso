//  Creating shares, and inserting them as real hyperlinks.
//
//  Sharing is deliberately ordered: create the record, build the URL, insert the
//  link, verify the insertion, and revoke the record if the insertion did not
//  land. The application never claims something is shared when the target
//  document only received plain text.

import Cocoa
import ApplicationServices

struct DependencyShare {
    let token: String
    let url: URL
}

/// Talks to the local share service. Kept separate from indexing and from the
/// insertion mechanics so neither depends on the other.
enum ShareClient {
    static func createShare(serverURL: URL, projectId: String, objectId: String, versionId: String?,
                            completion: @escaping (Result<DependencyShare, Error>) -> Void) {
        var request = URLRequest(url: serverURL
            .appendingPathComponent("api/projects/\(projectId)/object-shares"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 5
        var payload: [String: Any] = ["objectId": objectId]
        if let versionId { payload["versionId"] = versionId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { completion(.failure(error)); return }
            guard let data,
                  let status = (response as? HTTPURLResponse)?.statusCode, status == 201,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let share = root["share"] as? [String: Any],
                  let token = share["token"] as? String,
                  let raw = share["url"] as? String,
                  let url = URL(string: raw) else {
                completion(.failure(NSError(domain: "CoLabDry", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "The share could not be created.",
                ])))
                return
            }
            completion(.success(DependencyShare(token: token, url: url)))
        }.resume()
    }

    /// Used when an insertion fails after the record already exists.
    static func revokeShare(serverURL: URL, token: String) {
        var request = URLRequest(url: serverURL
            .appendingPathComponent("api/object-shares/\(token)/revoke"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request).resume()
    }
}

/// Rich-text insertion for applications that accept pasted HTML, which is how
/// Gmail's compose field receives a hyperlink. Isolated here so no other layer
/// depends on clipboard behaviour.
enum RichTextInserter {
    /// Insertion is a paste, so the clipboard is borrowed and put back.
    private static func withBorrowedPasteboard(_ body: () -> Void) {
        let pasteboard = NSPasteboard.general
        let saved = pasteboard.pasteboardItems?.compactMap { item -> [NSPasteboard.PasteboardType: Data] in
            var copy: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { copy[type] = data }
            }
            return copy
        } ?? []

        body()

        // Restore once the target application has had time to read the paste.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            pasteboard.clearContents()
            let restored = saved.map { entry -> NSPasteboardItem in
                let item = NSPasteboardItem()
                for (type, data) in entry { item.setData(data, forType: type) }
                return item
            }
            if !restored.isEmpty { pasteboard.writeObjects(restored) }
        }
    }

    private static func escapeHtml(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// Selects the partial word, then pastes `label` as a link to `url`.
    /// Only the label is clickable; no raw URL is shown.
    static func insertLink(label: String, url: URL, replacing length: Int, at caret: Int,
                           in element: AXUIElement, onPasted: @escaping () -> Void) {
        let html = "<a href=\"\(escapeHtml(url.absoluteString))\">\(escapeHtml(label))</a>"

        if length > 0 {
            if caret >= 0, caret - length >= 0 {
                var range = CFRange(location: caret - length, length: length)
                if let axRange = AXValueCreate(.cfRange, &range) {
                    AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
                }
            } else {
                // Web content exposes no ranges: erase the partial word first.
                SyntheticKeyboard.deleteBackwards(length)
            }
        }

        withBorrowedPasteboard {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.declareTypes([.html, .string], owner: nil)
            pasteboard.setString(html, forType: .html)
            // Plain-text fallback for fields that cannot take HTML.
            pasteboard.setString(label, forType: .string)
            paste()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: onPasted)
        }
    }

    private static func paste() {
        SyntheticKeyboard.paste()
    }
}
