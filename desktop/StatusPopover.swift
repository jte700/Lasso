import Cocoa

private final class StatusContentView: NSView {
    override var isFlipped: Bool { true }
}

private final class StatusCommandButton: NSButton {
    var onInvoke: (() -> Void)?

    init(item: NSMenuItem, expanded: Bool? = nil) {
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 28))
        title = item.title
        alignment = .left
        font = .menuFont(ofSize: 0)
        isBordered = false
        isEnabled = item.isEnabled
        keyEquivalent = item.keyEquivalent
        keyEquivalentModifierMask = item.keyEquivalentModifierMask
        if let expanded {
            image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right",
                            accessibilityDescription: nil)
        } else if item.state == .on {
            image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
        } else {
            image = item.image
        }
        imagePosition = .imageLeading
        imageHugsTitle = true
        toolTip = item.toolTip
        target = self
        action = #selector(invoke)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func invoke() { onInvoke?() }
}

/// An interactive status panel. Controls update in the same popover; AppKit
/// handles dismissal when the user clicks outside it.
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

    init() {
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
    }

    func toggle(relativeTo button: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(nil)
        } else if button.window != nil {
            layoutRows()
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            controller.view.window?.makeKey()
        }
    }

    func update(menu: NSMenu) {
        self.menu = menu
        let oldOffset = scroll.contentView.bounds.origin
        rows.removeAll()
        content.subviews.forEach { $0.removeFromSuperview() }
        width = 296
        append(menu: menu, path: "", inset: 0)
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
                separator.frame.size.height = 9
                rows.append((separator, inset))
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
                        row = existing
                    } else {
                        directoryRows[id] = fresh
                    }
                    (row as? NativeMenuToggleRow)?.onSizeChange = { [weak self] in self?.layoutRows() }
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
                rows.append((button, inset + 8))
                if expandedGroups.contains(key) { append(menu: submenu, path: key, inset: inset + 12) }
            } else if item.action != nil {
                let button = StatusCommandButton(item: item)
                button.onInvoke = {
                    guard item.isEnabled, let action = item.action else { return }
                    NSApp.sendAction(action, to: item.target, from: item)
                }
                rows.append((button, inset + 8))
            } else {
                let label = NSTextField(wrappingLabelWithString: item.title)
                label.font = .systemFont(ofSize: 12)
                label.textColor = .secondaryLabelColor
                label.toolTip = item.toolTip
                label.frame.size.height = item.title.count > 65 ? 42 : 26
                rows.append((label, inset + 14))
            }
        }
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
        for row in rows {
            let height = row.view.frame.height
            row.view.frame = NSRect(x: 8 + row.inset, y: y,
                                    width: width - 16 - row.inset, height: height)
            if row.view.superview !== content { content.addSubview(row.view) }
            y += height
        }
        let height = y + 8
        let maxHeight = min(650, (NSScreen.main?.visibleFrame.height ?? 800) - 64)
        let visibleHeight = min(height, maxHeight)
        content.frame = NSRect(x: 0, y: 0, width: width, height: height)
        root.frame.size = NSSize(width: width, height: visibleHeight)
        scroll.frame = root.bounds
        popover.contentSize = root.frame.size
    }
}
