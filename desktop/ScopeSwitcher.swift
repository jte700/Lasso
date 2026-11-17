// The ⌥Tab switcher: a small Liquid Glass pill by the caret that names the
// folder or app suggestions come from. Tab rolls it to the next one, the old
// name rising out as the new one rises in. ↓ rolls the pill to its second
// row, the AI writer a backslash prompt is handed to (WriterChoice.swift),
// and ↑ back. Return keeps what both rows show and Escape leaves the choices
// as they were. Keys reach it through KeyRouting.swift, so the writer's app
// keeps focus throughout.

import Cocoa
import SwiftUI

/// The switcher's two rows, one shown at a time.
enum ScopeSwitcherRow: Equatable {
    /// Where suggestions come from.
    case folders
    /// Who writes when a prompt is handed over.
    case writers

    var label: String { self == .folders ? "Suggest from" : "Write with" }
}

/// What the pill shows, and which way the last roll went.
final class ScopeSwitcherModel: ObservableObject {
    @Published var row: ScopeSwitcherRow = .folders
    @Published var entry: SourceScopeEntry = .all
    /// The entry shown is already the one in use.
    @Published var isCurrent = true
    /// The last roll went forward, so the new name rises from below.
    @Published var forward = true
}

struct ScopeSwitcherView: View {
    @ObservedObject var model: ScopeSwitcherModel

    static let height: CGFloat = 44
    static let chipHeight: CGFloat = 32
    static let symbolWidth: CGFloat = 16
    static let symbolGap: CGFloat = 6
    static let maximumTitleWidth: CGFloat = 220
    static let titleFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
    static let rowFont = NSFont.systemFont(ofSize: 13)

    /// A row's label width, so the pill can spring to it while the words roll.
    static func rowLabelWidth(_ row: ScopeSwitcherRow) -> CGFloat {
        ceil((row.label as NSString).size(withAttributes: [.font: rowFont]).width) + 1
    }

    /// The chip's label width for an entry, so the chip can spring to it
    /// before the new name has finished rolling in.
    static func labelWidth(_ entry: SourceScopeEntry) -> CGFloat {
        let title = ceil((entry.title as NSString).size(withAttributes: [.font: titleFont]).width) + 1
        return symbolWidth + symbolGap + min(title, maximumTitleWidth)
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            rowLabel
            chip
            // ✓ while the entry shown is the one in use; ↩ once Return would change it.
            Image(systemName: model.isCurrent ? "checkmark" : "return")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(model.isCurrent ? .secondary : .tertiary)
                .frame(width: 14)
                .contentTransition(.opacity)
            rowDots
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(height: Self.height)
        .modifier(ScopeSwitcherSurface())
        .fixedSize()
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.34, dampingFraction: 0.8),
                   value: model.entry)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.34, dampingFraction: 0.8),
                   value: model.row)
        .animation(.easeOut(duration: 0.15), value: model.isCurrent)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(model.row.label) \(model.entry.title)")
    }

    /// What the row chooses, rolling with the chip when ↓ or ↑ changes the row.
    private var rowLabel: some View {
        ZStack(alignment: .leading) {
            Text(model.row.label)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .fixedSize()
                .id(model.row)
                .transition(roll)
        }
        .frame(width: Self.rowLabelWidth(model.row), height: Self.chipHeight, alignment: .leading)
        .clipped()
    }

    /// Two dots, one above the other: the pill has a second row, and which one shows.
    private var rowDots: some View {
        VStack(spacing: 4) {
            ForEach([ScopeSwitcherRow.folders, .writers], id: \.self) { row in
                Circle()
                    .fill(Color.primary.opacity(row == model.row ? 0.55 : 0.18))
                    .frame(width: 4, height: 4)
            }
        }
        .frame(width: 6)
        .accessibilityHidden(true)
    }

    /// The inner capsule, as the reference pill draws it: the name and its
    /// symbol on a slightly lighter fill, clipped so a rolling name slides out of it.
    private var chip: some View {
        ZStack(alignment: .leading) {
            ScopeEntryLabel(entry: model.entry)
                // All and a writer have no folder id; the row and the title tell them apart.
                .id("\(model.row)|\(model.entry.projectId ?? model.entry.title)")
                .transition(roll)
        }
        .frame(width: Self.labelWidth(model.entry), height: Self.chipHeight, alignment: .leading)
        .padding(.horizontal, 12)
        .background(Capsule().fill(Color.primary.opacity(0.08)))
        .clipShape(Capsule())
    }

    private var roll: AnyTransition {
        guard !reduceMotion else { return .opacity }
        let distance = Self.chipHeight * 0.7
        let rise = model.forward ? distance : -distance
        return .asymmetric(
            insertion: .modifier(active: ScopeRoll(y: rise, blur: 3, opacity: 0), identity: ScopeRoll(y: 0, blur: 0, opacity: 1)),
            removal: .modifier(active: ScopeRoll(y: -rise, blur: 3, opacity: 0), identity: ScopeRoll(y: 0, blur: 0, opacity: 1)))
    }
}

private struct ScopeRoll: ViewModifier {
    let y: CGFloat
    let blur: CGFloat
    let opacity: Double

    func body(content: Content) -> some View {
        content.offset(y: y).blur(radius: blur).opacity(opacity)
    }
}

/// A folder's symbol in its colour from the Lasso menu; All in the text colour.
private struct ScopeEntryLabel: View {
    let entry: SourceScopeEntry

    var body: some View {
        HStack(spacing: ScopeSwitcherView.symbolGap) {
            Image(systemName: entry.symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: ScopeSwitcherView.symbolWidth)
            Text(entry.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: ScopeSwitcherView.maximumTitleWidth, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var tint: Color {
        guard let projectId = entry.projectId, let color = DirectoryColorPreferences.color(for: projectId) else { return .primary }
        return Color(nsColor: color.color)
    }
}

/// Liquid Glass on macOS 26, as the suggestion card has; the popover
/// material with a hairline edge before it, or with Reduce Transparency on.
private struct ScopeSwitcherSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *), NativeMaterial.usesGlass {
            content.glassEffect(.regular, in: Capsule())
        } else {
            content
                .background(RanchVisualEffect(material: .popover).clipShape(Capsule()))
                .overlay(Capsule().strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        }
    }
}

/// The panel the pill floats in. It never takes focus or clicks, so the
/// writer's app keeps both; a click anywhere or another app coming forward closes it.
final class ScopeSwitcherController {
    static let shared = ScopeSwitcherController()

    /// Room for the widest pill, and for its shadow on every side.
    static let margin: CGFloat = 14
    static var panelSize: NSSize {
        let label = max(ScopeSwitcherView.rowLabelWidth(.folders), ScopeSwitcherView.rowLabelWidth(.writers))
        let widest = 16 + label + 8 + 24 + ScopeSwitcherView.symbolWidth + ScopeSwitcherView.symbolGap
            + ScopeSwitcherView.maximumTitleWidth + 8 + 14 + 8 + 6 + 12
        return NSSize(width: ceil(widest) + 2 * margin, height: ScopeSwitcherView.height + 2 * margin)
    }

    private let model = ScopeSwitcherModel()
    private var panel: NSPanel?
    private var mouseMonitor: Any?
    private var activationObserver: NSObjectProtocol?
    private var shadowRefresh: DispatchWorkItem?
    /// Closed by something other than its keys: a click elsewhere or another app.
    var onDismiss: (() -> Void)?

    /// Open from ⌥Tab until Return, Escape or a key typed closes it: keys
    /// are the switcher's from the moment it opens, while the caret is still being read.
    private(set) var isOpen = false
    /// On screen, once the caret it sits by is known.
    private var isVisible = false
    /// The row the pill shows.
    private(set) var row: ScopeSwitcherRow = .folders
    /// The folder the pill shows on its first row, as an index into the scope's entries.
    private(set) var shownIndex = 0
    /// The writer it shows on its second, as an index into the writers offered.
    private(set) var shownWriterIndex = 0

    /// Opens on `entry`, the folder in use, with the writer in use on the
    /// row below. It shows once `present` places it.
    func open(_ entry: SourceScopeEntry, index: Int, isCurrent: Bool, writerIndex: Int = 0) {
        var plain = Transaction()
        plain.disablesAnimations = true
        withTransaction(plain) {
            model.forward = true
            model.row = .folders
            model.entry = entry
            model.isCurrent = isCurrent
        }
        row = .folders
        shownIndex = index
        shownWriterIndex = writerIndex
        isOpen = true
    }

    /// Shows the pill by the caret, an Accessibility rectangle, or at the
    /// pointer without one. Called again, it follows a caret read more exactly.
    func present(at caret: CGRect?) {
        guard isOpen else { return }
        let panel = existingPanel()
        let anchor = Self.anchor(for: caret)
        let screen = NSScreen.screens.first { $0.frame.intersects(anchor.insetBy(dx: -1, dy: -1)) } ?? NSScreen.main
        panel.setFrame(ScopeSwitcherPlacement.frame(caret: anchor, size: Self.panelSize, margin: Self.margin,
                                                    visible: screen?.visibleFrame), display: true)
        if !isVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                panel.animator().alphaValue = 1
            }
        }
        isVisible = true
        refreshShadow()
        watchForClicksElsewhere()
    }

    /// Rolls the row shown to `entry`, from below when going forward.
    func roll(to entry: SourceScopeEntry, index: Int, forward: Bool, isCurrent: Bool) {
        guard isOpen else { return }
        if row == .folders { shownIndex = index } else { shownWriterIndex = index }
        show(entry, forward: forward, isCurrent: isCurrent)
    }

    /// Rolls the pill to its other row, on the entry that row last showed:
    /// down to the writers, back up to the folders.
    func show(row: ScopeSwitcherRow, entry: SourceScopeEntry, isCurrent: Bool) {
        guard isOpen, row != self.row else { return }
        self.row = row
        show(entry, forward: row == .writers, isCurrent: isCurrent)
    }

    private func show(_ entry: SourceScopeEntry, forward: Bool, isCurrent: Bool) {
        // The direction is set first, so the name leaving rolls the same way as the one arriving.
        if model.forward != forward {
            var plain = Transaction()
            plain.disablesAnimations = true
            withTransaction(plain) { model.forward = forward }
        }
        let row = self.row
        DispatchQueue.main.async { [model] in
            model.row = row
            model.entry = entry
            model.isCurrent = isCurrent
        }
        refreshShadow()
    }

    func hide() {
        guard isOpen else { return }
        isOpen = false
        isVisible = false
        stopWatching()
        shadowRefresh?.cancel()
        guard let panel else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.1
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard self?.isOpen == false else { return }
            panel.orderOut(nil)
        })
    }

    /// The caret in AppKit coordinates, or the pointer when there is no caret to read.
    private static func anchor(for caret: CGRect?) -> CGRect {
        guard let caret else {
            let mouse = NSEvent.mouseLocation
            return CGRect(x: mouse.x, y: mouse.y - 18, width: 1, height: 18)
        }
        let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
        // A field's frame given for the caret stands for its first line, not its bottom edge.
        let flipped = HostGeometryConverter.toAppKit(CaretLine.line(caret), primaryHeight: primary?.frame.maxY ?? 0)
        return CGRect(x: flipped.minX, y: flipped.minY, width: max(1, flipped.width), height: max(1, flipped.height))
    }

    /// The window shadow follows the pill's outline, which changes width as it rolls.
    private func refreshShadow() {
        shadowRefresh?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.panel?.invalidateShadow() }
        shadowRefresh = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: work)
        panel?.invalidateShadow()
    }

    private func watchForClicksElsewhere() {
        if mouseMonitor == nil {
            mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
                self?.dismissFromOutside()
            }
        }
        if activationObserver == nil {
            activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                    self?.dismissFromOutside()
                }
        }
    }

    private func stopWatching() {
        if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
        mouseMonitor = nil
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
    }

    private func dismissFromOutside() {
        guard isOpen else { return }
        hide()
        onDismiss?()
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let size = Self.panelSize
        let created = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        created.level = .popUpMenu
        created.isOpaque = false
        created.backgroundColor = .clear
        created.hasShadow = true
        created.hidesOnDeactivate = false
        created.ignoresMouseEvents = true
        created.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        let pill = ScopeSwitcherView(model: model)
            .padding(Self.margin)
            .frame(width: size.width, height: size.height, alignment: .leading)
        let hosting = NSHostingView(rootView: AnyView(pill))
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.autoresizingMask = [.width, .height]
        created.contentView = hosting
        panel = created
        return created
    }
}
