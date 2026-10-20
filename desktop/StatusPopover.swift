import Cocoa

private final class StatusContentView: NSView {
    override var isFlipped: Bool { true }
}

/// A popover row that behaves like a menu item: a fixed checkmark column so
/// titles align, a hover highlight, and a trailing shortcut or disclosure chevron.
private final class StatusCommandButton: NSButton {
    var onInvoke: (() -> Void)?
    private let symbolName: String?
    private let shortcut: String
    private let disclosure: Bool?
    private var hovering = false { didSet { needsDisplay = true } }

    init(item: NSMenuItem, expanded: Bool? = nil) {
        disclosure = expanded
        symbolName = expanded == nil && item.state == .on ? "checkmark" : nil
        shortcut = expanded == nil ? Self.shortcutText(item) : ""
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 26))
        title = item.title
        isBordered = false
        isEnabled = item.isEnabled
        keyEquivalent = item.keyEquivalent
        keyEquivalentModifierMask = item.keyEquivalentModifierMask
        if expanded == nil, item.state != .on { image = item.image }
        toolTip = item.toolTip
        target = self
        action = #selector(invoke)
        setAccessibilityLabel(item.title)
        if item.state == .on { setAccessibilityValue("checked") }
        if let expanded { setAccessibilityValue(expanded ? "expanded" : "collapsed") }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private static func shortcutText(_ item: NSMenuItem) -> String {
        guard !item.keyEquivalent.isEmpty else { return "" }
        let flags = item.keyEquivalentModifierMask
        return (flags.contains(.control) ? "⌃" : "") + (flags.contains(.option) ? "⌥" : "")
            + (flags.contains(.shift) ? "⇧" : "") + (flags.contains(.command) ? "⌘" : "")
            + item.keyEquivalent.uppercased()
    }

    override func mouseEntered(with event: NSEvent) { hovering = isEnabled }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override var isEnabled: Bool { didSet { if !isEnabled { hovering = false } } }

    /// A closed popover keeps its views, so a row hovered at close would
    /// reopen highlighted. Read where the pointer really is.
    func refreshHover() {
        guard let window, window.isVisible, isEnabled else { hovering = false; return }
        let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
        hovering = visibleRect.contains(point)
    }

    override func draw(_ dirtyRect: NSRect) {
        if hovering {
            NSColor.labelColor.withAlphaComponent(0.1).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 1), xRadius: 5, yRadius: 5).fill()
        }
        let color: NSColor = isEnabled ? .labelColor : .disabledControlTextColor
        let symbol = symbolName.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) } ?? image
        if let symbol {
            let configured = symbol.withSymbolConfiguration(.init(pointSize: 12, weight: symbolName == nil ? .regular : .semibold)) ?? symbol
            let tinted = configured.tinted(isEnabled ? (symbolName == nil ? .secondaryLabelColor : .labelColor) : .disabledControlTextColor)
            let size = tinted.size
            tinted.draw(in: NSRect(x: 14 + (16 - size.width) / 2, y: (bounds.height - size.height) / 2,
                                   width: size.width, height: size.height))
        }
        let font = NSFont.menuFont(ofSize: 0)
        let trailing: CGFloat = disclosure != nil ? 24 : shortcut.isEmpty ? 12 : 44
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let titleHeight = ceil(font.ascender - font.descender)
        (title as NSString).draw(in: NSRect(x: 36, y: (bounds.height - titleHeight) / 2,
                                            width: bounds.width - 36 - trailing, height: titleHeight),
                                 withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
        if !shortcut.isEmpty {
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.tertiaryLabelColor]
            let width = (shortcut as NSString).size(withAttributes: attributes).width
            (shortcut as NSString).draw(at: NSPoint(x: bounds.width - 14 - width, y: (bounds.height - titleHeight) / 2),
                                        withAttributes: attributes)
        }
        if let disclosure, let chevron = NSImage(systemSymbolName: disclosure ? "chevron.down" : "chevron.right",
                                                  accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold)) {
            let tinted = chevron.tinted(.secondaryLabelColor)
            tinted.draw(in: NSRect(x: bounds.width - 14 - tinted.size.width, y: (bounds.height - tinted.size.height) / 2,
                                   width: tinted.size.width, height: tinted.size.height))
        }
    }

    override var isFlipped: Bool { true }
    @objc private func invoke() { onInvoke?() }
}

private extension NSImage {
    func tinted(_ color: NSColor) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            self.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        image.isTemplate = false
        return image
    }
}

/// Directory rows in their own scroll area, so a long list stays compact.
/// Edges fade only where more rows are hidden, which signals that it scrolls.
final class StatusDirectoryList: NSView {
    static let visibleRows = 4
    static let rowHeight: CGFloat = 32
    /// A lane for the overlay scroller, so its knob never sits on the toggles.
    static let scrollerGutter: CGFloat = 6
    let scroll = NSScrollView()
    private let documentView = StatusContentView()
    private let fade = CAGradientLayer()

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        // Rows are sized explicitly; autoresizing would stretch them again
        // whenever the document view's width changes.
        documentView.autoresizesSubviews = false
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.verticalScrollElasticity = .allowed
        scroll.verticalScroller?.controlSize = .small
        useOverlayScroller()
        scroll.documentView = documentView
        scroll.autoresizingMask = [.width, .height]
        scroll.contentView.postsBoundsChangedNotifications = true
        scroll.wantsLayer = true
        scroll.layer?.mask = fade
        addSubview(scroll)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Work directories")
        NotificationCenter.default.addObserver(self, selector: #selector(updateFade),
            name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(preferredScrollerStyleChanged),
            name: NSScroller.preferredScrollerStyleDidChangeNotification, object: nil)
    }

    /// Menus keep thin overlay scrollers even when System Settings shows
    /// scroll bars always; a tracked legacy bar looks foreign in this panel.
    /// AppKit resets the style when that preference changes, so reapply it.
    private func useOverlayScroller() {
        scroll.scrollerStyle = .overlay
    }

    @objc private func preferredScrollerStyleChanged() {
        DispatchQueue.main.async { [weak self] in self?.useOverlayScroller() }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { NotificationCenter.default.removeObserver(self) }

    var rows: [NSView] { documentView.subviews }

    /// Places rows in order and returns the height that shows four of them.
    /// An open colour palette adds its own height so four folders stay visible.
    func layout(_ rows: [NSView], width: CGFloat) -> CGFloat {
        for view in documentView.subviews where !rows.contains(where: { $0 === view }) {
            view.removeFromSuperview()
        }
        var y: CGFloat = 0
        for row in rows {
            row.frame = NSRect(x: 0, y: y, width: width - Self.scrollerGutter, height: row.frame.height)
            if row.superview !== documentView { documentView.addSubview(row) }
            y += row.frame.height
        }
        let extra = rows.reduce(0) { $0 + max(0, $1.frame.height - Self.rowHeight) }
        let visible = min(y, CGFloat(Self.visibleRows) * Self.rowHeight + extra)
        documentView.frame = NSRect(x: 0, y: 0, width: width, height: y)
        frame.size = NSSize(width: width, height: visible)
        scroll.frame = bounds
        let maximum = max(0, y - visible)
        let offset = min(scroll.contentView.bounds.origin.y, maximum)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: offset))
        scroll.reflectScrolledClipView(scroll.contentView)
        updateFade()
        return visible
    }

    /// Keeps a row (for example one whose palette just opened) fully visible.
    func reveal(_ row: NSView) {
        guard row.superview === documentView else { return }
        documentView.scrollToVisible(row.frame)
        updateFade()
    }

    func flashScrollers() { scroll.flashScrollers() }

    @objc private func updateFade() {
        // Scrolling moves rows under a still pointer without exit events.
        for case let row as NativeMenuToggleRow in documentView.subviews { row.refreshHover() }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fade.frame = scroll.bounds
        let height = max(1, scroll.bounds.height)
        let offset = scroll.contentView.bounds.origin.y
        let hiddenAbove = offset > 0.5
        let hiddenBelow = documentView.frame.height - offset - height > 0.5
        let edge = Float(min(0.4, 16 / height))
        let opaque = NSColor.black.cgColor, clear = NSColor.clear.cgColor
        // A gradient's unit space starts at the bottom unless its host layer is flipped.
        let topFirst = scroll.layer?.contentsAreFlipped() ?? false
        let first = topFirst ? hiddenAbove : hiddenBelow, last = topFirst ? hiddenBelow : hiddenAbove
        fade.colors = [first ? clear : opaque, opaque, opaque, last ? clear : opaque]
        fade.locations = [0, NSNumber(value: edge), NSNumber(value: 1 - edge), 1]
        CATransaction.commit()
    }
}

/// An interactive status panel. Controls update in the same popover; AppKit
/// handles dismissal when the user clicks outside it.
/// The card a directory's issue badge opens: what is wrong, and a button when
/// Lasso can fix it. It is drawn inside the panel's own window, so clicking
/// its button never reads as a click outside the panel.
final class DirectoryIssueCard: NSView {
    static let width: CGFloat = 232
    private static let padding: CGFloat = 10
    private let message = NSTextField(wrappingLabelWithString: "")
    private let fixButton = NSButton(title: "", target: nil, action: nil)
    var onFix: (() -> Void)?

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: Self.width, height: 40))
        message.font = .systemFont(ofSize: 12)
        message.textColor = .labelColor
        message.isSelectable = false
        addSubview(message)
        fixButton.bezelStyle = .rounded
        fixButton.controlSize = .small
        fixButton.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        fixButton.target = self
        fixButton.action = #selector(fix)
        addSubview(fixButton)
        wantsLayer = true
        shadow = NSShadow()
        layer?.shadowOpacity = 0.18
        layer?.shadowRadius = 6
        layer?.shadowOffset = NSSize(width: 0, height: -2)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func show(_ issue: DirectoryIssue) {
        let textWidth = Self.width - Self.padding * 2
        message.stringValue = issue.message
        let textHeight = ceil(message.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: textWidth,
            height: .greatestFiniteMagnitude)).height ?? 16)
        message.frame = NSRect(x: Self.padding, y: Self.padding, width: textWidth, height: textHeight)
        var height = Self.padding + textHeight + Self.padding
        fixButton.isHidden = issue.fixLabel == nil
        if let label = issue.fixLabel {
            fixButton.title = label
            fixButton.sizeToFit()
            fixButton.setFrameOrigin(NSPoint(x: Self.padding - 4, y: height - 2))
            height += fixButton.frame.height + 4
        }
        setFrameSize(NSSize(width: Self.width, height: height))
        setAccessibilityLabel(issue.message)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
        NSColor.windowBackgroundColor.setFill()
        shape.fill()
        NSColor.separatorColor.setStroke()
        shape.stroke()
    }

    @objc private func fix() { onFix?() }
}

final class StatusPopoverController {
    let popover = NSPopover()
    private let controller = NSViewController()
    private let root = NSView(frame: NSRect(x: 0, y: 0, width: 296, height: 300))
    private let scroll = NSScrollView()
    private let content = StatusContentView()
    private var menu: NSMenu?
    private var rows: [(view: NSView, inset: CGFloat)] = []
    private var directoryRows: [String: NativeMenuToggleRow] = [:]
    private var expandedGroups = Set<String>()
    private var width: CGFloat = 296
    private let directoryList = StatusDirectoryList(frame: .zero)
    private let issueCard = DirectoryIssueCard()
    private weak var issueRow: NativeMenuToggleRow?
    /// Checks where the pointer is while a card is open. Hover events alone
    /// miss a pointer that was already inside a view added under it.
    private var issueWatch: Timer?
    private var issueAwayTicks = 0
    private static let issueWatchInterval: TimeInterval = 0.15
    /// Two checks away, long enough to move the pointer from a badge onto its card.
    private static let issueAwayLimit = 2
    /// Escape first ends a mode inside the panel; returns true when it did.
    var onEscape: (() -> Bool)?
    var onClose: (() -> Void)?
    /// The app the user was in when the panel opened. Opening the panel makes
    /// Lasso active; closing it with Escape or the menu bar icon gives focus
    /// back, so the next keystrokes reach the user's document.
    private var previousApplication: NSRunningApplication?

    init() {
        LassoTransientUI.shared.register(self, priority: 10,
            // An alert shown over the panel handles its own Escape.
            isOpen: { [weak self] in self?.popover.isShown == true && NSApp.modalWindow == nil },
            dismiss: { [weak self] in
                guard let self, self.onEscape?() != true else { return }
                self.closeReturningFocus()
            })
        LassoTransientUI.shared.start()
        content.autoresizesSubviews = false
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.documentView = content
        root.addSubview(scroll)
        controller.view = root
        popover.contentViewController = controller
        popover.behavior = .transient
        popover.animates = false
        NotificationCenter.default.addObserver(forName: NSPopover.didCloseNotification, object: popover,
                                               queue: .main) { [weak self] _ in
            self?.hideIssue()
            self?.onClose?()
        }
        issueCard.onFix = { [weak self] in
            guard let self else { return }
            let row = self.issueRow
            self.hideIssue()
            row?.onFix?()
        }
        // Rows scroll under a still pointer without an exit event; the card
        // would stay behind, pointing at another folder.
        for clip in [scroll.contentView, directoryList.scroll.contentView] {
            clip.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip,
                                                   queue: .main) { [weak self] _ in self?.hideIssue() }
        }
    }

    /// Whether the pointer is over a view right now, as a refresh sends no hover events.
    private func pointerIsOver(_ view: NSView, margin: CGFloat = 0) -> Bool {
        guard let window = view.window, window.isVisible else { return false }
        let point = view.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        return view.bounds.insetBy(dx: -margin, dy: -margin).contains(point)
    }

    /// Leaving the badge is left to the watch, which allows for the move onto the card.
    private func issueHover(_ row: NativeMenuToggleRow, inside: Bool) {
        guard inside, let issue = row.issue else { return }
        issueRow = row
        issueAwayTicks = 0
        issueCard.show(issue)
        // Below the badge, or above it when the panel has no room below.
        let anchor = row.issueAnchor.convert(row.issueAnchor.bounds, to: root)
        let size = issueCard.frame.size
        let x = min(max(4, anchor.minX - 6), root.bounds.width - size.width - 4)
        let below = anchor.minY - 4 - size.height
        let y = below >= 4 ? below : min(anchor.maxY + 4, root.bounds.height - size.height - 4)
        issueCard.setFrameOrigin(NSPoint(x: x, y: y))
        if issueCard.superview !== root { root.addSubview(issueCard, positioned: .above, relativeTo: nil) }
        guard issueWatch == nil else { return }
        issueWatch = Timer.scheduledTimer(withTimeInterval: Self.issueWatchInterval, repeats: true) { [weak self] _ in
            self?.checkIssuePointer()
        }
    }

    private func checkIssuePointer() {
        guard let row = issueRow else { hideIssue(); return }
        let near = pointerIsOver(row.issueAnchor, margin: 3) || pointerIsOver(issueCard)
        issueAwayTicks = near ? 0 : issueAwayTicks + 1
        if issueAwayTicks >= Self.issueAwayLimit { hideIssue() }
    }

    private func hideIssue() {
        issueWatch?.invalidate()
        issueWatch = nil
        issueCard.removeFromSuperview()
        issueRow = nil
    }

    /// Runs a modal step (such as a confirmation alert) without the transient
    /// panel closing when the alert takes focus, then makes the panel key again.
    func holdingOpen<Result>(_ body: () -> Result) -> Result {
        guard popover.isShown else { return body() }
        popover.behavior = .applicationDefined
        defer {
            popover.behavior = .transient
            controller.view.window?.makeKey()
        }
        return body()
    }

    func toggle(relativeTo button: NSStatusBarButton) {
        if popover.isShown {
            closeReturningFocus()
        } else {
            show(relativeTo: button)
        }
    }

    func show(relativeTo button: NSStatusBarButton) {
        if !popover.isShown, button.window != nil {
            layoutRows()
            refreshHover()
            let frontmost = NSWorkspace.shared.frontmostApplication
            previousApplication = frontmost?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : frontmost
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            controller.view.window?.makeKey()
            refreshHover()
            if directoryList.superview != nil { directoryList.flashScrollers() }
        }
    }

    private func closeReturningFocus() {
        popover.performClose(nil)
        guard let previous = previousApplication, !previous.isTerminated, NSApp.modalWindow == nil else { return }
        previousApplication = nil
        previous.activate(options: [])
    }

    func update(menu: NSMenu) {
        self.menu = menu
        // Rows may move or change; a card left open could point at the wrong
        // one. It comes back below if the pointer is still on the same badge.
        let explained = issueRow?.actionItem.representedObject as? String
        let readingCard = issueCard.superview != nil && pointerIsOver(issueCard)
        hideIssue()
        defer {
            if let explained, let row = directoryRows[explained],
               readingCard || pointerIsOver(row.issueAnchor, margin: 3) {
                issueHover(row, inside: true)
            }
        }
        let oldOffset = scroll.contentView.bounds.origin
        rows.removeAll()
        content.subviews.forEach { $0.removeFromSuperview() }
        width = 296
        append(menu: menu, path: "", inset: 0)
        // Keep only rows still shown, so removed folders are released.
        let shown = Set(rows.compactMap { ($0.view as? NativeMenuToggleRow)?.actionItem.representedObject as? String })
        directoryRows = directoryRows.filter { shown.contains($0.key) }
        layoutRows()
        scroll.contentView.scroll(to: NSPoint(x: 0, y: min(oldOffset.y,
            max(0, content.frame.height - scroll.contentView.bounds.height))))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    private func append(menu: NSMenu, path: String, inset: CGFloat) {
        for item in menu.items where !item.isHidden {
            let key = path + "/" + item.title
            if item.isSeparatorItem {
                let separator = NSBox()
                separator.boxType = .separator
                separator.frame.size.height = 11
                rows.append((separator, inset + 4))
                continue
            }
            if let custom = item.view {
                // A row retains its action item. Detach the menu's ownership of
                // the row before embedding it here to avoid a retain cycle.
                item.view = nil
                var row = custom
                if let fresh = custom as? NativeMenuToggleRow,
                   let id = item.representedObject as? String {
                    if let existing = directoryRows[id] {
                        existing.update(item: item, color: fresh.currentColor)
                        existing.setSelecting(fresh.isSelecting, selected: fresh.isSelected, animated: true)
                        existing.issue = fresh.issue
                        existing.onFix = fresh.onFix
                        row = existing
                    } else {
                        directoryRows[id] = fresh
                    }
                    (row as? NativeMenuToggleRow)?.onIssueHover = { [weak self] row, inside in
                        self?.issueHover(row, inside: inside)
                    }
                    (row as? NativeMenuToggleRow)?.onSizeChange = { [weak self, weak row] in
                        self?.layoutRows()
                        if let row { self?.directoryList.reveal(row) }
                    }
                }
                width = max(width, min(496, row.frame.width + 16))
                rows.append((row, inset))
            } else if let submenu = item.submenu {
                let button = StatusCommandButton(item: item, expanded: expandedGroups.contains(key))
                button.onInvoke = { [weak self] in
                    guard let self else { return }
                    if self.expandedGroups.contains(key) { self.expandedGroups.remove(key) }
                    else { self.expandedGroups.insert(key) }
                    // Other custom rows were detached from their menu items.
                    // Render this same model without dropping those rows.
                    self.updateRetainingCustomRows()
                }
                rows.append((button, inset))
                if expandedGroups.contains(key) { append(menu: submenu, path: key, inset: inset + 12) }
            } else if item.action != nil {
                let button = StatusCommandButton(item: item)
                button.onInvoke = {
                    guard item.isEnabled, let action = item.action else { return }
                    NSApp.sendAction(action, to: item.target, from: item)
                }
                rows.append((button, inset))
            } else {
                // The first label titles the panel, as in system menu bar extras.
                // Later labels are status notes aligned with item titles.
                let isTitle = rows.isEmpty && path.isEmpty
                let label = NSTextField(wrappingLabelWithString: item.title)
                label.font = isTitle ? .systemFont(ofSize: 13, weight: .semibold) : .systemFont(ofSize: 12)
                label.textColor = isTitle ? .labelColor : .secondaryLabelColor
                label.toolTip = item.toolTip
                label.frame.size.height = 24
                rows.append((label, isTitle ? inset + 14 : inset + 36))
            }
        }
    }

    /// Clears highlights left from the last time the popover was open, then
    /// highlights whichever row is under the pointer now.
    private func refreshHover() {
        directoryRows.values.forEach { $0.refreshHover() }
        for case let button as StatusCommandButton in content.subviews { button.refreshHover() }
    }

    private func updateRetainingCustomRows() {
        guard let menu else { return }
        let customItems = rows.compactMap { row -> (NSMenuItem, NSView)? in
            if let toggle = row.view as? NativeMenuToggleRow {
                return (toggle.actionItem, toggle)
            }
            if let disclosure = row.view as? NativeMenuDisclosureRow {
                return (disclosure.actionItem, disclosure)
            }
            return nil
        }
        for (item, view) in customItems { item.view = view }
        update(menu: menu)
    }

    private func layoutRows() {
        var y: CGFloat = 8
        var index = 0
        var usesDirectoryList = false
        while index < rows.count {
            let row = rows[index]
            // More than four directories scroll inside their own list.
            var end = index
            while end < rows.count, rows[end].view is NativeMenuToggleRow { end += 1 }
            if end - index > StatusDirectoryList.visibleRows {
                let height = directoryList.layout(rows[index..<end].map(\.view), width: width - 16 - row.inset)
                directoryList.frame.origin = NSPoint(x: 8 + row.inset, y: y)
                if directoryList.superview !== content { content.addSubview(directoryList) }
                usesDirectoryList = true
                y += height
                index = end
                continue
            }
            var height = row.view.frame.height
            // Status notes wrap. Measure them at their real width so a long
            // message, such as how to recover the server, is never clipped.
            if let note = row.view as? NSTextField, let cell = note.cell, cell.wraps {
                let bounds = NSRect(x: 0, y: 0, width: width - 16 - row.inset, height: .greatestFiniteMagnitude)
                height = max(24, ceil(cell.cellSize(forBounds: bounds).height) + 6)
            }
            row.view.frame = NSRect(x: 8 + row.inset, y: y,
                                    width: width - 16 - row.inset, height: height)
            if row.view.superview !== content { content.addSubview(row.view) }
            y += height
            index += 1
        }
        if !usesDirectoryList { directoryList.removeFromSuperview() }
        let height = y + 8
        let maxHeight = min(650, (NSScreen.main?.visibleFrame.height ?? 800) - 64)
        let visibleHeight = min(height, maxHeight)
        content.frame = NSRect(x: 0, y: 0, width: width, height: height)
        root.frame.size = NSSize(width: width, height: visibleHeight)
        scroll.frame = root.bounds
        popover.contentSize = root.frame.size
    }
}
