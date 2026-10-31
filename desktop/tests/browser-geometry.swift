// Runs only when explicitly launched by browser-geometry.mjs. Using the signed
// app gives this integration test the same Accessibility permission as Lasso.
// The fixture belongs to a separate Chrome process and contains no user data.
import Cocoa
import ApplicationServices

enum BrowserGeometryRegression {
    private static let inspector = SourceInspectorPanel()
    private static var inspectorServerURL: URL?
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
                    inspector.hide()
                    response["stopped"] = true
                    write(response, to: resultURL)
                    return true
                }
                if request["command"] as? String == "render-model-preview" {
                    if let input = request["input"] as? String, let output = request["output"] as? String,
                       let previewData = try? Data(contentsOf: URL(fileURLWithPath: input)) {
                        let pdfData = (request["pdf"] as? String).flatMap {
                            try? Data(contentsOf: URL(fileURLWithPath: $0))
                        }
                        response["rendered"] = GlobalAssistant.regressionRenderPreview(
                            data: previewData, pdfData: pdfData, to: URL(fileURLWithPath: output))
                    } else { response["error"] = "Model preview JSON or output path is missing." }
                } else if request["command"] as? String == "model-orbit" {
                    if let input = request["input"] as? String,
                       let previewData = try? Data(contentsOf: URL(fileURLWithPath: input)) {
                        response["checks"] = GlobalAssistant.regressionModelOrbit(
                            data: previewData, outputDirectory: request["output"] as? String)
                    } else { response["error"] = "Model preview JSON is missing." }
                } else if request["command"] as? String == "column-scroll" {
                    if let input = request["input"] as? String,
                       let previewData = try? Data(contentsOf: URL(fileURLWithPath: input)) {
                        response["checks"] = GlobalAssistant.regressionColumnScroll(
                            data: previewData, outputDirectory: request["output"] as? String)
                    } else { response["error"] = "Column preview JSON is missing." }
                } else if request["command"] as? String == "notch-panel" {
                    response.merge(NotchPanelController.regression(outputPath: request["output"] as? String)) { _, new in new }
                } else if request["command"] as? String == "suggestion-navigation" {
                    response["checks"] = GlobalAssistant.regressionSuggestionNavigation(
                        outputPath: request["output"] as? String)
                } else if request["command"] as? String == "card-sizing" {
                    response["checks"] = GlobalAssistant.regressionCardSizing()
                } else if request["command"] as? String == "share-preview-fit" {
                    response["checks"] = ShareComposerView.runPreviewFitRegression(
                        screenshotPath: request["output"] as? String)
                } else if request["command"] as? String == "share-cad-undo" {
                    if let feature = (request["feature"] as? String).flatMap({ try? Data(contentsOf: URL(fileURLWithPath: $0)) }),
                       let overview = (request["overview"] as? String).flatMap({ try? Data(contentsOf: URL(fileURLWithPath: $0)) }) {
                        response["checks"] = ShareComposerView.runCADShareAndUndoRegression(
                            feature: feature, overview: overview, screenshotPath: request["output"] as? String)
                    } else { response["error"] = "Part and whole-model preview JSON are missing." }
                } else if request["command"] as? String == "share-pdf-preview" {
                    if let input = request["input"] as? String, let pdf = request["pdf"] as? String,
                       let data = try? Data(contentsOf: URL(fileURLWithPath: input)),
                       let pdfData = try? Data(contentsOf: URL(fileURLWithPath: pdf)) {
                        response["checks"] = ShareComposerView.runPDFPreviewRegression(
                            data: data, pdfData: pdfData, screenshotPath: request["output"] as? String)
                    } else { response["error"] = "PDF document JSON or original PDF path is missing." }
                } else if request["command"] as? String == "slide-deck" {
                    let pictures = (request["pictures"] as? [String] ?? []).compactMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) }
                    let output = request["output"] as? String
                    response["failures"] = AssistSlidePreviewView.runRegression(pictures: pictures, outputDirectory: output)
                        + ShareComposerView.runSlideDeckRegression(pictures: pictures,
                            screenshotPath: output.map { ($0 as NSString).appendingPathComponent("composer.png") })
                } else if request["command"] as? String == "share-pdf-live" {
                    response.merge(ShareComposerController.shared.regressionPDFComposer(request)) { _, new in new }
                } else if (request["command"] as? String)?.hasPrefix("inspector-") == true {
                    do { response.merge(try inspect(request)) { _, new in new } }
                    catch { response["error"] = error.localizedDescription }
                } else if request["command"] as? String == "native-click",
                          let x = request["x"] as? Double, let y = request["y"] as? Double {
                    let point = CGPoint(x: x, y: y)
                    let target = window(at: point, owner: Int(ProcessInfo.processInfo.processIdentifier))
                    // A hit on our own window asks this app's Accessibility
                    // server to respond. Keep its main thread free to do so.
                    var hitResult: AXError = .cannotComplete
                    var hitPID: pid_t = -1
                    var hitFinished = false
                    DispatchQueue.global(qos: .userInitiated).async {
                        var element: AXUIElement?
                        let status = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),
                                                                     Float(x), Float(y), &element)
                        var pid: pid_t = -1
                        if let element { AXUIElementGetPid(element, &pid) }
                        DispatchQueue.main.async {
                            hitResult = status; hitPID = pid; hitFinished = true
                        }
                    }
                    let hitDeadline = Date().addingTimeInterval(2)
                    while !hitFinished, Date() < hitDeadline {
                        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
                    }
                    response["targetWindow"] = target
                    response["hitPID"] = Int(hitPID)
                    response["hitError"] = Int(hitResult.rawValue)
                    if hitResult != .success || hitPID != ProcessInfo.processInfo.processIdentifier || target == nil {
                        response["error"] = "Native click target is outside this test helper's accessible windows."
                    } else if let expected = request["windowNumber"] as? Int,
                              target?["number"] as? Int != expected {
                        response["error"] = "Native click target is not the expected test window."
                    } else if !CGPreflightPostEventAccess() {
                        response["error"] = "The signed test helper is not permitted to post native events."
                    } else {
                        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
                        CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
                        response["clicked"] = true
                        response["allowed"] = CGPreflightPostEventAccess()
                    }
                } else if !AXIsProcessTrusted() {
                    response["error"] = "The signed Lasso app does not have Accessibility permission."
                } else if request["command"] as? String == "ping" {
                    response["ready"] = true
                } else if request["command"] as? String == "link-insert" {
                    do { response.merge(try insertLink(request)) { _, new in new } }
                    catch { response["error"] = error.localizedDescription }
                } else if request["command"] as? String == "link-verify" {
                    if let context = AccessibilityReader.focusedContext(),
                       let label = request["label"] as? String,
                       let rawURL = request["url"] as? String, let url = URL(string: rawURL) {
                        response["linked"] = AccessibilityReader.hyperlinkPresent(label, url: url, in: context)
                    } else { response["linked"] = false }
                } else if (request["command"] as? String)?.hasPrefix("popup-") == true {
                    do { response.merge(try popup(request)) { _, new in new } }
                    catch { response["error"] = error.localizedDescription }
                } else {
                    do { response.merge(try measure(request, adapter: adapter)) { _, new in new } }
                    catch { response["error"] = error.localizedDescription }
                }
                write(response, to: resultURL)
            }
            // NSApplication.run normally dispatches these events. This helper
            // owns its run loop, so it must also deliver real mouse clicks to
            // the nonactivating windows under test, not just timers and IPC.
            while let event = NSApp.nextEvent(matching: .any, until: .distantPast,
                                             inMode: .default, dequeue: true) {
                NSApp.sendEvent(event)
            }
            NSApp.updateWindows()
            RunLoop.current.run(until: Date().addingTimeInterval(0.025))
        }
        return true
    }

    private static func write(_ object: [String: Any], to url: URL) {
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private static func windowDescriptions() -> [[String: Any]] {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        return windows.compactMap { item in
            guard let bounds = item[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  let pid = item[kCGWindowOwnerPID as String] as? Int,
                  let number = item[kCGWindowNumber as String] as? Int,
                  let alpha = item[kCGWindowAlpha as String] as? Double, alpha > 0 else { return nil }
            return ["pid":pid, "number":number, "x":Double(rect.minX), "y":Double(rect.minY),
                    "width":Double(rect.width), "height":Double(rect.height), "alpha":alpha,
                    "layer":item[kCGWindowLayer as String] as? Int ?? 0]
        }
    }

    private static func window(at point: CGPoint, owner: Int) -> [String: Any]? {
        windowDescriptions().first { item in
            guard item["pid"] as? Int == owner,
                  let x = item["x"] as? Double, let y = item["y"] as? Double,
                  let width = item["width"] as? Double, let height = item["height"] as? Double else { return false }
            return CGRect(x: x, y: y, width: width, height: height).contains(point)
        }
    }

    private static func inspect(_ request: [String: Any]) throws -> [String: Any] {
        switch request["command"] as? String {
        case "inspector-show":
            guard let objectId = request["objectId"] as? String,
                  let rawURL = request["url"] as? String, let url = URL(string: rawURL) else {
                throw NSError(domain: "BrowserGeometryRegression", code: 4,
                              userInfo: [NSLocalizedDescriptionKey: "Inspector fixture source is missing."])
            }
            let reference = DependencyReference(id: request["referenceId"] as? String ?? "fixture-inspector", objectId: objectId,
                versionId: request["versionId"] as? String, projectId: request["projectId"] as? String,
                hostBundleIdentifier: "com.google.Chrome", hostApplication: "Chrome", documentContext: "fixture",
                anchor: TextAnchor(text: "supplies", prefixContext: "", suffixContext: "", approximateOffset: 0),
                state: .healthy, label: "Fixture source", valueText: nil,
                sourcePath: request["path"] as? String ?? "", sourceLocation: "", createdAt: Date(), updatedAt: Date())
            let near = AccessibilityReader.focusedContext()?.caretRect ?? NSRect(x: 120, y: 420, width: 80, height: 20)
            inspectorServerURL = url
            inspector.show(reference, near: near, serverURL: url)
        case "inspector-key":
            // A bare key as the keyboard tap routes it, with this inspector
            // open beside whichever app has focus. Fixture shares are never created.
            GlobalAssistant.shared.inspector = inspector
            inspector.onShare = { reference in
                guard let url = inspectorServerURL else { return }
                inspector.composeShare(reference, serverURL: url) { _, finished in
                    finished(.failure(NSError(domain: "BrowserGeometryRegression", code: 5,
                        userInfo: [NSLocalizedDescriptionKey: "Fixture shares are not created."])))
                }
            }
            GlobalAssistant.shared.regressionKey(request["keyCode"] as? Int ?? 48)
        case "inspector-hide": inspector.hide()
        case "inspector-focus": inspector.regressionFocus()
        case "inspector-resize":
            inspector.regressionResize(NSSize(width: request["width"] as? Double ?? 560,
                                             height: request["height"] as? Double ?? 540))
        case "inspector-snapshot":
            if let output = request["output"] as? String {
                return ["captured": inspector.regressionSnapshot(to: URL(fileURLWithPath: output))]
            }
        default: break
        }
        var result = inspector.regressionState()
        result["primaryTop"] = (NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first)?.frame.maxY ?? 0
        result["frontmostPID"] = Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
        result["pid"] = Int(ProcessInfo.processInfo.processIdentifier)
        result["windows"] = windowDescriptions().filter { $0["pid"] as? Int == Int(ProcessInfo.processInfo.processIdentifier) }
        result["screens"] = NSScreen.screens.map { ["x":$0.frame.minX,"y":$0.frame.minY,"width":$0.frame.width,"height":$0.frame.height] }
        return result
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
        case "popup-predict":
            guard let address = request["url"] as? String, let url = URL(string: address),
                  let ids = request["projectIds"] as? [String], let revision = request["revision"] as? String else {
                throw NSError(domain: "BrowserGeometryRegression", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Prediction fixture workspace is missing."])
            }
            assistant.regressionPredictPopup(serverURL: url, projectIds: ids, revision: revision)
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
        var verification = "Paste did not complete"
        var frontmostAtVerification = ""
        // Inserting runs on the Accessibility queue, as in the app. Its
        // results are handed back to this thread, which waits for them.
        func finish(_ inserted: Bool, _ detail: String, frontmost: String) {
            DispatchQueue.main.async { result = inserted; verification = detail; frontmostAtVerification = frontmost }
        }
        AccessibilityWork.queue.async {
            var detail = "Paste did not complete"
            RichTextInserter.insertLink(label: label, url: url, replacing: plan.range.count,
                at: request["keyboardFallback"] as? Bool == true ? -1 : captured.absoluteCaret,
                in: captured.element, keyboardDeleteCount: plan.expectedPrefix.count,
                validateSelection: { selected in
                    AccessibilityReader.canPaste(in: captured.element, before: before, caret: captured.absoluteCaret,
                                                 expectedPrefix: plan.expectedPrefix, selected: selected)
                }) { pasted in
                    guard pasted else { finish(false, detail, frontmost: ""); return }
                    bringForward(request["activateAfterPaste"] as? String) {
                        let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
                        RichTextInserter.verifyEventually(verify: {
                            // Production reads the captured editor, not the frontmost one.
                            guard let after = AccessibilityReader.context(of: captured.element) else {
                                let front = NSWorkspace.shared.frontmostApplication
                                detail = "Captured editor could not be read (frontmost: \(front?.localizedName ?? "none"), pid \(front?.processIdentifier ?? -1))"
                                return false
                            }
                            let transaction = CompletionTransaction.verify(before: before,
                                    after: CompletionSnapshot(documentStart: after.windowStart, text: Array(after.text.utf16)),
                                    plan: plan)
                            detail = String(describing: transaction)
                            guard case .success = transaction else { return false }
                            let linked = AccessibilityReader.hyperlinkPresent(label, url: url, in: after)
                            if !linked {
                                detail = "Link attributes unavailable: \(String(describing: WebTextReader.attributedTextBeforeCaret(expectedText: label, from: after.element)))"
                            }
                            return linked
                        }) { finish($0, detail, frontmost: frontmost) }
                    }
                }
        }
        let deadline = Date().addingTimeInterval(4)
        while result == nil, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.025)) }
        return ["inserted": result ?? false, "prefix": plan.expectedPrefix,
                "caretBefore": captured.absoluteCaret, "windowBefore": captured.windowStart,
                "verification": verification, "frontmostAtVerification": frontmostAtVerification]
    }

    /// Bring another app to the front between the paste and its read-back, as
    /// a user switching apps would, and continue once macOS reports it there.
    /// Runs on the Accessibility queue, like the insertion it interrupts.
    private static func bringForward(_ bundleIdentifier: String?, then next: @escaping () -> Void) {
        guard let bundleIdentifier,
              let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first else {
            next(); return
        }
        app.activate(options: [.activateIgnoringOtherApps])
        let deadline = Date().addingTimeInterval(1)
        func poll() {
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleIdentifier || Date() >= deadline {
                next(); return
            }
            AccessibilityWork.queue.asyncAfter(deadline: .now() + 0.025) { poll() }
        }
        poll()
    }

    private static func measure(_ request: [String: Any], adapter: AccessibilityTextAdapter) throws -> [String: Any] {
        // Match the production highlighter: each measurement starts a fresh
        // host snapshot instead of retaining text from the previous edit.
        adapter.beginRefresh()
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
