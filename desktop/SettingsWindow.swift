// Lasso Settings, opened with Command-Comma or Settings… in the status panel.
//
// General holds options that change how Lasso looks and behaves, and that the
// status panel does not already show: appearance, the folder colour, what Tab
// inserts, the notch, and how Lasso starts. Everyday switches stay in the
// panel. Shortcuts lists every keyboard shortcut Lasso has on the Mac.

import Cocoa

/// The panes of Settings, chosen from its toolbar.
enum SettingsPane: String, CaseIterable {
    case general, shortcuts

    var title: String {
        switch self {
        case .general: return "General"
        case .shortcuts: return "Shortcuts"
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
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
    let showInNotch: () -> Bool
    let setShowInNotch: (Bool) -> Void
    let notchAvailable: () -> Bool
    /// "Lasso 1.0.0 · Server: …", for the line at the bottom.
    let version: () -> String
    /// Called after any change, so the status panel can show the new state.
    let didChange: () -> Void
}

final class SettingsWindowController: NSWindowController, NSWindowDelegate, NSToolbarDelegate {
    private let actions: SettingsActions
    private let generalView = NSView()
    private lazy var shortcutsView = ShortcutsPane.makeView(width: Self.contentWidth)
    private let appearance = NSPopUpButton()
    private let color = NSPopUpButton()
    private let colorNote = SettingsWindowController.note("Folders you haven\u{2019}t given their own colour, and the text you accept from them.")
    private let insertion = NSPopUpButton()
    private let insertionNote = SettingsWindowController.note("")
    private let notch = NSButton(checkboxWithTitle: "Show Lasso in the notch", target: nil, action: nil)
    private let notchNote = SettingsWindowController.note("Available on Macs with a camera housing in the display.")
    private let startNote = SettingsWindowController.note("")
    private let loginItems = NSButton(title: "Open Login Items\u{2026}", target: nil, action: nil)
    private let version = SettingsWindowController.note("")
    private var grid: NSGridView?
    private static let notchNoteRow = 6
    private static let loginItemsRow = 8
    private static let versionRow = 9

    /// Runs when the window closes, so the app can leave the Dock again.
    var onClose: (() -> Void)?

    private static let contentWidth: CGFloat = 520
    private static let labelColumnWidth: CGFloat = 150
    private static let noteWidth: CGFloat = contentWidth - labelColumnWidth - 76
    private static let swatchSize: CGFloat = 12

    init(actions: SettingsActions) {
        self.actions = actions
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
        buildContent()
        select(.general)
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private static func note(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        label.textColor = .secondaryLabelColor
        // A fixed width lets the note wrap and report its real height.
        label.preferredMaxLayoutWidth = noteWidth
        label.widthAnchor.constraint(equalToConstant: noteWidth).isActive = true
        return label
    }

    private static func rowLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.alignment = .right
        return label
    }

    private func buildContent() {
        appearance.target = self; appearance.action = #selector(changeAppearance)
        for preference in AppearancePreference.allCases {
            appearance.addItem(withTitle: preference.title)
            appearance.lastItem?.representedObject = preference.rawValue
        }
        appearance.setAccessibilityLabel("Appearance")
        color.target = self; color.action = #selector(changeColor)
        for option in DirectoryToggleColor.allCases {
            color.addItem(withTitle: option.title)
            color.lastItem?.representedObject = option.rawValue
            color.lastItem?.image = option.swatch(size: Self.swatchSize)
        }
        color.setAccessibilityLabel("Folder colour")
        insertion.target = self; insertion.action = #selector(changeInsertion)
        for mode in InsertionMode.allCases {
            insertion.addItem(withTitle: mode.title)
            insertion.lastItem?.representedObject = mode.rawValue
        }
        insertion.setAccessibilityLabel("Tab inserts")
        notch.target = self; notch.action = #selector(changeNotch)
        loginItems.bezelStyle = .rounded
        loginItems.target = self; loginItems.action = #selector(openLoginItems)

        let grid = NSGridView(views: [
            [Self.rowLabel("Appearance:"), appearance],
            [Self.rowLabel("Folder colour:"), color],
            [NSGridCell.emptyContentView, colorNote],
            [Self.rowLabel("Tab inserts:"), insertion],
            [NSGridCell.emptyContentView, insertionNote],
            [Self.rowLabel("Notch:"), notch],
            [NSGridCell.emptyContentView, notchNote],
            [Self.rowLabel("Start:"), startNote],
            [NSGridCell.emptyContentView, loginItems],
            [NSGridCell.emptyContentView, version],
        ])
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.rowSpacing = 8
        grid.columnSpacing = 8
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 0).width = Self.labelColumnWidth
        grid.rowAlignment = .firstBaseline
        // Notes sit closer to the control they explain than to the next row.
        for row in [2, 4, Self.notchNoteRow] { grid.row(at: row).topPadding = -4 }
        // Groups: how Lasso looks, what Tab does, the notch, how Lasso starts.
        for row in [3, 5, 7] { grid.row(at: row).topPadding = 10 }
        grid.row(at: Self.versionRow).topPadding = 16

        self.grid = grid
        generalView.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: generalView.topAnchor, constant: 24),
            grid.leadingAnchor.constraint(equalTo: generalView.leadingAnchor, constant: 20),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: generalView.trailingAnchor, constant: -40),
            grid.bottomAnchor.constraint(equalTo: generalView.bottomAnchor, constant: -24),
            generalView.widthAnchor.constraint(equalToConstant: Self.contentWidth),
        ])
    }

    /// Shows a pane. A settings window with panes is titled by the one it shows.
    private func select(_ pane: SettingsPane) {
        guard let window else { return }
        window.toolbar?.selectedItemIdentifier = pane.identifier
        window.title = pane.title
        let view: NSView = pane == .general ? generalView : shortcutsView
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
    func refresh() {
        appearance.selectItem(at: AppearancePreference.allCases.firstIndex(of: AppearancePreference.current()) ?? 0)
        color.selectItem(at: DirectoryToggleColor.allCases.firstIndex(of: DirectoryColorPreferences.defaultColor()) ?? 0)
        let mode = InsertionMode.current
        insertion.selectItem(at: InsertionMode.allCases.firstIndex(of: mode) ?? 0)
        insertionNote.stringValue = mode.explanation
        let notchAvailable = actions.notchAvailable()
        notch.isEnabled = notchAvailable
        notch.state = notchAvailable && actions.showInNotch() ? .on : .off
        grid?.row(at: Self.notchNoteRow).isHidden = notchAvailable
        let start = LaunchHelper.state
        startNote.stringValue = LaunchHelper.note(for: start)
        grid?.row(at: Self.loginItemsRow).isHidden = start == .on
        version.stringValue = actions.version()
        fitWindowToContent()
    }

    /// Notes change length, some rows come and go, and each pane has its own
    /// height, so the window takes the height the shown pane needs.
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

    func show() {
        refresh()
        // The first time, center the window; after that, reopen where people left it.
        if let window, !window.isVisible, !window.setFrameUsingName("LassoSettings") { window.center() }
        // The saved frame may have been the other pane's; keep its place, not its height.
        fitWindowToContent()
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    @objc private func changeAppearance() {
        guard let raw = appearance.selectedItem?.representedObject as? String,
              let preference = AppearancePreference(rawValue: raw) else { return }
        AppearancePreference.set(preference)
        actions.didChange()
        refresh()
    }

    @objc private func changeColor() {
        guard let raw = color.selectedItem?.representedObject as? String,
              let option = DirectoryToggleColor(rawValue: raw) else { return }
        DirectoryColorPreferences.setDefault(option)
        actions.didChange()
        refresh()
    }

    @objc private func changeNotch() { actions.setShowInNotch(notch.state == .on); refresh() }

    @objc private func changeInsertion() {
        guard let raw = insertion.selectedItem?.representedObject as? String,
              let mode = InsertionMode(rawValue: raw) else { return }
        InsertionMode.set(mode)
        actions.didChange()
        refresh()
    }

    @objc private func openLoginItems() { LaunchHelper.openSettings() }

    func windowWillClose(_ notification: Notification) { onClose?() }
}
