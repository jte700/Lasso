//  Privacy-aware source sharing.
//
//  The composer is deliberately native and non-activating so the document the
//  user is writing in keeps focus. It makes the public boundary visible before
//  a token is minted: whole document, indexed context, or a preview with safe
//  redactions selected directly with the mouse.

import Cocoa
import CoreImage

private final class ShareComposerSurface: NSView {
    static let cornerRadius: CGFloat = 14

    init(content: NSView) {
        super.init(frame: content.frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.cornerRadius = Self.cornerRadius
        layer?.masksToBounds = true
        let material = NativeMaterial.glassContainer(content: content, cornerRadius: Self.cornerRadius)
        material.frame = bounds
        material.autoresizingMask = [.width, .height]
        addSubview(material)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

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

    private(set) var canvasSize = NSSize(width: 560, height: 540)
    private lazy var view = ShareComposerView(frame: NSRect(origin: .zero, size: canvasSize))
    private var panel: NSPanel?
    private weak var hostPanel: NSPanel?
    private var previousContent: NSView?
    private weak var previousResponder: NSResponder?
    private var previousFrame: NSRect?
    private var active = false
    private var requests: [URLSessionDataTask] = []
    private var generation = 0
    private var completion: ((ShareConfiguration) -> Void)?
    private var copyAction: ((ShareConfiguration, @escaping (Result<DependencyShare, Error>) -> Void) -> Void)?
    private var copyServerURL: URL?
    private var cancellation: (() -> Void)?
    private var projectId: String?
    private var fallbackColor: NSColor = .controlAccentColor
    private var colorObserver: NSObjectProtocol?
    var isVisible: Bool { active && (hostPanel ?? panel)?.isVisible == true }

    func isPresented(in panel: NSPanel?) -> Bool {
        active && panel != nil && hostPanel === panel
    }

    func confirm() { if isVisible { view.submit() } }

    func moveScope(_ delta: Int) {
        guard isVisible, !view.isCopying else { return }
        let scopes: [ShareAccessScope] = [.document, .indexed, .redacted]
        let index = scopes.firstIndex(of: view.scope) ?? 1
        view.scope = scopes[(index + delta + scopes.count) % scopes.count]
        view.needsDisplay = true
    }

    func cancel() {
        hide()
        let callback = cancellation
        cancellation = nil; completion = nil
        callback?()
    }

    override private init() {
        super.init()
        colorObserver = NotificationCenter.default.addObserver(
            forName: .directoryColorsDidChange, object: nil, queue: .main) { [weak self] _ in
                self?.updateSourceColor()
            }
        view.onCancel = { [weak self] in self?.cancel() }
        view.onCreate = { [weak self] configuration in
            self?.create(configuration)
        }
    }

    private func create(_ configuration: ShareConfiguration) {
        guard active else { return }
        guard let copyAction, let serverURL = copyServerURL else {
            let callback = completion
            hide()
            callback?(configuration)
            return
        }
        view.beginCopy()
        let token = generation
        copyAction(configuration) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == token else {
                    if case .success(let share) = result {
                        ShareClient.revokeShare(serverURL: serverURL, token: share.token)
                    }
                    return
                }
                switch result {
                case .success(let share):
                    NSPasteboard.general.clearContents()
                    if NSPasteboard.general.setString(share.url.absoluteString, forType: .string) {
                        self.view.finishCopy()
                    } else {
                        ShareClient.revokeShare(serverURL: serverURL, token: share.token)
                        self.view.finishCopy(error: "Could not copy the link. Please try again.")
                    }
                case .failure(let error):
                    self.view.finishCopy(error: error.localizedDescription)
                }
            }
        }
    }

    func show(objectId: String, versionId: String?, label: String, sourcePath: String,
              near anchor: NSRect, serverURL: URL, actionTitle: String = "Copy link",
              hostPanel: NSPanel? = nil,
              projectId: String? = nil, fallbackColor: NSColor = .controlAccentColor,
              copyAction: ((ShareConfiguration, @escaping (Result<DependencyShare, Error>) -> Void) -> Void)? = nil,
              onCancel: (() -> Void)? = nil,
              completion: ((ShareConfiguration) -> Void)? = nil) {
        hide()
        canvasSize = hostPanel.map { NSSize(width: max(560, $0.frame.width), height: max(438, $0.frame.height)) }
            ?? NSSize(width: 560, height: 540)
        self.completion = completion
        self.copyAction = copyAction
        copyServerURL = serverURL
        cancellation = onCancel
        self.projectId = projectId
        self.fallbackColor = fallbackColor
        updateSourceColor()
        active = true
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
        let panel: NSPanel
        if let hostPanel {
            self.hostPanel = hostPanel
            previousContent = hostPanel.contentView
            previousResponder = hostPanel.firstResponder
            previousFrame = hostPanel.frame
            hostPanel.contentView = ShareComposerSurface(content: view)
            panel = hostPanel
        } else {
            panel = existingPanel()
            panel.contentView = ShareComposerSurface(content: view)
        }
        view.frame = NSRect(origin: .zero, size: canvasSize)
        var origin = hostPanel.map { NSPoint(x: $0.frame.minX, y: $0.frame.maxY - canvasSize.height) }
            ?? placement(near: anchor)
        if let screen = hostPanel?.screen?.visibleFrame {
            origin.x = min(max(screen.minX, origin.x), screen.maxX - canvasSize.width)
            origin.y = min(max(screen.minY, origin.y), screen.maxY - canvasSize.height)
        }
        panel.setFrame(NSRect(origin: origin, size: canvasSize), display: true)
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.invalidateShadow()
        if panel.isKeyWindow { panel.makeFirstResponder(view) }
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
        active = true
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
        active = false
        completion = nil
        copyAction = nil
        copyServerURL = nil
        if let hostPanel {
            hostPanel.contentView = previousContent
            if hostPanel.isKeyWindow, let previousResponder { hostPanel.makeFirstResponder(previousResponder) }
            if let previousFrame { hostPanel.setFrame(previousFrame, display: true) }
            hostPanel.contentView?.layoutSubtreeIfNeeded()
            hostPanel.invalidateShadow()
        } else {
            panel?.orderOut(nil)
        }
        hostPanel = nil
        previousContent = nil
        previousResponder = nil
        previousFrame = nil
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let created = NSPanel(contentRect: NSRect(origin: .zero, size: canvasSize),
                              styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        created.level = .popUpMenu
        created.isOpaque = false
        created.backgroundColor = .clear
        created.hasShadow = true
        created.hidesOnDeactivate = false
        created.isMovableByWindowBackground = true
        created.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        created.contentView = ShareComposerSurface(content: view)
        panel = created
        return created
    }

    private func updateSourceColor() {
        view.sourceColor = DirectoryColorPreferences.color(for: projectId)?.color ?? fallbackColor
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
    private enum CopyState { case idle, copying, copied }
    private var copyState: CopyState = .idle
    var isCopying: Bool { copyState == .copying }
    var actionTitle = "Copy link"
    var sourceColor: NSColor = .controlAccentColor { didSet { needsDisplay = true } }
    var localOnly = true
    var scope: ShareAccessScope = .indexed {
        didSet { if scope != oldValue { clearCopyConfirmation() } }
    }
    var preview: AssistDocumentPreview?
    var fullDocument: ShareFullDocument?
    var isLoading = true
    var isDocumentLoading = true
    var onCancel: (() -> Void)?
    var onCreate: ((ShareConfiguration) -> Void)?

    private var label = ""
    private var filename = ""
    private var effect: ShareRedactionEffect = .blur
    private var masks: [String: ShareRedaction] = [:] {
        didSet { if masks != oldValue { clearCopyConfirmation() } }
    }
    private var targets: [ShareHitTarget] = []
    private var sheetTabTargets: [(rect: NSRect, index: Int)] = []
    private var sheetIndex = 0
    private var rowOffset = 0
    private var columnOffset = 0
    private var blockOffset = 0
    private var redactionDrag: ShareRedactionDrag?
    private var notice: String?

    private let headerHeight: CGFloat = 42
    private let footerHeight: CGFloat = 68
    private static let blurContext = CIContext(options: [.cacheIntermediates: false])
    private var blurredMasks: [String: NSImage] = [:]

    private var sourceInkColor: NSColor {
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return sourceColor.blended(withFraction: dark ? 0.18 : 0.35, of: dark ? .white : .black) ?? sourceColor
    }

    private var actionButtonRect: NSRect {
        NSRect(x: bounds.width - 132, y: bounds.height - footerHeight / 2 - 18, width: 116, height: 36)
    }

    private var cancelButtonRect: NSRect {
        NSRect(x: actionButtonRect.minX - 92, y: actionButtonRect.minY, width: 84, height: 36)
    }

    private var previewCard: NSRect {
        NSRect(x: 16, y: 132, width: bounds.width - 32,
               height: bounds.height - footerHeight - 146)
    }

    private func scopeRect(_ index: Int) -> NSRect {
        let width = (bounds.width - 44) / 3
        return NSRect(x: 16 + CGFloat(index) * (width + 6), y: 47,
                      width: width, height: 48)
    }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func keyDown(with event: NSEvent) {
        guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty else {
            super.keyDown(with: event); return
        }
        switch event.keyCode {
        case 53: onCancel?()
        case 48 where event.modifierFlags.contains(.shift): super.keyDown(with: event)
        case 48, 36, 76: submit()
        case 123, 124, 125, 126:
            guard !isCopying else { return }
            let scopes: [ShareAccessScope] = [.document, .indexed, .redacted]
            let delta = [123, 126].contains(event.keyCode) ? -1 : 1
            scope = scopes[((scopes.firstIndex(of: scope) ?? 1) + delta + scopes.count) % scopes.count]
            needsDisplay = true
        default: super.keyDown(with: event)
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        blurredMasks.removeAll()
        needsDisplay = true
    }

    func reset(label: String, filename: String) {
        self.label = label
        self.filename = filename.isEmpty ? "Indexed source" : filename
        scope = .indexed
        localOnly = true
        copyState = .idle
        effect = .blur
        masks.removeAll()
        blurredMasks.removeAll()
        redactionDrag = nil
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

    func beginCopy() {
        copyState = .copying
        redactionDrag = nil
        notice = nil
        needsDisplay = true
    }

    func finishCopy(error: String? = nil) {
        copyState = error == nil ? .copied : .idle
        notice = error
        needsDisplay = true
    }

    private func clearCopyConfirmation() {
        if copyState == .copied {
            copyState = .idle
            needsDisplay = true
        }
    }

    func addFixtureRedaction(sheet: Int, row: Int, column: Int, effect: ShareRedactionEffect) {
        let value = ShareRedaction(kind: "CELL", sheet: sheet, row: row,
                                   column: column, block: nil, effect: effect)
        masks["cell:\(sheet):\(row):\(column)"] = value
    }

    override func draw(_ dirtyRect: NSRect) {
        targets.removeAll()
        sheetTabTargets.removeAll()
        NSGraphicsContext.current?.cgContext.clear(bounds)
        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(roundedRect: bounds, xRadius: ShareComposerSurface.cornerRadius,
                     yRadius: ShareComposerSurface.cornerRadius).addClip()
        drawChrome()
        drawHeader()
        drawScopes()
        drawPreview()
        drawFooter()
        NSGraphicsContext.current?.restoreGraphicsState()
    }

    private func drawChrome() {
        let body = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 14, yRadius: 14)
        NSColor.windowBackgroundColor.withAlphaComponent(0.94).setFill()
        body.fill()
        NSColor.separatorColor.withAlphaComponent(0.14).setStroke()
        body.lineWidth = 0.65
        body.stroke()

        NSColor.separatorColor.withAlphaComponent(0.09).setStroke()
        line(from: NSPoint(x: 0, y: bounds.height - footerHeight),
             to: NSPoint(x: bounds.width, y: bounds.height - footerHeight))
    }

    private func drawHeader() {
        drawText(filename, in: NSRect(x: 18, y: 14, width: bounds.width - 65, height: 18),
                 font: .systemFont(ofSize: 12, weight: .semibold), color: .labelColor)
        drawSymbol("xmark", in: NSRect(x: bounds.width - 30, y: 16, width: 11, height: 11), fraction: 0.65)
    }

    private func drawScopes() {
        let entries: [(ShareAccessScope, String, String)] = [
            (.document, "Entire document", "Include the original file"),
            (.indexed, "Cited part only", "Share the matched context"),
            (.redacted, "Select & redact", "Hide source content"),
        ]
        for (index, entry) in entries.enumerated() {
            let row = scopeRect(index)
            if scope == entry.0 {
                sourceColor.withAlphaComponent(0.12).setFill()
                NSBezierPath(roundedRect: row, xRadius: 9, yRadius: 9).fill()
            }
            let radio = NSRect(x: row.minX + 10, y: row.minY + 9, width: 14, height: 14)
            NSColor.separatorColor.withAlphaComponent(scope == entry.0 ? 0.5 : 0.25).setStroke()
            NSBezierPath(ovalIn: radio).stroke()
            if scope == entry.0 {
                sourceColor.setFill()
                NSBezierPath(ovalIn: radio.insetBy(dx: 4, dy: 4)).fill()
            }
            drawText(entry.1, in: NSRect(x: row.minX + 31, y: row.minY + 8, width: row.width - 40, height: 17),
                     font: .systemFont(ofSize: 11, weight: .medium), color: scope == entry.0 ? sourceInkColor : .labelColor)
            drawText(entry.2, in: NSRect(x: row.minX + 31, y: row.minY + 27, width: row.width - 40, height: 14),
                     font: .systemFont(ofSize: 9.2), color: .secondaryLabelColor)
        }
    }

    private func drawPreview() {
        let x: CGFloat = 16
        drawText(scope == .indexed ? "RECIPIENT PREVIEW" : "COMPLETE DOCUMENT",
                 in: NSRect(x: x, y: 110, width: 170, height: 14),
                 font: .systemFont(ofSize: 9, weight: .semibold), color: .tertiaryLabelColor)

        if scope == .redacted {
            drawEffectControl("Blur", effect: .blur, in: NSRect(x: bounds.width - 140, y: 103, width: 54, height: 24))
            drawEffectControl("Redact", effect: .blank, in: NSRect(x: bounds.width - 80, y: 103, width: 64, height: 24))
        } else {
            let badge = scope == .document ? "Original available" : "Original protected"
            drawPill(badge, in: NSRect(x: bounds.width - 125, y: 105, width: 109, height: 20))
        }

        let card = previewCard
        NSColor.controlBackgroundColor.withAlphaComponent(0.65).setFill()
        NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).fill()
        NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
        NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).stroke()

        drawText(label, in: NSRect(x: card.minX + 13, y: card.minY + 12,
                                  width: card.width - 26, height: 17),
                 font: .systemFont(ofSize: 11.5, weight: .semibold), color: .labelColor)
        let subtitle = scope == .redacted ? "Drag across cells or sections to blur or redact." : scope == .indexed
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
        NSColor.textBackgroundColor.setFill()
        table.fill()
        NSGraphicsContext.current?.saveGraphicsState()
        table.addClip()
        NSColor.quaternaryLabelColor.withAlphaComponent(0.08).setFill()
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
                let value = absoluteColumn < values.count ? values[absoluteColumn] : ""
                if scope == .redacted, let mask = masks[target.key] {
                    drawMask(mask.effect, in: cellRect, value: value,
                             alignment: absoluteColumn == 0 ? .left : .right)
                } else {
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
        for visibleRow in 1..<(visibleRows.count + 1) {
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
                     color: sourceInkColor, alignment: .center)
            drawText("›", in: next.offsetBy(dx: 0, dy: 3), font: .systemFont(ofSize: 13),
                     color: sourceInkColor, alignment: .center)
            sheetTabTargets.append((previous, max(0, sheetIndex - 1)))
            sheetTabTargets.append((next, min(sheets.count - 1, sheetIndex + 1)))
        }

        for position in 0..<visibleCount {
            let index = start + position
            let tab = NSRect(x: rect.minX + arrowWidth + CGFloat(position) * width,
                             y: rect.minY, width: width, height: rect.height - 3)
            if index == sheetIndex {
                sourceColor.withAlphaComponent(0.12).setFill()
                NSBezierPath(roundedRect: tab, xRadius: 5, yRadius: 5).fill()
            }
            drawText(sheets[index].name, in: tab.insetBy(dx: 5, dy: 5),
                     font: .systemFont(ofSize: 8.4, weight: index == sheetIndex ? .semibold : .regular),
                     color: index == sheetIndex ? sourceInkColor : .secondaryLabelColor,
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
                drawMask(mask.effect, in: targetRect, value: block)
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
        NSColor.textBackgroundColor.setFill()
        table.fill()
        NSGraphicsContext.current?.saveGraphicsState()
        table.addClip()

        NSColor.quaternaryLabelColor.withAlphaComponent(0.08).setFill()
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
            drawText(row.rowNumber.map(String.init) ?? "",
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
                    sourceColor.withAlphaComponent(0.12).setFill()
                    cellRect.fill()
                }
                if let mask {
                    drawMask(mask.effect, in: cellRect, value: cell.value,
                             alignment: column == 0 ? .left : .right)
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
            NSColor.textBackgroundColor.setFill()
            NSBezierPath(roundedRect: targetRect, xRadius: 5, yRadius: 5).fill()
            if scope == .redacted, let mask = masks[target.key] {
                drawMask(mask.effect, in: targetRect, value: block)
            } else {
                drawText(block, in: targetRect.insetBy(dx: 8, dy: 7),
                         font: .systemFont(ofSize: 9.3), color: .labelColor)
            }
        }
    }

    private func drawMask(_ effect: ShareRedactionEffect, in rect: NSRect, value: String,
                          alignment: NSTextAlignment = .left) {
        let bar = NSRect(x: rect.minX + 6, y: rect.midY - 7,
                         width: max(0, rect.width - 12), height: 14)
        if effect == .blank {
            NSColor.black.setFill()
            NSBezierPath(roundedRect: bar, xRadius: 2, yRadius: 2).fill()
            return
        }
        // Rasterize only for this local preview. Shared pages receive safe
        // synthetic masks, never the original redacted text.
        let size = NSSize(width: rect.width, height: min(rect.height, 28))
        let text = value.isEmpty ? "Redacted content" : String(value.prefix(200))
        let key = "\(size.width):\(size.height):\(alignment.rawValue):\(text)"
        var image = blurredMasks[key]
        if image == nil {
            let original = NSImage(size: size, flipped: true) { bounds in
                let paragraph = NSMutableParagraphStyle()
                paragraph.alignment = alignment
                paragraph.lineBreakMode = .byTruncatingTail
                NSAttributedString(string: text, attributes: [
                    .font: NSFont.systemFont(ofSize: 10),
                    .foregroundColor: NSColor.labelColor,
                    .paragraphStyle: paragraph,
                ]).draw(in: NSRect(x: 6, y: bounds.midY - 7,
                                  width: max(0, bounds.width - 12), height: 14))
                return true
            }
            if let data = original.tiffRepresentation, let input = CIImage(data: data),
               let output = Self.blurContext.createCGImage(
                input.clampedToExtent().applyingGaussianBlur(sigma: 3.5).cropped(to: input.extent), from: input.extent) {
                image = NSImage(cgImage: output, size: size)
                if blurredMasks.count >= 128 { blurredMasks.removeAll() }
                blurredMasks[key] = image
            }
        }
        image?.draw(in: NSRect(x: rect.minX, y: rect.midY - size.height / 2,
                              width: size.width, height: size.height), from: .zero,
                    operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    private func drawFooter() {
        let centerY = bounds.height - footerHeight / 2
        let detail: String
        switch scope {
        case .document: detail = "Recipients can download the pinned original."
        case .indexed: detail = "Only indexed context is published."
        case .redacted: detail = masks.isEmpty ? "Select at least one area to redact." : "\(masks.count) area\(masks.count == 1 ? "" : "s") removed from the shared view."
        }
        drawSymbol("lock.shield", in: NSRect(x: 18, y: centerY - 8, width: 16, height: 16), fraction: 0.8)
        let availability = localOnly ? "Only on this Mac. Email recipients need hosted sharing." : detail
        let message = notice ?? availability
        let font = NSFont.systemFont(ofSize: 10)
        let textWidth = max(0, cancelButtonRect.minX - 56)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
        let height = min(44, ceil((message as NSString).boundingRect(
            with: NSSize(width: textWidth, height: 44), options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes).height))
        drawText(message, in: NSRect(x: 42, y: centerY - height / 2, width: textWidth, height: height),
                 font: font, color: notice == nil ? .secondaryLabelColor : .systemRed, wrap: true)

        drawButton(copyState == .copied ? "Done" : "Cancel", in: cancelButtonRect, prominent: false, enabled: true)
        let enabled = !isCopying && (scope != .redacted || !masks.isEmpty)
        let title = copyState == .copied ? "Link copied" : isCopying ? "Copying…" : actionTitle
        drawButton(title, in: actionButtonRect, prominent: true, enabled: enabled,
                   confirmed: copyState == .copied, showsShortcut: !isCopying)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        redactionDrag = nil
        notice = nil
        if NSRect(x: bounds.width - 40, y: 7, width: 30, height: 30).contains(point) {
            onCancel?(); return
        }
        if NSRect(x: 0, y: 0, width: bounds.width - 50, height: headerHeight).contains(point) {
            window?.performDrag(with: event)
            return
        }
        if cancelButtonRect.contains(point) {
            onCancel?(); return
        }
        if actionButtonRect.contains(point) {
            submit(); return
        }
        guard !isCopying else { return }
        for index in 0..<3 {
            let rect = scopeRect(index)
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
            if NSRect(x: bounds.width - 140, y: 103, width: 54, height: 24).contains(point) {
                effect = .blur; needsDisplay = true; return
            }
            if NSRect(x: bounds.width - 80, y: 103, width: 64, height: 24).contains(point) {
                effect = .blank; needsDisplay = true; return
            }
            if let target = targets.first(where: { $0.rect.contains(point) }) {
                let anchor = target.redaction(effect: effect)
                let drag = ShareRedactionDrag(anchor: anchor, masks: masks)
                redactionDrag = drag
                masks = drag.masks(through: anchor)
                needsDisplay = true
                return
            }
        }

    }

    func submit() {
        guard copyState == .idle else { return }
        guard scope != .redacted || !masks.isEmpty else {
            notice = "Select an area before creating the link."
            needsDisplay = true
            return
        }
        let redactions = scope == .redacted ? Array(masks.values) : []
        onCreate?(ShareConfiguration(scope: scope, redactions: redactions))
    }

    override func scrollWheel(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let previewRect = previewCard
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
        updateRedactionDrag(at: convert(event.locationInWindow, from: nil))
    }

    override func mouseUp(with event: NSEvent) {
        updateRedactionDrag(at: convert(event.locationInWindow, from: nil))
        redactionDrag = nil
    }

    private func updateRedactionDrag(at point: NSPoint) {
        guard !isCopying, scope == .redacted, let drag = redactionDrag else { return }
        let eligible = targets.filter {
            $0.kind == drag.anchor.kind && ($0.sheet ?? 0) == (drag.anchor.sheet ?? 0)
        }
        // Clamp to the nearest cell when the pointer leaves the table. The
        // anchor and endpoint define the range, independent of event frequency.
        func distance(to rect: NSRect) -> CGFloat {
            let dx = max(rect.minX - point.x, max(0, point.x - rect.maxX))
            let dy = max(rect.minY - point.y, max(0, point.y - rect.maxY))
            return dx * dx + dy * dy
        }
        guard let target = eligible.first(where: { $0.rect.contains(point) })
            ?? eligible.min(by: { distance(to: $0.rect) < distance(to: $1.rect) }) else { return }
        masks = drag.masks(through: target.redaction(effect: drag.anchor.effect))
        needsDisplay = true
    }

    private func drawEffectControl(_ title: String, effect option: ShareRedactionEffect, in rect: NSRect) {
        if effect == option {
            sourceColor.withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
        }
        NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
        NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).stroke()
        drawText(title, in: NSRect(x: rect.minX, y: rect.minY + 5, width: rect.width, height: 14),
                 font: .systemFont(ofSize: 9.5, weight: .medium), color: effect == option ? sourceInkColor : .secondaryLabelColor,
                 alignment: .center)
    }

    private func drawPill(_ title: String, in rect: NSRect) {
        NSColor.labelColor.withAlphaComponent(0.05).setFill()
        NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
        drawText(title, in: NSRect(x: rect.minX + 6, y: rect.minY + 4,
                                  width: rect.width - 12, height: 13),
                 font: .systemFont(ofSize: 8.7, weight: .medium), color: .secondaryLabelColor,
                 alignment: .center)
    }

    private func drawButton(_ title: String, in rect: NSRect, prominent: Bool, enabled: Bool,
                            confirmed: Bool = false, showsShortcut: Bool = true) {
        let fill = prominent
            ? (sourceColor.blended(withFraction: confirmed ? 0.45 : 0.35, of: .black) ?? sourceColor).withAlphaComponent(enabled ? 1 : 0.3)
            : sourceColor.withAlphaComponent(0.08)
        fill.setFill()
        NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8).fill()
        if !prominent {
            sourceColor.withAlphaComponent(0.3).setStroke()
            NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8).stroke()
        }
        let font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let color = prominent ? NSColor.white.withAlphaComponent(enabled ? 1 : 0.7) : sourceInkColor
        let titleSize = (title as NSString).size(withAttributes: [.font: font])
        let hasSymbol = prominent && showsShortcut
        let groupWidth = titleSize.width + (hasSymbol ? 22 : 0)
        let titleX = rect.midX - groupWidth / 2
        drawText(title, in: NSRect(x: titleX, y: rect.midY - titleSize.height / 2,
                                  width: titleSize.width + 1, height: titleSize.height), font: font, color: color)
        if hasSymbol {
            drawText(confirmed ? "✓" : "⇥", in: NSRect(x: titleX + titleSize.width + 10, y: rect.midY - titleSize.height / 2,
                                    width: 13, height: titleSize.height), font: font, color: color.withAlphaComponent(0.8))
        }
    }

    private func drawSymbol(_ name: String, in rect: NSRect, fraction: CGFloat) {
        guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil),
              let image = symbol.withSymbolConfiguration(.init(paletteColors: [sourceInkColor])) else { return }
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
