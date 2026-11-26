import AppKit
import SwiftUI

// Lasso's logo wherever the app shows one in small: the mascot, facing front,
// in one colour with his eyes cut through. Its paths are in MascotShape.swift.

enum MascotMark {
    /// The symbol name that stands for Lasso itself. Views that take an SF
    /// Symbol name draw the mascot for it instead (`LassoSymbol`).
    static let symbolName = "lasso"

    /// The menu bar's mark: a template image, so macOS tints it for light,
    /// dark and highlighted menu bars.
    static func menuBarImage(side: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.addPath(path(in: rect))
            context.setFillColor(NSColor.black.cgColor)
            context.fillPath()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Lasso"
        return image
    }

    /// The mark fitted into a rectangle whose y runs down.
    static func path(in rect: CGRect) -> CGPath {
        let side = min(rect.width, rect.height)
        let place = CGAffineTransform(translationX: rect.midX - side / 2, y: rect.midY - side / 2)
            .scaledBy(x: side, y: side)
        return Mascot.mark.transformed(place)
    }
}

/// The mascot as a SwiftUI shape, filled with the foreground style.
struct MascotMarkShape: Shape {
    func path(in rect: CGRect) -> Path { Path(MascotMark.path(in: rect)) }
}

/// An SF Symbol by name, except Lasso's own, which is drawn as the mascot at
/// about the size the symbol would take at that font size.
struct LassoSymbol: View {
    let name: String
    let size: CGFloat
    var weight: Font.Weight = .regular

    var body: some View {
        if name == MascotMark.symbolName {
            MascotMarkShape()
                .frame(width: size * Self.mascotScale, height: size * Self.mascotScale)
        } else if let provider = ConnectorLogo.provider(inSymbol: name) {
            // A cloud drive's logo keeps its own colours, whatever the tint around it.
            ConnectorLogoView(provider: provider, size: size * Self.mascotScale)
        } else {
            Image(systemName: name).font(.system(size: size, weight: weight))
        }
    }

    /// The mascot is wider than tall and has no stroke weight, so it is drawn
    /// a little larger than the type size to sit level with its neighbours.
    static let mascotScale: CGFloat = 1.2
}
