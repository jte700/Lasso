// The `lasso` terminal command. Lasso.app carries one (Contents/Resources/bin/lasso,
// run with the app's own Node.js) and links it into a folder Terminal already
// searches: /usr/local/bin, which every Mac's /etc/paths lists, or Homebrew's
// /opt/homebrew/bin, whichever Lasso may write to without a password. That
// happens at each launch, so the copy of Lasso that ran last is the one the
// command runs. Where neither folder can be written, Settings installs it into
// /usr/local/bin with the person's password. A `lasso` that is not a Lasso
// app's (one `npm link` made from a checkout) is left alone, and so is the
// command once someone removes it in Settings.

import Foundation

enum TerminalCommand {
    static let name = "lasso"
    /// Folders on Terminal's PATH that people's own tools go in, the one every Mac searches first.
    static let folders = ["/usr/local/bin", "/opt/homebrew/bin"]
    /// The folder a password puts it in: every Mac's Terminal searches it.
    static let passwordFolder = "/usr/local/bin"
    private static let removedKey = "TerminalCommandRemoved"

    enum State: Equatable {
        /// The link at this path runs this copy of Lasso.
        case installed(String)
        /// A `lasso` that is not a Lasso app's is already at this path.
        case other(String)
        /// Not installed. Whether Lasso may put it there without a password.
        case absent(needsPassword: Bool)
    }

    /// The command inside this app, when the app carries one (a build older than it does not)
    /// and stays where it is: not one opened from its disk image, or moved aside by macOS
    /// because it was opened from Downloads, whose path is gone once it quits.
    static var launcher: String? {
        guard let resources = Bundle.main.resourceURL, isLasting(Bundle.main.bundleURL) else { return nil }
        let path = resources.appendingPathComponent("bin/\(name)").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    /// Whether an app at this place keeps its path: not on a read-only volume, nor translocated.
    static func isLasting(_ app: URL) -> Bool {
        if app.path.contains("/AppTranslocation/") { return false }
        return (try? app.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly) != true
    }

    /// Whether someone removed the command in Settings, so launches leave it out.
    static var removed: Bool {
        get { UserDefaults.standard.bool(forKey: removedKey) }
        set { UserDefaults.standard.set(newValue, forKey: removedKey) }
    }

    /// Whether a link leads to the command inside a Lasso app, this one or another copy.
    static func isLassoApp(_ destination: String) -> Bool {
        destination.hasSuffix(".app/Contents/Resources/bin/\(name)")
    }

    /// Where the command stands, without changing anything.
    static func state(launcher: String, folders: [String] = folders,
                      fileManager: FileManager = .default) -> State {
        for folder in folders {
            let link = (folder as NSString).appendingPathComponent(name)
            if let destination = linkDestination(link, fileManager: fileManager) {
                if destination == launcher { return .installed(link) }
                if isLassoApp(destination) { return .absent(needsPassword: !fileManager.isWritableFile(atPath: folder)) }
                return .other(link)
            }
            if exists(link, fileManager: fileManager) { return .other(link) }
        }
        return .absent(needsPassword: writableFolder(folders, fileManager: fileManager) == nil)
    }

    /// Links the command into the first folder that already has a Lasso app's
    /// link (another copy, or one since moved or deleted), or else into the
    /// first that Lasso may write to. Changes nothing when a `lasso` that is not
    /// a Lasso app's is there, or when no folder can be written without a password.
    @discardableResult
    static func place(launcher: String, folders: [String] = folders,
                      fileManager: FileManager = .default) -> State {
        for folder in folders {
            let link = (folder as NSString).appendingPathComponent(name)
            if let destination = linkDestination(link, fileManager: fileManager) {
                if destination == launcher { return .installed(link) }
                guard isLassoApp(destination) else { return .other(link) }
                guard fileManager.isWritableFile(atPath: folder),
                      (try? fileManager.removeItem(atPath: link)) != nil,
                      (try? fileManager.createSymbolicLink(atPath: link, withDestinationPath: launcher)) != nil
                else { return .absent(needsPassword: true) }
                return .installed(link)
            }
            if exists(link, fileManager: fileManager) { return .other(link) }
        }
        guard let folder = writableFolder(folders, fileManager: fileManager) else { return .absent(needsPassword: true) }
        let link = (folder as NSString).appendingPathComponent(name)
        do {
            try fileManager.createSymbolicLink(atPath: link, withDestinationPath: launcher)
            return .installed(link)
        } catch {
            return .absent(needsPassword: true)
        }
    }

    /// Takes away a link to a Lasso app's command; any other `lasso` is never touched.
    /// False when the folder needs a password to change.
    static func unlink(_ link: String, fileManager: FileManager = .default) -> Bool {
        guard let destination = linkDestination(link, fileManager: fileManager), isLassoApp(destination) else { return true }
        return (try? fileManager.removeItem(atPath: link)) != nil
    }

    // MARK: Launch and Settings

    /// At launch, off the main thread: puts the command in place unless someone removed it.
    static func placeAtLaunch() {
        guard !removed, let launcher else { return }
        DispatchQueue.global(qos: .utility).async {
            let state = place(launcher: launcher)
            if case .installed = state { return }
            NSLog("Lasso left the lasso terminal command out: %@", String(describing: state))
        }
    }

    /// Settings' Install: without a password where it can, else with the person's password.
    /// Returns where the command now stands.
    static func install() -> State? {
        guard let launcher else { return nil }
        removed = false
        let state = place(launcher: launcher)
        guard state == .absent(needsPassword: true) else { return state }
        let link = (passwordFolder as NSString).appendingPathComponent(name)
        runWithPassword("mkdir -p \(shellQuoted(passwordFolder)) && ln -sfn \(shellQuoted(launcher)) \(shellQuoted(link))")
        return self.state(launcher: launcher)
    }

    /// Settings' Remove: takes the link away and keeps launches from putting it back.
    static func remove() {
        removed = true
        guard let launcher, case .installed(let link) = state(launcher: launcher) else { return }
        if !unlink(link) { runWithPassword("rm -f \(shellQuoted(link))") }
    }

    /// The line under the command's row in Settings.
    static func note(for state: State) -> String {
        let what = "Type lasso in Terminal to ask where any file came from and who changed it."
        switch state {
        case .installed(let link):
            return "\(what) It is in \((link as NSString).deletingLastPathComponent)."
        case .absent(let needsPassword):
            return needsPassword ? "\(what) Installing it asks for your password, since only an administrator can add to \(passwordFolder)." : what
        case .other(let link):
            return "Terminal already has a lasso command, at \(link), so Lasso leaves it as it is."
        }
    }

    /// Runs a shell command as an administrator, asking for the person's password.
    private static func runWithPassword(_ command: String) {
        let quoted = "\"" + command.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
        var error: NSDictionary?
        NSAppleScript(source: "do shell script \(quoted) with administrator privileges")?.executeAndReturnError(&error)
        if let error { NSLog("Lasso could not change the lasso terminal command: %@", error) }
    }

    static func shellQuoted(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    // MARK: Files

    /// Where a symbolic link leads, made absolute; nil when the path is no link.
    private static func linkDestination(_ link: String, fileManager: FileManager) -> String? {
        guard let destination = try? fileManager.destinationOfSymbolicLink(atPath: link) else { return nil }
        if destination.hasPrefix("/") { return destination }
        let folder = (link as NSString).deletingLastPathComponent
        return ((folder as NSString).appendingPathComponent(destination) as NSString).standardizingPath
    }

    /// Whether anything is at a path, a link that leads nowhere included.
    private static func exists(_ path: String, fileManager: FileManager) -> Bool {
        (try? fileManager.attributesOfItem(atPath: path)) != nil
    }

    private static func writableFolder(_ folders: [String], fileManager: FileManager) -> String? {
        folders.first { folder in
            var isFolder: ObjCBool = false
            return fileManager.fileExists(atPath: folder, isDirectory: &isFolder) && isFolder.boolValue
                && fileManager.isWritableFile(atPath: folder)
        }
    }
}
