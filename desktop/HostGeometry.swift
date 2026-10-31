//  Coordinate conversion and dependency geometry.
//
//  Several coordinate systems meet here: Accessibility reports rectangles with
//  the origin at the top-left of the primary display, AppKit windows use a
//  bottom-left origin, and displays can sit above or left of the primary one.
//  All of that is confined to this file so no other code carries an offset.

import Foundation
import CoreGraphics

enum HostGeometryConverter {
    /// Height of the primary display — the axis both systems hinge on.
    static func primaryHeight(_ heights: [CGRect]) -> CGFloat {
        heights.first(where: { $0.origin == .zero })?.height ?? heights.first?.height ?? 0
    }

    /// Accessibility rectangle → AppKit screen rectangle.
    static func toAppKit(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX,
               y: primaryHeight - rect.maxY,
               width: rect.width,
               height: rect.height)
    }

    /// AppKit screen rectangle → Accessibility rectangle.
    static func toAccessibility(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX,
               y: primaryHeight - rect.maxY,
               width: rect.width,
               height: rect.height)
    }

    /// AppKit screen rectangle → a transparent overlay panel's local space.
    /// NSView.convert(_:from:nil) starts in window coordinates, not screen
    /// coordinates, so screen geometry must have the panel origin removed first.
    static func toPanelLocal(_ rect: CGRect, panelFrame: CGRect) -> CGRect {
        rect.offsetBy(dx: -panelFrame.minX, dy: -panelFrame.minY)
    }

    /// True when a rectangle carries usable geometry.
    static func isUsable(_ rect: CGRect) -> Bool {
        rect.width.isFinite && rect.height.isFinite
            && rect.origin.x.isFinite && rect.origin.y.isFinite
            && rect.width > 0 && rect.height > 0 && rect.height < 400
    }

    /// Endpoints plus the whole range must agree before skipping line splitting.
    /// The whole bounds check also handles selections that cross columns and
    /// return to the starting vertical position.
    static func isSingleLine(whole: CGRect, first: CGRect, last: CGRect) -> Bool {
        guard isUsable(whole), isUsable(first), isUsable(last) else { return false }
        let tolerance = max(1, min(first.height, last.height) * 0.15)
        return abs(first.minY - last.minY) <= tolerance
            && abs(first.maxY - last.maxY) <= tolerance
            && whole.minY >= min(first.minY, last.minY) - tolerance
            && whole.maxY <= max(first.maxY, last.maxY) + tolerance
    }
}

/// Which line the caret is on. Apple Notes reports a collapsed range one line
/// above the line it draws, while the characters beside the caret measure where
/// they are drawn, so a card placed from the collapsed range covered the line
/// being typed. A character touching the caret on the same line settles it.
enum CaretLine {
    /// How far a character's edge may sit from the caret and still touch it.
    static let touchTolerance: CGFloat = 1.5

    /// `before` is the character just before the caret and `after` the one at
    /// it, each measured in Accessibility coordinates and nil when it is a line
    /// break, which can be drawn on another line than the caret's. `after` is
    /// only measured when `before` does not touch the caret, as at a line start.
    /// The caret keeps its own x; only its line moves.
    static func aligned(_ caret: CGRect, before: CGRect?, after: @autoclosure () -> CGRect?) -> CGRect {
        func touching(_ character: CGRect?, edge: (CGRect) -> CGFloat) -> CGRect? {
            guard let character, HostGeometryConverter.isUsable(character),
                  abs(edge(character) - caret.minX) <= touchTolerance else { return nil }
            return character
        }
        guard let line = touching(before, edge: \.maxX) ?? touching(after(), edge: \.minX),
              !sharesLine(caret, line) else { return caret }
        return CGRect(x: caret.minX, y: line.minY, width: caret.width, height: line.height)
    }

    /// Two rectangles share a line when they overlap for half the shorter one.
    private static func sharesLine(_ first: CGRect, _ second: CGRect) -> Bool {
        let overlap = min(first.maxY, second.maxY) - max(first.minY, second.minY)
        return overlap >= min(first.height, second.height) / 2
    }
}

/// Where the suggestion card goes beside the caret, in AppKit coordinates.
struct CaretCardPlacement: Equatable {
    let frame: CGRect
    /// True when the card hangs below the caret and points up at it.
    let pointerAtTop: Bool
    /// The pointer's distance from the card's leading edge.
    let pointerX: CGFloat

    static let gap: CGFloat = 2
    static let preferredPointerX: CGFloat = 84
    /// Keeps the pointer clear of the card's rounded corners.
    static let pointerInset: CGFloat = 32

    /// Clear of the text in the host's window. `window` is the window being
    /// written in and `text` the lines of text showing in its editor, both in
    /// AppKit coordinates. The card goes above or below the caret, the text or
    /// the window, wherever it fits on the display without covering the line
    /// being typed: covering the least text, then outside the window, then
    /// nearest the caret. Without either, or when nowhere fits, it goes beside
    /// the caret as `beside(caret:size:visible:)` puts it.
    static func clear(of window: CGRect?, text: CGRect?, caret: CGRect, size: CGSize, visible: CGRect?) -> CaretCardPlacement {
        guard let visible, window != nil || text != nil else { return beside(caret: caret, size: size, visible: visible) }
        let x = min(max(visible.minX, caret.midX - preferredPointerX), visible.maxX - size.width)
        let edges = [caret, text, window].compactMap { $0 }
        let origins = edges.flatMap { [$0.maxY + gap, $0.minY - gap - size.height] }
        func area(_ rect: CGRect) -> CGFloat { rect.isNull ? 0 : rect.width * rect.height }
        func distance(_ frame: CGRect) -> CGFloat { frame.minY >= caret.maxY ? frame.minY - caret.maxY : caret.minY - frame.maxY }
        let fitting = origins.map { CGRect(x: x, y: $0, width: size.width, height: size.height) }.filter { frame in
            frame.minY >= visible.minY && frame.maxY <= visible.maxY
                // The line being typed stays in view.
                && (frame.minY >= caret.maxY || frame.maxY <= caret.minY)
        }
        let best = fitting.min { first, second in
            let covered = (area(first.intersection(text ?? .null)).rounded(), area(second.intersection(text ?? .null)).rounded())
            if covered.0 != covered.1 { return covered.0 < covered.1 }
            let inside = (first.intersects(window ?? .null), second.intersects(window ?? .null))
            if inside.0 != inside.1 { return !inside.0 }
            if distance(first) != distance(second) { return distance(first) < distance(second) }
            return first.minY > second.minY
        }
        guard let frame = best else { return beside(caret: caret, size: size, visible: visible) }
        return CaretCardPlacement(frame: frame, pointerAtTop: frame.maxY <= caret.minY,
                                  pointerX: min(max(caret.midX - x, pointerInset), size.width - pointerInset))
    }

    /// Above the caret by preference, so the card never covers the line being
    /// typed or the lines that follow it. It drops below only when the display
    /// has no room above and more room below. The card is shifted sideways so
    /// its pointer, not its outer edge, sits at the caret.
    static func beside(caret: CGRect, size: CGSize, visible: CGRect?) -> CaretCardPlacement {
        var x = caret.midX - preferredPointerX
        var y = caret.maxY + gap
        var pointerAtTop = false
        if let visible {
            let roomAbove = visible.maxY - caret.maxY - gap
            let roomBelow = caret.minY - gap - visible.minY
            if roomAbove < size.height, roomBelow > roomAbove {
                y = caret.minY - gap - size.height
                pointerAtTop = true
            }
            y = min(max(visible.minY, y), visible.maxY - size.height)
            x = min(max(visible.minX, x), visible.maxX - size.width)
        }
        let pointerX = min(max(caret.midX - x, pointerInset), size.width - pointerInset)
        return CaretCardPlacement(frame: CGRect(x: x, y: y, width: size.width, height: size.height),
                                  pointerAtTop: pointerAtTop, pointerX: pointerX)
    }
}

/// One dependency's drawn geometry. A wrapped phrase is several rectangles that
/// still resolve to a single reference when clicked.
struct DependencyGeometry: Equatable {
    let referenceId: String
    let fragments: [CGRect]

    var bounds: CGRect {
        fragments.dropFirst().reduce(fragments.first ?? .zero) { $0.union($1) }
    }

    func contains(_ point: CGPoint) -> Bool {
        fragments.contains { $0.insetBy(dx: -1, dy: -2).contains(point) }
    }

    /// Merges rectangles that sit on the same text line, which the
    /// Accessibility API often reports per character run.
    static func coalesce(_ rects: [CGRect], referenceId: String) -> DependencyGeometry {
        let sorted = rects.filter(HostGeometryConverter.isUsable).sorted {
            $0.minY == $1.minY ? $0.minX < $1.minX : $0.minY < $1.minY
        }
        var lines: [CGRect] = []
        for rect in sorted {
            if let last = lines.last, abs(last.midY - rect.midY) < max(2, rect.height * 0.5) {
                lines[lines.count - 1] = last.union(rect)
            } else {
                lines.append(rect)
            }
        }
        return DependencyGeometry(referenceId: referenceId, fragments: lines)
    }
}
