// How a switch's knob moves, after the Toggle Switch motion component: a
// position spring carries the knob across with a small bounce, and a stretch
// spring, kicked on every flip, makes the knob grow long toward where it is
// going and round back up as it lands. The springs and the kick are the
// component's own, so the knob moves the same way.

import Foundation

struct SwitchSpring {
    var x: Double
    var v = 0.0
    var t: Double
    let k: Double
    let c: Double

    init(_ x: Double, stiffness k: Double, damping c: Double) {
        self.x = x
        t = x
        self.k = k
        self.c = c
    }

    mutating func step(_ dt: Double) {
        let a = -k * (x - t) - c * v
        v += a * dt
        x += v * dt
    }

    var isResting: Bool { abs(x - t) < 0.0005 && abs(v) < 0.005 }

    mutating func snap() {
        x = t
        v = 0
    }
}

final class SwitchMotion {
    /// Stiffness and damping of the knob's travel.
    static let travel = (stiffness: 320.0, damping: 18.0)
    /// Stiffness and damping of the knob's stretch, and the push each flip gives it.
    static let stretch = (stiffness: 300.0, damping: 20.0)
    static let kick = 60.0
    /// How much longer the knob grows at most, as a share of its width (10 of 26 points).
    static let stretchShare = 10.0 / 26.0

    private(set) var position = SwitchSpring(0, stiffness: travel.stiffness, damping: travel.damping)
    private(set) var stretch = SwitchSpring(0, stiffness: stretch.stiffness, damping: stretch.damping)
    /// Where the knob is headed; nil until the switch is first shown.
    private(set) var isOn: Bool?
    private var lastTime: Double?

    /// Switches rebuilt with each panel refresh pick up the motion their
    /// predecessor started, by key.
    private static var kept: [String: SwitchMotion] = [:]
    static func kept(for key: String) -> SwitchMotion {
        if let motion = kept[key] { return motion }
        let motion = SwitchMotion()
        kept[key] = motion
        return motion
    }

    init() {}

    var isMoving: Bool { !(position.isResting && stretch.isResting) }

    /// Heads for on or off. A flip that is not animated lands at once.
    func set(on: Bool, animated: Bool) {
        let first = isOn == nil
        guard isOn != on else { return }
        isOn = on
        position.t = on ? 1 : 0
        stretch.t = 0
        if animated && !first {
            stretch.v = Self.kick
        } else {
            position.snap()
            stretch.snap()
            lastTime = nil
        }
    }

    /// Steps both springs up to a clock time, at most a thirtieth of a second
    /// at once, in four slices, as the component's engine does. Several views
    /// sharing one motion can all call this without moving it twice.
    func advance(to now: Double) {
        guard let last = lastTime else { lastTime = now; return }
        lastTime = now
        let dt = min(max(now - last, 0), 1.0 / 30)
        guard dt > 0 else { return }
        for _ in 0..<4 {
            position.step(dt / 4)
            stretch.step(dt / 4)
        }
        if !isMoving {
            position.snap()
            stretch.snap()
            lastTime = nil
        }
    }

    /// How far along the knob is, 0 off and 1 on, before any bounce is cut off.
    var progress: Double { min(max(position.x, 0), 1) }

    /// The knob's left edge and width inside a track, given the knob's
    /// diameter and how far it travels. The edge in front leads.
    func knob(diameter: Double, travel: Double) -> (x: Double, width: Double) {
        let grow = min(max(stretch.x, 0), 1) * diameter * Self.stretchShare
        let x = position.x * travel
        return ((isOn ?? false) ? x - grow * progress : x, diameter + grow)
    }
}
