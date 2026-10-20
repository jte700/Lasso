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
    /// Open CAD edge polylines (STEP isometric wireframes); never filled.
    var lines: [[NSPoint]] = []
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
    let viewLabel: String
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
            let lines = (item["lines"] as? [[[NSNumber]]] ?? []).compactMap { line -> [NSPoint]? in
                guard line.count >= 2,
                      line.allSatisfy({ $0.count == 2 && $0.allSatisfy { $0.doubleValue.isFinite } }) else { return nil }
                return line.map { NSPoint(x: $0[0].doubleValue, y: $0[1].doubleValue) }
            }
            guard !polygons.isEmpty || !lines.isEmpty else { return nil }
            return AssistModelElement(
                id: (item["id"] as? NSNumber)?.intValue ?? 0,
                guid: item["guid"] as? String ?? "",
                label: item["label"] as? String ?? "",
                entityType: item["entityType"] as? String ?? "",
                role: item["role"] as? String ?? "context",
                selected: item["selected"] as? Bool ?? false,
                polygons: polygons,
                lines: lines)
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
        self.viewLabel = json["view"] as? String ?? "Plan view"
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

    func linePath(for element: AssistModelElement) -> NSBezierPath {
        let path = NSBezierPath()
        for line in element.lines {
            guard let first = line.first else { continue }
            path.move(to: point(first))
            for vertex in line.dropFirst() { path.line(to: point(vertex)) }
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

        let title = model.selectedLabel.isEmpty ? "Design model" : model.selectedLabel
        label(title, in: NSRect(x: rect.minX + 11, y: rect.minY + 8, width: rect.width - 22, height: 16),
              font: .systemFont(ofSize: 10.5, weight: .semibold), color: .labelColor)

        let viewport = NSRect(x: rect.minX + 1, y: rect.minY + 29,
                              width: rect.width - 2, height: rect.height - 55)
        if let transform = AssistModelTransform(bounds: model.focusBounds, viewport: viewport) {
            NSGraphicsContext.current?.saveGraphicsState()
            NSBezierPath(rect: viewport).addClip()
            // Fill source regions first. DXF drafting remains visible over the
            // selected room, and its outline is reinforced after the details.
            // CAD wireframe edges (STEP) are stroked, never filled.
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
                    let wire = transform.linePath(for: element)
                    stroke.withAlphaComponent(selected ? 0.95 : 0.45).setStroke()
                    wire.lineWidth = selected ? 1.6 : 0.6
                    wire.lineJoinStyle = .round
                    wire.lineCapStyle = .round
                    wire.stroke()
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

        let caption = model.warnings.first ?? [model.storeyLabel, model.viewLabel].filter { !$0.isEmpty }.joined(separator: " · ")
        label(caption, in: NSRect(x: rect.minX + 11, y: rect.maxY - 20, width: rect.width - 22, height: 15),
              font: .systemFont(ofSize: 10), color: .secondaryLabelColor)
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
    /// Markdown blocks or plain text lines around the cited passage.
    var textBlocks: [AssistTextBlock] = []
    var isMarkdown = false

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
        // The server reports "—" when an object has no recorded position.
        let reported = [preview["location"] as? String, source["location"] as? String]
            .compactMap { $0 }.first { !$0.isEmpty && $0 != "—" } ?? ""
        let context = [preview["text"] as? String, source["context"] as? String]
            .compactMap { $0 }.first { !$0.isEmpty && $0 != "—" } ?? ""
        var result = AssistDocumentPreview(
            filename: source["filename"] as? String ?? "",
            path: root["path"] as? String ?? "",
            location: reported,
            context: context,
            valueText: source["valueText"] as? String,
            objectType: source["objectType"] as? String ?? "SOURCE",
            snapshotVersion: (source["snapshotVersion"] as? NSNumber)?.intValue,
            columns: preview["columns"] as? [String] ?? [],
            headers: preview["headers"] as? [String] ?? [],
            rows: rows, model: model, unavailableReason: unavailable,
            pdf: pdf)
        if kind == "text" {
            result.isMarkdown = preview["format"] as? String == "markdown"
            result.textBlocks = result.isMarkdown
                ? (preview["blocks"] as? [[String: Any]] ?? []).map(AssistTextBlock.init(markdown:))
                : (preview["lines"] as? [[String: Any]] ?? []).map(AssistTextBlock.init(line:))
        }
        return result
    }
}

/// One rendered unit of a text preview: a Markdown block or a plain text line.
struct AssistTextBlock: Equatable {
    var type: String
    var level = 0
    var marker: String? = nil
    var checked: Bool? = nil
    var text: String
    var rows: [[String]] = []
    var cited = false
    var lineNumber: Int? = nil

    init(type: String, text: String, level: Int = 0, marker: String? = nil, cited: Bool = false) {
        self.type = type
        self.text = text
        self.level = level
        self.marker = marker
        self.cited = cited
    }

    init(markdown json: [String: Any]) {
        type = json["type"] as? String ?? "paragraph"
        level = (json["level"] as? NSNumber)?.intValue ?? 0
        marker = json["marker"] as? String
        checked = json["checked"] as? Bool
        text = json["text"] as? String ?? ""
        rows = (json["rows"] as? [[Any]] ?? []).map { $0.map { String(describing: $0) } }
        cited = json["cited"] as? Bool ?? false
    }

    init(line json: [String: Any]) {
        type = "line"
        text = json["value"] as? String ?? ""
        cited = json["cited"] as? Bool ?? false
        lineNumber = (json["lineNumber"] as? NSNumber)?.intValue
    }
}

/// Native Markdown typography. Inline syntax uses Foundation's parser, and the
/// server supplies block structure so every surface splits sections alike.
enum AssistMarkdown {
    static func inline(_ text: String, font: NSFont, color: NSColor) -> NSMutableAttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        let result = NSMutableAttributedString()
        for run in parsed.runs {
            var runFont = font
            var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: color]
            if let intent = run.inlinePresentationIntent {
                var traits: NSFontDescriptor.SymbolicTraits = []
                if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
                if intent.contains(.emphasized) { traits.insert(.italic) }
                if intent.contains(.code) {
                    runFont = .monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: .regular)
                    attributes[.backgroundColor] = NSColor.quaternaryLabelColor.withAlphaComponent(0.22)
                } else if !traits.isEmpty {
                    let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(traits))
                    runFont = NSFont(descriptor: descriptor, size: font.pointSize) ?? font
                }
                if intent.contains(.strikethrough) {
                    attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                }
            }
            if run.link != nil { attributes[.foregroundColor] = NSColor.linkColor }
            attributes[.font] = runFont
            result.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return result
    }

    static func headingFont(level: Int, base: CGFloat) -> NSFont {
        switch level {
        case 1: return .systemFont(ofSize: base + 5, weight: .bold)
        case 2: return .systemFont(ofSize: base + 3, weight: .semibold)
        case 3: return .systemFont(ofSize: base + 1.5, weight: .semibold)
        default: return .systemFont(ofSize: base, weight: .semibold)
        }
    }

    /// The attributed text for one block, including list and quote indentation.
    static func attributed(_ block: AssistTextBlock, baseSize: CGFloat,
                           color: NSColor = .labelColor) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = 1.5
        let body = NSFont.systemFont(ofSize: baseSize)
        let result: NSMutableAttributedString
        switch block.type {
        case "heading":
            result = inline(block.text, font: headingFont(level: block.level, base: baseSize), color: color)
        case "item":
            let indent = CGFloat(block.level) * 14
            let markerWidth: CGFloat = block.marker.map { $0.count > 2 ? 22 : 14 } ?? 14
            paragraph.firstLineHeadIndent = indent
            paragraph.headIndent = indent + markerWidth
            paragraph.tabStops = [NSTextTab(textAlignment: .left, location: indent + markerWidth)]
            let marker = block.checked.map { $0 ? "☑" : "☐" } ?? block.marker ?? "•"
            result = NSMutableAttributedString(string: "\(marker)\t", attributes: [
                .font: body, .foregroundColor: NSColor.secondaryLabelColor])
            result.append(inline(block.text, font: body, color: color))
        case "quote":
            paragraph.firstLineHeadIndent = 10
            paragraph.headIndent = 10
            result = inline(block.text, font: body, color: .secondaryLabelColor)
        case "code", "line":
            result = NSMutableAttributedString(string: block.text.isEmpty ? " " : block.text, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: baseSize - 1, weight: .regular), .foregroundColor: color])
        case "table":
            result = NSMutableAttributedString()
            for (index, row) in block.rows.enumerated() {
                if index > 0 { result.append(NSAttributedString(string: "\n")) }
                let cells = inline(row.joined(separator: "   │   "),
                                   font: index == 0 ? .systemFont(ofSize: baseSize, weight: .semibold) : body,
                                   color: color)
                result.append(cells)
            }
        case "rule":
            result = NSMutableAttributedString(string: " ", attributes: [.font: NSFont.systemFont(ofSize: 4)])
        default:
            result = inline(block.text, font: body, color: color)
        }
        result.addAttribute(.paragraphStyle, value: paragraph,
                            range: NSRange(location: 0, length: result.length))
        return result
    }

    static func height(of text: NSAttributedString, width: CGFloat) -> CGFloat {
        ceil(text.boundingRect(with: NSSize(width: max(1, width), height: .greatestFiniteMagnitude),
                               options: [.usesLineFragmentOrigin, .usesFontLeading]).height)
    }

    static func spacing(before block: AssistTextBlock, after previous: AssistTextBlock?) -> CGFloat {
        guard let previous else { return 0 }
        if block.type == "line" && previous.type == "line" { return 0 }
        if block.type == "item" && previous.type == "item" { return 2 }
        if block.type == "heading" { return 9 }
        return 6
    }

    /// Draws a preview so its first cited block is visible, with the
    /// preceding context that fits above it.
    static func draw(_ blocks: [AssistTextBlock], in rect: NSRect, accent: NSColor, baseSize: CGFloat = 10.5) {
        guard !blocks.isEmpty else { return }
        let width = rect.width - 20
        let texts = blocks.map { attributed($0, baseSize: baseSize) }
        let heights = texts.map { height(of: $0, width: width) }
        let gaps = blocks.indices.map { spacing(before: blocks[$0], after: $0 > 0 ? blocks[$0 - 1] : nil) }
        var start = blocks.firstIndex { $0.cited } ?? 0
        var above: CGFloat = 0
        while start > 0, above + heights[start - 1] + gaps[start] <= rect.height * 0.35 {
            above += heights[start - 1] + gaps[start]
            start -= 1
        }
        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8).addClip()
        var y = rect.minY + 9
        for index in start..<blocks.count {
            if index > start { y += gaps[index] }
            guard y < rect.maxY else { break }
            let block = blocks[index]
            let frame = NSRect(x: rect.minX + 10, y: y, width: width, height: heights[index])
            if block.cited {
                let highlight = frame.insetBy(dx: -5, dy: block.type == "line" ? 0 : -2.5)
                accent.withAlphaComponent(0.14).setFill()
                NSBezierPath(roundedRect: highlight, xRadius: 4, yRadius: 4).fill()
                accent.setFill()
                NSRect(x: highlight.minX, y: highlight.minY, width: 2.5, height: highlight.height).fill()
            }
            switch block.type {
            case "rule":
                NSColor.separatorColor.setFill()
                NSRect(x: frame.minX, y: frame.midY, width: frame.width, height: 1).fill()
            case "quote":
                NSColor.tertiaryLabelColor.setFill()
                NSRect(x: frame.minX, y: frame.minY, width: 2.5, height: frame.height).fill()
            case "code":
                NSColor.quaternaryLabelColor.withAlphaComponent(0.18).setFill()
                NSBezierPath(roundedRect: frame.insetBy(dx: -4, dy: -3), xRadius: 4, yRadius: 4).fill()
            default: break
            }
            texts[index].draw(with: frame, options: [.usesLineFragmentOrigin, .usesFontLeading])
            y += heights[index]
        }
        NSGraphicsContext.current?.restoreGraphicsState()
    }
}
