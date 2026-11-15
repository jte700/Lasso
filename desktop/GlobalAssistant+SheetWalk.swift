// fn+Right on a spreadsheet or CSV suggestion dives into its sheet: fn and
// the arrows then move the card a cell at a time, and Tab inserts the cell it
// is on. The server answers which cell is beside the shown one.

import Cocoa

/// The walk through a sheet: the cell shown, the list it was entered from, and moves still to send.
struct SheetWalk {
    var shown: AssistSuggestion
    let returnList: [AssistSuggestion]
    let returnSelection: Int
    let returnScoped: Bool
    var queued: [SheetDirection] = []
    var waiting = false
}

extension AssistSuggestion {
    /// A cell, row name or column name the server answered a sheet move with.
    /// Tab replaces the same typed words the suggestion dived from did.
    static func sheetCell(_ cell: [String: Any], replacement: CompletionReplacement?,
                          location: ([String: Any]) -> String) -> AssistSuggestion? {
        guard let object = cell["object"] as? [String: Any],
              let insert = cell["insertText"] as? String, !insert.isEmpty,
              let projectId = object["projectId"] as? String,
              let objectId = object["id"] as? String else { return nil }
        let kind = (object["anchor"] as? [String: Any])?["kind"] as? String
        let detail = kind == "table-row" ? "Row" : kind == "table-column" ? "Column"
            : object["valueText"] as? String ?? ""
        var suggestion = AssistSuggestion(
            insertText: insert, label: object["label"] as? String ?? insert, detail: detail,
            path: object["path"] as? String ?? "", location: location(object), replacement: replacement,
            objectId: objectId, versionId: object["versionId"] as? String,
            snapshotId: object["snapshotId"] as? String, usageObjectId: objectId,
            projectId: projectId, rankingReason: nil, previewText: insert,
            shareable: object["shareable"] as? Bool ?? true)
        suggestion.sheetGrid = true
        return suggestion
    }

    /// Where a walk is, for the card's header: the file and the cell ("Budget.xlsx · Budget!C3").
    var sheetPlace: String {
        let file = (path as NSString).lastPathComponent
        return location.isEmpty ? file : "\(file) · \(location)"
    }
}

extension GlobalAssistant {
    /// fn+Right on a sheet suggestion: the card moves onto the cell it lands on.
    func enterSheet() {
        guard view.mode == .suggestions, sheetWalk == nil, let suggestion = currentSuggestion,
              suggestion.sheetGrid else { return }
        // An answer still coming for the words typed before must not replace the cell.
        generation += 1
        debounce?.invalidate()
        debounce = nil
        request?.cancel()
        request = nil
        sheetWalk = SheetWalk(shown: suggestion, returnList: view.suggestions,
                              returnSelection: view.selected, returnScoped: view.sourceScoped)
        moveInSheet(.into)
    }

    /// fn and an arrow in a sheet. Moves wait their turn, so a held key walks every cell on the way.
    func moveInSheet(_ direction: SheetDirection) {
        guard sheetWalk != nil else { return }
        sheetWalk?.queued.append(direction)
        sendNextSheetMove()
    }

    /// Typing, a dismissal or Tab ends the walk; the next answer is for the words as they are.
    func endSheetWalk() {
        sheetToken += 1
        sheetWalk = nil
        view.sheetPlace = nil
    }

    private func sendNextSheetMove() {
        guard var walk = sheetWalk, !walk.waiting, !walk.queued.isEmpty, let serverURL else { return }
        let direction = walk.queued.removeFirst()
        walk.waiting = true
        sheetWalk = walk
        let from = walk.shown, token = sheetToken
        var request = URLRequest(url: serverURL.appendingPathComponent("api/workspace/dependencies/sheet-cell"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 2.5
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "projectId": from.projectId, "objectId": from.objectId ?? "",
            "snapshotId": from.snapshotId ?? "", "direction": direction.rawValue,
        ])
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let answered = (response as? HTTPURLResponse)?.statusCode == 200
            let root = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                guard let self, token == self.sheetToken, self.sheetWalk != nil else { return }
                self.sheetWalk?.waiting = false
                self.sheetAnswered(direction, cell: answered ? root?["cell"] as? [String: Any] : nil, from: from)
                self.sendNextSheetMove()
            }
        }.resume()
    }

    private func sheetAnswered(_ direction: SheetDirection, cell: [String: Any]?, from: AssistSuggestion) {
        if let cell, let next = AssistSuggestion.sheetCell(cell, replacement: from.replacement,
                                                            location: Self.sourceLocation) {
            showSheetCell(next)
            return
        }
        switch direction {
        case .left:
            // At the left edge fn+Left keeps its meaning: back to the list the walk began from.
            leaveSheet()
        case .into:
            // Nothing to walk: fn+Right does what it did before, into the values when there are any.
            leaveSheet()
            narrowFocus()
        case .up, .down, .right:
            // The sheet's edge: the card stays on its cell.
            break
        }
    }

    private func showSheetCell(_ cell: AssistSuggestion) {
        sheetWalk?.shown = cell
        view.sheetPlace = cell.sheetPlace
        view.selected = 0
        show([cell])
    }

    /// Back to the list the walk was entered from, on the row it was entered on.
    private func leaveSheet() {
        guard let walk = sheetWalk else { return }
        endSheetWalk()
        view.sourceScoped = walk.returnScoped
        view.selected = walk.returnSelection
        show(walk.returnList)
    }
}
