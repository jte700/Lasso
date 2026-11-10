// Mouse, scroll and pinch input on the card.

import Cocoa

extension AssistBoxView {
    override func mouseDown(with event: NSEvent) {
        guard mode == .suggestions else { return }
        let point = convert(event.locationInWindow, from: nil)
        // Dragging a STEP preview turns it; a double-click puts it back.
        if rotatableModel(at: point) != nil {
            if event.clickCount >= 2 {
                modelView = AssistModelView()
                needsDisplay = true
            } else {
                modelDrag = (point, modelView)
            }
            return
        }

        if point.x < leftWidth {
            if point.y >= footerY {
                switch footerCommand(at: point.x) {
                case .tab: onInsert?()
                case .insertText: onLocalLink?()
                case .share: onShare?()
                case .dismiss: onDismiss?()
                case nil: break
                }
                return
            }
            guard point.y >= bodyTop else { return }
            // The rows take their own clicks; the header names where it goes:
            // back to the list from a line's words, one level back, or the
            // list of every source.
            if point.y < bodyTop + navigationHeight {
                if wordChoice != nil { onCloseWords?() }
                else if sourceScoped { stepBackName == nil ? onAllSources?() : onStepBack?() }
                return
            }
            // Clicking a word selects it, and dragging selects every word to the one let go on.
            if wordChoice != nil, wordTextRect.contains(point), let word = word(at: point) {
                wordDrag = word
                wordChoice?.select(from: word, to: word)
            }
            return
        }

        guard point.y >= footerY + 6, point.y <= footerY + 41 else { return }
        if !selectedSuggestionIsShareable || point.x < leftWidth + (bounds.width - leftWidth) / 2 { onOpenSource?() }
        else { onShare?() }
    }

    override func mouseDragged(with event: NSEvent) {
        if let first = wordDrag {
            if let last = word(at: convert(event.locationInWindow, from: nil)) { wordChoice?.select(from: first, to: last) }
            return
        }
        guard let drag = modelDrag, let sent = preview?.model?.orbit?.camera else { return }
        let point = convert(event.locationInWindow, from: nil)
        modelView = drag.view.dragged(by: CGSize(width: point.x - drag.start.x, height: point.y - drag.start.y), from: sent)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) { modelDrag = nil; wordDrag = nil }

    override func scrollWheel(with event: NSEvent) {
        // Rolling a wheel away, or pushing two fingers away, zooms in, whatever
        // the scrolling direction setting.
        let away = event.isDirectionInvertedFromDevice ? -event.scrollingDeltaY : event.scrollingDeltaY
        let speed: CGFloat = event.hasPreciseScrollingDeltas ? 0.01 : 0.1
        let point = convert(event.locationInWindow, from: nil)
        if scrollWords(by: event, at: point) { return }
        // The list and the previews are scroll views, which take their own
        // scrolling. Over a table's header, its rows scroll.
        if let table = previewContent as? AssistTableRowsView, documentPreviewRect.contains(point) {
            table.scrollWheel(with: event)
        } else if !zoomModel(by: exp(away * speed), at: point) { super.scrollWheel(with: event) }
    }

    override func magnify(with event: NSEvent) {
        if !zoomModel(by: 1 + event.magnification, at: convert(event.locationInWindow, from: nil)) { super.magnify(with: event) }
    }
}
