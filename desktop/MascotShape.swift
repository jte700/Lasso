import CoreGraphics

// The website's mascot as vector paths, shared by the app icon
// (scripts/render-app-icon.swift, compiled with this file) and the small
// marks the app draws where Lasso shows its logo (MascotMark.swift).

extension CGPath {
    func transformed(_ transform: CGAffineTransform) -> CGPath {
        var t = transform
        return copy(using: &t)!
    }
}

/// Rounds concave corners (grow, then shrink) and convex ones (shrink, then grow).
func rounded(_ path: CGPath, radius r: CGFloat) -> CGPath {
    func band(_ p: CGPath) -> CGPath { p.copy(strokingWithWidth: 2 * r, lineCap: .round, lineJoin: .round, miterLimit: 1) }
    func grow(_ p: CGPath) -> CGPath { p.union(band(p)) }
    func shrink(_ p: CGPath) -> CGPath { p.subtracting(band(p)) }
    return grow(shrink(shrink(grow(path))))
}

/// The mascot in the SVG's own space: a 100 square, y down.
enum Mascot {
    /// The SVG's slight shear, shared by the body and the eyes.
    static func shear(_ tx: CGFloat, _ ty: CGFloat) -> CGAffineTransform {
        CGAffineTransform(a: 0.9553, b: -0.0587, c: 0, d: 0.9801, tx: tx, ty: ty)
    }

    /// The outline: hat crown, brim tips raised at the sides, and the face.
    static let outline: CGPath = {
        typealias Curve = (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)
        func add(_ p: CGMutablePath, _ curves: [Curve]) {
            curves.forEach { p.addCurve(to: CGPoint(x: $0.4, y: $0.5), control1: CGPoint(x: $0.0, y: $0.1),
                                        control2: CGPoint(x: $0.2, y: $0.3)) }
        }
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 33, y: 18))
        add(p, [(37, 15, 42, 22, 50, 22), (58, 22, 63, 15, 67, 18), (71, 21, 72, 29, 74, 34),
                (78, 36, 82, 33, 85, 31), (89, 28, 92, 32, 90, 37), (87, 43, 80, 46, 75, 47)])
        p.addLine(to: CGPoint(x: 75, y: 65))
        add(p, [(75, 78, 65, 86, 50, 86), (35, 86, 25, 78, 25, 65)])
        p.addLine(to: CGPoint(x: 25, y: 47))
        add(p, [(20, 46, 13, 43, 10, 37), (8, 32, 11, 28, 15, 31), (18, 33, 22, 36, 26, 34), (28, 29, 29, 21, 33, 18)])
        p.closeSubpath()
        return p
    }()

    static let body = rounded(outline.transformed(shear(1.2, 3.0)), radius: 2.2)

    /// Oval eyes for a head turned part way: both slide toward the turn, sit
    /// a little closer, and the far eye narrows as it wraps round the head.
    static func eyes(turn: CGFloat) -> CGPath {
        let spacing = 17 * (1 - abs(turn) * 0.18)
        let mid = CGPoint(x: 50 + turn * 7, y: 58.6)
        let path = CGMutablePath()
        for side in [-1, 1] as [CGFloat] {
            let far = side * turn < 0
            let width = 6.6 * (far ? 1 - abs(turn) * 0.38 : 1 + abs(turn) * 0.06)
            let height = 15.6 * (far ? 1 - abs(turn) * 0.08 : 1)
            let x = mid.x + side * spacing / 2
            path.addRoundedRect(in: CGRect(x: x - width / 2, y: mid.y - height / 2, width: width, height: height),
                                cornerWidth: width / 2, cornerHeight: width / 2)
        }
        return path.transformed(shear(1.16, 2.93))
    }

    /// The body with its eyes cut out, for one-colour marks: facing front,
    /// fitted into a unit square (y down) and centred in it.
    static let mark: CGPath = {
        let cut = body.subtracting(eyes(turn: 0))
        let bounds = cut.boundingBox
        let scale = 1 / max(bounds.width, bounds.height)
        let fitted = CGAffineTransform(translationX: (1 - bounds.width * scale) / 2, y: (1 - bounds.height * scale) / 2)
            .scaledBy(x: scale, y: scale)
            .translatedBy(x: -bounds.minX, y: -bounds.minY)
        return cut.transformed(fitted)
    }()
}
