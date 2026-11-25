// The field behind The Loop's opening card: a quiet grid of dots on the
// window's own dark panel. Near the pointer they grow, take on the Loop's
// colours (lime, sky, rope, sage, terracotta) and lean away from it; the
// pointer is followed with a little lag, so the colour trails it. With no
// pointer on the card a slow wanderer stands in, so the card is never still.
// When the person begins, the dots fade as the card makes way.

import SwiftUI

struct LoopDotField: View {
    /// 0 is the field at rest; 1 is all of it faded.
    var disperse: Double
    /// Held, not watched: the pointer moves every frame and only the canvas redraws.
    @State private var pointer = LoopDotPointer()

    var body: some View {
        TimelineView(.animation(minimumInterval: LoopDotPointer.frame)) { timeline in
            Canvas { context, size in
                let time = timeline.date.timeIntervalSinceReferenceDate
                let focus = pointer.step(at: time, in: size)
                LoopDotPainter(size: size, time: time, focus: focus, fade: disperse).draw(in: &context)
            }
        }
        .onContinuousHover { phase in
            switch phase {
            case .active(let point): pointer.target = point
            case .ended: pointer.target = nil
            }
        }
        .accessibilityHidden(true)
    }
}

/// Where the dots gather: the pointer, eased toward, or the wanderer.
final class LoopDotPointer {
    static let frame: TimeInterval = 1.0 / 60
    /// How much of the way to the target the gathering point moves each frame.
    private static let follow: CGFloat = 0.16
    /// The wanderer pulls the dots less than a real pointer does.
    private static let wanderStrength: CGFloat = 0.55

    var target: CGPoint?
    private var current: CGPoint?
    private var strength: CGFloat = 0

    /// The point the dots gather round this frame, and how strongly (0 to 1).
    func step(at time: TimeInterval, in size: CGSize) -> (point: CGPoint, strength: CGFloat) {
        let goal = target ?? Self.wander(at: time, in: size)
        let goalStrength: CGFloat = target == nil ? Self.wanderStrength : 1
        let start = current ?? goal
        let next = CGPoint(x: start.x + (goal.x - start.x) * Self.follow, y: start.y + (goal.y - start.y) * Self.follow)
        current = next
        strength += (goalStrength - strength) * Self.follow
        return (next, strength)
    }

    /// A slow loop through the card, never quite repeating.
    private static func wander(at time: TimeInterval, in size: CGSize) -> CGPoint {
        CGPoint(x: size.width * (0.5 + 0.32 * CGFloat(sin(time * 0.23))),
                y: size.height * (0.5 + 0.28 * CGFloat(sin(time * 0.31 + 1.2))))
    }
}

/// Draws one frame of the field.
struct LoopDotPainter {
    let size: CGSize
    let time: TimeInterval
    let focus: (point: CGPoint, strength: CGFloat)
    let fade: Double

    static let spacing: CGFloat = 22
    private static let restRadius: CGFloat = 1.15
    private static let growth: CGFloat = 3.1
    /// How far from the pointer, in points, dots still feel it.
    private static let reach: CGFloat = 170
    /// How far a dot leans away from the pointer at most.
    private static let lean: CGFloat = 7
    private static let colours = [LoopLook.lime, LoopLook.sky, LoopLook.rope, LoopLook.sage, LoopLook.terracottaSoft]

    func draw(in context: inout GraphicsContext) {
        let visible = 1 - min(1, max(0, fade))
        guard visible > 0 else { return }
        context.opacity = visible
        var resting = Path()
        let columns = Int(size.width / Self.spacing) + 1, rows = Int(size.height / Self.spacing) + 1
        let offset = CGPoint(x: (size.width - CGFloat(columns - 1) * Self.spacing) / 2,
                             y: (size.height - CGFloat(rows - 1) * Self.spacing) / 2)
        for row in 0..<rows {
            for column in 0..<columns {
                let home = CGPoint(x: offset.x + CGFloat(column) * Self.spacing, y: offset.y + CGFloat(row) * Self.spacing)
                let pull = influence(at: home)
                guard pull > 0.02 else {
                    resting.addEllipse(in: dot(at: home, radius: Self.restRadius))
                    continue
                }
                let colour = Self.colours[(row * 7 + column * 3) % Self.colours.count]
                context.fill(Path(ellipseIn: dot(at: leaned(home, by: pull), radius: Self.restRadius + Self.growth * pull)),
                             with: .color(colour.opacity(0.18 + 0.8 * Double(pull))))
            }
        }
        // A slow breath across the resting dots keeps the field alive between visits.
        let breath = 0.1 + 0.025 * sin(time * 0.9)
        context.fill(resting, with: .color(LoopLook.ink.opacity(breath)))
    }

    /// 0 far from the pointer, rising smoothly to 1 under it.
    private func influence(at point: CGPoint) -> CGFloat {
        let distance = hypot(point.x - focus.point.x, point.y - focus.point.y)
        let near = max(0, 1 - distance / Self.reach)
        return near * near * (3 - 2 * near) * focus.strength
    }

    private func leaned(_ point: CGPoint, by pull: CGFloat) -> CGPoint {
        let dx = point.x - focus.point.x, dy = point.y - focus.point.y
        let distance = max(1, hypot(dx, dy))
        return CGPoint(x: point.x + dx / distance * Self.lean * pull, y: point.y + dy / distance * Self.lean * pull)
    }

    private func dot(at center: CGPoint, radius: CGFloat) -> CGRect {
        CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    }
}
