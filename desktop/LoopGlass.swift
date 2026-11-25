// Where The Loop uses the system's materials. The whole window is the
// system's translucent sidebar material, with the desktop showing through, and
// the sidebar sits straight on it as part of the window; the page is a solid
// rounded panel set into it. On macOS 26 the controls in column headers are
// Liquid Glass; earlier systems get the bordered controls they always had.

import Cocoa
import SwiftUI

enum LoopGlass {
    /// Whether this Mac draws Liquid Glass.
    static var isAvailable: Bool {
        if #available(macOS 26.0, *) { return true }
        return false
    }

    /// Room a column header leaves for the window's buttons while the sidebar is hidden.
    static let windowButtonsWidth: CGFloat = 84
    /// How far the page's panel sits in from the window's edges, and how round it is.
    static let panelInset: CGFloat = 8
    static let panelRadius: CGFloat = 14

    /// A clear window lets the material show the desktop behind it; on macOS
    /// 26 an empty unified toolbar moves the window's buttons in from the
    /// corner, level with the page's title.
    static func prepare(_ window: NSWindow) {
        window.isOpaque = false
        window.backgroundColor = .clear
        guard isAvailable else { return }
        let toolbar = NSToolbar(identifier: "LassoLoop")
        toolbar.allowsUserCustomization = false
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified
    }
}

/// The window's ground wherever the page's panel is not: the system's
/// sidebar material, the desktop blurred and tinted through it, so the
/// sidebar reads as part of the window.
struct LoopWindowBackdrop: View {
    var body: some View {
        LoopVisualEffect(material: .sidebar)
    }
}

struct LoopToolbarKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True for controls in a column header or filter bar, the window's toolbar layer.
    var loopToolbar: Bool {
        get { self[LoopToolbarKey.self] }
        set { self[LoopToolbarKey.self] = newValue }
    }
}

extension View {
    /// A capsule of glass behind a control's label, or the bordered pill before macOS 26.
    func loopControlBackground(prominent: Bool = false, hovering: Bool = false) -> some View {
        background(LoopPillShape(prominent: prominent, hovering: hovering))
    }
}

/// An AppKit material behind SwiftUI content.
struct LoopVisualEffect: NSViewRepresentable {
    let material: NSVisualEffectView.Material

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) { view.material = material }
}

/// The look a button takes from where it sits: glass in the toolbar layer on
/// macOS 26, bordered everywhere else and on earlier systems.
struct LoopNativeButton: ViewModifier {
    let prominent: Bool
    @Environment(\.loopToolbar) private var toolbar

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *), toolbar || prominent {
            if prominent { content.buttonStyle(.glassProminent) } else { content.buttonStyle(.glass) }
        } else if prominent {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}
