// The Ranch's window. Like Settings, it gives Lasso a Dock icon and menu bar
// while it is open, and Lasso goes back to the menu bar when it closes.

import Cocoa
import SwiftUI

final class RanchWindowController: NSWindowController, NSWindowDelegate {
    static let title = Ranch.title
    private static let autosaveName = "LassoRanch"

    let store: RanchStore
    var onClose: (() -> Void)?

    var isVisible: Bool { window?.isVisible == true }

    init(actions: RanchActions, store: RanchStore = RanchStore()) {
        self.store = store
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 780),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        // The title names the window in the Window menu and to VoiceOver; the
        // sidebar shows it. The columns run to the top edge, under the window's
        // buttons, and their headers move the window as a title bar would.
        window.title = Self.title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = RanchTheme.nsSurface
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 860, height: 520)
        window.tabbingMode = .disallowed
        super.init(window: window)
        // Before the content: the window keeps the first undo manager anything
        // asks it for, and SwiftUI asks while the content is set up.
        window.delegate = self
        let hosting = NSHostingController(rootView: RanchRootView(store: store, actions: actions))
        // The window keeps the size people give it, not the content's ideal size.
        hosting.sizingOptions = []
        window.contentViewController = hosting
        // The window opens with no field taking the keyboard, as Finder's do;
        // left alone, AppKit would give it to the search field.
        window.initialFirstResponder = hosting.view
        window.setContentSize(NSSize(width: 1240, height: 780))
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

    func windowWillReturnUndoManager(_ window: NSWindow) -> UndoManager? { store.undoManager }

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
