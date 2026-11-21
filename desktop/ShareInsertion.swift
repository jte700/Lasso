//  Creating shares, and inserting them as real hyperlinks.
//
//  Sharing is deliberately ordered: create the record, build the URL, insert the
//  link, verify the insertion, and revoke the record if the insertion did not
//  land. The application never claims something is shared when the target
//  document only received plain text: there the text goes in as Tab would put
//  it, and the link is copied instead.

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
                            snapshotId: String? = nil,
                            configuration: ShareConfiguration = .entireDocument,
                            completion: @escaping (Result<DependencyShare, Error>) -> Void) {
        var request = URLRequest(url: serverURL
            .appendingPathComponent("api/projects/\(projectId)/object-shares"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 180
        var payload: [String: Any] = ["objectId": objectId]
        if let versionId { payload["versionId"] = versionId }
        // A share made from a link shares the file the link was made from.
        if let snapshotId { payload["snapshotId"] = snapshotId }
        payload["accessScope"] = configuration.scope.rawValue
        payload["redactions"] = configuration.redactions.map(\.payload)
        if configuration.scope == .marked { payload["markup"] = configuration.markup.map(\.payload) }
        if configuration.nearbyRows { payload["nearbyRows"] = true }
        if let citedIn = configuration.citedIn, !citedIn.isEmpty { payload["citedIn"] = citedIn }
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { completion(.failure(error)); return }
            if let data, let status = (response as? HTTPURLResponse)?.statusCode, status != 201,
               let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let error = root["error"] as? [String: Any], let message = error["message"] as? String {
                completion(.failure(NSError(domain: "Lasso", code: status, userInfo: [NSLocalizedDescriptionKey: message])))
                return
            }
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
        request.timeoutInterval = 30
        URLSession.shared.dataTask(with: request).resume()
    }
}

/// Rich-text insertion for applications that accept pasted HTML, which is how
/// Gmail's compose field receives a hyperlink. Isolated here so no other layer
/// depends on clipboard behaviour.
///
/// Inserting reads and writes the host, so it runs on `AccessibilityWork.queue`
/// and calls back there, like the clipboard it borrows.
enum RichTextInserter {
    private typealias ClipboardItems = [[(NSPasteboard.PasteboardType, Data)]]
    /// Touched on `AccessibilityWork.queue` only.
    private static var borrowed: [NSPasteboard.Name: (items: ClipboardItems, changeCount: Int)] = [:]
    static let defaultRestoreDelay: TimeInterval = 0.6
    /// Pictures go through renderer IPC and attachment imports, so they keep
    /// the borrowed clipboard a little longer before restoring the user's own.
    static let imageRestoreDelay: TimeInterval = 1.5

    /// Insertion is a paste, so the clipboard is borrowed and put back.
    /// Accessibility queue only.
    static func withBorrowedPasteboard(_ pasteboard: NSPasteboard = .general,
                                       restoreAfter delay: TimeInterval = defaultRestoreDelay,
                                       _ body: () -> Void) {
        // Consecutive insertions share the original clipboard until it is
        // restored or the user copies something else.
        let previous = borrowed[pasteboard.name]
        let saved = previous?.changeCount == pasteboard.changeCount ? previous!.items
            : pasteboard.pasteboardItems?.map { item -> [(NSPasteboard.PasteboardType, Data)] in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        } ?? []

        body()
        let changeCount = pasteboard.changeCount
        borrowed[pasteboard.name] = (saved, changeCount)

        // Restore once the target application has had time to read the paste.
        AccessibilityWork.queue.asyncAfter(deadline: .now() + delay) {
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

    /// Writes `formats` as a single pasteboard item in the exact order given,
    /// so hosts that prefer the first declared type (such as PNG over TIFF)
    /// always see it first.
    @discardableResult
    static func writeFormats(_ formats: [(NSPasteboard.PasteboardType, Data)],
                             to pasteboard: NSPasteboard = .general) -> Bool {
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        for (type, data) in formats { item.setData(data, forType: type) }
        return pasteboard.writeObjects([item])
    }

    private static func escapeHtml(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// Selects the partial word, then pastes `label` as a link to `url`.
    /// Only the label is clickable; no raw URL is shown. Accessibility queue
    /// only, where `validateSelection` and `onPasted` are called too.
    static func insertLink(label: String, url: URL, replacing length: Int, at caret: Int,
                           in element: AXUIElement, keyboardDeleteCount: Int,
                           validateSelection: @escaping (Bool) -> Bool,
                           onPasted: @escaping (Bool) -> Void) {
        let formats = representations(label: label, url: url)
        var ordered: [(NSPasteboard.PasteboardType, Data)] = []
        for type in [NSPasteboard.PasteboardType.html, .rtf, .string] {
            if let data = formats[type] { ordered.append((type, data)) }
        }
        insertFormats(ordered, replacing: length, at: caret, in: element,
                      keyboardDeleteCount: keyboardDeleteCount, validateSelection: validateSelection, onPasted: onPasted)
    }

    private static let deletionSettleTime: TimeInterval = 0.08
    private static let maxKeyboardDeleteWithoutSelection = 32

    /// How many times Backspace is pressed before pasting. A selected word is
    /// one press when `deletesFirst`, and pasting over it otherwise; without
    /// a selection the typed letters are deleted one by one.
    static func deletesBeforePaste(selected: Bool, deletesFirst: Bool, replacing length: Int,
                                   keyboardDeleteCount: Int) -> Int {
        guard selected else { return keyboardDeleteCount }
        return deletesFirst && length > 0 ? 1 : 0
    }

    /// Whether to select the replaced text by Accessibility before deleting or
    /// pasting. Short picture pastes without pending marked text, and hosts
    /// where Accessibility selection writes are avoided (such as Notes), delete
    /// by keyboard directly instead of mutating `AXSelectedTextRange`.
    static func shouldSelectBeforePaste(replacing length: Int, at caret: Int, deletesFirst: Bool,
                                        keyboardDeleteCount: Int, hasMarkedText: Bool,
                                        avoidSelection: Bool = false) -> Bool {
        guard length > 0, caret >= length else { return false }
        if avoidSelection && keyboardDeleteCount <= maxKeyboardDeleteWithoutSelection { return false }
        if deletesFirst && !hasMarkedText && keyboardDeleteCount <= maxKeyboardDeleteWithoutSelection { return false }
        return true
    }

    /// The integer caret position where a pending inline prediction should be
    /// cleared before pasting, or nil when pasting over a selection or in a
    /// marker-addressed editor (`caret < 0`).
    static func bareCaretForPaste(replacing length: Int, at caret: Int, deletesFirst: Bool) -> Int? {
        guard length == 0 || deletesFirst, caret >= length else { return nil }
        return caret - length
    }

    private static func bundleIdentifier(of element: AXUIElement) -> String? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { return nil }
        return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    }

    /// Selects the partial word, then pastes `formats` together, so the host
    /// takes the richest it reads: a link, or a sheet's cells as a picture.
    /// With `deletesFirst` the word is deleted before the paste, since editors
    /// that turn a pasted picture into an attachment leave the selection as it is.
    /// Accessibility queue only, where `validateSelection` and `onPasted` are called too.
    static func insertFormats(_ formats: [(NSPasteboard.PasteboardType, Data)], replacing length: Int, at caret: Int,
                              in element: AXUIElement, keyboardDeleteCount: Int, deletesFirst: Bool = false,
                              restoreClipboardAfter delay: TimeInterval = defaultRestoreDelay,
                              validateSelection: @escaping (Bool) -> Bool,
                              onPasted: @escaping (Bool) -> Void) {
        let avoidSelection = CompletionTransaction.prefersKeyboardInsertion(
            bundleIdentifier: bundleIdentifier(of: element))
        let hasMarkedText = deletesFirst && !avoidSelection && length > 0 && caret >= length
            ? AccessibilitySelectableText(element: element).hasMarkedText : false
        var selectedRange = false
        if shouldSelectBeforePaste(replacing: length, at: caret, deletesFirst: deletesFirst,
                                   keyboardDeleteCount: keyboardDeleteCount, hasMarkedText: hasMarkedText,
                                   avoidSelection: avoidSelection) {
            selectedRange = HostSelection.selectForWrite((caret - length)..<caret, caret: caret, in: element)
        }

        // A readable caret does not imply a writable AX range. Web editors
        // commonly reject the selection write, so use keyboard replacement
        // only after proving that the original caret and prefix still match.
        let proceed = {
            let verifiedSelection = selectedRange && validateSelection(true)
            guard verifiedSelection || validateSelection(false) else { onPasted(false); return }
            let deletes = deletesBeforePaste(selected: verifiedSelection, deletesFirst: deletesFirst,
                                             replacing: length, keyboardDeleteCount: keyboardDeleteCount)
            SyntheticKeyboard.deleteBackwards(deletes)
            // The app takes the deletion before the caret is read again.
            let settle = deletes > 0
                ? deletionSettleTime + min(0.12, Double(deletes) * 0.004) : 0
            AccessibilityWork.queue.asyncAfter(deadline: .now() + settle) {
                // Pasted at a bare caret, the paste would merge into a pending
                // prediction, which can return during the wait. Clear it now.
                if let bareCaret = bareCaretForPaste(replacing: length, at: caret,
                                                     deletesFirst: deletesFirst || (deletes > 0 && !verifiedSelection)) {
                    let cleared = HostSelection.selectForWrite(bareCaret..<bareCaret, caret: bareCaret, in: element)
                    // Only refuse before touching the field; once Backspace already
                    // removed the typed word, still paste rather than leaving a gap.
                    if !cleared && deletes == 0 {
                        onPasted(false)
                        return
                    }
                }
                withBorrowedPasteboard(restoreAfter: delay) {
                    writeFormats(formats)
                    paste()
                    AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.25) { onPasted(true) }
                }
            }
        }
        if selectedRange {
            AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.05, execute: proceed)
        } else {
            proceed()
        }
    }

    /// Rich editors update their accessibility trees after the paste finishes.
    /// Retry read-back only; never paste a second time while waiting for proof.
    /// Accessibility queue only, where `verify` and `completion` are called too.
    static func verifyEventually(attempts: Int = 8, interval: TimeInterval = 0.12,
                                 verify: @escaping () -> Bool, completion: @escaping (Bool) -> Void) {
        if verify() { completion(true); return }
        guard attempts > 1 else { completion(false); return }
        AccessibilityWork.queue.asyncAfter(deadline: .now() + interval) {
            verifyEventually(attempts: attempts - 1, interval: interval, verify: verify, completion: completion)
        }
    }

    /// How a pasted link shows in the host.
    enum LinkLanding: Equatable {
        /// The suggestion's text, where the plan put it, links to the share.
        case linked
        /// The suggestion's text is there without a link, as a box that takes
        /// only plain text pastes it.
        case plainText
    }

    /// Nil until the suggestion's text sits exactly where the plan put it with
    /// nothing else changed. `hasLink` is asked only then.
    static func landing(of plan: CompletionPlan, before: CompletionSnapshot, after: CompletionSnapshot,
                        hasLink: (String) -> Bool) -> LinkLanding? {
        guard case .success = CompletionTransaction.verify(before: before, after: after, plan: plan) else { return nil }
        return hasLink(plan.insertText) ? .linked : .plainText
    }

    /// Puts the link on the clipboard as Copy link does. Accessibility queue
    /// only, so a borrowed clipboard put back later never covers it.
    static func copyLink(_ url: URL, to pasteboard: NSPasteboard = .general) {
        pasteboard.clearContents()
        pasteboard.setString(url.absoluteString, forType: .string)
    }

    /// The link is the label itself. A box that takes only plain text gets the
    /// label alone, as Tab would insert it, never the URL beside it.
    static func representations(label: String, url: URL) -> [NSPasteboard.PasteboardType: Data] {
        let html = "<a href=\"\(escapeHtml(url.absoluteString))\">\(escapeHtml(label))</a>"
        var formats: [NSPasteboard.PasteboardType: Data] = [
            .html: Data(html.utf8), .string: Data(label.utf8),
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

    /// Pastes `text` as plain text, so the host takes it as written, in the
    /// formatting already at the caret. Accessibility queue only.
    static func pastePlainText(_ text: String) {
        withBorrowedPasteboard {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
            paste()
        }
    }

    private static func paste() {
        SyntheticKeyboard.paste()
    }
}
enum ShareAccessScope: String {
    case document = "DOCUMENT"
    case indexed = "INDEXED"
    case redacted = "REDACTED"
    /// A copy of the pages with pen, marker and highlighter strokes on them.
    case marked = "MARKED"

    /// A 3D CAD model has no text to redact. It is shared whole, or as the
    /// cited part with its feature marked when the citation names one part.
    /// A presentation is the same: the whole deck, or the slide the citation
    /// is on, which `hasCitedPart` then means. A PDF, Word document or deck
    /// can also be shared as a copy with markings drawn on its pages.
    static func offered(for kind: ShareSourceKind, hasCitedPart: Bool, markable: Bool = false) -> [ShareAccessScope] {
        let marked: [ShareAccessScope] = markable ? [.marked] : []
        switch kind {
        // A video is sent whole and opens at the cited moment: a sentence of it is a
        // place to start, not a part to cut out, and there is nothing on it to redact or mark.
        case .video: return [.document]
        // A picture or a 2D plan has no part worth sending alone; areas of it are covered instead.
        case .image, .planDrawing: return [.document, .redacted]
        case .writing: return [.document, .redacted] + marked
        case .other: return [.document, .indexed, .redacted] + marked
        case .cadModel, .presentation: return (hasCitedPart ? [.document, .indexed] : [.document]) + marked
        }
    }
}

/// What a shared source is, as far as which scopes it offers.
enum ShareSourceKind: Equatable {
    case cadModel, presentation, writing, video, image, planDrawing, other

    init(filename: String) {
        switch (filename as NSString).pathExtension.lowercased() {
        case "step", "stp": self = .cadModel
        case "pptx": self = .presentation
        // A passage of prose says little on its own, so these have no cited part. The server's
        // WRITING_TYPES in object-share.js is the same list.
        // The server's VIDEO list in history/file-types.js.
        case "mov", "mp4", "m4v": self = .video
        // The server's IMAGE list in history/file-types.js.
        case "png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "svg": self = .image
        case "dxf", "ifc": self = .planDrawing
        case "pdf", "docx", "txt", "tex", "bib", "ris", "enw", "nbib", "log", "md", "mdx", "qmd", "rmd", "rst": self = .writing
        default: self = .other
        }
    }

    /// PDFs, Word documents and decks are shown as pages to draw on.
    static func isMarkable(_ filename: String) -> Bool {
        ["pdf", "docx", "pptx"].contains((filename as NSString).pathExtension.lowercased())
    }
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
    var x: Double? = nil
    var y: Double? = nil
    var width: Double? = nil
    var height: Double? = nil
    var page: Int? = nil

    var locationKey: String {
        if kind == "CELL" { return "cell:\(sheet ?? 0):\(row ?? -1):\(column ?? -1)" }
        if kind == "DRAWING" || kind == "IMAGE" {
            return "\(kind.lowercased()):" + [x, y, width, height].map { String(format: "%.8f", $0 ?? -1) }.joined(separator: ":")
        }
        if kind == "PDF" {
            return "pdf:\(page ?? -1):" + [x, y, width, height].map { String(format: "%.8f", $0 ?? -1) }.joined(separator: ":")
        }
        return "block:\(block ?? -1)"
    }

    var payload: [String: Any] {
        var value: [String: Any] = ["kind": kind, "effect": effect.rawValue]
        if let sheet { value["sheet"] = sheet }
        if let row { value["row"] = row }
        if let column { value["column"] = column }
        if let block { value["block"] = block }
        if let x { value["x"] = x }
        if let y { value["y"] = y }
        if let width { value["width"] = width }
        if let height { value["height"] = height }
        if let page { value["page"] = page }
        return value
    }
}

/// Page coordinates are normalized against the unrotated PDF crop box.
struct SharePDFRegion: Hashable {
    let page: Int
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init?(page: Int, rect: NSRect, crop: NSRect) {
        let area = rect.intersection(crop)
        guard page > 0, !area.isNull, area.width > 0, area.height > 0,
              crop.width > 0, crop.height > 0 else { return nil }
        self.page = page
        x = Double((area.minX - crop.minX) / crop.width)
        y = Double((crop.maxY - area.maxY) / crop.height)
        width = Double(area.width / crop.width)
        height = Double(area.height / crop.height)
    }

    func rect(in crop: NSRect) -> NSRect {
        NSRect(x: crop.minX + CGFloat(x) * crop.width,
               y: crop.maxY - CGFloat(y + height) * crop.height,
               width: CGFloat(width) * crop.width, height: CGFloat(height) * crop.height)
    }

    func redaction(effect: ShareRedactionEffect) -> ShareRedaction {
        ShareRedaction(kind: "PDF", sheet: nil, row: nil, column: nil, block: nil,
                       effect: effect, x: x, y: y, width: width, height: height, page: page)
    }
}

/// Normalized top-left drawing coordinates match the server's pinned bounds.
/// The fitted frame uses the same viewport and padding as AssistModelRenderer.
/// A picture is laid out the same way, its frame where it is drawn and its masks of kind IMAGE.
struct ShareDrawingLayout {
    let frame: NSRect
    var kind = "DRAWING"

    init(frame: NSRect, kind: String = "DRAWING") {
        self.frame = frame
        self.kind = kind
    }

    init?(model: AssistModelPreview, in rect: NSRect) {
        guard let transform = AssistModelTransform(bounds: model.focusBounds,
                                                   viewport: AssistModelRenderer.viewport(in: rect)) else { return nil }
        let topLeft = transform.point(NSPoint(x: model.bounds.minX, y: model.bounds.maxY))
        let bottomRight = transform.point(NSPoint(x: model.bounds.maxX, y: model.bounds.minY))
        let frame = NSRect(x: topLeft.x, y: topLeft.y,
                           width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y)
        guard frame.width > 0, frame.height > 0 else { return nil }
        self.frame = frame
    }

    func redaction(from start: NSPoint, to end: NSPoint, effect: ShareRedactionEffect) -> ShareRedaction? {
        func normalized(_ point: NSPoint) -> NSPoint {
            NSPoint(x: min(1, max(0, (point.x - frame.minX) / frame.width)),
                    y: min(1, max(0, (point.y - frame.minY) / frame.height)))
        }
        let a = normalized(start), b = normalized(end)
        let x = min(a.x, b.x), y = min(a.y, b.y)
        let width = min(abs(a.x - b.x), 1 - x), height = min(abs(a.y - b.y), 1 - y)
        guard width * frame.width >= 3, height * frame.height >= 3 else { return nil }
        return ShareRedaction(kind: kind, sheet: nil, row: nil, column: nil, block: nil,
                              effect: effect, x: Double(x), y: Double(y),
                              width: Double(width), height: Double(height))
    }

    func rect(for mask: ShareRedaction) -> NSRect? {
        guard mask.kind == kind, let x = mask.x, let y = mask.y,
              let width = mask.width, let height = mask.height,
              [x, y, width, height].allSatisfy(\.isFinite),
              x >= 0, y >= 0, width > 0, height > 0,
              x + width <= 1.00000001, y + height <= 1.00000001 else { return nil }
        return NSRect(x: frame.minX + CGFloat(x) * frame.width, y: frame.minY + CGFloat(y) * frame.height,
                      width: CGFloat(width) * frame.width, height: CGFloat(height) * frame.height)
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

/// ⌘Z takes back the last mask or marking edit, a whole drag or click at a
/// time, and ⇧⌘Z puts it back. Every document kind keeps its masks in one
/// dictionary, so one history serves cells, sections, PDF areas and drawing
/// regions; a marked copy's strokes and a PDF's chosen excerpt keep
/// histories of their own.
struct ShareEditHistory<Value: Equatable> {
    private static var limit: Int { 100 }
    private var undone: [Value] = []
    private var redone: [Value] = []

    var canUndo: Bool { !undone.isEmpty }
    var canRedo: Bool { !redone.isEmpty }

    /// An edit that changed nothing is not a step.
    mutating func record(from before: Value, to after: Value) {
        guard before != after else { return }
        undone.append(before)
        if undone.count > Self.limit { undone.removeFirst() }
        redone.removeAll()
    }

    /// The state before the last edit, or nil with nothing to take back.
    mutating func undo(from current: Value) -> Value? {
        guard let previous = undone.popLast() else { return nil }
        redone.append(current)
        return previous
    }

    mutating func redo(from current: Value) -> Value? {
        guard let next = redone.popLast() else { return nil }
        undone.append(current)
        return next
    }

    mutating func clear() {
        undone.removeAll()
        redone.removeAll()
    }
}

typealias ShareMaskHistory = ShareEditHistory<[String: ShareRedaction]>

struct ShareConfiguration {
    let scope: ShareAccessScope
    let redactions: [ShareRedaction]
    var markup: [ShareMarkStroke] = []
    /// A cited cell or row brings the rows around it and every column.
    var nearbyRows = false
    /// The sentence the share backs, shown to its recipient.
    var citedIn: String? = nil

    static let entireDocument = ShareConfiguration(scope: .document, redactions: [])
}

/// The sentence a citation sits in, read from the text around it: back to
/// the last sentence end before it, and on to the next one after it. A line
/// break ends a sentence too.
enum CitingSentence {
    private static let enders: Set<Character> = [".", "!", "?"]

    static func around(_ text: String, before: String, after: String) -> String {
        let head = before.split(omittingEmptySubsequences: false) { enders.contains($0) || $0.isNewline }.last.map(String.init) ?? ""
        var tail = ""
        for character in after {
            if character.isNewline { break }
            tail.append(character)
            if enders.contains(character) { break }
        }
        return (head + text + tail).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
