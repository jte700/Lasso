//  The Source Inspector shown when a highlighted dependency is clicked.
//
//  It reuses the workspace's own source rendering — the panel loads the same
//  locally served view the share page is built from — so provenance is
//  described in exactly one place.

import Cocoa
import WebKit

private final class InspectorWindow: NSPanel {
    static let cornerRadius: CGFloat = 14

    override var canBecomeKey: Bool { true }

    override var contentView: NSView? {
        didSet {
            // The resizable window frame draws outside its content view. Clip
            // that outer surface as well, including after sharing swaps views.
            guard let frameView = contentView?.superview else { return }
            frameView.wantsLayer = true
            frameView.layer?.cornerRadius = Self.cornerRadius
            frameView.layer?.masksToBounds = true
            invalidateShadow()
        }
    }
}

final class SourceInspectorPanel: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private var panel: NSPanel?
    private var webView: WKWebView?
    private var reference: DependencyReference?
    private var serverURL: URL?
    private var pendingNavigation: WKNavigation?
    private var resolvedSuccessfully = false

    var onOpenSource: ((DependencyReference) -> Void)?
    var onShare: ((DependencyReference) -> Void)?
    var onUnlink: ((DependencyReference) -> Void)?

    private let size = NSSize(width: 560, height: 540)

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(updateSourceAccent),
            name: .directoryColorsDidChange, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var fallbackSourceColor: NSColor {
        DependencyStyle.stroke(for: .healthy, sourceSlot: reference?.sourceColorSlot ?? 0, hovered: true)
    }

    private var sourceAccentHex: String {
        let color = (DirectoryColorPreferences.color(for: reference?.projectId)?.color
            ?? fallbackSourceColor).usingColorSpace(.sRGB)!
        return String(format: "#%02X%02X%02X", Int((color.redComponent * 255).rounded()),
            Int((color.greenComponent * 255).rounded()), Int((color.blueComponent * 255).rounded()))
    }

    @objc private func updateSourceAccent() {
        guard reference != nil else { return }
        webView?.evaluateJavaScript("document.documentElement.style.setProperty('--accent', '\(sourceAccentHex)')")
    }

    func show(_ reference: DependencyReference, near rect: CGRect, serverURL: URL) {
        if ShareComposerController.shared.isPresented(in: panel) {
            ShareComposerController.shared.hide()
        }
        self.reference = reference
        self.serverURL = serverURL
        resolvedSuccessfully = false
        pendingNavigation = nil
        let panel = existingPanel()

        var components = URLComponents(url: serverURL.appendingPathComponent("inspect"),
                                       resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "object", value: reference.objectId),
            URLQueryItem(name: "version", value: reference.versionId),
            URLQueryItem(name: "reference", value: reference.id),
            URLQueryItem(name: "accent", value: sourceAccentHex),
        ]
        if let url = components?.url { pendingNavigation = webView?.load(URLRequest(url: url)) }

        panel.setFrame(NSRect(origin: placement(for: rect), size: size), display: true)
        panel.invalidateShadow()
        panel.orderFrontRegardless()
    }

    func hide() {
        if ShareComposerController.shared.isPresented(in: panel) {
            ShareComposerController.shared.hide()
        }
        panel?.orderOut(nil)
    }

    var isVisible: Bool { panel?.isVisible == true }

    func composeShare(_ reference: DependencyReference, serverURL: URL,
                      completion: @escaping (ShareConfiguration, @escaping (Result<DependencyShare, Error>) -> Void) -> Void) {
        guard let panel else { return }
        ShareComposerController.shared.show(
            objectId: reference.objectId, versionId: reference.versionId,
            label: reference.label, sourcePath: reference.sourcePath,
            near: panel.frame, serverURL: serverURL, hostPanel: panel,
            projectId: reference.projectId, fallbackColor: fallbackSourceColor,
            copyAction: completion)
    }

    /// Beside the words when there is room, otherwise left, below or above —
    /// always fully on the display the dependency is on.
    private func placement(for rect: CGRect) -> NSPoint {
        let screen = NSScreen.screens.first { $0.frame.intersects(rect) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let gap: CGFloat = 10

        var x = rect.maxX + gap
        if x + size.width > visible.maxX { x = rect.minX - size.width - gap }   // left
        x = min(max(visible.minX + 4, x), visible.maxX - size.width - 4)

        var y = rect.minY - size.height + rect.height                          // aligned to the line
        if y < visible.minY { y = rect.maxY + gap }                            // below → above
        y = min(max(visible.minY + 4, y), visible.maxY - size.height - 4)
        return NSPoint(x: x, y: y)
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "inspector")
        let web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.wantsLayer = true
        web.layer?.cornerRadius = InspectorWindow.cornerRadius
        web.layer?.masksToBounds = true
        web.underPageBackgroundColor = .clear
        web.navigationDelegate = self
        webView = web

        let created = InspectorWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .resizable, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        created.isMovableByWindowBackground = true
        created.level = .floating
        created.hidesOnDeactivate = false
        created.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        created.minSize = NSSize(width: 560, height: 440)
        created.backgroundColor = .clear
        created.isOpaque = false
        created.hasShadow = true
        created.contentView = NativeMaterial.glassContainer(
            content: web, cornerRadius: InspectorWindow.cornerRadius,
            tint: NSColor.windowBackgroundColor.withAlphaComponent(0.10))
        panel = created
        return created
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           let responseURL = response.url,
           let components = URLComponents(url: responseURL, resolvingAgainstBaseURL: false),
           components.queryItems?.first(where: { $0.name == "object" })?.value == reference?.objectId {
            resolvedSuccessfully = (200..<300).contains(response.statusCode)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === pendingNavigation, resolvedSuccessfully, isVisible,
              let serverURL, let reference else { return }
        pendingNavigation = nil
        updateSourceAccent()
        RecommendationUsageClient.recordResolvedOpen(serverURL: serverURL, objectId: reference.objectId)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "inspector", message.frameInfo.isMainFrame,
              message.webView === webView,
              let pageURL = message.frameInfo.request.url, let serverURL,
              pageURL.scheme == serverURL.scheme, pageURL.host == serverURL.host,
              pageURL.port == serverURL.port,
              let payload = message.body as? [String: Any],
              let action = payload["action"] as? String,
              let reference,
              payload["referenceId"] as? String == reference.id else { return }
        switch action {
        case "open":
            if let sourcePath = payload["absolutePath"] as? String,
               (sourcePath as NSString).isAbsolutePath,
               FileManager.default.fileExists(atPath: sourcePath),
               NSWorkspace.shared.open(URL(fileURLWithPath: sourcePath)) {
                RecommendationUsageClient.recordResolvedOpen(serverURL: serverURL, objectId: reference.objectId)
            } else {
                onOpenSource?(reference)
            }
        case "share": onShare?(reference)
        case "unlink": onUnlink?(reference); hide()
        case "close": hide()
        default: break
        }
    }
}
