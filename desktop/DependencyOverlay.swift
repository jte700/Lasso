//  The native highlight overlay.
//
//  CoLab owns this visual layer entirely: the host application's document is
//  never touched. A borderless, transparent, non-activating panel floats above
//  the focused window and draws a thin underline beneath each linked phrase.
//  Mouse events pass straight through except over a dependency, so the user
//  keeps typing and selecting in the host exactly as before.

import Cocoa

// MARK: - Appearance

/// Styling is chosen by dependency state, never hardcoded at the call site.
enum DependencyStyle {
    /// Source identity colors avoid warning red/amber, which remain reserved
    /// for stale, changed, and missing dependencies.
    private static let sourceColors: [NSColor] = [
        NSColor(srgbRed: 0.12, green: 0.48, blue: 0.94, alpha: 1),
        NSColor(srgbRed: 0.48, green: 0.32, blue: 0.88, alpha: 1),
        NSColor(srgbRed: 0.00, green: 0.55, blue: 0.58, alpha: 1),
        NSColor(srgbRed: 0.78, green: 0.25, blue: 0.58, alpha: 1),
        NSColor(srgbRed: 0.12, green: 0.60, blue: 0.32, alpha: 1),
        NSColor(srgbRed: 0.26, green: 0.36, blue: 0.84, alpha: 1),
        NSColor(srgbRed: 0.00, green: 0.52, blue: 0.74, alpha: 1),
        NSColor(srgbRed: 0.60, green: 0.30, blue: 0.72, alpha: 1),
    ]
    static var sourceColorCount: Int { sourceColors.count }

    static func stroke(for state: DependencyVisualState, sourceSlot: Int, hovered: Bool) -> NSColor {
        let base: NSColor
        switch state {
        case .healthy:
            let index = (sourceSlot % sourceColors.count + sourceColors.count) % sourceColors.count
            base = sourceColors[index]
        case .changed:    base = NSColor(srgbRed: 0.87, green: 0.66, blue: 0.29, alpha: 1)
        case .stale:      base = NSColor(srgbRed: 0.85, green: 0.72, blue: 0.35, alpha: 1)
        case .missing:    base = NSColor(srgbRed: 0.85, green: 0.40, blue: 0.38, alpha: 1)
        case .unresolved: base = .clear
        }
        return base.withAlphaComponent(hovered ? 1.0 : 0.90)
    }

    static func wash(for state: DependencyVisualState, sourceSlot: Int, hovered: Bool) -> NSColor {
        guard hovered else {
            return stroke(for: state, sourceSlot: sourceSlot, hovered: false).withAlphaComponent(0.08)
        }
        return stroke(for: state, sourceSlot: sourceSlot, hovered: true).withAlphaComponent(0.16)
    }

    static func isDashed(_ state: DependencyVisualState) -> Bool {
        state == .stale || state == .missing
    }
}

// MARK: - Drawing

final class OverlayView: NSView {
    var geometries: [DependencyGeometry] = []
    var states: [String: DependencyVisualState] = [:]
    var sourceSlots: [String: Int] = [:]
    var hoveredId: String?
    var debug = false
    /// Screen-space frame of the panel that owns this view.
    var panelFrame: CGRect = .zero

    override var isFlipped: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        for geometry in geometries {
            let state = states[geometry.referenceId] ?? .healthy
            guard state.isDrawn || debug else { continue }
            let hovered = geometry.referenceId == hoveredId
            let sourceSlot = sourceSlots[geometry.referenceId] ?? 0

            for fragment in geometry.fragments {
                let local = HostGeometryConverter.toPanelLocal(fragment, panelFrame: panelFrame)

                // A faint wash, kept well below the text's own contrast.
                DependencyStyle.wash(for: state, sourceSlot: sourceSlot, hovered: hovered).setFill()
                NSBezierPath(roundedRect: local.insetBy(dx: -1, dy: 0), xRadius: 4, yRadius: 4).fill()

                // The underline sits just under the baseline.
                context.saveGState()
                DependencyStyle.stroke(for: state, sourceSlot: sourceSlot, hovered: hovered).setStroke()
                context.setLineWidth(hovered ? 2.0 : 1.25)
                if DependencyStyle.isDashed(state) { context.setLineDash(phase: 0, lengths: [3, 2]) }
                let y = local.minY + 0.5
                context.move(to: CGPoint(x: local.minX, y: y))
                context.addLine(to: CGPoint(x: local.maxX, y: y))
                context.strokePath()
                context.restoreGState()

                if debug {
                    NSColor.systemPink.withAlphaComponent(0.9).setStroke()
                    context.setLineWidth(0.5)
                    context.stroke(local)
                }
            }

            if debug, let first = geometry.fragments.first {
                let label = "\(geometry.referenceId) · \(state.rawValue)"
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: NSFont.monospacedSystemFont(ofSize: 8, weight: .regular),
                    .foregroundColor: NSColor.systemPink,
                ]
                let point = CGPoint(x: first.minX - panelFrame.minX,
                                    y: first.maxY - panelFrame.minY + 2)
                NSAttributedString(string: label, attributes: attributes).draw(at: point)
            }
        }
    }
}

// MARK: - Window

/// A panel that never takes focus and only intercepts the mouse over a
/// dependency, so the host application keeps behaving normally everywhere else.
final class OverlayPanel: NSPanel {
    var hitTest: ((NSPoint) -> Bool)?

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    convenience init(view: NSView) {
        self.init(contentRect: .zero,
                  styleMask: [.borderless, .nonactivatingPanel],
                  backing: .buffered,
                  defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        ignoresMouseEvents = true
        contentView = view
    }
}
