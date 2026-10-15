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
    private typealias ClipboardItems = [[NSPasteboard.PasteboardType: Data]]
    private static var borrowed: [NSPasteboard.Name: (items: ClipboardItems, changeCount: Int)] = [:]

    /// Insertion is a paste, so the clipboard is borrowed and put back.
    static func withBorrowedPasteboard(_ pasteboard: NSPasteboard = .general, _ body: () -> Void) {
        // Consecutive insertions share the original clipboard until it is
        // restored or the user copies something else.
        let previous = borrowed[pasteboard.name]
        let saved = previous?.changeCount == pasteboard.changeCount ? previous!.items
            : pasteboard.pasteboardItems?.map { item -> [NSPasteboard.PasteboardType: Data] in
            var copy: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { copy[type] = data }
            }
            return copy
        } ?? []

        body()
        let changeCount = pasteboard.changeCount
        borrowed[pasteboard.name] = (saved, changeCount)

        // Restore once the target application has had time to read the paste.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard borrowed[pasteboard.name]?.changeCount == changeCount else { return }
            borrowed.removeValue(forKey: pasteboard.name)
            guard pasteboard.changeCount == changeCount else { return }
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
                           in element: AXUIElement, keyboardDeleteCount: Int,
                           validateSelection: @escaping (Bool) -> Bool,
                           onPasted: @escaping (Bool) -> Void) {
        var selectedRange = false
        if length > 0, caret >= length {
            var range = CFRange(location: caret - length, length: length)
            if let axRange = AXValueCreate(.cfRange, &range) {
                selectedRange = AXUIElementSetAttributeValue(
                    element, kAXSelectedTextRangeAttribute as CFString, axRange) == .success
            }
        }

        // A readable caret does not imply a writable AX range. Web editors
        // commonly reject the selection write, so use keyboard replacement
        // only after proving that the original caret and prefix still match.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            let verifiedSelection = selectedRange && validateSelection(true)
            guard verifiedSelection || validateSelection(false) else { onPasted(false); return }
            if !verifiedSelection { SyntheticKeyboard.deleteBackwards(keyboardDeleteCount) }
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
    }

    /// Rich editors update their accessibility trees after the paste finishes.
    /// Retry read-back only; never paste a second time while waiting for proof.
    static func verifyEventually(attempts: Int = 8, interval: TimeInterval = 0.12,
                                 verify: @escaping () -> Bool, completion: @escaping (Bool) -> Void) {
        if verify() { completion(true); return }
        guard attempts > 1 else { completion(false); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + interval) {
            verifyEventually(attempts: attempts - 1, interval: interval, verify: verify, completion: completion)
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

    static func containsLink(_ text: NSAttributedString, to url: URL) -> Bool {
        guard text.length > 0 else { return false }
        var valid = true
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attributes, _, _ in
            let value = attributes[.link] ?? attributes[NSAttributedString.Key("AXLink")]
            var destination = (value as? URL)?.absoluteString ?? value as? String
            if let value, CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() {
                var raw: CFTypeRef?
                if AXUIElementCopyAttributeValue(value as! AXUIElement, kAXURLAttribute as CFString, &raw) == .success {
                    destination = (raw as? URL)?.absoluteString ?? raw as? String
                }
            }
            if destination != url.absoluteString { valid = false }
        }
        return valid
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

    var locationKey: String {
        if kind == "CELL" { return "cell:\(sheet ?? 0):\(row ?? -1):\(column ?? -1)" }
        return "block:\(block ?? -1)"
    }

    var payload: [String: Any] {
        var value: [String: Any] = ["kind": kind, "effect": effect.rawValue]
        if let sheet { value["sheet"] = sheet }
        if let row { value["row"] = row }
        if let column { value["column"] = column }
        if let block { value["block"] = block }
        return value
    }
}

/// A drag is one reversible range edit, even when pointer events skip cells.
struct ShareRedactionDrag {
    let anchor: ShareRedaction
    private let originalMasks: [String: ShareRedaction]
    private let addsMasks: Bool

    init(anchor: ShareRedaction, masks: [String: ShareRedaction]) {
        self.anchor = anchor
        originalMasks = masks
        addsMasks = masks[anchor.locationKey] == nil
    }

    func masks(through endpoint: ShareRedaction) -> [String: ShareRedaction] {
        var result = originalMasks
        for redaction in range(through: endpoint) {
            if addsMasks { result[redaction.locationKey] = redaction }
            else { result.removeValue(forKey: redaction.locationKey) }
        }
        return result
    }

    private func range(through endpoint: ShareRedaction) -> [ShareRedaction] {
        guard anchor.kind == endpoint.kind else { return [] }
        if anchor.kind == "CELL",
           (anchor.sheet ?? 0) == (endpoint.sheet ?? 0),
           let firstRow = anchor.row, let lastRow = endpoint.row,
           let firstColumn = anchor.column, let lastColumn = endpoint.column {
            return (min(firstRow, lastRow)...max(firstRow, lastRow)).flatMap { row in
                (min(firstColumn, lastColumn)...max(firstColumn, lastColumn)).map { column in
                    ShareRedaction(kind: "CELL", sheet: anchor.sheet, row: row,
                                   column: column, block: nil, effect: anchor.effect)
                }
            }
        }
        if anchor.kind == "BLOCK", let first = anchor.block, let last = endpoint.block {
            return (min(first, last)...max(first, last)).map { block in
                ShareRedaction(kind: "BLOCK", sheet: nil, row: nil, column: nil,
                               block: block, effect: anchor.effect)
            }
        }
        return []
    }
}

struct ShareConfiguration {
    let scope: ShareAccessScope
    let redactions: [ShareRedaction]

    static let entireDocument = ShareConfiguration(scope: .document, redactions: [])
}
