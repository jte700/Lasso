// Owns the share composer's panel: shows it over or beside the suggestion card, loads what it previews
// from the server and hands the chosen configuration back.

import Cocoa
import PDFKit

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
    /// The server allows a long deck several minutes, saying nothing until it is done.
    private static let markupPagesTimeout: TimeInterval = 600
    private var active = false
    private var requests: [URLSessionDataTask] = []
    private var generation = 0
    private var pdfReviewGeneration = 0
    private var escapedCopies = Set<Int>()
    private var completion: ((ShareConfiguration) -> Void)?
    private var copyAction: ((ShareConfiguration, @escaping (Result<DependencyShare, Error>) -> Void) -> Void)?
    private var copyServerURL: URL?
    private var cancellation: (() -> Void)?
    private var colorObserver: NSObjectProtocol?
    private var folderColorObserver: NSObjectProtocol?
    private var projectId: String?
    private var fallbackHighlightColor: NSColor = .systemGreen
    var isVisible: Bool { active && (hostPanel ?? panel)?.isVisible == true }

    func isPresented(in panel: NSPanel?) -> Bool {
        active && panel != nil && hostPanel === panel
    }

    func confirm() { if isVisible { view.submit() } }

    func moveScope(_ delta: Int) {
        guard isVisible, !view.isCopying else { return }
        view.moveScope(delta)
    }

    func undoEdit() { if isVisible { view.undoEdit() } }
    func redoEdit() { if isVisible { view.redoEdit() } }

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
            forName: NSColor.systemColorsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                self?.view.needsDisplay = true
            }
        folderColorObserver = NotificationCenter.default.addObserver(
            forName: .directoryColorsDidChange, object: nil, queue: .main) { [weak self] _ in
                self?.updateHighlightColor()
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
              projectId: String? = nil, fallbackHighlightColor: NSColor = .systemGreen,
              copyAction: ((ShareConfiguration, @escaping (Result<DependencyShare, Error>) -> Void) -> Void)? = nil,
              onCancel: (() -> Void)? = nil,
              citedIn: String? = nil,
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
        self.fallbackHighlightColor = fallbackHighlightColor
        updateHighlightColor()
        active = true
        generation += 1
        let token = generation
        requests.forEach { $0.cancel() }
        requests.removeAll()
        view.reset(label: label, filename: (sourcePath as NSString).lastPathComponent)
        view.citedIn = citedIn
        view.onReviewPDFExcerpt = { [weak self] excerpt in
            self?.loadPDFExcerpt(excerpt, serverURL: serverURL, token: token)
        }
        view.onNeedsMarkupPages = { [weak self] in
            self?.loadMarkupPages(objectId: objectId, versionId: versionId, serverURL: serverURL, token: token)
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
            // The preview also brings the table a cited-part share publishes.
            if endpoint == "preview" {
                let items = components?.queryItems ?? []
                components?.queryItems = items + [URLQueryItem(name: "shared", value: "1")]
            }
            guard let url = components?.url else { continue }
            var urlRequest = URLRequest(url: url)
            urlRequest.timeoutInterval = 20
            let task = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, _, _ in
                DispatchQueue.main.async {
                    guard let self, token == self.generation else { return }
                    if endpoint == "preview" {
                        self.view.preview = data.flatMap(GlobalAssistant.parsePreview)
                        self.view.showSlides(from: SlidePictureSource(serverURL: serverURL, objectId: objectId, versionId: versionId))
                        self.view.citedPart = data.flatMap(Self.citedPart)
                        self.view.sharedExcerpt = data.flatMap { Self.excerpt($0, named: "sharedExcerpt") }
                        self.view.nearbyExcerpt = data.flatMap { Self.excerpt($0, named: "nearbyExcerpt") }
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
    /// A table a cited-part share publishes, as the server builds it for the
    /// recipient: `sharedExcerpt`, or `nearbyExcerpt` with the rows around it.
    static func excerpt(_ data: Data, named key: String) -> AssistDocumentPreview? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let source = root["source"], let excerpt = root[key],
              let json = try? JSONSerialization.data(withJSONObject: ["source": source, "preview": excerpt]) else { return nil }
        return AssistDocumentPreview.parse(json)
    }

    static func citedPart(_ data: Data) -> AssistModelPreview? {
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

    /// A Word document or deck laid out as pages to mark up. Quick Look draws
    /// a long deck's slides one at a time, so this can take a while.
    private func loadMarkupPages(objectId: String, versionId: String?, serverURL: URL, token: Int) {
        var components = URLComponents(url: serverURL.appendingPathComponent("api/dependency-objects")
            .appendingPathComponent(objectId).appendingPathComponent("pages"), resolvingAgainstBaseURL: false)
        if let versionId { components?.queryItems = [URLQueryItem(name: "version", value: versionId)] }
        guard let url = components?.url else { return }
        view.isMarkupPagesLoading = true
        view.markupPagesError = nil
        var request = URLRequest(url: url)
        request.timeoutInterval = Self.markupPagesTimeout
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let pages = (200..<300).contains(status) ? data.flatMap(PDFDocument.init(data:)).flatMap { $0.pageCount > 0 ? $0 : nil } : nil
            let failure = pages == nil ? WorkspaceAPI.errorMessage(data: data, response: response, error: error) : nil
            DispatchQueue.main.async {
                guard let self, token == self.generation else { return }
                self.view.markupPages = pages
                self.view.isMarkupPagesLoading = false
                self.view.markupPagesError = failure
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
                // ⌘Z may have taken the excerpt back while it was being prepared.
                guard let self, token == self.generation, reviewToken == self.pdfReviewGeneration,
                      self.view.pdfExcerpt == excerpt else { return }
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

    /// Cited cells and text are marked in the source folder's colour, as on the suggestion card.
    private func updateHighlightColor() {
        view.highlightColor = DirectoryColorPreferences.color(for: projectId)?.color ?? fallbackHighlightColor
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
