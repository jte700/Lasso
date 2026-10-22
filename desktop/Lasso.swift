//  Lasso macOS menu bar application.
//
//  A native menu selects the directories used by the local Lasso server.
//  Source suggestions, inspectors, and sharing stay available across apps.

import Cocoa

// MARK: - Local port allocation

/// Binds a specific loopback port when it is free, so share links stay valid
/// across restarts. Returns nil when the port is already taken.
func claimPreferredPort(_ port: Int) -> Int? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    // Match Node's listener so recently closed connections do not make a free
    // preferred port look occupied during a restart.
    var reuse: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
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

/// Let the kernel choose an unused loopback port when the preferred one is busy.
func findFreePort() -> Int? { claimPreferredPort(0) }

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
    private var healthCheck: URLSessionDataTask?
    /// Recent unexpected exits. A crash restarts the server on its own, but a
    /// server that keeps failing stops retrying and asks the user to look.
    private var unexpectedExits: [Date] = []
    private static let restartWindow: TimeInterval = 120
    private static let maximumAutomaticRestarts = 3
    private static let maximumLogBytes: UInt64 = 5_000_000
    /// Polls that go unanswered for this long slow down, because the server
    /// is busy reading large folders rather than failing.
    private static let patientPollingAfter: TimeInterval = 25
    /// A server that is running but has not answered at all for this long is
    /// stuck rather than busy, so the menu offers to restart it.
    private static let unresponsiveAfter: TimeInterval = 5 * 60
    private var launchAttempt = 0
    private let appDirectory: String
    private let dataDirectory: String
    private let logURL: URL
    let driveToken = UUID().uuidString + UUID().uuidString
    /// The Node.js the server was last started with, shown in About Lasso.
    private(set) var runtime: NodeRuntime?

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
        stop()
        runtime = nil
        transition(.starting)
        launchAttempt += 1
        let attempt = launchAttempt
        // Finding Node can run a login shell. Keep that off the main thread so
        // the menu stays responsive while Lasso starts.
        DispatchQueue.global(qos: .userInitiated).async {
            let resolution = resolveNodeRuntime(
                bundledNode: Bundle.main.url(forAuxiliaryExecutable: "node")?.path,
                recordedNode: BuildConfig.nodePath)
            DispatchQueue.main.async { [weak self] in
                guard let self, attempt == self.launchAttempt, self.process == nil else { return }
                switch resolution {
                case .found(let runtime):
                    self.runtime = runtime
                    self.launch(runtime)
                case .tooOld(let path, let version):
                    self.transition(.failed("Lasso's own Node.js could not start, and the Node.js \(version) at \(path) "
                        + "is older than \(minimumNodeMajorVersion). Reinstall Lasso, then choose Restart Server."))
                case .missing:
                    self.transition(.failed("Lasso's own Node.js could not start, and no Node.js \(minimumNodeMajorVersion) "
                        + "or newer was found. Reinstall Lasso, then choose Restart Server."))
                }
            }
        }
    }

    /// Keeps the server log from growing without bound across launches.
    private func rotateLogIfNeeded() {
        let size = (try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? NSNumber)?.uint64Value ?? 0
        guard size > Self.maximumLogBytes else { return }
        let previous = logURL.appendingPathExtension("1")
        try? FileManager.default.removeItem(at: previous)
        try? FileManager.default.moveItem(at: logURL, to: previous)
    }

    private func launch(_ runtime: NodeRuntime) {
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
        rotateLogIfNeeded()

        let child = Process()
        child.executableURL = URL(fileURLWithPath: runtime.path)
        child.arguments = ["--disable-warning=ExperimentalWarning", "src/server.js"]
        // Config resolves `public/` and `migrations/` from the working directory.
        child.currentDirectoryURL = URL(fileURLWithPath: appDirectory)

        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["LASSO_DATA_DIR"] = dataDirectory
        environment["LASSO_DRIVE_TOKEN"] = driveToken
        // The server stops itself if this app crashes or is force-quit, so an
        // orphan cannot keep the preferred port and database from the next launch.
        environment["LASSO_PARENT_PID"] = String(getpid())
        // Isolated here so shares can later be served from a hosted origin.
        environment["SHARE_BASE_URL"] = ProcessInfo.processInfo.environment["SHARE_BASE_URL"]
            ?? "http://localhost:\(port)"
        child.environment = environment

        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            // Naming the runtime shows in the log when an installed Node stood
            // in for the bundled one.
            let started = ISO8601DateFormatter().string(from: Date())
            try? handle.write(contentsOf: Data("[\(started)] Starting the server with \(runtime.summary)\n".utf8))
            child.standardOutput = handle
            child.standardError = handle
        }

        child.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, self.process === finished else { return }
                self.healthCheck?.cancel()
                self.healthCheck = nil
                self.process = nil
                self.recoverFromUnexpectedExit()
            }
        }

        do {
            try child.run()
        } catch {
            transition(.failed("The server could not be launched: \(error.localizedDescription)"))
            return
        }
        process = child
        waitUntilHealthy(child, startedAt: Date())
    }

    /// Polls the local server before enabling directory controls. A server
    /// reading large folders at startup can take a while to answer; that is
    /// not a failure. Only the process exiting is, and that restarts it.
    private func waitUntilHealthy(_ child: Process, startedAt: Date) {
        guard process === child, child.isRunning,
              let url = url?.appendingPathComponent("api/health") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalCacheData
        healthCheck = URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self, self.process === child, child.isRunning else { return }
                self.healthCheck = nil
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.transition(.ready)
                    return
                }
                let waited = Date().timeIntervalSince(startedAt)
                if waited > Self.unresponsiveAfter {
                    self.transition(.failed("The Lasso server has not answered for 5 minutes. Check the server log, then choose Restart Server."))
                    return
                }
                let patient = waited > Self.patientPollingAfter
                DispatchQueue.main.asyncAfter(deadline: .now() + (patient ? 1 : 0.25)) { [weak self] in
                    self?.waitUntilHealthy(child, startedAt: startedAt)
                }
            }
        }
        healthCheck?.resume()
    }

    /// Suggestions depend on the server, so a crash should not leave them off
    /// until someone notices. Retries back off and give up after repeated exits.
    private func recoverFromUnexpectedExit() {
        let now = Date()
        unexpectedExits = unexpectedExits.filter { now.timeIntervalSince($0) < Self.restartWindow } + [now]
        guard unexpectedExits.count <= Self.maximumAutomaticRestarts else {
            transition(.failed("The Lasso server stopped repeatedly. Check the server log, then use Restart Server."))
            return
        }
        transition(.starting)
        let delay = pow(2, Double(unexpectedExits.count - 1))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.process == nil, case .starting = self.state else { return }
            self.start()
        }
    }

    func restart() {
        unexpectedExits = []
        start()
    }

    func stop() {
        healthCheck?.cancel()
        healthCheck = nil
        let process = self.process
        self.process = nil
        port = 0
        guard let process, process.isRunning else { return }
        process.terminationHandler = nil
        process.terminate()
        // Give the server a moment to close SQLite cleanly before exiting.
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }

    private func transition(_ next: ServerState) {
        state = next
        onStateChange?(next)
    }
}

// MARK: - Application

private struct WorkDirectory {
    let id: String
    let name: String
    let rootPath: String
    let active: Bool
    let available: Bool
    let error: String?
    let issue: DirectoryIssue?

    init?(_ object: [String: Any]) {
        guard let id = object["id"] as? String,
              let rootPath = object["rootPath"] as? String else { return nil }
        self.id = id
        self.rootPath = rootPath
        self.name = object["name"] as? String ?? (rootPath as NSString).lastPathComponent
        self.active = object["active"] as? Bool ?? false
        self.available = object["available"] as? Bool ?? true
        self.error = object["error"] as? String
        self.issue = DirectoryIssue(object["issue"])
    }

    /// Switched on and present, but not usable for suggestions.
    var needsAttention: Bool { active && available && !(error ?? "").isEmpty }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var server: ServerController!
    private let statusMenu = NSMenu()
    private let statusPopover = StatusPopoverController()
    private let notch = NotchPanelController()
    private let driveMonitor = ExternalDriveMonitor()
    private var hasUnreadDriveChange = false
    private var pendingDriveDialog = false
    private var driveNotice: ExternalDriveNoticePanel?
    private var driveNoticeDismissal: DispatchWorkItem?
    private var drivePulseTimer: Timer?

    private let inspector = SourceInspectorPanel()
    private var directories: [WorkDirectory] = []
    private var workspaceRevision = ""
    private var workspaceError: String?
    private var busyMessage: String?
    private var workspaceRequest: URLSessionDataTask?
    private var workspaceGeneration = 0
    private var workspaceTimer: Timer?
    private var assistPermissionTimer: Timer?
    /// Folders show selection circles until Cancel, Escape, a removal or the
    /// panel closes. Chosen folders are removed together in one step.
    private var isRemovingDirectories = false
    private var removalSelection = DirectorySelection()
    private var assistActivation = AssistActivation(
        requested: UserDefaults.standard.bool(forKey: "AssistEnabled"))
    private lazy var settings: SettingsWindowController = {
        let controller = SettingsWindowController(actions: SettingsActions(
            showInNotch: { UserDefaults.standard.bool(forKey: NotchPanelController.preferenceKey) },
            setShowInNotch: { [weak self] on in
                guard on != UserDefaults.standard.bool(forKey: NotchPanelController.preferenceKey) else { return }
                self?.toggleNotch()
            },
            notchAvailable: { NotchPanelController.isAvailable },
            version: { [weak self] in self?.versionLine ?? "" },
            didChange: { [weak self] in self?.rebuildMenu() }))
        // The menu bar and Dock icon show only while Settings is open, as a
        // regular app window. Closing it returns Lasso to the menu bar.
        controller.onClose = { NSApp.setActivationPolicy(.accessory) }
        return controller
    }()
    private var settingsLoaded = false

    /// Lasso's online guide, opened from Help > Lasso Help.
    private static let helpURL = URL(string: "https://github.com/jte700/Lasso#readme")!

    private var directoryListCollapsed: Bool {
        get { UserDefaults.standard.bool(forKey: "WorkDirectoriesCollapsed") }
        set { UserDefaults.standard.set(newValue, forKey: "WorkDirectoriesCollapsed") }
    }

    private func toggleColor(for directoryID: String) -> DirectoryToggleColor {
        DirectoryColorPreferences.color(for: directoryID) ?? .blue
    }

    private func setToggleColor(_ color: DirectoryToggleColor, for directoryID: String) {
        DirectoryColorPreferences.set(color, for: directoryID)
        rebuildMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        MainMenu.install(MainMenu.Commands(
            target: self, about: #selector(showAbout), settings: #selector(showSettings),
            addDirectories: #selector(addDirectories), openWorkspace: #selector(openInBrowser),
            help: #selector(openHelp)))
        LassoTransientUI.shared.register(self, priority: 5,
            isOpen: { NSApp.modalWindow != nil || NSApp.keyWindow?.attachedSheet != nil },
            dismiss: { [weak self] in
                self?.statusMenu.cancelTrackingWithoutAnimation()
                if let sheet = NSApp.keyWindow?.attachedSheet { NSApp.endSheet(sheet, returnCode: NSApplication.ModalResponse.cancel.rawValue) }
                if NSApp.modalWindow != nil { NSApp.abortModal() }
            })
        LassoTransientUI.shared.start()
        AppearancePreference.apply()
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
        let data = support.appendingPathComponent("data", isDirectory: true)
        let previousData = support.deletingLastPathComponent()
            .appendingPathComponent("CoLab Dry/data", isDirectory: true)
        if !FileManager.default.fileExists(atPath: data.path),
           FileManager.default.fileExists(atPath: previousData.path) {
            do {
                try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: previousData, to: data)
            } catch {
                NSLog("Lasso could not copy previous app history: %@", error.localizedDescription)
            }
        }
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Lasso/server.log")
        removeTypingLog(beside: logs)
        LaunchHelper.start()

        notch.linkedSourceObjectIDs = { DependencyHighlighter.shared.linkedSourceObjectIDs }
        notch.onToggleSuggestions = { [weak self] in self?.toggleGlobalAssist() }
        notch.onOpenWorkspace = { [weak self] view in
            guard let base = self?.server?.url, var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
            components.queryItems = [URLQueryItem(name: "view", value: view)]
            if let url = components.url { NSWorkspace.shared.open(url) }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        buildStatusItem()
        GlobalAssistant.shared.onStateChange = { [weak self] in
            DispatchQueue.main.async { self?.rebuildMenu() }
        }
        GlobalAssistant.shared.onWorkspaceChange = { [weak self] in
            self?.refreshWorkspace()
        }
        server = ServerController(
            appDirectory: resources.path,
            dataDirectory: data.path,
            logURL: logs)
        // The browser workspace polls drive inventory; native UI only announces changes.
        driveMonitor.onInventorySynced = { [weak self] change in
            if let notice = change.notice { self?.announceDriveChange(notice) }
        }
        server.onStateChange = { [weak self] state in self?.render(state) }
        server.start()
        assistPermissionTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.reconcileAssistant()
        }
        startHighlighting()
        workspaceTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.refreshWorkspace()
        }
    }

    /// Local dependency highlights remain available without a workspace window.
    private func startHighlighting() {
        let highlighter = DependencyHighlighter.shared
        highlighter.onInspect = { [weak self] reference, rect in
            guard let self, let url = self.server.url else { return }
            self.inspector.show(reference, near: rect, serverURL: url)
        }
        GlobalAssistant.shared.inspector = inspector
        inspector.onUnlink = { reference in DependencyHighlighter.shared.unlink(id: reference.id) }
        inspector.onOpenSource = { [weak self] _ in
            self?.showError("The source file could not be opened at its recorded location.",
                            title: "The Source Couldn\u{2019}t Be Opened")
        }
        inspector.onShare = { [weak self] reference in
            guard let self, let url = self.server.url else { return }
            self.inspector.composeShare(reference, serverURL: url) { configuration, finished in
                // Persisted highlights may belong to any registered directory.
                // Resolve the object's owner instead of borrowing a menu selection.
                RecommendationUsageClient.resolveProject(serverURL: url, objectId: reference.objectId) { projectId in
                    guard let projectId else {
                        finished(.failure(NSError(domain: "LassoSharing", code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "The source directory could not be resolved."])))
                        return
                    }
                    ShareClient.createShare(
                        serverURL: url, projectId: projectId, objectId: reference.objectId,
                        versionId: reference.versionId, configuration: configuration
                    ) { result in finished(result) }
                }
            }
        }
        highlighter.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        LassoTransientUI.shared.stop()
        notch.stop()
        workspaceTimer?.invalidate()
        assistPermissionTimer?.invalidate()
        workspaceRequest?.cancel()
        driveMonitor.stop()
        drivePulseTimer?.invalidate()
        dismissDriveNotice()
        GlobalAssistant.shared.disable()
        server?.stop()
    }

    // MARK: Native status menu

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            if let symbol = NSImage(systemSymbolName: "lasso", accessibilityDescription: "Lasso")
                ?? NSImage(systemSymbolName: "link", accessibilityDescription: "Lasso") {
                symbol.isTemplate = true
                button.image = symbol
            } else {
                button.title = ">_"
            }
            button.toolTip = "Lasso work directories"
            button.target = self
            button.action = #selector(toggleStatusPopover(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusMenu.autoenablesItems = false
        statusPopover.onEscape = { [weak self] in self?.endRemovingDirectories() ?? false }
        statusPopover.onClose = { [weak self] in _ = self?.endRemovingDirectories() }
        rebuildMenu()
    }

    @objc private func toggleStatusPopover(_ sender: NSStatusBarButton) {
        // An unread drive change goes to its decision first.
        if hasUnreadDriveChange { openDrives(); return }
        statusPopover.toggle(relativeTo: sender)
        refreshWorkspace()
    }

    private var isServerReady: Bool {
        if case .ready = server?.state { return true }
        return false
    }

    private func command(_ title: String, action: Selector, key: String = "", enabled: Bool = true) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = enabled
        return item
    }

    private func label(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func rebuildMenu() {
        statusMenu.removeAllItems()
        let activeCount = directories.filter { $0.active && $0.available && ($0.error ?? "").isEmpty }.count
        let status = label(busyMessage ?? statusTitle(activeCount: activeCount))
        if busyMessage != nil { status.view = NativeMenuProgressRow(item: status) }
        statusMenu.addItem(status)
        statusMenu.addItem(.separator())
        statusMenu.addItem(command("Add Work Directories…", action: #selector(addDirectories),
                                   enabled: isServerReady && busyMessage == nil))
        statusMenu.addItem(command("External Drives…", action: #selector(openDrives), enabled: isServerReady))
        if directories.isEmpty { isRemovingDirectories = false }
        if !directories.isEmpty && isRemovingDirectories {
            addRemovalCommands()
        } else if !directories.isEmpty {
            let remove = command("Remove Work Directories\u{2026}", action: #selector(toggleRemovingDirectories))
            remove.toolTip = "Choose one or more folders to remove from Lasso. The folders and their files are not changed."
            statusMenu.addItem(remove)
        }
        if directories.isEmpty {
            if isServerReady {
                statusMenu.addItem(label("Add a folder of your work files to get source suggestions."))
            } else if case .starting = server?.state {
                statusMenu.addItem(label("Waiting for the server…"))
            }
        } else {
            statusMenu.addItem(.separator())
            let heading = command("Work Directories", action: #selector(toggleDirectoryList))
            heading.view = NativeMenuDisclosureRow(item: heading, expanded: !directoryListCollapsed || isRemovingDirectories,
                                                  count: directories.count)
            statusMenu.addItem(heading)
            if !directoryListCollapsed || isRemovingDirectories {
                let titles = WorkspaceAPI.distinctNames(directories.map { (name: $0.name, path: $0.rootPath) })
                for (directory, title) in zip(directories, titles) {
                    let note = !directory.available ? " (unavailable)"
                        : directory.needsAttention ? " (needs attention)" : ""
                    let item = command(title + note, action: #selector(toggleDirectory(_:)),
                                       enabled: isServerReady && busyMessage == nil)
                    item.state = directory.active ? .on : .off
                    item.representedObject = directory.id
                    let usage = directory.needsAttention ? "Click to try this folder again."
                        : directory.active ? "On: suggestions include this folder." : "Off: this folder is paused."
                    item.toolTip = [directory.rootPath, directory.error, usage].compactMap { $0 }.joined(separator: "\n")
                    item.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
                    let id = directory.id
                    let row = NativeMenuToggleRow(item: item, color: toggleColor(for: directory.id),
                                                  selecting: isRemovingDirectories,
                                                  selected: removalSelection.ids.contains(id)) { [weak self] color in
                        self?.setToggleColor(color, for: directory.id)
                    }
                    row.issue = directory.issue
                    row.onFix = { [weak self] in self?.fixDirectory(id) }
                    row.onSelect = { [weak self] extend in self?.toggleRemovalSelection(id, extendingRange: extend) }
                    row.onReveal = { [weak self] in self?.revealDirectory(id) }
                    row.onRemove = { [weak self] in
                        let remove = NSMenuItem()
                        remove.representedObject = id
                        self?.removeDirectory(remove)
                    }
                    item.view = row
                    statusMenu.addItem(item)
                }
            }
        }
        if let workspaceError {
            let item = label(workspaceError)
            item.toolTip = workspaceError
            statusMenu.addItem(item)
        }
        // Recovery belongs next to the problem, not three levels down.
        if case .failed = server?.state {
            statusMenu.addItem(command("Restart Server", action: #selector(restartServer)))
        }
        statusMenu.addItem(.separator())
        let assist = command("Suggest While Typing", action: #selector(toggleGlobalAssist),
                             enabled: isServerReady)
        assist.state = assistActivation.requested ? .on : .off
        statusMenu.addItem(assist)
        if assistActivation.requested, isServerReady, activeCount == 0, !directories.isEmpty, busyMessage == nil {
            statusMenu.addItem(label("Switch on a work directory to get suggestions."))
        }
        if assistActivation.requested && GlobalAssistant.shared.isEnabled && isServerReady
            && GlobalAssistant.shared.isAwaitingInput && !AssistPermission.hasInputMonitoring {
            statusMenu.addItem(command("Allow Input Monitoring…", action: #selector(openAssistSettings)))
        } else if assistActivation.requested && !GlobalAssistant.shared.isEnabled && isServerReady {
            if !AssistPermission.hasAccessibility {
                statusMenu.addItem(command("Allow Accessibility…", action: #selector(openAssistSettings)))
            } else if !AssistPermission.hasInputMonitoring {
                statusMenu.addItem(command("Allow Input Monitoring…", action: #selector(openAssistSettings)))
            } else {
                statusMenu.addItem(command("Retry Suggestions", action: #selector(retryGlobalAssist)))
            }
        }

        statusMenu.addItem(command("Open in Browser", action: #selector(openInBrowser), key: "b", enabled: isServerReady))
        statusMenu.addItem(.separator())
        // Look, Tab, notch and startup options live in Settings, not here.
        statusMenu.addItem(command("Settings…", action: #selector(showSettings), key: ","))
        let quit = command("Quit Lasso", action: #selector(quit), key: "q")
        if LaunchHelper.state == .on {
            quit.toolTip = "Turns Lasso off. Press \(LaunchHelper.shortcut) to start it again."
        }
        statusMenu.addItem(quit)
        statusPopover.update(menu: statusMenu)
        if settingsLoaded { settings.refresh() }
        notch.configure(enabled: UserDefaults.standard.bool(forKey: NotchPanelController.preferenceKey),
                        serverURL: isServerReady ? server?.url : nil,
                        suggestions: GlobalAssistant.shared.isEnabled, requested: assistActivation.requested,
                        revision: directories.filter { $0.active && $0.available && ($0.error ?? "").isEmpty }.map(\.id).sorted().joined(separator: "|"))
    }

    private func statusTitle(activeCount: Int) -> String {
        switch server?.state {
        case .ready:
            return activeCount == 1 ? "Lasso · 1 active directory" : "Lasso · \(activeCount) active directories"
        case .failed: return "Lasso · server unavailable"
        default: return "Lasso · starting…"
        }
    }

    // MARK: Shared workspace state

    private func render(_ state: ServerState) {
        workspaceGeneration += 1
        workspaceRequest?.cancel()
        workspaceRequest = nil
        busyMessage = nil
        switch state {
        case .ready:
            GlobalAssistant.shared.serverURL = server.url
            DependencyHighlighter.shared.serverURL = server.url
            if let url = server.url { driveMonitor.start(serverURL: url, token: server.driveToken) }
            refreshWorkspace()
            reconcileAssistant()
        case .starting:
            driveMonitor.stop()
            GlobalAssistant.shared.serverURL = nil
            GlobalAssistant.shared.suspendWorkspace()
            workspaceError = nil
        case .failed(let message):
            driveMonitor.stop()
            GlobalAssistant.shared.serverURL = nil
            GlobalAssistant.shared.suspendWorkspace()
            workspaceError = message
        }
        rebuildMenu()
    }

    private func refreshWorkspace() {
        guard isServerReady, busyMessage == nil, workspaceRequest == nil,
              let url = server.url?.appendingPathComponent("api/workspace") else { return }
        workspaceGeneration += 1
        let token = workspaceGeneration
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 5
        workspaceRequest = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, token == self.workspaceGeneration else { return }
                self.workspaceRequest = nil
                if let state = self.readWorkspace(data: data, response: response) {
                    self.applyWorkspace(state)
                } else {
                    self.workspaceError = WorkspaceAPI.errorMessage(data: data, response: response, error: error)
                    self.rebuildMenu()
                }
            }
        }
        workspaceRequest?.resume()
    }

    // MARK: External drive attention

    /// The workspace opens in the browser, which shows the pending drive
    /// decision; the native badge and notice only point the way there.
    @objc private func openDrives() {
        hasUnreadDriveChange = false
        drivePulseTimer?.invalidate()
        drivePulseTimer = nil
        statusItem.button?.alphaValue = 1
        statusItem.button?.title = ""
        statusItem.button?.toolTip = "Lasso work directories"
        statusItem.button?.setAccessibilityLabel("Lasso")
        dismissDriveNotice()
        guard isServerReady, let base = server.url,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
        components.queryItems = [URLQueryItem(name: "drives", value: "open")]
        if let url = components.url { NSWorkspace.shared.open(url) }
    }

    private func announceDriveChange(_ message: String) {
        hasUnreadDriveChange = true
        guard let button = statusItem.button else { return }
        button.title = " •"
        button.imagePosition = .imageLeading
        button.toolTip = "Lasso — " + message
        button.setAccessibilityLabel("Lasso. " + message)
        drivePulseTimer?.invalidate()
        button.alphaValue = 1
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            var ticks = 0
            drivePulseTimer = Timer.scheduledTimer(withTimeInterval: 0.55, repeats: true) { [weak self] timer in
                ticks += 1
                self?.statusItem.button?.alphaValue = ticks.isMultiple(of: 2) ? 1 : 0.45
                if ticks >= 6 {
                    timer.invalidate()
                    self?.drivePulseTimer = nil
                    self?.statusItem.button?.alphaValue = 1
                }
            }
        }
        showDriveNotice(message)
    }

    private func showDriveNotice(_ message: String) {
        dismissDriveNotice()
        guard let button = statusItem.button, let host = button.window else { return }
        let anchor = host.convertToScreen(button.convert(button.bounds, to: nil))
        let panel = ExternalDriveNoticePanel(contentRect: NSRect(x: 0, y: 0, width: 336, height: 146),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        let content = NSVisualEffectView(frame: panel.contentView!.bounds)
        content.material = .popover
        content.blendingMode = .behindWindow
        content.state = .active
        content.wantsLayer = true
        content.layer?.cornerRadius = 12
        content.layer?.masksToBounds = true
        let title = NSTextField(labelWithString: "External drive update")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.frame = NSRect(x: 16, y: 111, width: 270, height: 20)
        content.addSubview(title)
        let detail = NSTextField(wrappingLabelWithString: message)
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.frame = NSRect(x: 16, y: 46, width: 304, height: 60)
        content.addSubview(detail)
        let open = NSButton(title: "Review", target: self, action: #selector(openDrives))
        open.bezelStyle = .rounded
        open.frame = NSRect(x: 214, y: 12, width: 106, height: 28)
        content.addSubview(open)
        let close = NSButton(image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "Dismiss")!,
            target: self, action: #selector(dismissDriveNotice))
        close.isBordered = false
        close.frame = NSRect(x: 300, y: 111, width: 20, height: 20)
        content.addSubview(close)
        panel.contentView = content
        let screen = host.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? anchor
        let x = max(screen.minX + 8, min(anchor.maxX - 336, screen.maxX - 344))
        panel.setFrameOrigin(NSPoint(x: x, y: anchor.minY - 152))
        driveNotice = panel
        panel.orderFrontRegardless()
        let dismissal = DispatchWorkItem { [weak self] in self?.dismissDriveNotice() }
        driveNoticeDismissal = dismissal
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: dismissal)
    }

    @objc private func dismissDriveNotice() {
        driveNoticeDismissal?.cancel()
        driveNoticeDismissal = nil
        driveNotice?.orderOut(nil)
        driveNotice = nil
    }

    private func readWorkspace(data: Data?, response: URLResponse?) -> [String: Any]? {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let data, let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              state["directories"] is [[String: Any]] else { return nil }
        return state
    }

    /// A menu bar app has no window, so a new user could miss it entirely.
    /// The first time Lasso runs with no folders, open the menu once.
    private static let welcomedKey = "WelcomedOnce"

    private func welcomeIfNeeded() {
        guard directories.isEmpty, !UserDefaults.standard.bool(forKey: Self.welcomedKey),
              let button = statusItem.button else { return }
        UserDefaults.standard.set(true, forKey: Self.welcomedKey)
        statusPopover.show(relativeTo: button)
    }

    /// Opening Lasso again while it runs shows its menu instead of nothing.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let button = statusItem.button { statusPopover.show(relativeTo: button) }
        return true
    }

    private func applyWorkspace(_ state: [String: Any]) {
        directories = WorkspaceAPI.switchedOnFirst(
            (state["directories"] as? [[String: Any]] ?? []).compactMap(WorkDirectory.init), isOn: \.active)
        removalSelection = removalSelection.pruned(to: directories.map(\.id))
        if let revision = state["revision"] as? String {
            workspaceRevision = revision
        } else if let revision = state["revision"] as? NSNumber {
            workspaceRevision = revision.stringValue
        }
        workspaceError = nil
        let activeIds = state["activeProjectIds"] as? [String]
            ?? directories.filter { $0.active && $0.available && ($0.error ?? "").isEmpty }.map(\.id)
        GlobalAssistant.shared.updateWorkspace(projectIds: activeIds, revision: workspaceRevision)
        rebuildMenu()
        welcomeIfNeeded()
    }

    /// Adding a large folder reads and indexes every file before answering.
    private static let indexingRequestTimeout: TimeInterval = 30 * 60

    private func mutateWorkspace(path: String, method: String = "POST", body: [String: Any]? = nil, message: String) {
        guard isServerReady, busyMessage == nil, let base = server.url else { return }
        workspaceGeneration += 1
        let token = workspaceGeneration
        workspaceRequest?.cancel()
        busyMessage = message
        workspaceError = nil
        // In-flight predictions cannot outlive a directory selection change.
        GlobalAssistant.shared.suspendWorkspace()
        rebuildMenu()
        // The issue card closes when its button is pressed. Bring the progress
        // header into view even when that folder was below the menu's fold.
        statusPopover.revealProgress()
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = method == "DELETE" ? 120 : Self.indexingRequestTimeout
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        workspaceRequest = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, token == self.workspaceGeneration else { return }
                self.workspaceRequest = nil
                self.busyMessage = nil
                if let state = self.readWorkspace(data: data, response: response) {
                    self.applyWorkspace(state)
                } else {
                    let message = WorkspaceAPI.errorMessage(data: data, response: response, error: error)
                    self.workspaceError = message
                    self.rebuildMenu()
                    self.showError(message, title: "Work Directories Couldn\u{2019}t Be Updated")
                    self.refreshWorkspace()
                }
            }
        }
        workspaceRequest?.resume()
    }

    @objc private func addDirectories() {
        guard isServerReady, busyMessage == nil else { return }
        let panel = NSOpenPanel()
        panel.title = "Add Work Directories"
        panel.message = "Choose the folders Lasso should use. Command-click to select several, or Shift-click to select a range."
        panel.prompt = "Add Directories"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { [weak self] response in
            guard response == .OK else { return }
            self?.mutateWorkspace(path: "api/workspace/directories",
                                  body: WorkspaceAPI.addDirectoriesBody(panel.urls.map(\.path)),
                                  message: "Adding and indexing directories…")
        }
    }

    @objc private func toggleDirectory(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let directory = directories.first(where: { $0.id == id }) else { return }
        // A folder that is on but failed to start is retried, not paused:
        // pausing it would take a second click to get it working.
        let activate = !directory.active || directory.needsAttention
        mutateWorkspace(path: "api/workspace/directories/" + id,
                        body: WorkspaceAPI.toggleDirectoryBody(active: activate),
                        message: activate ? "Activating and indexing directory…" : "Pausing directory…")
    }

    /// Applies the fix Lasso offers for a folder's issue, such as re-reading its files.
    private func fixDirectory(_ id: String) {
        guard let directory = directories.first(where: { $0.id == id }),
              let fix = directory.issue?.fixLabel else { return }
        let action = fix == "Re-read Files" ? "Re-reading" : "Retrying"
        mutateWorkspace(path: WorkspaceAPI.fixDirectoryPath(id), body: WorkspaceAPI.fixDirectoryBody(),
                        message: "\(action) \(directory.name)…")
    }

    /// Takes a folder out of Lasso. Nothing on disk changes, and its history
    /// is kept, so adding the same folder again restores it.
    @objc private func removeDirectory(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let index = directories.firstIndex(where: { $0.id == id }) else { return }
        let directory = directories[index]
        let name = WorkspaceAPI.distinctNames(directories.map { (name: $0.name, path: $0.rootPath) })[index]
        guard confirmRemoval(of: [name]) else { return }
        mutateWorkspace(path: "api/workspace/directories/" + id, method: "DELETE",
                        message: "Removing \(directory.name)…")
    }

    /// Selection mode puts its commands where "Remove Work Directories…" was,
    /// above the list, so they stay in view while the list scrolls.
    private func addRemovalCommands() {
        let order = directories.map(\.id)
        let count = removalSelection.ordered(order).count
        let ready = isServerReady && busyMessage == nil
        let remove = command(WorkspaceAPI.removalCommandTitle(count: count),
                             action: #selector(removeSelectedDirectories), enabled: ready && count > 0)
        remove.toolTip = count == 0 ? "Click folders below to select them. Shift-click selects a range."
            : "The folders and their files are not changed."
        statusMenu.addItem(remove)
        let everySelected = removalSelection.containsAll(order)
        statusMenu.addItem(command(everySelected ? "Deselect All" : "Select All",
                                   action: #selector(toggleSelectAllForRemoval)))
        statusMenu.addItem(command("Cancel", action: #selector(toggleRemovingDirectories)))
    }

    private func toggleRemovalSelection(_ id: String, extendingRange: Bool) {
        guard isRemovingDirectories else { return }
        removalSelection = removalSelection.toggling(id, in: directories.map(\.id), extendingRange: extendingRange)
        rebuildMenu()
    }

    @objc private func toggleSelectAllForRemoval() {
        let order = directories.map(\.id)
        removalSelection = removalSelection.containsAll(order) ? DirectorySelection() : removalSelection.selectingAll(order)
        rebuildMenu()
    }

    /// Removes every selected folder in one request, after one confirmation.
    @objc private func removeSelectedDirectories() {
        let ids = removalSelection.ordered(directories.map(\.id))
        let shown = Dictionary(uniqueKeysWithValues: zip(directories.map(\.id),
            WorkspaceAPI.distinctNames(directories.map { (name: $0.name, path: $0.rootPath) })))
        let names = ids.compactMap { shown[$0] }
        guard !ids.isEmpty, isServerReady, busyMessage == nil, confirmRemoval(of: names) else { return }
        isRemovingDirectories = false
        removalSelection = DirectorySelection()
        mutateWorkspace(path: "api/workspace/directories", method: "DELETE",
                        body: WorkspaceAPI.removeDirectoriesBody(ids),
                        message: ids.count == 1 ? "Removing \(names[0])…" : "Removing \(ids.count) directories…")
    }

    /// Asks before removing. The panel stays open behind the alert.
    private func confirmRemoval(of names: [String]) -> Bool {
        let text = WorkspaceAPI.removalConfirmation(names: names)
        let alert = NSAlert()
        alert.messageText = text.message
        alert.informativeText = text.details
        alert.alertStyle = .warning
        let remove = alert.addButton(withTitle: "Remove")
        remove.hasDestructiveAction = true
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        return statusPopover.holdingOpen { alert.runModal() } == .alertFirstButtonReturn
    }

    private func revealDirectory(_ id: String) {
        guard let directory = directories.first(where: { $0.id == id }), directory.available else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory.rootPath)])
    }

    @objc private func toggleRemovingDirectories() {
        isRemovingDirectories.toggle()
        removalSelection = DirectorySelection()
        rebuildMenu()
    }

    /// Leaves selection mode. Returns false when it was not on.
    private func endRemovingDirectories() -> Bool {
        guard isRemovingDirectories else { return false }
        isRemovingDirectories = false
        removalSelection = DirectorySelection()
        rebuildMenu()
        return true
    }

    @objc private func toggleDirectoryList() {
        directoryListCollapsed.toggle()
        rebuildMenu()
    }

    @objc private func screensChanged() { rebuildMenu() }

    @objc private func toggleNotch() {
        guard NotchPanelController.isAvailable else { return }
        let key = NotchPanelController.preferenceKey
        UserDefaults.standard.set(!UserDefaults.standard.bool(forKey: key), forKey: key)
        rebuildMenu()
    }

    @objc private func toggleGlobalAssist() {
        let assistant = GlobalAssistant.shared
        assistActivation.setRequested(!assistActivation.requested)
        UserDefaults.standard.set(assistActivation.requested, forKey: "AssistEnabled")
        if !assistActivation.requested {
            assistant.disable()
        } else {
            reconcileAssistant(userInitiated: true)
        }
        rebuildMenu()
    }

    private func reconcileAssistant(userInitiated: Bool = false) {
        guard assistActivation.requested else { return }
        let assistant = GlobalAssistant.shared
        let accessibility = AssistPermission.hasAccessibility
        if assistant.isEnabled && !accessibility {
            assistant.disable()
        }
        guard assistActivation.shouldAttempt(
            serverReady: isServerReady, accessibility: accessibility,
            inputMonitoring: AssistPermission.hasInputMonitoring,
            running: assistant.isEnabled, userInitiated: userInitiated) else { return }
        assistant.serverURL = server?.url
        let problem = assistant.enable(requestPermissions: userInitiated)
        // macOS shows its own prompt for a first request. A stale approval from
        // an earlier build, or a missing Input Monitoring grant, needs steps
        // that only this message explains.
        if userInitiated, let problem,
           assistant.lastProblem?.stale == true || assistant.lastProblem?.service == "Input Monitoring" {
            showError(problem, title: "Suggestions Need Permission")
        }
        rebuildMenu()
    }

    @objc private func retryGlobalAssist() {
        reconcileAssistant(userInitiated: true)
    }

    @objc private func openAssistSettings() {
        if !AssistPermission.hasAccessibility {
            AssistPermission.openSettings("Privacy_Accessibility")
        } else {
            // One path at a time: the system prompt while macOS can still show
            // it, otherwise Settings. Both at once ask for the same thing twice.
            AssistPermission.askForInputMonitoring()
        }
    }

    /// The title says what happened; macOS already shows Lasso's icon.
    private func showError(_ message: String, title: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func openInBrowser() {
        guard let url = server.url else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func restartServer() { server.restart() }

    @objc private func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        let credits = ["Source-backed suggestions from your own files. Everything stays on this Mac.",
                       server.runtime.map { "Server: \($0.summary)" }].compactMap { $0 }
        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: NSAttributedString(string: credits.joined(separator: "\n\n"),
                                         attributes: [.font: NSFont.systemFont(ofSize: 11),
                                                      .foregroundColor: NSColor.secondaryLabelColor]),
        ])
    }

    /// The bottom line of Settings, which takes the place of About in the panel.
    private var versionLine: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        return ["\(MainMenu.appName) \(version)", server?.runtime.map { "Server: \($0.summary)" }]
            .compactMap { $0 }.joined(separator: " \u{00B7} ")
    }

    /// Lasso no longer records a typing log; an old one is only taking space.
    private func removeTypingLog(beside serverLog: URL) {
        let folder = serverLog.deletingLastPathComponent()
        for name in ["assist.log", "assist.log.1"] {
            let file = folder.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: file.path) else { continue }
            do { try FileManager.default.removeItem(at: file) } catch {
                NSLog("Lasso could not remove its old typing log: %@", error.localizedDescription)
            }
        }
        UserDefaults.standard.removeObject(forKey: "AssistDebug")
    }

    @objc private func showSettings() {
        settingsLoaded = true
        NSApp.setActivationPolicy(.regular)
        // Activating in the same turn as the policy change can leave the menu
        // bar without the app in front, so show the window on the next turn.
        DispatchQueue.main.async { [weak self] in self?.settings.show() }
    }

    @objc private func openHelp() { NSWorkspace.shared.open(Self.helpURL) }

    @objc private func quit() { NSApp.terminate(nil) }
}

@main
struct LassoApp {
    static func main() {
        let application = NSApplication.shared
        #if BROWSER_GEOMETRY_TEST
        if BrowserGeometryRegression.run(arguments: CommandLine.arguments) { return }
        #endif
        // Held for the lifetime of run(), which only returns on quit.
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
