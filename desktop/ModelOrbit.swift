// Rotation and zoom for 3D wireframe previews (STEP), the native twin of
// public/model-orbit.js: a turntable camera keeps model +Z up on screen, the
// projection is orthographic, and cylinder outlines follow the camera.
import Cocoa
import simd

private func modelNumber(_ value: Any?) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
          value.doubleValue.isFinite else { return nil }
    return value.doubleValue
}

private func modelVector(_ value: Any?) -> SIMD3<Double>? {
    guard let values = value as? [Any], values.count == 3 else { return nil }
    let numbers = values.compactMap(modelNumber)
    return numbers.count == 3 ? SIMD3(numbers[0], numbers[1], numbers[2]) : nil
}

/// Screen axes of an orthographic camera.
struct AssistModelAxes {
    let right: SIMD3<Double>
    let up: SIMD3<Double>
    let toward: SIMD3<Double>

    func project(_ point: SIMD3<Double>) -> NSPoint {
        NSPoint(x: simd_dot(point, right), y: simd_dot(point, up))
    }

    /// A model point moved by a screen offset, at the same depth.
    func shift(_ point: SIMD3<Double>, by offset: NSPoint) -> SIMD3<Double> {
        point + right * Double(offset.x) + up * Double(offset.y)
    }
}

struct AssistModelCamera: Equatable {
    let azimuth: Double
    let elevation: Double

    /// Looking down (1, 1, 1), where the three model axes foreshorten equally.
    static let isometric = AssistModelCamera(azimuth: .pi / 4, elevation: atan(0.5.squareRoot()))
    /// Short of a straight top or bottom view, so the screen's up stays defined.
    static let elevationLimit = Double.pi / 2 - Double.pi / 360

    func orbited(azimuth turn: Double, elevation tilt: Double) -> AssistModelCamera {
        let turned = azimuth + turn
        return AssistModelCamera(azimuth: turned - 2 * .pi * (turned / (2 * .pi)).rounded(.down),
                                 elevation: min(Self.elevationLimit, max(-Self.elevationLimit, elevation + tilt)))
    }

    var axes: AssistModelAxes {
        let (ca, sa, ce, se) = (cos(azimuth), sin(azimuth), cos(elevation), sin(elevation))
        return AssistModelAxes(right: SIMD3(-sa, ca, 0), up: SIMD3(-se * ca, -se * sa, ce),
                               toward: SIMD3(ce * ca, ce * sa, se))
    }
}

/// A cylindrical face in model space. Its outline depends on the camera.
struct AssistModelCylinder {
    let center: SIMD3<Double>
    let axis: SIMD3<Double>
    let xdir: SIMD3<Double>
    let ydir: SIMD3<Double>
    let radius: Double
    let h0: Double
    let h1: Double
    /// The covered arc of a partial cylinder, or nil for a full turn.
    let coverage: (start: Double, sweep: Double)?

    init?(json: Any?) {
        guard let json = json as? [String: Any],
              let center = modelVector(json["center"]), let axis = modelVector(json["axis"]),
              let xdir = modelVector(json["xdir"]), let ydir = modelVector(json["ydir"]),
              let radius = modelNumber(json["radius"]), radius > 0,
              let h0 = modelNumber(json["h0"]), let h1 = modelNumber(json["h1"]) else { return nil }
        if let raw = json["coverage"] {
            guard let raw = raw as? [String: Any], let start = modelNumber(raw["start"]),
                  let sweep = modelNumber(raw["sweep"]) else { return nil }
            coverage = (start, sweep)
        } else {
            coverage = nil
        }
        (self.center, self.axis, self.xdir, self.ydir) = (center, axis, xdir, ydir)
        (self.radius, self.h0, self.h1) = (radius, h0, h1)
    }

    /// Generators where the surface turns away from the viewer. A wireframe
    /// would otherwise show a shaft as two unconnected circles.
    func silhouettes(toward: SIMD3<Double>) -> [[SIMD3<Double>]] {
        let normal = simd_cross(axis, toward)
        let size = simd_length(normal)
        guard size >= 1e-6 else { return [] }
        return [1.0, -1.0].compactMap { sign in
            let direction = normal * (sign / size)
            if let coverage {
                // Wrapped as the web view does, so both keep the same generators.
                let angle = atan2(simd_dot(direction, ydir), simd_dot(direction, xdir)) - coverage.start
                if fmod(fmod(angle, 2 * .pi) + 2 * .pi, 2 * .pi) > coverage.sweep { return nil }
            }
            let base = center + direction * radius
            return [base + axis * h0, base + axis * h1]
        }
    }
}

/// A wireframe element in model space: its edges and cylindrical faces.
struct AssistModelWire {
    let edges: [[SIMD3<Double>]]
    let cylinders: [AssistModelCylinder]

    init?(json: [String: Any]) {
        guard let edges = json["edges"] as? [Any], let cylinders = json["cylinders"] as? [Any] else { return nil }
        self.edges = edges.compactMap { line in
            guard let points = line as? [Any], points.count >= 2 else { return nil }
            let vectors = points.compactMap(modelVector)
            return vectors.count == points.count ? vectors : nil
        }
        self.cylinders = cylinders.compactMap(AssistModelCylinder.init(json:))
    }

    /// Screen polylines for a camera: the edges, then the silhouettes.
    func lines(_ axes: AssistModelAxes) -> [[NSPoint]] {
        edges.map { $0.map(axes.project) }
            + cylinders.flatMap { $0.silhouettes(toward: axes.toward).map { $0.map(axes.project) } }
    }
}

/// The camera a rotatable preview was sent in, and the point it turns around.
struct AssistModelOrbit {
    let camera: AssistModelCamera
    let pivot: SIMD3<Double>

    init?(json: Any?) {
        guard let json = json as? [String: Any],
              let azimuth = modelNumber(json["azimuth"]), let elevation = modelNumber(json["elevation"]),
              abs(elevation) <= .pi / 2, let pivot = modelVector(json["pivot"]) else { return nil }
        camera = AssistModelCamera(azimuth: azimuth, elevation: elevation)
        self.pivot = pivot
    }
}

/// How the card shows a rotatable preview: no camera until the user turns it,
/// and a zoom relative to the fitted selection.
struct AssistModelView: Equatable {
    let camera: AssistModelCamera?
    let zoom: CGFloat

    /// Dragging 360 points turns the model half way round, as in the web view.
    static let radiansPerPoint = Double.pi / 360

    init(camera: AssistModelCamera? = nil, zoom: CGFloat = 1) {
        self.camera = camera
        self.zoom = zoom
    }

    /// Dragging right turns the model's front to the right; dragging down
    /// tilts its top toward the viewer.
    func dragged(by offset: CGSize, from sent: AssistModelCamera) -> AssistModelView {
        AssistModelView(camera: (camera ?? sent).orbited(azimuth: -Double(offset.width) * Self.radiansPerPoint,
                                                         elevation: Double(offset.height) * Self.radiansPerPoint),
                        zoom: zoom)
    }

    func zoomed(by factor: CGFloat, within range: ClosedRange<CGFloat>) -> AssistModelView {
        guard factor.isFinite, factor > 0 else { return self }
        return AssistModelView(camera: camera, zoom: min(range.upperBound, max(range.lowerBound, zoom * factor)))
    }

    func isTurned(from sent: AssistModelCamera) -> Bool { camera.map { $0 != sent } ?? false }
}

extension AssistModelElement {
    /// This element as the camera sees it. Flat elements are unchanged.
    func oriented(_ axes: AssistModelAxes) -> AssistModelElement {
        guard let wire else { return self }
        var copy = self
        copy.lines = wire.lines(axes)
        return copy
    }
}

extension AssistModelRenderer {
    // As in the web view: zoom stops at a tenth of the smaller of the selection
    // and the whole model, and at twice the larger.
    private static let maxMagnification: CGFloat = 10
    private static let maxReduction: CGFloat = 2

    /// The drawing area inside a model preview, below its title and above its caption.
    static func viewport(in rect: NSRect) -> NSRect {
        NSRect(x: rect.minX + 1, y: rect.minY + 29, width: rect.width - 2, height: rect.height - 55)
    }

    /// The transform and lines for a view of the preview. An untouched view
    /// draws the server's lines; a turned one redraws them from 3D, keeping the
    /// model point at the centre of the selection in place.
    static func layout(_ model: AssistModelPreview, viewport: NSRect,
                       view: AssistModelView?) -> (transform: AssistModelTransform, elements: [AssistModelElement])? {
        guard let fitted = AssistModelTransform(bounds: model.focusBounds, viewport: viewport) else { return nil }
        guard let view, let orbit = model.orbit, view != AssistModelView() else { return (fitted, model.elements) }
        let sent = orbit.camera.axes
        let pivot = sent.project(orbit.pivot)
        let target = sent.shift(orbit.pivot, by: NSPoint(x: fitted.center.x - pivot.x, y: fitted.center.y - pivot.y))
        let camera = view.camera ?? orbit.camera
        let axes = camera.axes
        let transform = AssistModelTransform(center: axes.project(target), scale: fitted.scale * view.zoom,
                                             screenCenter: fitted.screenCenter)
        return (transform, view.isTurned(from: orbit.camera) ? model.elements.map { $0.oriented(axes) } : model.elements)
    }

    static func zoomRange(for model: AssistModelPreview, in rect: NSRect) -> ClosedRange<CGFloat> {
        let viewport = viewport(in: rect)
        guard let focus = AssistModelTransform(bounds: model.focusBounds, viewport: viewport)?.scale,
              let whole = AssistModelTransform(bounds: model.bounds, viewport: viewport)?.scale else { return 1...1 }
        return min(1, whole / focus / maxReduction)...max(1, maxMagnification * max(focus, whole) / focus)
    }

    /// The line under the drawing. Rotatable previews in the card say how to
    /// turn them, and how to get back once turned or zoomed.
    static func caption(for model: AssistModelPreview, view: AssistModelView?) -> String {
        if let warning = model.warnings.first { return warning }
        let caption = [model.storeyLabel, model.viewLabel].filter { !$0.isEmpty }.joined(separator: " · ")
        guard let view, let orbit = model.orbit else { return caption }
        if view == AssistModelView() { return "\(caption) · Drag to rotate, scroll to zoom" }
        return "\(view.isTurned(from: orbit.camera) ? "Rotated view" : caption) · Double-click to reset"
    }
}
