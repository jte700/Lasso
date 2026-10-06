//  Lasso — macOS menu bar application.
//
//  The app lives in the status bar. It supervises the local Lasso server as
//  a background child process and shows the workspace in a WKWebView window.
//  No application logic lives here: this is a native shell around the same
//  local-first server that `npm start` runs.

import Cocoa
import WebKit

// MARK: - Local port allocation

/// Binds a specific loopback port when it is free, so share links stay valid
/// across restarts. Returns nil when the port is already taken.
func claimPreferredPort(_ port: Int) -> Int? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(port).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
            Darwin.bind(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return bound == 0 ? port : nil
}

/// Asks the kernel for an unused loopback port so the desktop app never
/// collides with a development server on the default port.
func findFreePort() -> Int? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }

    var reuse: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")

    let bound = withUnsafePointer(to: &addr) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
            Darwin.bind(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0 else { return nil }

    var assigned = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &assigned) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
            getsockname(fd, socketAddress, &length)
        }
    }
    guard named == 0 else { return nil }
    return Int(UInt16(bigEndian: assigned.sin_port))
}

// MARK: - Node discovery

/// GUI applications do not inherit a shell PATH, so the Node binary is resolved
/// explicitly: an env override, the path recorded at build time, the usual
/// install locations, any nvm install, and finally a login shell lookup.
func resolveNodePath() -> String? {
    let fileManager = FileManager.default
    var candidates: [String] = []

    if let override = ProcessInfo.processInfo.environment["COLAB_NODE"] {
        candidates.append(override)
    }
    candidates.append(BuildConfig.nodePath)
    candidates.append(contentsOf: [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ])

    let nvmRoot = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent(".nvm/versions/node", isDirectory: true)
    if let versions = try? fileManager.contentsOfDirectory(atPath: nvmRoot.path) {
        for version in versions.sorted(by: >) {
            candidates.append(nvmRoot.appendingPathComponent("\(version)/bin/node").path)
        }
    }

    for candidate in candidates where fileManager.isExecutableFile(atPath: candidate) {
        return candidate
    }
    return nodePathFromLoginShell()
}

private func nodePathFromLoginShell() -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lc", "command -v node"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
    } catch {
        return nil
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let path, !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) else { return nil }
    return path
}

// MARK: - Server supervision

enum ServerState {
    case starting
    case ready
    case failed(String)
}

/// Owns the Node child process: start, health-poll, restart, and shutdown.
final class ServerController {
    private(set) var port: Int = 0
    private(set) var state: ServerState = .starting
    private var process: Process?
    private let appDirectory: String
    private let dataDirectory: String
    private let logURL: URL

    var onStateChange: ((ServerState) -> Void)?

    var url: URL? {
        guard port > 0 else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/")
    }

    init(appDirectory: String, dataDirectory: String, logURL: URL) {
        self.appDirectory = appDirectory
        self.dataDirectory = dataDirectory
        self.logURL = logURL
    }

    func start() {
        transition(.starting)

        guard let node = resolveNodePath() else {
            transition(.failed("Node.js 24+ was not found. Install Node, or set COLAB_NODE to its path."))
            return
        }
        // Share links embed the port, so a stable one is preferred: links sent
        // yesterday still resolve today. Falls back to any free port.
        guard let chosen = claimPreferredPort(4319) ?? findFreePort() else {
            transition(.failed("No free local port was available."))
            return
        }
        port = chosen

        try? FileManager.default.createDirectory(atPath: dataDirectory, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        let child = Process()
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = ["--disable-warning=ExperimentalWarning", "src/server.js"]
        // Config resolves `public/` and `migrations/` from the working directory.
        child.currentDirectoryURL = URL(fileURLWithPath: appDirectory)

        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["COLAB_DRY_DATA_DIR"] = dataDirectory
        // Isolated here so shares can later be served from a hosted origin.
        environment["SHARE_BASE_URL"] = ProcessInfo.processInfo.environment["SHARE_BASE_URL"]
            ?? "http://localhost:\(port)"
        child.environment = environment

        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            child.standardOutput = handle
            child.standardError = handle
        }

        child.terminationHandler = { [weak self] finished in
            guard let self else { return }
            DispatchQueue.main.async {
                if case .ready = self.state, finished.terminationReason != .uncaughtSignal || finished.terminationStatus != 0 {
                    self.transition(.failed("The Lasso server stopped. Use Restart Server to bring it back."))
                }
            }
        }

        do {
            try child.run()
        } catch {
            transition(.failed("The server could not be launched: \(error.localizedDescription)"))
            return
        }
        process = child
        waitUntilHealthy()
    }

    /// Polls the static root until the HTTP server answers, so the web view is
    /// only pointed at a port that is actually serving.
    private func waitUntilHealthy() {
        guard let url else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let deadline = Date().addingTimeInterval(25)
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 2
            let session = URLSession(configuration: configuration)

            while Date() < deadline {
                guard let self, self.process?.isRunning == true else { return }
                let semaphore = DispatchSemaphore(value: 0)
                var healthy = false
                let task = session.dataTask(with: url) { _, response, _ in
                    healthy = (response as? HTTPURLResponse)?.statusCode == 200
                    semaphore.signal()
                }
                task.resume()
                _ = semaphore.wait(timeout: .now() + 3)
                if healthy {
                    DispatchQueue.main.async { self.transition(.ready) }
                    return
                }
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async {
                self?.transition(.failed("The server did not become ready. See the log for details."))
            }
        }
    }

    func restart() {
        stop()
        start()
    }

    func stop() {
        guard let process, process.isRunning else { return }
        process.terminationHandler = nil
        process.terminate()
        // Give the server a moment to close SQLite cleanly before exiting.
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        self.process = nil
    }

    private func transition(_ next: ServerState) {
        state = next
        onStateChange?(next)
    }
}

// MARK: - Application

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var statusItem: NSStatusItem!
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusLabelItem: NSMenuItem!
    private var server: ServerController!
    private var hasLoaded = false
    private var hasPresented = false

    private let inspector = SourceInspectorPanel()
    private let background = NSColor(srgbRed: 0x14 / 255.0, green: 0x17 / 255.0, blue: 0x1a / 255.0, alpha: 1)
    private let titlebar = NSColor(srgbRed: 0x1d / 255.0, green: 0x21 / 255.0, blue: 0x26 / 255.0, alpha: 1)
    private var titleObservation: NSKeyValueObservation?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if ProcessInfo.processInfo.environment["LASSO_SHARE_FIXTURE"] == "1" {
            ShareComposerController.shared.showFixture()
            return
        }
        if ProcessInfo.processInfo.environment["LASSO_OVERLAY_FIXTURE"] == "1" {
            GlobalAssistant.shared.showDesignFixture()
            return
        }

        let resources = Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lasso", isDirectory: true)
        let legacySupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CoLab Dry", isDirectory: true)
        if !FileManager.default.fileExists(atPath: support.path),
           FileManager.default.fileExists(atPath: legacySupport.path) {
            try? FileManager.default.copyItem(at: legacySupport, to: support)
        }
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Lasso/server.log")

        buildStatusItem()
        buildWindow()
        GlobalAssistant.shared.onStateChange = { [weak self] in
            DispatchQueue.main.async { self?.publishAssistState() }
        }

        server = ServerController(
            appDirectory: resources.path,
            dataDirectory: support.appendingPathComponent("data", isDirectory: true).path,
            logURL: logs)
        server.onStateChange = { [weak self] state in self?.render(state) }
        server.start()
        startHighlighting()
    }

    /// Local dependency highlights: Lasso's own visual layer over other apps.
    private func startHighlighting() {
        let highlighter = DependencyHighlighter.shared
        highlighter.onInspect = { [weak self] reference, rect in
            guard let self, let url = self.server.url else { return }
            self.inspector.show(reference, near: rect, serverURL: url)
        }
        inspector.onUnlink = { reference in DependencyHighlighter.shared.unlink(id: reference.id) }
        inspector.onOpenSource = { [weak self] reference in
            guard let url = self?.server.url else { return }
            // The exact indexed source, never a similarly named file.
            var components = URLComponents(url: url.appendingPathComponent("inspect"),
                                           resolvingAgainstBaseURL: false)
            components?.queryItems = [
                URLQueryItem(name: "object", value: reference.objectId),
                URLQueryItem(name: "version", value: reference.versionId),
            ]
            if let target = components?.url { NSWorkspace.shared.open(target) }
        }
        inspector.onShare = { [weak self] reference in
            guard let self, let url = self.server.url,
                  let projectId = GlobalAssistant.shared.projectId else { return }
            let anchor = NSRect(origin: NSEvent.mouseLocation, size: .zero)
            self.inspector.hide()
            ShareComposerController.shared.show(
                objectId: reference.objectId, versionId: reference.versionId,
                label: reference.label, sourcePath: reference.sourcePath,
                near: anchor, serverURL: url
            ) { configuration in
                ShareClient.createShare(
                    serverURL: url, projectId: projectId, objectId: reference.objectId,
                    versionId: reference.versionId, configuration: configuration
                ) { result in
                    DispatchQueue.main.async {
                        if case .success(let share) = result {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(share.url.absoluteString, forType: .string)
                        }
                    }
                }
            }
        }
        highlighter.start()
    }

    /// Reports what the focused application can actually do, so the adapter
    /// strategy is validated rather than assumed.
    @objc private func runHostProbe() {
        // Probe the app the user was in, not this menu.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            let report = HostCapabilityProbe.run()
            AssistLog.enabled = true
            for line in report.split(separator: "\n") { AssistLog.write(String(line)) }
            let alert = NSAlert()
            alert.messageText = "Host text support"
            alert.informativeText = report + "\n\nAlso written to the typing log."
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    @objc private func toggleDependencyDebug() {
        DependencyHighlighter.shared.isDebugging.toggle()
    }

    func applicationWillTerminate(_ notification: Notification) {
        GlobalAssistant.shared.disable()
        server?.stop()
    }

    // MARK: Status bar

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else { return }
        if let symbol = NSImage(systemSymbolName: "lasso", accessibilityDescription: "Lasso")
            ?? NSImage(systemSymbolName: "link", accessibilityDescription: "Lasso") {
            symbol.isTemplate = true
            button.image = symbol
        } else {
            button.title = ">_"
        }
        button.toolTip = "Lasso"
        button.target = self
        button.action = #selector(statusItemClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    @objc private func statusItemClicked(_ sender: Any?) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
        } else {
            toggleWindow()
        }
    }

    private func showMenu() {
        let menu = NSMenu()
        statusLabelItem = NSMenuItem(title: statusTitle(), action: nil, keyEquivalent: "")
        statusLabelItem.isEnabled = false
        menu.addItem(statusLabelItem)
        menu.addItem(.separator())

        let open = NSMenuItem(title: "Open Lasso", action: #selector(openWindow), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        let browser = NSMenuItem(title: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "b")
        browser.target = self
        menu.addItem(browser)

        let reload = NSMenuItem(title: "Reload", action: #selector(reload), keyEquivalent: "r")
        reload.target = self
        menu.addItem(reload)

        menu.addItem(.separator())
        let assist = NSMenuItem(title: "Suggest While Typing Anywhere",
                                action: #selector(toggleGlobalAssist), keyEquivalent: "")
        assist.target = self
        assist.state = GlobalAssistant.shared.isEnabled ? .on : .off
        menu.addItem(assist)

        let insertion = NSMenuItem(title: "Dependency insertion", action: nil, keyEquivalent: "")
        let insertionMenu = NSMenu()
        for mode in InsertionMode.allCases {
            let item = NSMenuItem(title: mode.title, action: #selector(chooseInsertionMode(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = mode.rawValue
            item.state = (InsertionMode.current == mode) ? .on : .off
            insertionMenu.addItem(item)
        }
        insertion.submenu = insertionMenu
        menu.addItem(insertion)

        let restart = NSMenuItem(title: "Restart Server", action: #selector(restartServer), keyEquivalent: "")
        restart.target = self
        menu.addItem(restart)

        let probe = NSMenuItem(title: "Probe This App's Text Support",
                               action: #selector(runHostProbe), keyEquivalent: "")
        probe.target = self
        menu.addItem(probe)

        let debug = NSMenuItem(title: "Show Dependency Geometry",
                               action: #selector(toggleDependencyDebug), keyEquivalent: "")
        debug.target = self
        debug.state = DependencyHighlighter.shared.isDebugging ? .on : .off
        menu.addItem(debug)

        let log = NSMenuItem(title: "Reveal Server Log", action: #selector(revealLog), keyEquivalent: "")
        log.target = self
        menu.addItem(log)

        let assistLog = NSMenuItem(title: "Reveal Typing Log", action: #selector(revealAssistLog), keyEquivalent: "")
        assistLog.target = self
        menu.addItem(assistLog)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Lasso", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    private func statusTitle() -> String {
        switch server?.state {
        case .ready: return "Server: running on port \(server.port)"
        case .failed(let message): return "Server: \(message)"
        default: return "Server: starting…"
        }
    }

    // MARK: Window

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1040, height: 700)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        window.title = "Lasso"
        // Keep native window controls and behavior while the web view supplies
        // the compact utility toolbar and object-detail hierarchy.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = .clear
        window.isOpaque = false
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 820, height: 560)
        window.delegate = self
        window.setFrameAutosaveName("LassoUtilityWindow")
        window.center()

        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = "LassoDesktop"
        // The page reports the active project so system-wide suggestions know
        // which indexed sources to draw from.
        configuration.userContentController.add(self, name: "colab")
        webView = WKWebView(frame: frame, configuration: configuration)
        webView.navigationDelegate = self
        webView.underPageBackgroundColor = .clear
        webView.autoresizingMask = [.width, .height]
        window.contentView = NativeMaterial.materialContainer(
            content: webView, material: .underWindowBackground, blendingMode: .behindWindow)

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let title = view.title, !title.isEmpty else { return }
            self?.window.title = title
        }
    }

    private func render(_ state: ServerState) {
        switch state {
        case .ready:
            guard let url = server.url,
                  var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
            // `app=1` lets the web layer drop its simulated window chrome, and
            // `view=documents` opens straight into the editor.
            components.queryItems = [
                URLQueryItem(name: "app", value: "1"),
                URLQueryItem(name: "view", value: "documents"),
            ]
            GlobalAssistant.shared.serverURL = server.url
            DependencyHighlighter.shared.serverURL = server.url
            if let target = components.url {
                webView.load(URLRequest(url: target))
                // Show the workspace once on launch; afterwards the status item
                // toggles it and closing only hides it.
                if !hasLoaded && !hasPresented {
                    hasPresented = true
                    openWindow()
                }
                hasLoaded = true
            }
        case .failed(let message):
            let escaped = message.replacingOccurrences(of: "<", with: "&lt;")
            webView.loadHTMLString(errorPage(escaped), baseURL: nil)
        case .starting:
            if !hasLoaded { webView.loadHTMLString(errorPage("Starting the local Lasso server…"), baseURL: nil) }
        }
    }

    private func errorPage(_ message: String) -> String {
        """
        <html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
        background:#14171a;color:#8b96a1;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;">
        <div style="text-align:center;max-width:60ch;line-height:1.7;">
        <div style="color:#d4d7d9;">Lasso</div><div>\(message)</div></div></body></html>
        """
    }

    private func toggleWindow() {
        if window.isVisible && NSApp.isActive {
            window.orderOut(nil)
        } else {
            openWindow()
        }
    }

    @objc private func openWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func openInBrowser() {
        guard let url = server.url else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func reload() {
        if hasLoaded { webView.reload() } else { render(server.state) }
    }

    @objc private func restartServer() {
        hasLoaded = false
        server.restart()
    }

    @objc private func revealLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Lasso/server.log")
        NSWorkspace.shared.activateFileViewerSelecting([log])
    }

    @objc private func chooseInsertionMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let mode = InsertionMode(rawValue: raw) else { return }
        InsertionMode.set(mode)
    }

    @objc private func revealAssistLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Lasso/assist.log")
        NSWorkspace.shared.activateFileViewerSelecting([log])
    }

    @objc private func quit() {
        server?.stop()
        NSApp.terminate(nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "colab", message.frameInfo.isMainFrame,
              let origin = message.frameInfo.request.url,
              let local = server?.url, origin.host == local.host,
              origin.port == local.port, origin.scheme == local.scheme,
              let payload = message.body as? [String: Any] else { return }
        if let projectId = payload["activeProjectId"] as? String {
            GlobalAssistant.shared.projectId = projectId
        }
        if payload["action"] as? String == "toggleSuggestions" { toggleGlobalAssist() }
        if payload["action"] as? String == "suggestionState" { publishAssistState() }
    }

    private func publishAssistState() {
        let enabled = GlobalAssistant.shared.isEnabled ? "true" : "false"
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('lasso-assist-state', {detail: {enabled: \(enabled)}}))",
            completionHandler: nil)
    }

    @objc private func toggleGlobalAssist() {
        defer { publishAssistState() }
        let assistant = GlobalAssistant.shared
        if assistant.isEnabled {
            assistant.disable()
            return
        }
        assistant.serverURL = server.url
        if assistant.projectId == nil { adoptFirstProject() }
        if let message = assistant.enable() {
            let alert = NSAlert()
            alert.messageText = "Suggestions everywhere"
            alert.informativeText = message
            alert.addButton(withTitle: "Open Settings")
            alert.addButton(withTitle: "Later")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn {
                AssistPermission.openSettings(
                    GlobalAssistant.shared.lastProblem?.settingsAnchor ?? "Privacy_Accessibility")
            }
        }
    }

    /// Falls back to the first indexed project when the window has not reported
    /// one yet, so suggestions work straight from the menu bar.
    private func adoptFirstProject() {
        guard let url = server.url?.appendingPathComponent("api/projects") else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let projects = root["projects"] as? [[String: Any]],
                  let first = projects.first?["id"] as? String else { return }
            DispatchQueue.main.async {
                if GlobalAssistant.shared.projectId == nil { GlobalAssistant.shared.projectId = first }
            }
        }.resume()
    }

    /// Closing the window keeps the server running in the background, which is
    /// the point of a status bar app.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        return false
    }
}

@main
struct LassoApp {
    static func main() {
        let application = NSApplication.shared
        // Held for the lifetime of run(), which only returns on quit.
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
