// What the suggestion card offers, and the text around the caret it was asked for.

import Cocoa
import ApplicationServices

struct AssistSuggestion {
    var insertText: String       // what gets typed into the focused app
    let label: String            // headline shown in the box
    var detail: String           // value or context, shown dim
    let path: String             // originating source file
    let location: String         // exact sheet/cell, page, row, or passage
    /// Exact detected fragment from the request, revalidated before insertion.
    var replacement: CompletionReplacement?
    /// Indexed object behind the suggestion. Required to create a share; absent
    /// for plain sentence completions, which have nothing to link to.
    var objectId: String?
    let versionId: String?
    let snapshotId: String?
    /// Sentence completions retain source identity for usage without becoming shareable.
    let usageObjectId: String?
    let projectId: String
    let rankingReason: String?
    var previewText: String? = nil
    var sentenceContinuation = false
    /// The server's word on whether a share link can be made: never for code.
    var shareable = true
    /// It has values below it, such as a part's measurements, that fn+Right narrows the card to.
    var narrowable = false
    /// Code: inserted exactly as written. Its letters are never re-cased, and
    /// where the host ignores Accessibility writes it is pasted, not typed.
    var verbatim = false
    /// A row or cell with spatial navigation in its source table.
    var tableNavigable = false
    /// A spreadsheet's or CSV's cell, row or column: fn+Tab opens its sheet to highlight cells from.
    var sheetPickable = false
    /// The typed words its source has, as the source spells them, which its preview marks.
    var matchedWords: [String] = []
    /// Seconds into a video where the quoted words are said, which its link and inspector start at.
    var videoTime: Double? = nil
    /// Typed at the caret exactly as the server spells it, with no space put before it:
    /// the rest of a quoted word, its closing quote and the citation.
    var joinsTyping = false
    /// Words chosen from after the line's first, set apart from the typed
    /// text even when the line continued the sentence.
    var startsMidLine = false
    /// A passage of a video, deck, PDF, Word document or text file: Tab opens the
    /// passage picker on its document instead of inserting it.
    var opensPassagePicker = false
    /// Chosen in the passage picker: ⌘Z after it takes back only its link, keeping the words.
    var fromPassagePicker = false
    /// Its value's recent change, which the detail slot names ("19,250 · was 18,400").
    var change: AssistValueChange? = nil

    var isShareable: Bool { objectId != nil && shareable }

    /// The indexed passage the passage picker opens on: a sentence completion
    /// names its source only as the object it was used from.
    var passageObjectId: String? { objectId ?? (usageObjectId == "completion-source" ? nil : usageObjectId) }

    var selectionIdentity: AssistSuggestionSelection.Identity {
        .init(projectId: projectId, objectId: objectId ?? usageObjectId, insertText: insertText)
    }

    /// A line long enough that ⇧fn+Left and ⇧fn+Right open it to choose some of its words.
    /// Not a table's, whose fn+arrows move through the table, nor a slide's.
    var offersWords: Bool { !tableNavigable && !narrowable && AssistWordChoice.offers(insertText, from: path) }

    /// The suggestion with only the words chosen from its line, or nil when none are.
    func choosing(_ words: AssistWordChoice) -> AssistSuggestion? {
        guard let text = words.chosenText else { return nil }
        var part = self
        part.insertText = text
        part.startsMidLine = words.startsMidLine
        return part
    }
}

struct CaretContext {
    let text: String
    let cursor: Int
    /// Absolute UTF-16 offset of the first character in `text`.
    let windowStart: Int
    /// Caret offset in the element's own coordinate space (UTF-16 units),
    /// which is what Accessibility ranges are expressed in.
    let absoluteCaret: Int
    let selectionLength: Int
    let caretRect: CGRect?
    let element: AXUIElement
    let diagnosis: String
}
