//  System-wide predictive provenance.
//
//  Watches typing in any application, reads the text around the caret through
//  the Accessibility API, asks the local Lasso server for source-backed
//  suggestions, and draws a native source suggestion panel next to the caret.
//  Tab inserts the suggestion into whatever app is focused.
//
//  Requires Accessibility and Input Monitoring permission. Nothing is captured
//  or stored: the focused text window is sent only to 127.0.0.1 and discarded.
//  Accepted source identities and deliberate opens are recorded locally for ranking.

import Cocoa
import ApplicationServices
import UniformTypeIdentifiers

// MARK: - Model

struct AssistSuggestion {
    let insertText: String       // what gets typed into the focused app
    let label: String            // headline shown in the box
    let detail: String           // value or context, shown dim
    let path: String             // originating source file
    let location: String         // exact sheet/cell, page, row, or passage
    /// Exact detected fragment from the request, revalidated before insertion.
    let replacement: CompletionReplacement?
    /// Indexed object behind the suggestion. Required to create a share; absent
    /// for plain sentence completions, which have nothing to link to.
    let objectId: String?
    let versionId: String?
    let snapshotId: String?
    /// Sentence completions retain source identity for usage without becoming shareable.
    let usageObjectId: String?
    let projectId: String
    let rankingReason: String?
    var previewText: String? = nil
    var sentenceContinuation = false

    var isShareable: Bool { objectId != nil }
}

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

/// What `Tab` does. Sharing is never implicit: the default inserts plain text
/// and creates no public token.
enum InsertionMode: String, CaseIterable {
    case plain, ask, share

    static var current: InsertionMode {
        InsertionMode(rawValue: UserDefaults.standard.string(forKey: "AssistInsertionMode") ?? "") ?? .plain
    }
    static func set(_ mode: InsertionMode) {
        UserDefaults.standard.set(mode.rawValue, forKey: "AssistInsertionMode")
    }
    var title: String {
        switch self {
        case .plain: return "Plain Text"
        case .ask: return "Ask Each Time"
        case .share: return "Share Link"
        }
    }

    var explanation: String {
        switch self {
        case .plain: return "Tab inserts the source's text. ⇧⌘↩ still offers a share link."
        case .ask: return "Tab asks whether to insert plain text or a share link."
        case .share: return "Tab opens the sharing options, then inserts a share link."
        }
    }
}

// MARK: - Permissions

enum AssistPermission {
    static var hasAccessibility: Bool { AXIsProcessTrusted() }

    /// True when this build is not trusted even though a previous build was.
    /// Ad-hoc signatures make the designated requirement a cdhash, so every
    /// rebuild invalidates the stored approval while the row stays visible.
    static var isListedButUntrusted: Bool {
        !AXIsProcessTrusted() && UserDefaults.standard.bool(forKey: "AssistWasTrusted")
    }

    static func rememberTrusted() {
        if AXIsProcessTrusted() { UserDefaults.standard.set(true, forKey: "AssistWasTrusted") }
    }

    static func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    }

    static var hasInputMonitoring: Bool {
        IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
    }

    @discardableResult
    static func requestInputMonitoring() -> Bool {
        IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    }

    static func openSettings(_ anchor: String) {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!
        NSWorkspace.shared.open(url)
    }
}

// MARK: - Caret context read through the Accessibility API

struct CaretContext {
    let text: String
    let cursor: Int
    /// Absolute UTF-16 offset of the first character in `text`.
    let windowStart: Int
    /// Caret offset in the element's own coordinate space (UTF-16 units),
    /// which is what Accessibility ranges are expressed in.
    let absoluteCaret: Int
    let selectionLength: Int
    let caretRect: CGRect?
    let element: AXUIElement
    let diagnosis: String
}

enum AssistLog {
    private static let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Lasso/assist.log")
    /// On by default while the feature settles; turn it off with
    /// `defaults write dry.lasso.desktop AssistDebug -bool false`.
    static var enabled = UserDefaults.standard.object(forKey: "AssistDebug") as? Bool ?? true
    private static let queue = DispatchQueue(label: "lasso.assist-log", qos: .utility)
    private static let formatter = ISO8601DateFormatter()
    private static var bytesWritten: UInt64?
    private static let maximumBytes: UInt64 = 1_048_576

    static func write(_ line: String) {
        guard enabled else { return }
        let timestamp = Date()
        queue.async { append(line, at: timestamp) }
    }

    private static func append(_ line: String, at timestamp: Date) {
        let stamp = formatter.string(from: timestamp)
        let entry = "[\(stamp)] \(line)\n"
        if bytesWritten == nil {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            bytesWritten = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.uint64Value ?? 0
        }
        let data = Data(entry.utf8)
        if (bytesWritten ?? 0) + UInt64(data.count) > maximumBytes {
            let previous = url.appendingPathExtension("1")
            try? FileManager.default.removeItem(at: previous)
            try? FileManager.default.moveItem(at: url, to: previous)
            bytesWritten = 0
        }
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? entry.write(to: url, atomically: true, encoding: .utf8)
        }
        bytesWritten = (bytesWritten ?? 0) + UInt64(data.count)
    }
}

enum AccessibilityReader {
    private static let excludedRoles: Set<String> = ["AXSecureTextField"]
    private static let maxContext = 1200
    /// Electron and other Chromium shells only publish an accessibility tree
    /// once a client asks for it.
    private static var primedApplications = Set<pid_t>()

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func focusedElement() -> (AXUIElement, pid_t)? {
        // Ask the frontmost application directly; the system-wide element is a
        // fallback because some apps answer only one of the two.
        if let front = NSWorkspace.shared.frontmostApplication {
            let pid = front.processIdentifier
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.4)
            if !primedApplications.contains(pid) {
                primedApplications.insert(pid)
                // Electron shells respond to the first, Chromium to the second.
                AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            }
            if let focused = attribute(application, kAXFocusedUIElementAttribute as String),
               CFGetTypeID(focused) == AXUIElementGetTypeID() {
                return (focused as! AXUIElement, pid)
            }
        }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.4)
        if let focused = attribute(system, kAXFocusedUIElementAttribute as String),
           CFGetTypeID(focused) == AXUIElementGetTypeID() {
            var pid: pid_t = 0
            AXUIElementGetPid(focused as! AXUIElement, &pid)
            return (focused as! AXUIElement, pid)
        }
        return nil
    }

    static func focusedContext(allowSelection: Bool = false) -> CaretContext? {
        guard let (field, pid) = focusedElement() else {
            AssistLog.write("no focused element")
            return nil
        }
        AXUIElementSetMessagingTimeout(field, 0.4)

        let role = attribute(field, kAXRoleAttribute as String) as? String ?? "?"
        let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "?"
        let subrole = attribute(field, kAXSubroleAttribute as String) as? String
        if excludedRoles.contains(role) || HostTextSafety.isSecure(role: role, subrole: subrole) {
            AssistLog.write("\(app): secure field, skipped")
            return nil
        }

        // Caret offset. Without it there is nothing to complete.
        var caret = -1
        var selection = CFRange(location: 0, length: 0)
        if let rangeValue = attribute(field, kAXSelectedTextRangeAttribute as String),
           CFGetTypeID(rangeValue) == AXValueGetTypeID() {
            var parsed = CFRange()
            if AXValueGetValue(rangeValue as! AXValue, .cfRange, &parsed) {
                selection = parsed
                caret = parsed.location
            }
        }

        guard allowSelection || selection.length == 0 else { return nil }
        if caret < 0, WebTextReader.hasNonemptySelection(from: field) { return nil }

        var window: String?
        var windowStart = -1

        // Preferred: ask for just the span before the caret. Works in apps that
        // never expose a whole AXValue (Word, Pages, large documents).
        if caret >= 0 {
            let start = max(0, caret - maxContext)
            var span = CFRange(location: start, length: caret - start)
            if span.length > 0, let axSpan = AXValueCreate(.cfRange, &span) {
                var text: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(
                    field, kAXStringForRangeParameterizedAttribute as CFString, axSpan, &text) == .success,
                   let string = text as? String, !string.isEmpty {
                    window = string
                    windowStart = start
                }
            }
        }

        // Fallback: the element's whole value, sliced around the caret.
        if window == nil, let full = attribute(field, kAXValueAttribute as String) as? String {
            let utf16 = Array(full.utf16)
            let position = caret >= 0 ? min(caret, utf16.count) : utf16.count
            let start = max(0, position - maxContext)
            if start < position {
                window = String(decoding: utf16[start..<position], as: UTF16.self)
                windowStart = start
            } else if position == 0 {
                window = ""
                windowStart = 0
            }
        }

        // Character ranges only work where the app answered with them. Web
        // content is addressed by markers instead, which carry no integer
        // offsets, so edits there fall back to synthesized keys.
        var rect = caret >= 0 ? caretRect(for: field, caret: caret, selection: selection) : nil
        var addressable = caret >= 0 && window != nil
        var route = rect == nil ? "range?" : "range"

        // Markers answer for web content, and often give a caret rectangle even
        // where the character-range path already produced text.
        if window == nil || rect == nil {
            if let reading = WebTextReader.read(from: field) {
                if window == nil, let markerText = reading.textBeforeCaret {
                    window = markerText
                    windowStart = reading.textWindowStart ?? -1
                    addressable = false
                    route = "marker"
                }
                if rect == nil, let markerRect = reading.caretRect {
                    rect = markerRect
                    route = route.hasPrefix("range") ? "range+markerRect" : route
                }
            }
        }
        // Measure the text, then settle for the field's own frame.
        if rect == nil, caret >= 0, let frame = fieldFrame(field) {
            if let measured = measuredCaretRect(field, caret: caret, field: frame) {
                rect = measured
                route += "+measured"
            } else {
                rect = frame
                route += "+fieldFrame"
            }
        }

        guard let text = window else {
            AssistLog.write("\(app) role=\(role) caret=\(caret): no readable text")
            describeUnreadable(field, app: app, role: role)
            return nil
        }

        AssistLog.write("\(app) role=\(role) via=\(route) caret=\(caret) chars=\(text.count) rect=\(rect.map { "\(Int($0.origin.x)),\(Int($0.origin.y))" } ?? "none")")
        let textLength = Array(text.utf16).count
        return CaretContext(text: text, cursor: textLength,
                            windowStart: windowStart,
                            absoluteCaret: addressable ? caret : -1, selectionLength: selection.length,
                            caretRect: rect, element: field, diagnosis: "\(app)/\(role)")
    }

    /// Screen rectangle of the insertion point, in Accessibility's top-left
    /// coordinate space. Falls back to the focused element's own frame so the
    /// box still lands on the text rather than the pointer.
    private static func caretRect(for element: AXUIElement, caret: Int, selection: CFRange) -> CGRect? {
        func bounds(_ location: Int, _ length: Int) -> CGRect? {
            guard location >= 0 else { return nil }
            var range = CFRange(location: location, length: length)
            guard let axRange = AXValueCreate(.cfRange, &range) else { return nil }
            var value: CFTypeRef?
            guard AXUIElementCopyParameterizedAttributeValue(
                    element, kAXBoundsForRangeParameterizedAttribute as CFString, axRange, &value) == .success,
                  let box = value, CFGetTypeID(box) == AXValueGetTypeID() else { return nil }
            var rect = CGRect.zero
            guard AXValueGetValue(box as! AXValue, .cgRect, &rect),
                  rect.origin.x.isFinite, rect.origin.y.isFinite,
                  rect.height > 0, rect.height < 400 else { return nil }
            return rect
        }

        if let rect = bounds(caret, 0) { return rect }
        if let rect = bounds(max(0, caret - 1), 1) { return rect }
        if selection.length > 0, let rect = bounds(selection.location, selection.length) { return rect }
        return nil
    }

    /// The focused field's own frame.
    private static func fieldFrame(_ element: AXUIElement) -> CGRect? {
        guard let positionValue = attribute(element, kAXPositionAttribute as String),
              let sizeValue = attribute(element, kAXSizeAttribute as String),
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
              size.height > 0, size.width > 0 else { return nil }
        return CGRect(origin: origin, size: size)
    }

    /// Single-line fields such as a browser address bar often refuse
    /// AXBoundsForRange while still handing over an attributed string. Measuring
    /// the text before the caret puts the box under the caret rather than under
    /// the field.
    private static func measuredCaretRect(_ element: AXUIElement, caret: Int, field: CGRect) -> CGRect? {
        guard caret > 0 else { return CGRect(x: field.minX, y: field.minY, width: 1, height: field.height) }
        var range = CFRange(location: 0, length: caret)
        guard let axRange = AXValueCreate(.cfRange, &range) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
                element, "AXAttributedStringForRange" as CFString, axRange, &value) == .success,
              let attributed = value as? NSAttributedString, attributed.length > 0 else { return nil }
        let width = attributed.size().width
        guard width.isFinite, width >= 0 else { return nil }
        return CGRect(x: min(field.minX + width, field.maxX - 1), y: field.minY,
                      width: 1, height: field.height)
    }

    /// Logged once per app+role: exactly which attributes the focused element
    /// offers. This is what turns "it does not work here" into a fix.
    private static var described = Set<String>()
    private static func describeUnreadable(_ element: AXUIElement, app: String, role: String) {
        let key = "\(app)/\(role)"
        guard !described.contains(key) else { return }
        described.insert(key)

        var names: CFArray?
        var parameterized: CFArray?
        AXUIElementCopyAttributeNames(element, &names)
        AXUIElementCopyParameterizedAttributeNames(element, &parameterized)
        let attributes = (names as? [String] ?? []).sorted()
        let parameters = (parameterized as? [String] ?? []).sorted()
        AssistLog.write("  attributes[\(key)]: \(attributes.joined(separator: ", "))")
        AssistLog.write("  parameterized[\(key)]: \(parameters.joined(separator: ", "))")

        // Walk up a little: the readable node is often an ancestor.
        var current = element
        for depth in 1...4 {
            guard let parent = attribute(current, kAXParentAttribute as String),
                  CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            current = parent as! AXUIElement
            let parentRole = attribute(current, kAXRoleAttribute as String) as? String ?? "?"
            var parentNames: CFArray?
            AXUIElementCopyAttributeNames(current, &parentNames)
            let hasValue = (parentNames as? [String] ?? []).contains(kAXValueAttribute as String)
            AssistLog.write("  ancestor[\(depth)] role=\(parentRole) hasAXValue=\(hasValue)")
        }
    }

    /// Caret rectangle alone, without pulling any text. Cheap enough to run on
    /// every keystroke, which is what keeps the box pinned to the caret.
    static func focusedCaretRect() -> CGRect? {
        guard let (field, _) = focusedElement() else { return nil }
        return caretRect(of: field)
    }

    /// Measure a known editor after its owner has been validated. Avoid a
    /// second focus lookup that could accidentally measure another window.
    static func caretRect(of field: AXUIElement) -> CGRect? {
        var selection = CFRange(location: 0, length: 0)
        var caret = -1
        if let rangeValue = attribute(field, kAXSelectedTextRangeAttribute as String),
           CFGetTypeID(rangeValue) == AXValueGetTypeID() {
            var parsed = CFRange()
            if AXValueGetValue(rangeValue as! AXValue, .cfRange, &parsed) {
                selection = parsed
                caret = parsed.location
            }
        }
        if caret >= 0, let rect = caretRect(for: field, caret: caret, selection: selection) { return rect }
        if let rect = WebTextReader.caretRect(from: field) { return rect }
        if caret >= 0, let frame = fieldFrame(field) {
            return measuredCaretRect(field, caret: caret, field: frame) ?? frame
        }
        return nil
    }

    /// Replaces `length` characters ending at the caret with `text`. A length of
    /// zero is a plain insertion.
    /// Replaces the partial word with `text`.
    ///
    /// Accessibility writes are tried first because they are instant and do not
    /// disturb the user's clipboard or key state, but several applications
    /// report success while changing nothing. The result is therefore read back
    /// and typed instead when it did not land.
    static func replace(length: Int, at caret: Int, with text: String, in element: AXUIElement,
                        expected: CaretContext, expectedPrefix: String,
                        completion: ((Bool) -> Void)? = nil) {
        guard let initial = focusedContext(), CFEqual(initial.element, element),
              initial.windowStart == expected.windowStart, initial.absoluteCaret == caret,
              CompletionTransaction.equivalentHostText(Array(initial.text.utf16), Array(expected.text.utf16)) else {
            completion?(false); return
        }
        let before = CompletionSnapshot(documentStart: expected.windowStart, text: Array(expected.text.utf16))
        let originalValue = attribute(element, kAXValueAttribute as String) as? String
        var selectedRange = false
        var wroteText = false

        if caret >= 0 {
            if length > 0, caret - length >= 0 {
                var range = CFRange(location: caret - length, length: length)
                if let axRange = AXValueCreate(.cfRange, &range) {
                    selectedRange = AXUIElementSetAttributeValue(
                        element, kAXSelectedTextRangeAttribute as CFString, axRange) == .success
                }
            }
            if length == 0 || selectedRange {
                wroteText = AXUIElementSetAttributeValue(
                    element, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success
            }
        }

        // Let the application apply the change before judging it.
        DispatchQueue.main.asyncAfter(deadline: .now() + (wroteText ? 0.12 : 0.05)) {
            if wroteText, landed(text, in: element) {
                AssistLog.write("insert: accessibility write landed")
                completion?(true)
                return
            }
            if wroteText { AssistLog.write("insert: accessibility reported success but nothing changed; typing") }
            else { AssistLog.write("insert: typing (selectedRange=\(selectedRange) caret=\(caret))") }
            guard let current = focusedContext(allowSelection: true), CFEqual(current.element, element),
                  CompletionTransaction.canRetry(before: before,
                    current: CompletionSnapshot(documentStart: current.windowStart, text: Array(current.text.utf16)),
                    selectionLength: current.selectionLength, expectedPrefix: expectedPrefix,
                    selectedPrefix: selectedRange) else { completion?(false); return }
            if let originalValue, attribute(element, kAXValueAttribute as String) as? String != originalValue {
                completion?(false); return
            }
            if selectedRange,
               attribute(element, kAXSelectedTextAttribute as String) as? String != expectedPrefix {
                completion?(false); return
            }
            // A live selection already covers the partial word.
            SyntheticKeyboard.deleteBackwards(selectedRange ? 0 : expectedPrefix.count)
            SyntheticKeyboard.type(text)
            // Confirm the typed result rather than assuming it arrived.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
                let ok = landed(text, in: element)
                AssistLog.write("insert: typed result \(ok ? "confirmed" : "not detected")")
                completion?(ok)
            }
        }
    }

    static func canPaste(in element: AXUIElement, before: CompletionSnapshot, caret: Int,
                         expectedPrefix: String, selected: Bool) -> Bool {
        guard let current = focusedContext(allowSelection: true), CFEqual(current.element, element),
              CompletionTransaction.canRetry(before: before,
                current: CompletionSnapshot(documentStart: current.windowStart, text: Array(current.text.utf16)),
                selectionLength: current.selectionLength, expectedPrefix: expectedPrefix,
                selectedPrefix: selected) else { return false }
        if selected {
            return attribute(element, kAXSelectedTextAttribute as String) as? String == expectedPrefix
        }
        return current.absoluteCaret == caret
    }

    static func hyperlinkPresent(_ label: String, url: URL, in context: CaretContext) -> Bool {
        let length = label.utf16.count
        if context.absoluteCaret >= length {
            var range = CFRange(location: context.absoluteCaret - length, length: length)
            if let axRange = AXValueCreate(.cfRange, &range) {
                var value: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(context.element,
                    "AXAttributedStringForRange" as CFString, axRange, &value) == .success,
                   let text = value as? NSAttributedString, text.string == label,
                   RichTextInserter.containsLink(text, to: url) { return true }
            }
        }
        if let text = WebTextReader.attributedTextBeforeCaret(expectedText: label, from: context.element),
           RichTextInserter.containsLink(text, to: url) { return true }
        return WebTextReader.hyperlinkBeforeCaret(label, url: url, caret: context.absoluteCaret,
                                                 from: context.element)
    }

    /// True when the text now sits immediately before the caret.
    static func landed(_ text: String, in element: AXUIElement) -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let context = focusedContext(), context.element == element else { return false }
        return CompletionTransaction.insertionIsAtCaret(text, in: context.text)
    }
}

// MARK: - The completion box

/// Material backing for the reference popover shape. The blur is split into a
/// rounded body and a small caret pointer so the panel remains genuinely
/// translucent instead of painting an opaque triangle over the host app.
final class AssistBubbleContainer: NSView {
    private let bodyEffect: NSView
    private let pointerEffect = NSVisualEffectView()
    private let overlay: AssistBoxView

    init(content: AssistBoxView) {
        overlay = content
        bodyEffect = NativeMaterial.glassContainer(content: NSView(frame: content.frame),
                                                    cornerRadius: content.bubbleCornerRadius)
        super.init(frame: content.frame)
        wantsLayer = true

        addSubview(bodyEffect)
        for effect in [pointerEffect] {
            effect.material = .popover
            effect.blendingMode = .behindWindow
            effect.state = .active
            effect.wantsLayer = true
            addSubview(effect)
        }
        bodyEffect.layer?.cornerRadius = content.bubbleCornerRadius
        bodyEffect.layer?.masksToBounds = true

        content.frame = bounds
        content.autoresizingMask = [.width, .height]
        addSubview(content)
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        let pointerHeight = overlay.pointerHeight
        let bodyHeight = max(0, bounds.height - pointerHeight)
        bodyEffect.frame = overlay.pointerAtTop
            ? NSRect(x: 0, y: 0, width: bounds.width, height: bodyHeight)
            : NSRect(x: 0, y: pointerHeight, width: bounds.width, height: bodyHeight)

        let width = overlay.pointerWidth
        pointerEffect.frame = NSRect(
            x: min(max(overlay.pointerX - width / 2, 0), max(0, bounds.width - width)),
            y: overlay.pointerAtTop ? bodyHeight : 0,
            width: width,
            height: pointerHeight)
        let mask = CAShapeLayer()
        let path = CGMutablePath()
        if overlay.pointerAtTop {
            path.move(to: CGPoint(x: 0, y: 0))
            path.addLine(to: CGPoint(x: width, y: 0))
            path.addLine(to: CGPoint(x: width / 2, y: pointerHeight))
        } else {
            path.move(to: CGPoint(x: 0, y: pointerHeight))
            path.addLine(to: CGPoint(x: width, y: pointerHeight))
            path.addLine(to: CGPoint(x: width / 2, y: 0))
        }
        path.closeSubpath()
        mask.path = path
        pointerEffect.layer?.mask = mask
    }
}

/// Compact, caret-anchored project suggestions in the density and hierarchy of
/// a native Spotlight or password-manager result panel.
final class AssistBoxView: NSView {
    enum Mode { case suggestions, confirmShare, message }
    var mode: Mode = .suggestions
    var suggestions: [AssistSuggestion] = [] {
        didSet { revealSelectedSuggestion() }
    }
    var selected: Int = 0 {
        didSet { revealSelectedSuggestion() }
    }
    private(set) var firstVisibleSuggestion = 0
    private let visibleSuggestionCount = 4
    var title: String = "Dependency"
    var confirmChoices: [String] = []
    var messageLines: [String] = []
    var sourceScoped = false
    var preview: AssistDocumentPreview?
    var isPreviewLoading = false
    var previewError: String?
    var onSelectRow: ((Int) -> Void)?
    var onInsert: (() -> Void)?
    var onLocalLink: (() -> Void)?
    var onShare: (() -> Void)?
    var onOpenSource: (() -> Void)?
    var onAllSources: (() -> Void)?
    var onDismiss: (() -> Void)?
    fileprivate let closeButton = NSButton()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Dismiss suggestions")
        closeButton.bezelStyle = .circular
        closeButton.isBordered = false
        closeButton.imagePosition = .imageOnly
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.toolTip = "Dismiss suggestions (Esc)"
        closeButton.setAccessibilityLabel("Dismiss suggestions")
        closeButton.target = self
        closeButton.action = #selector(dismissSuggestions)
        addSubview(closeButton)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        closeButton.frame = NSRect(x: bounds.width - 34, y: bodyTop + 6, width: 24, height: 24)
    }

    @objc private func dismissSuggestions() { onDismiss?() }

    private let panelWidth: CGFloat = 760
    private let leftWidth: CGFloat = 366
    private let headerHeight: CGFloat = 31
    private let suggestionHeight: CGFloat = 72
    private let choiceHeight: CGFloat = 34
    private let messageHeight: CGFloat = 22
    private let footerHeight: CGFloat = 55
    fileprivate let pointerHeight: CGFloat = 12
    fileprivate let pointerWidth: CGFloat = 21
    fileprivate let bubbleCornerRadius: CGFloat = 18
    fileprivate var pointerX: CGFloat = 84 {
        didSet { superview?.needsLayout = true; needsDisplay = true }
    }
    fileprivate var pointerAtTop = true {
        didSet { superview?.needsLayout = true; needsLayout = true; needsDisplay = true }
    }
    private let suggestionBodyHeight: CGFloat = 384
    private let navigationHeight: CGFloat = 32

    private var bodyRows: Int {
        switch mode {
        case .suggestions: return max(1, suggestions.count)
        case .confirmShare: return max(1, confirmChoices.count)
        case .message: return max(1, messageLines.count)
        }
    }

    private var rowHeight: CGFloat {
        switch mode {
        case .suggestions: return suggestionHeight
        case .confirmShare: return choiceHeight
        case .message: return messageHeight
        }
    }

    private var bodyHeight: CGFloat {
        if mode == .suggestions { return suggestionBodyHeight }
        let footer = mode == .message ? CGFloat(8) : footerHeight
        return headerHeight + rowHeight * CGFloat(bodyRows) + footer
    }

    private var bodyTop: CGFloat { pointerAtTop ? pointerHeight : 0 }
    private var bodyRect: NSRect {
        NSRect(x: 0, y: bodyTop, width: bounds.width, height: bodyHeight)
    }
    private var footerY: CGFloat { bodyTop + bodyHeight - footerHeight }

    var visibleSuggestionRange: Range<Int> {
        firstVisibleSuggestion..<min(suggestions.count, firstVisibleSuggestion + visibleSuggestionCount)
    }

    private func revealSelectedSuggestion() {
        let selection = min(max(0, selected), max(0, suggestions.count - 1))
        let lastStart = max(0, suggestions.count - visibleSuggestionCount)
        firstVisibleSuggestion = min(firstVisibleSuggestion, lastStart)
        if selection < firstVisibleSuggestion {
            firstVisibleSuggestion = selection
        } else if selection >= firstVisibleSuggestion + visibleSuggestionCount {
            firstVisibleSuggestion = selection - visibleSuggestionCount + 1
        }
    }

    var boxSize: NSSize {
        let width = mode == .suggestions ? panelWidth : leftWidth
        return NSSize(width: width, height: bodyHeight + pointerHeight)
    }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        bounds.fill()
        drawBubbleChrome()

        if mode != .suggestions {
            drawText("Lasso", in: NSRect(x: 14, y: bodyTop + 11, width: 46, height: 17),
                     font: NSFont.systemFont(ofSize: 11.5, weight: .semibold), color: .labelColor)
            // The share question is the header, so the choices below it read as answers.
            let context = mode == .confirmShare || sourceScoped
                ? title.replacingOccurrences(of: "_", with: " ") : "Project sources"
            drawText(context, in: NSRect(x: 64, y: bodyTop + 11, width: leftWidth - 118, height: 17),
                     font: NSFont.systemFont(ofSize: 10.5), color: .secondaryLabelColor)
            drawSeparator(at: bodyTop + headerHeight)
        }

        var y = bodyTop + (mode == .suggestions ? 0 : headerHeight)
        switch mode {
        case .suggestions:
            drawText(sourceScoped ? "‹ All sources" : "All sources",
                     in: NSRect(x: 20, y: bodyTop + 10, width: 130, height: 16),
                     font: .systemFont(ofSize: 11, weight: .medium),
                     color: sourceScoped ? .controlAccentColor : .secondaryLabelColor)
            if suggestions.count > visibleSuggestionCount {
                drawText("↑↓  \(selected + 1) of \(suggestions.count)",
                         in: NSRect(x: leftWidth - 150, y: bodyTop + 10, width: 130, height: 16),
                         font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor,
                         alignment: .right)
            }
            if suggestions.isEmpty {
                drawText("No matching indexed source",
                         in: NSRect(x: 22, y: bodyTop + 29,
                                   width: leftWidth - 44, height: 17),
                         font: NSFont.systemFont(ofSize: 11), color: .secondaryLabelColor)
            }
            for (slot, index) in visibleSuggestionRange.enumerated() {
                let suggestion = suggestions[index]
                let slotY = bodyTop + navigationHeight + CGFloat(slot) * suggestionHeight
                let selection = NSRect(x: 10, y: slotY + 13,
                                       width: leftWidth - 20, height: 63)
                if index == selected {
                    drawSelectedSurface(in: selection,
                        color: DirectoryColorPreferences.color(for: suggestion.projectId)?.color ?? .controlAccentColor)
                }

                drawSourceIcon(for: suggestion.path,
                               in: NSRect(x: 22, y: slotY + 26, width: 32, height: 32))

                let detailWidth: CGFloat = suggestion.detail.isEmpty ? 0 : 82
                drawText(suggestion.label,
                         in: NSRect(x: 65, y: slotY + 27,
                                   width: leftWidth - 85 - detailWidth, height: 17),
                         font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
                         color: .labelColor)
                if !suggestion.detail.isEmpty {
                    drawText(suggestion.detail,
                             in: NSRect(x: leftWidth - detailWidth - 20, y: slotY + 27,
                                       width: detailWidth, height: 17),
                             font: NSFont.systemFont(ofSize: 11.5, weight: .semibold),
                             color: .labelColor, alignment: .right)
                }
                let source = (suggestion.path as NSString).lastPathComponent
                let breadcrumb = [suggestion.rankingReason ?? "", source.isEmpty ? "Project workspace" : source, suggestion.location]
                    .filter { !$0.isEmpty }.joined(separator: "  ·  ")
                drawText(breadcrumb,
                         in: NSRect(x: 65, y: slotY + 47,
                                   width: leftWidth - 87, height: 15),
                         font: NSFont.systemFont(ofSize: 11),
                         color: .secondaryLabelColor)
                if index < visibleSuggestionRange.upperBound - 1 {
                    drawInsetSeparator(at: bodyTop + navigationHeight + 6 + CGFloat(slot + 1) * suggestionHeight,
                                       from: 26)
                }
            }

        case .confirmShare:
            for (index, choice) in confirmChoices.enumerated() {
                let row = NSRect(x: 0, y: y, width: bounds.width, height: choiceHeight)
                if index == selected { drawSelectedSurface(in: row.insetBy(dx: 5, dy: 3)) }
                drawText(choice, in: NSRect(x: 14, y: row.minY + 12,
                         width: row.width - 28, height: 17),
                         font: NSFont.systemFont(ofSize: 11.5, weight: .medium), color: .labelColor)
                y += choiceHeight
                if index < confirmChoices.count - 1 { drawInsetSeparator(at: y, from: 14) }
            }

        case .message:
            for line in messageLines {
                drawText(line, in: NSRect(x: 14, y: y + 7, width: bounds.width - 28, height: 17),
                         font: NSFont.systemFont(ofSize: 11), color: .secondaryLabelColor)
                y += messageHeight
            }
        }

        guard mode != .message else { return }
        drawSeparator(at: footerY)
        if mode == .suggestions {
            drawFooterActions()
            drawDocumentPreview(footerY: footerY)
        } else {
            drawText("↑↓  Move       ↩  Choose       Esc  Cancel",
                     in: NSRect(x: 18, y: footerY + 24, width: leftWidth - 36, height: 18),
                     font: NSFont.systemFont(ofSize: 11), color: .secondaryLabelColor)
        }
    }

    private func drawSelectedSurface(in rect: NSRect, color: NSColor = .controlAccentColor) {
        color.withAlphaComponent(
            NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? 0.30 : 0.16).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10).fill()
        color.withAlphaComponent(0.45).setStroke()
        let outline = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        outline.lineWidth = 0.75
        outline.stroke()
    }

    private func drawBubbleChrome() {
        // Keep the system glass visible; an opaque painted gradient defeats it.
        // A semantic content tint keeps text readable over every host document.
        // Glass still provides the edge, depth, and surrounding material.
        let opacity: CGFloat = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency ? 1 : 0.88
        NSColor.windowBackgroundColor.withAlphaComponent(opacity).setFill()
        NSBezierPath(roundedRect: bodyRect, xRadius: bubbleCornerRadius,
                     yRadius: bubbleCornerRadius).fill()
        NSColor.separatorColor.setStroke()
        let outline = NSBezierPath(roundedRect: bodyRect.insetBy(dx: 0.5, dy: 0.5),
                                   xRadius: bubbleCornerRadius, yRadius: bubbleCornerRadius)
        outline.lineWidth = 0.5
        outline.stroke()
    }

    private enum FooterCommand { case tab, insertText, share }
    private struct FooterAction {
        let symbol: String
        let symbolWidth: CGFloat
        let title: String
        let command: FooterCommand
    }
    /// Left edges of the footer slots; a click belongs to the slot it falls in.
    private let footerSlots: [CGFloat] = [18, 108, 237]

    /// Only shortcuts that do something different are listed. With plain-text
    /// insertion, Tab and ⌘↩ do the same thing, so ⌘↩ is not shown twice.
    private var footerActions: [FooterAction] {
        let suggestion = suggestions.indices.contains(selected) ? suggestions[selected] : nil
        let insertTitle = suggestion?.replacement?.expectedText.isEmpty == false ? "Replace" : "Insert"
        let shareable = suggestion?.isShareable == true
        let mode = shareable ? InsertionMode.current : .plain
        let tabTitle = mode == .share ? "Share…" : mode == .ask ? "Text or link…" : insertTitle
        var actions = [FooterAction(symbol: "⇥", symbolWidth: 18, title: tabTitle, command: .tab)]
        if mode != .plain {
            actions.append(FooterAction(symbol: "⌘↩", symbolWidth: 29, title: insertTitle, command: .insertText))
        }
        if shareable && mode != .share {
            actions.append(FooterAction(symbol: "⇧⌘↩", symbolWidth: 36, title: "Share…", command: .share))
        }
        return actions
    }

    private func drawFooterActions() {
        for (action, x) in zip(footerActions, footerSlots) {
            drawShortcut(action.symbol, title: action.title, x: x, y: footerY + 18, symbolWidth: action.symbolWidth)
        }
    }

    private func footerCommand(at x: CGFloat) -> FooterCommand? {
        let actions = footerActions
        let slot = footerSlots.lastIndex(where: { x >= $0 }) ?? 0
        return actions.indices.contains(slot) ? actions[slot].command : nil
    }

    private func drawShortcut(_ symbol: String, title: String, x: CGFloat, y: CGFloat,
                              symbolWidth: CGFloat) {
        drawText(symbol, in: NSRect(x: x, y: y - 1, width: symbolWidth, height: 17),
                 font: NSFont.systemFont(ofSize: 12.5),
                 color: .tertiaryLabelColor, alignment: .center)
        drawText(title, in: NSRect(x: x + symbolWidth + 6, y: y, width: 88, height: 17),
                 font: NSFont.systemFont(ofSize: 11),
                 color: .secondaryLabelColor)
    }

    private func drawSymbolShortcut(_ symbol: String, title: String, x: CGFloat, y: CGFloat,
                                    symbolWidth: CGFloat) {
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [.secondaryLabelColor])) {
            image.isTemplate = false
            image.draw(in: NSRect(x: x + (symbolWidth - 14) / 2, y: y,
                                  width: 14, height: 14),
                       from: .zero, operation: .sourceOver, fraction: 0.62,
                       respectFlipped: true, hints: nil)
        }
        drawText(title, in: NSRect(x: x + symbolWidth + 6, y: y, width: 64, height: 17),
                 font: NSFont.systemFont(ofSize: 11), color: .secondaryLabelColor)
    }

    private func drawSourceIcon(for path: String, in rect: NSRect) {
        let type = UTType(filenameExtension: (path as NSString).pathExtension) ?? .data
        let image = NSWorkspace.shared.icon(for: type)
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1,
                   respectFlipped: true, hints: nil)
    }


    private func drawDocumentPreview(footerY: CGFloat) {
        let rightX = leftWidth
        let rightWidth = bounds.width - rightX

        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(roundedRect: bodyRect,
                     xRadius: bubbleCornerRadius, yRadius: bubbleCornerRadius).addClip()
        NSColor.controlBackgroundColor.withAlphaComponent(0.32).setFill()
        NSRect(x: rightX, y: bodyRect.minY,
               width: rightWidth, height: bodyRect.height).fill()
        NSGraphicsContext.current?.restoreGraphicsState()

        NSColor.separatorColor.withAlphaComponent(0.08).setStroke()
        let divider = NSBezierPath()
        divider.lineWidth = 0.5
        divider.move(to: NSPoint(x: rightX, y: bodyRect.minY + 8))
        divider.line(to: NSPoint(x: rightX, y: bodyRect.maxY - 8))
        divider.stroke()

        let fallback = selected < suggestions.count ? suggestions[selected] : nil
        let path = preview?.path ?? fallback?.path ?? ""
        let filename = preview?.filename ?? (path as NSString).lastPathComponent
        drawSourceIcon(for: path,
                       in: NSRect(x: rightX + 19, y: bodyTop + 19, width: 32, height: 32))

        drawText(filename.isEmpty ? "Document preview" : filename,
                 in: NSRect(x: rightX + 63, y: bodyTop + 21,
                            width: rightWidth - 121, height: 18),
                 font: NSFont.systemFont(ofSize: 12.5, weight: .semibold), color: .labelColor)

        let location = preview?.pdfPage.map { "Page \($0.pageNumber)" }
            ?? [preview?.location, fallback?.location].compactMap { $0 }
                .first { !$0.isEmpty && $0 != "—" } ?? ""
        let sheet = location.components(separatedBy: "!").first ?? ""
        let parent = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
        let subtitle = !sheet.isEmpty ? sheet
            : (!parent.isEmpty ? parent : (preview?.objectType ?? "Indexed source"))
        drawText(subtitle,
                 in: NSRect(x: rightX + 63, y: bodyTop + 40,
                            width: rightWidth - 121, height: 15),
                 font: NSFont.systemFont(ofSize: 10), color: .secondaryLabelColor)

        let previewRect = NSRect(x: rightX + 18, y: bodyTop + 72,
                                 width: rightWidth - 36,
                                 height: preview?.model == nil && preview?.pdf == nil
                                    && preview?.textBlocks.isEmpty != false ? 184 : 222)
        if isPreviewLoading {
            drawText("Loading document preview…",
                     in: NSRect(x: previewRect.minX, y: previewRect.midY - 8,
                               width: previewRect.width, height: 17),
                     font: NSFont.systemFont(ofSize: 10), color: .secondaryLabelColor,
                     alignment: .center)
        } else if let pdfPage = preview?.pdfPage {
            drawPDFPreview(pdfPage, in: previewRect)
        } else if let model = preview?.model {
            AssistModelRenderer.draw(model, in: previewRect)
        } else if let preview, !preview.rows.isEmpty {
            drawTablePreview(preview, in: previewRect)
        } else if let preview, !preview.textBlocks.isEmpty {
            drawTextPreview(preview, in: previewRect)
        } else {
            NSColor.controlBackgroundColor.withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: previewRect, xRadius: 8, yRadius: 8).fill()
            NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
            NSBezierPath(roundedRect: previewRect, xRadius: 8, yRadius: 8).stroke()
            drawText("Document preview",
                     in: NSRect(x: previewRect.minX + 13, y: previewRect.minY + 13,
                               width: previewRect.width - 26, height: 16),
                     font: NSFont.systemFont(ofSize: 11, weight: .semibold), color: .labelColor)
            let excerpt = previewError ?? preview?.unavailableReason ?? (preview?.context.isEmpty == false
                ? preview!.context
                : "Select a source-backed result to preview its exact document context.")
            drawMultilineText(excerpt,
                              in: NSRect(x: previewRect.minX + 13, y: previewRect.minY + 38,
                                        width: previewRect.width - 26, height: previewRect.height - 51),
                              font: NSFont.systemFont(ofSize: 10), color: .secondaryLabelColor)
        }

        if !location.isEmpty {
            let extensionName = (path as NSString).pathExtension.lowercased()
            let prefix = ["xls", "xlsx", "csv", "tsv"].contains(extensionName)
                ? "Matched cell:  " : "Matched location:  "
            drawText(prefix + location,
                     in: NSRect(x: rightX + 18, y: footerY - 22,
                               width: rightWidth - 36, height: 16),
                     font: NSFont.systemFont(ofSize: 10.5), color: .secondaryLabelColor)
        }

        NSColor.separatorColor.withAlphaComponent(0.09).setStroke()
        let footerLine = NSBezierPath()
        footerLine.lineWidth = 0.5
        footerLine.move(to: NSPoint(x: rightX + 8, y: footerY))
        footerLine.line(to: NSPoint(x: bounds.width - 8, y: footerY))
        footerLine.stroke()

        let gap: CGFloat = 8
        let buttonWidth = (rightWidth - 36 - gap) / 2
        drawActionButton("Open file", symbol: "arrow.up.right.square",
                         in: NSRect(x: rightX + 18, y: footerY + 6,
                                   width: buttonWidth, height: 35))
        drawActionButton("Share link…", symbol: "link",
                         in: NSRect(x: rightX + 18 + buttonWidth + gap, y: footerY + 6,
                                   width: buttonWidth, height: 35))
    }

    private func drawPDFPreview(_ page: AssistPDFPageImage, in rect: NSRect) {
        let outline = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
        NSColor.controlBackgroundColor.withAlphaComponent(0.3).setFill()
        outline.fill()
        NSGraphicsContext.current?.saveGraphicsState()
        outline.addClip()
        let available = rect.insetBy(dx: 6, dy: 6)
        let size = page.image.size
        let scale = min(available.width / size.width, available.height / size.height)
        let target = NSRect(x: available.midX - size.width * scale / 2,
                            y: available.midY - size.height * scale / 2,
                            width: size.width * scale, height: size.height * scale)
        NSColor.white.setFill()
        target.fill()
        page.image.draw(in: target, from: .zero, operation: .sourceOver,
                        fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
        NSGraphicsContext.current?.restoreGraphicsState()
        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        outline.stroke()
    }

    /// Markdown renders as formatted text; other text sources show their lines.
    /// Either way the cited passage is highlighted in the source's colour.
    private func drawTextPreview(_ preview: AssistDocumentPreview, in rect: NSRect) {
        let projectId = suggestions.indices.contains(selected) ? suggestions[selected].projectId : nil
        let sourceColor = DirectoryColorPreferences.color(for: projectId)?.color ?? .controlAccentColor
        let outline = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
        NSColor.textBackgroundColor.withAlphaComponent(0.65).setFill()
        outline.fill()
        AssistMarkdown.draw(preview.textBlocks, in: rect, accent: sourceColor)
        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        outline.stroke()
    }

    private func drawTablePreview(_ preview: AssistDocumentPreview, in rect: NSRect) {
        let projectId = suggestions.indices.contains(selected) ? suggestions[selected].projectId : nil
        let sourceColor = DirectoryColorPreferences.color(for: projectId)?.color ?? .systemGreen
        let availableColumns = max(1, preview.rows.map(\.cells.count).max() ?? 1)
        let count = min(4, availableColumns)
        let selectedColumn = preview.rows.flatMap { row in
            row.cells.enumerated().filter { $0.element.cited }.map(\.offset)
        }.first ?? 0
        let windowStart = max(1, min(selectedColumn - 1, availableColumns - (count - 1)))
        let visibleColumns = availableColumns <= count
            ? Array(0..<count)
            : [0] + Array(windowStart..<(windowStart + count - 1))
        let rowHeaderWidth: CGFloat = 37
        let dataWidth = rect.width - rowHeaderWidth
        let columnWidths: [CGFloat] = count == 2
            ? [dataWidth * 0.56, dataWidth * 0.44]
            : Array(repeating: dataWidth / CGFloat(count), count: count)
        func columnOffset(_ column: Int) -> CGFloat {
            columnWidths.prefix(column).reduce(0, +)
        }
        let rowHeight: CGFloat = 30.5
        let headerHeight: CGFloat = 66
        let maximumRows = max(1, Int((rect.height - headerHeight) / rowHeight))
        let selectedRow = preview.rows.firstIndex { $0.cells.contains { $0.cited } } ?? 0
        let rowStart = max(0, min(selectedRow - maximumRows / 2, preview.rows.count - maximumRows))
        let rows = Array(preview.rows.dropFirst(rowStart).prefix(maximumRows))
        let tableHeight = headerHeight + rowHeight * CGFloat(rows.count)
        let table = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: tableHeight)
        let roundedTable = NSBezierPath(roundedRect: table, xRadius: 8, yRadius: 8)

        NSColor.textBackgroundColor.withAlphaComponent(0.65).setFill()
        roundedTable.fill()

        NSGraphicsContext.current?.saveGraphicsState()
        roundedTable.addClip()

        let header = NSRect(x: table.minX, y: table.minY, width: table.width, height: headerHeight)
        NSColor.controlBackgroundColor.withAlphaComponent(0.10).setFill()
        header.fill()

        for (column, sourceColumn) in visibleColumns.enumerated() {
            let letter = sourceColumn < preview.columns.count ? preview.columns[sourceColumn] : spreadsheetColumn(sourceColumn)
            let heading = sourceColumn < preview.headers.count ? preview.headers[sourceColumn] : ""
            let x = table.minX + rowHeaderWidth + columnOffset(column)
            drawMultilineText(heading.isEmpty ? "Column \(letter)" : heading,
                     in: NSRect(x: x + 8, y: table.minY + 10, width: columnWidths[column] - 16, height: 49),
                     font: NSFont.systemFont(ofSize: 11, weight: .semibold), color: .labelColor)
        }

        var citedOutlines: [NSRect] = []
        for (rowIndex, row) in rows.enumerated() {
            let y = table.minY + headerHeight + rowHeight * CGFloat(rowIndex)
            let citedColumns = visibleColumns.enumerated().filter {
                $0.element < row.cells.count && row.cells[$0.element].cited
            }.map(\.offset)
            let citedRow = !citedColumns.isEmpty

            drawText(row.rowNumber.map(String.init) ?? "—",
                     in: NSRect(x: table.minX, y: y + 8,
                               width: rowHeaderWidth - 8, height: 14),
                     font: NSFont.systemFont(ofSize: 11),
                     color: citedRow ? sourceColor : .secondaryLabelColor,
                     alignment: .right)

            if citedRow {
                let labelCell = NSRect(x: table.minX + rowHeaderWidth, y: y,
                                       width: columnWidths[0], height: rowHeight)
                sourceColor.withAlphaComponent(0.075).setFill()
                labelCell.fill()
            }

            for (column, sourceColumn) in visibleColumns.enumerated() {
                let cell = sourceColumn < row.cells.count
                    ? row.cells[sourceColumn]
                    : AssistPreviewCell(value: "", cited: false)
                let cellRect = NSRect(x: table.minX + rowHeaderWidth + columnOffset(column),
                                      y: y, width: columnWidths[column], height: rowHeight)
                if cell.cited {
                    sourceColor.withAlphaComponent(0.025).setFill()
                    cellRect.fill()
                }
                drawText(cell.value,
                         in: NSRect(x: cellRect.minX + 8, y: cellRect.minY + 8,
                                   width: cellRect.width - 16, height: 14),
                         font: NSFont.systemFont(ofSize: 10,
                                                weight: cell.cited ? .medium : .regular),
                         color: .labelColor, alignment: column == 0 ? .left : .right)
            }
            if let outlined = citedColumns.last {
                citedOutlines.append(NSRect(
                    x: table.minX + rowHeaderWidth + columnOffset(outlined),
                    y: y, width: columnWidths[outlined], height: rowHeight))
            }
        }

        NSColor.separatorColor.withAlphaComponent(0.11).setStroke()
        for column in 0...count {
            let x = table.minX + rowHeaderWidth + columnOffset(column)
            let line = NSBezierPath()
            line.lineWidth = 0.5
            line.move(to: NSPoint(x: x, y: table.minY))
            line.line(to: NSPoint(x: x, y: table.maxY))
            line.stroke()
        }
        if !rows.isEmpty {
            for row in 1...rows.count {
                let y = table.minY + headerHeight + rowHeight * CGFloat(row - 1)
                let line = NSBezierPath()
                line.lineWidth = 0.5
                line.move(to: NSPoint(x: table.minX, y: y))
                line.line(to: NSPoint(x: table.maxX, y: y))
                line.stroke()
            }
        }

        for rect in citedOutlines {
            sourceColor.withAlphaComponent(0.65).setStroke()
            let outline = NSBezierPath(rect: rect.insetBy(dx: 0.5, dy: 0.5))
            outline.lineWidth = 0.8
            outline.stroke()
        }
        NSGraphicsContext.current?.restoreGraphicsState()

        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        roundedTable.lineWidth = 0.65
        roundedTable.stroke()
    }

    private func spreadsheetColumn(_ index: Int) -> String {
        var current = index
        var label = ""
        repeat {
            label = String(UnicodeScalar(65 + current % 26)!) + label
            current = current / 26 - 1
        } while current >= 0
        return label
    }

    private func drawActionButton(_ title: String, symbol: String, in rect: NSRect) {
        NSColor.controlBackgroundColor.withAlphaComponent(0.65).setFill()
        let path = NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7)
        path.fill()
        NSColor.separatorColor.withAlphaComponent(0.18).setStroke()
        path.lineWidth = 0.6
        path.stroke()

        let font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        let titleWidth = ceil((title as NSString).size(withAttributes: [.font: font]).width)
        let groupWidth = CGFloat(14 + 8) + titleWidth
        let groupX = rect.midX - groupWidth / 2
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [.secondaryLabelColor])) {
            image.isTemplate = false
            image.draw(in: NSRect(x: groupX, y: rect.minY + 10.5,
                                  width: 14, height: 14),
                       from: .zero, operation: .sourceOver, fraction: 0.68,
                       respectFlipped: true, hints: nil)
        }
        drawText(title,
                 in: NSRect(x: groupX + 22, y: rect.minY + 9.5,
                           width: titleWidth + 2, height: 17),
                 font: font, color: .labelColor)
    }

    private func drawMultilineText(_ value: String, in rect: NSRect, font: NSFont, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = 3
        NSAttributedString(string: value, attributes: [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ]).draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    override func mouseDown(with event: NSEvent) {
        guard mode == .suggestions else { return }
        let point = convert(event.locationInWindow, from: nil)

        if point.x < leftWidth {
            if point.y >= footerY {
                switch footerCommand(at: point.x) {
                case .tab: onInsert?()
                case .insertText: onLocalLink?()
                case .share: onShare?()
                case nil: break
                }
                return
            }
            guard point.y >= bodyTop else { return }
            if point.y < bodyTop + navigationHeight {
                if sourceScoped { onAllSources?() }
                return
            }
            let slot = Int((point.y - bodyTop - navigationHeight) / suggestionHeight)
            let index = firstVisibleSuggestion + slot
            if visibleSuggestionRange.contains(index) { onSelectRow?(index) }
            return
        }

        guard point.y >= footerY + 6, point.y <= footerY + 41 else { return }
        if point.x < leftWidth + (bounds.width - leftWidth) / 2 { onOpenSource?() }
        else { onShare?() }
    }


    private func drawSeparator(at y: CGFloat) { drawInsetSeparator(at: y, from: 0) }

    private func drawInsetSeparator(at y: CGFloat, from x: CGFloat) {
        NSColor.separatorColor.setStroke()
        let path = NSBezierPath()
        path.lineWidth = 0.5
        path.move(to: NSPoint(x: x, y: y))
        path.line(to: NSPoint(x: mode == .suggestions ? leftWidth : bounds.width, y: y))
        path.stroke()
    }

    private func drawText(_ value: String, in rect: NSRect, font: NSFont, color: NSColor,
                          alignment: NSTextAlignment = .left) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = .byTruncatingTail
        paragraph.maximumLineHeight = rect.height
        NSAttributedString(string: value, attributes: [
            .font: font,
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ]).draw(in: rect)
    }
}

// MARK: - Coordinator

final class GlobalAssistant {
    static let shared = GlobalAssistant()

    private init() {
        LassoTransientUI.shared.register(self, priority: 70,
            isOpen: { [weak self] in
                guard let self else { return false }
                return self.panel?.isVisible == true || self.popupHost != nil
                    || self.debounce?.isValid == true || self.request != nil
            }, dismiss: { [weak self] in self?.dismissForEscape() })
        LassoTransientUI.shared.start()
    }

    var serverURL: URL?
    private(set) var projectIds: [String] = []
    private var workspaceRevision = ""
    private(set) var isEnabled = false

    /// The menu and retrieval share the server's persisted active directory set.
    func updateWorkspace(projectIds: [String], revision: String) {
        let updated = Array(Set(projectIds)).sorted()
        guard updated != self.projectIds || revision != workspaceRevision else { return }
        hide()
        self.projectIds = updated
        workspaceRevision = revision
        linkedSources.removeAll { !updated.contains($0.projectId) }
        if isEnabled, !updated.isEmpty { scheduleRefresh() }
    }

    /// Pause retrieval immediately while the directory selection is changing.
    func suspendWorkspace() {
        hide()
        projectIds = []
    }

    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var panel: NSPanel?
    private var view = AssistBoxView()
    private var debounce: Timer?
    private var request: URLSessionDataTask?
    private var previewRequest: URLSessionDataTask?
    private var previewGeneration = 0
    private var previewKey: String?
    private var previewCache: [String: AssistDocumentPreview] = [:]
    private var previewCacheOrder: [String] = []
    private var context: CaretContext?
    private var generation = 0
    private var feedbackDismissed = false
    private var sawEvent = false
    private var isInserting = false
    private var pendingShare: AssistSuggestion?
    /// Sources linked in the current surface, newest last. Reported to the
    /// server so it can offer their values instead of matching the same phrase.
    private struct LinkedSource {
        let projectId: String
        let objectId: String
        let snapshotId: String
        let text: String
    }
    private var linkedSources: [LinkedSource] = []
    private var linkedContext: String?
    private var linkedElement: AXUIElement?
    private var flashTimer: Timer?
    private static let minimumTypedCharacters = 2
    private static let minimumMessageTime: TimeInterval = 0.8
    private var messageShownAt = Date.distantPast
    private var lastTrack = Date.distantPast
    private var popupHost: AssistPopupHost?
    private var popupCaret: CGRect?
    private var hostTimer: Timer?
    private var hostObservers: [NSObjectProtocol] = []

    var onStateChange: (() -> Void)?
    var onWorkspaceChange: (() -> Void)?

    // MARK: Lifecycle

    /// Which permission is missing, and whether macOS is holding a stale grant
    /// from an earlier build of the app.
    struct PermissionProblem {
        let service: String          // "Accessibility" or "Input Monitoring"
        let settingsAnchor: String
        let stale: Bool
    }

    private(set) var lastProblem: PermissionProblem?

    @discardableResult
    func enable(requestPermissions: Bool = true) -> String? {
        guard !isEnabled else { return nil }
        let accessibility = AssistPermission.hasAccessibility
        let input = AssistPermission.hasInputMonitoring
        AssistLog.write("enable requested: accessibility=\(accessibility) inputMonitoring=\(input)")

        if !accessibility {
            lastProblem = PermissionProblem(service: "Accessibility",
                                            settingsAnchor: "Privacy_Accessibility",
                                            stale: AssistPermission.isListedButUntrusted)
            if requestPermissions { AssistPermission.requestAccessibility() }
            return lastProblem!.stale
                ? "macOS is not granting Lasso Accessibility access. Approval for an earlier build may no longer apply.\n\nAfter installing the current app, open Privacy & Security → Accessibility, remove the old Lasso entry with “−”, then add the current app with “+” and authorize it."
                : "Turn on Lasso under Privacy & Security → Accessibility, then enable this again."
        }
        // Input Monitoring is not always required: a keyboard tap usually works
        // with Accessibility alone. Ask for it only if the tap actually fails.
        lastProblem = nil

        let mask = (1 << CGEventType.keyDown.rawValue)
        guard let created = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let assistant = Unmanaged<GlobalAssistant>.fromOpaque(refcon).takeUnretainedValue()
                return assistant.handle(type: type, event: event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            AssistLog.write("tap creation failed (accessibility=\(accessibility) inputMonitoring=\(input))")
            if !input && requestPermissions { AssistPermission.requestInputMonitoring() }
            lastProblem = PermissionProblem(service: "Input Monitoring",
                                            settingsAnchor: "Privacy_ListenEvent",
                                            stale: false)
            return "The keyboard tap could not be created.\n\nTurn on Lasso under Privacy & Security → Input Monitoring. Approval for an earlier ad-hoc build may no longer apply. If needed, remove the old entry with “−” and add the current app with “+”."
        }

        tap = created
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        AssistPermission.rememberTrusted()
        isEnabled = true
        sawEvent = false
        AssistLog.write("tap created and listening")
        // If nothing arrives the tap exists but is not receiving; that is the
        // real signal that Input Monitoring is required.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.isEnabled, !self.sawEvent else { return }
            AssistLog.write("no key events after 20s — tap is not receiving input")
        }
        onStateChange?()
        return nil
    }

    func disable() {
        hide()
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes) }
        tap = nil
        runLoopSource = nil
        isEnabled = false
        onStateChange?()
    }

    // MARK: Event handling

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        guard type == .keyDown else { return Unmanaged.passUnretained(event) }
        if !sawEvent {
            sawEvent = true
            AssistLog.write("first key event received")
        }

        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let visible = panel?.isVisible == true

        // Our own synthesized keys are not the user typing.
        if isInserting
            || event.getIntegerValueField(.eventSourceUserData) == SyntheticKeyboard.marker {
            return Unmanaged.passUnretained(event)
        }

        let flags = event.flags
        if keyCode == 53, flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty,
           LassoTransientUI.shared.dismissAll() {
            return nil
        }
        // Native search controls own their keystrokes while the picker is open.
        if SourceChooserController.shared.isVisible { return Unmanaged.passUnretained(event) }
        if ShareComposerController.shared.isVisible,
           ShareComposerController.shared.isPresented(in: panel) {
            guard flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty else {
                return Unmanaged.passUnretained(event)
            }
            switch keyCode {
            case 48 where flags.contains(.maskShift):
                return Unmanaged.passUnretained(event)
            case 48, 36, 76:
                DispatchQueue.main.async { ShareComposerController.shared.confirm() }
            case 123, 126:
                DispatchQueue.main.async { ShareComposerController.shared.moveScope(-1) }
            case 124, 125:
                DispatchQueue.main.async { ShareComposerController.shared.moveScope(1) }
            default:
                return Unmanaged.passUnretained(event)
            }
            return nil
        }
        // Escape with nothing open belongs to the host, and must not schedule
        // a new prediction that would reopen the just-dismissed menu.
        if keyCode == 53 { return Unmanaged.passUnretained(event) }
        if visible && view.mode != .message {
            switch keyCode {
            case 48:                                    // Tab
                DispatchQueue.main.async {
                    if self.view.mode == .confirmShare { self.resolveConfirmation() }
                    else { self.activateSelection() }
                }
                return nil                              // swallow: do not insert a tab
            case 36, 76:                                // Return / Enter
                if flags.contains(.maskCommand) {
                    if flags.contains(.maskShift) {
                        DispatchQueue.main.async { self.acceptShared() }
                    } else {
                        DispatchQueue.main.async { self.acceptPlain() }
                    }
                    return nil
                }
                if view.mode == .confirmShare {
                    DispatchQueue.main.async { self.resolveConfirmation() }
                    return nil
                }
            case 126:                                   // Up
                DispatchQueue.main.async { self.move(-1) }
                return nil
            case 125:                                   // Down
                DispatchQueue.main.async { self.move(1) }
                return nil
            default:
                break
            }
        }

        // Other modifier chords are shortcuts, not typing.
        if flags.contains(.maskCommand) || flags.contains(.maskControl) {
            DispatchQueue.main.async { self.hide() }
            return Unmanaged.passUnretained(event)
        }

        DispatchQueue.main.async {
            // The debounce below only fires once typing pauses, so the box is
            // moved here instead — otherwise it lags behind continuous typing.
            if visible { self.trackCaret() }
            self.scheduleRefresh()
        }
        return Unmanaged.passUnretained(event)
    }

    // MARK: Suggestion flow

    /// Browse without editing the host document or removing existing links.
    private func chooseSource(allDocuments: Bool) {
        guard let serverURL, let savedContext = context else { return }
        let previous = view.suggestions
        let previousSelection = view.selected
        let previousScope = view.sourceScoped
        let replacement = currentSuggestion?.replacement
            ?? CompletionReplacement(start: savedContext.text.utf16.count, expectedText: "")
        let path = allDocuments ? nil : currentSuggestion?.path
        let sourceProjectId = allDocuments ? nil : currentSuggestion?.projectId
        hide()
        SourceChooserController.shared.show(serverURL: serverURL, sourceProjectId: sourceProjectId, sourcePath: path) { [weak self] object in
            guard let self else { return }
            self.context = savedContext
            guard let object, let id = object["id"] as? String, let projectId = object["projectId"] as? String,
                  self.projectIds.contains(projectId) else {
                self.view.selected = previousSelection
                self.view.sourceScoped = previousScope
                self.show(previous, near: savedContext.caretRect)
                return
            }
            let label = object["label"] as? String ?? "Source"
            let value = object["valueText"] as? String
            let type = object["objectType"] as? String ?? ""
            let suggestion = AssistSuggestion(
                insertText: type == "DATASET_VALUE" ? (value ?? label) : label,
                label: label, detail: value ?? "", path: object["path"] as? String ?? "",
                location: Self.sourceLocation(object), replacement: replacement,
                objectId: id, versionId: object["versionId"] as? String,
                snapshotId: object["snapshotId"] as? String, usageObjectId: id,
                projectId: projectId, rankingReason: nil)
            self.view.selected = 0
            self.view.sourceScoped = true
            self.show([suggestion], near: savedContext.caretRect)
        }
    }

    private func scheduleRefresh() {
        guard !ShareComposerController.shared.isVisible else { return }
        // A brief message must not swallow the next words the writer types,
        // such as the first word of the following sentence. It stays long
        // enough to be read, then gives way to suggestions for that text.
        if view.mode == .message {
            let remaining = Self.minimumMessageTime - Date().timeIntervalSince(messageShownAt)
            guard remaining <= 0 else {
                debounce?.invalidate()
                debounce = Timer.scheduledTimer(withTimeInterval: remaining, repeats: false) { [weak self] _ in
                    self?.hide()
                    self?.scheduleRefresh()
                }
                return
            }
            hide()
        }
        guard view.mode == .suggestions else { return }
        feedbackDismissed = false
        // Invalidate the previous response now, not after the debounce. A late
        // response must not dismiss the next refresh while the user is typing.
        generation += 1
        request?.cancel()
        request = nil
        debounce?.invalidate()
        debounce = Timer.scheduledTimer(withTimeInterval: 0.16, repeats: false) { [weak self] _ in
            self?.refresh()
        }
    }

    private func refresh() {
        guard isEnabled, let serverURL, !projectIds.isEmpty else { hide(); return }
        guard let captured = AccessibilityReader.focusedContext() else { hide(); return }
        let trimmed = captured.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Two characters are enough to ask, so the first word of an empty
        // field ("Re" → Revenue) is not skipped. The server decides whether
        // the typed fragment is long enough to match.
        guard trimmed.count >= Self.minimumTypedCharacters else { hide(); return }
        if let host = popupHost, !CFEqual(host.element, captured.element) { hide() }
        // Linked sources belong to one surface only.
        if linkedContext != captured.diagnosis || linkedElement.map({ !CFEqual($0, captured.element) }) != false {
            linkedElement = captured.element
            linkedContext = captured.diagnosis
            linkedSources.removeAll()
        }
        context = captured
        guard startTrackingHost(for: captured) else { hide(); return }
        // Track the caret straight away. Waiting for the response would leave
        // the box behind whenever fast typing cancels requests.
        if panel?.isVisible == true, view.mode == .suggestions { reposition(near: popupCaret) }

        generation += 1
        let token = generation
        request?.cancel()

        var request = URLRequest(url: serverURL
            .appendingPathComponent("api/workspace/dependencies/predict"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 2.5
        var body: [String: Any] = [
            "text": captured.text,
            "cursor": captured.cursor,
            "blockIndex": 0,
        ]
        // Locate each linked phrase inside the window actually being sent, so
        // the offsets the server receives match the text it is given.
        let window = Array(captured.text.utf16)
        let pending = linkedSources.compactMap { link -> [String: Any]? in
            let needle = Array(link.text.utf16)
            guard let start = TextAnchorResolver.indices(of: needle, in: window).last else { return nil }
            return [
                "projectId": link.projectId,
                "blockIndex": 0,
                "start": start,
                "end": start + needle.count,
                "sourceObjectId": link.objectId,
                "sourceSnapshotId": link.snapshotId,
            ]
        }
        if !pending.isEmpty { body["pendingDependencies"] = pending }
        let sourceScoped = !pending.isEmpty
        let activeProjectIds = Set(projectIds)
        let expectedRevision = workspaceRevision
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self else { return }
            guard let data else {
                DispatchQueue.main.async {
                    guard token == self.generation else { return }
                    self.hide()
                }
                return
            }
            let parsed = Self.parse(data, requestedText: captured.text, activeProjectIds: activeProjectIds)
            let heading = Self.heading(data)
            let returnedRevision = Self.predictionRevision(data)
            DispatchQueue.main.async {
                guard token == self.generation, self.isEnabled,
                      expectedRevision == self.workspaceRevision, activeProjectIds == Set(self.projectIds) else { return }
                if let returnedRevision, returnedRevision != expectedRevision {
                    // Browser selections and watch captures may change the server
                    // between menu refreshes. Adopt its state before showing results.
                    self.suspendWorkspace()
                    self.onWorkspaceChange?()
                    return
                }
                self.deliverPrediction(parsed, heading: heading, sourceScoped: sourceScoped,
                                       captured: captured, token: token)
            }
        }
        self.request = task
        task.resume()
    }

    private static func predictionRevision(_ data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prediction = root["prediction"] as? [String: Any] else { return nil }
        if let revision = prediction["workspaceRevision"] as? String { return revision }
        return (prediction["workspaceRevision"] as? NSNumber)?.stringValue
    }

    /// A response may arrive after Escape, an edit, or a window closing. Only
    /// deliver to the same still-current editor, using its current caret bounds.
    private func deliverPrediction(_ suggestions: [AssistSuggestion], heading: String?, sourceScoped: Bool,
                                   captured: CaretContext, token: Int) {
        guard token == generation, isEnabled else { return }
        request = nil
        guard popupHost?.isCurrent == true,
              let fresh = AccessibilityReader.focusedContext(), CFEqual(fresh.element, captured.element),
              fresh.text == captured.text, fresh.absoluteCaret == captured.absoluteCaret,
              fresh.windowStart == captured.windowStart else { hide(); return }
        guard !suggestions.isEmpty else { hide(); return }
        context = fresh
        view.sourceScoped = sourceScoped
        view.title = heading ?? "dependency"
        show(suggestions, near: fresh.caretRect)
    }

    /// What the server is offering: "Values for Office Supplies" once a source
    /// is linked, otherwise the general heading.
    private static func heading(_ data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prediction = root["prediction"] as? [String: Any] else { return nil }
        if let workspace = prediction["workspaceHeading"] as? String, !workspace.isEmpty {
            return workspace.lowercased()
        }
        if let context = prediction["sourceContext"] as? [String: Any],
           let source = context["source"] as? [String: Any],
           let label = source["label"] as? String {
            return "components from \(label)".lowercased()
        }
        return nil
    }

    private static func sourceLocation(_ candidate: [String: Any]) -> String {
        let anchor = candidate["anchor"] as? [String: Any] ?? [:]
        let metadata = candidate["metadata"] as? [String: Any] ?? [:]
        let sheet = (anchor["sheet"] as? String) ?? (metadata["sheet"] as? String) ?? ""
        let row = (anchor["rowIndex"] as? NSNumber)?.intValue
        let column = (anchor["columnIndex"] as? NSNumber)?.intValue
        if let row, let column {
            let cell = spreadsheetColumn(column) + String(row)
            return sheet.isEmpty ? cell : sheet + "!" + cell
        }
        if let page = (anchor["pageNumber"] as? NSNumber)?.intValue
            ?? (metadata["pageNumber"] as? NSNumber)?.intValue {
            return "p. " + String(page)
        }
        if let rowKey = (anchor["rowKey"] as? String) ?? (metadata["rowKey"] as? String),
           !rowKey.isEmpty {
            return sheet.isEmpty ? rowKey : sheet + " · " + rowKey
        }
        return sheet
    }

    private static func spreadsheetColumn(_ index: Int) -> String {
        var current = index
        var label = ""
        repeat {
            label = String(UnicodeScalar(65 + current % 26)!) + label
            current = current / 26 - 1
        } while current >= 0
        return label
    }

    private static func parse(_ data: Data, requestedText: String, activeProjectIds: Set<String>) -> [AssistSuggestion] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prediction = root["prediction"] as? [String: Any] else { return [] }

        // Every result retains its owning directory. A single-directory payload
        // can still be decoded during an upgrade from an older local server.
        func owner(_ values: [String: Any]...) -> String? {
            for value in values {
                if let id = value["projectId"] as? String {
                    return activeProjectIds.contains(id) ? id : nil
                }
            }
            return activeProjectIds.count == 1 ? activeProjectIds.first : nil
        }

        var results: [AssistSuggestion] = []
        var identities = Set<String>()
        func append(_ suggestion: AssistSuggestion) {
            let identity = suggestion.projectId + "|" + (suggestion.objectId ?? suggestion.usageObjectId ?? "")
                + "|" + suggestion.insertText
            if identities.insert(identity).inserted { results.append(suggestion) }
        }

        if let completion = prediction["completion"] as? [String: Any],
           let insert = completion["insertText"] as? String, !insert.isEmpty {
            let candidate = completion["dependencyCandidate"] as? [String: Any] ?? [:]
            let source = completion["source"] as? [String: Any] ?? [:]
            if let projectId = owner(completion, candidate, source) {
                append(AssistSuggestion(
                    insertText: insert,
                    label: insert.trimmingCharacters(in: .whitespaces),
                    detail: "sentence", path: source["path"] as? String ?? "", location: "",
                    replacement: CompletionReplacement(start: requestedText.utf16.count, expectedText: ""),
                    objectId: nil, versionId: candidate["versionId"] as? String,
                    snapshotId: candidate["snapshotId"] as? String ?? source["snapshotId"] as? String,
                    usageObjectId: candidate["id"] as? String,
                    projectId: projectId,
                    rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String,
                    previewText: completion["sourceSentence"] as? String ?? insert.trimmingCharacters(in: .whitespacesAndNewlines),
                    sentenceContinuation: true))
            }
        }

        for group in ["workspaceCompletions", "sourceCompletions"] {
            for entry in (prediction[group] as? [[String: Any]] ?? []) {
                let candidate = entry["dependencyCandidate"] as? [String: Any] ?? [:]
                let insert = (entry["replacementText"] as? String)
                    ?? (entry["insertText"] as? String) ?? ""
                guard !insert.isEmpty, let projectId = owner(entry, candidate) else { continue }
                guard let replacement = CompletionReplacement.capture(start: entry["claimStart"] as? Int,
                    end: entry["claimEnd"] as? Int, in: requestedText) else { continue }
                append(AssistSuggestion(
                    insertText: insert, label: insert,
                    detail: candidate["valueText"] as? String ?? (entry["category"] as? String ?? ""),
                    path: AssistSourceIdentity.canonicalPath(
                        candidatePath: candidate["path"] as? String,
                        provenanceLabel: entry["provenanceLabel"] as? String),
                    location: sourceLocation(candidate),
                    replacement: replacement,
                    objectId: candidate["id"] as? String,
                    versionId: candidate["versionId"] as? String,
                    snapshotId: candidate["snapshotId"] as? String,
                    usageObjectId: candidate["id"] as? String, projectId: projectId,
                    rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String,
                    previewText: entry["sourceSentence"] as? String ?? insert))
            }
        }

        for claim in (prediction["claims"] as? [[String: Any]] ?? []) {
            let claimStart = claim["start"] as? Int
            let claimEnd = claim["end"] as? Int
            let claimType = claim["type"] as? String
            let replacesName = ["ENTITY", "STUDY_VARIABLE", "LITERATURE", "TABLE_REFERENCE", "FIGURE"]
                .contains(claimType ?? "")
            let nameCompletion = replacesName && claim["partial"] as? Bool == true
            let matchedName = nameCompletion
                ? CompletionReplacement.capture(start: claimStart, end: claimEnd, in: requestedText,
                    expectedText: claim["text"] as? String) : nil
            if nameCompletion && matchedName == nil { continue }
            let replacement = matchedName
                ?? (["QUANTITATIVE", "SAMPLE_SIZE"].contains(claimType ?? "")
                    ? CompletionReplacement.terminalNumber(in: requestedText) : nil)
                ?? CompletionReplacement(start: requestedText.utf16.count, expectedText: "")
            for candidate in (claim["candidates"] as? [[String: Any]] ?? []) {
                let label = candidate["label"] as? String ?? ""
                let value = candidate["valueText"] as? String ?? candidate["displayValue"] as? String
                let insert = AssistSuggestionSemantics.insertionText(
                    claimType: claimType, label: label, value: value,
                    completionText: candidate["completionText"] as? String)
                guard !insert.isEmpty, let projectId = owner(candidate, claim) else { continue }
                append(AssistSuggestion(
                    insertText: insert, label: label,
                    detail: value ?? (candidate["objectType"] as? String ?? ""),
                    path: candidate["path"] as? String ?? "", location: sourceLocation(candidate),
                    replacement: replacement, objectId: candidate["id"] as? String,
                    versionId: candidate["versionId"] as? String,
                    snapshotId: candidate["snapshotId"] as? String,
                    usageObjectId: candidate["id"] as? String, projectId: projectId,
                    rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String))
            }
        }
        return results
    }

    private func loadPreviewForSelection() {
        guard view.mode == .suggestions,
              let suggestion = currentSuggestion,
              let objectId = suggestion.objectId ?? suggestion.usageObjectId,
              let serverURL else {
            previewRequest?.cancel()
            previewGeneration += 1
            previewKey = nil
            view.preview = nil
            view.previewError = nil
            view.isPreviewLoading = false
            view.needsDisplay = true
            return
        }

        let key = objectId + "|" + (suggestion.versionId ?? "") + "|" + (suggestion.previewText ?? "")
        if previewKey == key, view.preview != nil || view.isPreviewLoading { return }
        previewRequest?.cancel()
        previewGeneration += 1
        let token = previewGeneration
        previewKey = key
        view.previewError = nil
        if let cached = previewCache[key] {
            previewCacheOrder.removeAll { $0 == key }
            previewCacheOrder.append(key)
            view.preview = cached
            view.isPreviewLoading = false
            view.needsDisplay = true
            return
        }

        view.preview = nil
        view.isPreviewLoading = true
        view.needsDisplay = true

        var components = URLComponents(
            url: serverURL.appendingPathComponent("api/dependency-objects")
                .appendingPathComponent(objectId)
                .appendingPathComponent("preview"),
            resolvingAgainstBaseURL: false)
        var query: [URLQueryItem] = []
        if let versionId = suggestion.versionId { query.append(URLQueryItem(name: "version", value: versionId)) }
        // Text sources highlight the matched passage, as PDF pages do.
        if let text = suggestion.previewText, !text.isEmpty,
           (suggestion.path as NSString).pathExtension.lowercased() != "pdf" {
            query.append(URLQueryItem(name: "text", value: String(text.prefix(400))))
        }
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else {
            view.isPreviewLoading = false
            view.previewError = "The source preview address is unavailable."
            view.needsDisplay = true
            return
        }
        var request = URLRequest(url: url)
        // A first IFC preview compiles the geometry engine and reads the model.
        // Later previews reuse its geometry; ordinary table requests stay brief.
        switch (suggestion.path as NSString).pathExtension.lowercased() {
        case "ifc": request.timeoutInterval = 60
        case "pdf": request.timeoutInterval = 20
        default: request.timeoutInterval = 2.5
        }
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self, let data,
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  var parsed = Self.parsePreview(data) else {
                DispatchQueue.main.async {
                    guard let self, token == self.previewGeneration, self.previewKey == key else { return }
                    self.view.isPreviewLoading = false
                    self.view.previewError = "The document preview could not be loaded. Select this result again to retry."
                    self.view.needsDisplay = true
                }
                return
            }
            if let pdf = parsed.pdf, let text = suggestion.previewText, !text.isEmpty {
                parsed.pdf = AssistPDFPreview(json: ["kind": "pdf", "fileUrl": pdf.fileUrl,
                    "pageNumber": pdf.pageNumber, "selectedText": text])
            }
            DispatchQueue.main.async {
                guard token == self.previewGeneration, self.previewKey == key else { return }
                if parsed.pdf != nil {
                    self.loadPDFPreview(parsed, serverURL: serverURL, key: key, token: token)
                } else {
                    self.deliverPreview(parsed, key: key, token: token)
                }
            }
        }
        previewRequest = task
        task.resume()
    }

    private func loadPDFPreview(_ preview: AssistDocumentPreview, serverURL: URL, key: String, token: Int) {
        guard let pdf = preview.pdf, let url = pdf.sourceURL(serverURL: serverURL) else {
            var unavailable = preview
            unavailable.unavailableReason = "The indexed PDF preview address is unavailable."
            deliverPreview(unavailable, key: key, token: token)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            var rendered = preview
            if let data, (response as? HTTPURLResponse)?.statusCode == 200 {
                rendered.pdfPage = AssistPDFPageImage.render(data: data, preview: pdf)
            }
            if rendered.pdfPage == nil {
                rendered.unavailableReason = "The PDF page could not be displayed. Select this result again to retry, or open the source."
            }
            DispatchQueue.main.async { self.deliverPreview(rendered, key: key, token: token) }
        }
        previewRequest = task
        task.resume()
    }

    private func deliverPreview(_ preview: AssistDocumentPreview, key: String, token: Int) {
        guard token == previewGeneration, previewKey == key else { return }
        // Transient failures stay retryable; only complete previews enter the cache.
        if preview.unavailableReason == nil {
            previewCache[key] = preview
            previewCacheOrder.removeAll { $0 == key }
            previewCacheOrder.append(key)
            while previewCacheOrder.count > 8 {
                previewCache.removeValue(forKey: previewCacheOrder.removeFirst())
            }
        }
        view.preview = preview
        view.isPreviewLoading = false
        view.needsDisplay = true
    }

    static func parsePreview(_ data: Data) -> AssistDocumentPreview? {
        AssistDocumentPreview.parse(data)
    }

    private func selectRow(_ index: Int) {
        guard index >= 0, index < view.suggestions.count else { return }
        if view.preview?.unavailableReason != nil { previewKey = nil }
        view.selected = index
        view.needsDisplay = true
        loadPreviewForSelection()
    }

    private func openCurrentSource() {
        guard let suggestion = currentSuggestion,
              let serverURL else {
            flash(["The local source is unavailable right now."])
            return
        }
        let previewPath = view.preview?.path.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let sourcePath = previewPath.isEmpty ? suggestion.path : previewPath
        let endpoint = serverURL.appendingPathComponent("api/projects")
            .appendingPathComponent(suggestion.projectId)
        let task = URLSession.shared.dataTask(with: endpoint) { [weak self] data, response, _ in
            guard let self else { return }
            guard let data,
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let project = root["project"] as? [String: Any],
                  let rootPath = project["rootPath"] as? String else {
                DispatchQueue.main.async {
                    self.flash(["Lasso could not locate the project folder."])
                }
                return
            }
            DispatchQueue.main.async {
                self.openLocalSource(path: sourcePath, projectRoot: rootPath,
                                     suggestion: suggestion, serverURL: serverURL)
            }
        }
        task.resume()
    }

    private func openLocalSource(path: String, projectRoot: String,
                                 suggestion: AssistSuggestion, serverURL: URL) {
        let result = AssistSourceIdentity.openLocalFile(
            projectRoot: projectRoot, sourcePath: path,
            open: { NSWorkspace.shared.open($0) },
            onOpened: {
                RecommendationUsageClient.record(serverURL: serverURL, projectId: suggestion.projectId,
                                                 objectId: suggestion.usageObjectId, path: suggestion.path,
                                                 kind: "open")
            })
        switch result {
        case .unavailable:
            flash(["The source file is no longer available locally."])
        case .opened:
            hide()
        case .failed:
            flash(["macOS could not open \((path as NSString).lastPathComponent)."])
        }
    }

    // MARK: Panel
    #if BROWSER_GEOMETRY_TEST
    private var regressionPrediction = false
    private var regressionAccepted: [String: Any]?

    static func regressionSuggestionNavigation(outputPath: String? = nil) -> [String: Bool] {
        func entry(_ index: Int) -> [String: Any] {
            ["replacementText": "Ranked source \(index)", "claimStart": 0, "claimEnd": 0,
             "dependencyCandidate": ["id": "source-\(index)", "projectId": "fixture",
                "path": "Source-\(index).pdf", "label": "Ranked source \(index)",
                "ranking": ["reason": "Existing priority \(index)"]]]
        }
        var workspace = (1...6).map(entry)
        workspace.append(entry(1))
        workspace.append(["replacementText": "Inactive directory",
                          "dependencyCandidate": ["id": "inactive", "projectId": "inactive"]])
        let payload: [String: Any] = ["prediction": [
            "completion": ["insertText": "Sentence completion", "projectId": "fixture",
                "sourceSentence": "The original PDF sentence completion.",
                "source": ["path": "reference.pdf"],
                "dependencyCandidate": ["id": "completion-source", "versionId": "pinned-completion",
                    "snapshotId": "pinned-snapshot"]],
            "workspaceCompletions": workspace,
            "sourceCompletions": (7...9).map(entry),
            "claims": [["type": "ENTITY", "candidates": (10...12).map { index in
                ["id": "source-\(index)", "projectId": "fixture", "path": "Source-\(index).pdf",
                 "label": "Ranked source \(index)"]
            }]],
        ]]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            return ["fixture serialization": false]
        }
        let suggestions = parse(data, requestedText: "", activeProjectIds: ["fixture"])
        let expected = ["Sentence completion"] + (1...12).map { "Ranked source \($0)" }
        let assistant = shared
        assistant.hide()
        let savedServer = assistant.serverURL
        assistant.serverURL = nil
        defer {
            assistant.hide()
            assistant.view.suggestions = []
            assistant.serverURL = savedServer
        }
        let list = assistant.view
        list.suggestions = suggestions
        var checks = [
            "all ranked results survive parsing, with duplicate and inactive sources excluded":
                suggestions.map(\.insertText) == expected,
            "existing ranking explanations survive parsing":
                suggestions.dropFirst().prefix(9).enumerated().allSatisfy {
                    $0.element.rankingReason == "Existing priority \($0.offset + 1)"
                },
            "initial viewport shows the highest priority results": list.visibleSuggestionRange == 0..<4,
            "PDF sentence completions retain a pinned preview and original excerpt":
                suggestions.first?.usageObjectId == "completion-source"
                    && suggestions.first?.versionId == "pinned-completion"
                    && suggestions.first?.previewText == "The original PDF sentence completion."
                    && suggestions.first?.isShareable == false,
        ]
        let typed = "I was looking at the pro"
        let sourceLabel = "AC20 FZK haus · Projekt-FZK-Haus"
        let keywordPayload: [String: Any] = ["prediction": ["claims": [[
            "type": "ENTITY", "partial": true, "text": "pro",
            "start": typed.utf16.count - 3, "end": typed.utf16.count,
            "candidates": [["id": "drawing", "projectId": "fixture", "label": sourceLabel,
                            "objectType": "DRAWING", "path": "AC20-FZK-Haus.ifc"]],
        ]]]]
        if let keywordData = try? JSONSerialization.data(withJSONObject: keywordPayload),
           let keyword = parse(keywordData, requestedText: typed, activeProjectIds: ["fixture"]).first,
           case .success(let plan) = CompletionTransaction.plan(document: Array(typed.utf16),
                caret: typed.utf16.count, insertText: keyword.insertText, replacement: keyword.replacement) {
            checks["drawing keyword payload replaces only pro with the selected label"] =
                String(decoding: CompletionTransaction.apply(plan, to: Array(typed.utf16)), as: UTF16.self)
                    == "I was looking at the " + sourceLabel
        } else { checks["drawing keyword payload replaces only pro with the selected label"] = false }
        let numericText = "The count increased by 2"
        let numericPayload: [String: Any] = ["prediction": ["claims": [[
            "type": "QUANTITATIVE", "partial": true, "text": "increased by 2",
            "start": "The count ".utf16.count, "end": numericText.utf16.count,
            "candidates": [["id": "number", "projectId": "fixture", "label": "Count",
                            "valueText": "25", "objectType": "VALUE"]],
        ]]]]
        if let numericData = try? JSONSerialization.data(withJSONObject: numericPayload),
           let number = parse(numericData, requestedText: numericText, activeProjectIds: ["fixture"]).first,
           case .success(let plan) = CompletionTransaction.plan(document: Array(numericText.utf16),
                caret: numericText.utf16.count, insertText: number.insertText, replacement: number.replacement) {
            checks["quantitative claims retain their wording while completing the number"] =
                number.replacement?.expectedText == "2"
                    && String(decoding: CompletionTransaction.apply(plan, to: Array(numericText.utf16)), as: UTF16.self)
                        == "The count increased by 25"
        } else { checks["quantitative claims retain their wording while completing the number"] = false }
        checks["sentence payload carries an explicit append instead of guessing an overlap"] =
            suggestions.first?.replacement == CompletionReplacement(start: 0, expectedText: "")
        var everySelectionVisible = true
        for index in 1..<suggestions.count {
            assistant.move(1)
            everySelectionVisible = everySelectionVisible && list.selected == index
                && list.visibleSuggestionRange.contains(index) && list.visibleSuggestionRange.count <= 4
        }
        checks["Down reaches every result and scrolls the selected row into view"] = everySelectionVisible
        checks["last viewport reaches the final ranked result"] = list.visibleSuggestionRange == 9..<13
        assistant.move(1)
        checks["Down wraps to the first result and restores its viewport"] =
            list.selected == 0 && list.visibleSuggestionRange == 0..<4
        assistant.move(-1)
        checks["Up wraps to the final result and scrolls to it"] =
            list.selected == 12 && list.visibleSuggestionRange == 9..<13

        let window = NSWindow(contentRect: NSRect(origin: .zero, size: list.boxSize),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = list
        list.frame = NSRect(origin: .zero, size: list.boxSize)
        var clicked: Int?
        let savedOnSelect = list.onSelectRow
        list.onSelectRow = { clicked = $0 }
        let point = list.convert(NSPoint(x: 80, y: list.pointerHeight + 32 + 35), to: nil)
        if let event = NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1) {
            list.mouseDown(with: event)
        }
        checks["clicking a scrolled row selects its actual source"] = clicked == 9
        list.onSelectRow = savedOnSelect
        if let outputPath {
            list.appearance = NSAppearance(named: .aqua)
            list.layoutSubtreeIfNeeded()
            if let bitmap = list.bitmapImageRepForCachingDisplay(in: list.bounds) {
                list.cacheDisplay(in: list.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
                }
            }
        }
        window.contentView = nil
        list.suggestions = Array(suggestions.prefix(2))
        checks["shorter refreshes discard an obsolete scroll offset"] = list.visibleSuggestionRange == 0..<2
        list.suggestions = []
        checks["empty refreshes have an empty viewport"] = list.visibleSuggestionRange.isEmpty
        return checks
    }

    /// Captures the real panel renderer from an actual API response without
    /// moving focus, synthesizing a room, or touching the user's host document.
    static func regressionRenderPreview(data: Data, pdfData: Data? = nil, to output: URL) -> Bool {
        guard var preview = parsePreview(data) else { return false }
        if let pdf = preview.pdf {
            guard let pdfData, let page = AssistPDFPageImage.render(data: pdfData, preview: pdf) else { return false }
            preview.pdfPage = page
        }
        let renderView = AssistBoxView()
        let label = preview.model?.selectedLabel.isEmpty == false
            ? preview.model!.selectedLabel : preview.location
        renderView.suggestions = [AssistSuggestion(
            insertText: label, label: label,
            detail: preview.valueText ?? preview.context, path: preview.path,
            location: preview.location, replacement: nil,
            objectId: nil, versionId: nil, snapshotId: nil,
            usageObjectId: nil, projectId: "", rankingReason: nil)]
        renderView.preview = preview
        renderView.sourceScoped = true
        renderView.frame = NSRect(origin: .zero, size: renderView.boxSize)
        renderView.appearance = NSAppearance(named: .aqua)
        renderView.layoutSubtreeIfNeeded()
        guard let bitmap = renderView.bitmapImageRepForCachingDisplay(in: renderView.bounds) else { return false }
        renderView.cacheDisplay(in: renderView.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return false }
        do { try png.write(to: output, options: .atomic); return true }
        catch { return false }
    }

    // The signed integration build exercises the production popup, keyboard
    // handler, timer, and response delivery without depending on source data.
    private var regressionSuggestion: AssistSuggestion {
        AssistSuggestion(insertText: "supplies", label: "Supplies", detail: "$400",
                         path: "Fixture.xlsx", location: "Budget!B2", replacement: nil,
                         objectId: nil, versionId: nil, snapshotId: nil, usageObjectId: nil,
                         projectId: "fixture", rankingReason: nil)
    }

    func regressionShowPopup() -> Bool {
        hide()
        regressionPrediction = false
        guard let captured = AccessibilityReader.focusedContext() else { return false }
        isEnabled = true
        context = captured
        view.sourceScoped = true
        show([regressionSuggestion], near: captured.caretRect)
        panel?.contentView?.layoutSubtreeIfNeeded()
        return panel?.isVisible == true
    }

    func regressionPredictPopup(serverURL: URL, projectIds: [String], revision: String) {
        hide()
        regressionPrediction = true
        regressionAccepted = nil
        self.serverURL = serverURL
        self.projectIds = projectIds
        workspaceRevision = revision
        linkedSources.removeAll()
        linkedContext = nil
        linkedElement = nil
        isEnabled = true
        refresh()
    }

    func regressionPopupState() -> [String: Any] {
        func rectangle(_ rect: CGRect?) -> Any {
            guard let rect else { return NSNull() }
            return ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
        }
        let closeFrame = panel.map { $0.convertToScreen(view.closeButton.convert(view.closeButton.bounds, to: nil)) }
        return ["visible": panel?.isVisible == true, "frame": rectangle(panel?.frame),
                "caret": rectangle(popupHost?.visibleCaret(using: AccessibilityReader.caretRect(of:))),
                "closeButtonFrame": rectangle(closeFrame), "tracking": hostTimer?.isValid == true,
                "selected": view.selected,
                "suggestions": view.suggestions.map { suggestion -> [String: Any] in
                    ["label": suggestion.label, "insertText": suggestion.insertText,
                     "replacementStart": suggestion.replacement.map { $0.start as Any } ?? NSNull(),
                     "replacementText": suggestion.replacement?.expectedText ?? "",
                     "objectId": suggestion.objectId ?? "", "projectId": suggestion.projectId]
                }, "accepted": regressionAccepted as Any? ?? NSNull()]
    }

    func regressionKey(_ keyCode: Int) {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(keyCode), keyDown: true) else { return }
        _ = handle(type: .keyDown, event: event)
    }

    func regressionClosePopup() { view.closeButton.performClick(nil) }

    func regressionBeginDelayedPopup() {
        hide()
        guard let captured = AccessibilityReader.focusedContext() else { return }
        isEnabled = true
        context = captured
        guard startTrackingHost(for: captured) else { return }
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self else { return }
            self.deliverPrediction([self.regressionSuggestion], heading: nil, sourceScoped: true,
                                   captured: captured, token: token)
        }
    }
    #endif

    /// Deterministic render used only when LASSO_OVERLAY_FIXTURE=1. Keeping the
    /// fixture beside the production view makes visual QA exercise the exact
    /// same AppKit drawing, material, and sizing path users receive.
    func showDesignFixture() {
        view.mode = .suggestions
        view.selected = 0
        view.sourceScoped = true
        view.suggestions = [
            AssistSuggestion(insertText: "Office supplies", label: "Office supplies",
                             detail: "$400", path: "/Accounting/Income-Statement.xlsx",
                             location: "Accounting!B21", replacement: nil,
                             objectId: "fixture-1", versionId: "v1", snapshotId: "s1",
                             usageObjectId: nil, projectId: "fixture", rankingReason: nil),
            AssistSuggestion(insertText: "Office supplies budget", label: "Office supplies budget",
                             detail: "$420", path: "/Expenses/Budget-Plan.xlsx",
                             location: "Expenses!B18", replacement: nil,
                             objectId: "fixture-2", versionId: "v1", snapshotId: "s1",
                             usageObjectId: nil, projectId: "fixture", rankingReason: nil),
            AssistSuggestion(insertText: "Office supplies actual", label: "Office supplies actual",
                             detail: "$375", path: "/History/Historical-Expenses.xlsx",
                             location: "Sheet1!C9", replacement: nil,
                             objectId: "fixture-3", versionId: "v1", snapshotId: "s1",
                             usageObjectId: nil, projectId: "fixture", rankingReason: nil),
            AssistSuggestion(insertText: "Supplies account", label: "Supplies account",
                             detail: "6110", path: "/Accounting/Chart-of-Accounts.pdf",
                             location: "p. 6", replacement: nil,
                             objectId: "fixture-4", versionId: "v1", snapshotId: "s1",
                             usageObjectId: nil, projectId: "fixture", rankingReason: nil),
        ]
        view.preview = AssistDocumentPreview(
            filename: "Income-Statement.xlsx",
            path: "/Accounting/Income-Statement.xlsx",
            location: "Accounting!B21",
            context: "Office supplies",
            valueText: "$400",
            objectType: "SPREADSHEET_CELL",
            snapshotVersion: 1,
            columns: ["A", "B", "D", "F"],
            headers: ["", "Current Period", "Prior Period", "Increase (Decrease)"],
            rows: [
                AssistPreviewRow(rowNumber: 18, cells: [
                    AssistPreviewCell(value: "Payroll Taxes", cited: false),
                    AssistPreviewCell(value: "225", cited: false), AssistPreviewCell(value: "215", cited: false), AssistPreviewCell(value: "10", cited: false)]),
                AssistPreviewRow(rowNumber: 19, cells: [
                    AssistPreviewCell(value: "Depreciation-Direct", cited: false),
                    AssistPreviewCell(value: "612", cited: false), AssistPreviewCell(value: "612", cited: false), AssistPreviewCell(value: "0", cited: false)]),
                AssistPreviewRow(rowNumber: 20, cells: [
                    AssistPreviewCell(value: "Office Supplies", cited: false),
                    AssistPreviewCell(value: "400", cited: true), AssistPreviewCell(value: "310", cited: false), AssistPreviewCell(value: "90", cited: false)]),
                AssistPreviewRow(rowNumber: 21, cells: [
                    AssistPreviewCell(value: "Utilities", cited: false),
                    AssistPreviewCell(value: "180", cited: false)]),
                AssistPreviewRow(rowNumber: 22, cells: [
                    AssistPreviewCell(value: "", cited: false),
                    AssistPreviewCell(value: "", cited: false)]),
            ])
        view.isPreviewLoading = false
        view.pointerAtTop = true
        view.pointerX = 84

        let panel = existingPanel()
        let size = view.boxSize
        view.frame = NSRect(origin: .zero, size: size)
        view.needsDisplay = true
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrame(NSRect(x: visible.midX - size.width / 2,
                              y: visible.midY - size.height / 2,
                              width: size.width, height: size.height), display: true)
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func show(_ suggestions: [AssistSuggestion], near caret: CGRect?) {
        feedbackDismissed = false
        guard view.mode == .suggestions else { return }
        guard let context, startTrackingHost(for: context), let liveCaret = popupCaret else { hide(); return }
        let panel = existingPanel()
        view.suggestions = suggestions
        view.selected = min(view.selected, max(0, suggestions.count - 1))
        loadPreviewForSelection()
        let size = view.boxSize
        view.frame = NSRect(origin: .zero, size: size)
        view.needsDisplay = true

        let mainFrame = anchoredFrame(for: liveCaret, size: size)
        panel.setFrame(mainFrame, display: true)
        panel.orderFrontRegardless()
    }

    /// Moves an already-visible box to follow the caret.
    /// Follows the caret between refreshes, throttled so fast typing does not
    /// flood the Accessibility API.
    private func trackCaret() {
        guard popupHost != nil else { return }
        let stamp = Date()
        guard stamp.timeIntervalSince(lastTrack) > 0.03 else { return }
        lastTrack = stamp
        updateHostPosition()
    }

    @discardableResult
    private func startTrackingHost(for context: CaretContext) -> Bool {
        if popupHost == nil || !CFEqual(popupHost!.element, context.element) {
            popupHost = AssistPopupHost(element: context.element)
        }
        guard let rect = popupHost?.visibleCaret(using: AccessibilityReader.caretRect(of:)) else { return false }
        popupCaret = rect
        if hostTimer == nil {
            let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.updateHostPosition() }
            timer.tolerance = 0.02
            // Keep following while the user drags or resizes a host window.
            RunLoop.main.add(timer, forMode: .common)
            hostTimer = timer
            let center = NSWorkspace.shared.notificationCenter
            for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                         NSWorkspace.didHideApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
                hostObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.updateHostPosition()
                })
            }
        }
        return true
    }

    private func updateHostPosition() {
        guard let host = popupHost else { return }
        guard let rect = host.visibleCaret(using: AccessibilityReader.caretRect(of:)) else { hide(); return }
        popupCaret = rect
        reposition(near: rect)
    }

    private func stopTrackingHost() {
        hostTimer?.invalidate()
        hostTimer = nil
        let center = NSWorkspace.shared.notificationCenter
        hostObservers.forEach { center.removeObserver($0) }
        hostObservers.removeAll()
        popupHost = nil
        popupCaret = nil
    }

    private func reposition(near caret: CGRect?) {
        guard let panel, panel.isVisible else { return }
        let size = ShareComposerController.shared.isPresented(in: panel)
            ? ShareComposerController.shared.canvasSize : view.boxSize
        let mainFrame = anchoredFrame(for: caret, size: size)
        panel.setFrame(mainFrame, display: true)
    }

    /// Accessibility reports rectangles with the origin at the top-left of the
    /// primary display; AppKit windows use a bottom-left origin. The popover is
    /// shifted left so its pointer — not its outer edge — sits under the caret.
    private func anchoredFrame(for caret: CGRect?, size: NSSize) -> NSRect {
        let preferredPointerX: CGFloat = 84
        guard let caret else {
            let mouse = NSEvent.mouseLocation
            let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main
            var x = mouse.x - preferredPointerX
            var y = mouse.y - size.height - 4
            if let visible = screen?.visibleFrame {
                x = min(max(visible.minX, x), visible.maxX - size.width)
                y = min(max(visible.minY, y), visible.maxY - size.height)
            }
            view.pointerAtTop = true
            view.pointerX = min(max(mouse.x - x, 32), size.width - 32)
            view.superview?.layoutSubtreeIfNeeded()
            return NSRect(x: x, y: y, width: size.width, height: size.height)
        }

        let primary = NSScreen.screens.first(where: { $0.frame.origin == .zero })
            ?? NSScreen.screens.first
        let primaryTop = primary?.frame.maxY ?? 0
        let caretBottom = primaryTop - caret.maxY
        let caretTop = primaryTop - caret.minY
        let caretX = caret.midX

        var x = caretX - preferredPointerX
        var y = caretBottom - size.height - 2
        var pointerAtTop = true

        let point = NSPoint(x: caretX, y: caretBottom)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(point) })
            ?? primary ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            if y < visible.minY {
                y = caretTop + 2
                pointerAtTop = false
            }
            y = min(max(visible.minY, y), visible.maxY - size.height)
            x = min(max(visible.minX, x), visible.maxX - size.width)
        }

        view.pointerAtTop = pointerAtTop
        view.pointerX = min(max(caretX - x, 32), size.width - 32)
        view.superview?.layoutSubtreeIfNeeded()
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let size = view.boxSize
        let created = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        created.level = .popUpMenu
        created.isOpaque = false
        created.hasShadow = true
        created.backgroundColor = .clear
        created.ignoresMouseEvents = false
        created.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        view.frame = NSRect(origin: .zero, size: size)
        view.onSelectRow = { [weak self] index in self?.selectRow(index) }
        view.onInsert = { [weak self] in self?.activateSelection() }
        view.onLocalLink = { [weak self] in self?.acceptPlain() }
        view.onShare = { [weak self] in self?.acceptShared() }
        view.onOpenSource = { [weak self] in self?.openCurrentSource() }
        view.onAllSources = { [weak self] in self?.chooseSource(allDocuments: true) }
        view.onDismiss = { [weak self] in self?.hide() }
        created.contentView = AssistBubbleContainer(content: view)
        panel = created
        return created
    }


    private func move(_ delta: Int) {
        if view.mode == .confirmShare {
            view.selected = (view.selected + delta + view.confirmChoices.count) % view.confirmChoices.count
            view.needsDisplay = true
            return
        }
        guard !view.suggestions.isEmpty else { return }
        selectRow((view.selected + delta + view.suggestions.count) % view.suggestions.count)
    }

    /// `Tab`. Follows the insertion preference; sharing is never implicit.
    private func activateSelection() {
        guard view.mode == .suggestions,
              let suggestion = currentSuggestion else { hide(); return }
        switch InsertionMode.current {
        case .plain:
            acceptPlain()
        case .share:
            if suggestion.isShareable { acceptShared() } else { acceptPlain() }
        case .ask:
            if suggestion.isShareable { askBeforeSharing() } else { acceptPlain() }
        }
    }

    private var currentSuggestion: AssistSuggestion? {
        guard view.selected < view.suggestions.count else { return nil }
        return view.suggestions[view.selected]
    }

    private func askBeforeSharing() {
        pendingShare = currentSuggestion
        view.mode = .confirmShare
        view.title = "Insert as plain text or a share link?"
        view.confirmChoices = ["Plain text", "Share link…"]
        view.selected = 0
        refreshPanelGeometry()
    }

    private func resolveConfirmation() {
        let shareIt = view.selected == 1
        guard let suggestion = pendingShare else { hide(); return }
        pendingShare = nil
        view.mode = .suggestions
        if shareIt { beginShare(suggestion) } else { insertPlain(suggestion) }
    }

    private func acceptPlain() {
        guard let suggestion = currentSuggestion else { hide(); return }
        insertPlain(suggestion)
    }

    /// Explicit Share action (or `⇧⌘⏎`). Never reached by the local-link shortcut.
    private func acceptShared() {
        guard view.mode == .suggestions, let suggestion = currentSuggestion else { return }
        guard suggestion.isShareable else {
            flash(["This suggestion has no linkable source."])
            return
        }
        beginShare(suggestion)
    }

    private func beginShare(_ suggestion: AssistSuggestion) {
        guard let serverURL, let savedContext = context, !suggestion.projectId.isEmpty, let objectId = suggestion.objectId else {
            flash(["Sharing is unavailable right now."])
            return
        }
        let anchor = panel?.frame ?? NSRect(origin: NSEvent.mouseLocation, size: .zero)
        let savedSelection = view.selected
        let savedScope = view.sourceScoped
        // Keep the existing nonactivating panel and its host focus throughout
        // access selection. Late predictions must not replace this content.
        generation += 1
        debounce?.invalidate()
        debounce = nil
        request?.cancel()
        request = nil
        flashTimer?.invalidate()
        ShareComposerController.shared.show(
            objectId: objectId, versionId: suggestion.versionId,
            label: suggestion.label, sourcePath: suggestion.path, near: anchor, serverURL: serverURL, actionTitle: "Insert link",
            hostPanel: existingPanel(),
            projectId: suggestion.projectId,
            onCancel: { [weak self] in
                guard let self else { return }
                self.view.mode = .suggestions
                self.view.selected = savedSelection
                self.view.sourceScoped = savedScope
                self.show(self.view.suggestions, near: self.context?.caretRect)
            }
        ) { [weak self] configuration in
            self?.insertShared(suggestion, configuration: configuration, context: savedContext, serverURL: serverURL)
        }
    }

    // MARK: Insertion

    /// Stage A. Builds the smallest edit that turns what the user typed into the
    /// suggestion, refusing anything that would touch text it should not.
    private func planInsertion(for suggestion: AssistSuggestion,
                               in context: CaretContext) -> Result<CompletionPlan, CompletionFailure> {
        let window = Array(context.text.utf16)
        // The captured window ends at the caret, so the caret is its length.
        let caret = window.count
        let cased = Self.matchCasing(of: suggestion.insertText,
                                     replacing: suggestion.replacement?.expectedText ?? Self.trailingWord(window),
                                     precededBy: window, upTo: suggestion.replacement?.start ?? window.count)
        return CompletionTransaction.plan(document: window, caret: caret, insertText: cased,
                                          replacement: suggestion.replacement,
                                          separateInsertion: !suggestion.sentenceContinuation)
    }

    /// The run of characters before the caret, used only to decide casing.
    private static func trailingWord(_ window: [UInt16]) -> String {
        var start = window.count
        while start > 0, window[start - 1] != 32, window[start - 1] != 10 { start -= 1 }
        return String(decoding: window[start...], as: UTF16.self)
    }

    private func insertPlain(_ suggestion: AssistSuggestion) {
        guard let context else { hide(); return }
        AssistLog.write("TAB ACCEPT  \(context.diagnosis)")

        guard case .success(let plan) = planInsertion(for: suggestion, in: context) else {
            AssistLog.write("  ✗ could not plan an edit — aborting")
            hide()
            flash(["Could not insert here.", "Nothing was changed."])
            return
        }

        // Stage A: confirm the plan is still current against a fresh read.
        guard let fresh = AccessibilityReader.focusedContext(),
              CFEqual(fresh.element, context.element),
              fresh.windowStart == context.windowStart, fresh.absoluteCaret == context.absoluteCaret,
              CompletionTransaction.equivalentHostText(Array(fresh.text.utf16), Array(context.text.utf16)) else {
            AssistLog.write("  ✗ focus moved before insertion — aborting")
            hide()
            return
        }
        let before = Array(fresh.text.utf16)
        let beforeSnapshot = CompletionSnapshot(documentStart: fresh.windowStart,
                                                text: before)
        if let failure = CompletionTransaction.validate(plan, against: before, caret: before.count) {
            AssistLog.write("  ✗ plan is stale (\(failure.rawValue)) — aborting, nothing changed")
            hide()
            return
        }
        AssistLog.write("  ✓ plan: replace \(plan.range.count) char(s) “\(plan.expectedPrefix)” with “\(plan.insertText)”")

        hide()
        AccessibilityReader.replace(length: plan.range.count, at: context.absoluteCaret,
                                    with: plan.insertText, in: context.element, expected: fresh, expectedPrefix: plan.expectedPrefix) { [weak self] applied in
            guard let self else { return }
            self.completeInsertion(suggestion, plan: plan, before: beforeSnapshot,
                                   element: context.element, applied: applied)
        }
    }

    /// Stages A→B. Reads the host back, proves only the intended interval
    /// changed, and only then records a dependency.
    private func completeInsertion(_ suggestion: AssistSuggestion, plan: CompletionPlan,
                                   before: CompletionSnapshot, element: AXUIElement, applied: Bool) {
        guard applied else {
            AssistLog.write("  ✗ insertion verification failed — aborting reference creation")
            flash(["The insertion could not be verified.", "No source reference was recorded."])
            return
        }

        guard let after = AccessibilityReader.focusedContext(), after.element == element else {
            AssistLog.write("  ✗ host lost after insertion — no reference created")
            flash(["Text inserted, but its source could not be anchored here."])
            return
        }
        let afterUnits = Array(after.text.utf16)
        let afterSnapshot = CompletionSnapshot(documentStart: after.windowStart, text: afterUnits)
        switch CompletionTransaction.verify(before: before, after: afterSnapshot, plan: plan) {
        case .failure(let failure):
            AssistLog.write("  ✗ insertion verification failed (\(failure.rawValue)) — no reference created")
            if failure == .outsideRangeModified {
                flash(["Insertion touched other text.", "No dependency was recorded."])
            }
        case .success(let verified):
            AssistLog.write("  ✓ insertion verified · document range \(verified.documentRange.lowerBound)..<\(verified.documentRange.upperBound)")
            let content = plan.sourceRange ?? 0..<plan.insertText.utf16.count
            let sourceRange = (verified.snapshotRange.lowerBound + content.lowerBound)..<(verified.snapshotRange.lowerBound + content.upperBound)
            let sourceText = String(decoding: afterUnits[sourceRange], as: UTF16.self)
            #if BROWSER_GEOMETRY_TEST
            if regressionPrediction {
                regressionAccepted = ["text": sourceText,
                    "start": after.windowStart + sourceRange.lowerBound,
                    "end": after.windowStart + sourceRange.upperBound,
                    "objectId": suggestion.objectId ?? ""]
                return
            }
            #endif
            recordAcceptedUsage(suggestion)
            // The next suggestion should offer this source's values, not the
            // same phrase again.
            if let objectId = suggestion.objectId, let snapshotId = suggestion.snapshotId {
                linkedSources.append(LinkedSource(projectId: suggestion.projectId, objectId: objectId, snapshotId: snapshotId,
                                                  text: sourceText))
                if linkedSources.count > 8 { linkedSources.removeFirst() }
                AssistLog.write("  · source context: \(suggestion.label)")
            }
            guard let objectId = suggestion.objectId else {
                AssistLog.write("  · no linkable source; nothing to record")
                return
            }
            // Stage B: the reference starts from the verified range, never from
            // a fresh search of the document.
            DependencyHighlighter.shared.recordVerifiedInsertion(
                objectId: objectId, versionId: suggestion.versionId,
                projectId: suggestion.projectId,
                label: suggestion.label, valueText: suggestion.detail,
                sourcePath: suggestion.path, sourceLocation: suggestion.detail,
                document: afterUnits, range: sourceRange,
                documentOffset: after.windowStart)
        }
    }

    /// Create the record, build the URL, insert the link, verify it landed, and
    /// revoke the record if it did not.
    private func insertShared(_ suggestion: AssistSuggestion, configuration: ShareConfiguration,
                              context: CaretContext, serverURL: URL) {
        guard let objectId = suggestion.objectId else {
            flash(["Sharing is unavailable right now."])
            return
        }
        guard case .success(let planned) = planInsertion(for: suggestion, in: context) else {
            flash(["Could not insert here.", "Nothing was changed."])
            return
        }
        guard let fresh = AccessibilityReader.focusedContext(), fresh.element == context.element,
              fresh.absoluteCaret == context.absoluteCaret, fresh.windowStart == context.windowStart,
              CompletionTransaction.equivalentHostText(Array(fresh.text.utf16), Array(context.text.utf16)) else {
            flash(["The insertion point changed. Choose the source again."])
            return
        }
        let before = CompletionSnapshot(documentStart: fresh.windowStart, text: Array(fresh.text.utf16))
        let element = context.element
        let caret = context.absoluteCaret
        hide()
        flash(["Creating share link…"])

        ShareClient.createShare(serverURL: serverURL, projectId: suggestion.projectId,
                                objectId: objectId, versionId: suggestion.versionId, configuration: configuration) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure(let error):
                    AssistLog.write("share creation failed: \(error.localizedDescription)")
                    // No record, so nothing was inserted and nothing to clean up.
                    self.flash(["Could not create the share link.", "Nothing was inserted."])
                case .success(let share):
                    self.performLinkInsertion(share, plan: planned, before: before, element: element, caret: caret,
                                              suggestion: suggestion, serverURL: serverURL)
                }
            }
        }
    }

    private func performLinkInsertion(_ share: DependencyShare, plan: CompletionPlan,
                                      before: CompletionSnapshot, element: AXUIElement, caret: Int,
                                      suggestion: AssistSuggestion, serverURL: URL) {
        guard let fresh = AccessibilityReader.focusedContext(), fresh.element == element,
              fresh.absoluteCaret == caret, fresh.windowStart == before.documentStart,
              CompletionTransaction.equivalentHostText(Array(fresh.text.utf16), before.text) else {
            ShareClient.revokeShare(serverURL: serverURL, token: share.token)
            flash(["The insertion point changed. Nothing was inserted."])
            return
        }
        isInserting = true
        RichTextInserter.insertLink(label: plan.insertText, url: share.url, replacing: plan.range.count,
                                   at: caret, in: element, keyboardDeleteCount: plan.expectedPrefix.count,
                                   validateSelection: { selected in
            AccessibilityReader.canPaste(in: element, before: before, caret: caret,
                                         expectedPrefix: plan.expectedPrefix, selected: selected)
        }) { [weak self] pasted in
            guard let self else { ShareClient.revokeShare(serverURL: serverURL, token: share.token); return }
            guard pasted else {
                self.isInserting = false
                ShareClient.revokeShare(serverURL: serverURL, token: share.token)
                self.flash(["The insertion point changed. Nothing was inserted."])
                return
            }
            let fallback = RichTextInserter.plainText(label: plan.insertText, url: share.url)
            var verifiedPlan: CompletionPlan?
            RichTextInserter.verifyEventually(verify: {
                guard let after = AccessibilityReader.focusedContext(), CFEqual(after.element, element) else { return false }
                let snapshot = CompletionSnapshot(documentStart: after.windowStart, text: Array(after.text.utf16))
                for text in [plan.insertText, fallback] {
                    let candidate = CompletionPlan(range: plan.range, expectedPrefix: plan.expectedPrefix, insertText: text,
                        sourceRange: text == plan.insertText ? plan.sourceRange : nil)
                    if case .success = CompletionTransaction.verify(before: before, after: snapshot, plan: candidate),
                       text == fallback || AccessibilityReader.hyperlinkPresent(text, url: share.url, in: after) {
                        verifiedPlan = candidate
                        return true
                    }
                }
                return false
            }) { verified in
                self.isInserting = false
                if verified, let verifiedPlan {
                    self.completeInsertion(suggestion, plan: verifiedPlan, before: before, element: element, applied: true)
                    let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(share.url.host ?? "")
                    self.flash([verifiedPlan.insertText == fallback ? "Link inserted as text" : "Hyperlink inserted",
                                local ? "Available only on this Mac" : "Source access is set by your sharing choice"])
                } else {
                    ShareClient.revokeShare(serverURL: serverURL, token: share.token)
                    self.flash(["The link could not be verified.", "Its access link was revoked."])
                }
            }
        }
    }

    private func recordAcceptedUsage(_ suggestion: AssistSuggestion) {
        guard let serverURL else { return }
        RecommendationUsageClient.record(serverURL: serverURL, projectId: suggestion.projectId,
                                         objectId: suggestion.usageObjectId, path: suggestion.path,
                                         kind: "accept")
    }

    // MARK: Feedback

    /// Brief, non-modal confirmation drawn in the same terminal box.
    private func flash(_ lines: [String], seconds: TimeInterval = 2.2) {
        guard !feedbackDismissed else { return }
        guard let context, startTrackingHost(for: context) else { hide(); return }
        let panel = existingPanel()
        view.mode = .message
        messageShownAt = Date()
        view.title = "lasso"
        view.messageLines = lines
        refreshPanelGeometry()
        panel.orderFrontRegardless()
        flashTimer?.invalidate()
        flashTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.hide()
        }
    }

    private func refreshPanelGeometry() {
        let panel = existingPanel()
        let size = view.boxSize
        view.frame = NSRect(origin: .zero, size: size)
        view.needsDisplay = true
        let mainFrame = anchoredFrame(for: popupCaret ?? context?.caretRect, size: size)
        panel.setFrame(mainFrame, display: true)
    }

    /// Source labels are stored in title case ("Office Supplies"). Dropped into
    /// the middle of a sentence after a lower-case word, that reads wrong, so
    /// plainly capitalised words are lowered. Acronyms, mixed-case words and
    /// anything containing digits keep their original form.
    private static func matchCasing(of insertion: String, replacing typed: String,
                                    precededBy window: [UInt16], upTo index: Int) -> String {
        guard !typed.isEmpty, typed == typed.lowercased() else { return insertion }
        let before = String(decoding: window[0..<min(window.count, max(0, index))], as: UTF16.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // Start of a sentence keeps its capital.
        guard let last = before.last, !".!?:".contains(last) else { return insertion }

        func lowerIfPlainTitleCase(_ word: Substring) -> String {
            guard let first = word.first, first.isUppercase else { return String(word) }
            let rest = word.dropFirst()
            guard word.count > 1,
                  rest.allSatisfy({ $0.isLowercase || $0 == "'" || $0 == "-" }) else { return String(word) }
            return first.lowercased() + rest
        }
        return insertion.split(separator: " ", omittingEmptySubsequences: false)
            .map(lowerIfPlainTitleCase)
            .joined(separator: " ")
    }

    private func dismissForEscape() {
        feedbackDismissed = true
        hide()
    }

    func hide() {
        generation += 1
        if ShareComposerController.shared.isPresented(in: panel) { ShareComposerController.shared.hide() }
        stopTrackingHost()
        debounce?.invalidate()
        debounce = nil
        flashTimer?.invalidate()
        request?.cancel()
        request = nil
        previewRequest?.cancel()
        previewGeneration += 1
        previewKey = nil
        view.selected = 0
        view.mode = .suggestions
        view.title = "dependency"
        view.preview = nil
        view.previewError = nil
        view.isPreviewLoading = false
        view.sourceScoped = false
        pendingShare = nil
        panel?.orderOut(nil)
    }
}
