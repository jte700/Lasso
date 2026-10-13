//  Privacy-aware source sharing.
//
//  The composer is deliberately native and non-activating so the document the
//  user is writing in keeps focus. It makes the public boundary visible before
//  a token is minted: whole document, indexed context, or a preview with safe
//  redactions selected directly with the mouse.

import Cocoa

struct ShareFullSheet {
    let name: String
    let rows: [[String]]
}

struct ShareFullDocument {
    let kind: String
    let sheets: [ShareFullSheet]
    let blocks: [String]

    static func parse(_ data: Data) -> ShareFullDocument? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let document = root["document"] as? [String: Any],
              let kind = document["kind"] as? String else { return nil }
        let sheets = (document["sheets"] as? [[String: Any]] ?? []).map { sheet in
            ShareFullSheet(
                name: sheet["name"] as? String ?? "Sheet",
                rows: (sheet["rows"] as? [[Any]] ?? []).map { row in
                    row.map { String(describing: $0) }
                })
        }
        return ShareFullDocument(
            kind: kind, sheets: sheets,
            blocks: document["blocks"] as? [String] ?? [])
    }
}

final class ShareComposerController: NSObject {
    static let shared = ShareComposerController()

    private let canvasSize = NSSize(width: 660, height: 438)
    private lazy var view = ShareComposerView(frame: NSRect(origin: .zero, size: canvasSize))
    private var panel: NSPanel?
    private var requests: [URLSessionDataTask] = []
    private var generation = 0
    private var completion: ((ShareConfiguration) -> Void)?
    private var cancellation: (() -> Void)?
    var isVisible: Bool { panel?.isVisible == true }

    func cancel() {
        hide()
        let callback = cancellation
        cancellation = nil; completion = nil
        callback?()
    }

    override private init() {
        super.init()
        view.onCancel = { [weak self] in self?.cancel() }
        view.onCreate = { [weak self] configuration in
            guard let self else { return }
            self.hide()
            self.completion?(configuration)
            self.completion = nil
        }
    }

    func show(objectId: String, versionId: String?, label: String, sourcePath: String,
              near anchor: NSRect, serverURL: URL, actionTitle: String = "Copy link",
              onCancel: (() -> Void)? = nil,
              completion: @escaping (ShareConfiguration) -> Void) {
        self.completion = completion
        cancellation = onCancel
        generation += 1
        let token = generation
        requests.forEach { $0.cancel() }
        requests.removeAll()
        view.reset(label: label, filename: (sourcePath as NSString).lastPathComponent)
        view.actionTitle = actionTitle
        let statusRequest = URLSession.shared.dataTask(with: serverURL.appendingPathComponent("api/sharing/status")) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self, token == self.generation, let data,
                      let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                self.view.localOnly = status["localOnly"] as? Bool ?? true
                self.view.needsDisplay = true
            }
        }
        requests.append(statusRequest)
        statusRequest.resume()
        let panel = existingPanel()
        panel.setFrame(NSRect(origin: placement(near: anchor), size: canvasSize), display: true)
        panel.orderFrontRegardless()

        for endpoint in ["preview", "document"] {
            var components = URLComponents(
                url: serverURL.appendingPathComponent("api/dependency-objects")
                    .appendingPathComponent(objectId).appendingPathComponent(endpoint),
                resolvingAgainstBaseURL: false)
            if let versionId { components?.queryItems = [URLQueryItem(name: "version", value: versionId)] }
            guard let url = components?.url else { continue }
            var urlRequest = URLRequest(url: url)
            urlRequest.timeoutInterval = 6
            let task = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, _, _ in
                DispatchQueue.main.async {
                    guard let self, token == self.generation else { return }
                    if endpoint == "preview" {
                        self.view.preview = data.flatMap(GlobalAssistant.parsePreview)
                        self.view.isLoading = false
                    } else {
                        self.view.fullDocument = data.flatMap(ShareFullDocument.parse)
                        self.view.isDocumentLoading = false
                    }
                    self.view.needsDisplay = true
                }
            }
            requests.append(task)
            task.resume()
        }
    }

    func showFixture() {
        view.reset(label: "Office supplies", filename: "Income-Statement.xlsx")
        view.scope = ProcessInfo.processInfo.environment["LASSO_SHARE_FIXTURE_SCOPE"] == "document"
            ? .document : .redacted
        view.preview = AssistDocumentPreview(
            filename: "Income-Statement.xlsx", path: "/Accounting/Income-Statement.xlsx",
            location: "Accounting!B21", context: "Quarterly operating expense detail",
            valueText: "400", objectType: "DATASET_CELL", snapshotVersion: 3,
            columns: ["A", "B"], headers: ["Account", "Amount"],
            rows: [
                AssistPreviewRow(rowNumber: 18, cells: [
                    AssistPreviewCell(value: "Payroll Taxes", cited: false),
                    AssistPreviewCell(value: "225", cited: false)]),
                AssistPreviewRow(rowNumber: 19, cells: [
                    AssistPreviewCell(value: "Depreciation-Direct", cited: false),
                    AssistPreviewCell(value: "612", cited: false)]),
                AssistPreviewRow(rowNumber: 20, cells: [
                    AssistPreviewCell(value: "Office Supplies", cited: false),
                    AssistPreviewCell(value: "400", cited: true)]),
                AssistPreviewRow(rowNumber: 21, cells: [
                    AssistPreviewCell(value: "Utilities", cited: false),
                    AssistPreviewCell(value: "180", cited: false)]),
                AssistPreviewRow(rowNumber: 22, cells: [
                    AssistPreviewCell(value: "Insurance", cited: false),
                    AssistPreviewCell(value: "95", cited: false)]),
            ])
        view.fullDocument = ShareFullDocument(kind: "table", sheets: [
            ShareFullSheet(name: "Accounting", rows: [
                ["Account", "Current Period", "Prior Period", "Variance"],
                ["Payroll Taxes", "225", "218", "7"],
                ["Depreciation-Direct", "612", "590", "22"],
                ["Office Supplies", "400", "384", "16"],
                ["Utilities", "180", "175", "5"],
                ["Insurance", "95", "90", "5"],
                ["Travel", "320", "280", "40"],
                ["Repairs", "75", "62", "13"],
                ["Rent", "900", "900", "0"],
                ["Software", "145", "130", "15"],
            ]),
            ShareFullSheet(name: "Forecast", rows: [
                ["Account", "Q4 Forecast", "Annual"],
                ["Office Supplies", "420", "1,595"],
                ["Utilities", "190", "735"],
            ]),
        ], blocks: [])
        view.isLoading = false
        view.isDocumentLoading = false
        view.addFixtureRedaction(sheet: 0, row: 3, column: 1, effect: .blur)
        view.addFixtureRedaction(sheet: 0, row: 5, column: 0, effect: .blank)
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let panel = existingPanel()
        panel.setFrame(NSRect(x: visible.midX - canvasSize.width / 2,
                              y: visible.midY - canvasSize.height / 2,
                              width: canvasSize.width, height: canvasSize.height), display: true)
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func hide() {
        generation += 1
        requests.forEach { $0.cancel() }
        requests.removeAll()
        panel?.orderOut(nil)
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let created = NSPanel(contentRect: NSRect(origin: .zero, size: canvasSize),
                              styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        created.level = .popUpMenu
        created.isOpaque = false
        created.backgroundColor = .clear
        created.appearance = NSAppearance(named: .aqua)
        created.hasShadow = true
        created.hidesOnDeactivate = false
        created.isMovableByWindowBackground = true
        created.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        created.contentView = NativeMaterial.glassContainer(
            content: view, cornerRadius: 14)
        panel = created
        return created
    }

    private func placement(near anchor: NSRect) -> NSPoint {
        let point = anchor.isEmpty ? NSEvent.mouseLocation : NSPoint(x: anchor.midX, y: anchor.midY)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        var x = anchor.isEmpty ? point.x - canvasSize.width / 2 : anchor.midX - canvasSize.width + 96
        var y = anchor.isEmpty ? point.y - canvasSize.height / 2 : anchor.minY - canvasSize.height - 10
        if y < visible.minY + 4 { y = anchor.maxY + 10 }
        x = min(max(visible.minX + 4, x), visible.maxX - canvasSize.width - 4)
        y = min(max(visible.minY + 4, y), visible.maxY - canvasSize.height - 4)
        return NSPoint(x: x, y: y)
    }
}

private struct ShareHitTarget {
    let rect: NSRect
    let kind: String
    let sheet: Int?
    let row: Int?
    let column: Int?
    let block: Int?

    var key: String {
        if kind == "CELL" { return "cell:\(sheet ?? 0):\(row ?? -1):\(column ?? -1)" }
        return "block:\(block ?? -1)"
    }

    func redaction(effect: ShareRedactionEffect) -> ShareRedaction {
        ShareRedaction(kind: kind, sheet: sheet, row: row, column: column,
                       block: block, effect: effect)
    }
}

final class ShareComposerView: NSView {
    var actionTitle = "Copy link"
    var localOnly = true
    var scope: ShareAccessScope = .indexed
    var preview: AssistDocumentPreview?
    var fullDocument: ShareFullDocument?
    var isLoading = true
    var isDocumentLoading = true
    var onCancel: (() -> Void)?
    var onCreate: ((ShareConfiguration) -> Void)?

    private var label = ""
    private var filename = ""
    private var effect: ShareRedactionEffect = .blur
    private var masks: [String: ShareRedaction] = [:]
    private var targets: [ShareHitTarget] = []
    private var sheetTabTargets: [(rect: NSRect, index: Int)] = []
    private var sheetIndex = 0
    private var rowOffset = 0
    private var columnOffset = 0
    private var blockOffset = 0
    private var dragAdds = true
    private var dragVisited: Set<String> = []
    private var notice: String?

    private let leftWidth: CGFloat = 226
    private let headerHeight: CGFloat = 62
    private let footerHeight: CGFloat = 57
    private let rightInset: CGFloat = 14

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func reset(label: String, filename: String) {
        self.label = label
        self.filename = filename.isEmpty ? "Indexed source" : filename
        scope = .indexed
        localOnly = true
        effect = .blur
        masks.removeAll()
        preview = nil
        fullDocument = nil
        isLoading = true
        isDocumentLoading = true
        sheetIndex = 0
        rowOffset = 0
        columnOffset = 0
        blockOffset = 0
        notice = nil
        needsDisplay = true
    }

    func addFixtureRedaction(sheet: Int, row: Int, column: Int, effect: ShareRedactionEffect) {
        let value = ShareRedaction(kind: "CELL", sheet: sheet, row: row,
                                   column: column, block: nil, effect: effect)
        masks["cell:\(sheet):\(row):\(column)"] = value
    }

    override func draw(_ dirtyRect: NSRect) {
        targets.removeAll()
        sheetTabTargets.removeAll()
        NSColor.clear.setFill()
        bounds.fill()
        drawChrome()
        drawHeader()
        drawScopes()
        drawPreview()
        drawFooter()
    }

    private func drawChrome() {
        let body = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 14, yRadius: 14)
        NSGradient(colors: [
            NSColor(calibratedWhite: 0.959, alpha: 1.0),
            NSColor(calibratedWhite: 0.949, alpha: 1.0),
        ])?.draw(in: body, angle: -90)
        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        body.lineWidth = 0.65
        body.stroke()

        NSColor.separatorColor.withAlphaComponent(0.09).setStroke()
        line(from: NSPoint(x: 0, y: headerHeight), to: NSPoint(x: bounds.width, y: headerHeight))
        line(from: NSPoint(x: leftWidth, y: headerHeight + 10),
             to: NSPoint(x: leftWidth, y: bounds.height - footerHeight - 10))
        line(from: NSPoint(x: 0, y: bounds.height - footerHeight),
             to: NSPoint(x: bounds.width, y: bounds.height - footerHeight))
    }

    private func drawHeader() {
        let iconRect = NSRect(x: 18, y: 15, width: 32, height: 32)
        NSColor.white.withAlphaComponent(0.94).setFill()
        NSBezierPath(roundedRect: iconRect, xRadius: 7, yRadius: 7).fill()
        drawSymbol("square.and.arrow.up", in: iconRect.insetBy(dx: 8, dy: 8), fraction: 0.72)

        drawText(actionTitle == "Insert link" ? "Insert source hyperlink" : "Share source", in: NSRect(x: 62, y: 14, width: 250, height: 18),
                 font: .systemFont(ofSize: 13, weight: .semibold), color: .labelColor)
        drawText(filename, in: NSRect(x: 62, y: 33, width: 360, height: 15),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)

        let close = NSRect(x: bounds.width - 43, y: 16, width: 28, height: 28)
        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        NSBezierPath(ovalIn: close).stroke()
        drawText("×", in: NSRect(x: close.minX, y: close.minY + 5, width: close.width, height: 17),
                 font: .systemFont(ofSize: 14), color: .secondaryLabelColor, alignment: .center)
    }

    private func drawScopes() {
        drawText("SHARE ACCESS", in: NSRect(x: 18, y: 79, width: 170, height: 14),
                 font: .systemFont(ofSize: 9, weight: .semibold), color: .tertiaryLabelColor)
        let entries: [(ShareAccessScope, String, String, String)] = [
            (.document, "Entire document", "Preview and download the pinned original", "doc"),
            (.indexed, "Indexed part only", "Only the matched source context", "scope"),
            (.redacted, "Select & redact", "Scroll the full document; blur or blank any area", "selection.pin.in.out"),
        ]
        for (index, entry) in entries.enumerated() {
            let row = NSRect(x: 10, y: 101 + CGFloat(index) * 76, width: leftWidth - 20, height: 66)
            if scope == entry.0 {
                NSColor(calibratedWhite: 0.42, alpha: 0.11).setFill()
                NSBezierPath(roundedRect: row, xRadius: 9, yRadius: 9).fill()
            }
            let radio = NSRect(x: 20, y: row.minY + 15, width: 16, height: 16)
            NSColor.separatorColor.withAlphaComponent(scope == entry.0 ? 0.5 : 0.25).setStroke()
            NSBezierPath(ovalIn: radio).stroke()
            if scope == entry.0 {
                NSColor.controlAccentColor.withAlphaComponent(0.9).setFill()
                NSBezierPath(ovalIn: radio.insetBy(dx: 4, dy: 4)).fill()
            }
            drawSymbol(entry.3, in: NSRect(x: 46, y: row.minY + 13, width: 17, height: 17), fraction: 0.6)
            drawText(entry.1, in: NSRect(x: 72, y: row.minY + 11, width: row.width - 82, height: 17),
                     font: .systemFont(ofSize: 11.5, weight: .semibold), color: .labelColor)
            drawText(entry.2, in: NSRect(x: 46, y: row.minY + 35, width: row.width - 60, height: 25),
                     font: .systemFont(ofSize: 9.2), color: .secondaryLabelColor)
        }
    }

    private func drawPreview() {
        let x = leftWidth + 16
        let width = bounds.width - x - rightInset
        drawText(scope == .indexed ? "RECIPIENT PREVIEW" : "COMPLETE DOCUMENT",
                 in: NSRect(x: x, y: 79, width: 170, height: 14),
                 font: .systemFont(ofSize: 9, weight: .semibold), color: .tertiaryLabelColor)

        if scope == .redacted {
            drawEffectControl("Blur", effect: .blur, in: NSRect(x: bounds.width - 150, y: 74, width: 54, height: 24))
            drawEffectControl("Blank", effect: .blank, in: NSRect(x: bounds.width - 92, y: 74, width: 62, height: 24))
        } else {
            let badge = scope == .document ? "Original available" : "Original protected"
            drawPill(badge, in: NSRect(x: bounds.width - 139, y: 76, width: 109, height: 20))
        }

        let card = NSRect(x: x, y: 105, width: width, height: 251)
        NSColor.white.withAlphaComponent(0.17).setFill()
        NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).fill()
        NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
        NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).stroke()

        drawText(label, in: NSRect(x: card.minX + 13, y: card.minY + 12,
                                  width: card.width - 26, height: 17),
                 font: .systemFont(ofSize: 11.5, weight: .semibold), color: .labelColor)
        let subtitle = scope == .indexed
            ? (preview?.location.isEmpty == false ? preview!.location : filename)
            : "Complete \(filename)"
        drawText(subtitle, in: NSRect(x: card.minX + 13, y: card.minY + 31,
                                     width: card.width - 26, height: 14),
                 font: .systemFont(ofSize: 9.3), color: .secondaryLabelColor)

        let content = NSRect(x: card.minX + 13, y: card.minY + 55,
                             width: card.width - 26, height: card.height - 68)
        if scope != .indexed {
            if isDocumentLoading {
                drawCentered("Loading complete document…", in: content)
            } else if let fullDocument {
                drawFullDocument(fullDocument, in: content)
            } else {
                drawCentered("Complete document preview unavailable", in: content)
            }
        } else if isLoading {
            drawCentered("Loading source preview…", in: content)
        } else if let preview, !preview.rows.isEmpty {
            drawTable(preview, in: content)
        } else if let preview {
            drawTextBlocks(preview.context, in: content)
        } else {
            drawCentered("Preview unavailable", in: content)
        }

        if scope == .redacted {
            drawText("Scroll the entire document. Drag across cells or text sections.",
                     in: NSRect(x: x + 2, y: 361, width: width - 4, height: 14),
                     font: .systemFont(ofSize: 9), color: .tertiaryLabelColor)
        } else if scope == .document {
            drawText("Scroll to inspect the complete document before sharing.",
                     in: NSRect(x: x + 2, y: 361, width: width - 4, height: 14),
                     font: .systemFont(ofSize: 9), color: .tertiaryLabelColor)
        }
    }

    private func drawCentered(_ value: String, in rect: NSRect) {
        drawText(value, in: NSRect(x: rect.minX, y: rect.midY - 8,
                                   width: rect.width, height: 17),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor, alignment: .center)
    }

    private func drawFullDocument(_ document: ShareFullDocument, in rect: NSRect) {
        if document.kind == "table", !document.sheets.isEmpty {
            sheetIndex = min(max(0, sheetIndex), document.sheets.count - 1)
            drawFullTable(document.sheets[sheetIndex], sheetCount: document.sheets.count, in: rect)
        } else if document.kind == "text", !document.blocks.isEmpty {
            drawFullText(document.blocks, in: rect)
        } else {
            drawCentered("This document has no previewable content", in: rect)
        }
    }

    private func drawFullTable(_ sheet: ShareFullSheet, sheetCount: Int, in rect: NSRect) {
        let tabHeight: CGFloat = sheetCount > 1 ? 23 : 0
        if sheetCount > 1, let document = fullDocument {
            drawSheetTabs(document.sheets, in: NSRect(
                x: rect.minX, y: rect.minY, width: rect.width, height: tabHeight))
        }

        let statusHeight: CGFloat = 15
        let tableRect = NSRect(x: rect.minX, y: rect.minY + tabHeight,
                               width: rect.width - 7,
                               height: rect.height - tabHeight - statusHeight)
        let rowHeader: CGFloat = 28
        let headerHeight: CGFloat = 20
        let visibleRowCount = max(1, Int((tableRect.height - headerHeight) / 25))
        let maxColumnCount = max(1, sheet.rows.map(\.count).max() ?? 1)
        let visibleColumnCount = min(4, maxColumnCount)
        rowOffset = min(max(0, rowOffset), max(0, sheet.rows.count - visibleRowCount))
        columnOffset = min(max(0, columnOffset), max(0, maxColumnCount - visibleColumnCount))
        let visibleRows = Array(sheet.rows.dropFirst(rowOffset).prefix(visibleRowCount))
        let columnWidth = (tableRect.width - rowHeader) / CGFloat(visibleColumnCount)
        let rowHeight = (tableRect.height - headerHeight) / CGFloat(max(1, visibleRows.count))

        let table = NSBezierPath(roundedRect: tableRect, xRadius: 7, yRadius: 7)
        NSColor.white.withAlphaComponent(0.12).setFill()
        table.fill()
        NSGraphicsContext.current?.saveGraphicsState()
        table.addClip()
        NSColor.controlBackgroundColor.withAlphaComponent(0.10).setFill()
        NSRect(x: tableRect.minX, y: tableRect.minY,
               width: tableRect.width, height: headerHeight).fill()

        for visibleColumn in 0..<visibleColumnCount {
            let absoluteColumn = columnOffset + visibleColumn
            drawText(spreadsheetColumn(absoluteColumn),
                     in: NSRect(x: tableRect.minX + rowHeader + CGFloat(visibleColumn) * columnWidth,
                                y: tableRect.minY + 4, width: columnWidth, height: 13),
                     font: .systemFont(ofSize: 8.5), color: .secondaryLabelColor, alignment: .center)
        }

        for (visibleRow, values) in visibleRows.enumerated() {
            let absoluteRow = rowOffset + visibleRow
            let y = tableRect.minY + headerHeight + CGFloat(visibleRow) * rowHeight
            drawText(String(absoluteRow + 1),
                     in: NSRect(x: tableRect.minX, y: y + 5, width: rowHeader - 6, height: 13),
                     font: .systemFont(ofSize: 8.4), color: .secondaryLabelColor, alignment: .right)
            for visibleColumn in 0..<visibleColumnCount {
                let absoluteColumn = columnOffset + visibleColumn
                let cellRect = NSRect(
                    x: tableRect.minX + rowHeader + CGFloat(visibleColumn) * columnWidth,
                    y: y, width: columnWidth, height: rowHeight)
                let target = ShareHitTarget(
                    rect: cellRect, kind: "CELL", sheet: sheetIndex,
                    row: absoluteRow, column: absoluteColumn, block: nil)
                targets.append(target)
                if scope == .redacted, let mask = masks[target.key] {
                    drawMask(mask.effect, in: cellRect)
                } else {
                    let value = absoluteColumn < values.count ? values[absoluteColumn] : ""
                    drawText(value, in: cellRect.insetBy(dx: 6, dy: 5),
                             font: .systemFont(ofSize: 8.9), color: .labelColor,
                             alignment: absoluteColumn == 0 ? .left : .right)
                }
            }
        }

        NSColor.separatorColor.withAlphaComponent(0.12).setStroke()
        for visibleColumn in 0...visibleColumnCount {
            let x = tableRect.minX + rowHeader + CGFloat(visibleColumn) * columnWidth
            line(from: NSPoint(x: x, y: tableRect.minY), to: NSPoint(x: x, y: tableRect.maxY))
        }
        line(from: NSPoint(x: tableRect.minX, y: tableRect.minY + headerHeight),
             to: NSPoint(x: tableRect.maxX, y: tableRect.minY + headerHeight))
        for visibleRow in 1...visibleRows.count {
            let y = tableRect.minY + headerHeight + CGFloat(visibleRow) * rowHeight
            line(from: NSPoint(x: tableRect.minX, y: y), to: NSPoint(x: tableRect.maxX, y: y))
        }
        NSGraphicsContext.current?.restoreGraphicsState()
        NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
        table.stroke()

        drawScrollIndicator(offset: rowOffset, visible: visibleRowCount,
                            total: sheet.rows.count, in: tableRect)
        let rowEnd = min(sheet.rows.count, rowOffset + visibleRows.count)
        let columnEnd = min(maxColumnCount, columnOffset + visibleColumnCount)
        drawText("Rows \(rowOffset + 1)–\(rowEnd) of \(sheet.rows.count)  ·  Columns \(spreadsheetColumn(columnOffset))–\(spreadsheetColumn(max(columnOffset, columnEnd - 1)))",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - statusHeight + 2,
                            width: rect.width - 4, height: 13),
                 font: .systemFont(ofSize: 8), color: .tertiaryLabelColor)
    }

    private func drawSheetTabs(_ sheets: [ShareFullSheet], in rect: NSRect) {
        let arrowWidth: CGFloat = sheets.count > 4 ? 18 : 0
        let visibleCount = min(4, sheets.count)
        let start = min(max(0, sheetIndex - 1), max(0, sheets.count - visibleCount))
        let available = rect.width - arrowWidth * 2
        let width = available / CGFloat(visibleCount)

        if arrowWidth > 0 {
            let previous = NSRect(x: rect.minX, y: rect.minY, width: arrowWidth, height: rect.height)
            let next = NSRect(x: rect.maxX - arrowWidth, y: rect.minY, width: arrowWidth, height: rect.height)
            drawText("‹", in: previous.offsetBy(dx: 0, dy: 3), font: .systemFont(ofSize: 13),
                     color: .secondaryLabelColor, alignment: .center)
            drawText("›", in: next.offsetBy(dx: 0, dy: 3), font: .systemFont(ofSize: 13),
                     color: .secondaryLabelColor, alignment: .center)
            sheetTabTargets.append((previous, max(0, sheetIndex - 1)))
            sheetTabTargets.append((next, min(sheets.count - 1, sheetIndex + 1)))
        }

        for position in 0..<visibleCount {
            let index = start + position
            let tab = NSRect(x: rect.minX + arrowWidth + CGFloat(position) * width,
                             y: rect.minY, width: width, height: rect.height - 3)
            if index == sheetIndex {
                NSColor.controlBackgroundColor.withAlphaComponent(0.18).setFill()
                NSBezierPath(roundedRect: tab, xRadius: 5, yRadius: 5).fill()
            }
            drawText(sheets[index].name, in: tab.insetBy(dx: 5, dy: 5),
                     font: .systemFont(ofSize: 8.4, weight: index == sheetIndex ? .semibold : .regular),
                     color: index == sheetIndex ? .labelColor : .secondaryLabelColor,
                     alignment: .center)
            sheetTabTargets.append((tab, index))
        }
    }

    private func drawFullText(_ blocks: [String], in rect: NSRect) {
        let statusHeight: CGFloat = 15
        let body = NSRect(x: rect.minX, y: rect.minY, width: rect.width - 7,
                          height: rect.height - statusHeight)
        let blockHeight: CGFloat = 43
        let visibleCount = max(1, Int(body.height / (blockHeight + 4)))
        blockOffset = min(max(0, blockOffset), max(0, blocks.count - visibleCount))
        let visible = Array(blocks.dropFirst(blockOffset).prefix(visibleCount))
        for (position, block) in visible.enumerated() {
            let index = blockOffset + position
            let targetRect = NSRect(x: body.minX,
                                    y: body.minY + CGFloat(position) * (blockHeight + 4),
                                    width: body.width, height: blockHeight)
            let target = ShareHitTarget(rect: targetRect, kind: "BLOCK", sheet: nil,
                                        row: nil, column: nil, block: index)
            targets.append(target)
            NSColor.controlBackgroundColor.withAlphaComponent(0.10).setFill()
            NSBezierPath(roundedRect: targetRect, xRadius: 6, yRadius: 6).fill()
            if scope == .redacted, let mask = masks[target.key] {
                drawMask(mask.effect, in: targetRect)
            } else {
                drawText(block, in: targetRect.insetBy(dx: 8, dy: 7),
                         font: .systemFont(ofSize: 8.9), color: .labelColor)
            }
        }
        drawScrollIndicator(offset: blockOffset, visible: visibleCount,
                            total: blocks.count, in: body)
        let end = min(blocks.count, blockOffset + visible.count)
        drawText("Sections \(blockOffset + 1)–\(end) of \(blocks.count)",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - statusHeight + 2,
                            width: rect.width - 4, height: 13),
                 font: .systemFont(ofSize: 8), color: .tertiaryLabelColor)
    }

    private func drawScrollIndicator(offset: Int, visible: Int, total: Int, in rect: NSRect) {
        guard total > visible, total > 0 else { return }
        let track = NSRect(x: rect.maxX + 3, y: rect.minY + 2, width: 3, height: rect.height - 4)
        NSColor.separatorColor.withAlphaComponent(0.10).setFill()
        NSBezierPath(roundedRect: track, xRadius: 1.5, yRadius: 1.5).fill()
        let fraction = min(1, CGFloat(visible) / CGFloat(total))
        let thumbHeight = max(18, track.height * fraction)
        let travel = track.height - thumbHeight
        let denominator = max(1, total - visible)
        let thumbY = track.minY + travel * CGFloat(offset) / CGFloat(denominator)
        let thumb = NSRect(x: track.minX, y: thumbY, width: track.width, height: thumbHeight)
        NSColor.secondaryLabelColor.withAlphaComponent(0.30).setFill()
        NSBezierPath(roundedRect: thumb, xRadius: 1.5, yRadius: 1.5).fill()
    }

    private func spreadsheetColumn(_ index: Int) -> String {
        var result = ""
        var value = index
        repeat {
            result = String(UnicodeScalar(65 + value % 26)!) + result
            value = value / 26 - 1
        } while value >= 0
        return result
    }

    private func drawTable(_ preview: AssistDocumentPreview, in rect: NSRect) {
        let rows = Array(preview.rows.prefix(5))
        let columns = min(4, max(1, rows.map(\.cells.count).max() ?? 1))
        let rowHeader: CGFloat = 31
        let columnWidth = (rect.width - rowHeader) / CGFloat(columns)
        let rowHeight = rect.height / CGFloat(rows.count + 1)
        let table = NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7)
        NSColor.white.withAlphaComponent(0.12).setFill()
        table.fill()
        NSGraphicsContext.current?.saveGraphicsState()
        table.addClip()

        NSColor.controlBackgroundColor.withAlphaComponent(0.10).setFill()
        NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: rowHeight).fill()
        let labels = preview.headers.enumerated().map { index, heading in
            heading.isEmpty ? "Column \(index < preview.columns.count ? preview.columns[index] : String(index + 1))" : heading
        }
        for column in 0..<columns {
            let text = column < labels.count ? labels[column] : String(column + 1)
            drawText(text, in: NSRect(x: rect.minX + rowHeader + CGFloat(column) * columnWidth,
                                      y: rect.minY + 6, width: columnWidth, height: max(14, rowHeight - 10)),
                     font: .systemFont(ofSize: 9, weight: .medium), color: .secondaryLabelColor, alignment: .center, wrap: true)
        }

        for (rowIndex, row) in rows.enumerated() {
            let y = rect.minY + rowHeight * CGFloat(rowIndex + 1)
            drawText(row.rowNumber.map(String.init) ?? "—",
                     in: NSRect(x: rect.minX, y: y + 6, width: rowHeader - 7, height: 14),
                     font: .systemFont(ofSize: 8.8), color: .secondaryLabelColor, alignment: .right)
            for column in 0..<columns {
                let cellRect = NSRect(x: rect.minX + rowHeader + CGFloat(column) * columnWidth,
                                      y: y, width: columnWidth, height: rowHeight)
                let target = ShareHitTarget(rect: cellRect, kind: "CELL", sheet: nil,
                                            row: rowIndex, column: column, block: nil)
                targets.append(target)
                let cell = column < row.cells.count ? row.cells[column] : AssistPreviewCell(value: "", cited: false)
                let mask = scope == .redacted ? masks[target.key] : nil
                if cell.cited && mask == nil {
                    NSColor.systemGreen.withAlphaComponent(0.075).setFill()
                    cellRect.fill()
                }
                if let mask {
                    drawMask(mask.effect, in: cellRect)
                } else {
                    drawText(cell.value,
                             in: cellRect.insetBy(dx: 7, dy: 6),
                             font: .systemFont(ofSize: 9.2, weight: cell.cited ? .medium : .regular),
                             color: .labelColor, alignment: column == 0 ? .left : .right)
                }
            }
        }

        NSColor.separatorColor.withAlphaComponent(0.12).setStroke()
        for column in 0...columns {
            let x = rect.minX + rowHeader + CGFloat(column) * columnWidth
            line(from: NSPoint(x: x, y: rect.minY), to: NSPoint(x: x, y: rect.maxY))
        }
        for row in 1...rows.count {
            let y = rect.minY + rowHeight * CGFloat(row)
            line(from: NSPoint(x: rect.minX, y: y), to: NSPoint(x: rect.maxX, y: y))
        }
        NSGraphicsContext.current?.restoreGraphicsState()
        NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
        table.stroke()
    }

    private func drawTextBlocks(_ value: String, in rect: NSRect) {
        let words = value.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        var blocks: [String] = []
        stride(from: 0, to: words.count, by: 7).forEach {
            blocks.append(words[$0..<min($0 + 7, words.count)].joined(separator: " "))
        }
        if blocks.isEmpty { blocks = ["Indexed source context"] }
        let height = min(CGFloat(30), rect.height / CGFloat(max(1, blocks.count)))
        for (index, block) in blocks.prefix(6).enumerated() {
            let targetRect = NSRect(x: rect.minX, y: rect.minY + CGFloat(index) * (height + 3),
                                    width: rect.width, height: height)
            let target = ShareHitTarget(rect: targetRect, kind: "BLOCK", sheet: nil,
                                        row: nil, column: nil, block: index)
            targets.append(target)
            NSColor.controlBackgroundColor.withAlphaComponent(0.10).setFill()
            NSBezierPath(roundedRect: targetRect, xRadius: 5, yRadius: 5).fill()
            if scope == .redacted, let mask = masks[target.key] {
                drawMask(mask.effect, in: targetRect)
            } else {
                drawText(block, in: targetRect.insetBy(dx: 8, dy: 7),
                         font: .systemFont(ofSize: 9.3), color: .labelColor)
            }
        }
    }

    private func drawMask(_ effect: ShareRedactionEffect, in rect: NSRect) {
        let inset = rect.insetBy(dx: 2, dy: 2)
        let fill = effect == .blank
            ? NSColor(calibratedWhite: 0.55, alpha: 0.12)
            : NSColor(calibratedWhite: 0.48, alpha: 0.21)
        fill.setFill()
        NSBezierPath(roundedRect: inset, xRadius: 4, yRadius: 4).fill()
        if effect == .blur {
            drawText("••••••", in: NSRect(x: inset.minX + 4, y: inset.midY - 7,
                                          width: inset.width - 8, height: 14),
                     font: .systemFont(ofSize: 8.5), color: .tertiaryLabelColor, alignment: .center)
        }
    }

    private func drawFooter() {
        let y = bounds.height - footerHeight
        let detail: String
        switch scope {
        case .document: detail = "Recipients can download the pinned original."
        case .indexed: detail = "Only indexed context is published."
        case .redacted: detail = masks.isEmpty ? "Select at least one area to redact." : "\(masks.count) area\(masks.count == 1 ? "" : "s") removed from the shared view."
        }
        drawSymbol("lock.shield", in: NSRect(x: 18, y: y + 20, width: 15, height: 15), fraction: 0.58)
        let availability = localOnly ? "Only on this Mac. Email recipients need hosted sharing." : detail
        drawText(notice ?? availability, in: NSRect(x: 40, y: y + 12, width: 335, height: 32),
                 font: .systemFont(ofSize: 9.5),
                 color: notice == nil ? .secondaryLabelColor : .systemRed, wrap: true)

        drawButton("Cancel", in: NSRect(x: bounds.width - 213, y: y + 11, width: 82, height: 35),
                   prominent: false, enabled: true)
        let enabled = scope != .redacted || !masks.isEmpty
        drawButton(actionTitle, in: NSRect(x: bounds.width - 123, y: y + 11, width: 108, height: 35),
                   prominent: true, enabled: enabled)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        notice = nil
        if NSRect(x: bounds.width - 43, y: 16, width: 28, height: 28).contains(point) {
            onCancel?(); return
        }
        if NSRect(x: 0, y: 0, width: bounds.width - 50, height: headerHeight).contains(point) {
            window?.performDrag(with: event)
            return
        }
        for index in 0..<3 {
            let rect = NSRect(x: 10, y: 101 + CGFloat(index) * 76, width: leftWidth - 20, height: 66)
            if rect.contains(point) {
                scope = [ShareAccessScope.document, .indexed, .redacted][index]
                needsDisplay = true
                return
            }
        }
        if scope != .indexed,
           let tab = sheetTabTargets.first(where: { $0.rect.contains(point) }) {
            sheetIndex = tab.index
            rowOffset = 0
            columnOffset = 0
            needsDisplay = true
            return
        }
        if scope == .redacted {
            if NSRect(x: bounds.width - 150, y: 74, width: 54, height: 24).contains(point) {
                effect = .blur; needsDisplay = true; return
            }
            if NSRect(x: bounds.width - 92, y: 74, width: 62, height: 24).contains(point) {
                effect = .blank; needsDisplay = true; return
            }
            if let target = targets.first(where: { $0.rect.contains(point) }) {
                dragAdds = masks[target.key] == nil
                dragVisited = [target.key]
                apply(target, adding: dragAdds)
                return
            }
        }

        let footerY = bounds.height - footerHeight
        if NSRect(x: bounds.width - 213, y: footerY + 11, width: 82, height: 35).contains(point) {
            onCancel?(); return
        }
        if NSRect(x: bounds.width - 123, y: footerY + 11, width: 108, height: 35).contains(point) {
            guard scope != .redacted || !masks.isEmpty else {
                notice = "Select an area before creating the link."
                needsDisplay = true
                return
            }
            let redactions = scope == .redacted ? Array(masks.values) : []
            onCreate?(ShareConfiguration(scope: scope, redactions: redactions))
        }
    }

    override func scrollWheel(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let previewRect = NSRect(x: leftWidth + 16, y: 105,
                                 width: bounds.width - leftWidth - 30, height: 251)
        guard scope != .indexed, previewRect.contains(point), let document = fullDocument else {
            super.scrollWheel(with: event)
            return
        }

        let vertical = event.scrollingDeltaY
        let horizontal = event.scrollingDeltaX
        let horizontalIntent = abs(horizontal) > abs(vertical) || event.modifierFlags.contains(.shift)
        if document.kind == "table", !document.sheets.isEmpty {
            let index = min(max(0, sheetIndex), document.sheets.count - 1)
            let sheet = document.sheets[index]
            if horizontalIntent {
                let delta = abs(horizontal) > 0.1 ? horizontal : vertical
                let step = max(1, Int(abs(delta) / 8))
                let maxColumnCount = max(1, sheet.rows.map(\.count).max() ?? 1)
                let maximum = max(0, maxColumnCount - min(4, maxColumnCount))
                columnOffset = min(maximum, max(0, columnOffset + (delta < 0 ? step : -step)))
            } else {
                let step = max(1, Int(abs(vertical) / 8))
                let maximum = max(0, sheet.rows.count - 5)
                rowOffset = min(maximum, max(0, rowOffset + (vertical < 0 ? step : -step)))
            }
        } else if document.kind == "text" {
            let step = max(1, Int(abs(vertical) / 8))
            let maximum = max(0, document.blocks.count - 3)
            blockOffset = min(maximum, max(0, blockOffset + (vertical < 0 ? step : -step)))
        }
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard scope == .redacted else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard let target = targets.first(where: { $0.rect.contains(point) }),
              !dragVisited.contains(target.key) else { return }
        dragVisited.insert(target.key)
        apply(target, adding: dragAdds)
    }

    private func apply(_ target: ShareHitTarget, adding: Bool) {
        if adding { masks[target.key] = target.redaction(effect: effect) }
        else { masks.removeValue(forKey: target.key) }
        needsDisplay = true
    }

    private func drawEffectControl(_ title: String, effect option: ShareRedactionEffect, in rect: NSRect) {
        if effect == option {
            NSColor(calibratedWhite: 0.45, alpha: 0.10).setFill()
            NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
        }
        NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
        NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).stroke()
        drawText(title, in: NSRect(x: rect.minX, y: rect.minY + 5, width: rect.width, height: 14),
                 font: .systemFont(ofSize: 9.5, weight: .medium), color: .secondaryLabelColor,
                 alignment: .center)
    }

    private func drawPill(_ title: String, in rect: NSRect) {
        NSColor(calibratedWhite: 0.45, alpha: 0.08).setFill()
        NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
        drawText(title, in: NSRect(x: rect.minX + 6, y: rect.minY + 4,
                                  width: rect.width - 12, height: 13),
                 font: .systemFont(ofSize: 8.7, weight: .medium), color: .secondaryLabelColor,
                 alignment: .center)
    }

    private func drawButton(_ title: String, in rect: NSRect, prominent: Bool, enabled: Bool) {
        let fill = prominent
            ? NSColor.controlAccentColor.withAlphaComponent(enabled ? 0.88 : 0.24)
            : NSColor.white.withAlphaComponent(0.15)
        fill.setFill()
        NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7).fill()
        if !prominent {
            NSColor.separatorColor.withAlphaComponent(0.18).setStroke()
            NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7).stroke()
        }
        drawText(title, in: NSRect(x: rect.minX, y: rect.minY + 9, width: rect.width, height: 17),
                 font: .systemFont(ofSize: 10.5, weight: .semibold),
                 color: prominent ? NSColor.white.withAlphaComponent(enabled ? 1 : 0.7) : .labelColor,
                 alignment: .center)
    }

    private func drawSymbol(_ name: String, in rect: NSRect, fraction: CGFloat) {
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return }
        image.isTemplate = true
        image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: fraction,
                   respectFlipped: true, hints: nil)
    }

    private func line(from: NSPoint, to: NSPoint) {
        let path = NSBezierPath()
        path.lineWidth = 0.5
        path.move(to: from)
        path.line(to: to)
        path.stroke()
    }

    private func drawText(_ value: String, in rect: NSRect, font: NSFont, color: NSColor,
                          alignment: NSTextAlignment = .left, wrap: Bool = false) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = wrap ? .byWordWrapping : .byTruncatingTail
        NSAttributedString(string: value, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
        ]).draw(in: rect)
    }
}
