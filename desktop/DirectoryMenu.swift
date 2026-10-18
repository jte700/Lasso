import Cocoa

/// Draws its tint directly, so an enabled menu switch stays colored even when
/// its menu window is inactive. NSButton supplies state, keyboard and AX actions.
final class DirectoryTintSwitch: NSButton {
    var tint: DirectoryToggleColor = .blue { didSet { needsDisplay = true } }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 40, height: 24))
        setButtonType(.switch)
        allowsMixedState = false
        isBordered = false
        title = ""
        setAccessibilityRole(.checkBox)
        setAccessibilitySubrole(.switch)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        // Proportions follow the small system switch: a capsule track with a
        // round white knob that carries a soft shadow and hairline edge.
        let track = NSRect(x: (bounds.width - 30) / 2, y: (bounds.height - 17) / 2,
                           width: 30, height: 17)
        let opacity: CGFloat = isEnabled ? 1 : 0.45
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let offColor = dark ? NSColor(white: 1, alpha: 0.16) : NSColor(white: 0, alpha: 0.1)
        (state == .on ? tint.color : offColor).withAlphaComponent((state == .on ? 1 : offColor.alphaComponent) * opacity).setFill()
        NSBezierPath(roundedRect: track, xRadius: track.height / 2, yRadius: track.height / 2).fill()
        let knob = NSRect(x: state == .on ? track.maxX - 16 : track.minX + 1,
                          y: track.minY + 1, width: 15, height: 15)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.25 * opacity)
        shadow.shadowBlurRadius = 1.5
        shadow.shadowOffset = NSSize(width: 0, height: -0.5)
        shadow.set()
        NSColor.white.withAlphaComponent(dark && state != .on ? 0.85 * opacity : opacity).setFill()
        NSBezierPath(ovalIn: knob).fill()
        NSGraphicsContext.restoreGraphicsState()
        NSColor.black.withAlphaComponent(0.08 * opacity).setStroke()
        let edge = NSBezierPath(ovalIn: knob.insetBy(dx: 0.25, dy: 0.25))
        edge.lineWidth = 0.5
        edge.stroke()
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            let ring = NSBezierPath(roundedRect: track.insetBy(dx: -2.5, dy: -2.5), xRadius: 11, yRadius: 11)
            ring.lineWidth = 2.5
            ring.stroke()
        }
    }
}

final class DirectoryColorButton: NSButton {
    var tint: DirectoryToggleColor {
        didSet {
            needsDisplay = true
            refreshAccessibilityValue()
        }
    }
    var selected = false {
        didSet {
            needsDisplay = true
            refreshAccessibilityValue()
        }
    }
    var onPick: (() -> Void)?

    init(color: DirectoryToggleColor, label: String) {
        tint = color
        super.init(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
        isBordered = false
        title = ""
        setAccessibilityLabel(label)
        setAccessibilityValue(color.title)
        target = self
        action = #selector(pick)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let circle = NSRect(x: (bounds.width - 10) / 2, y: (bounds.height - 10) / 2,
                            width: 10, height: 10)
        tint.color.withAlphaComponent(isEnabled ? 1 : 0.45).setFill()
        NSBezierPath(ovalIn: circle).fill()
        if selected || window?.firstResponder === self {
            NSColor.labelColor.withAlphaComponent(0.65).setStroke()
            let ring = NSBezierPath(ovalIn: circle.insetBy(dx: -2.5, dy: -2.5))
            ring.lineWidth = 1
            ring.stroke()
        }
    }

    @objc private func pick() { onPick?() }

    private func refreshAccessibilityValue() {
        setAccessibilityValue(selected ? "\(tint.title), selected" : tint.title)
    }
}

private func dispatchMenuAction(_ item: NSMenuItem) {
    guard item.isEnabled, let action = item.action else { return }
    NSApp.sendAction(action, to: item.target, from: item)
}

final class NativeMenuToggleRow: NSView {
    private var item: NSMenuItem
    private let titleLabel: NSTextField
    private var icon: NSImageView?
    private let toggle = DirectoryTintSwitch()
    private let colorButton: DirectoryColorButton
    private let onColorChange: (DirectoryToggleColor) -> Void
    private var palette: DirectoryColorPaletteRow?
    private(set) var isPaletteVisible = false
    var currentColor: DirectoryToggleColor { toggle.tint }
    var actionItem: NSMenuItem { item }
    var onSizeChange: (() -> Void)?
    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }

    override var isFlipped: Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: NSRect(x: 0, y: 0, width: bounds.width, height: 32),
            options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { hovering = item.isEnabled }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func draw(_ dirtyRect: NSRect) {
        guard hovering else { return }
        NSColor.labelColor.withAlphaComponent(0.1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 4, y: 2, width: bounds.width - 8, height: 28),
                     xRadius: 5, yRadius: 5).fill()
    }

    init(item: NSMenuItem, color: DirectoryToggleColor,
         onColorChange: @escaping (DirectoryToggleColor) -> Void) {
        self.item = item
        colorButton = DirectoryColorButton(color: color, label: "Highlight color for \(item.title)")
        self.onColorChange = onColorChange
        titleLabel = NSTextField(labelWithString: item.title)
        let title = titleLabel
        title.font = .menuFont(ofSize: 0)
        title.textColor = item.isEnabled ? .labelColor : .disabledControlTextColor
        title.lineBreakMode = .byTruncatingMiddle
        title.setAccessibilityElement(false)
        title.sizeToFit()
        toggle.tint = color
        toggle.state = item.state
        toggle.isEnabled = item.isEnabled
        toggle.setAccessibilityLabel(item.title)
        toggle.setAccessibilityHelp(item.toolTip)
        colorButton.isEnabled = item.isEnabled
        colorButton.toolTip = "Highlight color for text inserted from this folder"

        let iconWidth: CGFloat = item.image == nil ? 0 : 22
        let width = min(480, max(260, 14 + iconWidth + title.frame.width + 18 + 24 + 8 + 40 + 12))
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: 32))
        autoresizingMask = [.width]
        toolTip = item.toolTip
        setAccessibilityElement(false)
        if let image = item.image {
            let icon = NSImageView(frame: NSRect(x: 14, y: 8, width: 16, height: 16))
            self.icon = icon
            icon.image = image
            icon.contentTintColor = item.isEnabled ? .secondaryLabelColor : .disabledControlTextColor
            icon.setAccessibilityElement(false)
            addSubview(icon)
        }
        title.frame = NSRect(x: 14 + iconWidth, y: (32 - title.frame.height) / 2,
                             width: width - 14 - iconWidth - 18 - 24 - 8 - 40 - 12,
                             height: title.frame.height)
        title.autoresizingMask = [.width]
        addSubview(title)
        toggle.setFrameOrigin(NSPoint(x: width - 12 - 40, y: 4))
        toggle.autoresizingMask = [.minXMargin]
        toggle.target = self
        toggle.action = #selector(activate)
        addSubview(toggle)
        colorButton.setFrameOrigin(NSPoint(x: toggle.frame.minX - 8 - 24, y: 4))
        colorButton.autoresizingMask = [.minXMargin]
        colorButton.onPick = { [weak self] in
            guard let self, self.item.isEnabled else { return }
            self.setPaletteVisible(!self.isPaletteVisible)
        }
        addSubview(colorButton)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(item: NSMenuItem, color: DirectoryToggleColor) {
        self.item = item
        titleLabel.stringValue = item.title
        titleLabel.textColor = item.isEnabled ? .labelColor : .disabledControlTextColor
        icon?.image = item.image
        icon?.contentTintColor = item.isEnabled ? .secondaryLabelColor : .disabledControlTextColor
        toggle.state = item.state
        toggle.tint = color
        toggle.isEnabled = item.isEnabled
        toggle.setAccessibilityLabel(item.title)
        toggle.setAccessibilityHelp(item.toolTip)
        colorButton.tint = color
        colorButton.isEnabled = item.isEnabled
        colorButton.setAccessibilityLabel("Highlight color for \(item.title)")
        palette?.update(selected: color, isEnabled: item.isEnabled)
        toolTip = item.toolTip
    }

    func setPaletteVisible(_ visible: Bool) {
        guard visible != isPaletteVisible else { return }
        isPaletteVisible = visible
        if visible {
            let palette = DirectoryColorPaletteRow(selected: toggle.tint) { [weak self] color in
                guard let self, self.item.isEnabled else { return }
                self.toggle.tint = color
                self.colorButton.tint = color
                self.palette?.update(selected: color, isEnabled: self.item.isEnabled)
                self.onColorChange(color)
            }
            palette.frame = NSRect(x: 0, y: 32, width: frame.width, height: 32)
            palette.autoresizingMask = [.width]
            palette.update(selected: toggle.tint, isEnabled: item.isEnabled)
            self.palette = palette
            addSubview(palette)
        } else {
            palette?.removeFromSuperview()
            palette = nil
        }
        setFrameSize(NSSize(width: frame.width, height: visible ? 64 : 32))
        onSizeChange?()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let hit = super.hitTest(point) else { return nil }
        if hit === toggle || hit.isDescendant(of: toggle)
            || hit === colorButton || hit.isDescendant(of: colorButton) { return hit }
        if let palette, hit === palette || hit.isDescendant(of: palette) { return hit }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        guard item.isEnabled else { return }
        toggle.performClick(nil)
    }

    @objc private func activate() {
        dispatchMenuAction(item)
    }
}

final class DirectoryColorPaletteRow: NSView {
    private var buttons: [DirectoryColorButton] = []

    init(selected: DirectoryToggleColor, onPick: @escaping (DirectoryToggleColor) -> Void) {
        super.init(frame: NSRect(x: 0, y: 0, width: CGFloat(DirectoryToggleColor.allCases.count) * 28 + 16, height: 32))
        setAccessibilityElement(false)
        for (index, color) in DirectoryToggleColor.allCases.enumerated() {
            let button = DirectoryColorButton(color: color, label: "Use \(color.title)")
            button.selected = color == selected
            button.setFrameOrigin(NSPoint(x: 8 + CGFloat(index) * 28, y: 4))
            button.onPick = { [weak self] in
                self?.update(selected: color, isEnabled: true)
                onPick(color)
            }
            buttons.append(button)
            addSubview(button)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(selected: DirectoryToggleColor, isEnabled: Bool) {
        for button in buttons {
            button.selected = button.tint == selected
            button.isEnabled = isEnabled
        }
    }
}

final class NativeMenuDisclosureRow: NSView {
    private var item: NSMenuItem
    var actionItem: NSMenuItem { item }
    private let button: NSButton
    private let total: NSTextField

    init(item: NSMenuItem, expanded: Bool, count: Int) {
        self.item = item
        button = NSButton(title: item.title, target: nil, action: nil)
        total = NSTextField(labelWithString: String(count))
        super.init(frame: NSRect(x: 0, y: 0, width: 260, height: 28))
        autoresizingMask = [.width]
        button.target = self
        button.action = #selector(activate)
        button.frame = NSRect(x: 12, y: 3, width: 206, height: 22)
        button.autoresizingMask = [.width]
        button.isBordered = false
        button.alignment = .left
        button.attributedTitle = NSAttributedString(string: item.title, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.secondaryLabelColor])
        button.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right",
                               accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .bold))
        button.imagePosition = .imageLeading
        button.imageHugsTitle = true
        button.contentTintColor = .secondaryLabelColor
        button.setAccessibilityLabel("\(expanded ? "Collapse" : "Expand") \(item.title)")
        addSubview(button)
        total.font = .systemFont(ofSize: 11)
        total.textColor = .tertiaryLabelColor
        total.alignment = .right
        total.frame = NSRect(x: 224, y: 7, width: 22, height: 14)
        total.autoresizingMask = [.minXMargin]
        total.setAccessibilityElement(false)
        addSubview(total)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(item: NSMenuItem, expanded: Bool, count: Int) {
        self.item = item
        button.attributedTitle = NSAttributedString(string: item.title, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.secondaryLabelColor])
        button.isEnabled = item.isEnabled
        button.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right",
                               accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .bold))
        button.setAccessibilityLabel("\(expanded ? "Collapse" : "Expand") \(item.title)")
        total.stringValue = String(count)
    }

    override func mouseDown(with event: NSEvent) { activate() }

    @objc private func activate() {
        dispatchMenuAction(item)
    }
}
