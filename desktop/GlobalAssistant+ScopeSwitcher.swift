// ⌥Tab: choosing the folder or connected app suggestions come from. The
// switcher (ScopeSwitcher.swift) opens on the one in use; Return keeps the
// one it shows until All is chosen again, that folder is switched off, or
// Lasso quits. Meanwhile the card's footer names it beside ⌥⇥. ↓ shows the
// switcher's second row, the AI writer a backslash prompt is handed to, which
// Return keeps too, from one launch to the next. Holding ⌥Tab shows the
// folders as a list to pick from with the arrows or a click.

import Cocoa

extension GlobalAssistant {
    /// ⌥Tab is Lasso's: suggestions are on, a folder is switched on, and the
    /// app in front is not one Lasso stays quiet in.
    var scopeSwitchAvailable: Bool {
        guard isEnabled, serverURL != nil, !projectIds.isEmpty else { return false }
        guard let app = Self.frontmostBundleID else { return true }
        return SuggestionApps.shared.allows(app)
    }

    /// The switched-on folders and apps, from the Lasso menu's last reading,
    /// with how often each was used. A chosen one switched off goes back to
    /// All; the menu's own update then asks for suggestions again.
    func updateSourceScope(_ folders: [SourceScopeEntry], uses: [String: Int]) {
        let before = sourceScope.entries
        sourceScope.update(folders, uses: uses)
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
        switcher.onChoose = { [weak self] in
            self?.chooseShownScope()
            self?.publishKeyRouting()
        }
        let index = sourceScope.chosenIndex
        switcher.open(sourceScope.entries[index], index: index, isCurrent: true, writerIndex: writer.choice.chosenIndex)
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
        if switcher.isListing { return switcher.moveInList(by: steps) }
        switch switcher.row {
        case .folders:
            let index = sourceScope.index(from: switcher.shownIndex, by: steps)
            switcher.roll(to: sourceScope.entries[index], index: index, forward: steps > 0,
                          isCurrent: index == sourceScope.chosenIndex)
        case .writers:
            let index = writer.choice.index(from: switcher.shownWriterIndex, by: steps)
            switcher.roll(to: writer.choice.entries[index].scopeEntry, index: index, forward: steps > 0,
                          isCurrent: index == writer.choice.chosenIndex)
        }
    }

    /// ⌥Tab held on the folders: the pill grows into their list, highlighting
    /// the folder it showed, or All when that one is not among the five used most.
    func holdScopeSwitcher() {
        let switcher = ScopeSwitcherController.shared
        guard switcher.isOpen, switcher.row == .folders, !switcher.isListing else { return }
        let indexes = sourceScope.listIndexes
        let chosen = sourceScope.chosenIndex
        let rows = indexes.map { ScopeListRow(index: $0, entry: sourceScope.entries[$0], isChosen: $0 == chosen) }
        let note = sourceScope.listIsTrimmed
            ? ScopeList.trimmedNote(shown: indexes.count - 1, of: sourceScope.entries.count - 1) : nil
        let highlighted = indexes.firstIndex(of: switcher.shownIndex) ?? 0
        switcher.showList(ScopeList(rows: rows, highlighted: highlighted, note: note))
    }

    /// ↓ shows who writes a prompt, on the writer that row last showed; ↑ goes
    /// back to where suggestions come from.
    func switchScopeRow(by steps: Int) {
        let switcher = ScopeSwitcherController.shared
        guard switcher.isOpen else { return }
        if steps > 0 {
            let index = switcher.shownWriterIndex
            switcher.show(row: .writers, entry: writer.choice.entries[index].scopeEntry,
                          isCurrent: index == writer.choice.chosenIndex)
        } else {
            let index = switcher.shownIndex
            switcher.show(row: .folders, entry: sourceScope.entries[index], isCurrent: index == sourceScope.chosenIndex)
        }
    }

    /// Return: suggestions come from the folder shown, starting with the words
    /// already typed, even in a sentence Escape had quieted, and prompts go to
    /// the writer shown on the row below.
    func chooseShownScope() {
        let switcher = ScopeSwitcherController.shared
        guard switcher.isOpen else { return }
        sourceScope.choose(at: switcher.shownIndex)
        chooseWriter(at: switcher.shownWriterIndex)
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
