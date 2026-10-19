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

/// The bundled server uses `node:sqlite`, which needs Node.js 24 or newer.
let minimumNodeMajorVersion = 24

enum NodeResolution {
    case found(String)
    case tooOld(path: String, version: String)
    case missing
}

/// GUI applications do not inherit a shell PATH, so the Node binary is resolved
/// explicitly: an env override, the path recorded at build time, the usual
/// install locations, any nvm install (newest first), and finally a login
/// shell lookup. Each candidate's version is checked, so an old Node is
/// reported as such instead of as a server that stopped.
func resolveNodePath() -> NodeResolution {
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
        // "v24.1.0" must sort above "v9.11.2", so compare numerically.
        for version in versions.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) {
            candidates.append(nvmRoot.appendingPathComponent("\(version)/bin/node").path)
        }
    }

    var tooOld: (path: String, version: String)?
    var checked = Set<String>()
    for candidate in candidates where checked.insert(candidate).inserted
        && fileManager.isExecutableFile(atPath: candidate) {
        guard let version = nodeVersion(at: candidate) else { continue }
        if nodeMajorVersion(version) >= minimumNodeMajorVersion { return .found(candidate) }
        if tooOld == nil { tooOld = (candidate, version) }
    }
    if let shellNode = nodePathFromLoginShell(), checked.insert(shellNode).inserted,
       let version = nodeVersion(at: shellNode) {
        if nodeMajorVersion(version) >= minimumNodeMajorVersion { return .found(shellNode) }
        if tooOld == nil { tooOld = (shellNode, version) }
    }
    if let tooOld { return .tooOld(path: tooOld.path, version: tooOld.version) }
    return .missing
}

func nodeMajorVersion(_ version: String) -> Int {
    let digits = version.trimmingCharacters(in: .whitespacesAndNewlines).drop(while: { $0 == "v" })
    return Int(digits.prefix(while: \.isNumber)) ?? 0
}

/// Output of a short command, or nil when it fails or takes too long.
private func commandOutput(_ executable: String, _ arguments: [String], timeout: TimeInterval) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
    } catch {
        return nil
    }
    // A slow or interactive shell profile must not stall startup.
    let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    deadline.cancel()
    guard process.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func nodeVersion(at path: String) -> String? {
    commandOutput(path, ["--version"], timeout: 5).flatMap { $0.isEmpty ? nil : $0 }
}

private func nodePathFromLoginShell() -> String? {
    // An interactive login shell also reads .zshrc, where nvm, fnm and asdf
    // usually set up PATH.
    guard let output = commandOutput("/bin/zsh", ["-ilc", "command -v node"], timeout: 5),
          let path = output.split(separator: "\n").last.map(String.init),
          FileManager.default.isExecutableFile(atPath: path) else { return nil }
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
        launchAttempt += 1
        let attempt = launchAttempt
        // Finding Node can run a login shell. Keep that off the main thread so
        // the menu stays responsive while Lasso starts.
        DispatchQueue.global(qos: .userInitiated).async {
            let resolution = resolveNodePath()
            DispatchQueue.main.async { [weak self] in
                guard let self, attempt == self.launchAttempt, self.process == nil else { return }
                switch resolution {
                case .found(let node):
                    self.launch(node: node)
                case .tooOld(let path, let version):
                    self.transition(.failed("Lasso needs Node.js \(minimumNodeMajorVersion) or newer, but found \(version) at \(path). "
                        + "Install a current Node.js, then choose Restart Server."))
                case .missing:
                    self.transition(.failed("Node.js \(minimumNodeMajorVersion) or newer was not found. "
                        + "Install it from nodejs.org or Homebrew, then choose Restart Server."))
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

    private func launch(node: String) {
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
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = ["--disable-warning=ExperimentalWarning", "src/server.js"]
        // Config resolves `public/` and `migrations/` from the working directory.
        child.currentDirectoryURL = URL(fileURLWithPath: appDirectory)

        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["LASSO_DATA_DIR"] = dataDirectory
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

    /// Switched on and present, but not usable for suggestions.
    var needsAttention: Bool { active && available && !(error ?? "").isEmpty }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var server: ServerController!
    private let statusMenu = NSMenu()
    private let statusPopover = StatusPopoverController()
    private let notch = NotchPanelController()
    private let inspector = SourceInspectorPanel()
    private var directories: [WorkDirectory] = []
    private var workspaceRevision = ""
    private var workspaceError: String?
    private var busyMessage: String?
    private var workspaceRequest: URLSessionDataTask?
    private var workspaceGeneration = 0
    private var workspaceTimer: Timer?
    private var assistPermissionTimer: Timer?
    /// Folders show red remove badges until Done, Escape or the panel closes.
    private var isRemovingDirectories = false
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
        LassoTransientUI.shared.register(self, priority: 5,
            isOpen: { NSApp.modalWindow != nil || NSApp.keyWindow?.attachedSheet != nil },
            dismiss: { [weak self] in
                self?.statusMenu.cancelTrackingWithoutAnimation()
                if let sheet = NSApp.keyWindow?.attachedSheet { NSApp.endSheet(sheet, returnCode: NSApplication.ModalResponse.cancel.rawValue) }
                if NSApp.modalWindow != nil { NSApp.abortModal() }
            })
        LassoTransientUI.shared.start()
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
        LassoTransientUI.shared.stop()
        notch.stop()
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
        statusPopover.onEscape = { [weak self] in self?.endRemovingDirectories() ?? false }
        statusPopover.onClose = { [weak self] in _ = self?.endRemovingDirectories() }
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
        if directories.isEmpty { isRemovingDirectories = false }
        if !directories.isEmpty {
            let remove = command(isRemovingDirectories ? "Done" : "Remove Work Directory",
                                 action: #selector(toggleRemovingDirectories))
            remove.toolTip = isRemovingDirectories ? nil
                : "Click a red badge to remove that folder from Lasso. The folder and its files are not changed."
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
                for directory in directories {
                    let duplicateName = directories.filter { $0.name == directory.name }.count > 1
                    let title = duplicateName ? directory.rootPath : directory.name
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
                    let row = NativeMenuToggleRow(item: item, color: toggleColor(for: directory.id),
                                                  removing: isRemovingDirectories) { [weak self] color in
                        self?.setToggleColor(color, for: directory.id)
                    }
                    let id = directory.id
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
        if NotchPanelController.isAvailable {
            let notchItem = command("Show Lasso in Notch", action: #selector(toggleNotch))
            notchItem.state = UserDefaults.standard.bool(forKey: NotchPanelController.preferenceKey) ? .on : .off
            statusMenu.addItem(notchItem)
        }
        let login = command("Open at Login", action: #selector(toggleLoginItem))
        login.state = LoginItem.isEnabled || LoginItem.needsApproval ? .on : .off
        login.toolTip = LoginItem.needsApproval
            ? "Waiting for approval in System Settings → General → Login Items."
            : "Start Lasso when you log in, so suggestions are ready without opening it."
        statusMenu.addItem(login)
        if LoginItem.needsApproval {
            statusMenu.addItem(command("Allow Open at Login…", action: #selector(openLoginItemSettings)))
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

        let tools = NSMenuItem(title: "Tools", action: nil, keyEquivalent: "")
        let toolsMenu = NSMenu()
        toolsMenu.autoenablesItems = false
        toolsMenu.addItem(command("Open in Browser", action: #selector(openInBrowser), key: "b", enabled: isServerReady))
        toolsMenu.addItem(command("Refresh Directory Status", action: #selector(refreshDirectoryStatus), enabled: isServerReady))
        let insertion = NSMenuItem(title: "Tab Inserts", action: nil, keyEquivalent: "")
        let insertionMenu = NSMenu()
        insertionMenu.autoenablesItems = false
        for mode in InsertionMode.allCases {
            let item = command(mode.title, action: #selector(chooseInsertionMode(_:)))
            item.representedObject = mode.rawValue
            item.state = InsertionMode.current == mode ? .on : .off
            item.toolTip = mode.explanation
            insertionMenu.addItem(item)
        }
        insertion.submenu = insertionMenu
        toolsMenu.addItem(insertion)
        toolsMenu.addItem(.separator())
        // Diagnostics stay together so everyday tools are not mixed with them.
        let troubleshooting = NSMenuItem(title: "Troubleshooting", action: nil, keyEquivalent: "")
        let troubleshootingMenu = NSMenu()
        troubleshootingMenu.autoenablesItems = false
        troubleshootingMenu.addItem(command("Restart Server", action: #selector(restartServer)))
        let probe = command("Check Text Support in Next App", action: #selector(runHostProbe))
        probe.toolTip = "Click, then switch to the app you type in. Lasso reports what it can read there."
        troubleshootingMenu.addItem(probe)
        let debug = command("Outline Highlight Positions", action: #selector(toggleDependencyDebug))
        debug.toolTip = "Draws the boxes Lasso uses to place source highlights."
        debug.state = DependencyHighlighter.shared.isDebugging ? .on : .off
        troubleshootingMenu.addItem(debug)
        let typingLog = command("Record Typing Log", action: #selector(toggleTypingLog))
        typingLog.state = AssistLog.enabled ? .on : .off
        typingLog.toolTip = "Records which apps Lasso could read and whether insertions landed. Never what you type."
        troubleshootingMenu.addItem(typingLog)
        troubleshootingMenu.addItem(command("Reveal Server Log", action: #selector(revealLog)))
        troubleshootingMenu.addItem(command("Reveal Typing Log", action: #selector(revealAssistLog)))
        troubleshooting.submenu = troubleshootingMenu
        toolsMenu.addItem(troubleshooting)
        tools.submenu = toolsMenu
        statusMenu.addItem(tools)
        statusMenu.addItem(command("About Lasso", action: #selector(showAbout)))
        statusMenu.addItem(command("Quit Lasso", action: #selector(quit), key: "q"))
        statusPopover.update(menu: statusMenu)
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
        // A folder that is on but failed to start is retried, not paused:
        // pausing it would take a second click to get it working.
        let activate = !directory.active || directory.needsAttention
        mutateWorkspace(path: "api/workspace/directories/" + id,
                        body: WorkspaceAPI.toggleDirectoryBody(active: activate),
                        message: activate ? "Activating and indexing directory…" : "Pausing directory…")
    }

    /// Takes a folder out of Lasso. Nothing on disk changes, and its history
    /// is kept, so adding the same folder again restores it.
    @objc private func removeDirectory(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let directory = directories.first(where: { $0.id == id }),
              confirmRemoval(of: directory) else { return }
        mutateWorkspace(path: "api/workspace/directories/" + id, method: "DELETE",
                        message: "Removing \(directory.name)…")
    }

    /// Asks before removing. The menu stays open behind the alert so
    /// several folders can be removed in one pass.
    private func confirmRemoval(of directory: WorkDirectory) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Remove \u{201C}\(directory.name)\u{201D} from Lasso?"
        alert.informativeText = "Lasso will stop indexing this directory and will no longer suggest its contents. "
            + "The folder and its files will remain on your Mac, and you can add it again at any time."
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
        rebuildMenu()
    }

    /// Leaves remove mode. Returns false when it was not on.
    private func endRemovingDirectories() -> Bool {
        guard isRemovingDirectories else { return false }
        isRemovingDirectories = false
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

    @objc private func refreshDirectoryStatus() { refreshWorkspace() }

    @objc private func toggleLoginItem() {
        let enable = !(LoginItem.isEnabled || LoginItem.needsApproval)
        do {
            try LoginItem.setEnabled(enable)
            if enable && LoginItem.needsApproval { LoginItem.openSettings() }
        } catch {
            showError(enable
                ? "Lasso could not be added to your login items: \(error.localizedDescription)"
                : "Lasso could not be removed from your login items: \(error.localizedDescription)")
        }
        rebuildMenu()
    }

    @objc private func openLoginItemSettings() { LoginItem.openSettings() }

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
            showError(problem)
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

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Lasso"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    /// Time to switch from the Lasso menu to the app being checked.
    private static let hostProbeDelay: TimeInterval = 3

    @objc private func runHostProbe() {
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.hostProbeDelay) {
            let report = HostCapabilityProbe.run()
            for line in report.split(separator: "\n") { AssistLog.write(String(line), force: true) }
            let alert = NSAlert()
            alert.messageText = "Host text support"
            alert.informativeText = report + "\n\nAlso written to the typing log."
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    @objc private func toggleTypingLog() {
        AssistLog.enabled.toggle()
        rebuildMenu()
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

    @objc private func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: NSAttributedString(string: "Source-backed suggestions from your own files. Everything stays on this Mac.",
                                         attributes: [.font: NSFont.systemFont(ofSize: 11),
                                                      .foregroundColor: NSColor.secondaryLabelColor]),
        ])
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
