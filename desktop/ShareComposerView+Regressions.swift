// Checks for the composer's preview, redactions and mark-up, run only by the browser geometry test.

import Cocoa
import PDFKit

#if BROWSER_GEOMETRY_TEST
extension ShareComposerView {
    func regressionPDFState(_ request: [String: Any]) -> [String: Any] {
        if let rawScope = request["scope"] as? String, let selected = ShareAccessScope(rawValue: rawScope) { scope = selected }
        if request["action"] as? String == "select", let text = request["text"] as? String,
           let selection = loadedPDFDocument?.findString(text, withOptions: [.caseInsensitive]).first {
            selectPDFText(selection)
        }
        needsDisplay = true
        displayIfNeeded()
        if let path = request["output"] as? String, let bitmap = bitmapImageRepForCachingDisplay(in: bounds) {
            cacheDisplay(in: bounds, to: bitmap)
            try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
        var state: [String: Any] = ["loaded": loadedPDFDocument != nil, "scope": scope.rawValue,
            "canSubmit": canSubmit, "redactions": masks.values.map(\.payload)]
        state["error"] = notice
        return state
    }

    static func runPDFPreviewRegression(data: Data, pdfData: Data, screenshotPath: String? = nil) -> [String] {
        guard let document = ShareFullDocument.parse(data), document.kind == "pdf",
              let descriptor = document.pdf,
              let pdf = PDFDocument(data: pdfData), !pdf.isLocked, pdf.pageCount > 0 else {
            preconditionFailure("The PDF composer must receive a valid document descriptor and original PDF")
        }
        let view = ShareComposerView(frame: NSRect(x: 0, y: 0, width: 760, height: 660))
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        var checks: [String] = []
        func require(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message)
            checks.append(message)
        }
        func paint() {
            view.needsDisplay = true
            view.displayIfNeeded()
            view.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
        }
        view.reset(label: "Cedar Lane Concept Plan", filename: "Cedar-Lane-Concept-Plan.pdf")
        view.fullDocument = document
        view.isDocumentLoading = false
        view.isLoading = false
        view.scope = .redacted
        paint()
        let textRevision = view.previewRevision
        view.loadedPDFDocument = pdf
        require(view.previewRevision == textRevision,
                "PDF loading does not reset an active text redaction layout")
        view.scope = .document
        paint()
        require(view.showsPDFPreview && !view.pdfView.isHidden && view.previewScroll.isHidden,
                "Entire document displays original PDF pages instead of extracted text")
        require(view.pdfView.document === pdf && view.pdfView.document?.pageCount == pdf.pageCount,
                "Every original PDF page is retained in the composer")
        require(view.pdfView.currentPage === pdf.page(at: min(descriptor.pageNumber - 1, pdf.pageCount - 1)),
                "The cited page is visible when the complete PDF opens")
        require(view.pdfView.frame.width > 0 && view.pdfView.frame.height > 0 && view.bounds.contains(view.pdfView.frame),
                "The PDF page viewer fits within the composer")
        require(view.pdfView.scaleFactor.isFinite && view.pdfView.scaleFactor > 0,
                "PDFKit computes a visible page scale")
        func capture(_ suffix: String) {
            guard let screenshotPath, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let stem = (screenshotPath as NSString).deletingPathExtension
            try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(stem)\(suffix).png"))
        }
        capture("-document")
        let originalPage = view.pdfView.currentPage
        view.scope = .redacted
        paint()
        require(view.showsPDFPreview && !view.pdfView.isHidden && view.previewScroll.isHidden,
                "Select and redact displays the original PDF page layout")
        guard let page = view.pdfView.currentPage,
              let text = page.selection(for: page.bounds(for: .cropBox)),
              let firstLine = text.selectionsByLine().first(where: { $0.bounds(for: page).width > 3 }) else {
            preconditionFailure("The PDF fixture must contain selectable page text")
        }
        view.selectPDFText(firstLine)
        paint()
        require(!view.masks.isEmpty && view.masks.values.allSatisfy { $0.kind == "PDF" && $0.page == document.pdf?.pageNumber },
                "Selected PDF words create precise page masks instead of whole text blocks")
        require(page.annotations.contains(where: { $0 is SharePDFMaskAnnotation }),
                "PDF redaction masks are visible on the original page")
        let selectedMask = view.masks.values.first!
        let maskRect = page.annotations.compactMap { $0 as? SharePDFMaskAnnotation }.first!.bounds
        require(view.removePDFMask(page: page, point: NSPoint(x: maskRect.midX, y: maskRect.midY)) && view.masks.isEmpty,
                "Clicking a PDF mask removes exactly that selected area")
        view.masks[selectedMask.locationKey] = selectedMask
        view.pdfSelectionMode = .area
        paint()
        // Both mask effects are neutral grey and a blurred mask is mostly
        // white, so the drag covers the cover photo: none of its colour may
        // show through. Unreadable pixels count as coloured.
        let crop = page.bounds(for: .cropBox)
        let a = NSPoint(x: crop.minX + crop.width * 0.55, y: crop.maxY - crop.height * 0.12)
        let b = NSPoint(x: crop.minX + crop.width * 0.85, y: crop.maxY - crop.height * 0.3)
        func colouredPixels() -> Int {
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return .max }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let corners = [a, b].map { view.convert(view.pdfView.convert($0, from: page), from: view.pdfView) }
            let area = NSRect(x: min(corners[0].x, corners[1].x), y: min(corners[0].y, corners[1].y),
                              width: abs(corners[1].x - corners[0].x), height: abs(corners[1].y - corners[0].y))
                .insetBy(dx: 4, dy: 4)
            var coloured = 0
            for column in 0...10 {
                for row in 0...6 {
                    let x = area.minX + area.width * CGFloat(column) / 10
                    let y = area.minY + area.height * CGFloat(row) / 6
                    guard let color = bitmap.colorAt(x: Int(x * CGFloat(bitmap.pixelsWide) / view.bounds.width),
                                                     y: Int(y * CGFloat(bitmap.pixelsHigh) / view.bounds.height))?
                            .usingColorSpace(.deviceRGB) else { coloured += 1; continue }
                    let channels = [color.redComponent, color.greenComponent, color.blueComponent]
                    if channels.max()! - channels.min()! > 0.08 { coloured += 1 }
                }
            }
            return coloured
        }
        let photoPixels = colouredPixels()
        func mouse(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: view.pdfView.convert(view.pdfView.convert(point, from: page), to: nil),
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
                eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        view.pdfView.mouseDown(with: mouse(.leftMouseDown, at: a))
        view.pdfView.mouseDragged(with: mouse(.leftMouseDragged, at: b))
        view.pdfView.mouseUp(with: mouse(.leftMouseUp, at: b))
        paint()
        require(view.masks.count == 2, "A native mouse drag can redact an arbitrary PDF area")
        require(photoPixels >= 20 && photoPixels != .max && colouredPixels() == 0,
                "The native PDF preview paints opaque mask pixels over the selected area")
        capture("")
        var configuration: ShareConfiguration?
        view.onCreate = { configuration = $0 }
        view.submit()
        require(configuration?.redactions.count == 2 && configuration?.redactions.allSatisfy { $0.payload["page"] as? Int != nil } == true,
                "Share creation preserves the reviewed PDF page and region coordinates")
        view.pdfView.mouseDown(with: mouse(.leftMouseDown, at: a))
        view.pdfView.mouseDragged(with: mouse(.leftMouseDragged, at: b))
        view.scope = .document
        paint()
        view.pdfView.mouseUp(with: mouse(.leftMouseUp, at: b))
        require(page.annotations.allSatisfy { !($0 is SharePDFMaskAnnotation) } && view.masks.count == 2,
                "Switching scope cancels an unfinished drag and removes local redaction overlays")
        require(view.pdfView.document === pdf && view.pdfView.currentPage === originalPage,
                "Changing sharing scope preserves the original PDF and current page")
        view.reset(label: "Another source", filename: "notes.txt")
        require(view.pdfView.document == nil && view.pdfView.isHidden,
                "Opening another source clears the previous PDF pages")
        view.reset(label: "Loading PDF", filename: "document.pdf")
        require(view.scope == .document && view.scopes == [.document, .redacted, .marked],
                "A PDF opens on the whole document and offers no cited part")
        return checks
    }

    static func runPreviewFitRegression(screenshotPath: String? = nil) -> [String] {
        let view = ShareComposerView(frame: NSRect(x: 0, y: 0, width: 760, height: 660))
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        var checks: [String] = []
        func require(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message)
            checks.append(message)
        }
        func paint() {
            view.layoutSubtreeIfNeeded()
            if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
            }
            if let bitmap = view.previewCanvas.bitmapImageRepForCachingDisplay(in: view.previewCanvas.visibleRect) {
                view.previewCanvas.cacheDisplay(in: view.previewCanvas.visibleRect, to: bitmap)
            }
        }
        func scrollToEnd() {
            let size = view.previewScroll.contentSize
            view.previewScroll.contentView.scroll(to: NSPoint(
                x: max(0, view.previewCanvas.frame.width - size.width),
                y: max(0, view.previewCanvas.frame.height - size.height)))
            view.previewScroll.reflectScrolledClipView(view.previewScroll.contentView)
            if let bitmap = view.previewCanvas.bitmapImageRepForCachingDisplay(in: view.previewCanvas.visibleRect) {
                view.previewCanvas.cacheDisplay(in: view.previewCanvas.visibleRect, to: bitmap)
            }
        }
        func capture(_ suffix: String) {
            guard let screenshotPath, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let stem = (screenshotPath as NSString).deletingPathExtension
            try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(stem)\(suffix).png"))
        }
        let longText = (0..<160).map { "Complete paragraph word \($0)." }.joined(separator: " ") + " LAST SENTENCE IS VISIBLE."
        let rows = (0..<40).map { row in (0..<7).map { column in
            row == 20 && column == 0 ? longText : "Row \(row + 1), column \(column + 1)"
        } }
        view.reset(label: "Clinic appointment capacity", filename: "Healthcare.xlsx")
        view.fullDocument = ShareFullDocument(kind: "table", sheets: [
            ShareFullSheet(name: "Capacity", rows: rows),
            ShareFullSheet(name: "Follow-up", rows: [["Second sheet first cell", "Second sheet final cell"]]),
        ], blocks: [])
        view.isLoading = false
        view.isDocumentLoading = false
        view.scope = .redacted
        paint()
        require(view.scrollRows.count == 40 && view.scrollColumns.count == 7,
                "Complete table retains every row and all seven columns")
        require(view.previewScroll.hasHorizontalScroller && view.previewScroll.hasVerticalScroller && !view.previewScroll.autohidesScrollers,
                "Native scrollbars expose overflowing content")
        require(view.previewScroll.verticalScroller?.isEnabled == true && view.previewScroll.horizontalScroller?.isEnabled == true,
                "Overflow scrollbars are enabled for direct mouse navigation")
        require(view.scrollRowHeights[21] >= view.textHeight(longText, width: view.scrollColumnWidths[0] - 16) + 16,
                "Long cells grow to show the full text instead of truncating")
        capture("-table-start")
        scrollToEnd()
        guard let last = view.targets.first(where: { $0.row == 39 && $0.column == 6 }) else {
            preconditionFailure("Last row and last column must be reachable")
        }
        require(last.rect.intersects(view.previewCanvas.visibleRect), "Last row and last column are reachable by scrolling")
        capture("-table-end")
        let point = NSPoint(x: last.rect.midX, y: last.rect.midY)
        view.previewMouseDown(at: point)
        view.previewMouseUp(at: point)
        require(view.masks["cell:0:39:6"]?.row == 39 && view.masks["cell:0:39:6"]?.column == 6,
                "Redaction after scrolling preserves the original sheet, row and column")
        var sent: ShareConfiguration?
        view.onCreate = { sent = $0 }
        view.submit()
        require(sent?.redactions.contains(where: { $0.sheet == 0 && $0.row == 39 && $0.column == 6 }) == true,
                "Share submission carries the exact reviewed cell coordinates")
        view.sheetIndex = 1
        view.scrollLayoutKey = ""
        paint()
        require(view.scrollRows.first?.last == "Second sheet final cell", "Every worksheet is reviewable")
        require(view.masks["cell:0:39:6"] != nil, "Changing worksheets preserves existing redactions")
        view.preview = AssistDocumentPreview(filename: "Healthcare.xlsx", path: "/Healthcare.xlsx",
            location: "Capacity", context: "Clinic capacity", valueText: nil, objectType: "DATASET_ROW", snapshotVersion: 1,
            columns: (0..<7).map(view.spreadsheetColumn), headers: (0..<7).map { "Heading \($0 + 1)" },
            rows: rows.map { AssistPreviewRow(rowNumber: nil, cells: $0.map { AssistPreviewCell(value: $0, cited: false) }) })
        view.scope = .indexed
        paint()
        require(view.scrollRows.count == 40 && view.scrollColumns.count == 7,
                "Indexed preview contains the same rows and columns as the recipient context")
        scrollToEnd()
        require(view.previewCanvas.visibleRect.maxY >= view.previewCanvas.frame.height - 1,
                "Indexed context can scroll to its final row")
        view.fullDocument = ShareFullDocument(kind: "text", sheets: [], blocks: [longText, "FINAL DOCUMENT SECTION."])
        view.scope = .redacted
        paint()
        require(view.scrollBlocks.first?.hasSuffix("LAST SENTENCE IS VISIBLE.") == true,
                "Text preview retains every word of each recipient paragraph")
        require(view.scrollBlockHeights[0] >= view.textHeight(longText, width: view.previewScroll.contentSize.width - 28) + 24,
                "Long document sections use their complete wrapped height")
        scrollToEnd()
        require(view.targets.contains(where: { $0.block == 1 }), "Final document section is reachable and redactable")
        capture("")
        return checks
    }

    /// A STEP citation offers the whole model or its cited part, never
    /// redaction, and ⌘Z and ⇧⌘Z step through masks one drag at a time.
    /// `feature` and `overview` are preview responses for a part feature and
    /// for a whole model.
    static func runCADShareAndUndoRegression(feature: Data, overview: Data, screenshotPath: String? = nil) -> [String] {
        let view = ShareComposerView(frame: NSRect(x: 0, y: 0, width: 760, height: 660))
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        var checks: [String] = []
        func require(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message)
            checks.append(message)
        }
        func capture(_ suffix: String) {
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            guard let screenshotPath else { return }
            let stem = (screenshotPath as NSString).deletingPathExtension
            try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(stem)\(suffix).png"))
        }
        func load(_ data: Data) {
            view.reset(label: "Bracket", filename: "Bracket.step")
            require(view.scopes == [.document, .indexed] && view.scope == .indexed,
                    "While a model's preview loads, the cited part stays the chosen scope")
            view.preview = GlobalAssistant.parsePreview(data)
            view.citedPart = ShareComposerController.citedPart(data)
            view.isLoading = false
            view.keepOfferedScope()
        }

        load(feature)
        require(view.citedPart != nil && view.scopes == [.document, .indexed] && view.scope == .indexed,
                "A cited hole offers its part, with the whole model, and nothing to redact")
        capture("-cad-part")
        func mouse(_ type: NSEvent.EventType, at point: NSPoint, clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: view.convert(point, to: nil), modifierFlags: [], timestamp: 0,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
        }
        guard let sent = view.citedPart?.orbit?.camera, let area = view.shownModel?.rect else {
            preconditionFailure("The cited part must be drawn as a model that can turn")
        }
        let middle = NSPoint(x: area.midX, y: area.midY)
        view.mouseDown(with: mouse(.leftMouseDown, at: middle))
        view.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: middle.x + 120, y: middle.y + 60)))
        view.mouseUp(with: mouse(.leftMouseUp, at: NSPoint(x: middle.x + 120, y: middle.y + 60)))
        require(view.modelView.isTurned(from: sent), "Dragging the cited part turns it, as in the card and the inspector")
        let turned = view.modelView
        view.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: middle.x - 80, y: middle.y)))
        require(view.modelView == turned, "Moving after the button is released does nothing")
        require(view.zoomModel(by: 1.5, at: middle) && view.modelView.zoom > 1 && view.modelView.camera == turned.camera,
                "Scrolling or pinching over the part zooms it")
        capture("-cad-part-turned")
        view.mouseDown(with: mouse(.leftMouseDown, at: middle, clicks: 2))
        require(view.modelView == AssistModelView(), "A double-click puts the part back as it was sent")
        view.mouseDown(with: mouse(.leftMouseDown, at: middle))
        view.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: middle.x + 40, y: middle.y)))
        view.mouseUp(with: mouse(.leftMouseUp, at: NSPoint(x: middle.x + 40, y: middle.y)))
        view.scope = .document
        require(view.modelView == AssistModelView(), "Changing scope shows the other model as it was sent")
        view.scope = .indexed
        view.moveScope(1)
        require(view.scope == .document, "Arrows move between the two scopes a part offers")
        view.moveScope(1)
        require(view.scope == .indexed, "and wrap around without reaching Select & redact")

        load(overview)
        require(view.citedPart == nil && view.scopes == [.document] && view.scope == .document,
                "A whole-model citation is shared as the model, with no cited part or redaction")
        if let root = try? JSONSerialization.jsonObject(with: overview) as? [String: Any], let model = root["preview"],
           let document = try? JSONSerialization.data(withJSONObject: ["document": model]) {
            view.fullDocument = ShareFullDocument.parse(document)
            view.isDocumentLoading = false
        }
        capture("-cad-overview")
        guard let whole = view.shownModel?.rect, let wholeCamera = view.fullDocument?.model?.orbit?.camera else {
            preconditionFailure("The whole model must be drawn as a model that can turn")
        }
        view.mouseDown(with: mouse(.leftMouseDown, at: NSPoint(x: whole.midX, y: whole.midY)))
        view.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: whole.midX - 100, y: whole.midY - 30)))
        view.mouseUp(with: mouse(.leftMouseUp, at: NSPoint(x: whole.midX - 100, y: whole.midY - 30)))
        require(view.modelView.isTurned(from: wholeCamera), "The entire model turns too")
        capture("-cad-overview-turned")

        view.reset(label: "Office supplies", filename: "Income-Statement.xlsx")
        require(view.scopes == [.document, .indexed, .redacted], "Other documents keep all three scopes")
        view.fullDocument = ShareFullDocument(kind: "table", sheets: [
            ShareFullSheet(name: "Accounting", rows: (0..<8).map { row in (0..<4).map { "R\(row)C\($0)" } }),
            ShareFullSheet(name: "Forecast", rows: [["Account", "Q4"], ["Office Supplies", "420"]]),
        ], blocks: [])
        view.isLoading = false
        view.isDocumentLoading = false
        view.scope = .redacted
        capture("")
        func target(_ row: Int, _ column: Int) -> NSPoint? {
            view.targets.first(where: { $0.row == row && $0.column == column }).map { NSPoint(x: $0.rect.midX, y: $0.rect.midY) }
        }
        guard let first = target(1, 0), let corner = target(3, 2), let single = target(6, 1) else {
            preconditionFailure("Table cells must be redactable")
        }
        view.previewMouseDown(at: first)
        view.previewMouseDragged(at: corner)
        view.previewMouseUp(at: corner)
        require(view.masks.count == 9, "A drag masks the whole rectangle")
        view.previewMouseDown(at: single)
        view.previewMouseUp(at: single)
        require(view.masks.count == 10, "A click masks one more cell")
        capture("-masked")
        view.undoEdit()
        require(view.masks.count == 9 && view.masks["cell:0:6:1"] == nil, "Command+Z unmasks the last click alone")
        view.undoEdit()
        require(view.masks.isEmpty, "Command+Z then unmasks the whole drag at once")
        view.undoEdit()
        require(view.masks.isEmpty, "With nothing left, Command+Z changes nothing")
        capture("-undone")
        view.redoEdit()
        view.redoEdit()
        require(view.masks.count == 10, "Shift+Command+Z puts both edits back")

        view.sheetIndex = 1
        view.scrollLayoutKey = ""
        capture("")
        guard let forecast = target(1, 1) else { preconditionFailure("The second worksheet must be redactable") }
        view.previewMouseDown(at: forecast)
        view.previewMouseUp(at: forecast)
        view.sheetIndex = 0
        view.scrollLayoutKey = ""
        capture("")
        view.undoEdit()
        require(view.masks["cell:1:1:1"] == nil && view.sheetIndex == 1,
                "Undoing a mask on another worksheet brings that worksheet into view")
        view.scope = .document
        view.undoEdit()
        require(view.masks.count == 10, "Masks are only stepped through where they are shown")
        return checks
    }

    /// A deck cited on slide 3 of five, its pictures already fetched on the
    /// card: each scope shows slide pictures under a slide menu, the cited
    /// slide alone for its share, every slide for the deck and its mark-up,
    /// and marking up draws on the slide pictures without asking for pages.
    static func runSlideDeckRegression(pictures: [Data], screenshotPath: String? = nil) -> [String] {
        var failures: [String] = []
        func require(_ condition: Bool, _ message: String) { if !condition { failures.append(message) } }
        guard pictures.count >= 5 else { return ["Five slide pictures are needed."] }
        let view = ShareComposerView(frame: NSRect(x: 0, y: 0, width: 760, height: 660))
        let window = NSWindow(contentRect: NSRect(x: -10_000, y: 0, width: 760, height: 660), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.contentView = view
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        func paint() {
            view.layoutSubtreeIfNeeded()
            if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) { view.cacheDisplay(in: view.bounds, to: bitmap) }
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
        }
        func capture(_ suffix: String) {
            guard let screenshotPath, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let stem = (screenshotPath as NSString).deletingPathExtension
            try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(stem)\(suffix).png"))
        }
        let shown = { view.slideNavigator?.slideInView ?? 0 }
        let preview: [String: Any] = [
            "source": ["filename": "Quarterly-Review.pptx", "objectType": "DOCUMENT", "location": "Slide 3 \u{00B7} Title 3"],
            "path": "Quarterly-Review.pptx",
            "preview": ["kind": "text", "format": "markdown", "slideNumber": 3, "slideCount": 5, "location": "Slide 3 \u{00B7} Title 3",
                        "deck": ["slides": (1...5).map { ["number": $0, "title": "Title \($0)"] }, "aspect": 1.7778],
                        "blocks": [["type": "paragraph", "text": "Item three is on track.", "cited": true]]],
        ]
        let source = SlidePictureSource(serverURL: URL(string: "http://127.0.0.1:9")!,
                                        objectId: "composer-regression-\(UUID().uuidString)", versionId: nil)
        for (index, picture) in pictures.prefix(5).enumerated() { SlidePictureCache.keep(picture, index + 1, of: source) }
        view.reset(label: "Item three is on track.", filename: "Quarterly-Review.pptx")
        view.preview = (try? JSONSerialization.data(withJSONObject: preview)).flatMap { AssistDocumentPreview.parse($0) }
        view.isLoading = false
        view.isDocumentLoading = false
        view.keepOfferedScope()
        var asked = 0
        view.onNeedsMarkupPages = { asked += 1 }
        view.showSlides(from: source)
        require(view.scopes == [.document, .indexed, .marked], "A cited slide offers the deck, the slide, or a marked-up copy")

        view.scope = .indexed
        paint()
        capture("-cited")
        require(!view.pdfView.isHidden && view.pdfView.document === view.slideDecks?.cited?.document
                && view.pdfView.document?.pageCount == 1, "Cited slide only shows that slide's picture alone")
        require(view.slideDecks?.cited?.drawn == [3], "Its picture, fetched on the card, shows at once")
        require(view.slideNavigator?.bar.isHidden == false && view.slideNavigator?.bar.listedSlides == [3]
                && view.slideNavigator?.bar.shownLabel == "Slide 3 of 5 \u{00B7} Title 3",
                "The slide menu names the cited slide and offers no other")

        view.scope = .document
        paint()
        capture("-deck")
        require(view.pdfView.document === view.slideDecks?.all.document && view.pdfView.document?.pageCount == 5,
                "Entire presentation shows every slide's picture")
        require(shown() == 3, "It opens on the cited slide (shows \(shown()))")
        require(view.slideNavigator?.bar.listedSlides == [1, 2, 3, 4, 5], "Its slide menu lists every slide")
        view.slideNavigator?.bar.chooseFromList(5)
        paint()
        require(shown() == 5, "Choosing a slide from the menu turns to it (shows \(shown()))")

        view.scope = .marked
        paint()
        capture("-markup")
        require(asked == 0, "Marking up a deck draws on its slide pictures without laying the deck out as pages")
        require(view.pdfView.document === view.slideDecks?.all.document && view.pdfView.selectionMode == .draw
                && view.slideNavigator?.bar.isHidden == false, "The slides are shown to draw on, under their slide menu")
        let middle = NSPoint(x: view.pdfView.bounds.midX, y: view.pdfView.bounds.midY)
        func mouse(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: view.pdfView.convert(point, to: nil), modifierFlags: [], timestamp: 0,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        view.pdfView.mouseDown(with: mouse(.leftMouseDown, at: middle))
        for step in 1...6 { view.pdfView.mouseDragged(with: mouse(.leftMouseDragged, at: NSPoint(x: middle.x + CGFloat(step * 12), y: middle.y))) }
        view.pdfView.mouseUp(with: mouse(.leftMouseUp, at: NSPoint(x: middle.x + 72, y: middle.y)))
        paint()
        require(view.markup.marks.count == 1 && view.markup.marks[0].page == shown() && view.canSubmit,
                "A stroke lands on the slide in view, numbered as the marked copy's pages are (\(view.markup.marks.map(\.page)))")
        require(view.slideDecks?.all.holdsPages == false, "Pictures stop waiting once the stroke ends")

        view.scope = .indexed
        paint()
        require(view.slideNavigator?.deck === view.slideDecks?.cited && view.pdfView.document?.pageCount == 1,
                "Going back to Cited slide only shows the cited slide again")
        return failures
    }
}
#endif
