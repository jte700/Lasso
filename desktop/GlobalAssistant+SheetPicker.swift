// fn+Tab on a spreadsheet's or CSV's suggestion opens the sheet picker on its
// sheet, and what is highlighted there is pasted as a picture of those cells.
// Tab on the card still inserts the suggestion as text.

import Cocoa

extension GlobalAssistant {
    /// Opens the picker over the card; false when it cannot open, and fn+Tab inserts as Tab does.
    func openSheetPicker(for suggestion: AssistSuggestion) -> Bool {
        guard let serverURL, let savedContext = context, let objectId = suggestion.objectId ?? suggestion.usageObjectId else { return false }
        let savedSelection = view.selected
        let savedScope = view.sourceScoped
        // An answer still coming for the words typed must not replace the picker.
        generation += 1
        debounce?.invalidate()
        debounce = nil
        request?.cancel()
        request = nil
        flashTimer?.invalidate()
        SheetPickerController.shared.show(
            objectId: objectId, versionId: suggestion.versionId, snapshotId: suggestion.snapshotId,
            name: (suggestion.path as NSString).lastPathComponent, projectId: suggestion.projectId,
            serverURL: serverURL, hostPanel: existingPanel(),
            onInsert: { [weak self] pick in self?.insertSheetPick(pick, from: suggestion, context: savedContext) },
            onCancel: { [weak self] in
                guard let self else { return }
                self.view.mode = .suggestions
                self.view.selected = savedSelection
                self.view.sourceScoped = savedScope
                self.showMeasuringHost(self.view.suggestions)
                self.publishKeyRouting()
            })
        publishKeyRouting()
        return true
    }

    /// The suggestion the picture stands in for when its place in the field
    /// is planned. It still replaces the typed words it was found by only
    /// when the cited cell is among those highlighted.
    static func sheetSuggestion(_ pick: SheetPick, from suggestion: AssistSuggestion) -> AssistSuggestion {
        var chosen = suggestion
        // An inline picture is one object replacement character in the field's text.
        chosen.insertText = "\u{FFFC}"
        chosen.verbatim = true
        chosen.joinsTyping = true
        chosen.opensPassagePicker = false
        chosen.sentenceContinuation = false
        chosen.startsMidLine = false
        if !pick.includesCited { chosen.replacement = nil }
        return chosen
    }

    /// Pastes the picture as PNG and TIFF, once a fresh read shows the field
    /// is still as it was. The app's own ⌘Z takes a paste back.
    private func insertSheetPick(_ pick: SheetPick, from suggestion: AssistSuggestion, context: CaretContext) {
        undoableInsertion = nil
        let chosen = Self.sheetSuggestion(pick, from: suggestion)
        guard let plan = fieldPlan(for: chosen, in: context) else {
            hide()
            flash(["Could not insert here.", "Nothing was changed."])
            return
        }
        hide()
        let token = generation
        AccessibilityWork.queue.async { [weak self] in
            let fresh = AccessibilityReader.focusedContext()
            DispatchQueue.main.async {
                guard let self, token == self.generation else { return }
                guard let fresh, fresh.element == context.element, fresh.absoluteCaret == context.absoluteCaret,
                      fresh.windowStart == context.windowStart,
                      CompletionTransaction.equivalentHostText(Array(fresh.text.utf16), Array(context.text.utf16)) else {
                    self.flash(["The insertion point changed. Nothing was inserted."])
                    return
                }
                let before = CompletionSnapshot(documentStart: fresh.windowStart, text: Array(fresh.text.utf16))
                var formats: [NSPasteboard.PasteboardType: Data] = [.png: pick.png]
                if let tiff = pick.tiff { formats[.tiff] = tiff }
                self.isInserting = true
                self.markOwnWrite()
                let element = context.element, caret = context.absoluteCaret
                AccessibilityWork.queue.async { [weak self] in
                    RichTextInserter.insertFormats(formats, replacing: plan.range.count, at: caret, in: element,
                                                   keyboardDeleteCount: plan.expectedPrefix.count,
                                                   validateSelection: { selected in
                        AccessibilityReader.canPaste(in: element, before: before, caret: caret,
                                                     expectedPrefix: plan.expectedPrefix, selected: selected)
                    }) { pasted in
                        DispatchQueue.main.async {
                            guard let self else { return }
                            self.isInserting = false
                            if pasted { self.recordAcceptedUsage(chosen) } else { self.flash(["Could not insert here.", "Nothing was changed."]) }
                            self.publishKeyRouting()
                        }
                    }
                }
            }
        }
    }
}
