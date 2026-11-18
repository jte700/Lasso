// The sidebar's icons, drawn as BeUI's file tree draws them: Lucide's line
// icons on their 24-point grid, stroked 2 points wide there and rounded at
// the ends, at 16 points. The shapes are Lucide's own (ISC licence, Lucide
// Contributors; parts MIT, Feather), read from their SVG path data.

import SwiftUI

enum RanchLucide: String {
    case layers, history, link, triangleAlert, network, folder, folderOpen, chevronRight, circlePlus, settings, file
    case search, plus, panelLeft
    case share, eyeOff, highlighter, clock, x, mail, fileText

    /// The icon's shapes as SVG path data on Lucide's 24 by 24 grid.
    var paths: [String] {
        switch self {
        case .layers:
            return ["m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
                    "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
                    "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"]
        case .history:
            return ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"]
        case .link:
            return ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
                    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"]
        case .triangleAlert:
            return ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"]
        case .network:
            return [Self.rect(16, 16, 6, 6, 1), Self.rect(2, 16, 6, 6, 1), Self.rect(9, 2, 6, 6, 1),
                    "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3", "M12 12V8"]
        case .folder:
            return ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"]
        case .folderOpen:
            return ["m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"]
        case .chevronRight:
            return ["m9 18 6-6-6-6"]
        case .circlePlus:
            return [Self.circle(12, 12, 10), "M8 12h8", "M12 8v8"]
        case .settings:
            return ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
                    Self.circle(12, 12, 3)]
        case .search:
            return [Self.circle(11, 11, 8), "m21 21-4.3-4.3"]
        case .plus:
            return ["M5 12h14", "M12 5v14"]
        case .panelLeft:
            return [Self.rect(3, 3, 18, 18, 2), "M9 3v18"]
        case .share:
            return ["M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8", "M16 6 12 2 8 6", "M12 2v13"]
        case .eyeOff:
            return ["M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
                    "M14.084 14.158a3 3 0 0 1-4.242-4.242",
                    "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
                    "m2 2 20 20"]
        case .highlighter:
            return ["m9 11-6 6v3h9l3-3", "m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"]
        case .clock:
            return [Self.circle(12, 12, 10), "M12 6v6l4 2"]
        case .x:
            return ["M18 6 6 18", "m6 6 12 12"]
        case .mail:
            return [Self.rect(2, 4, 20, 16, 2), "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"]
        case .fileText:
            return ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4",
                    "M10 9H8", "M16 13H8", "M16 17H8"]
        case .file:
            return ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"]
        }
    }

    /// An SVG rect with rounded corners, as path data.
    private static func rect(_ x: Double, _ y: Double, _ width: Double, _ height: Double, _ r: Double) -> String {
        "M\(x + r) \(y)h\(width - 2 * r)a\(r) \(r) 0 0 1 \(r) \(r)v\(height - 2 * r)a\(r) \(r) 0 0 1 -\(r) \(r)"
            + "h-\(width - 2 * r)a\(r) \(r) 0 0 1 -\(r) -\(r)v-\(height - 2 * r)a\(r) \(r) 0 0 1 \(r) -\(r)Z"
    }

    /// An SVG circle, as path data.
    private static func circle(_ cx: Double, _ cy: Double, _ r: Double) -> String {
        "M\(cx - r) \(cy)a\(r) \(r) 0 1 0 \(2 * r) 0a\(r) \(r) 0 1 0 -\(2 * r) 0Z"
    }
}

/// A Lucide icon, stroked as Lucide strokes it.
struct RanchLucideIcon: View {
    let icon: RanchLucide
    var size: CGFloat = 16
    var color: Color

    var body: some View {
        RanchSVGShape(paths: icon.paths)
            .stroke(color, style: StrokeStyle(lineWidth: 2 * size / 24, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
    }
}

/// SVG path data on a 24 by 24 grid, scaled to the frame it is drawn in.
struct RanchSVGShape: Shape {
    let paths: [String]

    func path(in rect: CGRect) -> Path {
        var whole = Path()
        for data in paths { whole.addPath(RanchSVGPath.parse(data)) }
        let scale = min(rect.width, rect.height) / 24
        return whole.applying(CGAffineTransform(scaleX: scale, y: scale)
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}

/// Reads SVG path data: moves, lines, curves and arcs, absolute and relative.
enum RanchSVGPath {
    private static var cache: [String: Path] = [:]
    private static let tokens = try! NSRegularExpression(pattern: "[a-zA-Z]|-?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE]-?[0-9]+)?")

    static func parse(_ data: String) -> Path {
        if let known = cache[data] { return known }
        let parts = tokens.matches(in: data, range: NSRange(data.startIndex..., in: data))
            .compactMap { Range($0.range, in: data).map { String(data[$0]) } }
        var path = Path()
        var index = 0
        var command: Character = "M"
        var current = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?
        func isCommand(_ token: String) -> Bool { token.first.map { $0.isLetter && $0 != "e" && $0 != "E" } ?? false }
        func number() -> CGFloat {
            defer { index += 1 }
            return index < parts.count ? CGFloat(Double(parts[index]) ?? 0) : 0
        }
        while index < parts.count {
            if isCommand(parts[index]) {
                command = Character(parts[index])
                index += 1
                if command == "Z" || command == "z" {
                    path.closeSubpath()
                    current = start
                    lastControl = nil
                    continue
                }
            }
            guard index < parts.count, !isCommand(parts[index]) else { continue }
            let relative = command.isLowercase
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y) }
            switch command.uppercased() {
            case "M":
                current = point(number(), number())
                start = current
                path.move(to: current)
                // Further pairs after a move are lines.
                command = relative ? "l" : "L"
                lastControl = nil
            case "L":
                current = point(number(), number())
                path.addLine(to: current)
                lastControl = nil
            case "H":
                let x = number()
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
                lastControl = nil
            case "V":
                let y = number()
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
                lastControl = nil
            case "C":
                let first = point(number(), number()), second = point(number(), number()), end = point(number(), number())
                path.addCurve(to: end, control1: first, control2: second)
                lastControl = second
                current = end
            case "S":
                let mirrored = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let second = point(number(), number()), end = point(number(), number())
                path.addCurve(to: end, control1: mirrored, control2: second)
                lastControl = second
                current = end
            case "Q":
                let control = point(number(), number()), end = point(number(), number())
                path.addQuadCurve(to: end, control: control)
                lastControl = control
                current = end
            case "A":
                let rx = number(), ry = number(), rotation = number(), large = number() != 0, sweep = number() != 0
                let end = point(number(), number())
                addArc(&path, from: current, to: end, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
                current = end
                lastControl = nil
            default:
                index += 1
            }
        }
        cache[data] = path
        return path
    }

    /// An SVG arc, from its end points to its centre, drawn as cubic curves of at most a quarter turn.
    private static func addArc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx: CGFloat, ry: CGFloat,
                               rotation: CGFloat, large: Bool, sweep: Bool) {
        var rx = abs(rx), ry = abs(ry)
        guard rx > 0, ry > 0, p0 != p1 else { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy
        let y1 = -sinPhi * dx + cosPhi * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var factor = sqrt(max(0, numerator / denominator))
        if large == sweep { factor = -factor }
        let cx1 = factor * rx * y1 / ry
        let cy1 = -factor * ry * x1 / rx
        let cx = cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2
        let cy = sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let sign: CGFloat = ux * vy - uy * vx < 0 ? -1 : 1
            let dot = (ux * vx + uy * vy) / (sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy))
            return sign * acos(min(1, max(-1, dot)))
        }
        let theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        let segments = Int(ceil(abs(delta) / (.pi / 2)))
        let step = delta / CGFloat(segments)
        let k = 4 / 3 * tan(step / 4)
        func on(_ t: CGFloat) -> CGPoint {
            CGPoint(x: cx + rx * cos(t) * cosPhi - ry * sin(t) * sinPhi, y: cy + rx * cos(t) * sinPhi + ry * sin(t) * cosPhi)
        }
        func tangent(_ t: CGFloat) -> CGPoint {
            CGPoint(x: -rx * sin(t) * cosPhi - ry * cos(t) * sinPhi, y: -rx * sin(t) * sinPhi + ry * cos(t) * cosPhi)
        }
        var t = theta
        for _ in 0..<segments {
            let a = on(t), b = on(t + step), ta = tangent(t), tb = tangent(t + step)
            path.addCurve(to: b, control1: CGPoint(x: a.x + k * ta.x, y: a.y + k * ta.y),
                          control2: CGPoint(x: b.x - k * tb.x, y: b.y - k * tb.y))
            t += step
        }
    }
}
