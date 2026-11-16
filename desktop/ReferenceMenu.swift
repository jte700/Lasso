//  The menu a linked phrase opens when clicked: Inspect Source, which opens the
//  Source Inspector, and Change Source, which turns the menu into the sources
//  the suggestion card offered when the words were written, to choose another.
//
//  It drops from under the phrase, growing from its top edge as it fades in;
//  between its pages the rows cross-fade while the glass springs to the new
//  height, and a choice fades it away. It takes clicks without taking focus,
//  so the writer's app keeps the caret throughout.

import Cocoa
import QuartzCore

struct ReferenceMenuRow: Equatable {
    enum Icon: Equatable {
        /// The type icon of the file at this path.
        case file(String)
        case symbol(String)
    }

    let icon: Icon
    let title: String
    /// A small capsule after the title naming the kind of file.
    var tag: String? = nil
    let subtitle: String
    var enabled = true
    /// The source the words have now, ticked.
    var current = false
}

extension ReferenceMenuRow {
    /// The first page: what can be done with the phrase.
    static func actions(for reference: DependencyReference) -> [ReferenceMenuRow] {
        let others = reference.otherAlternatives.count
        let change: String
        if reference.shareToken != nil {
            change = "A share link keeps the source it was made for"
        } else if reference.alternatives == nil {
            change = "Lasso didn\u{2019}t keep the other suggestions for these words"
        } else if others == 0 {
            change = "No other source was suggested for these words"
        } else {
            change = others == 1 ? "1 other source suggested for these words"
                : "\(others) other sources suggested for these words"
        }
        return [
            ReferenceMenuRow(icon: .file(reference.sourcePath), title: "Inspect Source",
                             tag: ReferenceSourceType.name(forPath: reference.sourcePath),
                             subtitle: ReferenceSourceType.caption(path: reference.sourcePath,
                                                                   location: reference.sourceLocation)),
            ReferenceMenuRow(icon: .symbol("arrow.triangle.2.circlepath"), title: "Change Source",
                             subtitle: change, enabled: others > 0),
        ]
    }

    /// The second page: every source offered, the one in use first and marked.
    static func sources(for reference: DependencyReference) -> [ReferenceMenuRow] {
        let current = reference.currentAlternativeIndex
        return (reference.alternatives ?? []).enumerated().map { index, alternative in
            ReferenceMenuRow(icon: .file(alternative.path), title: alternative.text,
                             tag: ReferenceSourceType.name(forPath: alternative.path),
                             subtitle: ReferenceSourceType.caption(path: alternative.path, location: alternative.location),
                             current: index == current)
        }
    }
}

final class ReferenceMenuController {
    static let shared = ReferenceMenuController()

    enum Metric {
        static let width: CGFloat = 300
        static let rowHeight: CGFloat = 50
        static let inset: CGFloat = 6
        static let cornerRadius: CGFloat = 16
        /// The gap between the phrase's line and the menu.
        static let gap: CGFloat = 6
        static let shadowMargin: CGFloat = 0
    }

    private enum Page { case actions, sources }

    /// The phrase whose menu is open.
    private(set) var referenceId: String?
    private var reference: DependencyReference?
    private var page = Page.actions
    private var panel: ReferenceMenuPanel?
    private var root: NSView?
    private var rowsView: ReferenceMenuRowsView?
    private var opensUpward = false
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []
    private var onInspect: (() -> Void)?
    private var onChoose: ((ReferenceAlternative) -> Void)?
    private var onClose: (() -> Void)?
    private var generation = 0

    var isShown: Bool { referenceId != nil }

    /// Opens the menu under `line`, the phrase's line the click landed on, in
    /// screen coordinates.
    func show(_ reference: DependencyReference, below line: CGRect,
              onInspect: @escaping () -> Void, onChoose: @escaping (ReferenceAlternative) -> Void,
              onClose: @escaping () -> Void) {
        if isShown { hide(animated: false) }
        generation += 1
        self.reference = reference
        referenceId = reference.id
        self.onInspect = onInspect
        self.onChoose = onChoose
        self.onClose = onClose
        page = .actions
        let panel = self.panel ?? makePanel()
        let rows = ReferenceMenuRow.actions(for: reference)
        rowsView?.rows = rows
        rowsView?.alphaValue = 1
        let size = Self.size(rows: rows.count)
        let frame = place(size: size, below: line)
        panel.setFrame(frame, display: false)
        panel.invalidateShadow()
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        startMonitoring()

        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
        guard !reduce, let layer = root?.layer else { return }
        let grow = CASpringAnimation(keyPath: "transform")
        grow.fromValue = NSValue(caTransform3D: Self.drop(size: size, scale: 0.94, rise: opensUpward ? -6 : 6,
                                                         fromTop: !opensUpward))
        grow.toValue = NSValue(caTransform3D: CATransform3DIdentity)
        grow.mass = 1
        grow.stiffness = 420
        grow.damping = 30
        grow.initialVelocity = 0
        grow.duration = grow.settlingDuration
        layer.add(grow, forKey: "drop")
    }

    func hide(animated: Bool = true) {
        guard isShown else { return }
        let closed = onClose
        referenceId = nil
        reference = nil
        onInspect = nil
        onChoose = nil
        onClose = nil
        stopMonitoring()
        generation += 1
        let token = generation
        closed?()
        guard let panel else { return }
        guard animated, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            panel.orderOut(nil)
            return
        }
        if let layer = root?.layer {
            let shrink = CABasicAnimation(keyPath: "transform")
            shrink.fromValue = NSValue(caTransform3D: CATransform3DIdentity)
            shrink.toValue = NSValue(caTransform3D: Self.drop(size: panel.frame.size, scale: 0.97, rise: 0,
                                                             fromTop: !opensUpward))
            shrink.duration = 0.14
            shrink.timingFunction = CAMediaTimingFunction(name: .easeIn)
            shrink.fillMode = .forwards
            shrink.isRemovedOnCompletion = false
            layer.add(shrink, forKey: "drop")
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.14
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, token == self.generation else { return }
            panel.orderOut(nil)
            self.root?.layer?.removeAnimation(forKey: "drop")
        })
    }

    // MARK: Choosing

    private func choose(_ index: Int) {
        guard let reference else { return }
        switch page {
        case .actions:
            if index == 0 {
                let inspect = onInspect
                hide()
                inspect?()
            } else if !reference.otherAlternatives.isEmpty {
                turn(to: .sources)
            }
        case .sources:
            guard let alternatives = reference.alternatives, alternatives.indices.contains(index) else { return }
            let choose = onChoose
            hide()
            if index != reference.currentAlternativeIndex { choose?(alternatives[index]) }
        }
    }

    /// The rows cross-fade while the glass springs to the new page's height,
    /// keeping its edge by the phrase where it is.
    private func turn(to next: Page) {
        guard let reference, let panel, let rowsView else { return }
        page = next
        let rows = next == .sources ? ReferenceMenuRow.sources(for: reference) : ReferenceMenuRow.actions(for: reference)
        let size = Self.size(rows: rows.count)
        var frame = panel.frame
        if !opensUpward { frame.origin.y = frame.maxY - size.height }
        frame.size = size
        if let screen = (panel.screen ?? NSScreen.main)?.visibleFrame, frame.minY < screen.minY {
            frame.origin.y = screen.minY
        }
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let token = generation
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = reduce ? 0.05 : 0.09
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            rowsView.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, token == self.generation else { return }
            rowsView.rows = rows
            rowsView.hovered = nil
            NSAnimationContext.runAnimationGroup { context in
                context.duration = reduce ? 0.1 : 0.26
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
                context.allowsImplicitAnimation = true
                panel.animator().setFrame(frame, display: true)
                rowsView.animator().alphaValue = 1
            }
            panel.invalidateShadow()
        })
    }

    // MARK: Window

    static func size(rows: Int) -> CGSize {
        CGSize(width: Metric.width, height: CGFloat(max(1, rows)) * Metric.rowHeight + Metric.inset * 2)
    }

    /// Under the phrase's line with its left edge near the words', or above
    /// the line when the screen has no room below.
    private func place(size: CGSize, below line: CGRect) -> CGRect {
        let screen = (NSScreen.screens.first { $0.frame.intersects(line) } ?? NSScreen.main)?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        var x = line.minX - 14
        var y = line.minY - Metric.gap - size.height
        opensUpward = false
        // The sources page can be taller, so leave room for it below.
        let room = Self.size(rows: ReferenceAlternative.limit).height
        if line.minY - Metric.gap - room < screen.minY, screen.maxY - line.maxY > line.minY - screen.minY {
            y = line.maxY + Metric.gap
            opensUpward = true
        }
        x = min(max(screen.minX + 4, x), screen.maxX - size.width - 4)
        y = min(max(screen.minY + 4, y), screen.maxY - size.height - 4)
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }

    /// A scale about the menu's edge nearest the phrase, and a small slide toward it.
    private static func drop(size: CGSize, scale: CGFloat, rise: CGFloat, fromTop: Bool) -> CATransform3D {
        let anchor = CGPoint(x: size.width / 2, y: fromTop ? size.height : 0)
        let transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                          tx: anchor.x * (1 - scale), ty: anchor.y * (1 - scale) + rise)
        return CATransform3DMakeAffineTransform(transform)
    }

    private func makePanel() -> ReferenceMenuPanel {
        let size = Self.size(rows: 2)
        let panel = ReferenceMenuPanel(contentRect: CGRect(origin: .zero, size: size),
                                       styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let root = NSView(frame: CGRect(origin: .zero, size: size))
        root.wantsLayer = true
        root.autoresizingMask = [.width, .height]
        let rows = ReferenceMenuRowsView(frame: CGRect(origin: .zero, size: size))
        rows.autoresizingMask = [.width, .height]
        rows.onChoose = { [weak self] index in self?.choose(index) }
        let surface = NativeMaterial.glassContainer(content: rows, cornerRadius: Metric.cornerRadius)
        surface.frame = root.bounds
        surface.autoresizingMask = [.width, .height]
        if !NativeMaterial.usesGlass {
            surface.wantsLayer = true
            surface.layer?.borderWidth = 0.5
            surface.layer?.borderColor = NSColor.separatorColor.cgColor
        }
        root.addSubview(surface)
        panel.contentView = root
        self.panel = panel
        self.root = root
        rowsView = rows
        return panel
    }

    // MARK: Closing

    private func startMonitoring() {
        stopMonitoring()
        if let keys = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            // Escape closes it; typing goes on in the host and closes it too.
            DispatchQueue.main.async { if event.keyCode == 53 || !event.modifierFlags.contains(.command) { self?.hide() } }
        }) { monitors.append(keys) }
        if let scroll = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel], handler: { [weak self] _ in
            DispatchQueue.main.async { self?.hide() }
        }) { monitors.append(scroll) }
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                self?.hide()
            })
    }

    private func stopMonitoring() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors = []
        observers.forEach(NSWorkspace.shared.notificationCenter.removeObserver)
        observers = []
    }
}

/// Takes clicks without becoming key, so the host keeps its caret.
final class ReferenceMenuPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing: NSWindow.BackingStoreType,
                  defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .popUpMenu
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        animationBehavior = .none
        setAccessibilityRole(.menu)
    }
}

/// The rows, drawn as the video's menu draws them: an icon, a title with its
/// small capsule, a line beneath, and a soft highlight under the pointer.
final class ReferenceMenuRowsView: NSView {
    var rows: [ReferenceMenuRow] = [] { didSet { if rows != oldValue { needsDisplay = true; updateAccessibility() } } }
    var hovered: Int? { didSet { if hovered != oldValue { needsDisplay = true } } }
    private var pressed: Int?
    var onChoose: ((Int) -> Void)?

    typealias Metric = ReferenceMenuController.Metric

    override var isFlipped: Bool { true }
    override var allowsVibrancy: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func rowRect(_ index: Int) -> CGRect {
        CGRect(x: Metric.inset, y: Metric.inset + CGFloat(index) * Metric.rowHeight,
               width: bounds.width - Metric.inset * 2, height: Metric.rowHeight)
    }

    private func row(at point: CGPoint) -> Int? {
        rows.indices.first { rowRect($0).contains(point) && rows[$0].enabled }
    }

    override func mouseMoved(with event: NSEvent) { hovered = row(at: convert(event.locationInWindow, from: nil)) }
    override func mouseEntered(with event: NSEvent) { hovered = row(at: convert(event.locationInWindow, from: nil)) }
    override func mouseExited(with event: NSEvent) { hovered = nil }

    override func mouseDown(with event: NSEvent) {
        pressed = row(at: convert(event.locationInWindow, from: nil))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        let released = row(at: convert(event.locationInWindow, from: nil))
        let chosen = pressed
        pressed = nil
        needsDisplay = true
        if let chosen, chosen == released { onChoose?(chosen) }
    }

    override func draw(_ dirtyRect: NSRect) {
        for (index, row) in rows.enumerated() {
            let rect = rowRect(index)
            if index == hovered || index == pressed || (row.current && hovered == nil) {
                let alpha: CGFloat = index == pressed ? 0.14 : (index == hovered ? 0.09 : 0.06)
                NSColor.labelColor.withAlphaComponent(alpha).setFill()
                NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10).fill()
            }
            draw(row, in: rect)
        }
    }

    private func draw(_ row: ReferenceMenuRow, in rect: CGRect) {
        let iconBox = CGRect(x: rect.minX + 10, y: rect.minY + 9, width: 22, height: 22)
        switch row.icon {
        case .file(let path):
            ReferenceSourceType.icon(forPath: path, size: 44).draw(in: iconBox, from: .zero, operation: .sourceOver,
                                                                    fraction: row.enabled ? 1 : 0.45,
                                                                    respectFlipped: true, hints: nil)
        case .symbol(let name):
            if let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 15, weight: .medium)) {
                let color: NSColor = row.enabled ? .secondaryLabelColor : .tertiaryLabelColor
                let tinted = NSImage(size: symbol.size, flipped: false) { box in
                    symbol.draw(in: box)
                    color.set()
                    box.fill(using: .sourceAtop)
                    return true
                }
                let size = tinted.size
                tinted.draw(in: CGRect(x: iconBox.midX - size.width / 2, y: iconBox.midY - size.height / 2,
                                       width: size.width, height: size.height),
                            from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        }

        let textX = rect.minX + 42
        var trailing = rect.maxX - 12
        if row.current, let check = NSImage(systemSymbolName: "checkmark", accessibilityDescription: "In use")?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .semibold)) {
            let tinted = NSImage(size: check.size, flipped: false) { box in
                check.draw(in: box)
                NSColor.labelColor.set()
                box.fill(using: .sourceAtop)
                return true
            }
            tinted.draw(in: CGRect(x: rect.maxX - 12 - check.size.width, y: rect.midY - check.size.height / 2,
                                   width: check.size.width, height: check.size.height),
                        from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            trailing -= check.size.width + 8
        }
        let titleFont = NSFont.systemFont(ofSize: 13, weight: .medium)
        let titleColor: NSColor = row.enabled ? .labelColor : .tertiaryLabelColor
        let tagFont = NSFont.systemFont(ofSize: 10, weight: .medium)
        let tagWidth = row.tag.map { ceil(($0 as NSString).size(withAttributes: [.font: tagFont]).width) + 12 } ?? 0
        let titleRoom = max(40, trailing - textX - (tagWidth > 0 ? tagWidth + 6 : 0))
        let truncating = NSMutableParagraphStyle()
        truncating.lineBreakMode = .byTruncatingTail
        let title = NSAttributedString(string: row.title, attributes: [
            .font: titleFont, .foregroundColor: titleColor, .paragraphStyle: truncating])
        let titleWidth = min(titleRoom, ceil(title.size().width))
        title.draw(with: CGRect(x: textX, y: rect.minY + 7, width: titleWidth, height: 18),
                   options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])

        if let tag = row.tag {
            let capsule = CGRect(x: textX + titleWidth + 6, y: rect.minY + 9, width: tagWidth, height: 15)
            let path = NSBezierPath(roundedRect: capsule.insetBy(dx: 0.25, dy: 0.25), xRadius: 7.5, yRadius: 7.5)
            NSColor.separatorColor.setStroke()
            path.lineWidth = 0.5
            path.stroke()
            (tag as NSString).draw(at: CGPoint(x: capsule.minX + 6, y: capsule.minY + 1),
                                   withAttributes: [.font: tagFont, .foregroundColor: NSColor.secondaryLabelColor])
        }

        let middle = NSMutableParagraphStyle()
        middle.lineBreakMode = .byTruncatingMiddle
        NSAttributedString(string: row.subtitle, attributes: [
            .font: NSFont.systemFont(ofSize: 11), .foregroundColor: row.enabled ? NSColor.secondaryLabelColor : .tertiaryLabelColor,
            .paragraphStyle: middle,
        ]).draw(with: CGRect(x: textX, y: rect.minY + 26, width: trailing - textX, height: 15),
                options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    private func updateAccessibility() {
        setAccessibilityElement(true)
        setAccessibilityRole(.list)
        setAccessibilityLabel(rows.map(\.title).joined(separator: ", "))
    }
}
