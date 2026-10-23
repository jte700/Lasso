// External drive choices in the menu bar panel: index a connected drive or
// folders on it, or keep or remove what Lasso saved from a disconnected one.
import Cocoa

/// An external drive as the server lists it, with the decision Lasso is
/// waiting for, if any, and the workspaces indexed from it.
struct ExternalDrive: Equatable {
    enum Decision: String { case connected, disconnected }

    let id: String
    let name: String
    let rootPath: String
    let connected: Bool
    let decision: Decision?
    let workspaces: [String]

    init?(_ row: [String: Any]) {
        guard let id = row["id"] as? String, !id.isEmpty, let name = row["name"] as? String,
              let rootPath = row["rootPath"] as? String else { return nil }
        self.id = id
        self.name = name
        self.rootPath = rootPath
        connected = row["connected"] as? Bool ?? false
        decision = (row["pendingAction"] as? String).flatMap(Decision.init(rawValue:))
        workspaces = (row["projects"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
    }

    /// The `/api/drives` answer, or nil when it cannot be read.
    static func list(from data: Data?) -> [ExternalDrive]? {
        guard let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = body["drives"] as? [[String: Any]] else { return nil }
        return rows.compactMap(ExternalDrive.init)
    }

    /// Marked the way a work directory that needs attention is. `shown` is the
    /// name, or the drive's path where another drive has the same name.
    func title(shown: String) -> String {
        decision != nil ? shown + " (needs a decision)" : connected ? shown : shown + " (offline)"
    }

    var title: String { title(shown: name) }

    var summary: String {
        if !connected {
            return workspaces.count == 1 ? "Disconnected. Its saved index stays searchable."
                : "Disconnected. Its \(workspaces.count) saved indexes stay searchable."
        }
        return workspaces.isEmpty ? "Connected. Lasso reads only the files you choose."
            : "Connected. Indexed: " + workspaces.joined(separator: ", ")
    }

    /// Folders chosen in an open panel, relative to this drive ("." for the
    /// drive itself), or nil when any of them is outside it.
    func relativePaths(_ urls: [URL]) -> [String]? {
        let root = URL(fileURLWithPath: rootPath).standardizedFileURL.resolvingSymlinksInPath().path
        let relative = urls.map { url -> String? in
            let path = url.standardizedFileURL.resolvingSymlinksInPath().path
            if path == root { return "." }
            guard path.hasPrefix(root + "/") else { return nil }
            return String(path.dropFirst(root.count + 1))
        }
        return relative.contains(nil) ? nil : relative.compactMap { $0 }
    }

    /// The workspace in the browser can hold edits that wait for the drive to
    /// return; the alert says they go too, as the panel cannot see them.
    func removalConfirmation(shown: String? = nil) -> (message: String, details: String) {
        let saved = workspaces.count == 1 ? "its indexed workspace" : "its \(workspaces.count) indexed workspaces"
        return ("Remove saved data for \u{201C}\(shown ?? name)\u{201D}?",
                "Lasso will delete \(saved), cached file copies and version history from this Mac, "
                + "including any edits not yet saved to the drive. "
                + "This can\u{2019}t be undone. The files on the drive are not changed.")
    }
}

/// The panel's External Drives group. Requests go through `perform`, which
/// shows progress in the panel and reads the changed workspace afterwards.
final class ExternalDriveMenu: NSObject, NSOpenSavePanelDelegate {
    static let title = "External Drives"
    var drives: [ExternalDrive] = []
    /// Called when the list changes, so the panel can be rebuilt.
    var onChange: (() -> Void)?
    /// Sends a drive request: the server path, its body, and a progress message.
    var perform: ((String, [String: Any], String) -> Void)?
    /// Asks before something that cannot be undone.
    var confirm: ((NSAlert) -> Bool)?
    private var request: URLSessionDataTask?
    private var generation = 0
    /// Callers of a refresh that a newer one replaced; the newest answers them all.
    private var waiting: [() -> Void] = []
    /// The drive each open folder panel is choosing on. Panels are modeless,
    /// so two can be open for different drives.
    private var choosing: [ObjectIdentifier: ExternalDrive] = [:]

    /// Each drive's name, or its path where another drive has the same name.
    private func shownName(_ drive: ExternalDrive) -> String {
        let names = WorkspaceAPI.distinctNames(drives.map { (name: $0.name, path: $0.rootPath) })
        return drives.firstIndex(of: drive).map { names[$0] } ?? drive.name
    }

    /// Titles of the groups a review expands: the list, and the first drive
    /// waiting for a decision.
    var attentionPath: [String] {
        [Self.title] + (drives.first { $0.decision != nil }.map { [$0.title(shown: shownName($0))] } ?? [])
    }

    func refresh(base: URL?, then completion: (() -> Void)? = nil) {
        guard let url = base?.appendingPathComponent("api/drives") else { completion?(); return }
        if let completion { waiting.append(completion) }
        request?.cancel()
        generation += 1
        let current = generation
        var get = URLRequest(url: url)
        get.cachePolicy = .reloadIgnoringLocalCacheData
        get.timeoutInterval = 5
        request = URLSession.shared.dataTask(with: get) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self, current == self.generation else { return }
                self.request = nil
                // A failed read keeps the last list rather than showing no drives.
                if let list = ExternalDrive.list(from: data), list != self.drives {
                    self.drives = list
                    self.onChange?()
                }
                let callers = self.waiting
                self.waiting = []
                callers.forEach { $0() }
            }
        }
        request?.resume()
    }

    /// `ready` is the server; `idle` means no other request is running.
    func item(ready: Bool, idle: Bool) -> NSMenuItem {
        let group = NSMenuItem(title: Self.title, action: nil, keyEquivalent: "")
        group.isEnabled = ready
        group.toolTip = "Index a connected external drive, or keep or remove what Lasso saved from a disconnected one."
        let list = NSMenu()
        list.autoenablesItems = false
        if drives.isEmpty {
            list.addItem(note("Connect an external drive to choose which of its files Lasso indexes."))
        }
        for drive in drives {
            let row = NSMenuItem(title: drive.title(shown: shownName(drive)), action: nil, keyEquivalent: "")
            row.toolTip = drive.rootPath
            row.submenu = choices(for: drive, enabled: ready && idle)
            list.addItem(row)
        }
        group.submenu = list
        return group
    }

    private func choices(for drive: ExternalDrive, enabled: Bool) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(note(drive.summary))
        func add(_ title: String, _ action: Selector, _ tip: String) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            item.representedObject = drive.id
            item.isEnabled = enabled
            item.toolTip = tip
            menu.addItem(item)
        }
        if drive.connected {
            add("Index Entire Drive", #selector(indexWholeDrive(_:)),
                "Lasso reads every file on the drive and keeps searchable copies and version history on this Mac.")
            add("Choose Folders\u{2026}", #selector(chooseFolders(_:)),
                "Index only the folders you choose. Each one includes everything inside it.")
            if drive.decision == .connected {
                add("Not Now", #selector(skipDrive(_:)), "Leave this drive unindexed. You can index it from here later.")
            }
        } else {
            if drive.decision == .disconnected {
                add("Keep Saved Index", #selector(keepIndex(_:)),
                    "Keep searching this drive's saved copies while it is disconnected.")
            }
            add("Remove Saved Data\u{2026}", #selector(removeSavedData(_:)),
                "Delete what Lasso saved from this drive. The files on the drive are not changed.")
        }
        return menu
    }

    private func note(_ text: String) -> NSMenuItem {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func drive(for sender: NSMenuItem) -> ExternalDrive? {
        drives.first { $0.id == sender.representedObject as? String }
    }

    // MARK: Choices

    @objc private func indexWholeDrive(_ sender: NSMenuItem) {
        guard let drive = drive(for: sender), drive.connected else { return }
        index(drive, paths: ["."])
    }

    @objc private func chooseFolders(_ sender: NSMenuItem) {
        guard let drive = drive(for: sender), drive.connected else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose Folders on \(drive.name)"
        panel.message = "Choose the folders Lasso should index. Each one includes everything inside it."
        panel.prompt = "Index Folders"
        panel.directoryURL = URL(fileURLWithPath: drive.rootPath, isDirectory: true)
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        panel.delegate = self
        let key = ObjectIdentifier(panel)
        choosing[key] = drive
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { [weak self] response in
            self?.choosing[key] = nil
            guard response == .OK, !panel.urls.isEmpty else { return }
            guard let paths = drive.relativePaths(panel.urls) else {
                NSAlert(error: Self.outsideDrive(drive)).runModal()
                return
            }
            self?.index(drive, paths: paths)
        }
    }

    /// Keeps the open panel on its drive: a folder elsewhere is refused there.
    func panel(_ sender: Any, validate url: URL) throws {
        guard let panel = sender as? NSOpenPanel, let drive = choosing[ObjectIdentifier(panel)],
              drive.relativePaths([url]) == nil else { return }
        throw Self.outsideDrive(drive)
    }

    private static func outsideDrive(_ drive: ExternalDrive) -> NSError {
        NSError(domain: "Lasso.ExternalDrive", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Choose folders on \(drive.name).",
            NSLocalizedRecoverySuggestionErrorKey: "Lasso indexes this drive only from folders on it."])
    }

    @objc private func skipDrive(_ sender: NSMenuItem) {
        guard let drive = drive(for: sender) else { return }
        decide(drive, "dismiss", message: "Leaving \(drive.name) unindexed\u{2026}")
    }

    @objc private func keepIndex(_ sender: NSMenuItem) {
        guard let drive = drive(for: sender) else { return }
        decide(drive, "keep", message: "Keeping \(drive.name)\u{2019}s saved index\u{2026}")
    }

    @objc private func removeSavedData(_ sender: NSMenuItem) {
        guard let drive = drive(for: sender), !drive.connected else { return }
        let text = drive.removalConfirmation(shown: shownName(drive))
        let alert = NSAlert()
        alert.messageText = text.message
        alert.informativeText = text.details
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Remove Saved Data").hasDestructiveAction = true
        alert.addButton(withTitle: "Cancel")
        guard confirm?(alert) == true else { return }
        decide(drive, "remove", message: "Removing \(drive.name)\u{2019}s saved data\u{2026}")
    }

    private func index(_ drive: ExternalDrive, paths: [String]) {
        let message = paths == ["."] ? "Indexing \(drive.name)\u{2026}"
            : paths.count == 1 ? "Indexing \((paths[0] as NSString).lastPathComponent)\u{2026}"
            : "Indexing \(paths.count) folders on \(drive.name)\u{2026}"
        perform?(WorkspaceAPI.drivePath(drive.id, "index"), WorkspaceAPI.driveIndexBody(paths), message)
    }

    private func decide(_ drive: ExternalDrive, _ action: String, message: String) {
        perform?(WorkspaceAPI.drivePath(drive.id, "decision"), ["action": action], message)
    }
}
