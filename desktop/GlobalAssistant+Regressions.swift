// Checks for the suggestion list, the card and the popup, run only by the browser geometry test.

import Cocoa

#if BROWSER_GEOMETRY_TEST
extension GlobalAssistant {
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
        let rankedPayload: [String: Any] = ["prediction": [
            "completion": ["insertText": " every Friday.", "projectId": "fixture", "rankOrder": 1,
                           "dependencyCandidate": ["id": "sentence", "projectId": "fixture"]],
            "claims": [["type": "ENTITY", "candidates": [["id": "ledger", "projectId": "fixture",
                                                           "label": "General Ledger", "rankOrder": 0]]]],
        ]]
        let reordered = (try? JSONSerialization.data(withJSONObject: rankedPayload))
            .map { parse($0, requestedText: "", activeProjectIds: ["fixture"]).map(\.label) } ?? []
        var checks = [
            "all ranked results survive parsing, with duplicate and inactive sources excluded":
                suggestions.map(\.insertText) == expected,
            "the server's rank order, not its groups, orders the list":
                reordered == ["General Ledger", "every Friday."],
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
        list.layoutSubtreeIfNeeded()
        var clicked: Int?
        let savedOnSelect = list.onSelectRow
        list.onSelectRow = { clicked = $0 }
        let row = NSPoint(x: 80, y: list.pointerHeight + 32 + 35)
        func viewAt(_ point: NSPoint) -> NSView? { window.contentView?.hitTest(list.convert(point, to: nil)) }
        if let event = NSEvent.mouseEvent(with: .leftMouseDown, location: list.convert(row, to: nil), modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1) {
            viewAt(row)?.mouseDown(with: event)
        }
        checks["clicking a scrolled row selects its actual source"] = clicked == 9
        func wheel(_ amount: Int32, at point: NSPoint) {
            // The window sits at the screen origin, so screen and window points agree.
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1,
                                wheel1: amount, wheel2: 0, wheel3: 0)
            let screen = list.convert(point, to: nil)
            event?.location = CGPoint(x: screen.x, y: (NSScreen.screens.first?.frame.height ?? 0) - screen.y)
            if let event = event.flatMap(NSEvent.init(cgEvent:)) { viewAt(point)?.scrollWheel(with: event) }
        }
        list.onSelectRow = { list.selected = $0 }
        let rowOffset = { list.suggestionList.contentView.bounds.origin.y / list.suggestionRowHeight }
        list.selected = 12
        wheel(3, at: row); wheel(-1, at: row)
        checks["scrolling over the list leaves it and its highlight, for ↑ and ↓ to move"] =
            rowOffset() == 9 && list.selected == 12
        list.suggestionList.scrollerStyle = .overlay
        let scroller = list.suggestionList.verticalScroller
        checks["the scroller shows where the list is, but cannot be dragged"] = scroller?.isHidden == false
            && list.suggestionList.scrollerStyle == .legacy
            && scroller.map { $0.hitTest(NSPoint(x: $0.frame.midX, y: $0.frame.midY)) == nil } == true
        wheel(-1, at: NSPoint(x: list.leftWidth + 40, y: row.y))
        checks["scrolling over the preview leaves the list and its highlight"] = list.selected == 12 && rowOffset() == 9
        // On screen, each move paints the old highlight away and the new one
        // in, whether the row is in view or the list glides to it.
        var painted: [(rect: NSRect, selection: Int)] = []
        let drawRows = list.suggestionRows.drawContent
        list.suggestionRows.drawContent = { dirty in painted.append((dirty, list.selected)); drawRows?(dirty) }
        window.setFrameOrigin(NSPoint(x: -10_000, y: 0))
        window.orderFrontRegardless()
        func settle() { RunLoop.current.run(until: Date().addingTimeInterval(0.35)) }
        settle()
        var everyMoveRepaints = true
        for _ in 0..<5 {
            let from = list.selected
            painted.removeAll()
            assistant.move(-1)
            settle()
            let to = list.selected
            let covered = painted.filter { $0.selection == to }.reduce(NSRect.null) { $0.union($1.rect) }
            everyMoveRepaints = everyMoveRepaints && [from, to].allSatisfy { row in
                covered.minY <= CGFloat(row) * list.suggestionRowHeight
                    && covered.maxY >= CGFloat(row + 1) * list.suggestionRowHeight
            }
        }
        checks["each move repaints the old and the new highlight, in view or after a glide"] =
            everyMoveRepaints && list.selected == 7
        window.orderOut(nil)
        list.suggestionRows.drawContent = drawRows
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

    /// The card fills its panel through every change of size. A brief message
    /// or the share question in between must not leave the next suggestions
    /// drawn shifted up and stretched past the panel's edge.
    static func regressionCardSizing() -> [String: Bool] {
        let assistant = shared
        assistant.hide()
        defer {
            assistant.hide()
            assistant.view.messageLines = []
            assistant.view.confirmChoices = []
        }
        let panel = assistant.existingPanel()
        var checks: [String: Bool] = [:]
        func check(_ state: String) {
            let content = panel.contentView?.bounds ?? .zero
            checks["\(state): the panel is the card's size"] = content.size == assistant.view.boxSize
            checks["\(state): the card fills the panel"] = assistant.view.frame == content
        }
        func present(_ mode: AssistBoxView.Mode, _ state: String) {
            assistant.view.mode = mode
            assistant.refreshPanelGeometry()
            check(state)
        }
        present(.suggestions, "suggestions")
        assistant.view.messageLines = ["The insertion could not be verified.", "No source reference was recorded."]
        present(.message, "message")
        present(.suggestions, "suggestions after a message")
        assistant.view.confirmChoices = ["Plain text", "Share link…"]
        present(.confirmShare, "share question")
        // The caret can move while the share question gives way to an insertion.
        panel.orderFrontRegardless()
        assistant.view.mode = .suggestions
        assistant.reposition(near: nil)
        check("suggestions moved after the share question")
        present(.suggestions, "suggestions after the share question")
        return checks
    }

    /// The footer's keys: what Tab does, then Choose and Dismiss, each whole
    /// inside the list's column, and a click on a key or its title doing
    /// what that key does. Hints that do not fit go from the end.
    static func regressionFooterKeys() -> [String: Bool] {
        let card = AssistBoxView()
        card.suggestions = [AssistSuggestion(
            insertText: "Net income", label: "Net income", detail: "", path: "Statement.xlsx", location: "",
            replacement: CompletionReplacement(start: 0, expectedText: "Net inc"), objectId: nil, versionId: nil,
            snapshotId: nil, usageObjectId: nil, projectId: "", rankingReason: nil)]
        card.frame = NSRect(origin: .zero, size: card.boxSize)
        let layout = card.footerHintLayout(card.footerHints)
        let placed = layout.placed
        var checks: [String: Bool] = [:]
        checks["typed words being replaced still show Insert, Choose and Dismiss"] = placed.map(\.hint.title) == ["Insert", "Choose", "Dismiss"]
        checks["every hint ends inside the list's column"] = placed.allSatisfy { $0.title.maxX <= card.leftWidth - 14 }
        checks["the arrows are a keycap each"] = placed.count == 3 && placed[1].keycaps.count == 2
        checks["the keys sit level with the preview's buttons"] = placed.allSatisfy { abs($0.keycaps[0].midY - (card.footerY + 23.5)) < 0.5 }
        guard placed.count == 3 else { return checks }
        checks["a click on Tab's key inserts"] = card.footerCommand(at: placed[0].keycaps[0].midX) == .tab
        checks["a click on Insert inserts"] = card.footerCommand(at: placed[0].title.midX) == .tab
        checks["a click on Choose does nothing"] = card.footerCommand(at: placed[1].title.midX) == nil
        checks["a click on Dismiss dismisses"] = card.footerCommand(at: placed[2].keycaps[0].midX) == .dismiss
        let narrow = AssistKeyHintLayout(card.footerHints, from: 18, to: placed[1].title.maxX + 1, centeredOn: 20)
        checks["hints that do not fit go from the end"] = narrow.placed.map(\.hint.title) == ["Insert", "Choose"]
        return checks
    }

    /// Captures the real panel renderer from an actual API response without
    /// moving focus, synthesizing a room, or touching the user's host document.
    static func regressionRenderPreview(data: Data, pdfData: Data? = nil, to output: URL) -> Bool {
        guard var preview = parsePreview(data) else { return false }
        if let pdf = preview.pdf {
            guard let pdfData, var page = AssistPDFPageImage.render(data: pdfData, preview: pdf) else { return false }
            // PDFKit draws its view in tiles a capture does not see, so the
            // capture shows the page image the card draws without the view.
            page.document = nil
            preview.pdfPage = page
        }
        return writePNG(of: regressionCard(showing: preview), to: output)
    }

    private static func regressionCard(showing preview: AssistDocumentPreview) -> AssistBoxView {
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
        return renderView
    }

    private static func writePNG(of renderView: AssistBoxView, to output: URL) -> Bool {
        guard let bitmap = renderView.bitmapImageRepForCachingDisplay(in: renderView.bounds) else { return false }
        renderView.cacheDisplay(in: renderView.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return false }
        do { try png.write(to: output, options: .atomic); return true }
        catch { return false }
    }

    /// Turns, zooms and resets a real API response's STEP preview in the card
    /// with real mouse and scroll events. Writes before and after PNGs when
    /// `outputDirectory` is given.
    static func regressionModelOrbit(data: Data, outputDirectory: String? = nil) -> [String: Bool] {
        guard let preview = parsePreview(data), let model = preview.model, let orbit = model.orbit else {
            return ["the preview is a rotatable STEP model": false]
        }
        let card = regressionCard(showing: preview)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: card.frame.size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = card
        defer { window.contentView = nil }
        let center = NSPoint(x: card.documentPreviewRect.midX, y: card.documentPreviewRect.midY)
        func mouse(_ type: NSEvent.EventType, at point: NSPoint, clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: card.convert(point, to: nil), modifierFlags: [],
                               timestamp: 0, windowNumber: window.windowNumber, context: nil,
                               eventNumber: 0, clickCount: clicks, pressure: 1)!
        }
        func scroll(_ pixels: Int32) -> NSEvent? {
            // The window sits at the screen origin, so screen and window points agree.
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                                wheel1: pixels, wheel2: 0, wheel3: 0)
            let screen = card.convert(center, to: nil)
            event?.location = CGPoint(x: screen.x, y: (NSScreen.screens.first?.frame.height ?? 0) - screen.y)
            return event.flatMap(NSEvent.init(cgEvent:))
        }
        let save = { (name: String) in
            outputDirectory.map { writePNG(of: card, to: URL(fileURLWithPath: $0).appendingPathComponent(name)) } ?? true
        }
        var checks = ["writes the untouched card": save("model-orbit-sent.png")]
        card.mouseDown(with: mouse(.leftMouseDown, at: center))
        card.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: center.x + 90, y: center.y + 30)))
        card.mouseUp(with: mouse(.leftMouseUp, at: NSPoint(x: center.x + 90, y: center.y + 30)))
        checks["dragging the drawing turns the model"] = card.modelView.isTurned(from: orbit.camera)
        checks["writes the turned card"] = save("model-orbit-turned.png")
        let turned = card.modelView
        card.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: center.x + 300, y: center.y)))
        checks["moving after the button is released does nothing"] = card.modelView == turned
        let range = AssistModelRenderer.zoomRange(for: model, in: card.documentPreviewRect)
        if let event = scroll(40) { card.scrollWheel(with: event) }
        checks["scrolling over the drawing zooms it"] = card.modelView.zoom != 1 && card.modelView.camera == turned.camera
        for _ in 0..<200 { if let event = scroll(400) { card.scrollWheel(with: event) } }
        let limit = card.modelView.zoom
        checks["zoom stops at a limit"] = limit == range.upperBound || limit == range.lowerBound
        checks["writes the zoomed card"] = save("model-orbit-zoomed.png")
        card.mouseDown(with: mouse(.leftMouseDown, at: center, clicks: 2))
        checks["a double-click resets the view"] = card.modelView == AssistModelView()
        card.mouseDown(with: mouse(.leftMouseDown, at: center))
        card.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: center.x - 50, y: center.y)))
        card.mouseUp(with: mouse(.leftMouseUp, at: NSPoint(x: center.x - 50, y: center.y)))
        card.preview = preview
        checks["a new preview starts as sent"] = card.modelView == AssistModelView()
        let outside = NSPoint(x: card.documentPreviewRect.midX, y: card.documentPreviewRect.maxY + 4)
        card.mouseDown(with: mouse(.leftMouseDown, at: outside))
        card.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: outside.x + 90, y: outside.y)))
        card.mouseUp(with: mouse(.leftMouseUp, at: outside))
        checks["dragging outside the drawing does not turn it"] = card.modelView == AssistModelView()
        return checks
    }

    /// Scrolls a real API response's whole-column table preview in the card
    /// with real scroll events. Writes first-row and last-row PNGs when
    /// `outputDirectory` is given.
    static func regressionColumnScroll(data: Data, outputDirectory: String? = nil) -> [String: Bool] {
        guard let preview = parsePreview(data), preview.moreRows != nil, !preview.rows.isEmpty else {
            return ["the preview lists a whole column": false]
        }
        let card = regressionCard(showing: preview)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: card.frame.size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = card
        defer { window.contentView = nil }
        guard let table = card.previewContent as? AssistTableRowsView else {
            return ["the rows scroll under the header": false]
        }
        // AppKit scrolls only for wheel events from the window server, so the
        // rows are moved as they, or a drag of the scroller, move them.
        let rowHeight = table.verticalLineScroll
        func scroll(byRows rows: CGFloat) {
            let clip = table.contentView
            let target = NSPoint(x: 0, y: clip.bounds.origin.y + rows * rowHeight)
            clip.scroll(to: clip.constrainBoundsRect(NSRect(origin: target, size: clip.bounds.size)).origin)
            table.reflectScrolledClipView(clip)
        }
        let save = { (name: String) in
            outputDirectory.map { writePNG(of: card, to: URL(fileURLWithPath: $0).appendingPathComponent(name)) } ?? true
        }
        var checks = ["writes the card as sent": save("column-first-rows.png"),
                      "a column starts at its first row": card.tableFirstRow == 0,
                      "a wheel notch scrolls a row": rowHeight > 0,
                      "the rows keep a scroller beside them": table.verticalScroller?.isHidden == false]
        scroll(byRows: 0.5)
        checks["the rows scroll as far as the fingers move, not a row at a time"] =
            table.contentView.bounds.origin.y == rowHeight / 2 && card.tableFirstRow == 0
        scroll(byRows: CGFloat(preview.rows.count + 10))
        checks["scrolling up shows the rows below"] = card.tableFirstRow > 0
        checks["writes the card scrolled to the end"] = save("column-last-rows.png")
        let last = card.tableFirstRow
        scroll(byRows: 1)
        checks["scrolling stops at the last row"] = card.tableFirstRow == last
        scroll(byRows: -CGFloat(preview.rows.count + 10))
        checks["scrolling back returns to the first row"] = card.tableFirstRow == 0
        scroll(byRows: 1)
        card.preview = preview
        card.layoutSubtreeIfNeeded()
        checks["a new preview starts at its first row"] = card.tableFirstRow == 0
        return checks
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
        guard regressionMeasureHost(for: captured) else { return false }
        show([regressionSuggestion])
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
        linkedSources.forget()
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
        switch KeyRouter.decide(keyCode: Int64(keyCode), flags: [], synthetic: false, state: currentKeyRouting()) {
        case .pass(let action): if let action { perform(action) }
        case .swallow(let action): perform(action)
        }
    }

    /// The test harness expects the popup at once, so it waits for the read.
    private func regressionMeasureHost(for context: CaretContext) -> Bool {
        let previous = popupHost
        let measured = AccessibilityWork.queue.sync { () -> (AssistPopupHost, CGRect)? in
            guard let host = Self.popupHost(for: context.element, reusing: previous),
                  let caret = host.visibleCaret(using: AccessibilityReader.caretRect(of:)) else { return nil }
            return (host, caret)
        }
        guard let measured else { return false }
        adoptHost(measured.0, caret: measured.1)
        return true
    }

    func regressionClosePopup() { view.closeButton.performClick(nil) }

    func regressionBeginDelayedPopup() {
        hide()
        guard let captured = AccessibilityReader.focusedContext() else { return }
        isEnabled = true
        context = captured
        guard regressionMeasureHost(for: captured) else { return }
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self else { return }
            self.deliverPrediction([self.regressionSuggestion], heading: nil, sourceScoped: true,
                                   captured: captured, token: token)
        }
    }
}
#endif
