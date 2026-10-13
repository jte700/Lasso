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
                            configuration: ShareConfiguration = .entireDocument,
                            completion: @escaping (Result<DependencyShare, Error>) -> Void) {
        var request = URLRequest(url: serverURL
            .appendingPathComponent("api/projects/\(projectId)/object-shares"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 5
        var payload: [String: Any] = ["objectId": objectId]
        if let versionId { payload["versionId"] = versionId }
        payload["accessScope"] = configuration.scope.rawValue
        payload["redactions"] = configuration.redactions.map(\.payload)
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
                completion(.failure(NSError(domain: "Lasso", code: 1, userInfo: [
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
        let borrowedChangeCount = pasteboard.changeCount

        // Restore once the target application has had time to read the paste.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard pasteboard.changeCount == borrowedChangeCount else { return }
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
                           in element: AXUIElement, onPasted: @escaping (Bool) -> Void) {
        if length > 0 {
            if caret >= 0, caret - length >= 0 {
                var range = CFRange(location: caret - length, length: length)
                guard let axRange = AXValueCreate(.cfRange, &range),
                      AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange) == .success else {
                    onPasted(false); return
                }
            } else {
                // Web content exposes no ranges: erase the partial word first.
                SyntheticKeyboard.deleteBackwards(length)
            }
        }

        withBorrowedPasteboard {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            let formats = representations(label: label, url: url)
            pasteboard.declareTypes(Array(formats.keys), owner: nil)
            for (type, data) in formats { pasteboard.setData(data, forType: type) }
            paste()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { onPasted(true) }
        }
    }

    static func representations(label: String, url: URL) -> [NSPasteboard.PasteboardType: Data] {
        let html = "<a href=\"\(escapeHtml(url.absoluteString))\">\(escapeHtml(label))</a>"
        var formats: [NSPasteboard.PasteboardType: Data] = [
            .html: Data(html.utf8), .string: Data(plainText(label: label, url: url).utf8),
        ]
        let attributed = NSAttributedString(string: label, attributes: [.link: url])
        if let rtf = try? attributed.data(from: NSRange(location: 0, length: attributed.length),
                                         documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]) {
            formats[.rtf] = rtf
        }
        return formats
    }

    static func plainText(label: String, url: URL) -> String { "\(label) (\(url.absoluteString))" }

    private static func paste() {
        SyntheticKeyboard.paste()
    }
}
enum ShareAccessScope: String {
    case document = "DOCUMENT"
    case indexed = "INDEXED"
    case redacted = "REDACTED"
}

enum ShareRedactionEffect: String {
    case blur = "BLUR"
    case blank = "BLANK"
}

struct ShareRedaction: Hashable {
    let kind: String
    let sheet: Int?
    let row: Int?
    let column: Int?
    let block: Int?
    let effect: ShareRedactionEffect

    var payload: [String: Any] {
        var value: [String: Any] = ["kind": kind, "effect": effect.rawValue]
        if let sheet { value["sheet"] = sheet }
        if let row { value["row"] = row }
        if let column { value["column"] = column }
        if let block { value["block"] = block }
        return value
    }
}

struct ShareConfiguration {
    let scope: ShareAccessScope
    let redactions: [ShareRedaction]

    static let entireDocument = ShareConfiguration(scope: .document, redactions: [])
}
