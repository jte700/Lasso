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

// MARK: - Node discovery

/// GUI applications do not inherit a shell PATH, so the Node binary is resolved
/// explicitly: an env override, the path recorded at build time, the usual
/// install locations, any nvm install, and finally a login shell lookup.
func resolveNodePath() -> String? {
    let fileManager = FileManager.default
    var candidates: [String] = []

    if let override = ProcessInfo.processInfo.environment["LASSO_NODE"]
        ?? ProcessInfo.processInfo.environment["COLAB_NODE"] {
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
    private var healthCheck: URLSessionDataTask?
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
        stop()
        transition(.starting)

        guard let node = resolveNodePath() else {
            transition(.failed("Node.js 24+ was not found. Install Node, or set LASSO_NODE to its path."))
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
        environment["LASSO_DATA_DIR"] = dataDirectory
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
            DispatchQueue.main.async {
                guard let self, self.process === finished else { return }
                self.healthCheck?.cancel()
                self.healthCheck = nil
                self.process = nil
                self.transition(.failed("The Lasso server stopped. Use Restart Server to bring it back."))
            }
        }

        do {
            try child.run()
        } catch {
            transition(.failed("The server could not be launched: \(error.localizedDescription)"))
            return
        }
        process = child
        waitUntilHealthy(child, deadline: Date().addingTimeInterval(25))
    }

    /// Polls the local server before enabling directory controls.
    private func waitUntilHealthy(_ child: Process, deadline: Date) {
        guard process === child, child.isRunning, let url else { return }
        guard Date() < deadline else {
            transition(.failed("The server did not become ready. See the log for details."))
            return
        }
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
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    self?.waitUntilHealthy(child, deadline: deadline)
                }
            }
        }
        healthCheck?.resume()
    }

    func restart() {
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

    init?(_ object: [String: Any]) {
        guard let id = object["id"] as? String,
              let rootPath = object["rootPath"] as? String else { return nil }
        self.id = id
        self.rootPath = rootPath
        self.name = object["name"] as? String ?? (rootPath as NSString).lastPathComponent
        self.active = object["active"] as? Bool ?? false
        self.available = object["available"] as? Bool ?? true
        self.error = object["error"] as? String
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var server: ServerController!
    private let statusMenu = NSMenu()
    private let statusPopover = StatusPopoverController()
    private let inspector = SourceInspectorPanel()
    private var directories: [WorkDirectory] = []
    private var workspaceRevision = ""
    private var workspaceError: String?
    private var busyMessage: String?
    private var workspaceRequest: URLSessionDataTask?
    private var workspaceGeneration = 0
    private var workspaceTimer: Timer?
    private var assistPermissionTimer: Timer?
    private var assistActivation = AssistActivation(
        requested: UserDefaults.standard.bool(forKey: "AssistEnabled"))

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
        inspector.onUnlink = { reference in DependencyHighlighter.shared.unlink(id: reference.id) }
        inspector.onOpenSource = { [weak self] _ in
            self?.showError("The source file could not be opened at its recorded location.")
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
        workspaceTimer?.invalidate()
        assistPermissionTimer?.invalidate()
        workspaceRequest?.cancel()
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
        rebuildMenu()
    }

    @objc private func toggleStatusPopover(_ sender: NSStatusBarButton) {
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
        statusMenu.addItem(label(busyMessage ?? statusTitle(activeCount: activeCount)))
        statusMenu.addItem(.separator())
        statusMenu.addItem(command("Add Work Directories…", action: #selector(addDirectories),
                                   enabled: isServerReady && busyMessage == nil))
        if directories.isEmpty {
            statusMenu.addItem(label(isServerReady ? "Choose directories to get started" : "Waiting for the server…"))
        } else {
            statusMenu.addItem(.separator())
            let heading = command("Work Directories", action: #selector(toggleDirectoryList))
            heading.view = NativeMenuDisclosureRow(item: heading, expanded: !directoryListCollapsed,
                                                  count: directories.count)
            statusMenu.addItem(heading)
            if !directoryListCollapsed {
                for directory in directories {
                    let duplicateName = directories.filter { $0.name == directory.name }.count > 1
                    let title = duplicateName ? directory.rootPath : directory.name
                    let item = command(title + (directory.available ? "" : " (unavailable)"),
                                       action: #selector(toggleDirectory(_:)),
                                       enabled: isServerReady && busyMessage == nil)
                    item.state = directory.active ? .on : .off
                    item.representedObject = directory.id
                    item.toolTip = [directory.rootPath, directory.error].compactMap { $0 }.joined(separator: "\n")
                    item.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
                    item.view = NativeMenuToggleRow(item: item, color: toggleColor(for: directory.id)) { [weak self] color in
                        self?.setToggleColor(color, for: directory.id)
                    }
                    statusMenu.addItem(item)
                }
            }
        }
        if let workspaceError {
            let item = label(workspaceError)
            item.toolTip = workspaceError
            statusMenu.addItem(item)
        }
        statusMenu.addItem(.separator())
        let assist = command("Suggest While Typing", action: #selector(toggleGlobalAssist),
                             enabled: isServerReady)
        assist.state = assistActivation.requested ? .on : .off
        statusMenu.addItem(assist)
        if assistActivation.requested && !GlobalAssistant.shared.isEnabled && isServerReady {
            if !AssistPermission.hasAccessibility {
                statusMenu.addItem(command("Allow Accessibility…", action: #selector(openAssistSettings)))
            } else if !AssistPermission.hasInputMonitoring {
                statusMenu.addItem(command("Allow Input Monitoring…", action: #selector(openAssistSettings)))
            } else {
                statusMenu.addItem(command("Retry Suggestions", action: #selector(retryGlobalAssist)))
            }
        }

        let tools = NSMenuItem(title: "Tools", action: nil, keyEquivalent: "")
        let toolsMenu = NSMenu()
        toolsMenu.autoenablesItems = false
        toolsMenu.addItem(command("Open in Browser", action: #selector(openInBrowser), key: "b", enabled: isServerReady))
        toolsMenu.addItem(command("Refresh Directory Status", action: #selector(refreshDirectoryStatus), enabled: isServerReady))
        let insertion = NSMenuItem(title: "Dependency Insertion", action: nil, keyEquivalent: "")
        let insertionMenu = NSMenu()
        insertionMenu.autoenablesItems = false
        for mode in InsertionMode.allCases {
            let item = command(mode.title, action: #selector(chooseInsertionMode(_:)))
            item.representedObject = mode.rawValue
            item.state = InsertionMode.current == mode ? .on : .off
            insertionMenu.addItem(item)
        }
        insertion.submenu = insertionMenu
        toolsMenu.addItem(insertion)
        toolsMenu.addItem(.separator())
        toolsMenu.addItem(command("Restart Server", action: #selector(restartServer)))
        toolsMenu.addItem(command("Probe This App’s Text Support", action: #selector(runHostProbe)))
        let debug = command("Show Dependency Geometry", action: #selector(toggleDependencyDebug))
        debug.state = DependencyHighlighter.shared.isDebugging ? .on : .off
        toolsMenu.addItem(debug)
        toolsMenu.addItem(command("Reveal Server Log", action: #selector(revealLog)))
        toolsMenu.addItem(command("Reveal Typing Log", action: #selector(revealAssistLog)))
        tools.submenu = toolsMenu
        statusMenu.addItem(tools)
        statusMenu.addItem(command("Quit Lasso", action: #selector(quit), key: "q"))
        statusPopover.update(menu: statusMenu)
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
            refreshWorkspace()
            reconcileAssistant()
        case .starting:
            GlobalAssistant.shared.serverURL = nil
            GlobalAssistant.shared.suspendWorkspace()
            workspaceError = nil
        case .failed(let message):
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

    private func readWorkspace(data: Data?, response: URLResponse?) -> [String: Any]? {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let data, let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              state["directories"] is [[String: Any]] else { return nil }
        return state
    }

    private func applyWorkspace(_ state: [String: Any]) {
        directories = (state["directories"] as? [[String: Any]] ?? []).compactMap(WorkDirectory.init)
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
    }

    private func mutateWorkspace(path: String, body: [String: Any], message: String) {
        guard isServerReady, busyMessage == nil, let base = server.url else { return }
        workspaceGeneration += 1
        let token = workspaceGeneration
        workspaceRequest?.cancel()
        busyMessage = message
        workspaceError = nil
        // In-flight predictions cannot outlive a directory selection change.
        GlobalAssistant.shared.suspendWorkspace()
        rebuildMenu()
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 120
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
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
                    self.showError(message)
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
        panel.message = "Select one or more directories. Lasso uses every checked directory for suggestions."
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
        mutateWorkspace(path: "api/workspace/directories/" + id,
                        body: WorkspaceAPI.toggleDirectoryBody(active: !directory.active),
                        message: directory.active ? "Pausing directory…" : "Activating and indexing directory…")
    }

    @objc private func toggleDirectoryList() {
        directoryListCollapsed.toggle()
        rebuildMenu()
    }

    @objc private func refreshDirectoryStatus() { refreshWorkspace() }

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
        _ = assistant.enable(requestPermissions: userInitiated)
        rebuildMenu()
    }

    @objc private func retryGlobalAssist() {
        reconcileAssistant(userInitiated: true)
    }

    @objc private func openAssistSettings() {
        if !AssistPermission.hasAccessibility {
            AssistPermission.openSettings("Privacy_Accessibility")
        } else {
            AssistPermission.requestInputMonitoring()
            AssistPermission.openSettings("Privacy_ListenEvent")
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Lasso"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func runHostProbe() {
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
        rebuildMenu()
    }

    @objc private func chooseInsertionMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let mode = InsertionMode(rawValue: raw) else { return }
        InsertionMode.set(mode)
        rebuildMenu()
    }

    @objc private func openInBrowser() {
        guard let url = server.url else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func restartServer() { server.restart() }

    @objc private func revealLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Lasso/server.log")
        NSWorkspace.shared.activateFileViewerSelecting([log])
    }

    @objc private func revealAssistLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Lasso/assist.log")
        NSWorkspace.shared.activateFileViewerSelecting([log])
    }

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
