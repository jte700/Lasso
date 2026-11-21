// The card's highlighted suggestion written as ghost text after the caret
// (GhostTextOverlay.swift): what Tab would add, dim, with a Tab key beside it.
// It follows the card: another row, the caret moving, or the card closing.

import Cocoa

extension GlobalAssistant {
    /// Writes the rest of what Tab would insert after the caret, or takes the
    /// ghost away when there is nothing Tab would write there as plain words.
    func updateGhostText() {
        guard let panel, panel.isVisible, view.mode == .suggestions, view.wordChoice == nil,
              !PassagePickerController.shared.isPresented(in: panel),
              !SheetPickerController.shared.isPresented(in: panel),
              !ShareComposerController.shared.isPresented(in: panel),
              let context, let caret = popupCaret, let suggestion = currentSuggestion,
              !suggestion.opensPassagePicker,
              case .success(let plan) = planInsertion(for: suggestion, in: context),
              let rest = GhostLayout.remainder(of: plan) else {
            GhostTextOverlay.shared.cardClosed()
            return
        }
        GhostTextOverlay.shared.offer(rest, element: context.element, caret: context.absoluteCaret,
                                      caretRect: caret, typed: context.text)
    }

    /// Tab is writing `plan`: the ghost's letters brighten and hop over the words.
    func acceptGhostText(_ plan: CompletionPlan) {
        guard let rest = GhostLayout.remainder(of: plan) else {
            GhostTextOverlay.shared.withdraw()
            return
        }
        GhostTextOverlay.shared.accept(writing: rest) { [weak self] in self?.updateGhostText() }
    }
}
