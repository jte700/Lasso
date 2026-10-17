// Source-backed previews shared by the native suggestion panel and its tests.
import Cocoa
import PDFKit

struct AssistPreviewCell {
    let value: String
    let cited: Bool
}

struct AssistPreviewRow {
    let rowNumber: Int?
    let cells: [AssistPreviewCell]
}

struct AssistModelBounds {
    let minX: CGFloat
    let minY: CGFloat
    let maxX: CGFloat
    let maxY: CGFloat

    init?(json: [String: Any]?) {
        guard let json,
              let minX = json["minX"] as? NSNumber, let minY = json["minY"] as? NSNumber,
              let maxX = json["maxX"] as? NSNumber, let maxY = json["maxY"] as? NSNumber,
              [minX, minY, maxX, maxY].allSatisfy({ $0.doubleValue.isFinite }),
              maxX.doubleValue > minX.doubleValue, maxY.doubleValue > minY.doubleValue else { return nil }
        self.minX = CGFloat(minX.doubleValue)
        self.minY = CGFloat(minY.doubleValue)
        self.maxX = CGFloat(maxX.doubleValue)
        self.maxY = CGFloat(maxY.doubleValue)
    }

    var width: CGFloat { maxX - minX }
    var height: CGFloat { maxY - minY }
}

struct AssistModelElement {
    let id: Int
    let guid: String
    let label: String
    let entityType: String
    let role: String
    let selected: Bool
    /// Actual source regions; even-odd fill preserves IFC openings.
    let polygons: [[NSPoint]]
}

struct AssistModelDrawingPath {
    let id: String
    let points: [NSPoint]
    let closed: Bool
    let elevation: CGFloat
    let layer: String
    /// DXF pen weight in hundredths of a millimetre, independent of model units.
    let lineweight: CGFloat?
}

struct AssistModelDrawingText {
    let id: String
    let point: NSPoint
    let text: String
    let height: CGFloat
    let rotation: CGFloat
    let align: String
    let verticalAlign: String
    let widthScale: CGFloat
    let elevation: CGFloat
    let layer: String
}

enum AssistModelDrawing {
    case path(AssistModelDrawingPath)
    case text(AssistModelDrawingText)

    private static func number(_ value: Any?, maximum: Double = 1e12) -> CGFloat? {
        guard let value = value as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, abs(value.doubleValue) <= maximum else { return nil }
        return CGFloat(value.doubleValue)
    }

    private static func point(_ value: Any?) -> NSPoint? {
        guard let values = value as? [Any], values.count == 2,
              let x = number(values[0]), let y = number(values[1]) else { return nil }
        return NSPoint(x: x, y: y)
    }

    static func parse(_ json: [String: Any], remainingPoints: inout Int) -> AssistModelDrawing? {
        guard let id = json["id"] as? String, id.count <= 512,
              let elevation = number(json["elevation"] ?? 0) else { return nil }
        let layer = String((json["layer"] as? String ?? "").prefix(512))
        switch json["type"] as? String {
        case "path":
            guard let values = json["points"] as? [Any], values.count >= 2,
                  values.count <= remainingPoints else { return nil }
            let points = values.compactMap(point)
            guard points.count == values.count else { return nil }
            let lineweight: CGFloat?
            if let raw = json["lineweight"] {
                guard let weight = number(raw, maximum: 211), weight >= 0 else { return nil }
                lineweight = weight
            } else { lineweight = nil }
            remainingPoints -= points.count
            return .path(AssistModelDrawingPath(id: id, points: points,
                closed: json["closed"] as? Bool ?? false, elevation: elevation, layer: layer,
                lineweight: lineweight))
        case "text":
            guard remainingPoints > 0, let point = point(json["point"]),
                  let text = json["text"] as? String, !text.isEmpty, text.count <= 16_384,
                  let height = number(json["height"], maximum: 1e9), height > 0,
                  let rotation = number(json["rotation"] ?? 0, maximum: 1e9),
                  let widthScale = number(json["widthScale"] ?? 1, maximum: 1_000), widthScale > 0 else { return nil }
            let align = json["align"] as? String ?? "start"
            let verticalAlign = json["verticalAlign"] as? String ?? "baseline"
            guard ["start", "middle", "end"].contains(align),
                  ["baseline", "top", "middle", "bottom"].contains(verticalAlign) else { return nil }
            remainingPoints -= 1
            return .text(AssistModelDrawingText(id: id, point: point, text: text,
                height: height, rotation: rotation.truncatingRemainder(dividingBy: 360), align: align,
                verticalAlign: verticalAlign, widthScale: widthScale, elevation: elevation, layer: layer))
        default:
            return nil
        }
    }
}

struct AssistModelPreview {
    let bounds: AssistModelBounds
    let focusBounds: AssistModelBounds
    let elements: [AssistModelElement]
    let drawing: [AssistModelDrawing]
    let selectedLabel: String
    let selectedEntityType: String
    let storeyLabel: String
    let warnings: [String]

    init?(json: [String: Any]) {
        guard json["kind"] as? String == "model-plan",
              let bounds = AssistModelBounds(json: json["bounds"] as? [String: Any]) else { return nil }
        let elements = (json["elements"] as? [[String: Any]] ?? []).compactMap { item -> AssistModelElement? in
            let polygons = (item["polygons"] as? [[[NSNumber]]] ?? []).compactMap { ring -> [NSPoint]? in
                guard ring.count >= 3,
                      ring.allSatisfy({ $0.count == 2 && $0.allSatisfy { $0.doubleValue.isFinite } }) else { return nil }
                return ring.map { NSPoint(x: $0[0].doubleValue, y: $0[1].doubleValue) }
            }
            guard !polygons.isEmpty else { return nil }
            return AssistModelElement(
                id: (item["id"] as? NSNumber)?.intValue ?? 0,
                guid: item["guid"] as? String ?? "",
                label: item["label"] as? String ?? "",
                entityType: item["entityType"] as? String ?? "",
                role: item["role"] as? String ?? "context",
                selected: item["selected"] as? Bool ?? false,
                polygons: polygons)
        }
        var remainingPoints = 400_000
        let drawing = (json["drawing"] as? [[String: Any]] ?? []).prefix(25_000).compactMap {
            AssistModelDrawing.parse($0, remainingPoints: &remainingPoints)
        }
        guard !elements.isEmpty || !drawing.isEmpty else { return nil }
        self.bounds = bounds
        self.focusBounds = AssistModelBounds(json: json["focusBounds"] as? [String: Any]) ?? bounds
        self.elements = elements
        self.drawing = drawing
        let selected = json["selected"] as? [String: Any] ?? [:]
        self.selectedLabel = selected["label"] as? String ?? ""
        self.selectedEntityType = selected["entityType"] as? String ?? ""
        self.storeyLabel = (json["storey"] as? [String: Any])?["label"] as? String ?? ""
        self.warnings = json["warnings"] as? [String] ?? []
    }
}

/// A single uniform scale maps the model's XY coordinates into a flipped
/// AppKit view. The server chooses the actual selected element's focus bounds.
struct AssistModelTransform {
    let scale: CGFloat
    private let source: AssistModelBounds
    private let origin: NSPoint

    init?(bounds: AssistModelBounds, viewport: NSRect, padding: CGFloat = 10) {
        let inner = viewport.insetBy(dx: padding, dy: padding)
        guard inner.width > 0, inner.height > 0 else { return nil }
        let scale = min(inner.width / bounds.width, inner.height / bounds.height)
        guard scale.isFinite, scale > 0 else { return nil }
        self.scale = scale
        self.source = bounds
        self.origin = NSPoint(x: inner.midX - bounds.width * scale / 2,
                              y: inner.midY - bounds.height * scale / 2)
    }

    func point(_ point: NSPoint) -> NSPoint {
        NSPoint(x: origin.x + (point.x - source.minX) * scale,
                y: origin.y + (source.maxY - point.y) * scale)
    }

    func path(for element: AssistModelElement) -> NSBezierPath {
        let path = NSBezierPath()
        path.windingRule = .evenOdd
        for polygon in element.polygons {
            guard let first = polygon.first else { continue }
            path.move(to: point(first))
            for vertex in polygon.dropFirst() { path.line(to: point(vertex)) }
            path.close()
        }
        return path
    }

    func path(for drawing: AssistModelDrawingPath) -> NSBezierPath {
        let path = NSBezierPath()
        guard let first = drawing.points.first else { return path }
        path.move(to: point(first))
        for vertex in drawing.points.dropFirst() { path.line(to: point(vertex)) }
        if drawing.closed { path.close() }
        return path
    }

    func textTransform(for text: AssistModelDrawingText) -> NSAffineTransform {
        let anchor = point(text.point)
        let transform = NSAffineTransform()
        transform.translateX(by: anchor.x, yBy: anchor.y)
        // Source Y points up; the native view is flipped. Rotate the glyphs,
        // without mirroring them, around their projected insertion point.
        transform.rotate(byDegrees: -text.rotation)
        transform.scaleX(by: text.widthScale, yBy: 1)
        return transform
    }
}

enum AssistModelRenderer {
    static func draw(_ model: AssistModelPreview, in rect: NSRect) {
        let outline = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
        NSColor.textBackgroundColor.withAlphaComponent(0.85).setFill()
        outline.fill()
        NSGraphicsContext.current?.saveGraphicsState()
        outline.addClip()

        let title = model.selectedLabel.isEmpty ? "Model plan" : model.selectedLabel
        label(title, in: NSRect(x: rect.minX + 11, y: rect.minY + 8, width: rect.width - 22, height: 16),
              font: .systemFont(ofSize: 10.5, weight: .semibold), color: .labelColor)

        let viewport = NSRect(x: rect.minX + 1, y: rect.minY + 29,
                              width: rect.width - 2, height: rect.height - 55)
        if let transform = AssistModelTransform(bounds: model.focusBounds, viewport: viewport) {
            NSGraphicsContext.current?.saveGraphicsState()
            NSBezierPath(rect: viewport).addClip()
            // Fill source regions first. DXF drafting remains visible over the
            // selected room, and its outline is reinforced after the details.
            for selected in [false, true] {
                for element in model.elements where element.selected == selected {
                    let path = transform.path(for: element)
                    let fill: NSColor = selected ? .systemBlue : .secondaryLabelColor
                    let alpha: CGFloat = selected ? 0.24 : (model.drawing.isEmpty ? (element.role == "space" ? 0.035 : 0.10) : 0.015)
                    fill.withAlphaComponent(alpha).setFill()
                    path.fill()
                    let stroke: NSColor = selected ? .systemBlue : .secondaryLabelColor
                    stroke.withAlphaComponent(selected ? 0.95 : 0.32).setStroke()
                    path.lineWidth = selected ? 1.7 : 0.65
                    path.lineJoinStyle = .round
                    path.stroke()
                }
            }
            for drawing in model.drawing {
                switch drawing {
                case .path(let drawing):
                    let path = transform.path(for: drawing)
                    NSColor.labelColor.withAlphaComponent(0.80).setStroke()
                    // Pen weights belong to the drawing sheet, not world
                    // coordinates. Preserve their relative emphasis on screen.
                    path.lineWidth = drawing.lineweight.map { min(2.5, max(0.5, $0 * 0.025)) } ?? 0.8
                    path.lineJoinStyle = .round
                    path.lineCapStyle = .round
                    path.stroke()
                case .text(let text):
                    draw(text, transform: transform)
                }
            }
            if !model.drawing.isEmpty {
                NSColor.systemBlue.withAlphaComponent(0.95).setStroke()
                for element in model.elements where element.selected {
                    let path = transform.path(for: element)
                    path.lineWidth = 1.7
                    path.lineJoinStyle = .round
                    path.stroke()
                }
            }
            NSGraphicsContext.current?.restoreGraphicsState()
        }

        let caption = model.warnings.first ?? [model.storeyLabel, "Plan view"].filter { !$0.isEmpty }.joined(separator: " · ")
        label(caption, in: NSRect(x: rect.minX + 11, y: rect.maxY - 20, width: rect.width - 22, height: 15),
              font: .systemFont(ofSize: 9.5), color: .secondaryLabelColor)
        NSGraphicsContext.current?.restoreGraphicsState()
        NSColor.separatorColor.withAlphaComponent(0.18).setStroke()
        outline.lineWidth = 0.65
        outline.stroke()
    }

    private static func draw(_ text: AssistModelDrawingText, transform: AssistModelTransform) {
        let height = text.height * transform.scale
        guard height.isFinite, height >= 0.5 else { return }
        let font = NSFont.systemFont(ofSize: min(160, max(3, height)))
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: NSColor.labelColor.withAlphaComponent(0.90),
        ]
        let value = NSAttributedString(string: text.text, attributes: attributes)
        let size = value.size()
        let x: CGFloat = text.align == "middle" ? -size.width / 2 : (text.align == "end" ? -size.width : 0)
        let y: CGFloat
        switch text.verticalAlign {
        case "top": y = 0
        case "middle": y = -size.height / 2
        case "bottom": y = -size.height
        default: y = -font.ascender
        }
        NSGraphicsContext.current?.saveGraphicsState()
        transform.textTransform(for: text).concat()
        value.draw(at: NSPoint(x: x, y: y))
        NSGraphicsContext.current?.restoreGraphicsState()
    }

    private static func label(_ value: String, in rect: NSRect, font: NSFont, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        NSAttributedString(string: value, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
        ]).draw(in: rect)
    }
}

struct AssistPDFPreview {
    let fileUrl: String
    let pageNumber: Int
    let selectedText: String

    init?(json: [String: Any]) {
        guard json["kind"] as? String == "pdf",
              let fileUrl = json["fileUrl"] as? String, !fileUrl.isEmpty else { return nil }
        self.fileUrl = fileUrl
        pageNumber = max(1, (json["pageNumber"] as? NSNumber ?? json["page"] as? NSNumber)?.intValue ?? 1)
        selectedText = json["selectedText"] as? String ?? ""
    }

    func sourceURL(serverURL: URL) -> URL? {
        guard let url = URL(string: fileUrl, relativeTo: serverURL)?.absoluteURL,
              url.scheme == serverURL.scheme, url.host == serverURL.host,
              url.port == serverURL.port, url.user == nil, url.password == nil else { return nil }
        return url
    }
}

struct AssistPDFPageImage {
    let image: NSImage
    let pageNumber: Int
    let highlighted: Bool

    /// Render immutable source bytes in memory. Highlight annotations are never saved.
    static func render(data: Data, preview: AssistPDFPreview,
                       size: NSSize = NSSize(width: 1440, height: 888)) -> AssistPDFPageImage? {
        guard let document = PDFDocument(data: data), !document.isLocked,
              document.pageCount > 0, size.width > 0, size.height > 0 else { return nil }
        var pageIndex = min(preview.pageNumber - 1, document.pageCount - 1)
        let query = preview.selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
        var selected: PDFSelection?
        if !query.isEmpty {
            let matches = document.findString(query, withOptions: [.caseInsensitive])
            selected = matches.first { selection in
                selection.pages.contains { document.index(for: $0) == pageIndex }
            }
            // Sentence completion normalizes line breaks. PDFKit's phrase
            // search does not, so recover the exact page range across wraps.
            let pattern = query.split(whereSeparator: { $0.isWhitespace })
                .map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: "\\s+")
            let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
            func wrappedSelection(on index: Int) -> PDFSelection? {
                guard let page = document.page(at: index), let text = page.string, let expression,
                      let match = expression.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))
                else { return nil }
                return page.selection(for: match.range)
            }
            selected = selected ?? wrappedSelection(on: pageIndex) ?? matches.first
            if selected == nil {
                for index in 0..<document.pageCount where index != pageIndex {
                    if let match = wrappedSelection(on: index) { selected = match; break }
                }
            }
            if let selected, !selected.pages.contains(where: { document.index(for: $0) == pageIndex }),
               let page = selected.pages.first { pageIndex = document.index(for: page) }
        }
        guard let page = document.page(at: pageIndex) else { return nil }
        for line in selected?.selectionsByLine() ?? [] {
            guard line.pages.contains(page) else { continue }
            let bounds = line.bounds(for: page)
            guard !bounds.isEmpty else { continue }
            let annotation = PDFAnnotation(bounds: bounds, forType: .highlight, withProperties: nil)
            annotation.color = NSColor.systemYellow.withAlphaComponent(0.55)
            page.addAnnotation(annotation)
        }
        let image = page.thumbnail(of: size, for: .cropBox)
        guard image.size.width > 0, image.size.height > 0 else { return nil }
        return AssistPDFPageImage(image: image, pageNumber: pageIndex + 1, highlighted: selected != nil)
    }
}

struct AssistDocumentPreview {
    let filename: String
    let path: String
    let location: String
    let context: String
    let valueText: String?
    let objectType: String
    let snapshotVersion: Int?
    let columns: [String]
    let headers: [String]
    let rows: [AssistPreviewRow]
    var model: AssistModelPreview? = nil
    var unavailableReason: String? = nil
    var pdf: AssistPDFPreview? = nil
    var pdfPage: AssistPDFPageImage? = nil

    static func parse(_ data: Data) -> AssistDocumentPreview? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let source = root["source"] as? [String: Any] else { return nil }
        let preview = root["preview"] as? [String: Any] ?? [:]
        let rows = (preview["rows"] as? [[String: Any]] ?? []).map { row in
            AssistPreviewRow(
                rowNumber: (row["rowNumber"] as? NSNumber)?.intValue,
                cells: (row["cells"] as? [[String: Any]] ?? []).map {
                    AssistPreviewCell(value: $0["value"] as? String ?? "", cited: $0["cited"] as? Bool ?? false)
                })
        }
        let kind = preview["kind"] as? String ?? ""
        let model = AssistModelPreview(json: preview)
        let pdf = AssistPDFPreview(json: preview)
        let unavailable: String?
        if kind == "model-unavailable" {
            unavailable = preview["reason"] as? String ?? "This indexed element has no available drawing geometry."
        } else if kind == "model-plan", model == nil {
            unavailable = "The model contains no usable drawing geometry for this preview."
        } else if kind == "pdf", pdf == nil {
            unavailable = "The indexed PDF preview address is unavailable. Select this result again to retry."
        } else {
            unavailable = nil
        }
        return AssistDocumentPreview(
            filename: source["filename"] as? String ?? "",
            path: root["path"] as? String ?? "",
            location: preview["location"] as? String ?? source["location"] as? String ?? "",
            context: preview["text"] as? String ?? source["context"] as? String ?? "",
            valueText: source["valueText"] as? String,
            objectType: source["objectType"] as? String ?? "SOURCE",
            snapshotVersion: (source["snapshotVersion"] as? NSNumber)?.intValue,
            columns: preview["columns"] as? [String] ?? [],
            headers: preview["headers"] as? [String] ?? [],
            rows: rows, model: model, unavailableReason: unavailable,
            pdf: pdf)
    }
}
