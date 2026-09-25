//  System-wide predictive provenance.
//
//  Watches typing in any application, reads the text around the caret through
//  the Accessibility API, asks the local CoLab Dry server for source-backed
//  suggestions, and draws a terminal-style completion box next to the caret.
//  Tab inserts the suggestion into whatever app is focused.
//
//  Requires Accessibility and Input Monitoring permission. Nothing is captured
//  or stored: the focused text window is sent only to 127.0.0.1 and discarded.
//  Accepted source identities and deliberate opens are recorded locally for ranking.

import Cocoa
import ApplicationServices

// MARK: - Model

struct AssistSuggestion {
    let insertText: String       // what gets typed into the focused app
    let label: String            // headline shown in the box
    let detail: String           // value or context, shown dim
    let path: String             // originating source file
    /// UTF-16 offset, within the captured window, of the partial word this
    /// suggestion replaces. Nil means "insert at the caret, replacing nothing".
    let replaceFrom: Int?
    /// Indexed object behind the suggestion. Required to create a share; absent
    /// for plain sentence completions, which have nothing to link to.
    let objectId: String?
    let versionId: String?
    let snapshotId: String?
    /// Sentence completions retain source identity for usage without becoming shareable.
    let usageObjectId: String?
    let projectId: String
    let rankingReason: String?

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

    /// A persisted highlight can belong to a project other than the active one.
    /// Resolve its owning project before counting an explicit inspector open.
    static func recordResolvedOpen(serverURL: URL, objectId: String) {
        var request = URLRequest(url: serverURL.appendingPathComponent("api/dependency-objects")
            .appendingPathComponent(objectId))
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let object = root["object"] as? [String: Any],
                  let projectId = object["projectId"] as? String else { return }
            record(serverURL: serverURL, projectId: projectId, objectId: objectId, kind: "open")
        }.resume()
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
        case .plain: return "Plain text by default"
        case .ask: return "Ask before sharing"
        case .share: return "Share link by default"
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
    let caretRect: CGRect?
    let element: AXUIElement
    let diagnosis: String
}

enum AssistLog {
    private static let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/CoLab Dry/assist.log")
    /// On by default while the feature settles; turn it off with
    /// `defaults write dry.colab.desktop AssistDebug -bool false`.
    static var enabled = UserDefaults.standard.object(forKey: "AssistDebug") as? Bool ?? true

    static func write(_ line: String) {
        guard enabled else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        let entry = "[\(stamp)] \(line)\n"
        let directory = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(entry.utf8))
            try? handle.close()
        } else {
            try? entry.write(to: url, atomically: true, encoding: .utf8)
        }
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

    static func focusedContext() -> CaretContext? {
        guard let (field, pid) = focusedElement() else {
            AssistLog.write("no focused element")
            return nil
        }
        AXUIElementSetMessagingTimeout(field, 0.4)

        let role = attribute(field, kAXRoleAttribute as String) as? String ?? "?"
        let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "?"
        if excludedRoles.contains(role) {
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
                            absoluteCaret: addressable ? caret : -1,
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

    /// The whole text of an element, for verifying an edit after the fact.
    static func wholeText(of element: AXUIElement) -> String? {
        if let value = attribute(element, kAXValueAttribute as String) as? String { return value }
        return WebTextReader.documentText(from: element)
    }

    /// Caret rectangle alone, without pulling any text. Cheap enough to run on
    /// every keystroke, which is what keeps the box pinned to the caret.
    static func focusedCaretRect() -> CGRect? {
        guard let (field, _) = focusedElement() else { return nil }
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
                        completion: ((Bool) -> Void)? = nil) {
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
            // A live selection already covers the partial word.
            SyntheticKeyboard.deleteBackwards(selectedRange ? 0 : length)
            SyntheticKeyboard.type(text)
            // Confirm the typed result rather than assuming it arrived.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
                let ok = landed(text, in: element)
                AssistLog.write("insert: typed result \(ok ? "confirmed" : "not detected")")
                completion?(ok)
            }
        }
    }

    /// True when the text now sits immediately before the caret.
    static func landed(_ text: String, in element: AXUIElement) -> Bool {
        let needle = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty, let context = focusedContext(), context.element == element else { return false }
        return CompletionTransaction.insertionIsAtCaret(needle, in: context.text)
    }
}

// MARK: - The completion box

/// Compact, caret-anchored project suggestions in the density and hierarchy of
/// a native Spotlight or password-manager result panel.
final class AssistBoxView: NSView {
    enum Mode { case suggestions, confirmShare, message }
    var mode: Mode = .suggestions
    var suggestions: [AssistSuggestion] = []
    var selected: Int = 0
    var title: String = "Dependency"
    var confirmChoices: [String] = []
    var messageLines: [String] = []
    var sourceScoped = false

    private let panelWidth: CGFloat = 398
    private let headerHeight: CGFloat = 38
    private let suggestionHeight: CGFloat = 54
    private let choiceHeight: CGFloat = 42
    private let messageHeight: CGFloat = 26
    private let footerHeight: CGFloat = 28

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

    var boxSize: NSSize {
        let footer = mode == .message ? CGFloat(8) : footerHeight
        return NSSize(width: panelWidth,
                      height: headerHeight + rowHeight * CGFloat(bodyRows) + footer)
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        bounds.fill()

        drawText("CoLab", in: NSRect(x: 12, y: 11, width: 42, height: 16),
                 font: NSFont.systemFont(ofSize: 10.5, weight: .semibold), color: .labelColor)
        let context = sourceScoped ? title.replacingOccurrences(of: "_", with: " ") : "Project sources"
        drawText(context, in: NSRect(x: 55, y: 11, width: bounds.width - 105, height: 16),
                 font: NSFont.systemFont(ofSize: 9.5, weight: .regular), color: .tertiaryLabelColor)
        drawText("esc", in: NSRect(x: bounds.width - 42, y: 11, width: 30, height: 16),
                 font: NSFont.systemFont(ofSize: 8.5, weight: .medium), color: .tertiaryLabelColor,
                 alignment: .right)
        drawSeparator(at: headerHeight)

        var y = headerHeight
        switch mode {
        case .suggestions:
            if suggestions.isEmpty {
                drawText("No matching indexed source", in: NSRect(x: 12, y: y + 19,
                         width: bounds.width - 24, height: 16),
                         font: NSFont.systemFont(ofSize: 10.5), color: .tertiaryLabelColor)
            }
            for (index, suggestion) in suggestions.enumerated() {
                let row = NSRect(x: 0, y: y, width: bounds.width, height: suggestionHeight)
                if index == selected {
                    NSColor.selectedContentBackgroundColor.withAlphaComponent(0.16).setFill()
                    row.fill()
                    NSColor.systemBlue.setFill()
                    NSRect(x: 0, y: row.minY + 5, width: 2, height: row.height - 10).fill()
                }

                let icon = sourceIcon(for: suggestion.path)
                let iconRect = NSRect(x: 11, y: row.minY + 12, width: 29, height: 29)
                icon.color.withAlphaComponent(index == selected ? 0.9 : 0.7).setFill()
                NSBezierPath(roundedRect: iconRect, xRadius: 6, yRadius: 6).fill()
                drawText(icon.label, in: NSRect(x: iconRect.minX, y: iconRect.minY + 8,
                         width: iconRect.width, height: 12),
                         font: NSFont.systemFont(ofSize: 7.5, weight: .bold), color: .white,
                         alignment: .center)

                let detailWidth: CGFloat = suggestion.detail.isEmpty ? 0 : 94
                drawText(suggestion.label,
                         in: NSRect(x: 49, y: row.minY + 9,
                                   width: row.width - detailWidth - 65, height: 17),
                         font: NSFont.systemFont(ofSize: 11.5, weight: .semibold), color: .labelColor)
                if !suggestion.detail.isEmpty {
                    drawText(suggestion.detail,
                             in: NSRect(x: row.maxX - detailWidth - 11, y: row.minY + 9,
                                       width: detailWidth, height: 17),
                             font: NSFont.systemFont(ofSize: 9.5, weight: .medium),
                             color: .systemGreen, alignment: .right)
                }
                let source = (suggestion.path as NSString).lastPathComponent
                let caption = [suggestion.rankingReason, source.isEmpty ? "Project workspace" : source]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                drawText(caption,
                         in: NSRect(x: 49, y: row.minY + 28, width: row.width - 62, height: 14),
                         font: NSFont.systemFont(ofSize: 9, weight: .regular),
                         color: .tertiaryLabelColor)
                y += suggestionHeight
                if index < suggestions.count - 1 { drawInsetSeparator(at: y, from: 49) }
            }

        case .confirmShare:
            for (index, choice) in confirmChoices.enumerated() {
                let row = NSRect(x: 0, y: y, width: bounds.width, height: choiceHeight)
                if index == selected {
                    NSColor.selectedContentBackgroundColor.withAlphaComponent(0.16).setFill()
                    row.fill()
                    NSColor.systemBlue.setFill()
                    NSRect(x: 0, y: row.minY + 5, width: 2, height: row.height - 10).fill()
                }
                drawText(choice, in: NSRect(x: 12, y: row.minY + 12,
                         width: row.width - 24, height: 17),
                         font: NSFont.systemFont(ofSize: 10.5, weight: .medium), color: .labelColor)
                y += choiceHeight
                if index < confirmChoices.count - 1 { drawInsetSeparator(at: y, from: 12) }
            }

        case .message:
            for line in messageLines {
                drawText(line, in: NSRect(x: 12, y: y + 7, width: bounds.width - 24, height: 16),
                         font: NSFont.systemFont(ofSize: 10, weight: .regular),
                         color: .secondaryLabelColor)
                y += messageHeight
            }
        }

        guard mode != .message else { return }
        let footerY = bounds.height - footerHeight
        drawSeparator(at: footerY)
        let hint = mode == .confirmShare
            ? "Return  Choose access     ↑↓  Select     Esc  Cancel"
            : "Tab  Insert     ↑↓  Select     Esc  Dismiss"
        drawText(hint, in: NSRect(x: 12, y: footerY + 8, width: bounds.width - 24, height: 14),
                 font: NSFont.systemFont(ofSize: 8.5, weight: .medium), color: .tertiaryLabelColor)
    }

    private func sourceIcon(for path: String) -> (label: String, color: NSColor) {
        switch (path as NSString).pathExtension.lowercased() {
        case "pdf": return ("PDF", .systemRed)
        case "xls", "xlsx", "csv", "tsv": return ("XLS", .systemGreen)
        case "doc", "docx", "rtf": return ("DOC", .systemBlue)
        case "png", "jpg", "jpeg", "tif", "tiff": return ("IMG", .systemPurple)
        default: return ("SRC", .systemIndigo)
        }
    }

    private func drawSeparator(at y: CGFloat) { drawInsetSeparator(at: y, from: 0) }

    private func drawInsetSeparator(at y: CGFloat, from x: CGFloat) {
        NSColor.separatorColor.withAlphaComponent(0.38).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 0.5
        path.move(to: NSPoint(x: x, y: y))
        path.line(to: NSPoint(x: bounds.width, y: y))
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

    var serverURL: URL?
    var projectId: String?
    private(set) var isEnabled = false

    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var panel: NSPanel?
    private var view = AssistBoxView()
    private var debounce: Timer?
    private var request: URLSessionDataTask?
    private var context: CaretContext?
    private var generation = 0
    private var sawEvent = false
    private var isInserting = false
    private var pendingShare: AssistSuggestion?
    /// Sources linked in the current surface, newest last. Reported to the
    /// server so it can offer their values instead of matching the same phrase.
    private struct LinkedSource { let objectId: String; let snapshotId: String; let text: String }
    private var linkedSources: [LinkedSource] = []
    private var linkedContext: String?
    private var flashTimer: Timer?
    private var lastTrack = Date.distantPast

    var onStateChange: (() -> Void)?

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
    func enable() -> String? {
        guard !isEnabled else { return nil }
        let accessibility = AssistPermission.hasAccessibility
        let input = AssistPermission.hasInputMonitoring
        AssistLog.write("enable requested: accessibility=\(accessibility) inputMonitoring=\(input)")

        if !accessibility {
            lastProblem = PermissionProblem(service: "Accessibility",
                                            settingsAnchor: "Privacy_Accessibility",
                                            stale: AssistPermission.isListedButUntrusted)
            AssistPermission.requestAccessibility()
            return lastProblem!.stale
                ? "macOS still lists CoLab Dry under Accessibility, but the approval belongs to an earlier build of the app, so it no longer applies.\n\nIn Privacy & Security → Accessibility, select CoLab Dry, remove it with the “−” button, then add it again with “+”."
                : "Turn on CoLab Dry under Privacy & Security → Accessibility, then enable this again."
        }
        // Input Monitoring is not always required: a keyboard tap usually works
        // with Accessibility alone. Ask for it only if the tap actually fails.
        if !input { AssistPermission.requestInputMonitoring() }
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
            lastProblem = PermissionProblem(service: "Input Monitoring",
                                            settingsAnchor: "Privacy_ListenEvent",
                                            stale: false)
            return "The keyboard tap could not be created.\n\nTurn on CoLab Dry under Privacy & Security → Input Monitoring. If it is already listed, remove it with “−” and add it again — approvals are tied to a specific build."
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
        if visible {
            switch keyCode {
            case 48:                                    // Tab
                DispatchQueue.main.async { self.activateSelection() }
                return nil                              // swallow: do not insert a tab
            case 36, 76:                                // Return / Enter
                if flags.contains(.maskCommand) {
                    DispatchQueue.main.async { self.acceptShared() }
                    return nil
                }
                if view.mode == .confirmShare {
                    DispatchQueue.main.async { self.resolveConfirmation() }
                    return nil
                }
            case 53:                                    // Escape
                DispatchQueue.main.async {
                    if self.view.mode == .confirmShare {
                        self.pendingShare = nil
                        self.view.mode = .suggestions
                        self.view.selected = 0
                        self.refreshPanelGeometry()
                    } else if self.view.mode == .suggestions && self.view.sourceScoped {
                        self.endSourceContext()
                    } else {
                        self.hide()
                    }
                }
                return nil
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

    /// Ends retrieval scope without unlinking or removing any dependency.
    /// The current text remains highlighted; only future suggestions become
    /// project-wide again.
    private func endSourceContext() {
        let count = linkedSources.count
        linkedSources.removeAll()
        request?.cancel()
        generation += 1
        view.sourceScoped = false
        view.title = "project index"
        view.needsDisplay = true
        AssistLog.write("SOURCE SCOPE ENDED (\(count) linked item(s)) → global project index")
        refresh()
    }

    private func scheduleRefresh() {
        guard view.mode == .suggestions else { return }
        debounce?.invalidate()
        debounce = Timer.scheduledTimer(withTimeInterval: 0.16, repeats: false) { [weak self] _ in
            self?.refresh()
        }
    }

    private func refresh() {
        guard isEnabled, let serverURL, let projectId else { return }
        guard let captured = AccessibilityReader.focusedContext() else { hide(); return }
        let trimmed = captured.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 4 else { hide(); return }
        // Linked sources belong to one surface only.
        if linkedContext != captured.diagnosis {
            linkedContext = captured.diagnosis
            linkedSources.removeAll()
        }
        context = captured
        // Track the caret straight away. Waiting for the response would leave
        // the box behind whenever fast typing cancels requests.
        if panel?.isVisible == true, view.mode == .suggestions { reposition(near: captured.caretRect) }

        generation += 1
        let token = generation
        request?.cancel()

        var request = URLRequest(url: serverURL
            .appendingPathComponent("api/projects/\(projectId)/dependencies/predict"))
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
                "blockIndex": 0,
                "start": start,
                "end": start + needle.count,
                "sourceObjectId": link.objectId,
                "sourceSnapshotId": link.snapshotId,
            ]
        }
        if !pending.isEmpty { body["pendingDependencies"] = pending }
        let sourceScoped = !pending.isEmpty
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data else { return }
            let parsed = Self.parse(data, windowLength: Array(captured.text.utf16).count, projectId: projectId)
            let heading = Self.heading(data)
            DispatchQueue.main.async {
                guard token == self.generation else { return }
                if parsed.isEmpty {
                    self.hide()
                } else {
                    self.view.sourceScoped = sourceScoped
                    self.view.title = heading ?? "dependency"
                    self.show(parsed, near: captured.caretRect)
                }
            }
        }
        self.request = task
        task.resume()
    }

    /// Turns a prediction payload into at most five insertable rows.
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

    private static func parse(_ data: Data, windowLength: Int, projectId: String) -> [AssistSuggestion] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prediction = root["prediction"] as? [String: Any] else { return [] }

        var results: [AssistSuggestion] = []

        // A sentence completion continues what is already typed, so it replaces
        // nothing.
        if let completion = prediction["completion"] as? [String: Any],
           let insert = completion["insertText"] as? String, !insert.isEmpty {
            let candidate = completion["dependencyCandidate"] as? [String: Any] ?? [:]
            let source = (completion["source"] as? [String: Any])?["path"] as? String ?? ""
            results.append(AssistSuggestion(
                insertText: insert,
                label: insert.trimmingCharacters(in: .whitespaces),
                detail: "sentence",
                path: source,
                replaceFrom: nil,
                objectId: nil, versionId: nil, snapshotId: nil,
                usageObjectId: candidate["id"] as? String,
                projectId: projectId,
                rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String))
        }

        // Once a source is linked the server answers with its downstream values
        // — the rows, columns and findings belonging to it — rather than with
        // the same phrase again.
        for group in ["workspaceCompletions", "sourceCompletions"] {
            for entry in (prediction[group] as? [[String: Any]] ?? []) {
                let candidate = entry["dependencyCandidate"] as? [String: Any] ?? [:]
                let insert = (entry["replacementText"] as? String)
                    ?? (entry["insertText"] as? String) ?? ""
                guard !insert.isEmpty else { continue }
                results.append(AssistSuggestion(
                    insertText: insert,
                    label: insert,
                    detail: candidate["valueText"] as? String ?? (entry["category"] as? String ?? ""),
                    path: AssistSourceIdentity.canonicalPath(
                        candidatePath: candidate["path"] as? String,
                        provenanceLabel: entry["provenanceLabel"] as? String
                    ),
                    replaceFrom: nil,
                    objectId: candidate["id"] as? String,
                    versionId: candidate["versionId"] as? String,
                    snapshotId: candidate["snapshotId"] as? String,
                    usageObjectId: candidate["id"] as? String,
                    projectId: projectId,
                    rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String))
                if results.count >= 5 { break }
            }
            if results.count >= 5 { break }
        }

        let claims = prediction["claims"] as? [[String: Any]] ?? []
        for claim in claims {
            // Only swap out the word when the claim actually runs to the caret.
            // If anything follows it — a space, say — this is a plain insertion.
            let claimStart = claim["start"] as? Int
            let claimEnd = claim["end"] as? Int
            let start = (claimEnd == windowLength) ? claimStart : nil
            let claimType = claim["type"] as? String
            for candidate in (claim["candidates"] as? [[String: Any]] ?? []) {
                let label = candidate["label"] as? String ?? ""
                let value = candidate["valueText"] as? String
                    ?? (candidate["displayValue"] as? String)
                let path = candidate["path"] as? String ?? ""
                let insert = AssistSuggestionSemantics.insertionText(
                    claimType: claimType, label: label, value: value)
                guard !insert.isEmpty else { continue }
                results.append(AssistSuggestion(
                    insertText: insert, label: label,
                    detail: value ?? (candidate["objectType"] as? String ?? ""), path: path,
                    replaceFrom: start,
                    objectId: candidate["id"] as? String,
                    versionId: candidate["versionId"] as? String,
                    snapshotId: candidate["snapshotId"] as? String,
                    usageObjectId: candidate["id"] as? String,
                    projectId: projectId,
                    rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String))
                if results.count >= 5 { break }
            }
            if results.count >= 5 { break }
        }
        return Array(results.prefix(5))
    }

    // MARK: Panel

    private func show(_ suggestions: [AssistSuggestion], near caret: CGRect?) {
        guard view.mode == .suggestions else { return }
        let panel = existingPanel()
        view.suggestions = suggestions
        view.selected = min(view.selected, max(0, suggestions.count - 1))
        let size = view.boxSize
        view.frame = NSRect(origin: .zero, size: size)
        view.needsDisplay = true

        let mainFrame = NSRect(origin: anchor(for: caret, size: size), size: size)
        panel.setFrame(mainFrame, display: true)
        panel.orderFrontRegardless()
    }

    /// Moves an already-visible box to follow the caret.
    /// Follows the caret between refreshes, throttled so fast typing does not
    /// flood the Accessibility API.
    private func trackCaret() {
        guard view.mode == .suggestions, panel?.isVisible == true else { return }
        let stamp = Date()
        guard stamp.timeIntervalSince(lastTrack) > 0.03 else { return }
        lastTrack = stamp
        if let rect = AccessibilityReader.focusedCaretRect() { reposition(near: rect) }
    }

    private func reposition(near caret: CGRect?) {
        guard let panel, panel.isVisible else { return }
        let size = view.boxSize
        let mainFrame = NSRect(origin: anchor(for: caret, size: size), size: size)
        panel.setFrame(mainFrame, display: true)
    }

    /// Accessibility reports rectangles with the origin at the top-left of the
    /// primary display; AppKit windows use a bottom-left origin. The conversion
    /// therefore hangs off the primary screen's height, not the caret's screen.
    private func anchor(for caret: CGRect?, size: NSSize) -> NSPoint {
        guard let caret else {
            let mouse = NSEvent.mouseLocation
            return NSPoint(x: mouse.x, y: mouse.y - size.height - 6)
        }

        let primary = NSScreen.screens.first(where: { $0.frame.origin == .zero })
            ?? NSScreen.screens.first
        let primaryTop = primary?.frame.maxY ?? 0

        // Caret edges converted into AppKit coordinates.
        let caretBottom = primaryTop - caret.maxY
        let caretTop = primaryTop - caret.minY

        var x = caret.minX
        var y = caretBottom - size.height - 4          // hang below the caret

        let point = NSPoint(x: caret.midX, y: caretBottom)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(point) })
            ?? primary ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            if y < visible.minY { y = caretTop + 4 }   // no room below: flip above
            y = min(max(visible.minY, y), visible.maxY - size.height)
            x = min(max(visible.minX, x), visible.maxX - size.width)
        }
        return NSPoint(x: x, y: y)
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let created = NSPanel(
            contentRect: NSRect(origin: .zero, size: NSSize(width: 398, height: 160)),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        created.level = .popUpMenu
        created.isOpaque = false
        created.hasShadow = true
        created.backgroundColor = .clear
        created.ignoresMouseEvents = true
        created.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        view.frame = NSRect(x: 0, y: 0, width: 398, height: 160)
        created.contentView = NativeMaterial.glassContainer(
            content: view, cornerRadius: 12,
            tint: NSColor.windowBackgroundColor.withAlphaComponent(0.10))
        panel = created
        return created
    }


    private func move(_ delta: Int) {
        guard !view.suggestions.isEmpty else { return }
        let count = view.suggestions.count
        view.selected = (view.selected + delta + count) % count
        view.needsDisplay = true
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
        view.title = "share this dependency?"
        view.confirmChoices = ["insert as plain text", "insert as shared link"]
        view.selected = 0
        refreshPanelGeometry()
    }

    private func resolveConfirmation() {
        let shareIt = view.selected == 1
        guard let suggestion = pendingShare else { hide(); return }
        pendingShare = nil
        view.mode = .suggestions
        if shareIt { insertShared(suggestion) } else { insertPlain(suggestion) }
    }

    private func acceptPlain() {
        guard let suggestion = currentSuggestion else { hide(); return }
        insertPlain(suggestion)
    }

    /// `⌘⏎`. Always shares, whatever the preference says.
    private func acceptShared() {
        guard view.mode == .suggestions, let suggestion = currentSuggestion else { return }
        guard suggestion.isShareable else {
            flash(["This suggestion has no linkable source."])
            return
        }
        insertShared(suggestion)
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
                                     replacing: Self.trailingWord(window),
                                     precededBy: window, upTo: window.count)
        return CompletionTransaction.plan(document: window, caret: caret, insertText: cased)
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
              fresh.element == context.element else {
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
                                    with: plan.insertText, in: context.element) { [weak self] applied in
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
            flash(["Could not insert here.", "Nothing was changed."])
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
            recordAcceptedUsage(suggestion)
            // The next suggestion should offer this source's values, not the
            // same phrase again.
            if let objectId = suggestion.objectId, let snapshotId = suggestion.snapshotId {
                linkedSources.append(LinkedSource(objectId: objectId, snapshotId: snapshotId,
                                                  text: plan.insertText))
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
                label: suggestion.label, valueText: suggestion.detail,
                sourcePath: suggestion.path, sourceLocation: suggestion.detail,
                document: afterUnits, range: verified.snapshotRange,
                documentOffset: after.windowStart)
        }
    }

    /// Create the record, build the URL, insert the link, verify it landed, and
    /// revoke the record if it did not.
    private func insertShared(_ suggestion: AssistSuggestion) {
        guard let context, let serverURL, let projectId, let objectId = suggestion.objectId else {
            flash(["Sharing is unavailable right now."])
            return
        }
        guard case .success(let planned) = planInsertion(for: suggestion, in: context) else {
            flash(["Could not insert here.", "Nothing was changed."])
            return
        }
        let plan = (length: planned.range.count, text: planned.insertText)
        let element = context.element
        let caret = context.absoluteCaret
        hide()
        flash(["Creating share link…"])

        ShareClient.createShare(serverURL: serverURL, projectId: projectId,
                                objectId: objectId, versionId: suggestion.versionId) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure(let error):
                    AssistLog.write("share creation failed: \(error.localizedDescription)")
                    // No record, so nothing was inserted and nothing to clean up.
                    self.flash(["Could not create the share link.", "Nothing was inserted."])
                case .success(let share):
                    self.performLinkInsertion(share, plan: plan, element: element, caret: caret,
                                              suggestion: suggestion)
                }
            }
        }
    }

    private func performLinkInsertion(_ share: DependencyShare, plan: (length: Int, text: String),
                                      element: AXUIElement, caret: Int, suggestion: AssistSuggestion) {
        isInserting = true
        AssistLog.write("insert link: \(share.url.absoluteString) replacing \(plan.length) char(s)")
        RichTextInserter.insertLink(label: plan.text, url: share.url, replacing: plan.length,
                                    at: caret, in: element) { [weak self] in
            guard let self else { return }
            // Read the field back: if the label is not there, the paste did not
            // land and the share must not be presented as live.
            let landed = Self.verifyInsertion(of: plan.text, in: element)
            self.isInserting = false
            if landed {
                self.recordAcceptedUsage(suggestion)
                let source = (suggestion.path as NSString).lastPathComponent
                self.flash(["Linked dependency inserted", "\(source) · \(suggestion.detail)"])
            } else {
                AssistLog.write("link insertion could not be verified; revoking \(share.token)")
                if let serverURL = self.serverURL {
                    ShareClient.revokeShare(serverURL: serverURL, token: share.token)
                }
                self.flash(["The link could not be inserted.", "The share was revoked; nothing was shared."])
            }
        }
    }

    private func recordAcceptedUsage(_ suggestion: AssistSuggestion) {
        guard let serverURL else { return }
        RecommendationUsageClient.record(serverURL: serverURL, projectId: suggestion.projectId,
                                         objectId: suggestion.usageObjectId, path: suggestion.path,
                                         kind: "accept")
    }

    private static func verifyInsertion(of text: String, in element: AXUIElement) -> Bool {
        guard let context = AccessibilityReader.focusedContext(), context.element == element else {
            // Some rich fields stop exposing a value mid-edit; treat an
            // unreadable field as unverifiable rather than as success.
            return false
        }
        let needle = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return false }
        return context.text.localizedCaseInsensitiveContains(needle)
    }

    // MARK: Feedback

    /// Brief, non-modal confirmation drawn in the same terminal box.
    private func flash(_ lines: [String], seconds: TimeInterval = 2.2) {
        let panel = existingPanel()
        view.mode = .message
        view.title = "colab"
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
        let mainFrame = NSRect(origin: anchor(for: context?.caretRect, size: size), size: size)
        panel.setFrame(mainFrame, display: true)
    }

    /// Source labels are stored in title case ("Office Supplies"). Dropped into
    /// the middle of a sentence after a lower-case word, that reads wrong, so
    /// plainly capitalised words are lowered. Acronyms, mixed-case words and
    /// anything containing digits keep their original form.
    private static func matchCasing(of insertion: String, replacing typed: String,
                                    precededBy window: [UInt16], upTo index: Int) -> String {
        guard !typed.isEmpty, typed == typed.lowercased() else { return insertion }
        let before = String(decoding: window[0..<max(0, index)], as: UTF16.self)
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

    func hide() {
        debounce?.invalidate()
        flashTimer?.invalidate()
        request?.cancel()
        view.selected = 0
        view.mode = .suggestions
        view.title = "dependency"
        pendingShare = nil
        panel?.orderOut(nil)
    }
}
