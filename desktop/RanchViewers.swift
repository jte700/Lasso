// How The Ranch shows a file. Documents, sheets, PDFs, slides, images and
// text scroll in Quick Look, the Mac's own viewer. 3D models turn with a drag
// and zoom with a pinch or scroll in SceneKit. 2D drawings pan and zoom.
// Nothing here can change the file.

import Cocoa
import PDFKit
import Quartz
import SceneKit
import SceneKit.ModelIO
import SwiftUI

/// Quick Look's view, which knows whether it was ever on screen: closing one
/// that never was trips an assertion inside Quick Look and ends the app.
final class RanchPreviewView: QLPreviewView {
    private(set) var wasShown = false

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { wasShown = true }
    }
}

/// The Mac's Quick Look viewer, which scrolls documents and sheets.
struct RanchQuickLookView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> RanchPreviewView {
        let view = RanchPreviewView(frame: .zero, style: .normal) ?? RanchPreviewView()
        view.autostarts = true
        view.shouldCloseWithWindow = true
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: RanchPreviewView, context: Context) {
        if (view.previewItem as? NSURL) as URL? != url { view.previewItem = url as NSURL }
    }

    static func dismantleNSView(_ view: RanchPreviewView, coordinator: ()) {
        if view.wasShown { view.close() }
    }
}

/// A PDF in PDFKit, which can turn to the page a review link cites and light
/// up the cited words; Quick Look cannot be told which page to show.
struct RanchPDFView: NSViewRepresentable {
    let url: URL
    var page: Int? = nil
    /// Words to light up on the page, such as the value a link cites.
    var find: String? = nil

    final class Coordinator {
        var shown: String?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.backgroundColor = .underPageBackgroundColor
        view.document = PDFDocument(url: url)
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        guard let document = view.document, document.pageCount > 0 else { return }
        let key = "\(page ?? 0)|\(find ?? "")"
        guard context.coordinator.shown != key else { return }
        context.coordinator.shown = key
        guard let page, let target = document.page(at: max(0, min(document.pageCount - 1, page - 1))) else {
            view.highlightedSelections = nil
            return
        }
        let words = find?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        DispatchQueue.main.async {
            view.go(to: target)
            guard words.count >= 2 else { view.highlightedSelections = nil; return }
            let matches = document.findString(words, withOptions: [.caseInsensitive]).filter { $0.pages.contains(target) }
            matches.forEach { $0.color = NSColor.systemYellow.withAlphaComponent(0.55) }
            view.highlightedSelections = matches.isEmpty ? nil : matches
            if let first = matches.first { view.go(to: first) }
        }
    }
}

/// A 3D model that turns with the trackpad or mouse.
struct RanchSceneView: NSViewRepresentable {
    let scene: SCNScene
    /// Changing it puts the camera back where it started.
    let resetToken: Int

    final class Coordinator {
        var scene: SCNScene?
        var resetToken = 0
        var home: SCNNode?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> SCNView {
        let view = SCNView(frame: .zero)
        view.backgroundColor = .clear
        view.allowsCameraControl = true
        view.autoenablesDefaultLighting = true
        view.antialiasingMode = .multisampling4X
        view.defaultCameraController.interactionMode = .orbitTurntable
        view.defaultCameraController.inertiaEnabled = true
        return view
    }

    func updateNSView(_ view: SCNView, context: Context) {
        let coordinator = context.coordinator
        guard coordinator.scene !== scene || coordinator.resetToken != resetToken else { return }
        coordinator.scene = scene
        coordinator.resetToken = resetToken
        view.scene = scene
        let camera = RanchModelScene.frame(scene)
        view.pointOfView = camera.node
        view.defaultCameraController.target = camera.target
    }
}

enum RanchModelScene {
    /// Mesh formats CAD apps export with Z up. OBJ, USD and Collada say Y up, as SceneKit does.
    private static let zUpExtensions: Set<String> = ["stl", "ply", "3mf"]

    /// A mesh file read by Model I/O, or Collada and SceneKit files read directly.
    static func mesh(at url: URL) throws -> SCNScene {
        let fileExtension = url.pathExtension.lowercased()
        if ["dae", "scn"].contains(fileExtension) { return try SCNScene(url: url, options: nil) }
        let asset = MDLAsset(url: url)
        guard asset.count > 0 else {
            throw NSError(domain: "LassoRanch", code: 3, userInfo: [NSLocalizedDescriptionKey: "This model has no shapes SceneKit can draw."])
        }
        // Exports often carry no normals, or zero ones, which shade every face the same.
        for case let mesh as MDLMesh in asset.childObjects(of: MDLMesh.self) {
            mesh.addNormals(withAttributeNamed: MDLVertexAttributeNormal, creaseThreshold: 0.6)
        }
        let loaded = SCNScene(mdlAsset: asset)
        let shade = SCNMaterial()
        shade.lightingModel = .blinn
        shade.diffuse.contents = NSColor(calibratedWhite: 0.62, alpha: 1)
        shade.specular.contents = NSColor(calibratedWhite: 0.35, alpha: 1)
        shade.shininess = 0.35
        shade.isDoubleSided = true
        loaded.rootNode.enumerateHierarchy { node, _ in
            guard let geometry = node.geometry else { return }
            // CAD exports carry plain colours at most; a textured model keeps its own look.
            if !geometry.materials.contains(where: { $0.diffuse.contents is NSImage || $0.diffuse.contents is URL }) {
                geometry.materials = [shade]
            }
        }
        let scene = SCNScene()
        let model = SCNNode()
        if zUpExtensions.contains(fileExtension) { model.eulerAngles.x = -.pi / 2 }
        for child in loaded.rootNode.childNodes { model.addChildNode(child) }
        scene.rootNode.addChildNode(model)
        addStudioLights(to: scene)
        return scene
    }

    /// Light fixed to the room rather than the camera, so turning a model shows its shape.
    private static func addStudioLights(to scene: SCNScene) {
        let lights: [(SCNLight.LightType, CGFloat, SCNVector3?)] = [
            (.ambient, 220, nil), (.directional, 1050, SCNVector3(0.6, 1, 0.8)), (.directional, 260, SCNVector3(-1, 0.3, -0.6)),
        ]
        for (type, intensity, direction) in lights {
            let light = SCNLight()
            light.type = type
            light.intensity = intensity
            let node = SCNNode()
            node.light = light
            if let direction { node.position = direction; node.look(at: SCNVector3(0, 0, 0)) }
            scene.rootNode.addChildNode(node)
        }
    }

    /// The STEP edges and cylindrical faces Lasso's reader recorded, turned so
    /// the model's Z points up as CAD apps show it.
    static func wireframe(_ model: AssistModelPreview, dark: Bool) -> SCNScene? {
        var lineVertices: [SCNVector3] = []
        var lineIndices: [Int32] = []
        var faceVertices: [SCNVector3] = []
        var faceNormals: [SCNVector3] = []
        var faceIndices: [Int32] = []
        for element in model.elements {
            guard let wire = element.wire else { continue }
            for edge in wire.edges {
                for (start, end) in zip(edge, edge.dropFirst()) {
                    lineIndices.append(Int32(lineVertices.count))
                    lineVertices.append(vector(start))
                    lineIndices.append(Int32(lineVertices.count))
                    lineVertices.append(vector(end))
                }
            }
            for cylinder in wire.cylinders { appendSurface(cylinder, &faceVertices, &faceNormals, &faceIndices) }
        }
        guard !lineVertices.isEmpty else { return nil }
        let scene = SCNScene()
        let model = SCNNode()
        model.eulerAngles.x = -.pi / 2
        let edges = SCNGeometry(sources: [SCNGeometrySource(vertices: lineVertices)],
                                elements: [SCNGeometryElement(indices: lineIndices, primitiveType: .line)])
        let ink = SCNMaterial()
        ink.lightingModel = .constant
        ink.diffuse.contents = dark ? NSColor(calibratedWhite: 0.92, alpha: 1) : NSColor(calibratedWhite: 0.18, alpha: 1)
        edges.materials = [ink]
        model.addChildNode(SCNNode(geometry: edges))
        if !faceVertices.isEmpty {
            let faces = SCNGeometry(sources: [SCNGeometrySource(vertices: faceVertices), SCNGeometrySource(normals: faceNormals)],
                                    elements: [SCNGeometryElement(indices: faceIndices, primitiveType: .triangles)])
            let skin = SCNMaterial()
            skin.diffuse.contents = NSColor.systemBlue.withAlphaComponent(0.22)
            skin.isDoubleSided = true
            skin.writesToDepthBuffer = false
            faces.materials = [skin]
            model.addChildNode(SCNNode(geometry: faces))
        }
        scene.rootNode.addChildNode(model)
        return scene
    }

    /// A camera looking at the whole model from above one corner, and the point it turns around.
    static func frame(_ scene: SCNScene) -> (node: SCNNode, target: SCNVector3) {
        let (low, high) = scene.rootNode.boundingBox
        let center = SCNVector3((low.x + high.x) / 2, (low.y + high.y) / 2, (low.z + high.z) / 2)
        let size = max(high.x - low.x, high.y - low.y, high.z - low.z, 0.001)
        let camera = SCNCamera()
        camera.zNear = Double(size) * 0.01
        camera.zFar = Double(size) * 40
        camera.fieldOfView = 35
        let node = SCNNode()
        node.camera = camera
        node.position = SCNVector3(center.x + size * 1.35, center.y + size * 1.05, center.z + size * 1.6)
        node.look(at: center)
        return (node, center)
    }

    private static func vector(_ point: SIMD3<Double>) -> SCNVector3 {
        SCNVector3(CGFloat(point.x), CGFloat(point.y), CGFloat(point.z))
    }

    /// A cylinder's covered arc as triangles, so a shaft reads as solid.
    private static func appendSurface(_ cylinder: AssistModelCylinder, _ vertices: inout [SCNVector3],
                                      _ normals: inout [SCNVector3], _ indices: inout [Int32]) {
        let start = cylinder.coverage?.start ?? 0
        let sweep = cylinder.coverage?.sweep ?? 2 * .pi
        let steps = max(6, Int((abs(sweep) / (2 * .pi) * 36).rounded()))
        let first = Int32(vertices.count)
        for step in 0...steps {
            let angle = start + sweep * Double(step) / Double(steps)
            let radial = cylinder.xdir * cos(angle) + cylinder.ydir * sin(angle)
            for height in [cylinder.h0, cylinder.h1] {
                vertices.append(vector(cylinder.center + cylinder.axis * height + radial * cylinder.radius))
                normals.append(vector(radial))
            }
        }
        for step in 0..<Int32(steps) {
            let base = first + step * 2
            indices += [base, base + 1, base + 2, base + 1, base + 3, base + 2]
        }
    }
}

/// A DXF or IFC plan in a scroll view that pinches and scrolls like Preview.
struct RanchPlanView: NSViewRepresentable {
    let model: AssistModelPreview
    /// Changing it zooms back to the whole drawing.
    let resetToken: Int

    final class Coordinator { var resetToken = 0 }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = RanchPlanScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.allowsMagnification = true
        scroll.minMagnification = 0.5
        scroll.maxMagnification = 12
        scroll.drawsBackground = false
        scroll.documentView = RanchPlanCanvas(model: model)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let canvas = scroll.documentView as? RanchPlanCanvas
        // A drawing framed on another element, for a review link, is drawn afresh.
        if canvas?.model.bounds.width != model.bounds.width || canvas?.model.elements.count != model.elements.count
            || canvas?.model.selectedLabel != model.selectedLabel {
            scroll.documentView = RanchPlanCanvas(model: model)
        }
        if context.coordinator.resetToken != resetToken {
            context.coordinator.resetToken = resetToken
            scroll.magnification = 1
        }
    }
}

/// Keeps the drawing as large as the pane; magnification then zooms it.
final class RanchPlanScrollView: NSScrollView {
    override func layout() {
        super.layout()
        let size = NSSize(width: max(contentSize.width, 200), height: max(contentSize.height, 200))
        if documentView?.frame.size != size { documentView?.setFrameSize(size) }
    }
}

final class RanchPlanCanvas: NSView {
    let model: AssistModelPreview

    init(model: AssistModelPreview) {
        self.model = model
        super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    }

    required init?(coder: NSCoder) { nil }

    // The renderer maps model Y up onto a flipped view.
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        AssistModelRenderer.draw(model, in: bounds.insetBy(dx: 12, dy: 12))
    }
}

/// Code with its line numbers beside it, read-only, so the number to write
/// after the file's name ("server.js line 42") is always in view. Selecting
/// text reports the lines it covers.
struct RanchCodeView: NSViewRepresentable {
    let text: String
    /// A line a review link cites, selected and scrolled to.
    var focusLine: Int? = nil
    let onSelectLines: (ClosedRange<Int>?) -> Void

    final class Coordinator: NSObject, NSTextViewDelegate {
        var shownLine: Int?
        var onSelectLines: (ClosedRange<Int>?) -> Void
        init(onSelectLines: @escaping (ClosedRange<Int>?) -> Void) { self.onSelectLines = onSelectLines }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            onSelectLines(RanchCodeLines.lines(in: view.string, selection: view.selectedRange()))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onSelectLines: onSelectLines) }

    func makeNSView(context: Context) -> NSScrollView {
        // TextKit 1, whose line fragments the numbers are drawn beside.
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        let textView = NSTextView(frame: .zero, textContainer: container)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.usesFindBar = true
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.textColor = .textColor
        textView.backgroundColor = .textBackgroundColor
        textView.textContainerInset = NSSize(width: 6, height: 8)
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        textView.string = text
        textView.delegate = context.coordinator
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = textView
        let ruler = RanchLineNumberRuler(scrollView: scroll, textView: textView)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.onSelectLines = onSelectLines
        guard let textView = scroll.documentView as? NSTextView else { return }
        if textView.string != text {
            textView.string = text
            (scroll.verticalRulerView as? RanchLineNumberRuler)?.textDidChange()
        }
        if let focusLine, context.coordinator.shownLine != focusLine {
            context.coordinator.shownLine = focusLine
            let range = RanchCodeLines.range(ofLine: focusLine, in: textView.string)
            // After layout, so the line is scrolled to where it really is.
            DispatchQueue.main.async {
                textView.setSelectedRange(range)
                textView.scrollRangeToVisible(range)
                textView.showFindIndicator(for: range)
            }
        }
    }
}

/// The line numbers in the margin of a code view, one beside the first
/// fragment of each line.
final class RanchLineNumberRuler: NSRulerView {
    private weak var textView: NSTextView?
    /// Where each line starts, in UTF-16 offsets.
    private var lineStarts: [Int] = [0]
    private let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)

    init(scrollView: NSScrollView, textView: NSTextView) {
        self.textView = textView
        super.init(scrollView: scrollView, orientation: .verticalRuler)
        clientView = textView
        textDidChange()
        NotificationCenter.default.addObserver(self, selector: #selector(redraw),
                                               name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        scrollView.contentView.postsBoundsChangedNotifications = true
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func textDidChange() {
        let units = Array((textView?.string ?? "").utf16)
        var starts = [0]
        for (index, unit) in units.enumerated() where unit == UInt16(UInt8(ascii: "\n")) && index + 1 < units.count {
            starts.append(index + 1)
        }
        lineStarts = starts
        ruleThickness = max(34, CGFloat(String(starts.count).count) * 7 + 18)
        needsDisplay = true
    }

    @objc private func redraw() { needsDisplay = true }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView, let layout = textView.layoutManager, let container = textView.textContainer,
              layout.numberOfGlyphs > 0 else { return }
        let visible = layout.glyphRange(forBoundingRect: textView.visibleRect, in: container)
        let characters = layout.characterRange(forGlyphRange: visible, actualGlyphRange: nil)
        var low = 0, high = lineStarts.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            if lineStarts[middle] <= characters.location { low = middle } else { high = middle - 1 }
        }
        let attributes: [NSAttributedString.Key: Any] = [.font: numberFont, .foregroundColor: NSColor.tertiaryLabelColor]
        let origin = textView.textContainerOrigin
        var line = low
        while line < lineStarts.count, lineStarts[line] <= NSMaxRange(characters) {
            let fragment = layout.lineFragmentRect(forGlyphAt: layout.glyphIndexForCharacter(at: lineStarts[line]), effectiveRange: nil)
            let top = convert(NSPoint(x: 0, y: fragment.minY + origin.y), from: textView)
            let bottom = convert(NSPoint(x: 0, y: fragment.maxY + origin.y), from: textView)
            let label = String(line + 1) as NSString
            let size = label.size(withAttributes: attributes)
            let box = NSRect(x: ruleThickness - size.width - 8, y: min(top.y, bottom.y) + (abs(bottom.y - top.y) - size.height) / 2,
                             width: size.width, height: size.height)
            label.draw(in: box, withAttributes: attributes)
            line += 1
        }
    }
}
