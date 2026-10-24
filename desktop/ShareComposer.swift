//  Privacy-aware source sharing.
//
//  The composer is deliberately native and non-activating so the document the
//  user is writing in keeps focus. It makes the public boundary visible before
//  a token is minted: whole document, indexed context, or a preview with safe
//  redactions selected directly with the mouse.

import Cocoa
import CoreImage
import PDFKit

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
    /// Markdown structure for each block, when the source is Markdown.
    var styles: [AssistTextBlock] = []
    var model: AssistModelPreview? = nil
    var pdf: AssistPDFPreview? = nil
    var unavailableReason: String? = nil
    /// XML reads as one section per source line, drawn like code.
    var lineLayout = false

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
        var result = ShareFullDocument(
            kind: kind, sheets: sheets,
            blocks: document["blocks"] as? [String] ?? [])
        if kind == "model-plan" {
            var drawing = document
            drawing["focusBounds"] = drawing["bounds"]
            result.model = AssistModelPreview(json: drawing)
        }
        if kind == "pdf" { result.pdf = AssistPDFPreview(json: document) }
        if document["format"] as? String == "markdown",
           let styles = document["styles"] as? [[String: Any]], styles.count == result.blocks.count {
            result.styles = styles.map(AssistTextBlock.init(markdown:))
        }
        result.unavailableReason = document["reason"] as? String
        result.lineLayout = document["format"] as? String == "lines"
        return result
    }
}

final class ShareComposerController: NSObject {
    static let shared = ShareComposerController()

    private(set) var canvasSize = NSSize(width: 760, height: 660)
    private lazy var view = ShareComposerView(frame: NSRect(origin: .zero, size: canvasSize))
    private var panel: NSPanel?
    private weak var hostPanel: NSPanel?
    private var previousContent: NSView?
    private weak var previousResponder: NSResponder?
    private var previousFrame: NSRect?
    private var previousLevel: NSWindow.Level?
    private static let sharingLevel = NSWindow.Level.popUpMenu
    private var active = false
    private var requests: [URLSessionDataTask] = []
    private var generation = 0
    private var pdfReviewGeneration = 0
    private var escapedCopies = Set<Int>()
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
        view.moveScope(delta)
    }

    func undoRedaction() { if isVisible { view.undoMaskEdit() } }
    func redoRedaction() { if isVisible { view.redoMaskEdit() } }

    func cancel() {
        hide()
        let callback = cancellation
        cancellation = nil; completion = nil
        callback?()
    }

    func dismissForEscape() {
        if active && view.isCopying { escapedCopies.insert(generation) }
        // Do not invoke a cancel callback that reopens the suggestion panel.
        cancellation = nil
        hide()
    }

    override private init() {
        super.init()
        LassoTransientUI.shared.register(self, priority: 100,
            isOpen: { [weak self] in self?.isVisible == true },
            dismiss: { [weak self] in self?.dismissForEscape() })
        LassoTransientUI.shared.start()
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
        let clipboardChange = NSPasteboard.general.changeCount
        copyAction(configuration) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                let dismissedByEscape = self.escapedCopies.remove(token) != nil
                guard dismissedByEscape || (self.active && self.generation == token) else {
                    if case .success(let share) = result {
                        ShareClient.revokeShare(serverURL: serverURL, token: share.token)
                    }
                    return
                }
                switch result {
                case .success(let share):
                    // An accepted copy still completes after dismissal, but
                    // never overwrites something copied later in another app.
                    if dismissedByEscape && NSPasteboard.general.changeCount != clipboardChange { return }
                    NSPasteboard.general.clearContents()
                    if NSPasteboard.general.setString(share.url.absoluteString, forType: .string) {
                        if !dismissedByEscape { self.view.finishCopy() }
                    } else {
                        ShareClient.revokeShare(serverURL: serverURL, token: share.token)
                        if !dismissedByEscape { self.view.finishCopy(error: "Could not copy the link. Please try again.") }
                    }
                case .failure(let error):
                    if !dismissedByEscape { self.view.finishCopy(error: error.localizedDescription) }
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
        let drawing = ["dxf", "ifc"].contains((sourcePath as NSString).pathExtension.lowercased())
        canvasSize = hostPanel.map {
            NSSize(width: max(760, $0.frame.width),
                   height: max(drawing ? 700 : 660, $0.frame.height))
        }
            ?? NSSize(width: 760, height: drawing ? 700 : 660)
        if let screen = hostPanel?.screen ?? NSScreen.main {
            canvasSize.width = min(canvasSize.width, screen.visibleFrame.width - 16)
            canvasSize.height = min(canvasSize.height, screen.visibleFrame.height - 16)
        }
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
        view.onReviewPDFExcerpt = { [weak self] excerpt in
            self?.loadPDFExcerpt(excerpt, serverURL: serverURL, token: token)
        }
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
            // Sharing sits above every other Lasso surface, such as suggestions.
            previousLevel = hostPanel.level
            if hostPanel.level.rawValue < Self.sharingLevel.rawValue { hostPanel.level = Self.sharingLevel }
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
            urlRequest.timeoutInterval = 20
            let task = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, _, _ in
                DispatchQueue.main.async {
                    guard let self, token == self.generation else { return }
                    if endpoint == "preview" {
                        self.view.preview = data.flatMap(GlobalAssistant.parsePreview)
                        self.view.citedPart = data.flatMap(Self.citedPart)
                        self.view.isLoading = false
                        self.view.keepOfferedScope()
                        self.view.initializePDFExcerpt()
                    } else {
                        self.view.fullDocument = data.flatMap(ShareFullDocument.parse)
                        self.view.isDocumentLoading = false
                        if let pdf = self.view.fullDocument?.pdf {
                            self.loadPDFDocument(pdf, serverURL: serverURL, token: token)
                        }
                    }
                    self.view.needsDisplay = true
                }
            }
            requests.append(task)
            task.resume()
        }
    }

    /// The part a cited-part link of a 3D model would publish, as the server prepared it.
    fileprivate static func citedPart(_ data: Data) -> AssistModelPreview? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let part = root["citedPart"] as? [String: Any] else { return nil }
        return AssistModelPreview(json: part)
    }

    private func loadPDFDocument(_ preview: AssistPDFPreview, serverURL: URL, token: Int) {
        guard let url = preview.sourceURL(serverURL: serverURL) else { return }
        view.isPDFLoading = true
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let document: PDFDocument?
            if let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
               let data, let parsed = PDFDocument(data: data), !parsed.isLocked, parsed.pageCount > 0 {
                document = parsed
            } else { document = nil }
            DispatchQueue.main.async {
                guard let self, token == self.generation else { return }
                self.view.loadedPDFDocument = document
                self.view.isPDFLoading = false
                self.view.initializePDFExcerpt()
                self.view.needsDisplay = true
            }
        }
        requests.append(task)
        task.resume()
    }

    private func loadPDFExcerpt(_ excerpt: SharePDFExcerpt, serverURL: URL, token: Int) {
        guard let source = view.fullDocument?.pdf?.sourceURL(serverURL: serverURL),
              var components = URLComponents(url: source, resolvingAgainstBaseURL: false) else { return }
        components.path = source.deletingLastPathComponent().appendingPathComponent("pdf-preview").path
        guard let url = components.url else { return }
        pdfReviewGeneration += 1
        let reviewToken = pdfReviewGeneration
        view.isPDFExcerptLoading = true
        view.reviewedPDFDocument = nil
        view.pdfExcerptError = nil
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["accessScope": "INDEXED", "excerpt": excerpt.payload])
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let document = (response as? HTTPURLResponse).flatMap { response in
                (200..<300).contains(response.statusCode) ? data.flatMap(PDFDocument.init(data:)) : nil
            }
            DispatchQueue.main.async {
                guard let self, token == self.generation, reviewToken == self.pdfReviewGeneration else { return }
                self.view.reviewedPDFDocument = document
                self.view.isPDFExcerptLoading = false
                self.view.pdfExcerptError = document == nil ? "The excerpt preview could not be prepared. Select the passage again." : nil
                self.view.needsDisplay = true
            }
        }
        requests.append(task)
        task.resume()
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
            if let previousLevel { hostPanel.level = previousLevel }
            hostPanel.contentView?.layoutSubtreeIfNeeded()
            hostPanel.invalidateShadow()
        } else {
            panel?.orderOut(nil)
        }
        hostPanel = nil
        previousContent = nil
        previousResponder = nil
        previousFrame = nil
        previousLevel = nil
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let created = NSPanel(contentRect: NSRect(origin: .zero, size: canvasSize),
                              styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        created.level = Self.sharingLevel
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

    #if BROWSER_GEOMETRY_TEST
    private var regressionPDFShare: String?
    private var regressionPDFError: String?

    func regressionPDFComposer(_ request: [String: Any]) -> [String: Any] {
        let action = request["action"] as? String ?? "state"
        if action == "show", let objectId = request["objectId"] as? String,
           let rawURL = request["url"] as? String, let url = URL(string: rawURL),
           let projectId = request["projectId"] as? String {
            regressionPDFShare = nil; regressionPDFError = nil
            let versionId = request["versionId"] as? String
            show(objectId: objectId, versionId: versionId, label: request["label"] as? String ?? "PDF source",
                 sourcePath: request["path"] as? String ?? "document.pdf",
                 near: NSRect(x: 200, y: 500, width: 20, height: 20), serverURL: url) { configuration in
                ShareClient.createShare(serverURL: url, projectId: projectId, objectId: objectId,
                                        versionId: versionId, configuration: configuration) { result in
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let share): self.regressionPDFShare = share.token
                        case .failure(let error): self.regressionPDFError = error.localizedDescription
                        }
                    }
                }
            }
        } else if action == "close" { hide() }
        else if action == "submit" { view.submit() }
        var state = view.regressionPDFState(request)
        state["visible"] = isVisible
        state["shareToken"] = regressionPDFShare
        state["shareError"] = regressionPDFError
        return state
    }
    #endif
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

private final class SharePDFMaskAnnotation: PDFAnnotation {
    let maskKey: String
    let effect: ShareRedactionEffect
    private static let blurContext = CIContext(options: [.cacheIntermediates: false])
    private lazy var blurredImage = Self.blurImage(size: bounds.size)

    init(bounds: NSRect, key: String, effect: ShareRedactionEffect) {
        maskKey = key
        self.effect = effect
        super.init(bounds: bounds, forType: .square, withProperties: nil)
        isReadOnly = true
        let fill = effect == .blank ? NSColor.black : NSColor.white
        color = fill
        interiorColor = fill
        border = PDFBorder()
        border?.lineWidth = 0
        shouldDisplay = true
        shouldPrint = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(with box: PDFDisplayBox, in context: CGContext) {
        drawMask(in: bounds, context: context)
    }

    func drawMask(in rect: NSRect, context: CGContext) {
        context.saveGState()
        context.clip(to: rect)
        context.setFillColor(CGColor(gray: effect == .blank ? 0.08 : 1, alpha: 1))
        context.fill(rect)
        if effect == .blur, let image = blurredImage {
            context.draw(image, in: rect)
        }
        context.restoreGState()
    }

    // Match the exported PDF's synthetic blur. Generate it once in page space
    // so zooming the PDF changes only its scale, never the mask's appearance.
    private static func blurImage(size: CGSize) -> CGImage? {
        let scale = min(2, 1024 / max(size.width, size.height))
        let width = max(1, Int(ceil(size.width * scale)))
        let height = max(1, Int(ceil(size.height * scale)))
        guard let bitmap = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        bitmap.setFillColor(CGColor(gray: 1, alpha: 1))
        bitmap.fill(CGRect(x: 0, y: 0, width: width, height: height))
        bitmap.scaleBy(x: scale, y: scale)
        let rows = max(1, Int(ceil(size.height / 17)))
        let lineHeight = size.height / CGFloat(rows)
        let strokeHeight = min(6, max(2, lineHeight * 0.4))
        let wordWidths: [CGFloat] = [1.2, 0.7, 1.65, 1, 0.85, 1.4]
        bitmap.setFillColor(CGColor(gray: 0.38, alpha: 1))
        for row in 0..<rows {
            var x: CGFloat = 3 + CGFloat(row % 2) * 2
            var word = row
            let end = size.width - 3 - CGFloat(row % 3) * min(size.width * 0.08, 18)
            while x < end {
                let markWidth = min(wordWidths[word % wordWidths.count] * lineHeight, end - x)
                bitmap.fill(CGRect(x: x, y: CGFloat(row) * lineHeight + (lineHeight - strokeHeight) / 2,
                    width: markWidth, height: strokeHeight))
                x += markWidth + max(3, lineHeight * 0.3)
                word += 1
            }
        }
        guard let source = bitmap.makeImage() else { return nil }
        let input = CIImage(cgImage: source)
        let radius = max(2, min(4, lineHeight * 0.24)) * scale
        return blurContext.createCGImage(input.clampedToExtent().applyingGaussianBlur(sigma: radius)
            .cropped(to: input.extent), from: input.extent)
    }
}

private final class SharePDFMaskOverlay: NSView {
    weak var pdfView: ShareInteractivePDFView?
    override var isFlipped: Bool { pdfView?.isFlipped ?? false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        pdfView?.drawMaskOverlay(in: context)
    }
}

private final class ShareInteractivePDFView: PDFView {
    private var scrollObserver: NSObjectProtocol?
    private lazy var maskOverlay: SharePDFMaskOverlay = {
        let overlay = SharePDFMaskOverlay(frame: bounds)
        overlay.pdfView = self
        overlay.autoresizingMask = [.width, .height]
        addSubview(overlay, positioned: .above, relativeTo: nil)
        scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self, let view = notification.object as? NSView, view.isDescendant(of: self) else { return }
            self.maskOverlay.needsDisplay = true
        }
        return overlay
    }()

    deinit { if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) } }

    func refreshMasks() {
        maskOverlay.frame = bounds
        maskOverlay.needsDisplay = true
    }

    fileprivate func drawMaskOverlay(in context: CGContext) {
        context.saveGState()
        if let clip = documentView?.enclosingScrollView?.contentView {
            context.clip(to: convert(clip.bounds, from: clip))
        }
        for page in visiblePages {
            for annotation in page.annotations.compactMap({ $0 as? SharePDFMaskAnnotation }) {
                annotation.drawMask(in: convert(annotation.bounds, from: page), context: context)
            }
        }
        if let draft, let page = start?.page {
            let rect = convert(draft.bounds, from: page)
            context.setFillColor(NSColor.systemBlue.withAlphaComponent(0.18).cgColor)
            context.fill(rect)
            context.setStrokeColor(NSColor.systemBlue.cgColor)
            context.stroke(rect, width: 1)
        }
        context.restoreGState()
    }
    enum SelectionMode { case read, text, area }
    var selectionMode: SelectionMode = .read
    var onTextSelection: ((PDFSelection) -> Void)?
    var onAreaSelection: ((PDFPage, NSRect) -> Void)?
    var onMaskClick: ((PDFPage, NSPoint) -> Bool)?
    private var start: (page: PDFPage, point: NSPoint, viewPoint: NSPoint)?
    private var draft: PDFAnnotation?

    func cancelInteraction() {
        if let draft, let page = start?.page { page.removeAnnotation(draft); annotationsChanged(on: page) }
        draft = nil
        start = nil
        clearSelection()
        refreshMasks()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func scrollWheel(with event: NSEvent) {
        if let scroll = documentView?.enclosingScrollView { scroll.scrollWheel(with: event) }
        else { super.scrollWheel(with: event) }
        refreshMasks()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        guard selectionMode != .read, let hit else { return hit }
        var candidate: NSView? = hit
        while let view = candidate, view !== self {
            if view is NSScroller { return hit }
            candidate = view.superview
        }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        guard selectionMode != .read else { super.mouseDown(with: event); return }
        let point = convert(event.locationInWindow, from: nil)
        guard let page = page(for: point, nearest: false) else { return }
        let pagePoint = convert(point, to: page)
        if onMaskClick?(page, pagePoint) == true { return }
        clearSelection()
        start = (page, pagePoint, point)
        if selectionMode == .text, event.clickCount >= 2 {
            let selection = event.clickCount >= 3 ? page.selectionForLine(at: pagePoint) : page.selectionForWord(at: pagePoint)
            setCurrentSelection(selection, animate: false)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        _ = documentView?.autoscroll(with: event)
        let point = convert(event.locationInWindow, from: nil)
        if selectionMode == .text, let endPage = page(for: point, nearest: true), let document {
            setCurrentSelection(document.selection(from: start.page, at: start.point,
                                                   to: endPage, at: convert(point, to: endPage)), animate: false)
        } else if selectionMode == .area {
            let end = convert(point, to: start.page)
            let area = NSRect(x: min(start.point.x, end.x), y: min(start.point.y, end.y),
                              width: abs(end.x - start.point.x), height: abs(end.y - start.point.y))
                .intersection(start.page.bounds(for: .cropBox))
            if let draft { start.page.removeAnnotation(draft) }
            let annotation = PDFAnnotation(bounds: area, forType: .square, withProperties: nil)
            annotation.color = .systemBlue
            annotation.interiorColor = NSColor.systemBlue.withAlphaComponent(0.18)
            start.page.addAnnotation(annotation)
            annotationsChanged(on: start.page)
            draft = annotation
            refreshMasks()
            needsDisplay = true
        }
    }

    override func mouseUp(with event: NSEvent) {
        guard let start else { return }
        self.start = nil
        if let draft {
            let rect = draft.bounds
            start.page.removeAnnotation(draft)
            annotationsChanged(on: start.page)
            self.draft = nil
            refreshMasks()
            let visible = convert(rect, from: start.page)
            if visible.width >= 3, visible.height >= 3 { onAreaSelection?(start.page, rect) }
        } else if selectionMode == .text, let selection = currentSelection,
                  selection.string?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            onTextSelection?(selection)
        }
    }
}

private final class SharePreviewCanvas: NSView {
    weak var composer: ShareComposerView?
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) { composer?.drawScrollablePreview(dirtyRect) }
    override func mouseDown(with event: NSEvent) { composer?.previewMouseDown(at: convert(event.locationInWindow, from: nil)) }
    override func mouseDragged(with event: NSEvent) {
        _ = autoscroll(with: event)
        composer?.previewMouseDragged(at: convert(event.locationInWindow, from: nil))
    }
    override func mouseUp(with event: NSEvent) { composer?.previewMouseUp(at: convert(event.locationInWindow, from: nil)) }
}

final class ShareComposerView: NSView {
    private enum CopyState { case idle, copying, copied }
    private var copyState: CopyState = .idle
    var isCopying: Bool { copyState == .copying }
    var actionTitle = "Copy link"
    var sourceColor: NSColor = .controlAccentColor { didSet { needsDisplay = true } }
    var localOnly = true
    var scope: ShareAccessScope = .indexed {
        didSet {
            if scope != oldValue {
                pdfView.cancelInteraction()
                redactionDrag = nil
                drawingDrag = nil
                // Each scope shows its own model, which starts as sent.
                modelView = AssistModelView()
                modelDrag = nil
                targets.removeAll()
                clearCopyConfirmation()
            }
        }
    }
    var preview: AssistDocumentPreview? { didSet { previewRevision += 1; targets.removeAll() } }
    /// What "Cited part only" publishes for a 3D CAD model: the cited part
    /// alone, its feature marked. Nil when the citation names no single part.
    var citedPart: AssistModelPreview?
    var fullDocument: ShareFullDocument? { didSet { previewRevision += 1; targets.removeAll() } }
    var isLoading = true
    var isDocumentLoading = true
    var isPDFLoading = false
    var loadedPDFDocument: PDFDocument?
    var onReviewPDFExcerpt: ((SharePDFExcerpt) -> Void)?
    var reviewedPDFDocument: PDFDocument?
    var isPDFExcerptLoading = false
    var pdfExcerptError: String?
    var onCancel: (() -> Void)?
    var onCreate: ((ShareConfiguration) -> Void)?

    private var label = ""
    private var filename = ""
    private var effect: ShareRedactionEffect = .blur
    private var masks: [String: ShareRedaction] = [:] {
        didSet { if masks != oldValue { clearCopyConfirmation() } }
    }
    private var history = ShareMaskHistory()
    /// The masks when the drag or click being made began.
    private var gestureMasks: [String: ShareRedaction]?
    private var targets: [ShareHitTarget] = []
    private var sheetTabTargets: [(rect: NSRect, index: Int)] = []
    private var sheetIndex = 0
    private var previewRevision = 0
    private var scrollLayoutKey = ""
    private var scrollRows: [[String]] = []
    private var scrollColumns: [String] = []
    private var scrollRowNumbers: [String] = []
    private var scrollHeaders: [String]?
    private var scrollCitations = Set<String>()
    private var scrollBlocks: [String] = []
    private var scrollStyles: [AssistTextBlock] = []
    private var scrollStyledText: [NSAttributedString] = []
    private var scrollColumnWidths: [CGFloat] = []
    private var scrollRowHeights: [CGFloat] = []
    private var scrollBlockHeights: [CGFloat] = []
    private var scrollLines = false
    private var scrollBlockGap: CGFloat { scrollLines ? 2 : 8 }
    private var scrollRedactionSheet: Int?
    private var scrollCanRedact = false
    private var showsScrollablePreview = false
    private var showsPDFPreview = false
    private var pdfSelectionMode: ShareInteractivePDFView.SelectionMode = .text {
        didSet { if oldValue != pdfSelectionMode { pdfView.cancelInteraction() } }
    }
    private var pdfExcerpt: SharePDFExcerpt?
    private var isChoosingPDFExcerpt = true
    private var initializedPDFExcerpt = false
    private var pdfMaskLayoutKey = ""
    private var pdfSourceDestination: PDFDestination?
    private lazy var pdfView: ShareInteractivePDFView = {
        let view = ShareInteractivePDFView(frame: .zero)
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displaysPageBreaks = true
        view.backgroundColor = .underPageBackgroundColor
        view.setAccessibilityLabel("PDF page preview")
        view.isHidden = true
        view.onTextSelection = { [weak self] in self?.selectPDFText($0) }
        view.onAreaSelection = { [weak self] in self?.selectPDFArea(page: $0, rect: $1) }
        view.onMaskClick = { [weak self] in self?.removePDFMask(page: $0, point: $1) ?? false }
        addSubview(view)
        return view
    }()
    private let scrollFont = NSFont.systemFont(ofSize: 11)
    private let scrollLineFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    private lazy var previewCanvas: SharePreviewCanvas = {
        let canvas = SharePreviewCanvas(frame: .zero)
        canvas.composer = self
        return canvas
    }()
    private lazy var previewScroll: NSScrollView = {
        let scroll = NSScrollView(frame: .zero)
        scroll.borderType = .noBorder
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 7
        scroll.layer?.masksToBounds = true
        scroll.layer?.borderWidth = 1
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = false
        scroll.scrollerStyle = .legacy
        scroll.documentView = previewCanvas
        scroll.isHidden = true
        addSubview(scroll)
        return scroll
    }()
    private var redactionDrag: ShareRedactionDrag?
    private var drawingLayout: ShareDrawingLayout?
    private var drawingDrag: (start: NSPoint, masks: [String: ShareRedaction], effect: ShareRedactionEffect)?
    /// A STEP model turns and zooms here as it does in the card and the inspector.
    private(set) var modelView = AssistModelView()
    private var modelDrag: (start: NSPoint, view: AssistModelView)?
    /// The rotatable model drawn last, and where.
    private var shownModel: (model: AssistModelPreview, rect: NSRect)?
    private var notice: String?

    private let headerHeight: CGFloat = 42
    private let footerHeight: CGFloat = 68
    // The server ends every share link 48 hours after it is created.
    private static let linkLifetimeNote = "Link expires in 48 hours."
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

    private var isPDFSource: Bool { (filename as NSString).pathExtension.lowercased() == "pdf" || fullDocument?.kind == "pdf" }
    private var sourceKind: ShareSourceKind { ShareSourceKind(filename: filename) }
    private var isCADModel: Bool { sourceKind == .cadModel }
    private var isPresentation: Bool { sourceKind == .presentation }

    /// The scopes this source offers. A model's cited part, or a deck's cited
    /// slide, is offered while its preview loads, so the protective choice
    /// stays selected meanwhile.
    var scopes: [ShareAccessScope] {
        let cited = isPresentation ? preview?.slideNumber != nil : citedPart != nil
        return ShareAccessScope.offered(for: sourceKind, hasCitedPart: cited || isLoading)
    }

    /// Once the preview shows the citation names no part, only what is offered stays chosen.
    func keepOfferedScope() {
        if !scopes.contains(scope) { scope = scopes[0] }
        needsDisplay = true
    }

    func moveScope(_ delta: Int) {
        let offered = scopes
        let index = offered.firstIndex(of: scope) ?? 0
        scope = offered[(index + delta + offered.count) % offered.count]
        needsDisplay = true
    }

    private var canSubmit: Bool {
        guard !isCopying else { return false }
        if scope == .redacted { return !masks.isEmpty }
        if scope == .indexed && isPDFSource {
            return pdfExcerpt != nil && reviewedPDFDocument != nil && !isPDFExcerptLoading
        }
        return true
    }

    private var previewCard: NSRect {
        NSRect(x: 16, y: 132, width: bounds.width - 32,
               height: bounds.height - footerHeight - 146)
    }

    private func scopeRect(_ index: Int) -> NSRect {
        let count = CGFloat(scopes.count)
        let width = (bounds.width - 32 - 6 * (count - 1)) / count
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
        case 53: LassoTransientUI.shared.dismissAll()
        case 48 where event.modifierFlags.contains(.shift): super.keyDown(with: event)
        case 48, 36, 76: submit()
        case 123, 124, 125, 126:
            guard !isCopying else { return }
            moveScope([123, 126].contains(event.keyCode) ? -1 : 1)
        default: super.keyDown(with: event)
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        blurredMasks.removeAll()
        needsDisplay = true
    }

    func reset(label: String, filename: String) {
        pdfView.cancelInteraction()
        self.label = label
        self.filename = filename.isEmpty ? "Indexed source" : filename
        scope = .indexed
        localOnly = true
        copyState = .idle
        effect = .blur
        modelView = AssistModelView()
        modelDrag = nil
        masks.removeAll()
        history.clear()
        gestureMasks = nil
        citedPart = nil
        blurredMasks.removeAll()
        redactionDrag = nil
        drawingDrag = nil
        drawingLayout = nil
        preview = nil
        fullDocument = nil
        isLoading = true
        isDocumentLoading = true
        isPDFLoading = false
        loadedPDFDocument = nil
        pdfView.document = nil
        pdfView.isHidden = true
        reviewedPDFDocument = nil
        isPDFExcerptLoading = false
        pdfExcerptError = nil
        pdfExcerpt = nil
        pdfSelectionMode = .text
        isChoosingPDFExcerpt = true
        initializedPDFExcerpt = false
        pdfMaskLayoutKey = ""
        pdfSourceDestination = nil
        sheetIndex = 0
        scrollLayoutKey = ""
        targets.removeAll()
        previewScroll.isHidden = true
        previewScroll.contentView.scroll(to: .zero)
        notice = nil
        needsDisplay = true
    }

    func beginCopy() {
        pdfView.cancelInteraction()
        copyState = .copying
        redactionDrag = nil
        drawingDrag = nil
        endMaskEdit()
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
        showsScrollablePreview = false
        showsPDFPreview = false
        sheetTabTargets.removeAll()
        drawingLayout = nil
        shownModel = nil
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
        previewScroll.isHidden = !showsScrollablePreview
        pdfView.isHidden = !showsPDFPreview
        if !showsScrollablePreview { targets.removeAll() }
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
        drawText(filename, in: NSRect(x: 18, y: 13, width: bounds.width - 65, height: 19),
                 font: .systemFont(ofSize: 13, weight: .semibold), color: .labelColor)
        drawSymbol("xmark", in: NSRect(x: bounds.width - 30, y: 16, width: 11, height: 11), fraction: 1,
                   color: .secondaryLabelColor)
    }

    private func drawScopes() {
        let entries: [(ShareAccessScope, String, String)] = scopes.map { scope in
            switch scope {
            case .document: return (scope, isPresentation ? "Entire presentation" : "Entire document",
                                    isPresentation ? "Every slide, and the original file" : "Include the original file")
            case .indexed: return (scope, isPresentation ? "Cited slide only" : "Cited part only",
                                   isCADModel ? "The part, its feature marked"
                                   : isPresentation ? "This slide, without notes or comments" : "Share the matched context")
            case .redacted: return (scope, "Select & redact", "Hide source content")
            }
        }
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
            drawText(entry.1, in: NSRect(x: row.minX + 31, y: row.minY + 7, width: row.width - 40, height: 18),
                     font: .systemFont(ofSize: 12, weight: .medium), color: scope == entry.0 ? sourceInkColor : .labelColor)
            drawText(entry.2, in: NSRect(x: row.minX + 31, y: row.minY + 26, width: row.width - 40, height: 15),
                     font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor)
        }
    }

    private func drawPreview() {
        // Resolved while drawing, so the frame follows light and dark appearance.
        previewScroll.layer?.borderColor = NSColor.separatorColor.cgColor
        let x: CGFloat = 16
        let isPDF = isPDFSource
        drawText(scope == .indexed ? (isPDF && isChoosingPDFExcerpt ? "Select excerpt" : "Recipient preview") : "Complete document",
                 in: NSRect(x: x + 2, y: 108, width: 170, height: 16),
                 font: .systemFont(ofSize: 11, weight: .semibold), color: .secondaryLabelColor)

        if scope == .redacted {
            drawSegmentedControl([("Blur", effect == .blur, blurEffectRect), ("Redact", effect == .blank, redactEffectRect)])
        } else {
            let badge = scope == .document ? "Original available" : "Original protected"
            drawPill(badge, in: NSRect(x: bounds.width - 125, y: 105, width: 109, height: 20))
        }
        if isPDF && (scope == .redacted || (scope == .indexed && isChoosingPDFExcerpt)) {
            drawButton("Select text", in: pdfTextModeRect, prominent: pdfSelectionMode == .text, enabled: !isCopying, showsShortcut: false)
            drawButton("Mark area", in: pdfAreaModeRect, prominent: pdfSelectionMode == .area, enabled: !isCopying, showsShortcut: false)
        }

        let card = previewCard
        NSColor.controlBackgroundColor.withAlphaComponent(0.65).setFill()
        NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).fill()
        NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
        NSBezierPath(roundedRect: card, xRadius: 10, yRadius: 10).stroke()

        drawText(label, in: NSRect(x: card.minX + 13, y: card.minY + 12,
                                  width: card.width - 26 - (isPDF && scope == .indexed && pdfExcerpt != nil ? 124 : 0), height: 17),
                 font: .systemFont(ofSize: 12.5, weight: .semibold), color: .labelColor)
        let drawing = fullDocument?.model != nil
        let subtitle = scope == .redacted ? (drawing || isPDF ? "Drag over text or mark an area. Click a mask to remove it." : "Drag across cells or sections to blur or redact.") : scope == .indexed && isPDF
            ? (isChoosingPDFExcerpt ? "Select the words, sentence, paragraph or area to share." : "Only the selected excerpt will be shared.") : scope == .indexed
            ? (citedPart.map(\.selectedLabel) ?? (preview?.location.isEmpty == false ? preview!.location : filename))
            : "Complete \(filename)"
        drawText(subtitle, in: NSRect(x: card.minX + 13, y: card.minY + 31,
                                     width: card.width - 26, height: 15),
                 font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor)
        if isPDF && scope == .indexed && pdfExcerpt != nil {
            drawButton(isChoosingPDFExcerpt ? "Review excerpt" : "Change selection", in: pdfExcerptToggleRect,
                       prominent: false, enabled: !isCopying)
        }

        let content = NSRect(x: card.minX + 13, y: card.minY + 55,
                             width: card.width - 26, height: card.height - 68)
        if isPDF {
            drawPDFContent(in: content)
        } else if scope != .indexed {
            if isDocumentLoading {
                drawCentered("Loading complete document…", in: content)
            } else if let fullDocument {
                drawFullDocument(fullDocument, in: content)
            } else {
                drawCentered("Complete document preview unavailable", in: content)
            }
        } else if isCADModel, let citedPart {
            drawRotatable(citedPart, in: content)
        } else if isPresentation, let preview, !preview.textBlocks.isEmpty {
            // The whole cited slide is what the recipient gets, with the cited passage marked.
            AssistMarkdown.draw(preview.textBlocks, in: content, accent: sourceColor, baseSize: 11.5)
        } else if isLoading {
            drawCentered("Loading source preview…", in: content)
        } else if let preview, !preview.rows.isEmpty {
            drawTable(preview, in: content)
        } else if let preview, preview.model != nil {
            let context = [preview.valueText, preview.context].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
            drawTextBlocks(context, in: NSRect(x: content.minX, y: content.minY, width: content.width, height: max(50, content.height - 48)))
            drawText("Choose Entire document or Select & redact to include the drawing.",
                     in: NSRect(x: content.minX + 4, y: content.maxY - 38, width: content.width - 8, height: 34),
                     font: .systemFont(ofSize: 10), color: .secondaryLabelColor, wrap: true)
        } else if let preview {
            // The indexed scope publishes the object's recorded excerpt, so
            // that is what the recipient preview shows.
            let excerpt = preview.valueText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            drawTextBlocks(excerpt.isEmpty ? preview.context : excerpt, in: content)
        } else {
            drawCentered("Preview unavailable", in: content)
        }

    }

    private func drawCentered(_ value: String, in rect: NSRect) {
        drawText(value, in: NSRect(x: rect.minX + 8, y: rect.midY - 20,
                                   width: max(0, rect.width - 16), height: 44),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor, alignment: .center, wrap: true)
    }

    private func drawFullDocument(_ document: ShareFullDocument, in rect: NSRect) {
        if let model = document.model, model.orbit != nil, scope != .redacted {
            drawRotatable(model, in: rect)
        } else if let model = document.model {
            AssistModelRenderer.draw(model, in: rect)
            drawingLayout = ShareDrawingLayout(model: model, in: rect)
            if scope == .redacted, let layout = drawingLayout {
                NSGraphicsContext.current?.saveGraphicsState()
                NSBezierPath(rect: layout.frame).addClip()
                for mask in masks.values where mask.kind == "DRAWING" {
                    if let area = layout.rect(for: mask) { drawDrawingMask(mask.effect, in: area) }
                }
                NSGraphicsContext.current?.restoreGraphicsState()
            }
        } else if document.kind == "table", !document.sheets.isEmpty {
            sheetIndex = min(max(0, sheetIndex), document.sheets.count - 1)
            drawFullTable(document.sheets[sheetIndex], sheetCount: document.sheets.count, in: rect)
        } else if document.kind == "text", !document.blocks.isEmpty {
            drawFullText(document.blocks, styles: document.styles, lines: document.lineLayout, in: rect)
        } else {
            drawCentered(document.unavailableReason ?? "This document has no previewable content", in: rect)
        }
    }

    private func drawRotatable(_ model: AssistModelPreview, in rect: NSRect) {
        AssistModelRenderer.draw(model, in: rect, view: model.orbit == nil ? nil : modelView)
        if model.orbit != nil { shownModel = (model, rect) }
    }

    /// The model under `point`, if it can be turned there.
    private func rotatableModel(at point: NSPoint) -> AssistModelPreview? {
        guard !isCopying, let shownModel, shownModel.rect.contains(point) else { return nil }
        return shownModel.model
    }

    private func zoomModel(by factor: CGFloat, at point: NSPoint) -> Bool {
        guard let model = rotatableModel(at: point), let rect = shownModel?.rect else { return false }
        modelView = modelView.zoomed(by: factor, within: AssistModelRenderer.zoomRange(for: model, in: rect))
        needsDisplay = true
        return true
    }

    private var blurEffectRect: NSRect { NSRect(x: bounds.width - 136, y: 103, width: 60, height: 24) }
    private var redactEffectRect: NSRect { NSRect(x: bounds.width - 76, y: 103, width: 60, height: 24) }

    private var pdfTextModeRect: NSRect { NSRect(x: 200, y: 103, width: 78, height: 24) }
    private var pdfAreaModeRect: NSRect { NSRect(x: 284, y: 103, width: 78, height: 24) }
    private var pdfExcerptToggleRect: NSRect {
        NSRect(x: previewCard.maxX - 124, y: previewCard.minY + 12, width: 110, height: 22)
    }

    private func drawPDFContent(in rect: NSRect) {
        syncPDFMasks()
        if scope == .indexed && !isChoosingPDFExcerpt {
            if let reviewedPDFDocument {
                pdfView.selectionMode = .read
                drawFullPDF(reviewedPDFDocument, page: 1, in: rect)
            } else {
                drawCentered(isPDFExcerptLoading ? "Preparing selected excerpt…" : pdfExcerptError ?? "Select an excerpt to review.", in: rect)
            }
            return
        }
        guard let document = loadedPDFDocument else {
            drawCentered(isDocumentLoading || isPDFLoading ? "Loading PDF pages…" : "PDF pages could not be loaded. Reopen this source to try again.", in: rect)
            return
        }
        pdfView.selectionMode = scope == .document || isCopying ? .read : pdfSelectionMode
        drawFullPDF(document, page: fullDocument?.pdf?.pageNumber ?? 1, in: rect)
    }

    private func drawFullPDF(_ document: PDFDocument, page: Int, in rect: NSRect) {
        showsPDFPreview = true
        pdfView.frame = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: max(0, rect.height - 20))
        if pdfView.document !== document {
            if pdfView.document === loadedPDFDocument { pdfSourceDestination = pdfView.currentDestination }
            pdfView.cancelInteraction()
            pdfView.document = document
            pdfView.autoScales = true
            if document === loadedPDFDocument, let destination = pdfSourceDestination {
                pdfView.go(to: destination)
            } else if let selected = document.page(at: min(max(0, page - 1), document.pageCount - 1)) {
                pdfView.go(to: selected)
            }
        }
        let detail = scope == .indexed ? (isChoosingPDFExcerpt ? "Select text or mark an area · Scroll for more pages" : "Selected excerpt · Original page layout")
            : scope == .redacted ? "\(masks.count) area\(masks.count == 1 ? "" : "s") hidden · Scroll for more pages" : "Original PDF layout · Scroll to read"
        drawText("\(document.pageCount) \(document.pageCount == 1 ? "page" : "pages") · \(detail)",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - 15, width: rect.width - 4, height: 14),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
    }

    func initializePDFExcerpt() {
        guard !initializedPDFExcerpt, let document = loadedPDFDocument,
              let preview = preview?.pdf, !preview.selectedText.isEmpty else { return }
        let pages = [min(preview.pageNumber - 1, document.pageCount - 1)]
            + (0..<document.pageCount).filter { $0 != preview.pageNumber - 1 }
        let direct = document.findString(preview.selectedText, withOptions: [.caseInsensitive])
        if let selection = direct.first(where: { $0.pages.contains { document.index(for: $0) == pages[0] } }) ?? direct.first {
            initializedPDFExcerpt = true
            selectPDFText(selection, asExcerpt: true)
            return
        }
        let pattern = preview.selectedText.split(whereSeparator: { $0.isWhitespace })
            .map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: "\\s+")
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return }
        for index in pages {
            guard let page = document.page(at: index), let text = page.string,
                  let match = expression.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)),
                  let selection = page.selection(for: match.range) else { continue }
            initializedPDFExcerpt = true
            selectPDFText(selection, asExcerpt: true)
            return
        }
    }

    private func selectPDFText(_ selection: PDFSelection, asExcerpt: Bool = false) {
        guard let document = loadedPDFDocument else { return }
        var regions: [SharePDFRegion] = []
        for line in selection.selectionsByLine() {
            for page in line.pages {
                if let region = SharePDFRegion(page: document.index(for: page) + 1,
                    rect: line.bounds(for: page).insetBy(dx: -0.7, dy: -0.7), crop: page.bounds(for: .cropBox)),
                   !regions.contains(region) { regions.append(region) }
            }
        }
        applyPDFSelection(text: selection.string ?? "", regions: regions, asExcerpt: asExcerpt)
    }

    private func selectPDFArea(page: PDFPage, rect: NSRect) {
        guard let document = loadedPDFDocument,
              let region = SharePDFRegion(page: document.index(for: page) + 1, rect: rect, crop: page.bounds(for: .cropBox)) else { return }
        applyPDFSelection(text: page.selection(for: rect)?.string ?? "", regions: [region])
    }

    private func applyPDFSelection(text: String, regions: [SharePDFRegion], asExcerpt: Bool = false) {
        guard !isCopying, !regions.isEmpty else { return }
        guard regions.count <= 512 else {
            notice = "Select a shorter excerpt with up to 512 lines or areas."
            needsDisplay = true
            return
        }
        if scope == .indexed || asExcerpt {
            let excerpt = SharePDFExcerpt(text: text, regions: regions)
            pdfExcerpt = excerpt
            initializedPDFExcerpt = true
            isChoosingPDFExcerpt = false
            clearCopyConfirmation()
            onReviewPDFExcerpt?(excerpt)
        } else if scope == .redacted {
            guard masks.count + regions.count <= 512 else {
                notice = "Use up to 512 areas. Click an existing mask to remove it."
                needsDisplay = true
                return
            }
            beginMaskEdit()
            for region in regions {
                let mask = region.redaction(effect: effect)
                masks[mask.locationKey] = mask
            }
            endMaskEdit()
            pdfView.clearSelection()
        }
        notice = nil
        needsDisplay = true
    }

    private func removePDFMask(page: PDFPage, point: NSPoint) -> Bool {
        guard scope == .redacted, !isCopying,
              let annotation = page.annotations.compactMap({ $0 as? SharePDFMaskAnnotation }).first(where: { $0.bounds.contains(point) }) else { return false }
        beginMaskEdit()
        masks.removeValue(forKey: annotation.maskKey)
        endMaskEdit()
        needsDisplay = true
        return true
    }

    private func syncPDFMasks() {
        guard let document = loadedPDFDocument else { return }
        let key = "\(ObjectIdentifier(document)):\(scope.rawValue):"
            + masks.values.sorted { $0.locationKey < $1.locationKey }.map { "\($0.locationKey):\($0.effect.rawValue)" }.joined(separator: "|")
        guard key != pdfMaskLayoutKey else { return }
        pdfMaskLayoutKey = key
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            for annotation in page.annotations where annotation is SharePDFMaskAnnotation { page.removeAnnotation(annotation) }
            guard scope == .redacted else { pdfView.annotationsChanged(on: page); continue }
            let crop = page.bounds(for: .cropBox)
            for mask in masks.values where mask.kind == "PDF" && mask.page == index + 1 {
                guard let x = mask.x, let y = mask.y, let width = mask.width, let height = mask.height else { continue }
                let rect = NSRect(x: crop.minX + CGFloat(x) * crop.width, y: crop.maxY - CGFloat(y + height) * crop.height,
                                  width: CGFloat(width) * crop.width, height: CGFloat(height) * crop.height)
                page.addAnnotation(SharePDFMaskAnnotation(bounds: rect, key: mask.locationKey, effect: mask.effect))
            }
            pdfView.annotationsChanged(on: page)
        }
        pdfView.needsDisplay = true
        pdfView.refreshMasks()
    }

    private func drawDrawingMask(_ effect: ShareRedactionEffect, in rect: NSRect) {
        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(rect: rect).addClip()
        if effect == .blank {
            NSColor.black.setFill()
            rect.fill()
        } else {
            // Synthetic blurred marks match the published preview. No source
            // pixels or text are carried in a recipient's blurred region.
            NSColor(calibratedWhite: 0.84, alpha: 1).setFill()
            rect.fill()
            let image = NSImage(size: NSSize(width: 80, height: 50), flipped: true) { _ in
                NSColor(calibratedWhite: 0.45, alpha: 1).setFill()
                for index in 0..<4 {
                    NSRect(x: 8 + CGFloat(index % 2) * 7, y: 6 + CGFloat(index) * 11,
                           width: index % 2 == 0 ? 62 : 46, height: 5).fill()
                }
                return true
            }
            if let data = image.tiffRepresentation, let input = CIImage(data: data),
               let output = Self.blurContext.createCGImage(input.applyingGaussianBlur(sigma: 4).cropped(to: input.extent), from: input.extent) {
                NSImage(cgImage: output, size: image.size).draw(in: rect, from: .zero,
                    operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        }
        NSGraphicsContext.current?.restoreGraphicsState()
        sourceColor.withAlphaComponent(0.8).setStroke()
        let border = NSBezierPath(rect: rect)
        border.lineWidth = 1
        border.stroke()
    }

    private func drawFullTable(_ sheet: ShareFullSheet, sheetCount: Int, in rect: NSRect) {
        let tabHeight: CGFloat = sheetCount > 1 ? 27 : 0
        if sheetCount > 1, let document = fullDocument {
            drawSheetTabs(document.sheets, in: NSRect(
                x: rect.minX, y: rect.minY, width: rect.width, height: tabHeight))
        }
        let columns = max(1, sheet.rows.map(\.count).max() ?? 1)
        configureScrollableTable(rows: sheet.rows,
            columns: (0..<columns).map(spreadsheetColumn),
            rowNumbers: sheet.rows.indices.map { String($0 + 1) },
            headers: nil, citations: [], redactionSheet: sheetIndex,
            in: NSRect(x: rect.minX, y: rect.minY + tabHeight,
                       width: rect.width, height: max(30, rect.height - tabHeight - 21)),
            key: "full:\(sheetIndex)")
        drawText("\(sheet.rows.count) rows · \(columns) columns · Scroll to review every cell",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - 16, width: rect.width - 4, height: 14),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
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
            drawSymbol("chevron.left", in: previous, color: sourceInkColor)
            drawSymbol("chevron.right", in: next, color: sourceInkColor)
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
                     font: .systemFont(ofSize: 10, weight: index == sheetIndex ? .semibold : .regular),
                     color: index == sheetIndex ? sourceInkColor : .secondaryLabelColor,
                     alignment: .center)
            sheetTabTargets.append((tab, index))
        }
    }

    private func drawFullText(_ blocks: [String], styles: [AssistTextBlock], lines: Bool, in rect: NSRect) {
        configureScrollableText(blocks, styles: styles,
            in: NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: max(30, rect.height - 21)),
            canRedact: true, key: "full-text", lines: lines)
        drawText("\(blocks.count) \(lines ? "lines" : "sections") · Scroll to read the complete document",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - 16, width: rect.width - 4, height: 14),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
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
        let columnCount = max(1, max(preview.headers.count,
            preview.rows.map { $0.cells.count }.max() ?? 1))
        let columns = (0..<columnCount).map { index in
            index < preview.columns.count ? preview.columns[index] : spreadsheetColumn(index)
        }
        var citations = Set<String>()
        for (rowIndex, row) in preview.rows.enumerated() {
            for (columnIndex, cell) in row.cells.enumerated() where cell.cited {
                citations.insert("\(rowIndex):\(columnIndex)")
            }
        }
        configureScrollableTable(rows: preview.rows.map { $0.cells.map(\.value) },
            columns: columns, rowNumbers: preview.rows.map { $0.rowNumber.map(String.init) ?? "" },
            headers: preview.headers, citations: citations, redactionSheet: nil,
            in: NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: max(30, rect.height - 21)),
            key: "indexed-table")
        drawText("\(preview.rows.count) context rows · \(columnCount) columns · Scroll to review every cell",
                 in: NSRect(x: rect.minX + 2, y: rect.maxY - 16, width: rect.width - 4, height: 14),
                 font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
    }

    private func drawTextBlocks(_ value: String, in rect: NSRect) {
        let text = value.isEmpty ? "Indexed source context" : value
        configureScrollableText([text],
                                styles: isMarkdownSource ? [AssistTextBlock(type: "paragraph", text: text)] : [],
                                in: rect, canRedact: false, key: "indexed-text")
    }

    private var isMarkdownSource: Bool {
        ["md", "mdx", "qmd", "rmd"].contains((filename as NSString).pathExtension.lowercased())
    }

    private func textHeight(_ text: String, width: CGFloat, font: NSFont? = nil) -> CGFloat {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let measured = (text.isEmpty ? " " : text) as NSString
        return ceil(measured.boundingRect(with: NSSize(width: max(1, width), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font ?? scrollFont, .paragraphStyle: paragraph]).height) + 2
    }

    private func configureScrollableTable(rows: [[String]], columns: [String], rowNumbers: [String],
                                          headers: [String]?, citations: Set<String>, redactionSheet: Int?,
                                          in rect: NSRect, key: String) {
        showsScrollablePreview = true
        let scroll = previewScroll
        scroll.isHidden = false
        scroll.hasHorizontalScroller = true
        scroll.frame = rect
        scroll.tile()
        let key = "\(key):\(previewRevision):\(scope.rawValue):\(rect.width):\(rect.height)"
        if scrollLayoutKey != key {
            scrollLayoutKey = key
            targets.removeAll()
            redactionDrag = nil
            scrollRows = rows
            scrollColumns = columns
            scrollStyles = []
            scrollStyledText = []
            scrollRowNumbers = rowNumbers
            scrollHeaders = headers
            scrollCitations = citations
            scrollBlocks = []
            scrollRedactionSheet = redactionSheet
            scrollCanRedact = redactionSheet != nil
            let viewport = scroll.contentSize
            let rowHeader: CGFloat = 34
            scrollColumnWidths = columns.indices.map { index in
                var natural = (columns[index] as NSString).size(withAttributes: [.font: scrollFont]).width
                if let headers, index < headers.count {
                    natural = max(natural, (headers[index] as NSString).size(withAttributes: [.font: scrollFont]).width)
                }
                for row in rows where index < row.count {
                    // A sensible maximum width keeps paragraphs readable. Height
                    // grows to display every character instead of truncating it.
                    natural = max(natural, min(260, (row[index] as NSString).size(withAttributes: [.font: scrollFont]).width))
                }
                return min(280, max(110, natural + 18))
            }
            let naturalWidth = rowHeader + scrollColumnWidths.reduce(0, +)
            if naturalWidth < viewport.width, !scrollColumnWidths.isEmpty {
                let extra = (viewport.width - naturalWidth) / CGFloat(scrollColumnWidths.count)
                scrollColumnWidths = scrollColumnWidths.map { $0 + extra }
            }
            var headerHeight: CGFloat = 28
            if let headers {
                headerHeight = max(headerHeight, (columns.indices.map { index in
                    textHeight(index < headers.count ? headers[index] : columns[index],
                               width: scrollColumnWidths[index] - 16,
                               font: .systemFont(ofSize: 11, weight: .semibold))
                }.max() ?? 14) + 16)
            }
            scrollRowHeights = [headerHeight] + rows.map { row in
                max(30, (columns.indices.map { index in
                    textHeight(index < row.count ? row[index] : "", width: scrollColumnWidths[index] - 16)
                }.max() ?? 14) + 16)
            }
            previewCanvas.frame = NSRect(origin: .zero, size: NSSize(
                width: max(viewport.width, rowHeader + scrollColumnWidths.reduce(0, +)),
                height: max(viewport.height, scrollRowHeights.reduce(0, +))))
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        previewCanvas.needsDisplay = true
    }

    private func configureScrollableText(_ blocks: [String], styles: [AssistTextBlock] = [],
                                         in rect: NSRect, canRedact: Bool, key: String, lines: Bool = false) {
        showsScrollablePreview = true
        let scroll = previewScroll
        scroll.isHidden = false
        scroll.hasHorizontalScroller = false
        scroll.frame = rect
        scroll.tile()
        let key = "\(key):\(previewRevision):\(scope.rawValue):\(rect.width):\(rect.height)"
        if scrollLayoutKey != key {
            scrollLayoutKey = key
            targets.removeAll()
            redactionDrag = nil
            scrollRows = []
            scrollColumns = []
            scrollBlocks = blocks
            scrollStyles = styles.count == blocks.count ? styles : []
            scrollStyledText = scrollStyles.map { AssistMarkdown.attributed($0, baseSize: 11) }
            scrollCanRedact = canRedact
            scrollLines = lines
            let viewport = scroll.contentSize
            scrollBlockHeights = lines
                ? blocks.map { max(22, textHeight($0, width: viewport.width - 28, font: scrollLineFont) + 8) }
                : scrollStyledText.isEmpty
                ? blocks.map { max(40, textHeight($0, width: viewport.width - 28) + 24) }
                : scrollStyledText.map { max(28, AssistMarkdown.height(of: $0, width: viewport.width - 28) + 16) }
            previewCanvas.frame = NSRect(origin: .zero, size: NSSize(
                width: viewport.width,
                height: max(viewport.height, scrollBlockHeights.reduce(0, +) + CGFloat(max(0, blocks.count - 1)) * scrollBlockGap)))
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        previewCanvas.needsDisplay = true
    }

    fileprivate func drawScrollablePreview(_ dirtyRect: NSRect) {
        targets.removeAll()
        let visible = previewCanvas.visibleRect
        NSColor.textBackgroundColor.setFill()
        dirtyRect.fill()
        if !scrollColumns.isEmpty {
            let rowHeader: CGFloat = 34
            let headerHeight = scrollRowHeights.first ?? 28
            NSColor.quaternaryLabelColor.withAlphaComponent(0.08).setFill()
            NSRect(x: 0, y: 0, width: previewCanvas.bounds.width, height: headerHeight).fill()
            var x = rowHeader
            for column in scrollColumns.indices {
                let width = scrollColumnWidths[column]
                let title = scrollHeaders.flatMap { column < $0.count ? $0[column] : nil } ?? scrollColumns[column]
                drawText(title.isEmpty ? scrollColumns[column] : title,
                    in: NSRect(x: x + 8, y: 8, width: width - 16, height: headerHeight - 12),
                    font: .systemFont(ofSize: 11, weight: .semibold), color: .secondaryLabelColor, wrap: true)
                x += width
            }
            var y = headerHeight
            for (rowIndex, row) in scrollRows.enumerated() {
                let height = scrollRowHeights[rowIndex + 1]
                defer { y += height }
                guard y < visible.maxY && y + height > visible.minY else { continue }
                drawText(rowIndex < scrollRowNumbers.count ? scrollRowNumbers[rowIndex] : String(rowIndex + 1),
                    in: NSRect(x: 1, y: y + 8, width: rowHeader - 7, height: 16),
                    font: .systemFont(ofSize: 10), color: .secondaryLabelColor, alignment: .right)
                x = rowHeader
                for column in scrollColumns.indices {
                    let cellRect = NSRect(x: x, y: y, width: scrollColumnWidths[column], height: height)
                    x += scrollColumnWidths[column]
                    guard cellRect.intersects(visible) else { continue }
                    let target = ShareHitTarget(rect: cellRect, kind: "CELL", sheet: scrollRedactionSheet,
                                                row: rowIndex, column: column, block: nil)
                    if scrollCanRedact { targets.append(target) }
                    let value = column < row.count ? row[column] : ""
                    let cited = scrollCitations.contains("\(rowIndex):\(column)")
                    if scope == .redacted, scrollCanRedact, let mask = masks[target.key] {
                        drawMask(mask.effect, in: cellRect, value: value)
                    } else {
                        if cited { sourceColor.withAlphaComponent(0.12).setFill(); cellRect.fill() }
                        drawText(value, in: cellRect.insetBy(dx: 8, dy: 8),
                                 font: scrollFont, color: .labelColor, wrap: true)
                    }
                    NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
                    line(from: NSPoint(x: cellRect.minX, y: cellRect.maxY),
                         to: NSPoint(x: cellRect.maxX, y: cellRect.maxY))
                }
            }
            NSColor.separatorColor.withAlphaComponent(0.15).setStroke()
            x = rowHeader
            for width in scrollColumnWidths {
                line(from: NSPoint(x: x, y: visible.minY), to: NSPoint(x: x, y: visible.maxY))
                x += width
            }
        } else {
            var y: CGFloat = 0
            for (index, block) in scrollBlocks.enumerated() {
                let targetRect = NSRect(x: 0, y: y, width: previewCanvas.bounds.width, height: scrollBlockHeights[index])
                y += scrollBlockHeights[index] + scrollBlockGap
                guard targetRect.intersects(visible) else { continue }
                let target = ShareHitTarget(rect: targetRect, kind: "BLOCK", sheet: nil, row: nil, column: nil, block: index)
                if scrollCanRedact { targets.append(target) }
                NSColor.controlBackgroundColor.withAlphaComponent(0.25).setFill()
                NSBezierPath(roundedRect: targetRect, xRadius: 6, yRadius: 6).fill()
                let styled = index < scrollStyledText.count ? scrollStyledText[index] : nil
                if scope == .redacted, scrollCanRedact, let mask = masks[target.key] {
                    drawMask(mask.effect, in: targetRect, value: styled?.string ?? block)
                } else if let styled {
                    let content = targetRect.insetBy(dx: 14, dy: 8)
                    if scrollStyles[index].type == "rule" {
                        NSColor.separatorColor.setFill()
                        NSRect(x: content.minX, y: content.midY, width: content.width, height: 1).fill()
                    } else {
                        if scrollStyles[index].type == "quote" {
                            NSColor.tertiaryLabelColor.setFill()
                            NSRect(x: content.minX, y: content.minY, width: 2.5, height: content.height).fill()
                        }
                        styled.draw(with: content, options: [.usesLineFragmentOrigin, .usesFontLeading])
                    }
                } else if scrollLines {
                    drawText(block, in: targetRect.insetBy(dx: 14, dy: 4), font: scrollLineFont, color: .labelColor, wrap: true)
                } else {
                    drawText(block, in: targetRect.insetBy(dx: 14, dy: 12), font: scrollFont, color: .labelColor, wrap: true)
                }
            }
        }
    }

    fileprivate func previewMouseDown(at point: NSPoint) {
        notice = nil
        guard !isCopying, scope == .redacted, scrollCanRedact,
              previewCanvas.visibleRect.contains(point),
              let target = targets.first(where: { $0.rect.contains(point) }) else { return }
        let anchor = target.redaction(effect: effect)
        let drag = ShareRedactionDrag(anchor: anchor, masks: masks)
        redactionDrag = drag
        beginMaskEdit()
        masks = drag.masks(through: anchor)
        needsDisplay = true
    }

    fileprivate func previewMouseDragged(at point: NSPoint) { updateRedactionDrag(at: point) }
    fileprivate func previewMouseUp(at point: NSPoint) {
        updateRedactionDrag(at: point)
        redactionDrag = nil
        endMaskEdit()
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
        case .indexed: detail = isCADModel ? "Only the cited part is published, not the model file."
            : isPresentation ? "Only this slide is published, without speaker notes or comments." : "Only indexed context is published."
        case .redacted: detail = masks.isEmpty ? "Select at least one area to redact." : "\(masks.count) area\(masks.count == 1 ? "" : "s") removed from the shared view."
        }
        drawSymbol("lock.shield", in: NSRect(x: 18, y: centerY - 8, width: 16, height: 16), fraction: 0.8)
        let availability = localOnly ? "Only on this Mac. Email recipients need hosted sharing." : detail
        let message = notice ?? availability
        let font = NSFont.systemFont(ofSize: 11)
        let textWidth = max(0, cancelButtonRect.minX - 56)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
        let height = min(30, ceil((message as NSString).boundingRect(
            with: NSSize(width: textWidth, height: 30), options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes).height))
        let noteHeight: CGFloat = 14
        let top = centerY - (height + 2 + noteHeight) / 2
        drawText(message, in: NSRect(x: 42, y: top, width: textWidth, height: height),
                 font: font, color: notice == nil ? .secondaryLabelColor : .systemRed, wrap: true)
        drawText(Self.linkLifetimeNote, in: NSRect(x: 42, y: top + height + 2, width: textWidth, height: noteHeight),
                 font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor)

        drawButton(copyState == .copied ? "Done" : "Cancel", in: cancelButtonRect, prominent: false, enabled: true)
        let enabled = canSubmit
        let title = copyState == .copied ? "Link copied" : isCopying ? "Copying…" : actionTitle
        drawButton(title, in: actionButtonRect, prominent: true, enabled: enabled,
                   confirmed: copyState == .copied, showsShortcut: !isCopying)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        redactionDrag = nil
        drawingDrag = nil
        endMaskEdit()
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
        // Dragging a STEP model turns it; a double-click puts it back.
        if rotatableModel(at: point) != nil {
            if event.clickCount >= 2 { modelView = AssistModelView() } else { modelDrag = (point, modelView) }
            needsDisplay = true
            return
        }
        if isPDFSource {
            if (scope == .redacted || (scope == .indexed && isChoosingPDFExcerpt)), pdfTextModeRect.contains(point) {
                pdfSelectionMode = .text; needsDisplay = true; return
            }
            if (scope == .redacted || (scope == .indexed && isChoosingPDFExcerpt)), pdfAreaModeRect.contains(point) {
                pdfSelectionMode = .area; needsDisplay = true; return
            }
            if scope == .indexed && pdfExcerpt != nil && pdfExcerptToggleRect.contains(point) {
                isChoosingPDFExcerpt.toggle(); needsDisplay = true; return
            }
        }
        for (index, offered) in scopes.enumerated() where scopeRect(index).contains(point) {
            scope = offered
            needsDisplay = true
            return
        }
        if scope != .indexed,
           let tab = sheetTabTargets.first(where: { $0.rect.contains(point) }) {
            sheetIndex = tab.index
            scrollLayoutKey = ""
            targets.removeAll()
            needsDisplay = true
            return
        }
        if scope == .redacted {
            if blurEffectRect.contains(point) {
                effect = .blur; needsDisplay = true; return
            }
            if redactEffectRect.contains(point) {
                effect = .blank; needsDisplay = true; return
            }
            if let layout = drawingLayout, layout.frame.contains(point) {
                if let mask = masks.values.first(where: { layout.rect(for: $0)?.contains(point) == true }) {
                    beginMaskEdit()
                    masks.removeValue(forKey: mask.locationKey)
                    endMaskEdit()
                } else if masks.count >= 64 {
                    notice = "Use up to 64 drawing masks. Click a mask to remove it."
                } else {
                    drawingDrag = (point, masks, effect)
                    beginMaskEdit()
                }
                needsDisplay = true
                return
            }
        }

    }

    func submit() {
        guard copyState == .idle else { return }
        guard scope != .indexed || !isPDFSource || canSubmit else {
            notice = "Select a PDF excerpt and review it before creating the link."
            needsDisplay = true
            return
        }
        guard scope != .redacted || !masks.isEmpty else {
            notice = "Select an area before creating the link."
            needsDisplay = true
            return
        }
        let redactions = scope == .redacted ? Array(masks.values) : []
        onCreate?(ShareConfiguration(scope: scope, redactions: redactions,
                                     excerpt: scope == .indexed ? pdfExcerpt : nil))
    }

    override func scrollWheel(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        // Rolling a wheel away, or pushing two fingers away, zooms in, as in the card.
        let away = event.isDirectionInvertedFromDevice ? -event.scrollingDeltaY : event.scrollingDeltaY
        if !previewScroll.isHidden, previewScroll.frame.contains(point) {
            previewScroll.scrollWheel(with: event)
        } else if !zoomModel(by: exp(away * (event.hasPreciseScrollingDeltas ? 0.01 : 0.1)), at: point) {
            super.scrollWheel(with: event)
        }
    }

    override func magnify(with event: NSEvent) {
        if !zoomModel(by: 1 + event.magnification, at: convert(event.locationInWindow, from: nil)) { super.magnify(with: event) }
    }

    override func mouseDragged(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let drag = modelDrag, let sent = shownModel?.model.orbit?.camera {
            modelView = drag.view.dragged(by: CGSize(width: point.x - drag.start.x, height: point.y - drag.start.y), from: sent)
            needsDisplay = true
            return
        }
        updateRedactionDrag(at: point)
    }

    override func mouseUp(with event: NSEvent) {
        modelDrag = nil
        updateRedactionDrag(at: convert(event.locationInWindow, from: nil))
        redactionDrag = nil
        drawingDrag = nil
        endMaskEdit()
    }

    // MARK: Undo

    private func beginMaskEdit() {
        if gestureMasks == nil { gestureMasks = masks }
    }

    /// A drag or click is one step for ⌘Z, however many masks it changed.
    private func endMaskEdit() {
        guard let before = gestureMasks else { return }
        gestureMasks = nil
        history.record(from: before, to: masks)
    }

    /// ⌘Z: the masks as they were before the last drag or click.
    func undoMaskEdit() {
        guard readyForMaskStep(), let previous = history.undo(from: masks) else { return }
        showMaskStep(previous)
    }

    /// ⇧⌘Z: the edit ⌘Z last took back.
    func redoMaskEdit() {
        guard readyForMaskStep(), let next = history.redo(from: masks) else { return }
        showMaskStep(next)
    }

    /// Only the redaction view shows masks, so it alone steps through them.
    private func readyForMaskStep() -> Bool {
        guard !isCopying, scope == .redacted else { return false }
        redactionDrag = nil
        drawingDrag = nil
        endMaskEdit()
        return true
    }

    private func showMaskStep(_ next: [String: ShareRedaction]) {
        let changed = Set(masks.keys).union(next.keys).filter { masks[$0] != next[$0] }
        let sheets = Set(changed.compactMap { (masks[$0] ?? next[$0]).flatMap { $0.kind == "CELL" ? $0.sheet ?? 0 : nil } })
        masks = next
        // A step on another worksheet brings that worksheet into view.
        if !sheets.isEmpty, !sheets.contains(sheetIndex), let sheet = sheets.min() {
            sheetIndex = sheet
            scrollLayoutKey = ""
            targets.removeAll()
        }
        notice = nil
        needsDisplay = true
    }

    /// The Edit menu's Undo and Redo, when the composer's own panel has focus.
    @objc func undo(_ sender: Any?) { undoMaskEdit() }
    @objc func redo(_ sender: Any?) { redoMaskEdit() }

    private func updateRedactionDrag(at point: NSPoint) {
        if !isCopying, scope == .redacted, let drag = drawingDrag, let layout = drawingLayout {
            masks = drag.masks
            if let region = layout.redaction(from: drag.start, to: point, effect: drag.effect) {
                masks[region.locationKey] = region
            }
            needsDisplay = true
            return
        }
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

    /// Adjacent segments in one rounded track, like NSSegmentedControl.
    private func drawSegmentedControl(_ segments: [(title: String, selected: Bool, rect: NSRect)]) {
        guard let first = segments.first?.rect else { return }
        let track = segments.dropFirst().reduce(first) { $0.union($1.rect) }
        NSColor.labelColor.withAlphaComponent(0.06).setFill()
        NSBezierPath(roundedRect: track, xRadius: 6, yRadius: 6).fill()
        for (index, segment) in segments.enumerated() {
            if segment.selected {
                let knob = segment.rect.insetBy(dx: 2, dy: 2)
                NSColor.controlBackgroundColor.setFill()
                NSGraphicsContext.saveGraphicsState()
                let shadow = NSShadow()
                shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
                shadow.shadowBlurRadius = 1.5
                shadow.shadowOffset = NSSize(width: 0, height: -0.5)
                shadow.set()
                NSBezierPath(roundedRect: knob, xRadius: 4.5, yRadius: 4.5).fill()
                NSGraphicsContext.restoreGraphicsState()
            } else if index > 0, !segments[index - 1].selected {
                NSColor.separatorColor.setStroke()
                line(from: NSPoint(x: segment.rect.minX, y: segment.rect.minY + 6),
                     to: NSPoint(x: segment.rect.minX, y: segment.rect.maxY - 6))
            }
            drawText(segment.title, in: NSRect(x: segment.rect.minX, y: segment.rect.minY + 4.5,
                                               width: segment.rect.width, height: 15),
                     font: .systemFont(ofSize: 11, weight: segment.selected ? .semibold : .regular),
                     color: segment.selected ? .labelColor : .secondaryLabelColor, alignment: .center)
        }
    }

    private func drawPill(_ title: String, in rect: NSRect) {
        NSColor.labelColor.withAlphaComponent(0.05).setFill()
        NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
        drawText(title, in: NSRect(x: rect.minX + 6, y: rect.minY + 4,
                                  width: rect.width - 12, height: 13),
                 font: .systemFont(ofSize: 10, weight: .medium), color: .secondaryLabelColor,
                 alignment: .center)
    }

    private func drawButton(_ title: String, in rect: NSRect, prominent: Bool, enabled: Bool,
                            confirmed: Bool = false, showsShortcut: Bool = true) {
        let fill = prominent
            ? (sourceColor.blended(withFraction: confirmed ? 0.45 : 0.35, of: .black) ?? sourceColor).withAlphaComponent(enabled ? 1 : 0.3)
            : NSColor.labelColor.withAlphaComponent(0.07)
        fill.setFill()
        NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7).fill()
        if !prominent {
            NSColor.separatorColor.setStroke()
            NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 7, yRadius: 7).stroke()
        }
        let font = NSFont.systemFont(ofSize: 12, weight: prominent ? .semibold : .regular)
        let color = prominent ? NSColor.white.withAlphaComponent(enabled ? 1 : 0.7)
            : enabled ? NSColor.labelColor : .disabledControlTextColor
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

    private func drawSymbol(_ name: String, in rect: NSRect, fraction: CGFloat, color: NSColor? = nil) {
        guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil),
              let image = symbol.withSymbolConfiguration(.init(paletteColors: [color ?? sourceInkColor])) else { return }
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

    /// Draws an SF Symbol centered in `rect`, in the given color.
    private func drawSymbol(_ name: String, in rect: NSRect, color: NSColor) {
        let configuration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
            .applying(.init(paletteColors: [color]))
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration) else { return }
        let size = image.size
        image.draw(in: NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2,
                              width: size.width, height: size.height),
                   from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    private func drawText(_ value: String, in rect: NSRect, font: NSFont, color: NSColor,
                          alignment: NSTextAlignment = .left, wrap: Bool = false) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = wrap ? .byWordWrapping : .byTruncatingTail
        NSAttributedString(string: value, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
        ]).draw(with: rect, options: [.usesLineFragmentOrigin, .usesFontLeading])
    }

    #if BROWSER_GEOMETRY_TEST
    fileprivate func regressionPDFState(_ request: [String: Any]) -> [String: Any] {
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
            "choosing": isChoosingPDFExcerpt, "reviewLoading": isPDFExcerptLoading,
            "reviewedPages": reviewedPDFDocument?.pageCount ?? 0, "canSubmit": canSubmit,
            "redactions": masks.values.map(\.payload)]
        state["excerpt"] = pdfExcerpt?.payload
        state["error"] = pdfExcerptError ?? notice
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
        view.scope = .indexed
        paint()
        require(!view.canSubmit, "A PDF reference cannot be shared as an empty cited excerpt")
        var selectedExcerpt: SharePDFExcerpt?
        view.onReviewPDFExcerpt = { selectedExcerpt = $0 }
        view.selectPDFText(firstLine)
        paint()
        require(selectedExcerpt?.text == firstLine.string && selectedExcerpt?.regions.isEmpty == false,
                "A PDF sentence selection requests only the selected text and page regions")
        let reviewed = PDFDocument()
        reviewed.insert(PDFPage(image: NSImage(size: NSSize(width: 400, height: 80), flipped: false) { rect in
            NSColor.white.setFill(); rect.fill(); return true
        })!, at: 0)
        view.reviewedPDFDocument = reviewed
        paint()
        require(view.pdfView.document === reviewed && view.canSubmit,
                "Cited-part review displays the generated excerpt rather than the complete PDF")
        view.submit()
        require(configuration?.scope == .indexed && configuration?.excerpt?.regions == selectedExcerpt?.regions,
                "The shared excerpt uses exactly the regions that were reviewed")
        view.reset(label: "Another source", filename: "notes.txt")
        require(view.pdfView.document == nil && view.pdfView.isHidden,
                "Opening another source clears the previous PDF pages")
        view.reset(label: "Loading PDF", filename: "document.pdf")
        view.submit()
        require(!view.canSubmit && view.notice != nil,
                "Quick acceptance while PDF metadata is loading cannot publish an empty excerpt")
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
        view.undoMaskEdit()
        require(view.masks.count == 9 && view.masks["cell:0:6:1"] == nil, "Command+Z unmasks the last click alone")
        view.undoMaskEdit()
        require(view.masks.isEmpty, "Command+Z then unmasks the whole drag at once")
        view.undoMaskEdit()
        require(view.masks.isEmpty, "With nothing left, Command+Z changes nothing")
        capture("-undone")
        view.redoMaskEdit()
        view.redoMaskEdit()
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
        view.undoMaskEdit()
        require(view.masks["cell:1:1:1"] == nil && view.sheetIndex == 1,
                "Undoing a mask on another worksheet brings that worksheet into view")
        view.scope = .document
        view.undoMaskEdit()
        require(view.masks.count == 10, "Masks are only stepped through where they are shown")
        return checks
    }
    #endif
}
