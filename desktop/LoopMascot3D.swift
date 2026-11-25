// Lasso's mascot in 3D, as the website rework draws it (assets/js/mascot3d.js
// in the site trial), here in SceneKit: the avatar kit's silhouette extruded
// into a soft, rounded figure that sways, turns to follow the pointer,
// blinks, and spins. A click spins it, and it spins on its own every few
// seconds; each time it passes edge-on it comes round in the kit's next
// colour and expression. With Reduce Motion it stays still and changes only
// when clicked. The shape and eyes are the open-bot-avatar kit's (MIT,
// Dominik Scholz).

import Cocoa
import SceneKit
import SwiftUI

struct LoopMascot3D: NSViewRepresentable {
    /// A look to keep, by palette and expression, for a mascot that should not spin on its own.
    var look: (palette: LoopMascotView.Palette, expression: LoopMascotView.Expression)? = nil
    /// Seconds after it appears that it pops into place, growing from nothing; nil for already there.
    var entrance: TimeInterval? = nil

    func makeNSView(context: Context) -> LoopMascotView { LoopMascotView(look: look, entrance: entrance) }
    func updateNSView(_ view: LoopMascotView, context: Context) {}
}

final class LoopMascotView: SCNView {
    /// The kit's colours: the body's and its eyes'.
    private static let palettes: [(body: Int, eye: Int)] = [
        (0x8EC5F4, 0x0B1A28), (0xD4F75C, 0x20281B), (0xC96749, 0x201A17), (0xD7BD85, 0x30291E),
        (0x91A984, 0x20281B), (0x2F4322, 0xF1EACB), (0x252923, 0xF1EACB),
    ]
    enum Expression: CaseIterable { case idle, happy, thinking }
    /// The kit's colours by name, in the order `palettes` lists them.
    enum Palette: Int { case sky, lime, terracotta, rope, sage, forest, ink }

    /// The order the looks come round in, as on the website: each colour with each expression.
    private static let looks: [(palette: Int, expression: Expression)] =
        (0..<(palettes.count * Expression.allCases.count)).map { ($0 % palettes.count, Expression.allCases[$0 % Expression.allCases.count]) }

    // The drawing's centre and the figure's depth, in the kit's 100 by 100 units.
    private static let centre = CGPoint(x: 50, y: 52)
    private static let depth: CGFloat = 23
    private static let body = "M33 18C37 15 42 22 50 22C58 22 63 15 67 18C71 21 72 29 74 34C78 36 82 33 85 31C89 28 92 32 90 37C87 43 80 46 75 47L75 65C75 78 65 86 50 86C35 86 25 78 25 65L25 47C20 46 13 43 10 37C8 32 11 28 15 31C18 33 22 36 26 34C28 29 29 21 33 18Z"

    /// Sway, spin and the pointer turn the figure; the thinking tilt turns what is inside it.
    private let figure = SCNNode()
    private let tilt = SCNNode()
    private var eyes = SCNNode()
    private let skin = SCNMaterial()
    private let eyeSkin = SCNMaterial()

    private var index = 0
    private var expression = Expression.idle
    // The spin, in radians, on a spring toward its target.
    private var angle: CGFloat = 0
    private var velocity: CGFloat = 0
    private var target: CGFloat = 0
    private var lastHalf = 0
    // A small squash as the look changes.
    private var pop: CGFloat = 1
    private var popVelocity: CGFloat = 0
    // Where the pointer is, eased.
    private var lookX: CGFloat = 0
    private var lookY: CGFloat = 0
    private var tiltZ: CGFloat = 0
    private var blink: CGFloat = 1
    private var blinkUntil: TimeInterval = 0
    private var nextBlink = CACurrentMediaTime() + 2.2
    private var lastInput = CACurrentMediaTime()
    private var last = CACurrentMediaTime()
    private var clock: Timer?
    private let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    /// It spins on its own after this long without being clicked.
    private static let auto: TimeInterval = 7
    /// A mascot given a look keeps it: it does not spin by itself, and a click only waves it round.
    private let fixed: Bool
    /// Its size as it pops in, on a spring that overshoots a little.
    private var grow: CGFloat = 1
    private var growVelocity: CGFloat = 0
    private let growAt: TimeInterval?

    init(look: (palette: Palette, expression: Expression)? = nil, entrance: TimeInterval? = nil) {
        fixed = look != nil
        growAt = entrance.map { CACurrentMediaTime() + $0 }
        if entrance != nil { grow = 0.001 }
        super.init(frame: .zero, options: nil)
        backgroundColor = .clear
        antialiasingMode = .multisampling4X
        rendersContinuously = true
        scene = makeScene()
        if let look {
            index = Self.looks.firstIndex { $0.palette == look.palette.rawValue && $0.expression == look.expression } ?? 0
        }
        apply(Self.looks[index])
        lastHalf = Self.half(angle)
    }

    required init?(coder: NSCoder) { nil }

    override var isOpaque: Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        clock?.invalidate()
        clock = nil
        guard window != nil else { return }
        last = CACurrentMediaTime()
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        clock = timer
    }

    override func mouseDown(with event: NSEvent) {
        spin(by: velocity < -0.5 ? -1 : 1)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    // MARK: The scene

    private func makeScene() -> SCNScene {
        let scene = SCNScene()
        scene.background.contents = NSColor.clear
        scene.lightingEnvironment.contents = Self.room()
        scene.lightingEnvironment.intensity = 0.7

        for material in [skin, eyeSkin] {
            material.lightingModel = .physicallyBased
            material.metalness.contents = 0.0
        }
        skin.roughness.contents = 0.46
        skin.clearCoat.contents = 0.55
        skin.clearCoatRoughness.contents = 0.32
        eyeSkin.roughness.contents = 0.5
        eyeSkin.clearCoat.contents = 0.35
        eyeSkin.clearCoatRoughness.contents = 0.45

        let shape = SCNShape(path: Self.bodyPath(), extrusionDepth: Self.depth)
        shape.chamferMode = .both
        shape.chamferRadius = 6
        shape.chamferProfile = Self.roundedProfile()
        shape.materials = [skin]
        tilt.addChildNode(SCNNode(geometry: shape))
        figure.addChildNode(tilt)
        scene.rootNode.addChildNode(figure)

        func light(_ type: SCNLight.LightType, _ intensity: CGFloat, at position: SCNVector3?) {
            let light = SCNLight()
            light.type = type
            light.intensity = intensity
            let node = SCNNode()
            node.light = light
            if let position {
                node.position = position
                node.look(at: SCNVector3Zero)
            }
            scene.rootNode.addChildNode(node)
        }
        light(.directional, 850, at: SCNVector3(-60, 90, 120))
        light(.directional, 650, at: SCNVector3(80, 40, -120))
        light(.ambient, 160, at: nil)

        let camera = SCNCamera()
        camera.fieldOfView = 28
        camera.zNear = 10
        camera.zFar = 1000
        let eye = SCNNode()
        eye.camera = camera
        eye.position = SCNVector3(0, 0, 228)
        scene.rootNode.addChildNode(eye)
        pointOfView = eye
        return scene
    }

    /// The kit's outline, centred and the right way up. It is written with
    /// moves, lines and cubic curves only, read as the website reads it.
    private static func bodyPath() -> NSBezierPath {
        let pattern = try! NSRegularExpression(pattern: "[MLCZ]|-?[0-9]*\\.?[0-9]+")
        let tokens = pattern.matches(in: body, range: NSRange(body.startIndex..., in: body))
            .compactMap { Range($0.range, in: body).map { String(body[$0]) } }
        let path = NSBezierPath()
        var index = 0
        var command = "M"
        func number() -> CGFloat {
            defer { index += 1 }
            return index < tokens.count ? CGFloat(Double(tokens[index]) ?? 0) : 0
        }
        func point() -> NSPoint {
            let x = number(), y = number()
            return NSPoint(x: x - centre.x, y: centre.y - y)
        }
        while index < tokens.count {
            if "MLCZ".contains(tokens[index]) {
                command = tokens[index]
                index += 1
            }
            switch command {
            case "M": path.move(to: point())
            case "L": path.line(to: point())
            case "C":
                let first = point(), second = point(), end = point()
                path.curve(to: end, controlPoint1: first, controlPoint2: second)
            default:
                path.close()
            }
        }
        path.flatness = 0.15
        return path
    }

    /// Rounded edges, not cut ones.
    private static func roundedProfile() -> NSBezierPath {
        let profile = NSBezierPath()
        profile.move(to: NSPoint(x: 0, y: 1))
        profile.curve(to: NSPoint(x: 1, y: 0), controlPoint1: NSPoint(x: 0.55, y: 1), controlPoint2: NSPoint(x: 1, y: 0.55))
        return profile
    }

    /// A soft room for the figure's sheen: light above, darker below.
    private static func room() -> NSImage {
        let size = NSSize(width: 256, height: 128)
        return NSImage(size: size, flipped: false) { rect in
            NSGradient(colors: [NSColor(white: 0.32, alpha: 1), NSColor(white: 0.78, alpha: 1), NSColor(white: 1, alpha: 1)],
                       atLocations: [0, 0.55, 1], colorSpace: .sRGB)?.draw(in: rect, angle: 90)
            return true
        }
    }

    // MARK: Looks

    private func apply(_ look: (palette: Int, expression: Expression)) {
        let palette = Self.palettes[look.palette]
        skin.diffuse.contents = Self.color(palette.body)
        eyeSkin.diffuse.contents = Self.color(palette.eye)
        expression = look.expression
        eyes.removeFromParentNode()
        eyes = Self.eyes(look.expression, material: eyeSkin)
        tilt.addChildNode(eyes)
    }

    private static func color(_ hex: Int) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// The eyes for each expression, in the kit's own coordinates, pressed flat into the face.
    private static func eyes(_ expression: Expression, material: SCNMaterial) -> SCNNode {
        let group = SCNNode()
        func place(_ x: CGFloat, _ y: CGFloat) -> SCNVector3 { SCNVector3(x - centre.x, centre.y - y, 0) }
        func pill(_ width: CGFloat, _ height: CGFloat, at position: SCNVector3) {
            let capsule = SCNCapsule(capRadius: width / 2, height: height)
            capsule.materials = [material]
            let node = SCNNode(geometry: capsule)
            node.position = position
            node.scale = SCNVector3(1, 1, 0.5)
            group.addChildNode(node)
        }
        func arc(_ from: CGPoint, _ control: CGPoint, _ to: CGPoint, width: CGFloat) {
            let bead = SCNSphere(radius: width / 2)
            bead.segmentCount = 16
            bead.materials = [material]
            let steps = 32
            for step in 0...steps {
                let t = CGFloat(step) / CGFloat(steps)
                let x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * control.x + t * t * to.x
                let y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * control.y + t * t * to.y
                let node = SCNNode(geometry: bead)
                node.position = place(x, y)
                node.scale = SCNVector3(1, 1, 0.5)
                group.addChildNode(node)
            }
        }
        switch expression {
        case .happy:
            arc(CGPoint(x: 36.91, y: 61.75), CGPoint(x: 41.5, y: 52.63), CGPoint(x: 46.09, y: 61.75), width: 3.83)
            arc(CGPoint(x: 53.91, y: 61.75), CGPoint(x: 58.5, y: 52.63), CGPoint(x: 63.09, y: 61.75), width: 3.83)
        case .thinking:
            pill(6.38, 16, at: place(42.8, 58.4))
            pill(6.38, 15.3, at: place(59.8, 58.6))
        case .idle:
            pill(6.38, 17.54, at: place(41.5, 60))
            pill(6.38, 17.54, at: place(58.5, 60))
        }
        group.position.z = depth / 2 - 0.35
        return group
    }

    // MARK: Motion

    private func spin(by turns: CGFloat) {
        lastInput = CACurrentMediaTime()
        target = (target / (2 * .pi)).rounded() * 2 * .pi + turns * 2 * .pi
    }

    /// Which half turn the figure is on; it changes as the figure passes edge-on.
    private static func half(_ angle: CGFloat) -> Int { Int(((angle - .pi / 2) / .pi).rounded(.down)) }

    private func tick() {
        guard window?.occlusionState.contains(.visible) == true else { return }
        let now = CACurrentMediaTime()
        let dt = CGFloat(min(0.05, now - last))
        last = now
        let t = CGFloat(now)

        if !still, !fixed, now - lastInput > Self.auto, abs(target - angle) < 0.01 { spin(by: 1) }

        // A spring toward the target: quick, and never overshooting much.
        let k: CGFloat = 34
        let damping = 2 * sqrt(k) * 0.92
        velocity += (k * (target - angle) - damping * velocity) * dt
        angle += velocity * dt

        let half = Self.half(angle)
        if half != lastHalf && fixed {
            lastHalf = half
        } else if half != lastHalf {
            lastHalf = half
            index = (index + (velocity >= 0 ? 1 : Self.looks.count - 1)) % Self.looks.count
            apply(Self.looks[index])
            popVelocity -= 2.2
        }
        popVelocity += (-90 * (pop - 1) - 12 * popVelocity) * dt
        pop += popVelocity * dt

        let aim = pointer()
        lookX += (aim.x - lookX) * min(1, dt * 4)
        lookY += (aim.y - lookY) * min(1, dt * 4)
        let sway = still ? 0 : sin(t * 0.7) * 0.12
        figure.eulerAngles.y = angle + sway + lookX * 0.42
        figure.eulerAngles.x = lookY * 0.28 + (still ? 0 : sin(t * 0.9) * 0.03)
        figure.position.y = still ? 0 : sin(t * 1.5) * 1.6
        if let growAt, now >= growAt {
            growVelocity += (-150 * (grow - 1) - 13 * growVelocity) * dt
            grow += growVelocity * dt
        }
        let squash = 1 / sqrt(max(0.2, pop))
        let size = max(0.001, grow)
        figure.scale = SCNVector3(squash * size, pop * size, squash * size)

        let wantTilt: CGFloat = expression == .thinking ? 0.09 : 0
        tiltZ += (wantTilt - tiltZ) * min(1, dt * 6)
        tilt.eulerAngles.z = tiltZ

        if !still && expression != .happy {
            if now > nextBlink {
                blinkUntil = now + 0.13
                nextBlink = now + 2.4 + Double.random(in: 0...2.8)
                if Double.random(in: 0...1) < 0.25 { nextBlink = now + 0.32 }
            }
            let want: CGFloat = now < blinkUntil ? 0.12 : 1
            blink += (want - blink) * min(1, dt * 28)
        } else {
            blink = 1
        }
        eyes.scale = SCNVector3(1, blink, 1)
    }

    /// Where the pointer is from the figure, -1 to 1 each way, measured
    /// against the window as the website measures it against the page.
    private func pointer() -> CGPoint {
        guard let window, bounds.width > 0 else { return .zero }
        let mouse = convert(window.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
        let size = window.frame.size
        let x = (mouse.x - bounds.midX) / (size.width * 0.5)
        // The view counts up the screen, the page down it.
        let y = (bounds.midY - mouse.y) / (size.height * 0.6)
        return CGPoint(x: min(1, max(-1, x)), y: min(1, max(-1, y)))
    }
}
