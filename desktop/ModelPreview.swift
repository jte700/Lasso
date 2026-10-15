// Source-backed previews shared by the native suggestion panel and its tests.
import Cocoa

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
    /// Actual projected IFC silhouette rings; even-odd fill preserves holes.
    let polygons: [[NSPoint]]
}

struct AssistModelPreview {
    let bounds: AssistModelBounds
    let focusBounds: AssistModelBounds
    let elements: [AssistModelElement]
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
        guard !elements.isEmpty else { return nil }
        self.bounds = bounds
        self.focusBounds = AssistModelBounds(json: json["focusBounds"] as? [String: Any]) ?? bounds
        self.elements = elements
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
            // Draw context first, then the exact selected IFC product on top.
            for selected in [false, true] {
                for element in model.elements where element.selected == selected {
                    let path = transform.path(for: element)
                    let fill: NSColor = selected ? .systemBlue : .secondaryLabelColor
                    fill.withAlphaComponent(selected ? 0.24 : (element.role == "space" ? 0.035 : 0.10)).setFill()
                    path.fill()
                    let stroke: NSColor = selected ? .systemBlue : .secondaryLabelColor
                    stroke.withAlphaComponent(selected ? 0.95 : 0.32).setStroke()
                    path.lineWidth = selected ? 1.7 : 0.65
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

    private static func label(_ value: String, in rect: NSRect, font: NSFont, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        NSAttributedString(string: value, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
        ]).draw(in: rect)
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
        let unavailable: String?
        if kind == "model-unavailable" {
            unavailable = preview["reason"] as? String ?? "This indexed element has no available drawing geometry."
        } else if kind == "model-plan", model == nil {
            unavailable = "The model contains no usable drawing geometry for this preview."
        } else {
            unavailable = nil
        }
        return AssistDocumentPreview(
            filename: source["filename"] as? String ?? "",
            path: root["path"] as? String ?? "",
            location: source["location"] as? String ?? "",
            context: source["context"] as? String ?? "",
            valueText: source["valueText"] as? String,
            objectType: source["objectType"] as? String ?? "SOURCE",
            snapshotVersion: (source["snapshotVersion"] as? NSNumber)?.intValue,
            columns: preview["columns"] as? [String] ?? [],
            headers: preview["headers"] as? [String] ?? [],
            rows: rows, model: model, unavailableReason: unavailable)
    }
}
