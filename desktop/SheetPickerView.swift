// The sheet picker's window: the file's name and sheet above, the sheet's
// grid in the middle, and along the bottom Insert, the switch for the header
// row and the switch for the source, with what will be cited. It sits on the
// card's Liquid Glass surface, as the passage picker does.

import Cocoa

final class SheetPickerView: NSView {
    static let defaultSize = NSSize(width: 720, height: 560)
    private static let margin: CGFloat = 18
    private static let headerHeight: CGFloat = 56
    private static let footerHeight: CGFloat = 64

    var onInsert: ((SheetPick) -> Void)?
    var onCancel: (() -> Void)?
    /// A sheet of the workbook was chosen from its menu.
    var onSheet: ((String) -> Void)?

    private let icon = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    private let closeButton = PassagePickerControls.circleButton(symbol: "xmark", label: "Back to suggestions (Esc)")
    /// The pill naming the sheet shown, made anew for each; none for a single sheet or a CSV.
    private var sheetButton: PassagePillButton?
    private let message = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let scroll = NSScrollView()
    private let grid = SheetGridView()
    private let insertButton = PassagePillButton(title: "Insert", symbol: "arrow.right.to.line", style: .prominent)
    private let headersSwitch = PassageToggle()
    private let headersLabel = NSTextField(labelWithString: "Headers")
    private let sourceSwitch = PassageToggle()
    private let sourceLabel = NSTextField(labelWithString: "Source")
    private let citationLabel = NSTextField(labelWithString: "")
    private static let maxSheetButtonWidth: CGFloat = 220

    var highlightColor: NSColor {
        get { grid.highlightColor }
        set { grid.highlightColor = newValue }
    }

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        build()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func build() {
        icon.imageScaling = .scaleProportionallyUpOrDown
        insertButton.glyph = "\u{21E5}"
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.lineBreakMode = .byTruncatingMiddle
        hint.font = .systemFont(ofSize: 11.5)
        hint.textColor = .secondaryLabelColor
        hint.lineBreakMode = .byTruncatingTail
        closeButton.target = self
        closeButton.action = #selector(cancel)
        message.alignment = .center
        message.textColor = .secondaryLabelColor
        message.font = .systemFont(ofSize: 13)
        spinner.style = .spinning
        spinner.isDisplayedWhenStopped = false
        scroll.documentView = grid
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 8
        scroll.layer?.masksToBounds = true
        scroll.contentView.postsBoundsChangedNotifications = true
        grid.layerContentsRedrawPolicy = .onSetNeedsDisplay
        // The letters and numbers are pinned to the visible edges, so a scroll redraws them.
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification,
                                               object: scroll.contentView)
        grid.onHighlightsChange = { [weak self] _ in self?.updateControls() }
        insertButton.target = self
        insertButton.action = #selector(insert)
        insertButton.toolTip = "Insert the highlighted cells (Tab)"
        for (toggle, label, name) in [(headersSwitch, headersLabel, "Insert with the header row"), (sourceSwitch, sourceLabel, "Insert with source")] {
            toggle.setAccessibilityLabel(name)
            toggle.target = self
            toggle.action = #selector(optionToggled)
            label.font = .systemFont(ofSize: 13)
        }
        citationLabel.font = .systemFont(ofSize: 11)
        citationLabel.lineBreakMode = .byTruncatingMiddle
        [icon, title, hint, closeButton, message, spinner, scroll, insertButton,
         headersSwitch, headersLabel, sourceSwitch, sourceLabel, citationLabel].forEach(addSubview)
        showLoading(name: "")
    }

    @objc private func scrolled() { grid.setNeedsDisplay(grid.visibleRect) }

    override func layout() {
        super.layout()
        let margin = Self.margin, width = bounds.width
        icon.frame = NSRect(x: margin, y: 12, width: 32, height: 32)
        closeButton.frame = NSRect(x: width - margin - 28, y: 13, width: 28, height: 28)
        var titleEnd = closeButton.frame.minX
        if let sheetButton {
            let sheetWidth = min(sheetButton.intrinsicContentSize.width, Self.maxSheetButtonWidth)
            sheetButton.frame = NSRect(x: closeButton.frame.minX - 10 - sheetWidth, y: 12, width: sheetWidth, height: 30)
            titleEnd = sheetButton.frame.minX
        }
        let textWidth = max(0, titleEnd - margin - 54)
        title.frame = NSRect(x: margin + 44, y: 11, width: textWidth, height: 18)
        hint.frame = NSRect(x: margin + 44, y: 29, width: textWidth, height: 15)
        let body = NSRect(x: margin, y: Self.headerHeight, width: width - margin * 2,
                          height: max(0, bounds.height - Self.headerHeight - Self.footerHeight))
        scroll.frame = body
        message.frame = NSRect(x: margin * 2, y: body.midY - 10, width: width - margin * 4, height: 44)
        spinner.frame = NSRect(x: bounds.midX - 10, y: body.midY - 34, width: 20, height: 20)
        let footerY = bounds.height - Self.footerHeight + 16
        insertButton.frame = NSRect(x: margin, y: footerY, width: max(96, insertButton.intrinsicContentSize.width), height: 32)
        var x = width - margin
        for (toggle, label) in [(sourceSwitch, sourceLabel), (headersSwitch, headersLabel)] {
            let size = toggle.intrinsicContentSize
            x -= size.width
            toggle.frame = NSRect(x: x, y: footerY + (32 - size.height) / 2, width: size.width, height: size.height)
            label.sizeToFit()
            x -= 8 + label.frame.width
            label.frame.origin = NSPoint(x: x, y: footerY + (32 - label.frame.height) / 2)
            x -= 18
        }
        let citationX = insertButton.frame.maxX + 12
        citationLabel.frame = NSRect(x: citationX, y: footerY + 9, width: max(0, x + 8 - citationX), height: 14)
    }

    // MARK: Showing

    func showLoading(name: String) {
        title.stringValue = name
        icon.image = PassagePickerView.fileIcon(name)
        scroll.isHidden = true
        setSheetButton(nil)
        spinner.startAnimation(nil)
        show(message: "Opening \(name.isEmpty ? "the sheet" : name)\u{2026}")
    }

    func show(message text: String) {
        message.stringValue = text
        message.isHidden = false
        if !text.hasPrefix("Opening") { spinner.stopAnimation(nil) }
        updateControls()
    }

    /// The sheet as it looks, with the cited cell, row or column highlighted.
    func show(_ document: SheetDocument) {
        title.stringValue = document.name
        icon.image = PassagePickerView.fileIcon(document.name)
        spinner.stopAnimation(nil)
        if let reason = document.unavailable ?? (document.rows.isEmpty ? "This sheet has no cells." : nil) {
            scroll.isHidden = true
            show(message: reason)
            return
        }
        message.isHidden = true
        scroll.isHidden = false
        grid.show(document)
        grid.highlights = document.selection.map { SheetHighlights().adding($0) } ?? SheetHighlights()
        setSheetButton(document.sheets.count > 1 ? document.sheet : nil)
        needsLayout = true
        layoutSubtreeIfNeeded()
        grid.revealLatest(centered: true)
        updateControls()
    }

    private func setSheetButton(_ name: String?) {
        sheetButton?.removeFromSuperview()
        sheetButton = nil
        guard let name else { return }
        let button = PassagePillButton(title: name, symbol: "tablecells", style: .secondary)
        button.target = self
        button.action = #selector(chooseSheet)
        button.toolTip = "Show another sheet"
        addSubview(button)
        sheetButton = button
    }

    @objc private func chooseSheet() {
        guard let document = grid.document, document.sheets.count > 1 else { return }
        let menu = NSMenu()
        for name in document.sheets {
            let item = NSMenuItem(title: name, action: #selector(sheetChosen(_:)), keyEquivalent: "")
            item.target = self
            item.state = name == document.sheet ? .on : .off
            menu.addItem(item)
        }
        guard let button = sheetButton else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY + 4), in: button)
    }

    @objc private func sheetChosen(_ item: NSMenuItem) {
        guard item.title != grid.document?.sheet else { return }
        onSheet?(item.title)
    }

    // MARK: Choosing

    var currentPick: SheetPick? {
        guard let document = grid.document, !scroll.isHidden else { return nil }
        let ranges = grid.highlights.ranges
        guard var pick = SheetClipboard.pick(document, highlights: ranges, headers: headersSwitch.isOn, citing: sourceSwitch.isOn) else { return nil }
        pick.includesCited = document.selection.map { cited in ranges.contains { $0.contains(row: cited.top, column: cited.left) } } ?? false
        return pick
    }

    var canInsert: Bool { currentPick != nil }

    private func updateControls() {
        let pick = currentPick
        insertButton.isEnabled = pick != nil
        citationLabel.stringValue = pick?.citation ?? ""
        citationLabel.textColor = sourceSwitch.isOn ? .secondaryLabelColor : .tertiaryLabelColor
        let count = grid.highlights.ranges.count
        hint.stringValue = count == 0 ? "Drag to highlight cells \u{00B7} Esc goes back"
            : "Drag again to add cells \u{00B7} \u{2318}Z removes the last \u{00B7} Tab inserts"
    }

    @objc private func optionToggled() { updateControls() }

    @objc func insert() {
        guard let pick = currentPick else { NSSound.beep(); return }
        onInsert?(pick)
    }

    @objc func cancel() { onCancel?() }

    func undo() { grid.update(grid.highlights.undoing()); updateControls() }
    func redo() { grid.update(grid.highlights.redoing()); updateControls() }

    func move(columns: Int, rows: Int, extending: Bool) {
        guard let document = grid.document else { return }
        // With nothing highlighted, an arrow starts on the sheet's first cell.
        if grid.highlights.isEmpty, let first = document.rows.first {
            grid.update(grid.highlights.adding(SheetRange(top: first.number, bottom: first.number, left: 0, right: 0)))
        } else {
            grid.update(grid.highlights.moving(columns: columns, rows: rows, extending: extending, in: document))
        }
        grid.revealLatest()
        updateControls()
    }

    // MARK: Moving

    /// The title bar moves the window, as the passage picker's does.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        let controls = [closeButton.frame, sheetButton?.frame ?? .zero]
        if bounds.contains(local), local.y < Self.headerHeight, !controls.contains(where: { $0.contains(local) }) { return self }
        let hit = super.hitTest(point)
        if let label = hit as? NSTextField, label.superview === self { return self }
        return hit
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if let window { CardPanelTakeover.drag(window) }
    }
}
