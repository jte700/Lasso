// Lasso Settings, opened with Command-Comma or Settings… in the status panel.
//
// General holds options that change how Lasso looks and behaves, and that the
// status panel does not already show: appearance and what Tab
// inserts, with the folder colour, starting at login and the version under
// Advanced. Apps switches suggestions off in chosen apps. Shortcuts lists
// every keyboard shortcut Lasso has on the Mac. The first two are SwiftUI
// grouped forms (SettingsPanes.swift), so they match System Settings.

import Cocoa
import SwiftUI

/// The panes of Settings, chosen from its toolbar.
enum SettingsPane: String, CaseIterable {
    case general, apps, shortcuts

    var title: String {
        switch self {
        case .general: return "General"
        case .apps: return "Apps"
        case .shortcuts: return "Shortcuts"
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .apps: return "app.badge.checkmark"
        case .shortcuts: return "keyboard"
        }
    }

    var identifier: NSToolbarItem.Identifier { NSToolbarItem.Identifier("LassoSettings.\(rawValue)") }

    init?(identifier: NSToolbarItem.Identifier) {
        guard let pane = Self.allCases.first(where: { $0.identifier == identifier }) else { return nil }
        self = pane
    }
}

struct SettingsActions {
    /// "Lasso 1.0.0 · Server: …", shown under Advanced.
    let version: () -> String
    /// Called after any change, so the status panel can show the new state.
    let didChange: () -> Void
}

final class SettingsWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate {
    let model: SettingsModel
    private lazy var generalView = Self.host(SettingsGeneralView(model: model).frame(width: Self.contentWidth))
    private lazy var appsView = Self.host(SettingsAppsView(model: model).frame(width: Self.contentWidth))
    private lazy var shortcutsView = ShortcutsPane.makeView(width: Self.contentWidth)
    private var pane = SettingsPane.general

    /// Runs when the window closes, so the app can leave the Dock again.
    var onClose: (() -> Void)?

    private static let contentWidth: CGFloat = 500

    init(actions: SettingsActions) {
        model = SettingsModel(actions: actions)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Self.contentWidth, height: 240),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.toolbarStyle = .preference
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("LassoSettings")
        super.init(window: window)
        window.delegate = self
        let toolbar = NSToolbar(identifier: "LassoSettings")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        toolbar.allowsUserCustomization = false
        window.toolbar = toolbar
        // Opening Advanced, or adding an app, changes the height the pane needs.
        model.onResize = { [weak self] in DispatchQueue.main.async { self?.fitWindowToContent() } }
        select(.general)
        model.refresh()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private static func host<Content: View>(_ view: Content) -> NSView {
        let hosting = NSHostingView(rootView: view.fixedSize(horizontal: false, vertical: true))
        hosting.sizingOptions = [.intrinsicContentSize]
        return hosting
    }

    /// Shows a pane. A settings window with panes is titled by the one it shows.
    func select(_ pane: SettingsPane) {
        guard let window else { return }
        self.pane = pane
        window.toolbar?.selectedItemIdentifier = pane.identifier
        window.title = pane.title
        let view: NSView
        switch pane {
        case .general: view = generalView
        case .apps: model.reloadApps(); view = appsView
        case .shortcuts: view = shortcutsView
        }
        if window.contentView !== view { window.contentView = view }
        fitWindowToContent()
        // The list takes focus so the keyboard can scroll it.
        if pane == .shortcuts { window.makeFirstResponder(shortcutsView.list) }
    }

    @objc private func choosePane(_ sender: NSToolbarItem) {
        guard let pane = SettingsPane(identifier: sender.itemIdentifier) else { return }
        select(pane)
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        SettingsPane.allCases.map(\.identifier)
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard let pane = SettingsPane(identifier: identifier) else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = pane.title
        item.image = NSImage(systemSymbolName: pane.symbol, accessibilityDescription: pane.title)
        item.target = self
        item.action = #selector(choosePane(_:))
        return item
    }

    /// Reads the current values, for example after the status panel changed one.
    /// A closed window reads them when it opens again.
    func refresh() {
        guard window?.isVisible == true else { return }
        model.refresh()
    }

    /// Some rows come and go, Advanced opens and closes, and each pane has its
    /// own height, so the window takes the height the shown pane needs.
    private func fitWindowToContent() {
        guard let window, let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        let size = content.fittingSize
        // Compared with the window's content area: Auto Layout may already
        // have stretched the view itself past the window.
        guard size.height > 0, size != window.contentRect(forFrameRect: window.frame).size else { return }
        let frameSize = window.frameRect(forContentRect: NSRect(origin: .zero, size: size)).size
        let frame = NSRect(x: window.frame.minX, y: window.frame.maxY - frameSize.height,
                           width: frameSize.width, height: frameSize.height)
        window.setFrame(frame, display: true, animate: window.isVisible)
    }

    func show(pane: SettingsPane? = nil) {
        model.refresh()
        if let pane { select(pane) }
        // The first time, center the window; after that, reopen where people left it.
        if let window, !window.isVisible, !window.setFrameUsingName("LassoSettings") { window.center() }
        // The saved frame may have been another pane's; keep its place, not its height.
        fitWindowToContent()
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) { onClose?() }
}
