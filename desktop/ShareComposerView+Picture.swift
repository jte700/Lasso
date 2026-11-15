// A shared picture in the composer: drawn whole, and in Select & redact with
// the areas dragged over it covered, as the recipient's copy will be.

import Cocoa

extension ShareComposerView {
    func drawPicture(in rect: NSRect) {
        guard let picture, picture.size.width > 0, picture.size.height > 0 else {
            drawCentered(isPictureLoading ? "Loading picture…" : "Picture preview unavailable", in: rect)
            return
        }
        let frame = Self.fitted(picture.size, in: rect)
        picture.draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        let layout = ShareDrawingLayout(frame: frame, kind: "IMAGE")
        drawingLayout = layout
        guard scope == .redacted else { return }
        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(rect: frame).addClip()
        for mask in masks.values where mask.kind == "IMAGE" {
            if let area = layout.rect(for: mask) { drawDrawingMask(mask.effect, in: area) }
        }
        NSGraphicsContext.current?.restoreGraphicsState()
    }

    /// `size` as large as fits in `rect`, centred, never stretched.
    static func fitted(_ size: NSSize, in rect: NSRect) -> NSRect {
        let scale = min(rect.width / size.width, rect.height / size.height)
        let width = (size.width * scale).rounded(), height = (size.height * scale).rounded()
        return NSRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height)
    }
}
