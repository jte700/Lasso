// How The Ranch picks up the system look. On macOS 26 the sidebar floats as a
// Liquid Glass pane and the controls in column headers are glass; earlier
// systems get the translucent sidebar and bordered controls they always had.
// Nothing here draws glass on a system that does not have it.

import Cocoa
import SwiftUI

enum RanchGlass {
    /// Whether this Mac draws Liquid Glass.
    static var isAvailable: Bool {
        if #available(macOS 26.0, *) { return true }
        return false
    }

    /// How far the floating sidebar sits in from the window's edges.
    static let sidebarInset: CGFloat = 8
    static let sidebarRadius: CGFloat = 16
    /// The strip at the top of the floating sidebar that holds the window's
    /// buttons, so the sidebar's own button lines up with them.
    static let sidebarTitlebarHeight: CGFloat = 36
    /// Room a column header leaves for the window's buttons while the sidebar is hidden.
    static let windowButtonsWidth: CGFloat = 84

    /// Sets a window up for a floating glass sidebar: an empty unified toolbar
    /// moves its buttons in from the corner, inside the sidebar, and a clear
    /// window lets the sidebar's glass show the desktop behind it.
    static func prepare(_ window: NSWindow) {
        guard isAvailable else { return }
        let toolbar = NSToolbar(identifier: "LassoRanch")
        toolbar.allowsUserCustomization = false
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.isOpaque = false
        window.backgroundColor = .clear
    }
}

/// What the window shows where no column draws: on macOS 26 the desktop,
/// blurred, around and under the glass sidebar; before it, the plain surface.
struct RanchWindowBackdrop: View {
    var body: some View {
        if RanchGlass.isAvailable {
            RanchVisualEffect(material: .underWindowBackground).ignoresSafeArea()
        } else {
            RanchTheme.surface.ignoresSafeArea()
        }
    }
}

struct RanchToolbarKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True for controls in a column header or filter bar, the window's toolbar layer.
    var ranchToolbar: Bool {
        get { self[RanchToolbarKey.self] }
        set { self[RanchToolbarKey.self] = newValue }
    }
}

extension View {
    /// The sidebar's surface: a floating glass pane, or the system's sidebar material.
    func ranchSidebarSurface() -> some View { modifier(RanchSidebarSurface()) }

    /// A capsule of glass behind a control's label, or the bordered pill before macOS 26.
    func ranchControlBackground(prominent: Bool = false, hovering: Bool = false) -> some View {
        background(RanchPillShape(prominent: prominent, hovering: hovering))
    }
}

private struct RanchSidebarSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            let shape = RoundedRectangle(cornerRadius: RanchGlass.sidebarRadius, style: .continuous)
            content
                .clipShape(shape)
                .glassEffect(.regular, in: shape)
                .padding(RanchGlass.sidebarInset)
        } else {
            content.background(RanchVisualEffect(material: .sidebar).ignoresSafeArea())
        }
    }
}

/// An AppKit material behind SwiftUI content.
struct RanchVisualEffect: NSViewRepresentable {
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
struct RanchNativeButton: ViewModifier {
    let prominent: Bool
    @Environment(\.ranchToolbar) private var toolbar

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
