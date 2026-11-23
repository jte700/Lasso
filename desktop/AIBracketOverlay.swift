// Brackets drawn around text an AI wrote, in that AI's colour: an opening
// bracket before its first letter and a closing one after its last, each as
// tall as its line, in the space beside the words so no letter is covered:
// within two fifths of a single space, and only arms where a letter touches.
// Hovering a part washes its lines faintly in the same colour. The panel
// never takes a click: links drawn inside an AI-written part keep working.

import Cocoa

/// How much space a bracket has beside a part's words: none (a letter
/// touches it), one space mid-sentence, or more (a line's start or end, an indent).
enum AIRoom: Equatable {
    case none, tight, wide

    private static func isSpace(_ unit: UInt16) -> Bool { [9, 32, 160].contains(unit) }
    private static func isBreak(_ unit: UInt16) -> Bool { [10, 13, 0x2028, 0x2029].contains(unit) }

    static func before(_ range: Range<Int>, in units: [UInt16]) -> AIRoom {
        let index = range.lowerBound - 1
        guard index >= 0, index < units.count else { return .wide }
        if isBreak(units[index]) { return .wide }
        guard isSpace(units[index]) else { return .none }
        return index == 0 || isSpace(units[index - 1]) || isBreak(units[index - 1]) ? .wide : .tight
    }

    static func after(_ range: Range<Int>, in units: [UInt16]) -> AIRoom {
        let index = range.upperBound
        guard index < units.count else { return .wide }
        if isBreak(units[index]) { return .wide }
        guard isSpace(units[index]) else { return .none }
        return index + 1 >= units.count || isSpace(units[index + 1]) || isBreak(units[index + 1]) ? .wide : .tight
    }
}

/// One AI-written part as drawn: its lines in AppKit coordinates, top first.
struct AIBracketGroup: Equatable {
    let id: String
    let info: AIMarkInfo
    let lines: [CGRect]
    let roomBefore: AIRoom
    let roomAfter: AIRoom

    var bounds: CGRect { lines.dropFirst().reduce(lines.first ?? .zero) { $0.union($1) } }

    /// The part's own lines and its brackets.
    func contains(_ point: CGPoint) -> Bool {
        lines.contains { $0.insetBy(dx: -AIBracketShape.wideGap - 3, dy: -1).contains(point) }
    }

    /// Lines in reading order, from rectangles in any order.
    static func readingOrder(_ rects: [CGRect]) -> [CGRect] {
        rects.sorted { abs($0.midY - $1.midY) > 1 ? $0.midY > $1.midY : $0.minX < $1.minX }
    }
}

/// The bracket's measures, shared by drawing and hit-testing.
enum AIBracketShape {
    /// Space between a bracket and the letter it stands beside, where there is more than a space.
    static let wideGap: CGFloat = 3
    /// The arms' reach toward the words.
    static let arm: CGFloat = 3.2
    static let width: CGFloat = 1.4

    /// Where the bracket's stroke is centred from the letter: in a single
    /// space it keeps within two fifths of the space, so the letter on the
    /// other side is never touched. A space is about a fifth of a line's height.
    static func gap(_ room: AIRoom, line: CGRect) -> CGFloat {
        switch room {
        case .wide: return wideGap
        case .tight: return min(wideGap, max(0.6, line.height * 0.19 * 0.4 - width / 2))
        case .none: return 0
        }
    }

    /// An opening bracket before `line`'s first letter, arms reaching right.
    static func opening(beside line: CGRect, room: AIRoom) -> NSBezierPath {
        bracket(x: line.minX - gap(room, line: line), line: line, toward: 1, room: room)
    }

    /// A closing bracket after `line`'s last letter, arms reaching left.
    static func closing(beside line: CGRect, room: AIRoom) -> NSBezierPath {
        bracket(x: line.maxX + gap(room, line: line), line: line, toward: -1, room: room)
    }

    /// Without room beside the letters, only the arms are drawn, at the top and foot of the line.
    private static func bracket(x: CGFloat, line: CGRect, toward: CGFloat, room: AIRoom) -> NSBezierPath {
        let inset = min(1.5, line.height * 0.08)
        let top = line.maxY - inset
        let bottom = line.minY + inset
        let reach = x + arm * toward
        let path = NSBezierPath()
        path.lineWidth = width
        path.lineCapStyle = .butt
        path.lineJoinStyle = .miter
        if room == .none {
            path.move(to: CGPoint(x: x, y: top))
            path.line(to: CGPoint(x: reach, y: top))
            path.move(to: CGPoint(x: x, y: bottom))
            path.line(to: CGPoint(x: reach, y: bottom))
        } else {
            path.move(to: CGPoint(x: reach, y: top))
            path.line(to: CGPoint(x: x, y: top))
            path.line(to: CGPoint(x: x, y: bottom))
            path.line(to: CGPoint(x: reach, y: bottom))
        }
        return path
    }
}

final class AIBracketView: NSView {
    private(set) var groups: [AIBracketGroup] = []
    var hoveredId: String? { didSet { if hoveredId != oldValue { needsDisplay = true } } }
    var panelFrame: CGRect = .zero

    override var isFlipped: Bool { false }

    func show(_ groups: [AIBracketGroup]) {
        guard groups != self.groups else { return }
        self.groups = groups
        needsDisplay = true
    }

    /// What is drawn, in screen coordinates, with room for the brackets.
    var paintedBounds: CGRect? {
        guard let first = groups.first else { return nil }
        let union = groups.dropFirst().reduce(first.bounds) { $0.union($1.bounds) }
        return union.insetBy(dx: -(AIBracketShape.wideGap + AIBracketShape.width + 4), dy: -4)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        context.translateBy(x: -panelFrame.minX, y: -panelFrame.minY)
        for group in groups {
            guard let first = group.lines.first, let last = group.lines.last else { continue }
            let color = group.info.style.color
            let hovered = group.id == hoveredId
            if hovered {
                color.withAlphaComponent(0.09).setFill()
                for line in group.lines { NSBezierPath(roundedRect: line.insetBy(dx: -1, dy: 0), xRadius: 2, yRadius: 2).fill() }
            }
            color.withAlphaComponent(hovered ? 1 : 0.85).setStroke()
            let opening = AIBracketShape.opening(beside: first, room: group.roomBefore)
            let closing = AIBracketShape.closing(beside: last, room: group.roomAfter)
            opening.stroke()
            closing.stroke()
        }
        context.restoreGState()
    }
}

/// The brackets' panel sits just under the linked-word pills', so a pill inside a part is drawn over its wash.
final class AIBracketPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    convenience init(view: NSView) {
        self.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue - 1)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        ignoresMouseEvents = true
        contentView = view
    }
}
