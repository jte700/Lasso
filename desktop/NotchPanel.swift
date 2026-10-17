import Cocoa

/// Geometry is expressed in AppKit screen coordinates, including displays
/// above/below the primary screen. No model-name guesses or camera heuristics.
enum NotchGeometry {
    static let logoWidth: CGFloat = 32
    static func supported(builtIn: Bool, topInset: CGFloat, left: NSRect?, right: NSRect?) -> Bool {
        guard builtIn, topInset > 0, let left, let right else { return false }
        return left.width > 0 && right.width > 0 && right.minX > left.maxX
    }

    static func frame(screen: NSRect, topInset: CGFloat, centerX: CGFloat, expanded: Bool, notchWidth: CGFloat = 200) -> NSRect {
        if !expanded {
            // Paint beneath the housing's curved left corner, not just up to
            // its rectangular safe-area boundary. Keep the logo outside it.
            let overlap = min(topInset, notchWidth / 2)
            return NSRect(x: max(screen.minX, centerX - notchWidth / 2 - logoWidth),
                          y: screen.maxY - topInset, width: logoWidth + overlap, height: topInset)
        }
        let width = min(max(440.0, notchWidth + 2 * logoWidth), screen.width - 24)
        let height = topInset + min(272.0, screen.height - topInset - 12)
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
    var expanded = false
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        let radius: CGFloat = expanded ? 18 : 10
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        // Square off the top corners so black meets the physical screen edge.
        NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height / 2).fill()
        if !expanded {
            // This edge is hidden inside the camera housing, so only the
            // outer bottom-left corner should be rounded when collapsed.
            NSRect(x: bounds.midX, y: 0, width: bounds.width / 2, height: bounds.height).fill()
        }
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
    private let content = NotchContent()
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
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.title = "Lasso notch"
        content.frame = NSRect(x: 0, y: 0, width: 440, height: 272)
        panel.appearance = NSAppearance(named: .darkAqua)
        surface.addSubview(content)
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
                    self.issue = "Activity unavailable. Open Lasso to check the server."
                    if newlyUnavailable { self.presentActivity() }
                }
                self.render()
            }
        }
        task?.resume()
    }

    private func label(_ text: String, x: CGFloat = 20, y: CGFloat, width: CGFloat = 400,
                       size: CGFloat = 13, color: NSColor = .labelColor, bold: Bool = false, height: CGFloat = 20) {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: size, weight: bold ? .semibold : .regular)
        label.textColor = color
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: x, y: y, width: width, height: height)
        label.toolTip = text
        content.addSubview(label)
    }

    @discardableResult
    private func button(_ title: String, frame: NSRect, action: Selector, symbol: String? = nil) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.font = .systemFont(ofSize: 12, weight: .medium)
        button.frame = frame
        if let symbol { button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
        button.imagePosition = .imageLeading
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
                                       centerX: center, expanded: expanded, notchWidth: notchWidth)
        panel.setFrame(frame, display: true)
        panel.contentView?.layoutSubtreeIfNeeded()
        surface.expanded = expanded
        surface.needsDisplay = true
        // The logo never moves or gets hidden behind the camera as we expand.
        launcherButton?.frame = NSRect(x: center - notchWidth / 2 - NotchGeometry.logoWidth - frame.minX,
                                      y: 0, width: NotchGeometry.logoWidth, height: screen.safeAreaInsets.top)
        launcherButton?.setAccessibilityLabel(expanded ? "Close Lasso notch" : "Open Lasso notch")
        panel.title = expanded ? "Lasso notch" : "Lasso notch control"
        content.isHidden = !expanded
        guard expanded else { panel.orderFrontRegardless(); return }
        content.frame = NSRect(x: 0, y: screen.safeAreaInsets.top, width: frame.width,
                               height: frame.height - screen.safeAreaInsets.top)
        content.subviews.forEach { $0.removeFromSuperview() }
        label("Lasso", y: 17, size: 15, bold: true)
        button("", frame: NSRect(x: 394, y: 10, width: 30, height: 28),
               action: #selector(collapse), symbol: "chevron.up").setAccessibilityLabel("Collapse notch")
        label("\(activity.directories) active directories · \(activity.files) indexed files", y: 43,
              color: .secondaryLabelColor)
        let separator = NSBox(frame: NSRect(x: 20, y: 73, width: 400, height: 1))
        separator.boxType = .separator; content.addSubview(separator)
        if let issue {
            label(issue, y: 88, color: .systemOrange)
            label("Your recorded sources stay on this Mac.", y: 119, color: .secondaryLabelColor)
        } else if !activity.changes.isEmpty {
            selectedChange = min(selectedChange, activity.changes.count - 1)
            let change = activity.changes[selectedChange]
            label("Latest changes · \(selectedChange + 1) of \(activity.changes.count)", y: 85, size: 11, color: .secondaryLabelColor)
            label(change["fileName"] as? String ?? change["name"] as? String ?? "Source changed",
                  y: 105, width: 330, bold: true)
            label([change["projectName"], change["locator"]].compactMap { $0 as? String }.joined(separator: " · "),
                  y: 128, size: 11, color: .secondaryLabelColor)
            let moved = change["moved"] as? Bool == true
            let old = (moved ? change["previousPath"] : change["previousValue"]) as? String ?? "Removed"
            let new = (moved ? change["path"] : change["currentValue"]) as? String ?? "Removed"
            label("\(old) → \(new)", y: 152, size: 17, color: .systemGreen, bold: true)
            let count = change["unresolvedReferences"] as? Int ?? 0
            label("\(count) reference\(count == 1 ? "" : "s") to review · v\(change["fromVersion"] ?? "?") → v\(change["toVersion"] ?? "?")",
                  y: 181, size: 11, color: .secondaryLabelColor)
            if activity.changes.count > 1 {
                button("", frame: NSRect(x: 352, y: 101, width: 28, height: 27), action: #selector(previous), symbol: "chevron.left").setAccessibilityLabel("Previous change")
                button("", frame: NSRect(x: 388, y: 101, width: 28, height: 27), action: #selector(next), symbol: "chevron.right").setAccessibilityLabel("Next change")
            }
        } else {
            label(initialized ? "Your source library is ready" : "Loading source activity…", y: 94, size: 15, bold: true)
            label(activity.directories == 0 ? "Add or enable a work directory in the Lasso menu."
                : "Source changes will appear here as you work.", y: 126, size: 12, color: .secondaryLabelColor)
        }
        if activity.failures > 0 {
            label("\(activity.failures) indexing or directory issue\(activity.failures == 1 ? "" : "s")", y: 203,
                  size: 11, color: .systemOrange)
        }
        button(suggestionsRequested ? "Pause suggestions" : "Resume suggestions",
               frame: NSRect(x: 16, y: 232, width: 175, height: 28), action: #selector(toggleSuggestions))
            .isEnabled = baseURL != nil
        button(activity.stale > 0 || activity.failures > 0 ? "Review sources" : "Open sources",
               frame: NSRect(x: 251, y: 232, width: 173, height: 28), action: #selector(openWorkspace),
               symbol: "arrow.up.right.square").isEnabled = baseURL != nil
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
        verify(controller.content.frame.height == 272 && controller.localClick != nil)
        let screen = Self.supportedScreen!
        verify(screen.frame.contains(controller.panel!.frame))
        verify(controller.panel!.frame.maxY == screen.frame.maxY)
        verify(controller.content.frame.minY == screen.safeAreaInsets.top && !controller.content.isHidden)
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
        controller.openWorkspace()
        verify(destination == "attention" && !controller.expanded)
        verify(controller.localClick == nil && controller.globalClick == nil)
        controller.configure(enabled: false, serverURL: nil, suggestions: false)
        verify(controller.panel?.isVisible == false
            && controller.timer == nil && controller.task == nil && controller.autoCollapseTimer == nil)
        return ["checks": checks, "supported": true]
    }
    #endif

}
