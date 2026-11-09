// The suggestion card's Liquid Glass on macOS 26: one glass outline for the
// rounded body and the arrow that points at the caret, so the arrow is the
// same material as the card rather than a separate blurred triangle.

import Cocoa
import SwiftUI

/// Where the card's body and arrow sit inside its panel.
struct AssistBubbleGeometry: Equatable {
    let cornerRadius: CGFloat
    let pointerWidth: CGFloat
    let pointerHeight: CGFloat
    let pointerX: CGFloat
    let pointerAtTop: Bool
}

enum AssistGlassBubble {
    /// The glass view and how to reshape it, or nil where the system has no
    /// Liquid Glass or Reduce Transparency is on; the card keeps its material
    /// and separate arrow there.
    static func make(_ geometry: AssistBubbleGeometry) -> (view: NSView, update: (AssistBubbleGeometry) -> Void)? {
        guard NativeMaterial.usesGlass, #available(macOS 26.0, *) else { return nil }
        let host = NSHostingView(rootView: AssistGlassBubbleView(shape: AssistBubbleShape(geometry: geometry)))
        return (host, { geometry in
            let shape = AssistBubbleShape(geometry: geometry)
            guard host.rootView.shape != shape else { return }
            host.rootView = AssistGlassBubbleView(shape: shape)
        })
    }
}

@available(macOS 26.0, *)
private struct AssistGlassBubbleView: View {
    let shape: AssistBubbleShape

    var body: some View {
        Color.clear
            .glassEffect(.regular, in: shape)
            .allowsHitTesting(false)
    }
}

/// The card's outline as one path: a rounded body with the arrow on its top
/// or bottom edge. SwiftUI's y runs down, so "top" is the small y.
struct AssistBubbleShape: Shape, Equatable {
    let geometry: AssistBubbleGeometry

    func path(in rect: CGRect) -> Path {
        let g = geometry
        let radius = min(g.cornerRadius, (rect.height - g.pointerHeight) / 2, rect.width / 2)
        let body = CGRect(x: rect.minX, y: g.pointerAtTop ? rect.minY + g.pointerHeight : rect.minY,
                          width: rect.width, height: max(0, rect.height - g.pointerHeight))
        // The arrow stays clear of the rounded corners.
        let half = g.pointerWidth / 2
        let x = min(max(g.pointerX, body.minX + radius + half), body.maxX - radius - half)
        var path = Path()
        path.move(to: CGPoint(x: body.minX + radius, y: body.minY))
        if g.pointerAtTop {
            path.addLine(to: CGPoint(x: x - half, y: body.minY))
            path.addLine(to: CGPoint(x: x, y: rect.minY))
            path.addLine(to: CGPoint(x: x + half, y: body.minY))
        }
        path.addArc(tangent1End: CGPoint(x: body.maxX, y: body.minY),
                    tangent2End: CGPoint(x: body.maxX, y: body.maxY), radius: radius)
        path.addArc(tangent1End: CGPoint(x: body.maxX, y: body.maxY),
                    tangent2End: CGPoint(x: body.minX, y: body.maxY), radius: radius)
        if !g.pointerAtTop {
            path.addLine(to: CGPoint(x: x + half, y: body.maxY))
            path.addLine(to: CGPoint(x: x, y: rect.maxY))
            path.addLine(to: CGPoint(x: x - half, y: body.maxY))
        }
        path.addArc(tangent1End: CGPoint(x: body.minX, y: body.maxY),
                    tangent2End: CGPoint(x: body.minX, y: body.minY), radius: radius)
        path.addArc(tangent1End: CGPoint(x: body.minX, y: body.minY),
                    tangent2End: CGPoint(x: body.maxX, y: body.minY), radius: radius)
        path.closeSubpath()
        return path
    }
}
