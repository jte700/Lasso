import Cocoa

/// Geometry is expressed in AppKit screen coordinates, including displays
/// above/below the primary screen. No model-name guesses or camera heuristics.
enum NotchGeometry {
    static let overshootAllowance: CGFloat = 24
    static func motionFrame(screen: NSRect, compact: NSRect, from start: NSRect, to target: NSRect) -> NSRect {
        compact.union(start).union(target.insetBy(dx: -overshootAllowance, dy: -overshootAllowance))
            .intersection(screen).integral
    }

    static func supported(builtIn: Bool, topInset: CGFloat, left: NSRect?, right: NSRect?) -> Bool {
        guard builtIn, topInset > 0, let left, let right else { return false }
        return left.width > 0 && right.width > 0 && right.minX > left.maxX
    }

    static func frame(screen: NSRect, topInset: CGFloat, centerX: CGFloat, expanded: Bool, notchWidth: CGFloat = 200, contentHeight: CGFloat = 198) -> NSRect {
        // At rest the entire window coincides with the real camera housing.
        // There is no permanently painted logo tab alongside it.
        if !expanded {
            return NSRect(x: centerX - notchWidth / 2, y: screen.maxY - topInset,
                          width: notchWidth, height: topInset)
        }
        let width = min(max(380.0, notchWidth + 64), screen.width - 24)
        let height = topInset + min(contentHeight, screen.height - topInset - 12)
        let x = min(max(centerX - width / 2, screen.minX + 12), screen.maxX - width - 12)
        return NSRect(x: x, y: screen.maxY - height, width: width, height: height).integral
    }
}

enum NotchPresentation {
    case collapsed, notification, expanded
}

struct NotchActivity {
    var directories = 0
    var files = 0
    var stale = 0
    var failures = 0
    var changes: [[String: Any]] = []
    var linkedSourceObjectIDs: Set<String>?
    init(_ json: [String: Any] = [:]) {
        linkedSourceObjectIDs = (json["linkedSourceObjectIds"] as? [String]).map { Set($0) }
        directories = max(0, json["directories"] as? Int ?? 0)
        files = max(0, json["files"] as? Int ?? 0)
        stale = max(0, json["stale"] as? Int ?? 0)
        failures = max(0, json["failures"] as? Int ?? 0)
        changes = Array((json["changes"] as? [[String: Any]] ?? []).prefix(8))
        linkedChanges = Array((json["linkedChanges"] as? [[String: Any]]
            ?? changes.filter { ($0["referenceCount"] as? Int ?? 0) > 0 }).prefix(256))
    }
    var linkedChanges: [[String: Any]] = []
    static func key(_ change: [String: Any]) -> String {
        [change["projectId"], change["objectId"], change["toVersion"]]
            .map { String(describing: $0 ?? "") }.joined(separator: ":")
    }
    var changeKeys: Set<String> { Set(linkedChanges.map(Self.key)) }
    var newestKey: String? { changes.first.map(Self.key) }
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
    var onClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) {
        if let onClick { onClick() } else { super.mouseDown(with: event) }
    }
}

/// One continuous silhouette grows out of the actual camera housing.
private final class NotchSurface: NSView {
    override var isFlipped: Bool { true }
    var onPointerChanged: (() -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
    }
    override func mouseEntered(with event: NSEvent) { onPointerChanged?() }
    override func mouseExited(with event: NSEvent) { onPointerChanged?() }
    override func mouseMoved(with event: NSEvent) { onPointerChanged?() }

    override func draw(_ dirtyRect: NSRect) {
        let w = bounds.width, h = bounds.height
        let radius = min(22, h * 0.45)
        let shoulder: CGFloat = min(8, h * 0.2)
        let path = NSBezierPath()
        path.move(to: NSPoint(x: 0, y: 0))
        path.curve(to: NSPoint(x: shoulder, y: shoulder),
                   controlPoint1: NSPoint(x: shoulder * 0.6, y: 0), controlPoint2: NSPoint(x: shoulder, y: shoulder * 0.4))
        path.line(to: NSPoint(x: shoulder, y: h - radius))
        path.curve(to: NSPoint(x: shoulder + radius, y: h),
                   controlPoint1: NSPoint(x: shoulder, y: h - radius * 0.45), controlPoint2: NSPoint(x: shoulder + radius * 0.45, y: h))
        path.line(to: NSPoint(x: w - shoulder - radius, y: h))
        path.curve(to: NSPoint(x: w - shoulder, y: h - radius),
                   controlPoint1: NSPoint(x: w - shoulder - radius * 0.45, y: h), controlPoint2: NSPoint(x: w - shoulder, y: h - radius * 0.45))
        path.line(to: NSPoint(x: w - shoulder, y: shoulder))
        path.curve(to: NSPoint(x: w, y: 0),
                   controlPoint1: NSPoint(x: w - shoulder, y: shoulder * 0.4), controlPoint2: NSPoint(x: w - shoulder * 0.6, y: 0))
        path.close()
        NSColor.black.setFill(); path.fill()
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
    var linkedSourceObjectIDs: (() -> [String])?
    var onToggleSuggestions: (() -> Void)?
    var onOpenWorkspace: ((String) -> Void)?
    private var panel: NotchWindow?
    private var launcherButton: NSButton?
    private var autoCollapseTimer: Timer?
    private var frameClock: NotchFrameClock?
    private var motion: NotchBodyMotion?
    private var contentReveal = NotchSpring(0)
    private var lastFrameTime: TimeInterval = 0
    private var motionWindowFrame = NSRect.zero
    private var motionCompactFrame = NSRect.zero
    private var cameraHeight: CGFloat = 0
    private var contentScreenX: CGFloat = 0
    private var presentedExpanded = false
    private let windowContent = NotchContent()
    private var presentationTarget = NSRect.zero
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
    private var state = NotchPresentation.collapsed
    private var expanded: Bool { state != .collapsed }
    private var hoverOpened = false
    private var hoverTimer: Timer?
    private var hoverExitTimer: Timer?
    private var notificationChange: [String: Any]?
    private var seenChangeKeys = Set<String>()
    private var cameraFrame = NSRect.zero
    private var pointerLocation = { NSEvent.mouseLocation }
    private var hoverSuppressedUntilExit = false
    private var subscribedSourceIDs = Set<String>()
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
            seenChangeKeys.removeAll(); subscribedSourceIDs.removeAll(); notificationChange = nil
            state = .collapsed; hoverOpened = false
            autoCollapseTimer?.invalidate(); autoCollapseTimer = nil
            hoverTimer?.invalidate(); hoverTimer = nil
            hoverExitTimer?.invalidate(); hoverExitTimer = nil
        }
        if serverURL == nil { issue = "Waiting for the local server…" }
        guard self.enabled else { stop(); return }
        if panel == nil { makePanel() }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
            timer?.tolerance = 0.5
        }
        installClickDismissal()
        render()
        if !wasEnabled || changedServer || !initialized { refresh() }
    }

    func stop() {
        enabled = false
        generation += 1; task?.cancel(); task = nil
        timer?.invalidate(); timer = nil
        frameClock?.invalidate(); frameClock = nil
        motion = nil; contentReveal = NotchSpring(0)
        presentedBody = nil
        content.isHidden = true
        content.alphaValue = 0
        panel?.orderOut(nil)
        autoCollapseTimer?.invalidate(); autoCollapseTimer = nil
        state = .collapsed; hoverOpened = false
        hoverTimer?.invalidate(); hoverTimer = nil
        hoverExitTimer?.invalidate(); hoverExitTimer = nil
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
        panel.acceptsMouseMovedEvents = true
        panel.title = "Lasso notch"
        content.frame = NSRect(x: 0, y: 0, width: 360, height: 198)
        panel.appearance = NSAppearance(named: .darkAqua)
        content.onClick = { [weak self] in
            guard let self, self.state == .notification else { return }
            self.toggleExpanded()
        }
        contentClip.clipsToBounds = true
        contentClip.addSubview(content)
        surface.addSubview(contentClip)
        windowContent.addSubview(surface)
        panel.contentView = windowContent
        self.panel = panel
        let button = NSButton(title: "", target: self, action: #selector(toggleExpanded))
        button.isBordered = false
        button.imagePosition = .imageOnly
        // An invisible, accessible button covers the whole camera band.
        // The hardware hides pixels here, but the pointer still reaches it.
        button.image = nil
        button.contentTintColor = .white
        button.setAccessibilityLabel("Open Lasso notch")
        button.toolTip = "Open Lasso"
        surface.addSubview(button)
        launcherButton = button
        surface.onPointerChanged = { [weak self] in guard let self else { return }; self.handlePointer(at: self.pointerLocation()) }
    }

    private func receive(_ next: NotchActivity, newlyLinkedSourceIDs: Set<String> = []) {
        let newSubscriptions = next.linkedSourceObjectIDs.map { $0.subtracting(subscribedSourceIDs) } ?? newlyLinkedSourceIDs
        if let ids = next.linkedSourceObjectIDs { subscribedSourceIDs = ids }
        let unseen = next.linkedChanges.filter {
            !seenChangeKeys.contains(NotchActivity.key($0))
                && !newSubscriptions.contains($0["objectId"] as? String ?? "")
        }
        let shouldPresent = initialized && (!unseen.isEmpty || next.failures > activity.failures || next.stale > activity.stale)
        if next.newestKey != activity.newestKey { selectedChange = 0 }
        notificationChange = unseen.first ?? (shouldPresent ? nil : notificationChange)
        seenChangeKeys.formUnion(next.changeKeys)
        // Bound session history without allowing a reordered eight-row summary
        // to reopen a previously seen source notification.
        if seenChangeKeys.count > 4096 { seenChangeKeys = next.changeKeys }
        activity = next
        initialized = true; issue = nil; failedPolls = 0
        if shouldPresent { presentActivity() }
        render()
    }

    private func presentActivity() {
        guard enabled, state != .expanded else { return }
        state = .notification
        hoverTimer?.invalidate(); hoverTimer = nil
        hoverExitTimer?.invalidate(); hoverExitTimer = nil
        hoverOpened = false
        scheduleAutoCollapse()
    }

    private func scheduleAutoCollapse() {
        autoCollapseTimer?.invalidate()
        autoCollapseTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
            guard let self, self.state == .notification else { return }
            if self.visibleFrame.contains(self.pointerLocation()) == true {
                self.scheduleAutoCollapse()
            } else { self.collapse() }
        }
    }

    private var failedPolls = 0
    private static let failedPollsBeforeAlert = 2

    private func refresh() {
        guard enabled, task == nil, let baseURL else { return }
        let token = generation
        var components = URLComponents(url: baseURL.appendingPathComponent("api/workspace/activity"), resolvingAgainstBaseURL: false)!
        let requestSourceIDs = Set((linkedSourceObjectIDs?() ?? []).prefix(256))
        components.queryItems = requestSourceIDs.sorted().map { URLQueryItem(name: "sourceObjectId", value: $0) }
        guard let url = components.url else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, self.enabled, token == self.generation else { return }
                self.task = nil
                if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                   let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let payload = json["activity"] as? [String: Any] {
                    let newlyLinked = requestSourceIDs.subtracting(self.subscribedSourceIDs)
                    let next = NotchActivity(payload)
                    self.receive(next, newlyLinkedSourceIDs: newlyLinked)
                    if next.linkedSourceObjectIDs == nil { self.subscribedSourceIDs = requestSourceIDs }
                } else {
                    // One missed poll usually means the server is busy reading
                    // a large folder. Interrupt the user only if it persists.
                    self.failedPolls += 1
                    let newlyUnavailable = self.initialized && self.issue == nil
                        && self.failedPolls >= Self.failedPollsBeforeAlert
                    if self.failedPolls >= Self.failedPollsBeforeAlert {
                        self.issue = "Activity unavailable. Open Lasso to check."
                    }
                    if newlyUnavailable { self.notificationChange = nil; self.presentActivity() }
                }
                self.render()
            }
        }
        task?.resume()
    }

    // The footer keeps the same 14-point inset from the bottom as from the
    // sides, and an issue line gets its own row above it rather than a squeeze.
    private static let footerInset: CGFloat = 14
    private static let issueRowHeight: CGFloat = 26

    private var expandedContentHeight: CGFloat {
        if state == .notification { return 92 }
        return (issue == nil && !activity.changes.isEmpty ? 208 : 148) + (activity.failures > 0 ? Self.issueRowHeight : 0)
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
        self.cameraFrame = cameraFrame
        launcherButton?.setAccessibilityLabel(state == .expanded ? "Close Lasso notch" : "Open Lasso notch")
        panel.title = expanded ? "Lasso notch" : "Lasso notch control"
        guard expanded else {
            present(frame: frame, compactFrame: compactFrame, cameraFrame: cameraFrame)
            return
        }
        content.frame = NSRect(x: 0, y: 0, width: frame.width,
                               height: frame.height - screen.safeAreaInsets.top)
        content.subviews.forEach { $0.removeFromSuperview() }
        let width = content.bounds.width
        if state == .notification {
            renderNotification(width: width)
            present(frame: frame, compactFrame: compactFrame, cameraFrame: cameraFrame)
            return
        }
        let footerY = content.bounds.height - Self.footerInset - 28
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
            let summary = change["removed"] as? Bool == true ? "Source removed"
                : change["restored"] as? Bool == true ? "Source restored"
                : change["contentChanged"] as? Bool == true ? "Source contents updated" : "\(old) → \(new)"
            label(summary, y: 106, size: 16, color: .systemGreen, bold: true, height: 24)
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
            label("\(activity.failures) indexing or directory issue\(activity.failures == 1 ? "" : "s")", y: footerY - Self.issueRowHeight - 2,
                  size: 10, color: .systemOrange, height: 16)
        }
        let actionWidth = (width - 36) / 2
        button(suggestionsRequested ? "Pause Suggestions" : "Resume Suggestions",
               frame: NSRect(x: 14, y: footerY, width: actionWidth, height: 28), action: #selector(toggleSuggestions))
            .isEnabled = baseURL != nil
        button(activity.stale > 0 || activity.failures > 0 ? "Review Sources" : "Open Sources",
               frame: NSRect(x: width - 14 - actionWidth, y: footerY, width: actionWidth, height: 28), action: #selector(openWorkspace),
               symbol: "arrow.up.right.square").isEnabled = baseURL != nil
        present(frame: frame, compactFrame: compactFrame, cameraFrame: cameraFrame)
    }

    private func renderNotification(width: CGFloat) {
        let change = notificationChange
        let title = issue != nil ? "Lasso needs attention" : change != nil ? "Linked source changed" : activity.failures > 0 ? "Source needs attention" : "Linked sources need review"
        label(title, x: 24, y: 8, width: width - 122, size: 11, color: .secondaryLabelColor, bold: true, height: 16)
        label(change?["fileName"] as? String ?? issue ?? "Review your source library",
              x: 24, y: 29, width: width - 48, size: 13, bold: true, height: 19)
        let summary: String
        if let change {
            if change["removed"] as? Bool == true { summary = "Source removed · linked text needs review" }
            else if change["restored"] as? Bool == true { summary = "Source restored · linked text needs review" }
            else if change["moved"] as? Bool == true { summary = "Source moved · linked text needs review" }
            else if change["contentChanged"] as? Bool == true { summary = "Contents updated · linked text needs review" }
            else { summary = "\(change["previousValue"] as? String ?? "Previous value") → \(change["currentValue"] as? String ?? "Updated value")" }
        } else { summary = "Open Lasso to review the changes." }
        label(summary, x: 24, y: 53, width: width - 48, size: 12, color: .systemGreen, height: 18)
        button("Details", frame: NSRect(x: width - 94, y: 4, width: 70, height: 26), action: #selector(toggleExpanded))
            .setAccessibilityLabel("Show source change details")
    }

    private var visibleFrame: NSRect { presentedBody ?? cameraFrame }

    private func applyPresentation(body: NSRect?, windowFrame: NSRect, compactFrame: NSRect, cameraHeight: CGFloat) {
        guard let panel else { return }
        if panel.frame != windowFrame { panel.setFrame(windowFrame, display: false) }
        let actualFrame = panel.frame
        let visible = body ?? compactFrame
        presentedBody = body
        surface.frame = NSRect(x: visible.minX - actualFrame.minX, y: actualFrame.maxY - visible.maxY,
                               width: visible.width, height: visible.height)
        launcherButton?.frame = NSRect(x: 0, y: 0, width: visible.width, height: cameraHeight)
        contentClip.frame = NSRect(x: 0, y: cameraHeight, width: visible.width,
                                   height: max(0, visible.height - cameraHeight))
        let reveal = min(1, max(0, contentReveal.value))
        content.setFrameOrigin(NSPoint(x: contentScreenX - visible.minX, y: -6 * (1 - reveal)))
        content.alphaValue = reveal
        surface.needsDisplay = true
        panel.displayIfNeeded()
    }

    private func present(frame: NSRect, compactFrame: NSRect, cameraFrame: NSRect) {
        guard let panel, let screen = Self.supportedScreen else { return }
        let changed = presentationTarget != frame
        let animated = panel.isVisible && !reduceMotion() && (changed || motion != nil)
        presentationTarget = frame
        presentedExpanded = expanded
        motionCompactFrame = compactFrame
        cameraHeight = cameraFrame.height
        if expanded { contentScreenX = frame.minX }
        guard animated else {
            finishMotion(); panel.orderFrontRegardless(); return
        }
        let next = motion?.retargeted(to: frame) ?? NotchBodyMotion(from: visibleFrame, to: frame)
        let room = NotchGeometry.motionFrame(screen: screen.frame, compact: compactFrame, from: next.frame, to: frame)
        motionWindowFrame = motion == nil ? room : motionWindowFrame.union(room)
        motion = next
        content.isHidden = false
        panel.orderFrontRegardless()
        if frameClock == nil {
            lastFrameTime = ProcessInfo.processInfo.systemUptime
            frameClock = NotchFrameClock(view: surface) { [weak self] in self?.stepMotion() }
        }
        applyMotion()
    }

    private func stepMotion() {
        guard let motion, !reduceMotion() else { finishMotion(); return }
        let now = ProcessInfo.processInfo.systemUptime
        let elapsed = min(now - lastFrameTime, 1.0 / 30)
        lastFrameTime = now
        let moved = motion.advanced(by: elapsed, style: presentedExpanded ? .open : .close)
        let travel = presentationTarget.height - cameraHeight
        let openness = travel > 0 ? (moved.frame.height - cameraHeight) / travel : 1
        let showContent = presentedExpanded && openness >= 0.3
        contentReveal = contentReveal.retargeted(to: showContent ? 1 : 0)
            .advanced(by: elapsed, style: presentedExpanded ? .contentIn : .contentOut)
        self.motion = moved
        if moved.isSettled && contentReveal.isSettled(within: 0.01) { finishMotion(); return }
        applyMotion()
    }

    private func applyMotion() {
        guard let motion else { return }
        let body = motion.frame
        if !motionWindowFrame.contains(body) { motionWindowFrame = motionWindowFrame.union(body).integral }
        applyPresentation(body: body, windowFrame: motionWindowFrame,
                          compactFrame: motionCompactFrame, cameraHeight: cameraHeight)
    }

    private func finishMotion() {
        frameClock?.invalidate(); frameClock = nil
        motion = nil
        contentReveal = NotchSpring(presentedExpanded ? 1 : 0)
        content.isHidden = !presentedExpanded
        applyPresentation(body: presentedExpanded ? presentationTarget : nil, windowFrame: presentationTarget,
                          compactFrame: motionCompactFrame, cameraHeight: cameraHeight)
    }

    @objc private func toggleExpanded() {
        autoCollapseTimer?.invalidate(); autoCollapseTimer = nil
        hoverTimer?.invalidate(); hoverTimer = nil
        hoverExitTimer?.invalidate(); hoverExitTimer = nil
        if state == .expanded && !hoverOpened { collapse(); return }
        if state == .notification, let change = notificationChange {
            let key = NotchActivity.key(change)
            if let index = activity.changes.firstIndex(where: { NotchActivity.key($0) == key }) { selectedChange = index }
            else { activity.changes.insert(change, at: 0); activity.changes = Array(activity.changes.prefix(8)); selectedChange = 0 }
        }
        state = .expanded; hoverOpened = false
        refresh(); render()
    }

    @objc private func collapse() {
        autoCollapseTimer?.invalidate(); autoCollapseTimer = nil
        hoverTimer?.invalidate(); hoverTimer = nil
        hoverExitTimer?.invalidate(); hoverExitTimer = nil
        state = .collapsed; hoverOpened = false; hoverSuppressedUntilExit = true; render()
    }

    private func handlePointer(at point: NSPoint) {
        guard enabled, panel != nil else { return }
        if !cameraFrame.contains(point) { hoverSuppressedUntilExit = false }
        let inside = (expanded ? visibleFrame : cameraFrame).contains(point)
        if inside {
            hoverExitTimer?.invalidate(); hoverExitTimer = nil
            guard !expanded, !hoverSuppressedUntilExit, hoverTimer == nil else { return }
            hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
                guard let self else { return }
                self.hoverTimer = nil
                guard self.enabled, !self.expanded, self.cameraFrame.contains(self.pointerLocation()) else { return }
                self.state = .expanded; self.hoverOpened = true
                self.refresh(); self.render()
            }
        } else {
            hoverTimer?.invalidate(); hoverTimer = nil
            guard state == .expanded, hoverExitTimer == nil else { return }
            hoverExitTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                guard let self else { return }
                self.hoverExitTimer = nil
                if self.state == .expanded, !self.visibleFrame.contains(self.pointerLocation()) { self.collapse() }
            }
        }
    }

    private func handleOutsideEvent(_ event: NSEvent, local: Bool) {
        let point = pointerLocation()
        if event.type == .mouseMoved { handlePointer(at: point); return }
        if local && event.window === panel {
            // Content interaction completes hover activation before the control action.
            if expanded, event.type == .leftMouseDown, let panel,
               point.y < panel.frame.maxY - cameraFrame.height {
                hoverOpened = false; hoverExitTimer?.invalidate(); hoverExitTimer = nil
            }
            return // Let controls handle their own click.
        }
        // WindowServer may route a click within the physical camera housing to
        // another app. Geometry makes that click an activation, not dismissal.
        if cameraFrame.contains(point), event.type == .leftMouseDown { toggleExpanded() }
        else if !visibleFrame.contains(point), expanded { collapse() }
    }

    private func installClickDismissal() {
        guard localClick == nil && globalClick == nil else { return }
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDown, .rightMouseDown]
        globalClick = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            self?.handleOutsideEvent(event, local: false)
        }
        localClick = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            self?.handleOutsideEvent(event, local: true)
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
        var pointer = NSPoint(x: -100000, y: -100000)
        controller.pointerLocation = { pointer }
        var checks = 0
        func verify(_ condition: Bool, line: UInt = #line) { precondition(condition, "Notch integration check failed (check \(checks + 1), line \(line))"); checks += 1 }
        func capture(_ suffix: String) {
            guard let outputPath, let view = controller.panel == nil ? nil : controller.surface,
                  let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let url = URL(fileURLWithPath: outputPath).deletingPathExtension().appendingPathExtension(suffix + ".png")
            try? bitmap.representation(using: .png, properties: [:])?.write(to: url)
        }
        controller.configure(enabled: false, serverURL: nil, suggestions: false)
        verify(controller.panel?.isVisible != true && controller.timer == nil)
        guard Self.isAvailable else {
            controller.configure(enabled: true, serverURL: nil, suggestions: false)
            verify(controller.panel?.isVisible != true && controller.timer == nil)
            return ["checks": checks, "supported": false]
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        controller.configure(enabled: true, serverURL: nil, suggestions: true, requested: true)
        verify(controller.panel?.isVisible == true && !controller.expanded && controller.content.isHidden)
        controller.timer?.invalidate(); controller.timer = nil
        verify(controller.localClick != nil && controller.globalClick != nil)
        if let local = controller.localClick { NSEvent.removeMonitor(local) }
        if let global = controller.globalClick { NSEvent.removeMonitor(global) }
        controller.localClick = nil; controller.globalClick = nil
        controller.surface.onPointerChanged = nil // Drive pointer fixtures explicitly.
        let display = Self.supportedScreen!
        let compactFrame = controller.panel!.frame
        verify(compactFrame == controller.cameraFrame)
        verify(compactFrame.minX == display.auxiliaryTopLeftArea!.maxX && compactFrame.maxX == display.auxiliaryTopRightArea!.minX)
        verify(controller.launcherButton!.frame == controller.surface.bounds && controller.launcherButton!.image == nil)
        for x in [CGFloat(1), compactFrame.width / 2, compactFrame.width - 1] {
            verify(controller.surface.hitTest(NSPoint(x: x, y: compactFrame.height / 2)) === controller.launcherButton)
        }
        verify(controller.panel!.level.rawValue > NSWindow.Level.statusBar.rawValue && !controller.panel!.hasShadow)
        verify(!controller.panel!.canBecomeKey && !controller.panel!.canBecomeMain)
        capture("collapsed")
        func activity(_ version: Int, linked: Bool = true) -> NotchActivity {
            NotchActivity(["directories": 6, "files": 125, "changes": [[
                "projectId": "p", "objectId": "budget", "toVersion": version, "fromVersion": version - 1,
                "fileName": "Budget.xlsx", "projectName": "Finance", "locator": "Sheet1 · C14 · Total budget",
                "previousValue": "$48,210", "currentValue": "$51,060", "referenceCount": linked ? 1 : 0,
                "unresolvedReferences": 1]]])
        }
        controller.receive(activity(1)); verify(!controller.expanded)
        controller.receive(activity(1)); verify(!controller.expanded)
        controller.receive(activity(2, linked: false)); verify(!controller.expanded)
        controller.receive(activity(2)); verify(controller.state == .notification && controller.autoCollapseTimer != nil)
        verify(controller.content.frame.height == 92)
        verify(controller.contentClip.frame.minY == display.safeAreaInsets.top)
        verify(NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmost)
        capture("notification")
        let oldTimer = controller.autoCollapseTimer
        controller.receive(activity(3)); verify(controller.state == .notification && controller.autoCollapseTimer !== oldTimer)
        controller.autoCollapseTimer?.fire(); verify(!controller.expanded)
        controller.receive(activity(3)); verify(!controller.expanded)
        controller.receive(activity(1)); verify(!controller.expanded) // Older/reordered history is already seen.
        controller.receive(activity(4), newlyLinkedSourceIDs: ["budget"]); verify(!controller.expanded)
        controller.receive(activity(5)); verify(controller.state == .notification)
        pointer = NSPoint(x: controller.panel!.frame.midX, y: controller.panel!.frame.minY + 10)
        controller.autoCollapseTimer?.fire(); verify(controller.state == .notification)
        controller.launcherButton?.performClick(nil); verify(controller.state == .expanded && controller.autoCollapseTimer == nil)
        controller.launcherButton?.performClick(nil); verify(!controller.expanded)
        // Dismissal doesn't instantly reopen under a stationary pointer.
        pointer = NSPoint(x: compactFrame.midX, y: compactFrame.midY)
        controller.handlePointer(at: pointer); verify(controller.hoverTimer == nil)
        pointer = NSPoint(x: compactFrame.minX - 100, y: compactFrame.minY - 100)
        controller.handlePointer(at: pointer)
        pointer = NSPoint(x: compactFrame.midX, y: compactFrame.midY)
        controller.handlePointer(at: pointer); verify(controller.hoverTimer != nil)
        controller.hoverTimer?.fire(); verify(controller.state == .expanded && controller.hoverOpened)
        pointer = NSPoint(x: compactFrame.minX - 400, y: compactFrame.minY - 400)
        controller.handlePointer(at: pointer)
        controller.hoverExitTimer?.fire(); verify(!controller.expanded)
        // A cutout click routed outside our NSPanel still opens the full notch.
        pointer = NSPoint(x: compactFrame.midX, y: compactFrame.midY)
        let click = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
                                      windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        controller.handleOutsideEvent(click, local: false); verify(controller.state == .expanded)
        pointer = NSPoint(x: compactFrame.minX - 400, y: compactFrame.minY - 400)
        controller.handleOutsideEvent(click, local: false); verify(!controller.expanded)
        // Details must include the announced source even beyond the eight-row summary.
        let extra: [String: Any] = ["projectId": "p", "objectId": "extra", "toVersion": 2, "fileName": "Plan.pdf", "removed": true]
        controller.receive(NotchActivity(["changes": activity(5).changes, "linkedChanges": [extra]]))
        controller.content.mouseDown(with: click)
        verify(controller.activity.changes[controller.selectedChange]["objectId"] as? String == "extra")
        controller.activity = activity(5); controller.selectedChange = 0
        controller.render()
        verify(controller.content.frame.height == 208)
        verify(controller.panel!.frame.maxY == display.frame.maxY && display.frame.contains(controller.panel!.frame))
        verify(controller.contentClip.frame.minY == display.safeAreaInsets.top && !controller.content.isHidden)
        verify(controller.launcherButton!.frame.width == controller.panel!.frame.width)
        capture("expanded")
        var toggles = 0; var destination = ""
        controller.onToggleSuggestions = { toggles += 1 }
        controller.onOpenWorkspace = { destination = $0 }
        controller.baseURL = URL(string: "http://127.0.0.1:4319")
        controller.render()
        controller.content.subviews.compactMap { $0 as? NSButton }.first { $0.title == "Pause Suggestions" }?.performClick(nil)
        verify(toggles == 1)
        controller.baseURL = nil
        controller.collapse()
        controller.receive(NotchActivity(["linkedSourceObjectIds": ["browser-source"], "linkedChanges": [["projectId": "p", "objectId": "browser-source", "toVersion": 3]]]))
        verify(!controller.expanded) // New links baseline historical changes.
        controller.receive(NotchActivity(["linkedSourceObjectIds": ["browser-source", "fresh-source"], "linkedChanges": []]))
        controller.receive(NotchActivity(["linkedSourceObjectIds": ["browser-source", "fresh-source"], "linkedChanges": [["projectId": "p", "objectId": "fresh-source", "toVersion": 2]]]))
        verify(controller.state == .notification) // An existing link's first edit still announces.
        controller.activity = activity(5)
        controller.toggleExpanded()
        if keepOpen {
            regressionPanel = controller
            controller.timer?.invalidate(); controller.timer = nil
            return ["checks": checks, "supported": true, "windowNumber": controller.panel!.windowNumber]
        }
        controller.collapse()
        controller.reduceMotion = { false }
        controller.launcherButton?.performClick(nil)
        verify(controller.frameClock != nil && controller.expanded)
        RunLoop.current.run(until: Date().addingTimeInterval(0.06))
        verify(controller.presentedBody!.height > compactFrame.height && controller.presentedBody!.height < controller.presentationTarget.height)
        verify(controller.panel!.frame.contains(controller.presentedBody!) && controller.panel!.frame.contains(controller.presentationTarget))
        verify(controller.panel!.frame.maxY == display.frame.maxY)
        verify(abs(controller.panel!.frame.midX - compactFrame.midX) < 1)
        controller.collapse()
        controller.launcherButton?.performClick(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(1.2))
        verify(controller.expanded && controller.frameClock == nil && controller.panel!.frame == controller.presentationTarget.integral)
        verify(!controller.content.isHidden && controller.content.alphaValue == 1)
        controller.collapse()
        RunLoop.current.run(until: Date().addingTimeInterval(1.2))
        verify(controller.panel!.frame == compactFrame && controller.content.isHidden && controller.frameClock == nil)
        controller.launcherButton?.performClick(nil)
        controller.reduceMotion = { true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.04))
        verify(controller.frameClock == nil && controller.expanded && controller.panel!.frame == controller.presentationTarget.integral)
        controller.openWorkspace()
        verify(destination == "changes" && !controller.expanded)
        controller.reduceMotion = { false }
        controller.launcherButton?.performClick(nil)
        controller.stop()
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        verify(controller.panel?.isVisible == false && controller.localClick == nil && controller.globalClick == nil)
        verify(controller.timer == nil && controller.task == nil && controller.autoCollapseTimer == nil && controller.frameClock == nil)
        return ["checks": checks, "supported": true]
    }
    #endif
}
