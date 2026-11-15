// fn+Tab on a spreadsheet's or CSV's suggestion opens the sheet picker on its
// sheet. One highlighted cell is inserted as Tab inserts a suggestion; more
// are pasted as Excel copies them, so the app takes a table where it can.

import Cocoa
import UniformTypeIdentifiers

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

    /// The suggestion as the picker makes it: the cells' text, typed exactly.
    /// It still replaces the typed words it was found by only when the cited
    /// cell is among those highlighted. A table starts on a line of its own.
    static func sheetSuggestion(_ pick: SheetPick, from suggestion: AssistSuggestion, before: String) -> AssistSuggestion {
        var chosen = suggestion
        chosen.verbatim = true
        chosen.opensPassagePicker = false
        chosen.sentenceContinuation = false
        chosen.startsMidLine = false
        if !pick.includesCited { chosen.replacement = nil }
        if pick.single {
            chosen.insertText = pick.plain
            chosen.joinsTyping = false
        } else {
            chosen.insertText = SheetClipboard.block(pick.plain, after: before)
            chosen.joinsTyping = true
        }
        return chosen
    }

    private func insertSheetPick(_ pick: SheetPick, from suggestion: AssistSuggestion, context: CaretContext) {
        let chosen = Self.sheetSuggestion(pick, from: suggestion, before: context.text)
        if pick.single { insertPlain(chosen); return }
        pasteSheetCells(pick, as: chosen, context: context)
    }

    /// Pastes the cells as HTML, RTF and tab-separated text together, once a
    /// fresh read shows the field is still as it was. The app's own ⌘Z takes
    /// a paste back.
    private func pasteSheetCells(_ pick: SheetPick, as chosen: AssistSuggestion, context: CaretContext) {
        undoableInsertion = nil
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
                var formats: [NSPasteboard.PasteboardType: Data] = [.string: Data(plan.insertText.utf8), .html: Data(pick.html.utf8)]
                if let rtf = pick.rtf { formats[.rtf] = rtf }
                // Spreadsheets read the cells in place from tab-separated text.
                formats[NSPasteboard.PasteboardType(UTType.utf8TabSeparatedText.identifier)] = Data(pick.tsv.utf8)
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
