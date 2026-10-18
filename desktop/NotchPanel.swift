import Cocoa

/// Geometry is expressed in AppKit screen coordinates, including displays
/// above/below the primary screen. No model-name guesses or camera heuristics.
enum NotchGeometry {
    static let logoWidth: CGFloat = 32
    static func interpolatedFrame(from: NSRect, to: NSRect, progress: CGFloat) -> NSRect {
        let p = min(1, max(0, progress))
        func mix(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * p }
        let height = mix(from.height, to.height)
        return NSRect(x: mix(from.minX, to.minX), y: mix(from.maxY, to.maxY) - height,
                      width: mix(from.width, to.width), height: height)
    }

    static func supported(builtIn: Bool, topInset: CGFloat, left: NSRect?, right: NSRect?) -> Bool {
        guard builtIn, topInset > 0, let left, let right else { return false }
        return left.width > 0 && right.width > 0 && right.minX > left.maxX
    }

    static func frame(screen: NSRect, topInset: CGFloat, centerX: CGFloat, expanded: Bool, notchWidth: CGFloat = 200, contentHeight: CGFloat = 198) -> NSRect {
        if !expanded {
            // Paint beneath the housing's curved left corner, not just up to
            // its rectangular safe-area boundary. Keep the logo outside it.
            let overlap = min(topInset, notchWidth / 2)
            return NSRect(x: max(screen.minX, centerX - notchWidth / 2 - logoWidth),
                          y: screen.maxY - topInset, width: logoWidth + overlap, height: topInset)
        }
        let width = min(max(360.0, notchWidth + 2 * logoWidth), screen.width - 24)
        let height = topInset + min(contentHeight, screen.height - topInset - 12)
        let x = min(max(centerX - width / 2, screen.minX + 12), screen.maxX - width - 12)
        return NSRect(x: x, y: screen.maxY - height, width: width, height: height)
    }
}

struct NotchActivity {
    var directories = 0
    var files = 0
    var stale = 0
    var failures = 0
    var changes: [[String: Any]] = []
    init(_ json: [String: Any] = [:]) {
        directories = max(0, json["directories"] as? Int ?? 0)
        files = max(0, json["files"] as? Int ?? 0)
        stale = max(0, json["stale"] as? Int ?? 0)
        failures = max(0, json["failures"] as? Int ?? 0)
        changes = Array((json["changes"] as? [[String: Any]] ?? []).prefix(8))
    }
    var changeKeys: Set<String> {
        Set(changes.map { change in
            [change["projectId"], change["objectId"], change["toVersion"]]
                .map { String(describing: $0 ?? "") }.joined(separator: ":")
        })
    }
    var newestKey: String? {
        guard let change = changes.first else { return nil }
        return [change["projectId"], change["objectId"], change["toVersion"]]
            .map { String(describing: $0 ?? "") }.joined(separator: ":")
    }
    func hasNewActivity(comparedTo previous: NotchActivity) -> Bool {
        !changeKeys.subtracting(previous.changeKeys).isEmpty
            || failures > previous.failures || stale > previous.stale
    }

}

private final class NotchWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    // The window includes the camera band. Its controls are laid out below it.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

private final class NotchContent: NSView {
    override var isFlipped: Bool { true }
}

/// A single silhouette joins the display edge to the camera housing. The
/// compact backing overlaps the housing to fill its exposed rounded corner;
/// the expanded surface has no transparent shoulders or separate logo tab.
private final class NotchSurface: NSView {
    override var isFlipped: Bool { true }
    var logoBacking = NSRect.zero
    var body: NSRect?

    private func fill(_ rect: NSRect, radius: CGFloat, roundRight: Bool) {
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        // Square top corners keep both shapes flush with the display edge.
        NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height / 2).fill()
        if !roundRight {
            NSRect(x: rect.midX, y: rect.minY, width: rect.width / 2, height: rect.height).fill()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        fill(logoBacking, radius: 10, roundRight: false)
        if let body { fill(body, radius: 14, roundRight: true) }
    }
}

final class NotchPanelController: NSObject {
    static let preferenceKey = "NotchEnabled"
    static var supportedScreen: NSScreen? {
        NSScreen.screens.first { screen in
            guard #available(macOS 12.0, *),
                  let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
            return NotchGeometry.supported(builtIn: CGDisplayIsBuiltin(number.uint32Value) != 0,
                topInset: screen.safeAreaInsets.top, left: screen.auxiliaryTopLeftArea, right: screen.auxiliaryTopRightArea)
        }
    }
    static var isAvailable: Bool { supportedScreen != nil }
    var onToggleSuggestions: (() -> Void)?
    var onOpenWorkspace: ((String) -> Void)?
    private var panel: NotchWindow?
    private var launcherButton: NSButton?
    private var autoCollapseTimer: Timer?
    private var transitionTimer: Timer?
    private var presentationTarget = NSRect.zero
    private var presentedExpanded = false
    private var presentedBody: NSRect?
    private var reduceMotion = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private let content = NotchContent()
    private let contentClip = NotchContent()
    private let surface = NotchSurface()
    private var timer: Timer?
    private var task: URLSessionDataTask?
    private var generation = 0
    private var baseURL: URL?
    private var workspaceRevision = ""
    private var enabled = false
    private var expanded = false
    private var suggestions = false
    private var suggestionsRequested = false
    private var activity = NotchActivity()
    private var issue: String?
    private var initialized = false
    private var selectedChange = 0
    private var localClick: Any?
    private var globalClick: Any?

    override init() {
        super.init()
        LassoTransientUI.shared.register(self, priority: 1,
            isOpen: { [weak self] in self?.expanded == true },
            dismiss: { [weak self] in self?.collapse() })
    }

    func configure(enabled: Bool, serverURL: URL?, suggestions: Bool, requested: Bool = false, revision: String = "") {
        let changedServer = baseURL != serverURL || workspaceRevision != revision
        workspaceRevision = revision
        let wasEnabled = self.enabled
        self.enabled = enabled && Self.isAvailable
        self.suggestions = suggestions
        self.suggestionsRequested = requested
        baseURL = serverURL
        if changedServer {
            generation += 1; task?.cancel(); task = nil
            activity = NotchActivity(); initialized = false; selectedChange = 0
        }
        if serverURL == nil { issue = "Waiting for the local server…" }
        guard self.enabled else { stop(); return }
        if panel == nil { makePanel() }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refresh() }
            timer?.tolerance = 2
        }
        render()
        if !wasEnabled || changedServer || !initialized { refresh() }
    }

    func stop() {
        enabled = false
        generation += 1; task?.cancel(); task = nil
        timer?.invalidate(); timer = nil
        transitionTimer?.invalidate(); transitionTimer = nil
        presentedExpanded = false
        presentedBody = nil
        content.isHidden = true
        content.alphaValue = 0
        panel?.orderOut(nil)
        autoCollapseTimer?.invalidate(); autoCollapseTimer = nil
        expanded = false
        if let localClick { NSEvent.removeMonitor(localClick) }
        if let globalClick { NSEvent.removeMonitor(globalClick) }
        localClick = nil; globalClick = nil
    }

    private func makePanel() {
        let panel = NotchWindow(contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        if #available(macOS 13.0, *) { panel.collectionBehavior.insert(.canJoinAllApplications) }
        panel.animationBehavior = .none
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.title = "Lasso notch"
        content.frame = NSRect(x: 0, y: 0, width: 360, height: 198)
        panel.appearance = NSAppearance(named: .darkAqua)
        contentClip.clipsToBounds = true
        contentClip.addSubview(content)
        surface.addSubview(contentClip)
        panel.contentView = surface
        self.panel = panel
        let button = NSButton(title: "", target: self, action: #selector(toggleExpanded))
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.image = NSImage(systemSymbolName: "lasso", accessibilityDescription: "Open Lasso notch")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 16, weight: .regular))
        button.contentTintColor = .white
        button.setAccessibilityLabel("Open Lasso notch")
        button.toolTip = "Open Lasso"
        surface.addSubview(button)
        launcherButton = button
    }

    private func receive(_ next: NotchActivity) {
        let shouldPresent = initialized && next.hasNewActivity(comparedTo: activity)
        if next.newestKey != activity.newestKey { selectedChange = 0 }
        activity = next
        initialized = true; issue = nil
        if shouldPresent { presentActivity() }
        render()
    }

    private func presentActivity() {
        guard enabled, !expanded else { return }
        expanded = true
        installClickDismissal()
        scheduleAutoCollapse()
    }

    private func scheduleAutoCollapse() {
        autoCollapseTimer?.invalidate()
        autoCollapseTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
            guard let self, self.expanded else { return }
            if self.panel?.frame.contains(NSEvent.mouseLocation) == true {
                self.scheduleAutoCollapse()
            } else { self.collapse() }
        }
    }

    private func refresh() {
        guard enabled, task == nil, let baseURL else { return }
        let token = generation
        var request = URLRequest(url: baseURL.appendingPathComponent("api/workspace/activity"))
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, self.enabled, token == self.generation else { return }
                self.task = nil
                if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                   let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let payload = json["activity"] as? [String: Any] {
                    self.receive(NotchActivity(payload))
                } else {
                    let newlyUnavailable = self.initialized && self.issue == nil
                    self.issue = "Activity unavailable. Open Lasso to check."
                    if newlyUnavailable { self.presentActivity() }
                }
                self.render()
            }
        }
        task?.resume()
    }

    private var expandedContentHeight: CGFloat {
        (issue == nil && !activity.changes.isEmpty ? 198 : 138) + (activity.failures > 0 ? 20 : 0)
    }

    private func label(_ text: String, x: CGFloat = 14, y: CGFloat, width: CGFloat? = nil,
                       size: CGFloat = 13, color: NSColor = .labelColor, bold: Bool = false, height: CGFloat = 20) {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: size, weight: bold ? .semibold : .regular)
        label.textColor = color
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: x, y: y, width: width ?? content.bounds.width - x - 14, height: height)
        label.toolTip = text
        content.addSubview(label)
    }

    @discardableResult
    private func button(_ title: String, frame: NSRect, action: Selector, symbol: String? = nil) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        if title.isEmpty, let symbol {
            // Icon-only controls on the black surface are plain glyphs, as in system HUDs.
            button.isBordered = false
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
            button.contentTintColor = .secondaryLabelColor
            button.imagePosition = .imageOnly
        } else {
            // The large push button is the native 28-point control height.
            button.bezelStyle = .rounded
            button.controlSize = .large
            button.font = .systemFont(ofSize: 12, weight: .medium)
            if let symbol { button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
            button.imagePosition = .imageLeading
        }
        button.frame = frame
        content.addSubview(button)
        return button
    }

    private func render() {
        guard enabled, let panel, let screen = Self.supportedScreen else { return }
        guard #available(macOS 12.0, *) else { return }
        let center = ((screen.auxiliaryTopLeftArea?.maxX ?? screen.frame.midX)
            + (screen.auxiliaryTopRightArea?.minX ?? screen.frame.midX)) / 2
        let notchWidth = (screen.auxiliaryTopRightArea?.minX ?? center + 100)
            - (screen.auxiliaryTopLeftArea?.maxX ?? center - 100)
        let frame = NotchGeometry.frame(screen: screen.frame, topInset: screen.safeAreaInsets.top,
                                       centerX: center, expanded: expanded, notchWidth: notchWidth, contentHeight: expandedContentHeight)
        let compactFrame = NotchGeometry.frame(screen: screen.frame, topInset: screen.safeAreaInsets.top,
                                               centerX: center, expanded: false, notchWidth: notchWidth)
        let cameraFrame = NSRect(x: center - notchWidth / 2, y: screen.frame.maxY - screen.safeAreaInsets.top,
                                 width: notchWidth, height: screen.safeAreaInsets.top)
        launcherButton?.setAccessibilityLabel(expanded ? "Close Lasso notch" : "Open Lasso notch")
        panel.title = expanded ? "Lasso notch" : "Lasso notch control"
        guard expanded else {
            present(frame: frame, compactFrame: compactFrame, cameraFrame: cameraFrame)
            return
        }
        content.frame = NSRect(x: 0, y: 0, width: frame.width,
                               height: frame.height - screen.safeAreaInsets.top)
        content.subviews.forEach { $0.removeFromSuperview() }
        let width = content.bounds.width
        let footerY = content.bounds.height - 38
        label("\(activity.directories) active director\(activity.directories == 1 ? "y" : "ies") · \(activity.files) indexed file\(activity.files == 1 ? "" : "s")",
              y: 8, size: 11, color: .secondaryLabelColor, height: 18)
        let separator = NSBox(frame: NSRect(x: 14, y: 34, width: width - 28, height: 1))
        separator.boxType = .separator; content.addSubview(separator)
        if let issue {
            label(issue, y: 46, size: 12, color: .systemOrange)
            label("Your recorded sources stay on this Mac.", y: 70, size: 11, color: .secondaryLabelColor)
        } else if !activity.changes.isEmpty {
            selectedChange = min(selectedChange, activity.changes.count - 1)
            let change = activity.changes[selectedChange]
            label("Latest changes · \(selectedChange + 1) of \(activity.changes.count)", y: 44, size: 10, color: .secondaryLabelColor, height: 16)
            label(change["fileName"] as? String ?? change["name"] as? String ?? "Source changed",
                  y: 64, width: width - (activity.changes.count > 1 ? 86 : 28), size: 12, bold: true, height: 18)
            label([change["projectName"], change["locator"]].compactMap { $0 as? String }.joined(separator: " · "),
                  y: 85, size: 10, color: .secondaryLabelColor, height: 16)
            let moved = change["moved"] as? Bool == true
            let old = (moved ? change["previousPath"] : change["previousValue"]) as? String ?? "Removed"
            let new = (moved ? change["path"] : change["currentValue"]) as? String ?? "Removed"
            label("\(old) → \(new)", y: 106, size: 16, color: .systemGreen, bold: true, height: 24)
            let count = change["unresolvedReferences"] as? Int ?? 0
            label("\(count) reference\(count == 1 ? "" : "s") to review · v\(change["fromVersion"] ?? "?") → v\(change["toVersion"] ?? "?")",
                  y: 134, size: 10, color: .secondaryLabelColor, height: 16)
            if activity.changes.count > 1 {
                button("", frame: NSRect(x: width - 66, y: 61, width: 24, height: 24), action: #selector(previous), symbol: "chevron.left").setAccessibilityLabel("Previous change")
                button("", frame: NSRect(x: width - 38, y: 61, width: 24, height: 24), action: #selector(next), symbol: "chevron.right").setAccessibilityLabel("Next change")
            }
        } else {
            label(initialized ? "Your source library is ready" : "Loading source activity…", y: 46, size: 13, bold: true)
            label(activity.directories == 0 ? "Enable a directory in the Lasso menu."
                : "Source changes will appear here as you work.", y: 70, size: 11, color: .secondaryLabelColor)
        }
        if activity.failures > 0 {
            label("\(activity.failures) indexing or directory issue\(activity.failures == 1 ? "" : "s")", y: footerY - 22,
                  size: 10, color: .systemOrange, height: 16)
        }
        let actionWidth = (width - 36) / 2
        button(suggestionsRequested ? "Pause suggestions" : "Resume suggestions",
               frame: NSRect(x: 14, y: footerY, width: actionWidth, height: 28), action: #selector(toggleSuggestions))
            .isEnabled = baseURL != nil
        button(activity.stale > 0 || activity.failures > 0 ? "Review sources" : "Open sources",
               frame: NSRect(x: width - 14 - actionWidth, y: footerY, width: actionWidth, height: 28), action: #selector(openWorkspace),
               symbol: "arrow.up.right.square").isEnabled = baseURL != nil
        present(frame: frame, compactFrame: compactFrame, cameraFrame: cameraFrame)
    }

    private func applyPresentation(body: NSRect?, compactFrame: NSRect, cameraHeight: CGFloat, contentX: CGFloat) {
        guard let panel else { return }
        // The logo's backing stays fixed. Only the central body grows from the
        // camera cutout; the window contains their union throughout the motion.
        let windowFrame = body.map { compactFrame.union($0) } ?? compactFrame
        panel.setFrame(windowFrame, display: false)
        let actualFrame = panel.frame // AppKit may round to backing pixels.
        presentedBody = body
        surface.logoBacking = NSRect(x: compactFrame.minX - actualFrame.minX, y: 0,
                                     width: compactFrame.width, height: cameraHeight)
        surface.body = body.map {
            NSRect(x: $0.minX - actualFrame.minX, y: actualFrame.maxY - $0.maxY,
                   width: $0.width, height: $0.height)
        }
        launcherButton?.frame = NSRect(x: compactFrame.minX - actualFrame.minX, y: 0,
                                      width: NotchGeometry.logoWidth, height: cameraHeight)
        if let body {
            contentClip.frame = NSRect(x: body.minX - actualFrame.minX, y: cameraHeight,
                                       width: body.width, height: max(0, body.height - cameraHeight))
            content.setFrameOrigin(NSPoint(x: contentX - body.minX, y: 0))
        } else { contentClip.frame = .zero }
        surface.needsDisplay = true
        panel.displayIfNeeded()
    }

    private func present(frame: NSRect, compactFrame: NSRect, cameraFrame: NSRect) {
        guard let panel else { return }
        let changedState = presentedExpanded != expanded
        if transitionTimer != nil && !changedState && presentationTarget == frame {
            // A refresh may rebuild labels during an animation. Keep their
            // origin aligned without restarting the central body's motion.
            if expanded, let body = presentedBody {
                content.setFrameOrigin(NSPoint(x: frame.minX - body.minX, y: 0))
            }
            return
        }
        let animated = panel.isVisible && !reduceMotion() && (changedState || transitionTimer != nil)
        transitionTimer?.invalidate(); transitionTimer = nil
        let startBody = presentedBody ?? cameraFrame
        let targetBody = expanded ? frame : cameraFrame
        let contentX = expanded ? frame.minX : startBody.minX + content.frame.minX
        let startAlpha = content.isHidden ? 0 : content.alphaValue
        presentedExpanded = expanded
        presentationTarget = frame
        if !animated {
            content.isHidden = !expanded
            content.alphaValue = expanded ? 1 : 0
            applyPresentation(body: expanded ? frame : nil, compactFrame: compactFrame,
                              cameraHeight: cameraFrame.height, contentX: contentX)
            panel.orderFrontRegardless()
            return
        }
        let opening = expanded
        let started = ProcessInfo.processInfo.systemUptime
        let duration = opening ? 0.18 : 0.14
        content.isHidden = false
        content.alphaValue = startAlpha
        applyPresentation(body: startBody, compactFrame: compactFrame,
                          cameraHeight: cameraFrame.height, contentX: contentX)
        let transition = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            let elapsed = ProcessInfo.processInfo.systemUptime - started
            let progress = self.reduceMotion() ? 1 : min(1, elapsed / duration)
            let eased = CGFloat(progress * progress * (3 - 2 * progress))
            let body = NotchGeometry.interpolatedFrame(from: startBody, to: targetBody, progress: eased)
            if opening {
                let fade = min(1, max(0, (progress - 0.25) / 0.75))
                self.content.alphaValue = startAlpha + (1 - startAlpha) * fade
            } else {
                self.content.alphaValue = startAlpha * max(0, 1 - progress * 3)
            }
            self.applyPresentation(body: progress >= 1 && !opening ? nil : body, compactFrame: compactFrame,
                                   cameraHeight: cameraFrame.height, contentX: contentX)
            if progress >= 1 {
                timer.invalidate(); self.transitionTimer = nil
                self.content.isHidden = !opening
                self.content.alphaValue = opening ? 1 : 0
            }
        }
        transitionTimer = transition
        RunLoop.main.add(transition, forMode: .common)
        panel.orderFrontRegardless()
    }

    @objc private func toggleExpanded() {
        autoCollapseTimer?.invalidate(); autoCollapseTimer = nil
        expanded.toggle()
        if expanded { installClickDismissal(); refresh() } else { removeClickDismissal() }
        render()
    }
    @objc private func collapse() {
        autoCollapseTimer?.invalidate(); autoCollapseTimer = nil
        expanded = false; removeClickDismissal(); render()
    }
    private func removeClickDismissal() {
        if let localClick { NSEvent.removeMonitor(localClick) }
        if let globalClick { NSEvent.removeMonitor(globalClick) }
        localClick = nil; globalClick = nil
    }
    private func installClickDismissal() {
        removeClickDismissal()
        globalClick = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in self?.collapse() }
        localClick = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            if let self, event.window !== self.panel { self.collapse() }
            return event
        }
    }
    @objc private func previous() { selectedChange = (selectedChange + activity.changes.count - 1) % max(1, activity.changes.count); render() }
    @objc private func next() { selectedChange = (selectedChange + 1) % max(1, activity.changes.count); render() }
    @objc private func toggleSuggestions() { onToggleSuggestions?() }
    @objc private func openWorkspace() {
        onOpenWorkspace?(activity.stale > 0 || activity.failures > 0 ? "attention" : activity.changes.isEmpty ? "sources" : "changes")
        collapse()
    }
    #if BROWSER_GEOMETRY_TEST
    private static var regressionPanel: NotchPanelController?
    static func regression(outputPath: String?, keepOpen: Bool = false) -> [String: Any] {
        let controller = NotchPanelController()
        controller.reduceMotion = { true }
        var checks = 0
        func verify(_ condition: Bool) { precondition(condition, "Notch integration check failed (check \(checks + 1))"); checks += 1 }
        func surfaceBitmap() -> NSBitmapImageRep {
            let view = controller.surface
            view.displayIfNeeded()
            let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: bitmap)
            return bitmap
        }
        func isBlack(_ bitmap: NSBitmapImageRep, x: CGFloat, y: CGFloat) -> Bool {
            let scale = CGFloat(bitmap.pixelsWide) / controller.surface.bounds.width
            guard let color = bitmap.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.deviceRGB) else { return false }
            return color.alphaComponent > 0.99 && max(color.redComponent, color.greenComponent, color.blueComponent) < 0.01
        }
        controller.configure(enabled: false, serverURL: nil, suggestions: false)
        verify(controller.panel?.isVisible != true && controller.timer == nil)
        guard Self.isAvailable else {
            controller.configure(enabled: true, serverURL: nil, suggestions: false)
            verify(controller.panel?.isVisible != true && controller.timer == nil)
            return ["checks": checks, "supported": false]
        }
        controller.configure(enabled: true, serverURL: nil, suggestions: true, requested: true)
        verify(controller.panel?.isVisible == true && !controller.expanded && controller.content.isHidden)
        verify(controller.launcherButton?.title == "" && controller.launcherButton?.isHidden == false)
        let display = Self.supportedScreen!
        let compactFrame = controller.panel!.frame
        let logoFrame = controller.launcherButton!.frame
        verify(compactFrame.minY == display.frame.maxY - display.safeAreaInsets.top)
        verify(compactFrame.minX + logoFrame.maxX == display.auxiliaryTopLeftArea!.maxX)
        verify(compactFrame.maxX > display.auxiliaryTopLeftArea!.maxX)
        verify(controller.panel!.level.rawValue > NSWindow.Level.statusBar.rawValue && !controller.panel!.hasShadow)
        verify(controller.panel!.collectionBehavior.contains(.stationary))
        if #available(macOS 13.0, *) { verify(controller.panel!.collectionBehavior.contains(.canJoinAllApplications)) }
        let windowNumber = controller.panel!.windowNumber
        let compactBitmap = surfaceBitmap()
        // The exposed crescent at the old tab/housing seam must be opaque black,
        // including its bottom edge, rather than the desktop showing through.
        verify(isBlack(compactBitmap, x: logoFrame.maxX + 1, y: compactFrame.height - 1))
        verify(isBlack(compactBitmap, x: 1, y: 1))
        let baseline = NotchActivity(["changes": [["projectId": "p", "objectId": "value", "toVersion": 1]]])
        controller.receive(baseline); verify(!controller.expanded)
        controller.receive(baseline); verify(!controller.expanded)
        let changed = NotchActivity(["changes": [["projectId": "p", "objectId": "value", "toVersion": 2]]])
        controller.receive(changed); verify(controller.expanded && controller.autoCollapseTimer != nil)
        controller.collapse()
        controller.receive(changed); verify(!controller.expanded)
        let failure = NotchActivity(["failures": 1, "changes": changed.changes])
        controller.receive(failure); verify(controller.expanded)
        controller.collapse()
        controller.receive(failure); verify(!controller.expanded)
        controller.launcherButton?.performClick(nil); verify(controller.expanded && controller.autoCollapseTimer == nil)
        controller.launcherButton?.performClick(nil); verify(!controller.expanded)
        verify(controller.panel?.canBecomeKey == false)
        controller.baseURL = URL(string: "http://127.0.0.1:4319")
        controller.activity = NotchActivity(["directories": 6, "files": 125, "stale": 3,
            "changes": [["fileName": "Budget.xlsx", "projectName": "Finance", "locator": "Sheet1 · C14 · Total budget",
                         "previousValue": "$48,210", "currentValue": "$51,060", "unresolvedReferences": 3,
                         "fromVersion": 4, "toVersion": 5],
                        ["fileName": "Plan.pdf", "previousValue": "12 m²", "currentValue": "14 m²"]]])
        controller.issue = nil
        controller.expanded = true
        controller.installClickDismissal()
        controller.render()
        verify(controller.content.frame.height == 198 && controller.localClick != nil)
        let screen = Self.supportedScreen!
        verify(screen.frame.contains(controller.panel!.frame))
        verify(controller.panel!.frame.maxY == screen.frame.maxY)
        verify(controller.contentClip.frame.minY == screen.safeAreaInsets.top && controller.content.frame.minY == 0 && !controller.content.isHidden)
        verify(controller.panel!.frame.minX + controller.launcherButton!.frame.minX == compactFrame.minX + logoFrame.minX)
        verify(controller.launcherButton!.frame.maxY == screen.safeAreaInsets.top)
        verify(controller.panel?.appearance?.name == .darkAqua)
        verify(controller.panel!.windowNumber == windowNumber)
        let expandedBitmap = surfaceBitmap()
        // Both formerly transparent shoulders now meet the top edge in black.
        verify(isBlack(expandedBitmap, x: 1, y: 1))
        verify(isBlack(expandedBitmap, x: controller.surface.bounds.width - 2, y: 1))
        var toggles = 0; var destination = ""
        controller.onToggleSuggestions = { toggles += 1 }
        controller.onOpenWorkspace = { destination = $0 }
        let pause = controller.content.subviews.compactMap { $0 as? NSButton }.first { $0.title == "Pause suggestions" }
        pause?.performClick(nil)
        verify(toggles == 1)
        controller.next(); verify(controller.selectedChange == 1)
        controller.previous(); verify(controller.selectedChange == 0)
        controller.panel?.displayIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        verify(controller.content.bounds.width == controller.surface.bounds.width)
        if keepOpen {
            regressionPanel = controller
            controller.timer?.invalidate(); controller.timer = nil
            return ["checks": checks, "supported": true, "windowNumber": controller.panel!.windowNumber]
        }
        if let outputPath, let view = controller.panel?.contentView,
           let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: outputPath))
        }
        controller.collapse()
        controller.baseURL = nil // Keep animation fixtures independent of the live server.
        controller.reduceMotion = { false }
        controller.launcherButton?.performClick(nil)
        verify(controller.transitionTimer != nil && controller.expanded)
        RunLoop.current.run(until: Date().addingTimeInterval(0.06))
        verify(controller.panel!.frame.height > compactFrame.height && controller.panel!.frame.height < controller.presentationTarget.height)
        verify(controller.panel!.frame.maxY == screen.frame.maxY)
        verify(abs(controller.panel!.frame.minX + controller.launcherButton!.frame.minX - compactFrame.minX) < 0.01)
        verify(controller.content.frame.width == controller.presentationTarget.width)
        let cameraCenter = (screen.auxiliaryTopLeftArea!.maxX + screen.auxiliaryTopRightArea!.minX) / 2
        verify(abs(controller.presentedBody!.midX - cameraCenter) < 0.01)
        verify(controller.contentClip.clipsToBounds && abs(controller.contentClip.frame.width - controller.presentedBody!.width) < 0.01)
        // Reverse twice before finishing. No stale callback can leave a tiny
        // panel behind or hide a newer expanded state.
        controller.collapse()
        controller.launcherButton?.performClick(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.24))
        verify(controller.expanded && controller.transitionTimer == nil && controller.panel!.frame == controller.presentationTarget)
        verify(!controller.content.isHidden && controller.content.alphaValue == 1)
        controller.collapse()
        RunLoop.current.run(until: Date().addingTimeInterval(0.20))
        verify(controller.panel!.frame == compactFrame && controller.content.isHidden && controller.transitionTimer == nil && controller.presentedBody == nil)
        controller.reduceMotion = { true }
        controller.launcherButton?.performClick(nil)
        verify(controller.transitionTimer == nil && controller.expanded && controller.panel!.frame == controller.presentationTarget)
        controller.openWorkspace()
        verify(destination == "attention" && !controller.expanded)
        verify(controller.localClick == nil && controller.globalClick == nil)
        controller.reduceMotion = { false }
        controller.launcherButton?.performClick(nil)
        controller.configure(enabled: false, serverURL: nil, suggestions: false)
        RunLoop.current.run(until: Date().addingTimeInterval(0.22))
        verify(controller.panel?.isVisible == false
            && controller.timer == nil && controller.task == nil && controller.autoCollapseTimer == nil && controller.transitionTimer == nil)
        return ["checks": checks, "supported": true]
    }
    #endif

}
