//  Opens a cited source in its default app at the cited place.
//
//  The plan comes from AssistOpenPlanner. This file carries it out: macOS opens
//  the file, then a script asks Excel, Numbers, Word or Acrobat to move, and
//  Preview, which has no scripting for pages, is driven through Accessibility.
//  A refused permission or a failed jump is logged and leaves the file open.

import Cocoa
import ApplicationServices
import UniformTypeIdentifiers

enum AssistSourceOpener {
    /// How much of a file is read to tell text from binary data.
    private static let textSniffLength = 4096

    /// Opens `fileURL` and starts the jump to `target`. False only when macOS
    /// could not open the file itself.
    static func open(_ fileURL: URL, at target: AssistOpenTarget?) -> Bool {
        let workspace = NSWorkspace.shared
        // A text source no app claims, such as LandXML or STEP on a Mac without
        // CAD software, opens in the Mac's text editor instead of failing.
        let textEditor = workspace.urlForApplication(toOpen: fileURL) == nil && isText(fileURL)
            ? workspace.urlForApplication(toOpen: .plainText) : nil
        let appURL = textEditor ?? workspace.urlForApplication(toOpen: fileURL)
        let appBundleID = appURL.flatMap { Bundle(url: $0)?.bundleIdentifier }
        let plan = AssistOpenPlanner.plan(fileURL: fileURL, target: target, appBundleID: appBundleID)
        return AssistSourceOpening.perform(plan, fileURL: fileURL, actions: AssistOpenActions(
            openFile: { url in
                guard let textEditor else { return workspace.open(url) }
                workspace.open([url], withApplicationAt: textEditor, configuration: NSWorkspace.OpenConfiguration())
                return true
            },
            openURL: { workspace.open($0) },
            runScript: { AssistOpenScriptRunner.run($0, arguments: $1) },
            goToPreviewPage: { PreviewPageNavigator.start(page: $0, documentURL: $1) }))
    }

    /// True when the start of the file holds no NUL bytes, as text never does.
    private static func isText(_ fileURL: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return false }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: textSniffLength), !head.isEmpty else { return false }
        return !head.contains(0)
    }
}

/// Runs a jump script in `osascript`, off the main thread. macOS attributes
/// its Apple Events to Lasso and asks once per app for permission.
enum AssistOpenScriptRunner {
    /// Covers a cold app launch, the script's own 30-second wait for the
    /// document, and time for the person to answer the permission prompt.
    private static let timeout: TimeInterval = 90

    /// How long a cold launch may take before the script is sent anyway.
    private static let launchWait: TimeInterval = 30
    /// Numbers stops exposing its documents for the whole session when a
    /// script reaches it while it is still launching, so a cold launch gets
    /// time to open the file before the first event.
    private static let settleAfterLaunch: TimeInterval = 2
    private static let launchPollInterval: TimeInterval = 0.1

    static func run(_ script: AssistOpenScript, arguments: [String]) {
        let isReady = {
            NSRunningApplication.runningApplications(withBundleIdentifier: script.appBundleID)
                .contains { $0.isFinishedLaunching }
        }
        guard !isReady() else { return start(script, arguments: arguments) }
        DispatchQueue.global(qos: .utility).async {
            let deadline = Date().addingTimeInterval(launchWait)
            while !isReady(), Date() < deadline { Thread.sleep(forTimeInterval: launchPollInterval) }
            Thread.sleep(forTimeInterval: settleAfterLaunch)
            start(script, arguments: arguments)
        }
    }

    private static func start(_ script: AssistOpenScript, arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        // "--" ends osascript's options, so every argument reaches the script
        // verbatim, even an empty one or one that begins with a dash.
        process.arguments = ["-e", script.source, "--"] + arguments
        let errors = Pipe()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errors
        process.terminationHandler = { finished in
            guard finished.terminationStatus != 0 else { return }
            let output = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            NSLog("Lasso opened the source, but it did not go to the cited place: %@",
                  script.failureSummary(errorOutput: output))
        }
        do {
            try process.run()
        } catch {
            NSLog("Lasso opened the source, but could not start the %@ jump: %@",
                  script.rawValue, error.localizedDescription)
            return
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
            if process.isRunning { process.terminate() }
        }
    }
}

/// Preview has no scripting for pages. Lasso already holds Accessibility
/// access, so it chooses Go to Page (Option-Command-G) for the window showing
/// the file and enters the page number, the steps a person would take.
final class PreviewPageNavigator {
    private static let bundleID = "com.apple.Preview"
    private static let queue = DispatchQueue(label: "com.jte700.lasso.preview-page", qos: .userInitiated)
    private static let pollInterval: TimeInterval = 0.15
    /// Long enough for Preview to launch and lay out a large PDF.
    private static let patience: TimeInterval = 12
    private static let messagingTimeout: Float = 1
    /// Go to Page's shortcut is Option-Command-G in every language.
    private static let goToPageKey = "G"
    private static let optionModifier = 2 // kAXMenuItemModifierOption; Command is implied.
    /// Navigations in flight, kept alive until they finish.
    private static var running: [ObjectIdentifier: PreviewPageNavigator] = [:]

    private let page: Int
    private let documentPath: String
    private let deadline = Date().addingTimeInterval(patience)
    private var choseGoToPage = false

    private init(page: Int, documentURL: URL) {
        self.page = page
        self.documentPath = documentURL.standardizedFileURL.resolvingSymlinksInPath().path
    }

    static func start(page: Int, documentURL: URL) {
        guard AXIsProcessTrusted() else {
            NSLog("Lasso opened the PDF, but needs Accessibility access to go to page %d in Preview.", page)
            return
        }
        let navigator = PreviewPageNavigator(page: page, documentURL: documentURL)
        queue.async {
            running[ObjectIdentifier(navigator)] = navigator
            navigator.step()
        }
    }

    private func step() {
        guard Date() < deadline else {
            finish("Preview did not show the page in time")
            return
        }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID)
                .first(where: { $0.isFinishedLaunching }) else { return retry() }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, Self.messagingTimeout)
        guard let window = documentWindow(in: application) else { return retry() }
        if !choseGoToPage {
            // The menu acts on Preview's main window, so wait until it is ours.
            guard bool(window, kAXMainAttribute),
                  let item = goToPageItem(in: application), bool(item, kAXEnabledAttribute) else {
                AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                return retry()
            }
            choseGoToPage = AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
            return retry()
        }
        guard let dialog = goToPageDialog(of: window, in: application),
              let field = descendant(of: dialog, role: kAXTextFieldRole) else { return retry() }
        AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, String(page) as CFString)
        if let button = element(dialog, "AXDefaultButton"),
           AXUIElementPerformAction(button, kAXPressAction as CFString) == .success {
            finish(nil)
        } else if AXUIElementPerformAction(field, kAXConfirmAction as CFString) == .success {
            finish(nil)
        } else {
            finish("Go to Page could not be confirmed")
        }
    }

    private func retry() {
        Self.queue.asyncAfter(deadline: .now() + Self.pollInterval) { self.step() }
    }

    private func finish(_ failure: String?) {
        if let failure {
            NSLog("Lasso opened the PDF, but did not go to page %d in Preview: %@", page, failure)
        }
        Self.running.removeValue(forKey: ObjectIdentifier(self))
    }

    /// The window whose document is the opened file.
    private func documentWindow(in application: AXUIElement) -> AXUIElement? {
        elements(application, kAXWindowsAttribute).first { window in
            guard let document = string(window, kAXDocumentAttribute),
                  let url = URL(string: document), url.isFileURL else { return false }
            return url.standardizedFileURL.resolvingSymlinksInPath().path == documentPath
        }
    }

    /// Found by its shortcut rather than its title, which is localized.
    private func goToPageItem(in application: AXUIElement) -> AXUIElement? {
        guard let bar = element(application, kAXMenuBarAttribute) else { return nil }
        for menuTitle in elements(bar, kAXChildrenAttribute) {
            for menu in elements(menuTitle, kAXChildrenAttribute) {
                if let item = elements(menu, kAXChildrenAttribute).first(where: { item in
                    string(item, kAXMenuItemCmdCharAttribute)?.uppercased() == Self.goToPageKey
                        && integer(item, kAXMenuItemCmdModifiersAttribute) == Self.optionModifier
                }) { return item }
            }
        }
        return nil
    }

    /// Go to Page appears as a sheet on the document window, or as a dialog.
    private func goToPageDialog(of window: AXUIElement, in application: AXUIElement) -> AXUIElement? {
        if let sheet = elements(window, kAXChildrenAttribute).first(where: { string($0, kAXRoleAttribute) == kAXSheetRole }) {
            return sheet
        }
        return elements(application, kAXWindowsAttribute).first { candidate in
            let subrole = string(candidate, kAXSubroleAttribute)
            return subrole == kAXDialogSubrole || subrole == kAXSystemDialogSubrole
        }
    }

    private func descendant(of root: AXUIElement, role: String, depth: Int = 0) -> AXUIElement? {
        guard depth < 6 else { return nil }
        for child in elements(root, kAXChildrenAttribute) {
            if string(child, kAXRoleAttribute) == role { return child }
            if let found = descendant(of: child, role: role, depth: depth + 1) { return found }
        }
        return nil
    }

    private func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
    }

    private func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = value(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private func elements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        value(element, attribute) as? [AXUIElement] ?? []
    }

    private func string(_ element: AXUIElement, _ attribute: String) -> String? {
        value(element, attribute) as? String
    }

    private func bool(_ element: AXUIElement, _ attribute: String) -> Bool {
        value(element, attribute) as? Bool ?? false
    }

    private func integer(_ element: AXUIElement, _ attribute: String) -> Int? {
        (value(element, attribute) as? NSNumber)?.intValue
    }
}
