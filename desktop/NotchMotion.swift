import Cocoa

/// A spring in SwiftUI's terms: `response` is the undamped period in seconds,
/// and a damping fraction of 1 settles without overshooting.
struct NotchSpringStyle {
    let response: Double
    let dampingFraction: Double

    /// Opening runs about 6 percent past its size and springs back, like the
    /// iPhone's Dynamic Island.
    static let open = NotchSpringStyle(response: 0.42, dampingFraction: 0.66)
    /// Closing tucks back into the camera housing without a bounce.
    static let close = NotchSpringStyle(response: 0.26, dampingFraction: 1)
    /// Content arrives once the surface has room for it, and leaves ahead of it.
    static let contentIn = NotchSpringStyle(response: 0.3, dampingFraction: 1)
    static let contentOut = NotchSpringStyle(response: 0.14, dampingFraction: 1)
}

/// One animated value. A new target keeps the current velocity, so reversing
/// mid-flight turns the motion around instead of restarting it from rest.
struct NotchSpring {
    // Fixed substeps keep the integration stable and alike at 60 and 120 Hz.
    private static let substep = 1.0 / 480
    let value: CGFloat
    let target: CGFloat
    let velocity: CGFloat

    init(_ value: CGFloat, target: CGFloat? = nil, velocity: CGFloat = 0) {
        self.value = value
        self.target = target ?? value
        self.velocity = velocity
    }

    func retargeted(to target: CGFloat) -> NotchSpring {
        NotchSpring(value, target: target, velocity: velocity)
    }

    func advanced(by elapsed: TimeInterval, style: NotchSpringStyle) -> NotchSpring {
        let stiffness = pow(2 * .pi / style.response, 2)
        let friction = 4 * .pi * style.dampingFraction / style.response
        let goal = Double(target)
        var position = Double(value), speed = Double(velocity), remaining = max(0, elapsed)
        while remaining > 0 {
            let step = min(remaining, Self.substep)
            speed += (-stiffness * (position - goal) - friction * speed) * step
            position += speed * step
            remaining -= step
        }
        return NotchSpring(CGFloat(position), target: target, velocity: CGFloat(speed))
    }

    /// Resting within `tolerance` of the target and barely moving.
    func isSettled(within tolerance: CGFloat) -> Bool {
        abs(value - target) < tolerance && abs(velocity) < tolerance * 10
    }
}

/// The black body's frame as three springs. Its top stays on the display edge
/// while it grows out of, or tucks back into, the camera housing.
struct NotchBodyMotion {
    let top: CGFloat
    let minX: NotchSpring
    let width: NotchSpring
    let height: NotchSpring

    init(from start: NSRect, to target: NSRect) {
        self.init(top: target.maxY,
                  minX: NotchSpring(start.minX, target: target.minX),
                  width: NotchSpring(start.width, target: target.width),
                  height: NotchSpring(start.height, target: target.height))
    }

    private init(top: CGFloat, minX: NotchSpring, width: NotchSpring, height: NotchSpring) {
        self.top = top
        self.minX = minX
        self.width = width
        self.height = height
    }

    var frame: NSRect {
        let height = max(0, height.value)
        return NSRect(x: minX.value, y: top - height, width: max(0, width.value), height: height)
    }

    var target: NSRect {
        NSRect(x: minX.target, y: top - height.target, width: width.target, height: height.target)
    }

    /// Within half a point, which a Retina display rounds onto the target.
    var isSettled: Bool {
        [minX, width, height].allSatisfy { $0.isSettled(within: 0.5) }
    }

    func retargeted(to target: NSRect) -> NotchBodyMotion {
        NotchBodyMotion(top: target.maxY, minX: minX.retargeted(to: target.minX),
                        width: width.retargeted(to: target.width), height: height.retargeted(to: target.height))
    }

    func advanced(by elapsed: TimeInterval, style: NotchSpringStyle) -> NotchBodyMotion {
        NotchBodyMotion(top: top, minX: minX.advanced(by: elapsed, style: style),
                        width: width.advanced(by: elapsed, style: style),
                        height: height.advanced(by: elapsed, style: style))
    }
}

/// Calls back once per display refresh while the notch moves: in step with
/// the panel's display through CADisplayLink (120 Hz on ProMotion), or a
/// 120 Hz timer before macOS 14.
final class NotchFrameClock: NSObject {
    private let tick: () -> Void
    private var link: AnyObject?
    private var timer: Timer?

    init(view: NSView, tick: @escaping () -> Void) {
        self.tick = tick
        super.init()
        if #available(macOS 14.0, *) {
            let link = view.displayLink(target: self, selector: #selector(fire))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            self.link = link
        } else {
            let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in self?.tick() }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        }
    }

    @objc private func fire() { tick() }

    /// The display link retains its target, so every clock must be invalidated.
    func invalidate() {
        if #available(macOS 14.0, *) { (link as? CADisplayLink)?.invalidate() }
        timer?.invalidate()
        link = nil
        timer = nil
    }
}
