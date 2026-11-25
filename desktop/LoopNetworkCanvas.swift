// How The Loop's Network is drawn on its panel: a faint dot grid that moves
// with the view, lines from each file to its directory in that directory's
// colour, connections between files (blue where they cross directories,
// dashed where only a name is shared), directory hubs ringed in their colour,
// files from grey to lime by how much they are used, labels set where they do
// not cover one already drawn, and on the lines in focus a tag saying what
// joins their two files.

import Cocoa
import SwiftUI

struct LoopNetworkScene {
    let layout: LoopNetworkLayout
    let place: (CGPoint) -> CGPoint
    let zoom: CGFloat
    let pan: CGSize
    let hovered: Int?
    /// The two files of a hovered line.
    let hoveredPair: (Int, Int)?
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
    static func radius(of node: LoopNetworkNode, zoom: CGFloat) -> CGFloat {
        node.radius * (node.role == .hub ? hubScale : 1) * min(1.6, max(0.8, zoom))
    }

    func draw(in context: inout GraphicsContext, size: CGSize) {
        drawGrid(in: &context, size: size)
        drawLines(in: &context)
        drawNodes(in: &context)
        let taken = drawLabels(in: &context, size: size)
        drawTags(in: &context, around: taken)
    }

    /// Where a connection's gentle curve bends, so crossing lines stay apart.
    static func bend(from: CGPoint, to: CGPoint) -> CGPoint {
        let middle = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
        return CGPoint(x: middle.x - (to.y - from.y) * 0.12, y: middle.y + (to.x - from.x) * 0.12)
    }

    /// The halfway point of a connection's curve, where its tag sits.
    static func middle(from: CGPoint, to: CGPoint) -> CGPoint {
        let control = bend(from: from, to: to)
        return CGPoint(x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x, y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y)
    }

    /// How far a point is from a connection's curve, measured along a few straight pieces.
    static func distance(from point: CGPoint, toCurveFrom from: CGPoint, to: CGPoint) -> CGFloat {
        let control = bend(from: from, to: to)
        let pieces = 14
        var previous = from, nearest = CGFloat.greatestFiniteMagnitude
        for step in 1...pieces {
            let t = CGFloat(step) / CGFloat(pieces), u = 1 - t
            let next = CGPoint(x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
                               y: u * u * from.y + 2 * u * t * control.y + t * t * to.y)
            nearest = min(nearest, distance(from: point, toSegment: previous, next))
            previous = next
        }
        return nearest
    }

    private static func distance(from point: CGPoint, toSegment a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x, dy = b.y - a.y
        let length = dx * dx + dy * dy
        let t = length == 0 ? 0 : min(1, max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
        return hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
    }

    private func isPair(_ line: LoopNetworkLine) -> Bool {
        guard let (a, b) = hoveredPair else { return false }
        return (line.from == a && line.to == b) || (line.from == b && line.to == a)
    }

    private func color(_ node: LoopNetworkNode) -> Color { colors[node.directoryId] ?? LoopLook.ink2 }

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
        context.fill(dots, with: .color(LoopLook.ink.opacity(0.07)))
    }

    private func drawLines(in context: inout GraphicsContext) {
        let quiet = hovered != nil || hoveredPair != nil || lit != nil
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
            path.addQuadCurve(to: to, control: Self.bend(from: from, to: to))
            let tint = line.crossesDirectories ? LoopLook.sky : LoopLook.ink
            let focused = isPair(line) || (hovered != nil && (line.from == hovered || line.to == hovered))
            let opacity = focused ? 0.95 : hoveredPair != nil ? 0.05
                : lineLit ? (hovered == nil ? (line.crossesDirectories ? 0.5 : 0.28) : 0.9) : 0.05
            let style = StrokeStyle(lineWidth: 1 + 0.55 * min(3, line.weight) + (isPair(line) ? 1.5 : 0), lineCap: .round,
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
                context.fill(Path(ellipseIn: shape), with: .color(LoopLook.raise))
                context.stroke(Path(ellipseIn: shape), with: .color(tint), lineWidth: 2)
                if let glyph = context.resolveSymbol(id: node.directoryId) {
                    context.draw(glyph, at: CGPoint(x: shape.midX, y: shape.midY))
                }
            } else {
                context.fill(Path(ellipseIn: shape), with: .color(Self.fill(activity: node.activity)))
                context.stroke(Path(ellipseIn: shape), with: .color(LoopLook.panel), lineWidth: 1.5)
                if index == hovered || index == selected {
                    context.stroke(Path(ellipseIn: shape.insetBy(dx: -4, dy: -4)), with: .color(LoopLook.ink), lineWidth: 1.5)
                }
            }
        }
        context.opacity = 1
    }

    /// Labels go on in order of importance and are left off where they would
    /// cover one already drawn, so the picture never turns to mush.
    @discardableResult
    private func drawLabels(in context: inout GraphicsContext, size: CGSize) -> [CGRect] {
        let nodes = layout.nodes
        let pair = hoveredPair.map { [$0.0, $0.1] } ?? []
        let inFocus = Set([hovered, selected].compactMap { $0 } + pair)
        let order = [hovered, selected].compactMap { $0 } + pair
            + nodes.indices.filter { nodes[$0].role == .hub }
            + nodes.indices.filter { labelled.contains($0) }.sorted { nodes[$0].activity > nodes[$1].activity }
        // Hubs, and the file in focus, keep their own space clear.
        var taken = nodes.indices.filter { nodes[$0].role == .hub || inFocus.contains($0) }.map(rect)
        var seen = Set<Int>()
        for index in order where seen.insert(index).inserted {
            let node = nodes[index]
            let focus = inFocus.contains(index)
            if !focus, let lit, !lit.contains(index) { continue }
            let text = context.resolve(Text(node.label)
                .font(node.role == .hub ? LoopLook.font(13, .medium) : LoopLook.font(11.5, focus ? .medium : .regular))
                .foregroundColor(node.role == .hub || focus ? LoopLook.ink : LoopLook.ink2))
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
                context.fill(backing, with: .color(LoopLook.panel.opacity(0.85)))
            }
            context.draw(text, in: frame)
        }
        return taken
    }

    /// On each line in focus, what joins its two files: "names", "same name",
    /// the linked value. One tag a pair, left off where it would cover a name.
    private func drawTags(in context: inout GraphicsContext, around labels: [CGRect]) {
        let ends: [(Int, Int)] = hoveredPair.map { [$0] }
            ?? hovered.map { node in layout.neighbours(of: node).filter { layout.nodes[$0].role == .file }.map { (node, $0) } }
            ?? []
        var taken = labels + layout.nodes.indices.map(rect)
        for (a, b) in ends.sorted(by: { $0.1 < $1.1 }) {
            guard let connection = layout.connection(between: a, and: b) else { continue }
            let text = context.resolve(Text(connection.tag).font(LoopLook.font(11, .medium))
                .foregroundColor(connection.crossesDirectories ? LoopLook.sky : LoopLook.ink))
            let measured = text.measure(in: CGSize(width: 200, height: 30))
            let middle = Self.middle(from: place(layout.nodes[a].position), to: place(layout.nodes[b].position))
            let frame = CGRect(x: middle.x - measured.width / 2, y: middle.y - measured.height / 2,
                               width: measured.width, height: measured.height)
            let backing = frame.insetBy(dx: -7, dy: -3)
            if hoveredPair == nil && taken.contains(where: { $0.intersects(backing) }) { continue }
            taken.append(backing)
            let shape = Path(roundedRect: backing, cornerRadius: backing.height / 2)
            context.fill(shape, with: .color(LoopLook.raise))
            context.stroke(shape, with: .color((connection.crossesDirectories ? LoopLook.sky : LoopLook.ink).opacity(0.35)), lineWidth: 1)
            context.draw(text, in: frame)
        }
    }
}
