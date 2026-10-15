// Runs only when explicitly launched by browser-geometry.mjs. Using the signed
// app gives this integration test the same Accessibility permission as Lasso.
// The fixture belongs to a separate Chrome process and contains no user data.
import Cocoa
import ApplicationServices

enum BrowserGeometryRegression {
    static func run(arguments: [String]) -> Bool {
        guard let flag = arguments.firstIndex(of: "--browser-geometry-test") else { return false }
        guard arguments.count > flag + 2 else { return true }
        NSApp.setActivationPolicy(.accessory)
        NSApp.finishLaunching()
        let requestURL = URL(fileURLWithPath: arguments[flag + 1])
        let resultURL = URL(fileURLWithPath: arguments[flag + 2])
        let adapter = AccessibilityTextAdapter()
        var previousSequence = -1
        let deadline = Date().addingTimeInterval(240)
        while Date() < deadline {
            if let data = try? Data(contentsOf: requestURL),
               let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let sequence = request["sequence"] as? Int, sequence != previousSequence {
                previousSequence = sequence
                var response: [String: Any] = ["sequence": sequence]
                if request["command"] as? String == "stop" {
                    GlobalAssistant.shared.hide()
                    response["stopped"] = true
                    write(response, to: resultURL)
                    return true
                }
                if !AXIsProcessTrusted() {
                    response["error"] = "The signed Lasso app does not have Accessibility permission."
                } else if request["command"] as? String == "ping" {
                    response["ready"] = true
                } else if request["command"] as? String == "link-insert" {
                    do { response.merge(try insertLink(request)) { _, new in new } }
                    catch { response["error"] = error.localizedDescription }
                } else if (request["command"] as? String)?.hasPrefix("popup-") == true {
                    do { response.merge(try popup(request)) { _, new in new } }
                    catch { response["error"] = error.localizedDescription }
                } else {
                    do { response.merge(try measure(request, adapter: adapter)) { _, new in new } }
                    catch { response["error"] = error.localizedDescription }
                }
                write(response, to: resultURL)
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.025))
        }
        return true
    }

    private static func write(_ object: [String: Any], to url: URL) {
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func frame(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute as String),
              let size = attribute(element, kAXSizeAttribute as String),
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        return CGRect(origin: origin, size: dimensions)
    }

    private static func selection(_ element: AXUIElement) -> [Int]? {
        guard let value = attribute(element, kAXSelectedTextRangeAttribute as String),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
        return [range.location, range.length]
    }

    private static func rectangle(_ rect: CGRect) -> [String: CGFloat] {
        ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
    }

    private static func popup(_ request: [String: Any]) throws -> [String: Any] {
        let assistant = GlobalAssistant.shared
        var result: [String: Any] = [:]
        switch request["command"] as? String {
        case "popup-activate":
            guard let pid = request["pid"] as? Int32, let app = NSRunningApplication(processIdentifier: pid) else {
                throw NSError(domain: "BrowserGeometryRegression", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "Isolated Chrome PID is unavailable."])
            }
            result["activated"] = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        case "popup-show":
            result["shown"] = assistant.regressionShowPopup()
        case "popup-state":
            break
        case "popup-key":
            guard let keyCode = request["keyCode"] as? Int else {
                throw NSError(domain: "BrowserGeometryRegression", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "Missing popup test key code."])
            }
            assistant.regressionKey(keyCode)
        case "popup-close":
            assistant.regressionClosePopup()
        case "popup-delayed":
            assistant.regressionBeginDelayedPopup()
        default:
            throw NSError(domain: "BrowserGeometryRegression", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Unknown popup test command."])
        }
        result.merge(assistant.regressionPopupState()) { _, new in new }
        let primary = NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.screens.first
        result["primaryTop"] = primary?.frame.maxY ?? 0
        result["screens"] = NSScreen.screens.map {
            ["frame": rectangle($0.frame), "visibleFrame": rectangle($0.visibleFrame)]
        }
        result["frontmostPID"] = Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
        return result
    }

    private static func insertLink(_ request: [String: Any]) throws -> [String: Any] {
        GlobalAssistant.shared.hide()
        guard let captured = AccessibilityReader.focusedContext(),
              let label = request["label"] as? String,
              let rawURL = request["url"] as? String, let url = URL(string: rawURL),
              case .success(let plan) = CompletionTransaction.plan(document: Array(captured.text.utf16),
                caret: captured.text.utf16.count, insertText: label) else {
            throw NSError(domain: "BrowserGeometryRegression", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot capture the fixture insertion point."])
        }
        let before = CompletionSnapshot(documentStart: captured.windowStart, text: Array(captured.text.utf16))
        var result: Bool?
        RichTextInserter.insertLink(label: label, url: url, replacing: plan.range.count,
            at: request["keyboardFallback"] as? Bool == true ? -1 : captured.absoluteCaret,
            in: captured.element, keyboardDeleteCount: plan.expectedPrefix.count,
            validateSelection: { selected in
                AccessibilityReader.canPaste(in: captured.element, before: before, caret: captured.absoluteCaret,
                                             expectedPrefix: plan.expectedPrefix, selected: selected)
            }) { pasted in
                guard pasted else { result = false; return }
                RichTextInserter.verifyEventually(verify: {
                    guard let after = AccessibilityReader.focusedContext(), CFEqual(after.element, captured.element),
                          case .success = CompletionTransaction.verify(before: before,
                            after: CompletionSnapshot(documentStart: after.windowStart, text: Array(after.text.utf16)),
                            plan: plan) else { return false }
                    return AccessibilityReader.hyperlinkPresent(label, url: url, in: after)
                }) { result = $0 }
            }
        let deadline = Date().addingTimeInterval(4)
        while result == nil, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.025)) }
        return ["inserted": result ?? false, "prefix": plan.expectedPrefix,
                "caretBefore": captured.absoluteCaret, "windowBefore": captured.windowStart]
    }

    private static func measure(_ request: [String: Any], adapter: AccessibilityTextAdapter) throws -> [String: Any] {
        func failure(_ message: String) -> NSError {
            NSError(domain: "BrowserGeometryRegression", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        guard let pid = request["pid"] as? Int32,
              let editorID = request["editorID"] as? String,
              let phrase = request["phrase"] as? String, !phrase.isEmpty else {
            throw failure("Missing fixture PID, editor ID, or phrase.")
        }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        var budget = 4_000
        func find(_ element: AXUIElement, area: AXUIElement?, depth: Int) -> (AXUIElement, AXUIElement)? {
            guard budget > 0, depth < 60 else { return nil }
            budget -= 1
            let currentArea = attribute(element, kAXRoleAttribute as String) as? String == "AXWebArea" ? element : area
            if attribute(element, "AXDOMIdentifier") as? String == editorID, let currentArea {
                return (element, currentArea)
            }
            guard let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] else { return nil }
            for child in children {
                if let result = find(child, area: currentArea, depth: depth + 1) { return result }
            }
            return nil
        }
        guard let (editor, area) = find(app, area: nil, depth: 0), let viewport = frame(area) else {
            throw failure("The isolated Chrome fixture editor is not yet present in Accessibility.")
        }
        let context = HostContext(bundleIdentifier: "com.google.Chrome", applicationName: "Chrome fixture",
                                  documentContext: editorID, element: editor, windowFrame: nil)
        guard let text = adapter.documentText(context) else { throw failure("Fixture text is unavailable.") }
        let target = (text as NSString).range(of: phrase)
        guard target.location != NSNotFound else { throw failure("The fixture phrase is missing from AX text.") }
        let before = selection(editor)
        let started = ProcessInfo.processInfo.systemUptime
        let rects = adapter.rects(for: target.location..<(target.location + target.length), in: context)
        let durationMilliseconds = (ProcessInfo.processInfo.systemUptime - started) * 1_000
        let after = selection(editor)
        return ["rects": rects.map(rectangle), "viewport": rectangle(viewport),
                "text": text, "range": [target.location, target.length],
                "durationMilliseconds": durationMilliseconds,
                "selectionBefore": before as Any? ?? NSNull(), "selectionAfter": after as Any? ?? NSNull()]
    }
}
