// Mouse, scroll and pinch input on the composer, and undo and redo of its redactions and excerpt.

import Cocoa

extension ShareComposerView {
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        redactionDrag = nil
        drawingDrag = nil
        endMaskEdit()
        notice = nil
        if NSRect(x: bounds.width - 40, y: 7, width: 30, height: 30).contains(point) {
            onCancel?(); return
        }
        if offersNearbyRows && nearbyRowsRect.contains(point) {
            includesNearbyRows.toggle()
            return
        }
        if NSRect(x: 0, y: 0, width: bounds.width - 50, height: headerHeight).contains(point) {
            window?.performDrag(with: event)
            return
        }
        if cancelButtonRect.contains(point) {
            onCancel?(); return
        }
        if actionButtonRect.contains(point) {
            submit(); return
        }
        guard !isCopying else { return }
        // Dragging a STEP model turns it; a double-click puts it back.
        if rotatableModel(at: point) != nil {
            if event.clickCount >= 2 { modelView = AssistModelView() } else { modelDrag = (point, modelView) }
            needsDisplay = true
            return
        }
        if isPDFSource {
            if scope == .redacted, pdfTextModeRect.contains(point) {
                pdfSelectionMode = .text; needsDisplay = true; return
            }
            if scope == .redacted, pdfAreaModeRect.contains(point) {
                pdfSelectionMode = .area; needsDisplay = true; return
            }
        }
        if scope == .marked, choosePaletteItem(at: point) { return }
        for (index, offered) in scopes.enumerated() where scopeRect(index).contains(point) {
            scope = offered
            needsDisplay = true
            return
        }
        if scope != .indexed,
           let tab = sheetTabTargets.first(where: { $0.rect.contains(point) }) {
            sheetIndex = tab.index
            scrollLayoutKey = ""
            targets.removeAll()
            needsDisplay = true
            return
        }
        if scope == .redacted {
            if blurEffectRect.contains(point) {
                effect = .blur; needsDisplay = true; return
            }
            if redactEffectRect.contains(point) {
                effect = .blank; needsDisplay = true; return
            }
            if let layout = drawingLayout, layout.frame.contains(point) {
                if let mask = masks.values.first(where: { layout.rect(for: $0)?.contains(point) == true }) {
                    beginMaskEdit()
                    masks.removeValue(forKey: mask.locationKey)
                    endMaskEdit()
                } else if masks.count >= 64 {
                    notice = "Use up to 64 drawing masks. Click a mask to remove it."
                } else {
                    drawingDrag = (point, masks, effect)
                    beginMaskEdit()
                }
                needsDisplay = true
                return
            }
        }

    }

    func submit() {
        guard copyState == .idle else { return }
        guard scope != .redacted || !masks.isEmpty else {
            notice = "Select an area before creating the link."
            needsDisplay = true
            return
        }
        guard scope != .marked || !markup.marks.isEmpty else {
            notice = "Draw on the document before creating the link."
            needsDisplay = true
            return
        }
        let redactions = scope == .redacted ? Array(masks.values) : []
        onCreate?(ShareConfiguration(scope: scope, redactions: redactions,
                                     markup: scope == .marked ? markup.marks : [],
                                     nearbyRows: offersNearbyRows && includesNearbyRows,
                                     citedIn: citedIn))
    }

    override func scrollWheel(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        // Rolling a wheel away, or pushing two fingers away, zooms in, as in the card.
        let away = event.isDirectionInvertedFromDevice ? -event.scrollingDeltaY : event.scrollingDeltaY
        if !previewScroll.isHidden, previewScroll.frame.contains(point) {
            previewScroll.scrollWheel(with: event)
        } else if !zoomModel(by: exp(away * (event.hasPreciseScrollingDeltas ? 0.01 : 0.1)), at: point) {
            super.scrollWheel(with: event)
        }
    }

    override func magnify(with event: NSEvent) {
        if !zoomModel(by: 1 + event.magnification, at: convert(event.locationInWindow, from: nil)) { super.magnify(with: event) }
    }

    override func mouseDragged(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let drag = modelDrag, let sent = shownModel?.model.orbit?.camera {
            modelView = drag.view.dragged(by: CGSize(width: point.x - drag.start.x, height: point.y - drag.start.y), from: sent)
            needsDisplay = true
            return
        }
        updateRedactionDrag(at: point)
    }

    override func mouseUp(with event: NSEvent) {
        modelDrag = nil
        updateRedactionDrag(at: convert(event.locationInWindow, from: nil))
        redactionDrag = nil
        drawingDrag = nil
        endMaskEdit()
    }

    // MARK: Undo

    func beginMaskEdit() {
        if gestureMasks == nil { gestureMasks = masks }
    }

    /// A drag or click is one step for ⌘Z, however many masks it changed.
    func endMaskEdit() {
        guard let before = gestureMasks else { return }
        gestureMasks = nil
        history.record(from: before, to: masks)
    }

    /// ⌘Z: the masks as they were before the last drag or click, or the marks
    /// before the last stroke.
    func undoEdit() {
        if scope == .marked { if !isCopying, markup.undo() { showMarks() }; return }
        guard readyForMaskStep(), let previous = history.undo(from: masks) else { return }
        showMaskStep(previous)
    }

    /// ⇧⌘Z: the edit ⌘Z last took back.
    func redoEdit() {
        if scope == .marked { if !isCopying, markup.redo() { showMarks() }; return }
        guard readyForMaskStep(), let next = history.redo(from: masks) else { return }
        showMaskStep(next)
    }

    /// Only the redaction view shows masks, so it alone steps through them.
    private func readyForMaskStep() -> Bool {
        guard !isCopying, scope == .redacted else { return false }
        redactionDrag = nil
        drawingDrag = nil
        endMaskEdit()
        return true
    }

    private func showMaskStep(_ next: [String: ShareRedaction]) {
        let changed = Set(masks.keys).union(next.keys).filter { masks[$0] != next[$0] }
        let sheets = Set(changed.compactMap { (masks[$0] ?? next[$0]).flatMap { $0.kind == "CELL" ? $0.sheet ?? 0 : nil } })
        masks = next
        // A step on another worksheet brings that worksheet into view.
        if !sheets.isEmpty, !sheets.contains(sheetIndex), let sheet = sheets.min() {
            sheetIndex = sheet
            scrollLayoutKey = ""
            targets.removeAll()
        }
        notice = nil
        needsDisplay = true
    }

    /// The Edit menu's Undo and Redo, when the composer's own panel has focus.
    @objc func undo(_ sender: Any?) { undoEdit() }
    @objc func redo(_ sender: Any?) { redoEdit() }

    func updateRedactionDrag(at point: NSPoint) {
        if !isCopying, scope == .redacted, let drag = drawingDrag, let layout = drawingLayout {
            masks = drag.masks
            if let region = layout.redaction(from: drag.start, to: point, effect: drag.effect) {
                masks[region.locationKey] = region
            }
            needsDisplay = true
            return
        }
        guard !isCopying, scope == .redacted, let drag = redactionDrag else { return }
        let eligible = targets.filter {
            $0.kind == drag.anchor.kind && ($0.sheet ?? 0) == (drag.anchor.sheet ?? 0)
        }
        // Clamp to the nearest cell when the pointer leaves the table. The
        // anchor and endpoint define the range, independent of event frequency.
        func distance(to rect: NSRect) -> CGFloat {
            let dx = max(rect.minX - point.x, max(0, point.x - rect.maxX))
            let dy = max(rect.minY - point.y, max(0, point.y - rect.maxY))
            return dx * dx + dy * dy
        }
        guard let target = eligible.first(where: { $0.rect.contains(point) })
            ?? eligible.min(by: { distance(to: $0.rect) < distance(to: $1.rect) }) else { return }
        masks = drag.masks(through: target.redaction(effect: drag.anchor.effect))
        needsDisplay = true
    }
}
