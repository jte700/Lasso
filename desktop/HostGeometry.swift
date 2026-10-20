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
