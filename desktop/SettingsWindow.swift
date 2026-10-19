// Lasso Settings, opened with Command-Comma or Settings… in the status panel.
//
// One General pane holds the app-wide options that otherwise live only in the
// status panel. The window reads and writes them through the application
// delegate, so both places always show the same state.

import Cocoa

struct SettingsActions {
    let suggestWhileTyping: () -> Bool
    let setSuggestWhileTyping: (Bool) -> Void
    let showInNotch: () -> Bool
    let setShowInNotch: (Bool) -> Void
    let notchAvailable: () -> Bool
    let openAtLogin: () -> Bool
    let setOpenAtLogin: (Bool) -> Void
    /// Called after any change, so the status panel can show the new state.
    let didChange: () -> Void
}

final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    private let actions: SettingsActions
    private let suggest = NSButton(checkboxWithTitle: "Suggest sources while typing in other apps", target: nil, action: nil)
    private let insertion = NSPopUpButton()
    private let insertionNote = SettingsWindowController.note("")
    private let notch = NSButton(checkboxWithTitle: "Show Lasso in the notch", target: nil, action: nil)
    private let notchNote = SettingsWindowController.note("Available on Macs with a camera housing in the display.")
    private let login = NSButton(checkboxWithTitle: "Open Lasso at login", target: nil, action: nil)
    private var grid: NSGridView?
    private static let notchNoteRow = 4

    /// Runs when the window closes, so the app can leave the Dock again.
    var onClose: (() -> Void)?

    private static let contentWidth: CGFloat = 520
    private static let labelColumnWidth: CGFloat = 150
    private static let noteWidth: CGFloat = contentWidth - labelColumnWidth - 76

    init(actions: SettingsActions) {
        self.actions = actions
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Self.contentWidth, height: 240),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        // A single-pane settings window is titled "App Name Settings".
        window.title = "\(MainMenu.appName) Settings"
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("LassoSettings")
        super.init(window: window)
        window.delegate = self
        buildContent()
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
        suggest.target = self; suggest.action = #selector(changeSuggest)
        notch.target = self; notch.action = #selector(changeNotch)
        login.target = self; login.action = #selector(changeLogin)
        insertion.target = self; insertion.action = #selector(changeInsertion)
        for mode in InsertionMode.allCases {
            insertion.addItem(withTitle: mode.title)
            insertion.lastItem?.representedObject = mode.rawValue
        }
        insertion.setAccessibilityLabel("Tab inserts")

        let grid = NSGridView(views: [
            [Self.rowLabel("Suggestions:"), suggest],
            [Self.rowLabel("Tab inserts:"), insertion],
            [NSGridCell.emptyContentView, insertionNote],
            [Self.rowLabel("Notch:"), notch],
            [NSGridCell.emptyContentView, notchNote],
            [Self.rowLabel("Startup:"), login],
        ])
        grid.translatesAutoresizingMaskIntoConstraints = false
        grid.rowSpacing = 8
        grid.columnSpacing = 8
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 0).width = Self.labelColumnWidth
        grid.rowAlignment = .firstBaseline
        // Notes sit closer to the control they explain than to the next row.
        grid.row(at: 2).topPadding = -4
        grid.row(at: Self.notchNoteRow).topPadding = -4
        grid.row(at: 3).topPadding = 10
        grid.row(at: 5).topPadding = 10

        self.grid = grid
        let content = NSView()
        content.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -40),
            grid.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
            content.widthAnchor.constraint(equalToConstant: Self.contentWidth),
        ])
        window?.contentView = content
    }

    /// Reads the current values, for example after the status panel changed one.
    func refresh() {
        suggest.state = actions.suggestWhileTyping() ? .on : .off
        let mode = InsertionMode.current
        insertion.selectItem(at: InsertionMode.allCases.firstIndex(of: mode) ?? 0)
        insertionNote.stringValue = mode.explanation
        let notchAvailable = actions.notchAvailable()
        notch.isEnabled = notchAvailable
        notch.state = notchAvailable && actions.showInNotch() ? .on : .off
        grid?.row(at: Self.notchNoteRow).isHidden = notchAvailable
        login.state = actions.openAtLogin() ? .on : .off
        fitWindowToContent()
    }

    /// Notes change length and the notch note comes and goes, so the window
    /// takes the height its rows need.
    private func fitWindowToContent() {
        guard let window, let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        let size = content.fittingSize
        guard size.height > 0, size != content.frame.size else { return }
        let top = window.frame.maxY
        window.setContentSize(size)
        window.setFrameTopLeftPoint(NSPoint(x: window.frame.minX, y: top))
    }

    func show() {
        refresh()
        // The first time, center the window; after that, reopen where people left it.
        if let window, !window.isVisible, !window.setFrameUsingName("LassoSettings") { window.center() }
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    @objc private func changeSuggest() { actions.setSuggestWhileTyping(suggest.state == .on); refresh() }
    @objc private func changeNotch() { actions.setShowInNotch(notch.state == .on); refresh() }
    @objc private func changeLogin() { actions.setOpenAtLogin(login.state == .on); refresh() }

    @objc private func changeInsertion() {
        guard let raw = insertion.selectedItem?.representedObject as? String,
              let mode = InsertionMode(rawValue: raw) else { return }
        InsertionMode.set(mode)
        actions.didChange()
        refresh()
    }

    func windowWillClose(_ notification: Notification) { onClose?() }
}
