// Tab on a passage opens the passage picker on its document; the words the
// writer highlights there are inserted, or inserted as a share link, through
// the card's usual insertion.

import Cocoa

extension GlobalAssistant {
    /// Opens the picker over the card; false when it cannot open, and Tab inserts as before.
    func openPassagePicker(for suggestion: AssistSuggestion) -> Bool {
        guard let serverURL, let savedContext = context, let objectId = suggestion.passageObjectId else { return false }
        let savedSelection = view.selected
        let savedScope = view.sourceScoped
        // An answer still coming for the words typed must not replace the picker.
        generation += 1
        debounce?.invalidate()
        debounce = nil
        request?.cancel()
        request = nil
        flashTimer?.invalidate()
        PassagePickerController.shared.show(
            objectId: objectId, versionId: suggestion.versionId, snapshotId: suggestion.snapshotId,
            name: (suggestion.path as NSString).lastPathComponent, typed: savedContext.text,
            projectId: suggestion.projectId, serverURL: serverURL, hostPanel: existingPanel(), linkAvailable: suggestion.shareable,
            onInsert: { [weak self] pick in self?.insertPick(pick, from: suggestion, context: savedContext) },
            onLink: { [weak self] pick in self?.linkPick(pick, from: suggestion, context: savedContext) },
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

    /// The suggestion as the highlight makes it: its words, in place of the
    /// typed words they begin with, typed exactly as the picker shows them.
    static func picked(_ pick: PassagePick, from suggestion: AssistSuggestion, context: CaretContext) -> AssistSuggestion? {
        guard let plan = PassageInsertion.plan(body: pick.body, citation: pick.citation, quoted: pick.quoted,
                                               before: context.text, replacing: pick.replacing),
              let replacement = CompletionReplacement.capture(start: plan.replaceStart, end: plan.replaceEnd, in: context.text)
        else { return nil }
        var chosen = suggestion
        chosen.insertText = plan.text
        chosen.replacement = replacement
        chosen.joinsTyping = true
        chosen.sentenceContinuation = false
        chosen.startsMidLine = false
        chosen.opensPassagePicker = false
        chosen.fromPassagePicker = true
        // Words picked from a sentence completion's passage are linked to that passage.
        chosen.objectId = suggestion.passageObjectId
        if let time = pick.videoTime { chosen.videoTime = time }
        return chosen
    }

    private func insertPick(_ pick: PassagePick, from suggestion: AssistSuggestion, context: CaretContext) {
        guard let chosen = Self.picked(pick, from: suggestion, context: context) else {
            hide()
            flash(["Could not insert here.", "Nothing was changed."])
            return
        }
        insertPlain(chosen)
    }

    private func linkPick(_ pick: PassagePick, from suggestion: AssistSuggestion, context: CaretContext) {
        guard let chosen = Self.picked(pick, from: suggestion, context: context) else {
            hide()
            flash(["Could not insert here.", "Nothing was changed."])
            return
        }
        beginShare(chosen)
    }
}
