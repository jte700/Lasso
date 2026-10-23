import Cocoa
import EventKit
import UniformTypeIdentifiers
import WebKit

/// The Calendar app's events, read with EventKit for an "apple-calendar"
/// connection and handed to the server, which writes and indexes them like
/// any connected app's items. It reads again when Calendar's data changes.
final class AppleCalendarBridge {
    private let store = EKEventStore()
    private var observer: NSObjectProtocol?
    private var pending: DispatchWorkItem?
    private var timer: Timer?
    /// Switched-on Calendar connections and their settings, kept by the app.
    private var tracked: [(id: String, settings: [String: Any])] = []
    private var serverURL: URL?
    private var lastSync: [String: Date] = [:]
    /// Read again this often even when Calendar reports no change, so the
    /// window of days moves forward.
    private static let refreshInterval: TimeInterval = 30 * 60
    private static let changeDelay: TimeInterval = 5
    var onSynced: (() -> Void)?

    var hasAccess: Bool {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14.0, *) { return status == .fullAccess }
        return status == .authorized
    }

    func requestAccess(_ done: @escaping (Bool) -> Void) {
        let finish: (Bool, Error?) -> Void = { granted, _ in DispatchQueue.main.async { done(granted) } }
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents(completion: finish)
        } else {
            store.requestAccess(to: .event, completion: finish)
        }
    }

    /// Every event calendar, grouped by account, for the Connect window's checklist.
    func calendars() -> [[String: Any]] {
        store.reset()
        return store.calendars(for: .event)
            .sorted { ($0.source.title, $0.title) < ($1.source.title, $1.title) }
            .map { ["id": $0.calendarIdentifier, "title": $0.title, "source": $0.source.title,
                    "color": Self.hex($0.color)] }
    }

    private static func hex(_ color: NSColor?) -> String {
        guard let rgb = color?.usingColorSpace(.sRGB) else { return "#888888" }
        return String(format: "#%02x%02x%02x", Int(rgb.redComponent * 255), Int(rgb.greenComponent * 255),
                      Int(rgb.blueComponent * 255))
    }

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let weekdays = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    /// "Every 2 weeks on Mon, Wed", as the server writes a feed's repeating events.
    static func describe(_ rule: EKRecurrenceRule) -> String {
        let unit: String
        switch rule.frequency {
        case .daily: unit = "day"
        case .weekly: unit = "week"
        case .monthly: unit = "month"
        case .yearly: unit = "year"
        @unknown default: return "Repeats"
        }
        var text = rule.interval > 1 ? "Every \(rule.interval) \(unit)s" : "Every \(unit)"
        let days = (rule.daysOfTheWeek ?? []).map { weekdays[$0.dayOfTheWeek.rawValue] }
        if !days.isEmpty { text += " on " + days.joined(separator: ", ") }
        if let end = rule.recurrenceEnd?.endDate {
            text += " until " + DateFormatter.localizedString(from: end, dateStyle: .medium, timeStyle: .none)
        } else if let count = rule.recurrenceEnd?.occurrenceCount, count > 0 {
            text += ", \(count) times"
        }
        return text
    }

    private static func person(_ participant: EKParticipant?) -> [String: String]? {
        guard let participant else { return nil }
        let address = participant.url.absoluteString.replacingOccurrences(of: "mailto:", with: "", options: .caseInsensitive)
        return ["name": participant.name ?? "", "address": address.hasPrefix("/") ? "" : address]
    }

    /**
     The chosen calendars' events in the connection's window of days. A
     repeating event is listed once, at its next occurrence (or its latest
     one when none is ahead), with its pattern, as a feed's are.
     */
    func events(settings: [String: Any]) -> [[String: Any]] {
        let past = (settings["pastDays"] as? NSNumber)?.intValue ?? 30
        let future = (settings["futureDays"] as? NSNumber)?.intValue ?? 90
        let chosen = Set(settings["calendars"] as? [String] ?? [])
        store.reset()
        let calendars = store.calendars(for: .event).filter { chosen.isEmpty || chosen.contains($0.calendarIdentifier) }
        guard !calendars.isEmpty else { return [] }
        let now = Date()
        let start = now.addingTimeInterval(-Double(past) * 86_400)
        let end = now.addingTimeInterval(Double(future) * 86_400)
        let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: calendars))
        var series: [String: EKEvent] = [:]
        var single: [EKEvent] = []
        for event in events {
            guard event.hasRecurrenceRules else { single.append(event); continue }
            let id = event.calendarItemIdentifier
            if let kept = series[id] {
                // The next occurrence wins over past ones; among past ones, the latest.
                let keptAhead = kept.startDate >= now, ahead = event.startDate >= now
                if (ahead && (!keptAhead || event.startDate < kept.startDate)) || (!ahead && !keptAhead && event.startDate > kept.startDate) {
                    series[id] = event
                }
            } else {
                series[id] = event
            }
        }
        return (single + series.values).map { event in
            var item: [String: Any] = [
                "id": event.hasRecurrenceRules ? event.calendarItemIdentifier
                    : "\(event.calendarItemIdentifier)@\(Self.iso.string(from: event.startDate))",
                "title": event.title ?? "",
                "start": Self.iso.string(from: event.startDate),
                "end": Self.iso.string(from: event.endDate),
                "allDay": event.isAllDay,
                "location": event.location ?? "",
                "notes": event.notes ?? "",
                "calendar": event.calendar?.title ?? "",
                "attendees": (event.attendees ?? []).compactMap(Self.person),
            ]
            if let organizer = Self.person(event.organizer) { item["organizer"] = organizer }
            if let url = event.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") { item["url"] = url.absoluteString }
            if let rule = event.recurrenceRules?.first { item["recurrence"] = Self.describe(rule) }
            switch event.status {
            case .canceled: item["status"] = "Cancelled"
            case .tentative: item["status"] = "Tentative"
            default: break
            }
            return item
        }
    }

    /// Reads the calendars and sends their events for one connection.
    func sync(connectionId: String, settings: [String: Any], serverURL: URL,
              completion: @escaping (Result<Int, Error>) -> Void) {
        guard hasAccess else {
            completion(.failure(NSError(domain: "LassoCalendar", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "Lasso is not allowed to read your calendars. Allow it in System Settings › Privacy & Security › Calendars."])))
            return
        }
        DispatchQueue.global(qos: .utility).async { [self] in
            let events = self.events(settings: settings)
            var request = URLRequest(url: serverURL.appendingPathComponent("api/connections/\(connectionId)/items"))
            request.httpMethod = "POST"
            request.timeoutInterval = 10 * 60
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["events": events])
            URLSession.shared.dataTask(with: request) { data, response, error in
                DispatchQueue.main.async {
                    if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                        self.lastSync[connectionId] = Date()
                        completion(.success(events.count))
                        self.onSynced?()
                    } else {
                        completion(.failure(NSError(domain: "LassoCalendar", code: 2, userInfo: [NSLocalizedDescriptionKey:
                            WorkspaceAPI.errorMessage(data: data, response: response, error: error)])))
                    }
                }
            }.resume()
        }
    }

    /// Keeps switched-on Calendar connections current while Lasso runs.
    func track(_ connections: [(id: String, settings: [String: Any])], serverURL: URL?) {
        tracked = connections
        self.serverURL = serverURL
        guard !connections.isEmpty, serverURL != nil, hasAccess else { stopTracking(); return }
        if observer == nil {
            observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store,
                                                              queue: .main) { [weak self] _ in self?.scheduleSync() }
        }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.syncStale() }
        }
        syncStale()
    }

    private func stopTracking() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        timer?.invalidate()
        timer = nil
    }

    private func scheduleSync() {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.syncAll(force: true) }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.changeDelay, execute: work)
    }

    private func syncStale() { syncAll(force: false) }

    private func syncAll(force: Bool) {
        guard let serverURL else { return }
        for connection in tracked {
            if !force, let last = lastSync[connection.id], Date().timeIntervalSince(last) < Self.refreshInterval { continue }
            // Marked now, so a slow read is not started twice.
            lastSync[connection.id] = Date()
            sync(connectionId: connection.id, settings: connection.settings, serverURL: serverURL) { result in
                if case .failure(let error) = result { NSLog("Lasso could not bring Calendar up to date: %@", error.localizedDescription) }
            }
        }
    }

    /// Calendar connections the server already read recently need no read at launch.
    func noteSynced(_ id: String, at date: Date) {
        if (lastSync[id] ?? .distantPast) < date { lastSync[id] = date }
    }
}

/// The strip under the title bar of a window whose page runs to its top
/// edge: dragging it moves the window, and double-clicking it zooms or
/// minimizes the window as System Settings says.
private final class TitlebarDragView: NSView {
    override func mouseDown(with event: NSEvent) {
        guard event.clickCount == 2 else { window?.performDrag(with: event); return }
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window?.performMiniaturize(nil)
        case "None": break
        default: window?.performZoom(nil)
        }
    }
}

/// Relays page messages without the content controller retaining the window.
private final class ConnectMessageProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: ConnectAppsWindowController?
    init(_ target: ConnectAppsWindowController) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { replyHandler(nil, "The Connect window has closed."); return }
        target.handle(message, reply: replyHandler)
    }
}

/// The Connect 3rd Party Apps window: the server's Connect page, at a good
/// share of the screen, with a bridge for what only the Mac app can do.
final class ConnectAppsWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverURL: URL?
    let calendar = AppleCalendarBridge()
    /// A connection was added, switched, synced or removed: refresh the menu.
    var onChange: (() -> Void)?
    var onClose: (() -> Void)?

    var isVisible: Bool { window?.isVisible == true }

    /// The page's sand, so the title bar and the page read as one surface.
    private static let background = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x16 / 255, green: 0x16 / 255, blue: 0x15 / 255, alpha: 1)
            : NSColor(srgbRed: 0xf5 / 255, green: 0xf3 / 255, blue: 0xf1 / 255, alpha: 1)
    }

    func show(serverURL: URL) {
        if let window, self.serverURL == serverURL {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            webView?.evaluateJavaScript("window.lassoConnect?.refresh()")
            return
        }
        window?.close()
        self.serverURL = serverURL
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1480, max(960, visible.width * 0.78)).rounded(),
                          height: min(980, max(660, visible.height * 0.84)).rounded())
        // The page runs under the title bar, so the letter field fills the window.
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "Connect 3rd Party Apps"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = Self.background
        window.minSize = NSSize(width: 860, height: 600)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addScriptMessageHandler(ConnectMessageProxy(self), contentWorld: .page, name: "lasso")
        configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.underPageBackgroundColor = Self.background
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setAccessibilityLabel("Connect 3rd Party Apps")
        let content = NSView(frame: NSRect(origin: .zero, size: size))
        content.addSubview(web)
        let titlebar = max(28, window.frame.height - window.contentLayoutRect.height)
        let drag = TitlebarDragView(frame: NSRect(x: 0, y: size.height - titlebar, width: size.width, height: titlebar))
        drag.autoresizingMask = [.width, .minYMargin]
        content.addSubview(drag)
        window.contentView = content
        webView = web
        self.window = window
        web.load(URLRequest(url: serverURL.appendingPathComponent("connect.html")))
        window.center()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "lasso", contentWorld: .page)
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView = nil
        window = nil
        onChange?()
        onClose?()
    }

    // MARK: Navigation

    private func isOwnPage(_ url: URL?) -> Bool {
        guard let url, let serverURL, url.scheme == "http", url.port == serverURL.port else { return false }
        return ["127.0.0.1", "localhost"].contains(url.host ?? "")
    }

    /// Lasso's own pages stay in the window; sign-in and help pages open in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if isOwnPage(url) || url?.scheme == "about" { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if let url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let window else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = "Lasso"
        alert.informativeText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // MARK: Icons

    /// The apps' own icons where they are installed, so each looks as it does in
    /// the Dock; the page draws a plain symbol for the rest.
    private static func appIcons() -> [String: String] {
        var icons: [String: String] = [:]
        let bundles = ["apple-calendar": "com.apple.iCal", "outlook": "com.microsoft.Outlook", "notion": "notion.id"]
        for (provider, bundle) in bundles {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { continue }
            icons[provider] = pngDataURL(NSWorkspace.shared.icon(forFile: url.path))
        }
        if let calendarFile = UTType(filenameExtension: "ics") {
            icons["ics"] = pngDataURL(NSWorkspace.shared.icon(for: calendarFile))
        }
        return icons
    }

    private static func pngDataURL(_ image: NSImage, points: CGFloat = 64) -> String? {
        let pixels = Int(points * 2)
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                            bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        bitmap.size = NSSize(width: points, height: points)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(x: 0, y: 0, width: points, height: points))
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .png, properties: [:]).map { "data:image/png;base64," + $0.base64EncodedString() }
    }

    // MARK: Bridge

    fileprivate func handle(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        guard isOwnPage(message.frameInfo.request.url), let body = message.body as? [String: Any],
              let type = body["type"] as? String else { reply(nil, "Unknown request."); return }
        switch type {
        case "close":
            reply(true, nil)
            window?.performClose(nil)
        case "openURL":
            guard let text = body["url"] as? String, let url = URL(string: text),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { reply(nil, "Only web addresses can be opened."); return }
            NSWorkspace.shared.open(url)
            reply(true, nil)
        case "connected":
            onChange?()
            reply(true, nil)
        case "appIcons":
            reply(Self.appIcons(), nil)
        case "confirm":
            guard let window else { reply(false, nil); return }
            let alert = NSAlert()
            alert.messageText = body["title"] as? String ?? "Are you sure?"
            alert.informativeText = body["message"] as? String ?? ""
            alert.alertStyle = .warning
            let confirm = alert.addButton(withTitle: body["action"] as? String ?? "OK")
            confirm.hasDestructiveAction = body["destructive"] as? Bool ?? false
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: window) { response in reply(response == .alertFirstButtonReturn, nil) }
        case "calendar.requestAccess":
            calendar.requestAccess { [weak self] granted in
                reply(["granted": granted, "calendars": granted ? self?.calendar.calendars() ?? [] : []], nil)
            }
        case "calendar.openSettings":
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars") {
                NSWorkspace.shared.open(url)
            }
            reply(true, nil)
        case "calendar.sync":
            guard let id = body["connectionId"] as? String, let serverURL else { reply(nil, "Choose a connection."); return }
            calendar.sync(connectionId: id, settings: body["settings"] as? [String: Any] ?? [:], serverURL: serverURL) { [weak self] result in
                switch result {
                case .success(let count): reply(["count": count], nil)
                case .failure(let error): reply(nil, error.localizedDescription)
                }
                self?.onChange?()
            }
        default:
            reply(nil, "Unknown request.")
        }
    }
}
