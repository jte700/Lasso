//  The Source Inspector shown when a highlighted dependency is clicked.
//
//  It reuses the workspace's own source rendering — the panel loads the same
//  locally served view the share page is built from — so provenance is
//  described in exactly one place.

import Cocoa
import WebKit

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

    private let size = NSSize(width: 420, height: 540)

    func show(_ reference: DependencyReference, near rect: CGRect, serverURL: URL) {
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
        ]
        if let url = components?.url { pendingNavigation = webView?.load(URLRequest(url: url)) }

        panel.setFrame(NSRect(origin: placement(for: rect), size: size), display: true)
        panel.orderFrontRegardless()
    }

    func hide() { panel?.orderOut(nil) }

    var isVisible: Bool { panel?.isVisible == true }

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
        web.underPageBackgroundColor = .clear
        web.navigationDelegate = self
        webView = web

        let created = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .resizable, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        created.isMovableByWindowBackground = true
        created.level = .floating
        created.hidesOnDeactivate = false
        created.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        created.minSize = NSSize(width: 380, height: 440)
        created.backgroundColor = .clear
        created.isOpaque = false
        created.hasShadow = true
        created.contentView = NativeMaterial.glassContainer(
            content: web, cornerRadius: 12,
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
        RecommendationUsageClient.recordResolvedOpen(serverURL: serverURL, objectId: reference.objectId)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "inspector",
              let payload = message.body as? [String: Any],
              let action = payload["action"] as? String,
              let reference else { return }
        switch action {
        case "open": onOpenSource?(reference)
        case "share": onShare?(reference)
        case "unlink": onUnlink?(reference); hide()
        case "close": hide()
        default: break
        }
    }
}
