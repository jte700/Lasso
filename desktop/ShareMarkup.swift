//  Pen, marker and highlighter strokes drawn on a copy of a document to share.
//
//  The share composer shows a PDF, Word document or deck as pages. A stroke
//  belongs to one page and keeps its points against that page's crop box,
//  from the top left and normalized to 0...1, as PDF redaction regions are,
//  so the server's renderer draws the shared copy with the marks in place.

import Cocoa

enum ShareMarkTool: String, CaseIterable {
    case pen = "PEN"
    case marker = "MARKER"
    case highlighter = "HIGHLIGHTER"

    var title: String {
        switch self {
        case .pen: return "Pen"
        case .marker: return "Marker"
        case .highlighter: return "Highlighter"
        }
    }

    // How wide each tool draws, as a share of the page's width, and how much
    // of the page shows through. Keep in sync with strokeStyle in
    // scripts/render-shared-pdf.swift, which draws the shared copy. That copy
    // also multiplies the highlighter into the page, so text under it stays
    // dark; the composer draws on a layer of its own, where it cannot, and
    // tints that text a little.
    var widthFraction: CGFloat {
        switch self {
        case .pen: return 0.0032
        case .marker: return 0.009
        case .highlighter: return 0.024
        }
    }

    var alpha: CGFloat { self == .highlighter ? 0.38 : 1 }

    /// A highlighter starts yellow, as one does; the others start in ink colours.
    var defaultColor: ShareMarkColor {
        switch self {
        case .pen: return .red
        case .marker: return .blue
        case .highlighter: return .yellow
        }
    }
}

enum ShareMarkColor: String, CaseIterable {
    case black = "#1D1D1F"
    case red = "#E5372B"
    case blue = "#0A84FF"
    case green = "#28A745"
    case yellow = "#FFD60A"

    var title: String {
        switch self {
        case .black: return "Black"
        case .red: return "Red"
        case .blue: return "Blue"
        case .green: return "Green"
        case .yellow: return "Yellow"
        }
    }

    var color: NSColor {
        let value = Int(rawValue.dropFirst(), radix: 16) ?? 0
        return NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                       blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }
}

struct ShareMarkStroke: Equatable {
    /// The server's limit for one stroke; a longer one ends there.
    static let maxPoints = 2000
    /// Points closer than this, in page points, add nothing a reader would see.
    static let spacing: CGFloat = 1
    private static let precision: Double = 10_000

    let tool: ShareMarkTool
    let color: ShareMarkColor
    /// Counted from 1, as PDF pages are.
    let page: Int
    /// From the crop box's top left, each 0...1.
    private(set) var points: [CGPoint]

    init(tool: ShareMarkTool, color: ShareMarkColor, page: Int, start: NSPoint, crop: NSRect) {
        self.tool = tool
        self.color = color
        self.page = page
        points = [Self.normalized(start, crop: crop)]
    }

    /// A point on the page, in page space, as the stroke keeps it; a point off the page is held at its edge.
    static func normalized(_ point: NSPoint, crop: NSRect) -> CGPoint {
        guard crop.width > 0, crop.height > 0 else { return .zero }
        return CGPoint(x: min(1, max(0, (point.x - crop.minX) / crop.width)),
                       y: min(1, max(0, (crop.maxY - point.y) / crop.height)))
    }

    /// Where a kept point is on the page, in page space.
    static func pagePoint(_ point: CGPoint, crop: NSRect) -> NSPoint {
        NSPoint(x: crop.minX + point.x * crop.width, y: crop.maxY - point.y * crop.height)
    }

    /// Adds where the pointer moved to; false when the stroke is full.
    @discardableResult
    mutating func extend(to point: NSPoint, crop: NSRect) -> Bool {
        guard points.count < Self.maxPoints else { return false }
        let last = Self.pagePoint(points[points.count - 1], crop: crop)
        if hypot(point.x - last.x, point.y - last.y) >= Self.spacing { points.append(Self.normalized(point, crop: crop)) }
        return true
    }

    func lineWidth(crop: NSRect) -> CGFloat { tool.widthFraction * crop.width }

    /// Whether the eraser at `point`, in page space, touches the stroke.
    func isTouched(by point: NSPoint, crop: NSRect, reach: CGFloat) -> Bool {
        let limit = lineWidth(crop: crop) / 2 + reach
        let placed = points.map { Self.pagePoint($0, crop: crop) }
        guard placed.count > 1 else { return hypot(point.x - placed[0].x, point.y - placed[0].y) <= limit }
        return zip(placed, placed.dropFirst()).contains { start, end in
            Self.distance(from: point, toSegment: start, end) <= limit
        }
    }

    private static func distance(from point: NSPoint, toSegment start: NSPoint, _ end: NSPoint) -> CGFloat {
        let dx = end.x - start.x, dy = end.y - start.y
        let length = dx * dx + dy * dy
        let along = length == 0 ? 0 : min(1, max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length))
        return hypot(point.x - (start.x + along * dx), point.y - (start.y + along * dy))
    }

    /// Draws the stroke where `place` puts page points, `scale` view points to a page point.
    func draw(in context: CGContext, crop: NSRect, scale: CGFloat, place: (NSPoint) -> NSPoint) {
        let path = CGMutablePath()
        for (index, point) in points.enumerated() {
            let placed = place(Self.pagePoint(point, crop: crop))
            if index == 0 { path.move(to: placed) } else { path.addLine(to: placed) }
        }
        // A single point is a dot.
        if points.count == 1 { path.addLine(to: path.currentPoint) }
        context.saveGState()
        context.setAlpha(tool.alpha)
        context.setStrokeColor(color.color.cgColor)
        context.setLineWidth(lineWidth(crop: crop) * scale)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.addPath(path)
        context.strokePath()
        context.restoreGState()
    }

    var payload: [String: Any] {
        let rounded = { (value: CGFloat) in (Double(value) * Self.precision).rounded() / Self.precision }
        return ["tool": tool.rawValue, "color": color.rawValue, "page": page,
                "points": points.flatMap { [rounded($0.x), rounded($0.y)] }]
    }
}

/// What the composer's pages hold while they are marked up: the tool in hand,
/// a colour for each tool, the strokes so far and the one being drawn. A drag,
/// whether it draws or erases, is one step for ⌘Z.
struct ShareMarkupSession {
    enum Hand: Equatable {
        case tool(ShareMarkTool)
        case eraser
    }

    /// The server's limits for one marked copy: strokes, and their points together.
    static let maxStrokes = 400
    static let maxPoints = 100_000

    var hand = Hand.tool(.pen)
    private var colors = Dictionary(uniqueKeysWithValues: ShareMarkTool.allCases.map { ($0, $0.defaultColor) })
    private(set) var marks: [ShareMarkStroke] = []
    private(set) var draft: ShareMarkStroke?
    private var history = ShareEditHistory<[ShareMarkStroke]>()
    /// The marks when the drag under way began.
    private var before: [ShareMarkStroke]?

    func color(for tool: ShareMarkTool) -> ShareMarkColor { colors[tool] ?? tool.defaultColor }

    /// The colour the tool in hand draws with; the eraser has none.
    var color: ShareMarkColor? {
        if case .tool(let tool) = hand { return color(for: tool) }
        return nil
    }

    /// Gives the tool in hand a colour, or puts the pen back in hand when the eraser is.
    mutating func choose(_ color: ShareMarkColor) {
        if case .tool(let tool) = hand {
            colors[tool] = color
        } else {
            hand = .tool(.pen)
            colors[.pen] = color
        }
    }

    /// Starts a stroke, or erasing, at `point` in page space. False when the
    /// copy holds as many strokes as it can and the tool in hand draws.
    @discardableResult
    mutating func begin(page: Int, at point: NSPoint, crop: NSRect, reach: CGFloat) -> Bool {
        cancel()
        switch hand {
        case .eraser:
            before = marks
            erase(page: page, at: point, crop: crop, reach: reach)
            return true
        case .tool(let tool):
            guard marks.count < Self.maxStrokes,
                  marks.reduce(0, { $0 + $1.points.count }) < Self.maxPoints else { return false }
            before = marks
            draft = ShareMarkStroke(tool: tool, color: color(for: tool), page: page, start: point, crop: crop)
            return true
        }
    }

    mutating func move(to point: NSPoint, page: Int, crop: NSRect, reach: CGFloat) {
        guard before != nil else { return }
        if hand == .eraser {
            erase(page: page, at: point, crop: crop, reach: reach)
        } else if var stroke = draft, stroke.page == page {
            stroke.extend(to: point, crop: crop)
            draft = stroke
        }
    }

    /// Keeps the stroke drawn, and records the drag as one step.
    mutating func end() {
        guard let start = before else { return }
        if let draft { marks.append(draft) }
        draft = nil
        before = nil
        history.record(from: start, to: marks)
    }

    /// Drops a stroke under way, as when the composer changes what it shows.
    mutating func cancel() {
        if let start = before { marks = start }
        draft = nil
        before = nil
    }

    @discardableResult
    mutating func undo() -> Bool {
        cancel()
        guard let previous = history.undo(from: marks) else { return false }
        marks = previous
        return true
    }

    @discardableResult
    mutating func redo() -> Bool {
        cancel()
        guard let next = history.redo(from: marks) else { return false }
        marks = next
        return true
    }

    private mutating func erase(page: Int, at point: NSPoint, crop: NSRect, reach: CGFloat) {
        marks.removeAll { $0.page == page && $0.isTouched(by: point, crop: crop, reach: reach) }
    }
}
