// The top of the status panel, laid out like a Control Center module: Lasso's
// name, a line saying how it is doing, and the switch for Suggest While
// Typing on the right. While a request no folder reports is running, such as
// a removal, a bar under the line shows Lasso is busy.

import Cocoa

final class StatusHeaderRow: NSView {
    /// The Suggest While Typing item: its action, whether it is on, and whether it can change.
    let actionItem: NSMenuItem
    let isBusy: Bool
    private let titleLabel = NSTextField(labelWithString: "")
    private let subtitleLabel = NSTextField(wrappingLabelWithString: "")
    private let toggle = NSSwitch()
    private let progress = DirectoryProgressBar()

    private static let inset: CGFloat = 14
    private static let switchGap: CGFloat = 10
    private static let titleHeight: CGFloat = 18
    /// Wide enough for the panel's narrowest width, so a long line wraps and is measured.
    static let nominalWidth: CGFloat = 280
    private static let progressHeight: CGFloat = 9

    override var isFlipped: Bool { true }

    init(item: NSMenuItem, title: String, subtitle: String, busy: Bool) {
        actionItem = item
        isBusy = busy
        super.init(frame: NSRect(x: 0, y: 0, width: Self.nominalWidth, height: 44))
        autoresizingMask = [.width]
        titleLabel.stringValue = title
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.autoresizingMask = [.width]
        addSubview(titleLabel)
        subtitleLabel.stringValue = subtitle
        subtitleLabel.font = .systemFont(ofSize: 11)
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.isSelectable = false
        subtitleLabel.maximumNumberOfLines = 2
        subtitleLabel.autoresizingMask = [.width]
        subtitleLabel.toolTip = subtitle
        addSubview(subtitleLabel)
        toggle.controlSize = .regular
        toggle.state = item.state == .on ? .on : .off
        toggle.isEnabled = item.isEnabled
        toggle.target = self
        toggle.action = #selector(flip)
        toggle.toolTip = item.toolTip
        toggle.setAccessibilityLabel(item.title)
        toggle.autoresizingMask = [.minXMargin]
        addSubview(toggle)
        progress.indeterminate = true
        progress.accent = .controlAccentColor
        progress.isHidden = !busy
        progress.autoresizingMask = [.width]
        progress.setAccessibilityLabel(subtitle)
        addSubview(progress)
        layOut(width: Self.nominalWidth)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Places the pieces for a width and takes the height they need.
    private func layOut(width: CGFloat) {
        toggle.sizeToFit()
        let switchSize = toggle.frame.size
        let textWidth = width - Self.inset * 2 - switchSize.width - Self.switchGap
        titleLabel.frame = NSRect(x: Self.inset, y: 6, width: textWidth, height: Self.titleHeight)
        subtitleLabel.preferredMaxLayoutWidth = textWidth
        let subtitleHeight = ceil(subtitleLabel.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: textWidth,
            height: .greatestFiniteMagnitude)).height ?? 14)
        subtitleLabel.frame = NSRect(x: Self.inset, y: titleLabel.frame.maxY, width: textWidth, height: subtitleHeight)
        var height = subtitleLabel.frame.maxY + 6
        if isBusy {
            progress.frame = NSRect(x: Self.inset, y: height + 2, width: width - Self.inset * 2, height: Self.progressHeight)
            height = progress.frame.maxY + 8
        }
        toggle.frame = NSRect(x: width - Self.inset - switchSize.width, y: 8,
                              width: switchSize.width, height: switchSize.height)
        setFrameSize(NSSize(width: width, height: height))
    }

    @objc private func flip() {
        guard actionItem.isEnabled, let action = actionItem.action else { return }
        NSApp.sendAction(action, to: actionItem.target, from: actionItem)
    }
}
