// ⌥Tab: choosing the folder or connected app suggestions come from. The
// switcher (ScopeSwitcher.swift) opens on the one in use; Return keeps the
// one it shows until All is chosen again, that folder is switched off, or
// Lasso quits. Meanwhile the card's footer names it beside ⌥⇥.

import Cocoa

extension GlobalAssistant {
    /// ⌥Tab is Lasso's: suggestions are on, a folder is switched on, and the
    /// app in front is not one Lasso stays quiet in.
    var scopeSwitchAvailable: Bool {
        guard isEnabled, serverURL != nil, !projectIds.isEmpty else { return false }
        guard let app = Self.frontmostBundleID else { return true }
        return SuggestionApps.shared.allows(app)
    }

    /// The switched-on folders and apps, from the Lasso menu's last reading.
    /// A chosen one switched off goes back to All; the menu's own update then
    /// asks for suggestions again.
    func updateSourceScope(_ folders: [SourceScopeEntry]) {
        let before = sourceScope.entries
        sourceScope.update(folders)
        showScopeOnCard()
        // The pill's place in a list that changed under it no longer means the same folder.
        if before != sourceScope.entries { ScopeSwitcherController.shared.hide() }
    }

    func openScopeSwitcher() {
        // The caret the card was following, or the one read last in the app now in front.
        let known = panel?.isVisible == true ? popupCaret : context.flatMap { context -> CGRect? in
            var pid: pid_t = 0
            guard AXUIElementGetPid(context.element, &pid) == .success,
                  pid == NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
            return context.caretRect
        }
        dismiss()
        let switcher = ScopeSwitcherController.shared
        switcher.onDismiss = { [weak self] in self?.publishKeyRouting() }
        let index = sourceScope.chosenIndex
        switcher.open(sourceScope.entries[index], index: index, isCurrent: true)
        if let known { switcher.present(at: known) }
        // Read where the caret is now; the pill moves there if it has moved.
        AccessibilityWork.queue.async {
            let caret = AccessibilityReader.focusedContext()?.caretRect
            DispatchQueue.main.async {
                // Without a caret either way, the pill shows at the pointer.
                guard switcher.isOpen, known == nil || (caret != nil && caret != known) else { return }
                switcher.present(at: caret)
            }
        }
    }

    func rollScopeSwitcher(by steps: Int) {
        let switcher = ScopeSwitcherController.shared
        guard switcher.isOpen else { return }
        let index = sourceScope.index(from: switcher.shownIndex, by: steps)
        switcher.roll(to: sourceScope.entries[index], index: index, forward: steps > 0,
                      isCurrent: index == sourceScope.chosenIndex)
    }

    /// Return: suggestions come from the folder shown, starting with the words
    /// already typed, even in a sentence Escape had quieted.
    func chooseShownScope() {
        let switcher = ScopeSwitcherController.shared
        guard switcher.isOpen else { return }
        sourceScope.choose(at: switcher.shownIndex)
        switcher.hide()
        showScopeOnCard()
        escapeQuiet.clear()
        escapedElement = nil
        feedbackDismissed = false
        scheduleRefresh()
    }

    private func showScopeOnCard() {
        let title = sourceScope.chosenProjectId == nil ? nil : sourceScope.chosen.title
        guard view.scopeTitle != title else { return }
        view.scopeTitle = title
        view.needsDisplay = true
    }
}
