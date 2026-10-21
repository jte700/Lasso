// The Shortcuts pane of Settings: every keyboard shortcut Lasso has on the
// Mac, grouped by where it works, with the keys right-aligned as in a menu.

import Cocoa

/// Takes focus when the pane opens, so the arrow keys, Page Up and Page Down,
/// Home, End and Space scroll the list without a trackpad.
final class ShortcutsDocumentView: NSView {
    private static let lineStep: CGFloat = 24

    // Rows start at the top, so the list opens scrolled to its first section.
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        // Space pages down and Shift-Space pages up, as in a web page.
        guard event.charactersIgnoringModifiers == " " else { interpretKeyEvents([event]); return }
        scroll(by: event.modifierFlags.contains(.shift) ? -pageStep : pageStep)
    }
    override func moveUp(_ sender: Any?) { scroll(by: -Self.lineStep) }
    override func moveDown(_ sender: Any?) { scroll(by: Self.lineStep) }
    override func scrollPageUp(_ sender: Any?) { scroll(by: -pageStep) }
    override func scrollPageDown(_ sender: Any?) { scroll(by: pageStep) }
    override func scrollToBeginningOfDocument(_ sender: Any?) { scrollTo(0) }
    override func scrollToEndOfDocument(_ sender: Any?) { scrollTo(bounds.height) }

    /// A page keeps one line of the previous page in view.
    private var pageStep: CGFloat { max(Self.lineStep, visibleRect.height - Self.lineStep) }

    private func scroll(by delta: CGFloat) { scrollTo(visibleRect.minY + delta) }

    private func scrollTo(_ y: CGFloat) {
        guard let scrollView = enclosingScrollView else { return }
        let clip = scrollView.contentView
        let top = min(max(0, y), max(0, bounds.height - clip.bounds.height))
        clip.scroll(to: NSPoint(x: clip.bounds.minX, y: top))
        scrollView.reflectScrolledClipView(clip)
    }
}

/// The pane, with the list that takes focus when it is shown.
final class ShortcutsPaneView: NSView {
    let list: ShortcutsDocumentView

    init(list: ShortcutsDocumentView) {
        self.list = list
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

enum ShortcutsPane {
    /// Taller lists scroll rather than stretch the window past most screens.
    private static let maxHeight: CGFloat = 460
    private static let inset: CGFloat = 20
    private static let keysColumnWidth: CGFloat = 72
    private static let columnSpacing: CGFloat = 12

    static func makeView(width: CGFloat) -> ShortcutsPaneView {
        let rowWidth = width - 2 * inset
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        for view in sectionViews(rowWidth: rowWidth) { stack.addArrangedSubview(view) }

        let document = ShortcutsDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: inset),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: inset),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -inset),
        ])
        let height = min(stack.fittingSize.height + 2 * inset, maxHeight)

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = document
        let content = ShortcutsPaneView(list: document)
        content.addSubview(scroll)
        NSLayoutConstraint.activate([
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            scroll.topAnchor.constraint(equalTo: content.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            scroll.heightAnchor.constraint(equalToConstant: height),
            content.widthAnchor.constraint(equalToConstant: width),
        ])
        return content
    }

    private static func sectionViews(rowWidth: CGFloat) -> [NSView] {
        do {
            return try ShortcutCatalog.loadBundled().macSections.map { sectionView($0, rowWidth: rowWidth) }
        } catch {
            NSLog("Lasso could not read its keyboard shortcuts: %@", error.localizedDescription)
            return [note("Lasso couldn\u{2019}t read its list of keyboard shortcuts. Installing Lasso again restores it.",
                         width: rowWidth)]
        }
    }

    private static func sectionView(_ section: ShortcutCatalog.MacSection, rowWidth: CGFloat) -> NSView {
        let title = NSTextField(labelWithString: section.title)
        title.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
        let grid = NSGridView(views: section.rows.map { [actionLabel($0.action), keysLabel($0.keys)] })
        grid.rowSpacing = 7
        grid.columnSpacing = columnSpacing
        grid.rowAlignment = .firstBaseline
        grid.column(at: 0).width = rowWidth - keysColumnWidth - columnSpacing
        grid.column(at: 1).width = keysColumnWidth
        grid.column(at: 1).xPlacement = .trailing

        let views: [NSView] = [title] + (section.note.map { [note($0, width: rowWidth)] } ?? []) + [grid]
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.setCustomSpacing(10, after: views[views.count - 2])
        return stack
    }

    private static func actionLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.lineBreakMode = .byTruncatingTail
        label.toolTip = text
        return label
    }

    private static func keysLabel(_ keys: String) -> NSTextField {
        let label = NSTextField(labelWithString: keys)
        label.textColor = .secondaryLabelColor
        label.alignment = .right
        label.setAccessibilityLabel(ShortcutCatalog.spokenKeys(keys))
        return label
    }

    private static func note(_ text: String, width: CGFloat) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        label.textColor = .secondaryLabelColor
        label.preferredMaxLayoutWidth = width
        label.widthAnchor.constraint(equalToConstant: width).isActive = true
        return label
    }
}
