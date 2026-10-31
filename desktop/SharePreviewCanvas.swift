// The scrolling preview's canvas, and the cells and blocks it records for the mouse to hit.

import Cocoa

struct ShareHitTarget {
    let rect: NSRect
    let kind: String
    let sheet: Int?
    let row: Int?
    let column: Int?
    let block: Int?

    var key: String {
        if kind == "CELL" { return "cell:\(sheet ?? 0):\(row ?? -1):\(column ?? -1)" }
        return "block:\(block ?? -1)"
    }

    func redaction(effect: ShareRedactionEffect) -> ShareRedaction {
        ShareRedaction(kind: kind, sheet: sheet, row: row, column: column,
                       block: block, effect: effect)
    }
}

final class SharePreviewCanvas: NSView {
    weak var composer: ShareComposerView?
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) { composer?.drawScrollablePreview(dirtyRect) }
    override func mouseDown(with event: NSEvent) { composer?.previewMouseDown(at: convert(event.locationInWindow, from: nil)) }
    override func mouseDragged(with event: NSEvent) {
        _ = autoscroll(with: event)
        composer?.previewMouseDragged(at: convert(event.locationInWindow, from: nil))
    }
    override func mouseUp(with event: NSEvent) { composer?.previewMouseUp(at: convert(event.locationInWindow, from: nil)) }
}
