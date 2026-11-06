// Accepting a suggestion: plain text or a share link, checked after it lands, and taken back by undo.

import Cocoa
import ApplicationServices

extension GlobalAssistant {
    func move(_ delta: Int) {
        if view.mode == .confirmShare {
            view.selected = (view.selected + delta + view.confirmChoices.count) % view.confirmChoices.count
            view.needsDisplay = true
            return
        }
        guard !view.suggestions.isEmpty else { return }
        selectRow((view.selected + delta + view.suggestions.count) % view.suggestions.count)
    }

    /// `Tab`. Follows the insertion preference; sharing is never implicit.
    func activateSelection() {
        guard view.mode == .suggestions,
              let suggestion = currentSuggestion else { hide(); return }
        switch InsertionMode.current {
        case .plain:
            acceptPlain()
        case .share:
            if suggestion.isShareable { acceptShared() } else { acceptPlain() }
        case .ask:
            if suggestion.isShareable { askBeforeSharing() } else { acceptPlain() }
        }
    }

    var currentSuggestion: AssistSuggestion? {
        guard view.selected < view.suggestions.count else { return nil }
        return view.suggestions[view.selected]
    }

    private func askBeforeSharing() {
        pendingShare = currentSuggestion
        view.mode = .confirmShare
        view.title = "Insert as plain text or a share link?"
        view.confirmChoices = ["Plain text", "Share link…"]
        view.selected = 0
        refreshPanelGeometry()
        publishKeyRouting()
    }

    func resolveConfirmation() {
        let shareIt = view.selected == 1
        guard let suggestion = pendingShare else { hide(); return }
        pendingShare = nil
        view.mode = .suggestions
        if shareIt { beginShare(suggestion) } else { insertPlain(suggestion) }
    }

    func acceptPlain() {
        guard let suggestion = currentSuggestion else { hide(); return }
        insertPlain(suggestion)
    }

    /// Explicit Share action (or `⇧⌘⏎`). Never reached by the local-link shortcut.
    func acceptShared() {
        guard view.mode == .suggestions, let suggestion = currentSuggestion else { return }
        guard suggestion.isShareable else {
            flash([suggestion.objectId == nil ? "This suggestion has no linkable source."
                   : "Lasso doesn\u{2019}t make share links for code. Tab inserts it as text."])
            return
        }
        beginShare(suggestion)
    }

    private func beginShare(_ suggestion: AssistSuggestion) {
        guard let serverURL, let savedContext = context, !suggestion.projectId.isEmpty, let objectId = suggestion.objectId else {
            flash(["Sharing is unavailable right now."])
            return
        }
        let anchor = panel?.frame ?? NSRect(origin: NSEvent.mouseLocation, size: .zero)
        let savedSelection = view.selected
        let savedScope = view.sourceScoped
        // Keep the existing nonactivating panel and its host focus throughout
        // access selection. Late predictions must not replace this content.
        generation += 1
        debounce?.invalidate()
        debounce = nil
        request?.cancel()
        request = nil
        flashTimer?.invalidate()
        ShareComposerController.shared.show(
            objectId: objectId, versionId: suggestion.versionId,
            label: suggestion.label, sourcePath: suggestion.path, near: anchor, serverURL: serverURL, actionTitle: "Insert link",
            hostPanel: existingPanel(),
            onCancel: { [weak self] in
                guard let self else { return }
                self.view.mode = .suggestions
                self.view.selected = savedSelection
                self.view.sourceScoped = savedScope
                self.showMeasuringHost(self.view.suggestions)
            }
        ) { [weak self] configuration in
            self?.insertShared(suggestion, configuration: configuration, context: savedContext, serverURL: serverURL)
        }
        // The composer grows down from the card's top edge. With the card above
        // the caret that would cover the typed line, so place it as the card is.
        if let popupCaret { reposition(near: popupCaret) }
    }

    // MARK: Insertion

    /// Stage A. Builds the smallest edit that turns what the user typed into the
    /// suggestion, refusing anything that would touch text it should not.
    private func planInsertion(for suggestion: AssistSuggestion,
                               in context: CaretContext) -> Result<CompletionPlan, CompletionFailure> {
        let window = Array(context.text.utf16)
        // The captured window ends at the caret, so the caret is its length.
        let caret = window.count
        // Code keeps its letters as written.
        let cased = suggestion.verbatim || suggestion.joinsTyping ? suggestion.insertText
            : Self.matchCasing(of: suggestion.insertText,
                               replacing: suggestion.replacement?.expectedText ?? Self.trailingWord(window),
                               precededBy: window, upTo: suggestion.replacement?.start ?? window.count)
        return CompletionTransaction.plan(document: window, caret: caret, insertText: cased,
                                          replacement: suggestion.replacement,
                                          separateInsertion: !suggestion.sentenceContinuation && !suggestion.joinsTyping)
    }

    /// The run of characters before the caret, used only to decide casing.
    private static func trailingWord(_ window: [UInt16]) -> String {
        var start = window.count
        while start > 0, window[start - 1] != 32, window[start - 1] != 10 { start -= 1 }
        return String(decoding: window[start...], as: UTF16.self)
    }

    /// The host is read and written on the Accessibility queue. Each step
    /// that returns to the main thread before anything is written is dropped
    /// if a hide or new typing happened meanwhile; once writing has started,
    /// the insertion always finishes verifying and reports.
    private func insertPlain(_ suggestion: AssistSuggestion) {
        undoableInsertion = nil
        guard let context else { hide(); return }

        guard case .success(let plan) = planInsertion(for: suggestion, in: context) else {
            hide()
            flash(["Could not insert here.", "Nothing was changed."])
            return
        }

        // Stage A: confirm the plan is still current against a fresh read.
        let token = generation
        AccessibilityWork.queue.async { [weak self] in
            let fresh = AccessibilityReader.focusedContext()
            DispatchQueue.main.async {
                guard let self, token == self.generation else { return }
                self.writePlain(suggestion, plan: plan, context: context, fresh: fresh)
            }
        }
    }

    /// Checks the fresh read against the planned context, then writes.
    private func writePlain(_ suggestion: AssistSuggestion, plan: CompletionPlan,
                            context: CaretContext, fresh: CaretContext?) {
        guard let fresh, CFEqual(fresh.element, context.element),
              fresh.windowStart == context.windowStart, fresh.absoluteCaret == context.absoluteCaret,
              CompletionTransaction.equivalentHostText(Array(fresh.text.utf16), Array(context.text.utf16)) else {
            hide()
            return
        }
        let before = Array(fresh.text.utf16)
        let beforeSnapshot = CompletionSnapshot(documentStart: fresh.windowStart,
                                                text: before)
        if CompletionTransaction.validate(plan, against: before, caret: before.count) != nil {
            hide()
            return
        }

        hide()
        let element = context.element
        AccessibilityWork.queue.async { [weak self] in
            AccessibilityReader.replace(length: plan.range.count, at: context.absoluteCaret,
                                        with: plan.insertText, in: element, expected: fresh,
                                        expectedPrefix: plan.expectedPrefix,
                                        verbatim: suggestion.verbatim) { applied in
                // Something may have been written, so this reports even if a
                // hide or new typing happened meanwhile.
                let check = Self.checkInsertion(plan: plan, before: beforeSnapshot, element: element, applied: applied)
                DispatchQueue.main.async {
                    self?.reportInsertion(check, plan: plan, suggestion: suggestion, element: element)
                }
            }
        }
    }

    /// What reading the host back after an insertion found.
    private enum InsertionCheck {
        case notApplied
        case hostLost
        case failed(CompletionFailure)
        case verified(VerifiedCompletion, after: CaretContext)
    }

    /// Stages A→B, on the Accessibility queue. Reads the host back and proves
    /// only the intended interval changed.
    private static func checkInsertion(plan: CompletionPlan, before: CompletionSnapshot,
                                       element: AXUIElement, applied: Bool) -> InsertionCheck {
        guard applied else { return .notApplied }
        guard let after = AccessibilityReader.focusedContext(extending: plan.insertText.utf16.count),
              after.element == element else { return .hostLost }
        let afterSnapshot = CompletionSnapshot(documentStart: after.windowStart, text: Array(after.text.utf16))
        switch CompletionTransaction.verify(before: before, after: afterSnapshot, plan: plan) {
        case .failure(let failure): return .failed(failure)
        case .success(let verified): return .verified(verified, after: after)
        }
    }

    /// Records a dependency only for an insertion proved by `checkInsertion`.
    private func reportInsertion(_ check: InsertionCheck, plan: CompletionPlan,
                                 suggestion: AssistSuggestion, element: AXUIElement) {
        switch check {
        case .notApplied:
            flash(["The insertion could not be verified.", "No source reference was recorded."])
        case .hostLost:
            flash(["Text inserted, but its source could not be anchored here."])
        case .failed(let failure):
            if failure == .outsideRangeModified {
                flash(["Insertion touched other text.", "No dependency was recorded."])
            }
        case .verified(let verified, let after):
            undoableInsertion = AcceptedInsertion(element: element, caret: verified.documentRange.upperBound,
                                                  inserted: plan.insertText, replaced: plan.expectedPrefix)
            recordInsertion(verified, after: after, plan: plan, suggestion: suggestion, element: element)
        }
    }

    private func recordInsertion(_ verified: VerifiedCompletion, after: CaretContext, plan: CompletionPlan,
                                 suggestion: AssistSuggestion, element: AXUIElement) {
        let afterUnits = Array(after.text.utf16)
        let content = plan.sourceRange ?? 0..<plan.insertText.utf16.count
        let sourceRange = (verified.snapshotRange.lowerBound + content.lowerBound)..<(verified.snapshotRange.lowerBound + content.upperBound)
        let sourceText = String(decoding: afterUnits[sourceRange], as: UTF16.self)
        #if BROWSER_GEOMETRY_TEST
        if regressionPrediction {
            regressionAccepted = ["text": sourceText,
                "start": after.windowStart + sourceRange.lowerBound,
                "end": after.windowStart + sourceRange.upperBound,
                "objectId": suggestion.objectId ?? ""]
            return
        }
        #endif
        recordAcceptedUsage(suggestion)
        // The next suggestion should offer this source's values, not the
        // same phrase again.
        if let objectId = suggestion.objectId, let snapshotId = suggestion.snapshotId {
            linkedSources.record(.init(projectId: suggestion.projectId, objectId: objectId, snapshotId: snapshotId,
                                       text: sourceText), in: afterUnits, at: sourceRange,
                                 reachesStart: after.windowStart == 0)
        }
        // A sentence continuation carries its source object as the usage
        // id. It is linked and highlighted like any other inserted source.
        let continuationSource = suggestion.sentenceContinuation
            && suggestion.usageObjectId != "completion-source" ? suggestion.usageObjectId : nil
        guard let objectId = suggestion.objectId ?? continuationSource else {
            return
        }
        // Stage B: the reference starts from the verified range, never from
        // a fresh search of the document.
        undoableInsertion?.referenceId = DependencyHighlighter.shared.recordVerifiedInsertion(
            objectId: objectId, versionId: suggestion.versionId,
            projectId: suggestion.projectId,
            label: suggestion.label, valueText: suggestion.detail,
            sourcePath: suggestion.path, sourceLocation: suggestion.detail,
            document: afterUnits, range: sourceRange,
            documentOffset: after.windowStart, element: element, videoTime: suggestion.videoTime)
    }

    /// A share link on its way into the host, planned against `before`.
    private struct LinkInsertion {
        let suggestion: AssistSuggestion
        let plan: CompletionPlan
        let before: CompletionSnapshot
        let element: AXUIElement
        let caret: Int
        let serverURL: URL
    }

    /// How a pasted link ended. One that did not land is already revoked; one
    /// whose text went in as plain text is already copied.
    private enum LinkOutcome {
        case notPasted
        case unverified
        case linked(InsertionCheck)
        case plainText(InsertionCheck)
    }

    /// Create the record, build the URL, insert the link, verify it landed, and
    /// revoke the record if it did not. The host is read and written on the
    /// Accessibility queue, as for plain insertion.
    private func insertShared(_ suggestion: AssistSuggestion, configuration: ShareConfiguration,
                              context: CaretContext, serverURL: URL) {
        undoableInsertion = nil
        guard let objectId = suggestion.objectId else {
            flash(["Sharing is unavailable right now."])
            return
        }
        guard case .success(let planned) = planInsertion(for: suggestion, in: context) else {
            flash(["Could not insert here.", "Nothing was changed."])
            return
        }
        hide()
        let token = generation
        AccessibilityWork.queue.async { [weak self] in
            let fresh = AccessibilityReader.focusedContext()
            DispatchQueue.main.async {
                // No link exists yet, so a hide or new typing meanwhile drops it.
                guard let self, token == self.generation else { return }
                guard let fresh, fresh.element == context.element,
                      fresh.absoluteCaret == context.absoluteCaret, fresh.windowStart == context.windowStart,
                      CompletionTransaction.equivalentHostText(Array(fresh.text.utf16), Array(context.text.utf16)) else {
                    self.flash(["The insertion point changed. Choose the source again."])
                    return
                }
                let before = CompletionSnapshot(documentStart: fresh.windowStart, text: Array(fresh.text.utf16))
                self.createShare(objectId: objectId, configuration: configuration,
                                 for: LinkInsertion(suggestion: suggestion, plan: planned, before: before,
                                                    element: context.element, caret: context.absoluteCaret,
                                                    serverURL: serverURL))
            }
        }
    }

    private func createShare(objectId: String, configuration: ShareConfiguration, for link: LinkInsertion) {
        flash(["Creating share link…"])
        let suggestion = link.suggestion
        ShareClient.createShare(serverURL: link.serverURL, projectId: suggestion.projectId,
                                objectId: objectId, versionId: suggestion.versionId, configuration: configuration) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure:
                    // No record, so nothing was inserted and nothing to clean up.
                    self.flash(["Could not create the share link.", "Nothing was inserted."])
                case .success(let share):
                    self.performLinkInsertion(share, link)
                }
            }
        }
    }

    /// The box only shows "Creating share link…" by now, and measuring or
    /// following that message can hide it without the user doing anything.
    /// So the fresh read alone decides, as it did on the main thread: typing
    /// or a move to another editor changes it, and the link is revoked.
    private func performLinkInsertion(_ share: DependencyShare, _ link: LinkInsertion) {
        AccessibilityWork.queue.async { [weak self] in
            let fresh = AccessibilityReader.focusedContext()
            DispatchQueue.main.async {
                guard let self else { ShareClient.revokeShare(serverURL: link.serverURL, token: share.token); return }
                guard let fresh, fresh.element == link.element,
                      fresh.absoluteCaret == link.caret, fresh.windowStart == link.before.documentStart,
                      CompletionTransaction.equivalentHostText(Array(fresh.text.utf16), link.before.text) else {
                    ShareClient.revokeShare(serverURL: link.serverURL, token: share.token)
                    self.flash(["The insertion point changed. Nothing was inserted."])
                    return
                }
                self.isInserting = true
                AccessibilityWork.queue.async { [weak self] in
                    Self.pasteLink(share, link) { outcome in
                        // Writing has started, so this always reports.
                        DispatchQueue.main.async { self?.finishLinkInsertion(outcome, share: share, link: link) }
                    }
                }
            }
        }
    }

    /// Accessibility queue. Pastes the link, then reads the host back until it
    /// shows the link or the attempts run out. A link that did not land is
    /// revoked here, and one whose text went in as plain text is copied;
    /// `completion` runs on the queue too.
    private static func pasteLink(_ share: DependencyShare, _ link: LinkInsertion,
                                  completion: @escaping (LinkOutcome) -> Void) {
        let plan = link.plan
        RichTextInserter.insertLink(label: plan.insertText, url: share.url, replacing: plan.range.count,
                                   at: link.caret, in: link.element, keyboardDeleteCount: plan.expectedPrefix.count,
                                   validateSelection: { selected in
            AccessibilityReader.canPaste(in: link.element, before: link.before, caret: link.caret,
                                         expectedPrefix: plan.expectedPrefix, selected: selected)
        }) { pasted in
            guard pasted else {
                ShareClient.revokeShare(serverURL: link.serverURL, token: share.token)
                completion(.notPasted)
                return
            }
            var landing: RichTextInserter.LinkLanding?
            // Read the captured editor itself: the user may switch apps
            // before the editor's accessibility tree catches up.
            RichTextInserter.verifyEventually(verify: {
                guard let after = AccessibilityReader.context(of: link.element) else {
                    landing = nil
                    return false
                }
                let snapshot = CompletionSnapshot(documentStart: after.windowStart, text: Array(after.text.utf16))
                landing = RichTextInserter.landing(of: plan, before: link.before, after: snapshot) { label in
                    AccessibilityReader.hyperlinkPresent(label, url: share.url, in: after)
                }
                // A rich editor can show the text before its link, so only
                // the link ends the wait early.
                return landing == .linked
            }) { _ in
                switch landing {
                case .linked?:
                    completion(.linked(checkInsertion(plan: plan, before: link.before,
                                                      element: link.element, applied: true)))
                case .plainText?:
                    RichTextInserter.copyLink(share.url)
                    completion(.plainText(checkInsertion(plan: plan, before: link.before,
                                                         element: link.element, applied: true)))
                case nil:
                    ShareClient.revokeShare(serverURL: link.serverURL, token: share.token)
                    completion(.unverified)
                }
            }
        }
    }

    private func finishLinkInsertion(_ outcome: LinkOutcome, share: DependencyShare, link: LinkInsertion) {
        isInserting = false
        switch outcome {
        case .notPasted:
            flash(["The insertion point changed. Nothing was inserted."])
        case .unverified:
            flash(["The link could not be verified.", "Its access link was revoked."])
        case .linked(let check):
            reportInsertion(check, plan: link.plan, suggestion: link.suggestion, element: link.element)
            if case .verified = check {
                undoableInsertion?.share = share
                undoableInsertion?.serverURL = link.serverURL
            }
            let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(share.url.host ?? "")
            flash(["Hyperlink inserted",
                   local ? "Available only on this Mac" : "Source access is set by your sharing choice"])
        case .plainText(let check):
            reportInsertion(check, plan: link.plan, suggestion: link.suggestion, element: link.element)
            var pid: pid_t = 0
            AXUIElementGetPid(link.element, &pid)
            let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "This app"
            flash(["\(app) can\u{2019}t hold a link here.", "Link copied."])
        }
    }

    // MARK: Undo

    /// ⌘Z right after a Tab or an inserted link takes that insertion back
    /// while its text still ends at the caret. Otherwise the ⌘Z the tap held
    /// goes on to the host.
    func undoInsertion() {
        guard let insertion = undoableInsertion else { SyntheticKeyboard.undo(); return }
        undoableInsertion = nil
        hide()
        isInserting = true
        AccessibilityWork.queue.async { [weak self] in
            guard let fresh = AccessibilityReader.focusedContext(extending: insertion.inserted.utf16.count),
                  CFEqual(fresh.element, insertion.element),
                  let plan = insertion.revertPlan(windowStart: fresh.windowStart, text: Array(fresh.text.utf16),
                                                  caret: fresh.absoluteCaret) else {
                SyntheticKeyboard.undo()
                DispatchQueue.main.async { self?.isInserting = false }
                return
            }
            AccessibilityReader.revert(plan, in: insertion.element, expected: fresh,
                                       unlink: insertion.share != nil) { reverted in
                DispatchQueue.main.async { self?.finishUndo(insertion, reverted: reverted) }
            }
        }
    }

    private func finishUndo(_ insertion: AcceptedInsertion, reverted: Bool) {
        isInserting = false
        guard reverted else {
            flash(["The insertion could not be taken back here."])
            return
        }
        if let id = insertion.referenceId { DependencyHighlighter.shared.unlink(id: id) }
        // A link taken back is revoked, like one that never landed.
        if let share = insertion.share, let serverURL = insertion.serverURL {
            ShareClient.revokeShare(serverURL: serverURL, token: share.token)
        }
    }

    private func recordAcceptedUsage(_ suggestion: AssistSuggestion) {
        guard let serverURL else { return }
        RecommendationUsageClient.record(serverURL: serverURL, projectId: suggestion.projectId,
                                         objectId: suggestion.usageObjectId, path: suggestion.path,
                                         kind: "accept")
    }

    /// Source labels are stored in title case ("Office Supplies"). Dropped into
    /// the middle of a sentence after a lower-case word, that reads wrong, so
    /// plainly capitalised words are lowered. Acronyms, mixed-case words and
    /// anything containing digits keep their original form.
    private static func matchCasing(of insertion: String, replacing typed: String,
                                    precededBy window: [UInt16], upTo index: Int) -> String {
        guard !typed.isEmpty, typed == typed.lowercased() else { return insertion }
        let before = String(decoding: window[0..<min(window.count, max(0, index))], as: UTF16.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // Start of a sentence keeps its capital.
        guard let last = before.last, !".!?:".contains(last) else { return insertion }

        func lowerIfPlainTitleCase(_ word: Substring) -> String {
            guard let first = word.first, first.isUppercase else { return String(word) }
            let rest = word.dropFirst()
            guard word.count > 1,
                  rest.allSatisfy({ $0.isLowercase || $0 == "'" || $0 == "-" }) else { return String(word) }
            return first.lowercased() + rest
        }
        return insertion.split(separator: " ", omittingEmptySubsequences: false)
            .map(lowerIfPlainTitleCase)
            .joined(separator: " ")
    }
}
