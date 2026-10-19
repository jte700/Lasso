//  The Source Inspector shown when a highlighted dependency is clicked.
//
//  It reuses the workspace's own source rendering — the panel loads the same
//  locally served view the share page is built from — so provenance is
//  described in exactly one place.

import Cocoa
import WebKit

private final class InspectorWebView: WKWebView {
    // The inspector opens above the editor without taking its focus. Deliver
    // the first click to its controls instead of spending it on activation.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private final class InspectorCloseButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
}

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
    private var closeButton: NSButton?
    private var reference: DependencyReference?
    private var serverURL: URL?
    private var pendingNavigation: WKNavigation?
    private var resolvedSuccessfully = false
    #if BROWSER_GEOMETRY_TEST
    private var regressionActions: [String] = []
    #endif

    var onOpenSource: ((DependencyReference) -> Void)?
    var onShare: ((DependencyReference) -> Void)?
    var onUnlink: ((DependencyReference) -> Void)?

    private let size = NSSize(width: 560, height: 540)

    override init() {
        super.init()
        LassoTransientUI.shared.register(self, priority: 80,
            isOpen: { [weak self] in self?.isVisible == true },
            dismiss: { [weak self] in self?.hide() })
        LassoTransientUI.shared.start()
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
        closeButton?.contentTintColor = DirectoryColorPreferences.color(for: reference?.projectId)?.color
            ?? fallbackSourceColor
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
        #if BROWSER_GEOMETRY_TEST
        regressionActions = []
        #endif
        let panel = existingPanel()
        updateSourceAccent()

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
        // Dismissal belongs to the window, independently of whether its page
        // is still loading, has failed, or is displaying the previous source.
        pendingNavigation = nil
        resolvedSuccessfully = false
        reference = nil
        serverURL = nil
        webView?.stopLoading()
        panel?.orderOut(nil)
    }

    @objc private func closeInspector(_ sender: Any?) { hide() }

    var isVisible: Bool { panel?.isVisible == true }

    #if BROWSER_GEOMETRY_TEST
    /// Observe the actual hosted page and button position for native click
    /// regressions. Tests post real mouse events instead of invoking actions.
    func regressionState() -> [String: Any] {
        var result: [String: Any] = ["visible": isVisible, "key": panel?.isKeyWindow == true,
                                    "loading": pendingNavigation != nil, "actions": regressionActions]
        if let panel {
            result["windowNumber"] = panel.windowNumber
            result["panelFrame"] = ["x": panel.frame.minX, "y": panel.frame.minY,
                                    "width": panel.frame.width, "height": panel.frame.height]
        }
        if let closeButton, let panel, isVisible {
            let frame = panel.convertToScreen(closeButton.convert(closeButton.bounds, to: nil))
            result["closeButtonFrame"] = ["x":frame.minX,"y":frame.minY,"width":frame.width,"height":frame.height]
        }
        guard let webView, isVisible else { return result }
        result["webFlipped"] = webView.isFlipped
        result["webBounds"] = ["x": webView.bounds.minX, "y": webView.bounds.minY,
                               "width": webView.bounds.width, "height": webView.bounds.height]
        var completed = false
        webView.evaluateJavaScript("""
            (() => {
              const close = document.querySelector('[data-action="close"]');
              const rect = close?.getBoundingClientRect();
              const shareRect = document.querySelector('[data-action="share"]')?.getBoundingClientRect();
              return {ready: Boolean(close), pageCloseVisible: Boolean(close && getComputedStyle(close).visibility !== 'hidden'),
                objectId: new URL(location.href).searchParams.get('object'),
                text: document.body.innerText.slice(0, 1400),
                model: Boolean(document.querySelector('[data-model-plan]')),
                paths: document.querySelectorAll('[data-model-element]').length,
                selected: [...document.querySelectorAll('[data-model-element].selected')].map(e => e.dataset.modelElement),
                button: rect ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height} : null,
                shareButton: shareRect ? {x:shareRect.x,y:shareRect.y,width:shareRect.width,height:shareRect.height} : null};
            })()
            """) { value, _ in
            if let state = value as? [String: Any] {
                result.merge(state) { _, new in new }
                result["ready"] = state["ready"] as? Bool == true && self.pendingNavigation == nil && self.resolvedSuccessfully
                if let button = state["shareButton"] as? [String: Double],
                   let x = button["x"], let y = button["y"], let width = button["width"], let height = button["height"],
                   let panel = self.panel {
                    let rect = NSRect(x: x, y: webView.isFlipped ? y : webView.bounds.height - y - height,
                                      width: width, height: height)
                    let screen = panel.convertToScreen(webView.convert(rect, to: nil))
                    result["shareButtonFrame"] = ["x":screen.minX,"y":screen.minY,"width":screen.width,"height":screen.height]
                }
            }
            completed = true
        }
        let deadline = Date().addingTimeInterval(2)
        while !completed, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        return result
    }

    func regressionSnapshot(to url: URL) -> Bool {
        guard let webView, isVisible else { return false }
        var result: Bool?
        webView.takeSnapshot(with: nil) { image, _ in
            guard let data = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data),
                  let png = bitmap.representation(using: .png, properties: [:]) else { result = false; return }
            do { try png.write(to: url); result = true } catch { result = false }
        }
        let deadline = Date().addingTimeInterval(3)
        while result == nil, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        return result ?? false
    }

    func regressionFocus() {
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func regressionResize(_ size: NSSize) {
        panel?.setContentSize(NSSize(width: max(560, size.width), height: max(440, size.height)))
    }
    #endif

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
        // The persistent native close button also works before navigation
        // commits and on server error pages. Keep the page's header spacing.
        configuration.userContentController.addUserScript(WKUserScript(source: """
            const nativeCloseStyle = document.createElement('style');
            nativeCloseStyle.textContent = '.close-inspector { visibility: hidden !important; }';
            (document.head || document.documentElement).appendChild(nativeCloseStyle);
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let web = InspectorWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.wantsLayer = true
        web.layer?.cornerRadius = InspectorWindow.cornerRadius
        web.layer?.masksToBounds = true
        web.underPageBackgroundColor = .clear
        web.navigationDelegate = self
        webView = web

        let content = NSView(frame: web.frame)
        content.addSubview(web)
        let close = InspectorCloseButton(frame: NSRect(x: size.width - 39, y: size.height - 39,
                                                       width: 23, height: 23))
        close.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .semibold))
        close.imagePosition = .imageOnly
        close.isBordered = false
        close.bezelStyle = .regularSquare
        close.target = self
        close.action = #selector(closeInspector(_:))
        close.keyEquivalent = "\u{1b}"
        close.keyEquivalentModifierMask = []
        close.toolTip = "Close source inspector"
        close.setAccessibilityLabel("Close source inspector")
        close.setAccessibilityIdentifier("lasso.source-inspector.close")
        close.autoresizingMask = [.minXMargin, .minYMargin]
        content.addSubview(close)
        closeButton = close

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
            content: content, cornerRadius: InspectorWindow.cornerRadius,
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
           let reference,
           components.queryItems?.first(where: { $0.name == "object" })?.value == reference.objectId,
           components.queryItems?.first(where: { $0.name == "reference" })?.value == reference.id,
           components.queryItems?.first(where: { $0.name == "version" })?.value == reference.versionId {
            resolvedSuccessfully = (200..<300).contains(response.statusCode)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === pendingNavigation else { return }
        pendingNavigation = nil
        guard resolvedSuccessfully, isVisible, let serverURL, let reference else { return }
        updateSourceAccent()
        RecommendationUsageClient.recordResolvedOpen(serverURL: serverURL, objectId: reference.objectId)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finishFailedNavigation(navigation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finishFailedNavigation(navigation)
    }

    private func finishFailedNavigation(_ navigation: WKNavigation?) {
        guard navigation === pendingNavigation else { return }
        pendingNavigation = nil
        resolvedSuccessfully = false
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "inspector", message.frameInfo.isMainFrame,
              message.webView === webView,
              let pageURL = message.frameInfo.request.url, let serverURL,
              pageURL.scheme == serverURL.scheme, pageURL.host == serverURL.host,
              pageURL.port == serverURL.port, pageURL.path == "/inspect", isVisible,
              let payload = message.body as? [String: Any],
              let action = payload["action"] as? String else { return }
        // A trusted previous inspector document can still be visible while a
        // new source loads. Closing it never acts on the selected source.
        if action == "close" { hide(); return }
        guard let reference,
              payload["referenceId"] as? String == reference.id,
              let components = URLComponents(url: pageURL, resolvingAgainstBaseURL: false),
              components.queryItems?.first(where: { $0.name == "object" })?.value == reference.objectId,
              components.queryItems?.first(where: { $0.name == "version" })?.value == reference.versionId else { return }
        #if BROWSER_GEOMETRY_TEST
        regressionActions.append(action)
        #endif
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
