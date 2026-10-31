// Asking the server for suggestions as the person types, and reading its answer.

import Cocoa
import ApplicationServices

extension GlobalAssistant {
    // MARK: Suggestion flow

    /// Browse without editing the host document or removing existing links.
    func chooseSource(allDocuments: Bool) {
        guard let serverURL, let savedContext = context else { return }
        let previous = view.suggestions
        let previousSelection = view.selected
        let previousScope = view.sourceScoped
        let replacement = currentSuggestion?.replacement
            ?? CompletionReplacement(start: savedContext.text.utf16.count, expectedText: "")
        let path = allDocuments ? nil : currentSuggestion?.path
        let sourceProjectId = allDocuments ? nil : currentSuggestion?.projectId
        hide()
        SourceChooserController.shared.show(serverURL: serverURL, sourceProjectId: sourceProjectId, sourcePath: path) { [weak self] object in
            guard let self else { return }
            self.context = savedContext
            guard let object, let id = object["id"] as? String, let projectId = object["projectId"] as? String,
                  self.projectIds.contains(projectId) else {
                self.view.selected = previousSelection
                self.view.sourceScoped = previousScope
                self.showMeasuringHost(previous)
                return
            }
            let label = object["label"] as? String ?? "Source"
            let value = object["valueText"] as? String
            let type = object["objectType"] as? String ?? ""
            let suggestion = AssistSuggestion(
                insertText: type == "DATASET_VALUE" ? (value ?? label) : label,
                label: label, detail: value ?? "", path: object["path"] as? String ?? "",
                location: Self.sourceLocation(object), replacement: replacement,
                objectId: id, versionId: object["versionId"] as? String,
                snapshotId: object["snapshotId"] as? String, usageObjectId: id,
                projectId: projectId, rankingReason: nil)
            self.view.selected = 0
            self.view.sourceScoped = true
            self.showMeasuringHost([suggestion])
        }
    }

    func scheduleRefresh() {
        guard !ShareComposerController.shared.isVisible else { return }
        // A brief message must not swallow the next words the writer types,
        // such as the first word of the following sentence. It stays long
        // enough to be read, then gives way to suggestions for that text.
        if view.mode == .message {
            let remaining = Self.minimumMessageTime - Date().timeIntervalSince(messageShownAt)
            guard remaining <= 0 else {
                debounce?.invalidate()
                debounce = Timer.scheduledTimer(withTimeInterval: remaining, repeats: false) { [weak self] _ in
                    self?.hide()
                    self?.scheduleRefresh()
                }
                return
            }
            hide()
        }
        guard view.mode == .suggestions else { return }
        feedbackDismissed = false
        // Invalidate the previous response now, not after the debounce. A late
        // response must not dismiss the next refresh while the user is typing.
        generation += 1
        request?.cancel()
        request = nil
        rereadsLeft = Self.maximumRereads
        // Each key restarts the wait, but it is short enough to fall between
        // keys, so suggestions follow fast typing instead of waiting for a pause.
        debounce?.invalidate()
        debounce = Timer.scheduledTimer(withTimeInterval: Self.typingSettleTime, repeats: false) { [weak self] _ in
            self?.refresh()
        }
    }

    /// The focused editor, read off the main thread. `host` and `caret` are
    /// only measured once enough has been typed to ask for suggestions.
    private struct HostReading {
        let context: CaretContext?
        let host: AssistPopupHost?
        let caret: CGRect?
    }

    private static func trimmedLength(_ context: CaretContext) -> Int {
        context.text.trimmingCharacters(in: .whitespacesAndNewlines).count
    }

    /// Accessibility queue only.
    private static func readHost(reusing previous: AssistPopupHost?) -> HostReading {
        guard let context = AccessibilityReader.focusedContext() else {
            return HostReading(context: nil, host: nil, caret: nil)
        }
        guard trimmedLength(context) >= minimumTypedCharacters else {
            return HostReading(context: context, host: nil, caret: nil)
        }
        let host = popupHost(for: context.element, reusing: previous)
        // The caret was measured with the context a moment ago.
        let caret = host?.visibleCaret(using: { _ in context.caretRect })
        return HostReading(context: context, host: host, caret: caret)
    }

    /// Accessibility queue only.
    static func popupHost(for element: AXUIElement, reusing previous: AssistPopupHost?) -> AssistPopupHost? {
        if let previous, CFEqual(previous.element, element) { return previous }
        return AssistPopupHost(element: element)
    }

    func refresh() {
        guard isEnabled, serverURL != nil, !projectIds.isEmpty else { hide(); return }
        // One read at a time: a slow host must not pile up reads behind it.
        guard contextReads.begin() else { return }
        let token = generation
        let previous = popupHost
        AccessibilityWork.queue.async { [weak self] in
            let reading = Self.readHost(reusing: previous)
            DispatchQueue.main.async {
                guard let self else { return }
                let again = self.contextReads.end()
                // Typing, Escape or a hide since the read began make it stale.
                if token == self.generation { self.didReadHost(reading) }
                if again { self.refresh() }
            }
        }
    }

    private func didReadHost(_ reading: HostReading) {
        guard isEnabled, let serverURL, !projectIds.isEmpty,
              let captured = reading.context else { hide(); return }
        // Two characters are enough to ask, so the first word of an empty
        // field ("Re" → Revenue) is not skipped. The server decides whether
        // the typed fragment is long enough to match.
        guard Self.trimmedLength(captured) >= Self.minimumTypedCharacters else { hide(); return }
        if let host = popupHost, !CFEqual(host.element, captured.element) { hide() }
        // Linked sources belong to one surface only.
        if linkedContext != captured.diagnosis || linkedElement.map({ !CFEqual($0, captured.element) }) != false {
            linkedElement = captured.element
            linkedContext = captured.diagnosis
            linkedSources.forget()
        }
        context = captured
        guard let host = reading.host, let caret = reading.caret else { hide(); return }
        adoptHost(host, caret: caret)
        // Track the caret straight away. Waiting for the response would leave
        // the box behind whenever fast typing cancels requests.
        if panel?.isVisible == true, view.mode == .suggestions { reposition(near: popupCaret) }
        requestPrediction(for: captured, serverURL: serverURL)
    }

    private func requestPrediction(for captured: CaretContext, serverURL: URL) {
        generation += 1
        let token = generation
        request?.cancel()

        var request = URLRequest(url: serverURL
            .appendingPathComponent("api/workspace/dependencies/predict"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 2.5
        var body: [String: Any] = [
            "text": captured.text,
            "cursor": captured.cursor,
            "blockIndex": 0,
        ]
        // Accepted phrases are located inside the window actually being sent,
        // so the offsets the server receives match the text it is given. One
        // deleted since it was accepted takes the card's focus back a step.
        linkedSources.observe(captured.text, reachesStart: captured.windowStart == 0)
        body.merge(linkedSources.requestFields) { _, focus in focus }
        let activeProjectIds = Set(projectIds)
        let expectedRevision = workspaceRevision
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let task = URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self else { return }
            guard let data else {
                DispatchQueue.main.async {
                    guard token == self.generation else { return }
                    self.hide()
                }
                return
            }
            let parsed = Self.parse(data, requestedText: captured.text, activeProjectIds: activeProjectIds)
            let heading = Self.heading(data)
            let focus = Self.focusedSource(data)
            let returnedRevision = Self.predictionRevision(data)
            DispatchQueue.main.async {
                guard token == self.generation, self.isEnabled,
                      expectedRevision == self.workspaceRevision, activeProjectIds == Set(self.projectIds) else { return }
                if let returnedRevision, returnedRevision != expectedRevision {
                    // Browser selections and watch captures may change the server
                    // between menu refreshes. Adopt its state before showing results.
                    self.suspendWorkspace()
                    self.onWorkspaceChange?()
                    return
                }
                self.deliverPrediction(parsed, heading: heading, sourceScoped: focus != nil, focus: focus,
                                       captured: captured, token: token)
            }
        }
        self.request = task
        task.resume()
    }

    /// The source the server focused the card on, which fn+Left leaves and
    /// fn+Right returns to. A list scoped to project data names no source.
    private static func focusedSource(_ data: Data) -> LinkedSourceMemory.Source? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prediction = root["prediction"] as? [String: Any],
              let context = prediction["sourceContext"] as? [String: Any],
              let source = context["source"] as? [String: Any],
              let objectId = source["id"] as? String,
              let snapshotId = source["snapshotId"] as? String,
              let projectId = source["projectId"] as? String else { return nil }
        return .init(projectId: projectId, objectId: objectId, snapshotId: snapshotId,
                     text: source["label"] as? String ?? "")
    }

    /// The highlighted row as a source, whether or not it has values below it.
    var highlightedSource: LinkedSourceMemory.Source? {
        guard let suggestion = currentSuggestion, let objectId = suggestion.objectId,
              let snapshotId = suggestion.snapshotId else { return nil }
        return .init(projectId: suggestion.projectId, objectId: objectId, snapshotId: snapshotId,
                     text: suggestion.label)
    }

    /// The highlighted row as a focus fn+Right can narrow the card to, when it
    /// has values below it, with the words typed to find it ("brac" for
    /// Bracket). Those values replace the words.
    var narrowingChoice: (source: LinkedSourceMemory.Source, typed: TextAnchor?)? {
        guard let suggestion = currentSuggestion, suggestion.narrowable, let source = highlightedSource else { return nil }
        // The words are found in the text the card answered, which a newer read may have replaced.
        guard let replacement = suggestion.replacement, let text = context?.text else { return (source, nil) }
        let document = Array(text.utf16), words = Array(replacement.typedText.utf16)
        let range = replacement.start..<(replacement.start + words.count)
        guard range.upperBound <= document.count, Array(document[range]) == words else { return (source, nil) }
        return (source, TextAnchor.make(in: document, range: range))
    }

    private static func predictionRevision(_ data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prediction = root["prediction"] as? [String: Any] else { return nil }
        if let revision = prediction["workspaceRevision"] as? String { return revision }
        return (prediction["workspaceRevision"] as? NSNumber)?.stringValue
    }

    /// A response may arrive after Escape, an edit, or a window closing. Only
    /// deliver to the same still-current editor, using its current caret bounds.
    /// The editor is checked off the main thread; typing meanwhile drops it.
    func deliverPrediction(_ suggestions: [AssistSuggestion], heading: String?, sourceScoped: Bool,
                                   focus: LinkedSourceMemory.Source? = nil, captured: CaretContext, token: Int) {
        guard token == generation, isEnabled else { return }
        request = nil
        // Right after fn+Left or fn+Right an empty card stays, so the move can be undone.
        guard !suggestions.isEmpty || linkedSources.keepsEmptyCard(focusedOn: focus),
              let host = popupHost else { hide(); return }
        AccessibilityWork.queue.async { [weak self] in
            var current: (context: CaretContext, caret: CGRect)?
            var movedOn = false
            if host.isCurrent, let fresh = AccessibilityReader.focusedContext(), CFEqual(fresh.element, captured.element) {
                if fresh.text == captured.text, fresh.absoluteCaret == captured.absoluteCaret,
                   fresh.windowStart == captured.windowStart, let caret = host.caretIfVisible(fresh.caretRect) {
                    current = (fresh, caret)
                } else {
                    // A key the editor had not yet taken when it was read: the
                    // text before the caret grew or shrank at its end. A click
                    // elsewhere in the field does neither, and closes the box.
                    movedOn = fresh.text != captured.text && fresh.windowStart == captured.windowStart
                        && (fresh.text.hasPrefix(captured.text) || captured.text.hasPrefix(fresh.text))
                }
            }
            DispatchQueue.main.async {
                guard let self, token == self.generation, self.isEnabled else { return }
                // The same editor with newer text is asked about that text, and
                // whatever is showing stays until the answer replaces it.
                if current == nil, movedOn, self.rereadsLeft > 0 {
                    self.rereadsLeft -= 1
                    self.refresh()
                    return
                }
                guard let current else { self.hide(); return }
                self.context = current.context
                self.adoptHost(host, caret: current.caret)
                self.view.sourceScoped = sourceScoped
                self.focusedSource = focus
                self.linkedSources.noteFocus(focus)
                self.view.stepBackName = focus == nil ? nil : self.linkedSources.stepBack?.text
                self.view.returnFocusName = focus == nil && self.linkedSources.canMoveIn(focusedOn: nil, selected: nil)
                    ? self.linkedSources.recent?.text : nil
                if let landing = self.focusLanding {
                    self.focusLanding = nil
                    self.view.selected = landing.index(in: suggestions.map(\.objectId))
                }
                self.view.title = heading ?? "dependency"
                self.show(suggestions)
                self.publishKeyRouting()
            }
        }
    }

    /// What the server is offering: "Values for Office Supplies" once a source
    /// is linked, otherwise the general heading.
    private static func heading(_ data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prediction = root["prediction"] as? [String: Any] else { return nil }
        if let workspace = prediction["workspaceHeading"] as? String, !workspace.isEmpty {
            return workspace.lowercased()
        }
        if let context = prediction["sourceContext"] as? [String: Any],
           let source = context["source"] as? [String: Any],
           let label = source["label"] as? String {
            return "components from \(label)".lowercased()
        }
        return nil
    }

    private static func sourceLocation(_ candidate: [String: Any]) -> String {
        let anchor = candidate["anchor"] as? [String: Any] ?? [:]
        let metadata = candidate["metadata"] as? [String: Any] ?? [:]
        // Equal CAD values ("10 mm") are told apart by the feature they measure.
        if anchor["kind"] as? String == "cad-property",
           let label = (anchor["label"] as? String) ?? (candidate["label"] as? String) {
            return AssistSourceLocation.cadFeature(label: label, part: metadata["entityName"] as? String)
        }
        let sheet = (anchor["sheet"] as? String) ?? (metadata["sheet"] as? String) ?? ""
        let row = (anchor["rowIndex"] as? NSNumber)?.intValue
        let column = (anchor["columnIndex"] as? NSNumber)?.intValue
        if let row, let column {
            let cell = spreadsheetColumn(column) + String(row)
            return sheet.isEmpty ? cell : sheet + "!" + cell
        }
        if let page = (anchor["pageNumber"] as? NSNumber)?.intValue
            ?? (metadata["pageNumber"] as? NSNumber)?.intValue {
            return "p. " + String(page)
        }
        if let rowKey = (anchor["rowKey"] as? String) ?? (metadata["rowKey"] as? String),
           !rowKey.isEmpty {
            return sheet.isEmpty ? rowKey : sheet + " · " + rowKey
        }
        if let slide = (anchor["slideNumber"] as? NSNumber)?.intValue { return "Slide " + String(slide) }
        if anchor["kind"] as? String == "line-range", let first = (anchor["lineStart"] as? NSNumber)?.intValue {
            let last = (anchor["lineEnd"] as? NSNumber)?.intValue ?? first
            return last > first ? "Lines \(first)–\(last)" : "Line \(first)"
        }
        return sheet
    }

    private static func spreadsheetColumn(_ index: Int) -> String {
        var current = index
        var label = ""
        repeat {
            label = String(UnicodeScalar(65 + current % 26)!) + label
            current = current / 26 - 1
        } while current >= 0
        return label
    }

    static func parse(_ data: Data, requestedText: String, activeProjectIds: Set<String>) -> [AssistSuggestion] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prediction = root["prediction"] as? [String: Any] else { return [] }

        // Every result retains its owning directory. A single-directory payload
        // can still be decoded during an upgrade from an older local server.
        func owner(_ values: [String: Any]...) -> String? {
            for value in values {
                if let id = value["projectId"] as? String {
                    return activeProjectIds.contains(id) ? id : nil
                }
            }
            return activeProjectIds.count == 1 ? activeProjectIds.first : nil
        }

        var results: [(suggestion: AssistSuggestion, rankOrder: Int)] = []
        var identities = Set<String>()
        func append(_ suggestion: AssistSuggestion, rankedBy entry: [String: Any]) {
            let identity = suggestion.projectId + "|" + (suggestion.objectId ?? suggestion.usageObjectId ?? "")
                + "|" + suggestion.insertText
            if identities.insert(identity).inserted {
                var matched = suggestion
                matched.matchedWords = entry["matchedWords"] as? [String] ?? []
                results.append((matched, (entry["rankOrder"] as? Int) ?? Int.max))
            }
        }

        if let completion = prediction["completion"] as? [String: Any],
           let insert = completion["insertText"] as? String, !insert.isEmpty {
            let candidate = completion["dependencyCandidate"] as? [String: Any] ?? [:]
            let source = completion["source"] as? [String: Any] ?? [:]
            if let projectId = owner(completion, candidate, source) {
                append(AssistSuggestion(
                    insertText: insert,
                    label: insert.trimmingCharacters(in: .whitespaces),
                    detail: "sentence", path: source["path"] as? String ?? "", location: "",
                    replacement: CompletionReplacement(start: requestedText.utf16.count, expectedText: ""),
                    objectId: nil, versionId: candidate["versionId"] as? String,
                    snapshotId: candidate["snapshotId"] as? String ?? source["snapshotId"] as? String,
                    usageObjectId: candidate["id"] as? String,
                    projectId: projectId,
                    rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String,
                    previewText: completion["sourceSentence"] as? String ?? insert.trimmingCharacters(in: .whitespacesAndNewlines),
                    sentenceContinuation: true), rankedBy: completion)
            }
        }

        for group in ["workspaceCompletions", "sourceCompletions"] {
            for entry in (prediction[group] as? [[String: Any]] ?? []) {
                let candidate = entry["dependencyCandidate"] as? [String: Any] ?? [:]
                let insert = (entry["replacementText"] as? String)
                    ?? (entry["insertText"] as? String) ?? ""
                guard !insert.isEmpty, let projectId = owner(entry, candidate) else { continue }
                // Code's colon replaces spaces typed after the line numbers.
                guard let replacement = CompletionReplacement.capture(start: entry["claimStart"] as? Int,
                    end: entry["claimEnd"] as? Int, in: requestedText,
                    replacingSpaces: entry["verbatim"] as? Bool == true) else { continue }
                append(AssistSuggestion(
                    // A code range inserts several lines; the row names its first one.
                    insertText: insert, label: entry["label"] as? String ?? insert,
                    detail: entry["detail"] as? String ?? candidate["valueText"] as? String ?? (entry["category"] as? String ?? ""),
                    path: AssistSourceIdentity.canonicalPath(
                        candidatePath: candidate["path"] as? String,
                        provenanceLabel: entry["provenanceLabel"] as? String),
                    location: sourceLocation(candidate),
                    replacement: replacement,
                    objectId: candidate["id"] as? String,
                    versionId: candidate["versionId"] as? String,
                    snapshotId: candidate["snapshotId"] as? String,
                    usageObjectId: candidate["id"] as? String, projectId: projectId,
                    rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String,
                    previewText: entry["sourceSentence"] as? String ?? insert,
                    shareable: candidate["shareable"] as? Bool ?? true,
                    narrowable: candidate["narrowable"] as? Bool == true,
                    verbatim: entry["verbatim"] as? Bool == true), rankedBy: entry)
            }
        }

        for claim in (prediction["claims"] as? [[String: Any]] ?? []) {
            let claimStart = claim["start"] as? Int
            let claimEnd = claim["end"] as? Int
            let claimType = claim["type"] as? String
            let replacesName = ["ENTITY", "STUDY_VARIABLE", "LITERATURE", "TABLE_REFERENCE", "FIGURE"]
                .contains(claimType ?? "")
            let nameCompletion = replacesName && claim["partial"] as? Bool == true
            let matchedName = nameCompletion
                ? CompletionReplacement.capture(start: claimStart, end: claimEnd, in: requestedText,
                    expectedText: claim["text"] as? String) : nil
            if nameCompletion && matchedName == nil { continue }
            let replacement = matchedName
                ?? (["QUANTITATIVE", "SAMPLE_SIZE"].contains(claimType ?? "")
                    ? CompletionReplacement.terminalNumber(in: requestedText) : nil)
                ?? CompletionReplacement(start: requestedText.utf16.count, expectedText: "")
            for candidate in (claim["candidates"] as? [[String: Any]] ?? []) {
                let label = candidate["label"] as? String ?? ""
                let value = candidate["valueText"] as? String ?? candidate["displayValue"] as? String
                let insert = AssistSuggestionSemantics.insertionText(
                    claimType: claimType, label: label, value: value,
                    completionText: candidate["completionText"] as? String)
                guard !insert.isEmpty, let projectId = owner(candidate, claim) else { continue }
                append(AssistSuggestion(
                    insertText: insert, label: label,
                    detail: value ?? (candidate["objectType"] as? String ?? ""),
                    path: candidate["path"] as? String ?? "", location: sourceLocation(candidate),
                    replacement: replacement, objectId: candidate["id"] as? String,
                    versionId: candidate["versionId"] as? String,
                    snapshotId: candidate["snapshotId"] as? String,
                    usageObjectId: candidate["id"] as? String, projectId: projectId,
                    rankingReason: (candidate["ranking"] as? [String: Any])?["reason"] as? String,
                    // A claimed sentence is marked on its slide or page even when no typed word is.
                    previewText: AssistSuggestionSemantics.passage(of: candidate),
                    shareable: candidate["shareable"] as? Bool ?? true,
                    narrowable: candidate["narrowable"] as? Bool == true), rankedBy: candidate)
            }
        }
        // The server ranks every suggestion in one order, which its groups only
        // split up: a file named exactly goes above sentences that share a word.
        return results.enumerated()
            .sorted { ($0.element.rankOrder, $0.offset) < ($1.element.rankOrder, $1.offset) }
            .map(\.element.suggestion)
    }
}
