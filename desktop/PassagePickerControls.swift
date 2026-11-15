// The passage picker's controls. The picker never takes the keyboard, so
// AppKit would draw its buttons and switch as in an inactive window: Insert
// would look disabled and the switch off. These draw as active controls do:
// the card's own pill buttons, and a switch in the system's shape.

import Cocoa

/// A pill button as the suggestion card draws them: Insert a white pill with
/// the Tab symbol, Insert Link a grey pill with the link symbol.
final class PassagePillButton: NSControl {
    private let title: String
    private let symbol: String
    private let style: AssistPill.Style
    /// A key's mark ("⇥") drawn in place of the symbol.
    var glyph: String?
    private var pressed = false { didSet { needsDisplay = true } }
    override var isEnabled: Bool { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }

    init(title: String, symbol: String, style: AssistPill.Style) {
        self.title = title
        self.symbol = symbol
        self.style = style
        super.init(frame: .zero)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize { NSSize(width: AssistPill.width(title, style: style), height: AssistPill.height) }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.current?.saveGraphicsState()
        // Dimmed until something is highlighted; darker while pressed.
        let fraction: CGFloat = !isEnabled ? 0.4 : pressed ? 0.7 : 1
        if fraction < 1 { NSGraphicsContext.current?.cgContext.setAlpha(fraction) }
        AssistPill.draw(title, symbol: symbol, in: bounds.insetBy(dx: 2, dy: 0), style: style, glyph: glyph)
        NSGraphicsContext.current?.restoreGraphicsState()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled, let window else { return }
        pressed = true
        var inside = true
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            inside = bounds.contains(convert(next.locationInWindow, from: nil))
            if next.type == .leftMouseUp { break }
            pressed = inside
        }
        pressed = false
        if inside, let action { NSApp.sendAction(action, to: target, from: self) }
    }

    override func accessibilityPerformPress() -> Bool {
        guard isEnabled, let action else { return false }
        return NSApp.sendAction(action, to: target, from: self)
    }
}

/// An on/off switch drawn as the system's, in the accent colour when on.
final class PassageToggle: NSControl {
    var isOn = false { didSet { needsDisplay = true; setAccessibilityValue(isOn) } }

    override var intrinsicContentSize: NSSize { NSSize(width: 38, height: 22) }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityRole(.checkBox)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let track = bounds.insetBy(dx: 1, dy: 1)
        (isOn ? NSColor.controlAccentColor : NSColor.quaternaryLabelColor.withAlphaComponent(0.6)).setFill()
        NSBezierPath(roundedRect: track, xRadius: track.height / 2, yRadius: track.height / 2).fill()
        let diameter = track.height - 4
        let knob = NSRect(x: isOn ? track.maxX - diameter - 2 : track.minX + 2, y: track.minY + 2, width: diameter, height: diameter)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.25)
        shadow.shadowBlurRadius = 2
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        shadow.set()
        NSColor.white.setFill()
        NSBezierPath(ovalIn: knob).fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// Turns over when the click is let go on it, as the system's switch does.
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        var inside = true
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            inside = bounds.contains(convert(next.locationInWindow, from: nil))
            if next.type == .leftMouseUp { break }
        }
        guard inside else { return }
        isOn.toggle()
        if let action { NSApp.sendAction(action, to: target, from: self) }
    }

    override func accessibilityPerformPress() -> Bool {
        isOn.toggle()
        if let action { NSApp.sendAction(action, to: target, from: self) }
        return true
    }
}

/// The picker's small controls, as the system draws them: Liquid Glass on macOS 26.
enum PassagePickerControls {
    static func circleButton(symbol: String, label: String) -> NSButton {
        let button = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage(),
                              target: nil, action: nil)
        button.toolTip = label
        if #available(macOS 26.0, *) {
            button.bezelStyle = .glass
            button.borderShape = .circle
        } else {
            button.bezelStyle = .circular
            button.isBordered = false
            button.contentTintColor = .secondaryLabelColor
        }
        return button
    }
}
