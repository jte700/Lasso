// How The Ranch's Network is drawn on its panel: a faint dot grid that moves
// with the view, lines from each file to its directory in that directory's
// colour, connections between files (blue where they cross directories,
// dashed where only a name is shared), directory hubs ringed in their colour,
// files from grey to lime by how much they are used, and labels set where
// they do not cover one already drawn.

import Cocoa
import SwiftUI

struct RanchNetworkScene {
    let layout: RanchNetworkLayout
    let place: (CGPoint) -> CGPoint
    let zoom: CGFloat
    let pan: CGSize
    let hovered: Int?
    let selected: Int?
    /// The nodes lit by a hover or a search; nil lights everything.
    let lit: Set<Int>?
    let labelled: Set<Int>
    /// Each directory's colour, by directory id.
    let colors: [String: Color]

    /// Room kept clear round the network inside its panel.
    static let padding: CGFloat = 52
    private static let gridSpacing: CGFloat = 24
    private static let hubScale: CGFloat = 1.35
    private static let unused = NSColor(srgbRed: 0x5A / 255, green: 0x5A / 255, blue: 0x54 / 255, alpha: 1)
    private static let busiest = NSColor(srgbRed: 0xD4 / 255, green: 0xF7 / 255, blue: 0x5C / 255, alpha: 1)

    /// A file's colour: grey when nobody has used it, through to the mascot's lime for the busiest.
    static func fill(activity: Double) -> Color {
        let amount = CGFloat(min(1, max(0, activity.isFinite ? activity : 0)))
        return Color(nsColor: unused.blended(withFraction: amount, of: busiest) ?? unused)
    }

    /// How large a node is drawn at a zoom.
    static func radius(of node: RanchNetworkNode, zoom: CGFloat) -> CGFloat {
        node.radius * (node.role == .hub ? hubScale : 1) * min(1.6, max(0.8, zoom))
    }

    func draw(in context: inout GraphicsContext, size: CGSize) {
        drawGrid(in: &context, size: size)
        drawLines(in: &context)
        drawNodes(in: &context)
        drawLabels(in: &context, size: size)
    }

    private func color(_ node: RanchNetworkNode) -> Color { colors[node.directoryId] ?? RanchLook.ink2 }

    private func isLit(_ index: Int) -> Bool { lit?.contains(index) ?? true }

    private func rect(_ index: Int) -> CGRect {
        let node = layout.nodes[index]
        let center = place(node.position)
        let radius = Self.radius(of: node, zoom: zoom)
        return CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    }

    // MARK: Layers

    private func drawGrid(in context: inout GraphicsContext, size: CGSize) {
        let spacing = Self.gridSpacing
        let start = CGPoint(x: pan.width.truncatingRemainder(dividingBy: spacing) - spacing,
                            y: pan.height.truncatingRemainder(dividingBy: spacing) - spacing)
        var dots = Path()
        var y = start.y
        while y < size.height + spacing {
            var x = start.x
            while x < size.width + spacing {
                dots.addEllipse(in: CGRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5))
                x += spacing
            }
            y += spacing
        }
        context.fill(dots, with: .color(RanchLook.ink.opacity(0.07)))
    }

    private func drawLines(in context: inout GraphicsContext) {
        let quiet = hovered != nil || lit != nil
        for line in layout.lines {
            let from = place(layout.nodes[line.from].position), to = place(layout.nodes[line.to].position)
            let lineLit = isLit(line.from) && isLit(line.to)
            var path = Path()
            path.move(to: from)
            if line.kind == "member" {
                path.addLine(to: to)
                let tint = color(layout.nodes[line.from])
                context.stroke(path, with: .color(tint.opacity(lineLit ? (quiet ? 0.4 : 0.22) : 0.05)), lineWidth: 1)
                continue
            }
            // A gentle curve keeps crossing lines apart.
            let middle = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
            let bend = CGPoint(x: middle.x - (to.y - from.y) * 0.12, y: middle.y + (to.x - from.x) * 0.12)
            path.addQuadCurve(to: to, control: bend)
            let tint = line.crossesDirectories ? RanchLook.sky : RanchLook.ink
            let opacity = lineLit ? (hovered == nil ? (line.crossesDirectories ? 0.5 : 0.28) : 0.9) : 0.05
            let style = StrokeStyle(lineWidth: 1 + 0.55 * min(3, line.weight), lineCap: .round,
                                    dash: line.kind == "same-name" ? [3, 4] : [])
            context.stroke(path, with: .color(tint.opacity(opacity)), style: style)
        }
    }

    private func drawNodes(in context: inout GraphicsContext) {
        for (index, node) in layout.nodes.enumerated() {
            let shape = rect(index)
            context.opacity = isLit(index) ? 1 : 0.22
            if node.role == .hub {
                let tint = color(node)
                // A soft halo in the directory's colour, then the disc and its ring.
                context.fill(Path(ellipseIn: shape.insetBy(dx: -7, dy: -7)), with: .color(tint.opacity(0.1)))
                context.fill(Path(ellipseIn: shape), with: .color(RanchLook.raise))
                context.stroke(Path(ellipseIn: shape), with: .color(tint), lineWidth: 2)
                if let glyph = context.resolveSymbol(id: node.directoryId) {
                    context.draw(glyph, at: CGPoint(x: shape.midX, y: shape.midY))
                }
            } else {
                context.fill(Path(ellipseIn: shape), with: .color(Self.fill(activity: node.activity)))
                context.stroke(Path(ellipseIn: shape), with: .color(RanchLook.panel), lineWidth: 1.5)
                if index == hovered || index == selected {
                    context.stroke(Path(ellipseIn: shape.insetBy(dx: -4, dy: -4)), with: .color(RanchLook.ink), lineWidth: 1.5)
                }
            }
        }
        context.opacity = 1
    }

    /// Labels go on in order of importance and are left off where they would
    /// cover one already drawn, so the picture never turns to mush.
    private func drawLabels(in context: inout GraphicsContext, size: CGSize) {
        let nodes = layout.nodes
        let order = [hovered, selected].compactMap { $0 }
            + nodes.indices.filter { nodes[$0].role == .hub }
            + nodes.indices.filter { labelled.contains($0) }.sorted { nodes[$0].activity > nodes[$1].activity }
        // Hubs, and the file in focus, keep their own space clear.
        var taken = nodes.indices.filter { nodes[$0].role == .hub || $0 == hovered || $0 == selected }.map(rect)
        var seen = Set<Int>()
        for index in order where seen.insert(index).inserted {
            let node = nodes[index]
            let focus = index == hovered || index == selected
            if !focus, let lit, !lit.contains(index) { continue }
            let text = context.resolve(Text(node.label)
                .font(node.role == .hub ? RanchLook.font(13, .medium) : RanchLook.font(11.5, focus ? .medium : .regular))
                .foregroundColor(node.role == .hub || focus ? RanchLook.ink : RanchLook.ink2))
            let measured = text.measure(in: CGSize(width: 220, height: 40))
            let shape = rect(index)
            // Kept inside the panel, so a name near the edge is never cut off.
            let x = min(max(6, shape.midX - measured.width / 2), max(6, size.width - measured.width - 6))
            let frame = CGRect(x: x, y: shape.maxY + (node.role == .hub ? 7 : 5), width: measured.width, height: measured.height)
            if !focus && taken.contains(where: { $0.insetBy(dx: -4, dy: -1).intersects(frame) }) { continue }
            taken.append(frame)
            if node.role == .hub || focus {
                // A backing the colour of the panel keeps the name readable over lines.
                let backing = Path(roundedRect: frame.insetBy(dx: -5, dy: -2), cornerRadius: 6)
                context.fill(backing, with: .color(RanchLook.panel.opacity(0.85)))
            }
            context.draw(text, in: frame)
        }
    }
}
