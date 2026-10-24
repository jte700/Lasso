// The Ranch's window. Like Settings, it gives Lasso a Dock icon and menu bar
// while it is open, and Lasso goes back to the menu bar when it closes.

import Cocoa
import SwiftUI

final class RanchWindowController: NSWindowController, NSWindowDelegate {
    static let title = Ranch.title
    private static let autosaveName = "LassoRanch"

    let store = RanchStore()
    var onClose: (() -> Void)?

    var isVisible: Bool { window?.isVisible == true }

    init(actions: RanchActions) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 780),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = Self.title
        window.toolbarStyle = .unified
        // An empty toolbar gives the title bar the height macOS gives sidebar windows.
        window.toolbar = NSToolbar(identifier: Self.autosaveName)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 860, height: 520)
        window.tabbingMode = .disallowed
        let hosting = NSHostingController(rootView: RanchRootView(store: store, actions: actions))
        // The window keeps the size people give it, not the content's ideal size.
        hosting.sizingOptions = []
        window.contentViewController = hosting
        window.setContentSize(NSSize(width: 1240, height: 780))
        super.init(window: window)
        window.delegate = self
        window.setFrameAutosaveName(Self.autosaveName)
    }

    required init?(coder: NSCoder) { nil }

    /// Opens the window, on `section` when given, reading the library afresh.
    func show(section: RanchStore.Section? = nil, serverURL: URL?) {
        store.serverURL = serverURL
        if let section { store.section = section }
        if let window, !window.isVisible, !window.setFrameUsingName(Self.autosaveName) { window.center() }
        store.startRefreshing()
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        store.stopRefreshing()
        onClose?()
    }
}

extension RanchStore.Section {
    /// Where the notch's button leads: what needs review, what changed, or everything.
    init(notchDestination: String) {
        switch notchDestination {
        case "attention": self = .review
        case "changes": self = .changes
        default: self = .sources
        }
    }
}
